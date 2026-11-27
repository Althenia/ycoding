use super::{Component, Origin};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct VersionId(pub String);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub key: String,
    pub content: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Harness {
    pub items: BTreeMap<Component, Vec<Item>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    Set(String),
    Remove,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub component: Component,
    pub key: String,
    pub op: Op,
    pub origin: Origin,
    pub rationale: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub id: VersionId,
    pub parent: Option<VersionId>,
    pub harness: Harness,
    pub edits: Vec<Edit>,
    pub created_at: i64,
    pub task: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ceiling {
    pub skills: BTreeSet<String>,
    pub agents: BTreeSet<String>,
    pub plugins: BTreeSet<String>,
    pub scripts: BTreeSet<String>,
    pub max_item_bytes: usize,
    pub max_items: usize,
}
