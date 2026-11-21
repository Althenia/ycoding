use super::{Clock, Error, error};
use crate::{
    event_feed::{self, Payload},
    session::autonomy::{FailureCause, Service},
    tools::code_mode::Cancellation,
};
use std::{
    collections::BTreeSet,
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
};
use ycoding_schema::{DomainEncode, JsonValue, LosslessString, session};
use ycoding_store::{Client, session::TaskTable};

#[derive(Clone)]
pub(super) struct Stall {
    pub seconds: u64,
    owner: session::Id,
    session: session::Id,
    autonomy: Service,
}

impl Stall {
    pub fn new(
        client: &Client,
        session: &session::Id,
        seconds: u64,
    ) -> Result<Option<Self>, Error> {
        if client
            .snapshot()
            .and_then(|snapshot| {
                snapshot.get::<ycoding_store::session::SessionTable>(&crate::session::key(
                    session.as_lossless(),
                ))
            })
            .map_err(|cause| error("goal.state", &cause.to_string()))?
            .is_some_and(|session| session.scope.as_str() == Some("standalone"))
        {
            return Ok(None);
        }
        let autonomy = Service::new(client.clone());
        Ok(autonomy
            .goal_owner(session)
            .map_err(|cause| error("goal.state", &cause.to_string()))?
            .map(|owner| Self {
                seconds,
                owner,
                session: session.clone(),
                autonomy,
            }))
    }

    pub async fn record(&self, class: &str, unit: &str) -> Result<(), Error> {
        let cause = (self.owner == self.session).then(|| FailureCause {
            fingerprint: format!("{class}:{unit}").into(),
            class: class.into(),
            unit: unit.into(),
        });
        self.autonomy
            .record_stall(&self.owner, cause)
            .await
            .map_err(|cause| error("goal.state", &cause.to_string()))?;
        Ok(())
    }

    pub async fn resolve(&self, tool: Option<&str>) -> Result<(), Error> {
        if self.owner == self.session {
            self.autonomy
                .resolve_failure(&self.owner, tool)
                .await
                .map_err(|cause| error("goal.state", &cause.to_string()))?;
        }
        Ok(())
    }
}

pub(super) struct Activity {
    clock: Arc<dyn Clock>,
    last: AtomicI64,
}
impl Activity {
    pub fn new(clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self {
            last: AtomicI64::new(clock.now()),
            clock,
        })
    }
    pub fn touch(&self) {
        self.last.store(self.clock.now(), Ordering::Release);
    }
    pub async fn watch<T>(
        &self,
        future: impl Future<Output = T>,
        millis: u64,
        mut waiting: impl FnMut() -> Result<bool, Error>,
    ) -> Result<Option<T>, Error> {
        tokio::pin!(future);
        loop {
            let elapsed = self
                .clock
                .now()
                .saturating_sub(self.last.load(Ordering::Acquire))
                .max(0) as u64;
            if elapsed >= millis {
                if !waiting()? {
                    return Ok(None);
                }
                self.touch();
                continue;
            }
            tokio::select! {
                biased;
                result = &mut future => return Ok(Some(result)),
                () = self.clock.sleep(millis - elapsed) => {},
            }
        }
    }
}

pub(super) struct Requests {
    subscriber: event_feed::Subscriber,
    open: BTreeSet<LosslessString>,
    client: Client,
    session: session::Id,
}

impl Requests {
    pub fn new(
        events: &event_feed::Feed,
        client: Client,
        session: session::Id,
    ) -> Result<Arc<Mutex<Self>>, Error> {
        let subscriber = events
            .subscribe(event_feed::Scope::Session(session.clone()), None, || {})
            .map_err(|_| error("goal.state", "Unable to observe goal waits"))?;
        Ok(Arc::new(Mutex::new(Self {
            subscriber,
            open: BTreeSet::new(),
            client,
            session,
        })))
    }
    pub fn waiting(&mut self) -> Result<bool, Error> {
        while let Some(item) = self
            .subscriber
            .next()
            .map_err(|_| error("goal.state", "Goal wait event buffer overflowed"))?
        {
            let (name, data) = match &item.payload {
                Payload::Ephemeral(event) => (event.data.name(), event.data.encode()),
                Payload::Durable(event) => (
                    event
                        .type_
                        .as_str()
                        .unwrap_or_default()
                        .trim_end_matches(".1"),
                    event.data.clone(),
                ),
            };
            self.observe(name, &data);
        }
        Ok(!self.open.is_empty()
            || self
                .client
                .snapshot()?
                .get::<TaskTable>(&crate::session::key(self.session.as_lossless()))?
                .is_some_and(|task| task.state.as_str() == Some("waiting")))
    }
    fn observe(&mut self, name: &str, data: &JsonValue) {
        let field = crate::session::autonomy::verification::field;
        let id = |value: &JsonValue, key: &str| match field(value, key) {
            Some(JsonValue::String(id)) => Some(id.clone()),
            _ => None,
        };
        if name == "form.created" {
            if let Some(form) = field(data, "form")
                && let Some(id) = id(form, "id")
            {
                self.open.insert(id);
            }
            return;
        }
        if matches!(
            name,
            "permission.asked" | "question.asked" | "guardrail.asked"
        ) {
            if let Some(id) = id(data, "id") {
                self.open.insert(id);
            }
        } else if matches!(
            name,
            "permission.replied"
                | "permission.deferred"
                | "permission.cancelled"
                | "question.replied"
                | "question.rejected"
                | "question.timed_out"
                | "question.deferred"
                | "guardrail.replied"
                | "guardrail.deferred"
                | "guardrail.cancelled"
                | "form.replied"
                | "form.cancelled"
                | "form.timed_out"
                | "form.deferred"
        ) && let Some(id) = id(data, "requestID").or_else(|| id(data, "id"))
        {
            self.open.remove(&id);
        }
    }
}

pub(super) struct CancelOnDrop(pub Cancellation);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ycoding_schema::parse_json;

    #[test]
    fn native_wait_events_hold_the_clock_until_the_request_settles() {
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::native::catalog(ycoding_store::native::DatabaseKind::Core),
            ycoding_store::Metadata::new([7; 16], 1),
        )
        .unwrap();
        let feed = event_feed::Feed::attach(&store.client());
        let requests =
            Requests::new(&feed, store.client(), session::Id::new("ses_one").unwrap()).unwrap();
        for (opened, opening, closed, closing) in [
            (
                "permission.asked",
                r#"{"id":"per_wait","sessionID":"ses_one","action":"edit","resources":["parser.rs"]}"#,
                "permission.replied",
                r#"{"sessionID":"ses_one","requestID":"per_wait","reply":"once"}"#,
            ),
            (
                "question.asked",
                r#"{"id":"que_wait","sessionID":"ses_one","questions":[]}"#,
                "question.rejected",
                r#"{"sessionID":"ses_one","requestID":"que_wait"}"#,
            ),
            (
                "guardrail.asked",
                r#"{"id":"grq_wait","sessionID":"ses_one","rootSessionID":"ses_one","action":"edit","resources":[],"ruleIDs":[],"reason":"review","standard":true}"#,
                "guardrail.replied",
                r#"{"rootSessionID":"ses_one","sessionID":"ses_one","requestID":"grq_wait","reply":"once"}"#,
            ),
            (
                "form.created",
                r#"{"form":{"id":"frm_wait","sessionID":"ses_one","title":"Plan","fields":[{"key":"plan","type":"string","required":true}]}}"#,
                "form.cancelled",
                r#"{"sessionID":"ses_one","id":"frm_wait"}"#,
            ),
        ] {
            feed.emit(
                event_feed::Data::decode(opened, &parse_json(opening).unwrap()).unwrap(),
                None,
            )
            .unwrap();
            assert!(requests.lock().unwrap().waiting().unwrap(), "{opened}");
            feed.emit(
                event_feed::Data::decode(closed, &parse_json(closing).unwrap()).unwrap(),
                None,
            )
            .unwrap();
            assert!(!requests.lock().unwrap().waiting().unwrap(), "{closed}");
        }
    }
}
