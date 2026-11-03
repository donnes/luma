//! Keeps one live connection to the paired T3 Code server, on its own thread.
//!
//! Connecting checks every saved address in parallel and uses the best one that answers as
//! the paired environment (LAN before Tailscale). While on a worse route it re-checks the
//! better ones every minute, so walking back into the house moves the TV from Tailscale to
//! the LAN. The socket is dropped while Luma isn't in front.
use super::{
    model::{Shell, ThreadDetail},
    pairing::{self, Pairing, PairingError},
    routes::{self, Route},
    rpc::{Message, Socket},
    types::{DirectEndpoint, ShellStreamItem},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant},
};

const PROBE: Duration = Duration::from_millis(2500);
const OPEN: Duration = Duration::from_secs(10);
const SNAPSHOT: Duration = Duration::from_secs(15);
const UPGRADE: Duration = Duration::from_secs(60);
const COOLDOWN: Duration = Duration::from_secs(5 * 60);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const CACHED_DETAILS: usize = 16;
/// The session name T3 Code shows in its Connections settings.
pub const DEVICE_LABEL: &str = "Luma TV";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Unpaired,
    Connecting,
    Connected,
    Offline,
    Expired,
    Paused,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Decide {
        thread: String,
        request: String,
        decision: String,
    },
    Answer {
        thread: String,
        request: String,
        answers: BTreeMap<String, Value>,
    },
    Send {
        thread: String,
        text: String,
    },
    Stop {
        thread: String,
    },
}

impl Action {
    pub fn thread(&self) -> &str {
        match self {
            Self::Decide { thread, .. }
            | Self::Answer { thread, .. }
            | Self::Send { thread, .. }
            | Self::Stop { thread } => thread,
        }
    }

    fn command(&self) -> Value {
        let mut command = match self {
            Self::Decide {
                thread,
                request,
                decision,
            } => json!({"type": "runtime-request.respond", "threadId": thread,
                "requestId": request, "decision": decision}),
            Self::Answer {
                thread,
                request,
                answers,
            } => json!({"type": "runtime-request.respond", "threadId": thread,
                "requestId": request, "answers": answers}),
            // The server decides whether a message steers or queues behind an active run.
            Self::Send { thread, text } => json!({"type": "message.dispatch", "createdBy": "user",
                "creationSource": "web", "threadId": thread, "messageId": uuid(), "text": text,
                "attachments": [], "deliveryIntent": "auto",
                "dispatchMode": {"type": "start_immediately"}}),
            Self::Stop { thread } => json!({"type": "thread.stop", "threadId": thread}),
        };
        command["commandId"] = json!(uuid());
        command
    }
}

fn uuid() -> String {
    let mut bytes = [0u8; 16];
    // A failed read leaves zeros: still a valid id, and T3 Code only needs it unique per command.
    let _ = getrandom::getrandom(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

pub enum Command {
    Pair {
        address: String,
        code: String,
    },
    Unpair,
    /// Luma is in front: connect, or stay connected.
    Resume,
    /// Another app is in front; the TV has better uses for the socket.
    Pause,
    /// Streams full detail for the thread on screen, one at a time.
    Focus(Option<String>),
    Act(Action),
    /// A one-time pairing code for T3 Code's web app.
    WebCode,
}

#[derive(Clone, Debug)]
pub enum Event {
    Status(Status),
    Pairing(Option<Pairing>),
    Route(Option<Route>),
    Shell(Shell),
    Detail(ThreadDetail),
    Paired(Result<(), PairingError>),
    Done(Action, Result<(), String>),
    WebCode(Result<(Route, String), PairingError>),
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64)
}

pub fn spawn(path: PathBuf) -> (Sender<Command>, Receiver<Event>) {
    let (commands, worker_commands) = mpsc::channel();
    let (worker_events, events) = mpsc::channel();
    thread::spawn(move || {
        let pairing = Pairing::load(&path);
        let mut worker = Worker {
            status: if pairing.is_some() {
                Status::Paused
            } else {
                Status::Unpaired
            },
            path,
            pairing,
            commands: worker_commands,
            events: worker_events,
            visible: false,
            focus: None,
            details: Vec::new(),
            backoff: Duration::from_secs(1),
            retry_at: None,
            cooldown: HashMap::new(),
            upgrading_to: None,
        };
        worker.run();
    });
    (commands, events)
}

struct Worker {
    path: PathBuf,
    commands: Receiver<Command>,
    events: Sender<Event>,
    pairing: Option<Pairing>,
    status: Status,
    visible: bool,
    focus: Option<String>,
    /// Last known detail per thread, newest last, so returning to an agent shows it at once.
    details: Vec<ThreadDetail>,
    backoff: Duration,
    retry_at: Option<Instant>,
    cooldown: HashMap<String, Instant>,
    upgrading_to: Option<String>,
}

/// Why a live session ended.
enum End {
    Lost,
    /// Deliberately closed; state already reflects the command that closed it.
    Closed,
    /// A better route answered.
    Upgrade,
}

impl Worker {
    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }

    fn set_status(&mut self, status: Status) {
        if self.status != status {
            self.status = status;
            self.emit(Event::Status(status));
        }
    }

    fn run(&mut self) {
        self.emit(Event::Pairing(self.pairing.clone()));
        self.emit(Event::Status(self.status));
        loop {
            if self.should_connect() {
                self.connect();
                continue;
            }
            let wait = self.retry_at.map_or(Duration::from_secs(3600), |at| {
                at.saturating_duration_since(Instant::now())
            });
            match self.commands.recv_timeout(wait) {
                Ok(command) => self.idle(command),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn should_connect(&self) -> bool {
        self.visible
            && self.pairing.is_some()
            && matches!(
                self.status,
                Status::Paused | Status::Offline | Status::Connecting
            )
            && self.retry_at.is_none_or(|at| at <= Instant::now())
    }

    /// Commands that arrive without a live session.
    fn idle(&mut self, command: Command) {
        match command {
            Command::Pair { address, code } => self.pair(&address, &code),
            Command::Unpair => self.unpair(),
            Command::Resume => self.resume(),
            Command::Pause => self.pause(),
            Command::Focus(thread) => self.focus(thread),
            Command::Act(action) => self.emit(Event::Done(action, Err("offline".into()))),
            Command::WebCode => self.emit(Event::WebCode(Err(PairingError::Unreachable))),
        }
    }

    fn resume(&mut self) {
        self.visible = true;
        if self.status == Status::Paused {
            self.backoff = Duration::from_secs(1);
            self.retry_at = None;
        }
    }

    fn pause(&mut self) {
        self.visible = false;
        if self.pairing.is_some() && self.status != Status::Expired {
            self.retry_at = None;
            self.set_status(Status::Paused);
        }
    }

    fn pair(&mut self, address: &str, code: &str) {
        match pairing::pair(address, code, DEVICE_LABEL, now()) {
            Ok(pairing) => {
                if let Err(error) = pairing.save(&self.path) {
                    eprintln!("Luma T3 Code pairing: {error}");
                }
                self.pairing = Some(pairing);
                self.details.clear();
                self.emit(Event::Shell(Shell::default()));
                self.emit(Event::Pairing(self.pairing.clone()));
                self.emit(Event::Paired(Ok(())));
                self.status = Status::Paused;
                self.resume();
            }
            Err(error) => self.emit(Event::Paired(Err(error))),
        }
    }

    fn unpair(&mut self) {
        Pairing::remove(&self.path);
        self.pairing = None;
        self.details.clear();
        self.retry_at = None;
        self.emit(Event::Pairing(None));
        self.emit(Event::Route(None));
        self.emit(Event::Shell(Shell::default()));
        self.set_status(Status::Unpaired);
    }

    fn focus(&mut self, thread: Option<String>) {
        if thread == self.focus {
            return;
        }
        self.focus = thread;
        if let Some(thread) = &self.focus {
            let cached = self
                .details
                .iter()
                .find(|detail| &detail.thread_id == thread)
                .cloned();
            self.emit(Event::Detail(
                cached.unwrap_or_else(|| ThreadDetail::new(thread)),
            ));
        }
    }

    fn remember(&mut self, detail: &ThreadDetail) {
        self.details
            .retain(|cached| cached.thread_id != detail.thread_id);
        self.details.push(detail.clone());
        if self.details.len() > CACHED_DETAILS {
            self.details.remove(0);
        }
    }

    fn connect(&mut self) {
        let Some(pairing) = self.pairing.clone() else {
            return;
        };
        self.retry_at = None;
        if pairing.expired(now()) {
            self.set_status(Status::Expired);
            return;
        }
        self.set_status(Status::Connecting);
        let at = Instant::now();
        let routes: Vec<_> = pairing
            .routes
            .iter()
            .filter(|route| {
                self.cooldown
                    .get(&route.url)
                    .is_none_or(|until| *until < at)
            })
            .cloned()
            .collect();
        // Only routes that answer as the paired environment right now get the token. An
        // address proves nothing by itself: LAN addresses change owners, and a Tailscale
        // address names a device, not the server listening on it.
        for route in probe(&routes, &pairing.environment_id) {
            match self.open(&pairing, &route) {
                Ok((socket, shell_id, shell)) => {
                    if self.upgrading_to.take().as_deref() == Some(route.url.as_str()) {
                        self.cooldown.remove(&route.url);
                    }
                    let connected = Instant::now();
                    match self.serve(socket, shell_id, route, shell) {
                        End::Lost => {
                            // A connection that held for a while resets the backoff.
                            if connected.elapsed() > Duration::from_secs(30) {
                                self.backoff = Duration::from_secs(1);
                            }
                            self.emit(Event::Route(None));
                            self.set_status(Status::Connecting);
                            self.schedule_retry();
                        }
                        End::Upgrade => {
                            self.emit(Event::Route(None));
                            self.set_status(Status::Connecting);
                        }
                        End::Closed => self.emit(Event::Route(None)),
                    }
                    return;
                }
                Err(PairingError::Expired) => {
                    self.set_status(Status::Expired);
                    return;
                }
                Err(_) => {}
            }
        }
        self.upgrading_to = None;
        self.set_status(Status::Offline);
        self.schedule_retry();
    }

    fn schedule_retry(&mut self) {
        self.retry_at = Some(Instant::now() + self.backoff);
        self.backoff = (self.backoff * 2).min(MAX_BACKOFF);
    }

    /// Opens the socket and waits for the shell's first snapshot.
    fn open(
        &mut self,
        pairing: &Pairing,
        route: &Route,
    ) -> Result<(Socket, u64, Shell), PairingError> {
        let ticket = pairing::websocket_ticket(route, &pairing.token)?;
        let mut socket = Socket::connect(&pairing::socket_url(route, &ticket), OPEN)
            .map_err(|_| PairingError::Unreachable)?;
        let id = socket
            .request(
                "orchestration.subscribeShell",
                json!({"requestCompletionMarker": true}),
            )
            .map_err(|_| PairingError::Unreachable)?;
        let mut shell = Shell::default();
        let started = Instant::now();
        while !shell.ready {
            if started.elapsed() > SNAPSHOT {
                socket.close();
                return Err(PairingError::Unreachable);
            }
            for message in socket.poll().map_err(|_| PairingError::Unreachable)? {
                if let Message::Chunk { id: chunk, values } = message
                    && chunk == id
                {
                    apply_shell(&mut shell, values);
                }
            }
        }
        Ok((socket, id, shell))
    }

    fn serve(&mut self, mut socket: Socket, shell_id: u64, route: Route, mut shell: Shell) -> End {
        self.emit(Event::Shell(shell.clone()));
        self.emit(Event::Route(Some(route.clone())));
        self.set_status(Status::Connected);
        let config_id = socket.request("server.getConfig", json!({})).ok();
        let mut stream: Option<(u64, ThreadDetail)> = None;
        let mut watched: Option<String> = None;
        let mut actions: HashMap<u64, Action> = HashMap::new();
        let mut upgrade_at = Instant::now() + UPGRADE;
        let mut upgrade: Option<Receiver<Option<Route>>> = None;
        loop {
            // The thread on screen gets the live stream; the cached detail showed already.
            if self.focus != watched {
                if let Some((id, _)) = stream.take() {
                    let _ = socket.interrupt(id);
                }
                watched = self.focus.clone();
                if let Some(thread) = &watched {
                    stream = socket
                        .request(
                            "orchestration.subscribeThread",
                            json!({"threadId": thread, "requestCompletionMarker": true,
                                "acceptBoundedSnapshot": true}),
                        )
                        .ok()
                        .map(|id| (id, ThreadDetail::new(thread)));
                }
            }
            let messages = match socket.poll() {
                Ok(messages) => messages,
                Err(error) => {
                    eprintln!("Luma T3 Code connection: {error}");
                    return End::Lost;
                }
            };
            let mut shell_changed = false;
            for message in messages {
                match message {
                    Message::Chunk { id, values } if id == shell_id => {
                        apply_shell(&mut shell, values);
                        shell_changed = true;
                    }
                    Message::Chunk { id, values } => {
                        if let Some((stream_id, detail)) = &mut stream
                            && *stream_id == id
                        {
                            for value in &values {
                                detail.apply(value);
                            }
                            if detail.ready {
                                let detail = detail.clone();
                                self.remember(&detail);
                                self.emit(Event::Detail(detail));
                            }
                        }
                    }
                    Message::Exit { id, .. } if id == shell_id => return End::Lost,
                    Message::Exit { id, result } if Some(id) == config_id => {
                        if let Ok(config) = result {
                            self.learn(&config, &route);
                        }
                    }
                    Message::Exit { id, result } => {
                        if let Some(action) = actions.remove(&id) {
                            self.emit(Event::Done(action, result.map(|_| ())));
                        }
                    }
                }
            }
            if shell_changed {
                self.emit(Event::Shell(shell.clone()));
            }
            loop {
                let command = match self.commands.try_recv() {
                    Ok(command) => command,
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        socket.close();
                        return End::Closed;
                    }
                };
                match command {
                    Command::Resume => self.visible = true,
                    Command::Focus(thread) => self.focus(thread),
                    Command::Act(action) => {
                        match socket.request("orchestration.dispatchCommand", action.command()) {
                            Ok(id) => {
                                actions.insert(id, action);
                            }
                            Err(error) => self.emit(Event::Done(action, Err(error))),
                        }
                    }
                    Command::WebCode => {
                        let events = self.events.clone();
                        let (route, token) = (
                            route.clone(),
                            self.pairing
                                .as_ref()
                                .map(|p| p.token.clone())
                                .unwrap_or_default(),
                        );
                        thread::spawn(move || {
                            let code = pairing::pairing_code(
                                &route,
                                &token,
                                &format!("{DEVICE_LABEL} (T3 Code)"),
                            );
                            let _ = events.send(Event::WebCode(code.map(|code| (route, code))));
                        });
                    }
                    Command::Pause | Command::Unpair | Command::Pair { .. } => {
                        socket.close();
                        for (_, action) in actions.drain() {
                            self.emit(Event::Done(action, Err("offline".into())));
                        }
                        self.idle(command);
                        return End::Closed;
                    }
                }
            }
            if let Some(answer) = &upgrade {
                match answer.try_recv() {
                    Ok(Some(better)) => {
                        // If the switch doesn't land on the better route, don't keep trying it.
                        self.cooldown
                            .insert(better.url.clone(), Instant::now() + COOLDOWN);
                        self.upgrading_to = Some(better.url);
                        socket.close();
                        return End::Upgrade;
                    }
                    Ok(None) | Err(mpsc::TryRecvError::Disconnected) => upgrade = None,
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            } else if Instant::now() >= upgrade_at {
                upgrade_at = Instant::now() + UPGRADE;
                upgrade = self.check_better_routes(&route);
            }
        }
    }

    /// Saves every address the server reports, so the token keeps working away from home.
    fn learn(&mut self, config: &Value, route: &Route) {
        let Some(pairing) = &mut self.pairing else {
            return;
        };
        let endpoints: Vec<DirectEndpoint> = config
            .get("directEndpoints")
            .and_then(|endpoints| serde_json::from_value(endpoints.clone()).ok())
            .unwrap_or_default();
        let routes = routes::learn(&pairing.routes, &endpoints, &pairing.paired_on);
        if routes == pairing.routes {
            return;
        }
        pairing.routes = routes;
        if let Err(error) = pairing.save(&self.path) {
            eprintln!("Luma T3 Code pairing: {error}");
        }
        self.emit(Event::Pairing(self.pairing.clone()));
        self.emit(Event::Route(Some(route.clone())));
    }

    /// Probes the routes ranked above the current one, off the socket's thread.
    fn check_better_routes(&self, current: &Route) -> Option<Receiver<Option<Route>>> {
        let pairing = self.pairing.as_ref()?;
        let index = pairing
            .routes
            .iter()
            .position(|route| route.url == current.url)?;
        let at = Instant::now();
        let better: Vec<_> = pairing.routes[..index]
            .iter()
            .filter(|route| {
                self.cooldown
                    .get(&route.url)
                    .is_none_or(|until| *until < at)
            })
            .cloned()
            .collect();
        if better.is_empty() {
            return None;
        }
        let environment = pairing.environment_id.clone();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let _ = sender.send(probe(&better, &environment).into_iter().next());
        });
        Some(receiver)
    }
}

fn apply_shell(shell: &mut Shell, values: Vec<Value>) {
    for value in values {
        if let Ok(item) = serde_json::from_value::<ShellStreamItem>(value) {
            shell.apply(item);
        }
    }
}

/// The routes that answer as `environment`, in their saved order, checked in parallel.
fn probe(routes: &[Route], environment: &str) -> Vec<Route> {
    let checks: Vec<_> = routes
        .iter()
        .cloned()
        .map(|route| {
            let environment = environment.to_owned();
            thread::spawn(move || {
                pairing::describe(&route, PROBE)
                    .is_ok_and(|answer| answer.environment_id == environment)
                    .then_some(route)
            })
        })
        .collect();
    checks
        .into_iter()
        .filter_map(|check| check.join().ok().flatten())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::{TcpListener, TcpStream},
        sync::{Arc, Mutex},
    };
    use tungstenite::Message as Frame;

    /// Replays the request head a test server already read, so tungstenite can accept it.
    struct Replay {
        head: std::io::Cursor<Vec<u8>>,
        stream: TcpStream,
    }

    impl Read for Replay {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            match self.head.read(buffer)? {
                0 => self.stream.read(buffer),
                read => Ok(read),
            }
        }
    }

    impl Write for Replay {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.stream.write(buffer)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.stream.flush()
        }
    }

    /// A T3 Code stand-in: identity, ticket and a WebSocket that sends one shell snapshot
    /// and answers every dispatched command.
    fn fake_server(commands: Arc<Mutex<Vec<Value>>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let commands = commands.clone();
                thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut head = Vec::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        head.extend_from_slice(line.as_bytes());
                        if line == "\r\n" {
                            break;
                        }
                    }
                    let first = String::from_utf8_lossy(&head)
                        .lines()
                        .next()
                        .unwrap()
                        .to_owned();
                    let mut stream = stream;
                    let reply = |stream: &mut TcpStream, body: &str| {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        );
                    };
                    if first.starts_with("GET /.well-known/t3/environment") {
                        reply(
                            &mut stream,
                            r#"{"environmentId":"env-1","label":"workstation"}"#,
                        );
                    } else if first.starts_with("POST /api/auth/websocket-ticket") {
                        reply(&mut stream, r#"{"ticket":"ticket-1"}"#);
                    } else if first.starts_with("GET /ws?wsTicket=ticket-1") {
                        let mut socket = tungstenite::accept(Replay {
                            head: std::io::Cursor::new(head),
                            stream,
                        })
                        .unwrap();
                        while let Ok(frame) = socket.read() {
                            let Frame::Text(text) = frame else { continue };
                            let message: Value = serde_json::from_str(&text).unwrap();
                            if message["_tag"] != "Request" {
                                continue;
                            }
                            let id = message["id"].clone();
                            let reply = match message["tag"].as_str().unwrap() {
                                "orchestration.subscribeShell" => json!({"_tag": "Chunk",
                                    "requestId": id, "values": [{"kind": "snapshot", "snapshot": {
                                        "snapshotSequence": 1, "projects": [],
                                        "threads": [{"id": "t1", "projectId": "p", "title": "Fix it",
                                            "status": "running", "createdAt": "2026-10-20T19:00:00Z",
                                            "updatedAt": "2026-10-20T19:59:00Z"}]}}]}),
                                "orchestration.dispatchCommand" => {
                                    commands.lock().unwrap().push(message["payload"].clone());
                                    json!({"_tag": "Exit", "requestId": id,
                                        "exit": {"_tag": "Success", "value": null}})
                                }
                                _ => json!({"_tag": "Exit", "requestId": id,
                                    "exit": {"_tag": "Success", "value": {}}}),
                            };
                            let _ = socket.send(Frame::text(reply.to_string()));
                        }
                    }
                });
            }
        });
        url
    }

    fn next(events: &Receiver<Event>, mut matches: impl FnMut(&Event) -> bool) -> Event {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let event = events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("event in time");
            if matches(&event) {
                return event;
            }
        }
    }

    #[test]
    fn a_saved_pairing_connects_when_resumed_streams_the_shell_and_dispatches_commands() {
        let commands = Arc::new(Mutex::new(Vec::new()));
        let server = fake_server(commands.clone());
        let directory =
            std::env::temp_dir().join(format!("luma-t3-connection-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("t3-pairing.json");
        let route = Route::new(&server).unwrap();
        Pairing {
            environment_id: "env-1".into(),
            label: "workstation".into(),
            token: "token-1".into(),
            expires_at: 0,
            paired_on: route.clone(),
            routes: vec![route],
        }
        .save(&path)
        .unwrap();

        let (sender, events) = spawn(path);
        // Paired but not in front: no connection yet.
        assert!(matches!(
            next(&events, |event| matches!(event, Event::Status(_))),
            Event::Status(Status::Paused)
        ));
        sender.send(Command::Resume).unwrap();
        // The first snapshot arrives with the connection.
        let Event::Shell(shell) = next(
            &events,
            |event| matches!(event, Event::Shell(shell) if shell.ready),
        ) else {
            unreachable!()
        };
        next(&events, |event| {
            matches!(event, Event::Status(Status::Connected))
        });
        assert_eq!(shell.threads["t1"].title, "Fix it");

        sender
            .send(Command::Act(Action::Stop {
                thread: "t1".into(),
            }))
            .unwrap();
        let Event::Done(action, result) = next(&events, |event| matches!(event, Event::Done(..)))
        else {
            unreachable!()
        };
        assert_eq!(action.thread(), "t1");
        assert_eq!(result, Ok(()));
        let sent = commands.lock().unwrap()[0].clone();
        assert_eq!(sent["type"], "thread.stop");
        assert_eq!(sent["threadId"], "t1");
        assert_eq!(sent["commandId"].as_str().unwrap().len(), 36);

        sender.send(Command::Pause).unwrap();
        next(&events, |event| {
            matches!(event, Event::Status(Status::Paused))
        });
        std::fs::remove_dir_all(directory).unwrap();
    }
}
