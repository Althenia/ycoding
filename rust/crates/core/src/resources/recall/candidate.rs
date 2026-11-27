use super::document::{Kind, Scope};
use std::cmp::Ordering;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Method {
    Explicit,
    Cue,
    Exact,
    Bm25,
    Semantic,
    Rrf,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Explicit => "explicit",
            Self::Cue => "cue",
            Self::Exact => "exact",
            Self::Bm25 => "bm25",
            Self::Semantic => "semantic",
            Self::Rrf => "rrf",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    ExplicitId,
    Event,
    Command,
    Path,
    ExactId,
    ExactTitle,
    ExactTag,
    ExactIdentifier,
    BodyPhrase,
    Lexical,
    Semantic,
    Fused,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExplicitId => "explicit-id",
            Self::Event => "event",
            Self::Command => "command",
            Self::Path => "path",
            Self::ExactId => "exact-id",
            Self::ExactTitle => "exact-title",
            Self::ExactTag => "exact-tag",
            Self::ExactIdentifier => "exact-identifier",
            Self::BodyPhrase => "body-phrase",
            Self::Lexical => "lexical",
            Self::Semantic => "semantic",
            Self::Fused => "fused",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MethodScore {
    pub method: Method,
    pub score: f64,
    pub rank: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub kind: Kind,
    pub scope: Scope,
    pub content_hash: String,
    pub bytes: usize,
    pub aliases: Vec<String>,
    pub method: Method,
    pub scores: Vec<MethodScore>,
    pub reason: Reason,
}

impl Candidate {
    pub fn score(&self, method: Method) -> Option<MethodScore> {
        self.scores.iter().copied().find(|s| s.method == method)
    }

    pub fn order(&self, other: &Self) -> Ordering {
        let primary = |c: &Self| c.score(c.method).map_or(f64::NEG_INFINITY, |s| s.score);
        primary(other)
            .total_cmp(&primary(self))
            .then_with(|| self.scope.cmp(&other.scope))
            .then_with(|| self.kind.cmp(&other.kind))
            .then_with(|| self.id.cmp(&other.id))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Semantic {
    NotNeeded,
    Unavailable,
    Used,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Signals {
    pub query_terms: usize,
    pub matched_terms: usize,
    pub top_bm25: f64,
    pub second_bm25: f64,
    pub top_cosine: Option<f32>,
    pub semantic: Semantic,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Retrieval {
    pub candidates: Vec<Candidate>,
    pub signals: Signals,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Query {
    pub text: String,
    pub kinds: Vec<Kind>,
    pub scopes: Vec<Scope>,
    pub tags: Vec<String>,
    pub types: Vec<String>,
    pub implicit: bool,
    pub now: Option<i64>,
    pub seen: Vec<String>,
    pub budget: Budget,
    pub limit: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Budget {
    pub total_bytes: Option<usize>,
    pub per_kind_bytes: Option<usize>,
    pub per_kind_candidates: Option<usize>,
}
