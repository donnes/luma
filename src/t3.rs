//! T3 Code agents on the TV: pairing with a T3 Code server, a live view of its threads, and
//! answering what an agent asks, over the same WebSocket API as T3 Code's own clients.
//!
//! The connection runs on its own thread (`connection`); the UI sends it `Command`s and
//! folds its `Event`s into `Agents` each frame.
pub mod connection;
pub mod model;
pub mod pairing;
pub mod routes;
pub mod rpc;
pub mod types;

pub use connection::{Action, Command, Event, Status};
use model::{Shell, ThreadDetail};
use pairing::{Pairing, PairingError};
use routes::Route;
use std::{
    path::Path,
    sync::mpsc::{Receiver, Sender},
};

pub struct Service {
    sender: Sender<Command>,
    receiver: Receiver<Event>,
}

impl Service {
    /// The pairing lives beside the preferences, as `t3-pairing.json`. A disabled service
    /// (scripted previews) answers nothing and never reads the pairing.
    pub fn new(preferences: &Path, enabled: bool) -> Self {
        if !enabled {
            let (sender, _) = std::sync::mpsc::channel();
            let (_, receiver) = std::sync::mpsc::channel();
            return Self { sender, receiver };
        }
        let (sender, receiver) = connection::spawn(preferences.with_file_name("t3-pairing.json"));
        Self { sender, receiver }
    }

    pub fn send(&self, command: Command) {
        let _ = self.sender.send(command);
    }

    pub fn events(&self) -> impl Iterator<Item = Event> + '_ {
        self.receiver.try_iter()
    }
}

/// What the UI knows about the connection, kept current from the worker's events.
#[derive(Clone, Debug)]
pub struct Agents {
    /// The worker has reported the saved pairing (or none) at least once.
    pub loaded: bool,
    pub status: Status,
    pub pairing: Option<Pairing>,
    pub route: Option<Route>,
    pub shell: Shell,
    pub detail: Option<ThreadDetail>,
}

impl Default for Agents {
    fn default() -> Self {
        Self {
            loaded: false,
            status: Status::Unpaired,
            pairing: None,
            route: None,
            shell: Shell::default(),
            detail: None,
        }
    }
}

/// Events the UI acts on beyond updating `Agents`.
#[derive(Debug)]
pub enum Outcome {
    Paired(Result<(), PairingError>),
    Done(Action, Result<(), String>),
    WebCode(Result<(Route, String), PairingError>),
}

impl Agents {
    pub fn apply(&mut self, event: Event) -> Option<Outcome> {
        match event {
            Event::Status(status) => self.status = status,
            Event::Pairing(pairing) => {
                self.pairing = pairing;
                self.loaded = true;
            }
            Event::Route(route) => self.route = route,
            Event::Shell(shell) => self.shell = shell,
            Event::Detail(detail) => self.detail = Some(detail),
            Event::Paired(result) => return Some(Outcome::Paired(result)),
            Event::Done(action, result) => return Some(Outcome::Done(action, result)),
            Event::WebCode(result) => return Some(Outcome::WebCode(result)),
        }
        None
    }

    /// The streamed detail of `thread`, once its snapshot arrived.
    pub fn detail_of(&self, thread: &str) -> Option<&ThreadDetail> {
        self.detail
            .as_ref()
            .filter(|detail| detail.thread_id == thread && detail.ready)
    }
}
