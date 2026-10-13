use super::{
    service::{Error, Service, non_negative},
    view::task_from_row,
};
use crate::session::key;
use ycoding_schema::{
    session,
    session_orchestration::{Direction, ListAnchor, ListRank, State, Summary, Task},
};
use ycoding_store::session::SessionTable;

const PAGE_SIZE: usize = 10;
const PINNED_RANK: u8 = 5;

type OrderKey = (u8, i64, i64, String);

#[derive(Clone, Debug, PartialEq)]
pub struct Listing {
    pub data: Vec<Task>,
    pub summary: Summary,
    pub previous: Option<ListAnchor>,
    pub next: Option<ListAnchor>,
}

impl Service {
    pub fn page(
        &self,
        parent_id: &session::Id,
        limit: Option<usize>,
        cursor: Option<&ListAnchor>,
    ) -> Result<Listing, Error> {
        self.require_session(parent_id)?;
        let limit = limit.unwrap_or(PAGE_SIZE).min(PAGE_SIZE);
        let snapshot = self.sessions.client.snapshot()?;
        let mut entries = self
            .children(parent_id)?
            .iter()
            .map(|row| {
                let mut task = task_from_row(row)?;
                task.pinned_at = snapshot
                    .get::<SessionTable>(&key(&row.session_id))?
                    .and_then(|session| session.time_pinned)
                    .map(non_negative)
                    .transpose()?;
                Ok((order_key(&task), task))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        let count = |predicate: fn(&State) -> bool| {
            non_negative(
                entries
                    .iter()
                    .filter(|(_, task)| predicate(&task.state))
                    .count() as i64,
            )
        };
        let summary = Summary {
            total: non_negative(entries.len() as i64)?,
            active: count(|state| !super::view::is_terminal(state))?,
            running: count(|state| *state == State::Running)?,
            waiting: count(|state| *state == State::Waiting)?,
        };
        let backward = cursor.is_some_and(|anchor| anchor.direction == Direction::Previous);
        let anchor = cursor.map(anchor_key);
        let mut window = entries
            .into_iter()
            .filter(|(key, _)| match &anchor {
                None => true,
                Some(anchor) if backward => key < anchor,
                Some(anchor) => key > anchor,
            })
            .map(|(_, task)| task)
            .collect::<Vec<_>>();
        let has_more = window.len() > limit;
        window = if backward {
            window.split_off(window.len().saturating_sub(limit))
        } else {
            window.truncate(limit);
            window
        };
        let previous = window
            .first()
            .filter(|_| if backward { has_more } else { cursor.is_some() })
            .map(|task| anchor_of(task, Direction::Previous));
        let next = window
            .last()
            .filter(|_| if backward { cursor.is_some() } else { has_more })
            .map(|task| anchor_of(task, Direction::Next));
        Ok(Listing {
            data: window,
            summary,
            previous,
            next,
        })
    }
}

fn rank(state: &State) -> u8 {
    match state {
        State::Waiting => 0,
        State::Starting => 1,
        State::Running => 2,
        State::Cancelling => 3,
        _ => 4,
    }
}

fn text(task: &Task) -> String {
    task.session_id.as_lossless().to_utf8().unwrap_or_default()
}

fn order_key(task: &Task) -> OrderKey {
    match task.pinned_at {
        Some(pinned) => (0, pinned.get(), 0, text(task)),
        None => (
            1,
            i64::from(rank(&task.state)),
            -task.time.updated.get(),
            text(task),
        ),
    }
}

fn anchor_key(anchor: &ListAnchor) -> OrderKey {
    let id = anchor
        .session_id
        .as_lossless()
        .to_utf8()
        .unwrap_or_default();
    match anchor.rank.0 {
        PINNED_RANK => (0, anchor.updated.get(), 0, id),
        rank => (1, i64::from(rank), -anchor.updated.get(), id),
    }
}

fn anchor_of(task: &Task, direction: Direction) -> ListAnchor {
    ListAnchor {
        rank: ListRank(
            task.pinned_at
                .map_or_else(|| rank(&task.state), |_| PINNED_RANK),
        ),
        updated: task.pinned_at.unwrap_or(task.time.updated),
        session_id: task.session_id.clone(),
        direction,
    }
}
