use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_core::{
    event_feed,
    resources::{
        agent, command,
        project_artifact::{accounting, adapter, package, source, source_registry, store},
        skill,
    },
    session,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, project, project_artifact,
};
use ycoding_store::{
    Metadata, Options, Store, TableSpec, artifacts, import,
    session::{Event, NewEvent},
};

struct Fixture {
    db: Store,
    root: PathBuf,
    artifacts: store::Service,
    source: source::Service,
    feed: event_feed::Feed,
    registry: Arc<Mutex<source_registry::Registry>>,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "ycoding-artifact-lifecycle-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let db = Store::disposable(
            Options::core(),
            import::catalog(import::DatabaseKind::Core),
            Metadata::new([51; 16], 1),
        )
        .unwrap();
        db.submit(|tx| {
            ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_store::project::Project {
                    id: "project".into(),
                    worktree: "/project".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 0,
                    time_updated: 0,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
        let registry = Arc::new(Mutex::new(source_registry::Registry::default()));
        let accounting = accounting::Service::new(db.client(), "test-bucket-secret".into());
        let artifacts = store::Service::new(
            db.client(),
            store::Paths {
                data: root.join("data"),
                home: root.join("home"),
                config: root.join("config"),
            },
            registry.clone(),
        )
        .with_accounting(accounting.clone());
        let source = source::Service::new(
            source::Options {
                client: db.client(),
                store: artifacts.clone(),
                accounting,
                registry: registry.clone(),
                location: ycoding_schema::location::Ref::decode(
                    &ycoding_schema::parse_json(r#"{"directory":"/project"}"#).unwrap(),
                )
                .unwrap(),
                project_id: project_id(),
                project_directory: "/project".into(),
                data_root: root.join("data"),
            },
            source::Catalogs {
                agents: agent::Service::new(vec![]),
                commands: command::Service::default(),
                skills: skill::Service::new(&root.join("cache")),
            },
        );
        let feed = event_feed::Feed::attach(&db.client());
        Self {
            db,
            root,
            artifacts,
            source,
            feed,
            registry,
        }
    }
    fn write(
        &self,
        kind: &str,
        body: &str,
        expected: Option<project_artifact::MutationExpectation>,
    ) -> store::WriteResult {
        let definition = definition(kind, body);
        self.artifacts
            .write_manual(store::ManualWriteInput {
                scope: project_artifact::ScopeSelector::Project,
                project_id: Some(project_id()),
                id: "review",
                definition: &definition,
                expected,
                now: 1000,
            })
            .unwrap()
    }
    fn expectation(&self, written: &store::WriteResult) -> project_artifact::MutationExpectation {
        project_artifact::MutationExpectation {
            expected_revision: self
                .artifacts
                .get(&written.scope_id, &written.kind, &written.id)
                .unwrap()
                .artifact
                .revision,
            expected_version_id: written.version_id.clone(),
            expected_digest: written.content_digest.clone(),
        }
    }
    fn sessions(&self) -> session::store::Service {
        session::store::Service::new(self.db.client()).with_artifact_source(self.source.clone())
    }
    async fn session(&self, id: &str) {
        self.sessions()
            .create(NewEvent {
                id: format!("evt_create_{id}").into(),
                aggregate_id: id.into(),
                created: 1,
                type_: "session.created.2".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", id)
                    .field("projectID", "project")
                    .field(
                        "location",
                        &ycoding_schema::parse_json(r#"{"directory":"/project"}"#).unwrap(),
                    )
                    .field("title", "Lifecycle test")
                    .field("created", &1.0)
                    .finish(),
            })
            .await
            .unwrap();
    }
    async fn event(&self, id: &str, kind: &str, now: i64, fields: &str) -> Event {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        self.sessions()
            .publish(NewEvent {
                id: format!("evt_{}", NEXT.fetch_add(1, Ordering::Relaxed)).into(),
                aggregate_id: id.into(),
                created: now,
                type_: format!("{kind}.1").into(),
                data: ycoding_schema::parse_json(&format!(r#"{{"sessionID":"{id}"{fields}}}"#))
                    .unwrap(),
            })
            .await
            .unwrap()
    }
    async fn assistant(&self, id: &str, message: &str) {
        self.event(id, "session.step.started", 100, &format!(r#", "assistantMessageID":"{message}","agent":"build","model":{{"providerID":"test","id":"model"}}"#)).await;
    }
    async fn tool(
        &self,
        id: &str,
        message: &str,
        name: &str,
        call: &str,
        completed: bool,
    ) -> Event {
        self.event(
            id,
            "session.tool.input.started",
            101,
            &format!(r#", "assistantMessageID":"{message}","callID":"{call}","name":"{name}""#),
        )
        .await;
        self.event(
            id,
            "session.tool.input.ended",
            102,
            &format!(r#", "assistantMessageID":"{message}","callID":"{call}","text":"{{}}""#),
        )
        .await;
        let called = self.event(id, "session.tool.called", 103, &format!(r#", "assistantMessageID":"{message}","callID":"{call}","input":{{}},"executed":false"#)).await;
        if completed {
            self.event(id, "session.tool.success", 104, &format!(r#", "assistantMessageID":"{message}","callID":"{call}","executed":false,"structured":{{}},"content":[]"#)).await;
        } else {
            self.event(id, "session.tool.failed", 104, &format!(r#", "assistantMessageID":"{message}","callID":"{call}","executed":false,"error":{{"type":"fixture","message":"Failed"}}"#)).await;
        }
        called
    }
    fn rows<T: TableSpec>(&self) -> Vec<T::Record> {
        self.db
            .snapshot()
            .unwrap()
            .scan::<T>(std::ops::Bound::Unbounded, std::ops::Bound::Unbounded, 128)
            .unwrap()
    }
    fn fresh_source(&self) -> source::Service {
        source::Service::new(
            source::Options {
                client: self.db.client(),
                store: self.artifacts.clone(),
                accounting: accounting::Service::new(self.db.client(), "test-bucket-secret".into()),
                registry: self.registry.clone(),
                location: ycoding_schema::location::Ref::decode(
                    &ycoding_schema::parse_json(r#"{"directory":"/project"}"#).unwrap(),
                )
                .unwrap(),
                project_id: project_id(),
                project_directory: "/project".into(),
                data_root: self.root.join("data"),
            },
            source::Catalogs {
                agents: agent::Service::new(vec![]),
                commands: command::Service::default(),
                skills: skill::Service::new(&self.root.join("cache")),
            },
        )
    }
    fn global_catalogs(&self, written: &store::WriteResult) -> source::Catalogs {
        let details = self
            .artifacts
            .get(&written.scope_id, &written.kind, &written.id)
            .unwrap();
        let mut catalogs = source::Catalogs {
            agents: agent::Service::new(vec![]),
            commands: command::Service::default(),
            skills: skill::Service::new(&self.root.join("cache")),
        };
        adapter::activate(
            &adapter::VersionIndex {
                scope_id: written.scope_id.clone(),
                version_id: written.version_id.clone(),
                id: written.id.clone(),
                content_path: adapter::global_path(
                    &written.kind,
                    &self.root.join("home"),
                    &self.root.join("config"),
                    "review",
                ),
                definition: details.definition,
            },
            adapter::RuntimeDraft {
                agent: Some(&mut catalogs.agents),
                command: Some(&mut catalogs.commands),
                skill: Some(&mut catalogs.skills),
            },
        )
        .unwrap();
        catalogs
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.root.exists() {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }
}
fn project_id() -> project::Id {
    project::Id::new("project").unwrap()
}
fn definition(kind: &str, body: &str) -> project_artifact::Definition {
    project_artifact::Definition::decode(
        &ObjectEncoder::new()
            .field("kind", kind)
            .field("name", "Review")
            .field("description", "Reusable review")
            .field("subtask", &false)
            .field("mode", "subagent")
            .field("permissions", &JsonValue::Array(vec![]))
            .field(
                match kind {
                    "command" => "template",
                    "agent" => "system",
                    _ => "content",
                },
                body,
            )
            .finish(),
    )
    .unwrap()
}
fn kind(value: &str) -> project_artifact::Kind {
    project_artifact::Kind::decode(&JsonValue::String(value.into())).unwrap()
}

#[tokio::test]
async fn refresh_replaces_all_catalogs_and_preserves_exact_provenance() {
    let fixture = Fixture::new();
    for name in ["skill", "command", "agent"] {
        let written = fixture.write(name, "First guidance", None);
        fixture.source.refresh().await;
        let provenance = fixture.source.provenance(&kind(name), "review").unwrap();
        assert_eq!(provenance.scope, "project");
        assert_eq!(provenance.scope_id, written.scope_id);
        assert_eq!(provenance.version_id, written.version_id);
        assert_eq!(
            provenance.expected_revision,
            fixture.expectation(&written).expected_revision
        );
        assert_eq!(provenance.expected_digest, written.content_digest);
        let second = fixture.write(name, "Second guidance", Some(fixture.expectation(&written)));
        fixture.source.refresh().await;
        assert_eq!(
            fixture
                .source
                .provenance(&kind(name), "review")
                .unwrap()
                .version_id,
            second.version_id
        );
        let catalogs = fixture.source.catalogs().await;
        match name {
            "skill" => assert_eq!(
                catalogs
                    .skills
                    .clone()
                    .list()
                    .await
                    .unwrap()
                    .iter()
                    .find(|info| info.id == "review".into())
                    .unwrap()
                    .content
                    .as_str(),
                Some("Second guidance")
            ),
            "command" => assert_eq!(
                catalogs
                    .commands
                    .get(&"review".into())
                    .unwrap()
                    .template
                    .as_str(),
                Some("Second guidance")
            ),
            _ => assert_eq!(
                catalogs
                    .agents
                    .get(&"review".into())
                    .unwrap()
                    .system
                    .as_ref()
                    .unwrap()
                    .as_str(),
                Some("Second guidance")
            ),
        }
        fixture
            .artifacts
            .disable(store::LifecycleInput {
                scope_id: &second.scope_id,
                kind: &second.kind,
                id: &second.id,
                expected: &fixture.expectation(&second),
                now: 1100,
            })
            .unwrap();
        fixture.source.refresh().await;
        assert!(fixture.source.provenance(&kind(name), "review").is_none());
        let mut catalogs = fixture.source.catalogs().await;
        match name {
            "skill" => assert!(catalogs.skills.list().await.unwrap().is_empty()),
            "command" => assert!(catalogs.commands.list().is_empty()),
            _ => assert!(catalogs.agents.list().is_empty()),
        }
    }
    assert_eq!(fixture.feed.subscribers(), 0);
    assert!(fixture.db.client().snapshot().is_ok());
}

#[tokio::test]
async fn refresh_rejects_invalid_bytes_and_collisions_without_leaking_registration() {
    let fixture = Fixture::new();
    let written = fixture.write("command", "Managed command", None);
    fixture.source.refresh().await;
    let mut catalogs = source::Catalogs {
        agents: agent::Service::new(vec![]),
        commands: command::Service::default(),
        skills: skill::Service::new(&fixture.root.join("cache")),
    };
    catalogs.commands.update("review".into(), |command| {
        command.template = "Standard command".into()
    });
    fixture.source.replace_standard(catalogs).await;
    assert!(
        fixture
            .source
            .provenance(&kind("command"), "review")
            .is_none()
    );
    assert_eq!(
        fixture
            .source
            .catalogs()
            .await
            .commands
            .get(&"review".into())
            .unwrap()
            .template
            .as_str(),
        Some("Standard command")
    );
    assert!(fixture.source.diagnostics().contains(&"collision"));
    fixture
        .source
        .replace_standard(source::Catalogs {
            agents: agent::Service::new(vec![]),
            commands: command::Service::default(),
            skills: skill::Service::new(&fixture.root.join("cache")),
        })
        .await;
    let path = fixture
        .source
        .catalogs()
        .await
        .commands
        .get(&"review".into())
        .unwrap()
        .locations
        .as_ref()
        .unwrap()[0]
        .as_lossless()
        .as_str()
        .unwrap()
        .to_string();
    std::fs::write(
        path,
        ycoding_core::resources::project_artifact::adapter::render(&definition(
            "command",
            "Tampered command",
        ))
        .as_str()
        .unwrap(),
    )
    .unwrap();
    fixture.source.refresh().await;
    assert!(
        fixture
            .source
            .provenance(&kind("command"), "review")
            .is_none()
    );
    assert!(fixture.source.catalogs().await.commands.list().is_empty());
    assert!(
        fixture
            .registry
            .lock()
            .unwrap()
            .resolve("project", Some(&project_id()), &written.kind, &written.id)
            .is_empty()
    );
}

#[tokio::test]
async fn every_invocation_variant_anchors_exact_durable_boundary_and_retries() {
    let fixture = Fixture::new();
    fixture.session("ses_invocations").await;
    for kind in ["skill", "command", "agent"] {
        fixture.write(kind, "Guidance", None);
    }
    fixture.source.refresh().await;
    fixture
        .assistant("ses_invocations", "msg_invocations")
        .await;
    for (kind_name, source_name, call) in [
        ("skill", "skill-tool", "call_skill"),
        ("agent", "subagent-launch", "call_subagent"),
    ] {
        let called = fixture
            .tool(
                "ses_invocations",
                "msg_invocations",
                if kind_name == "skill" {
                    "skill"
                } else {
                    "subagent"
                },
                call,
                true,
            )
            .await;
        for _ in 0..2 {
            fixture
                .source
                .activate(source::ActivationInput {
                    kind: kind(kind_name),
                    id: "review".into(),
                    session_id: ycoding_schema::session::Id::new("ses_invocations").unwrap(),
                    agent_id: Some("build".into()),
                    source: if source_name == "skill-tool" {
                        source::ActivationSource::SkillTool {
                            message_id: "msg_invocations".into(),
                            call_id: Some(call.into()),
                        }
                    } else {
                        source::ActivationSource::SubagentLaunch {
                            message_id: "msg_invocations".into(),
                            call_id: Some(call.into()),
                        }
                    },
                })
                .unwrap();
        }
        let rows = fixture.rows::<artifacts::ActivationTable>();
        let row = rows
            .iter()
            .find(|row| row.source.as_str() == Some(source_name))
            .unwrap();
        assert_eq!(row.boundary_seq, called.seq);
        assert_eq!(row.activated_at, called.created);
    }
    for message in ["msg_command_first", "msg_command_second"] {
        let admitted = fixture.event("ses_invocations", "session.input.admitted", 110, &format!(r#", "inputID":"{message}","input":{{"type":"user","delivery":"steer","data":{{"text":"Review."}}}}"#)).await;
        fixture
            .event(
                "ses_invocations",
                "session.input.promoted",
                120,
                &format!(r#", "inputID":"{message}""#),
            )
            .await;
        for _ in 0..2 {
            fixture
                .source
                .activate(source::ActivationInput {
                    kind: kind("command"),
                    id: "review".into(),
                    session_id: ycoding_schema::session::Id::new("ses_invocations").unwrap(),
                    agent_id: None,
                    source: source::ActivationSource::Command {
                        message_id: message.into(),
                        call_id: None,
                    },
                })
                .unwrap();
        }
        assert!(
            fixture
                .rows::<artifacts::ActivationTable>()
                .iter()
                .any(
                    |row| row.message_id.as_ref().and_then(|id| id.as_str()) == Some(message)
                        && row.boundary_seq == admitted.seq
                        && row.activated_at == admitted.created
                )
        );
    }
    fixture
        .source
        .activate(source::ActivationInput {
            kind: kind("agent"),
            id: "review".into(),
            session_id: ycoding_schema::session::Id::new("ses_invocations").unwrap(),
            agent_id: Some("review".into()),
            source: source::ActivationSource::AgentSelected {
                boundary_seq: project_artifact::Revision::new(50).unwrap(),
                activated_at: project_artifact::TimestampMillis::new(150).unwrap(),
            },
        })
        .unwrap();
    assert_eq!(fixture.rows::<artifacts::ActivationTable>().len(), 5);
    let missing = fixture.source.activate(source::ActivationInput {
        kind: kind("skill"),
        id: "review".into(),
        session_id: ycoding_schema::session::Id::new("ses_invocations").unwrap(),
        agent_id: None,
        source: source::ActivationSource::SkillTool {
            message_id: "msg_invocations".into(),
            call_id: None,
        },
    });
    assert!(
        missing
            .unwrap_err()
            .to_string()
            .contains("Managed activation requires a durable invocation")
    );
    fixture
        .source
        .activate(source::ActivationInput {
            kind: kind("skill"),
            id: "standard".into(),
            session_id: ycoding_schema::session::Id::new("ses_invocations").unwrap(),
            agent_id: None,
            source: source::ActivationSource::Command {
                message_id: "missing".into(),
                call_id: None,
            },
        })
        .unwrap();
}

#[tokio::test]
async fn agent_selected_event_and_accounting_commit_or_rollback_together() {
    let fixture = Fixture::new();
    fixture.write("agent", "Review safely.", None);
    fixture.source.refresh().await;
    fixture.session("ses_atomic").await;
    let provenance = fixture.source.provenance(&kind("agent"), "review").unwrap();
    let session_id = ycoding_schema::session::Id::new("ses_atomic").unwrap();
    let conflicting = fixture
        .source
        .activation_at(
            &provenance,
            &session_id,
            Some("other".into()),
            "agent-selected",
            1,
            200,
        )
        .unwrap();
    accounting::Service::new(fixture.db.client(), "secret".into())
        .activate(&conflicting)
        .unwrap();
    let event = NewEvent {
        id: "evt_atomic".into(),
        aggregate_id: "ses_atomic".into(),
        created: 200,
        type_: "session.agent.selected.1".into(),
        data: ObjectEncoder::new()
            .field("sessionID", &session_id)
            .field("agent", "review")
            .finish(),
    };
    assert!(fixture.source.publish_activation(event).await.is_err());
    assert!(
        fixture
            .sessions()
            .get(&session_id)
            .unwrap()
            .unwrap()
            .agent
            .is_none()
    );
    assert!(
        fixture
            .sessions()
            .latest(&session_id, "agent-switched")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fixture.rows::<ycoding_store::session::EventTable>().len(),
        1
    );
    assert_eq!(fixture.rows::<artifacts::ActivationTable>().len(), 1);
    fixture.session("ses_atomic_ok").await;
    let event = fixture
        .source
        .publish_activation(NewEvent {
            id: "evt_atomic_ok".into(),
            aggregate_id: "ses_atomic_ok".into(),
            created: 200,
            type_: "session.agent.selected.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", "ses_atomic_ok")
                .field("agent", "review")
                .finish(),
        })
        .await
        .unwrap();
    let row = fixture
        .rows::<artifacts::ActivationTable>()
        .into_iter()
        .find(|row| row.session_id.as_ref().and_then(|id| id.as_str()) == Some("ses_atomic_ok"))
        .unwrap();
    assert_eq!(row.boundary_seq, event.seq);
    assert_eq!(row.activated_at, event.created);
    assert_eq!(row.agent_id.as_ref().unwrap().as_str(), Some("review"));
    let selected = fixture
        .sessions()
        .latest(
            &ycoding_schema::session::Id::new("ses_atomic_ok").unwrap(),
            "agent-switched",
        )
        .unwrap()
        .unwrap();
    let ycoding_schema::session_message::Info::AgentSelected(selected) = selected else {
        panic!()
    };
    assert_eq!(selected.artifact, Some(provenance.message()));
}

#[tokio::test]
async fn authored_catalog_skill_invocation_reaches_terminal_quality_for_all_outcomes() {
    let fixture = Fixture::new();
    let written = fixture.write("skill", "Review guidance.", None);
    fixture.source.refresh().await;
    let mut catalogs = fixture.source.catalogs().await;
    let info = catalogs.skills.list().await.unwrap().remove(0);
    let governor = fixture.source.start(&fixture.feed).unwrap();
    assert!(fixture.source.start(&fixture.feed).is_err());
    for outcome in ["succeeded", "failed", "interrupted"] {
        let id = format!("ses_{outcome}");
        fixture.session(&id).await;
        let session_id = ycoding_schema::session::Id::new(id.as_str()).unwrap();
        session::skill::activate(
            &fixture.sessions(),
            &session_id,
            ObjectEncoder::new()
                .field("id", &info.id)
                .field("name", &info.name)
                .field("text", &info.content)
                .finish(),
            100,
        )
        .await
        .unwrap();
        let marker = fixture
            .sessions()
            .latest(&session_id, "skill")
            .unwrap()
            .unwrap();
        let ycoding_schema::session_message::Info::Skill(marker) = marker else {
            panic!()
        };
        assert_eq!(
            marker.artifact.unwrap().version_id,
            *written.version_id.as_lossless()
        );
        fixture.assistant(&id, &format!("msg_{outcome}")).await;
        fixture.event(&id, "session.step.ended", 120, &format!(r#", "assistantMessageID":"msg_{outcome}","finish":"stop","cost":0,"tokens":{{"input":11,"output":12,"reasoning":0,"cache":{{"read":13,"write":0}}}}"#)).await;
        let autonomy = session::autonomy::Service::new(fixture.db.client());
        autonomy
            .set_goal(
                &session_id,
                session::autonomy::Goal::new("Finish review", None, None),
            )
            .await
            .unwrap();
        fixture
            .event(&id, "session.execution.started", 1000, "")
            .await;
        governor.flush().await.unwrap();
        if outcome == "succeeded" {
            autonomy.complete(&session_id).await.unwrap();
        } else if outcome == "failed" {
            for _ in 0..3 {
                autonomy.report(&session_id).await.unwrap();
            }
        } else {
            autonomy.stop(&session_id).await.unwrap();
        }
        let fields = match outcome {
            "failed" => r#", "error":{"type":"fixture","message":"private failure"}"#,
            "interrupted" => r#", "reason":"user""#,
            _ => "",
        };
        fixture
            .event(&id, &format!("session.execution.{outcome}"), 1075, fields)
            .await;
        governor.flush().await.unwrap();
        fixture
            .event(&id, &format!("session.execution.{outcome}"), 1080, fields)
            .await;
        governor.flush().await.unwrap();
        let row = fixture
            .rows::<artifacts::ObservationTable>()
            .into_iter()
            .find(|row| row.session_id.as_ref().and_then(|value| value.as_str()) == Some(&id))
            .unwrap();
        assert_eq!(row.terminal_outcome.as_str(), Some(outcome));
        assert_eq!(
            row.goal_status.as_str(),
            Some(match outcome {
                "succeeded" => "completed",
                "failed" => "exhausted",
                _ => "stopped",
            })
        );
        assert_eq!(row.latency_ms, Some(75));
        assert_eq!(
            (row.input_tokens, row.output_tokens, row.cache_read_tokens),
            (Some(11), Some(12), Some(13))
        );
        assert_eq!(row.eligible, i64::from(outcome != "interrupted"));
        assert_eq!(row.active_artifact_count, 1);
    }
    governor.close().await.unwrap();
    assert_eq!(fixture.feed.subscribers(), 0);
    assert_eq!(fixture.registry.lock().unwrap().size(), 0);
    assert_eq!(fixture.rows::<artifacts::TerminalTable>().len(), 3);
    assert_eq!(fixture.rows::<artifacts::ObservationTable>().len(), 3);
    assert!(
        fixture.source.diagnostics().is_empty(),
        "{:?}",
        fixture.source.diagnostics()
    );
    let metrics = fixture.artifacts.metrics(&written.version_id).unwrap();
    assert_eq!(metrics.confidence.sample_count.get(), 2);
    assert_eq!(metrics.penalty_units, 1.0);
}

#[tokio::test]
async fn terminal_tool_classification_restart_and_missing_start_match_ts() {
    let fixture = Fixture::new();
    fixture.write("skill", "Guidance", None);
    fixture.write("agent", "Guidance", None);
    fixture.source.refresh().await;
    let governor = fixture.source.start(&fixture.feed).unwrap();
    for (id, tool, managed) in [
        ("ses_managed_skill", "skill", true),
        ("ses_managed_subagent", "subagent", true),
        ("ses_standard", "skill", false),
    ] {
        fixture.session(id).await;
        fixture.assistant(id, &format!("msg_{id}")).await;
        fixture
            .tool(id, &format!("msg_{id}"), tool, "call", true)
            .await;
        if managed {
            fixture
                .source
                .activate(source::ActivationInput {
                    kind: kind(if tool == "skill" { "skill" } else { "agent" }),
                    id: "review".into(),
                    session_id: ycoding_schema::session::Id::new(id).unwrap(),
                    agent_id: Some("build".into()),
                    source: if tool == "skill" {
                        source::ActivationSource::SkillTool {
                            message_id: format!("msg_{id}").into(),
                            call_id: Some("call".into()),
                        }
                    } else {
                        source::ActivationSource::SubagentLaunch {
                            message_id: format!("msg_{id}").into(),
                            call_id: Some("call".into()),
                        }
                    },
                })
                .unwrap();
        }
        fixture
            .event(id, "session.execution.succeeded", 200, "")
            .await;
        governor.flush().await.unwrap();
        let row = fixture
            .rows::<artifacts::TerminalTable>()
            .into_iter()
            .find(|row| row.session_id.as_str() == Some(id))
            .unwrap();
        assert_eq!(row.standard_invocation_count, i64::from(!managed));
        assert_eq!(row.managed_activation_count, i64::from(managed));
        assert_eq!(
            row.kind.as_str(),
            Some(if managed && tool == "subagent" {
                "agent"
            } else {
                "skill"
            })
        );
    }
    governor.close().await.unwrap();
    let restarted = fixture.fresh_source();
    restarted.refresh().await;
    let governor = restarted.start(&fixture.feed).unwrap();
    governor.flush().await.unwrap();
    assert_eq!(fixture.rows::<artifacts::TerminalTable>().len(), 3);
    fixture
        .event("ses_managed_skill", "session.execution.succeeded", 250, "")
        .await;
    governor.flush().await.unwrap();
    assert_eq!(fixture.rows::<artifacts::TerminalTable>().len(), 3);
    assert!(
        restarted
            .diagnostics()
            .contains(&"terminal-observation-failed")
    );
    fixture
        .assistant("ses_managed_skill", "msg_after_restart")
        .await;
    fixture
        .event("ses_managed_skill", "session.execution.started", 300, "")
        .await;
    fixture
        .event("ses_managed_skill", "session.execution.succeeded", 275, "")
        .await;
    governor.close().await.unwrap();
    let observation = fixture
        .rows::<artifacts::ObservationTable>()
        .into_iter()
        .find(|row| {
            row.terminal_message_id.as_ref().and_then(|id| id.as_str()) == Some("msg_after_restart")
        })
        .unwrap();
    assert_eq!(observation.latency_ms, Some(0));
    assert_eq!(observation.eligible, 1);
    assert_eq!(fixture.rows::<artifacts::ObservationTable>().len(), 3);
}

#[tokio::test]
async fn promoted_global_catalogs_and_explicit_shadow_require_exact_origin_evidence() {
    let fixture = Fixture::new();
    let written = fixture.write("command", "Project command", None);
    fixture.source.refresh().await;
    let preview = fixture
        .artifacts
        .preview_promotion(store::LifecycleInput {
            scope_id: &written.scope_id,
            kind: &written.kind,
            id: &written.id,
            expected: &fixture.expectation(&written),
            now: 1100,
        })
        .unwrap();
    let promoted = fixture
        .artifacts
        .confirm_promotion(&preview.token, 1101)
        .unwrap();
    fixture
        .source
        .replace_standard(fixture.global_catalogs(&promoted))
        .await;
    let global = fixture
        .source
        .provenance(&kind("command"), "review")
        .unwrap();
    assert_eq!(global.scope, "global");
    assert_eq!(global.version_id, promoted.version_id);
    assert_eq!(global.expected_digest, promoted.content_digest);
    assert_eq!(
        fixture
            .source
            .catalogs()
            .await
            .commands
            .get(&"review".into())
            .unwrap()
            .template
            .as_str(),
        Some("Project command")
    );
    assert_eq!(
        fixture
            .registry
            .lock()
            .unwrap()
            .resolve("global", None, &promoted.kind, &promoted.id)
            .len(),
        1
    );
    fixture
        .artifacts
        .write_manual(store::ManualWriteInput {
            scope: project_artifact::ScopeSelector::Project,
            project_id: Some(project_id()),
            id: "review",
            definition: &definition("command", "Shadow command"),
            expected: Some(fixture.expectation(&written)),
            now: 1200,
        })
        .unwrap();
    fixture.source.refresh().await;
    assert_eq!(
        fixture
            .source
            .catalogs()
            .await
            .commands
            .get(&"review".into())
            .unwrap()
            .template
            .as_str(),
        Some("Project command")
    );
    let project_scope = fixture
        .artifacts
        .resolve_project_scope(&project_id())
        .unwrap();
    let project_details = fixture
        .artifacts
        .get(&project_scope.id, &written.kind, &written.id)
        .unwrap();
    let project_expected = project_artifact::MutationExpectation {
        expected_revision: project_details.artifact.revision,
        expected_version_id: project_details.current_version.id,
        expected_digest: project_details.current_version.content_digest,
    };
    let shadow = fixture
        .artifacts
        .preview_shadow(store::ShadowInput {
            project_id: &project_id(),
            kind: &promoted.kind,
            id: &promoted.id,
            expected: &project_expected,
            global_scope_id: &promoted.scope_id,
            global_expected: &fixture.expectation(&promoted),
            now: 1201,
        })
        .unwrap();
    let rejected = fixture
        .artifacts
        .confirm_shadow(&shadow.token, 1202)
        .unwrap_err();
    assert_eq!(
        rejected.code.encode(),
        JsonValue::String("ReconciliationRequired".into())
    );
    let fixture = Fixture::new();
    let global_definition = definition("command", "Global guidance");
    let preview = fixture
        .artifacts
        .preview_manual(store::ManualPreviewInput {
            id: "review",
            definition: &global_definition,
            expected: None,
            now: 1300,
        })
        .unwrap();
    let promoted = fixture
        .artifacts
        .confirm_manual(&preview.token, 1301)
        .unwrap();
    fixture
        .source
        .replace_standard(fixture.global_catalogs(&promoted))
        .await;
    let preview = fixture
        .artifacts
        .preview_fork(store::ForkPreviewInput {
            project_id: &project_id(),
            kind: &promoted.kind,
            id: &promoted.id,
            expected_revision: Some(fixture.expectation(&promoted).expected_revision),
            expected_version_id: &promoted.version_id,
            expected_digest: &promoted.content_digest,
            now: 1302,
        })
        .unwrap();
    let written = fixture
        .artifacts
        .confirm_fork(&preview.token, 1303)
        .unwrap();
    fixture.source.refresh().await;
    let project_scope = fixture
        .artifacts
        .resolve_project_scope(&project_id())
        .unwrap();
    assert!(fixture.source.diagnostics().is_empty());
    assert_eq!(
        fixture
            .source
            .catalogs()
            .await
            .commands
            .get(&"review".into())
            .unwrap()
            .locations
            .as_ref()
            .unwrap()[0]
            .as_lossless()
            .as_str()
            .unwrap(),
        package::active_content_path(
            &fixture
                .root
                .join("data/project-artifacts")
                .join(project_scope.storage_id.as_lossless().as_str().unwrap()),
            &written.kind,
            &written.id
        )
        .to_str()
        .unwrap()
    );
    assert_eq!(
        fixture
            .source
            .provenance(&kind("command"), "review")
            .unwrap()
            .scope,
        "global"
    );
    let global_path = adapter::global_path(
        &promoted.kind,
        &fixture.root.join("home"),
        &fixture.root.join("config"),
        "review",
    );
    std::fs::write(
        global_path,
        adapter::render(&definition("command", "Changed global command"))
            .as_str()
            .unwrap(),
    )
    .unwrap();
    fixture.source.refresh().await;
    assert_eq!(
        fixture
            .source
            .provenance(&kind("command"), "review")
            .unwrap()
            .scope,
        "project"
    );
    fixture
        .source
        .replace_standard(fixture.global_catalogs(&promoted))
        .await;
    assert!(
        fixture
            .source
            .provenance(&kind("command"), "review")
            .is_none()
    );
    assert!(fixture.source.diagnostics().contains(&"collision"));
}

#[tokio::test]
async fn terminal_markers_use_compaction_floor_ignore_unrelated_rows_and_filter_locations() {
    let fixture = Fixture::new();
    fixture.session("ses_floor").await;
    fixture.session("ses_other").await;
    fixture.db.submit(|tx| {
        let mut row = tx.get::<ycoding_store::session::SessionTable>(&ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_other".into())]))?.unwrap();
        row.directory = "/other".into();
        ycoding_store::session::SessionTable::put(tx, &row)?;
        for (seq, type_, data) in [
            (2, "skill", r#"{"artifact":null}"#),
            (3, "compaction", r#"{"reason":"auto","status":"completed","summary":"Summary","recent":"","time":{"created":41}}"#),
            (4, "agent-switched", r#"{"artifact":{"kind":"agent"}}"#),
            (5, "user", r#"{"metadata":{"projectArtifact":{"kind":"command"}}}"#),
            (6, "skill", r#"{}"#),
            (7, "synthetic", r#"{"bogus":true}"#),
        ] {
            ycoding_store::session::MessageTable::insert(tx, &ycoding_store::session::Message { id: format!("msg_floor_{seq}").into(), session_id: "ses_floor".into(), type_: type_.into(), seq, time_created: 41, time_updated: 41, data: ycoding_schema::parse_json(data).unwrap() })?;
        }
        Ok(())
    }).unwrap().wait().unwrap();
    let governor = fixture.source.start(&fixture.feed).unwrap();
    fixture
        .event("ses_floor", "session.execution.succeeded", 100, "")
        .await;
    fixture
        .event("ses_other", "session.execution.succeeded", 100, "")
        .await;
    governor.close().await.unwrap();
    let rows = fixture.rows::<artifacts::TerminalTable>();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind.as_str(), Some("agent"));
    assert_eq!(rows[0].standard_invocation_count, 1);
    assert_eq!(rows[0].external_confounded, 1);
    assert!(rows[0].terminal_message_id.is_none());
    assert!(
        fixture.source.diagnostics().is_empty(),
        "{:?}",
        fixture.source.diagnostics()
    );
}

#[tokio::test]
async fn terminal_samples_drive_existing_governor_through_trial_to_active() {
    const DAY: i64 = 86_400_000;
    let fixture = Fixture::new();
    let written = fixture.write("skill", "Review guidance", None);
    let initial_revision = fixture.expectation(&written).expected_revision.get();
    fixture.source.refresh().await;
    let governor = fixture.source.start(&fixture.feed).unwrap();
    for index in 0..21 {
        let id = format!("ses_quality_{index}");
        fixture.session(&id).await;
        let session_id = ycoding_schema::session::Id::new(id.as_str()).unwrap();
        session::skill::activate(
            &fixture.sessions(),
            &session_id,
            ObjectEncoder::new()
                .field("id", "review")
                .field("name", "Review")
                .field("text", "Review guidance")
                .finish(),
            1100,
        )
        .await
        .unwrap();
        fixture
            .event(
                &id,
                "session.execution.succeeded",
                1000 + 7 * DAY + if index == 20 { DAY } else { 0 },
                "",
            )
            .await;
        governor.flush().await.unwrap();
    }
    governor.close().await.unwrap();
    let details = fixture
        .artifacts
        .get(&written.scope_id, &written.kind, &written.id)
        .unwrap();
    assert_eq!(
        details.artifact.stage.encode(),
        JsonValue::String("active".into())
    );
    assert_eq!(details.artifact.revision.get(), initial_revision + 1);
    assert_eq!(
        details.current_version.state.encode(),
        JsonValue::String("active".into())
    );
    assert_eq!(
        fixture
            .artifacts
            .metrics(&written.version_id)
            .unwrap()
            .confidence
            .sample_count
            .get(),
        21
    );
    assert!(
        fixture.source.diagnostics().is_empty(),
        "{:?}",
        fixture.source.diagnostics()
    );
}

#[tokio::test]
async fn governor_filters_unrelated_feed_traffic_before_its_bounded_queue() {
    let fixture = Fixture::new();
    fixture.session("ses_filtered").await;
    let feed = event_feed::Feed::attach_with(&fixture.db.client(), 1, 1);
    let governor = fixture.source.start(&feed).unwrap();
    for _ in 0..100 {
        feed.emit(
            event_feed::Data::SessionTextDelta(Box::new(event_feed::ephemeral::Fragment {
                session_id: ycoding_schema::session::Id::new("ses_filtered").unwrap(),
                assistant_message_id: ycoding_schema::session_message::Id::new("msg_noise")
                    .unwrap(),
                ordinal: project_artifact::Revision::new(0).unwrap(),
                delta: ".".into(),
            })),
            None,
        )
        .unwrap();
    }
    fixture
        .event("ses_filtered", "session.execution.succeeded", 200, "")
        .await;
    governor.close().await.unwrap();
    assert_eq!(fixture.rows::<artifacts::TerminalTable>().len(), 1);
    assert!(fixture.source.diagnostics().is_empty());
}
