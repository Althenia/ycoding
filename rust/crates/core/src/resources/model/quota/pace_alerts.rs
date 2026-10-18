use super::{forecast::Semantics, pace::pace};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{Arc, Mutex},
};
use ycoding_schema::{LosslessString, provider, provider_usage::Window};

pub const MAX_STATES: usize = 256;
pub const MAX_DEFERRED: usize = 16;
pub const RESET_TOLERANCE_MS: u64 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Milestone {
    AlmostOut,
    CuttingItClose,
    WillRunOut,
}
impl Milestone {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AlmostOut => "almost-out",
            Self::CuttingItClose => "cutting-it-close",
            Self::WillRunOut => "will-run-out",
        }
    }
    pub fn title(self) -> &'static str {
        match self {
            Self::AlmostOut => "Almost out",
            Self::CuttingItClose => "Cutting it close",
            Self::WillRunOut => "Will run out",
        }
    }
    pub fn body(self) -> &'static str {
        match self {
            Self::AlmostOut => "Less than 10% of this quota remains.",
            Self::CuttingItClose => "Projected quota use exceeds 90% of its limit at reset.",
            Self::WillRunOut => "Quota use is at its limit or projected to exceed it before reset.",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Alert {
    pub provider_id: provider::Id,
    pub window_id: LosslessString,
    pub milestone: Milestone,
    pub reset_at: i64,
}

pub struct Observation {
    pub account: LosslessString,
    pub provider_id: provider::Id,
    pub available: bool,
    pub updated_at: i64,
    pub window: Window,
    pub semantics: Semantics,
    pub now: i64,
}

type Key = (LosslessString, provider::Id, LosslessString);

struct Flight {
    deliveries: Vec<(Milestone, Option<bool>)>,
    bucket: i8,
    under_now: bool,
    crossed: bool,
}

struct State {
    id: u64,
    touched: u64,
    updated_at: i64,
    signature: String,
    pending: bool,
    reset_at: i64,
    fired: BTreeSet<Milestone>,
    bucket: i8,
    under_ten: bool,
    primed: bool,
    flight: Option<Flight>,
    queue: VecDeque<Observation>,
}

struct Started {
    key: Key,
    state_id: u64,
    alerts: Vec<Alert>,
}

#[derive(Default)]
struct Inner {
    states: BTreeMap<Key, State>,
    clock: u64,
}

#[derive(Clone, Default)]
pub struct Evaluator(Arc<Mutex<Inner>>);

impl Evaluator {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn observe(&self, observation: Observation) -> Vec<Delivery> {
        let Ok(mut inner) = self.0.lock() else {
            return Vec::new();
        };
        let started = inner.observe(observation);
        drop(inner);
        deliveries(&self.0, started)
    }
}

pub struct Delivery {
    alert: Alert,
    shared: Arc<Mutex<Inner>>,
    key: Key,
    state_id: u64,
    settled: bool,
}
impl Delivery {
    pub fn alert(&self) -> &Alert {
        &self.alert
    }
    pub fn settle(mut self, delivered: bool) -> Vec<Delivery> {
        self.settled = true;
        self.complete(delivered, true)
    }
    fn complete(&self, delivered: bool, drain: bool) -> Vec<Delivery> {
        let Ok(mut inner) = self.shared.lock() else {
            return Vec::new();
        };
        let started = inner.settle(
            &self.key,
            self.state_id,
            self.alert.milestone,
            delivered,
            drain,
        );
        drop(inner);
        deliveries(&self.shared, started)
    }
}
impl Drop for Delivery {
    fn drop(&mut self) {
        if !self.settled {
            self.complete(false, false);
        }
    }
}

fn deliveries(shared: &Arc<Mutex<Inner>>, started: Option<Started>) -> Vec<Delivery> {
    started
        .into_iter()
        .flat_map(|started| {
            started.alerts.into_iter().map(move |alert| Delivery {
                alert,
                shared: shared.clone(),
                key: started.key.clone(),
                state_id: started.state_id,
                settled: false,
            })
        })
        .collect()
}

impl Inner {
    fn observe(&mut self, observation: Observation) -> Option<Started> {
        let reset_at = observation.window.reset_at?.get();
        let measure = measure(&observation.window)?;
        if !observation.available || reset_at <= observation.now {
            return None;
        }
        let key = (
            observation.account.clone(),
            observation.provider_id.clone(),
            observation.window.id.clone(),
        );
        let signature = format!(
            "{:?}",
            (
                observation.updated_at,
                &observation.window.unit,
                observation.window.used,
                observation.window.limit,
                observation.window.remaining,
                reset_at,
                observation.window.period_seconds
            )
        );
        self.clock += 1;
        let stamp = self.clock;
        match self.states.get_mut(&key) {
            Some(state) => {
                if observation.updated_at < state.updated_at {
                    return None;
                }
                if state.flight.is_some() {
                    if state.queue.len() < MAX_DEFERRED {
                        state.queue.push_back(observation);
                    }
                    return None;
                }
                if state.signature == signature && !state.pending {
                    return None;
                }
                state.touched = stamp;
            }
            None => {
                self.states.insert(
                    key.clone(),
                    State {
                        id: stamp,
                        touched: stamp,
                        updated_at: observation.updated_at,
                        signature: signature.clone(),
                        pending: false,
                        reset_at,
                        fired: BTreeSet::new(),
                        bucket: -1,
                        under_ten: false,
                        primed: false,
                        flight: None,
                        queue: VecDeque::new(),
                    },
                );
                while self.states.len() > MAX_STATES {
                    let oldest = self
                        .states
                        .iter()
                        .min_by_key(|(_, state)| state.touched)
                        .map(|(key, _)| key.clone())?;
                    self.states.remove(&oldest);
                }
            }
        }
        let state = self.states.get_mut(&key)?;
        state.updated_at = observation.updated_at;
        state.signature = signature;
        if reset_at.abs_diff(state.reset_at) > RESET_TOLERANCE_MS {
            state.fired.clear();
            state.under_ten = false;
            state.bucket = -1;
        }
        state.reset_at = reset_at;
        let bucket = pace(&observation.window, observation.semantics, observation.now)
            .map_or(-1, |pace| pace.verdict as i8);
        let under_now = measure.remaining * 10.0 < measure.limit;
        if !state.primed {
            state.primed = true;
            state.pending = false;
            state.bucket = bucket;
            state.under_ten = under_now;
            state.fired.clear();
            return None;
        }
        let pace_milestone = if bucket == 1
            && state.bucket < 1
            && !state.fired.contains(&Milestone::CuttingItClose)
        {
            Some(Milestone::CuttingItClose)
        } else if bucket >= 2 && state.bucket < 2 && !state.fired.contains(&Milestone::WillRunOut) {
            Some(Milestone::WillRunOut)
        } else {
            None
        };
        if bucket >= 0 && bucket < state.bucket {
            if bucket <= 0 {
                state.fired.remove(&Milestone::CuttingItClose);
            }
            if bucket <= 1 {
                state.fired.remove(&Milestone::WillRunOut);
            }
        }
        let crossed = under_now && !state.under_ten;
        let under_milestone = (crossed && !state.fired.contains(&Milestone::AlmostOut))
            .then_some(Milestone::AlmostOut);
        if !under_now {
            state.fired.remove(&Milestone::AlmostOut);
        }
        let milestones = [pace_milestone, under_milestone]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let flight = Flight {
            deliveries: milestones
                .iter()
                .map(|milestone| (*milestone, None))
                .collect(),
            bucket,
            under_now,
            crossed,
        };
        if milestones.is_empty() {
            state.finalize(flight);
            return None;
        }
        state.flight = Some(flight);
        Some(Started {
            key,
            state_id: state.id,
            alerts: milestones
                .into_iter()
                .map(|milestone| Alert {
                    provider_id: observation.provider_id.clone(),
                    window_id: observation.window.id.clone(),
                    milestone,
                    reset_at,
                })
                .collect(),
        })
    }

    fn settle(
        &mut self,
        key: &Key,
        state_id: u64,
        milestone: Milestone,
        delivered: bool,
        drain: bool,
    ) -> Option<Started> {
        let state = self
            .states
            .get_mut(key)
            .filter(|state| state.id == state_id)?;
        let flight = state.flight.as_mut()?;
        flight
            .deliveries
            .iter_mut()
            .find(|(candidate, outcome)| *candidate == milestone && outcome.is_none())?
            .1 = Some(delivered);
        if flight
            .deliveries
            .iter()
            .any(|(_, outcome)| outcome.is_none())
        {
            return None;
        }
        let flight = state.flight.take()?;
        state.finalize(flight);
        if !drain {
            state.queue.clear();
            return None;
        }
        while let Some(queued) = self
            .states
            .get_mut(key)
            .and_then(|state| state.queue.pop_front())
        {
            if let Some(started) = self.observe(queued) {
                return Some(started);
            }
        }
        None
    }
}

impl State {
    fn finalize(&mut self, flight: Flight) {
        let delivered = |outcome: &Option<bool>| *outcome == Some(true);
        let pace_delivered = flight
            .deliveries
            .iter()
            .any(|(milestone, outcome)| *milestone != Milestone::AlmostOut && delivered(outcome));
        let under_delivered = flight
            .deliveries
            .iter()
            .any(|(milestone, outcome)| *milestone == Milestone::AlmostOut && delivered(outcome));
        self.fired.extend(
            flight
                .deliveries
                .iter()
                .filter(|(_, outcome)| delivered(outcome))
                .map(|(milestone, _)| *milestone),
        );
        self.pending = flight
            .deliveries
            .iter()
            .any(|(_, outcome)| !delivered(outcome));
        if flight.bucket >= 0 && (flight.bucket <= self.bucket || pace_delivered) {
            self.bucket = flight.bucket;
        }
        if !flight.crossed || under_delivered {
            self.under_ten = flight.under_now;
        }
    }
}

struct Measure {
    remaining: f64,
    limit: f64,
}

fn measure(window: &Window) -> Option<Measure> {
    let limit = window
        .limit
        .or_else(|| (window.unit == "percent".into()).then_some(100.0))?;
    if window.unlimited == Some(true) || !limit.is_finite() || limit <= 0.0 {
        return None;
    }
    let left = window
        .remaining
        .or_else(|| window.used.map(|used| limit - used))?;
    left.is_finite().then(|| Measure {
        remaining: left.max(0.0),
        limit,
    })
}
