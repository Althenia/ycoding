use super::{key, store::Service};
use std::ops::Bound;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonPath, ObjectDecoder, ObjectEncoder, event, session,
    session_event, session_message, session_pending,
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{
        self as tables, Admission, EventTable, MessageTable, NewEvent, Pending, PendingTable,
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
}

pub(crate) fn conflict() -> Error {
    Error::Domain {
        kind: "input_identity",
        message: "input identity belongs to another session or kind, or has no admitted event",
    }
}

impl Service {
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
        self.promote_delivery(id, "steer", now).await
    }

    pub async fn promote_next_queued(&self, id: &session::Id, now: i64) -> Result<bool, Error> {
        self.promote_delivery(id, "queue", now)
            .await
            .map(|count| count > 0)
    }

    async fn promote_delivery(
        &self,
        id: &session::Id,
        delivery: &'static str,
        now: i64,
    ) -> Result<usize, Error> {
        let id = id.as_lossless().clone();
        self.client
            .submit(move |tx| {
                let prefix = key(&id);
                let mut after = None;
                let mut selected = Vec::new();
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
                        return Ok(0);
                    }
                    if rows.is_empty() {
                        break;
                    }
                    after = rows.last().map(|row| row.cursor.clone());
                    selected.extend(
                        rows.into_iter()
                            .filter(|row| {
                                row.record
                                    .delivery
                                    .as_ref()
                                    .and_then(|value| value.as_str())
                                    == Some(delivery)
                            })
                            .map(|row| row.record),
                    );
                }
                if delivery == "queue" {
                    selected.truncate(1);
                }
                for row in &selected {
                    super::projector::append(
                        tx,
                        &NewEvent {
                            id: super::projector::random_event_id()?.as_lossless().clone(),
                            aggregate_id: id.clone(),
                            created: now,
                            type_: "session.input.promoted.1".into(),
                            data: ObjectEncoder::new()
                                .field("sessionID", &id)
                                .field("inputID", &row.id)
                                .finish(),
                        },
                    )?;
                }
                Ok(selected.len())
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
        let session = self.get(&request.session_id)?.ok_or(Error::Domain {
            kind: "not_found",
            message: "Session not found",
        })?;
        let user = matches!(request.input, session_pending::Message::User(_));
        if user {
            super::revert::commit(self, &session, request.created).await?;
        }
        let id = request.session_id.clone();
        let pending = self.admit(request).await?;
        let wake = user
            || self
                .get(&id)?
                .is_some_and(|session| session.revert.is_none());
        Ok(Admitted { pending, wake })
    }

    pub async fn admit(&self, request: Request) -> Result<Pending, Error> {
        self.client
            .submit(move |tx| {
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
                let record = Pending {
                    id: request.id.as_lossless().clone(),
                    session_id: request.session_id.as_lossless().clone(),
                    type_: type_.into(),
                    data,
                    delivery: Some(delivery),
                    admitted_seq: 0,
                    time_created: request.created,
                };
                if tx.get::<PendingTable>(&key(&record.id))?.is_some()
                    || tx.get::<MessageTable>(&key(&record.id))?.is_some()
                {
                    return match tables::admit(tx, &record)? {
                        Admission::Pending(existing) => validate(existing),
                        Admission::Promoted(_) => {
                            promoted(tx, &record)?.ok_or_else(|| tx.reject(conflict()))
                        }
                    };
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
                Ok(record)
            })?
            .await
    }
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
