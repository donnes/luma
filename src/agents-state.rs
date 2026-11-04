//! The agents page's state, behind the T3 Code tile: which agent the spotlight shows, its
//! actions, pairing and replies.
//! T3 Code itself runs in `crate::t3`; this queues the commands the UI sends it in `outbox`,
//! which the main loop hands to the connection worker.
use super::{Control, Direction, Overlay, Page, State, Target, TextField};
use crate::t3::{
    self, Action, Command, Outcome, Status,
    model::{Agent, AgentStatus, Pending},
    pairing::PairingError,
    routes::{InputError, parse_pairing_input},
};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    time::{Duration, Instant},
};

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
    /// Fire TV: put Luma behind the app the inbox was opened over.
    ReturnToApp,
}

/// An agent that newly needs you, at the top right for a few seconds.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentAlert {
    pub request: String,
    /// It asked a question; otherwise it waits for an approval.
    pub asked: bool,
    pub title: String,
    pub project: String,
}

/// How long an alert stays up, and how long it takes to fade in or out.
pub const ALERT_TIME: Duration = Duration::from_secs(6);
pub const ALERT_FADE: Duration = Duration::from_millis(200);

/// Whether Luma draws its own alerts: on Fire TV, HomeGuard draws them over every app,
/// Luma included.
const DRAWS_ALERTS: bool = !cfg!(target_os = "android");

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
    /// Alerts waiting their turn; the first has shown since `alert_shown`.
    pub alerts: VecDeque<AgentAlert>,
    pub alert_shown: Option<Instant>,
    /// Pending requests already alerted about. None until the first full shell, whose
    /// waiting agents were there before Luma was and don't alert.
    alerted: Option<BTreeSet<String>>,
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
            alerts: VecDeque::new(),
            alert_shown: None,
            alerted: None,
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
            Target::InboxAgent(id) => {
                self.overlay = None;
                if OPENS_WEB_APP {
                    self.open_agent(&id);
                } else {
                    self.agents_ui.selected = Some(id);
                    self.open_agents();
                }
            }
            Target::InboxT3 => {
                self.overlay = None;
                self.open_agents();
            }
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
        let outcome = self.agents.apply(event);
        self.update_agent_alerts();
        let Some(outcome) = outcome else {
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

    /// Up from the spotlight reaches the connection pill at the top right, which the
    /// geometric search would skip for the tabs.
    pub(super) fn agents_up(&self, direction: Direction, controls: &[Control]) -> Option<Target> {
        (self.page == Page::Agents
            && matches!(direction, Direction::Up)
            && matches!(self.focus, Target::AgentAction(_) | Target::AgentsRetry)
            && controls
                .iter()
                .any(|control| control.target == Target::AgentsConnection))
        .then_some(Target::AgentsConnection)
    }

    /// The inbox's rows in order: needs you, then done, then working, as the shelf ranks
    /// them within each group.
    pub fn inbox_groups(&self) -> [(&'static str, Vec<Agent<'_>>); 3] {
        let mut groups = [
            ("agentNeedsYou", Vec::new()),
            ("agentDone", Vec::new()),
            ("agentWorking", Vec::new()),
        ];
        if self.agents.status == Status::Expired {
            return groups;
        }
        for agent in self.agents.shell.shelf(now_ms()) {
            let group = if agent.status.needs_you() {
                0
            } else if agent.status.working() {
                2
            } else {
                1
            };
            groups[group].1.push(agent);
        }
        groups
    }

    /// Menu: the inbox over whatever page is showing, or closed again. `returns` when Fire
    /// TV brought Luma forward for it over another app.
    pub fn toggle_inbox(&mut self, returns: bool) {
        if let Some(Overlay::AgentsInbox { restore, returns }) = &self.overlay {
            let (restore, returns) = (restore.clone(), *returns);
            self.overlay = None;
            self.close_inbox(restore, returns);
            return;
        }
        if self.overlay.is_some() || self.moving.is_some() {
            return;
        }
        let first = self
            .inbox_groups()
            .iter()
            .find_map(|(_, agents)| agents.first())
            .map_or(Target::InboxT3, |agent| {
                Target::InboxAgent(agent.thread.id.clone())
            });
        self.overlay = Some(Overlay::AgentsInbox {
            restore: self.focus.clone(),
            returns,
        });
        self.focus = first;
        self.panel_started = (!self.preferences.reduced_motion).then(Instant::now);
        self.dirty = true;
    }

    pub(super) fn close_inbox(&mut self, restore: Target, returns: bool) {
        self.dirty = true;
        self.focus = restore;
        self.reconcile_focus();
        if returns {
            self.agents_ui.outbox.push(Outbound::ReturnToApp);
        }
    }

    /// Queues an alert for each request that's new since the last shell, and drops those
    /// that ended, say because they were answered elsewhere.
    fn update_agent_alerts(&mut self) {
        let shell = &self.agents.shell;
        if !DRAWS_ALERTS || !shell.ready {
            return;
        }
        let ui = &mut self.agents_ui;
        let pending: BTreeSet<&str> = shell
            .threads
            .values()
            .filter_map(|thread| thread.pending_runtime_request.as_ref())
            .map(|request| request.id.as_str())
            .collect();
        let first = ui.alerted.is_none();
        let alerted = ui.alerted.get_or_insert_with(BTreeSet::new);
        alerted.retain(|id| pending.contains(id.as_str()));
        for agent in shell.shelf(now_ms()) {
            let Some(request) = &agent.thread.pending_runtime_request else {
                continue;
            };
            if !agent.status.needs_you() || !alerted.insert(request.id.clone()) || first {
                continue;
            }
            ui.alerts.push_back(AgentAlert {
                request: request.id.clone(),
                asked: agent.status == AgentStatus::Input,
                title: agent.thread.title.clone(),
                project: agent
                    .project
                    .map_or(String::new(), |project| project.title.clone()),
            });
        }
        let showing = ui.alerts.front().map(|alert| alert.request.clone());
        ui.alerts
            .retain(|alert| pending.contains(alert.request.as_str()));
        if ui.alerts.front().map(|alert| &alert.request) != showing.as_ref() {
            ui.alert_shown = None;
        }
    }

    /// Shows the next alert and retires the one whose time is up.
    pub(super) fn tick_agent_alerts(&mut self) {
        let ui = &mut self.agents_ui;
        if ui.alerts.is_empty() {
            ui.alert_shown = None;
            return;
        }
        match ui.alert_shown {
            None => {
                ui.alert_shown = Some(Instant::now());
                self.dirty = true;
            }
            Some(shown) if shown.elapsed() >= ALERT_TIME => {
                ui.alerts.pop_front();
                ui.alert_shown = None;
                self.dirty = true;
            }
            Some(_) => self.dirty |= self.agent_alert_fading(),
        }
    }

    pub(super) fn agent_alert_fading(&self) -> bool {
        !self.preferences.reduced_motion
            && self.agents_ui.alert_shown.is_some_and(|shown| {
                let elapsed = shown.elapsed();
                elapsed < ALERT_FADE || elapsed + ALERT_FADE > ALERT_TIME
            })
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

    fn needing_you(id: &str, request: &str) -> crate::t3::types::ThreadShell {
        crate::t3::types::ThreadShell {
            id: id.into(),
            title: format!("Thread {id}"),
            status: "running".into(),
            pending_runtime_request: Some(crate::t3::types::PendingRuntimeRequest {
                id: request.into(),
                kind: "user_input".into(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn shell(threads: Vec<crate::t3::types::ThreadShell>) -> crate::t3::Event {
        crate::t3::Event::Shell(crate::t3::model::Shell {
            threads: threads
                .into_iter()
                .map(|thread| (thread.id.clone(), thread))
                .collect(),
            ready: true,
            ..Default::default()
        })
    }

    #[test]
    #[cfg(not(target_os = "android"))]
    fn alerts_are_for_requests_that_arrive_while_luma_watches_and_end_with_them() {
        let mut state = State::new(Preferences::default());
        state.agents_event(shell(vec![needing_you("a", "r1")]));
        assert!(
            state.agents_ui.alerts.is_empty(),
            "what waited before Luma connected doesn't alert"
        );
        state.agents_event(shell(vec![needing_you("a", "r1"), needing_you("b", "r2")]));
        let requests = |state: &State| -> Vec<String> {
            state
                .agents_ui
                .alerts
                .iter()
                .map(|alert| alert.request.clone())
                .collect()
        };
        assert_eq!(requests(&state), ["r2"]);
        assert!(state.agents_ui.alerts[0].asked);
        assert_eq!(state.agents_ui.alerts[0].title, "Thread b");
        state.agents_event(shell(vec![needing_you("a", "r1"), needing_you("b", "r2")]));
        assert_eq!(requests(&state), ["r2"], "one alert per request");
        state.agents_event(shell(vec![needing_you("a", "r1")]));
        assert!(
            requests(&state).is_empty(),
            "answered elsewhere, it leaves the queue"
        );
    }

    #[test]
    fn menu_opens_the_inbox_and_back_returns_to_the_page_or_the_app_it_opened_over() {
        use super::Outbound;
        use crate::state::{Overlay, Page, Target};
        let mut state = State::new(Preferences::default());
        state.agents_event(shell(vec![needing_you("a", "r1")]));
        state.focus = Target::Nav(0);
        state.toggle_inbox(false);
        assert!(matches!(state.overlay, Some(Overlay::AgentsInbox { .. })));
        assert_eq!(state.focus, Target::InboxAgent("a".into()));
        state.back();
        assert!(state.overlay.is_none());
        assert_eq!(state.focus, Target::Nav(0));
        assert!(state.agents_ui.outbox.is_empty());

        state.toggle_inbox(true);
        state.dirty = false;
        state.toggle_inbox(true);
        assert!(state.overlay.is_none(), "Menu closes it too");
        assert!(state.dirty, "and the page redraws without it");
        assert_eq!(state.agents_ui.outbox, [Outbound::ReturnToApp]);

        if !super::OPENS_WEB_APP {
            state.toggle_inbox(false);
            state.activate();
            assert!(state.overlay.is_none());
            assert_eq!(state.page, Page::Agents);
            assert_eq!(state.agents_ui.selected.as_deref(), Some("a"));
        }
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
