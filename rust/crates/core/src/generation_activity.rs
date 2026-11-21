use crate::session::generation_meter::Meter;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex, PoisonError},
};
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, ObjectEncoder, model, provider_request, session,
    stringify_json,
};

const WINDOW: u64 = 5_000_000_000;
const SLOT: u64 = 250_000_000;
const BUCKET: i64 = 5000;
const HISTORY: usize = 120;
const MODELS: usize = 50;

#[derive(Clone)]
pub struct Service(Arc<Mutex<State>>);

pub(crate) struct Registration {
    pub(crate) service: Service,
    pub(crate) clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    owner: Arc<()>,
}

struct Entry {
    key: String,
    model: model::Ref,
    tokens: u64,
    last_output: Option<u64>,
    owner: Option<Arc<()>>,
    session: Option<session::Id>,
    order: u64,
    live: JsonValue,
}
struct Slot {
    index: u64,
    key: String,
    model: model::Ref,
    at: u64,
    tokens: u64,
}
struct State {
    wall_ms: i64,
    anchor: u64,
    now: u64,
    bucket: i64,
    tokens: u64,
    peak: usize,
    entries: BTreeMap<(LosslessString, u32), Entry>,
    slots: VecDeque<Slot>,
    history: VecDeque<JsonValue>,
    sequence: u64,
}

impl Service {
    pub fn new(wall_ms: i64, ns: u64) -> Self {
        Self(Arc::new(Mutex::new(State {
            wall_ms,
            anchor: ns,
            now: ns,
            bucket: wall_ms / BUCKET,
            tokens: 0,
            peak: 0,
            entries: BTreeMap::new(),
            slots: VecDeque::new(),
            history: VecDeque::new(),
            sequence: 0,
        })))
    }

    pub fn start(
        &self,
        session: session::Id,
        request_id: provider_request::Id,
        attempt: u32,
        model: model::Ref,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Meter {
        let now = clock();
        let mut meter = Meter::new(request_id, attempt, model, now);
        let owner = Arc::new(());
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.advance(now);
        state.sequence = state.sequence.saturating_add(1);
        let order = state.sequence;
        state.entries.insert(
            (meter.request_id.as_lossless().clone(), meter.attempt),
            Entry {
                key: stringify_json(&meter.model.encode()),
                model: meter.model.clone(),
                tokens: 0,
                last_output: None,
                owner: Some(owner.clone()),
                session: Some(session),
                order,
                live: meter.live(),
            },
        );
        state.peak = state.peak.max(state.entries.len());
        drop(state);
        meter.attach(Registration {
            service: self.clone(),
            clock,
            owner,
        });
        meter
    }

    pub fn active(&self) -> usize {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entries
            .len()
    }

    pub fn live(&self, session: &session::Id) -> Option<JsonValue> {
        self.current(session).map(|(_, live)| live)
    }

    pub(crate) fn current(&self, session: &session::Id) -> Option<(model::Ref, JsonValue)> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entries
            .values()
            .filter(|entry| entry.session.as_ref() == Some(session))
            .max_by_key(|entry| entry.order)
            .map(|entry| (entry.model.clone(), entry.live.clone()))
    }

    pub fn update(&self, meter: &Meter, ns: u64) {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.advance(ns);
        let identity = (meter.request_id.as_lossless().clone(), meter.attempt);
        if !owned(state.entries.get(&identity), meter) {
            return;
        }
        let known = state.entries.remove(&identity);
        if known.is_none() && meter.terminal() {
            return;
        }
        let mut entry = known.unwrap_or_else(|| Entry {
            key: stringify_json(&meter.model.encode()),
            model: meter.model.clone(),
            tokens: 0,
            last_output: None,
            owner: None,
            session: None,
            order: 0,
            live: meter.live(),
        });
        let tokens = meter.output_tokens();
        if tokens > entry.tokens {
            let at = state.now;
            let index = at / SLOT;
            let delta = tokens - entry.tokens;
            match state
                .slots
                .iter_mut()
                .rev()
                .find(|slot| slot.index == index && slot.key == entry.key)
            {
                Some(slot) => {
                    slot.at = at;
                    slot.tokens += delta;
                }
                None => state.slots.push_back(Slot {
                    index,
                    key: entry.key.clone(),
                    model: entry.model.clone(),
                    at,
                    tokens: delta,
                }),
            }
            state.tokens += delta;
            entry.tokens = tokens;
        }
        entry.last_output = meter.last_output_ns();
        entry.live = meter.live();
        if !meter.terminal() {
            state.entries.insert(identity, entry);
        }
        state.peak = state.peak.max(state.entries.len());
    }

    pub fn remove(&self, meter: &Meter, ns: u64) {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.advance(ns);
        let identity = (meter.request_id.as_lossless().clone(), meter.attempt);
        if owned(state.entries.get(&identity), meter) {
            state.entries.remove(&identity);
        }
    }

    pub fn snapshot(&self, ns: u64) -> JsonValue {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.advance(ns);
        let mut models = BTreeMap::<String, (model::Ref, usize, usize, u64)>::new();
        for entry in state.entries.values() {
            let value = models
                .entry(entry.key.clone())
                .or_insert_with(|| (entry.model.clone(), 0, 0, 0));
            value.1 += 1;
            if entry.last_output.is_some_and(|at| state.now - at < WINDOW) {
                value.2 += 1;
            }
        }
        for slot in &state.slots {
            models
                .entry(slot.key.clone())
                .or_insert_with(|| (slot.model.clone(), 0, 0, 0))
                .3 += slot.tokens;
        }
        let tokens = models.values().map(|value| value.3).sum::<u64>();
        let streaming = models.values().map(|value| value.2).sum::<usize>();
        let mut models = models.into_iter().collect::<Vec<_>>();
        models.sort_by(|(left_key, left), (right_key, right)| {
            right
                .1
                .cmp(&left.1)
                .then_with(|| right.3.cmp(&left.3))
                .then_with(|| left_key.cmp(right_key))
        });
        ObjectEncoder::new()
            .field("asOf", &(state.wall(state.now) as f64))
            .field("active", &(state.entries.len() as f64))
            .field("streaming", &(streaming as f64))
            .optional(
                "outputTokensPerSecond",
                &(!state.entries.is_empty() || tokens > 0).then_some(tokens as f64 / 5.0),
            )
            .field(
                "models",
                &JsonValue::Array(
                    models
                        .into_iter()
                        .take(MODELS)
                        .map(|(_, value)| {
                            ObjectEncoder::new()
                                .field("model", &value.0)
                                .field("active", &(value.1 as f64))
                                .field("streaming", &(value.2 as f64))
                                .field("outputTokensPerSecond", &(value.3 as f64 / 5.0))
                                .finish()
                        })
                        .collect(),
                ),
            )
            .field(
                "history",
                &JsonValue::Array(state.history.iter().cloned().collect()),
            )
            .finish()
    }
}

fn owned(entry: Option<&Entry>, meter: &Meter) -> bool {
    match (
        entry.and_then(|entry| entry.owner.as_ref()),
        meter.registration(),
    ) {
        (Some(owner), Some(registration)) => Arc::ptr_eq(owner, &registration.owner),
        (None, None) => true,
        _ => false,
    }
}

impl State {
    fn wall(&self, ns: u64) -> i64 {
        self.wall_ms
            .saturating_add(((ns - self.anchor) / 1_000_000) as i64)
    }
    fn close(&mut self, bucket: i64, tokens: u64, peak: usize) {
        self.history.push_back(
            ObjectEncoder::new()
                .field("at", &((bucket + 1).saturating_mul(BUCKET) as f64))
                .field("active", &(peak as f64))
                .optional(
                    "outputTokensPerSecond",
                    &(peak > 0 || tokens > 0).then_some(tokens as f64 / 5.0),
                )
                .finish(),
        );
        if self.history.len() > HISTORY {
            self.history.pop_front();
        }
    }
    fn advance(&mut self, ns: u64) {
        self.now = self.now.max(ns);
        let target = self.wall(self.now) / BUCKET;
        if target > self.bucket {
            self.close(self.bucket, self.tokens, self.peak);
            for index in (self.bucket + 1).max(target - HISTORY as i64)..target {
                self.close(index, 0, self.entries.len());
            }
            self.bucket = target;
            self.tokens = 0;
            self.peak = self.entries.len();
        }
        let now = self.now;
        self.slots.retain(|slot| now - slot.at < WINDOW);
    }
}
