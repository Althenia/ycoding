use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::watch;
use ycoding_schema::{
    JsonValue, LosslessString, ObjectEncoder,
    dots::{RejectionLabel, RejectionMessage},
};
use ycoding_store::{
    Client, KeyPart, Write,
    resources::{self, KvTable},
    session::Document,
    tuple_key,
};

const KEY: &str = "dots.native-access";
const REMOVED_GUIDANCE: &str = "This computer was removed from your ChatGPT account and Dots access is off. Turn Dots access on to enroll it again.";
const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Preference {
    pub enabled: bool,
    pub revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigurationStatus {
    pub ready: bool,
    pub profile: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Unavailable,
    InvalidInput,
    Conflict,
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "Native Session access is unavailable",
            Self::InvalidInput => "Invalid global Dots access change",
            Self::Conflict => "Global Dots access revision changed",
        })
    }
}
impl std::error::Error for Error {}

pub type Configuration = Arc<dyn Fn() -> Result<ConfigurationStatus, Error> + Send + Sync>;
pub type StatusFuture<'a> =
    Pin<Box<dyn Future<Output = Result<TransportStatus, Error>> + Send + 'a>>;
pub type ComputerFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ComputerStatus, Error>> + Send + 'a>>;
type ComputerFutureOwned = ComputerFuture<'static>;
pub trait Transport: Send + Sync {
    fn status(&self) -> StatusFuture<'_>;
    fn computer(&self) -> ComputerFuture<'_>;
    fn attach_computer(&self, input: ComputerAttach) -> ComputerFuture<'_>;
    fn detach_computer(&self, input: ComputerDetach) -> ComputerFuture<'_>;
    fn remove_computer(&self, input: ComputerRemove) -> ComputerFuture<'_>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerAttach {
    pub replace_others: bool,
    pub expected_target: Option<ComputerTarget>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerDetach {
    pub expected_target: Option<ComputerTarget>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerRemove {
    pub expected_target: Option<ComputerTarget>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerTarget {
    pub dot_id: LosslessString,
    pub thread_id: LosslessString,
    pub environment_id: LosslessString,
    pub revision: String,
}
impl ComputerTarget {
    pub fn is_valid(&self) -> bool {
        [&self.dot_id, &self.thread_id, &self.environment_id]
            .iter()
            .all(|value| !value.is_empty() && value.len() <= 256)
            && self.revision.len() == 64
            && self
                .revision
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComputerState {
    Attached,
    Detached,
    Unavailable,
    Removed,
}
impl ComputerState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Attached => "attached",
            Self::Detached => "detached",
            Self::Unavailable => "unavailable",
            Self::Removed => "removed",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Readiness {
    Connected,
    Offline,
    Unknown,
}
impl Readiness {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::Offline => "offline",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DotEnvironment {
    pub status: String,
    pub capabilities: Vec<(String, String)>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComputerProblem {
    Configuration,
    Authentication,
    Enrollment,
    DotUnavailable,
    NotListed,
    AdminDisabled,
    NotConnectable,
    Rejected,
    Unconfirmed,
    Connection,
    TargetChanged,
    NotDisconnectable,
    NotDeletable,
}
impl ComputerProblem {
    fn guidance(self) -> &'static str {
        match self {
            Self::Configuration => {
                "Turn on Dots access with a ready ChatGPT profile to attach this computer."
            }
            Self::Authentication => {
                "The selected ChatGPT profile could not be used. Check its sign-in."
            }
            Self::Enrollment => {
                "This computer's Dots executor is not enrolled for the selected account yet. Keep Dots access on and try again."
            }
            Self::DotUnavailable => "No single active Dot was found for this account.",
            Self::NotListed => {
                "This computer is not among your Dot's computers yet. Keep Dots access on and try again."
            }
            Self::AdminDisabled => {
                "Your workspace administrator has disabled local computer access."
            }
            Self::NotConnectable => "ChatGPT does not allow attaching this computer right now.",
            Self::Rejected => "ChatGPT refused the request.",
            Self::Unconfirmed => {
                "The outcome is unconfirmed. Do not repeat the request; refresh status and confirm the current computer before any new attempt."
            }
            Self::Connection => "Your Dot's computers could not be read. Try again.",
            Self::TargetChanged => {
                "The Dots computer or account changed. Refresh and confirm the current computer before changing it."
            }
            Self::NotDisconnectable => "ChatGPT does not allow detaching this computer right now.",
            Self::NotDeletable => "ChatGPT does not allow removing this computer right now.",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerStatus {
    pub state: ComputerState,
    pub problem: Option<ComputerProblem>,
    pub name: Option<LosslessString>,
    pub target: Option<ComputerTarget>,
    pub readiness: Option<Readiness>,
    pub usable_for_tasks: Option<bool>,
    pub dot_environment: Option<DotEnvironment>,
}
impl ComputerStatus {
    pub fn new(state: ComputerState, problem: Option<ComputerProblem>) -> Self {
        Self {
            state,
            problem,
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        }
    }
    pub fn failure() -> Self {
        Self::new(
            ComputerState::Unavailable,
            Some(ComputerProblem::Connection),
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Computer {
    pub state: ComputerState,
    pub message: Option<String>,
    pub name: Option<LosslessString>,
    pub target: Option<ComputerTarget>,
    pub readiness: Option<Readiness>,
    pub usable_for_tasks: Option<bool>,
    pub dot_environment: Option<DotEnvironment>,
}
impl Computer {
    fn bare(state: ComputerState, message: Option<String>) -> Self {
        Self {
            state,
            message,
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Problem {
    Configuration,
    Authentication,
    Enrollment,
    Connection,
}
impl Problem {
    fn guidance(self) -> &'static str {
        match self {
            Self::Configuration => {
                "Native configuration is unavailable. Check global Dots configuration."
            }
            Self::Authentication => {
                "The selected ChatGPT profile is unavailable. Check its authentication; the connector retries automatically."
            }
            Self::Enrollment => {
                "Native enrollment failed. Check the selected profile and connection; the connector retries automatically."
            }
            Self::Connection => {
                "The native connection failed. The connector retries automatically."
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransportStatus {
    pub state: String,
    pub hostname: Option<String>,
    pub name: Option<String>,
    pub problem: Option<Problem>,
}
impl TransportStatus {
    pub fn connected(hostname: &str) -> Self {
        Self {
            state: "connected".into(),
            hostname: Some(hostname.into()),
            name: None,
            problem: None,
        }
    }
    pub fn connecting() -> Self {
        Self {
            state: "connecting".into(),
            hostname: None,
            name: None,
            problem: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectionStatus {
    pub state: String,
    pub hostname: Option<LosslessString>,
    pub name: Option<LosslessString>,
    pub message: Option<LosslessString>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigurationView {
    pub ready: bool,
    pub profile: Option<LosslessString>,
    pub message: Option<LosslessString>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Status {
    pub access: Preference,
    pub configuration: ConfigurationView,
    pub connection: ConnectionStatus,
    pub computer: Option<Computer>,
}

struct Owner {
    transport: Arc<dyn Transport>,
}
struct Snapshot {
    owner: Option<Arc<Owner>>,
    access: Preference,
    configuration: ConfigurationStatus,
}
struct Inner {
    client: Client,
    configuration: Configuration,
    transport: Mutex<Option<Arc<Owner>>>,
    changes: watch::Sender<u64>,
    listeners: Mutex<std::collections::BTreeMap<u64, Arc<dyn Fn() + Send + Sync>>>,
    listener_id: std::sync::atomic::AtomicU64,
}
pub(crate) struct Listener {
    access: Weak<Inner>,
    id: u64,
}
impl Drop for Listener {
    fn drop(&mut self) {
        if let Some(access) = self.access.upgrade() {
            access
                .listeners
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.id);
        }
    }
}
#[derive(Clone)]
pub struct Access(Arc<Inner>);
pub struct Attachment {
    access: Weak<Inner>,
    owner: Arc<Owner>,
}
impl Attachment {
    pub(super) fn guard(&self) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let access = self.access.clone();
        let expected = Arc::downgrade(&self.owner);
        Arc::new(move || {
            let (Some(access), Some(expected)) = (access.upgrade(), expected.upgrade()) else {
                return false;
            };
            access
                .transport
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
                .is_some_and(|owner| Arc::ptr_eq(owner, &expected))
        })
    }
    pub fn release(&self) {
        if let Some(access) = self.access.upgrade() {
            let mut attached = access
                .transport
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if attached
                .as_ref()
                .is_some_and(|owner| Arc::ptr_eq(owner, &self.owner))
            {
                *attached = None;
            }
        }
    }
}
impl Drop for Attachment {
    fn drop(&mut self) {
        self.release();
    }
}

impl Access {
    pub fn new(client: Client, configuration: Configuration) -> Self {
        Self(Arc::new(Inner {
            client,
            configuration,
            transport: Mutex::new(None),
            changes: watch::channel(0).0,
            listeners: Mutex::default(),
            listener_id: std::sync::atomic::AtomicU64::new(0),
        }))
    }
    pub fn get(&self) -> Result<Preference, Error> {
        decode(
            resources::get_kv(
                &self.0.client.snapshot().map_err(|_| Error::Unavailable)?,
                &KEY.into(),
            )
            .map_err(|_| Error::Unavailable)?
            .map(|value| value.domain().map(ycoding_schema::domain::Json::into_value))
            .transpose()
            .map_err(|_| Error::Unavailable)?,
        )
    }
    pub async fn set(&self, enabled: bool, expected_revision: u64) -> Result<Preference, Error> {
        if expected_revision > MAX_REVISION {
            return Err(Error::InvalidInput);
        }
        let configuration = self.0.configuration.clone();
        let observed = self.0.clone();
        let result = self
            .0
            .client
            .submit_owned(
                move |tx| {
                    let current = read_in(tx).map_err(store_error)?;
                    if current.revision != expected_revision {
                        return Err(store_error(Error::Conflict));
                    }
                    if enabled && !(configuration)().map_err(store_error)?.ready {
                        return Err(store_error(Error::Unavailable));
                    }
                    if current.enabled == enabled {
                        return Ok((current, false));
                    }
                    let revision = current
                        .revision
                        .checked_add(1)
                        .filter(|value| *value <= MAX_REVISION)
                        .ok_or_else(|| store_error(Error::Unavailable))?;
                    let access = Preference { enabled, revision };
                    let value = ycoding_schema::domain::Json::new(
                        ObjectEncoder::new()
                            .field("enabled", &enabled)
                            .field("revision", &(revision as f64))
                            .finish(),
                    )
                    .map_err(|_| store_error(Error::Unavailable))?;
                    resources::set_kv(
                        tx,
                        &KEY.into(),
                        &Document::from_domain(&value)?,
                        chrono::Utc::now().timestamp_millis(),
                    )?;
                    Ok((access, true))
                },
                move |result| {
                    let Ok((access, true)) = result else {
                        return;
                    };
                    observed.changes.send_replace(access.revision);
                },
            )
            .map_err(map_store)?
            .await
            .map_err(map_store)?;
        if result.1 {
            let listeners = self
                .0
                .listeners
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for listener in listeners {
                listener();
            }
        }
        Ok(result.0)
    }
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.0.changes.subscribe()
    }
    pub(crate) fn listen(&self, listener: Arc<dyn Fn() + Send + Sync>) -> Listener {
        let id = self
            .0
            .listener_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.0
            .listeners
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id, listener);
        Listener {
            access: Arc::downgrade(&self.0),
            id,
        }
    }
    pub fn attach_transport(&self, transport: Arc<dyn Transport>) -> Result<Attachment, Error> {
        let mut attached = self
            .0
            .transport
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if attached.is_some() {
            return Err(Error::Unavailable);
        }
        let owner = Arc::new(Owner { transport });
        *attached = Some(owner.clone());
        Ok(Attachment {
            access: Arc::downgrade(&self.0),
            owner,
        })
    }
    fn snapshot(&self) -> Result<Snapshot, Error> {
        let access = self.get()?;
        let configuration = (self.0.configuration)()?;
        let owner = self
            .0
            .transport
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        Ok(Snapshot {
            owner,
            access,
            configuration,
        })
    }
    pub async fn status(&self) -> Result<Status, Error> {
        let baseline = self.snapshot()?;
        self.observe(None, baseline).await
    }
    async fn change(
        &self,
        run: impl FnOnce(Arc<dyn Transport>) -> ComputerFutureOwned,
    ) -> Result<(ComputerStatus, Snapshot), Error> {
        let baseline = self.snapshot()?;
        let owner = baseline.owner.clone().ok_or(Error::Unavailable)?;
        let result = if baseline.access.enabled && baseline.configuration.ready {
            run(owner.transport.clone())
                .await
                .unwrap_or_else(|_| ComputerStatus::failure())
        } else {
            ComputerStatus::new(
                ComputerState::Unavailable,
                Some(ComputerProblem::Configuration),
            )
        };
        Ok((result, baseline))
    }
    pub async fn attach_computer(&self, input: ComputerAttach) -> Result<Status, Error> {
        let (result, baseline) = self
            .change(|transport| Box::pin(async move { transport.attach_computer(input).await }))
            .await?;
        self.observe(Some(result), baseline).await
    }
    pub async fn detach_computer(&self, input: ComputerDetach) -> Result<Status, Error> {
        let (result, baseline) = self
            .change(|transport| Box::pin(async move { transport.detach_computer(input).await }))
            .await?;
        self.observe(Some(result), baseline).await
    }
    pub async fn remove_computer(&self, input: ComputerRemove) -> Result<Status, Error> {
        let (result, baseline) = self
            .change(|transport| Box::pin(async move { transport.remove_computer(input).await }))
            .await?;
        if result.state != ComputerState::Removed {
            return self.observe(Some(result), baseline).await;
        }
        let current = self.get()?;
        if current.enabled {
            self.set(false, current.revision).await?;
        }
        let baseline = self.snapshot()?;
        self.observe(Some(result), baseline).await
    }
    async fn observe(
        &self,
        attempted: Option<ComputerStatus>,
        baseline: Snapshot,
    ) -> Result<Status, Error> {
        let Snapshot {
            owner,
            access: initial,
            configuration,
        } = baseline;
        let (observed, computed) = match &owner {
            Some(owner) => {
                let (observed, computed) = tokio::join!(owner.transport.status(), async {
                    match attempted {
                        Some(result) => result,
                        None => owner
                            .transport
                            .computer()
                            .await
                            .unwrap_or_else(|_| ComputerStatus::failure()),
                    }
                });
                (
                    Some(observed.unwrap_or(TransportStatus {
                        state: "error".into(),
                        hostname: None,
                        name: None,
                        problem: Some(Problem::Connection),
                    })),
                    Some(computed),
                )
            }
            None => (None, None),
        };
        let access = self.get()?;
        let current = (self.0.configuration)()?;
        let same_owner = {
            let attached = self
                .0
                .transport
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            matches!((&owner, attached.as_ref()), (Some(owner), Some(attached)) if Arc::ptr_eq(owner, attached))
        };
        let observed_binding = same_owner && initial.revision == access.revision;
        let hostname = if observed_binding {
            observed
                .as_ref()
                .and_then(|status| display(status.hostname.as_deref(), 256))
        } else {
            None
        };
        let name = if observed_binding {
            observed
                .as_ref()
                .and_then(|status| display(status.name.as_deref(), 256))
        } else {
            None
        };
        let state = if !same_owner {
            "unavailable"
        } else if !access.enabled || !current.ready {
            "off"
        } else if initial.revision != access.revision || configuration != current {
            "connecting"
        } else {
            observed
                .as_ref()
                .map_or("connecting", |status| match status.state.as_str() {
                    "off" => "off",
                    "connecting" => "connecting",
                    "connected" => "connected",
                    _ => "error",
                })
        };
        let message = if same_owner
            && initial == access
            && configuration == current
            && access.enabled
            && current.ready
        {
            observed.as_ref().and_then(|status| {
                status
                    .problem
                    .map(|problem| LosslessString::from(problem.guidance()))
            })
        } else {
            None
        };
        let current_binding = observed_binding && configuration == current;
        let computer = computed.filter(|_| same_owner).map(|computed| {
            let computed = if computed
                .target
                .as_ref()
                .is_some_and(|target| !target.is_valid())
            {
                ComputerStatus::failure()
            } else {
                computed
            };
            if !current_binding {
                Computer::bare(ComputerState::Unavailable, None)
            } else if computed.state == ComputerState::Removed {
                Computer::bare(ComputerState::Removed, Some(REMOVED_GUIDANCE.into()))
            } else {
                Computer {
                    state: computed.state,
                    message: computed.problem.map(|problem| problem.guidance().into()),
                    name: computed
                        .name
                        .as_ref()
                        .and_then(|name| display_lossless(name, 256)),
                    target: computed.target,
                    readiness: computed.readiness,
                    usable_for_tasks: computed.usable_for_tasks,
                    dot_environment: computed.dot_environment,
                }
            }
        });
        Ok(Status {
            access,
            configuration: ConfigurationView {
                ready: current.ready,
                profile: display(current.profile.as_deref(), 256),
                message: display(current.message.as_deref(), 500),
            },
            connection: ConnectionStatus {
                state: state.into(),
                hostname,
                name,
                message,
            },
            computer,
        })
    }
}

fn js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x9..=0xd
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

pub fn trim_units(units: &[u16]) -> &[u16] {
    let start = units
        .iter()
        .position(|unit| !js_space(*unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !js_space(*unit))
        .map_or(start, |index| index + 1);
    &units[start..end]
}

pub(crate) fn display_units(units: &[u16], limit: usize) -> Option<Vec<u16>> {
    let replaced = units
        .iter()
        .map(|unit| {
            if *unit <= 0x1f || (0x7f..=0x9f).contains(unit) {
                0x20
            } else {
                *unit
            }
        })
        .collect::<Vec<_>>();
    let trimmed = trim_units(&replaced);
    let bounded = &trimmed[..trimmed.len().min(limit)];
    (!bounded.is_empty()).then(|| bounded.to_vec())
}

pub(crate) fn display_lossless(value: &LosslessString, limit: usize) -> Option<LosslessString> {
    display_units(&value.code_units().collect::<Vec<_>>(), limit).map(LosslessString::from_utf16)
}

fn display(value: Option<&str>, limit: usize) -> Option<LosslessString> {
    let units = value?.encode_utf16().collect::<Vec<_>>();
    display_units(&units, limit).map(LosslessString::from_utf16)
}

pub(crate) fn read_in(tx: &mut Write<'_>) -> Result<Preference, Error> {
    decode(
        tx.get::<KvTable>(&tuple_key(&[KeyPart::String(&KEY.into())]))
            .map_err(|_| Error::Unavailable)?
            .map(|row| {
                row.value
                    .domain()
                    .map(ycoding_schema::domain::Json::into_value)
            })
            .transpose()
            .map_err(|_| Error::Unavailable)?,
    )
}
fn decode(value: Option<JsonValue>) -> Result<Preference, Error> {
    let Some(value) = value else {
        return Ok(Preference {
            enabled: false,
            revision: 0,
        });
    };
    let JsonValue::Object(value) = value else {
        return Err(Error::Unavailable);
    };
    let (Some(JsonValue::Bool(enabled)), Some(JsonValue::Number(revision))) =
        (value.get(&"enabled".into()), value.get(&"revision".into()))
    else {
        return Err(Error::Unavailable);
    };
    if !revision.is_finite()
        || *revision < 0.0
        || revision.fract() != 0.0
        || *revision > MAX_REVISION as f64
    {
        return Err(Error::Unavailable);
    }
    Ok(Preference {
        enabled: *enabled,
        revision: *revision as u64,
    })
}
fn store_error(error: Error) -> ycoding_store::Error {
    ycoding_store::Error::Domain {
        kind: match error {
            Error::Conflict => "dots_conflict",
            Error::InvalidInput => "dots_invalid",
            Error::Unavailable => "dots_unavailable",
        },
        message: "Native Session access is unavailable",
    }
}
fn map_store(error: ycoding_store::Error) -> Error {
    match error {
        ycoding_store::Error::Domain {
            kind: "dots_conflict",
            ..
        } => Error::Conflict,
        ycoding_store::Error::Domain {
            kind: "dots_invalid",
            ..
        } => Error::InvalidInput,
        _ => Error::Unavailable,
    }
}

pub use ycoding_schema::dots::Rejection;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationProblem {
    Configuration,
    Authentication,
    DotUnavailable,
    ThreadUnavailable,
    Connection,
    DurableUnavailable,
    Rejected,
    Malformed,
    Stale,
    Unsupported,
    InvalidAnswer,
}
impl ConversationProblem {
    fn guidance(self) -> &'static str {
        match self {
            Self::Configuration => {
                "Turn on Dots access with a ready ChatGPT profile to use your Dot's conversation."
            }
            Self::Authentication => {
                "The selected ChatGPT profile could not be used. Check its sign-in."
            }
            Self::DotUnavailable => "No single active Dot was found for this account.",
            Self::ThreadUnavailable => "This thread does not belong to your Dot.",
            Self::Connection => "Your Dot could not be reached. Try again.",
            Self::DurableUnavailable => {
                "The Dots conversation connection is not ready. Try again shortly."
            }
            Self::Rejected => "ChatGPT refused the request.",
            Self::Malformed => "ChatGPT returned a response that could not be read.",
            Self::Stale => {
                "This request was already answered or is no longer pending. Refresh the pending requests."
            }
            Self::Unsupported => "This request type cannot be answered from YCoding.",
            Self::InvalidAnswer => "The answer does not match this request.",
        }
    }
    fn code(self) -> ConversationErrorCode {
        match self {
            Self::Stale => ConversationErrorCode::Conflict,
            Self::Unsupported | Self::InvalidAnswer => ConversationErrorCode::InvalidInput,
            _ => ConversationErrorCode::Unavailable,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct UpstreamRejection {
    pub code: Option<f64>,
    pub error_code: Option<String>,
    pub error_type: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ConversationResult<T> {
    Ok(T),
    Failed {
        problem: ConversationProblem,
        rejection: Option<UpstreamRejection>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationErrorCode {
    Unavailable,
    InvalidInput,
    Conflict,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConversationError {
    pub code: ConversationErrorCode,
    pub message: &'static str,
    pub rejection: Option<Box<Rejection>>,
}

impl<T> ConversationResult<T> {
    pub fn into_result(self) -> Result<T, ConversationError> {
        match self {
            Self::Ok(value) => Ok(value),
            Self::Failed { problem, rejection } => Err(ConversationError {
                code: problem.code(),
                message: problem.guidance(),
                rejection: rejection
                    .filter(|_| problem == ConversationProblem::Rejected)
                    .and_then(|rejection| cleaned(&rejection))
                    .map(Box::new),
            }),
        }
    }
}

fn cleaned(upstream: &UpstreamRejection) -> Option<Rejection> {
    let rejection = Rejection {
        code: upstream
            .code
            .filter(|code| code.fract() == 0.0 && code.abs() <= MAX_REVISION as f64)
            .and_then(|code| ycoding_schema::schema::Int::new(code as i64).ok()),
        error_code: display(upstream.error_code.as_deref(), 128).map(RejectionLabel),
        error_type: display(upstream.error_type.as_deref(), 128).map(RejectionLabel),
        message: display(upstream.message.as_deref(), 1000).map(RejectionMessage),
    };
    (rejection.code.is_some()
        || rejection.error_code.is_some()
        || rejection.error_type.is_some()
        || rejection.message.is_some())
    .then_some(rejection)
}
