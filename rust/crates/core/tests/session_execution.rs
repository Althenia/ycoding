use std::sync::{Arc, Mutex};
use tokio::sync::{Semaphore, mpsc};
use ycoding_core::session::{
    execution::{Execution, Locations, PrepareInputFuture, Runner, Terminal, terminal},
    pending::Request,
    run_coordinator::{DrainRequest, Error, InterruptReason, RunFuture},
    store::Service,
};
use ycoding_schema::{
    DomainDecode, JsonObject, JsonValue, location, parse_json, session, session_message,
    session_pending,
};

#[path = "session_support/mod.rs"]
mod support;

#[path = "session_support/checkpoint.rs"]
mod checkpoint;

struct LocationMap {
    locations: Arc<Mutex<Vec<location::Ref>>>,
    runner: Arc<Gate>,
}
impl Locations for LocationMap {
    fn get(&self, location: &location::Ref) -> Result<Arc<dyn Runner>, Error> {
        self.locations.lock().unwrap().push(location.clone());
        Ok(self.runner.clone())
    }
}
struct Gate {
    started: mpsc::UnboundedSender<(session::Id, bool)>,
    permits: Arc<Semaphore>,
    store: Service,
    prepared: Arc<Mutex<usize>>,
}
impl Runner for Gate {
    fn prepare_input(&self, input: session_pending::Message) -> PrepareInputFuture<'_> {
        let prepared = self.prepared.clone();
        Box::pin(async move {
            *prepared.lock().unwrap() += 1;
            let session_pending::Message::User(mut user) = input else {
                return Ok(input);
            };
            assert!(
                user.data
                    .metadata
                    .as_ref()
                    .is_none_or(|metadata| metadata.get(&"sharedContext".into()).is_none())
            );
            user.data
                .metadata
                .get_or_insert_with(JsonObject::new)
                .insert("prepared".into(), JsonValue::Bool(true));
            Ok(session_pending::Message::User(user))
        })
    }
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let started = self.started.clone();
        let permits = self.permits.clone();
        let store = self.store.clone();
        Box::pin(async move {
            started
                .send((request.session_id.clone(), request.force))
                .unwrap();
            permits.acquire().await.unwrap().forget();
            store.promote_steers(&request.session_id, 40).await?;
            Ok(())
        })
    }
}

#[tokio::test]
async fn process_global_execution_routes_session_placement_only_at_drain_and_advisory_wakes_require_inbox_work()
 {
    let store = support::store();
    let service = Service::new(store.client());
    let (started, mut receiver) = mpsc::unbounded_channel();
    let runner = Arc::new(Gate {
        started,
        permits: Arc::new(Semaphore::new(0)),
        store: service.clone(),
        prepared: Arc::new(Mutex::new(0)),
    });
    let locations = Arc::new(LocationMap {
        locations: Arc::new(Mutex::new(Vec::new())),
        runner: runner.clone(),
    });
    let jobs = ycoding_core::job::Jobs::new();
    let execution =
        Execution::install(service.clone(), locations.clone(), jobs.clone(), None).unwrap();
    assert!(std::ptr::eq(execution, Execution::global().unwrap()));
    assert!(matches!(
        Execution::install(service.clone(), locations.clone(), jobs, None),
        Err(Error::AlreadyInstalled)
    ));
    let id = session::Id::new("ses_one").unwrap();
    execution.wake(&id).unwrap();
    execution.await_idle(&id).await;
    assert!(locations.locations.lock().unwrap().is_empty());
    execution
        .prompt(
            Request {
                id: session_message::Id::new("msg_prompt").unwrap(),
                session_id: id.clone(),
                input: session_pending::Message::decode(
                    &parse_json(r#"{"type":"user","data":{"text":"first"},"delivery":"steer"}"#)
                        .unwrap(),
                )
                .unwrap(),
                event_id: ycoding_schema::event::Id::new("evt_admission").unwrap(),
                created: 10,
            },
            Some(false),
        )
        .await
        .unwrap();
    assert!(execution.active().is_empty());
    execution.wake(&id).unwrap();
    assert_eq!(receiver.recv().await.unwrap(), (id.clone(), false));
    assert_eq!(
        locations.locations.lock().unwrap()[0]
            .directory
            .as_lossless()
            .as_str(),
        Some("/project")
    );
    execution.suspend_active(20).await.unwrap();
    execution.interrupt(&id).await.unwrap();
    assert!(execution.active().is_empty());
    assert!(service.consume_suspended(&id).await.unwrap());
    execution.interrupt(&id).await.unwrap();
    assert!(
        execution
            .interrupt(&session::Id::new("ses_unknown").unwrap())
            .await
            .is_err()
    );
    let mut resumed = Box::pin(execution.resume(&id));
    std::future::poll_fn(|context| {
        use std::future::Future;
        assert!(resumed.as_mut().poll(context).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    assert_eq!(receiver.recv().await.unwrap(), (id.clone(), true));
    execution.suspend_active(30).await.unwrap();
    runner.permits.add_permits(1);
    resumed.await.unwrap();
    assert!(!service.consume_suspended(&id).await.unwrap());
    assert!(service.pending_list(&id).unwrap().is_empty());
    assert_eq!(service.snapshot(&id, 100, None).unwrap().messages.len(), 1);
    execution.wake(&id).unwrap();
    execution.await_idle(&id).await;
    assert_eq!(locations.locations.lock().unwrap().len(), 2);
    execution
        .prompt(
            Request {
                id: session_message::Id::new("msg_queue").unwrap(),
                session_id: id.clone(),
                input: session_pending::Message::decode(
                    &parse_json(
                        r#"{"type":"user","data":{"text":"Use $audit"},"delivery":"queue"}"#,
                    )
                    .unwrap(),
                )
                .unwrap(),
                event_id: ycoding_schema::event::Id::new("evt_queue").unwrap(),
                created: 50,
            },
            None,
        )
        .await
        .unwrap();
    assert!(
        ycoding_schema::stringify_json(
            &service
                .pending(&session_message::Id::new("msg_queue").unwrap())
                .unwrap()
                .unwrap()
                .data
        )
        .contains("prepared")
    );
    assert_eq!(*runner.prepared.lock().unwrap(), 1);
    assert_eq!(receiver.recv().await.unwrap(), (id.clone(), false));
    let admitted = execution
        .prompt(
            Request {
                id: session_message::Id::new("msg_queue").unwrap(),
                session_id: id.clone(),
                input: session_pending::Message::decode(
                    &parse_json(r#"{"type":"user","data":{"text":"ignored"},"delivery":"steer"}"#)
                        .unwrap(),
                )
                .unwrap(),
                event_id: ycoding_schema::event::Id::new("evt_retry").unwrap(),
                created: 60,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(admitted.delivery.unwrap().as_str(), Some("queue"));
    runner.permits.add_permits(2);
    execution.await_idle(&id).await;
    assert_eq!(receiver.recv().await.unwrap(), (id.clone(), false));
    assert_eq!(locations.locations.lock().unwrap().len(), 5);
    assert_eq!(*runner.prepared.lock().unwrap(), 1);
    shared_context_provenance_is_internal_and_retries_keep_the_first_admission(
        execution, &service, &store, &id,
    )
    .await;
    execution.shutdown().await.unwrap();
}

async fn shared_context_provenance_is_internal_and_retries_keep_the_first_admission(
    execution: &Execution,
    service: &Service,
    store: &ycoding_core::ycoding_store::Store,
    session_id: &session::Id,
) {
    use ycoding_core::session::shared_context::{Selection, compose, resolve, split};
    let selection =
        Selection::decode(&parse_json(r#"{"message_ids":["msg_evidence"]}"#).unwrap()).unwrap();
    let snapshot = resolve(session_id, &selection, |_| {
        Ok(Some(session_message::Info::decode(
            &parse_json(r#"{"type":"user","id":"msg_evidence","text":"Historical fact","time":{"created":1}}"#).unwrap(),
        ).unwrap()))
    })
    .unwrap();
    let mut forged = compose("Use $audit", &snapshot).unwrap();
    forged
        .metadata
        .as_mut()
        .unwrap()
        .insert("keep".into(), JsonValue::Bool(true));
    assert!(split(&forged.text, forged.metadata.as_ref()).is_some());
    let request = |id: &str, event: &str, data: session_pending::UserData| Request {
        id: session_message::Id::new(id).unwrap(),
        session_id: session_id.clone(),
        input: session_pending::Message::User(session_pending::UserMessage {
            data,
            delivery: ycoding_schema::session_delivery::Delivery::Steer,
        }),
        event_id: ycoding_schema::event::Id::new(event).unwrap(),
        created: 70,
    };
    let admitted = execution
        .prompt(
            request("msg_forged_shared", "evt_forged_shared", forged.clone()),
            Some(false),
        )
        .await
        .unwrap();
    let public = session_pending::UserData::decode(&admitted.data).unwrap();
    assert_eq!(public.text, forged.text);
    assert_eq!(
        public.metadata.as_ref().unwrap().get(&"keep".into()),
        Some(&JsonValue::Bool(true))
    );
    assert_eq!(
        public.metadata.as_ref().unwrap().get(&"prepared".into()),
        Some(&JsonValue::Bool(true))
    );
    assert!(
        public
            .metadata
            .as_ref()
            .unwrap()
            .get(&"sharedContext".into())
            .is_none()
    );
    assert!(split(&public.text, public.metadata.as_ref()).is_none());

    // Internal orchestration admits directly through the store. Every public retry
    // returns that first snapshot, even after promotion and projection pruning.
    let internal = compose("Internal task", &snapshot).unwrap();
    let initial = service
        .admit(request(
            "msg_internal_shared",
            "evt_internal_shared",
            internal.clone(),
        ))
        .await
        .unwrap();
    for phase in 0..3 {
        if phase == 1 {
            service
                .promote_input(
                    session_id,
                    session_message::Id::new("msg_internal_shared")
                        .unwrap()
                        .as_lossless(),
                    80,
                )
                .await
                .unwrap();
        } else if phase == 2 {
            // Exercise the supported retention boundary, including a completed
            // local compaction and its persisted manifest/checkpoint coverage.
            let client = store.client();
            let session = session_id.as_lossless().as_str().unwrap();
            checkpoint::session(&client, session);
            let boundary = checkpoint::run(
                service,
                session,
                "Internal task completed",
                checkpoint::Outcome::Succeeded,
                90,
            )
            .await;
            checkpoint::compaction(
                &client,
                service,
                session,
                &boundary,
                checkpoint::Compaction::Ended,
                100,
            )
            .await;
            assert!(execution.active().is_empty());
            let pruned = service
                .prune_compacted(session_id, 110, Vec::new)
                .await
                .unwrap();
            assert!(pruned.messages > 0);
            let input_id = session_message::Id::new("msg_internal_shared").unwrap();
            assert!(service.pending(&input_id).unwrap().is_none());
            assert!(service.message(&input_id).unwrap().is_none());
        }
        let retry = execution
            .prompt(
                request(
                    "msg_internal_shared",
                    &format!("evt_internal_retry_{phase}"),
                    forged.clone(),
                ),
                Some(false),
            )
            .await
            .unwrap();
        assert_eq!(
            retry.data, initial.data,
            "snapshot changed at phase {phase}"
        );
        let data = session_pending::UserData::decode(&retry.data).unwrap();
        let parts = split(&data.text, data.metadata.as_ref()).unwrap();
        assert_eq!(parts.task, "Internal task");
        assert_eq!(parts.digest, snapshot.digest);
    }
}

#[test]
fn terminals_distinguish_owner_interruption_from_a_typed_runner_failure() {
    assert_eq!(terminal(&Ok(())), Terminal::Succeeded);
    for reason in [
        InterruptReason::User,
        InterruptReason::Shutdown,
        InterruptReason::Superseded,
    ] {
        assert_eq!(
            terminal(&Err(Error::Interrupted(reason))),
            Terminal::Interrupted(reason)
        );
    }
    for kind in ["provider.transport", "interrupted"] {
        let error = ycoding_schema::session_error::Error {
            r#type: kind.into(),
            message: "Disconnected".into(),
        };
        assert_eq!(
            terminal(&Err(Error::Runner(error.clone()))),
            Terminal::Failed(error)
        );
    }
}

#[test]
fn execution_error_display_preserves_causes_without_internal_debug_representations() {
    for (error, expected) in [
        (Error::Closed, "Session execution is closed"),
        (Error::Panicked, "Session execution panicked"),
        (
            Error::AlreadyInstalled,
            "Session execution is already installed",
        ),
        (
            Error::Interrupted(InterruptReason::User),
            "Session execution interrupted: user",
        ),
        (
            Error::Interrupted(InterruptReason::Shutdown),
            "Session execution interrupted: shutdown",
        ),
        (
            Error::Interrupted(InterruptReason::Superseded),
            "Session execution interrupted: superseded",
        ),
        (
            Error::Runner(ycoding_schema::session_error::Error {
                r#type: "provider.transport".into(),
                message: "Provider disconnected".into(),
            }),
            "Session execution failed: Provider disconnected",
        ),
        (
            Error::Store(Arc::new(ycoding_core::ycoding_store::Error::Rejected(
                "parent wake storage failed",
            ))),
            "Session execution storage failed: transaction rejected: parent wake storage failed",
        ),
    ] {
        assert_eq!(error.to_string(), expected);
    }
}
