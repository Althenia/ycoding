use super::{info, store::Service};
use std::{cmp::Ordering, ops::Bound};
use ycoding_schema::{LosslessString, session};
use ycoding_store::{
    Error,
    session::{Session, SessionTable},
};

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Scope {
    #[default]
    All,
    Directory(LosslessString),
    Project(LosslessString),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Order {
    Ascending,
    #[default]
    Descending,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Parent {
    Root,
    Child(session::Id),
}

#[derive(Clone, Debug, Default)]
pub struct Query {
    pub scope: Scope,
    pub workspace: Option<LosslessString>,
    pub search: Option<LosslessString>,
    pub parent: Option<Parent>,
    pub order: Order,
    pub limit: Option<usize>,
    pub anchor: Option<session::ListAnchor>,
}

impl Service {
    pub fn list(&self, query: &Query) -> Result<Vec<session::Info>, Error> {
        let backward = query
            .anchor
            .as_ref()
            .is_some_and(|anchor| anchor.direction.as_str() == Some("previous"));
        let ascending = (query.order == Order::Ascending) != backward;
        let pattern = query
            .search
            .as_ref()
            .filter(|search| !search.is_empty())
            .map(|search| {
                let mut pattern = vec!['%'];
                pattern.extend(text(search).chars());
                pattern.push('%');
                pattern
            });
        let mut rows = self
            .client
            .snapshot()?
            .scan::<SessionTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?
            .into_iter()
            .filter(|row| matches(query, pattern.as_deref(), row))
            .filter(|row| {
                query.anchor.as_ref().is_none_or(|anchor| {
                    let position = compare(row, anchor.time.get(), &text(anchor.id.as_lossless()));
                    if ascending {
                        position == Ordering::Greater
                    } else {
                        position == Ordering::Less
                    }
                })
            })
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| {
            let order = compare(left, right.time_updated as f64, &text(&right.id));
            if ascending { order } else { order.reverse() }
        });
        rows.truncate(query.limit.unwrap_or(usize::MAX));
        if backward {
            rows.reverse();
        }
        rows.iter().map(info::from_row).collect()
    }
}

fn matches(query: &Query, pattern: Option<&[char]>, row: &Session) -> bool {
    let scoped = match &query.scope {
        Scope::All => true,
        Scope::Directory(directory) => row.directory == *directory,
        Scope::Project(project) => row.project_id == *project,
    };
    let workspace = query
        .workspace
        .as_ref()
        .filter(|workspace| !workspace.is_empty())
        .is_none_or(|workspace| row.workspace_id.as_ref() == Some(workspace));
    let parent = match &query.parent {
        None => true,
        Some(Parent::Root) => row.parent_id.is_none(),
        Some(Parent::Child(parent)) => row.parent_id.as_ref() == Some(parent.as_lossless()),
    };
    scoped
        && workspace
        && parent
        && pattern
            .is_none_or(|pattern| like(pattern, &text(&row.title).chars().collect::<Vec<_>>()))
}

fn compare(row: &Session, time: f64, id: &str) -> Ordering {
    (row.time_updated as f64)
        .partial_cmp(&time)
        .unwrap_or(Ordering::Equal)
        .then_with(|| text(&row.id).as_str().cmp(id))
}

fn text(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}

fn like(pattern: &[char], text: &[char]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut resume: Option<(usize, usize)> = None;
    while t < text.len() {
        match pattern.get(p) {
            Some('%') => {
                resume = Some((p, t));
                p += 1;
            }
            Some(symbol) if *symbol == '_' || symbol.eq_ignore_ascii_case(&text[t]) => {
                p += 1;
                t += 1;
            }
            _ => match resume {
                Some((star, from)) => {
                    p = star + 1;
                    t = from + 1;
                    resume = Some((star, from + 1));
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|symbol| *symbol == '%')
}
