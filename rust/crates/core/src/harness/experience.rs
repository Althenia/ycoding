use super::{Component, VersionId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strategy {
    Success,
    Failure,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Basis {
    Observed,
    Assumed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Applicability {
    pub domains: Vec<String>,
    pub components: Vec<Component>,
    pub agents: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub version: VersionId,
    pub edits: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Experience {
    pub id: String,
    pub strategy: Strategy,
    pub cue: String,
    pub lesson: String,
    pub evidence: Vec<String>,
    pub confidence: f32,
    pub basis: Basis,
    pub applicability: Applicability,
    pub change: Option<Change>,
}
