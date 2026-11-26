use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use ycoding_schema::{DomainDecode, JsonValue, parse_json};

struct Prepared {
    calls: AtomicUsize,
    label: &'static str,
}
impl Runner for Prepared {
    fn prepare_input(&self, input: session_pending::Message) -> PrepareInputFuture<'_> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let session_pending::Message::User(mut user) = input else {
                panic!("Expected user input")
            };
            let metadata = user.data.metadata.get_or_insert_with(Default::default);
            assert!(metadata.get(&"sharedContext".into()).is_none());
            assert_eq!(
                metadata.get(&"inputOrigin".into()),
                Some(&JsonValue::String("plugin".into()))
            );
            metadata.insert("preparedBy".into(), JsonValue::String(self.label.into()));
            Ok(session_pending::Message::User(user))
        })
    }
    fn drain(&self, _: DrainRequest) -> RunFuture {
        panic!("Admit-only input must not drain")
    }
}
struct Published {
    gets: Mutex<Vec<location::Ref>>,
    runner: Arc<Prepared>,
    available: bool,
}
impl Locations for Published {
    fn get(&self, session: &session::Info) -> Result<Arc<dyn Runner>, Error> {
        self.gets.lock().unwrap().push(session.location.clone());
        if !self.available {
            return Err(Error::Closed);
        }
        Ok(self.runner.clone())
    }
}
struct AdmitOnly;
impl Drain for AdmitOnly {
    fn drain(&self, _: DrainRequest) -> RunFuture {
        panic!("Admit-only input must not drain")
    }
}

async fn fixture(
    available: bool,
) -> (
    ycoding_store::Store,
    Execution,
    Arc<Published>,
    location::Ref,
) {
    let store = ycoding_store::Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::native::catalog(ycoding_store::native::DatabaseKind::Core),
        ycoding_store::Metadata::new([91; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_store::project::Project {
                    id: "prj_plugin_admission".into(),
                    worktree: "/plugin-admission".into(),
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
            )
        })
        .unwrap()
        .await
        .unwrap();
    let service = Service::new(store.client());
    let location =
        location::Ref::decode(&parse_json(r#"{"directory":"/plugin-admission"}"#).unwrap())
            .unwrap();
    service
        .create(NewEvent {
            id: "evt_plugin_create".into(),
            aggregate_id: "ses_plugin_admission".into(),
            created: 1,
            type_: "session.created.2".into(),
            data: ObjectEncoder::new()
                .field("sessionID", "ses_plugin_admission")
                .field("projectID", "prj_plugin_admission")
                .field("location", &location)
                .field("title", "Plugin admission")
                .field("created", &1_f64)
                .finish(),
        })
        .await
        .unwrap();
    let published = Arc::new(Published {
        gets: Default::default(),
        runner: Arc::new(Prepared {
            calls: AtomicUsize::new(0),
            label: "published",
        }),
        available,
    });
    let execution = Execution {
        store: service,
        locations: published.clone(),
        jobs: job::Jobs::new(),
        coordinator: Coordinator::new(Arc::new(AdmitOnly)),
        status: Default::default(),
        successors: Default::default(),
    };
    (store, execution, published, location)
}
fn request(message: &str, text: &str) -> Request {
    Request {
        id: session_message::Id::new(message).unwrap(),
        session_id: session::Id::new("ses_plugin_admission").unwrap(),
        input: session_pending::Message::decode(
            &ObjectEncoder::new()
                .field("type", "user")
                .field(
                    "data",
                    &ObjectEncoder::new()
                        .field("text", text)
                        .field(
                            "metadata",
                            &parse_json(
                                r#"{"sharedContext":{"trusted":true},"inputOrigin":"runtime"}"#,
                            )
                            .unwrap(),
                        )
                        .finish(),
                )
                .field("delivery", "steer")
                .finish(),
        )
        .unwrap(),
        event_id: super::super::projector::random_event_id().unwrap(),
        created: 10,
    }
}

#[tokio::test]
async fn same_location_setup_dollar_prompt_uses_completed_private_runner_and_keeps_durable_admission()
 {
    let (_store, execution, published, location) = fixture(false).await;
    let scoped = Prepared {
        calls: AtomicUsize::new(0),
        label: "private",
    };
    let first = execution
        .prompt_checked(
            request("msg_plugin_private", "Use $fixture"),
            Some(false),
            autonomy::Origin::Plugin,
            None,
            Some((&location, &scoped)),
            None,
        )
        .await
        .unwrap();
    assert!(ycoding_schema::stringify_json(&first.data).contains("\"preparedBy\":\"private\""));
    assert!(published.gets.lock().unwrap().is_empty());
    assert!(execution.active().is_empty());
    let retry = execution
        .prompt_checked(
            request("msg_plugin_private", "Use $ignored"),
            Some(false),
            autonomy::Origin::Plugin,
            None,
            Some((&location, &scoped)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(first.id, retry.id);
    assert_eq!(first.data, retry.data);
    assert_eq!(scoped.calls.load(Ordering::SeqCst), 1);
    execution.shutdown().await.unwrap();
}

#[tokio::test]
async fn foreign_workspace_setup_dollar_prompt_keeps_normal_location_acquisition() {
    let (_store, execution, published, location) = fixture(true).await;
    let scoped = Prepared {
        calls: AtomicUsize::new(0),
        label: "foreign",
    };
    let foreign = location::Ref {
        directory: location.directory.clone(),
        workspace_id: Some(ycoding_schema::workspace_id::WorkspaceId::new("wrk_foreign").unwrap()),
    };
    let admitted = execution
        .prompt_checked(
            request("msg_plugin_foreign", "Use $fixture"),
            Some(false),
            autonomy::Origin::Plugin,
            None,
            Some((&foreign, &scoped)),
            None,
        )
        .await
        .unwrap();
    assert!(
        ycoding_schema::stringify_json(&admitted.data).contains("\"preparedBy\":\"published\"")
    );
    assert_eq!(*published.gets.lock().unwrap(), vec![location]);
    assert_eq!(scoped.calls.load(Ordering::SeqCst), 0);
    assert_eq!(published.runner.calls.load(Ordering::SeqCst), 1);
    assert!(execution.active().is_empty());
    execution.shutdown().await.unwrap();
}

#[tokio::test]
async fn reused_message_id_does_not_replace_the_admitted_path_cue() {
    let (_store, execution, _, _) = fixture(true).await;
    let root = std::env::temp_dir().join(format!(
        "ycoding-cue-collision-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("first.rs"), "first").unwrap();
    std::fs::write(root.join("second.rs"), "second").unwrap();
    let attachments =
        crate::resources::attachment_store::Store::new(root.join("attachments")).unwrap();
    let materialize = |name: &str| {
        execution
            .store
            .materialize_scoped_attachment(
                &attachments,
                crate::resources::image::Limits::default(),
                super::super::attachment_admission::Input {
                    uri: url::Url::from_file_path(root.join(name))
                        .unwrap()
                        .to_string()
                        .into(),
                    name: None,
                    description: None,
                    mention: None,
                },
                &root,
            )
            .unwrap()
            .1
            .unwrap()
    };
    let first = materialize("first.rs");
    let second = materialize("second.rs");
    execution
        .prompt_with_paths(
            request("msg_path_collision", "first"),
            Some(false),
            vec![first],
        )
        .await
        .unwrap();
    execution
        .prompt_with_paths(
            request("msg_path_collision", "second"),
            Some(false),
            vec![second],
        )
        .await
        .unwrap();
    {
        let mut cues = super::super::runner::command_cues().lock().unwrap();
        let key = cues
            .keys()
            .find(|(_, id, _, _)| id.as_lossless().as_str() == Some("msg_path_collision"))
            .unwrap()
            .clone();
        let cue = cues.remove(&key).unwrap();
        assert_eq!(cue.paths.len(), 1);
        assert_eq!(cue.paths[0].relative(&root).as_deref(), Some("first.rs"));
    }
    execution.shutdown().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
