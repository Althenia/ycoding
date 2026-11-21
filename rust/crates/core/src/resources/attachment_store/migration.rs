use super::{Error, Store};
use std::ops::Bound;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue,
    prompt::{ManagedAttachmentContent, valid_base64},
};
use ycoding_store::{
    Client, KeyPart,
    resources::{Migration, MigrationTable},
    session::{EventTable, MessageTable, PendingTable},
    tuple_key,
};

pub const NAME: &str = "managed-attachments-v1";
pub async fn migrate(client: &Client, store: &Store, now: i64) -> Result<(), Error> {
    let snapshot = client.snapshot()?;
    let name = NAME.into();
    if snapshot
        .get::<MigrationTable>(&tuple_key(&[KeyPart::String(&name)]))?
        .is_some()
    {
        return Ok(());
    }
    let mut events = snapshot
        .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?
        .into_iter()
        .filter(|row| row.type_.as_str() == Some("session.input.admitted.1"))
        .collect::<Vec<_>>();
    let mut pending = snapshot
        .scan::<PendingTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?
        .into_iter()
        .filter(|row| row.type_.as_str() == Some("user"))
        .collect::<Vec<_>>();
    let mut messages = snapshot
        .scan::<MessageTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?
        .into_iter()
        .filter(|row| row.type_.as_str() == Some("user"))
        .collect::<Vec<_>>();
    drop(snapshot);
    for row in &mut events {
        let mut data = stored_record(&row.data)?;
        let mut input = record(data.get(&"input".into()).ok_or(Error::Migration)?)?;
        if input.get(&"type".into()).and_then(string) != Some("user") {
            row.data = JsonValue::Object(data);
            continue;
        }
        let content =
            JsonValue::Object(record(input.get(&"data".into()).ok_or(Error::Migration)?)?);
        input.insert("data".into(), migrate_record(&content, store)?);
        data.insert("input".into(), JsonValue::Object(input));
        row.data = JsonValue::Object(data);
    }
    for row in &mut pending {
        row.data = migrate_record(&row.data, store)?;
    }
    for row in &mut messages {
        row.data = migrate_record(&row.data, store)?;
    }
    client
        .submit(move |tx| {
            for row in events {
                EventTable::put(tx, &row)?;
            }
            for row in pending {
                PendingTable::put(tx, &row)?;
            }
            for row in messages {
                MessageTable::put(tx, &row)?;
            }
            MigrationTable::insert(
                tx,
                &Migration {
                    name,
                    time_completed: now,
                },
            )?;
            Ok(())
        })?
        .await?;
    Ok(())
}
fn record(value: &JsonValue) -> Result<ycoding_schema::JsonObject, Error> {
    match value {
        JsonValue::Object(object) => Ok(object.clone()),
        _ => Err(Error::Migration),
    }
}
fn stored_record(value: &JsonValue) -> Result<ycoding_schema::JsonObject, Error> {
    if let JsonValue::String(text) = value {
        return record(
            &ycoding_schema::parse_json(text.as_str().ok_or(Error::Migration)?)
                .map_err(|_| Error::Migration)?,
        );
    }
    record(value)
}
pub fn migrate_record(value: &JsonValue, store: &Store) -> Result<JsonValue, Error> {
    let mut data = stored_record(value)?;
    let Some(files) = data.get(&"files".into()) else {
        return Ok(JsonValue::Object(data));
    };
    let JsonValue::Array(files) = files else {
        return Err(Error::Migration);
    };
    let files = files
        .iter()
        .map(|file| migrate_file(file, store))
        .collect::<Result<Vec<_>, _>>()?;
    data.insert("files".into(), JsonValue::Array(files));
    Ok(JsonValue::Object(data))
}
fn migrate_file(value: &JsonValue, store: &Store) -> Result<JsonValue, Error> {
    let file = record(value)?;
    if let Some(content) = file.get(&"content".into())
        && let Ok(content) = ManagedAttachmentContent::decode(content)
    {
        let digest = content.digest.0.as_str().ok_or(Error::Migration)?;
        if content.path.as_str()
            == Some(format!("attachments/sha256/{}/{digest}", &digest[..2]).as_str())
        {
            store.read(&content)?;
            return Ok(JsonValue::Object(file));
        }
    }
    let data = file
        .get(&"data".into())
        .and_then(string)
        .ok_or(Error::Migration)?;
    let mime = file
        .get(&"mime".into())
        .and_then(string)
        .ok_or(Error::Migration)?;
    let bytes = canonical_base64(data)?;
    let mut output = ycoding_schema::JsonObject::new();
    output.insert("content".into(), store.import(&bytes)?.encode());
    output.insert("mime".into(), JsonValue::String(mime.into()));
    for key in ["name", "description"] {
        if let Some(value @ JsonValue::String(_)) = file.get(&key.into()) {
            output.insert(key.into(), value.clone());
        }
    }
    if let Some(mention) = file.get(&"mention".into()) {
        output.insert("mention".into(), mention.clone());
    }
    Ok(JsonValue::Object(output))
}
fn string(value: &JsonValue) -> Option<&str> {
    match value {
        JsonValue::String(value) => value.as_str(),
        _ => None,
    }
}
fn canonical_base64(value: &str) -> Result<Vec<u8>, Error> {
    if !valid_base64(&value.into()) {
        return Err(Error::Migration);
    }
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = Vec::with_capacity(value.len() / 4 * 3);
    for chunk in value.as_bytes().as_chunks::<4>().0 {
        let mut n = 0_u32;
        for byte in chunk {
            n = (n << 6)
                | if *byte == b'=' {
                    0
                } else {
                    alphabet
                        .iter()
                        .position(|item| item == byte)
                        .ok_or(Error::Migration)? as u32
                };
        }
        output.push((n >> 16) as u8);
        if chunk[2] != b'=' {
            output.push((n >> 8) as u8);
        }
        if chunk[3] != b'=' {
            output.push(n as u8);
        }
        if chunk[2] == b'=' && n & 0xffff != 0 || chunk[3] == b'=' && n & 0xff != 0 {
            return Err(Error::Migration);
        }
    }
    Ok(output)
}
