use super::{Mode, Stage, VersionId};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Detail {
    Skipped(String),
    Baseline {
        signals: u32,
        insufficient: bool,
    },
    Proposed {
        candidates: usize,
    },
    Probed {
        candidate: String,
        outcome: String,
        tokens: u64,
        latency_ms: u64,
    },
    Composed {
        kept: usize,
        dropped: usize,
    },
    Adopted {
        version: VersionId,
        parent: VersionId,
    },
    RolledBack {
        from: VersionId,
        to: VersionId,
    },
    Reflected {
        experiences: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    pub session: ycoding_schema::session::Id,
    pub stage: Stage,
    pub mode: Mode,
    pub detail: Detail,
}
