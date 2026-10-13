include!("tool_fixture.rs");
use std::{fs, sync::Arc};
use ycoding_core::tools::{
    builtin::{read::Read, skill},
    context::{
        Context,
        consumers::{ActiveSkill, ConsumerFuture, ReadInstructions},
    },
};
use ycoding_schema::{schema::AbsolutePath, skill::Info};

#[derive(Default)]
struct Instructions(std::sync::Mutex<Vec<std::path::PathBuf>>);
impl ReadInstructions for Instructions {
    fn load(&self, _: Context, paths: Vec<std::path::PathBuf>) -> ConsumerFuture<'_, ()> {
        Box::pin(async move {
            self.0.lock().unwrap().extend(paths);
            Ok(())
        })
    }
}

#[tokio::test]
async fn local_skill_rendering_and_active_resource_reads_are_fenced_to_the_skill_directory() {
    let fixture = ToolFixture::new();
    fs::create_dir_all(fixture.root.join("effect")).unwrap();
    fs::write(fixture.root.join("effect/SKILL.md"), "skill").unwrap();
    fs::write(fixture.root.join("effect/reference.md"), "reference text").unwrap();
    fs::write(fixture.root.join("outside.md"), "outside").unwrap();
    let info = Info {
        id: "effect".into(),
        name: "Effect & Rust".into(),
        description: None,
        slash: None,
        autoinvoke: None,
        conflicts: None,
        location: AbsolutePath::new(
            fixture
                .root
                .join("effect/SKILL.md")
                .to_string_lossy()
                .as_ref(),
        )
        .unwrap(),
        content: "\nUse <effect>.\n".into(),
    };
    let output = skill::load_local(&info, &fixture.policy, fixture.context(), None)
        .await
        .unwrap();
    let text = output.output.as_str().unwrap();
    assert!(text.starts_with("<skill_content name=\"Effect &amp; Rust\">\n# Skill: Effect &amp; Rust\n\nUse <effect>.\n\n"));
    assert!(text.contains(&format!(
        "<file>{}</file>",
        fixture.root.join("effect/reference.md").display()
    )));
    assert!(!text.contains("<file>SKILL.md</file>"));
    let instructions = Arc::new(Instructions::default());
    let reader = Read {
        paths: fixture.paths(),
        policy: fixture.policy.clone(),
        instructions: instructions.clone(),
        collator: Arc::new(|left, right| left.cmp(right)),
    };
    let active = ActiveSkill {
        id: "effect".into(),
        name: "Held name".into(),
        entry: None,
    };
    let resource =
        skill::read_local_resource(&info, &active, "reference.md", &reader, fixture.context())
            .await
            .unwrap();
    assert_eq!(resource.name.as_str(), Some("Held name"));
    assert_eq!(resource.already_active, Some(true));
    assert!(
        resource
            .output
            .as_str()
            .unwrap()
            .ends_with(">\nreference text\n</skill_resource>")
    );
    assert!(instructions.0.lock().unwrap().is_empty());
    assert!(
        skill::read_local_resource(&info, &active, "../outside.md", &reader, fixture.context())
            .await
            .is_err()
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            fixture.root.join("outside.md"),
            fixture.root.join("effect/link.md"),
        )
        .unwrap();
        assert!(
            skill::read_local_resource(&info, &active, "link.md", &reader, fixture.context())
                .await
                .is_err()
        );
    }
    fixture.cleanup();
}

#[tokio::test]
async fn managed_skill_tool_records_durable_invocation_and_keeps_accounting_failures_best_effort() {
    use ycoding_core::{
        event_feed::Feed,
        resources::{
            agent, command,
            project_artifact::{accounting, source, source_registry, store},
            skill::Service,
        },
        session,
    };
    use ycoding_schema::{DomainDecode, JsonValue, ObjectEncoder, project, project_artifact};
    use ycoding_store::{artifacts, session::NewEvent};
    let fixture = ToolFixture::new();
    let client = fixture.authority.store.client();
    let registry = Arc::new(std::sync::Mutex::new(source_registry::Registry::default()));
    let accounting = accounting::Service::new(client.clone(), "secret".into());
    let artifacts = store::Service::new(
        client.clone(),
        store::Paths {
            data: fixture.root.join("data"),
            home: fixture.root.join("home"),
            config: fixture.root.join("config"),
        },
        registry.clone(),
    )
    .with_accounting(accounting.clone());
    let written = artifacts.write_manual(store::ManualWriteInput { scope: project_artifact::ScopeSelector::Project, project_id: Some(project::Id::decode(&JsonValue::String("project".into())).unwrap()), id: "review", definition: &project_artifact::Definition::decode(&ycoding_schema::parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review safely."}"#).unwrap()).unwrap(), expected: None, now: 100 }).unwrap();
    let source = source::Service::new(
        source::Options {
            client: client.clone(),
            store: artifacts,
            accounting,
            registry,
            location: ycoding_schema::location::Ref::decode(
                &ycoding_schema::parse_json(r#"{"directory":"/workspace/project"}"#).unwrap(),
            )
            .unwrap(),
            project_id: project::Id::decode(&JsonValue::String("project".into())).unwrap(),
            project_directory: "/workspace/project".into(),
            data_root: fixture.root.join("data"),
        },
        source::Catalogs {
            agents: agent::Service::new(vec![]),
            commands: command::Service::default(),
            skills: Service::new(&fixture.root.join("cache")),
        },
    );
    source.refresh().await;
    let mut catalogs = source.catalogs().await;
    let info = catalogs.skills.list().await.unwrap().remove(0);
    let sessions = session::store::Service::new(client.clone());
    for (id, kind, fields) in [
        (
            "evt_skill_step",
            "session.step.started.1",
            r#"{"sessionID":"ses_tool","assistantMessageID":"msg_tool","agent":"test","model":{"providerID":"test","id":"model"}}"#,
        ),
        (
            "evt_skill_call",
            "session.tool.called.1",
            r#"{"sessionID":"ses_tool","assistantMessageID":"msg_tool","callID":"call_tool","input":{},"executed":false}"#,
        ),
    ] {
        sessions
            .publish(NewEvent {
                id: id.into(),
                aggregate_id: "ses_tool".into(),
                created: 200,
                type_: kind.into(),
                data: ycoding_schema::parse_json(fields).unwrap(),
            })
            .await
            .unwrap();
    }
    let feed = Feed::attach(&client);
    let governor = source.start(&feed).unwrap();
    for _ in 0..2 {
        let output = skill::load_local(&info, &fixture.policy, fixture.context(), Some(&source))
            .await
            .unwrap();
        assert!(output.output.as_str().unwrap().contains("Review safely."));
    }
    let rows = client
        .snapshot()
        .unwrap()
        .scan::<artifacts::ActivationTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            10,
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].source.as_str(), Some("skill-tool"));
    assert_eq!(rows[0].version_id, *written.version_id.as_lossless());
    assert_eq!(rows[0].activated_at, 200);
    let mut missing = fixture.context();
    missing.call_id = "missing".into();
    skill::load_local(&info, &fixture.policy, missing, Some(&source))
        .await
        .unwrap();
    assert!(source.diagnostics().contains(&"activation-failed"));
    sessions
        .publish(NewEvent {
            id: "evt_skill_terminal".into(),
            aggregate_id: "ses_tool".into(),
            created: 250,
            type_: "session.execution.succeeded.1".into(),
            data: ObjectEncoder::new().field("sessionID", "ses_tool").finish(),
        })
        .await
        .unwrap();
    governor.close().await.unwrap();
    assert_eq!(
        client
            .snapshot()
            .unwrap()
            .scan::<artifacts::ObservationTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                10
            )
            .unwrap()
            .len(),
        1
    );
    fixture.cleanup();
}
