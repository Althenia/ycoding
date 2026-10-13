use super::{key, store::Service};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, event, session_event, session_message, session_pending,
};
use ycoding_store::{
    Error, Write,
    session::{
        self as tables, ContextState, ContextStateTable, Document, Event, Message, MessageTable,
        NewEvent, Pending, PendingTable, Revision, RevisionTable, Session, SessionTable,
    },
};

pub fn decode(event: &Event) -> Result<session_event::DurableEvent, Error> {
    let (name, version) = event
        .type_
        .as_str()
        .and_then(|value| value.rsplit_once('.'))
        .ok_or(Error::Rejected("invalid versioned Session event"))?;
    let version: i64 = version
        .parse()
        .map_err(|_| Error::Rejected("invalid Session event version"))?;
    session_event::DurableEvent::decode(
        &ObjectEncoder::new()
            .field("id", &event.id)
            .field("created", &(event.created as f64))
            .field("type", name)
            .field(
                "durable",
                &ObjectEncoder::new()
                    .field("aggregateID", &event.aggregate_id)
                    .field("seq", &(event.seq as f64))
                    .field("version", &(version as f64))
                    .finish(),
            )
            .field("data", &event.data)
            .finish(),
    )
    .map_err(|error| Error::Record(Box::new(error)))
}

impl Service {
    pub async fn publish(&self, event: NewEvent) -> Result<Event, Error> {
        self.client.submit(move |tx| append(tx, &event))?.await
    }

    pub async fn create(&self, event: NewEvent) -> Result<ycoding_schema::session::Info, Error> {
        if event.type_.as_str() != Some("session.created.2") {
            return Err(Error::Rejected("create requires session.created.2"));
        }
        let row = self
            .client
            .submit(move |tx| {
                if let Some(row) = tx.get::<SessionTable>(&key(&event.aggregate_id))? {
                    return Ok(row);
                }
                append(tx, &event)?;
                tx.get::<SessionTable>(&key(&event.aggregate_id))?
                    .ok_or(Error::Rejected("created Session missing"))
            })?
            .await?;
        super::info::from_row(&row)
    }
}

pub(crate) fn append(tx: &mut Write<'_>, event: &NewEvent) -> Result<Event, Error> {
    let appended = tables::append(tx, event, None)?;
    let tables::Append::Appended(event) = appended else {
        return Err(tx.reject(Error::Rejected("new publication did not append")));
    };
    fold(tx, &event).map_err(|error| tx.reject(error))?;
    Ok(event)
}

pub fn fold(tx: &mut Write<'_>, event: &Event) -> Result<(), Error> {
    let decoded = decode(event)?;
    let data = decoded.0.data.encode();
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&data, &path).map_err(record_error)?;
    let id: ycoding_schema::session::Id = object.field("sessionID").map_err(record_error)?;
    if id.as_lossless() != &event.aggregate_id {
        return Err(Error::Rejected(
            "Session event aggregate differs from sessionID",
        ));
    }
    match event.type_.as_str() {
        Some("session.forked.2") => super::fork::apply(tx, event, &object)?,
        Some("session.file-change.recorded.1") => super::file_change::apply(tx, event, &object)?,
        Some("session.instructions.updated.2") => super::instruction_state::apply(tx, event)?,
        Some("session.created.2") => {
            let location: ycoding_schema::location::Ref =
                object.field("location").map_err(record_error)?;
            let parent: Option<ycoding_schema::session::Id> =
                object.optional("parentID").map_err(record_error)?;
            let permission: Option<ycoding_schema::permission::Ruleset> =
                object.optional("permissionCeiling").map_err(record_error)?;
            let mut seen = std::collections::BTreeSet::new();
            let permission = permission
                .unwrap_or_default()
                .into_iter()
                .filter(|rule| {
                    rule.effect.0.as_str() == Some("deny")
                        && seen.insert((rule.action.clone(), rule.resource.clone()))
                })
                .collect::<Vec<_>>();
            let created: ycoding_schema::schema::NonNegativeInt =
                object.field("created").map_err(record_error)?;
            let daybreak = parent
                .as_ref()
                .map(|id| tx.get::<SessionTable>(&key(id.as_lossless())))
                .transpose()?
                .flatten()
                .and_then(|row| row.daybreak);
            SessionTable::insert(
                tx,
                &Session {
                    id: event.aggregate_id.clone(),
                    project_id: object.field("projectID").map_err(record_error)?,
                    directory: location.directory.as_lossless().clone(),
                    workspace_id: location
                        .workspace_id
                        .as_ref()
                        .map(|id| id.as_lossless().clone()),
                    parent_id: parent.map(|id| id.as_lossless().clone()),
                    fork_session_id: None,
                    fork_message_id: None,
                    fork_seq: None,
                    path: object.optional("subpath").map_err(record_error)?,
                    title: object.field("title").map_err(record_error)?,
                    cost: 0.0,
                    tokens_input: 0,
                    tokens_output: 0,
                    tokens_reasoning: 0,
                    tokens_cache_read: 0,
                    tokens_cache_write: 0,
                    agent: object.optional("agent").map_err(record_error)?,
                    model: object
                        .optional::<ycoding_schema::model::Ref>("model")
                        .map_err(record_error)?
                        .as_ref()
                        .map(Document::from_domain)
                        .transpose()?,
                    permission: (!permission.is_empty())
                        .then(|| Document::from_domain(&permission))
                        .transpose()?,
                    daybreak,
                    profile_binding: None,
                    revert: None,
                    autonomy: None,
                    autonomy_revision: 0,
                    orchestration_revision: 0,
                    time_created: created.get(),
                    time_updated: created.get(),
                    time_active: None,
                    time_archived: None,
                    time_pinned: None,
                    time_suspended: None,
                },
            )?;
            RevisionTable::insert(
                tx,
                &Revision {
                    session_id: event.aggregate_id.clone(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: created.get(),
                },
            )?;
            ContextStateTable::insert(
                tx,
                &ContextState {
                    session_id: event.aggregate_id.clone(),
                    status: "active".into(),
                    revision: 0,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activated_event_id: None,
                    time_activated: None,
                    error_code: None,
                },
            )?;
            if let Some(workspace) = &location.workspace_id
                && let Some(mut row) =
                    tx.get::<ycoding_store::project::WorkspaceTable>(&key(workspace.as_lossless()))?
            {
                row.time_used = event.created;
                ycoding_store::project::WorkspaceTable::put(tx, &row)?;
            }
        }
        Some("session.input.admitted.1") => {
            let input: session_pending::Message = object.field("input").map_err(record_error)?;
            let input_id: session_message::Id = object.field("inputID").map_err(record_error)?;
            if tx
                .get::<MessageTable>(&key(input_id.as_lossless()))?
                .is_some()
            {
                return Err(super::pending::conflict());
            }
            let (type_, data, delivery) = match input {
                session_pending::Message::User(input) => {
                    ("user", input.data.encode(), input.delivery.encode())
                }
                session_pending::Message::Synthetic(input) => {
                    ("synthetic", input.data.encode(), input.delivery.encode())
                }
            };
            let JsonValue::String(delivery) = delivery else {
                return Err(super::pending::conflict());
            };
            PendingTable::insert(
                tx,
                &Pending {
                    id: input_id.as_lossless().clone(),
                    session_id: event.aggregate_id.clone(),
                    type_: type_.into(),
                    data,
                    delivery: Some(delivery),
                    admitted_seq: event.seq,
                    time_created: event.created,
                },
            )?;
        }
        Some("session.input.promoted.1") => {
            let input_id: session_message::Id = object.field("inputID").map_err(record_error)?;
            let pending = tx
                .get::<PendingTable>(&key(input_id.as_lossless()))?
                .ok_or_else(super::pending::conflict)?;
            if pending.session_id != event.aggregate_id {
                return Err(super::pending::conflict());
            }
            let JsonValue::Object(mut data) = pending.data else {
                return Err(super::pending::conflict());
            };
            data.insert(
                "time".into(),
                ObjectEncoder::new()
                    .field("created", &(event.created as f64))
                    .finish(),
            );
            let message = Message {
                id: pending.id,
                session_id: pending.session_id,
                type_: pending.type_,
                seq: event.seq,
                time_created: event.created,
                time_updated: event.created,
                data: JsonValue::Object(data),
            };
            message.info()?;
            tables::promote(tx, &message)?;
        }
        Some(
            "session.renamed.1"
            | "session.daybreak.set.1"
            | "session.archived.2"
            | "session.unarchived.2"
            | "session.pinned.1"
            | "session.unpinned.1"
            | "session.revert.staged.1"
            | "session.revert.cleared.1"
            | "session.execution.started.1"
            | "session.execution.succeeded.1"
            | "session.execution.failed.1"
            | "session.execution.interrupted.1",
        ) => {
            let mut row = tx
                .get::<SessionTable>(&key(&event.aggregate_id))?
                .ok_or(Error::Rejected("Session not found"))?;
            match event.type_.as_str() {
                Some("session.daybreak.set.1") => {
                    row.daybreak = object
                        .optional::<ycoding_schema::model::Daybreak>("daybreak")
                        .map_err(record_error)?
                        .map(|daybreak| daybreak.0);
                    row.time_updated = event.created;
                }
                Some("session.renamed.1") => {
                    row.title = object.field("title").map_err(record_error)?;
                    row.time_updated = event.created;
                }
                Some("session.archived.2") => row.time_archived = Some(event.created),
                Some("session.unarchived.2") => row.time_archived = None,
                Some("session.pinned.1") => row.time_pinned = Some(event.created),
                Some("session.unpinned.1") => row.time_pinned = None,
                Some("session.revert.staged.1") => super::revert::apply_staged(
                    &mut row,
                    &object.field("revert").map_err(record_error)?,
                    event.created,
                )?,
                Some("session.revert.cleared.1") => {
                    super::revert::apply_cleared(&mut row, event.created)
                }
                Some("session.execution.started.1") => {}
                _ => {
                    row.time_active = Some(
                        row.time_active
                            .map_or(event.created, |time| time.max(event.created)),
                    )
                }
            }
            SessionTable::put(tx, &row)?;
            if matches!(
                event.type_.as_str(),
                Some(
                    "session.execution.succeeded.1"
                        | "session.execution.failed.1"
                        | "session.execution.interrupted.1"
                )
            ) {
                super::message_updater::clear_current_retry(tx, event)?;
            }
        }
        Some("session.moved.1") => {
            let location: ycoding_schema::location::Ref =
                object.field("location").map_err(record_error)?;
            let mut row = tx
                .get::<SessionTable>(&key(&event.aggregate_id))?
                .ok_or(Error::Rejected("Session not found"))?;
            row.directory = location.directory.as_lossless().clone();
            row.workspace_id = location
                .workspace_id
                .as_ref()
                .map(|id| id.as_lossless().clone());
            if let Some(project) = object.optional("projectID").map_err(record_error)? {
                row.project_id = project;
            }
            if let Some(subpath) = object.optional("subpath").map_err(record_error)? {
                row.path = Some(subpath);
            }
            row.time_updated = event.created;
            SessionTable::put(tx, &row)?;
            tx.delete::<ycoding_store::session::InstructionStateTable>(&key(&event.aggregate_id))?;
        }
        Some("session.revert.committed.1") => super::revert::apply_committed(
            tx,
            &event.aggregate_id,
            &object.field("to").map_err(record_error)?,
            event.created,
        )?,
        Some("session.task.updated.1") => super::orchestration::apply(tx, event, &decoded.0)?,
        Some("session.deleted.2") => super::orchestration::delete_session(tx, &event.aggregate_id)?,
        Some("session.step.started.1" | "session.step.ended.1" | "session.step.failed.1") => {
            super::message_updater::fold(tx, event, &decoded.0)?;
            super::orchestration::mark_attempt(
                tx,
                &event.aggregate_id,
                event.type_.as_str() == Some("session.step.started.1"),
            )?
        }
        Some("session.skill.activated.1" | "session.skill.deactivated.1") => {
            super::skill_status::apply(tx, event, &decoded.0)?
        }
        Some("session.provider.request.recorded.1") => {
            super::provider_request::apply(tx, &object, &event.aggregate_id)?
        }
        Some(
            "session.compaction.admitted.2"
            | "session.compaction.started.2"
            | "session.compaction.ended.2"
            | "session.compaction.failed.2",
        ) => super::compaction_job::fold(tx, event, &decoded.0)?,
        Some(
            "session.compaction.replaced.1"
            | "session.work.completed.1"
            | "session.guardrail.approved.1",
        ) => {}
        _ => return super::message_updater::fold(tx, event, &decoded.0),
    }
    Ok(())
}

pub(crate) fn record_error(error: ycoding_schema::DecodeError) -> Error {
    Error::Record(Box::new(error))
}

pub(crate) fn insert_message(
    tx: &mut Write<'_>,
    event: &Event,
    message: &session_message::Info,
) -> Result<(), Error> {
    let JsonValue::Object(value) = message.encode() else {
        return Err(Error::Rejected("message must encode an object"));
    };
    let id = value
        .get(&"id".into())
        .ok_or(Error::Rejected("message ID missing"))?;
    let type_ = value
        .get(&"type".into())
        .ok_or(Error::Rejected("message type missing"))?;
    let mut data = JsonObject::new();
    for (key, value) in value
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), Some("id" | "type")))
    {
        data.insert(key.clone(), value.clone());
    }
    MessageTable::insert(
        tx,
        &Message {
            id: LosslessString::decode(id).map_err(record_error)?,
            session_id: event.aggregate_id.clone(),
            type_: LosslessString::decode(type_).map_err(record_error)?,
            seq: event.seq,
            time_created: event.created,
            time_updated: event.created,
            data: JsonValue::Object(data),
        },
    )
}

pub(crate) fn random_event_id() -> Result<event::Id, Error> {
    use ring::rand::SecureRandom;
    let mut entropy = [0u8; 16];
    ring::rand::SystemRandom::new()
        .fill(&mut entropy)
        .map_err(|_| Error::Rejected("event entropy unavailable"))?;
    event::Id::new(format!(
        "evt_{}",
        entropy
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
    .map_err(record_error)
}
