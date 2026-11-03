//! The same environment is often reachable at several addresses: the LAN, the Tailscale IP
//! and a Tailscale Serve HTTPS name. The ranking and the rules for learning addresses follow
//! T3 Code's client-runtime/src/connection/routes.ts.
use super::types::DirectEndpoint;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    Loopback,
    Lan,
    Tailnet,
    Vpn,
    Public,
}

impl RouteKind {
    fn rank(self) -> u8 {
        match self {
            Self::Loopback => 0,
            Self::Lan => 1,
            Self::Tailnet | Self::Vpn => 2,
            Self::Public => 3,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Route {
    /// Origin with a trailing slash, e.g. `http://192.168.1.10:3773/`.
    pub url: String,
    pub kind: RouteKind,
}

impl Route {
    pub fn new(url: &str) -> Option<Self> {
        let origin = Origin::parse(url)?;
        Some(Self {
            url: origin.url(),
            kind: route_kind(&origin, None),
        })
    }

    pub fn https(&self) -> bool {
        self.url.starts_with("https:")
    }
}

/// The parts of an http(s) URL Luma needs; everything after the authority is ignored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    pub https: bool,
    /// Lowercase, without IPv6 brackets.
    pub host: String,
    pub port: Option<u16>,
}

impl Origin {
    pub fn parse(url: &str) -> Option<Self> {
        let (scheme, rest) = url.split_once("://")?;
        let https = match scheme.to_ascii_lowercase().as_str() {
            "http" => false,
            "https" => true,
            _ => return None,
        };
        let authority = rest
            .split(['/', '?', '#'])
            .next()
            .filter(|authority| !authority.is_empty() && !authority.contains('@'))?;
        let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
            let (host, after) = bracketed.split_once(']')?;
            (host, after.strip_prefix(':'))
        } else {
            match authority.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (authority, None),
            }
        };
        if host.is_empty()
            || !host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_'))
        {
            return None;
        }
        let port = match port {
            Some(port) => Some(port.parse().ok()?),
            None => None,
        };
        Some(Self {
            https,
            host: host.to_ascii_lowercase(),
            port: port.filter(|port| *port != if https { 443 } else { 80 }),
        })
    }

    pub fn url(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        let port = self.port.map(|port| format!(":{port}")).unwrap_or_default();
        format!(
            "{}://{host}{port}/",
            if self.https { "https" } else { "http" }
        )
    }
}

fn ipv4(host: &str) -> Option<[u8; 4]> {
    let parts: Vec<_> = host.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut octets = [0; 4];
    for (octet, part) in octets.iter_mut().zip(parts) {
        *octet = part.parse().ok()?;
    }
    Some(octets)
}

pub fn route_kind(origin: &Origin, reported: Option<&str>) -> RouteKind {
    let host = origin.host.as_str();
    let tailnet = reported == Some("tailnet");
    if host == "localhost" || host == "::1" || host.starts_with("127.") {
        return RouteKind::Loopback;
    }
    if host.ends_with(".ts.net") || host.starts_with("fd7a:115c:a1e0:") {
        return RouteKind::Tailnet;
    }
    let ip = ipv4(host);
    // 100.64.0.0/10 is shared by every CGNAT VPN; only trust it as Tailscale when the server
    // says the address is on its Tailscale interface.
    if let Some([100, second, ..]) = ip
        && (64..128).contains(&second)
    {
        return if tailnet {
            RouteKind::Tailnet
        } else {
            RouteKind::Vpn
        };
    }
    let private_v6 = host.len() > 4
        && matches!(&host[..2], "fc" | "fd")
        && host[2..4].chars().all(|c| c.is_ascii_hexdigit())
        && host[4..].starts_with(':');
    if matches!(ip, Some([10, ..]) | Some([192, 168, ..]))
        || matches!(ip, Some([172, second, ..]) if (16..32).contains(&second))
        || host.ends_with(".local")
        || private_v6
    {
        return RouteKind::Lan;
    }
    if tailnet {
        RouteKind::Tailnet
    } else {
        RouteKind::Public
    }
}

pub fn sort(routes: &mut [Route]) {
    routes.sort_by_key(|route| route.kind.rank());
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputError {
    MissingAddress,
    InvalidAddress,
    MissingCode,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PairingInput {
    pub url: String,
    pub code: String,
}

/// Accepts a full pairing link (`http://host:3773/pair#token=…`), or an address plus the
/// 12-character code from T3 Code's Connections settings.
pub fn parse_pairing_input(address: &str, code: &str) -> Result<PairingInput, InputError> {
    let raw = address.trim();
    if raw.is_empty() {
        return Err(InputError::MissingAddress);
    }
    let with_scheme = if raw.to_ascii_lowercase().starts_with("http://")
        || raw.to_ascii_lowercase().starts_with("https://")
    {
        raw.to_owned()
    } else {
        let host = raw.split(['/', '?', '#', ':']).next().unwrap_or_default();
        let scheme = if host.to_ascii_lowercase().ends_with(".ts.net") {
            "https"
        } else {
            "http"
        };
        format!("{scheme}://{raw}")
    };
    let origin = Origin::parse(&with_scheme).ok_or(InputError::InvalidAddress)?;
    let from_link = ['#', '?'].iter().find_map(|separator| {
        with_scheme
            .split_once(*separator)?
            .1
            .split(['&', '#'])
            .find_map(|pair| pair.strip_prefix("token="))
            .map(str::to_owned)
    });
    let token: String = from_link
        .as_deref()
        .unwrap_or(code)
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect::<String>()
        .to_ascii_uppercase();
    if token.is_empty() {
        return Err(InputError::MissingCode);
    }
    Ok(PairingInput {
        url: origin.url(),
        code: token,
    })
}

/// Merges the server's advertised addresses into the saved routes.
///
/// A token is never sent in clear to an address it wasn't already exposed on: a token paired
/// over HTTPS or Tailscale only learns HTTPS and Tailscale addresses.
pub fn learn(routes: &[Route], endpoints: &[DirectEndpoint], paired_on: &Route) -> Vec<Route> {
    let seen_in_clear =
        !paired_on.https() && matches!(paired_on.kind, RouteKind::Lan | RouteKind::Public);
    let mut learned = routes.to_vec();
    for endpoint in endpoints {
        let Some(origin) = Origin::parse(&endpoint.http_base_url) else {
            continue;
        };
        let kind = route_kind(&origin, Some(&endpoint.kind));
        let route = Route {
            url: origin.url(),
            kind,
        };
        if kind == RouteKind::Loopback || learned.iter().any(|known| known.url == route.url) {
            continue;
        }
        if !origin.https && kind != RouteKind::Tailnet && !seen_in_clear {
            continue;
        }
        learned.push(route);
    }
    sort(&mut learned);
    learned
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(url: &str, reported: Option<&str>) -> RouteKind {
        route_kind(&Origin::parse(url).unwrap(), reported)
    }

    #[test]
    fn pairing_accepts_a_full_link_or_an_address_with_a_code() {
        assert_eq!(
            parse_pairing_input("http://192.168.1.10:3773/pair#token=K7QM4XR2HP9D", ""),
            Ok(PairingInput {
                url: "http://192.168.1.10:3773/".into(),
                code: "K7QM4XR2HP9D".into(),
            })
        );
        assert_eq!(
            parse_pairing_input(" 192.168.1.10:3773 ", "k7qm-4xr2-hp9d"),
            Ok(PairingInput {
                url: "http://192.168.1.10:3773/".into(),
                code: "K7QM4XR2HP9D".into(),
            })
        );
        assert_eq!(
            parse_pairing_input("pc.tail1234.ts.net", "K7QM4XR2HP9D")
                .unwrap()
                .url,
            "https://pc.tail1234.ts.net/"
        );
        assert_eq!(
            parse_pairing_input("192.168.1.10:3773", ""),
            Err(InputError::MissingCode)
        );
        assert_eq!(
            parse_pairing_input("ftp://192.168.1.10", "CODE"),
            Err(InputError::InvalidAddress)
        );
    }

    #[test]
    fn tailscale_is_only_trusted_where_the_server_says_so() {
        assert_eq!(kind("http://100.110.174.118:3773/", None), RouteKind::Vpn);
        assert_eq!(
            kind("http://100.110.174.118:3773/", Some("tailnet")),
            RouteKind::Tailnet
        );
        assert_eq!(
            kind("https://pc.tail1234.ts.net/", None),
            RouteKind::Tailnet
        );
        assert_eq!(kind("http://192.168.1.10:3773/", None), RouteKind::Lan);
        assert_eq!(kind("http://[fd12:3456::1]:3773/", None), RouteKind::Lan);
        assert_eq!(kind("http://127.0.0.1:3773/", None), RouteKind::Loopback);
    }

    #[test]
    fn learned_routes_rank_lan_first_and_never_expose_an_https_paired_token_in_clear() {
        let endpoint = |kind: &str, url: &str| DirectEndpoint {
            kind: kind.into(),
            http_base_url: url.into(),
        };
        let endpoints = [
            endpoint("tailnet", "http://100.110.174.118:3773/"),
            endpoint("lan", "http://192.168.1.10:3773/"),
            endpoint("lan", "http://127.0.0.1:3773/"),
            endpoint("tailnet", "https://pc.tail1234.ts.net/"),
        ];
        let urls = |routes: Vec<Route>| routes.into_iter().map(|r| r.url).collect::<Vec<_>>();

        let lan = Route::new("http://192.168.1.10:3773/").unwrap();
        assert_eq!(
            urls(learn(std::slice::from_ref(&lan), &endpoints, &lan)),
            [
                "http://192.168.1.10:3773/",
                "http://100.110.174.118:3773/",
                "https://pc.tail1234.ts.net/"
            ]
        );

        let serve = Route::new("https://pc.tail1234.ts.net/").unwrap();
        assert_eq!(
            urls(learn(std::slice::from_ref(&serve), &endpoints, &serve)),
            [
                "https://pc.tail1234.ts.net/",
                "http://100.110.174.118:3773/"
            ]
        );
    }
}
