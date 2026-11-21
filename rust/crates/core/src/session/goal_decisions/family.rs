use super::{FAMILY_LIMIT, Fallible, GoalDecisions, PAGE, Requirement, candidate::Fence, readable};
use crate::session::{autonomy::State, key, orchestration::Atomic, prompt_cache::sha256};
use std::{collections::BTreeSet, ops::Bound, sync::Arc};
use ycoding_schema::session;
use ycoding_store::{
    IndexOrder, IndexQuery, Write,
    session::{Session, SessionTable},
};

#[derive(Clone, Debug)]
pub(super) struct Row {
    pub id: session::Id,
    pub parent: Option<session::Id>,
    pub archived: bool,
    pub goal: bool,
}

pub(super) fn eligible(row: &Row) -> bool {
    !row.archived && row.goal
}

fn to_row(record: &Session) -> Option<Row> {
    Some(Row {
        id: session::Id::new(record.id.clone()).ok()?,
        parent: record
            .parent_id
            .clone()
            .filter(|parent| !parent.is_empty())
            .and_then(|parent| session::Id::new(parent).ok()),
        archived: record.time_archived.is_some(),
        goal: State::read(record.autonomy.as_ref())
            .goal
            .is_some_and(|goal| goal.is_active()),
    })
}

fn transactional(
    check: impl Fn(&mut Write<'_>) -> Result<bool, ycoding_store::Error> + Send + Sync + 'static,
) -> Atomic {
    Arc::new(check)
}

fn owner_in(
    tx: &mut Write<'_>,
    member: &session::Id,
) -> Result<Option<session::Id>, ycoding_store::Error> {
    let mut current = member.as_lossless().clone();
    for depth in 0..64 {
        let Some(record) = tx.get::<SessionTable>(&key(&current))? else {
            return Ok(None);
        };
        if depth == 0 && record.time_archived.is_some() {
            return Ok(None);
        }
        let Some(row) = to_row(&record) else {
            return Ok(None);
        };
        if eligible(&row) {
            return Ok(Some(row.id));
        }
        let Some(parent) = row.parent else {
            return Ok(None);
        };
        current = parent.as_lossless().clone();
    }
    Ok(None)
}

pub(super) fn atomic(fence: &Fence) -> Atomic {
    let owner = fence.owner.clone();
    let requirement = fence.requirement.clone();
    let member = fence.session.clone();
    transactional(move |tx| {
        let Some(record) = tx.get::<SessionTable>(&key(owner.as_lossless()))? else {
            return Ok(false);
        };
        let Some(goal) = State::read(record.autonomy.as_ref())
            .goal
            .filter(|goal| goal.is_active())
        else {
            return Ok(false);
        };
        if record.time_archived.is_some()
            || record.autonomy_revision != requirement.revision
            || goal.iteration != requirement.iteration
            || sha256(&readable(&goal.text)) != requirement.goal_digest
        {
            return Ok(false);
        }
        Ok(owner_in(tx, &member)?.as_ref() == Some(&owner))
    })
}

impl GoalDecisions {
    pub(super) fn row(&self, id: &session::Id) -> Fallible<Option<Row>> {
        Ok(self
            .0
            .client
            .snapshot()?
            .get::<SessionTable>(&key(id.as_lossless()))?
            .as_ref()
            .and_then(to_row))
    }

    pub(super) fn owner_of(&self, id: &session::Id) -> Option<session::Id> {
        let mut current = id.clone();
        for _ in 0..64 {
            let row = self.row(&current).ok()??;
            if eligible(&row) {
                return Some(row.id);
            }
            current = row.parent?;
        }
        None
    }

    pub(super) fn subtree(&self, root: &session::Id, prune: bool) -> Fallible<Vec<Row>> {
        let snapshot = self.0.client.snapshot()?;
        let Some(start) = snapshot
            .get::<SessionTable>(&key(root.as_lossless()))?
            .as_ref()
            .and_then(to_row)
        else {
            return Ok(Vec::new());
        };
        let mut seen = BTreeSet::from([start.id.clone()]);
        let mut rows = vec![start];
        let mut frontier = vec![root.clone()];
        while !frontier.is_empty() && rows.len() < FAMILY_LIMIT {
            let mut next = Vec::new();
            for parent in &frontier {
                let prefix = key(parent.as_lossless());
                let mut after = None;
                loop {
                    let page = snapshot.index_range::<SessionTable>(
                        "session_parent_idx",
                        IndexQuery {
                            lower: Bound::Unbounded,
                            upper: Bound::Unbounded,
                            prefix: Some(&prefix),
                            order: IndexOrder::Ascending,
                            after: after.as_ref(),
                            limit: PAGE,
                        },
                    )?;
                    let Some(last) = page.last() else {
                        break;
                    };
                    after = Some(last.cursor.clone());
                    for entry in &page {
                        let Some(child) = to_row(&entry.record) else {
                            continue;
                        };
                        if (prune && eligible(&child)) || !seen.insert(child.id.clone()) {
                            continue;
                        }
                        next.push(child);
                    }
                    if rows.len() + next.len() >= FAMILY_LIMIT {
                        break;
                    }
                }
            }
            frontier = next.iter().map(|row| row.id.clone()).collect();
            rows.extend(next);
        }
        rows.truncate(FAMILY_LIMIT);
        Ok(rows)
    }

    pub(super) fn capture(&self, owner: &session::Id) -> Option<Requirement> {
        if !self.row(owner).ok()?.as_ref().is_some_and(eligible) {
            return None;
        }
        let snapshot = self.0.autonomy.snapshot(owner).ok()?;
        let goal = snapshot.state.goal?;
        goal.is_active().then(|| Requirement {
            goal_digest: sha256(&readable(&goal.text)),
            iteration: goal.iteration,
            revision: snapshot.sequence,
        })
    }

    pub(super) fn owner_current(&self, owner: &session::Id, requirement: &Requirement) -> bool {
        self.capture(owner).as_ref() == Some(requirement)
    }
}
