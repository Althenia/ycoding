mod durable;
mod projection;
mod rest;
pub use durable::{Connect, ConnectError, Socket, SocketError, SocketFuture};

use super::{
    access::{
        ConversationError, ConversationProblem as Problem, ConversationResult, UpstreamRejection,
    },
    native::{Configuration, Host},
};
use durable::Reply;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{sync::watch, task::JoinSet};
use ycoding_schema::{JsonValue, LosslessString, ObjectEncoder, stringify_json};

#[derive(Clone, Copy)]
pub enum Operation {
    Threads,
    TaskUpdates,
    Read,
    Send,
    Interrupt,
    Requests,
    Respond,
    Resume,
}

#[derive(Clone)]
struct Error {
    problem: Problem,
    rejection: Option<UpstreamRejection>,
}
impl Error {
    fn new(problem: Problem) -> Self {
        Self {
            problem,
            rejection: None,
        }
    }
    fn public(self) -> ConversationError {
        ConversationResult::<()>::Failed {
            problem: self.problem,
            rejection: self.rejection,
        }
        .into_result()
        .unwrap_err()
    }
}
fn malformed() -> Error {
    Error::new(Problem::Malformed)
}
fn field<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    match value {
        JsonValue::Object(value) => value.get(&key.into()).unwrap_or(&JsonValue::Null),
        _ => &JsonValue::Null,
    }
}
fn string<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    match field(value, key) {
        JsonValue::String(value) => value.as_str(),
        _ => None,
    }
}
fn list<'a>(value: &'a JsonValue, key: &str) -> Result<&'a [JsonValue], Error> {
    match field(value, key) {
        JsonValue::Array(values) => Ok(values),
        _ => Err(malformed()),
    }
}
fn cursor(value: &JsonValue, key: &str) -> Result<Option<String>, Error> {
    match field(value, key) {
        JsonValue::Null => Ok(None),
        JsonValue::String(value) if !value.is_empty() && value.len() <= 4096 => {
            value.to_utf8().map(Some).map_err(|_| malformed())
        }
        _ => Err(malformed()),
    }
}
fn outcome(key: &str, value: &str) -> JsonValue {
    ObjectEncoder::new().field(key, value).finish()
}

type ResultCell = watch::Sender<Option<Result<JsonValue, Error>>>;
#[derive(Clone)]
struct Work {
    rest: rest::Rest,
    durable: Arc<durable::Durable>,
}
struct Inner {
    work: Work,
    pending: Mutex<BTreeMap<String, ResultCell>>,
    tasks: Mutex<JoinSet<()>>,
    stopped: Arc<AtomicBool>,
}

struct Completion {
    owner: Weak<Inner>,
    key: String,
    result: ResultCell,
}
impl Drop for Completion {
    fn drop(&mut self) {
        let unfinished = self.result.borrow().is_none();
        if unfinished {
            self.result
                .send_replace(Some(Err(Error::new(Problem::Connection))));
        }
        if let Some(owner) = self.owner.upgrade() {
            owner
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.key);
        }
    }
}

#[derive(Clone)]
pub struct Service(Arc<Inner>);
impl Service {
    pub fn start(
        host: Host,
        attachment: &super::access::Attachment,
        connect: Connect,
    ) -> Result<Self, ConversationError> {
        let stopped = Arc::new(AtomicBool::new(false));
        let owner = attachment.guard();
        let rest =
            rest::Rest::new(host.clone(), stopped.clone(), owner.clone()).map_err(Error::public)?;
        let work = Work {
            rest,
            durable: Arc::new(durable::Durable::start(host, owner, connect)),
        };
        Ok(Self(Arc::new(Inner {
            work,
            pending: Mutex::new(BTreeMap::new()),
            tasks: Mutex::new(JoinSet::new()),
            stopped,
        })))
    }

    pub async fn call(
        &self,
        operation: Operation,
        request: JsonValue,
    ) -> Result<JsonValue, ConversationError> {
        if self.0.stopped.load(Ordering::Acquire) {
            return Err(Error::new(Problem::Connection).public());
        }
        let configuration = self
            .0
            .work
            .rest
            .host
            .configuration()
            .map_err(|_| Error::new(Problem::Configuration).public())?;
        if !matches!(configuration, Configuration::Enabled { .. }) {
            return Err(Error::new(Problem::Configuration).public());
        }
        self.0
            .work
            .rest
            .fence(&configuration)
            .map_err(Error::public)?;
        let id = match operation {
            Operation::Send => format!(
                "send:{}:{}",
                stringify_json(field(field(&request, "params"), "threadID")),
                stringify_json(field(field(&request, "payload"), "clientMessageID"))
            ),
            Operation::Resume => "resume".into(),
            _ => durable::request_id().map_err(Error::public)?,
        };
        let key = format!("{configuration:?}:{id}");
        let mut result = {
            let mut tasks = self
                .0
                .tasks
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if self.0.stopped.load(Ordering::Acquire) {
                return Err(Error::new(Problem::Connection).public());
            }
            while let Some(result) = tasks.try_join_next() {
                if result.is_err() {
                    tracing::error!("Dots conversation task failed");
                }
            }
            let mut pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(existing) = pending.get(&key) {
                existing.subscribe()
            } else {
                if pending.len() >= 256 {
                    return Err(Error::new(Problem::Connection).public());
                }
                let (completed, receiver) = watch::channel(None);
                pending.insert(key.clone(), completed.clone());
                let work = self.0.work.clone();
                let expected = configuration.clone();
                let completion = Completion {
                    owner: Arc::downgrade(&self.0),
                    key,
                    result: completed,
                };
                tasks.spawn(async move {
                    let value = work.run(operation, request, &expected).await;
                    completion.result.send_replace(Some(value));
                });
                receiver
            }
        };
        loop {
            let value = result.borrow_and_update().clone();
            if let Some(value) = value {
                self.0
                    .work
                    .rest
                    .fence(&configuration)
                    .map_err(Error::public)?;
                return value.map_err(Error::public);
            }
            result
                .changed()
                .await
                .map_err(|_| Error::new(Problem::Connection).public())?;
        }
    }

    pub async fn close(&self) -> Result<(), ConversationError> {
        self.0.stopped.store(true, Ordering::Release);
        let durable = self.0.work.durable.close().await;
        let mut tasks = {
            let mut tasks = self
                .0
                .tasks
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::replace(&mut *tasks, JoinSet::new())
        };
        let mut failed = false;
        while let Some(result) = tasks.join_next().await {
            failed |= result.is_err();
        }
        durable.map_err(Error::public)?;
        if failed {
            return Err(Error::new(Problem::Connection).public());
        }
        Ok(())
    }
}

impl Work {
    async fn context(&self) -> Result<rest::Context, Error> {
        tokio::time::timeout(Duration::from_secs(30), self.rest.context())
            .await
            .map_err(|_| Error::new(Problem::Connection))?
    }

    async fn member(&self, thread: &str) -> Result<rest::Context, Error> {
        tokio::time::timeout(Duration::from_secs(30), async {
            let owner = self.context().await?;
            if !self
                .rest
                .members(&owner)
                .await?
                .iter()
                .any(|id| id == thread)
            {
                return Err(Error::new(Problem::ThreadUnavailable));
            }
            Ok(owner)
        })
        .await
        .map_err(|_| Error::new(Problem::Connection))?
    }

    async fn catalog(&self, configuration: &Configuration) -> BTreeMap<String, JsonValue> {
        let mut rows = BTreeMap::new();
        if !self.durable.connected(configuration) {
            return rows;
        }
        let mut next = None::<String>;
        let mut seen = BTreeSet::new();
        for _ in 0..20 {
            let params = ObjectEncoder::new()
                .field(
                    "cursor",
                    &next
                        .as_ref()
                        .map(|value| JsonValue::String(value.as_str().into()))
                        .unwrap_or(JsonValue::Null),
                )
                .field("limit", &100.0)
                .field("archived", &false)
                .field("useStateDbOnly", &true)
                .finish();
            let Reply::Result(body) = self
                .durable
                .request(configuration, "thread/list", params, 30)
                .await
            else {
                return BTreeMap::new();
            };
            let Ok(items) = list(&body, "data") else {
                return BTreeMap::new();
            };
            if items.len() > 100 {
                return BTreeMap::new();
            }
            for item in items {
                if let Ok(id) = projection::identity(field(item, "id")) {
                    rows.insert(id, item.clone());
                }
            }
            let Ok(cursor) = cursor(&body, "nextCursor") else {
                return BTreeMap::new();
            };
            next = cursor;
            let Some(cursor) = &next else {
                return rows;
            };
            if !seen.insert(cursor.clone()) {
                return BTreeMap::new();
            }
        }
        BTreeMap::new()
    }

    async fn run(
        &self,
        operation: Operation,
        request: JsonValue,
        expected: &Configuration,
    ) -> Result<JsonValue, Error> {
        self.rest.fence(expected)?;
        let params = field(&request, "params");
        let query = field(&request, "query");
        let input = field(&request, "payload");
        if matches!(operation, Operation::Threads) {
            let owner = self.context().await?;
            if &owner.configuration != expected {
                return Err(Error::new(Problem::Configuration));
            }
            let (members, tasks, catalog) = tokio::join!(
                self.rest.members(&owner),
                self.rest.tasks(&owner),
                self.catalog(expected)
            );
            let threads = members?
                .iter()
                .map(|thread| {
                    projection::details(catalog.get(thread).unwrap_or(&JsonValue::Null))
                        .field("threadID", thread.as_str())
                        .field(
                            "kind",
                            if owner.root.as_ref() == Some(thread) {
                                "root"
                            } else {
                                "task"
                            },
                        )
                        .finish()
                })
                .collect::<Vec<_>>();
            return Ok(ObjectEncoder::new()
                .field("dotID", owner.dot.as_str())
                .optional(
                    "rootThreadID",
                    &owner.root.as_deref().map(LosslessString::from),
                )
                .field("threads", &threads)
                .field("tasks", &tasks?)
                .finish());
        }
        if matches!(operation, Operation::Resume) {
            let owner = self.context().await?;
            if &owner.configuration != expected {
                return Err(Error::new(Problem::Configuration));
            }
            return self.resume(&owner).await;
        }
        if matches!(operation, Operation::TaskUpdates) {
            let task = projection::identity(field(params, "taskID"))?;
            let owner = self.context().await?;
            if &owner.configuration != expected {
                return Err(Error::new(Problem::Configuration));
            }
            let body = self
                .rest
                .get(
                    &owner,
                    &format!(
                        "/tbo/{}/tasks/{}/updates",
                        rest::segment(&owner.dot),
                        rest::segment(&task)
                    ),
                    &page(query, 50)?,
                    false,
                )
                .await?;
            let rows = list(&body, "data")?;
            if rows.len() > 50 {
                return Err(malformed());
            }
            return Ok(ObjectEncoder::new()
                .field("taskID", task.as_str())
                .field(
                    "updates",
                    &rows
                        .iter()
                        .map(|row| projection::update(row, &task))
                        .collect::<Result<Vec<_>, _>>()?,
                )
                .optional(
                    "nextCursor",
                    &cursor(&body, "next_cursor")?.map(LosslessString::from),
                )
                .finish());
        }
        let thread = projection::identity(field(params, "threadID"))?;
        let owner = self.member(&thread).await?;
        if &owner.configuration != expected {
            return Err(Error::new(Problem::Configuration));
        }
        match operation {
            Operation::Read => {
                let mut query = page(query, 20)?;
                query.extend([
                    ("sortDirection".into(), "desc".into()),
                    ("itemsView".into(), "full".into()),
                ]);
                let summary_path = format!("/v1/threads/{}", rest::segment(&thread));
                let turns_path = format!("/v2/threads/{}/turns", rest::segment(&thread));
                let (summary, history) = tokio::try_join!(
                    self.rest.get(&owner, &summary_path, &[], true),
                    self.rest.get(&owner, &turns_path, &query, true)
                )?;
                let summary = field(&summary, "thread");
                if string(summary, "id") != Some(thread.as_str()) {
                    return Err(malformed());
                }
                let rows = list(&history, "data")?;
                if rows.len() > 50 {
                    return Err(malformed());
                }
                let turns = rows
                    .iter()
                    .rev()
                    .map(projection::turn)
                    .collect::<Result<Vec<_>, _>>()?;
                self.durable.observe(expected, &thread);
                Ok(ObjectEncoder::new()
                    .field(
                        "thread",
                        &projection::details(summary)
                            .field("threadID", thread.as_str())
                            .field(
                                "kind",
                                if owner.root.as_ref() == Some(&thread) {
                                    "root"
                                } else {
                                    "task"
                                },
                            )
                            .finish(),
                    )
                    .field("turns", &turns)
                    .optional(
                        "nextCursor",
                        &cursor(&history, "nextCursor")?.map(LosslessString::from),
                    )
                    .finish())
            }
            Operation::Send => self.send(&owner, &thread, input).await,
            Operation::Interrupt => {
                let turn = projection::identity(field(input, "turnID"))?;
                let reply = self
                    .durable
                    .request(
                        expected,
                        "turn/interrupt",
                        ObjectEncoder::new()
                            .field("threadId", thread.as_str())
                            .field("turnId", turn.as_str())
                            .finish(),
                        30,
                    )
                    .await;
                match reply {
                    Reply::Unknown => Ok(outcome("outcome", "unknown")),
                    Reply::Rejected(rejection)
                        if rejection.message.as_ref().is_some_and(|message| {
                            message.contains("no active turn to interrupt")
                        }) =>
                    {
                        Ok(outcome("outcome", "interrupted"))
                    }
                    value => {
                        value.result()?;
                        Ok(outcome("outcome", "interrupted"))
                    }
                }
            }
            Operation::Requests => {
                if !self.durable.connected(expected) {
                    return Err(Error::new(Problem::DurableUnavailable));
                }
                self.durable.observe(expected, &thread);
                let pending = self
                    .durable
                    .pending(expected, &thread)
                    .iter()
                    .map(|request| {
                        projection::pending(&request.id, &request.method, &request.params)
                    })
                    .collect::<Vec<_>>();
                Ok(ObjectEncoder::new()
                    .field("threadID", thread.as_str())
                    .field("requests", &pending)
                    .finish())
            }
            Operation::Respond => {
                let id = projection::identity(field(params, "requestID"))?;
                let pending = self
                    .durable
                    .pending(expected, &thread)
                    .into_iter()
                    .find(|request| request.id == id)
                    .ok_or_else(|| Error::new(Problem::Stale))?;
                let answer = projection::answer(&pending.method, &pending.params, input)?;
                match self.durable.answer(expected, &thread, &id, answer).await {
                    Reply::Result(_) => Ok(outcome("outcome", "sent")),
                    Reply::Unknown => Ok(outcome("outcome", "unknown")),
                    Reply::NotSent => Err(Error::new(Problem::DurableUnavailable)),
                    Reply::Stale => Err(Error::new(Problem::Stale)),
                    value => {
                        value.result()?;
                        Err(malformed())
                    }
                }
            }
            _ => Err(malformed()),
        }
    }

    async fn resume(&self, owner: &rest::Context) -> Result<JsonValue, Error> {
        let Some(body) = self
            .rest
            .post(
                owner,
                &format!("/tbo/{}/runtime/resume", rest::segment(&owner.dot)),
                None,
                true,
            )
            .await?
        else {
            return Ok(outcome("outcome", "unknown"));
        };
        let Ok(thread) = projection::identity(field(&body, "thread_id")) else {
            return Ok(outcome("outcome", "unknown"));
        };
        Ok(ObjectEncoder::new()
            .field(
                "outcome",
                if string(&body, "status") == Some("unconfirmed") {
                    "unconfirmed"
                } else {
                    "resumed"
                },
            )
            .field("threadID", thread.as_str())
            .optional(
                "rootChanged",
                &owner.root.as_ref().map(|root| root != &thread),
            )
            .finish())
    }

    async fn unarchive(&self, configuration: &Configuration, thread: &str) -> Result<bool, Error> {
        let reply = self
            .durable
            .request(
                configuration,
                "thread/unarchive",
                ObjectEncoder::new().field("threadId", thread).finish(),
                120,
            )
            .await;
        if matches!(reply, Reply::Unknown) {
            return Ok(false);
        }
        reply.result()?;
        self.durable
            .watch(configuration, thread, true)
            .await
            .result()?;
        Ok(true)
    }

    async fn send(
        &self,
        owner: &rest::Context,
        thread: &str,
        input: &JsonValue,
    ) -> Result<JsonValue, Error> {
        let text = match field(input, "text") {
            JsonValue::String(value) if value.len() <= 32768 => value,
            _ => return Err(malformed()),
        };
        let message = projection::identity(field(input, "clientMessageID"))?;
        let mode = string(input, "mode")
            .filter(|mode| ["send", "queue"].contains(mode))
            .ok_or_else(malformed)?;
        if owner.root.as_deref() == Some(thread) {
            let profile = self
                .rest
                .get(
                    owner,
                    &format!("/tbo/{}", rest::segment(&owner.dot)),
                    &[],
                    false,
                )
                .await?;
            let room = if string(&profile, "scope") == Some("shared") {
                let Some(body) = self
                    .rest
                    .post(
                        owner,
                        &format!("/messaging/dots/{}/dm", rest::segment(&owner.dot)),
                        None,
                        false,
                    )
                    .await?
                else {
                    return Ok(outcome("admission", "unknown"));
                };
                projection::identity(field(&body, "id"))?
            } else if !matches!(field(&profile, "messaging_room_id"), JsonValue::Null) {
                projection::identity(field(&profile, "messaging_room_id"))?
            } else {
                let Some(body) = self
                    .rest
                    .post(
                        owner,
                        &format!("/tbo/{}/messaging-room", rest::segment(&owner.dot)),
                        None,
                        false,
                    )
                    .await?
                else {
                    return Ok(outcome("admission", "unknown"));
                };
                if string(&body, "id") != Some(owner.dot.as_str()) {
                    return Err(malformed());
                }
                projection::identity(field(&body, "messaging_room_id"))?
            };
            if field(&profile, "is_paused") == &JsonValue::Bool(true) {
                let resumed = self.resume(owner).await?;
                if string(&resumed, "outcome") != Some("resumed")
                    || string(&resumed, "threadID") != owner.root.as_deref()
                {
                    return Ok(outcome("admission", "unknown"));
                }
            }
            let body = ObjectEncoder::new()
                .field(
                    "content",
                    &ObjectEncoder::new().field("text", text).finish(),
                )
                .field("request_id", message.as_str())
                .field("idempotency_token", message.as_str())
                .field(
                    "timezone_offset_min",
                    &f64::from(-chrono::Local::now().offset().local_minus_utc() / 60),
                )
                .finish();
            let sent = self
                .rest
                .post(
                    owner,
                    &format!("/messaging/rooms/{}/messages", rest::segment(&room)),
                    Some(&body),
                    false,
                )
                .await?;
            return Ok(outcome(
                "admission",
                if sent
                    .as_ref()
                    .is_some_and(|body| string(body, "id").is_some())
                {
                    "started"
                } else {
                    "unknown"
                },
            ));
        }
        let configuration = &owner.configuration;
        let subscription = self.durable.watch(configuration, thread, false).await;
        let mut unarchived = false;
        if subscription.archived() {
            unarchived = true;
            if !self.unarchive(configuration, thread).await? {
                return Ok(outcome("admission", "unknown"));
            }
        } else {
            subscription.result()?;
        }
        let params = ObjectEncoder::new()
            .field("threadId", thread)
            .field(
                "input",
                &vec![
                    ObjectEncoder::new()
                        .field("type", "text")
                        .field("text", text)
                        .field("text_elements", &Vec::<JsonValue>::new())
                        .finish(),
                ],
            )
            .field("clientUserMessageId", message.as_str())
            .field("messageThreadId", durable::request_id()?.as_str())
            .optional(
                "mode",
                &(mode == "queue").then(|| LosslessString::from("queue")),
            )
            .finish();
        let mut reply = self
            .durable
            .request(configuration, "turn/addUserMessage", params.clone(), 120)
            .await;
        if reply.archived() && !unarchived {
            if !self.unarchive(configuration, thread).await? {
                return Ok(outcome("admission", "unknown"));
            }
            reply = self
                .durable
                .request(configuration, "turn/addUserMessage", params, 120)
                .await;
        }
        if matches!(reply, Reply::Unknown) {
            return Ok(outcome("admission", "unknown"));
        }
        let reply = reply.result()?;
        let turn = projection::identity(field(field(&reply, "turn"), "id")).ok();
        let admission = string(&reply, "admissionOutcome")
            .filter(|value| ["started", "steered", "duplicate"].contains(value))
            .unwrap_or("unknown");
        Ok(ObjectEncoder::new()
            .field("admission", admission)
            .optional("turnID", &turn.map(LosslessString::from))
            .finish())
    }
}

fn page(value: &JsonValue, default: u32) -> Result<Vec<(String, String)>, Error> {
    let limit = match field(value, "limit") {
        JsonValue::Null => default,
        JsonValue::Number(value) if value.fract() == 0.0 && (1.0..=50.0).contains(value) => {
            *value as u32
        }
        _ => return Err(malformed()),
    };
    let mut query = vec![("limit".into(), limit.to_string())];
    if let Some(cursor) = cursor(value, "cursor")? {
        query.push(("cursor".into(), cursor));
    }
    Ok(query)
}
