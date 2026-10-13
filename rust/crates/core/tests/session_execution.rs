use std::sync::{Arc, Mutex};
use tokio::sync::{Semaphore, mpsc};
use ycoding_core::session::{
    execution::{Execution, Locations, Runner, Terminal, terminal},
    pending::Request,
    run_coordinator::{DrainRequest, Error, InterruptReason, RunFuture},
    store::Service,
};
use ycoding_schema::{
    DomainDecode, location, parse_json, session, session_message, session_pending,
};

#[path = "session_support/mod.rs"]
mod support;

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
}
impl Runner for Gate {
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
    });
    let locations = Arc::new(LocationMap {
        locations: Arc::new(Mutex::new(Vec::new())),
        runner: runner.clone(),
    });
    let jobs = ycoding_core::job::Jobs::new();
    let execution = Execution::install(service.clone(), locations.clone(), jobs.clone()).unwrap();
    assert!(std::ptr::eq(execution, Execution::global().unwrap()));
    assert!(matches!(
        Execution::install(service.clone(), locations.clone(), jobs),
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
                    &parse_json(r#"{"type":"user","data":{"text":"queued"},"delivery":"queue"}"#)
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
    assert_eq!(locations.locations.lock().unwrap().len(), 4);
    execution.shutdown().await.unwrap();
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
