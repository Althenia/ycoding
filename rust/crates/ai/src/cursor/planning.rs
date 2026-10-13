use super::protobuf::{self, Field};
use crate::{Error, llm::ToolDefinition};
use std::{future::Future, pin::Pin};
use ycoding_schema::LosslessString;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApprovalKind {
    SwitchMode {
        target: String,
        tool: Option<String>,
    },
    ExecutePlan {
        artifact: Artifact,
    },
}
#[derive(Clone, Debug)]
pub struct Approval {
    pub session_id: LosslessString,
    pub kind: ApprovalKind,
    pub question: String,
    pub review: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Approved,
    Rejected(String),
}
#[derive(Clone, Debug)]
pub struct Plan {
    pub session_id: LosslessString,
    pub title: String,
    pub content: String,
    pub is_project: bool,
    pub stage: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact {
    pub path: String,
    pub uri: String,
}
pub trait Host: Send + Sync {
    fn approve<'a>(
        &'a self,
        request: &'a Approval,
    ) -> Pin<Box<dyn Future<Output = Result<Decision, Error>> + Send + 'a>>;
    fn persist<'a>(
        &'a self,
        request: &'a Plan,
    ) -> Pin<Box<dyn Future<Output = Result<Artifact, Error>> + Send + 'a>>;
    fn switch_agent<'a>(
        &'a self,
        session_id: &'a LosslessString,
        target: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'a>>;
}

#[derive(Default)]
pub(crate) struct State {
    pub mode: Option<Mode>,
    pub terminal_target: Option<String>,
}
pub(crate) struct Mode {
    target: String,
    first: bool,
    bridged: bool,
}
pub(crate) struct Outcome {
    pub reply: Vec<u8>,
    pub mode: Option<Mode>,
    pub terminal_target: Option<String>,
}

pub(crate) async fn query(
    bytes: &[u8],
    state: &State,
    tools: &[ToolDefinition],
    session_id: Option<&LosslessString>,
    host: Option<&dyn Host>,
    seed: fn() -> Result<u64, Error>,
) -> Result<Option<Outcome>, Error> {
    let fields = protobuf::fields(bytes)?;
    let variants = fields
        .iter()
        .filter(|field| field.number != 1)
        .collect::<Vec<_>>();
    if variants.len() != 1 || ![4, 7].contains(&variants[0].number) {
        return Ok(None);
    }
    let variant = variants[0];
    let id = fields
        .iter()
        .rev()
        .find(|field| field.number == 1)
        .map(|field| field.uint32())
        .transpose()?
        .unwrap_or(0);
    let args = protobuf::fields(variant.bytes()?)
        .and_then(|body| {
            body.iter()
                .rev()
                .find(|field| field.number == 1)
                .map(|field| field.bytes())
                .transpose()?
                .map(protobuf::fields)
                .transpose()
                .map(|value| value.unwrap_or_default())
        })
        .unwrap_or_default();
    let available = |name: &str| tools.iter().any(|tool| tool.name.as_str() == Some(name));
    let mut outcome = Outcome {
        reply: Vec::new(),
        mode: None,
        terminal_target: None,
    };
    let result = if variant.number == 4 {
        let target = args
            .iter()
            .filter(|field| (1..=3).contains(&field.number))
            .try_for_each(|field| field.text().map(|_| ()))
            .and_then(|_| text(&args, 1))
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        if target.is_empty() {
            rejection("Missing switch-mode arguments")?
        } else if tools.is_empty() {
            wrap(1, &[])?
        } else if let (Some(session_id), Some(host)) = (session_id, host) {
            let plan = matches!(target.as_str(), "plan" | "spec");
            let native = if plan { "plan_enter" } else { "plan_exit" };
            let same = state
                .mode
                .as_ref()
                .is_some_and(|mode| mode.target == target);
            let decision = if same || plan && !available(native) {
                Decision::Approved
            } else if available(native) || available("question") {
                host.approve(&Approval { session_id: session_id.clone(), kind: ApprovalKind::SwitchMode { target: target.clone(), tool: available(native).then(|| native.into()) }, question: if plan { "Would you like to switch to the plan agent?".into() } else { "Planning is complete. Would you like to switch to the build agent and start implementing?".into() }, review: None }).await.unwrap_or_else(|error| Decision::Rejected(error.message))
            } else {
                Decision::Rejected("Neither the OpenCode `plan_exit` tool nor the `question` tool is available to the current agent, so leaving plan mode cannot be approved this turn.".into())
            };
            match decision {
                Decision::Approved => {
                    outcome.mode = Some(Mode {
                        target: target.clone(),
                        first: true,
                        bridged: available(native) && plan,
                    });
                    if !same {
                        outcome.terminal_target = Some(target);
                    }
                    wrap(1, &[])?
                }
                Decision::Rejected(reason) => rejection(if reason.trim().is_empty() {
                    "Mode switch rejected by user"
                } else {
                    &reason
                })?,
            }
        } else {
            rejection("Cursor mode approval requires a backend Session and planning host")?
        }
    } else {
        let content = validate_plan(&args)
            .and_then(|_| markdown(&args))
            .unwrap_or_default();
        if content.trim().is_empty() || tools.is_empty() {
            plan_result(Ok(""), "")?
        } else if let (Some(session_id), Some(host)) = (session_id, host) {
            let name = text(&args, 4)?;
            let slug = name
                .trim()
                .to_lowercase()
                .split(|ch: char| !ch.is_ascii_alphanumeric())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("-")
                .chars()
                .take(64)
                .collect::<String>();
            let slug = if slug.is_empty() {
                let seed = seed()?;
                let adjectives = [
                    "brave", "calm", "clever", "cosmic", "crisp", "curious", "eager", "gentle",
                    "glowing", "happy", "hidden", "jolly", "kind", "lucky", "mighty", "misty",
                    "neon", "nimble", "playful", "proud", "quick", "quiet", "shiny", "silent",
                    "stellar", "sunny", "swift", "tidy", "witty",
                ];
                let nouns = [
                    "cabin", "cactus", "canyon", "circuit", "comet", "eagle", "engine", "falcon",
                    "forest", "garden", "harbor", "island", "knight", "lagoon", "meadow", "moon",
                    "mountain", "nebula", "orchid", "otter", "panda", "pixel", "planet", "river",
                    "rocket", "sailor", "squid", "star", "tiger", "wizard", "wolf",
                ];
                format!(
                    "{}-{}",
                    adjectives[(seed % adjectives.len() as u64) as usize],
                    nouns[(seed / adjectives.len() as u64 % nouns.len() as u64) as usize]
                )
            } else {
                slug
            };
            let stage = available("cursor_plan_stage");
            let artifact = host
                .persist(&Plan {
                    session_id: session_id.clone(),
                    title: slug,
                    content: content.clone(),
                    is_project: args
                        .iter()
                        .rev()
                        .find(|field| field.number == 5)
                        .map(|field| field.varint())
                        .transpose()?
                        .is_some_and(|value| value != 0),
                    stage,
                })
                .await;
            match artifact {
                Err(error) => plan_result(Err(&error.message), "")?,
                Ok(artifact) => {
                    let plan_mode = state
                        .mode
                        .as_ref()
                        .is_some_and(|mode| matches!(mode.target.as_str(), "plan" | "spec"));
                    let decision = if stage || plan_mode && available("question") {
                        host.approve(&Approval { session_id: session_id.clone(), kind: ApprovalKind::ExecutePlan { artifact: artifact.clone() }, question: format!("Plan at {} is complete. Would you like to switch to the build agent and start implementing?", artifact.path), review: Some(format!("{}\n\n_Plan saved to {}_", content.trim(), artifact.path)) }).await.unwrap_or_else(|error| Decision::Rejected(error.message))
                    } else {
                        Decision::Approved
                    };
                    match decision {
                        Decision::Approved => {
                            if stage || plan_mode && available("question") {
                                outcome.mode = Some(Mode {
                                    target: "agent".into(),
                                    first: true,
                                    bridged: false,
                                });
                                outcome.terminal_target = Some("agent".into());
                            }
                            plan_result(Ok(""), &artifact.uri)?
                        }
                        Decision::Rejected(_) => plan_result(
                            Err(
                                "The user did not approve executing this plan. Keep planning: refine the plan and propose it again when it is ready.",
                            ),
                            &artifact.uri,
                        )?,
                    }
                }
            }
        } else {
            plan_result(
                Err("CreatePlan requires a Location-owned planning host to write the plan file"),
                "",
            )?
        }
    };
    let mut response = Vec::new();
    protobuf::write_varint(&mut response, 1, u64::from(id))?;
    protobuf::write_bytes(&mut response, variant.number, &result)?;
    outcome.reply = wrap(6, &response)?;
    Ok(Some(outcome))
}
pub(crate) fn reminder(state: &mut State, tools: &[ToolDefinition]) -> Option<String> {
    let mode = state.mode.as_mut()?;
    if mode.bridged
        && tools
            .iter()
            .any(|tool| tool.name.as_str() == Some("plan_enter"))
    {
        mode.target = "agent".into();
        mode.first = true;
        mode.bridged = false;
    }
    let first = mode.first;
    mode.first = false;
    let body = match mode.target.as_str() {
        "plan" | "spec" => {
            if first {
                let leave = if tools
                    .iter()
                    .any(|tool| tool.name.as_str() == Some("cursor_plan_stage"))
                {
                    "record the finished plan with Cursor CreatePlan. The host stage tool waits for the host plan review and does not return until the user accepts or declines. Do not call `plan_exit` to submit or skip that review, and do not implement until the tool returns success"
                } else if !tools
                    .iter()
                    .any(|tool| tool.name.as_str() == Some("plan_exit"))
                {
                    "record the finished plan (Cursor CreatePlan). Writing it needs no approval, and the user is then asked whether to start implementing; if they decline, refine the plan and record it again"
                } else {
                    "record the finished plan, then call OpenCode `plan_exit` so the user can approve leaving plan mode"
                };
                format!(
                    "Plan mode is active. The user does not want execution yet -- you MUST NOT make edits, run non-readonly tools (including changing configs or making commits), or otherwise modify system state. This supersedes any conflicting instruction.\n\n1. Research enough to make an accurate plan.\n2. Before finishing, resolve decisions that would materially change the implementation path, touched files, architecture, user-visible behavior, data model, or validation strategy. If investigation cannot resolve one, ask clarifying questions in small batches (use the OpenCode `question` tool when available).\n3. Do not put choices in the plan for the user to resolve. The plan must present one recommended approach, not unresolved questions or \"choose A or B\" options.\n4. When ready, {leave}.\n5. Do not execute the plan until the user confirms it."
                )
            } else {
                "Plan mode is still active. You MUST NOT make edits, run non-readonly tools (including changing configs or making commits), or otherwise modify system state. This supersedes any conflicting instruction.".into()
            }
        }
        "chat" => if first { r#"Ask mode is active. The user wants you to answer questions about their codebase or coding in general. You MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received (for example, to make edits).

Your role in Ask mode:

1. Answer the user's questions comprehensively and accurately. Focus on providing clear, detailed explanations.
2. Use readonly tools to explore the codebase and gather information needed to answer the user's questions.
3. Provide code examples and references when helpful, citing specific file paths and line numbers.
4. If you need more information, ask the user for clarification (OpenCode `question` when available).
5. You may provide suggestions about how to implement something, but you MUST NOT actually implement it yourself.
6. If the user asks you to make changes or implement something, politely remind them that you're in Ask mode and can only provide information and guidance. Suggest they switch to Agent mode (OpenCode `plan_exit` / SwitchMode target agent) if they want you to make changes."#.into() } else { "Ask mode is still active. You MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received (for example, to make edits).".into() },
        "debug" => if first { r#"You are now in **DEBUG MODE**. You must debug with **runtime evidence**.

**Why this approach:** Traditional AI agents jump to fixes claiming high confidence, but fail due to lacking runtime information. You cannot and must NOT fix bugs from code-only guesses — you need actual runtime data.

**Your systematic workflow:**
1. Generate 3-5 precise hypotheses about WHY the bug occurs.
2. Instrument code with logs to test hypotheses in parallel.
3. Ask the user to reproduce the bug. Conclude with a <reproduction_steps>...</reproduction_steps> block when the user must run something (mandatory unless the issue is fully confirmed fixed).
4. Analyze logs, accept/reject hypotheses, and only then implement a fix.
5. Verify the fix with runtime evidence before claiming success.

Prefer reproduction, runtime logs, and end-to-end verification over speculative refactors."#.into() } else { r#"Debug mode is still active. You must debug with **runtime evidence**.

**During fixes:** Do NOT remove instrumentation until post-fix verification logs prove success or the user explicitly asks you to remove it.
**Testing:** Prefer reproduction, runtime logs, and end-to-end verification; run tests when they directly exercise a hypothesis or confirm the final fix.
**Reproduction steps (MANDATORY):** Unless the issue is fully confirmed fixed, conclude with a <reproduction_steps>...</reproduction_steps> block when the user must reproduce.
**If fix failed:** Generate NEW hypotheses from different subsystems and add more instrumentation."#.into() },
        "multitask" => r#"Multitask Mode is active. You are a coordinator who pushes meaningful work to asynchronous workers through the OpenCode `task` tool (prefer background=true when the host supports it).

- For most non-trivial requests, launch or resume one coherent worker and let that worker handle the investigation/implementation.
- After delegating the only coherent worker task, do not redo the same work in the foreground. Only coordinate, answer a new independent question, or synthesize after multiple workers return.
- NEVER await or sleep while waiting for a running subagent — end your response; you will be notified when it completes.
- Do NOT aggressively decompose small or medium tasks into many sibling agents. Multitask Mode is about moving substantial work out of the foreground, not maximizing parallel agents.
- For trivial requests (zero or one tool call), fulfill them directly and disregard these Multitask instructions."#.into(),
        "triage" => if first { r#"Triage mode is active. Your job is to coordinate long-horizon, multi-step work by delegating to subagents and integrating their progress.

1. Break the user's task into well-scoped subtasks and launch subagents with the OpenCode `task` tool. Provide clear objectives and context so each subagent can make measurable progress.
2. Routinely inspect subagent output and synthesize results.
3. Decide next steps and iterate: launch additional agents, request revisions, or merge work when ready.
4. Throughout triage mode, maintain a global plan, document your decisions, and ensure the combined work moves the user toward their goal."#.into() } else { "Triage mode is still active. You must continue to coordinate long-horizon, multi-step work by delegating to subagents and integrating their progress.".into() },
        "project" => r#"You are Project Agent Mode: a long-running, high-level planner and orchestrator for complex software projects.

Your mandate is to convert user intent into a correct, high-quality implementation by delegating nearly all work to subagents and coordinating them safely over long horizons.

## Non-Negotiable Rules
1) Orchestrate, don't execute — you are NOT an implementer. Workspace modifications MUST be performed by OpenCode `task` subagents.
2) Task-first for everything — default to spawning subagents for research, exploration, implementation, validation, and review. Use your own read-only tools only for quick triage and synthesizing plans.
3) No work without clarity — if ambiguity remains, stop and ask clarifying questions (OpenCode `question` when available).
4) Phase-gated workflow — Clarify → Research → Plan → User Review → Implement → Review → Iterate → Finalize. Do not skip phases.
5) Externalize state — assume chat context may be condensed; keep durable progress notes so work can resume from written artifacts."#.into(),
        "background" => r#"Cloud / background mode intent is active. Prefer long-running and environment/browser automation work via OpenCode `task` subagents (background=true when advertised) rather than blocking the foreground turn.

- Useful when the task needs browser automation, multi-service environments, or should keep running if the local session is interrupted.
- After launching background work, end your response promptly; do not busy-wait.
- For short local unit/lint/typecheck work, stay in ordinary agent execution instead."#.into(),
        _ => {
            if first {
                "Agent mode is active (OpenCode build / agents). You have left plan mode and may implement: edit files, run tools, and execute the agreed approach.\n\nThe plan-mode restriction is over. An earlier reminder that forbade edits no longer applies.\n\n- Change file contents with the advertised `write` and `edit` tools.\n- Prefer making progress with the advertised host tools.\n- If the task is large or ambiguous again, switch back to plan mode (OpenCode `plan_enter` / SwitchMode target plan) before a large rewrite.".into()
            } else {
                "Agent mode is still active. Continue implementing with the advertised host tools, and change file contents with `write` and `edit`. Switch back to plan mode only when a new large/ambiguous design decision appears.".into()
            }
        }
    };
    Some(format!("<system_reminder>\n{body}\n</system_reminder>"))
}
fn markdown(args: &[Field<'_>]) -> Result<String, Error> {
    let name = text(args, 4)?.trim().to_owned();
    let overview = text(args, 3)?.trim().to_owned();
    let plan = text(args, 1)?.trim().to_owned();
    let leading = plan.lines().next().and_then(|line| line.strip_prefix("# "));
    let body = if !name.is_empty()
        && leading.is_some_and(|heading| heading.trim().to_lowercase() == name.to_lowercase())
    {
        plan.split_once('\n')
            .map(|(_, body)| body.trim_start())
            .unwrap_or(&plan)
    } else {
        &plan
    };
    let mut parts = Vec::new();
    if !name.is_empty() {
        parts.push(format!("# {name}"));
    }
    if !overview.is_empty() && !body.starts_with(&overview) {
        parts.push(overview);
    }
    if !body.is_empty() {
        parts.push(body.into());
    }
    let todos = args
        .iter()
        .filter(|field| field.number == 2)
        .map(|field| {
            let fields = protobuf::fields(field.bytes()?)?;
            let content = text(&fields, 2)?;
            if content.is_empty() {
                return Ok(None);
            }
            let status = fields
                .iter()
                .rev()
                .find(|field| field.number == 3)
                .map(|field| field.uint32())
                .transpose()?
                .unwrap_or(0);
            Ok(Some(format!(
                "- {} {content}",
                match status {
                    3 => "[x]",
                    4 => "[~]",
                    _ => "[ ]",
                }
            )))
        })
        .collect::<Result<Vec<_>, Error>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if !todos.is_empty() {
        parts.push(format!("## Todos\n\n{}", todos.join("\n")));
    }
    let joined = parts.join("\n\n");
    let mut normalized = String::new();
    let mut newlines = 0;
    for ch in joined.chars() {
        newlines = if ch == '\n' { newlines + 1 } else { 0 };
        if newlines <= 2 {
            normalized.push(ch);
        }
    }
    Ok(if normalized.trim_end().is_empty() {
        String::new()
    } else {
        format!("{}\n", normalized.trim_end())
    })
}
fn validate_plan(args: &[Field<'_>]) -> Result<(), Error> {
    for field in args {
        match field.number {
            1 | 3 | 4 => {
                field.text()?;
            }
            2 => {
                for todo in protobuf::fields(field.bytes()?)? {
                    match todo.number {
                        1 | 2 | 6 => {
                            todo.text()?;
                        }
                        3..=5 => {
                            todo.varint()?;
                        }
                        _ => {}
                    }
                }
            }
            5 => {
                field.varint()?;
            }
            _ => {}
        }
    }
    Ok(())
}
fn text(fields: &[Field<'_>], number: u32) -> Result<String, Error> {
    fields
        .iter()
        .rev()
        .find(|field| field.number == number)
        .map(|field| field.text())
        .transpose()
        .map(|value| value.unwrap_or_default())
}
fn wrap(number: u32, body: &[u8]) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    protobuf::write_bytes(&mut out, number, body)?;
    Ok(out)
}
fn rejection(reason: &str) -> Result<Vec<u8>, Error> {
    wrap(2, &wrap(1, reason.as_bytes())?)
}
fn plan_result(result: Result<&str, &str>, uri: &str) -> Result<Vec<u8>, Error> {
    let mut value = match result {
        Ok(_) => wrap(1, &[])?,
        Err(reason) => wrap(2, &wrap(1, reason.as_bytes())?)?,
    };
    protobuf::write_string(&mut value, 3, &uri.into())?;
    wrap(1, &value)
}

#[cfg(test)]
mod tests {
    use super::{Approval, Artifact, Decision, Host, Plan, State, query, wrap};
    use crate::Error;
    use crate::llm::ToolDefinition;
    use std::{future::Future, pin::Pin, sync::Mutex};
    use ycoding_schema::LosslessString;

    struct NamingHost {
        titles: Mutex<Vec<String>>,
    }
    impl Host for NamingHost {
        fn approve<'a>(
            &'a self,
            _request: &'a Approval,
        ) -> Pin<Box<dyn Future<Output = Result<Decision, Error>> + Send + 'a>> {
            Box::pin(async { panic!("non-plan-mode write needs no execution approval") })
        }
        fn persist<'a>(
            &'a self,
            plan: &'a Plan,
        ) -> Pin<Box<dyn Future<Output = Result<Artifact, Error>> + Send + 'a>> {
            Box::pin(async move {
                self.titles.lock().unwrap().push(plan.title.clone());
                Ok(Artifact {
                    path: "/fixture/plan.md".into(),
                    uri: "file:///fixture/plan.md".into(),
                })
            })
        }
        fn switch_agent<'a>(
            &'a self,
            _id: &'a LosslessString,
            _target: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'a>> {
            Box::pin(async { panic!("naming cannot switch agents") })
        }
    }

    #[tokio::test]
    async fn cursor_unnamed_plan_slug_uses_provider_seed_and_committed_word_lists() {
        let host = NamingHost {
            titles: Mutex::new(Vec::new()),
        };
        let tool = ToolDefinition {
            name: "question".into(),
            description: "fixture".into(),
            input_schema: ycoding_schema::parse_json(r#"{"type":"object"}"#).unwrap(),
            output_schema: None,
            cache: None,
            metadata: None,
            native: None,
        };
        for name in ["", "!!!", "My Plan"] {
            let args = [
                wrap(1, b"Research").unwrap(),
                wrap(4, name.as_bytes()).unwrap(),
            ]
            .concat();
            let message = wrap(7, &wrap(1, &args).unwrap()).unwrap();
            let outcome = query(
                &message,
                &State::default(),
                std::slice::from_ref(&tool),
                Some(&"ses-fixture".into()),
                Some(&host),
                || Ok(100),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(outcome.terminal_target.is_none());
        }
        assert_eq!(
            host.titles.lock().unwrap().as_slice(),
            ["lucky-circuit", "lucky-circuit", "my-plan"]
        );
    }

    struct NoEffectHost;
    impl Host for NoEffectHost {
        fn approve<'a>(
            &'a self,
            _request: &'a Approval,
        ) -> Pin<Box<dyn Future<Output = Result<Decision, Error>> + Send + 'a>> {
            Box::pin(async { panic!("malformed plan fields cannot request approval") })
        }
        fn persist<'a>(
            &'a self,
            _plan: &'a Plan,
        ) -> Pin<Box<dyn Future<Output = Result<Artifact, Error>> + Send + 'a>> {
            Box::pin(async { panic!("malformed plan fields cannot persist a plan") })
        }
        fn switch_agent<'a>(
            &'a self,
            _id: &'a LosslessString,
            _target: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'a>> {
            Box::pin(async { panic!("malformed plan fields cannot switch agents") })
        }
    }

    #[tokio::test]
    async fn cursor_malformed_nested_plan_fields_ack_empty_without_effects() {
        let tool = ToolDefinition {
            name: "question".into(),
            description: "fixture".into(),
            input_schema: ycoding_schema::parse_json(r#"{"type":"object"}"#).unwrap(),
            output_schema: None,
            cache: None,
            metadata: None,
            native: None,
        };
        for args in [
            vec![8, 1],
            vec![24, 1],
            vec![32, 1],
            vec![40, 1, 10, 1, b'X', 18, 2, 16, 1],
            vec![10, 1, b'X', 18, 2, 8, 1],
            vec![10, 1, b'X', 18, 2, 48, 1],
            vec![10, 1, b'X', 18, 3, 34, 1, b'x'],
            vec![10, 1, b'X', 18, 3, 42, 1, b'x'],
        ] {
            let message = wrap(7, &wrap(1, &args).unwrap()).unwrap();
            let outcome = query(
                &message,
                &State::default(),
                std::slice::from_ref(&tool),
                Some(&"ses-fixture".into()),
                Some(&NoEffectHost),
                || Ok(29),
            )
            .await
            .expect("malformed nested arguments must not fail the Run")
            .unwrap();
            assert_eq!(outcome.reply, [50, 10, 8, 0, 58, 6, 10, 4, 10, 0, 26, 0]);
            assert!(outcome.mode.is_none());
            assert!(outcome.terminal_target.is_none());
        }
    }

    struct ApprovalHost {
        events: Mutex<Vec<String>>,
        reject: bool,
    }
    impl Host for ApprovalHost {
        fn approve<'a>(
            &'a self,
            request: &'a Approval,
        ) -> Pin<Box<dyn Future<Output = Result<Decision, Error>> + Send + 'a>> {
            Box::pin(async move {
                self.events.lock().unwrap().push(match &request.kind {
                    super::ApprovalKind::SwitchMode { tool, .. } => {
                        tool.clone().unwrap_or_else(|| "question".into())
                    }
                    super::ApprovalKind::ExecutePlan { .. } => "review".into(),
                });
                Ok(if self.reject {
                    Decision::Rejected("not approved".into())
                } else {
                    Decision::Approved
                })
            })
        }
        fn persist<'a>(
            &'a self,
            plan: &'a Plan,
        ) -> Pin<Box<dyn Future<Output = Result<Artifact, Error>> + Send + 'a>> {
            Box::pin(async move {
                assert!(plan.stage);
                self.events.lock().unwrap().push("stage".into());
                Ok(Artifact {
                    path: "/fixture/plan.md".into(),
                    uri: "local://brave-cactus-plan.md".into(),
                })
            })
        }
        fn switch_agent<'a>(
            &'a self,
            _id: &'a LosslessString,
            _target: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'a>> {
            Box::pin(async { panic!("query cannot deliver agent switch before terminal") })
        }
    }
    #[tokio::test]
    async fn cursor_stage_and_native_or_question_exit_approval_paths_preserve_the_gate() {
        for reject in [false, true] {
            for name in ["plan_exit", "question", "cursor_plan_stage"] {
                let tool = ToolDefinition {
                    name: name.into(),
                    description: "fixture".into(),
                    input_schema: ycoding_schema::parse_json(r#"{"type":"object"}"#).unwrap(),
                    output_schema: None,
                    cache: None,
                    metadata: None,
                    native: None,
                };
                let host = ApprovalHost {
                    events: Mutex::new(Vec::new()),
                    reject,
                };
                let variant = if name == "cursor_plan_stage" { 7 } else { 4 };
                let args = wrap(1, if variant == 7 { b"Research" } else { b"agent" }).unwrap();
                let message = wrap(variant, &wrap(1, &args).unwrap()).unwrap();
                let outcome = query(
                    &message,
                    &State::default(),
                    std::slice::from_ref(&tool),
                    Some(&"ses-fixture".into()),
                    Some(&host),
                    || Ok(29),
                )
                .await
                .unwrap()
                .unwrap();
                assert_eq!(
                    outcome.terminal_target.as_deref(),
                    (!reject).then_some("agent")
                );
                assert_eq!(
                    host.events.lock().unwrap().as_slice(),
                    if name == "cursor_plan_stage" {
                        vec!["stage", "review"]
                    } else {
                        vec![name]
                    }
                );
            }
        }
    }
    #[tokio::test]
    async fn cursor_malformed_switch_and_lifecycle_queries_do_not_raise_approval_or_modify_mode() {
        let tool = ToolDefinition {
            name: "question".into(),
            description: "fixture".into(),
            input_schema: ycoding_schema::parse_json(r#"{"type":"object"}"#).unwrap(),
            output_schema: None,
            cache: None,
            metadata: None,
            native: None,
        };
        for args in [
            vec![8, 1],
            [wrap(1, b"agent").unwrap(), vec![16, 1]].concat(),
        ] {
            let message = wrap(4, &wrap(1, &args).unwrap()).unwrap();
            let outcome = query(
                &message,
                &State::default(),
                std::slice::from_ref(&tool),
                None,
                None,
                || Ok(29),
            )
            .await
            .expect("malformed switches receive typed rejection")
            .unwrap();
            let outer = super::protobuf::fields(&outcome.reply).unwrap();
            let response = super::protobuf::fields(outer[0].bytes().unwrap()).unwrap();
            let result = super::protobuf::fields(response[1].bytes().unwrap()).unwrap();
            assert_eq!(result[0].number, 2);
            assert!(outcome.mode.is_none());
        }
        let host = ApprovalHost {
            events: Mutex::new(Vec::new()),
            reject: false,
        };
        for variant in [4, 7] {
            let message = wrap(variant, &wrap(1, &wrap(1, b"plan").unwrap()).unwrap()).unwrap();
            let outcome = query(
                &message,
                &State::default(),
                &[],
                Some(&"ses-fixture".into()),
                Some(&host),
                || Ok(29),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(outcome.mode.is_none());
            assert!(outcome.terminal_target.is_none());
        }
        assert!(host.events.lock().unwrap().is_empty());
    }
}
