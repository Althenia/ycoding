use super::{Harness, Origin, Stage, VersionId};
use ycoding_schema::session;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub session: session::Id,
    pub agent: String,
    pub text: String,
    pub domains: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    ToolError,
    Retry,
    Loop,
    Stall,
    Denied,
    Compaction,
    Correction,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Failed(String),
    Abstained,
    Exhausted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Execution {
    pub candidate: String,
    pub outcome: Outcome,
    pub tokens: u64,
    pub latency_ms: u64,
    pub steps: u32,
    pub signals: Vec<(Signal, u32)>,
    pub summary: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Replay {
    pub performed: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    pub tokens: u64,
    pub latency_ms: u64,
    pub concurrency: usize,
    pub depth: u8,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub origin: Origin,
    pub base: VersionId,
    pub harness: Harness,
    pub edits: Vec<super::Edit>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contrast {
    pub edit: super::Edit,
    pub better: Vec<String>,
    pub worse: Vec<String>,
    pub observation: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Composition {
    pub kept: Vec<super::Edit>,
    pub dropped: Vec<(super::Edit, String)>,
    pub contrasts: Vec<Contrast>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub version: VersionId,
    pub execution: Execution,
    pub reached: Stage,
}
