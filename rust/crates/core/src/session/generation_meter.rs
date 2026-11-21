use super::usage::{GenerationTimes, generation_timing};
use std::collections::{BTreeSet, VecDeque};
use ycoding_ai::llm;
use ycoding_schema::{
    JsonValue, LosslessString, ObjectEncoder, model, provider_request, stringify_json,
};

const WINDOW: u64 = 5_000_000_000;
const MINIMUM: u64 = 1_000_000_000;
const SPACING: u64 = 250_000_000;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Failed,
    Cancelled,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Phase,
    Output,
}

#[derive(Clone, Copy)]
struct Point {
    time: u64,
    tokens: u64,
}

pub struct Meter {
    pub request_id: provider_request::Id,
    pub attempt: u32,
    pub model: model::Ref,
    started: u64,
    now: u64,
    phase: &'static str,
    characters: u64,
    first_output: Option<u64>,
    last_output: Option<u64>,
    ended: Option<u64>,
    origin: Option<Point>,
    latest: Option<Point>,
    points: VecDeque<Point>,
    streamed: BTreeSet<LosslessString>,
    completed: BTreeSet<LosslessString>,
    usage: Option<llm::Usage>,
    frozen: bool,
    registration: Option<crate::generation_activity::Registration>,
}

impl Meter {
    pub fn new(
        request_id: provider_request::Id,
        attempt: u32,
        model: model::Ref,
        started_ns: u64,
    ) -> Self {
        Self {
            request_id,
            attempt,
            model,
            started: started_ns,
            now: started_ns,
            phase: "preparing",
            characters: 0,
            first_output: None,
            last_output: None,
            ended: None,
            origin: None,
            latest: None,
            points: VecDeque::new(),
            streamed: BTreeSet::new(),
            completed: BTreeSet::new(),
            usage: None,
            frozen: false,
            registration: None,
        }
    }

    pub fn phase(&self) -> &'static str {
        self.phase
    }
    pub fn terminal(&self) -> bool {
        matches!(self.phase, "completed" | "failed" | "cancelled")
    }
    pub fn output_tokens(&self) -> u64 {
        self.characters.saturating_add(2) / 4
    }
    pub fn last_output_ns(&self) -> Option<u64> {
        self.last_output
    }

    pub(crate) fn attach(&mut self, registration: crate::generation_activity::Registration) {
        self.registration = Some(registration);
    }

    pub(crate) fn registration(&self) -> Option<&crate::generation_activity::Registration> {
        self.registration.as_ref()
    }

    fn publish(&self) {
        if let Some(registration) = &self.registration {
            registration.service.update(self, self.now);
        }
    }

    pub fn waiting(&mut self, time: u64) {
        if self.phase == "preparing" && !self.frozen {
            self.now = self.now.max(time);
            self.phase = "waiting";
            self.publish();
        }
    }

    pub fn observe(&mut self, event: &llm::Event, time: u64) -> Option<Change> {
        if self.terminal() || self.frozen {
            return None;
        }
        self.now = self.now.max(time);
        if let llm::Event::StepFinish { finish, .. } = event {
            self.usage = finish.usage.clone();
            self.ended = Some(self.now);
            self.frozen = true;
            self.publish();
            return None;
        }
        if matches!(event, llm::Event::ProviderError { .. }) {
            self.ended.get_or_insert(self.now);
            self.publish();
            return None;
        }
        let (length, next) = match event {
            llm::Event::TextDelta(delta) => (
                delta.text.len() as u64,
                (!delta.text.is_empty()).then_some("streaming"),
            ),
            llm::Event::ReasoningDelta(delta) => (
                delta.text.len() as u64,
                (!delta.text.is_empty()).then_some("reasoning"),
            ),
            llm::Event::ToolInputDelta { id, text, .. } => {
                if !text.is_empty() {
                    self.streamed.insert(id.clone());
                }
                (text.len() as u64, (!text.is_empty()).then_some("streaming"))
            }
            llm::Event::ToolCall(call) => {
                let length = if self.completed.insert(call.id.clone())
                    && !self.streamed.contains(&call.id)
                {
                    stringify_json(&call.input).encode_utf16().count() as u64
                } else {
                    0
                };
                (length, Some("tool"))
            }
            _ => (0, None),
        };
        let changed = next.is_some_and(|next| next != self.phase);
        if let Some(next) = next {
            self.phase = next;
        }
        if length > 0 {
            self.characters = self.characters.saturating_add(length);
            let point = Point {
                time: self.now,
                tokens: self.output_tokens(),
            };
            if self.points.back().is_some_and(|last| {
                last.time == point.time
                    || (self.points.len() > 1
                        && point.time - self.points[self.points.len() - 2].time < SPACING)
            }) {
                self.points.pop_back();
            }
            self.points.push_back(point);
            while self.points.len() > 2
                && self.points[1].time <= point.time.saturating_sub(WINDOW)
                && point.time >= WINDOW
            {
                self.points.pop_front();
            }
            if self.origin.is_none_or(|origin| origin.time == point.time) {
                self.origin = Some(point);
            }
            self.latest = Some(point);
            self.last_output = Some(self.now);
            self.first_output.get_or_insert(self.now);
        }
        self.publish();
        if changed {
            Some(Change::Phase)
        } else if length > 0 {
            Some(Change::Output)
        } else {
            None
        }
    }

    pub fn settle(&mut self, outcome: Outcome, time: u64) -> bool {
        if self.terminal() {
            return false;
        }
        self.now = self.now.max(time);
        self.ended.get_or_insert(self.now);
        self.phase = outcome.as_str();
        self.publish();
        true
    }

    pub fn live(&self) -> JsonValue {
        let sample = self.speed(interval(
            self.points.front().copied(),
            self.points.back().copied(),
        ));
        let final_sample = self
            .terminal()
            .then(|| self.speed(interval(self.origin, self.latest)))
            .flatten();
        ObjectEncoder::new()
            .field("requestID", &self.request_id)
            .field("attempt", &(self.attempt as f64))
            .field("phase", self.phase)
            .optional(
                "firstOutputMs",
                &self
                    .first_output
                    .map(|first| ((first - self.started) / 1_000_000) as f64),
            )
            .optional("sample", &sample)
            .optional("final", &final_sample)
            .finish()
    }

    pub fn recorded_timing(&self, consented: bool) -> Option<JsonValue> {
        let timing = self.timing();
        if !consented {
            return timing;
        }
        let mut fields = match timing {
            Some(JsonValue::Object(fields)) => fields,
            _ => ycoding_schema::JsonObject::new(),
        };
        let millis =
            |end: u64| JsonValue::Number((end.saturating_sub(self.started) / 1_000_000) as f64);
        if let Some(first) = self.first_output {
            fields.insert("firstOutputMs".into(), millis(first));
        }
        fields.insert("totalMs".into(), millis(self.ended.unwrap_or(self.now)));
        fields.insert("retryWaitMs".into(), JsonValue::Number(0.0));
        Some(JsonValue::Object(fields))
    }

    pub fn timing(&self) -> Option<JsonValue> {
        let generation = generation_timing(
            self.usage.as_ref(),
            &GenerationTimes {
                started: Some(self.started),
                text: self.first_output,
                ended: Some(self.ended.unwrap_or(self.now)),
                streamed_output_units: self.characters,
                ..Default::default()
            },
        );
        let received = interval(self.origin, self.latest);
        let provider = super::usage::timing(self.usage.as_ref());
        if generation.is_none() && received.is_none() && provider.is_none() {
            return None;
        }
        let mut object = ObjectEncoder::new();
        for value in [provider, generation].into_iter().flatten() {
            if let JsonValue::Object(fields) = value {
                for (key, value) in fields.iter() {
                    if let Some(key) = key.as_str() {
                        object = object.field(key, value);
                    }
                }
            }
        }
        Some(
            object
                .optional(
                    "receivedOutput",
                    &received.map(|(tokens, duration)| {
                        ObjectEncoder::new()
                            .field("estimatedTokens", &(tokens as f64))
                            .field("durationNs", &(duration as f64))
                            .finish()
                    }),
                )
                .finish(),
        )
    }

    fn speed(&self, received: Option<(u64, u64)>) -> Option<JsonValue> {
        received.map(|(tokens, duration)| {
            ObjectEncoder::new()
                .field("model", &self.model)
                .field("tokens", &(tokens as f64))
                .field("durationNs", &(duration as f64))
                .field("tokensPerSecond", &(tokens as f64 * 1e9 / duration as f64))
                .field("estimated", &true)
                .finish()
        })
    }
}

impl Drop for Meter {
    fn drop(&mut self) {
        if let Some(registration) = &self.registration {
            registration.service.remove(self, (registration.clock)());
        }
    }
}

fn interval(first: Option<Point>, last: Option<Point>) -> Option<(u64, u64)> {
    let (first, last) = first.zip(last)?;
    let duration = last.time.checked_sub(first.time)?;
    let tokens = last.tokens.checked_sub(first.tokens)?;
    ((MINIMUM..=MAX_SAFE).contains(&duration) && tokens > 0 && tokens <= MAX_SAFE)
        .then_some((tokens, duration))
}
