use super::{
    DeleteResult, Error, Listing, PurgeResult, ReadResult, RestoreResult, Scope, Search,
    SearchResult, Service, State, TrashListing, VacuumResult, WriteResult, format::require_id,
    graph::Export,
};
use std::path::Path;

pub enum Input<'a> {
    Status,
    List {
        limit: Option<usize>,
        offset: Option<usize>,
    },
    Search(Search<'a>),
    Read {
        id: &'a str,
    },
    Write {
        id: &'a str,
        content: &'a str,
        expected_digest: Option<&'a str>,
    },
    Graph,
    Delete {
        id: &'a str,
        expected_digest: &'a str,
    },
    Trash {
        limit: Option<usize>,
        offset: Option<usize>,
    },
    Restore {
        trash_id: &'a str,
        expected_digest: &'a str,
    },
    Purge {
        trash_id: &'a str,
        expected_digest: &'a str,
    },
    Vacuum {
        dry_run: Option<bool>,
        expected_digest: Option<&'a str>,
    },
}
#[derive(Debug)]
pub enum Output {
    Status(State),
    List(Listing),
    Search(SearchResult),
    Read(ReadResult),
    Write(WriteResult),
    Graph(Export),
    Delete(DeleteResult),
    Trash(TrashListing),
    Restore(RestoreResult),
    Purge(PurgeResult),
    Vacuum(VacuumResult),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    Read,
    Write,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mutation {
    Write,
    Remove,
}
pub struct Reservation<'a>(Option<Box<dyn FnOnce() + 'a>>);
impl<'a> Reservation<'a> {
    pub fn new(release: impl FnOnce() + 'a) -> Self {
        Self(Some(Box::new(release)))
    }
}
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            release();
        }
    }
}
pub trait Authority {
    fn visible(&self, root: &Path) -> Result<bool, Error>;
    fn assert_permission(
        &self,
        permission: Permission,
        root: &Path,
        operation: &str,
        scope: Scope,
    ) -> Result<(), Error>;
    fn reserve(
        &self,
        mutation: Mutation,
        root: &Path,
        operation: &str,
    ) -> Result<Reservation<'_>, Error>;
}
impl Input<'_> {
    pub fn operation(&self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::List { .. } => "list",
            Self::Search(_) => "search",
            Self::Read { .. } => "read",
            Self::Write { .. } => "write",
            Self::Graph => "graph",
            Self::Delete { .. } => "delete",
            Self::Trash { .. } => "trash",
            Self::Restore { .. } => "restore",
            Self::Purge { .. } => "purge",
            Self::Vacuum { .. } => "vacuum",
        }
    }
    fn mutating(&self) -> bool {
        matches!(
            self,
            Self::Write { .. }
                | Self::Graph
                | Self::Delete { .. }
                | Self::Restore { .. }
                | Self::Purge { .. }
                | Self::Vacuum {
                    dry_run: Some(false),
                    ..
                }
        )
    }
    fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Read { id } | Self::Write { id, .. } | Self::Delete { id, .. } => require_id(id)?,
            Self::List { limit, offset } | Self::Trash { limit, offset } => {
                super::page(*limit, *offset)?;
            }
            Self::Search(search)
                if search.query.encode_utf16().count() == 0
                    || search.query.encode_utf16().count() > 1024
                    || search.limit.is_some_and(|limit| !(1..=50).contains(&limit)) =>
            {
                return Err(Error::InvalidConcept);
            }
            _ => {}
        }
        let digest = match self {
            Self::Write {
                expected_digest, ..
            }
            | Self::Vacuum {
                expected_digest, ..
            } => *expected_digest,
            Self::Delete {
                expected_digest, ..
            }
            | Self::Restore {
                expected_digest, ..
            }
            | Self::Purge {
                expected_digest, ..
            } => Some(*expected_digest),
            _ => None,
        };
        if digest.is_some_and(|digest| {
            digest.len() != 64
                || !digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(Error::InvalidConcept);
        }
        Ok(())
    }
}
pub async fn execute(
    service: &Service,
    scope: Option<Scope>,
    input: Input<'_>,
    authority: &impl Authority,
) -> Result<Output, Error> {
    input.validate()?;
    let scope = scope.unwrap_or_default();
    let status = service.status(scope)?;
    if !status.enabled && !matches!(input, Input::Status) {
        return Err(Error::Disabled);
    }
    if !authority.visible(&status.root)? {
        return Err(Error::Unavailable);
    }
    authority.assert_permission(
        if input.mutating() {
            Permission::Write
        } else {
            Permission::Read
        },
        &status.root,
        input.operation(),
        scope,
    )?;
    if matches!(input, Input::Graph) && scope == Scope::Repository {
        authority.assert_permission(
            Permission::Read,
            &status.knowledge_root,
            "graph",
            Scope::Knowledge,
        )?;
    }
    let _reservation = if input.mutating() {
        Some(authority.reserve(
            if matches!(
                input,
                Input::Delete { .. } | Input::Purge { .. } | Input::Vacuum { .. }
            ) {
                Mutation::Remove
            } else {
                Mutation::Write
            },
            &status.root,
            input.operation(),
        )?)
    } else {
        None
    };
    if service.status(scope)?.root != status.root {
        return Err(Error::UnsafePath);
    }
    Ok(match input {
        Input::Status => Output::Status(status),
        Input::List { limit, offset } => Output::List(service.list(scope, limit, offset)?),
        Input::Search(search) => Output::Search(service.search(scope, search)?),
        Input::Read { id } => Output::Read(service.read(scope, id)?),
        Input::Write {
            id,
            content,
            expected_digest,
        } => Output::Write(service.write(scope, id, content, expected_digest).await?),
        Input::Graph => Output::Graph(service.graph(scope).await?),
        Input::Delete {
            id,
            expected_digest,
        } => Output::Delete(service.delete(scope, id, expected_digest).await?),
        Input::Trash { limit, offset } => Output::Trash(service.trash(scope, limit, offset)?),
        Input::Restore {
            trash_id,
            expected_digest,
        } => Output::Restore(service.restore(scope, trash_id, expected_digest).await?),
        Input::Purge {
            trash_id,
            expected_digest,
        } => Output::Purge(service.purge(scope, trash_id, expected_digest).await?),
        Input::Vacuum {
            dry_run,
            expected_digest,
        } => Output::Vacuum(service.vacuum(scope, dry_run, expected_digest).await?),
    })
}
