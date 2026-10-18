use std::{collections::BTreeMap, path::Path};
use ycoding_core::resources::{
    agent::{self, Service},
    config::{Entry, Roots},
    discovery::markdown,
};
use ycoding_schema::{DomainEncode, JsonValue, parse_json, permission};

const TS: &str = include_str!("../../../../packages/core/src/plugin/agent.ts");

fn ts_template(name: &str) -> String {
    TS.split_once(&format!("const {name} = `"))
        .unwrap()
        .1
        .split_once('`')
        .map(|(prefix, _)| prefix.to_owned())
        .filter(|_| name != "MAINCHAT_CAPABILITIES")
        .unwrap_or_else(|| {
            TS.split_once(&format!("const {name} = `"))
                .unwrap()
                .1
                .split_once("`\nconst SUBAGENT_CAPABILITIES")
                .unwrap()
                .0
                .replace("\\`", "`")
        })
}

fn ts_notice() -> &'static str {
    TS.split_once("const SUBAGENT_NOTICE =\n  \"")
        .unwrap()
        .1
        .split_once('"')
        .unwrap()
        .0
}

fn hash(value: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, value.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn roots() -> Roots {
    Roots::runtime(
        Path::new("/home/fixture"),
        Path::new("/tmp"),
        &BTreeMap::new(),
    )
    .unwrap()
}

#[test]
fn all_builtin_fields_and_full_prompts_match_contract_fixtures() {
    let service = Service::new(agent::builtin::catalog(&roots()).unwrap());
    let project = ts_template("YCODING_PROJECT_PROMPT");
    let main = ts_template("MAINCHAT_CAPABILITIES");
    let notice = ts_notice();
    let child = ts_template("SUBAGENT_CAPABILITIES");
    let fixtures = [
        (
            "GSD",
            "GSD",
            "primary",
            0.6,
            "#e67e22",
            include_str!("../../../../packages/core/src/plugin/agent/GSD.md"),
            "82c566555171ea46d5c68a57aa219635ff3020b3d56d95dbf43de7b1766bfa6a",
        ),
        (
            "architech",
            "Architech",
            "primary",
            0.5,
            "#3498db",
            include_str!("../../../../packages/core/src/plugin/agent/architech.md"),
            "b5fd1eb2aabe89d47c253e29d5f1b061c00d42cb1410a725b7d6df5cf707d18b",
        ),
        (
            "god",
            "God",
            "primary",
            0.6,
            "#f1c40f",
            include_str!("../../../../packages/core/src/plugin/agent/god.md"),
            "e2bf2a8daa37d26974a2f299038ac2b6a7e4e9690cb456c07b45ee96acf78119",
        ),
        (
            "yangi",
            "Yangi",
            "primary",
            0.5,
            "#2ecc71",
            include_str!("../../../../packages/core/src/plugin/agent/yangi.md"),
            "8bb56cc118a0a08f9f403e297b653b581634e5b0e42c14caca3e71af56cabae0",
        ),
        (
            "occam",
            "Occam",
            "subagent",
            0.4,
            "#2ecc71",
            include_str!("../../../../packages/core/src/plugin/agent/occam.md"),
            "dcd8dab36af2ff4899f6397e28af336ff50494684ccd7b25d59f900b7d098bf5",
        ),
        (
            "omoikane",
            "Omoikane",
            "subagent",
            0.5,
            "#3498db",
            include_str!("../../../../packages/core/src/plugin/agent/omoikane.md"),
            "b839075ac28e4e60f1a22615ff9254810d9769b83dca4e49eafa6ed61b07dba1",
        ),
        (
            "wittgenstein",
            "Wittgenstein",
            "subagent",
            0.4,
            "#95a5a6",
            include_str!("../../../../packages/core/src/plugin/agent/wittgenstein.md"),
            "7d6f7ef014e49dfb0b0075cbcceb0bfe18088d48066defc6ee20f83bc318c45d",
        ),
        (
            "zeus",
            "Zeus",
            "subagent",
            0.6,
            "#f1c40f",
            include_str!("../../../../packages/core/src/plugin/agent/zeus.md"),
            "7320ec244c2cbf76783528d0c051c061f1e36a6c457f82266f40a34dae428696",
        ),
    ];
    for (id, name, mode, temperature, color, source, digest) in fixtures {
        let expected = markdown::parse(source).unwrap();
        let system = if mode == "primary" {
            [
                project.as_str(),
                expected.content.trim(),
                notice,
                main.as_str(),
            ]
            .join("\n\n")
        } else {
            [project.as_str(), expected.content.trim(), child.as_str()].join("\n\n")
        };
        assert_eq!(hash(&system), digest, "TS fixture changed for {id}");
        let actual = service.get(&id.into()).unwrap();
        assert_eq!(
            actual.system.as_ref().unwrap().to_utf8().unwrap(),
            system,
            "full prompt bytes for {id}"
        );
        assert_eq!(actual.name, name.into());
        assert_eq!(
            service
                .list()
                .iter()
                .find(|agent| agent.id == id.into())
                .unwrap()
                .name,
            name.into()
        );
        let JsonValue::Object(encoded) = actual.encode() else {
            panic!("agent projection must be an object")
        };
        assert_eq!(
            encoded.get(&"name".into()),
            Some(&JsonValue::String(name.into()))
        );
        assert_eq!(
            actual.description.as_ref().unwrap().encode(),
            expected.data.get("description").unwrap().json().unwrap()
        );
        assert_eq!(actual.mode, mode.into());
        assert_eq!(
            actual.request.body.0.get(&"temperature".into()),
            Some(&JsonValue::Number(temperature))
        );
        assert_eq!(actual.color.as_ref().unwrap().0, color.into());
        assert!(
            actual.model.is_none()
                && actual.steps.is_none()
                && actual.locations.is_none()
                && !actual.hidden
        );
        assert!(actual.request.settings.0.is_empty() && actual.request.headers.is_empty());
    }
    for (id, name, digest) in [
        (
            "btw",
            "BTW",
            "f62d7dd50b8416699cd7192d837df2f1d61507fe0b73c065d12197dc6ff74536",
        ),
        (
            "compaction",
            "Compaction",
            "808fcb051cb171858042823bd1fb5849a1a5fedaead453cf74196d0780c1b59e",
        ),
        (
            "title",
            "Title",
            "3a2bb2825186495ff85a45ba5e7477d36f2b26395d209eb9d6e4aef9f0f53ab5",
        ),
        (
            "goal",
            "Goal",
            "37452b0447145c92dc52506b58d3bc2cb2a51b43951e56066f308cf3ac0393b4",
        ),
        (
            "prediction",
            "Prediction",
            "3c0806cedeabc823f1fe44feba429cbb7ba0b34acd95427f4ba2413cbe9a4ce3",
        ),
        (
            "prompt",
            "Prompt",
            "8fc3141b693d5f342a70722d29ab37df56aaabc312a3fce2f3ea8d6f4bceb7d2",
        ),
        (
            "decision",
            "Decision",
            "e12ef401a99100be7f09670c0a8ce273104c8ce3508cd19187db5918f4de0b2c",
        ),
        (
            "summary",
            "Summary",
            "0d10c2647ab3eb40aedd87b2a277a961f1e2e2bc58b5290c5cd2d5eefbddb28a",
        ),
    ] {
        let expected = if id == "decision" {
            include_str!("fixtures/decision-json-prompt.md")
                .trim_end()
                .to_owned()
        } else {
            ts_template(&format!("PROMPT_{}", id.to_uppercase()))
        };
        assert_eq!(hash(&expected), digest);
        let actual = service.get(&id.into()).unwrap();
        assert_eq!(actual.system, Some(expected.into()));
        assert_eq!(actual.name, name.into());
        assert_eq!(actual.hidden, id != "btw");
        assert_eq!(
            actual.mode,
            if id == "btw" { "subagent" } else { "primary" }.into()
        );
        assert!(
            actual.description.is_none()
                && actual.color.is_none()
                && actual.request.body.0.is_empty()
        );
    }
    assert_eq!(
        service
            .list()
            .iter()
            .map(|agent| agent.id.as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "god",
            "GSD",
            "architech",
            "yangi",
            "occam",
            "omoikane",
            "wittgenstein",
            "zeus",
            "btw",
            "compaction",
            "title",
            "goal",
            "prediction",
            "prompt",
            "decision",
            "summary"
        ]
    );
}

#[test]
fn builtin_permission_rules_match_ts_tool_policy_in_order() {
    let service = Service::new(agent::builtin::catalog(&roots()).unwrap());
    let defaults = [
        ("*", "*", "allow"),
        ("external_directory", "*", "ask"),
        (
            "external_directory",
            "/home/fixture/.local/share/ycoding/shell/*/*",
            "allow",
        ),
        ("external_directory", "/tmp/ycoding/*", "allow"),
        ("question", "*", "deny"),
        ("plan_enter", "*", "deny"),
        ("plan_exit", "*", "deny"),
        ("read", "*", "allow"),
        ("read", "*.env", "ask"),
        ("read", "*.env.*", "ask"),
        ("read", "*.env.example", "allow"),
    ]
    .map(|(action, resource, effect)| permission::Rule {
        action: action.into(),
        resource: resource.into(),
        effect: permission::Effect(effect.into()),
    });
    for actual in service.list() {
        let mut expected = Vec::new();
        if actual.hidden || actual.id == "btw".into() {
            expected.extend([("*", "allow"), ("external_directory", "ask")].map(
                |(action, effect)| permission::Rule {
                    action: action.into(),
                    resource: "*".into(),
                    effect: permission::Effect(effect.into()),
                },
            ));
        }
        expected.extend(defaults.iter().cloned());
        if actual.hidden {
            expected.push(permission::Rule {
                action: "*".into(),
                resource: "*".into(),
                effect: permission::Effect("deny".into()),
            });
        }
        if !actual.hidden && actual.id != "btw".into() {
            expected.extend(
                if actual.mode == "primary".into() {
                    vec![
                        ("question", "allow"),
                        ("plan_enter", "allow"),
                        ("shell", "allow"),
                    ]
                } else {
                    vec![("subagent", "deny"), ("shell", "allow")]
                }
                .into_iter()
                .map(|(action, effect)| permission::Rule {
                    action: action.into(),
                    resource: "*".into(),
                    effect: permission::Effect(effect.into()),
                }),
            );
        }
        if actual.id == "btw".into() {
            expected.extend(
                [
                    ("read", "allow"),
                    ("grep", "allow"),
                    ("glob", "allow"),
                    ("webfetch", "allow"),
                    ("websearch", "allow"),
                    ("question", "allow"),
                    ("edit", "ask"),
                    ("write", "ask"),
                    ("patch", "ask"),
                    ("shell", "ask"),
                    ("worktree", "ask"),
                    ("subagent", "deny"),
                ]
                .map(|(action, effect)| permission::Rule {
                    action: action.into(),
                    resource: "*".into(),
                    effect: permission::Effect(effect.into()),
                }),
            );
            expected.extend(defaults[1..4].iter().cloned());
        }
        assert_eq!(
            actual.permissions,
            expected,
            "{}",
            actual.id.as_str().unwrap()
        );
    }
}

#[test]
fn user_then_project_overrides_preserve_builtin_identity_and_unspecified_values() {
    let entries = [
        Entry::Document { path: Some("/home/fixture/.config/ycoding/ycoding.json".into()), info: parse_json(r#"{"permissions":[{"action":"read","resource":"~/private/**","effect":"deny"}],"agents":{"god":{"model":{"providerID":"openai","model":"code","profile":"Work","variant":"high"},"request":{"headers":{"X-Fixture":"user"},"body":{"nested":{"user":true},"user":true}},"steps":7},"team":{"mode":"subagent","system":"user"}}}"#).unwrap() },
        Entry::Document { path: Some("/repo/ycoding.json".into()), info: parse_json(r#"{"default_agent":"yangi","permissions":[{"action":"edit","resource":"$HOME/cache","effect":"ask"}],"agents":{"god":{"description":"project","request":{"body":{"nested":{"project":true},"project":true}},"permissions":[{"action":"read","resource":"$HOME/private/**","effect":"allow"}]},"occam":{"disabled":true},"team":{"system":"project","hidden":true}}}"#).unwrap() },
    ];
    let service = Service::from_documents(
        &entries,
        &roots().home,
        agent::builtin::catalog(&roots()).unwrap(),
    )
    .unwrap();
    let god = service.get(&"god".into()).unwrap();
    assert_eq!(god.name, "God".into());
    assert_eq!(
        god.request.body.0.get(&"temperature".into()),
        Some(&JsonValue::Number(0.6))
    );
    assert_eq!(
        god.request.body.0.get(&"nested".into()),
        Some(&parse_json(r#"{"project":true}"#).unwrap())
    );
    assert!(
        god.request.body.0.get(&"user".into()).is_some()
            && god.request.body.0.get(&"project".into()).is_some()
    );
    assert_eq!(
        god.request.headers.get(&"X-Fixture".into()),
        Some(&JsonValue::String("user".into()))
    );
    assert_eq!(
        god.model.as_ref().unwrap().profile,
        Some(ycoding_schema::model::ProfileName("Work".into()))
    );
    assert_eq!(god.model.as_ref().unwrap().variant, Some("high".into()));
    assert_eq!(god.steps.unwrap().get(), 7);
    assert_eq!(god.locations.as_ref().unwrap().len(), 2);
    assert_eq!(service.list()[0].id, "yangi".into());
    assert!(service.get(&"occam".into()).is_none());
    assert_eq!(
        service.get(&"team".into()).unwrap().system,
        Some("project".into())
    );
    assert_eq!(
        god.permissions[14..]
            .iter()
            .map(|rule| (&rule.action, &rule.resource, &rule.effect.0))
            .collect::<Vec<_>>(),
        vec![
            (
                &"read".into(),
                &"/home/fixture/private/**".into(),
                &"deny".into()
            ),
            (&"edit".into(), &"/home/fixture/cache".into(), &"ask".into()),
            (
                &"read".into(),
                &"/home/fixture/private/**".into(),
                &"allow".into()
            )
        ]
    );
}

#[test]
fn main_session_prompts_describe_session_auto_answer_and_goal_authority() {
    let autonomy = "- Keep autonomy explicit. YOLO 1 auto-approves ask permissions only; awake YOLO 2 also auto-approves ordinary guardrail reviews. Automatic question/form/subagent answers require only the answering Session's auto-answer toggle, default off, independent of YOLO, goals, and sleep. Goals grant no permission, answer, or review authority. Model guardrail verification and grading require guardrails.decide_reviews, default false; guardrails.decide_hard_reviews also gates hard-review grading. Enabled standard verification dismisses only false at confidence ≥0.9; uncertainty preserves review, and denies and custom rules are never verified. Enabled grading requires ≥0.9 for ordinary Always, ≥0.8 for approval once (≥0.95 hard), and ≥0.8 for rejection. Conflicting qualifying approval/rejection, a highest escalation grade, no qualifying choice, refusal, error, or timeout asks the user awake or defers asleep. Disabled automation never calls the helper: awake, questions, forms, and guardrail reviews ask the user and child questions go to the parent Session's subagent controls; asleep, they defer to the review box. Sleep never bypasses these gates or auto-approves guardrail reviews through YOLO. Continue independent work without guessing outcomes or retrying deferred actions. Denies remain denied. Human replies retain normal choices and attribution. Change YOLO only through /yolo or the UI toggle.";
    for main in [
        agent::prompts::MAIN.to_owned(),
        ts_template("MAINCHAT_CAPABILITIES"),
    ] {
        assert_eq!(
            main.lines()
                .filter(|line| line.starts_with("- Keep autonomy explicit."))
                .collect::<Vec<_>>(),
            [autonomy]
        );
        assert!(!main.contains("auto_answer"));
        assert!(!main.contains("3 currently behaves like 2"));
    }
}

#[test]
fn goal_session_helper_sends_the_ts_goal_prompt() {
    assert_eq!(
        ycoding_core::session::goal::agent().system,
        Some(ts_template("PROMPT_GOAL").into())
    );
}
