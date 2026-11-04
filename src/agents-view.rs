//! The agents page, opened from the T3 Code tile: the agent that needs you in the spotlight
//! with its actions, every live agent on a shelf below, and the pairing screen before that.
use super::{Assets, Draw, Rect, Scene, State, Target, TextField, TextStyle, WHITE, c, text};
use crate::{
    state::agents_state::{AgentAction, OPENS_WEB_APP, now_ms},
    t3::{
        Status,
        model::{AgentStatus, Pending, StepKind, millis, model_label, summary},
        routes::RouteKind,
    },
};

const LEFT: f32 = 84.;
const WIDTH: f32 = 1752.;
const CARD_WIDTH: f32 = 400.;
const CARD_GAP: f32 = 24.;

fn status_color(status: AgentStatus) -> u32 {
    match status {
        AgentStatus::Input | AgentStatus::Approval => 0xff9f0a,
        AgentStatus::Starting | AgentStatus::Running => 0x0a84ff,
        AgentStatus::Done => 0x30d158,
        AgentStatus::Error => 0xff453a,
        AgentStatus::Idle => 0x8e8e93,
    }
}

fn status_key(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Input | AgentStatus::Approval => "agentNeedsYou",
        AgentStatus::Starting => "agentStarting",
        AgentStatus::Running => "agentWorking",
        AgentStatus::Done => "agentDone",
        AgentStatus::Error => "agentFailed",
        AgentStatus::Idle => "agentIdle",
    }
}

fn request_key(kind: &str) -> &'static str {
    match kind {
        "user_input" => "agentAsked",
        "command" => "agentWantsCommand",
        "file-change" => "agentWantsEdit",
        "file-read" => "agentWantsRead",
        "mcp-elicitation" | "dynamic_tool_call" => "agentWantsTool",
        _ => "agentWantsPermission",
    }
}

fn route_key(kind: RouteKind) -> &'static str {
    match kind {
        RouteKind::Lan => "agentRouteLan",
        RouteKind::Tailnet => "agentRouteTailscale",
        RouteKind::Vpn => "agentRouteVpn",
        RouteKind::Loopback => "agentRouteLocal",
        RouteKind::Public => "agentRouteInternet",
    }
}

/// "now", "4m", "2h", "3d": the time since an agent's state began.
fn elapsed(timestamp: &str, now: i64) -> String {
    let Some(since) = millis(timestamp) else {
        return String::new();
    };
    let minutes = (now - since).max(0) / 60_000;
    match minutes {
        0 => "now".into(),
        1..60 => format!("{minutes}m"),
        60..1440 => format!("{}h", minutes / 60),
        _ => format!("{}d", minutes / 1440),
    }
}

/// `value` cut to `lines` lines with an ellipsis: at a word, or for one line, mid-word when a
/// word cut would leave most of the line empty (commands are often one long token).
fn clip(assets: &Assets, value: &str, style: TextStyle, width: f32, lines: usize) -> String {
    if assets.lines(value, style, width) <= lines {
        return value.to_owned();
    }
    let fits = |candidate: &str| assets.lines(candidate, style, width) <= lines;
    let mut words: Vec<&str> = value.split(' ').collect();
    while words.len() > 1 {
        words.pop();
        let candidate = format!("{}…", words.join(" "));
        if fits(&candidate) {
            if lines > 1 || assets.width(&candidate, style) >= width * 0.6 {
                return candidate;
            }
            break;
        }
    }
    // The longest prefix that fits, found by halving: values can run to thousands of chars.
    let chars: Vec<char> = value.chars().collect();
    let (mut low, mut high) = (0, chars.len());
    while low < high {
        let middle = (low + high).div_ceil(2);
        let candidate: String = chars[..middle].iter().chain(['…'].iter()).collect();
        if fits(&candidate) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let cut: String = chars[..low].iter().collect();
    format!("{}…", cut.trim_end())
}

fn text_height(assets: &Assets, value: &str, style: TextStyle, width: f32) -> f32 {
    assets.lines(value, style, width) as f32 * style.size * style.line_height
}

struct Pill<'a> {
    target: Target,
    x: f32,
    y: f32,
    icon: Option<&'a str>,
    label: &'a str,
    primary: bool,
}

/// A pill with an optional icon and a label; returns its width.
fn pill(out: &mut Scene, state: &State, assets: &Assets, pill: Pill<'_>) -> f32 {
    let Pill {
        target,
        x,
        y,
        icon,
        label,
        primary,
    } = pill;
    let style = text(20.8, 600, -0.02);
    let icon_width = if icon.is_some() { 32. } else { 0. };
    let width = assets.width(label, style).ceil() + 56. + icon_width;
    let rect = Rect::new(x, y, width, 64.);
    let focused = state.focus == target;
    out.pill(rect, focused, primary);
    let color = if focused { c(0x2c2c2c, 1.) } else { WHITE };
    let mut left = x + 28.;
    if let Some(icon) = icon {
        out.icon(assets, icon, Rect::new(left, y + 21., 22., 22.), color);
        left += icon_width;
    }
    out.text(
        label,
        Rect::new(left, y + 18., width, 28.),
        style,
        color,
        false,
    );
    out.control(target, rect, false);
    width
}

pub(super) fn page(out: &mut Scene, state: &State, assets: &Assets) {
    let language = state.preferences.language;
    if state.agents_pairing_screen() {
        return pairing(out, state, assets);
    }
    connection(out, state, assets);
    let server = state
        .agents
        .pairing
        .as_ref()
        .map_or("T3 Code", |pairing| pairing.name());
    if !state.agents.shell.ready {
        return if state.agents.status == Status::Offline {
            message(
                out,
                state,
                assets,
                "alert",
                language.t("agentsOfflineTitle"),
                &language.format("agentsOfflineBody", &[("server", server)]),
                Some(language.t("retry")),
            )
        } else {
            message(
                out,
                state,
                assets,
                "refresh",
                &language.format("agentsConnecting", &[("server", server)]),
                "",
                None,
            )
        };
    }
    let Some(agent) = state.agents_current() else {
        return message(
            out,
            state,
            assets,
            "check",
            language.t("agentsQuietTitle"),
            language.t("agentsQuietBody"),
            OPENS_WEB_APP.then(|| language.t("agentsOpenT3")),
        );
    };
    let now = now_ms();
    let detail = state.agents.detail_of(&agent.thread.id);

    let eyebrow = [
        language.t(status_key(agent.status)).to_owned(),
        agent
            .project
            .map(|project| project.title.clone())
            .unwrap_or_default(),
        model_label(
            agent
                .thread
                .model_selection
                .as_ref()
                .and_then(|selection| selection.model.as_deref()),
        ),
        elapsed(agent.since(), now),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    out.shape(
        Rect::new(LEFT, 201., 12., 12.),
        6.,
        c(status_color(agent.status), 1.),
    );
    out.text(
        eyebrow,
        Rect::new(LEFT + 24., 194., 1300., 26.),
        text(18.4, 600, 0.04),
        c(0xf5f5f5, 0.78),
        false,
    );
    let title_style = text(56., 500, -0.045).leading(1.1);
    out.text(
        clip(assets, &agent.thread.title, title_style, 1500., 1),
        Rect::new(LEFT, 232., 1500., 64.),
        title_style,
        WHITE,
        false,
    );

    // Text that streams in lives in a fixed slot, so the actions never move.
    let mut y = 318.;
    let body = text(24., 450, -0.02).leading(1.35);
    let said = if agent.status == AgentStatus::Error
        && let Some(error) = agent.thread.last_error.as_deref()
    {
        error.to_owned()
    } else {
        let message = agent
            .thread
            .latest_visible_message
            .as_ref()
            .filter(|message| message.role == "assistant")
            .map(|message| message.text.as_str());
        summary(
            message.unwrap_or(detail.map_or("", |detail| detail.last_assistant_text())),
            280,
        )
    };
    let pending = state.agents_pending();
    let said_lines = if agent.status.needs_you() { 2 } else { 3 };
    if !said.is_empty() {
        let said = clip(assets, &said, body, 1500., said_lines);
        let height = text_height(assets, &said, body, 1500.);
        out.text(
            said.clone(),
            Rect::new(LEFT, y, 1500., height),
            body,
            c(0xeeeeee, 0.78),
            false,
        );
        y += height + 18.;
    }
    if agent.status.needs_you() {
        let kind = agent
            .thread
            .pending_runtime_request
            .as_ref()
            .map_or("permission", |request| request.kind.as_str());
        let (heading, detail) = match &pending {
            Some(Pending::Approval { detail, .. }) => {
                (language.t(request_key(kind)), detail.clone())
            }
            Some(Pending::Question { questions, .. }) => (
                language.t("agentAsked"),
                questions
                    .first()
                    .map(|question| question.question.clone())
                    .unwrap_or_default(),
            ),
            None => (language.t(request_key(kind)), String::new()),
        };
        out.text(
            heading,
            Rect::new(LEFT, y, 1500., 30.),
            text(22.4, 600, -0.02),
            c(0xff9f0a, 1.),
            false,
        );
        y += 38.;
        if !detail.is_empty() {
            let style = text(21.6, 450, -0.01).leading(1.35);
            let detail = clip(assets, detail.trim(), style, 1500., 2);
            out.text(
                detail,
                Rect::new(LEFT, y, 1500., 60.),
                style,
                c(0xffffff, 0.9),
                false,
            );
        }
    } else if agent.status.working()
        && let Some(detail) = detail
    {
        let style = text(21.6, 450, -0.01);
        for step in detail.recent_steps(3) {
            let label = match step.kind {
                StepKind::Status => String::new(),
                StepKind::Ran => language.t("agentStepRan").to_owned(),
                StepKind::Edited => language.t("agentStepEdited").to_owned(),
                StepKind::Searched => language.t("agentStepSearched").to_owned(),
                StepKind::SearchedWeb => language.t("agentStepSearchedWeb").to_owned(),
            };
            let running = matches!(step.status.as_str(), "running" | "pending");
            if running {
                out.border(
                    Rect::new(LEFT + 2., y + 5., 16., 16.),
                    8.,
                    2.,
                    c(0x0a84ff, 1.),
                );
            } else {
                out.icon(
                    assets,
                    "check",
                    Rect::new(LEFT, y + 3., 20., 20.),
                    c(0xffffff, 0.6),
                );
            }
            // Commands span lines and indent; one line reads better on a TV.
            // One line holds about 150 characters; measuring more each frame is waste.
            let detail: String = step
                .detail
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(240)
                .collect();
            let line = [label, detail]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            out.text(
                clip(assets, &line, style, 1460., 1),
                Rect::new(LEFT + 34., y, 1460., 28.),
                style,
                c(0xeeeeee, if running { 0.9 } else { 0.6 }),
                false,
            );
            y += 34.;
        }
    }

    let mut x = LEFT;
    for (index, action) in state.agents_actions().into_iter().enumerate() {
        let (icon, label, primary) = match &action {
            AgentAction::Decide { decision, label } => (
                Some(match decision.as_str() {
                    "decline" => "close",
                    _ => "check",
                }),
                match decision.as_str() {
                    "accept" => language.t("agentApprove").to_owned(),
                    "acceptForSession" => language.t("agentAllowSession").to_owned(),
                    "acceptAlways" => language.t("agentAllowAlways").to_owned(),
                    "decline" => language.t("agentDeny").to_owned(),
                    _ => label.clone(),
                },
                index == 0,
            ),
            AgentAction::Choose { answer, .. } => (None, answer.clone(), index == 0),
            AgentAction::Answer => (Some("message"), language.t("agentAnswer").into(), true),
            AgentAction::Open => (
                Some("arrow"),
                language.t("agentOpen").into(),
                pending.is_none(),
            ),
            AgentAction::Reply => (Some("message"), language.t("agentReply").into(), false),
            AgentAction::Stop => (Some("stop"), language.t("agentStop").into(), false),
        };
        let width = pill(
            out,
            state,
            assets,
            Pill {
                target: Target::AgentAction(index),
                x,
                y: 548.,
                icon,
                label: &label,
                primary,
            },
        );
        x += width + 16.;
    }

    shelf(out, state, assets, now);
}

fn shelf(out: &mut Scene, state: &State, assets: &Assets, now: i64) {
    let language = state.preferences.language;
    let agents = state.agents.shell.shelf(now);
    let current = state.agents_current().map(|agent| agent.thread.id.clone());
    out.text(
        language.t("agents"),
        Rect::new(LEFT, 668., 600., 31.),
        text(23.2, 550, -0.035).leading(1.3),
        WHITE,
        false,
    );
    let heading = assets.width(language.t("agents"), text(23.2, 550, -0.035));
    out.text(
        language.format("agentsActive", &[("count", &agents.len().to_string())]),
        Rect::new(LEFT + heading + 14., 672., 400., 26.),
        text(18.4, 500, -0.02),
        c(0xeeeeee, 0.6),
        false,
    );
    // Keep the focused card, or else the spotlight's, on screen.
    let anchor = match &state.focus {
        Target::Agent(id) => Some(id.clone()),
        _ => current.clone(),
    };
    let index = anchor
        .and_then(|id| agents.iter().position(|agent| agent.thread.id == id))
        .unwrap_or(0);
    let visible = ((WIDTH + CARD_GAP) / (CARD_WIDTH + CARD_GAP)).floor() as usize;
    let first = index.saturating_sub(visible.saturating_sub(1));
    let top = 718.;
    out.draw
        .push(Draw::Clip(Some(Rect::new(0., top - 12., 1920., 220.))));
    for (position, agent) in agents.iter().enumerate().skip(first) {
        let x = LEFT + (position - first) as f32 * (CARD_WIDTH + CARD_GAP);
        if x > 1920. {
            break;
        }
        let rect = Rect::new(x, top, CARD_WIDTH, 180.);
        let target = Target::Agent(agent.thread.id.clone());
        let focused = state.focus == target;
        let selected = current.as_deref() == Some(agent.thread.id.as_str());
        if focused {
            out.draw.push(Draw::RoundedGradient(
                rect,
                24.,
                c(0xfafafa, 1.),
                c(0xe5e5e5, 1.),
            ));
        } else {
            out.shape(
                rect,
                24.,
                if selected {
                    c(0x303438, 0.92)
                } else {
                    c(0x171c20, 0.72)
                },
            );
            out.border(
                rect,
                24.,
                1.,
                if agent.status.needs_you() {
                    c(0xff9f0a, 0.6)
                } else {
                    c(0xffffff, 0.07)
                },
            );
        }
        let ink = |alpha| {
            if focused {
                c(0x2c2c2c, alpha)
            } else {
                c(0xffffff, alpha)
            }
        };
        let small = text(16., 600, 0.);
        let project = agent
            .project
            .map(|project| project.title.as_str())
            .unwrap_or_default();
        out.text(
            clip(assets, project, small, 200., 1),
            Rect::new(x + 24., top + 22., 200., 22.),
            small,
            ink(0.6),
            false,
        );
        let status = language.t(status_key(agent.status));
        let status_width = assets.width(status, small);
        out.shape(
            Rect::new(
                x + CARD_WIDTH - 24. - status_width - 18.,
                top + 28.,
                10.,
                10.,
            ),
            5.,
            c(status_color(agent.status), 1.),
        );
        out.text(
            status,
            Rect::new(
                x + CARD_WIDTH - 24. - status_width,
                top + 22.,
                status_width + 2.,
                22.,
            ),
            small,
            ink(0.75),
            false,
        );
        let title = text(22.4, 600, -0.02).leading(1.3);
        out.text(
            clip(assets, &agent.thread.title, title, CARD_WIDTH - 48., 2),
            Rect::new(x + 24., top + 58., CARD_WIDTH - 48., 60.),
            title,
            ink(1.),
            false,
        );
        let detail = if agent.status.needs_you() {
            language
                .t(request_key(
                    agent
                        .thread
                        .pending_runtime_request
                        .as_ref()
                        .map_or("permission", |request| request.kind.as_str()),
                ))
                .to_owned()
        } else {
            elapsed(&agent.thread.updated_at, now)
        };
        out.text(
            detail,
            Rect::new(x + 24., top + 140., CARD_WIDTH - 48., 22.),
            text(16., 450, 0.),
            ink(0.6),
            false,
        );
        out.control(target, rect, false);
    }
    out.draw.push(Draw::Clip(None));
}

/// The server and how Luma reaches it, at the top right; OK shows the addresses and Unpair.
fn connection(out: &mut Scene, state: &State, assets: &Assets) {
    let language = state.preferences.language;
    let Some(pairing) = &state.agents.pairing else {
        return;
    };
    let (color, detail) = match (state.agents.status, &state.agents.route) {
        (Status::Connected, Some(route)) => (0x30d158, language.t(route_key(route.kind))),
        (Status::Offline, _) => (0xff453a, language.t("agentsOffline")),
        _ => (0xffb340, language.t("agentsConnectingShort")),
    };
    let label = format!("{} · {detail}", pairing.name());
    let style = text(18.4, 550, -0.02);
    let width = assets.width(&label, style).ceil() + 70.;
    let rect = Rect::new(1836. - width, 170., width, 52.);
    let focused = state.focus == Target::AgentsConnection;
    out.pill(rect, focused, false);
    out.shape(
        Rect::new(rect.x + 24., rect.y + 21., 10., 10.),
        5.,
        c(color, 1.),
    );
    out.text(
        label,
        Rect::new(rect.x + 46., rect.y + 14., width - 60., 26.),
        style,
        if focused {
            c(0x2c2c2c, 1.)
        } else {
            c(0xeeeeee, 0.85)
        },
        false,
    );
    out.control(Target::AgentsConnection, rect, false);
}

fn message(
    out: &mut Scene,
    state: &State,
    assets: &Assets,
    icon: &str,
    title: &str,
    body: &str,
    action: Option<&str>,
) {
    out.icon(
        assets,
        icon,
        Rect::new(LEFT, 300., 44., 44.),
        c(0xffffff, 0.7),
    );
    let style = text(64., 500, -0.05).leading(1.1);
    out.text(
        title,
        Rect::new(LEFT, 372., 1500., 72.),
        style,
        WHITE,
        false,
    );
    let body_style = text(24., 450, -0.02).leading(1.35);
    out.text(
        clip(assets, body, body_style, 1100., 3),
        Rect::new(LEFT, 466., 1100., 100.),
        body_style,
        c(0xeeeeee, 0.73),
        false,
    );
    if let Some(action) = action {
        pill(
            out,
            state,
            assets,
            Pill {
                target: Target::AgentsRetry,
                x: LEFT,
                y: 600.,
                icon: None,
                label: action,
                primary: true,
            },
        );
    }
}

struct Field<'a> {
    target: Target,
    y: f32,
    label: &'a str,
    value: &'a str,
    placeholder: &'a str,
}

fn field(out: &mut Scene, state: &State, assets: &Assets, field: Field<'_>) {
    let Field {
        target,
        y,
        label,
        value,
        placeholder,
    } = field;
    out.text(
        label,
        Rect::new(LEFT, y, 900., 24.),
        text(17.6, 600, 0.02),
        c(0xf5f5f5, 0.72),
        false,
    );
    let rect = Rect::new(LEFT, y + 32., 900., 64.);
    let focused = state.focus == target;
    if focused {
        out.draw.push(Draw::RoundedGradient(
            rect,
            32.,
            c(0xfafafa, 1.),
            c(0xe5e5e5, 1.),
        ));
    } else {
        out.shape(rect, 32., c(0x171c20, 0.72));
        out.border(rect, 32., 1., c(0xffffff, 0.07));
    }
    let typing = state.text_input_active()
        && matches!(
            (&target, state.keyboard_field),
            (Target::PairAddress, TextField::PairAddress) | (Target::PairCode, TextField::PairCode)
        );
    let (shown, color) = if value.is_empty() && !typing {
        (
            placeholder.to_owned(),
            if focused {
                c(0x2c2c2c, 0.5)
            } else {
                c(0xeeeeee, 0.45)
            },
        )
    } else {
        (
            format!("{value}{}", if typing { "|" } else { "" }),
            if focused { c(0x2c2c2c, 1.) } else { WHITE },
        )
    };
    let style = text(20.8, 500, -0.02);
    out.text(
        clip(assets, &shown, style, 852., 1),
        Rect::new(LEFT + 28., y + 50., 852., 28.),
        style,
        color,
        false,
    );
    out.control(target, rect, false);
}

fn pairing(out: &mut Scene, state: &State, assets: &Assets) {
    let language = state.preferences.language;
    let expired = state.agents.pairing.is_some();
    out.text(
        language.t(if expired {
            "agentsExpiredTitle"
        } else {
            "agentsPairTitle"
        }),
        Rect::new(LEFT, 176., 1500., 72.),
        text(64., 500, -0.05).leading(1.1),
        WHITE,
        false,
    );
    let body = text(24., 450, -0.02).leading(1.35);
    let intro = language.t(if expired {
        "agentsExpiredBody"
    } else {
        "agentsPairBody"
    });
    out.text(
        clip(assets, intro, body, 1100., 2),
        Rect::new(LEFT, 262., 1100., 70.),
        body,
        c(0xeeeeee, 0.73),
        false,
    );
    let steps = text(20.8, 450, -0.01);
    for (index, key) in ["agentsPairStep1", "agentsPairStep2"]
        .into_iter()
        .enumerate()
    {
        out.text(
            format!("{}. {}", index + 1, language.t(key)),
            Rect::new(LEFT, 350. + index as f32 * 34., 1500., 28.),
            steps,
            c(0xeeeeee, 0.65),
            false,
        );
    }
    let ui = &state.agents_ui;
    field(
        out,
        state,
        assets,
        Field {
            target: Target::PairAddress,
            y: 436.,
            label: language.t("agentsAddress"),
            value: &ui.address,
            placeholder: language.t("agentsAddressPlaceholder"),
        },
    );
    field(
        out,
        state,
        assets,
        Field {
            target: Target::PairCode,
            y: 552.,
            label: language.t("agentsCode"),
            value: &ui.code,
            placeholder: language.t("agentsCodePlaceholder"),
        },
    );
    pill(
        out,
        state,
        assets,
        Pill {
            target: Target::PairSubmit,
            x: LEFT,
            y: 690.,
            icon: Some(if ui.pairing { "refresh" } else { "check" }),
            label: language.t(if ui.pairing {
                "agentsPairing"
            } else {
                "agentsPair"
            }),
            primary: true,
        },
    );
    if let Some(error) = ui.error {
        out.text(
            clip(assets, language.t(error), steps, 1100., 2),
            Rect::new(LEFT, 776., 1100., 60.),
            steps,
            c(0xff6961, 1.),
            false,
        );
    }
}

/// The server's addresses and Unpair, over the page.
pub(super) fn connection_dialog(out: &mut Scene, state: &State, assets: &Assets) {
    let language = state.preferences.language;
    let Some(pairing) = &state.agents.pairing else {
        return;
    };
    let routes = &pairing.routes;
    let height = 250. + routes.len() as f32 * 44.;
    let panel = Rect::new(560., (1080. - height) / 2., 800., height);
    out.modal = Some(panel);
    out.shadow(panel, 27.2, 90., 20., 0.45);
    out.draw.push(Draw::RoundedGradient(
        panel,
        27.2,
        c(0x34383b, 0.98),
        c(0x24282d, 1.),
    ));
    out.border(panel, 27.2, 1., c(0xffffff, 0.12));
    out.text(
        pairing.name(),
        Rect::new(panel.x + 40., panel.y + 34., panel.w - 80., 44.),
        text(37.6, 500, -0.055).leading(1.1),
        WHITE,
        false,
    );
    let status = match state.agents.status {
        Status::Connected => language.t("connected"),
        Status::Offline => language.t("agentsOffline"),
        _ => language.t("agentsConnectingShort"),
    };
    out.text(
        status,
        Rect::new(panel.x + 40., panel.y + 88., panel.w - 80., 26.),
        text(18.4, 450, -0.01),
        c(0xeeeeee, 0.65),
        false,
    );
    let mut y = panel.y + 132.;
    for route in routes {
        let current = state.agents.route.as_ref().map(|r| &r.url) == Some(&route.url);
        out.text(
            route.url.trim_end_matches('/'),
            Rect::new(panel.x + 40., y, 520., 28.),
            text(19.2, if current { 600 } else { 450 }, -0.01),
            c(0xffffff, if current { 1. } else { 0.8 }),
            false,
        );
        let kind = language.t(route_key(route.kind));
        let style = text(16., 500, 0.);
        let width = assets.width(kind, style);
        out.text(
            kind,
            Rect::new(panel.x + panel.w - 40. - width, y + 3., width + 2., 24.),
            style,
            c(0xeeeeee, 0.6),
            false,
        );
        y += 44.;
    }
    let rect = Rect::new(panel.x + 24., y + 8., panel.w - 48., 92.);
    let focused = state.focus == Target::Unpair;
    if focused {
        out.draw.push(Draw::RoundedGradient(
            rect,
            20.,
            c(0xfafafa, 1.),
            c(0xe5e5e5, 1.),
        ));
    } else {
        out.shape(rect, 20., c(0x171c20, 0.6));
    }
    let ink = |alpha| {
        if focused {
            c(0x2c2c2c, alpha)
        } else {
            c(0xffffff, alpha)
        }
    };
    out.text(
        language.t("agentsUnpair"),
        Rect::new(rect.x + 24., rect.y + 16., rect.w - 48., 28.),
        text(20.8, 600, -0.02),
        ink(1.),
        false,
    );
    let hint = text(15.2, 400, 0.).leading(1.4);
    out.text(
        clip(
            assets,
            language.t("agentsUnpairHint"),
            hint,
            rect.w - 48.,
            2,
        ),
        Rect::new(rect.x + 24., rect.y + 48., rect.w - 48., 40.),
        hint,
        ink(0.6),
        false,
    );
    out.control(Target::Unpair, rect, false);
}

/// Fire TV's own keyboard covers the screen's lower half; the reply shows above it.
pub(super) fn reply_preview(out: &mut Scene, state: &State, assets: &Assets) {
    let language = state.preferences.language;
    let panel = Rect::new(360., 120., 1200., 180.);
    out.shadow(panel, 27.2, 60., 16., 0.4);
    out.draw.push(Draw::RoundedGradient(
        panel,
        27.2,
        c(0x34383b, 0.98),
        c(0x24282d, 1.),
    ));
    out.text(
        language.t("agentReplyPrompt"),
        Rect::new(panel.x + 36., panel.y + 28., panel.w - 72., 36.),
        text(28., 550, -0.03),
        WHITE,
        false,
    );
    let style = text(21.6, 450, -0.01).leading(1.35);
    let typed = if state.agents_ui.reply.is_empty() {
        language.t("agentReplyPlaceholder").to_owned()
    } else {
        format!("{}|", state.agents_ui.reply)
    };
    out.text(
        clip(assets, &typed, style, panel.w - 72., 2),
        Rect::new(panel.x + 36., panel.y + 84., panel.w - 72., 64.),
        style,
        c(
            0xeeeeee,
            if state.agents_ui.reply.is_empty() {
                0.5
            } else {
                1.
            },
        ),
        false,
    );
}

/// T3 Code's mark on a light chip, as the inbox and alerts head with it.
fn glyph(out: &mut Scene, assets: &Assets, rect: Rect) {
    out.shape(rect, rect.w * 0.23, c(0xf5f5f5, 1.));
    out.draw.push(Draw::TintedImage(
        assets.path("logos/t3-code.lvec"),
        rect.inset(rect.w * 0.14),
        0.,
        true,
        c(0x17191c, 1.),
    ));
}

const AMBER: u32 = 0xf5c26b;
const MUTED: f32 = 0.56;
const INBOX_WIDTH: f32 = 832.;
const INBOX_ROW: f32 = 80.;
const INBOX_HEADING: f32 = 44.;

/// The inbox Menu opens on the right, over any page: the paired server's agents by group,
/// under a line on why they're missing or may be out of date.
pub(super) fn inbox(out: &mut Scene, state: &State, assets: &Assets) {
    let language = state.preferences.language;
    let now = now_ms();
    let server = state
        .agents
        .pairing
        .as_ref()
        .map(|pairing| pairing.name().to_owned());
    // Agents from the last snapshot stay listed while the connection is down.
    let notice = match (&server, state.agents.status) {
        (None, _) => Some(language.t("agentsPairTitle").to_owned()),
        (_, Status::Expired) => Some(language.t("agentsExpiredTitle").to_owned()),
        (_, Status::Offline) => Some(language.t("agentsOfflineTitle").to_owned()),
        (_, Status::Connected) => None,
        (Some(server), _) => Some(language.format("agentsConnecting", &[("server", server)])),
    };
    let groups = state.inbox_groups();
    let rows: usize = groups.iter().map(|(_, agents)| agents.len()).sum();

    // Lay the list out first, so the panel fits it and the focused row stays in view.
    let mut items = Vec::new();
    let mut y = 0.;
    if notice.is_some() {
        y += 52.;
    }
    for (label, agents) in &groups {
        if agents.is_empty() {
            continue;
        }
        items.push((y, None, *label));
        y += INBOX_HEADING;
        for agent in agents {
            items.push((y, Some(agent), *label));
            y += INBOX_ROW;
        }
    }
    let empty = rows == 0;
    if empty {
        y += 64. + 84.;
    }
    let top_padding = 38.;
    let header = 62.;
    let max_list = 1080. - 88. - top_padding - header - 26.;
    let list_height = y.min(max_list);
    let panel = Rect::new(
        1920. - 84. - INBOX_WIDTH,
        44.,
        INBOX_WIDTH,
        top_padding + header + list_height + 26.,
    );
    out.modal = Some(panel);
    out.shadow(panel, 27.2, 120., 25., 0.45);
    out.draw.push(Draw::RoundedGradient(
        panel,
        27.2,
        c(0x2c3033, 0.97),
        c(0x1d2024, 0.99),
    ));
    out.border(panel, 27.2, 1., c(0xffffff, 0.12));

    let left = panel.x + 26.;
    let inner = panel.w - 52.;
    glyph(
        out,
        assets,
        Rect::new(left + 19., panel.y + top_padding, 38., 38.),
    );
    out.text(
        language.t("agentsInbox"),
        Rect::new(left + 72., panel.y + top_padding + 1., 400., 40.),
        text(35.2, 500, -0.05).leading(1.1),
        WHITE,
        false,
    );
    if let Some(server) = &server {
        let style = text(17.6, 450, 0.);
        let width = assets.width(server, style).min(320.);
        out.text(
            clip(assets, server, style, 320., 1),
            Rect::new(
                left + inner - 19. - width,
                panel.y + top_padding + 10.,
                width + 2.,
                24.,
            ),
            style,
            c(0xf5f5f5, MUTED),
            false,
        );
    }

    let list = Rect::new(
        panel.x,
        panel.y + top_padding + header,
        panel.w,
        list_height,
    );
    let focused_bottom = items
        .iter()
        .find(|(_, agent, _)| {
            agent.is_some_and(|agent| state.focus == Target::InboxAgent(agent.thread.id.clone()))
        })
        .map_or(0., |(y, ..)| y + INBOX_ROW);
    let offset = (focused_bottom - list_height).max(0.);
    out.draw.push(Draw::Clip(Some(list)));
    if let Some(notice) = &notice {
        out.text(
            notice,
            Rect::new(left + 19., list.y - offset + 6., inner - 38., 30.),
            text(22.4, 500, -0.02),
            c(0xf5f5f5, 0.85),
            false,
        );
    }
    for (y, agent, label) in &items {
        let y = list.y + y - offset;
        let Some(agent) = agent else {
            out.text(
                language.t(label).to_uppercase(),
                Rect::new(left + 19., y + 19., inner - 38., 20.),
                text(15.2, 650, 0.12),
                c(0xf5f5f5, MUTED),
                false,
            );
            continue;
        };
        let target = Target::InboxAgent(agent.thread.id.clone());
        let rect = Rect::new(left, y, inner, INBOX_ROW - 4.);
        if state.focus == target {
            out.shape(rect, 16., c(0xffffff, 0.08));
            out.border(rect, 16., 2., c(0xf0f0f0, 0.95));
        }
        out.shape(
            Rect::new(rect.x + 19., rect.y + rect.h / 2. - 6., 12., 12.),
            6.,
            c(status_color(agent.status), 1.),
        );
        let time = elapsed(agent.since(), now);
        let time_style = text(16.8, 450, 0.);
        let time_width = assets.width(&time, time_style);
        out.text(
            time.clone(),
            Rect::new(
                rect.x + rect.w - 19. - time_width,
                rect.y + 28.,
                time_width + 2.,
                24.,
            ),
            time_style,
            c(0xf5f5f5, MUTED),
            false,
        );
        let text_left = rect.x + 19. + 12. + 16.;
        let text_width = rect.w - (text_left - rect.x) - 19. - time_width - 16.;
        let title_style = text(23.2, 500, -0.03);
        out.text(
            clip(assets, &agent.thread.title, title_style, text_width, 1),
            Rect::new(text_left, rect.y + 13., text_width, 30.),
            title_style,
            WHITE,
            false,
        );
        if let Some(project) = agent.project {
            let style = text(16.8, 450, 0.);
            out.text(
                clip(assets, &project.title, style, text_width, 1),
                Rect::new(text_left, rect.y + 45., text_width, 22.),
                style,
                c(0xf5f5f5, MUTED),
                false,
            );
        }
        out.control(target, rect, false);
    }
    out.draw.push(Draw::Clip(None));
    if empty {
        let y = list.y + list.h - 64. - 20.;
        if notice.is_none() {
            out.text(
                language.t("agentsQuietTitle"),
                Rect::new(left + 19., list.y + 6., inner - 38., 30.),
                text(22.4, 500, -0.02),
                c(0xf5f5f5, 0.85),
                false,
            );
        }
        pill(
            out,
            state,
            assets,
            Pill {
                target: Target::InboxT3,
                x: left + 19.,
                y,
                icon: None,
                label: "T3 Code",
                primary: false,
            },
        );
    }
}

/// The agent that newly needs you, at the top right for a few seconds. It never takes
/// focus or keys, so whatever is on screen keeps the remote.
pub(super) fn alert(out: &mut Scene, state: &State, assets: &Assets) {
    use crate::state::agents_state::{ALERT_FADE, ALERT_TIME};
    let (Some(alert), Some(shown)) = (state.agents_ui.alerts.front(), state.agents_ui.alert_shown)
    else {
        return;
    };
    let language = state.preferences.language;
    let elapsed = shown.elapsed();
    let alpha = if state.preferences.reduced_motion {
        1.
    } else {
        let fade = ALERT_FADE.as_secs_f32();
        (elapsed.as_secs_f32() / fade)
            .min((ALERT_TIME.saturating_sub(elapsed)).as_secs_f32() / fade)
            .clamp(0., 1.)
    };
    let start = out.draw.len();
    let height = if alert.project.is_empty() { 118. } else { 146. };
    let panel = Rect::new(1836. - 720., 128., 720., height);
    out.shadow(panel, 27.2, 48., 12., 0.45);
    out.draw.push(Draw::RoundedGradient(
        panel,
        27.2,
        c(0x2c3033, 0.97),
        c(0x1d2024, 0.99),
    ));
    out.border(panel, 27.2, 1., c(0xffffff, 0.12));
    out.shape(
        Rect::new(panel.x + 26., panel.y + 26., 7., panel.h - 52.),
        3.5,
        c(AMBER, 1.),
    );
    let left = panel.x + 26. + 7. + 22.;
    let width = panel.w - (left - panel.x) - 30.;
    glyph(out, assets, Rect::new(left, panel.y + 25., 26., 26.));
    let headline = format!(
        "{} · {}",
        language.t("agentNeedsYou"),
        language.t(if alert.asked {
            "agentAlertAsked"
        } else {
            "agentAlertApproval"
        })
    );
    let source = state
        .agents
        .pairing
        .as_ref()
        .map_or(String::new(), |pairing| pairing.name().to_owned());
    let source_style = text(17.6, 450, 0.);
    let source_width = assets.width(&source, source_style).min(220.);
    out.text(
        clip(assets, &source, source_style, 220., 1),
        Rect::new(
            left + width - source_width,
            panel.y + 28.,
            source_width + 2.,
            24.,
        ),
        source_style,
        c(0xf5f5f5, MUTED),
        false,
    );
    let headline_style = text(20., 500, -0.01);
    out.text(
        clip(
            assets,
            &headline,
            headline_style,
            width - 38. - source_width - 16.,
            1,
        ),
        Rect::new(left + 38., panel.y + 27., width - 38., 26.),
        headline_style,
        c(AMBER, 1.),
        false,
    );
    let title_style = text(25.6, 600, -0.03);
    out.text(
        clip(assets, &alert.title, title_style, width, 1),
        Rect::new(left, panel.y + 64., width, 32.),
        title_style,
        WHITE,
        false,
    );
    if !alert.project.is_empty() {
        let style = text(17.6, 450, 0.);
        out.text(
            clip(assets, &alert.project, style, width, 1),
            Rect::new(left, panel.y + 100., width, 24.),
            style,
            c(0xf5f5f5, MUTED),
            false,
        );
    }
    out.fade(start, alpha, 1.);
}
