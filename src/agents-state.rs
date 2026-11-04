//! The agents page's state, behind the T3 Code tile: which agent the spotlight shows, its
//! actions, pairing and replies.
//! T3 Code itself runs in `crate::t3`; this queues the commands the UI sends it in `outbox`,
//! which the main loop hands to the connection worker.
use super::{Overlay, Page, State, Target, TextField};
use crate::t3::{
    self, Action, Command, Outcome, Status,
    model::{Agent, Pending},
    pairing::PairingError,
    routes::{InputError, parse_pairing_input},
};
use std::collections::BTreeMap;

/// The T3 Code tile's id: never an installed app's, and never launched or uninstalled.
pub const AGENTS_APP_ID: &str = "luma.t3code";

/// What the main loop does on the UI's behalf.
#[derive(Debug, PartialEq)]
pub enum Outbound {
    Command(Command),
    /// Fire TV: open T3 Code's web app at `url`, going on to `then`; `origin` is now paired.
    OpenWeb {
        url: String,
        then: String,
        origin: String,
    },
}

pub struct AgentsUi {
    /// The tab the T3 Code tile was opened from, which Back returns to.
    pub origin: usize,
    /// The spotlight's agent, pinned so it doesn't follow the shelf's order around.
    pub selected: Option<String>,
    pub address: String,
    pub code: String,
    /// The last pairing error, as a message key.
    pub error: Option<&'static str>,
    pub pairing: bool,
    pub reply: String,
    pub reply_thread: Option<String>,
    pub reply_return: Target,
    /// An action is on its way to T3 Code; the spotlight's actions wait for it.
    pub busy: bool,
    pub outbox: Vec<Outbound>,
    /// The origin whose web app already has a session, so Open needn't pair it again.
    pub web_origin: Option<String>,
    /// A web app path waiting for its pairing code.
    pub opening: Option<String>,
    /// Preferences changed (the tile was pinned); the main loop saves them.
    pub save: bool,
    /// When the web app last asked to be paired again; a second ask this soon means its
    /// session won't stick, so Luma stops rather than loop.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub repaired: Option<std::time::Instant>,
}

impl Default for AgentsUi {
    fn default() -> Self {
        Self {
            origin: 0,
            selected: None,
            address: String::new(),
            code: String::new(),
            error: None,
            pairing: false,
            reply: String::new(),
            reply_thread: None,
            reply_return: Target::AgentAction(0),
            busy: false,
            outbox: Vec::new(),
            web_origin: None,
            opening: None,
            save: false,
            repaired: None,
        }
    }
}

pub fn draft_limit(field: TextField) -> usize {
    match field {
        TextField::Reply => 4000,
        _ => 300,
    }
}

/// One pill in the spotlight's action row.
#[derive(Clone, Debug, PartialEq)]
pub enum AgentAction {
    Decide {
        decision: String,
        label: String,
    },
    /// One option of a single-choice question, answered in place.
    Choose {
        question: String,
        answer: String,
    },
    /// A question that needs more than a pill opens the thread.
    Answer,
    Open,
    Reply,
    Stop,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64)
}

/// Whether Open can show a thread here: T3 Code's web app needs Fire TV's second WebView.
pub const OPENS_WEB_APP: bool = cfg!(target_os = "android");

impl State {
    /// The T3 Code tile sits in the app library like an installed app, in title order.
    pub(super) fn add_agents_tile(&mut self) {
        let apps = &mut self.inventory.apps;
        // A failed read stays empty: the library shows what the TV reported, plus the tile.
        if apps.is_empty() || apps.iter().any(|app| app.id == AGENTS_APP_ID) {
            return;
        }
        let tile = crate::model::App::new(AGENTS_APP_ID, "T3 Code");
        let title = tile.title.to_lowercase();
        let index = apps
            .iter()
            .position(|app| app.title.to_lowercase() > title)
            .unwrap_or(apps.len());
        apps.insert(index, tile);
    }

    fn open_agents(&mut self) {
        let origin = self.page_index();
        self.open(origin);
        self.agents_ui.origin = origin;
        self.page = Page::Agents;
        self.focus = self.agents_first_content();
    }

    /// Back to the tab the tile was opened from, on the tile.
    pub(super) fn close_agents(&mut self) {
        self.open(self.agents_ui.origin);
        self.focus = Target::App(AGENTS_APP_ID.into());
        self.reconcile_focus();
    }

    /// Pairing pins the tile to Home, where the web launcher put it too.
    fn pin_agents_tile(&mut self) {
        let mut favorites = self.preferences.favorites(&self.inventory.apps);
        if !favorites.iter().any(|id| id == AGENTS_APP_ID) {
            favorites.insert(0, AGENTS_APP_ID.to_owned());
            self.preferences.favorites = Some(favorites);
            self.agents_ui.save = true;
        }
    }

    pub fn agents_draft(&mut self, field: TextField) -> Option<&mut String> {
        match field {
            TextField::PairAddress => Some(&mut self.agents_ui.address),
            TextField::PairCode => Some(&mut self.agents_ui.code),
            TextField::Reply => Some(&mut self.agents_ui.reply),
            _ => None,
        }
    }

    /// The pairing screen shows while unpaired or after the token stopped working.
    pub fn agents_pairing_screen(&self) -> bool {
        self.agents.pairing.is_none() || self.agents.status == Status::Expired
    }

    /// The spotlight's agent: the pinned one while it's on the shelf, else the first.
    pub fn agents_current(&self) -> Option<Agent<'_>> {
        let shelf = self.agents.shell.shelf(now_ms());
        let pinned = self
            .agents_ui
            .selected
            .as_ref()
            .and_then(|id| shelf.iter().position(|agent| &agent.thread.id == id));
        let index = pinned.unwrap_or(0);
        shelf.into_iter().nth(index)
    }

    /// The thread whose detail the connection should stream.
    pub fn agents_focus_thread(&self) -> Option<String> {
        (self.page == Page::Agents && !self.agents_pairing_screen())
            .then(|| self.agents_current().map(|agent| agent.thread.id.clone()))
            .flatten()
    }

    pub fn agents_pending(&self) -> Option<Pending> {
        let agent = self.agents_current()?;
        if !agent.status.needs_you() {
            return None;
        }
        self.agents.detail_of(&agent.thread.id)?.pending()
    }

    pub fn agents_actions(&self) -> Vec<AgentAction> {
        let Some(agent) = self.agents_current() else {
            return vec![];
        };
        let mut actions = Vec::new();
        match self.agents_pending() {
            Some(Pending::Approval { options, .. }) => {
                actions.extend(options.into_iter().map(|option| AgentAction::Decide {
                    decision: option.decision,
                    label: option.label,
                }));
            }
            Some(Pending::Question { questions, .. }) => match questions.as_slice() {
                // One single-choice question answers in place, like T3 Code's own quick replies.
                [question] if !question.multi_select && !question.options.is_empty() => {
                    actions.extend(question.options.iter().map(|option| AgentAction::Choose {
                        question: question.id.clone(),
                        answer: option.answer().to_owned(),
                    }));
                }
                _ if OPENS_WEB_APP => actions.push(AgentAction::Answer),
                _ => {}
            },
            None => {}
        }
        if OPENS_WEB_APP {
            actions.push(AgentAction::Open);
        }
        actions.push(AgentAction::Reply);
        if agent.status.working() {
            actions.push(AgentAction::Stop);
        }
        actions
    }

    pub fn agents_first_content(&self) -> Target {
        if self.agents_pairing_screen() {
            return Target::PairAddress;
        }
        if !self.agents.shell.ready {
            return if self.agents.status == Status::Offline {
                Target::AgentsRetry
            } else {
                Target::AgentsConnection
            };
        }
        match self.agents_current() {
            Some(_) => Target::AgentAction(0),
            None if OPENS_WEB_APP => Target::AgentsRetry,
            None => Target::AgentsConnection,
        }
    }

    fn send_agents(&mut self, command: Command) {
        self.agents_ui.outbox.push(Outbound::Command(command));
    }

    /// OK on an Agents control; false when the focus isn't one.
    pub(super) fn activate_agents(&mut self) -> bool {
        match self.focus.clone() {
            Target::App(id) if id == AGENTS_APP_ID => self.open_agents(),
            Target::AgentAction(index) => {
                if let Some(action) = self.agents_actions().get(index).cloned() {
                    self.run_agent_action(action);
                }
            }
            Target::Agent(id) => {
                self.agents_ui.selected = Some(id.clone());
                if OPENS_WEB_APP {
                    self.open_agent(&id);
                }
            }
            Target::AgentsConnection => {
                if self.agents.pairing.is_some() {
                    self.overlay = Some(Overlay::AgentsConnection);
                    self.focus = Target::Unpair;
                }
            }
            Target::Unpair => {
                self.send_agents(Command::Unpair);
                self.agents_ui.selected = None;
                self.agents_ui.web_origin = None;
                self.overlay = None;
                self.focus = Target::PairAddress;
            }
            Target::AgentsRetry => {
                if self.agents.status == Status::Offline || !self.agents.shell.ready {
                    // Resuming again skips the backoff.
                    self.send_agents(Command::Pause);
                    self.send_agents(Command::Resume);
                } else {
                    self.open_web_path(String::new());
                }
            }
            Target::PairAddress => self.open_keyboard(TextField::PairAddress),
            Target::PairCode => self.open_keyboard(TextField::PairCode),
            Target::PairSubmit => self.submit_pairing(),
            _ => return false,
        }
        self.dirty = true;
        true
    }

    fn submit_pairing(&mut self) {
        if self.agents_ui.pairing {
            return;
        }
        let ui = &mut self.agents_ui;
        match parse_pairing_input(&ui.address, &ui.code) {
            Err(InputError::MissingAddress | InputError::InvalidAddress) => {
                ui.error = Some("agentsErrorAddress");
                self.focus = Target::PairAddress;
            }
            Err(InputError::MissingCode) => {
                ui.error = Some("agentsErrorCode");
                self.focus = Target::PairCode;
            }
            Ok(_) => {
                ui.error = None;
                ui.pairing = true;
                let command = Command::Pair {
                    address: ui.address.clone(),
                    code: ui.code.clone(),
                };
                self.send_agents(command);
            }
        }
    }

    fn run_agent_action(&mut self, action: AgentAction) {
        let Some(agent) = self.agents_current() else {
            return;
        };
        let thread = agent.thread.id.clone();
        let request = self
            .agents_pending()
            .map(|pending| pending.request_id().to_owned());
        match action {
            AgentAction::Open | AgentAction::Answer => self.open_agent(&thread),
            AgentAction::Reply => {
                self.agents_ui.reply_thread = Some(thread);
                self.agents_ui.reply_return = self.focus.clone();
                self.agents_ui.reply.clear();
                self.open_keyboard(TextField::Reply);
            }
            _ if self.agents_ui.busy => {}
            AgentAction::Stop => self.act(Action::Stop { thread }),
            AgentAction::Decide { decision, .. } => {
                if let Some(request) = request {
                    self.act(Action::Decide {
                        thread,
                        request,
                        decision,
                    });
                }
            }
            AgentAction::Choose { question, answer } => {
                if let Some(request) = request {
                    self.act(Action::Answer {
                        thread,
                        request,
                        answers: BTreeMap::from([(question, answer.into())]),
                    });
                }
            }
        }
    }

    fn act(&mut self, action: Action) {
        self.agents_ui.busy = true;
        self.send_agents(Command::Act(action));
    }

    fn open_agent(&mut self, thread: &str) {
        let Some(pairing) = &self.agents.pairing else {
            return;
        };
        let encode = |value: &str| {
            value
                .bytes()
                .map(|byte| match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                        (byte as char).to_string()
                    }
                    _ => format!("%{byte:02X}"),
                })
                .collect::<String>()
        };
        let path = format!("{}/{}", encode(&pairing.environment_id), encode(thread));
        self.open_web_path(path);
    }

    /// Opens T3 Code's web app at `path`; a server it has no session with gets a fresh
    /// one-time code first, minted with Luma's token.
    fn open_web_path(&mut self, path: String) {
        if !OPENS_WEB_APP {
            return;
        }
        let server = self
            .agents
            .route
            .as_ref()
            .or(self
                .agents
                .pairing
                .as_ref()
                .map(|pairing| &pairing.paired_on))
            .map(|route| route.url.clone());
        let Some(server) = server else {
            return;
        };
        if self.agents_ui.web_origin.as_deref() == Some(server.as_str()) {
            self.agents_ui.outbox.push(Outbound::OpenWeb {
                url: format!("{server}{path}"),
                then: String::new(),
                origin: server,
            });
            return;
        }
        self.agents_ui.opening = Some(path);
        self.send_agents(Command::WebCode);
    }

    /// T3 Code's web app lost its session on its way to `target`: pair it again and go on.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub fn repair_web_app(&mut self, target: &str) {
        self.agents_ui.web_origin = None;
        if self
            .agents_ui
            .repaired
            .is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(30))
        {
            self.notify(self.preferences.language.t("agentsWebFailed"));
            return;
        }
        self.agents_ui.repaired = Some(std::time::Instant::now());
        // Only the path: the code goes to the paired server, whichever address it was.
        let path = target
            .split_once("://")
            .and_then(|(_, rest)| rest.split_once('/'))
            .map_or("", |(_, path)| path);
        self.open_web_path(path.to_owned());
    }

    /// What HomeGuard needs to alert over other apps, as AgentWatch reads it; empty once
    /// unpaired.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub fn agent_watch_config(&self) -> String {
        let language = self.preferences.language;
        self.agents
            .pairing
            .as_ref()
            .map_or(String::new(), |pairing| {
                serde_json::json!({
                    "environmentId": pairing.environment_id,
                    "routes": pairing.routes.iter().map(|route| &route.url).collect::<Vec<_>>(),
                    "token": pairing.token,
                    "source": pairing.name(),
                    "asked": language.t("agentAlertAsked"),
                    "approval": language.t("agentAlertApproval"),
                })
                .to_string()
            })
    }

    /// Closing the keyboard keeps pairing drafts; a reply goes out when it has words.
    pub(super) fn commit_agents_text(&mut self) {
        if self.keyboard_field != TextField::Reply {
            self.agents_ui.error = None;
            return;
        }
        let text = std::mem::take(&mut self.agents_ui.reply);
        let text = text.trim();
        if let Some(thread) = self.agents_ui.reply_thread.take()
            && !text.is_empty()
        {
            self.act(Action::Send {
                thread,
                text: text.to_owned(),
            });
        }
    }

    /// Folds a worker event in; outcomes become notices and follow-ups.
    pub fn agents_event(&mut self, event: t3::Event) {
        self.dirty = true;
        let Some(outcome) = self.agents.apply(event) else {
            return;
        };
        let language = self.preferences.language;
        match outcome {
            Outcome::Paired(Ok(())) => {
                self.agents_ui.pairing = false;
                self.agents_ui.error = None;
                self.agents_ui.address.clear();
                self.agents_ui.code.clear();
                self.agents_ui.web_origin = None;
                self.notify(language.t("agentsPaired"));
                self.pin_agents_tile();
                if self.page == Page::Agents {
                    self.focus = self.agents_first_content();
                }
            }
            Outcome::Paired(Err(error)) => {
                self.agents_ui.pairing = false;
                self.agents_ui.error = Some(match error {
                    PairingError::Input(InputError::MissingCode) => "agentsErrorCode",
                    PairingError::Input(_) => "agentsErrorAddress",
                    PairingError::Unreachable => "agentsErrorUnreachable",
                    PairingError::Incompatible => "agentsErrorIncompatible",
                    PairingError::Rejected | PairingError::Expired => "agentsErrorRejected",
                });
            }
            Outcome::Done(action, result) => {
                self.agents_ui.busy = false;
                if result.is_err() {
                    self.notify(language.t("agentActionFailed"));
                    return;
                }
                match action {
                    Action::Send { .. } => self.notify(language.t("agentReplySent")),
                    Action::Decide { .. } | Action::Answer { .. } => self.next_needing_you(),
                    Action::Stop { .. } => {}
                }
            }
            Outcome::WebCode(Ok((route, code))) => {
                if let Some(path) = self.agents_ui.opening.take() {
                    self.agents_ui.outbox.push(Outbound::OpenWeb {
                        url: format!("{}pair#token={code}", route.url),
                        then: format!("{}{path}", route.url),
                        origin: route.url.clone(),
                    });
                    self.agents_ui.web_origin = Some(route.url);
                }
            }
            Outcome::WebCode(Err(_)) => {
                self.agents_ui.opening = None;
                self.notify(language.t("agentsWebFailed"));
            }
        }
    }

    /// After answering, the spotlight moves on to the next agent that needs you.
    fn next_needing_you(&mut self) {
        let current = self.agents_current().map(|agent| agent.thread.id.clone());
        let next = self
            .agents
            .shell
            .shelf(now_ms())
            .into_iter()
            .find(|agent| agent.status.needs_you() && Some(&agent.thread.id) != current.as_ref())
            .map(|agent| agent.thread.id.clone());
        if let Some(next) = next {
            self.agents_ui.selected = Some(next);
            if self.page == Page::Agents {
                self.focus = Target::AgentAction(0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        state::{Preferences, State},
        t3::{pairing::Pairing, routes::Route},
    };

    #[test]
    fn the_t3_code_tile_opens_the_agents_page_and_back_returns_to_it() {
        use super::AGENTS_APP_ID;
        use crate::state::{Page, Target};
        let mut state = State::new(Preferences::default());
        let apps = crate::platform::normalize_apps(&serde_json::json!([
            {"id": "netflix", "title": "Netflix"},
            {"id": "youtube.leanback.v4", "title": "YouTube"},
            {"id": "com.apple.appletv", "title": "Apple TV"},
        ]))
        .unwrap();
        state.set_inventory(
            crate::model::Inventory {
                apps,
                inputs: vec![],
            },
            None,
        );
        let ids: Vec<_> = state
            .inventory
            .apps
            .iter()
            .map(|app| app.id.as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "com.apple.appletv",
                "netflix",
                AGENTS_APP_ID,
                "youtube.leanback.v4"
            ],
            "in title order"
        );
        assert_eq!(state.inventory.apps[2].brand, "t3-code");
        assert!(!crate::platform::can_uninstall(AGENTS_APP_ID));

        state.open(1);
        state.focus = Target::App(AGENTS_APP_ID.into());
        assert!(state.activate().is_empty(), "the tile launches nothing");
        assert_eq!(state.page, Page::Agents);
        assert_eq!(state.page_index(), 1, "Apps stays highlighted");
        assert_eq!(state.focus, Target::PairAddress);
        state.back();
        assert_eq!(state.page, Page::Apps);
        assert_eq!(state.focus, Target::App(AGENTS_APP_ID.into()));
    }

    #[test]
    fn homeguard_gets_the_pairing_in_the_shape_agent_watch_reads() {
        let mut state = State::new(Preferences::default());
        assert_eq!(
            state.agent_watch_config(),
            "",
            "unpaired clears HomeGuard's copy"
        );
        let lan = Route::new("http://192.168.1.10:3773/").unwrap();
        state.agents.pairing = Some(Pairing {
            environment_id: "env-1".into(),
            label: "donnes-pc".into(),
            token: "token-1".into(),
            expires_at: 0,
            paired_on: lan.clone(),
            routes: vec![lan, Route::new("https://pc.tail1234.ts.net/").unwrap()],
        });
        let config: serde_json::Value = serde_json::from_str(&state.agent_watch_config()).unwrap();
        assert_eq!(config["environmentId"], "env-1");
        assert_eq!(
            config["routes"],
            serde_json::json!(["http://192.168.1.10:3773/", "https://pc.tail1234.ts.net/"])
        );
        assert_eq!(config["token"], "token-1");
        assert_eq!(config["source"], "donnes-pc");
        assert_eq!(config["asked"], "asked a question");
        assert_eq!(config["approval"], "waiting for approval");
    }
}
