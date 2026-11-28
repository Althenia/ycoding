use std::path::Path;
use ycoding_core::resources::{agent, discovery, reference, skill};
use ycoding_schema::{DomainDecode, parse_json};

fn configuration(content: &str) -> std::sync::Arc<ycoding_core::resources::config::Configuration> {
    use ycoding_core::resources::config::{Configuration, LoadOptions, Roots};
    let roots = Roots::development(
        &std::env::temp_dir().join(format!("ycoding-guidance-{}", std::process::id())),
    )
    .unwrap();
    std::sync::Arc::new(
        Configuration::load(LoadOptions {
            directory: roots.home.clone(),
            roots,
            project: false,
            file: None,
            content: Some(content.into()),
            env: Default::default(),
        })
        .unwrap(),
    )
}

#[tokio::test]
async fn builtin_tool_dependencies_follow_agent_ceiling_and_codemode() {
    use std::sync::Arc;
    use ycoding_core::{
        instructions::{self, Observation, builtins},
        resources::{memory, tool_output_store},
        session::instruction_assembly,
        tools::registry::{DynamicTool, Options, Registry},
    };
    for (content, codemode, subagent, denied) in [
        (
            r#"{}"#,
            false,
            false,
            vec!["core/shell-memory", "ycoding/workspace-memory"],
        ),
        (
            r#"{"capabilities":{"tools":{"deny":["execute"]}}}"#,
            true,
            false,
            vec![
                "core/shell-memory",
                "core/subagent-reuse",
                "core/decision-use",
                "core/task-completion",
                "core/decision-input",
                "ycoding/workspace-memory",
            ],
        ),
        (
            r#"{"capabilities":{"tools":{"allow":["shell"]}}}"#,
            true,
            false,
            vec![
                "core/subagent-reuse",
                "core/decision-use",
                "ycoding/workspace-memory",
            ],
        ),
        (
            r#"{}"#,
            false,
            true,
            vec![
                "core/subagent-reuse",
                "core/shell-memory",
                "ycoding/workspace-memory",
            ],
        ),
        (
            r#"{"capabilities":{"builtin_instructions":{"deny":["date","decision-use"]}}}"#,
            false,
            false,
            vec!["core/date", "core/decision-use"],
        ),
    ] {
        let config = configuration(content);
        let registry = Registry::new(
            Arc::new(tool_output_store::Store::new(config.roots())),
            Some(config.clone()),
            Default::default(),
            Arc::new(|a, b| a.cmp(b)),
        );
        let _scope = registry
            .register(
                [
                    "subagent",
                    "shell",
                    "question",
                    "decision",
                    "task_complete",
                    "memory",
                ]
                .iter()
                .map(|name| {
                    (
                        (*name).into(),
                        Arc::new(DynamicTool::new(
                            "test",
                            ycoding_schema::JsonValue::Null,
                            None,
                            None,
                            |_, _| {
                                Box::pin(async {
                                    Ok(ycoding_ai::llm::ToolOutput {
                                        structured: ycoding_schema::JsonValue::Null,
                                        content: vec![],
                                    })
                                })
                            },
                        )) as Arc<dyn ycoding_core::tools::registry::Tool>,
                    )
                })
                .collect(),
                Options {
                    namespace: None,
                    codemode,
                },
            )
            .unwrap();
        let mut agent = agent::empty("build".into());
        agent.mode = if subagent { "subagent" } else { "primary" }.into();
        let ceiling = if content == "{}" {
            ["shell", "memory"]
                .iter()
                .map(|action| ycoding_schema::permission::Rule {
                    action: (*action).into(),
                    effect: ycoding_schema::permission::Effect("deny".into()),
                    resource: "*".into(),
                })
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        let mut sources = builtins::load(
            builtins::Environment {
                directory: "/project".into(),
                project_root: "/project".into(),
                git: true,
                platform: "test".into(),
                data: "/data/ycoding".into(),
            },
            Arc::new(|| 0),
            ycoding_schema::session_scope::Scope::Bound,
        );
        sources.push(memory::instructions::source());
        let selected = instruction_assembly::select_sources(
            &sources,
            &agent,
            &instruction_assembly::project_ceiling(&ceiling, false),
            &config,
            &registry,
        );
        let observed = instructions::read(&selected).await.unwrap();
        assert_eq!(selected.len(), sources.len());
        for key in denied {
            assert_eq!(
                observed
                    .iter()
                    .find(|entry| ycoding_schema::DomainEncode::encode(&entry.key)
                        == ycoding_schema::JsonValue::String(key.into()))
                    .unwrap()
                    .value,
                Observation::Removed,
                "{content}/{key}"
            );
        }
        assert!(matches!(observed[0].value, Observation::Value(_)));
        if content.contains(r#""allow":["shell"]"#) {
            assert!(matches!(
                observed
                    .iter()
                    .find(|entry| ycoding_schema::DomainEncode::encode(&entry.key)
                        == ycoding_schema::JsonValue::String("core/shell-memory".into()))
                    .unwrap()
                    .value,
                Observation::Value(_)
            ));
        }
    }
}

#[tokio::test]
async fn memory_off_removes_all_memory_guidance() {
    use std::sync::Arc;
    use ycoding_core::{
        instructions::{self, Observation},
        resources::{memory, tool_output_store},
        session::instruction_assembly,
        tools::registry::{DynamicTool, Options, Registry},
    };
    let config = configuration(r#"{"memory":{"enabled":false}}"#);
    let registry = Registry::new(
        Arc::new(tool_output_store::Store::new(config.roots())),
        Some(config.clone()),
        Default::default(),
        Arc::new(|a, b| a.cmp(b)),
    );
    let _scope = registry
        .register(
            vec![(
                "memory".into(),
                Arc::new(DynamicTool::new(
                    "memory",
                    ycoding_schema::JsonValue::Null,
                    None,
                    None,
                    |_, _| Box::pin(async { unreachable!() }),
                )),
            )],
            Options::direct(),
        )
        .unwrap();
    let sources = [
        memory::instructions::source(),
        instructions::constant("core/memory", memory::instructions::CONTENT),
    ];
    let selected = instruction_assembly::select_sources(
        &sources,
        &agent::empty("build".into()),
        &instruction_assembly::project_ceiling(&[], false),
        &config,
        &registry,
    );
    assert!(
        instructions::read(&selected)
            .await
            .unwrap()
            .iter()
            .all(|entry| entry.value == Observation::Removed)
    );
}

#[test]
fn skill_guidance_filters_denies_and_autoinvoke_and_escapes_xml_then_renders_deltas() {
    let a = skill::from_frontmatter(
        Path::new("/skills/a/SKILL.md"),
        &parse_json(r#"{"name":"a","description":"Description","metadata":{"display-name":"<A & 'quote'\">"}}"#).unwrap(),
        "A",
    )
    .unwrap();
    let mut b = a.clone();
    b.id = "b".into();
    b.name = "B".into();
    b.description = Some("B description".into());
    let mut c = a.clone();
    c.id = "c".into();
    c.autoinvoke = Some(false);
    let mut selected = agent::empty("reviewer".into());
    selected.permissions.push(
        ycoding_schema::permission::Rule::decode(
            &parse_json(r#"{"action":"s?ill","resource":"b","effect":"deny"}"#).unwrap(),
        )
        .unwrap(),
    );
    let skills = vec![a.clone(), b.clone(), c];
    let allowed = skill::available(&skills, &selected);
    assert_eq!(
        allowed.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        vec!["a".into(), "c".into()]
    );
    let before = skill::instructions::summaries_by(&allowed, |a, b| a.cmp(b));
    assert_eq!(before.len(), 1);
    let rendered = skill::instructions::render(&before).to_utf8().unwrap();
    assert!(rendered.contains("<name>&lt;A &amp; &apos;quote&apos;&quot;&gt;</name>"));
    let after = skill::instructions::summaries_by(&[&a, &b], |a, b| a.cmp(b));
    assert!(
        skill::instructions::changed(&before, &after)
            .to_utf8()
            .unwrap()
            .starts_with("New skills are available in addition to those previously listed:")
    );
    assert!(
        skill::instructions::changed(&after, &before)
            .to_utf8()
            .unwrap()
            .contains("The following skill IDs are no longer available and must not be used: b.")
    );
    let mut modified = after.clone();
    modified[0].description = "Changed".into();
    assert!(
        skill::instructions::changed(&after, &modified)
            .to_utf8()
            .unwrap()
            .starts_with("The available skills have changed. This list supersedes")
    );
    assert!(
        skill::instructions::render(&[])
            .to_utf8()
            .unwrap()
            .ends_with("No skills are currently available.")
    );
}

#[test]
fn reference_guidance_includes_described_even_hidden_sources_and_preserves_ts_markup_and_deltas() {
    let source = ycoding_schema::reference::Source::Local(ycoding_schema::reference::LocalSource {
        path: discovery::absolute_path(Path::new("/one")).unwrap(),
        description: Some("<raw>".into()),
        hidden: Some(true),
    });
    let first = ycoding_schema::reference::Info {
        name: "one".into(),
        path: discovery::absolute_path(Path::new("/one")).unwrap(),
        description: Some("<raw>".into()),
        hidden: Some(true),
        source,
    };
    let mut second = first.clone();
    second.name = "two".into();
    second.path = discovery::absolute_path(Path::new("/two")).unwrap();
    let before =
        reference::instructions::summaries_by(std::slice::from_ref(&first), |a, b| a.cmp(b));
    assert_eq!(before.len(), 1);
    assert!(
        reference::instructions::render(&before)
            .to_utf8()
            .unwrap()
            .contains("<description><raw></description>")
    );
    let after = reference::instructions::summaries_by(&[first, second], |a, b| b.cmp(a));
    assert_eq!(after[0].name, "two".into());
    assert!(
        reference::instructions::changed(&before, &after)
            .to_utf8()
            .unwrap()
            .starts_with(
                "New project references are available in addition to those previously listed:"
            )
    );
    assert!(reference::instructions::changed(&after,&before).to_utf8().unwrap().ends_with("The following project references are no longer available and must not be used: two."));
    let mut changed = before.clone();
    changed[0].path = "/new".into();
    assert!(
        reference::instructions::changed(&before, &changed)
            .to_utf8()
            .unwrap()
            .starts_with("The available project references have changed. This list supersedes")
    );
}

#[tokio::test]
async fn git_worktree_guidance_names_the_managed_data_path_and_repo_key() {
    use ycoding_core::instructions::{Observation, builtins};
    let sources = builtins::load(
        builtins::Environment {
            directory: "/project".into(),
            project_root: "/project".into(),
            git: true,
            platform: "test".into(),
            data: "/data/ycoding".into(),
        },
        std::sync::Arc::new(|| 0),
        ycoding_schema::session_scope::Scope::Bound,
    );
    let source = sources
        .iter()
        .find(|source| {
            ycoding_schema::DomainEncode::encode(&source.key)
                == ycoding_schema::JsonValue::String("core/git-worktree".into())
        })
        .unwrap();
    let Observation::Value(ycoding_schema::JsonValue::String(text)) =
        (source.read)().await.unwrap()
    else {
        panic!("git worktree guidance must render text")
    };
    assert_eq!(
        text.as_str(),
        Some(
            r#"When working with a Git worktree, create it at `/data/ycoding/worktrees/<repo-key>/<name>`, where `<repo-key>` is `repo_` followed by the SHA-256 hex digest of the real path of the repository's Git common directory. Give every worktree a named branch identical to its worktree name, for example `git worktree add -b <name> /data/ycoding/worktrees/<repo-key>/<name>`; never create a detached HEAD worktree. During authorized integration, use `git diff --name-only` between the previous and latest target heads to compare intermediate target changes against lane files. Automatically rebase linearly onto the latest target head when files are disjoint; ask only for overlapping file conflicts or failing checks. Complete consolidated checks, a single commit, linear rebase onto the latest target head, `git merge --ff-only --autostash <name>` from the target branch checkout, and safe non-force worktree removal in one continuous pass without ceremony, handoffs, or slots. Preserve unrelated work, existing Git identity, and permission boundaries; never create a merge commit. Prune stale registrations after verified worktree removal. Never stage, commit, integrate, or remove a worktree without authorization; this policy grants none."#
        )
    );
}

#[test]
fn standalone_builtin_sources_omit_host_only_instructions() {
    use ycoding_core::instructions::builtins;
    let sources = builtins::load(
        builtins::Environment {
            directory: "/project".into(),
            project_root: "/project".into(),
            git: true,
            platform: "test".into(),
            data: "/data/ycoding".into(),
        },
        std::sync::Arc::new(|| 0),
        ycoding_schema::session_scope::Scope::Standalone,
    );
    assert_eq!(
        sources
            .iter()
            .map(|source| ycoding_core::instructions::key(&source.key))
            .collect::<Vec<_>>(),
        [
            "core/date",
            "core/subagent-reuse",
            "core/decision-input",
            "core/decision-use",
            "core/task-completion",
        ]
        .map(ycoding_schema::LosslessString::from)
    );
}

#[tokio::test]
async fn builtin_guidance_preserves_current_content_and_environment_boundaries() {
    use ycoding_core::instructions::{Observation, builtins};
    use ycoding_schema::{DomainEncode, JsonValue};
    let sources = builtins::load(
        builtins::Environment {
            directory: "/project".into(),
            project_root: "/project".into(),
            git: true,
            platform: "test".into(),
            data: "/data/ycoding".into(),
        },
        std::sync::Arc::new(|| 0),
        ycoding_schema::session_scope::Scope::Bound,
    );
    for (key, expected) in [
        (
            "core/shell-memory",
            r#"Shell commands accept memory_limit_mb to constrain memory used by the command process tree. A finite limit supplies matching Go and Node runtime hints and terminates the process tree if sampled aggregate resident memory still exceeds the limit. Leave commands uncapped unless the project or user explicitly configures a limit; never impose unrequested resource limits."#,
        ),
        (
            "core/decision-input",
            r#"Work agentically. Resolve every blocker and issue yourself: diagnose the root cause, try every local compliant fix, and recover from failed checks, conflicts and environment errors, then keep going. Pursue the user's goal proactively and relentlessly to full completion; never stop at an intermediate milestone, a status report, or a question you can settle from evidence. Resolve routine choices, minor ambiguities, and recoverable obstacles yourself from evidence first; call question only when progress genuinely needs underivable user input. Offer concise choices with a recommended default for decisions and empty options for free text, and continue immediately after its answer. Honor enforced controls and report any blocked action or missing credential. Answers YOLO handles every question, including explicit-decision and open questions, with a valid automatic answer or deterministic valid fallback instead of asking or deferring. Outside YOLO, follow native controls for unresolved requests and honor defer. Do not re-ask, retry or guess deferred manual decisions. /defer remains active across prompts until explicitly toggled off; review decisions do not change it. Call task_complete only after all work is verified."#,
        ),
        (
            "core/decision-use",
            r#"Use decision for bounded typed judgments from the hidden helper. Confidence is self-reported and uncalibrated. Prefer tests, grep, typechecks and inventory for facts. Supply authorized evidence, neutral questions, observable criteria, distinct choices including keep-current and adjacent score levels. Batch independent questions; separate dependent judgments. Grade mode (`grade: true`) returns each listed choice once with confidence in [0,1] and nonempty evidence of at most 500 characters, without a pick. Treat refusal, invalid output, unavailable routes, low confidence and conflicting evidence as uncertainty. Set thresholds by mistake cost, preserve owner choices and reuse unchanged judgments. Advisory judgments never grant authority or prove completion. Permissions, guardrails and answers each use an independent mode through /autonomous. Manual requires a typed decision and calls no helper; Auto applies deterministic rules without model fallback. Permissions YOLO admits directly except Project coordinator execution restrictions; guardrails YOLO bypasses classification and review while retaining action capacity. Answers YOLO alone consults yolo-answer, with validated fallbacks for unsettled results. New YOLO enablement requires explicit client risk acceptance; never change modes or security settings on the user's behalf. Defer persists until explicitly disabled and retains unresolved review items. Never retry deferred actions."#,
        ),
        (
            "core/environment",
            r#"<env>
  Working directory: /project
  Workspace root folder: /project
  Is directory a git repo: yes
  Platform: test
</env>
Put new ad-hoc agent scratch files, logs, snapshots and patches in a unique per-task directory `/data/ycoding/tasks/<unique-task-name>`, never in a repository `.cache` directory. Leave existing repository and tool-managed caches in place and never move or delete them automatically. Built-in agents need no outside-directory confirmation under `/data/ycoding`; your agent's permissions, explicit denies, permission ceilings and guardrail reviews still apply."#,
        ),
    ] {
        let source = sources
            .iter()
            .find(|source| source.key.encode() == JsonValue::String(key.into()))
            .unwrap();
        let Observation::Value(value) = (source.read)().await.unwrap() else {
            panic!("expected current guidance for {key}")
        };
        assert_eq!(value, JsonValue::String(expected.into()), "{key}");
        let initial = (source.initial)(&value).unwrap();
        let changed = (source.changed)(&value, &value).unwrap();
        assert!(initial.as_str().unwrap().ends_with(expected), "{key}");
        assert!(changed.as_str().unwrap().ends_with(expected), "{key}");
    }
}

#[tokio::test]
async fn built_in_decision_guidance_directs_agentic_work_without_user_instructions() {
    use ycoding_core::instructions::{Observation, builtins};
    use ycoding_schema::JsonValue;
    let sources = builtins::load(
        builtins::Environment {
            directory: "/project".into(),
            project_root: "/project".into(),
            git: true,
            platform: "test".into(),
            data: "/data/ycoding".into(),
        },
        std::sync::Arc::new(|| 0),
        ycoding_schema::session_scope::Scope::Bound,
    );
    let source = sources
        .iter()
        .find(|source| {
            ycoding_core::instructions::key(&source.key).as_str() == Some("core/decision-input")
        })
        .unwrap();
    let Observation::Value(JsonValue::String(text)) = (source.read)().await.unwrap() else {
        panic!("decision-input is a string instruction")
    };
    let text = text.to_utf8().unwrap();
    for phrase in [
        "Work agentically.",
        "Resolve every blocker and issue yourself: diagnose the root cause, try every local compliant fix",
        "recover from failed checks, conflicts and environment errors, then keep going",
        "proactively and relentlessly to full completion",
        "never stop at an intermediate milestone, a status report, or a question you can settle from evidence",
        "Honor enforced controls and report any blocked action or missing credential.",
    ] {
        assert!(text.contains(phrase), "{phrase}");
    }
    assert_eq!(text.matches("Work agentically.").count(), 1);
}
