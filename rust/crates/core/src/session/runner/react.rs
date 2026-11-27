use crate::session::{projector, store::Service};
use ycoding_ai::llm::FinishReason;
use ycoding_schema::{JsonValue, ObjectEncoder, lifecycle, schema::NonNegativeInt, session};
use ycoding_store::{Error, session::NewEvent};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Observation {
    pub finish: Option<FinishReason>,
    pub assistant_text: bool,
    pub continuation: bool,
    pub recovering: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Continue,
    Recover,
    Complete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Basis {
    ToolResults,
    Answered,
    Truncated,
    Silent,
    Unsettled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub decision: Decision,
    pub basis: Basis,
}

impl Verdict {
    pub fn decision(self) -> lifecycle::Decision {
        match self.decision {
            Decision::Continue => lifecycle::Decision::Continue,
            Decision::Recover => lifecycle::Decision::Recover,
            Decision::Complete => lifecycle::Decision::Complete,
        }
    }

    pub fn basis(self) -> lifecycle::Basis {
        match self.basis {
            Basis::ToolResults => lifecycle::Basis::ToolResults,
            Basis::Answered => lifecycle::Basis::Answered,
            Basis::Truncated => lifecycle::Basis::Truncated,
            Basis::Silent => lifecycle::Basis::Silent,
            Basis::Unsettled => lifecycle::Basis::Unsettled,
        }
    }
}

pub fn evaluate(observation: &Observation, recovered: bool) -> Verdict {
    if observation.continuation {
        return Verdict {
            decision: Decision::Continue,
            basis: Basis::ToolResults,
        };
    }
    let (basis, recoverable) = match observation.finish {
        None => (Basis::Unsettled, !observation.recovering),
        Some(FinishReason::Length) => (Basis::Truncated, false),
        Some(_) if observation.assistant_text => (Basis::Answered, false),
        Some(_) => (Basis::Silent, true),
    };
    Verdict {
        decision: if recoverable && !recovered {
            Decision::Recover
        } else {
            Decision::Complete
        },
        basis,
    }
}

pub struct Step<'a> {
    pub session: &'a session::Id,
    pub number: i64,
    pub verdict: Verdict,
    pub recovery: bool,
    pub recalled: bool,
}

pub async fn record(store: &Service, step: Step<'_>, now: i64) -> Result<(), Error> {
    let data: JsonValue = ObjectEncoder::new()
        .field("sessionID", step.session)
        .field(
            "step",
            &NonNegativeInt::new(step.number.max(0))
                .map_err(|_| Error::Rejected("Invalid lifecycle step"))?,
        )
        .field("decision", &step.verdict.decision())
        .field("basis", &step.verdict.basis())
        .field("recovery", &step.recovery)
        .field("recalled", &step.recalled)
        .finish();
    let event = NewEvent {
        id: projector::random_event_id()?.as_lossless().clone(),
        aggregate_id: step.session.as_lossless().clone(),
        created: now,
        type_: "session.lifecycle.recorded.1".into(),
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
