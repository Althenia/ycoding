use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use ycoding_core::{
    process::guardrails::decision::{EvaluateFuture, Evaluator},
    resources::decision::{self, Invocation},
};
use ycoding_schema::{JsonValue, session, session_message};

type Seen = (JsonValue, session::Id, Option<session_message::Id>);

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
        self.seen.lock().unwrap().push((
            input,
            invocation.session_id.clone(),
            invocation.input_id.cloned(),
        ));
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected helper call");
        Box::pin(async move { reply })
    }
}
