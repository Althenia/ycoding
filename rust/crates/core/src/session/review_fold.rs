use super::{key, projector};
use std::collections::BTreeMap;
use std::ops::Bound;
use ycoding_schema::{
    DomainDecode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, session,
    session_message,
    session_orchestration::QuestionId,
    session_review::{Decision, Deferral, Id, Kind, Origin, RecoveryChoice},
};
use ycoding_store::{
    Error, IndexEntry, IndexOrder, IndexQuery, KeyPart, Snapshot, Write,
    session::{Event, EventTable, MessageTable, NewEvent, PendingTable, TaskTable},
    tuple_key,
};

pub(crate) const DEFERRED: &str = "session.review.deferred.1";
pub(crate) const DECIDED: &str = "session.review.decided.1";
pub(crate) const WITHDRAWN: &str = "session.review.withdrawn.1";
pub(crate) const CONSUMED: &str = "session.review.consumed.1";
const TYPES: [&str; 4] = [DEFERRED, DECIDED, WITHDRAWN, CONSUMED];
const PAGE: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WithdrawReason {
    Reverted,
    TaskClosed,
}

impl WithdrawReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reverted => "reverted",
            Self::TaskClosed => "task_closed",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Folded {
    pub item_id: Id,
    pub session_id: session::Id,
    pub deferral: Deferral,
    pub created: i64,
    pub decision: Option<Decision>,
    pub withdrawn: Option<WithdrawReason>,
    pub consumed: bool,
}

impl Folded {
    pub fn is_open(&self) -> bool {
        self.decision.is_none() && self.withdrawn.is_none()
    }

    pub fn is_stopped_recovery(&self) -> bool {
        self.deferral.kind == Kind::Recovery
            && self.withdrawn.is_none()
            && matches!(
                self.decision,
                Some(Decision::Recovery {
                    choice: RecoveryChoice::Stop
                })
            )
    }
}

pub fn fold(snapshot: &Snapshot, sessions: &[LosslessString]) -> Result<Vec<Folded>, Error> {
    let mut items = BTreeMap::new();
    for aggregate in sessions {
        let Ok(session_id) = session::Id::new(aggregate.clone()) else {
            continue;
        };
        for event in history(snapshot, aggregate)? {
            apply(&mut items, &session_id, &event);
        }
    }
    Ok(items.into_values().collect())
}

pub fn owns_question(
    snapshot: &Snapshot,
    session_id: &session::Id,
    question_id: &QuestionId,
) -> Result<bool, Error> {
    let Some(task) = snapshot.get::<TaskTable>(&key(session_id.as_lossless()))? else {
        return Ok(false);
    };
    if task.state.as_str() != Some("waiting") || task.question_id.as_ref() != Some(&question_id.0) {
        return Ok(false);
    }
    Ok(fold(snapshot, &[session_id.as_lossless().clone()])?
        .iter()
        .any(|item| {
            item.withdrawn.is_none()
                && matches!(item.deferral.kind, Kind::SubagentQuestion | Kind::Recovery)
                && matches!(&item.deferral.origin, Origin::Question { question_id: origin } if origin == question_id)
        }))
}

pub fn stopped_recovery(
    snapshot: &Snapshot,
    session_id: &session::Id,
) -> Result<Option<Id>, Error> {
    Ok(fold(snapshot, &[session_id.as_lossless().clone()])?
        .into_iter()
        .rfind(Folded::is_stopped_recovery)
        .map(|item| item.item_id))
}

pub fn message_seq(
    snapshot: &Snapshot,
    session_id: &session::Id,
    message_id: &session_message::Id,
) -> Result<Option<i64>, Error> {
    let id = key(message_id.as_lossless());
    if let Some(message) = snapshot.get::<MessageTable>(&id)? {
        return Ok((&message.session_id == session_id.as_lossless()).then_some(message.seq));
    }
    Ok(snapshot
        .get::<PendingTable>(&id)?
        .filter(|pending| &pending.session_id == session_id.as_lossless())
        .map(|pending| pending.admitted_seq))
}

pub fn withdrawals(
    snapshot: &Snapshot,
    session_id: &session::Id,
    boundary: i64,
    inclusive: bool,
    now: i64,
) -> Result<Withdrawals, Error> {
    let mut items = Vec::new();
    for item in fold(snapshot, &[session_id.as_lossless().clone()])? {
        if item.withdrawn.is_some() || item.consumed {
            continue;
        }
        let Origin::Tool { message_id, .. } = &item.deferral.origin else {
            continue;
        };
        let Some(seq) = message_seq(snapshot, session_id, message_id)? else {
            continue;
        };
        if (inclusive && seq >= boundary) || seq > boundary {
            items.push(item.item_id);
        }
    }
    Withdrawals::new(snapshot, session_id, items, WithdrawReason::Reverted, now)
}

#[derive(Clone, Debug)]
pub struct Withdrawals {
    session_id: session::Id,
    fence: i64,
    items: Vec<Id>,
    reason: WithdrawReason,
    now: i64,
}

impl Withdrawals {
    pub(crate) fn new(
        snapshot: &Snapshot,
        session_id: &session::Id,
        items: Vec<Id>,
        reason: WithdrawReason,
        now: i64,
    ) -> Result<Self, Error> {
        Ok(Self {
            fence: latest(&mut Read::Snapshot(snapshot), session_id.as_lossless())?,
            session_id: session_id.clone(),
            items,
            reason,
            now,
        })
    }

    pub fn item_ids(&self) -> &[Id] {
        &self.items
    }

    pub fn append(&self, tx: &mut Write<'_>) -> Result<usize, Error> {
        if latest(
            &mut Read::Transaction(&mut *tx),
            self.session_id.as_lossless(),
        )? != self.fence
        {
            return Err(changed(tx));
        }
        for item in &self.items {
            append(
                tx,
                self.session_id.as_lossless(),
                WITHDRAWN,
                self.now,
                ObjectEncoder::new()
                    .field("sessionID", &self.session_id)
                    .field("itemID", item)
                    .field("reason", self.reason.as_str())
                    .finish(),
            )?;
        }
        Ok(self.items.len())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Fence(Vec<(LosslessString, i64)>);

impl Fence {
    pub(crate) fn read(snapshot: &Snapshot, sessions: &[LosslessString]) -> Result<Self, Error> {
        let mut read = Read::Snapshot(snapshot);
        sessions
            .iter()
            .map(|session| Ok((session.clone(), latest(&mut read, session)?)))
            .collect::<Result<_, Error>>()
            .map(Self)
    }

    pub(crate) fn holds(&self, tx: &mut Write<'_>) -> Result<bool, Error> {
        for (session, seq) in &self.0 {
            if latest(&mut Read::Transaction(&mut *tx), session)? != *seq {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

pub(crate) fn family_open(
    snapshot: &Snapshot,
    session: &LosslessString,
) -> Result<(usize, Fence), Error> {
    let mut read = super::family::Reader::Snapshot(snapshot);
    let Some(root) = super::family::root(&mut read, session)? else {
        return Ok((0, Fence(Vec::new())));
    };
    let members = super::family::members(&mut read, &root)?;
    let open = fold(snapshot, &members)?
        .iter()
        .filter(|item| item.is_open())
        .count();
    Ok((open, Fence::read(snapshot, &members)?))
}

pub(crate) fn latest_in(tx: &mut Write<'_>, session: &LosslessString) -> Result<i64, Error> {
    latest(&mut Read::Transaction(tx), session)
}

pub(crate) fn latest_at(snapshot: &Snapshot, session: &LosslessString) -> Result<i64, Error> {
    latest(&mut Read::Snapshot(snapshot), session)
}

pub(crate) fn has_decided(snapshot: &Snapshot, session: &LosslessString) -> Result<bool, Error> {
    Ok(!Read::Snapshot(snapshot)
        .page(session, DECIDED, IndexOrder::Ascending, None, 1)?
        .is_empty())
}

pub(crate) fn changed(tx: &mut Write<'_>) -> Error {
    tx.reject(Error::Domain {
        kind: "review_changed",
        message: "review state changed before commit",
    })
}

pub(crate) fn is_changed(error: &Error) -> bool {
    matches!(
        error,
        Error::Domain {
            kind: "review_changed",
            ..
        }
    )
}

pub(crate) fn append(
    tx: &mut Write<'_>,
    aggregate: &LosslessString,
    type_: &str,
    created: i64,
    data: JsonValue,
) -> Result<Event, Error> {
    projector::append(
        tx,
        &NewEvent {
            id: projector::random_event_id()?.as_lossless().clone(),
            aggregate_id: aggregate.clone(),
            created,
            type_: type_.into(),
            data,
        },
    )
}

fn history(snapshot: &Snapshot, aggregate: &LosslessString) -> Result<Vec<Event>, Error> {
    let mut read = Read::Snapshot(snapshot);
    let mut events = Vec::new();
    for type_ in TYPES {
        let mut after = None;
        loop {
            let page = read.page(
                aggregate,
                type_,
                IndexOrder::Ascending,
                after.as_ref(),
                PAGE,
            )?;
            let Some(last) = page.last() else {
                break;
            };
            after = Some(last.cursor.clone());
            events.extend(page.into_iter().map(|entry| entry.record));
        }
    }
    events.sort_by_key(|event| event.seq);
    Ok(events)
}

fn apply(items: &mut BTreeMap<Id, Folded>, session_id: &session::Id, event: &Event) {
    let path = JsonPath::default();
    let Ok(object) = ObjectDecoder::new(&event.data, &path) else {
        return;
    };
    match event.type_.as_str() {
        Some(DEFERRED) => {
            let Ok(deferral) = Deferral::decode(&event.data) else {
                return;
            };
            items.insert(
                deferral.item_id.clone(),
                Folded {
                    item_id: deferral.item_id.clone(),
                    session_id: session_id.clone(),
                    deferral,
                    created: event.created,
                    decision: None,
                    withdrawn: None,
                    consumed: false,
                },
            );
        }
        Some(DECIDED) => {
            let (Ok(item_id), Ok(decision)) = (
                object.field::<Id>("itemID"),
                object.field::<Decision>("decision"),
            ) else {
                return;
            };
            if let Some(item) = items.get_mut(&item_id) {
                item.decision = Some(decision);
            }
        }
        Some(WITHDRAWN) => {
            let (Ok(item_id), Ok(reason)) = (
                object.field::<Id>("itemID"),
                object.field::<LosslessString>("reason"),
            ) else {
                return;
            };
            let reason = match reason.as_str() {
                Some("reverted") => WithdrawReason::Reverted,
                Some("task_closed") => WithdrawReason::TaskClosed,
                _ => return,
            };
            if let Some(item) = items.get_mut(&item_id) {
                item.withdrawn = Some(reason);
            }
        }
        _ => {
            let Ok(item_id) = object.field::<Id>("itemID") else {
                return;
            };
            if let Some(item) = items.get_mut(&item_id) {
                item.consumed = true;
            }
        }
    }
}

fn latest(read: &mut Read<'_, '_>, session: &LosslessString) -> Result<i64, Error> {
    let mut highest = -1;
    for type_ in TYPES {
        if let Some(entry) = read
            .page(session, type_, IndexOrder::Descending, None, 1)?
            .into_iter()
            .next()
        {
            highest = highest.max(entry.record.seq);
        }
    }
    Ok(highest)
}

enum Read<'a, 'b> {
    Snapshot(&'a Snapshot),
    Transaction(&'a mut Write<'b>),
}

impl Read<'_, '_> {
    fn page(
        &mut self,
        session: &LosslessString,
        type_: &str,
        order: IndexOrder,
        after: Option<&ycoding_store::IndexCursor>,
        limit: usize,
    ) -> Result<Vec<IndexEntry<Event>>, Error> {
        let type_ = LosslessString::from(type_);
        let prefix = tuple_key(&[KeyPart::String(session), KeyPart::String(&type_)]);
        let query = IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: Some(&prefix),
            order,
            after,
            limit,
        };
        match self {
            Self::Snapshot(snapshot) => {
                snapshot.index_range::<EventTable>("event_aggregate_type_seq_idx", query)
            }
            Self::Transaction(tx) => {
                tx.index_range::<EventTable>("event_aggregate_type_seq_idx", query)
            }
        }
    }
}
