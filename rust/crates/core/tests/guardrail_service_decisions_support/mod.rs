include!("../policy_fixture.rs");

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;
use ycoding_core::{
    process::guardrails::decision::{EvaluateFuture, Evaluator},
    resources::decision::{self, Invocation},
    session::{autonomy, review, store},
    tools::policy::{Event, Publisher, Reviews},
};
use ycoding_schema::{JsonValue, session, session_message};

pub struct Seen {
    pub input: JsonValue,
    pub session_id: session::Id,
    pub input_id: Option<session_message::Id>,
}

pub struct Fake {
    pub replies: Mutex<VecDeque<Result<JsonValue, decision::Error>>>,
    pub seen: Mutex<Vec<Seen>>,
}

impl Fake {
    pub fn new(replies: Vec<Result<JsonValue, decision::Error>>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            seen: Mutex::new(vec![]),
        })
    }
}

impl Evaluator for Fake {
    fn evaluate<'a>(&'a self, input: JsonValue, invocation: Invocation<'a>) -> EvaluateFuture<'a> {
        self.seen.lock().unwrap().push(Seen {
            input,
            session_id: invocation.session_id.clone(),
            input_id: invocation.input_id.cloned(),
        });
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected helper call");
        Box::pin(async move { reply })
    }
}

pub fn response(answer: &str) -> Result<JsonValue, decision::Error> {
    Ok(ycoding_schema::parse_json(&format!(
        r#"{{"provider":"agent","response":{{"model":{{"providerID":"local","id":"judge"}},"semantics":"model-estimate","version":1,"answers":[{answer}]}}}}"#
    )).unwrap())
}

pub fn refusal(name: &str) -> Result<JsonValue, decision::Error> {
    response(&format!(
        r#"{{"name":"{name}","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}}"#
    ))
}

struct Delivery;

impl review::Delivery for Delivery {
    fn wake(&self, _: &session::Id) {}

    fn answer_child<'a>(&'a self, _: review::ChildAnswer) -> review::DeliveryFuture<'a> {
        Box::pin(async {
            Err(review::DeliveryError::Conflict(
                "no child delivery in this fixture".into(),
            ))
        })
    }

    fn resolve_recovery<'a>(&'a self, _: review::RecoveryResolution) -> review::DeliveryFuture<'a> {
        Box::pin(async {
            Err(review::DeliveryError::Conflict(
                "no recovery in this fixture".into(),
            ))
        })
    }
}

pub struct Harness {
    pub fixture: Fixture,
    pub reviews: review::Service,
    pub autonomy: autonomy::Service,
    pub publish: Publisher,
    events: tokio::sync::Mutex<mpsc::UnboundedReceiver<Event>>,
}

impl Harness {
    pub fn new() -> Self {
        let fixture = Fixture::default();
        let (sender, receiver) = mpsc::unbounded_channel();
        let publish = fixture.publisher();
        Self {
            reviews: review::Service::new(
                store::Service::new(fixture.store.client()),
                Arc::new(Delivery),
            ),
            autonomy: autonomy::Service::new(fixture.store.client()),
            fixture,
            publish: Arc::new(move |event| {
                publish(event.clone())?;
                sender
                    .send(event)
                    .map_err(|_| "test event receiver closed".to_owned())
            }),
            events: tokio::sync::Mutex::new(receiver),
        }
    }

    pub fn review_policy(&self) -> Reviews {
        Reviews {
            service: self.reviews.clone(),
            limit: 16,
        }
    }

    pub async fn event(&self, kind: &str) -> JsonValue {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut events = self.events.lock().await;
            loop {
                let event = events
                    .recv()
                    .await
                    .expect("publisher closed before settlement");
                if event.type_ == kind {
                    return event.data;
                }
            }
        })
        .await
        .expect("service did not publish the expected boundary event")
    }
}
