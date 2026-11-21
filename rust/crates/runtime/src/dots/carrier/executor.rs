use super::{Clock, server_name_for_host, until};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{io::AsyncWriteExt, sync::watch};
use ycoding_core::{
    dots::{access, enrollment, native},
    session::prompt_cache::sha256,
    ycoding_schema::{JsonValue, LosslessString, ObjectEncoder, parse_json, stringify_json},
};

const DISPLAY_NAME_UNITS: usize = 100;
const REREGISTRATION_ATTEMPTS: u32 = 2;
const REREGISTRATION_RETRY_MS: u64 = 1_000;
const CODEX_HOME_SKILLS: &str = "codex-home-skills";
const DOTS_SKILLS: &str = "ycoding-dots-skills";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Root {
    pub id: String,
    pub path: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Pending,
    Completed,
    Failed,
    Uncertain,
    Removed,
}
impl Status {
    fn name(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Uncertain => "uncertain",
            Self::Removed => "removed",
        }
    }
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "pending" => Self::Pending,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "uncertain" => Self::Uncertain,
            "removed" => Self::Removed,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Declined {
    ExecutorChanged,
    Unconfirmed,
    Uncertain,
}
impl Declined {
    fn name(self) -> &'static str {
        match self {
            Self::ExecutorChanged => "executor-changed",
            Self::Unconfirmed => "unconfirmed",
            Self::Uncertain => "uncertain",
        }
    }
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "executor-changed" => Self::ExecutorChanged,
            "unconfirmed" => Self::Unconfirmed,
            "uncertain" => Self::Uncertain,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenameDeclined {
    pub label: LosslessString,
    pub outcome: Declined,
    pub at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Record {
    pub installation_id: String,
    pub account_hash: String,
    pub status: Status,
    pub created_at: String,
    pub updated_at: String,
    pub executor_id: Option<LosslessString>,
    pub custom_display_name: Option<LosslessString>,
    pub display_name: Option<LosslessString>,
    pub error_classification: Option<String>,
    pub roots: Option<Vec<Root>>,
    pub rename_declined: Option<RenameDeclined>,
}

#[derive(Debug)]
pub struct Failure {
    pub retryable: bool,
    #[cfg(test)]
    pub status: Option<u16>,
    pub cancelled: bool,
}
impl Failure {
    fn local() -> Self {
        Self {
            retryable: true,
            #[cfg(test)]
            status: None,
            cancelled: false,
        }
    }
    fn cancelled() -> Self {
        Self {
            retryable: true,
            #[cfg(test)]
            status: None,
            cancelled: true,
        }
    }
}

#[derive(Debug)]
pub enum Problem {
    Cancelled,
    Retry,
    Rejected(&'static str),
}

pub struct Resolved {
    pub executor_id: LosslessString,
    pub record: Record,
    pub notes: Vec<&'static str>,
    pub roots_changed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rename {
    Confirmed,
    ExecutorChanged,
    Unconfirmed,
    Uncertain,
    Unrecorded,
}

pub struct Renamed {
    pub outcome: Rename,
    pub persisted: bool,
    pub record: Record,
}

pub struct Reregistered {
    pub record: Record,
    pub executor_changed: bool,
}

pub type Refresh = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Option<Arc<native::ResolvedCredential>>> + Send>>
        + Send
        + Sync,
>;
pub type Installation =
    Box<dyn Fn() -> Pin<Box<dyn Future<Output = Option<String>> + Send>> + Send + Sync>;

pub struct Context<'a> {
    pub path: &'a Path,
    pub post: &'a enrollment::ExecutorPost,
    pub clock: &'a dyn Clock,
    pub refresh: Option<&'a Refresh>,
}

pub fn capability_roots(home: &Path, data: &Path) -> Vec<Root> {
    let text = |path: PathBuf| path.to_string_lossy().into_owned();
    vec![
        Root {
            id: CODEX_HOME_SKILLS.into(),
            path: text(home.join(".agents").join("skills")),
        },
        Root {
            id: DOTS_SKILLS.into(),
            path: text(data.join("dots").join("skills")),
        },
    ]
}

pub fn same_roots(left: Option<&[Root]>, right: &[Root]) -> bool {
    left == Some(right)
}

fn trimmed(text: &LosslessString) -> Vec<u16> {
    access::trim_units(&text.code_units().collect::<Vec<_>>()).to_vec()
}

fn sliced(units: &[u16]) -> LosslessString {
    LosslessString::from_utf16(units[..units.len().min(DISPLAY_NAME_UNITS)].to_vec())
}

fn default_name(hostname: &str, installation_id: &str) -> LosslessString {
    let suffix = format!(" ({})", &sha256(installation_id)[..6])
        .encode_utf16()
        .collect::<Vec<_>>();
    let host = server_name_for_host(hostname)
        .encode_utf16()
        .collect::<Vec<_>>();
    let host = access::trim_units(&host);
    let mut units = host[..host.len().min(DISPLAY_NAME_UNITS - suffix.len())].to_vec();
    units.extend(suffix);
    LosslessString::from_utf16(units)
}

fn stamp(clock: &dyn Clock) -> String {
    enrollment::instant_iso(clock.wall() as i64).unwrap_or_default()
}

fn encode(record: &Record) -> String {
    let mut encoder = ObjectEncoder::new()
        .field("installationID", record.installation_id.as_str())
        .field("accountHash", record.account_hash.as_str())
        .field("status", record.status.name())
        .field("createdAt", record.created_at.as_str())
        .field("updatedAt", record.updated_at.as_str());
    for (name, value) in [
        ("executorID", &record.executor_id),
        ("customDisplayName", &record.custom_display_name),
        ("displayName", &record.display_name),
    ] {
        if let Some(value) = value {
            encoder = encoder.field(name, value);
        }
    }
    if let Some(value) = &record.error_classification {
        encoder = encoder.field("errorClassification", value.as_str());
    }
    if let Some(roots) = &record.roots {
        let roots = roots
            .iter()
            .map(|root| {
                ObjectEncoder::new()
                    .field("id", root.id.as_str())
                    .field("path", root.path.as_str())
                    .finish()
            })
            .collect();
        encoder = encoder.field("selectedCapabilityRoots", &JsonValue::Array(roots));
    }
    if let Some(declined) = &record.rename_declined {
        let item = ObjectEncoder::new()
            .field("label", &declined.label)
            .field("outcome", declined.outcome.name());
        encoder = encoder.field(
            "renameDeclined",
            &item.field("at", declined.at.as_str()).finish(),
        );
    }
    stringify_json(&encoder.finish())
}

fn decode(text: &str) -> Option<Record> {
    let Ok(JsonValue::Object(object)) = parse_json(text) else {
        return None;
    };
    let lossless = |name: &str| match object.get(&name.into()) {
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => None,
    };
    let string = |name: &str| lossless(name)?.to_utf8().ok();
    let roots = match object.get(&"selectedCapabilityRoots".into()) {
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|item| {
                let JsonValue::Object(item) = item else {
                    return None;
                };
                let text = |name: &str| match item.get(&name.into()) {
                    Some(JsonValue::String(value)) => value.to_utf8().ok(),
                    _ => None,
                };
                Some(Root {
                    id: text("id")?,
                    path: text("path")?,
                })
            })
            .collect::<Option<Vec<_>>>(),
        _ => None,
    };
    let rename_declined = match object.get(&"renameDeclined".into()) {
        Some(JsonValue::Object(item)) => {
            let lossless = |name: &str| match item.get(&name.into()) {
                Some(JsonValue::String(value)) => Some(value.clone()),
                _ => None,
            };
            (|| {
                Some(RenameDeclined {
                    label: lossless("label")?,
                    outcome: Declined::parse(&lossless("outcome")?.to_utf8().ok()?)?,
                    at: lossless("at")?.to_utf8().ok()?,
                })
            })()
        }
        _ => None,
    };
    Some(Record {
        installation_id: string("installationID")?,
        account_hash: string("accountHash").unwrap_or_default(),
        status: Status::parse(&string("status")?)?,
        created_at: string("createdAt").unwrap_or_default(),
        updated_at: string("updatedAt").unwrap_or_default(),
        executor_id: lossless("executorID"),
        custom_display_name: lossless("customDisplayName"),
        display_name: lossless("displayName"),
        error_classification: string("errorClassification"),
        roots,
        rename_declined,
    })
}

pub async fn load(path: &Path) -> Result<Option<Record>, ()> {
    match tokio::fs::read_to_string(path).await {
        Ok(text) => decode(&text).map(Some).ok_or(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

async fn read(path: &Path) -> Result<Option<Record>, Problem> {
    load(path)
        .await
        .map_err(|_| Problem::Rejected("enrollment-unreadable"))
}

async fn write_private(path: &Path, text: &str, exclusive: bool) -> std::io::Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true);
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(text.as_bytes()).await?;
    file.sync_all().await
}

fn request_body(name: &LosslessString, installation_id: &str, roots: &[Root]) -> String {
    let roots = roots
        .iter()
        .map(|root| {
            ObjectEncoder::new()
                .field("id", root.id.as_str())
                .field("path", root.path.as_str())
                .finish()
        })
        .collect();
    stringify_json(
        &ObjectEncoder::new()
            .field("displayName", name)
            .field("installation_id", installation_id)
            .field("selected_capability_roots", &JsonValue::Array(roots))
            .finish(),
    )
}

struct Decoded {
    executor_id: LosslessString,
    custom_display_name: Option<LosslessString>,
}

fn decode_response(body: &str) -> Option<Decoded> {
    let Ok(JsonValue::Object(object)) = parse_json(body) else {
        return None;
    };
    let Some(JsonValue::String(executor_id)) = object.get(&"executor_id".into()) else {
        return None;
    };
    let executor_id = LosslessString::from_utf16(trimmed(executor_id));
    if executor_id.is_empty() {
        return None;
    }
    let custom_display_name = match object.get(&"custom_display_name".into()) {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::String(name)) => Some(name.clone()),
        Some(_) => return None,
    };
    Some(Decoded {
        executor_id,
        custom_display_name,
    })
}

fn retryable_status(status: u16) -> bool {
    matches!(status, 401 | 408 | 429) || status >= 500
}

async fn exchange(
    ctx: &Context<'_>,
    credential: &Arc<native::ResolvedCredential>,
    body: &str,
) -> Result<Decoded, Failure> {
    let transport = |_| Failure::local();
    let send = |credential: Arc<native::ResolvedCredential>| {
        (ctx.post)(enrollment::ExecutorRequest {
            credential,
            body: body.to_owned(),
        })
    };
    let mut response = send(credential.clone()).await.map_err(transport)?;
    if response.status == 401
        && let Some(refresh) = ctx.refresh
    {
        let refreshed = refresh(credential.access_token.clone())
            .await
            .filter(|refreshed| refreshed.account_id == credential.account_id);
        let Some(refreshed) = refreshed else {
            return Err(Failure {
                retryable: true,
                #[cfg(test)]
                status: Some(401),
                cancelled: false,
            });
        };
        response = send(refreshed).await.map_err(transport)?;
    }
    if !(200..300).contains(&response.status) || response.challenged {
        return Err(Failure {
            retryable: !response.challenged && retryable_status(response.status),
            #[cfg(test)]
            status: Some(response.status),
            cancelled: false,
        });
    }
    decode_response(&response.body).ok_or(Failure {
        retryable: false,
        #[cfg(test)]
        status: None,
        cancelled: false,
    })
}

async fn post_registration(
    ctx: &Context<'_>,
    credential: &Arc<native::ResolvedCredential>,
    body: &str,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Decoded, Failure> {
    let deadline = Duration::from_millis(enrollment::EXECUTOR_DEADLINE_MS);
    match until(
        cancel,
        tokio::time::timeout(deadline, exchange(ctx, credential, body)),
    )
    .await
    {
        None => Err(Failure::cancelled()),
        Some(Err(_)) => Err(Failure::local()),
        Some(Ok(result)) => result,
    }
}

pub async fn register(
    ctx: &Context<'_>,
    credential: &Arc<native::ResolvedCredential>,
    installation_id: &str,
    display_name: &LosslessString,
    roots: &[Root],
    cancel: &mut watch::Receiver<bool>,
) -> Result<Record, Failure> {
    let installation_id = installation_id.trim();
    let name = trimmed(display_name);
    if installation_id.is_empty() || name.is_empty() {
        return Err(Failure::local());
    }
    let name = sliced(&name);
    let body = request_body(&name, installation_id, roots);
    let now = stamp(ctx.clock);
    let reserved = Record {
        installation_id: installation_id.to_owned(),
        account_hash: sha256(&credential.account_id),
        status: Status::Pending,
        created_at: now.clone(),
        updated_at: now,
        executor_id: None,
        custom_display_name: None,
        display_name: None,
        error_classification: None,
        roots: None,
        rename_declined: None,
    };
    write_private(ctx.path, &encode(&reserved), true)
        .await
        .map_err(|_| Failure::local())?;
    match post_registration(ctx, credential, &body, cancel).await {
        Err(failure) => {
            if failure.retryable {
                let _ = tokio::fs::remove_file(ctx.path).await;
            } else {
                let failed = Record {
                    status: Status::Failed,
                    error_classification: Some("failed".into()),
                    updated_at: stamp(ctx.clock),
                    ..reserved
                };
                let _ = write_private(ctx.path, &encode(&failed), false).await;
            }
            Err(failure)
        }
        Ok(decoded) => {
            let completed = Record {
                status: Status::Completed,
                executor_id: Some(decoded.executor_id),
                custom_display_name: decoded.custom_display_name,
                display_name: Some(name),
                roots: Some(roots.to_vec()),
                updated_at: stamp(ctx.clock),
                ..reserved
            };
            write_private(ctx.path, &encode(&completed), false)
                .await
                .map_err(|_| Failure::local())?;
            Ok(completed)
        }
    }
}

pub async fn reregister(
    ctx: &Context<'_>,
    credential: &Arc<native::ResolvedCredential>,
    record: &Record,
    display_name: &LosslessString,
    roots: &[Root],
    cancel: &mut watch::Receiver<bool>,
) -> Result<Reregistered, Failure> {
    let name = sliced(&trimmed(display_name));
    let installation_id = record.installation_id.trim();
    let sent = trimmed(&name);
    if installation_id.is_empty() || sent.is_empty() {
        return Err(Failure::local());
    }
    let body = request_body(&sliced(&sent), installation_id, roots);
    let mut attempt = 1;
    let decoded = loop {
        match post_registration(ctx, credential, &body, cancel).await {
            Ok(decoded) => break decoded,
            Err(failure)
                if attempt >= REREGISTRATION_ATTEMPTS
                    || !failure.retryable
                    || failure.cancelled =>
            {
                return Err(failure);
            }
            Err(_) => {
                let deadline = ctx.clock.now() + REREGISTRATION_RETRY_MS;
                if until(cancel, ctx.clock.sleep_until(deadline))
                    .await
                    .is_none()
                {
                    return Err(Failure::cancelled());
                }
                attempt += 1;
            }
        }
    };
    let executor_changed = record.executor_id.as_ref() != Some(&decoded.executor_id);
    let updated = Record {
        executor_id: Some(decoded.executor_id),
        custom_display_name: decoded.custom_display_name,
        display_name: Some(name),
        roots: Some(roots.to_vec()),
        updated_at: stamp(ctx.clock),
        ..record.clone()
    };
    write_private(ctx.path, &encode(&updated), false)
        .await
        .map_err(|_| Failure::local())?;
    Ok(Reregistered {
        record: updated,
        executor_changed,
    })
}

pub async fn reconcile(
    ctx: &Context<'_>,
    credential: &Arc<native::ResolvedCredential>,
    record: &Record,
    display_name: &LosslessString,
    roots: &[Root],
    cancel: &mut watch::Receiver<bool>,
) -> Result<Reregistered, Failure> {
    let reregistered = reregister(ctx, credential, record, display_name, roots, cancel).await?;
    let confirmed = reregistered.record.custom_display_name.is_some()
        && reregistered.record.custom_display_name == reregistered.record.display_name;
    let restored = !confirmed && !reregistered.executor_changed;
    let mut settled = reregistered.record;
    if restored {
        settled.display_name = record.display_name.clone();
        settled.updated_at = stamp(ctx.clock);
        write_private(ctx.path, &encode(&settled), false)
            .await
            .map_err(|_| Failure::local())?;
    }
    let superseded = record.rename_declined.as_ref().is_some_and(|declined| {
        reregistered.executor_changed
            || settled
                .custom_display_name
                .as_ref()
                .is_some_and(|custom| *custom == declined.label)
    });
    if superseded {
        settled.rename_declined = None;
        settled.updated_at = stamp(ctx.clock);
        write_private(ctx.path, &encode(&settled), false)
            .await
            .map_err(|_| Failure::local())?;
    }
    Ok(Reregistered {
        record: settled,
        executor_changed: reregistered.executor_changed,
    })
}

pub struct EnrollmentInput<'a> {
    pub hostname: &'a str,
    pub configured_name: Option<&'a LosslessString>,
    pub roots: &'a [Root],
    pub installation: &'a Installation,
}

pub async fn resolve(
    ctx: &Context<'_>,
    credential: &Arc<native::ResolvedCredential>,
    enrollment: EnrollmentInput<'_>,
    reconciled: &mut bool,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Resolved, Problem> {
    let EnrollmentInput {
        hostname,
        configured_name,
        roots,
        installation,
    } = enrollment;
    let mut state = read(ctx.path).await?;
    if state
        .as_ref()
        .is_some_and(|record| matches!(record.status, Status::Failed | Status::Removed))
    {
        let _ = tokio::fs::remove_file(ctx.path).await;
        state = None;
    }
    if state.is_none() {
        let Some(installation_id) = installation().await else {
            return Err(Problem::Retry);
        };
        let label = configured_name
            .cloned()
            .unwrap_or_else(|| default_name(hostname, &installation_id));
        match register(ctx, credential, &installation_id, &label, roots, cancel).await {
            Ok(record) => {
                *reconciled = true;
                state = Some(record);
            }
            Err(failure) if failure.cancelled => return Err(Problem::Cancelled),
            Err(_) => state = Some(read(ctx.path).await?.ok_or(Problem::Retry)?),
        }
    }
    let Some(mut record) = state else {
        return Err(Problem::Retry);
    };
    match record.status {
        Status::Failed | Status::Removed => {
            return Err(Problem::Rejected("enrollment-rejected"));
        }
        Status::Pending | Status::Uncertain => {
            return Err(Problem::Rejected("enrollment-uncertain"));
        }
        Status::Completed => {}
    }
    if record.account_hash != sha256(&credential.account_id) {
        return Err(Problem::Rejected("enrollment-account-mismatch"));
    }
    if record
        .executor_id
        .as_ref()
        .is_none_or(|executor_id| trimmed(executor_id).is_empty())
    {
        return Err(Problem::Rejected("enrollment-unreadable"));
    }
    let mut notes = Vec::new();
    if !*reconciled {
        *reconciled = true;
        let label = configured_name
            .cloned()
            .or_else(|| record.display_name.clone())
            .unwrap_or_else(|| LosslessString::from(hostname));
        match reconcile(ctx, credential, &record, &label, roots, cancel).await {
            Ok(updated) => {
                if updated.executor_changed {
                    notes.push("registration-executor-changed");
                }
                record = updated.record;
            }
            Err(failure) if failure.cancelled => return Err(Problem::Cancelled),
            Err(_) => notes.push("registration-update-failed"),
        }
    }
    let roots_changed = !same_roots(record.roots.as_deref(), roots);
    if roots_changed {
        let label = configured_name
            .cloned()
            .or_else(|| record.display_name.clone())
            .unwrap_or_else(|| LosslessString::from(hostname));
        match reregister(ctx, credential, &record, &label, roots, cancel).await {
            Ok(updated) => {
                if updated.executor_changed {
                    notes.push("registration-executor-changed");
                }
                record = updated.record;
            }
            Err(failure) if failure.cancelled => return Err(Problem::Cancelled),
            Err(_) => notes.push("registration-update-failed"),
        }
    }
    let executor_id = record
        .executor_id
        .as_ref()
        .map(|executor_id| LosslessString::from_utf16(trimmed(executor_id)))
        .filter(|executor_id| !executor_id.is_empty())
        .ok_or(Problem::Rejected("enrollment-unreadable"))?;
    Ok(Resolved {
        executor_id,
        record,
        notes,
        roots_changed,
    })
}

async fn fenced(path: &Path, record: &Record) -> Option<(String, Record)> {
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    let current = decode(&raw)?;
    (current.account_hash == record.account_hash
        && current.installation_id == record.installation_id
        && current.executor_id == record.executor_id)
        .then_some((raw, current))
}

pub async fn rename(
    ctx: &Context<'_>,
    credential: &Arc<native::ResolvedCredential>,
    record: &Record,
    label: &LosslessString,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Renamed, Failure> {
    let label = sliced(&trimmed(label));
    if label.is_empty() {
        return Err(Failure::local());
    }
    if *cancel.borrow() {
        return Err(Failure::cancelled());
    }
    let body = stringify_json(
        &ObjectEncoder::new()
            .field("installation_id", record.installation_id.trim())
            .field("custom_display_name", &label)
            .finish(),
    );
    let unrecorded = || Renamed {
        outcome: Rename::Unrecorded,
        persisted: false,
        record: record.clone(),
    };
    let Some((raw, current)) = fenced(ctx.path, record).await else {
        return Ok(unrecorded());
    };
    let declined = |outcome: Declined| RenameDeclined {
        label: label.clone(),
        outcome,
        at: stamp(ctx.clock),
    };
    let intent = Record {
        rename_declined: Some(declined(Declined::Uncertain)),
        updated_at: stamp(ctx.clock),
        ..current
    };
    if write_private(ctx.path, &encode(&intent), false)
        .await
        .is_err()
    {
        return Ok(unrecorded());
    }
    let dispatched = Arc::new(AtomicBool::new(false));
    let post: enrollment::ExecutorPost = {
        let (inner, dispatched) = (ctx.post.clone(), dispatched.clone());
        Arc::new(move |request| {
            dispatched.store(true, Ordering::SeqCst);
            inner(request)
        })
    };
    let sending = Context {
        path: ctx.path,
        post: &post,
        clock: ctx.clock,
        refresh: None,
    };
    let decoded = match post_registration(&sending, credential, &body, cancel).await {
        Ok(decoded) => decoded,
        Err(failure) => {
            if !dispatched.load(Ordering::SeqCst) {
                let _ = write_private(ctx.path, &raw, false).await;
                return Err(failure);
            }
            return Ok(Renamed {
                outcome: Rename::Uncertain,
                persisted: true,
                record: intent,
            });
        }
    };
    let (outcome, rename_declined, confirmed, adopted) =
        if Some(&decoded.executor_id) != record.executor_id.as_ref() {
            if decoded.custom_display_name.as_ref() != Some(&label) {
                (
                    Rename::Unconfirmed,
                    Some(declined(Declined::Unconfirmed)),
                    None,
                    None,
                )
            } else {
                (
                    Rename::ExecutorChanged,
                    None,
                    Some(label.clone()),
                    Some(decoded.executor_id),
                )
            }
        } else if decoded.custom_display_name.as_ref() != Some(&label) {
            (
                Rename::Unconfirmed,
                Some(declined(Declined::Unconfirmed)),
                None,
                None,
            )
        } else {
            (Rename::Confirmed, None, Some(label.clone()), None)
        };
    let Some((_, latest)) = fenced(ctx.path, record).await else {
        return Ok(Renamed {
            outcome,
            persisted: false,
            record: intent,
        });
    };
    let mut state = Record {
        rename_declined,
        updated_at: stamp(ctx.clock),
        ..latest
    };
    if confirmed.is_some() {
        state.custom_display_name = confirmed;
    }
    if adopted.is_some() {
        state.executor_id = adopted;
    }
    let persisted = write_private(ctx.path, &encode(&state), false)
        .await
        .is_ok();
    Ok(Renamed {
        outcome,
        persisted,
        record: state,
    })
}
