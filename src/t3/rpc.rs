//! A minimal client for T3 Code's WebSocket API: Effect RPC with JSON serialization. Each text
//! frame is one message or an array of them.
//!
//!   → {_tag:"Request", id, tag, payload, headers:[]}   ← {_tag:"Chunk", requestId, values}
//!   → {_tag:"Ack", requestId}  (after every Chunk)     ← {_tag:"Exit", requestId, exit}
//!   → {_tag:"Interrupt", requestId}                    ← {_tag:"Pong"}
//!   → {_tag:"Ping"}                                    ← {_tag:"Defect", defect}
//!
//! Streams use ack-based backpressure: the server stops sending until each Chunk is
//! acknowledged. The socket is polled from one worker thread with a short read timeout.
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::Arc,
    time::{Duration, Instant},
};
use tungstenite::{Message as Frame, WebSocket, protocol::frame::coding::CloseCode};

const PING_INTERVAL: Duration = Duration::from_secs(5);
const SILENCE: Duration = Duration::from_secs(15);
/// How long one poll waits for a frame before the worker checks its commands.
pub const POLL: Duration = Duration::from_millis(100);

pub enum Stream {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl Stream {
    fn tcp(&self) -> &TcpStream {
        match self {
            Self::Plain(tcp) => tcp,
            Self::Tls(tls) => tls.get_ref(),
        }
    }
}

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Plain(tcp) => tcp.read(buffer),
            Self::Tls(tls) => tls.read(buffer),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(tcp) => tcp.write(buffer),
            Self::Tls(tls) => tls.write(buffer),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(tcp) => tcp.flush(),
            Self::Tls(tls) => tls.flush(),
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Message {
    Chunk {
        id: u64,
        values: Vec<Value>,
    },
    Exit {
        id: u64,
        result: Result<Value, String>,
    },
}

pub struct Socket {
    socket: WebSocket<Stream>,
    /// A failure after frames were already read; reported by the next poll, after them.
    failed: Option<String>,
    next_id: u64,
    last_heard: Instant,
    last_ping: Instant,
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: std::sync::OnceLock<Arc<rustls::ClientConfig>> = std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            Arc::new(
                rustls::ClientConfig::builder_with_provider(Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))
                .with_safe_default_protocol_versions()
                .expect("ring supports the default TLS versions")
                .with_root_certificates(roots)
                .with_no_client_auth(),
            )
        })
        .clone()
}

/// Failure causes are arrays of {_tag:"Fail", error} / {_tag:"Die", defect}.
fn failure(cause: &Value) -> String {
    let first = cause
        .as_array()
        .and_then(|causes| causes.first())
        .unwrap_or(cause);
    let error = first.get("error").or_else(|| first.get("defect"));
    match error {
        Some(Value::String(text)) => text.clone(),
        Some(error) => error
            .get("message")
            .or_else(|| error.get("_tag"))
            .and_then(Value::as_str)
            .unwrap_or("Request failed")
            .to_owned(),
        None => "Request failed".to_owned(),
    }
}

impl Socket {
    /// Opens `ws://` or `wss://` and completes the WebSocket handshake within `timeout`.
    pub fn connect(url: &str, timeout: Duration) -> Result<Self, String> {
        let (https, rest) = if let Some(rest) = url.strip_prefix("wss://") {
            (true, rest)
        } else if let Some(rest) = url.strip_prefix("ws://") {
            (false, rest)
        } else {
            return Err("Not a WebSocket URL".into());
        };
        let authority = rest.split(['/', '?']).next().unwrap_or_default();
        let origin = super::routes::Origin::parse(&format!(
            "{}://{authority}/",
            if https { "https" } else { "http" }
        ))
        .ok_or("Invalid WebSocket address")?;
        let port = origin.port.unwrap_or(if https { 443 } else { 80 });
        let address = (origin.host.as_str(), port)
            .to_socket_addrs()
            .map_err(|error| error.to_string())?
            .next()
            .ok_or("The server's name didn't resolve")?;
        let tcp = TcpStream::connect_timeout(&address, timeout).map_err(|e| e.to_string())?;
        tcp.set_nodelay(true).ok();
        tcp.set_read_timeout(Some(timeout))
            .map_err(|e| e.to_string())?;
        tcp.set_write_timeout(Some(timeout))
            .map_err(|e| e.to_string())?;
        let stream = if https {
            let name = rustls::pki_types::ServerName::try_from(origin.host.clone())
                .map_err(|error| error.to_string())?;
            let connection = rustls::ClientConnection::new(tls_config(), name)
                .map_err(|error| error.to_string())?;
            Stream::Tls(Box::new(rustls::StreamOwned::new(connection, tcp)))
        } else {
            Stream::Plain(tcp)
        };
        let (socket, _) = tungstenite::client(url, stream).map_err(|error| match error {
            tungstenite::HandshakeError::Failure(error) => error.to_string(),
            tungstenite::HandshakeError::Interrupted(_) => "The handshake timed out".into(),
        })?;
        socket
            .get_ref()
            .tcp()
            .set_read_timeout(Some(POLL))
            .map_err(|error| error.to_string())?;
        let now = Instant::now();
        Ok(Self {
            socket,
            failed: None,
            next_id: 1,
            last_heard: now,
            last_ping: now,
        })
    }

    fn send(&mut self, message: Value) -> Result<(), String> {
        self.socket
            .send(Frame::text(message.to_string()))
            .map_err(|error| error.to_string())
    }

    /// Starts a request or stream; its replies arrive from `poll` under the returned id.
    pub fn request(&mut self, tag: &str, payload: Value) -> Result<u64, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({
            "_tag": "Request",
            "id": id.to_string(),
            "tag": tag,
            "payload": payload,
            "headers": [],
        }))?;
        Ok(id)
    }

    /// Ends a stream on the server.
    pub fn interrupt(&mut self, id: u64) -> Result<(), String> {
        self.send(json!({"_tag": "Interrupt", "requestId": id.to_string()}))
    }

    /// Waits up to `POLL` for frames, acknowledges stream chunks and keeps the connection
    /// alive. An error means the connection is gone.
    pub fn poll(&mut self) -> Result<Vec<Message>, String> {
        if let Some(error) = self.failed.take() {
            return Err(error);
        }
        let mut messages = Vec::new();
        loop {
            let failure = match self.socket.read() {
                Ok(Frame::Text(text)) => {
                    self.last_heard = Instant::now();
                    self.receive(&text, &mut messages).err()
                }
                Ok(Frame::Close(_)) => Some("The server closed the connection".to_owned()),
                Ok(_) => {
                    self.last_heard = Instant::now();
                    None
                }
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    break;
                }
                Err(error) => Some(error.to_string()),
            };
            if let Some(error) = failure {
                if messages.is_empty() {
                    return Err(error);
                }
                self.failed = Some(error);
                return Ok(messages);
            }
            // A busy stream mustn't keep the worker from its commands.
            if messages.len() >= 64 {
                break;
            }
        }
        let now = Instant::now();
        if now.duration_since(self.last_heard) > SILENCE {
            return Err("The server stopped answering".into());
        }
        if now.duration_since(self.last_ping) >= PING_INTERVAL {
            self.last_ping = now;
            self.send(json!({"_tag": "Ping"}))?;
        }
        Ok(messages)
    }

    fn receive(&mut self, text: &str, messages: &mut Vec<Message>) -> Result<(), String> {
        let Ok(parsed) = serde_json::from_str::<Value>(text) else {
            return Ok(());
        };
        let list = match parsed {
            Value::Array(list) => list,
            single => vec![single],
        };
        for message in list {
            let id = || {
                message
                    .get("requestId")
                    .and_then(|id| {
                        id.as_str()
                            .map(str::to_owned)
                            .or_else(|| Some(id.to_string()))
                    })
                    .and_then(|id| id.parse::<u64>().ok())
            };
            match message.get("_tag").and_then(Value::as_str) {
                Some("Chunk") => {
                    let Some(id) = id() else { continue };
                    self.send(json!({"_tag": "Ack", "requestId": id.to_string()}))?;
                    let values = message
                        .get("values")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    messages.push(Message::Chunk { id, values });
                }
                Some("Exit") => {
                    let Some(id) = id() else { continue };
                    let exit = message.get("exit");
                    let result = match exit
                        .and_then(|exit| exit.get("_tag"))
                        .and_then(Value::as_str)
                    {
                        Some("Success") => Ok(exit
                            .and_then(|exit| exit.get("value"))
                            .cloned()
                            .unwrap_or(Value::Null)),
                        _ => Err(failure(
                            exit.and_then(|exit| exit.get("cause"))
                                .unwrap_or(&Value::Null),
                        )),
                    };
                    messages.push(Message::Exit { id, result });
                }
                Some("Defect") => return Err("The server reported a protocol defect".into()),
                _ => {}
            }
        }
        Ok(())
    }

    pub fn close(mut self) {
        let _ = self.send(json!({"_tag": "Eof"}));
        let _ = self.socket.close(Some(tungstenite::protocol::CloseFrame {
            code: CloseCode::Normal,
            reason: "".into(),
        }));
        let _ = self.socket.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn streams_are_acknowledged_chunk_by_chunk_and_requests_end_with_their_exit() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}/ws?wsTicket=t", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            let mut read = || -> Value {
                match socket.read().unwrap() {
                    Frame::Text(text) => serde_json::from_str(&text).unwrap(),
                    other => panic!("unexpected {other:?}"),
                }
            };
            let request = read();
            assert_eq!(request["_tag"], "Request");
            assert_eq!(request["tag"], "orchestration.subscribeShell");
            let id = request["id"].as_str().unwrap().to_owned();
            drop(read);
            socket
                .send(Frame::text(
                    json!([
                        {"_tag": "Chunk", "requestId": id, "values": [{"kind": "synchronized"}]},
                        {"_tag": "Exit", "requestId": id, "exit": {"_tag": "Failure",
                            "cause": [{"_tag": "Fail", "error": {"_tag": "Gone", "message": "Stream ended"}}]}}
                    ])
                    .to_string(),
                ))
                .unwrap();
            match socket.read().unwrap() {
                Frame::Text(text) => {
                    let ack: Value = serde_json::from_str(&text).unwrap();
                    assert_eq!(ack, json!({"_tag": "Ack", "requestId": id}));
                }
                other => panic!("unexpected {other:?}"),
            }
        });
        let mut socket = Socket::connect(&url, Duration::from_secs(2)).unwrap();
        let id = socket
            .request("orchestration.subscribeShell", json!({}))
            .unwrap();
        let mut messages = Vec::new();
        for _ in 0..20 {
            messages.extend(socket.poll().unwrap());
            if messages.len() == 2 {
                break;
            }
        }
        assert_eq!(
            messages,
            [
                Message::Chunk {
                    id,
                    values: vec![json!({"kind": "synchronized"})]
                },
                Message::Exit {
                    id,
                    result: Err("Stream ended".into())
                }
            ]
        );
        server.join().unwrap();
    }
}
