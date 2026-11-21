use serde_json::Value;
use std::fmt;
use std::path::Path;
use std::sync::{Arc, Mutex, mpsc};
use tokio::sync::oneshot;
use ycoding_schema::{JsonValue, LosslessString, parse_json, stringify_json};
use ycoding_store::meeting::{self as records, MeetingStore};
use ycoding_store::{Client, Metadata, Snapshot, Write};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreError(pub String);

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for StoreError {}

impl From<ycoding_store::Error> for StoreError {
    fn from(error: ycoding_store::Error) -> Self {
        Self(error.to_string())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Keep,
    Set(String),
    Clear,
}

type Put = fn(&mut Write<'_>, &JsonValue) -> Result<(), ycoding_store::Error>;
type Read = fn(&Snapshot, &LosslessString) -> Result<Vec<JsonValue>, ycoding_store::Error>;

type Slot = Mutex<Option<Client>>;
type Task = Box<dyn FnOnce(&mut Option<MeetingStore>, &Slot) + Send>;

struct Owner {
    client: Arc<Slot>,
    tasks: Mutex<Option<mpsc::Sender<Task>>>,
}

/// `MeetingStore` is thread-affine, so one dedicated thread owns it. Erasure
/// replaces the store's `Client`; the shared slot always holds the current one
/// and stays locked while the owner thread runs an exclusive operation.
#[derive(Clone)]
pub struct MeetingDatabase {
    owner: Arc<Owner>,
}

impl MeetingDatabase {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let path = path.to_path_buf();
        let client = Arc::new(Mutex::new(None));
        let (tasks, queue) = mpsc::channel::<Task>();
        let (opened, opening) = mpsc::sync_channel(1);
        let slot = client.clone();
        std::thread::Builder::new()
            .name("meeting-store".into())
            .spawn(move || {
                let store = match open_store(&path) {
                    Ok(store) => store,
                    Err(error) => return drop(opened.send(Err(error))),
                };
                *slot.lock().unwrap_or_else(|error| error.into_inner()) = Some(store.client());
                let _ = opened.send(Ok(()));
                let mut store = Some(store);
                while let Ok(task) = queue.recv() {
                    task(&mut store, &slot);
                }
                *slot.lock().unwrap_or_else(|error| error.into_inner()) = None;
            })
            .map_err(|error| StoreError(error.to_string()))?;
        opening
            .recv()
            .map_err(|_| StoreError("Meeting storage thread stopped".into()))??;
        Ok(Self {
            owner: Arc::new(Owner {
                client,
                tasks: Mutex::new(Some(tasks)),
            }),
        })
    }

    pub async fn write<R: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Write<'_>) -> Result<R, ycoding_store::Error> + Send + 'static,
    ) -> Result<R, StoreError> {
        Ok(self.client()?.submit(operation)?.await?)
    }

    pub async fn recover(&self) -> Result<(), StoreError> {
        let now = now();
        self.write(move |tx| records::recover(tx, &now)).await
    }

    pub async fn retain(&self, days: f64) -> Result<(), StoreError> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        self.exclusive(move |store| store.retain(days, now_ms))
            .await
    }

    pub async fn delete_meeting(&self, id: &str) -> Result<bool, StoreError> {
        let id = LosslessString::from(id);
        self.exclusive(move |store| store.delete_meeting(id)).await
    }

    pub async fn create_meeting(
        &self,
        id: &str,
        title: &str,
        session_id: &str,
    ) -> Result<Value, StoreError> {
        let input =
            to_store(&serde_json::json!({ "id": id, "title": title, "sessionID": session_id }))?;
        let now = now();
        from_store(
            &self
                .write(move |tx| records::create_meeting(tx, &input, &now))
                .await?,
        )
    }

    pub fn get_meeting(&self, id: &str) -> Result<Option<Value>, StoreError> {
        records::get_meeting(&self.client()?.snapshot()?, &id.into())?
            .map(|meeting| from_store(&meeting))
            .transpose()
    }

    pub fn list_meetings(&self, query: &str, limit: u64) -> Result<Vec<Value>, StoreError> {
        records::list_meetings(&self.client()?.snapshot()?, query, limit)?
            .iter()
            .map(from_store)
            .collect()
    }

    pub async fn update_meeting(
        &self,
        id: &str,
        status: Option<&str>,
        capture_id: Change,
        error: Change,
    ) -> Result<Value, StoreError> {
        let mut patch = serde_json::Map::new();
        let mut cleared = Vec::new();
        if let Some(status) = status {
            patch.insert("status".into(), Value::from(status));
        }
        for (name, change) in [("captureID", capture_id), ("error", error)] {
            match change {
                Change::Keep => (),
                Change::Set(value) => {
                    patch.insert(name.into(), Value::from(value));
                }
                Change::Clear => cleared.push(name),
            }
        }
        let patch = (!patch.is_empty())
            .then(|| to_store(&Value::Object(patch)))
            .transpose()?;
        let key = LosslessString::from(id);
        let now = now();
        let updated = self
            .write(move |tx| match patch {
                Some(patch) => {
                    let updated = records::update_meeting(tx, &key, &patch, &now)?;
                    if cleared.is_empty() {
                        Ok(updated)
                    } else {
                        records::clear_optional_fields(tx, &key, &cleared, &now)
                    }
                }
                None => records::clear_optional_fields(tx, &key, &cleared, &now),
            })
            .await?;
        from_store(&updated)
    }

    pub async fn put_segment(&self, segment: &Value) -> Result<(), StoreError> {
        self.put(records::put_segment, segment).await
    }

    pub fn segments(&self, id: &str, after: i64, limit: u64) -> Result<Vec<Value>, StoreError> {
        records::segments(&self.client()?.snapshot()?, &id.into(), after, limit)?
            .iter()
            .map(from_store)
            .collect()
    }

    pub fn next_sequence(&self, id: &str) -> Result<i64, StoreError> {
        Ok(records::next_sequence(
            &self.client()?.snapshot()?,
            &id.into(),
        )?)
    }

    pub async fn correct_segment(&self, id: &str, text: &str) -> Result<(), StoreError> {
        let (id, text) = (LosslessString::from(id), LosslessString::from(text));
        self.write(move |tx| records::correct_segment(tx, &id, &text))
            .await
    }

    pub fn findings(&self, id: &str) -> Result<Vec<Value>, StoreError> {
        self.children(records::findings, id)
    }

    pub fn checkpoints(&self, id: &str) -> Result<Vec<Value>, StoreError> {
        self.children(records::checkpoints, id)
    }

    pub fn proposals(&self, id: &str) -> Result<Vec<Value>, StoreError> {
        self.children(records::proposals, id)
    }

    pub fn approvals(&self, id: &str) -> Result<Vec<Value>, StoreError> {
        self.children(records::approvals, id)
    }

    pub fn jobs(&self, id: &str) -> Result<Vec<Value>, StoreError> {
        self.children(records::jobs, id)
    }

    pub fn references(&self, id: &str) -> Result<Vec<Value>, StoreError> {
        self.children(records::references, id)
    }

    pub fn plan(&self, id: &str) -> Result<Option<Value>, StoreError> {
        records::plan(&self.client()?.snapshot()?, &id.into())?
            .map(|plan| from_store(&plan))
            .transpose()
    }

    pub async fn put_finding(&self, value: &Value) -> Result<(), StoreError> {
        self.put(records::put_finding, value).await
    }

    pub async fn put_checkpoint(&self, value: &Value) -> Result<(), StoreError> {
        self.put(records::put_checkpoint, value).await
    }

    pub async fn put_proposal(&self, value: &Value) -> Result<(), StoreError> {
        self.put(records::put_proposal, value).await
    }

    pub async fn put_plan(&self, value: &Value) -> Result<(), StoreError> {
        self.put(records::put_plan, value).await
    }

    pub async fn put_approval(&self, value: &Value) -> Result<(), StoreError> {
        self.put(records::put_approval, value).await
    }

    pub async fn put_job(&self, value: &Value) -> Result<(), StoreError> {
        self.put(records::put_job, value).await
    }

    pub async fn put_reference(&self, meeting_id: &str, value: &Value) -> Result<(), StoreError> {
        let (meeting_id, value) = (LosslessString::from(meeting_id), to_store(value)?);
        self.write(move |tx| records::put_reference(tx, &meeting_id, &value))
            .await
    }

    pub async fn close(&self) -> Result<(), StoreError> {
        if self
            .owner
            .tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_none()
        {
            return Ok(());
        }
        let (reply, outcome) = oneshot::channel();
        let sent = self.send(Box::new(move |store, slot| {
            *slot.lock().unwrap_or_else(|error| error.into_inner()) = None;
            let result = store
                .take()
                .map_or(Ok(()), MeetingStore::shutdown)
                .map_err(StoreError::from);
            let _ = reply.send(result);
        }));
        self.owner
            .tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        sent?;
        outcome
            .await
            .map_err(|_| StoreError("Meeting storage thread stopped".into()))?
    }

    fn client(&self) -> Result<Client, StoreError> {
        self.owner
            .client
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .ok_or_else(|| StoreError("Meeting store is closed".into()))
    }

    fn send(&self, task: Task) -> Result<(), StoreError> {
        self.owner
            .tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .ok_or_else(|| StoreError("Meeting store is closed".into()))?
            .send(task)
            .map_err(|_| StoreError("Meeting store is closed".into()))
    }

    async fn put(&self, put: Put, value: &Value) -> Result<(), StoreError> {
        let value = to_store(value)?;
        self.write(move |tx| put(tx, &value)).await
    }

    fn children(&self, read: Read, id: &str) -> Result<Vec<Value>, StoreError> {
        read(&self.client()?.snapshot()?, &id.into())?
            .iter()
            .map(from_store)
            .collect()
    }

    async fn exclusive<R: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut MeetingStore) -> Result<R, ycoding_store::Error> + Send + 'static,
    ) -> Result<R, StoreError> {
        let (reply, outcome) = oneshot::channel();
        self.send(Box::new(move |store, slot| {
            let mut client = slot.lock().unwrap_or_else(|error| error.into_inner());
            let result = match store.as_mut() {
                Some(store) => {
                    let result = operation(store);
                    *client = Some(store.client());
                    result.map_err(StoreError::from)
                }
                None => Err(StoreError("Meeting store is closed".into())),
            };
            drop(client);
            let _ = reply.send(result);
        }))?;
        outcome
            .await
            .map_err(|_| StoreError("Meeting storage thread stopped".into()))?
    }
}

fn open_store(path: &Path) -> Result<MeetingStore, StoreError> {
    if path.exists() {
        return Ok(MeetingStore::open(path)?);
    }
    let identity =
        crate::platform::random::<16>().map_err(|error| StoreError(error.to_string()))?;
    Ok(MeetingStore::initialize(path, Metadata::new(identity, 1))?)
}

pub fn to_store(value: &Value) -> Result<JsonValue, StoreError> {
    parse_json(&value.to_string())
        .map_err(|_| StoreError("Meeting record is not valid JSON".into()))
}

pub fn from_store(value: &JsonValue) -> Result<Value, StoreError> {
    serde_json::from_str(&stringify_json(value)).map_err(|_| {
        StoreError("Meeting record contains text that cannot be represented as JSON".into())
    })
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn uuid() -> Result<String, StoreError> {
    let mut bytes =
        crate::platform::random::<16>().map_err(|error| StoreError(error.to_string()))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
