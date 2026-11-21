use super::{
    access::{
        ComputerAttach, ComputerDetach, ComputerProblem, ComputerRemove, ComputerState,
        ComputerStatus, ComputerTarget, DotEnvironment, Readiness, display_lossless, trim_units,
    },
    native,
};
use ring::digest;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::sync::watch;
use ycoding_schema::{JsonObject, JsonValue, LosslessString, parse_json};

pub const BASE_URL: &str = "https://chatgpt.com/backend-api";
pub const REGISTRY_BASE_URL: &str = "https://codex-cloud-environments.chatgpt.com/api";
pub const CACHE_MS: u64 = 15_000;
pub const OBSERVE_MS: u64 = 20_000;
pub const CONNECT_MS: u64 = 15_000;
pub const REQUEST_MS: u64 = 15_000;
pub const SUPPLEMENT_MS: u64 = 5_000;
const MAX_CAPABILITIES: usize = 16;
const PAGE_LIMIT: usize = 25;
const MAX_PAGES: usize = 40;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Method {
    Get,
    Post,
    Delete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Base {
    Backend,
    Registry,
}

pub struct Request {
    pub method: Method,
    pub base: Base,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub credential: Arc<native::ResolvedCredential>,
    pub timeout: Duration,
}

pub struct Response {
    pub status: u16,
    pub body: String,
}

pub type Dispatch = Arc<dyn Fn(Request) -> native::NativeFuture<'static, Response> + Send + Sync>;

pub struct Settings {
    pub host: native::Host,
    pub state_path: PathBuf,
    pub dispatch: Dispatch,
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub observe: Duration,
    pub connect: Duration,
    pub supplement: Duration,
    pub diagnostic: Arc<dyn Fn(&str) + Send + Sync>,
}
impl Settings {
    pub fn production(host: native::Host, state_path: PathBuf) -> Self {
        Self {
            host,
            state_path,
            dispatch: Arc::new(dispatch),
            now: Arc::new(|| chrono::Utc::now().timestamp_millis().max(0) as u64),
            observe: Duration::from_millis(OBSERVE_MS),
            connect: Duration::from_millis(CONNECT_MS),
            supplement: Duration::from_millis(SUPPLEMENT_MS),
            diagnostic: Arc::new(|message| tracing::warn!("{message}")),
        }
    }
}

pub fn dispatch(request: Request) -> native::NativeFuture<'static, Response> {
    Box::pin(async move {
        let base = match request.base {
            Base::Backend => BASE_URL,
            Base::Registry => REGISTRY_BASE_URL,
        };
        let mut url = url::Url::parse(&format!("{base}{}", request.path))
            .map_err(|_| super::access::Error::Unavailable)?;
        if !request.query.is_empty() {
            url.query_pairs_mut().extend_pairs(request.query.iter());
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(request.timeout)
            .build()
            .map_err(|_| super::access::Error::Unavailable)?;
        let mut builder = match request.method {
            Method::Get => client.get(url),
            Method::Post => client.post(url),
            Method::Delete => client.delete(url),
        }
        .bearer_auth(&request.credential.access_token)
        .header("chatgpt-account-id", &request.credential.account_id)
        .header(reqwest::header::CONTENT_TYPE, "application/json");
        for (name, value) in super::enrollment::cca_headers::headers() {
            builder = builder.header(name, value);
        }
        let response = builder
            .send()
            .await
            .map_err(|_| super::access::Error::Unavailable)?;
        if response.status().is_redirection() {
            return Err(super::access::Error::Unavailable);
        }
        let status = response.status().as_u16();
        if request.method != Method::Get {
            return Ok(Response {
                status,
                body: String::new(),
            });
        }
        let body = response
            .text()
            .await
            .map_err(|_| super::access::Error::Unavailable)?;
        Ok(Response { status, body })
    })
}

#[derive(Clone)]
struct Binding {
    key: String,
    credential: Arc<native::ResolvedCredential>,
    environment_id: LosslessString,
}
#[derive(Clone)]
struct Target {
    credential: Arc<native::ResolvedCredential>,
    dot_id: LosslessString,
    thread_id: LosslessString,
    environment_id: LosslessString,
}
struct Observation {
    status: ComputerStatus,
    target: Option<Target>,
    disconnect: Option<Target>,
    delete: Option<Target>,
}
impl Observation {
    fn only(status: ComputerStatus) -> Self {
        Self {
            status,
            target: None,
            disconnect: None,
            delete: None,
        }
    }
}
#[derive(Default)]
struct Supplements {
    readiness: Option<Readiness>,
    usable_for_tasks: Option<bool>,
    dot_environment: Option<DotEnvironment>,
}
enum Operation {
    Attach(ComputerAttach),
    Detach(ComputerDetach),
    Remove(ComputerRemove),
}
struct Enrolled {
    executor_id: LosslessString,
    installation_id: LosslessString,
    account_hash: String,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Outcome {
    Accepted,
    Rejected,
    Uncertain,
}

type Flight = watch::Receiver<Option<ComputerStatus>>;
struct Cache {
    key: String,
    at: u64,
    status: ComputerStatus,
}
struct Refresh {
    id: u64,
    key: String,
    generation: u64,
    flight: Flight,
}
#[derive(Default)]
struct State {
    generation: u64,
    cache: Option<Cache>,
    latest_key: Option<String>,
    refreshing: Option<Refresh>,
    changing: BTreeMap<String, Flight>,
    next: u64,
}
struct Inner {
    settings: Settings,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct Control(Arc<Inner>);

fn unavailable(problem: ComputerProblem) -> ComputerStatus {
    ComputerStatus::new(ComputerState::Unavailable, Some(problem))
}

fn sha256_hex(text: &str) -> String {
    digest::digest(&digest::SHA256, text.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn js_string(value: &LosslessString) -> String {
    let units = value.code_units().collect::<Vec<_>>();
    let mut quoted = String::with_capacity(units.len() + 2);
    quoted.push('"');
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        index += 1;
        match unit {
            0x22 => quoted.push_str("\\\""),
            0x5c => quoted.push_str("\\\\"),
            0x8 => quoted.push_str("\\b"),
            0xc => quoted.push_str("\\f"),
            0xa => quoted.push_str("\\n"),
            0xd => quoted.push_str("\\r"),
            0x9 => quoted.push_str("\\t"),
            0x0..=0x1f => quoted.push_str(&format!("\\u{unit:04x}")),
            0xd800..=0xdbff
                if units
                    .get(index)
                    .is_some_and(|next| (0xdc00..=0xdfff).contains(next)) =>
            {
                let low = units[index];
                index += 1;
                let point =
                    0x10000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(low) - 0xdc00);
                quoted.extend(char::from_u32(point));
            }
            0xd800..=0xdfff => quoted.push_str(&format!("\\u{unit:04x}")),
            unit => quoted.extend(char::from_u32(u32::from(unit))),
        }
    }
    quoted.push('"');
    quoted
}

#[allow(clippy::too_many_arguments)]
pub fn owner_key(
    access_revision: u64,
    profile: &str,
    credential_id: &str,
    account_id: &str,
    account_generation: i64,
    executor_id: &LosslessString,
    installation_id: &LosslessString,
    account_hash: &str,
    status: &str,
) -> String {
    let text = |value: &str| js_string(&LosslessString::from(value));
    format!(
        "[{{\"enabled\":true,\"accessRevision\":{access_revision},\"profile\":{},\"credentialID\":{},\"accountID\":{},\"accountGeneration\":{account_generation}}},{{\"executorID\":{},\"installationID\":{},\"accountHash\":{},\"status\":{}}}]",
        text(profile),
        text(credential_id),
        text(account_id),
        js_string(executor_id),
        js_string(installation_id),
        text(account_hash),
        text(status),
    )
}

pub fn receipt_revision(
    owner_key: &str,
    dot_id: &LosslessString,
    thread_id: &LosslessString,
    environment_id: &LosslessString,
) -> String {
    sha256_hex(&format!(
        "[{},{{\"dotID\":{},\"threadID\":{},\"environmentID\":{}}}]",
        js_string(&LosslessString::from(owner_key)),
        js_string(dot_id),
        js_string(thread_id),
        js_string(environment_id),
    ))
}

fn field<'a>(object: &'a JsonObject, name: &str) -> Option<&'a JsonValue> {
    object.get(&name.into())
}

fn record(value: Option<&JsonValue>) -> Result<&JsonObject, ComputerProblem> {
    match value {
        Some(JsonValue::Object(object)) => Ok(object),
        _ => Err(ComputerProblem::Connection),
    }
}

fn identity(value: Option<&JsonValue>) -> Result<LosslessString, ComputerProblem> {
    match value {
        Some(JsonValue::String(value)) if !value.is_empty() => Ok(value.clone()),
        _ => Err(ComputerProblem::Connection),
    }
}

fn encode_component(value: &LosslessString) -> Result<String, ComputerProblem> {
    let text = value.to_utf8().map_err(|_| ComputerProblem::Connection)?;
    let mut encoded = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(encoded)
}

fn query_value(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}

async fn wait(mut flight: Flight) -> ComputerStatus {
    loop {
        let current = flight.borrow_and_update().clone();
        if let Some(status) = current {
            return status;
        }
        if flight.changed().await.is_err() {
            let last = flight.borrow().clone();
            return last.unwrap_or_else(ComputerStatus::failure);
        }
    }
}

impl Control {
    pub fn new(settings: Settings) -> Self {
        Self(Arc::new(Inner {
            settings,
            state: Mutex::default(),
        }))
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn now(&self) -> u64 {
        (self.0.settings.now)()
    }

    fn enabled(&self) -> Option<native::Configuration> {
        self.0
            .settings
            .host
            .configuration()
            .ok()
            .filter(|configuration| matches!(configuration, native::Configuration::Enabled { .. }))
    }

    async fn enrollment(&self, account_id: &str) -> Result<Enrolled, ComputerProblem> {
        let content = tokio::fs::read_to_string(&self.0.settings.state_path)
            .await
            .map_err(|_| ComputerProblem::Enrollment)?;
        let Ok(JsonValue::Object(state)) = parse_json(&content) else {
            return Err(ComputerProblem::Enrollment);
        };
        let string = |name: &str| match field(&state, name) {
            Some(JsonValue::String(value)) => Some(value.clone()),
            _ => None,
        };
        let (Some(installation_id), Some(status)) = (string("installationID"), string("status"))
        else {
            return Err(ComputerProblem::Enrollment);
        };
        let executor_id = string("executorID")
            .map(|value| {
                let units = value.code_units().collect::<Vec<_>>();
                LosslessString::from_utf16(trim_units(&units).to_vec())
            })
            .filter(|value| !value.is_empty());
        let account_hash = string("accountHash");
        match (executor_id, account_hash) {
            (Some(executor_id), Some(account_hash))
                if status == LosslessString::from("completed")
                    && account_hash == LosslessString::from(sha256_hex(account_id))
                    && !installation_id.is_empty() =>
            {
                Ok(Enrolled {
                    executor_id,
                    installation_id,
                    account_hash: sha256_hex(account_id),
                })
            }
            _ => Err(ComputerProblem::Enrollment),
        }
    }

    async fn binding(&self) -> Result<Binding, ComputerProblem> {
        let current = self.enabled().ok_or(ComputerProblem::Configuration)?;
        let native::Configuration::Enabled {
            access_revision,
            profile,
            credential_id,
            account_id,
            account_generation,
        } = &current
        else {
            return Err(ComputerProblem::Configuration);
        };
        let resolved = self
            .0
            .settings
            .host
            .credential(profile, None)
            .await
            .ok()
            .flatten()
            .filter(|resolved| {
                &resolved.account_id == account_id
                    && &resolved.credential_id == credential_id
                    && &resolved.account_generation == account_generation
            })
            .ok_or(ComputerProblem::Authentication)?;
        let enrolled = self.enrollment(&resolved.account_id).await?;
        if self.enabled().as_ref() != Some(&current) {
            return Err(ComputerProblem::Configuration);
        }
        let key = owner_key(
            *access_revision,
            profile,
            credential_id,
            account_id,
            *account_generation,
            &enrolled.executor_id,
            &enrolled.installation_id,
            &enrolled.account_hash,
            "completed",
        );
        Ok(Binding {
            key,
            credential: Arc::new(resolved),
            environment_id: enrolled.executor_id,
        })
    }

    async fn validate(&self, owner: &Binding) -> Result<Binding, ComputerProblem> {
        let latest = self.binding().await?;
        if latest.key != owner.key {
            return Err(ComputerProblem::TargetChanged);
        }
        Ok(latest)
    }

    fn receipt(owner: &Binding, target: &Target) -> ComputerTarget {
        ComputerTarget {
            dot_id: target.dot_id.clone(),
            thread_id: target.thread_id.clone(),
            environment_id: target.environment_id.clone(),
            revision: receipt_revision(
                &owner.key,
                &target.dot_id,
                &target.thread_id,
                &target.environment_id,
            ),
        }
    }

    async fn get(
        &self,
        path: String,
        query: Vec<(String, String)>,
        credential: &Arc<native::ResolvedCredential>,
    ) -> Result<JsonObject, ComputerProblem> {
        self.get_from(Base::Backend, path, query, credential).await
    }

    async fn get_from(
        &self,
        base: Base,
        path: String,
        query: Vec<(String, String)>,
        credential: &Arc<native::ResolvedCredential>,
    ) -> Result<JsonObject, ComputerProblem> {
        let response = (self.0.settings.dispatch)(Request {
            method: Method::Get,
            base,
            path,
            query,
            credential: credential.clone(),
            timeout: Duration::from_millis(REQUEST_MS),
        })
        .await
        .map_err(|_| ComputerProblem::Connection)?;
        if response.status == 401 || response.status == 403 {
            return Err(ComputerProblem::Authentication);
        }
        if !(200..300).contains(&response.status) {
            return Err(ComputerProblem::Connection);
        }
        match parse_json(&response.body) {
            Ok(JsonValue::Object(object)) => Ok(object),
            _ => Err(ComputerProblem::Connection),
        }
    }

    async fn dot(
        &self,
        credential: &Arc<native::ResolvedCredential>,
    ) -> Result<LosslessString, ComputerProblem> {
        let mut active = Vec::<LosslessString>::new();
        let mut cursors = BTreeSet::<LosslessString>::new();
        let mut cursor = None::<LosslessString>;
        for _ in 0..MAX_PAGES {
            let mut query = Vec::new();
            if let Some(cursor) = &cursor {
                query.push(("cursor".to_owned(), query_value(cursor)));
            }
            query.push(("limit".to_owned(), PAGE_LIMIT.to_string()));
            query.push(("include_room_preview".to_owned(), "false".to_owned()));
            let body = self.get("/tbo".into(), query, credential).await?;
            let Some(JsonValue::Array(items)) = field(&body, "items") else {
                return Err(ComputerProblem::Connection);
            };
            for item in items {
                let fields = record(Some(item))?;
                if matches!(field(fields, "status"), Some(JsonValue::String(status)) if status.as_str() == Some("active"))
                {
                    active.push(identity(field(fields, "id"))?);
                }
            }
            match field(&body, "cursor") {
                None | Some(JsonValue::Null) => {
                    if active.len() == 1 {
                        return Ok(active.remove(0));
                    }
                    if active.is_empty() {
                        return Err(ComputerProblem::DotUnavailable);
                    }
                    let primary = self
                        .get("/tbo/primary".into(), Vec::new(), credential)
                        .await?;
                    let id = match field(&primary, "profile") {
                        None | Some(JsonValue::Null) => None,
                        profile => Some(identity(field(record(profile)?, "id"))?),
                    };
                    return match id {
                        Some(id) if active.contains(&id) => Ok(id),
                        _ => Err(ComputerProblem::DotUnavailable),
                    };
                }
                next => {
                    let next = identity(next)?;
                    if !cursors.insert(next.clone()) {
                        return Err(ComputerProblem::Connection);
                    }
                    cursor = Some(next);
                }
            }
        }
        Err(ComputerProblem::Connection)
    }

    async fn read(&self, owner: &Binding) -> Result<Observation, ComputerProblem> {
        let credential = &owner.credential;
        let environment_id = &owner.environment_id;
        let dot_id = self.dot(credential).await?;
        let root = self
            .get(
                format!("/tbo/{}/root-thread", encode_component(&dot_id)?),
                Vec::new(),
                credential,
            )
            .await?;
        let thread_id = match field(&root, "root_thread_id") {
            None | Some(JsonValue::Null) => return Err(ComputerProblem::DotUnavailable),
            value => identity(value)?,
        };
        let list = self
            .get(
                format!("/tbo/{}/computers", encode_component(&dot_id)?),
                vec![("expected_thread_id".into(), query_value(&thread_id))],
                credential,
            )
            .await?;
        let Some(JsonValue::String(listed)) = field(&list, "thread_id") else {
            return Err(ComputerProblem::Connection);
        };
        if *listed != thread_id {
            return Err(ComputerProblem::DotUnavailable);
        }
        let Some(JsonValue::Array(computers)) = field(&list, "computers") else {
            return Err(ComputerProblem::Connection);
        };
        let rows = computers
            .iter()
            .map(|value| record(Some(value)))
            .collect::<Result<Vec<_>, _>>()?;
        let row = rows.into_iter().find(|row| {
            matches!(field(row, "environment_id"), Some(JsonValue::String(value)) if value == environment_id)
        });
        let target = Target {
            credential: credential.clone(),
            dot_id,
            thread_id,
            environment_id: environment_id.clone(),
        };
        let extra = match row {
            Some(row) => self.supplements(owner, &target, row).await,
            None => Supplements::default(),
        };
        self.validate(owner).await?;
        let Some(row) = row else {
            return Ok(Observation::only(unavailable(ComputerProblem::NotListed)));
        };
        let name = match field(row, "display_name") {
            Some(JsonValue::String(value)) => display_lossless(value, 256),
            _ => None,
        };
        let status = |state, problem| ComputerStatus {
            state,
            problem,
            name: name.clone(),
            target: Some(Self::receipt(owner, &target)),
            readiness: extra.readiness,
            usable_for_tasks: extra.usable_for_tasks,
            dot_environment: extra.dot_environment.clone(),
        };
        let flag = |name: &str| matches!(field(row, name), Some(JsonValue::Bool(true)));
        let delete = flag("can_delete").then(|| target.clone());
        let observed = |status, target, disconnect| Observation {
            status,
            target,
            disconnect,
            delete: delete.clone(),
        };
        if flag("is_attached") {
            if !flag("can_disconnect") {
                return Ok(observed(
                    status(
                        ComputerState::Attached,
                        Some(ComputerProblem::NotDisconnectable),
                    ),
                    None,
                    None,
                ));
            }
            return Ok(observed(
                status(ComputerState::Attached, None),
                None,
                Some(target.clone()),
            ));
        }
        if matches!(
            field(&list, "local_computer_access_disabled_by_admin"),
            Some(JsonValue::Bool(true))
        ) {
            return Ok(observed(
                status(
                    ComputerState::Detached,
                    Some(ComputerProblem::AdminDisabled),
                ),
                None,
                None,
            ));
        }
        if !flag("can_connect") {
            return Ok(observed(
                status(
                    ComputerState::Detached,
                    Some(ComputerProblem::NotConnectable),
                ),
                None,
                None,
            ));
        }
        Ok(observed(
            status(ComputerState::Detached, None),
            Some(target.clone()),
            None,
        ))
    }

    async fn supplements(&self, owner: &Binding, target: &Target, row: &JsonObject) -> Supplements {
        let bound = self.0.settings.supplement;
        let (readiness, environment) = tokio::join!(
            tokio::time::timeout(bound, self.readiness(owner)),
            tokio::time::timeout(bound, self.dot_environment(target)),
        );
        Supplements {
            readiness: readiness.ok().flatten(),
            usable_for_tasks: match field(row, "can_use_for_tasks") {
                Some(JsonValue::Bool(value)) => Some(*value),
                _ => None,
            },
            dot_environment: environment.ok().flatten(),
        }
    }

    async fn readiness(&self, owner: &Binding) -> Option<Readiness> {
        let body = self
            .get_from(
                Base::Registry,
                format!(
                    "/cloud/environment/{}/status",
                    encode_component(&owner.environment_id).ok()?
                ),
                Vec::new(),
                &owner.credential,
            )
            .await
            .ok()?;
        let Some(JsonValue::String(named)) = field(&body, "environment_id") else {
            return None;
        };
        if *named != owner.environment_id {
            return None;
        }
        let Some(JsonValue::String(status)) = field(&body, "status") else {
            return None;
        };
        match status.as_str() {
            Some("connected") => Some(Readiness::Connected),
            Some("offline") => Some(Readiness::Offline),
            Some("unknown") => Some(Readiness::Unknown),
            _ => None,
        }
    }

    async fn dot_environment(&self, target: &Target) -> Option<DotEnvironment> {
        let body = self
            .get(
                format!(
                    "/tbo/{}/environment/status",
                    encode_component(&target.dot_id).ok()?
                ),
                vec![("thread_id".into(), query_value(&target.thread_id))],
                &target.credential,
            )
            .await
            .ok()?;
        if !matches!(
            field(&body, "environmentId"),
            None | Some(JsonValue::Null | JsonValue::String(_))
        ) {
            return None;
        }
        let status = identifier(field(&body, "status")?)?;
        let Some(JsonValue::Array(items)) = field(&body, "capabilities") else {
            return None;
        };
        if items.len() > MAX_CAPABILITIES {
            return None;
        }
        let mut capabilities = Vec::new();
        for item in items {
            let JsonValue::Object(item) = item else {
                return None;
            };
            capabilities.push((
                identifier(field(item, "type")?)?,
                identifier(field(item, "status")?)?,
            ));
        }
        Some(DotEnvironment {
            status,
            capabilities,
        })
    }

    async fn observe(&self, owner: &Binding) -> Observation {
        match tokio::time::timeout(self.0.settings.observe, self.read(owner)).await {
            Ok(Ok(observation)) => observation,
            Ok(Err(problem)) => Observation::only(unavailable(problem)),
            Err(_) => Observation::only(unavailable(ComputerProblem::Connection)),
        }
    }

    async fn dispatch_change(
        &self,
        method: Method,
        path: String,
        query: Vec<(String, String)>,
        credential: Arc<native::ResolvedCredential>,
    ) -> Outcome {
        let request = Request {
            method,
            base: Base::Backend,
            path,
            query,
            credential,
            timeout: self.0.settings.connect,
        };
        let response =
            tokio::time::timeout(self.0.settings.connect, (self.0.settings.dispatch)(request))
                .await;
        match response {
            Ok(Ok(response)) if (200..300).contains(&response.status) => Outcome::Accepted,
            Ok(Ok(response))
                if response.status == 408 || response.status == 429 || response.status >= 500 =>
            {
                Outcome::Uncertain
            }
            Ok(Ok(_)) => Outcome::Rejected,
            Ok(Err(_)) | Err(_) => Outcome::Uncertain,
        }
    }

    async fn connect(
        &self,
        target: Target,
        replace_others: bool,
    ) -> Result<Outcome, ComputerProblem> {
        let grant = if replace_others {
            "connect-and-replace"
        } else {
            "connect"
        };
        Ok(self
            .dispatch_change(
                Method::Post,
                format!(
                    "/tbo/{}/computers/{}/{grant}",
                    encode_component(&target.dot_id)?,
                    encode_component(&target.environment_id)?
                ),
                vec![("expected_thread_id".into(), query_value(&target.thread_id))],
                target.credential.clone(),
            )
            .await)
    }

    async fn disconnect(&self, target: Target) -> Result<Outcome, ComputerProblem> {
        Ok(self
            .dispatch_change(
                Method::Post,
                format!(
                    "/tbo/{}/computers/{}/disconnect",
                    encode_component(&target.dot_id)?,
                    encode_component(&target.environment_id)?
                ),
                vec![("expected_thread_id".into(), query_value(&target.thread_id))],
                target.credential.clone(),
            )
            .await)
    }

    async fn destroy(&self, target: Target) -> Result<Outcome, ComputerProblem> {
        Ok(self
            .dispatch_change(
                Method::Delete,
                format!("/computers/{}", encode_component(&target.environment_id)?),
                Vec::new(),
                target.credential.clone(),
            )
            .await)
    }

    fn store(&self, key: &str, status: ComputerStatus) -> ComputerStatus {
        let now = self.now();
        let mut state = self.lock();
        if state.latest_key.as_deref() != Some(key) {
            return status;
        }
        if status.problem == Some(ComputerProblem::Connection)
            && let Some(cache) = state.cache.as_mut()
            && cache.key == key
        {
            cache.at = now;
            let held = cache.status.clone();
            drop(state);
            (self.0.settings.diagnostic)("CCA computer refresh-failed problem=connection");
            return held;
        }
        state.cache = Some(Cache {
            key: key.to_owned(),
            at: now,
            status: status.clone(),
        });
        status
    }

    async fn refresh(&self, owner: Binding, key: String) -> ComputerStatus {
        let (flight, spawned) = {
            let mut state = self.lock();
            let joined = state
                .refreshing
                .as_ref()
                .filter(|refresh| refresh.key == key && refresh.generation == state.generation)
                .map(|refresh| refresh.flight.clone());
            match joined {
                Some(flight) => (flight, None),
                None => {
                    let started = state.generation;
                    state.next += 1;
                    let id = state.next;
                    let (sender, receiver) = watch::channel(None);
                    state.refreshing = Some(Refresh {
                        id,
                        key: key.clone(),
                        generation: started,
                        flight: receiver.clone(),
                    });
                    (receiver, Some((id, started, sender)))
                }
            }
        };
        if let Some((id, started, sender)) = spawned {
            let this = self.clone();
            tokio::spawn(async move {
                let observation = this.observe(&owner).await;
                let current = this.lock().generation;
                let status = if started == current {
                    this.store(&key, observation.status)
                } else {
                    observation.status
                };
                sender.send_replace(Some(status));
                let mut state = this.lock();
                if state
                    .refreshing
                    .as_ref()
                    .is_some_and(|refresh| refresh.id == id)
                {
                    state.refreshing = None;
                }
            });
        }
        wait(flight).await
    }

    pub async fn computer(&self) -> ComputerStatus {
        let current = match self.binding().await {
            Ok(current) => current,
            Err(problem) => {
                self.lock().cache = None;
                return unavailable(problem);
            }
        };
        let key = current.key.clone();
        let cached = {
            let mut state = self.lock();
            state.latest_key = Some(key.clone());
            if state.cache.as_ref().is_some_and(|cache| cache.key != key) {
                state.cache = None;
            }
            state
                .cache
                .as_ref()
                .map(|cache| (cache.at, cache.status.clone()))
        };
        match cached {
            None => self.refresh(current, key).await,
            Some((at, status)) => {
                if self.now().saturating_sub(at) >= CACHE_MS {
                    let this = self.clone();
                    tokio::spawn(async move {
                        this.refresh(current, key).await;
                    });
                }
                status
            }
        }
    }

    async fn reconcile(
        &self,
        owner: &Binding,
        before: &ComputerStatus,
        outcome: Outcome,
        goal: ComputerState,
    ) -> ComputerStatus {
        let problem = if outcome == Outcome::Rejected {
            ComputerProblem::Rejected
        } else {
            ComputerProblem::Unconfirmed
        };
        let Ok(current) = self.validate(owner).await else {
            return unavailable(problem);
        };
        let after = self.observe(&current).await;
        if after.status.target != before.target || after.status.state == ComputerState::Unavailable
        {
            return unavailable(problem);
        }
        if after.status.state == goal {
            return after.status;
        }
        ComputerStatus {
            problem: Some(problem),
            ..after.status
        }
    }

    fn begin(&self, owner: &Binding) {
        let mut state = self.lock();
        state.latest_key = Some(owner.key.clone());
        state.generation += 1;
    }

    fn settle(&self, owner: &Binding, status: &ComputerStatus) {
        self.lock().generation += 1;
        self.store(&owner.key, status.clone());
    }

    async fn attach_once(
        &self,
        owner: &Binding,
        input: ComputerAttach,
    ) -> Result<ComputerStatus, ComputerProblem> {
        let ComputerAttach {
            replace_others,
            expected_target: expected,
        } = input;
        self.begin(owner);
        let before = self.observe(owner).await;
        if let Some(expected) = &expected
            && before.status.target.as_ref() != Some(expected)
        {
            return Ok(unavailable(ComputerProblem::TargetChanged));
        }
        let Some(target) = before.target else {
            self.settle(owner, &before.status);
            return Ok(before.status);
        };
        let current = self.validate(owner).await?;
        let outcome = self
            .connect(
                Target {
                    credential: current.credential.clone(),
                    ..target
                },
                replace_others,
            )
            .await?;
        let result = self
            .reconcile(owner, &before.status, outcome, ComputerState::Attached)
            .await;
        self.settle(owner, &result);
        Ok(result)
    }

    async fn detach_once(
        &self,
        owner: &Binding,
        input: ComputerDetach,
    ) -> Result<ComputerStatus, ComputerProblem> {
        self.begin(owner);
        let before = self.observe(owner).await;
        if let Some(expected) = &input.expected_target
            && before.status.target.as_ref() != Some(expected)
        {
            return Ok(unavailable(ComputerProblem::TargetChanged));
        }
        let Some(target) = before.disconnect else {
            self.settle(owner, &before.status);
            return Ok(before.status);
        };
        let current = self.validate(owner).await?;
        let outcome = self
            .disconnect(Target {
                credential: current.credential.clone(),
                ..target
            })
            .await?;
        let result = self
            .reconcile(owner, &before.status, outcome, ComputerState::Detached)
            .await;
        self.settle(owner, &result);
        Ok(result)
    }

    async fn remove_once(
        &self,
        owner: &Binding,
        input: ComputerRemove,
    ) -> Result<ComputerStatus, ComputerProblem> {
        self.begin(owner);
        let before = self.observe(owner).await;
        if let Some(expected) = &input.expected_target
            && before.status.target.as_ref() != Some(expected)
        {
            return Ok(unavailable(ComputerProblem::TargetChanged));
        }
        if before.status.state == ComputerState::Unavailable {
            self.settle(owner, &before.status);
            return Ok(before.status);
        }
        let Some(target) = before.delete else {
            return Ok(ComputerStatus {
                problem: Some(ComputerProblem::NotDeletable),
                ..before.status
            });
        };
        let current = self.validate(owner).await?;
        let outcome = self
            .destroy(Target {
                credential: current.credential.clone(),
                ..target
            })
            .await?;
        self.lock().generation += 1;
        let problem = if outcome == Outcome::Rejected {
            ComputerProblem::Rejected
        } else {
            ComputerProblem::Unconfirmed
        };
        let Ok(current) = self.validate(owner).await else {
            return Ok(unavailable(problem));
        };
        let after = self.observe(&current).await;
        if after.status.problem == Some(ComputerProblem::NotListed) {
            if self.mark_removed(&owner.environment_id).await.is_err() {
                (self.0.settings.diagnostic)("CCA computer removal-state-unrecorded");
            }
            self.lock().cache = None;
            return Ok(ComputerStatus::new(ComputerState::Removed, None));
        }
        if after.status.target != before.status.target
            || after.status.state == ComputerState::Unavailable
        {
            return Ok(unavailable(problem));
        }
        Ok(ComputerStatus {
            problem: Some(problem),
            ..after.status
        })
    }

    async fn mark_removed(&self, environment_id: &LosslessString) -> Result<(), ()> {
        let path = &self.0.settings.state_path;
        let content = tokio::fs::read_to_string(path).await.map_err(|_| ())?;
        let Ok(JsonValue::Object(state)) = parse_json(&content) else {
            return Err(());
        };
        let text = |name: &str| match field(&state, name) {
            Some(JsonValue::String(value)) => Some(value.clone()),
            _ => None,
        };
        let executor = text("executorID").map(|value| {
            LosslessString::from_utf16(trim_units(&value.code_units().collect::<Vec<_>>()).to_vec())
        });
        if text("status") != Some("completed".into()) || executor.as_ref() != Some(environment_id) {
            return Err(());
        }
        let updated = super::enrollment::instant_iso(self.now() as i64).ok_or(())?;
        let mut removed = ycoding_schema::ObjectEncoder::new()
            .field("installationID", &text("installationID").ok_or(())?)
            .field("accountHash", &text("accountHash").ok_or(())?)
            .field("status", "removed");
        if let Some(created) = text("createdAt") {
            removed = removed.field("createdAt", &created);
        }
        let encoded =
            ycoding_schema::stringify_json(&removed.field("updatedAt", updated.as_str()).finish());
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let temporary = path.with_extension(format!(
            "{}.{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let written = async {
            use tokio::io::AsyncWriteExt;
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&temporary).await?;
            file.write_all(encoded.as_bytes()).await?;
            file.sync_all().await?;
            tokio::fs::rename(&temporary, path).await
        }
        .await;
        if written.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
        }
        written.map_err(|_| ())
    }

    async fn run(
        &self,
        owner: &Binding,
        operation: Operation,
    ) -> Result<ComputerStatus, ComputerProblem> {
        match operation {
            Operation::Attach(input) => self.attach_once(owner, input).await,
            Operation::Detach(input) => self.detach_once(owner, input).await,
            Operation::Remove(input) => self.remove_once(owner, input).await,
        }
    }

    async fn change(&self, operation: Operation) -> ComputerStatus {
        let owner = match self.binding().await {
            Ok(owner) => owner,
            Err(problem) => return unavailable(problem),
        };
        let receipt = |expected: &Option<ComputerTarget>| match expected {
            None => "null".to_owned(),
            Some(target) => format!(
                "[{},{},{},{}]",
                js_string(&target.dot_id),
                js_string(&target.thread_id),
                js_string(&target.environment_id),
                js_string(&LosslessString::from(target.revision.as_str()))
            ),
        };
        let scope = match &operation {
            Operation::Attach(input) => format!(
                "attach:{},{}",
                input.replace_others,
                receipt(&input.expected_target)
            ),
            Operation::Detach(input) => format!("detach:{}", receipt(&input.expected_target)),
            Operation::Remove(input) => format!("remove:{}", receipt(&input.expected_target)),
        };
        let key = format!(
            "[{},{scope}]",
            js_string(&LosslessString::from(owner.key.as_str())),
        );
        let (flight, spawned) = {
            let mut state = self.lock();
            match state.changing.get(&key) {
                Some(flight) => (flight.clone(), None),
                None => {
                    let (sender, receiver) = watch::channel(None);
                    state.changing.insert(key.clone(), receiver.clone());
                    (receiver, Some(sender))
                }
            }
        };
        if let Some(sender) = spawned {
            let this = self.clone();
            tokio::spawn(async move {
                let status = this
                    .run(&owner, operation)
                    .await
                    .unwrap_or_else(unavailable);
                this.lock().changing.remove(&key);
                sender.send_replace(Some(status));
            });
        }
        wait(flight).await
    }

    pub async fn attach(&self, input: ComputerAttach) -> ComputerStatus {
        self.change(Operation::Attach(input)).await
    }

    pub async fn detach(&self, input: ComputerDetach) -> ComputerStatus {
        self.change(Operation::Detach(input)).await
    }

    pub async fn remove(&self, input: ComputerRemove) -> ComputerStatus {
        self.change(Operation::Remove(input)).await
    }
}

fn identifier(value: &JsonValue) -> Option<String> {
    let JsonValue::String(value) = value else {
        return None;
    };
    let text = value.to_utf8().ok()?;
    let mut bytes = text.bytes();
    let valid = text.len() <= 64
        && bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        });
    valid.then_some(text)
}
