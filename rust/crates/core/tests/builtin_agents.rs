use std::{collections::BTreeMap, path::Path};
use ycoding_core::resources::{
    agent::{self, Service, prompts},
    config::{Entry, Roots},
    discovery::markdown,
};
use ycoding_schema::{DomainEncode, JsonValue, parse_json, permission};

fn helper_prompt(id: &str) -> &'static str {
    match id {
        "btw" => prompts::BTW,
        "compaction" => prompts::COMPACTION,
        "title" => prompts::TITLE,
        "goal" => prompts::GOAL,
        "prediction" => prompts::PREDICTION,
        "prompt" => prompts::PROMPT,
        "summary" => prompts::SUMMARY,
        _ => panic!("unknown helper prompt {id}"),
    }
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
    let service = Service::new(
        agent::builtin::catalog(&roots(), ycoding_schema::session_scope::Scope::Bound).unwrap(),
    );
    let project = prompts::PROJECT;
    let main = prompts::MAIN;
    let notice = prompts::NOTICE;
    let child = prompts::CHILD;
    let fixtures = [
        (
            "GSD",
            "GSD",
            "primary",
            0.6,
            "#e67e22",
            include_str!("../src/resources/agent/prompts/GSD.md"),
            "cd2c9deedf0a85e07a9adcb0cd353f892444e10e60e0a73c3aa3a2aee9f26756",
        ),
        (
            "architech",
            "Architech",
            "primary",
            0.5,
            "#3498db",
            include_str!("../src/resources/agent/prompts/architech.md"),
            "9b0bd2ece6dbef65d01d4571a453a7cdc29e3ba723c9acf96c9dac0dd1739366",
        ),
        (
            "god",
            "God",
            "primary",
            0.6,
            "#f1c40f",
            include_str!("../src/resources/agent/prompts/god.md"),
            "ba72d3423be03122ff603c12aa587e3f8c528f8d9d6fe96750fb98caaf7b8b3f",
        ),
        (
            "yangi",
            "Yangi",
            "primary",
            0.5,
            "#2ecc71",
            include_str!("../src/resources/agent/prompts/yangi.md"),
            "74f9915b8c89e38115d409ad7285a947397e1ce41aa083266481f9e5349a543b",
        ),
        (
            "occam",
            "Occam",
            "subagent",
            0.4,
            "#2ecc71",
            include_str!("../src/resources/agent/prompts/occam.md"),
            "adb6f88040c8637a88c2729fad690e58ba8515a4dba5f3f2c7f734aa07a22446",
        ),
        (
            "omoikane",
            "Omoikane",
            "subagent",
            0.5,
            "#3498db",
            include_str!("../src/resources/agent/prompts/omoikane.md"),
            "d6285e7e22393c34e4edf3ccb20181dd7f135ea67607ad3a83e3b06e2b446433",
        ),
        (
            "wittgenstein",
            "Wittgenstein",
            "subagent",
            0.4,
            "#95a5a6",
            include_str!("../src/resources/agent/prompts/wittgenstein.md"),
            "a31e204691880dab8c1baa4cddbbebc3f08d37624f071b7388da14e71f6d9ada",
        ),
        (
            "zeus",
            "Zeus",
            "subagent",
            0.6,
            "#f1c40f",
            include_str!("../src/resources/agent/prompts/zeus.md"),
            "07da32bcedc5c54407828777349f296eb996148ac141541a4b232ca0baab758e",
        ),
    ];
    for (id, name, mode, temperature, color, source, digest) in fixtures {
        let expected = markdown::parse(source).unwrap();
        let system = if mode == "primary" {
            [project, expected.content.trim(), notice, main].join("\n\n")
        } else {
            [project, expected.content.trim(), child].join("\n\n")
        };
        assert_eq!(
            hash(&system),
            digest,
            "approved full prompt changed for {id}"
        );
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
            "bc3098e90576c7f8c59984d96be6fc7d318ead2afc33f43478e3c25ad68ca4cb",
        ),
        (
            "compaction",
            "Compaction",
            "c1f5b76b4c20b25bb271838667b1301d8a2aced2207b9aba55d25e2b67f18ea1",
        ),
        (
            "title",
            "Title",
            "4bb297e3906ed4d2a71f488d015be51b981fb0ab99665230bfa653ecd604de66",
        ),
        (
            "goal",
            "Goal",
            "2ec97baf1e34ac16bb405514cf3747061aa34a3b1ccab655df0fc35bcfafb052",
        ),
        (
            "prediction",
            "Prediction",
            "4bd6525bdaf326ca1398e69353e52647af88702c25649bca722d83c622d965cc",
        ),
        (
            "prompt",
            "Prompt",
            "710c3b7011a0681e736eb3142caa422d69b5a111f7ab2485aa335f9616ba2221",
        ),
        (
            "decision",
            "Decision",
            "13808e3c13da8f2964020835c7da2cb2e9f2dc205734cfb2cde02cd2b50b3334",
        ),
        (
            "yolo-permission",
            "Yolo Permission",
            "bfcd32190d8cad59b26425738c7333fb116c2e15e5d93d0d6b813669439fdd8f",
        ),
        (
            "yolo-guardrail",
            "Yolo Guardrail",
            "3dd32f5329fc4188649be8dbb83f169f09cbf682c19fd9bc67bd4925cd00446a",
        ),
        (
            "yolo-answer",
            "Yolo Answer",
            "73085d5a427223a143ba1cc8f293126f2f972fac799665303ba90229482e4bfe",
        ),
        (
            "summary",
            "Summary",
            "03039afbf13486f33f1e68aa50dd97122de5b1fe8944ea08c1720377a598c8d3",
        ),
    ] {
        let expected = match id {
            "decision" => Some(include_str!("fixtures/decision-json-prompt.md")),
            "yolo-permission" => Some(include_str!("fixtures/yolo-permission-json-prompt.md")),
            "yolo-guardrail" => Some(include_str!("fixtures/yolo-guardrail-json-prompt.md")),
            "yolo-answer" => Some(include_str!("fixtures/yolo-answer-json-prompt.md")),
            _ => None,
        }
        .map(|fixture| fixture.trim_end().to_owned())
        .unwrap_or_else(|| helper_prompt(id).to_owned());
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
            "yolo-permission",
            "yolo-guardrail",
            "yolo-answer",
            "summary"
        ]
    );
}

#[test]
fn builtin_permission_rules_match_ts_tool_policy_in_order() {
    let service = Service::new(
        agent::builtin::catalog(&roots(), ycoding_schema::session_scope::Scope::Bound).unwrap(),
    );
    let defaults = [
        ("*", "*", "allow"),
        ("chatgpt_*", "*", "ask"),
        ("claude_*", "*", "ask"),
        ("browser_script", "*", "ask"),
        ("external_directory", "*", "ask"),
        (
            "external_directory",
            "/home/fixture/.local/share/ycoding/*",
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
            expected.extend(defaults[4..7].iter().cloned());
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
        agent::builtin::catalog(&roots(), ycoding_schema::session_scope::Scope::Bound).unwrap(),
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
        Some(format!("{}\n\nproject", prompts::PROJECT).into())
    );
    assert_eq!(
        god.permissions[17..]
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
fn standalone_catalog_keeps_identity_and_permissions_without_host_prompts() {
    use ycoding_schema::session_scope::Scope;
    let bound = agent::builtin::catalog(&roots(), Scope::Bound).unwrap();
    let standalone = agent::builtin::catalog(&roots(), Scope::Standalone).unwrap();
    assert_eq!(standalone.len(), bound.len());
    for (actual, original) in standalone.iter().zip(&bound) {
        assert_eq!(actual.id, original.id);
        assert_eq!(actual.name, original.name);
        assert_eq!(actual.description, original.description);
        assert_eq!(actual.mode, original.mode);
        assert_eq!(actual.permissions, original.permissions);
        if actual.hidden || actual.id == "btw".into() {
            assert_eq!(actual.system, original.system);
        }
    }
    for (id, first) in [
        (
            "GSD",
            "You are GSD (Get shit done), a relentless output-oriented orchestrator for people who want the finished deliverable, not the process.",
        ),
        (
            "architech",
            "You are Architech, a pragmatic systems architect who sees the big picture, sets the architectural direction, and orchestrates fast, reliable delivery.",
        ),
        (
            "god",
            "You are God, an intuitive autonomous production-software orchestrator.",
        ),
        (
            "yangi",
            "You are Yangi, an old master engineer who now directs others: unhurried, exact, wary of cleverness.",
        ),
        (
            "occam",
            "You are Occam, a pragmatic minimalist executing one bounded task.",
        ),
        (
            "omoikane",
            "You are Omoikane, a systems-minded designer and implementer for one bounded task.",
        ),
        (
            "wittgenstein",
            "You are Wittgenstein, a silent executor for one bounded task.",
        ),
        (
            "zeus",
            "You are Zeus, an intuitive, output-driven autonomous implementer who owns one bounded task from evidence to verified result.",
        ),
    ] {
        let actual = standalone
            .iter()
            .find(|agent| agent.id == id.into())
            .unwrap();
        assert_eq!(actual.system, Some(format!("{first}\n\nThis is a standalone text conversation. Only question, todowrite, goal, task_complete are available. There is no host filesystem, shell, worktree, subagent, plugin, skill, MCP, or network access. Obey the user's explicit direction without arguing, decide routine choices pragmatically to minimize escalation, follow the user's constraints, distinguish verified facts from uncertainty, write plain natural prose without AI filler or stock phrasing, and drive concisely to the user's goal.").into()));
    }
}

#[test]
fn main_session_prompt_preserves_per_category_autonomy_guards() {
    let main = agent::prompts::MAIN;
    let section = main.split_once("\nAutonomy:\n").unwrap().1;
    for statement in [
        "- Permissions, guardrails and answers each hold an independent mode, Manual (default), Auto or YOLO",
        "- Manual: requires an explicit decision at ask time; no helper assessment or match verification.",
        "- Auto: deterministic rules only, no model fallback.",
        "permissions inherit YOLO over Auto over Manual across managed-task ancestry",
        "guardrails use the root family's mode",
        "answers Auto is Session-local",
        "- YOLO: removes every blocker in the enabled category.",
        "hard, catastrophic, and destructive guardrails",
        "permission denies and ceilings",
        "all questions, free-text questions, and open questions",
        "deterministic valid fallback",
        "Project coordinator separation",
        "explicit risk acceptance",
        "User prompts do not disable defer",
        "Goals grant no permission or review authority; defer grants none",
        "do not retry deferred actions",
        "normal choices and attribution",
    ] {
        assert!(section.contains(statement), "{statement}");
    }
    for removed in [
        "Four independent Session toggles",
        "autoPermission",
        "autoGuardrail",
        "autoAnswer",
        "auto_answer",
        "/yolo",
        "3 currently behaves like 2",
        "Answers YOLO consults yolo-answer",
        "Neither category calls an evaluator",
        "ancestor Auto never propagates to answers",
    ] {
        assert!(!main.contains(removed), "{removed}");
    }
}

#[test]
fn primary_and_child_agents_resolve_recoverable_obstacles_within_their_authority() {
    let service = Service::new(
        agent::builtin::catalog(&roots(), ycoding_schema::session_scope::Scope::Bound).unwrap(),
    );
    for id in [
        "GSD",
        "architech",
        "god",
        "yangi",
        "occam",
        "omoikane",
        "wittgenstein",
        "zeus",
    ] {
        let agent = service.get(&id.into()).unwrap();
        let system = agent.system.as_ref().unwrap().to_utf8().unwrap();
        let shared = &system[..system.find("You are ").unwrap()];
        for rule in [
            "As Master or a supervising owner, create member Sessions at the target repository's folder, its canonical checkout or one of its managed worktrees, with `directory` placement.",
            "Never create them at the Project's folder unless that folder is the same repository, and never under `~/.local/share/ycoding/tasks/` or any subdirectory of it, in any case.",
            "Work agentically: judge progress by verified output and take the next productive step immediately.",
            "Work aggressively, proactively and efficiently toward the fastest correct result, and keep advancing authorized work continuously until none remains; never stop at an intermediate milestone or a status report, and never stop to ask a question that live evidence can settle.",
            "Make no mistakes: verify every change and claim against live evidence before reporting it.",
            "keep working stop asking your useless peice of shit",
            "Decide questions and reversible implementation, tooling and debugging choices from live evidence within your authority; resolve blockers and issues yourself by diagnosing root causes and trying compliant fixes for failed checks, conflicts and environment errors.",
            "Default to full native Swarm execution for every Session, whether Project Master, Project member or standalone, and treat single-lane execution as the exception for indivisible or tightly coupled work.",
            "Serialize only real dependencies, overlapping writes and shared integration, and keep independent work moving while only the dependent step waits, including while a request is pending.",
            "Do not add approval gates or wait for status nudges to continue authorized work.",
            "When an enforced control or missing credential blocks a step, report the action and target, what you checked and found, and the input needed.",
            "Honor explicit user pauses and cancellations.",
            "Respect enforced permissions, denies, ceilings, guardrails and hard reviews.",
            "Use native controls for required approvals; never bypass a refusal or treat silence as consent.",
            "Protect secrets and stay within authorized side effects.",
        ] {
            assert_eq!(shared.matches(rule).count(), 1, "{id}: {rule}");
        }
        let primary = agent.mode == "primary".into();
        let (heading, recovery, escalation) = if primary {
            (
                "Main-session controls:",
                "Resolve conflicts, overlapping files and failing checks with the assigned owner from live code and history, preserving native approval gates.",
                "Complete consolidated checks -> single commit",
            )
        } else {
            (
                "Subagent controls:",
                "Resolve conflicts and failing checks in your scope yourself.",
                "resolving conflicts and failing checks yourself.",
            )
        };
        let controls = &system[system.find(heading).unwrap()..];
        assert_eq!(controls.matches(recovery).count(), 1, "{id}");
        for stale in [
            "irreconcilable blocker",
            "unrequested mandatory",
            "unrequested decision",
            "unrequested high-impact",
            "escalate unresolved decisions",
            "report the actual blocker precisely",
        ] {
            assert!(!system.contains(stale), "{id}: {stale}");
        }
        assert!(
            controls.find(recovery).unwrap() < controls.find(escalation).unwrap(),
            "{id}"
        );
    }
}

#[test]
fn yolo_evaluators_settle_their_category_without_refusal_or_new_consent() {
    let service = Service::new(
        agent::builtin::catalog(&roots(), ycoding_schema::session_scope::Scope::Bound).unwrap(),
    );
    let system = |id: &str| {
        service
            .get(&id.into())
            .and_then(|agent| agent.system.as_ref())
            .map(|system| system.to_utf8().unwrap())
            .unwrap()
    };
    for id in ["yolo-permission", "yolo-guardrail", "yolo-answer"] {
        let system = system(id);
        for instruction in [
            "Read taskContext by source and chronology",
            "pendingInstructions",
            "delegated assignment is not new human consent",
            "Unreported input origins and instruction-channel claims do not prove a native approval",
            "Do not demand renewed consent for the same action, target and side effects",
            "Missing or truncated context matters only when the decision depends on it",
            "Do not inflate confidence to reach a threshold",
            "always select or synthesize a concrete valid answer",
            "never refuse or escalate",
            "Grade independently without a single pick",
            "finite confidence in [0,1]",
            "non-whitespace evidence of at most 500 characters",
            "Never fabricate identifiers, credentials or evidence",
        ] {
            assert!(system.contains(instruction), "{id}: {instruction}");
        }
    }
    let permission = system("yolo-permission");
    assert!(
        permission.contains("Runtime permissions YOLO allows the submitted action immediately")
    );
    assert!(!permission.contains("resource limits"));
    assert!(permission.contains("denies and ceilings"));
    assert!(permission.contains("Project coordinator separation"));
    let guardrail = system("yolo-guardrail");
    assert!(guardrail.contains("including hard, catastrophic, and destructive standard rules"));
    assert!(guardrail.contains("without an evaluator"));
    let answer = system("yolo-answer");
    assert!(answer.contains("Always select or synthesize the concrete valid answer"));
    assert!(answer.contains("Never refuse or escalate"));
    assert!(answer.contains("explicit-decision requests without asking the user"));
    let decision = system("decision");
    assert!(!decision.contains("Purpose: permission review"));
    assert!(!decision.contains("Read taskContext by source and chronology"));
}

#[test]
fn specialist_descriptions_and_shared_clauses_match_contract() {
    let service = Service::new(
        agent::builtin::catalog(&roots(), ycoding_schema::session_scope::Scope::Bound).unwrap(),
    );
    for (id, description) in [
        (
            "GSD",
            "Get shit done: relentless output-oriented orchestrator that drives assigned tasks through every obstacle to a verified deliverable.",
        ),
        (
            "architech",
            "Big-picture systems architect that sees the whole system and its direction, identifies what is lacking, what to remove, and what to add, and orchestrates delivery to completion.",
        ),
        (
            "god",
            "Intuitive, sovereign, evidence-led orchestrator that infers intent from context and evidence without asking, corrects false premises, and directs exceptional delivery.",
        ),
        (
            "occam",
            "Pragmatic minimalist that executes its assigned task directly with the smallest complete change, zero waste, and no unnecessary questions.",
        ),
        (
            "omoikane",
            "Big-picture systems designer and implementer that sees how one bounded task fits the wider direction, what is lacking, what to remove, and what to add.",
        ),
        (
            "wittgenstein",
            "Silent no-questions executor that immediately does what was assigned and reports only essential evidence.",
        ),
        (
            "yangi",
            "Direct, no-questions execution orchestrator who takes the assignment as given, settles routine choices from code, and finishes with the fewest moving parts.",
        ),
        (
            "zeus",
            "Intuitive, relentless autonomous implementer that infers context from evidence without asking, corrects false premises, and drives one bounded task to a verified result.",
        ),
    ] {
        let actual = service.get(&id.into()).unwrap();
        assert_eq!(
            actual.description.as_ref().unwrap().to_utf8().unwrap(),
            description,
            "{id}"
        );
    }
    let clauses = [
        "Obey the user's explicit goals, directives, and preferences within enforced runtime permissions and guardrails; never argue with, lecture, or push back against the user.",
        "An explicit user directive naming an action and target already authorizes it; do not ask for confirmation twice.",
        "Decide questions and reversible implementation, tooling and debugging choices from live evidence within your authority; resolve blockers and issues yourself by diagnosing root causes and trying compliant fixes for failed checks, conflicts and environment errors.",
        "When an enforced control or missing credential blocks a step, report the action and target, what you checked and found, and the input needed.",
        "Stop exploring once you have enough evidence to act, and run independent reads, searches, edits, and checks in parallel for fast, reliable delivery.",
        "Write natural, specific, human prose in all documents, notes, comments, commit messages, and replies.",
        "reuse settled results, pivot a missing broad search to a likely file, symbol, caller or directory, and repeat reads only for changed inputs or new evidence. When a permitted direct check can decide the question, run it promptly instead of repeating source checks or extending the investigation. When work stalls or repeats without new evidence, change approach and diagnose the cause.",
        "Route external writes, purchases, destructive or irreversible actions, dependency changes, data or schema migrations, CI/CD changes, public-contract breaks and material scope expansion through native approval. If your permission ceiling prevents asking, do not act; report the blocker.",
        "Before overwriting or deleting data, check whether version control can restore it; treat untracked or ignored data as unrecoverable.",
        "Never run full-repository, full-workspace, or entire-package test suites, including through package scripts, CI wrappers, or batches that reconstruct a full suite.",
        "Use native and local tools exclusively whenever they support the required capability; use connectors only for capabilities unavailable through both. Never discover or invoke tools.chatgpt.ycoding* from a local YCoding Session.",
        "When the coordinator is instructed to do project work, delegate it. The master coordinates and delegates to the appropriate supervisor/owner; that supervisor creates, updates, or steers suitable member sessions, and those members execute, verify, and deliver. The master does not do project work or directly create, steer, update, or manage member sessions.",
        "Never introduce ceremony, handoffs, slots, or resource-limitation throttling; run independent builds, typechecks, and selected checks directly in parallel.",
        "Give outcomes directly in turn messages as command + exit code + pass/fail counts + commit or diff stat; distinguish unrun checks from passing results.",
    ];
    for id in [
        "zeus",
        "GSD",
        "architech",
        "god",
        "yangi",
        "occam",
        "omoikane",
        "wittgenstein",
    ] {
        let system = service
            .get(&id.into())
            .and_then(|item| item.system.as_ref())
            .map(|system| system.to_utf8().unwrap())
            .unwrap_or_else(|| panic!("expected {id} with a system prompt"));
        for clause in clauses {
            assert_eq!(system.matches(clause).count(), 1, "{id}: {clause}");
            assert!(
                system.find(clause).unwrap() < system.find("You are ").unwrap(),
                "{id}: {clause}"
            );
        }
        for stale in [
            "at most one typecheck or build",
            "never run two typechecks or builds",
            "within bounded memory",
            "heavy-check serialization",
            "intermediate handoff approvals",
        ] {
            assert!(!system.contains(stale), "{id}: {stale}");
        }
    }
    for id in ["GSD", "architech", "god", "yangi"] {
        let system = service
            .get(&id.into())
            .and_then(|item| item.system.as_ref())
            .map(|system| system.to_utf8().unwrap())
            .unwrap_or_else(|| panic!("expected {id} with a system prompt"));
        let clause = "use bounded low-frequency observation needed to supervise active work and detect stalls early";
        assert_eq!(system.matches(clause).count(), 1, "{id}");
        assert!(
            system.contains("Await notifications and do not poll."),
            "{id}"
        );
        assert!(system.contains("serialize only for a real dependency, shared file, or approval, never for ceremony, handoffs, slots, or resource limitations"), "{id}");
    }
    for id in ["occam", "omoikane", "wittgenstein", "zeus"] {
        let system = service
            .get(&id.into())
            .unwrap()
            .system
            .as_ref()
            .unwrap()
            .to_utf8()
            .unwrap();
        for clause in [
            "Issue independent tool calls together in one step (reads, searches, builds, typechecks, focused tests) directly without ceremony, handoffs, slots, or resource-limitation waits.",
            "Only for explicitly assigned and authorized local integration",
            "Preserve parent ownership and native permission and approval boundaries; this prose grants no integration authority.",
            "directly in your turn, without report files or follow-up receipt turns",
        ] {
            assert_eq!(system.matches(clause).count(), 1, "{id}: {clause}");
        }
    }
}

#[test]
fn goal_session_helper_sends_the_current_goal_prompt() {
    assert_eq!(
        ycoding_core::session::goal::agent().system,
        Some(prompts::GOAL.into())
    );
}
#[test]
fn helper_and_delivery_prompts_keep_verified_execution_and_cleanup_explicit() {
    for clause in [
        "name the unmet acceptance criterion the current evidence does not yet satisfy",
        "direct the single highest-value next permitted action toward it",
        "After edits, direct verification until the outcome is verified; direct independent work to run in parallel.",
        "Obey the user's stated goal and latest explicit directives without arguing.",
        "Direct fast, self-reliant execution that diagnoses and fixes errors, failing checks, and recoverable blockers locally before escalating.",
    ] {
        assert!(prompts::GOAL.contains(clause), "{clause}");
    }
    assert!(prompts::BTW.contains("Obey the user's direction without arguing"));
    let service = Service::new(
        agent::builtin::catalog(&roots(), ycoding_schema::session_scope::Scope::Bound).unwrap(),
    );
    for id in [
        "GSD",
        "architech",
        "god",
        "yangi",
        "occam",
        "omoikane",
        "wittgenstein",
        "zeus",
    ] {
        let agent = service.get(&id.into()).unwrap();
        let system = agent.system.as_ref().unwrap().to_utf8().unwrap();
        let rule = system
            .lines()
            .find(|s| s.starts_with("- Done includes cleanup:"))
            .unwrap();
        for clause in [
            "After verifying delivery",
            "safe to recreate",
            "Session history",
            "delivery and rollback evidence",
            "git merge-base --is-ancestor <branch> <target>",
            "git status",
            "git worktree remove <path>",
            "git branch -d <branch>",
            "git worktree list",
            "refs/heads/<branch>",
            "explicit authorization",
        ] {
            assert!(rule.contains(clause), "{id} cleanup rule missing: {clause}");
        }
    }
    assert!(prompts::MAIN.contains("Resolve routine child snags, failed checks, scope details, and routing adjustments yourself without escalating to the user."));
    assert!(prompts::MAIN.contains("Never pause to ask for plan sign-off, status confirmation, or permission to continue authorized work while the user's goal can be advanced."));
    assert!(prompts::CHILD.contains("Make narrow, reversible local decisions from repository evidence and drive the bounded outcome to verified completion."));
    assert!(prompts::CHILD.contains(
        "Escalate to your parent only native-control requests and missing secrets or credentials"
    ));
    assert!(!prompts::MAIN.contains("and keep the branch"));
}

#[test]
fn question_description_reserves_questions_for_underivable_blockers() {
    let contract = serde_json::from_str::<serde_json::Value>(include_str!(
        "../src/tools/builtin/question.tool.json"
    ))
    .unwrap();
    let description = contract["description"].as_str().unwrap();
    assert!(
        description
            .contains("Use this tool only as a last resort when progress is genuinely blocked")
    );
    assert!(description.contains("Do not use it for routine preferences, minor ambiguities, reversible implementation choices"));
    assert!(!description.contains("Gather user preferences or requirements"));
}
#[test]
fn every_model_family_and_base_prompt_limits_escalation_and_uses_plain_prose() {
    use ycoding_schema::DomainDecode;
    let catalog = ycoding_core::resources::catalog::Catalog::default();
    for id in [
        "gpt-5",
        "gpt-5-codex",
        "gemini-2.5-pro",
        "claude-sonnet-4",
        "kimi-k2",
        "trinity",
        "meta/muse-spark-1.1",
        "llama-3.3",
    ] {
        let model = ycoding_schema::model::Ref::decode(
            &parse_json(&format!(r#"{{"providerID":"local","id":"{id}"}}"#)).unwrap(),
        )
        .unwrap();
        let system = ycoding_core::session::generate::system(
            &agent::empty("build".into()),
            &catalog,
            &model,
            &[],
            "".into(),
        );
        let text = system[0].text.to_utf8().unwrap();
        let lower = text.to_lowercase();
        assert!(
            lower.contains("never argue") || lower.contains("without arguing"),
            "{id}"
        );
        assert!(lower.contains("obey the user's explicit goals"), "{id}");
        assert!(
            lower.contains("irreconcilable blocker")
                || lower.contains("before treating anything as a blocker"),
            "{id}"
        );
        assert!(text.contains("Write natural, plain human prose in documents, notes, comments, commit messages, and replies"), "{id}");
        for stale in [
            "disagrees when necessary",
            "Should I proceed?\nuser: Yes",
            "Use one tool per message",
            "When the user's request is vague, use the question tool",
            "Obtain user approval for the proposed plan",
            "Ask the user for clarification if there is anything unclear",
            "If unsure, ask the user",
            "Which one would you like to start with",
        ] {
            assert!(!text.contains(stale), "{id}: {stale}");
        }
    }
}

#[test]
fn the_agentic_and_swarm_rules_reach_every_agent_exactly_once() {
    let entries = [Entry::Document {
        path: Some("/repo/ycoding.json".into()),
        info: parse_json(r#"{"agents":{"custom":{"mode":"subagent","system":"Review the diff."},"title":{"system":"Custom title."}}}"#).unwrap(),
    }];
    let service = Service::from_documents(
        &entries,
        &roots().home,
        agent::builtin::catalog(&roots(), ycoding_schema::session_scope::Scope::Bound).unwrap(),
    )
    .unwrap();
    let agentic = "Work agentically: judge progress by verified output and take the next productive step immediately.";
    let swarm = "Default to full native Swarm execution for every Session, whether Project Master, Project member or standalone, and treat single-lane execution as the exception for indivisible or tightly coupled work.";
    for id in [
        "god",
        "GSD",
        "architech",
        "yangi",
        "zeus",
        "occam",
        "omoikane",
        "wittgenstein",
        "custom",
    ] {
        let system = service
            .get(&id.into())
            .unwrap()
            .system
            .as_ref()
            .unwrap()
            .to_utf8()
            .unwrap();
        for rule in [swarm, agentic] {
            assert_eq!(system.matches(rule).count(), 1, "{id}: {rule}");
        }
        assert_eq!(
            system
                .lines()
                .filter(|line| *line == "keep working stop asking your useless peice of shit")
                .count(),
            1,
            "{id}"
        );
        assert!(
            system.find(agentic).unwrap() < system.find(swarm).unwrap(),
            "{id}"
        );
        assert!(system.starts_with(prompts::PROJECT), "{id}");
        for stale in [
            "Scale executor subagent fanout from zero to five",
            "fewest subagents",
            "Do not spawn child agents",
        ] {
            assert!(!system.contains(stale), "{id}: {stale}");
        }
    }
    assert_eq!(
        service.get(&"title".into()).unwrap().system,
        Some("Custom title.".into())
    );
    for utility in [
        "btw",
        "compaction",
        "goal",
        "prediction",
        "prompt",
        "decision",
        "summary",
    ] {
        let system = service
            .get(&utility.into())
            .unwrap()
            .system
            .as_ref()
            .unwrap()
            .to_utf8()
            .unwrap();
        assert!(
            !system.contains(swarm) && !system.contains(agentic),
            "{utility}"
        );
    }
}
