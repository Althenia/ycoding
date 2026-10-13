use crate::session::{key, projector::record_error};
use std::ops::Bound;
use ycoding_schema::{
    DomainEncode, JsonPath, LosslessString, ObjectDecoder, domain, model, session_event,
    session_orchestration::{Change, NotificationType},
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{Document, Event, Notification, NotificationTable, SessionTable, Task, TaskTable},
    tuple_key,
};

const ACTIVE: [&str; 4] = ["starting", "running", "waiting", "cancelling"];
const TERMINAL: [&str; 4] = ["cancelled", "completed", "failed", "lost"];

pub fn apply(
    tx: &mut Write<'_>,
    event: &Event,
    decoded: &session_event::Event,
) -> Result<(), Error> {
    let data = decoded.data.encode();
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&data, &path).map_err(record_error)?;
    let change: Change = object.field("change").map_err(record_error)?;
    if let Change::Launched {
        parent_id,
        parent_assistant_message_id,
        tool_call_id,
        input_id,
        description,
        agent,
        model,
        prompt_digest,
        background,
        delivery,
    } = &change
    {
        TaskTable::insert(
            tx,
            &Task {
                session_id: event.aggregate_id.clone(),
                parent_id: parent_id.as_lossless().clone(),
                parent_assistant_message_id: parent_assistant_message_id.as_lossless().clone(),
                tool_call_id: tool_call_id.clone(),
                input_id: input_id.as_lossless().clone(),
                description: description.clone(),
                agent: agent.clone(),
                model: Document::<model::Ref>::from_domain(model)?,
                prompt_digest: prompt_digest.clone(),
                background: i64::from(*background),
                delivery: delivery.as_str().into(),
                state: "starting".into(),
                progress: None,
                progress_time: None,
                question_id: None,
                question: None,
                question_data: None,
                question_time: None,
                attempt_started: 0,
                revision: 0,
                time_created: event.created,
                time_updated: event.created,
            },
        )?;
        return bump_parent(tx, parent_id.as_lossless());
    }
    let mut row = tx
        .get::<TaskTable>(&key(&event.aggregate_id))?
        .ok_or(Error::Rejected("Task does not exist"))?;
    let state = row.state.as_str().unwrap_or_default().to_owned();
    let invalid = Error::Rejected("Invalid task transition");
    let revision = row.revision + 1;
    let mut notify = None;
    match change {
        Change::Launched { .. } => return Err(Error::Rejected("Task launch repeated")),
        Change::Started => {
            if state != "starting" {
                if !TERMINAL.contains(&state.as_str()) {
                    return Err(invalid);
                }
                row.progress = None;
                row.progress_time = None;
                clear_question(&mut row);
                row.attempt_started = 0;
            }
            row.state = "running".into();
        }
        Change::Backgrounded => {
            if state != "running" || row.background != 0 {
                return Err(invalid);
            }
            row.background = 1;
        }
        Change::Progressed { progress } => {
            if state != "running" {
                return Err(invalid);
            }
            row.progress = Some(progress.text);
            row.progress_time = Some(progress.time.get());
        }
        Change::QuestionAsked { question } => {
            if state != "running" || row.question_id.is_some() {
                return Err(invalid);
            }
            row.state = "waiting".into();
            row.question_id = Some(question.id.0);
            row.question = Some(question.text);
            row.question_data = question
                .data
                .as_ref()
                .map(Document::<domain::Json>::from_domain)
                .transpose()?;
            row.question_time = Some(question.time.get());
            notify = Some((NotificationType::Question, None));
        }
        Change::QuestionAnswered { answer } => {
            if state != "waiting" || row.question_id.as_ref() != Some(&answer.question_id.0) {
                return Err(invalid);
            }
            row.state = "running".into();
            clear_question(&mut row);
        }
        Change::CancelRequested => {
            if !["starting", "running", "waiting"].contains(&state.as_str()) {
                return Err(invalid);
            }
            row.state = "cancelling".into();
        }
        Change::Cancelled => {
            if state != "cancelling" {
                return Err(invalid);
            }
            row.state = "cancelled".into();
            notify = Some((NotificationType::Cancelled, None));
        }
        Change::Completed { excerpt } => {
            if state != "running" {
                return Err(invalid);
            }
            row.state = "completed".into();
            if detached(tx, &row)? {
                notify = Some((NotificationType::Completed, excerpt));
            }
        }
        Change::Failed { error, excerpt } => {
            if state != "running" {
                return Err(invalid);
            }
            row.state = "failed".into();
            if detached(tx, &row)? {
                notify = Some((NotificationType::Failed, excerpt.or(Some(error))));
            }
        }
        Change::Lost { excerpt } => {
            if !ACTIVE.contains(&state.as_str()) {
                return Err(invalid);
            }
            row.state = "lost".into();
            notify = Some((NotificationType::Lost, excerpt));
        }
    }
    row.revision = revision;
    row.time_updated = event.created;
    TaskTable::put(tx, &row)?;
    bump_parent(tx, &row.parent_id)?;
    if let Some((kind, excerpt)) = notify {
        let name = super::identity::notification_name(&kind);
        NotificationTable::insert(
            tx,
            &Notification {
                id: format!(
                    "ntf_{}_{revision}_{name}",
                    event.aggregate_id.as_str().unwrap_or_default()
                )
                .into(),
                task_session_id: row.session_id.clone(),
                parent_id: row.parent_id.clone(),
                type_: name.into(),
                revision,
                excerpt,
                delivered: 0,
                time_created: event.created,
                time_delivered: None,
            },
        )?;
    }
    Ok(())
}

pub fn mark_attempt(
    tx: &mut Write<'_>,
    session_id: &LosslessString,
    started: bool,
) -> Result<(), Error> {
    if let Some(mut row) = tx.get::<TaskTable>(&key(session_id))? {
        row.attempt_started = i64::from(started);
        TaskTable::put(tx, &row)?;
    }
    Ok(())
}

pub fn delete_session(tx: &mut Write<'_>, session_id: &LosslessString) -> Result<(), Error> {
    let parent = tx
        .get::<TaskTable>(&key(session_id))?
        .map(|row| row.parent_id);
    ycoding_store::session::delete(tx, session_id)?;
    if let Some(parent) = parent
        && tx.get::<SessionTable>(&key(&parent))?.is_some()
    {
        bump_parent(tx, &parent)?;
    }
    Ok(())
}

fn clear_question(row: &mut Task) {
    row.question_id = None;
    row.question = None;
    row.question_data = None;
    row.question_time = None;
}

fn detached(tx: &mut Write<'_>, row: &Task) -> Result<bool, Error> {
    if row.background != 0 {
        return Ok(true);
    }
    let prefix = tuple_key(&[
        KeyPart::String(&row.session_id),
        KeyPart::String(&"question".into()),
    ]);
    Ok(!tx
        .index_range::<NotificationTable>(
            "session_task_notification_transition_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: None,
                limit: 1,
            },
        )?
        .is_empty())
}

fn bump_parent(tx: &mut Write<'_>, parent_id: &LosslessString) -> Result<(), Error> {
    let mut parent = tx
        .get::<SessionTable>(&key(parent_id))?
        .ok_or(Error::Rejected("Task parent does not exist"))?;
    parent.orchestration_revision += 1;
    SessionTable::put(tx, &parent)
}
