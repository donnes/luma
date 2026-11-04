//! Pairing exchanges a one-time code from T3 Code for a 30-day bearer token. The token belongs
//! to the server environment, not to an address, so every route Luma learns later reuses it.
//!
//! No request follows a redirect: an identity check only vouches for the address it asked,
//! and a code or token mustn't be forwarded to any other address.
use super::routes::{InputError, Route, parse_pairing_input};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::Path, time::Duration};

pub const ORCHESTRATION_PROTOCOL: u64 = 2;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub environment_id: String,
    #[serde(default)]
    pub label: String,
    pub token: String,
    /// Milliseconds since the epoch; 0 when the server gave no lifetime.
    #[serde(default)]
    pub expires_at: i64,
    pub paired_on: Route,
    #[serde(default)]
    pub routes: Vec<Route>,
}

impl Pairing {
    /// A saved pairing; unreadable or invalid ones read as unpaired.
    pub fn load(path: &Path) -> Option<Self> {
        let mut pairing: Self = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        if pairing.environment_id.is_empty() || pairing.token.is_empty() {
            return None;
        }
        pairing
            .routes
            .retain(|route| Route::new(&route.url).is_some_and(|parsed| parsed.url == route.url));
        if pairing.routes.is_empty() {
            pairing.routes = vec![pairing.paired_on.clone()];
        }
        Some(pairing)
    }

    /// Written owner-only: the token reaches the server's agents.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let json = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        let temporary = path.with_extension("json.tmp");
        write_private(&temporary, &json)?;
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())
    }

    pub fn remove(path: &Path) {
        let _ = std::fs::remove_file(path);
    }

    /// The pairing Fire TV's HomeGuard keeps for its alerts (`agent-watch.json`), which the
    /// web launcher handed it: server origins best first, the token and the server's name.
    /// Its lifetime wasn't kept, so a revoked token shows as expired on first use.
    pub fn from_agent_watch(path: &Path) -> Option<Self> {
        let config: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        let text = |key| {
            config
                .get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        };
        let routes: Vec<_> = config
            .get("routes")?
            .as_array()?
            .iter()
            .filter_map(|origin| Route::new(origin.as_str()?))
            .collect();
        Some(Self {
            environment_id: text("environmentId")?.to_owned(),
            label: text("source").unwrap_or_default().to_owned(),
            token: text("token")?.to_owned(),
            expires_at: 0,
            paired_on: routes.first()?.clone(),
            routes,
        })
    }

    pub fn expired(&self, now: i64) -> bool {
        self.expires_at != 0 && self.expires_at < now
    }

    pub fn name(&self) -> &str {
        if self.label.is_empty() {
            "T3 Code"
        } else {
            &self.label
        }
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairingError {
    Input(InputError),
    /// No answer, or not one from a T3 Code server.
    Unreachable,
    /// A T3 Code server speaking another orchestration protocol.
    Incompatible,
    /// The code was refused, or the server's answer made no sense.
    Rejected,
    /// The token is no longer accepted.
    Expired,
}

pub struct Environment {
    pub environment_id: String,
    pub label: String,
    pub protocol: Option<u64>,
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .max_redirects(0)
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .new_agent()
}

fn json(mut response: ureq::http::Response<ureq::Body>) -> Option<Value> {
    serde_json::from_str(&response.body_mut().read_to_string().ok()?).ok()
}

fn ok(response: &ureq::http::Response<ureq::Body>) -> bool {
    response.status().is_success()
}

/// Asks an address which environment answers there.
pub fn describe(route: &Route, timeout: Duration) -> Result<Environment, PairingError> {
    let response = agent(timeout)
        .get(format!("{}.well-known/t3/environment", route.url))
        .header("cache-control", "no-store")
        .call()
        .map_err(|_| PairingError::Unreachable)?;
    if !ok(&response) {
        return Err(PairingError::Unreachable);
    }
    let body = json(response).ok_or(PairingError::Unreachable)?;
    Ok(Environment {
        environment_id: body
            .get("environmentId")
            .and_then(Value::as_str)
            .ok_or(PairingError::Unreachable)?
            .to_owned(),
        label: body
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        protocol: body
            .get("orchestrationProtocolVersion")
            .and_then(Value::as_u64),
    })
}

fn form(fields: &[(&str, &str)]) -> String {
    let encode = |value: &str| {
        value
            .bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    (byte as char).to_string()
                }
                b' ' => "+".to_owned(),
                _ => format!("%{byte:02X}"),
            })
            .collect::<String>()
    };
    fields
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn pair(
    address: &str,
    code: &str,
    device_label: &str,
    now: i64,
) -> Result<Pairing, PairingError> {
    let input = parse_pairing_input(address, code).map_err(PairingError::Input)?;
    let route = Route::new(&input.url).ok_or(PairingError::Input(InputError::InvalidAddress))?;
    let environment = describe(&route, Duration::from_secs(8))?;
    if environment.protocol != Some(ORCHESTRATION_PROTOCOL) {
        return Err(PairingError::Incompatible);
    }
    // The token endpoint only accepts form-encoded bodies.
    let response = agent(Duration::from_secs(8))
        .post(format!("{}oauth/token", route.url))
        .header("content-type", "application/x-www-form-urlencoded")
        .send(form(&[
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange",
            ),
            ("subject_token", &input.code),
            (
                "subject_token_type",
                "urn:t3:params:oauth:token-type:environment-bootstrap",
            ),
            (
                "requested_token_type",
                "urn:ietf:params:oauth:token-type:access_token",
            ),
            ("client_label", device_label),
            ("client_device_type", "unknown"),
        ]))
        .map_err(|_| PairingError::Unreachable)?;
    if !ok(&response) {
        return Err(PairingError::Rejected);
    }
    let body = json(response).ok_or(PairingError::Rejected)?;
    let token = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or(PairingError::Rejected)?;
    let lifetime = body.get("expires_in").and_then(Value::as_i64).unwrap_or(0);
    Ok(Pairing {
        environment_id: environment.environment_id,
        label: environment.label,
        token: token.to_owned(),
        expires_at: if lifetime > 0 {
            now + lifetime * 1000
        } else {
            0
        },
        paired_on: route.clone(),
        routes: vec![route],
    })
}

fn authorized_post(
    route: &Route,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> Result<Value, PairingError> {
    let request = agent(Duration::from_secs(8))
        .post(format!("{}{path}", route.url))
        .header("authorization", format!("Bearer {token}"));
    let response = match body {
        Some(body) => request
            .header("content-type", "application/json")
            .send(body.to_string()),
        None => request.send_empty(),
    }
    .map_err(|_| PairingError::Unreachable)?;
    match response.status().as_u16() {
        401 | 403 => Err(PairingError::Expired),
        _ if ok(&response) => json(response).ok_or(PairingError::Unreachable),
        _ => Err(PairingError::Unreachable),
    }
}

/// The short-lived ticket T3 Code's WebSocket takes in place of the token.
pub fn websocket_ticket(route: &Route, token: &str) -> Result<String, PairingError> {
    authorized_post(route, "api/auth/websocket-ticket", token, None)?
        .get("ticket")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(PairingError::Unreachable)
}

/// A fresh one-time pairing code, so another client (T3 Code's web app) can pair without you.
pub fn pairing_code(route: &Route, token: &str, label: &str) -> Result<String, PairingError> {
    authorized_post(
        route,
        "api/auth/pairing-token",
        token,
        Some(serde_json::json!({ "label": label })),
    )
    .map_err(|error| match error {
        PairingError::Unreachable => PairingError::Rejected,
        other => other,
    })?
    .get("credential")
    .and_then(Value::as_str)
    .map(str::to_owned)
    .ok_or(PairingError::Rejected)
}

pub fn socket_url(route: &Route, ticket: &str) -> String {
    let scheme = if route.https() { "wss" } else { "ws" };
    let rest = route
        .url
        .split_once("://")
        .map_or(route.url.as_str(), |(_, rest)| rest);
    let encode = |value: &str| form(&[("v", value)])[2..].to_owned();
    format!(
        "{scheme}://{rest}ws?wsTicket={}&orchestrationProtocol={ORCHESTRATION_PROTOCOL}&clientSurface=web&clientDeviceType=unknown&connectionMethod=direct",
        encode(ticket)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
    };

    /// Serves `handler(method, path)` on a free loopback port, one response per connection.
    fn serve(
        handler: impl Fn(&str, &str) -> (u16, Vec<(&'static str, String)>, String) + Send + 'static,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let (method, path) = (
                    parts.next().unwrap_or_default().to_owned(),
                    parts.next().unwrap_or_default().to_owned(),
                );
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; length];
                let _ = reader.read_exact(&mut body);
                let (status, headers, body) = handler(&method, &path);
                let mut stream = stream;
                let extra: String = headers
                    .iter()
                    .map(|(name, value)| format!("{name}: {value}\r\n"))
                    .collect();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n{body}",
                    body.len()
                );
            }
        });
        url
    }

    #[test]
    fn an_identity_check_only_vouches_for_the_address_it_asked() {
        let paired = serve(|_, _| {
            (
                200,
                vec![],
                r#"{"environmentId":"env-1","label":"workstation"}"#.into(),
            )
        });
        let target = format!("{paired}.well-known/t3/environment");
        let other = serve(move |_, _| (302, vec![("location", target.clone())], String::new()));
        let route = |url: &str| Route::new(url).unwrap();
        assert_eq!(
            describe(&route(&paired), Duration::from_secs(2))
                .ok()
                .map(|environment| environment.environment_id),
            Some("env-1".into())
        );
        assert!(describe(&route(&other), Duration::from_secs(2)).is_err());
    }

    #[test]
    fn the_pairing_code_and_token_never_follow_a_redirect_to_another_address() {
        // Anything reaching this address got a credential it never proved it should have.
        let forwarded = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = forwarded.clone();
        let elsewhere = serve(move |method, path| {
            seen.lock().unwrap().push(format!("{method} {path}"));
            (
                200,
                vec![],
                r#"{"access_token":"stolen","ticket":"stolen","credential":"stolen"}"#.into(),
            )
        });
        let paired = serve(move |_, path| {
            if path == "/.well-known/t3/environment" {
                return (
                    200,
                    vec![],
                    format!(
                        r#"{{"environmentId":"env-1","label":"workstation","orchestrationProtocolVersion":{ORCHESTRATION_PROTOCOL}}}"#
                    ),
                );
            }
            // 307 keeps the method and body, so the code or token would go along.
            (
                307,
                vec![("location", format!("{elsewhere}{}", &path[1..]))],
                String::new(),
            )
        });
        let route = Route::new(&paired).unwrap();
        assert!(pair(&paired, "BOOTSTRAP", "Luma TV", 0).is_err());
        assert!(websocket_ticket(&route, "token-1").is_err());
        assert!(pairing_code(&route, "token-1", "Luma TV (T3 Code)").is_err());
        assert!(forwarded.lock().unwrap().is_empty());
    }

    #[test]
    fn pairing_saves_the_server_and_its_token_lifetime() {
        let server = serve(|method, path| match (method, path) {
            ("GET", "/.well-known/t3/environment") => (
                200,
                vec![],
                format!(
                    r#"{{"environmentId":"env-1","label":"workstation","orchestrationProtocolVersion":{ORCHESTRATION_PROTOCOL}}}"#
                ),
            ),
            ("POST", "/oauth/token") => (
                200,
                vec![],
                r#"{"access_token":"token-1","expires_in":60}"#.into(),
            ),
            _ => (404, vec![], String::new()),
        });
        let pairing = pair(&server, "k7qm-4xr2", "Luma TV", 1_000).unwrap();
        assert_eq!(pairing.environment_id, "env-1");
        assert_eq!(pairing.token, "token-1");
        assert_eq!(pairing.expires_at, 61_000);
        assert_eq!(pairing.routes, vec![pairing.paired_on.clone()]);

        let directory = std::env::temp_dir().join(format!("luma-t3-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("t3-pairing.json");
        pairing.save(&path).unwrap();
        assert_eq!(Pairing::load(&path), Some(pairing));
        #[cfg(unix)]
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(
                &std::fs::metadata(&path).unwrap().permissions()
            ) & 0o777,
            0o600
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_fire_tv_pairing_saved_for_alerts_carries_over() {
        let directory = std::env::temp_dir().join(format!("luma-t3-watch-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("agent-watch.json");
        std::fs::write(
            &path,
            r#"{"environmentId":"env-1","routes":["http://192.168.1.21:3773/","https://pc.tail1234.ts.net/"],
                "token":"token-1","source":"donnes-pc","asked":"asked a question","approval":"waiting"}"#,
        )
        .unwrap();
        let pairing = Pairing::from_agent_watch(&path).unwrap();
        assert_eq!(pairing.label, "donnes-pc");
        assert_eq!(pairing.paired_on.url, "http://192.168.1.21:3773/");
        assert_eq!(pairing.routes.len(), 2);
        std::fs::write(
            &path,
            r#"{"environmentId":"env-1","routes":[],"token":"t"}"#,
        )
        .unwrap();
        assert_eq!(Pairing::from_agent_watch(&path), None);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn socket_urls_carry_the_ticket_and_follow_the_route_scheme() {
        let lan = Route::new("http://192.168.1.10:3773/").unwrap();
        assert_eq!(
            socket_url(&lan, "a b+c"),
            "ws://192.168.1.10:3773/ws?wsTicket=a+b%2Bc&orchestrationProtocol=2&clientSurface=web&clientDeviceType=unknown&connectionMethod=direct"
        );
        let serve = Route::new("https://pc.tail1234.ts.net/").unwrap();
        assert!(socket_url(&serve, "t").starts_with("wss://pc.tail1234.ts.net/ws?"));
    }
}
