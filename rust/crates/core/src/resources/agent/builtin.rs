use super::{empty, prompts};
use crate::resources::{
    config::Roots,
    discovery::{Error, markdown},
};
use std::path::Path;
use ycoding_schema::{DomainDecode, JsonValue, agent, permission};

pub fn catalog(roots: &Roots) -> Result<Vec<agent::Info>, Error> {
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
            if agent.mode == "primary".into() {
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
    btw.permissions.extend(defaults[1..4].iter().cloned());
    agents.push(btw);
    agents.extend(
        [
            ("compaction", "Compaction", prompts::COMPACTION),
            ("title", "Title", prompts::TITLE),
            ("goal", "Goal", prompts::GOAL),
            ("prediction", "Prediction", prompts::PREDICTION),
            ("prompt", "Prompt", prompts::PROMPT),
            ("decision", "Decision", prompts::DECISION),
            ("summary", "Summary", prompts::SUMMARY),
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
    let shell = data.join("shell/*/*");
    let temporary = tmp.join("*");
    Ok(vec![
        rule("*", "*", "allow"),
        rule("external_directory", "*", "ask"),
        rule(
            "external_directory",
            shell
                .to_str()
                .ok_or_else(|| Error::InvalidPath(shell.clone()))?,
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
