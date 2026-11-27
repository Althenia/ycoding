use super::{projector, runner::Clock, store::Service};
use crate::harness::{Detail, Event, Events, Mode, Stage};
use std::sync::Arc;
use tokio::sync::mpsc;
use ycoding_schema::{
    JsonValue, LosslessString, ObjectEncoder, harness as schema, schema::NonNegativeInt,
};
use ycoding_store::{Error, session::NewEvent};

fn stage(stage: Stage) -> schema::Stage {
    match stage {
        Stage::Baseline => schema::Stage::Baseline,
        Stage::Propose => schema::Stage::Propose,
        Stage::Probe => schema::Stage::Probe,
        Stage::Compose => schema::Stage::Compose,
        Stage::Adopt => schema::Stage::Adopt,
    }
}

fn mode(mode: Mode) -> schema::Mode {
    match mode {
        Mode::Adaptive => schema::Mode::Adaptive,
        Mode::Parallel => schema::Mode::Parallel,
        Mode::Sequential => schema::Mode::Sequential,
        Mode::Disabled => schema::Mode::Disabled,
    }
}

fn bounded(text: &str, limit: usize) -> LosslessString {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    LosslessString::from(&text[..end])
}

fn count(value: u64) -> Result<NonNegativeInt, Error> {
    NonNegativeInt::new(value.min(9_007_199_254_740_991) as i64)
        .map_err(|_| Error::Rejected("Invalid harness count"))
}

fn identifier(text: &str) -> Result<LosslessString, Error> {
    if text.is_empty() {
        return Err(Error::Rejected("Empty harness identifier"));
    }
    Ok(bounded(text, 128))
}

pub fn data(event: &Event) -> Result<Option<(&'static str, JsonValue)>, Error> {
    let base = || ObjectEncoder::new().field("sessionID", &event.session);
    let evaluated = |signals: u32, insufficient: bool, skipped: Option<LosslessString>| {
        Ok(Some((
            "session.harness.evaluated.1",
            base()
                .field("stage", &stage(event.stage))
                .field("mode", &mode(event.mode))
                .field("signals", &count(signals.into())?)
                .field("insufficient", &insufficient)
                .optional("skipReason", &skipped)
                .finish(),
        )))
    };
    match &event.detail {
        Detail::Skipped(reason) => evaluated(0, false, Some(bounded(reason, 200))),
        Detail::Baseline {
            signals,
            insufficient,
        } => evaluated(*signals, *insufficient, None),
        Detail::Proposed { .. } | Detail::Composed { .. } => Ok(None),
        Detail::Probed {
            candidate,
            outcome,
            tokens,
            latency_ms,
        } => {
            if outcome.is_empty() {
                return Err(Error::Rejected("Empty harness probe outcome"));
            }
            Ok(Some((
                "session.harness.probed.1",
                base()
                    .field("candidate", &identifier(candidate)?)
                    .field("outcome", &bounded(outcome, 64))
                    .field("tokens", &count(*tokens)?)
                    .field("latencyMs", &count(*latency_ms)?)
                    .finish(),
            )))
        }
        Detail::Adopted { version, parent } => Ok(Some((
            "session.harness.adopted.1",
            base()
                .field("version", &identifier(&version.0)?)
                .field("parent", &identifier(&parent.0)?)
                .finish(),
        ))),
        Detail::RolledBack { from, to } => Ok(Some((
            "session.harness.rolled-back.1",
            base()
                .field("from", &identifier(&from.0)?)
                .field("to", &identifier(&to.0)?)
                .finish(),
        ))),
        Detail::Reflected { experiences } => Ok(Some((
            "session.harness.reflected.1",
            base()
                .field(
                    "experiences",
                    &schema::Experiences(
                        experiences
                            .iter()
                            .take(64)
                            .map(|id| identifier(id))
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                )
                .finish(),
        ))),
    }
}

pub async fn record(store: &Service, event: &Event, now: i64) -> Result<(), Error> {
    let Some((type_, data)) = data(event)? else {
        return Ok(());
    };
    let event = NewEvent {
        id: projector::random_event_id()?.as_lossless().clone(),
        aggregate_id: event.session.as_lossless().clone(),
        created: now,
        type_: type_.into(),
        data,
    };
    store
        .client
        .submit(move |tx| {
            projector::append(tx, &event)?;
            Ok(())
        })?
        .await
}

pub struct Emitter {
    sender: mpsc::UnboundedSender<Event>,
}

impl Emitter {
    pub fn spawn(store: Service, clock: Arc<dyn Clock>) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<Event>();
        tokio::spawn(async move {
            while let Some(event) = receiver.recv().await {
                if let Err(error) = record(&store, &event, clock.now()).await {
                    tracing::warn!(%error, "harness event was not recorded");
                }
            }
        });
        Self { sender }
    }
}

impl Events for Emitter {
    fn emit(&self, event: Event) {
        let _ = self.sender.send(event);
    }
}
