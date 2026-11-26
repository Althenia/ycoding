use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;
use ycoding_core::session::{
    execution::{Execution, Locations, Runner},
    pending::Request,
    run_coordinator::{DrainRequest, Error, RunFuture},
    store::Service,
};
use ycoding_schema::{
    DomainDecode, parse_json, session, session_error, session_message, session_pending,
};

#[path = "session_support/mod.rs"]
mod support;

struct Failing {
    drains: Arc<Mutex<Vec<String>>>,
    gate: Arc<Semaphore>,
    blocked: Arc<Mutex<bool>>,
}

impl Runner for Failing {
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let drains = self.drains.clone();
        let gate = self.gate.clone();
        let blocked = *self.blocked.lock().unwrap();
        Box::pin(async move {
            drains.lock().unwrap().push(
                request
                    .session_id
                    .as_lossless()
                    .to_utf8()
                    .unwrap_or_default(),
            );
            if blocked {
                gate.acquire().await.unwrap().forget();
            }
            Err(Error::Runner(session_error::Error {
                r#type: "provider.test".into(),
                message: "Synthetic pre-promotion failure".into(),
            }))
        })
    }
}

struct LocationMap {
    runner: Arc<Failing>,
}

impl Locations for LocationMap {
    fn get(&self, _session: &ycoding_schema::session::Info) -> Result<Arc<dyn Runner>, Error> {
        Ok(self.runner.clone())
    }
}

fn input(session_id: &str, name: &str, created: i64) -> Request {
    Request {
        id: session_message::Id::new(format!("msg_{name}")).unwrap(),
        session_id: session::Id::new(session_id).unwrap(),
        input: session_pending::Message::decode(
            &parse_json(r#"{"type":"user","data":{"text":"pending"},"delivery":"steer"}"#).unwrap(),
        )
        .unwrap(),
        event_id: ycoding_schema::event::Id::new(format!("evt_{name}")).unwrap(),
        created,
    }
}

async fn prompt(execution: &Execution, session_id: &str, name: &str, created: i64) {
    execution
        .prompt(input(session_id, name, created), Some(false))
        .await
        .unwrap();
}

#[tokio::test]
async fn pre_promotion_failure_reschedules_a_bounded_successor_drain() {
    let store = support::store();
    let service = Service::new(store.client());
    let drains = Arc::new(Mutex::new(Vec::new()));
    let gate = Arc::new(Semaphore::new(0));
    let blocked = Arc::new(Mutex::new(false));
    let runner = Arc::new(Failing {
        drains: drains.clone(),
        gate: gate.clone(),
        blocked: blocked.clone(),
    });
    let execution = Execution::install(
        service.clone(),
        Arc::new(LocationMap {
            runner: runner.clone(),
        }),
        ycoding_core::job::Jobs::new(),
        None,
    )
    .unwrap();
    let count = |session_id: &str| {
        drains
            .lock()
            .unwrap()
            .iter()
            .filter(|id| id.as_str() == session_id)
            .count()
    };
    let one = session::Id::new("ses_one").unwrap();
    prompt(execution, "ses_one", "first", 10).await;
    execution.wake(&one).unwrap();
    execution.await_idle(&one).await;
    assert_eq!(count("ses_one"), 4);
    assert_eq!(service.pending_list(&one).unwrap().len(), 1);

    prompt(execution, "ses_one", "second", 20).await;
    execution.wake(&one).unwrap();
    execution.await_idle(&one).await;
    assert_eq!(count("ses_one"), 8);
    assert_eq!(service.pending_list(&one).unwrap().len(), 2);

    let two = session::Id::new("ses_two").unwrap();
    *blocked.lock().unwrap() = true;
    prompt(execution, "ses_two", "third", 30).await;
    execution.wake(&two).unwrap();
    for _ in 0..1000 {
        if count("ses_two") == 1 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(count("ses_two"), 1);
    execution.request_interrupt(&two).unwrap();
    gate.add_permits(1);
    execution.await_idle(&two).await;
    assert_eq!(count("ses_two"), 1);
    execution.shutdown().await.unwrap();
    let request = input("ses_two", "accepted_after_shutdown", 40);
    let result = execution.prompt(request.clone(), None).await;
    let admitted = service.pending(&request.id).unwrap().unwrap();
    assert_eq!(result.unwrap(), admitted);
    assert_eq!(execution.prompt(request, None).await.unwrap(), admitted);
    assert_eq!(service.pending_list(&two).unwrap().len(), 2);
}
