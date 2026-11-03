//! The subset of T3 Code's orchestration v2 wire shapes that Luma reads. The authoritative
//! schemas live in T3 Code's packages/contracts; fields Luma doesn't use are left out, kinds
//! stay strings so new ones can't fail parsing, and everything is untrusted input.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectShell {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PendingRuntimeRequest {
    pub id: String,
    pub kind: String,
    pub created_at: String,
    pub blocking: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct VisibleMessage {
    pub role: String,
    pub text: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct ModelSelection {
    pub model: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct BackgroundTask {
    pub kind: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Lineage {
    pub relationship_to_parent: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ThreadShell {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub model_selection: Option<ModelSelection>,
    /// `idle` or a run status: preparing, queued, starting, running, waiting, completed,
    /// interrupted, failed, cancelled, rolled_back.
    pub status: String,
    pub activity_run_status: Option<String>,
    pub last_error: Option<String>,
    pub pending_runtime_request: Option<PendingRuntimeRequest>,
    pub latest_visible_message: Option<VisibleMessage>,
    pub latest_run_started_at: Option<String>,
    /// Work a finished run left running, such as subagents. Older servers omit it.
    pub pending_background_tasks: Vec<BackgroundTask>,
    pub created_at: String,
    pub lineage: Option<Lineage>,
    pub settled_override: Option<String>,
    pub settled_at: Option<String>,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub deleted_at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShellSnapshot {
    pub snapshot_sequence: u64,
    pub projects: Vec<ProjectShell>,
    pub threads: Vec<ThreadShell>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ShellStreamItem {
    #[serde(rename = "snapshot")]
    Snapshot { snapshot: ShellSnapshot },
    #[serde(rename = "project.updated")]
    ProjectUpdated {
        sequence: u64,
        project: ProjectShell,
    },
    #[serde(rename = "project.removed")]
    ProjectRemoved { sequence: u64, project_id: String },
    #[serde(rename = "thread.updated")]
    ThreadUpdated {
        sequence: u64,
        location: String,
        thread: Box<ThreadShell>,
    },
    #[serde(rename = "thread.removed")]
    ThreadRemoved { sequence: u64, thread_id: String },
    /// `synchronized` and kinds newer than Luma.
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
    pub value: Option<String>,
}

impl QuestionOption {
    /// What T3 Code expects back for a chosen option.
    pub fn answer(&self) -> &str {
        self.value.as_deref().unwrap_or(&self.label)
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    pub allow_custom_answer: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct DecisionOption {
    /// accept, acceptForSession, acceptAlways, decline or cancel.
    pub decision: String,
    pub label: String,
}

/// The turn item types the TV shows; anything else is `Other`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ItemKind {
    UserMessage {
        #[serde(default)]
        text: String,
    },
    AssistantMessage {
        #[serde(default)]
        text: String,
        #[serde(default)]
        streaming: bool,
    },
    CommandExecution {
        #[serde(default)]
        input: String,
    },
    FileChange {
        #[serde(default)]
        file_name: String,
    },
    FileSearch {
        #[serde(default)]
        pattern: Option<String>,
    },
    WebSearch {
        #[serde(default)]
        patterns: Vec<String>,
    },
    ApprovalRequest {
        request_id: String,
        #[serde(default)]
        prompt: Option<String>,
        #[serde(default)]
        options: Vec<DecisionOption>,
    },
    UserInputRequest {
        request_id: String,
        #[serde(default)]
        questions: Vec<UserInputQuestion>,
    },
    /// Reasoning, plans, checkpoints and newer item types aren't shown on the TV.
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TurnItem {
    pub id: String,
    pub ordinal: f64,
    pub status: String,
    pub title: Option<String>,
    pub kind: ItemKind,
}

impl TurnItem {
    /// Items without an id or ordinal are dropped; a malformed shown type reads as `Other`.
    pub fn parse(raw: &Value) -> Option<Self> {
        let id = raw.get("id")?.as_str()?.to_owned();
        let ordinal = raw.get("ordinal")?.as_f64()?;
        let text = |key| raw.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Self {
            id,
            ordinal,
            status: text("status").unwrap_or_default(),
            title: text("title"),
            kind: ItemKind::deserialize(raw).unwrap_or(ItemKind::Other),
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeRequest {
    pub id: String,
    pub kind: String,
    /// pending, resolved, expired or cancelled.
    pub status: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectEndpoint {
    /// `lan` or `tailnet`.
    #[serde(default)]
    pub kind: String,
    pub http_base_url: String,
}
