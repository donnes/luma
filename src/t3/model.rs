//! Which agents need you, and what they're doing: T3 Code's shell and thread streams folded
//! into state, ordered as the web launcher and T3 Code's own client order them.
use super::types::{
    DecisionOption, ItemKind, ProjectShell, RuntimeRequest, ShellStreamItem, ThreadShell, TurnItem,
    UserInputQuestion,
};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentStatus {
    Input,
    Approval,
    Starting,
    Running,
    Done,
    Error,
    Idle,
}

impl AgentStatus {
    pub fn needs_you(self) -> bool {
        matches!(self, Self::Input | Self::Approval)
    }

    pub fn working(self) -> bool {
        matches!(self, Self::Starting | Self::Running)
    }
}

/// Mirrors T3 Code's packages/shared/src/agentAwareness.ts, so the TV and the desktop agree
/// on which agents are waiting for you.
pub fn agent_status(thread: &ThreadShell) -> AgentStatus {
    let run = thread
        .activity_run_status
        .as_deref()
        .unwrap_or(&thread.status);
    let active = matches!(run, "preparing" | "starting" | "running" | "waiting");
    if let Some(request) = &thread.pending_runtime_request {
        if request.kind == "user_input" && (request.blocking != Some(false) || !active) {
            return AgentStatus::Input;
        }
        if request.kind != "user_input" && request.kind != "auth_refresh" {
            return AgentStatus::Approval;
        }
    }
    match run {
        "preparing" | "starting" => AgentStatus::Starting,
        "running" | "waiting" => AgentStatus::Running,
        // A finished run still waiting on subagents, monitors or background tasks is working.
        // Plain background commands don't hold it.
        "completed"
            if thread.pending_background_tasks.iter().any(|task| {
                matches!(
                    task.kind.as_str(),
                    "subagent" | "monitor" | "background_task"
                )
            }) =>
        {
            AgentStatus::Running
        }
        "completed" => AgentStatus::Done,
        "failed" => AgentStatus::Error,
        _ => AgentStatus::Idle,
    }
}

/// Milliseconds since the epoch, or None for a missing or malformed timestamp.
pub fn millis(timestamp: &str) -> Option<i64> {
    time::OffsetDateTime::parse(timestamp, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|time| (time.unix_timestamp_nanos() / 1_000_000) as i64)
}

#[derive(Clone, Debug)]
pub struct Agent<'a> {
    pub thread: &'a ThreadShell,
    pub project: Option<&'a ProjectShell>,
    pub status: AgentStatus,
}

impl Agent<'_> {
    /// When the agent's current state began: its request, its run, or its last update.
    /// Working agents use their run start: every step bumps updatedAt and would reshuffle.
    pub fn since(&self) -> &str {
        if self.status.needs_you()
            && let Some(request) = &self.thread.pending_runtime_request
        {
            return &request.created_at;
        }
        if self.status.working() {
            return self
                .thread
                .latest_run_started_at
                .as_deref()
                .unwrap_or(&self.thread.created_at);
        }
        &self.thread.updated_at
    }
}

#[derive(Clone, Debug, Default)]
pub struct Shell {
    pub projects: BTreeMap<String, ProjectShell>,
    pub threads: BTreeMap<String, ThreadShell>,
    pub sequence: u64,
    pub ready: bool,
}

const RECENT_MS: i64 = 24 * 60 * 60 * 1000;
pub const SHELF_SIZE: usize = 12;

impl Shell {
    pub fn apply(&mut self, item: ShellStreamItem) {
        let sequence = match &item {
            ShellStreamItem::Snapshot { snapshot } => {
                // A later snapshot without threads refreshes metadata for some projects; it
                // isn't the full list, so it merges into the projects already known.
                if self.ready && snapshot.threads.is_empty() {
                    for project in &snapshot.projects {
                        self.projects.insert(project.id.clone(), project.clone());
                    }
                    return;
                }
                self.projects = snapshot
                    .projects
                    .iter()
                    .map(|project| (project.id.clone(), project.clone()))
                    .collect();
                self.threads = snapshot
                    .threads
                    .iter()
                    .map(|thread| (thread.id.clone(), thread.clone()))
                    .collect();
                self.sequence = snapshot.snapshot_sequence;
                self.ready = true;
                return;
            }
            ShellStreamItem::Other => return,
            ShellStreamItem::ProjectUpdated { sequence, .. }
            | ShellStreamItem::ProjectRemoved { sequence, .. }
            | ShellStreamItem::ThreadUpdated { sequence, .. }
            | ShellStreamItem::ThreadRemoved { sequence, .. } => *sequence,
        };
        // Events at or before the snapshot are already reflected in it.
        if sequence <= self.sequence {
            return;
        }
        self.sequence = sequence;
        match item {
            ShellStreamItem::ProjectUpdated { project, .. } => {
                self.projects.insert(project.id.clone(), project);
            }
            ShellStreamItem::ProjectRemoved { project_id, .. } => {
                self.projects.remove(&project_id);
            }
            ShellStreamItem::ThreadUpdated {
                location, thread, ..
            } => {
                if location == "active" {
                    self.threads.insert(thread.id.clone(), thread);
                } else {
                    self.threads.remove(&thread.id);
                }
            }
            ShellStreamItem::ThreadRemoved { thread_id, .. } => {
                self.threads.remove(&thread_id);
            }
            ShellStreamItem::Snapshot { .. } | ShellStreamItem::Other => {}
        }
    }

    fn agent_for<'a>(&'a self, thread: &'a ThreadShell) -> Agent<'a> {
        Agent {
            thread,
            project: self.projects.get(&thread.project_id),
            status: agent_status(thread),
        }
    }

    fn visible(&self) -> impl Iterator<Item = Agent<'_>> {
        self.threads
            .values()
            .filter(|thread| {
                thread.archived_at.is_none()
                    && thread.deleted_at.is_none()
                    && thread
                        .lineage
                        .as_ref()
                        .and_then(|lineage| lineage.relationship_to_parent.as_deref())
                        != Some("subagent")
            })
            .map(|thread| self.agent_for(thread))
    }

    /// Needs-you agents first, longest waiting first; then working agents and unsettled
    /// agents from the last day, newest first.
    pub fn shelf(&self, now: i64) -> Vec<Agent<'_>> {
        let mut agents: Vec<_> = self
            .visible()
            .filter(|agent| {
                let thread = agent.thread;
                let settled = thread.settled_override.as_deref() == Some("settled")
                    || (thread.settled_at.is_some()
                        && thread.settled_override.as_deref() != Some("active"));
                agent.status.needs_you()
                    || agent.status.working()
                    || (!settled && recent(thread, now))
            })
            .collect();
        let rank = |agent: &Agent| {
            if agent.status.needs_you() {
                0
            } else if agent.status.working() {
                1
            } else {
                2
            }
        };
        agents.sort_by(|a, b| {
            rank(a).cmp(&rank(b)).then_with(|| {
                if rank(a) == 0 {
                    oldest_first(a, b)
                } else {
                    oldest_first(b, a)
                }
            })
        });
        agents.truncate(SHELF_SIZE);
        agents
    }
}

fn recent(thread: &ThreadShell, now: i64) -> bool {
    millis(&thread.updated_at).is_some_and(|updated| now - updated < RECENT_MS)
}

/// Ties break on the thread id in the same direction, as in the web launcher.
fn oldest_first(a: &Agent, b: &Agent) -> std::cmp::Ordering {
    let since = |agent: &Agent| millis(agent.since()).unwrap_or(0);
    since(a)
        .cmp(&since(b))
        .then_with(|| a.thread.id.cmp(&b.thread.id))
}

// --- Thread detail ------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct ThreadDetail {
    pub thread_id: String,
    pub sequence: u64,
    pub items: BTreeMap<String, TurnItem>,
    pub requests: BTreeMap<String, RuntimeRequest>,
    pub ready: bool,
}

impl ThreadDetail {
    pub fn new(thread_id: &str) -> Self {
        Self {
            thread_id: thread_id.into(),
            ..Self::default()
        }
    }

    /// Applies one `orchestration.subscribeThread` item, kept as JSON because its event
    /// payloads vary by type.
    pub fn apply(&mut self, item: &Value) {
        match item.get("kind").and_then(Value::as_str) {
            Some("snapshot") => {
                let projection = item.get("projection");
                let list = |key| {
                    projection
                        .and_then(|projection| projection.get(key))
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or_default()
                };
                self.items = list("turnItems")
                    .iter()
                    .filter_map(TurnItem::parse)
                    .map(|item| (item.id.clone(), item))
                    .collect();
                self.requests = list("runtimeRequests")
                    .iter()
                    .filter_map(|raw| serde_json::from_value::<RuntimeRequest>(raw.clone()).ok())
                    .map(|request| (request.id.clone(), request))
                    .collect();
                self.sequence = item
                    .get("snapshotSequence")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                self.ready = true;
            }
            Some("event") => {
                let Some(sequence) = item.get("sequence").and_then(Value::as_u64) else {
                    return;
                };
                if sequence <= self.sequence {
                    return;
                }
                self.sequence = sequence;
                let event = item.get("event");
                let payload = event.and_then(|event| event.get("payload"));
                match event
                    .and_then(|event| event.get("type"))
                    .and_then(Value::as_str)
                {
                    Some("turn-item.updated") => {
                        if let Some(item) = payload.and_then(TurnItem::parse) {
                            self.items.insert(item.id.clone(), item);
                        }
                    }
                    Some("runtime-request.updated") => {
                        if let Some(request) = payload.and_then(|payload| {
                            serde_json::from_value::<RuntimeRequest>(payload.clone()).ok()
                        }) {
                            self.requests.insert(request.id.clone(), request);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    pub fn ordered(&self) -> Vec<&TurnItem> {
        let mut items: Vec<_> = self.items.values().collect();
        items.sort_by(|a, b| a.ordinal.total_cmp(&b.ordinal));
        items
    }

    /// The oldest pending request with its turn item, paired as T3 Code's
    /// derivePendingThreadRequests pairs them.
    pub fn pending(&self) -> Option<Pending> {
        let items = self.ordered();
        let mut requests: Vec<_> = self
            .requests
            .values()
            .filter(|request| {
                request.status == "pending"
                    && request.kind != "auth_refresh"
                    && request.kind != "dynamic_tool_call"
            })
            .collect();
        requests.sort_by_key(|request| millis(&request.created_at).unwrap_or(0));
        for request in requests {
            if request.kind == "user_input" {
                let questions = items.iter().rev().find_map(|item| match &item.kind {
                    ItemKind::UserInputRequest {
                        request_id,
                        questions,
                    } if request_id == &request.id => Some(questions.clone()),
                    _ => None,
                });
                if let Some(questions) = questions {
                    return Some(Pending::Question {
                        request_id: request.id.clone(),
                        questions,
                    });
                }
                continue;
            }
            let approval = items.iter().rev().find(|item| {
                matches!(&item.kind, ItemKind::ApprovalRequest { request_id, .. } if request_id == &request.id)
            });
            let (detail, options) = match approval {
                Some(TurnItem {
                    title,
                    kind:
                        ItemKind::ApprovalRequest {
                            prompt, options, ..
                        },
                    ..
                }) => (
                    prompt
                        .as_deref()
                        .map(str::trim)
                        .filter(|prompt| !prompt.is_empty())
                        .or(title.as_deref())
                        .unwrap_or_default()
                        .to_owned(),
                    options
                        .iter()
                        .filter(|option| option.decision != "cancel")
                        .cloned()
                        .collect(),
                ),
                _ => (String::new(), Vec::new()),
            };
            return Some(Pending::Approval {
                request_id: request.id.clone(),
                request_kind: request.kind.clone(),
                detail,
                options: if options.is_empty() {
                    default_decisions()
                } else {
                    options
                },
            });
        }
        None
    }

    pub fn last_assistant_text(&self) -> &str {
        self.ordered()
            .into_iter()
            .rev()
            .find_map(|item| match &item.kind {
                ItemKind::AssistantMessage { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub fn recent_steps(&self, count: usize) -> Vec<Step> {
        let steps: Vec<_> = self.ordered().into_iter().filter_map(step).collect();
        steps[steps.len().saturating_sub(count)..].to_vec()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Pending {
    Approval {
        request_id: String,
        request_kind: String,
        detail: String,
        options: Vec<DecisionOption>,
    },
    Question {
        request_id: String,
        questions: Vec<UserInputQuestion>,
    },
}

impl Pending {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Approval { request_id, .. } | Self::Question { request_id, .. } => request_id,
        }
    }
}

fn default_decisions() -> Vec<DecisionOption> {
    [
        ("accept", "Approve"),
        ("acceptForSession", "Allow for this session"),
        ("decline", "Deny"),
    ]
    .into_iter()
    .map(|(decision, label)| DecisionOption {
        decision: decision.into(),
        label: label.into(),
    })
    .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepKind {
    Status,
    Ran,
    Edited,
    Searched,
    SearchedWeb,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub id: String,
    pub kind: StepKind,
    pub detail: String,
    pub status: String,
}

/// One line per tool call: what it did and to what.
fn step(item: &TurnItem) -> Option<Step> {
    let (kind, detail) = match &item.kind {
        // Titled commands are T3's own steps, like "Workspace ready"; the title reads better.
        ItemKind::CommandExecution { input } => match &item.title {
            Some(title) => (StepKind::Status, title.clone()),
            None => (StepKind::Ran, input.clone()),
        },
        ItemKind::FileChange { file_name } => (StepKind::Edited, file_name.clone()),
        ItemKind::FileSearch { pattern } => (
            StepKind::Searched,
            pattern
                .clone()
                .or_else(|| item.title.clone())
                .unwrap_or_default(),
        ),
        ItemKind::WebSearch { patterns } => (StepKind::SearchedWeb, patterns.join(", ")),
        _ => return None,
    };
    Some(Step {
        id: item.id.clone(),
        kind,
        detail,
        status: item.status.clone(),
    })
}

/// Markdown shows as plain text on the TV: the syntax goes, the words stay.
pub fn plain_text(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    // Fenced code blocks read as a space; the text around them stays.
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        let Some(end) = after.find("```") else { break };
        out.push_str(&rest[..start]);
        out.push(' ');
        rest = &after[end + 3..];
    }
    out.push_str(rest);
    let lines: Vec<String> = out.lines().map(plain_line).collect();
    let mut text = String::with_capacity(out.len());
    let mut blank_run = 0;
    for line in &lines {
        if line.is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        text.push_str(line);
        text.push('\n');
    }
    text.trim().to_owned()
}

fn plain_line(line: &str) -> String {
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    let line = if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(char::is_whitespace) {
        trimmed[hashes..].trim_start().to_owned()
    } else if let Some(item) = ["- ", "* ", "+ "]
        .iter()
        .find_map(|bullet| trimmed.strip_prefix(bullet))
    {
        format!("• {}", item.trim_start())
    } else {
        line.to_owned()
    };
    inline(&line)
}

/// Inline code, images, links and bold.
fn inline(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let find = |from: usize, target: char| chars[from..].iter().position(|c| *c == target);
    while i < chars.len() {
        let c = chars[i];
        if c == '`'
            && let Some(len) = find(i + 1, '`')
            && len > 0
        {
            out.extend(&chars[i + 1..i + 1 + len]);
            i += len + 2;
            continue;
        }
        let image = c == '!' && chars.get(i + 1) == Some(&'[');
        if c == '[' || image {
            let open = if image { i + 1 } else { i };
            if let Some(len) = find(open + 1, ']')
                && chars.get(open + 2 + len) == Some(&'(')
                && let Some(url_len) = find(open + 3 + len, ')')
                && (image || len > 0)
            {
                if !image {
                    out.extend(&chars[open + 1..open + 1 + len]);
                }
                i = open + 3 + len + url_len + 1;
                continue;
            }
        }
        if (c == '*' || c == '_') && chars.get(i + 1) == Some(&c) {
            let marker = [c, c];
            if let Some(len) = chars[i + 2..].windows(2).position(|pair| pair == marker)
                && len > 0
            {
                out.extend(&chars[i + 2..i + 2 + len]);
                i += len + 4;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Plain text on one line, cut at a word boundary near `max` characters.
pub fn summary(text: &str, max: usize) -> String {
    let plain = plain_text(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if plain.chars().count() <= max {
        return plain;
    }
    let cut: String = plain.chars().take(max).collect();
    let floor = max.saturating_sub(20);
    let end = cut
        .rfind(' ')
        .filter(|space| cut[..*space].chars().count() >= floor)
        .unwrap_or_else(|| {
            cut.char_indices()
                .nth(floor)
                .map_or(cut.len(), |(at, _)| at)
        });
    format!("{}…", &cut[..end])
}

/// "claude-opus-5-5" reads "Claude Opus 5.5", "gpt-5.5-codex" reads "GPT 5.5 Codex".
pub fn model_label(model: Option<&str>) -> String {
    let Some(model) = model.filter(|model| !model.is_empty()) else {
        return String::new();
    };
    let mut parts: Vec<String> = model.split(['-', '_']).map(str::to_owned).collect();
    // A trailing "N-M" pair is a version: "opus-5-5" is Opus 5.5.
    if let Some(index) = (0..parts.len().saturating_sub(1)).find(|&index| {
        let digits = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());
        digits(&parts[index])
            && digits(&parts[index + 1])
            && (index + 2 == parts.len() || !digits(&parts[index + 2]))
            && index > 0
    }) {
        let minor = parts.remove(index + 1);
        parts[index] = format!("{}.{minor}", parts[index]);
    }
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .map(|part| {
            if part.eq_ignore_ascii_case("gpt") {
                "GPT".to_owned()
            } else {
                let mut chars = part.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().chain(chars).collect())
                    .unwrap_or_default()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::t3::types::{Lineage, PendingRuntimeRequest, ShellSnapshot};
    use serde_json::json;

    const NOW: &str = "2026-10-20T20:00:00Z";

    fn now() -> i64 {
        millis(NOW).unwrap()
    }

    fn minutes_ago(minutes: i64) -> String {
        let time = time::OffsetDateTime::from_unix_timestamp(now() / 1000 - minutes * 60).unwrap();
        time.format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    }

    fn thread(id: &str) -> ThreadShell {
        ThreadShell {
            id: id.into(),
            project_id: "p".into(),
            title: id.into(),
            status: "idle".into(),
            created_at: minutes_ago(60),
            updated_at: minutes_ago(1),
            ..ThreadShell::default()
        }
    }

    fn request(id: &str, kind: &str, minutes: i64) -> Option<PendingRuntimeRequest> {
        Some(PendingRuntimeRequest {
            id: id.into(),
            kind: kind.into(),
            created_at: minutes_ago(minutes),
            blocking: None,
        })
    }

    fn with(id: &str, patch: impl FnOnce(&mut ThreadShell)) -> ThreadShell {
        let mut thread = thread(id);
        patch(&mut thread);
        thread
    }

    fn snapshot(sequence: u64, threads: Vec<ThreadShell>) -> ShellStreamItem {
        ShellStreamItem::Snapshot {
            snapshot: ShellSnapshot {
                snapshot_sequence: sequence,
                projects: vec![ProjectShell {
                    id: "p".into(),
                    title: "luma".into(),
                }],
                threads,
            },
        }
    }

    fn ids(agents: &[Agent]) -> Vec<String> {
        agents.iter().map(|agent| agent.thread.id.clone()).collect()
    }

    #[test]
    fn questions_and_approvals_need_you_and_auth_refreshes_do_not() {
        let status = |patch: fn(&mut ThreadShell)| agent_status(&with("a", patch));
        assert_eq!(
            status(|t| t.pending_runtime_request = request("r", "command", 1)),
            AgentStatus::Approval
        );
        assert_eq!(
            status(|t| t.pending_runtime_request = request("r", "user_input", 1)),
            AgentStatus::Input
        );
        // A non-blocking question while the run keeps going is just work.
        assert_eq!(
            status(|t| {
                t.status = "running".into();
                t.pending_runtime_request = request("r", "user_input", 1);
                t.pending_runtime_request.as_mut().unwrap().blocking = Some(false);
            }),
            AgentStatus::Running
        );
        assert_eq!(
            status(|t| {
                t.status = "running".into();
                t.pending_runtime_request = request("r", "auth_refresh", 1);
            }),
            AgentStatus::Running
        );
        assert_eq!(
            status(|t| {
                t.status = "completed".into();
                t.activity_run_status = Some("starting".into());
            }),
            AgentStatus::Starting
        );
        assert_eq!(
            status(|t| t.status = "interrupted".into()),
            AgentStatus::Idle
        );
        // A finished parent waiting on subagents is working; a leftover command isn't.
        let tasks = |kinds: &[&str]| {
            kinds
                .iter()
                .map(|kind| crate::t3::types::BackgroundTask {
                    kind: (*kind).into(),
                })
                .collect()
        };
        let mut parent = with("a", |t| t.status = "completed".into());
        parent.pending_background_tasks = tasks(&["command", "subagent"]);
        assert_eq!(agent_status(&parent), AgentStatus::Running);
        parent.pending_background_tasks = tasks(&["command"]);
        assert_eq!(agent_status(&parent), AgentStatus::Done);
    }

    #[test]
    fn the_shelf_puts_the_longest_wait_first_and_drops_settled_old_and_subagent_threads() {
        let mut shell = Shell::default();
        shell.apply(snapshot(
            10,
            vec![
                with("recent-done", |t| {
                    t.status = "completed".into();
                    t.updated_at = minutes_ago(5);
                }),
                with("working", |t| {
                    t.status = "running".into();
                    t.updated_at = minutes_ago(2);
                }),
                with("newer-request", |t| {
                    t.pending_runtime_request = request("r2", "command", 1)
                }),
                with("older-request", |t| {
                    t.pending_runtime_request = request("r1", "file-change", 9)
                }),
                with("settled", |t| {
                    t.status = "completed".into();
                    t.settled_at = Some(minutes_ago(3));
                }),
                with("yesterday", |t| {
                    t.status = "completed".into();
                    t.updated_at = minutes_ago(60 * 25);
                }),
                with("helper", |t| {
                    t.status = "running".into();
                    t.lineage = Some(Lineage {
                        relationship_to_parent: Some("subagent".into()),
                    });
                }),
            ],
        ));
        assert_eq!(
            ids(&shell.shelf(now())),
            ["older-request", "newer-request", "working", "recent-done"]
        );

        // Events at or before the snapshot are already reflected and must not apply.
        shell.apply(ShellStreamItem::ThreadRemoved {
            sequence: 10,
            thread_id: "working".into(),
        });
        assert!(shell.threads.contains_key("working"));
        shell.apply(ShellStreamItem::ThreadUpdated {
            sequence: 11,
            location: "archive".into(),
            thread: thread("working"),
        });
        assert!(!shell.threads.contains_key("working"));

        // A later projects-only snapshot refreshes metadata without wiping threads.
        shell.apply(ShellStreamItem::Snapshot {
            snapshot: ShellSnapshot {
                snapshot_sequence: 12,
                projects: vec![ProjectShell {
                    id: "p".into(),
                    title: "Luma".into(),
                }],
                threads: vec![],
            },
        });
        assert_eq!(shell.threads.len(), 6);
        assert_eq!(shell.projects["p"].title, "Luma");
    }

    #[test]
    fn working_agents_keep_their_shelf_order_while_they_emit_updates() {
        let mut shell = Shell::default();
        shell.apply(snapshot(
            1,
            vec![
                with("older-run", |t| {
                    t.status = "running".into();
                    t.latest_run_started_at = Some(minutes_ago(30));
                    t.updated_at = minutes_ago(0);
                }),
                with("newer-run", |t| {
                    t.status = "running".into();
                    t.latest_run_started_at = Some(minutes_ago(5));
                    t.updated_at = minutes_ago(4);
                }),
            ],
        ));
        assert_eq!(ids(&shell.shelf(now())), ["newer-run", "older-run"]);
    }

    #[test]
    fn a_pending_approval_pairs_with_its_turn_item_and_keeps_the_servers_decisions() {
        let mut detail = ThreadDetail::new("t");
        detail.apply(&json!({
            "kind": "snapshot",
            "snapshotSequence": 1,
            "projection": {
                "turnItems": [{
                    "id": "i1", "ordinal": 1, "status": "waiting", "title": null, "runId": null,
                    "type": "approval_request", "requestId": "r1", "requestKind": "command",
                    "prompt": "pnpm test",
                    "options": [
                        {"decision": "accept", "label": "Yes"},
                        {"decision": "decline", "label": "No"},
                        {"decision": "cancel", "label": "Cancel"}
                    ]
                }],
                "runtimeRequests": [
                    {"id": "r1", "kind": "command", "status": "pending", "createdAt": minutes_ago(1)}
                ]
            }
        }));
        let option = |decision: &str, label: &str| DecisionOption {
            decision: decision.into(),
            label: label.into(),
        };
        assert_eq!(
            detail.pending(),
            Some(Pending::Approval {
                request_id: "r1".into(),
                request_kind: "command".into(),
                detail: "pnpm test".into(),
                options: vec![option("accept", "Yes"), option("decline", "No")],
            })
        );
        detail.apply(&json!({
            "kind": "event",
            "sequence": 2,
            "event": {
                "type": "runtime-request.updated",
                "payload": {"id": "r1", "kind": "command", "status": "resolved", "createdAt": minutes_ago(1)}
            }
        }));
        assert_eq!(detail.pending(), None);
    }

    #[test]
    fn a_question_waits_for_its_turn_item_and_unknown_items_still_count() {
        let mut detail = ThreadDetail::new("t");
        detail.apply(&json!({
            "kind": "snapshot",
            "snapshotSequence": 1,
            "projection": {
                "turnItems": [
                    {"id": "plan", "ordinal": 1, "type": "plan_update", "status": "done"},
                    {"id": "said", "ordinal": 2, "type": "assistant_message", "status": "done", "text": "Which **one**?"}
                ],
                "runtimeRequests": [
                    {"id": "q", "kind": "user_input", "status": "pending", "createdAt": minutes_ago(1)}
                ]
            }
        }));
        assert_eq!(detail.items["plan"].kind, ItemKind::Other);
        assert_eq!(detail.pending(), None, "the question's item hasn't arrived");
        detail.apply(&json!({
            "kind": "event",
            "sequence": 2,
            "event": {"type": "turn-item.updated", "payload": {
                "id": "ask", "ordinal": 3, "type": "user_input_request", "status": "waiting",
                "requestId": "q",
                "questions": [{"id": "pick", "header": "Pick", "question": "Which one?",
                    "options": [{"label": "A", "description": ""}]}]
            }}
        }));
        assert!(
            matches!(detail.pending(), Some(Pending::Question { request_id, questions })
            if request_id == "q" && questions[0].options[0].answer() == "A")
        );
        assert_eq!(detail.last_assistant_text(), "Which **one**?");
    }

    #[test]
    fn markdown_reads_as_plain_text_and_summaries_cut_at_words() {
        assert_eq!(
            plain_text(
                "## Done\n\nRan `pnpm test` with **all** [tests](https://x) ![shot](a.png)\n\n\n\n- one\n* two\n```\ncode\n```\nend"
            ),
            "Done\n\nRan pnpm test with all tests \n\n• one\n• two\n \nend"
        );
        assert_eq!(summary("short", 280), "short");
        let long = "word ".repeat(80);
        let cut = summary(&long, 40);
        assert!(cut.ends_with('…') && cut.chars().count() <= 41 && !cut.contains("wor…"));
    }

    #[test]
    fn model_labels_read_like_product_names() {
        assert_eq!(model_label(Some("claude-opus-5-5")), "Claude Opus 5.5");
        assert_eq!(model_label(Some("gpt-5.5-codex")), "GPT 5.5 Codex");
        assert_eq!(model_label(None), "");
    }
}
