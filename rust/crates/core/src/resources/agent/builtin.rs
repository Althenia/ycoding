use super::{empty, prompts};
use crate::resources::{
    config::Roots,
    discovery::{Error, markdown},
};
use std::path::Path;
use ycoding_schema::{DomainDecode, JsonValue, agent, permission, session_scope::Scope};

pub fn catalog(roots: &Roots, scope: Scope) -> Result<Vec<agent::Info>, Error> {
    let defaults = defaults(&roots.data, &roots.tmp)?;
    let mut agents = [
        ("GSD", include_str!("prompts/GSD.md")),
        ("architech", include_str!("prompts/architech.md")),
        ("god", include_str!("prompts/god.md")),
        ("yangi", include_str!("prompts/yangi.md")),
        ("occam", include_str!("prompts/occam.md")),
        ("omoikane", include_str!("prompts/omoikane.md")),
        ("wittgenstein", include_str!("prompts/wittgenstein.md")),
        ("zeus", include_str!("prompts/zeus.md")),
    ]
    .into_iter()
    .map(|(id, source)| {
        let source = markdown::parse(source).expect("embedded agent Markdown");
        let metadata = source
            .data
            .fields(&["description", "mode", "color", "request"])
            .expect("embedded agent metadata");
        let mut agent = empty(id.into());
        agent.name = format!("{}{}", id[..1].to_uppercase(), &id[1..]).into();
        agent.description = metadata
            .get(&"description".into())
            .map(|v| ycoding_schema::LosslessString::decode(v).expect("embedded description"));
        agent.mode =
            ycoding_schema::LosslessString::decode(metadata.get(&"mode".into()).expect("mode"))
                .expect("embedded mode");
        agent.color = metadata
            .get(&"color".into())
            .map(|v| agent::Color::decode(v).expect("embedded color"));
        let JsonValue::Object(request) = metadata.get(&"request".into()).expect("request") else {
            unreachable!()
        };
        agent.request.body =
            ycoding_schema::provider::Settings::decode(request.get(&"body".into()).expect("body"))
                .expect("embedded request body");
        agent.system = Some(
            if scope == Scope::Standalone {
                let base = source.content.trim();
                let end = base
                    .char_indices()
                    .find_map(|(index, character)| {
                        (character.is_whitespace()
                            && matches!(base[..index].chars().next_back(), Some('.' | '!' | '?')))
                        .then_some(index)
                    })
                    .unwrap_or(base.len());
                format!("{}\n\nThis is a standalone text conversation. Only question, todowrite, goal, task_complete are available. There is no host filesystem, shell, worktree, subagent, plugin, skill, MCP, or network access. Obey the user's explicit direction without arguing, decide routine choices pragmatically to minimize escalation, follow the user's constraints, distinguish verified facts from uncertainty, write plain natural prose without AI filler or stock phrasing, and drive concisely to the user's goal.", &base[..end])
            } else if agent.mode == "primary".into() {
                [
                    prompts::PROJECT,
                    source.content.trim(),
                    prompts::NOTICE,
                    prompts::MAIN,
                ]
                .join("\n\n")
            } else {
                [prompts::PROJECT, source.content.trim(), prompts::CHILD].join("\n\n")
            }
            .into(),
        );
        agent.permissions = defaults.clone();
        agent
            .permissions
            .extend(if agent.mode == "subagent".into() {
                vec![rule("subagent", "*", "deny"), rule("shell", "*", "allow")]
            } else {
                vec![
                    rule("question", "*", "allow"),
                    rule("plan_enter", "*", "allow"),
                    rule("shell", "*", "allow"),
                ]
            });
        agent
    })
    .collect::<Vec<_>>();
    let mut btw = empty("btw".into());
    btw.name = "BTW".into();
    btw.mode = "subagent".into();
    btw.system = Some(prompts::BTW.into());
    btw.permissions.extend(defaults.iter().cloned());
    btw.permissions.extend([
        rule("read", "*", "allow"),
        rule("grep", "*", "allow"),
        rule("glob", "*", "allow"),
        rule("webfetch", "*", "allow"),
        rule("websearch", "*", "allow"),
        rule("question", "*", "allow"),
        rule("edit", "*", "ask"),
        rule("write", "*", "ask"),
        rule("patch", "*", "ask"),
        rule("shell", "*", "ask"),
        rule("worktree", "*", "ask"),
        rule("subagent", "*", "deny"),
    ]);
    btw.permissions.extend(defaults[4..7].iter().cloned());
    agents.push(btw);
    agents.extend(
        [
            ("compaction", "Compaction", prompts::COMPACTION.to_owned()),
            ("title", "Title", prompts::TITLE.to_owned()),
            ("goal", "Goal", prompts::GOAL.to_owned()),
            ("prediction", "Prediction", prompts::PREDICTION.to_owned()),
            ("prompt", "Prompt", prompts::PROMPT.to_owned()),
            ("decision", "Decision", prompts::DECISION.to_owned()),
            (
                "yolo-permission",
                "Yolo Permission",
                prompts::YOLO_PERMISSION.to_owned(),
            ),
            (
                "yolo-guardrail",
                "Yolo Guardrail",
                prompts::YOLO_GUARDRAIL.to_owned(),
            ),
            (
                "yolo-answer",
                "Yolo Answer",
                prompts::YOLO_ANSWER.to_owned(),
            ),
            ("summary", "Summary", prompts::SUMMARY.to_owned()),
        ]
        .into_iter()
        .map(|(id, name, system)| {
            let mut agent = empty(id.into());
            agent.name = name.into();
            agent.mode = "primary".into();
            agent.hidden = true;
            agent.system = Some(system.into());
            agent.permissions.extend(defaults.iter().cloned());
            agent.permissions.push(rule("*", "*", "deny"));
            agent
        }),
    );
    Ok(agents)
}

fn defaults(data: &Path, tmp: &Path) -> Result<Vec<permission::Rule>, Error> {
    let data = data.join("*");
    let temporary = tmp.join("*");
    Ok(vec![
        rule("*", "*", "allow"),
        rule("chatgpt_*", "*", "ask"),
        rule("claude_*", "*", "ask"),
        rule("browser_script", "*", "ask"),
        rule("external_directory", "*", "ask"),
        rule(
            "external_directory",
            data.to_str()
                .ok_or_else(|| Error::InvalidPath(data.clone()))?,
            "allow",
        ),
        rule(
            "external_directory",
            temporary
                .to_str()
                .ok_or_else(|| Error::InvalidPath(temporary.clone()))?,
            "allow",
        ),
        rule("question", "*", "deny"),
        rule("plan_enter", "*", "deny"),
        rule("plan_exit", "*", "deny"),
        rule("read", "*", "allow"),
        rule("read", "*.env", "ask"),
        rule("read", "*.env.*", "ask"),
        rule("read", "*.env.example", "allow"),
    ])
}

fn rule(action: &str, resource: &str, effect: &str) -> permission::Rule {
    permission::Rule {
        action: action.into(),
        resource: resource.into(),
        effect: permission::Effect(effect.into()),
    }
}
