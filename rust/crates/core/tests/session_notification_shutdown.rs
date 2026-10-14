use std::{ops::Bound, path::PathBuf, process::Command, sync::Arc, time::Duration};
use tokio::{sync::mpsc, time::timeout};
use ycoding_core::{
    job,
    process::guardrails::{Guardrails, Limits, Paths, Settings},
    session::{
        execution::{self, Locations, Runner},
        orchestration::{self, Launch, LaunchInput, Prepared},
        pending::Request,
        run_coordinator::{DrainRequest, Error, Outcome, RunFuture},
        store,
    },
    tools::policy::{Authority, Publisher, permissions::Permissions},
};
use ycoding_schema::{
    DomainDecode, location, model, parse_json, session, session_message,
    session_orchestration::{NotificationType, State},
    session_pending,
};
use ycoding_store::{
    Metadata, Options, Store,
    project::{Project, ProjectTable},
    session::{NotificationTable, SessionTable},
};

#[path = "session_support/record.rs"]
mod support;

struct Consumer {
    store: store::Service,
    started: mpsc::UnboundedSender<session::Id>,
    restarting: bool,
}

impl Runner for Consumer {
    fn drain(&self, mut request: DrainRequest) -> RunFuture {
        let store = self.store.clone();
        let started = self.started.clone();
        let restarting = self.restarting;
        Box::pin(async move {
            started.send(request.session_id.clone()).unwrap();
            if !restarting {
                return Err(Error::Interrupted(request.cancellation.cancelled().await));
            }
            store.promote_steers(&request.session_id, 100).await?;
            Ok(())
        })
    }
}

struct Placement(Arc<Consumer>);

impl Locations for Placement {
    fn get(&self, _: &location::Ref) -> Result<Arc<dyn Runner>, Error> {
        Ok(self.0.clone())
    }
}

struct LocalExecution;

impl orchestration::Execution for LocalExecution {
    fn wake(&self, id: &session::Id) -> Outcome {
        execution::Execution::global().unwrap().wake(id)
    }

    fn interrupt(&self, id: &session::Id) -> RunFuture {
        let id = id.clone();
        Box::pin(async move { execution::Execution::global().unwrap().interrupt(&id).await })
    }
}

#[test]
fn cancelled_child_notification_survives_closed_execution_and_process_restart_exactly_once() {
    let root = std::env::temp_dir().join(format!(
        "notification-restart-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let phase = |name| {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "notification_shutdown_phase",
                "--nocapture",
            ])
            .env("YCODING_NOTIFICATION_TEST_ROOT", &root)
            .env("YCODING_NOTIFICATION_TEST_PHASE", name)
            .output()
            .unwrap()
    };
    let cancelled = phase("cancel");
    let restarted = phase("restart");
    assert!(
        restarted.status.success(),
        "restart: {} {}",
        String::from_utf8_lossy(&restarted.stdout),
        String::from_utf8_lossy(&restarted.stderr)
    );
    assert!(
        cancelled.status.success(),
        "shutdown: {} {}",
        String::from_utf8_lossy(&cancelled.stdout),
        String::from_utf8_lossy(&cancelled.stderr)
    );
    let stderr = String::from_utf8_lossy(&cancelled.stderr);
    assert!(
        !stderr.contains("Failed to dispatch subagent notifications"),
        "{stderr}"
    );
    assert!(
        !stderr.contains("SessionId(") && !stderr.contains("LosslessString("),
        "{stderr}"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "invoked in two fresh processes by the notification restart boundary test"]
async fn notification_shutdown_phase() {
    timeout(Duration::from_secs(30), phase()).await.unwrap();
}

async fn phase() {
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_target(false)
        .without_time()
        .with_writer(std::io::stderr)
        .init();
    let root = PathBuf::from(std::env::var_os("YCODING_NOTIFICATION_TEST_ROOT").unwrap());
    let restarting = std::env::var("YCODING_NOTIFICATION_TEST_PHASE").unwrap() == "restart";
    let catalog = ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core);
    let database = root.join("store.redb");
    let store = if restarting {
        Store::open(database, Options::core(), catalog).unwrap()
    } else {
        Store::initialize(
            database,
            Options::core(),
            catalog,
            Metadata::new([5; 16], 1),
        )
        .unwrap()
    };
    if !restarting {
        store
            .submit(|tx| {
                ProjectTable::insert(
                    tx,
                    &Project {
                        id: "prj_one".into(),
                        worktree: "/project".into(),
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: 1,
                        time_updated: 1,
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    },
                )?;
                SessionTable::insert(tx, &support::record("ses_one"))
            })
            .unwrap()
            .await
            .unwrap();
    }
    let sessions = store::Service::new(store.client());
    let (started, mut received) = mpsc::unbounded_channel();
    let execution = execution::Execution::install(
        sessions.clone(),
        Arc::new(Placement(Arc::new(Consumer {
            store: sessions.clone(),
            started,
            restarting,
        }))),
        job::Jobs::new(),
        None,
    )
    .unwrap();
    let service = orchestration::Service::new(sessions.clone(), Arc::new(LocalExecution));
    let parent = session::Id::new("ses_one").unwrap();
    let assistant = session_message::Id::new("msg_parent").unwrap();
    let ids = Launch::new(&parent, &assistant, "call_cancel_shutdown");

    if !restarting {
        execution
            .prompt(
                Request {
                    id: session_message::Id::new("msg_parent_input").unwrap(),
                    session_id: parent.clone(),
                    input: session_pending::Message::decode(
                        &parse_json(
                            r#"{"type":"user","data":{"text":"Parent work"},"delivery":"steer"}"#,
                        )
                        .unwrap(),
                    )
                    .unwrap(),
                    event_id: ycoding_schema::event::Id::new("evt_parent_input").unwrap(),
                    created: 1,
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(received.recv().await.unwrap(), parent);
        let authority = Authority {
            store: store.client(),
            agents: Arc::new(|agent| {
                Some((agent.cloned().unwrap_or_else(|| "build".into()), Vec::new()))
            }),
        };
        let publisher: Publisher = Arc::new(|_| Ok(()));
        let guardrails = Guardrails::new(
            authority.clone(),
            Permissions::new(
                authority,
                ycoding_schema::project_id::ProjectId::new("prj_one").unwrap(),
                publisher.clone(),
            ),
            Settings {
                paths: Paths {
                    workdir: "/project".into(),
                    project: "/project".into(),
                    home: "/home/operator".into(),
                    tmpdir: None,
                    trusted_paths: vec![],
                },
                global_roots: vec![],
                custom: Arc::new(Vec::new),
                enabled: true,
                limits: Limits::default(),
            },
            publisher,
        );
        service
            .launch(LaunchInput {
                parent_id: parent.clone(),
                parent_assistant_message_id: assistant,
                tool_call_id: "call_cancel_shutdown".into(),
                description: "Shutdown cancellation".into(),
                prompt: "Child work".into(),
                depth_limit: 1,
                prepared: Prepared {
                    agent: "explore".into(),
                    caller_permissions: Vec::new(),
                    model: model::Ref::decode(
                        &parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap(),
                    )
                    .unwrap(),
                    profile_binding: None,
                },
                guardrails,
            })
            .await
            .unwrap();
        assert_eq!(received.recv().await.unwrap(), ids.child_id);
        let cancelled = service.cancel(&parent, &ids.child_id).await.unwrap();
        assert_eq!(cancelled.state, State::Cancelled);
        let rows = store
            .snapshot()
            .unwrap()
            .scan::<NotificationTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].delivered, 0);
        assert_eq!(rows[0].type_.as_str(), Some("cancelled"));
        execution.shutdown().await.unwrap();
        let dispatch = service.dispatch_notifications().await;
        let notice = ids.notification(cancelled.revision.get(), &NotificationType::Cancelled);
        assert!(sessions.pending(&notice).unwrap().is_some());
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .scan::<NotificationTable>(Bound::Unbounded, Bound::Unbounded, 10)
                .unwrap()[0]
                .delivered,
            0
        );
        assert_eq!(
            service.get(&parent, &ids.child_id).unwrap().state,
            State::Cancelled
        );
        store.shutdown().unwrap();
        assert_eq!(dispatch.unwrap(), 0);
        return;
    }

    let cancelled = service.get(&parent, &ids.child_id).unwrap();
    assert_eq!(cancelled.state, State::Cancelled);
    assert_eq!(service.list(&parent).unwrap().len(), 1);
    assert_eq!(service.reconcile_stale().await.unwrap(), 0);
    assert_eq!(service.dispatch_notifications().await.unwrap(), 1);
    execution.await_idle(&parent).await;
    assert_eq!(service.dispatch_notifications().await.unwrap(), 0);
    let notice = ids.notification(cancelled.revision.get(), &NotificationType::Cancelled);
    let messages = sessions.context(&parent).unwrap();
    let notices = messages
        .iter()
        .filter_map(|message| match message {
            ycoding_schema::session_message::Info::Synthetic(message) => Some(message),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].id, notice);
    assert!(
        notices[0]
            .text
            .to_utf8()
            .unwrap()
            .contains("\"type\":\"cancelled\"")
    );
    assert!(
        notices[0]
            .text
            .to_utf8()
            .unwrap()
            .contains(ids.child_id.as_lossless().as_str().unwrap())
    );
    assert!(sessions.pending(&notice).unwrap().is_none());
    let rows = store
        .snapshot()
        .unwrap()
        .scan::<NotificationTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].delivered, 1);
    assert_eq!(service.get(&parent, &ids.child_id).unwrap(), cancelled);
    execution.shutdown().await.unwrap();
    store.shutdown().unwrap();
}
