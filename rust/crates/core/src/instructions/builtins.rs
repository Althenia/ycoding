use super::{Error, Observation, Source, join};
use chrono::TimeZone;
use std::sync::Arc;
use ycoding_schema::{DomainDecode, JsonValue, LosslessString, instruction};

pub struct Environment {
    pub directory: String,
    pub project_root: String,
    pub git: bool,
    pub platform: String,
    pub data: String,
}

pub fn enabled(
    name: &str,
    capabilities: &crate::resources::config::capabilities::ConfigCapabilities,
    tools: &std::collections::BTreeSet<String>,
) -> bool {
    if !crate::resources::config::capabilities::BUILTIN_INSTRUCTIONS.contains(&name) {
        return false;
    }
    let required = match name {
        "subagent-reuse" => Some("subagent"),
        "shell-memory" => Some("shell"),
        "project-artifact-authoring" => Some("project_artifact"),
        "decision-input" => Some("question"),
        "decision-use" => Some("decision"),
        "task-completion" => Some("task_complete"),
        "memory" => Some("memory"),
        _ => None,
    };
    capabilities.builtin_instructions.allows(&name.into())
        && required.is_none_or(|tool| tools.contains(tool))
}

pub fn load(
    environment: Environment,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    scope: ycoding_schema::session_scope::Scope,
) -> Vec<Source> {
    let tasks = std::path::Path::new(&environment.data).join("tasks");
    let scratch = format!(
        r#"Put new ad-hoc agent scratch files, logs, snapshots and patches in a unique per-task directory `{tasks}/<unique-task-name>`, never in a repository `.cache` directory. Leave existing repository and tool-managed caches in place and never move or delete them automatically. Built-in agents need no outside-directory confirmation under `{data}`; your agent's permissions, explicit denies, permission ceilings and guardrail reviews still apply."#,
        tasks = tasks.display(),
        data = environment.data,
    );
    let value = format!(
        "<env>\n  Working directory: {}\n  Workspace root folder: {}\n  Is directory a git repo: {}\n  Platform: {}\n</env>\n{scratch}",
        environment.directory,
        environment.project_root,
        if environment.git { "yes" } else { "no" },
        environment.platform
    );
    let worktrees = std::path::Path::new(&environment.data)
        .join("worktrees")
        .to_string_lossy()
        .into_owned();
    let worktree = format!(
        "When working with a Git worktree, create it at `{worktrees}/<repo-key>/<name>`, where `<repo-key>` is `repo_` followed by the SHA-256 hex digest of the real path of the repository's Git common directory. Give every worktree a named branch identical to its worktree name, for example `git worktree add -b <name> {worktrees}/<repo-key>/<name>`; never create a detached HEAD worktree. During authorized integration, use `git diff --name-only` between the previous and latest target heads to compare intermediate target changes against lane files. Automatically rebase linearly onto the latest target head when files are disjoint; ask only for overlapping file conflicts or failing checks. Complete consolidated checks, a single commit, linear rebase onto the latest target head, `git merge --ff-only --autostash <name>` from the target branch checkout, and safe non-force worktree removal in one continuous pass without ceremony, handoffs, or slots. Preserve unrelated work, existing Git identity, and permission boundaries; never create a merge commit. Prune stale registrations after verified worktree removal. Never stage, commit, integrate, or remove a worktree without authorization; this policy grants none."
    );
    let mut sources = vec![
        source(
            "core/environment",
            Arc::new(move || {
                let value = value.clone();
                Box::pin(async move { Ok(Observation::Value(JsonValue::String(value.into()))) })
            }),
            "Here is some useful information about the environment you are running in:\n",
            "The environment you are running in is now:\n",
        ),
        source(
            "core/date",
            Arc::new(move || {
                let clock = clock.clone();
                Box::pin(async move {
                    let date = chrono::Local
                        .timestamp_millis_opt(clock())
                        .single()
                        .ok_or(Error::ReaderFailed)?;
                    Ok(Observation::Value(JsonValue::String(
                        date.format("%a %b %d %Y").to_string().into(),
                    )))
                })
            }),
            "Today's date: ",
            "Today's date is now: ",
        ),
    ];
    sources.extend([
        ("core/subagent-reuse", "Before launching a subagent, inspect the current direct child TeamView. Reuse a relevant direct terminal child with subagent_control send when its agent, domain, model, and retained context fit; send only incremental context. Launch a new child when role, model, location, permission, or task context does not fit. Use resume only for durable pending work."),
        ("core/shell-memory", r#"Shell commands accept memory_limit_mb to constrain memory used by the command process tree. A finite limit supplies matching Go and Node runtime hints and terminates the process tree if sampled aggregate resident memory still exceeds the limit. Leave commands uncapped unless the project or user explicitly configures a limit; never impose unrequested resource limits."#),
        ("core/project-artifact-authoring", "At a safe boundary after the primary task is complete and validated, create or update at most one Project Artifact for each newly learned reusable insight. The insight must be repeated, durable, repository-specific, and useful in future work. Never persist transient task state, current todos, user preferences, prompts, logs, secrets, credentials, private paths/URLs, customer data, or speculation. Search existing artifacts first and update the owned project version rather than duplicating it. Prefer a skill; use a command only for an invokable instruction-only template; use a least-privilege agent only for a genuine reusable role. Workflows are not a first-class artifact. Never create or enable a plugin automatically. Do not interrupt the primary task to author an artifact."),
    ].into_iter().map(|(key, text)| source(key, Arc::new(move || Box::pin(async move { Ok(Observation::Value(JsonValue::String(text.into()))) })), "", "")));
    sources.push(source(
        "core/git-worktree",
        Arc::new(move || {
            let worktree = worktree.clone();
            Box::pin(async move { Ok(Observation::Value(JsonValue::String(worktree.into()))) })
        }),
        "",
        "",
    ));
    sources.extend([
        ("core/git-attribution", "When creating commits, use the user's existing Git author and committer identity and write messages without Co-authored-by trailers or AI, model, agent, or provider attribution. Do not set `user.name`, `user.email`, or `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, or pass `--author` or `--reset-author`, as part of committing. If Git reports a missing identity, report it and ask the user to configure their own identity; never invent one."),
        ("core/decision-input", r#"Resolve routine choices, minor ambiguities, and recoverable obstacles yourself from evidence first; call question only when progress genuinely needs underivable user input. Offer concise choices with a recommended default for decisions and empty options for free text, and continue immediately after its answer. Keep permission and guardrail approvals on their native paths. Answers YOLO handles every question, including explicit-decision and open questions, with a valid automatic answer or deterministic valid fallback instead of asking or deferring. Outside YOLO, unresolved requests wait for the user or defer to the review box while defer is active. Do not re-ask, retry or guess deferred manual decisions. /defer remains active across prompts until explicitly toggled off; review decisions do not change it. Call task_complete only after all work is verified."#),
        ("core/decision-use", r#"Use decision for bounded typed judgments from the hidden helper. Confidence is self-reported and uncalibrated. Prefer tests, grep, typechecks and inventory for facts. Supply authorized evidence, neutral questions, observable criteria, distinct choices including keep-current and adjacent score levels. Batch independent questions; separate dependent judgments. Grade mode (`grade: true`) returns each listed choice once with confidence in [0,1] and nonempty evidence of at most 500 characters, without a pick. Treat refusal, invalid output, unavailable routes, low confidence and conflicting evidence as uncertainty. Set thresholds by mistake cost, preserve owner choices and reuse unchanged judgments. Advisory judgments never grant authority or prove completion. Permissions, guardrails and answers each use an independent mode through /autonomous. Manual requires a typed decision and calls no helper; Auto applies deterministic rules without model fallback. Permissions YOLO admits directly except Project coordinator execution restrictions; guardrails YOLO bypasses classification and review while retaining action capacity. Answers YOLO alone consults yolo-answer, with validated fallbacks for unsettled results. New YOLO enablement requires explicit client risk acceptance; never change modes or security settings on the user's behalf. Defer persists until explicitly disabled and retains unresolved review items. Never retry deferred actions."#),
        ("core/task-completion", "Call task_complete once after all accepted work is finished and verified, immediately before your final reply. Do not call it for ordinary replies, idle, partial results, blockers, or unfinished pending, subagent, or background work. In goal mode, first complete the achieved goal with the goal tool; goal completion alone is not work-completion evidence. If new input or unfinished work intervenes, finish and verify it before declaring completion again."),
    ].into_iter().map(|(key, text)| source(key, Arc::new(move || Box::pin(async move { Ok(Observation::Value(JsonValue::String(text.into()))) })), "", "")));
    if scope == ycoding_schema::session_scope::Scope::Standalone {
        sources.retain(|source| {
            !matches!(
                super::key(&source.key).as_str(),
                Some(
                    "core/environment"
                        | "core/git-worktree"
                        | "core/git-attribution"
                        | "core/shell-memory"
                )
            )
        });
    }
    sources
}
fn source(
    key: &str,
    read: Arc<dyn Fn() -> super::ReadFuture + Send + Sync>,
    initial: &'static str,
    changed: &'static str,
) -> Source {
    Source {
        key: instruction::Key::decode(&JsonValue::String(key.into()))
            .expect("built-in instruction key is valid"),
        read,
        initial: Arc::new(move |value| render(value, initial)),
        changed: Arc::new(move |_, value| render(value, changed)),
        removed: None,
    }
}
fn render(value: &JsonValue, prefix: &str) -> Option<LosslessString> {
    match value {
        JsonValue::String(value) => Some(join(&[prefix.into(), value.clone()], "")),
        _ => None,
    }
}
