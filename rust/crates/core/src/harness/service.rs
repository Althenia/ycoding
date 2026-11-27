use super::{
    Budget, Candidate, Ceiling, Completion, Composition, Edit, Event, Execution, Experience,
    Harness, Replay, Settings, Task, Version, VersionId,
};
use std::{future::Future, pin::Pin};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("harness adaptation is disabled")]
    Disabled,
    #[error("edit outside the effective authorization: {0}")]
    Denied(String),
    #[error("probe budget exhausted: {0}")]
    Budget(String),
    #[error("invalid harness data: {0}")]
    Invalid(String),
    #[error("unavailable: {0}")]
    Unavailable(String),
    #[error("conflict: {0}")]
    Conflict(String),
}

pub type Pending<'a, T> = Pin<Box<dyn Future<Output = Result<T, Error>> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq)]
pub struct Prepared {
    pub version: Version,
    pub adopted: Vec<Edit>,
    pub baseline: Option<Execution>,
    pub probes: Vec<Execution>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reflection {
    pub experiences: Vec<Experience>,
}

pub trait Controller: Send + Sync {
    fn prepare(&self, task: Task, ceiling: Ceiling) -> Pending<'_, Prepared>;
    fn reflect(&self, task: Task, completion: Completion) -> Pending<'_, Reflection>;
    fn current(&self) -> Pending<'_, Version>;
    fn rollback(&self, to: VersionId) -> Pending<'_, Version>;
}

pub trait Proposer: Send + Sync {
    fn propose(
        &self,
        task: &Task,
        base: &Version,
        baseline: &Execution,
        lessons: &[Experience],
        count: usize,
    ) -> Pending<'_, Vec<Candidate>>;
    fn compose(
        &self,
        task: &Task,
        base: &Version,
        baseline: &Execution,
        probes: &[Execution],
        candidates: &[Candidate],
    ) -> Pending<'_, Composition>;
    fn reflect(
        &self,
        task: &Task,
        completion: &Completion,
        composition: Option<&Composition>,
        lessons: &[Experience],
    ) -> Pending<'_, Vec<Experience>>;
}

pub trait Prober: Send + Sync {
    fn baseline(
        &self,
        task: &Task,
        harness: &Harness,
        budget: Budget,
    ) -> Pending<'_, (Execution, Replay)>;
    fn probe(
        &self,
        task: &Task,
        candidate: &Candidate,
        replay: &Replay,
        budget: Budget,
    ) -> Pending<'_, Execution>;
}

pub trait Versions: Send + Sync {
    fn current(&self) -> Pending<'_, Version>;
    fn get(&self, id: &VersionId) -> Pending<'_, Option<Version>>;
    fn publish(&self, version: Version, expected: &VersionId) -> Pending<'_, ()>;
}

pub trait Experiences: Send + Sync {
    fn record(&self, experience: Experience) -> Pending<'_, ()>;
    fn recall(&self, task: &Task, limit: usize) -> Pending<'_, Vec<Experience>>;
}

pub trait Events: Send + Sync {
    fn emit(&self, event: Event);
}

pub fn effective(settings: &Settings) -> Budget {
    Budget {
        tokens: settings.max_tokens,
        latency_ms: settings.max_latency_ms,
        concurrency: settings.max_concurrency,
        depth: settings.max_depth,
    }
}
