#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Concept,
    Skill,
    Experience,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Concept => "concept",
            Self::Skill => "skill",
            Self::Experience => "experience",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Scope {
    Workspace,
    Project,
    Knowledge,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Project => "project",
            Self::Knowledge => "knowledge",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub path: String,
    pub revision: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fields {
    pub doc_type: String,
    pub title: String,
    pub description: String,
    pub body: String,
    pub tags: Vec<String>,
    pub keywords: Vec<String>,
    pub identifiers: Vec<String>,
    pub relationships: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Status {
    #[default]
    Active,
    Draft,
    Deprecated,
    Archived,
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum Trust {
    #[default]
    Unverified,
    Verified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activation {
    Auto,
    Manual,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Lifecycle {
    pub status: Status,
    pub trust: Trust,
    pub stale_after: Option<i64>,
    pub superseded_by: Option<String>,
    pub activation: Option<Activation>,
}

impl Lifecycle {
    pub fn eligible(&self, now: i64) -> bool {
        self.status == Status::Active
            && self.superseded_by.is_none()
            && self.stale_after.is_none_or(|limit| now <= limit)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Document {
    pub id: String,
    pub kind: Kind,
    pub scope: Scope,
    pub source: Source,
    pub fields: Fields,
    pub lifecycle: Lifecycle,
}

impl Document {
    pub fn key(&self) -> (Scope, Kind, &str) {
        (self.scope, self.kind, &self.id)
    }
}
