use super::{key, revert, store::Service};
use crate::job;
use ring::digest;
use std::{collections::BTreeSet, ops::Bound, sync::Arc};
use ycoding_schema::{
    JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, event, session,
    session_message,
};
use ycoding_store::{
    Error, IndexEntry, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write,
    session::{
        self as tables, Append, Event, EventTable, NewEvent, NotificationTable, PendingTable,
        SessionTable, TaskTable,
    },
    tuple_key,
};

pub type Active = Arc<dyn Fn() -> Vec<session::Id> + Send + Sync>;

const COMPLETED: &str = "session.work.completed.1";
const EXECUTION_STARTED: &str = "session.execution.started.1";
const EXECUTION_SUCCEEDED: &str = "session.execution.succeeded.1";
const EXECUTION_PREFIX: &str = "session.execution.";
const STEP_STARTED: &str = "session.step.started.1";
const STEP_ENDED: &str = "session.step.ended.1";
const STEP_FAILED: &str = "session.step.failed.1";
const TEXT_ENDED: &str = "session.text.ended.1";
const TOOL_INPUT_STARTED: &str = "session.tool.input.started.1";
const TOOL_CALLED: &str = "session.tool.called.1";
const TOOL_SUCCESS: &str = "session.tool.success.1";
const TOOL_FAILED: &str = "session.tool.failed.1";
const INPUT_PROMOTED: &str = "session.input.promoted.1";
const INPUT_ADMITTED: &str = "session.input.admitted.1";
const REVERT_COMMITTED: &str = "session.revert.committed.1";
const HISTORY: [&str; 11] = [
    EXECUTION_SUCCEEDED,
    "session.execution.failed.1",
    "session.execution.interrupted.1",
    STEP_STARTED,
    STEP_ENDED,
    STEP_FAILED,
    TEXT_ENDED,
    TOOL_INPUT_STARTED,
    TOOL_CALLED,
    TOOL_SUCCESS,
    TOOL_FAILED,
];
const FAILURES: [&str; 2] = [STEP_FAILED, TOOL_FAILED];
pub(super) const ACTIVE_TASKS: [&str; 4] = ["starting", "running", "waiting", "cancelling"];
const PAGE: usize = 128;
const MAX_COMPLETIONS: usize = 200;

#[derive(Clone)]
pub struct Completion {
    sessions: Service,
    jobs: job::Jobs,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub id: event::Id,
    pub seq: i64,
    pub created: i64,
    pub session_id: session::Id,
    pub input_id: session_message::Id,
    pub assistant_message_id: session_message::Id,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Receipts {
    pub data: Vec<Receipt>,
    pub next: Option<session::Id>,
}

#[derive(Clone, Debug)]
pub struct Page {
    pub after: Option<session::Id>,
    pub limit: usize,
}

#[derive(Clone, Debug, PartialEq)]
struct Candidate {
    id: String,
    input_id: LosslessString,
    assistant_message_id: LosslessString,
}

impl Completion {
    pub fn new(sessions: Service, jobs: job::Jobs) -> Self {
        Self { sessions, jobs }
    }

    pub async fn complete(&self, session_id: &session::Id, active: Active) -> Result<(), Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let mut reader = Reader::Snapshot(&snapshot);
        let Some(candidate) = candidate(&mut reader, session_id)? else {
            return Ok(());
        };
        if reader
            .get::<EventTable>(&key(&candidate.id.as_str().into()))?
            .is_some()
            || unfinished(&mut reader, &self.jobs, session_id, &active)?
        {
            return Ok(());
        }
        drop(snapshot);
        let (jobs, session_id) = (self.jobs.clone(), session_id.clone());
        self.sessions
            .client
            .submit(move |tx| {
                let mut reader = Reader::Transaction(tx);
                let publishable =
                    candidate_is_current(&mut reader, &jobs, &session_id, &active, &candidate)?;
                if !publishable {
                    return Ok(());
                }
                let appended = tables::append(
                    tx,
                    &NewEvent {
                        id: candidate.id.as_str().into(),
                        aggregate_id: session_id.as_lossless().clone(),
                        created: chrono::Utc::now().timestamp_millis(),
                        type_: COMPLETED.into(),
                        data: ObjectEncoder::new()
                            .field("sessionID", &session_id)
                            .field("inputID", &candidate.input_id)
                            .field("assistantMessageID", &candidate.assistant_message_id)
                            .finish(),
                    },
                    None,
                )?;
                match appended {
                    Append::Appended(_) => Ok(()),
                    _ => Err(tx.reject(Error::Rejected("completion did not append"))),
                }
            })?
            .await
    }

    pub fn latest(&self, page: Page) -> Result<Receipts, Error> {
        if page.limit < 1 || page.limit > MAX_COMPLETIONS {
            return Err(Error::Rejected("Invalid completion page"));
        }
        let snapshot = self.sessions.client.snapshot()?;
        let mut found = Vec::new();
        let mut lower = page.after.as_ref().map(|id| key(id.as_lossless()));
        loop {
            let rows = snapshot.scan::<SessionTable>(
                lower.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                PAGE,
            )?;
            let Some(last) = rows.last() else { break };
            lower = Some(key(&last.id));
            let exhausted = rows.len() < PAGE;
            for row in rows.into_iter().filter(|row| row.parent_id.is_none()) {
                if let Some(event) = Reader::Snapshot(&snapshot).latest(&row.id, COMPLETED)? {
                    found.push(receipt(&event)?);
                }
                if found.len() > page.limit {
                    break;
                }
            }
            if exhausted || found.len() > page.limit {
                break;
            }
        }
        let more = found.len() > page.limit;
        found.truncate(page.limit);
        let next = match (more, found.last()) {
            (true, Some(last)) => Some(last.session_id.clone()),
            _ => None,
        };
        Ok(Receipts { data: found, next })
    }
}

fn candidate_is_current(
    reader: &mut Reader<'_, '_>,
    jobs: &job::Jobs,
    session_id: &session::Id,
    active: &Active,
    expected: &Candidate,
) -> Result<bool, Error> {
    let Some(current) = candidate(reader, session_id)? else {
        return Ok(false);
    };
    Ok(current == *expected
        && reader
            .get::<EventTable>(&key(&current.id.as_str().into()))?
            .is_none()
        && !unfinished(reader, jobs, session_id, active)?)
}

fn receipt(event: &Event) -> Result<Receipt, Error> {
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&event.data, &path).map_err(super::projector::record_error)?;
    Ok(Receipt {
        id: event::Id::new(event.id.clone()).map_err(super::projector::record_error)?,
        seq: event.seq,
        created: event.created,
        session_id: object
            .field("sessionID")
            .map_err(super::projector::record_error)?,
        input_id: object
            .field("inputID")
            .map_err(super::projector::record_error)?,
        assistant_message_id: object
            .field("assistantMessageID")
            .map_err(super::projector::record_error)?,
    })
}

fn candidate(
    reader: &mut Reader<'_, '_>,
    session_id: &session::Id,
) -> Result<Option<Candidate>, Error> {
    let Some(execution) = reader.latest(session_id.as_lossless(), EXECUTION_STARTED)? else {
        return Ok(None);
    };
    let history = reader.history(session_id.as_lossless(), execution.seq)?;
    let Some(declared) = declared(&history) else {
        return Ok(None);
    };
    let Some(promoted) = reader.before(
        session_id.as_lossless(),
        INPUT_PROMOTED,
        declared.invoking_seq,
    )?
    else {
        return Ok(None);
    };
    let Some(admitted) = reader.latest(session_id.as_lossless(), INPUT_ADMITTED)? else {
        return Ok(None);
    };
    let (Some(JsonValue::String(input_id)), Some(admitted_id)) =
        (field(&promoted, "inputID"), field(&admitted, "inputID"))
    else {
        return Ok(None);
    };
    if admitted_id != &JsonValue::String(input_id.clone()) {
        return Ok(None);
    }
    if reader.committed_after(session_id, declared.invoking_seq)? {
        return Ok(None);
    }
    let revert = reader
        .latest(session_id.as_lossless(), REVERT_COMMITTED)?
        .map_or(-1, |event| event.seq);
    let digest = digest::digest(
        &digest::SHA256,
        format!(
            "{}\0{}\0{revert}",
            session_id.as_lossless().to_utf8().unwrap_or_default(),
            admitted.seq
        )
        .as_bytes(),
    );
    Ok(Some(Candidate {
        id: format!(
            "evt_work_{}",
            digest
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()[..24]
                .to_owned()
        ),
        input_id: input_id.clone(),
        assistant_message_id: declared.final_message_id,
    }))
}

struct Declared {
    final_message_id: LosslessString,
    invoking_seq: i64,
}

fn declared(history: &[Event]) -> Option<Declared> {
    let kind = |event: &Event| event.type_.as_str().unwrap_or_default().to_owned();
    let last = |name: &str| history.iter().rev().find(|event| kind(event) == name);
    let terminal = history
        .iter()
        .rev()
        .find(|event| kind(event).starts_with(EXECUTION_PREFIX))?;
    if kind(terminal) != EXECUTION_SUCCEEDED {
        return None;
    }
    let step = last(STEP_STARTED)?;
    let ended = last(STEP_ENDED)?;
    let final_id = text(ended, "assistantMessageID")?;
    if text(step, "assistantMessageID")? != final_id || text(ended, "finish")? != "stop" {
        return None;
    }
    if !history.iter().any(|event| {
        kind(event) == TEXT_ENDED
            && text(event, "assistantMessageID") == Some(final_id)
            && text(event, "phase") != Some("commentary")
            && text(event, "text").is_some_and(|text| !text.trim().is_empty())
    }) {
        return None;
    }
    let same_call = |left: &Event, right: &Event| {
        text(left, "assistantMessageID") == text(right, "assistantMessageID")
            && text(left, "callID") == text(right, "callID")
    };
    let declaration = history.iter().rev().find(|event| {
        kind(event) == TOOL_SUCCESS
            && !executed(event)
            && matches!(
                field(event, "structured"),
                Some(JsonValue::Object(structured))
                    if structured.get(&"recorded".into()) == Some(&JsonValue::Bool(true))
            )
            && history.iter().any(|input| {
                kind(input) == TOOL_INPUT_STARTED
                    && text(input, "name") == Some("task_complete")
                    && same_call(input, event)
            })
    })?;
    if text(declaration, "assistantMessageID")? == final_id || declaration.seq >= step.seq {
        return None;
    }
    let invoking = history.iter().find(|event| {
        kind(event) == STEP_STARTED
            && text(event, "assistantMessageID") == text(declaration, "assistantMessageID")
    })?;
    if !history.iter().any(|event| {
        kind(event) == TOOL_CALLED && same_call(event, declaration) && !executed(event)
    }) {
        return None;
    }
    if history.iter().any(|event| {
        event.seq > declaration.seq
            && (FAILURES.contains(&kind(event).as_str())
                || (kind(event) == TOOL_CALLED
                    && text(event, "assistantMessageID") == Some(final_id)))
    }) {
        return None;
    }
    Some(Declared {
        final_message_id: final_id.into(),
        invoking_seq: invoking.seq,
    })
}

fn unfinished(
    reader: &mut Reader<'_, '_>,
    jobs: &job::Jobs,
    session_id: &session::Id,
    active: &Active,
) -> Result<bool, Error> {
    let family = family(reader, session_id)?;
    let running = active();
    if family.is_empty()
        || !running.contains(session_id)
        || running
            .iter()
            .any(|id| id != session_id && family.contains(id.as_lossless()))
    {
        return Ok(true);
    }
    for id in &family {
        let session = key(id);
        if !reader
            .range::<PendingTable>("session_pending_session_admitted_seq_idx", &session, 1)?
            .is_empty()
        {
            return Ok(true);
        }
        let row = reader.get::<SessionTable>(&session)?;
        if row.is_some_and(|row| row.revert.is_some() || goal_active(row.autonomy.as_ref())) {
            return Ok(true);
        }
        for state in ACTIVE_TASKS {
            let prefix = tuple_key(&[KeyPart::String(id), KeyPart::String(&state.into())]);
            if !reader
                .range::<TaskTable>("session_task_parent_state_updated_idx", &prefix, 1)?
                .is_empty()
            {
                return Ok(true);
            }
        }
    }
    let undelivered = tuple_key(&[KeyPart::I64(0)]);
    if reader
        .range::<NotificationTable>(
            "session_task_notification_delivery_idx",
            &undelivered,
            usize::MAX,
        )?
        .iter()
        .any(|notice| family.contains(&notice.parent_id))
    {
        return Ok(true);
    }
    let members = |id: &str| session::Id::new(id).is_ok_and(|id| family.contains(id.as_lossless()));
    Ok(jobs
        .outstanding_sessions()
        .iter()
        .any(|id| family.contains(id.as_lossless()))
        || jobs.list().iter().any(|info| {
            info.status == job::Status::Running
                && info
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("sessionID")?.as_str())
                    .is_some_and(members)
        }))
}

fn family(
    reader: &mut Reader<'_, '_>,
    session_id: &session::Id,
) -> Result<BTreeSet<LosslessString>, Error> {
    if reader
        .get::<SessionTable>(&key(session_id.as_lossless()))?
        .is_none()
    {
        return Ok(BTreeSet::new());
    }
    let mut ordered = vec![session_id.as_lossless().clone()];
    let mut seen = BTreeSet::from([session_id.as_lossless().clone()]);
    let mut cursor = 0;
    while cursor < ordered.len() {
        let children = reader.range::<SessionTable>(
            "session_parent_idx",
            &key(&ordered[cursor]),
            usize::MAX,
        )?;
        for child in children {
            if seen.insert(child.id.clone()) {
                ordered.push(child.id);
            }
        }
        cursor += 1;
    }
    Ok(seen)
}

pub(super) fn goal_active(autonomy: Option<&JsonValue>) -> bool {
    let Some(JsonValue::Object(autonomy)) = autonomy else {
        return false;
    };
    let Some(JsonValue::Object(goal)) = autonomy.get(&"goal".into()) else {
        return false;
    };
    goal.get(&"status".into()) == Some(&JsonValue::String("active".into()))
}

fn field<'a>(event: &'a Event, name: &str) -> Option<&'a JsonValue> {
    match &event.data {
        JsonValue::Object(object) => object.get(&name.into()),
        _ => None,
    }
}

fn text<'a>(event: &'a Event, name: &str) -> Option<&'a str> {
    match field(event, name)? {
        JsonValue::String(text) => text.as_str(),
        _ => None,
    }
}

fn executed(event: &Event) -> bool {
    field(event, "executed") == Some(&JsonValue::Bool(true))
}

enum Reader<'a, 'b> {
    Snapshot(&'a Snapshot),
    Transaction(&'a mut Write<'b>),
}

impl Reader<'_, '_> {
    fn get<T: TableSpec>(&mut self, key: &[u8]) -> Result<Option<T::Record>, Error> {
        match self {
            Self::Snapshot(snapshot) => snapshot.get::<T>(key),
            Self::Transaction(tx) => tx.get::<T>(key),
        }
    }

    fn index<T: TableSpec>(
        &mut self,
        name: &str,
        query: IndexQuery<'_>,
    ) -> Result<Vec<IndexEntry<T::Record>>, Error> {
        match self {
            Self::Snapshot(snapshot) => snapshot.index_range::<T>(name, query),
            Self::Transaction(tx) => tx.index_range::<T>(name, query),
        }
    }

    fn range<T: TableSpec>(
        &mut self,
        name: &str,
        prefix: &[u8],
        limit: usize,
    ) -> Result<Vec<T::Record>, Error> {
        let mut records = Vec::new();
        let mut after = None;
        while records.len() < limit {
            let rows = self.index::<T>(
                name,
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: (limit - records.len()).min(PAGE),
                },
            )?;
            let Some(last) = rows.last() else { break };
            after = Some(last.cursor.clone());
            records.extend(rows.into_iter().map(|row| row.record));
        }
        Ok(records)
    }

    fn latest(&mut self, session: &LosslessString, type_: &str) -> Result<Option<Event>, Error> {
        self.typed(session, type_, Bound::Unbounded)
    }

    fn before(
        &mut self,
        session: &LosslessString,
        type_: &str,
        seq: i64,
    ) -> Result<Option<Event>, Error> {
        let upper = tuple_key(&[
            KeyPart::String(session),
            KeyPart::String(&type_.into()),
            KeyPart::I64(seq),
        ]);
        self.typed(session, type_, Bound::Excluded(&upper))
    }

    fn typed(
        &mut self,
        session: &LosslessString,
        type_: &str,
        upper: Bound<&[u8]>,
    ) -> Result<Option<Event>, Error> {
        let prefix = tuple_key(&[KeyPart::String(session), KeyPart::String(&type_.into())]);
        Ok(self
            .index::<EventTable>(
                "event_aggregate_type_seq_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper,
                    prefix: Some(&prefix),
                    order: IndexOrder::Descending,
                    after: None,
                    limit: 1,
                },
            )?
            .pop()
            .map(|entry| entry.record))
    }

    fn history(&mut self, session: &LosslessString, after: i64) -> Result<Vec<Event>, Error> {
        let prefix = key(session);
        let lower = tuple_key(&[KeyPart::String(session), KeyPart::I64(after)]);
        let mut history = Vec::new();
        let mut cursor = None;
        loop {
            let rows = self.index::<EventTable>(
                "event_aggregate_seq_idx",
                IndexQuery {
                    lower: Bound::Excluded(&lower),
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: cursor.as_ref(),
                    limit: PAGE,
                },
            )?;
            let Some(last) = rows.last() else {
                return Ok(history);
            };
            cursor = Some(last.cursor.clone());
            history.extend(rows.into_iter().map(|row| row.record).filter(|event| {
                HISTORY
                    .iter()
                    .any(|name| event.type_.as_str() == Some(name))
            }));
        }
    }

    fn committed_after(&mut self, session: &session::Id, seq: i64) -> Result<bool, Error> {
        match self {
            Self::Snapshot(snapshot) => revert::committed_after(snapshot, session, seq),
            Self::Transaction(tx) => revert::committed_after_in(tx, session, seq),
        }
    }
}
