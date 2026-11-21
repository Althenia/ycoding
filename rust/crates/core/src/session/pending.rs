use super::retired_input;
use super::{key, store::Service};
use std::ops::Bound;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonPath, ObjectDecoder, ObjectEncoder, event, session,
    session_event, session_message, session_pending, usage_anchor,
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{
        self as tables, Admission, ContextStateTable, EventTable, MessageTable, NewEvent, Pending,
        PendingTable,
    },
    tuple_key,
};

#[derive(Clone, Debug)]
pub struct Request {
    pub id: session_message::Id,
    pub session_id: session::Id,
    pub input: session_pending::Message,
    pub event_id: event::Id,
    pub created: i64,
}

#[derive(Clone, Debug)]
pub struct Admitted {
    pub pending: Pending,
    pub wake: bool,
    pub fresh: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Promotion {
    Promoted,
    Reconciled,
    Rejected,
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    Remove,
    Steer,
}

pub(crate) fn conflict() -> Error {
    Error::Domain {
        kind: "input_identity",
        message: "input identity belongs to another session or kind, or has no admitted event",
    }
}

impl Service {
    pub async fn control_pending(
        &self,
        id: &session::Id,
        input_id: &session_message::Id,
        control: Control,
        now: i64,
    ) -> Result<bool, Error> {
        let _inbox = super::autonomy::inbox(&self.client, id).await;
        let id = id.as_lossless().clone();
        let input_id = input_id.as_lossless().clone();
        self.client
            .submit(move |tx| {
                let pending = tx
                    .get::<PendingTable>(&key(&input_id))?
                    .filter(|pending| pending.session_id == id)
                    .ok_or(Error::Domain {
                        kind: "pending_input_not_found",
                        message: "Pending input not found",
                    })?;
                if pending.type_.as_str() != Some("user") {
                    return Err(Error::Domain {
                        kind: "pending_input_invalid",
                        message: "Only pending user inputs can be removed or steered",
                    });
                }
                if control == Control::Steer
                    && pending
                        .delivery
                        .as_ref()
                        .and_then(|delivery| delivery.as_str())
                        == Some("steer")
                {
                    return Ok(false);
                }
                super::projector::append(
                    tx,
                    &NewEvent {
                        id: super::projector::random_event_id()?.as_lossless().clone(),
                        aggregate_id: id.clone(),
                        created: now,
                        type_: match control {
                            Control::Remove => "session.input.withdrawn.1",
                            Control::Steer => "session.input.steered.1",
                        }
                        .into(),
                        data: ObjectEncoder::new()
                            .field("sessionID", &id)
                            .field("inputID", &input_id)
                            .finish(),
                    },
                )?;
                Ok(true)
            })?
            .await
    }
    pub(crate) fn has_pending(&self, id: &session::Id) -> Result<bool, Error> {
        let snapshot = self.client.snapshot()?;
        let prefix = key(id.as_lossless());
        Ok(!snapshot
            .index_range::<PendingTable>(
                "session_pending_session_admitted_seq_idx",
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

    pub fn has_eligible_pending(&self, id: &session::Id) -> Result<bool, Error> {
        let snapshot = self.client.snapshot()?;
        let prefix = key(id.as_lossless());
        let mut after = None;
        let mut eligible = false;
        loop {
            let rows = snapshot.index_range::<PendingTable>(
                "session_pending_session_admitted_seq_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            if rows
                .iter()
                .any(|row| row.record.type_.as_str() == Some("compaction"))
            {
                return Ok(false);
            }
            if rows.is_empty() {
                return Ok(eligible);
            }
            eligible |= rows.iter().any(|row| {
                matches!(
                    row.record
                        .delivery
                        .as_ref()
                        .and_then(|delivery| delivery.as_str()),
                    Some("steer" | "queue")
                )
            });
            after = rows.last().map(|row| row.cursor.clone());
        }
    }

    pub fn has_pending_compaction(&self, id: &session::Id) -> Result<bool, Error> {
        let snapshot = self.client.snapshot()?;
        let prefix = key(id.as_lossless());
        let mut after = None;
        loop {
            let rows = snapshot.index_range::<PendingTable>(
                "session_pending_session_admitted_seq_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            if rows
                .iter()
                .any(|row| row.record.type_.as_str() == Some("compaction"))
            {
                return Ok(true);
            }
            let Some(last) = rows.last() else {
                return Ok(false);
            };
            after = Some(last.cursor.clone());
        }
    }

    pub fn pending_list(&self, id: &session::Id) -> Result<Vec<Pending>, Error> {
        let snapshot = self.client.snapshot()?;
        let prefix = key(id.as_lossless());
        let mut after = None;
        let mut pending = Vec::new();
        loop {
            let rows = snapshot.index_range::<PendingTable>(
                "session_pending_session_admitted_seq_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            if rows.is_empty() {
                return Ok(pending);
            }
            after = rows.last().map(|row| row.cursor.clone());
            pending.extend(
                rows.into_iter()
                    .map(|row| validate(row.record))
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .filter(|row| row.type_.as_str() != Some("compaction")),
            );
        }
    }

    pub async fn promote_steers(&self, id: &session::Id, now: i64) -> Result<usize, Error> {
        let steers = self
            .pending_list(id)?
            .into_iter()
            .filter(|pending| {
                pending
                    .delivery
                    .as_ref()
                    .and_then(|delivery| delivery.as_str())
                    == Some("steer")
            })
            .collect::<Vec<_>>();
        let mut promoted = 0;
        for pending in steers {
            match self.promote_input(id, &pending.id, now).await? {
                Promotion::Promoted => promoted += 1,
                Promotion::Reconciled | Promotion::Rejected => {}
                Promotion::Missing => break,
            }
        }
        Ok(promoted)
    }

    pub async fn promote_next_queued(&self, id: &session::Id, now: i64) -> Result<bool, Error> {
        let Some(pending) = self.pending_list(id)?.into_iter().find(|pending| {
            pending
                .delivery
                .as_ref()
                .and_then(|delivery| delivery.as_str())
                == Some("queue")
        }) else {
            return Ok(false);
        };
        Ok(matches!(
            self.promote_input(id, &pending.id, now).await?,
            Promotion::Promoted | Promotion::Reconciled
        ))
    }

    pub async fn promote_input(
        &self,
        id: &session::Id,
        input_id: &ycoding_schema::LosslessString,
        now: i64,
    ) -> Result<Promotion, Error> {
        let _inbox = super::autonomy::inbox(&self.client, id).await;
        let id = id.as_lossless().clone();
        let input_id = input_id.clone();
        self.client
            .submit(move |tx| {
                let prefix = key(&id);
                let mut after = None;
                loop {
                    let rows = tx.index_range::<PendingTable>(
                        "session_pending_session_admitted_seq_idx",
                        IndexQuery {
                            lower: Bound::Unbounded,
                            upper: Bound::Unbounded,
                            prefix: Some(&prefix),
                            order: IndexOrder::Ascending,
                            after: after.as_ref(),
                            limit: 128,
                        },
                    )?;
                    if rows
                        .iter()
                        .any(|row| row.record.type_.as_str() == Some("compaction"))
                    {
                        return Ok(Promotion::Missing);
                    }
                    let Some(last) = rows.last() else {
                        break;
                    };
                    after = Some(last.cursor.clone());
                }
                let Some(pending) = tx.get::<PendingTable>(&key(&input_id))? else {
                    return Ok(match tx.get::<MessageTable>(&key(&input_id))? {
                        Some(message) if message.session_id == id => Promotion::Reconciled,
                        _ => Promotion::Missing,
                    });
                };
                if pending.session_id != id || pending.type_.as_str() == Some("compaction") {
                    return Ok(Promotion::Missing);
                }
                if retired_input::reject(tx, &pending, now)? {
                    return Ok(Promotion::Rejected);
                }
                super::projector::append(
                    tx,
                    &NewEvent {
                        id: super::projector::random_event_id()?.as_lossless().clone(),
                        aggregate_id: id.clone(),
                        created: now,
                        type_: "session.input.promoted.1".into(),
                        data: ObjectEncoder::new()
                            .field("sessionID", &id)
                            .field("inputID", &pending.id)
                            .finish(),
                    },
                )?;
                Ok(Promotion::Promoted)
            })?
            .await
    }

    pub async fn reject_retired_pending(
        &self,
        session_id: &session::Id,
        input_id: &ycoding_schema::LosslessString,
        now: i64,
    ) -> Result<bool, Error> {
        let _inbox = super::autonomy::inbox(&self.client, session_id).await;
        let session_id = session_id.as_lossless().clone();
        let input_id = input_id.clone();
        self.client
            .submit(move |tx| {
                let Some(pending) = tx.get::<PendingTable>(&key(&input_id))? else {
                    return Ok(false);
                };
                if pending.session_id != session_id {
                    return Ok(false);
                }
                retired_input::reject(tx, &pending, now)
            })?
            .await
    }

    pub fn pending(&self, id: &session_message::Id) -> Result<Option<Pending>, Error> {
        self.client
            .snapshot()?
            .get::<PendingTable>(&key(id.as_lossless()))?
            .map(validate)
            .transpose()
    }

    pub async fn admit_input(&self, request: Request) -> Result<Admitted, Error> {
        self.admit_input_attributed(request, None).await
    }

    pub async fn admit_input_attributed(
        &self,
        request: Request,
        caused_by: Option<usage_anchor::Ref>,
    ) -> Result<Admitted, Error> {
        self.admit_input_checked(request, caused_by, None).await
    }

    pub(crate) async fn admit_input_checked(
        &self,
        request: Request,
        caused_by: Option<usage_anchor::Ref>,
        admission: Option<CheckedAdmission>,
    ) -> Result<Admitted, Error> {
        let session = self.get(&request.session_id)?.ok_or(Error::Domain {
            kind: "not_found",
            message: "Session not found",
        })?;
        let user = matches!(request.input, session_pending::Message::User(_));
        if user {
            super::revert::commit(self, &session, request.created).await?;
        }
        let id = request.session_id.clone();
        let (pending, fresh) = self.admit_record(request, caused_by, admission).await?;
        let wake = user
            || self
                .get(&id)?
                .is_some_and(|session| session.revert.is_none());
        Ok(Admitted {
            pending,
            wake,
            fresh,
        })
    }

    pub async fn admit(&self, request: Request) -> Result<Pending, Error> {
        self.admit_attributed(request, None).await
    }

    pub async fn admit_attributed(
        &self,
        request: Request,
        caused_by: Option<usage_anchor::Ref>,
    ) -> Result<Pending, Error> {
        self.admit_record(request, caused_by, None)
            .await
            .map(|(pending, _)| pending)
    }

    async fn admit_record(
        &self,
        request: Request,
        caused_by: Option<usage_anchor::Ref>,
        admission: Option<CheckedAdmission>,
    ) -> Result<(Pending, bool), Error> {
        self.client
            .submit(move |tx| match admission {
                Some(CheckedAdmission::Native(native)) => {
                    native.gate.with(tx, Some(&request.session_id), |tx| {
                        admit_in(tx, &request, &caused_by)
                    })
                }
                Some(CheckedAdmission::Coordination(admission)) => {
                    admit_coordination_in(tx, request, &caused_by, &admission)
                }
                None => admit_in(tx, &request, &caused_by),
            })?
            .await
    }
}

pub(crate) fn admit_in(
    tx: &mut Write<'_>,
    request: &Request,
    caused_by: &Option<usage_anchor::Ref>,
) -> Result<(Pending, bool), Error> {
    let record = pending_record(request)?;
    if tx.get::<PendingTable>(&key(&record.id))?.is_some()
        || tx.get::<MessageTable>(&key(&record.id))?.is_some()
    {
        return match tables::admit(tx, &record)? {
            Admission::Pending(existing) => validate(existing),
            Admission::Promoted(_) => promoted(tx, &record)?.ok_or_else(|| tx.reject(conflict())),
        }
        .map(|pending| (pending, false));
    }
    if let Some(original) = promoted_from_history(tx, &record)? {
        return Ok((original, false));
    }
    let event = tables::append(
        tx,
        &NewEvent {
            id: request.event_id.as_lossless().clone(),
            aggregate_id: record.session_id.clone(),
            created: request.created,
            type_: event::versioned_type(&"session.input.admitted".into(), 1.0),
            data: ObjectEncoder::new()
                .field("sessionID", &request.session_id)
                .field("inputID", &request.id)
                .field("input", &request.input)
                .optional("causedBy", caused_by)
                .finish(),
        },
        None,
    )?;
    let tables::Append::Appended(event) = event else {
        return Err(tx.reject(conflict()));
    };
    let record = Pending {
        admitted_seq: event.seq,
        ..record
    };
    PendingTable::insert(tx, &record)?;
    Ok((record, true))
}

pub(crate) enum CheckedAdmission {
    Native(Box<crate::dots::Admission>),
    Coordination(Box<crate::coordination::Admission>),
}

pub(crate) fn validate_coordination_in(
    tx: &mut Write<'_>,
    request: &Request,
    admission: &crate::coordination::Admission,
) -> Result<(), Error> {
    crate::coordination::authority::authorize_member_in(
        tx,
        &admission.sender_session_id,
        &request.session_id,
        &admission.group_id,
    )?;
    let group =
        tx.get::<ycoding_store::coordination::GroupTable>(&key(admission.group_id.as_lossless()))?;
    if request.id != admission.message_id
        || !group.is_some_and(|group| {
            group.master_session_id == *admission.master_session_id.as_lossless()
        })
    {
        return Err(tx.reject(coordination_refused()));
    }
    Ok(())
}

pub(crate) fn input_origin(metadata: Option<&ycoding_schema::JsonObject>) -> Option<&str> {
    match metadata?.get(&"inputOrigin".into())? {
        ycoding_schema::JsonValue::String(origin) => origin.as_str(),
        _ => None,
    }
}

fn coordination_refused() -> Error {
    Error::Domain {
        kind: "CoordinationRuntime.RefusedError",
        message: "Project admission is no longer authorized",
    }
}

fn admit_coordination_in(
    tx: &mut Write<'_>,
    mut request: Request,
    caused_by: &Option<usage_anchor::Ref>,
    admission: &crate::coordination::Admission,
) -> Result<(Pending, bool), Error> {
    validate_coordination_in(tx, &request, admission)?;
    let probe = pending_record(&request)?;
    let prior = match tx.get::<PendingTable>(&key(&probe.id))? {
        Some(prior) => Some(validate(prior)?),
        None if tx.get::<MessageTable>(&key(&probe.id))?.is_some() => promoted(tx, &probe)?,
        None => promoted_from_history(tx, &probe)?,
    };
    if let Some(prior) = prior {
        let old = session_pending::UserData::decode(&prior.data)
            .map_err(super::projector::record_error)?;
        let session_pending::Message::User(user) = &request.input else {
            return Err(tx.reject(coordination_refused()));
        };
        let metadata = old.metadata.as_ref();
        let provenance = metadata.and_then(|metadata| metadata.get(&"coordination".into()));
        let group = provenance.and_then(|value| {
            if let ycoding_schema::JsonValue::Object(fields) = value {
                fields.get(&"groupID".into())
            } else {
                None
            }
        });
        if prior.session_id != *request.session_id.as_lossless()
            || old.text != user.data.text
            || input_origin(metadata) != Some("coordination")
            || group != Some(&admission.group_id.encode())
        {
            return Err(tx.reject(coordination_refused()));
        }
        return Ok((prior, false));
    }
    let session_pending::Message::User(user) = &mut request.input else {
        return Err(tx.reject(coordination_refused()));
    };
    let mut metadata = ycoding_schema::JsonObject::new();
    for (key, value) in user
        .data
        .metadata
        .as_ref()
        .into_iter()
        .flat_map(|metadata| metadata.iter())
    {
        if !matches!(
            key.as_str(),
            Some("sharedContext" | "nativeSource" | "inputOrigin" | "coordination")
        ) {
            metadata.insert(key.clone(), value.clone());
        }
    }
    metadata.insert("inputOrigin".into(), "coordination".encode());
    metadata.insert(
        "coordination".into(),
        ObjectEncoder::new()
            .field("groupID", &admission.group_id)
            .field("masterSessionID", &admission.master_session_id)
            .field("senderSessionID", &admission.sender_session_id)
            .field("messageID", &admission.message_id)
            .optional("model", &admission.model)
            .finish(),
    );
    user.data.metadata = Some(metadata);
    admit_in(tx, &request, caused_by)
}

fn pending_record(request: &Request) -> Result<Pending, Error> {
    let (type_, data, delivery) = match &request.input {
        session_pending::Message::User(input) => {
            ("user", input.data.encode(), input.delivery.encode())
        }
        session_pending::Message::Synthetic(input) => {
            ("synthetic", input.data.encode(), input.delivery.encode())
        }
    };
    let ycoding_schema::JsonValue::String(delivery) = delivery else {
        return Err(conflict());
    };
    Ok(Pending {
        id: request.id.as_lossless().clone(),
        session_id: request.session_id.as_lossless().clone(),
        type_: type_.into(),
        data,
        delivery: Some(delivery),
        admitted_seq: 0,
        time_created: request.created,
    })
}

fn validate(row: Pending) -> Result<Pending, Error> {
    session_pending::LegacyInfo::decode(
        &ObjectEncoder::new()
            .field("id", &row.id)
            .field("sessionID", &row.session_id)
            .field("type", &row.type_)
            .field("admittedSeq", &(row.admitted_seq as f64))
            .field("timeCreated", &(row.time_created as f64))
            .field("data", &row.data)
            .optional("delivery", &row.delivery)
            .finish(),
    )
    .map_err(super::projector::record_error)?;
    Ok(row)
}

fn promoted_from_history(tx: &mut Write<'_>, record: &Pending) -> Result<Option<Pending>, Error> {
    if !tx
        .get::<ContextStateTable>(&key(&record.session_id))?
        .is_some_and(|state| state.covered_through_seq.is_some())
        && input_event_seq(tx, record, "session.input.deleted.1")?.is_none()
    {
        return Ok(None);
    }
    let Some(seq) = input_event_seq(tx, record, "session.input.promoted.1")? else {
        return Ok(None);
    };
    let session = session::Id::new(record.session_id.clone())
        .map_err(|error| Error::Record(Box::new(error)))?;
    if super::revert::committed_after_in(tx, &session, seq)? {
        return Ok(None);
    }
    promoted(tx, record)
}

fn input_event_seq(tx: &mut Write<'_>, record: &Pending, kind: &str) -> Result<Option<i64>, Error> {
    let prefix = tuple_key(&[
        KeyPart::String(&record.session_id),
        KeyPart::String(&kind.into()),
    ]);
    let mut after = None;
    loop {
        let events = tx.index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        if let Some(event) = events.iter().find(|event| {
            matches!(&event.record.data, ycoding_schema::JsonValue::Object(data)
                if data.get(&"inputID".into()) == Some(&ycoding_schema::JsonValue::String(record.id.clone())))
        }) {
            return Ok(Some(event.record.seq));
        }
        let Some(last) = events.last() else {
            return Ok(None);
        };
        after = Some(last.cursor.clone());
    }
}

fn promoted(tx: &mut Write<'_>, record: &Pending) -> Result<Option<Pending>, Error> {
    let prefix = tuple_key(&[
        KeyPart::String(&record.session_id),
        KeyPart::String(&event::versioned_type(
            &"session.input.admitted".into(),
            1.0,
        )),
    ]);
    let mut after = None;
    loop {
        let events = tx.index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        for event in &events {
            let Ok(admitted) = session_event::InputAdmitted::decode(&event.record.data) else {
                continue;
            };
            let value = admitted.encode();
            let path = JsonPath::default();
            let object = ObjectDecoder::new(&value, &path)
                .map_err(|error| Error::Record(Box::new(error)))?;
            let id: session_message::Id = object
                .field("inputID")
                .map_err(|error| Error::Record(Box::new(error)))?;
            if id.as_lossless() != &record.id {
                continue;
            }
            let input: session_pending::Message = object
                .field("input")
                .map_err(|error| Error::Record(Box::new(error)))?;
            let (type_, data, delivery) = match input {
                session_pending::Message::User(input) => {
                    ("user", input.data.encode(), input.delivery.encode())
                }
                session_pending::Message::Synthetic(input) => {
                    ("synthetic", input.data.encode(), input.delivery.encode())
                }
            };
            if record.type_.as_str() != Some(type_) {
                return Err(tx.reject(conflict()));
            }
            let ycoding_schema::JsonValue::String(delivery) = delivery else {
                return Err(tx.reject(conflict()));
            };
            return Ok(Some(Pending {
                admitted_seq: event.record.seq,
                time_created: event.record.created,
                data,
                delivery: Some(delivery),
                ..record.clone()
            }));
        }
        if events.is_empty() {
            return Ok(None);
        }
        after = events.last().map(|event| event.cursor.clone());
    }
}

#[cfg(test)]
#[path = "pending/coordination_tests.rs"]
mod coordination_tests;
