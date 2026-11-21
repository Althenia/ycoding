include!("../policy_fixture.rs");

use std::sync::Arc;
use tokio::sync::mpsc;
use ycoding_core::{
    resources::decision,
    session::{review, store},
    tools::policy::{Event, Publisher, Reviews},
};
use ycoding_schema::{JsonValue, session};

pub fn response(answer: &str) -> Result<JsonValue, decision::Error> {
    Ok(ycoding_schema::parse_json(&format!(
        r#"{{"provider":"agent","response":{{"model":{{"providerID":"local","id":"judge"}},"semantics":"model-estimate","version":1,"answers":[{answer}]}}}}"#
    )).unwrap())
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
    pub publish: Publisher,
    _events: tokio::sync::Mutex<mpsc::UnboundedReceiver<Event>>,
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
            fixture,
            publish: Arc::new(move |event| {
                publish(event.clone())?;
                sender
                    .send(event)
                    .map_err(|_| "test event receiver closed".to_owned())
            }),
            _events: tokio::sync::Mutex::new(receiver),
        }
    }

    pub fn review_policy(&self) -> Reviews {
        Reviews {
            service: self.reviews.clone(),
            limit: 16,
        }
    }
}
