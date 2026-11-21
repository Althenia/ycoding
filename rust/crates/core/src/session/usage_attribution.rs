use super::key;
use std::{collections::BTreeSet, ops::Bound};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, session_id::SessionId, session_message_id,
    usage_anchor,
};
use ycoding_store::{
    Error, IndexEntry, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec,
    session::{EventTable, MessageTable, SessionTable, TaskTable},
    tuple_key,
};

const PAGE: usize = 200;
const ADMITTED: &str = "session.input.admitted.1";
const PROMOTED: &str = "session.input.promoted.1";
const REVERTED: &str = "session.revert.committed.1";

#[derive(Clone, Debug, PartialEq)]
pub enum Attribution {
    Unset,
    Unanchored,
    Anchored(usage_anchor::Ref),
}

impl Attribution {
    pub fn explicit(anchor: Option<usage_anchor::Ref>) -> Self {
        anchor.map_or(Self::Unanchored, Self::Anchored)
    }

    pub fn anchor(&self) -> Option<&usage_anchor::Ref> {
        match self {
            Self::Anchored(anchor) => Some(anchor),
            _ => None,
        }
    }
}

pub trait Reader {
    fn get<T: TableSpec>(&mut self, key: &[u8]) -> Result<Option<T::Record>, Error>;
    fn range<T: TableSpec>(
        &mut self,
        index: &str,
        query: IndexQuery<'_>,
    ) -> Result<Vec<IndexEntry<T::Record>>, Error>;
}

impl Reader for Snapshot {
    fn get<T: TableSpec>(&mut self, key: &[u8]) -> Result<Option<T::Record>, Error> {
        Snapshot::get::<T>(self, key)
    }
    fn range<T: TableSpec>(
        &mut self,
        index: &str,
        query: IndexQuery<'_>,
    ) -> Result<Vec<IndexEntry<T::Record>>, Error> {
        self.index_range::<T>(index, query)
    }
}

pub async fn dispatch(
    client: &ycoding_store::Client,
    session: &LosslessString,
    ambient: &Attribution,
) -> Result<Option<usage_anchor::Ref>, Error> {
    match ambient {
        Attribution::Unanchored => Ok(None),
        Attribution::Anchored(anchor) => Ok(Some(anchor.clone())),
        Attribution::Unset => {
            let session = session.clone();
            read(client.snapshot()?, move |snapshot| {
                current(snapshot, &session)
            })
            .await
        }
    }
}

pub async fn entry(
    client: &ycoding_store::Client,
    session: &LosslessString,
) -> Result<Attribution, Error> {
    dispatch(client, session, &Attribution::Unset)
        .await
        .map(Attribution::explicit)
}

pub async fn first_prompt(
    client: &ycoding_store::Client,
    session: &LosslessString,
    input: &LosslessString,
) -> Result<Attribution, Error> {
    let (session, input) = (session.clone(), input.clone());
    read(client.snapshot()?, move |snapshot| {
        resolve_cursor(snapshot, session, input)
    })
    .await
    .map(Attribution::explicit)
}

async fn read<T: Send + 'static>(
    mut snapshot: Snapshot,
    work: impl FnOnce(&mut Snapshot) -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    tokio::task::spawn_blocking(move || work(&mut snapshot))
        .await
        .map_err(|_| Error::Domain {
            kind: "usage_attribution",
            message: "Usage attribution read did not complete",
        })?
}

pub fn current<R: Reader>(
    reader: &mut R,
    session: &LosslessString,
) -> Result<Option<usage_anchor::Ref>, Error> {
    let reverted = descending::<R>(reader, session, REVERTED, None)?
        .first()
        .map(|event| event.record.seq);
    let mut after = None;
    loop {
        let page = descending::<R>(reader, session, PROMOTED, after.as_ref())?;
        let Some(last) = page.last() else {
            break;
        };
        let cursor = last.cursor.clone();
        for event in &page {
            if reverted.is_some_and(|seq| event.record.seq <= seq) {
                return fallback(reader, session);
            }
            let Some(JsonValue::String(input)) = field(&event.record.data, "inputID") else {
                continue;
            };
            if let Some(anchor) = resolve_cursor(reader, session.clone(), input.clone())? {
                return Ok(Some(anchor));
            }
        }
        if page.len() < PAGE {
            break;
        }
        after = Some(cursor);
    }
    fallback(reader, session)
}

pub fn started<R: Reader>(
    reader: &mut R,
    reference: &usage_anchor::Ref,
) -> Result<Option<i64>, Error> {
    let session = reference.session_id.as_lossless();
    let input = reference.input_id.as_lossless();
    if let Some(message) = reader
        .get::<MessageTable>(&key(input))?
        .filter(|message| &message.session_id == session)
    {
        return Ok(Some(message.time_created));
    }
    Ok(admitted(reader, session, input)?.map(|(_, _, created)| created))
}

pub fn resolve<R: Reader>(
    reader: &mut R,
    reference: &usage_anchor::Ref,
) -> Result<Option<usage_anchor::Ref>, Error> {
    resolve_cursor(
        reader,
        reference.session_id.as_lossless().clone(),
        reference.input_id.as_lossless().clone(),
    )
}

fn fallback<R: Reader>(
    reader: &mut R,
    session: &LosslessString,
) -> Result<Option<usage_anchor::Ref>, Error> {
    let prefix = tuple_key(&[KeyPart::String(session), KeyPart::String(&"user".into())]);
    let latest = reader
        .range::<MessageTable>(
            "session_message_session_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Descending,
                after: None,
                limit: 1,
            },
        )?
        .into_iter()
        .next();
    match latest {
        Some(message) => resolve_cursor(reader, session.clone(), message.record.id),
        None => Ok(None),
    }
}

fn resolve_cursor<R: Reader>(
    reader: &mut R,
    session: LosslessString,
    input: LosslessString,
) -> Result<Option<usage_anchor::Ref>, Error> {
    let mut seen = BTreeSet::new();
    let mut cursor = (session, input);
    loop {
        if !seen.insert(cursor.clone()) {
            return Ok(None);
        }
        let admitted = admitted(reader, &cursor.0, &cursor.1)?;
        if let Some((Some(cause), _, _)) = &admitted {
            cursor = (
                cause.session_id.as_lossless().clone(),
                cause.input_id.as_lossless().clone(),
            );
            continue;
        }
        if reader.get::<SessionTable>(&key(&cursor.0))?.is_none() {
            return Ok(None);
        }
        let user = admitted.as_ref().is_some_and(|(_, user, _)| *user);
        let Some(task) = reader
            .get::<TaskTable>(&key(&cursor.0))?
            .filter(|task| task.input_id == cursor.1)
        else {
            return Ok(user.then(|| reference(&cursor)).transpose()?.flatten());
        };
        if let Some(anchor) = &task.usage_anchor {
            return Ok(anchor.domain().ok());
        }
        let Some(message) = reader
            .get::<MessageTable>(&key(&task.parent_assistant_message_id))?
            .filter(|message| message.session_id == task.parent_id)
        else {
            return Ok(None);
        };
        let prefix = tuple_key(&[
            KeyPart::String(&task.parent_id),
            KeyPart::String(&"user".into()),
        ]);
        let before = tuple_key(&[
            KeyPart::String(&task.parent_id),
            KeyPart::String(&"user".into()),
            KeyPart::I64(message.seq),
        ]);
        let Some(parent) = reader
            .range::<MessageTable>(
                "session_message_session_type_seq_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Excluded(&before),
                    prefix: Some(&prefix),
                    order: IndexOrder::Descending,
                    after: None,
                    limit: 1,
                },
            )?
            .into_iter()
            .next()
        else {
            return Ok(None);
        };
        cursor = (task.parent_id, parent.record.id);
    }
}

fn reference(
    cursor: &(LosslessString, LosslessString),
) -> Result<Option<usage_anchor::Ref>, Error> {
    Ok(
        match (
            SessionId::new(cursor.0.clone()),
            session_message_id::Id::new(cursor.1.clone()),
        ) {
            (Ok(session_id), Ok(input_id)) => Some(usage_anchor::Ref {
                session_id,
                input_id,
            }),
            _ => None,
        },
    )
}

type Admitted = Option<(Option<usage_anchor::Ref>, bool, i64)>;

fn admitted<R: Reader>(
    reader: &mut R,
    session: &LosslessString,
    input: &LosslessString,
) -> Result<Admitted, Error> {
    let mut after = None;
    loop {
        let page = descending::<R>(reader, session, ADMITTED, after.as_ref())?;
        let Some(last) = page.last() else {
            return Ok(None);
        };
        let cursor = last.cursor.clone();
        for event in &page {
            if field(&event.record.data, "inputID") != Some(&JsonValue::String(input.clone())) {
                continue;
            }
            let cause = match field(&event.record.data, "causedBy") {
                None => None,
                Some(value) => match usage_anchor::Ref::decode(value) {
                    Ok(cause) => Some(cause),
                    Err(_) => continue,
                },
            };
            let user = field(&event.record.data, "input").and_then(|input| field(input, "type"))
                == Some(&JsonValue::String("user".into()));
            return Ok(Some((cause, user, event.record.created)));
        }
        if page.len() < PAGE {
            return Ok(None);
        }
        after = Some(cursor);
    }
}

fn descending<R: Reader>(
    reader: &mut R,
    session: &LosslessString,
    kind: &str,
    after: Option<&ycoding_store::IndexCursor>,
) -> Result<Vec<IndexEntry<ycoding_store::session::Event>>, Error> {
    let prefix = tuple_key(&[KeyPart::String(session), KeyPart::String(&kind.into())]);
    reader.range::<EventTable>(
        "event_aggregate_type_seq_idx",
        IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: Some(&prefix),
            order: IndexOrder::Descending,
            after,
            limit: if kind == REVERTED { 1 } else { PAGE },
        },
    )
}

fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&name.into()),
        _ => None,
    }
}
