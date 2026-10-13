use std::{collections::BTreeMap, path::Path};
use ycoding_core::resources::{
    agent::{self, Service},
    config::{Entry, Roots},
    discovery::markdown,
};
use ycoding_schema::{DomainEncode, JsonValue, parse_json, permission};

const CHECKPOINT: &str = "Before building, design comprehensive test cases from the accepted requirements and contracts, and reproduce a reported failure at its boundary. Build the complete working feature or milestone together with those tests; do not alternate test and code for each small step, and add no mutation probes unless requested. At each feature checkpoint, run the focused tests once, fix failures, and rerun only the failing scope; run full suites and every affected required check at the integration or merge checkpoint.";
const BUILD_LANES: &str = " When build or test capacity is the bottleneck, run code-writing lanes on disjoint files that only compile-check and run one feature-level test pass, then merge them through one dedicated integration lane that resolves conflicts and runs the full checks.";
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
fn all_builtin_fields_and_full_prompts_equal_main_ts_fixtures() {
    let service = Service::new(agent::builtin::catalog(&roots()).unwrap());
    let project = ts_template("YCODING_PROJECT_PROMPT");
    let project = if project.contains(CHECKPOINT) {
        project
    } else {
        project.replace(
            "Never make atomic commits.",
            &format!("{CHECKPOINT}\n\nNever make atomic commits."),
        )
    };
    let main = ts_template("MAINCHAT_CAPABILITIES");
    let main = if main.contains(BUILD_LANES) {
        main
    } else {
        main.replace(
            "at a time across all agents on the machine.",
            &format!("at a time across all agents on the machine.{BUILD_LANES}"),
        )
    };
    let notice = "Subagents always run in the background, and a shell may also run in the background. Both notify you when they finish. Do not poll them or wait idle for them. While either is running, continue every remaining task that is still your responsibility and does not depend on that result.";
    let child = ts_template("SUBAGENT_CAPABILITIES");
    let fixtures = [
        (
            "GSD",
            "GSD",
            "primary",
            0.6,
            "#e67e22",
            include_str!("../../../../packages/core/src/plugin/agent/GSD.md"),
            "5db617aa23c9aa1c3fb516dfc89e4bb52151df3c3b4eb669351f34e62e3f49ff",
        ),
        (
            "architech",
            "Architech",
            "primary",
            0.5,
            "#3498db",
            include_str!("../../../../packages/core/src/plugin/agent/architech.md"),
            "96d694bf20e9fd36ac157db32f18d9aa35b63ece8a3926314f8376c32165e6cf",
        ),
        (
            "god",
            "God",
            "primary",
            0.6,
            "#f1c40f",
            include_str!("../../../../packages/core/src/plugin/agent/god.md"),
            "97374856fef2a26673603e744a9cf70a41a10d568c85ea3b8672d30f5ce0c2c9",
        ),
        (
            "yangi",
            "Yangi",
            "primary",
            0.5,
            "#2ecc71",
            include_str!("../../../../packages/core/src/plugin/agent/yangi.md"),
            "e9226d01c6aa303790b2ba2dd567d8776f7cfab66f6d838d193632e43ba9661b",
        ),
        (
            "occam",
            "Occam",
            "subagent",
            0.4,
            "#2ecc71",
            include_str!("../../../../packages/core/src/plugin/agent/occam.md"),
            "4aafb0d014eb8b6b1637f76853c6404b41fa5545f579fd9cb53274e122d52271",
        ),
        (
            "omoikane",
            "Omoikane",
            "subagent",
            0.5,
            "#3498db",
            include_str!("../../../../packages/core/src/plugin/agent/omoikane.md"),
            "9eb5c76bd1d43e8d678bb083caccff4493081cfc3dadb491390387caedb5e686",
        ),
        (
            "wittgenstein",
            "Wittgenstein",
            "subagent",
            0.4,
            "#95a5a6",
            include_str!("../../../../packages/core/src/plugin/agent/wittgenstein.md"),
            "14b2270c868057a0eda222fa5ba3221cb43b9452a3c392f459ae5ba4f40b4c77",
        ),
        (
            "zeus",
            "Zeus",
            "subagent",
            0.6,
            "#f1c40f",
            include_str!("../../../../packages/core/src/plugin/agent/zeus.md"),
            "99e147bbf42e370cd624ea238498d8c41146234583160442cb6a615508dac60c",
        ),
    ];
    for (id, name, mode, temperature, color, source, digest) in fixtures {
        let source = source.replace("- Use TDD for changed behavior: prove RED at the relevant boundary, fix, then prove GREEN. Add distinct required cases, not tests for their own sake.\n- Run focused tests and required affected checks. Run the full suite only when an affected required check demands it. Reuse settled results; do not weaken a check to make it pass.", "- Add distinct required test cases, not tests for their own sake. Reuse settled results; do not weaken a check to make it pass.");
        let expected = markdown::parse(&source).unwrap();
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
            "733da9822f3c5c665f202af9a441d6d286764726744215dadae6ad45491c0c6c",
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
            "29bedcd10bffa22714a95119c50e433f5f253b9fa9f37297ecc42e95529638f9",
        ),
        (
            "summary",
            "Summary",
            "0d10c2647ab3eb40aedd87b2a277a961f1e2e2bc58b5290c5cd2d5eefbddb28a",
        ),
    ] {
        let expected = ts_template(&format!("PROMPT_{}", id.to_uppercase()));
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
