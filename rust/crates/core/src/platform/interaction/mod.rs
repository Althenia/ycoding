pub mod boundary;
pub mod chrome;
#[cfg(test)]
mod consent_tests;
#[cfg(unix)]
pub mod isolated;
#[cfg(unix)]
mod isolated_pipe;
pub mod macos;
mod script;
mod validation;

use super::computer::Future;
pub use serde_json::Value;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    sync::{broadcast, watch},
    task::JoinHandle,
};
use url::Url;
pub use validation::{uuid, valid};
fn signal() -> watch::Receiver<bool> {
    static SIGNAL: std::sync::LazyLock<watch::Sender<bool>> =
        std::sync::LazyLock::new(|| watch::channel(false).0);
    SIGNAL.subscribe()
}

pub fn from_domain(value: &impl ycoding_schema::DomainEncode) -> Result<serde_json::Value, Error> {
    serde_json::from_str(&ycoding_schema::stringify_json(&value.encode()))
        .map_err(|_| Error("invalid"))
}
pub fn to_domain<T: ycoding_schema::DomainDecode>(value: &serde_json::Value) -> Result<T, Error> {
    let value = ycoding_schema::parse_json(&value.to_string()).map_err(|_| Error("invalid"))?;
    T::decode(&value).map_err(|_| Error("invalid"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Inventory,
    Attach,
    Observe,
    Perform,
    Preview,
    Resume,
    Run,
    Detach,
}
impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inventory => "inventory",
            Self::Attach => "attach",
            Self::Observe => "observe",
            Self::Perform => "perform",
            Self::Preview => "preview",
            Self::Resume => "resume",
            Self::Run => "run",
            Self::Detach => "detach",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Interaction {0}")]
pub struct Error(pub &'static str);
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentError(pub String);
impl From<Error> for ConsentError {
    fn from(error: Error) -> Self {
        Self(
            if error.0 == "cleanup" {
                "error"
            } else {
                error.0
            }
            .into(),
        )
    }
}

pub trait Driver: Send + Sync {
    fn platform(&self) -> &'static str;
    fn call(
        &self,
        operation: Operation,
        input: Value,
        cancel: watch::Receiver<bool>,
    ) -> Future<'_, Result<Value, Error>>;
}
pub type SessionCheck = Arc<dyn Fn(&str) -> bool + Send + Sync>;
pub type SessionLabel = Arc<dyn Fn(&str) -> Result<String, Error> + Send + Sync>;
pub type Changed = Arc<dyn Fn(&str, &str) + Send + Sync>;
pub type CaptureAdmission =
    Arc<dyn Fn(String, String, Value) -> Future<'static, Result<(), Error>> + Send + Sync>;
pub struct Options {
    pub usable: SessionCheck,
    pub label: SessionLabel,
    pub changed: Changed,
    pub timeout: Duration,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            usable: Arc::new(|_| true),
            label: Arc::new(|_| Ok(String::new())),
            changed: Arc::new(|_, _| {}),
            timeout: Duration::from_secs(10),
        }
    }
}
struct Candidate {
    request: Value,
    targets: HashMap<String, Value>,
    busy: bool,
    proof: Option<Value>,
}
struct Entry {
    key: String,
    driver: Arc<dyn Driver>,
    generation: String,
    status: Value,
    label: String,
    candidate: Option<Candidate>,
    target: Option<Value>,
    lease: Option<String>,
    revision: Option<u64>,
    last_revision: u64,
    busy: bool,
    previewing: bool,
    capturing: bool,
    calls: HashSet<String>,
    cancel: watch::Sender<bool>,
    timer: Option<JoinHandle<()>>,
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}
#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    drivers: HashMap<String, Arc<dyn Driver>>,
    targets: HashMap<(String, String), String>,
    closed: bool,
}
pub struct Authority {
    platforms: Mutex<Option<Platforms>>,
    state: Mutex<State>,
    options: Options,
    pending: broadcast::Sender<(String, Value)>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    capture: Mutex<Option<CaptureAdmission>>,
}
struct Platforms {
    macos: Option<Arc<macos::Adapter>>,
    #[cfg(unix)]
    isolated: Arc<isolated::Isolated>,
    profiles: std::path::PathBuf,
    chrome: Option<Arc<chrome::Transport>>,
}
struct Cleanup {
    session: String,
    generation: String,
    driver: Arc<dyn Driver>,
    lease: String,
    key: String,
    target: Option<String>,
    reason: &'static str,
}

impl Authority {
    pub fn new(options: Options) -> Arc<Self> {
        Arc::new(Self {
            platforms: Mutex::new(None),
            state: Mutex::new(State::default()),
            options,
            pending: broadcast::channel(128).0,
            tasks: Mutex::new(vec![]),
            capture: Mutex::new(None),
        })
    }
    pub async fn mount_platforms(
        self: &Arc<Self>,
        macos: Option<Arc<macos::Adapter>>,
        profiles: std::path::PathBuf,
    ) -> Result<(), Error> {
        if self
            .platforms
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
        {
            return Err(Error("busy"));
        }
        if let Some(macos) = &macos {
            macos.mount(self)?;
        }
        #[cfg(unix)]
        let isolated = {
            let isolated = isolated::Isolated::installed(macos.clone());
            if let Err(error) = isolated.mount(self) {
                if let Some(macos) = &macos {
                    macos.shutdown().await?;
                }
                return Err(error);
            }
            isolated
        };
        *self.platforms.lock().unwrap_or_else(|e| e.into_inner()) = Some(Platforms {
            macos,
            #[cfg(unix)]
            isolated,
            profiles,
            chrome: None,
        });
        Ok(())
    }
    pub fn bind_chrome(
        self: &Arc<Self>,
        origin: &str,
    ) -> Result<Option<Arc<chrome::Transport>>, Error> {
        let mut platforms = self.platforms.lock().unwrap_or_else(|e| e.into_inner());
        let Some(platforms) = platforms.as_mut() else {
            return Ok(None);
        };
        if let Some(chrome) = &platforms.chrome {
            return if chrome.origin() == origin {
                Ok(Some(chrome.clone()))
            } else {
                Err(Error("origin_changed"))
            };
        }
        let confirm = platforms.macos.as_ref().map_or_else(
            || {
                Arc::new(|_, _| {
                    Box::pin(async { false }) as crate::platform::computer::Future<'static, bool>
                }) as chrome::Confirm
            },
            |macos| macos.profile_confirmation(),
        );
        let chrome = chrome::Transport::new(self, origin, platforms.profiles.clone(), confirm)?;
        platforms.chrome = Some(chrome.clone());
        Ok(Some(chrome))
    }
    pub fn register(self: &Arc<Self>, key: &str, driver: Arc<dyn Driver>) -> Result<Native, Error> {
        if key != driver.platform() && !(key == "chrome-isolated" && driver.platform() == "chrome")
        {
            return Err(Error("unavailable"));
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return Err(Error("unavailable"));
        }
        if state.drivers.contains_key(key) {
            return Err(Error("busy"));
        }
        state.drivers.insert(key.into(), driver.clone());
        Ok(Native {
            authority: Arc::downgrade(self),
            key: key.into(),
            driver,
        })
    }
    pub fn usable(&self, session: &str) -> bool {
        (self.options.usable)(session)
    }
    pub fn status(&self, session: &str) -> Value {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .get(session)
            .map(|e| e.status.clone())
            .unwrap_or_else(|| json!({"state":"unavailable"}))
    }
    pub fn target(&self, session: &str, generation: &str) -> Option<Value> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let entry = state.entries.get(session)?;
        (entry.generation == generation
            && entry.status["state"] == "active"
            && !*entry.cancel.borrow())
        .then(|| entry.target.clone())
        .flatten()
    }
    pub fn request(self: &Arc<Self>, session: &str, mut selection: Value) -> Result<Value, Error> {
        if !valid("Request", &selection) {
            return Ok(json!({"state":"unavailable"}));
        }
        if let Some(raw) = selection["url"].as_str() {
            let parsed = Url::parse(raw).map_err(|_| Error("unavailable"))?;
            selection["url"] = json!(parsed.as_str());
        }
        let key = if selection["mode"] == "isolated" {
            "chrome-isolated"
        } else {
            selection["platform"].as_str().ok_or(Error("unavailable"))?
        }
        .to_owned();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prior) = state.entries.get(session)
            && (prior.status["state"] != "stopped" || prior.status["cleanup"] == "pending")
        {
            return Ok(prior.status.clone());
        }
        if state.closed || !state.drivers.contains_key(&key) {
            return Ok(json!({"state":"unavailable"}));
        }
        if !state.entries.contains_key(session) && state.entries.len() >= 128 {
            let terminal = state
                .entries
                .iter()
                .find(|(_, e)| e.status["state"] == "stopped" && e.status["cleanup"] != "pending")
                .map(|(s, _)| s.clone());
            let Some(terminal) = terminal else {
                return Ok(json!({"state":"unavailable"}));
            };
            state.entries.remove(&terminal);
        }
        let generation = uuid()?;
        let status =
            json!({"state":"pending","platform":selection["platform"],"generation":generation});
        let label = (self.options.label)(session);
        let request = json!({"candidateID":uuid()?,"sessionID":session,"sessionLabel":label.as_ref().map(|s|bounded_label(s)).unwrap_or_default(),"purpose":"attach","selection":selection,"expiresAt":now()+60000});
        let timer = self.expiry(session, &generation, Duration::from_secs(60));
        let driver = state.drivers[&key].clone();
        state.entries.insert(
            session.into(),
            Entry {
                key: key.clone(),
                driver,
                generation: generation.clone(),
                status: status.clone(),
                label: label.as_ref().map(|s| bounded_label(s)).unwrap_or_default(),
                candidate: Some(Candidate {
                    request: request.clone(),
                    targets: HashMap::new(),
                    busy: false,
                    proof: None,
                }),
                target: None,
                lease: None,
                revision: None,
                last_revision: 0,
                busy: false,
                previewing: false,
                capturing: false,
                calls: HashSet::new(),
                cancel: watch::channel(false).0,
                timer: Some(timer),
            },
        );
        drop(state);
        (self.options.changed)(session, &generation);
        if label.is_err() {
            self.revoke(session);
            return Ok(self.status(session));
        }
        let _ = self.pending.send((key, request));
        Ok(status)
    }
    fn expiry(
        self: &Arc<Self>,
        session: &str,
        generation: &str,
        delay: Duration,
    ) -> JoinHandle<()> {
        let weak = Arc::downgrade(self);
        let session = session.to_owned();
        let generation = generation.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Some(authority) = weak.upgrade() {
                authority.retire(&session, Some(&generation), "expired");
            }
        })
    }
    pub fn stop(self: &Arc<Self>, session: &str, generation: &str) -> bool {
        self.retire(session, Some(generation), "stopped")
    }
    pub fn revoke(self: &Arc<Self>, session: &str) {
        self.retire(session, None, "permission");
    }
    fn retire(
        self: &Arc<Self>,
        session: &str,
        generation: Option<&str>,
        reason: &'static str,
    ) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = state.entries.get_mut(session) else {
            return false;
        };
        if generation.is_some_and(|g| g != entry.generation) || entry.status["state"] == "stopped" {
            return false;
        }
        entry.status = json!({"state":"stopped","platform":entry.driver.platform(),"generation":entry.generation,"reason":reason,"cleanup":if entry.target.is_some(){"pending"}else{"complete"}});
        entry.cancel.send_replace(true);
        entry.revision = None;
        entry.candidate = None;
        if let Some(timer) = entry.timer.take() {
            timer.abort();
        }
        let generation = entry.generation.clone();
        let cleanup = entry.lease.as_ref().map(|lease| {
            (
                entry.driver.clone(),
                lease.clone(),
                entry.key.clone(),
                entry.target.as_ref().map(|t| text(t, "id").to_owned()),
            )
        });
        drop(state);
        (self.options.changed)(session, &generation);
        if let Some((driver, lease, key, target)) = cleanup {
            self.detach(Cleanup {
                session: session.to_owned(),
                generation,
                driver,
                lease,
                key,
                target,
                reason,
            });
        }
        true
    }
    fn detach(self: &Arc<Self>, cleanup: Cleanup) {
        let Cleanup {
            session,
            generation,
            driver,
            lease,
            key,
            target,
            reason,
        } = cleanup;
        let weak = Arc::downgrade(self);
        let timeout = self.options.timeout;
        let task = tokio::spawn(async move {
            let result = tokio::time::timeout(
                timeout,
                driver.call(
                    Operation::Detach,
                    json!({"id":lease,"reason":reason}),
                    signal(),
                ),
            )
            .await;
            if let Some(authority) = weak.upgrade() {
                let mut state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
                let complete = matches!(result, Ok(Ok(_)));
                if complete && let Some(target) = target {
                    state.targets.remove(&(key, target));
                }
                if let Some(entry) = state.entries.get_mut(&session)
                    && entry.generation == generation
                    && entry.status["state"] == "stopped"
                {
                    entry.status["cleanup"] = json!(if complete { "complete" } else { "failed" });
                }
                drop(state);
                (authority.options.changed)(&session, &generation);
            }
        });
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(task);
    }
    pub async fn drain(&self) -> Result<(), Error> {
        loop {
            let tasks = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(|e| e.into_inner()));
            if tasks.is_empty() {
                return Ok(());
            }
            for task in tasks {
                task.await.map_err(|_| Error("unavailable"))?;
            }
        }
    }
    pub async fn shutdown(self: &Arc<Self>) -> Result<(), Error> {
        let platforms = self
            .platforms
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(chrome) = platforms.as_ref().and_then(|p| p.chrome.as_ref()) {
            chrome.close();
        }
        let sessions = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.closed = true;
            state.entries.keys().cloned().collect::<Vec<_>>()
        };
        for session in sessions {
            self.retire(&session, None, "shutdown");
        }
        let drained = self.drain().await;
        #[cfg(unix)]
        let drained = drained.and(match &platforms {
            Some(platforms) => platforms.isolated.shutdown().await,
            None => Ok(()),
        });
        let macos = match platforms.and_then(|p| p.macos) {
            Some(macos) => macos.shutdown().await,
            None => Ok(()),
        };
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drivers
            .clear();
        drained.and(macos)
    }
    fn begin(
        self: &Arc<Self>,
        session: &str,
        generation: &str,
        preview: bool,
    ) -> Result<Call, Error> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let entry = state.entries.get_mut(session).ok_or(Error("stale"))?;
        if entry.generation != generation || *entry.cancel.borrow() || entry.lease.is_none() {
            return Err(Error("stale"));
        }
        if entry.status["state"] == "paused" && !preview {
            return Err(Error("paused"));
        }
        if entry.status["state"] != "active" && !(preview && entry.status["state"] == "paused") {
            return Err(Error("stale"));
        }
        if entry.busy || (preview && entry.previewing) {
            return Err(Error("busy"));
        }
        if preview {
            entry.previewing = true;
        } else {
            entry.busy = true;
        }
        Ok(Call {
            authority: self.clone(),
            session: session.into(),
            generation: generation.into(),
            driver: entry.driver.clone(),
            lease: entry.lease.clone().ok_or(Error("stale"))?,
            target: entry.target.clone().ok_or(Error("stale"))?,
            cancel: entry.cancel.subscribe(),
            preview,
            settled: false,
            mutating: false,
        })
    }
    pub async fn observe(
        self: &Arc<Self>,
        session: &str,
        generation: &str,
    ) -> Result<Value, Error> {
        let mut call = self.begin(session, generation, false)?;
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let entry = state.entries.get_mut(session).ok_or(Error("stale"))?;
            entry.revision = None;
            entry.candidate = None;
        }
        let result = call
            .invoke(
                Operation::Observe,
                json!({"id":call.lease}),
                self.options.timeout,
            )
            .await;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let entry = state.entries.get_mut(session).ok_or(Error("stale"))?;
        if !call.live(entry) {
            return Err(Error("stale"));
        }
        if entry.status["state"] == "paused" {
            call.settled = true;
            return Err(Error("paused"));
        }
        let result = result.ok().filter(|value| {
            valid("Observation", value)
                && value["revision"]
                    .as_u64()
                    .is_some_and(|r| r > entry.last_revision)
                && value.get("pathname") == call.target.get("pathname")
        });
        let Some(result) = result else {
            drop(state);
            self.retire(session, Some(generation), "target_lost");
            call.settled = true;
            return Err(Error("unavailable"));
        };
        entry.revision = result["revision"].as_u64();
        entry.last_revision = entry.revision.unwrap_or_default();
        call.settled = true;
        Ok(result)
    }
    pub fn confirmation(
        self: &Arc<Self>,
        session: &str,
        generation: &str,
        revision: u64,
        action: Value,
    ) -> Result<Option<Value>, Error> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let entry = state.entries.get_mut(session).ok_or(Error("stale"))?;
        if entry.generation != generation
            || entry.status["state"] != "active"
            || entry.revision != Some(revision)
        {
            return Err(Error("stale"));
        }
        if entry.busy
            || entry
                .candidate
                .as_ref()
                .is_some_and(|c| c.request["expiresAt"].as_u64().is_some_and(|v| v > now()))
        {
            return Err(Error("busy"));
        }
        let target = entry.target.as_ref().ok_or(Error("stale"))?;
        if !valid_action(target, &action) {
            return Err(Error("unavailable"));
        }
        if target["kind"] == "chrome-isolated" {
            return Ok(Some(refused("unsupported")));
        }
        if matches!(text(&action, "type"), "scroll" | "navigate") {
            return Err(Error("unavailable"));
        }
        let request = json!({"candidateID":uuid()?,"sessionID":session,"sessionLabel":entry.label,"purpose":"confirm","targetID":target["id"],"revision":revision,"action":action,"expiresAt":now()+60000});
        entry.candidate = Some(Candidate {
            request: request.clone(),
            targets: HashMap::new(),
            busy: false,
            proof: None,
        });
        let key = entry.key.clone();
        drop(state);
        let _ = self.pending.send((key, request));
        Ok(None)
    }
    pub async fn perform(
        self: &Arc<Self>,
        session: &str,
        generation: &str,
        revision: u64,
        call_id: &str,
        action: Value,
    ) -> Value {
        let mut call = match self.begin(session, generation, false) {
            Ok(call) => call,
            Err(error) => return self.rejected(session, generation, error),
        };
        let consent = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let entry = state
                .entries
                .get_mut(session)
                .expect("active call owns an entry");
            if entry.revision != Some(revision) || entry.calls.contains(call_id) {
                call.settled = true;
                return refused("stale");
            }
            if !valid_action(&call.target, &action) || !validation::id(call_id) {
                call.settled = true;
                return refused("policy");
            }
            if call.target["kind"] == "chrome-isolated" && action["destructive"] == true {
                call.settled = true;
                return refused("unsupported");
            }
            let consent = entry
                .candidate
                .as_ref()
                .filter(|c| {
                    c.request["purpose"] == "confirm"
                        && c.request["revision"] == revision
                        && c.request["action"] == action
                        && c.request["expiresAt"].as_u64().is_some_and(|v| v > now())
                })
                .and_then(|c| c.proof.clone());
            if action["destructive"] == true && consent.is_none() {
                call.settled = true;
                return refused("confirmation_required");
            }
            if entry.calls.len() >= 512 {
                drop(state);
                self.retire(session, Some(generation), "expired");
                call.settled = true;
                return refused("stale");
            }
            entry.calls.insert(call_id.into());
            entry.revision = None;
            entry.candidate = None;
            consent
        };
        call.mutating = true;
        let mut input =
            json!({"id":call.lease,"revision":revision,"callID":call_id,"action":action});
        if let Some(consent) = consent {
            input["consent"] = consent;
        }
        let result = call
            .invoke(Operation::Perform, input, self.options.timeout)
            .await
            .ok()
            .filter(|v| valid("ActionResult", v));
        let Some(result) = result else {
            self.retire(session, Some(generation), "uncertain");
            call.settled = true;
            return json!({"outcome":"uncertain"});
        };
        let live = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let entry = state
                .entries
                .get_mut(session)
                .expect("active call owns an entry");
            if result["reason"] == "confirmation_required" && call.live(entry) {
                entry.revision = Some(revision);
            }
            call.live(entry)
        };
        if !live {
            call.settled = true;
            return json!({"outcome":"uncertain"});
        }
        self.settle_result(session, generation, &result);
        call.settled = true;
        result
    }
    fn rejected(&self, session: &str, generation: &str, error: Error) -> Value {
        let current = self.status(session);
        if error.0 == "paused" && current["generation"] == generation {
            return json!({"outcome":"paused","reason":current["reason"]});
        }
        refused(if error.0 == "busy" { "busy" } else { "stale" })
    }
    fn settle_result(self: &Arc<Self>, session: &str, generation: &str, result: &Value) {
        match text(result, "outcome") {
            "uncertain" => {
                self.retire(session, Some(generation), "uncertain");
            }
            "paused" => {
                self.pause_session(session, generation, text(result, "reason"));
            }
            "refused" => match text(result, "reason") {
                "target_lost" => {
                    self.retire(session, Some(generation), "target_lost");
                }
                "permission" => {
                    self.retire(session, Some(generation), "permission");
                }
                _ => {}
            },
            _ => (self.options.changed)(session, generation),
        }
    }
    pub async fn run(
        self: &Arc<Self>,
        session: &str,
        generation: &str,
        revision: u64,
        mut script: Value,
    ) -> Result<Value, Error> {
        let mut call = match self.begin(session, generation, false) {
            Ok(call) => call,
            Err(error) => return Ok(self.rejected(session, generation, error)),
        };
        if call.target["kind"] == "macos-window" {
            call.settled = true;
            return Ok(refused("unsupported"));
        }
        if !valid("ScriptRequest", &script) {
            call.settled = true;
            return Ok(refused("policy"));
        }
        if script.get("timeoutMs").is_none() {
            script["timeoutMs"] = json!(10000);
        }
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let entry = state
                .entries
                .get_mut(session)
                .expect("active call owns an entry");
            if entry.revision != Some(revision) {
                call.settled = true;
                return Ok(refused("stale"));
            }
            if entry.calls.len() >= 512 {
                drop(state);
                self.retire(session, Some(generation), "expired");
                call.settled = true;
                return Ok(refused("stale"));
            }
            entry.calls.insert(uuid()?);
            entry.revision = None;
            entry.candidate = None;
        }
        call.mutating = true;
        let timeout = Duration::from_millis(script["timeoutMs"].as_u64().unwrap_or(10000))
            + self.options.timeout;
        let result = call
            .invoke(
                Operation::Run,
                json!({"id":call.lease,"script":script}),
                timeout,
            )
            .await
            .ok()
            .filter(|v| {
                valid("ScriptResult", v)
                    && v.get("value").is_none_or(|v| v.to_string().len() <= 65536)
            });
        let Some(result) = result else {
            self.retire(session, Some(generation), "uncertain");
            call.settled = true;
            return Err(Error("uncertain"));
        };
        self.settle_result(session, generation, &result);
        call.settled = true;
        Ok(result)
    }
    fn pause_session(&self, session: &str, generation: &str, reason: &str) -> bool {
        if !validation::pause_reason(reason) {
            return false;
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = state.entries.get_mut(session) else {
            return false;
        };
        if entry.generation != generation
            || entry.lease.is_none()
            || !matches!(text(&entry.status, "state"), "active" | "paused")
        {
            return false;
        }
        if entry.status["state"] == "paused" && entry.status["reason"] == reason {
            return true;
        }
        entry.status["state"] = json!("paused");
        entry.status["reason"] = json!(reason);
        entry.revision = None;
        entry.candidate = None;
        drop(state);
        (self.options.changed)(session, generation);
        true
    }
    fn unpause(&self, session: &str, generation: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = state.entries.get_mut(session) else {
            return false;
        };
        if entry.generation != generation
            || entry.status["state"] != "paused"
            || *entry.cancel.borrow()
        {
            return false;
        }
        entry.status["state"] = json!("active");
        entry
            .status
            .as_object_mut()
            .expect("status object")
            .remove("reason");
        entry.revision = None;
        drop(state);
        (self.options.changed)(session, generation);
        true
    }
    pub async fn resume(self: &Arc<Self>, session: &str, generation: &str) -> bool {
        if self.status(session)["state"] != "paused" {
            return false;
        }
        let Ok(mut call) = self.begin(session, generation, true) else {
            return false;
        };
        let resumed = call
            .invoke(
                Operation::Resume,
                json!({"id":call.lease}),
                self.options.timeout,
            )
            .await
            == Ok(json!(true));
        call.settled = true;
        resumed && self.unpause(session, generation)
    }
    pub async fn preview(self: &Arc<Self>, session: &str, generation: &str) -> Value {
        let unavailable = json!({"state":"unavailable","generation":generation});
        let Ok(mut call) = self.begin(session, generation, true) else {
            return unavailable;
        };
        let stamp = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let entry = &state.entries[session];
            (entry.calls.len(), entry.last_revision)
        };
        let frame = call
            .invoke(
                Operation::Preview,
                json!({"id":call.lease}),
                self.options.timeout,
            )
            .await
            .ok()
            .filter(validation::frame);
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let entry = &state.entries[session];
        let current =
            call.live(entry) && !entry.busy && (entry.calls.len(), entry.last_revision) == stamp;
        call.settled = true;
        if current && let Some(frame) = frame {
            return json!({"state":"ready","generation":generation,"frame":frame});
        }
        unavailable
    }
    pub fn admit_captures(&self, admission: Option<CaptureAdmission>) {
        *self.capture.lock().unwrap_or_else(|e| e.into_inner()) = admission;
    }
}
struct Call {
    authority: Arc<Authority>,
    session: String,
    generation: String,
    driver: Arc<dyn Driver>,
    lease: String,
    target: Value,
    cancel: watch::Receiver<bool>,
    preview: bool,
    settled: bool,
    mutating: bool,
}
impl Call {
    fn live(&self, entry: &Entry) -> bool {
        entry.generation == self.generation
            && !*entry.cancel.borrow()
            && matches!(text(&entry.status, "state"), "active" | "paused")
    }
    async fn invoke(&self, op: Operation, input: Value, timeout: Duration) -> Result<Value, Error> {
        let mut cancel = self.cancel.clone();
        if *cancel.borrow() {
            return Err(Error("stale"));
        }
        tokio::select! {result=tokio::time::timeout(timeout,self.driver.call(op,input,cancel.clone()))=>result.map_err(|_|Error("uncertain"))?,_=cancel.wait_for(|v|*v)=>Err(Error("stale"))}
    }
}
impl Drop for Call {
    fn drop(&mut self) {
        {
            let mut state = self
                .authority
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = state.entries.get_mut(&self.session)
                && entry.generation == self.generation
            {
                if self.preview {
                    entry.previewing = false;
                } else {
                    entry.busy = false;
                }
            }
        }
        if !self.settled {
            self.authority.retire(
                &self.session,
                Some(&self.generation),
                if self.mutating {
                    "uncertain"
                } else {
                    "target_lost"
                },
            );
        }
    }
}

#[derive(Clone)]
pub struct Native {
    authority: Weak<Authority>,
    key: String,
    driver: Arc<dyn Driver>,
}
impl Native {
    async fn consent<F, Fut>(&self, request: &Value, cancel: watch::Receiver<bool>, approve: F)
    where
        F: FnOnce(Vec<Value>, watch::Receiver<bool>) -> Fut,
        Fut: std::future::Future<Output = Result<(), ConsentError>>,
    {
        let id = text(request, "candidateID");
        if *cancel.borrow() || request["expiresAt"].as_u64().is_none_or(|v| v <= now()) {
            return;
        }
        let scope = Scope::new(
            cancel,
            Duration::from_millis(
                request["expiresAt"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_sub(now()),
            ),
        );
        let mut cancel = scope.cancel.subscribe();
        let mut targets = self.inventory(id).await;
        for delay in [100, 200, 400, 800] {
            if !targets.is_empty() {
                break;
            }
            tokio::select! {_=tokio::time::sleep(Duration::from_millis(delay))=>{},_=cancel.wait_for(|v|*v)=>return,}
            if *cancel.borrow() || !self.pending().iter().any(|c| c["candidateID"] == id) {
                return;
            }
            targets = self.inventory(id).await;
        }
        if *cancel.borrow() {
            return;
        }
        let outcome = if targets.is_empty() {
            Err(Error("inventory_empty").into())
        } else {
            approve(targets, cancel.clone()).await
        };
        if let Err(reason) = outcome
            && !*cancel.borrow()
            && self.reject(id)
        {
            tracing::warn!(
                driver = self.key(),
                purpose = text(request, "purpose"),
                sessionID = text(request, "sessionID"),
                reason = reason.0.as_str(),
                "Native interaction consent was rejected"
            );
        }
    }
    pub fn cancellation(&self, candidate: &str) -> Option<watch::Receiver<bool>> {
        let authority = self.authority.upgrade()?;
        let state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .entries
            .values()
            .find(|e| {
                self.owned(&state, e)
                    && e.candidate
                        .as_ref()
                        .is_some_and(|c| c.request["candidateID"] == candidate)
            })
            .map(|e| e.cancel.subscribe())
    }
    pub fn subscribe(&self) -> Option<broadcast::Receiver<(String, Value)>> {
        Some(self.authority.upgrade()?.pending.subscribe())
    }
    pub fn key(&self) -> &str {
        &self.key
    }
    fn owned(&self, state: &State, entry: &Entry) -> bool {
        entry.key == self.key
            && state
                .drivers
                .get(&self.key)
                .is_some_and(|d| Arc::ptr_eq(d, &self.driver))
            && !*entry.cancel.borrow()
    }
    pub fn pending(&self) -> Vec<Value> {
        let Some(authority) = self.authority.upgrade() else {
            return vec![];
        };
        let state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .entries
            .values()
            .filter(|e| self.owned(&state, e))
            .filter_map(|e| e.candidate.as_ref())
            .filter(|c| {
                c.proof.is_none() && c.request["expiresAt"].as_u64().is_some_and(|v| v > now())
            })
            .map(|c| c.request.clone())
            .collect()
    }
    pub async fn inventory(&self, candidate_id: &str) -> Vec<Value> {
        let Some(authority) = self.authority.upgrade() else {
            return vec![];
        };
        let current = {
            let mut state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
            let session = state
                .entries
                .iter()
                .find(|(_, e)| {
                    self.owned(&state, e)
                        && e.candidate
                            .as_ref()
                            .is_some_and(|c| c.request["candidateID"] == candidate_id)
                })
                .map(|(s, _)| s.clone());
            let Some(session) = session else {
                return vec![];
            };
            let entry = state.entries.get_mut(&session).expect("found entry");
            let c = entry.candidate.as_mut().expect("found candidate");
            if c.busy
                || c.proof.is_some()
                || c.request["expiresAt"].as_u64().is_none_or(|v| v <= now())
            {
                return vec![];
            }
            c.busy = true;
            (
                session,
                entry.generation.clone(),
                c.request.clone(),
                entry.cancel.subscribe(),
                entry.target.clone(),
            )
        };
        let (session, generation, request, mut cancel, pinned) = current;
        let result = tokio::select! {r=tokio::time::timeout(authority.options.timeout,self.driver.call(Operation::Inventory,request.clone(),cancel.clone()))=>r.ok().and_then(Result::ok),_=cancel.wait_for(|v|*v)=>None};
        let mut targets = HashMap::new();
        if let Some(Value::Array(values)) = result
            && values.len() <= 100
        {
            for target in values {
                if !validation::allows_target(self.driver.platform(), &target) {
                    continue;
                }
                let matches = if request["purpose"] == "confirm" {
                    pinned.as_ref().is_some_and(|p| {
                        p["id"] == target["id"]
                            && p["kind"] == target["kind"]
                            && p.get("bundleID") == target.get("bundleID")
                            && p.get("origin") == target.get("origin")
                            && p.get("pathname") == target.get("pathname")
                    })
                } else {
                    validation::matches_target(&request["selection"], &target)
                };
                if !matches {
                    continue;
                }
                let id = text(&target, "id").to_owned();
                if targets.insert(id, target).is_some() {
                    targets.clear();
                    break;
                }
            }
        }
        let mut state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
        let owned = state
            .entries
            .get(&session)
            .is_some_and(|e| self.owned(&state, e));
        let Some(entry) = state.entries.get_mut(&session) else {
            return vec![];
        };
        if !owned || entry.generation != generation {
            return vec![];
        }
        let Some(c) = entry
            .candidate
            .as_mut()
            .filter(|c| c.request["candidateID"] == candidate_id)
        else {
            return vec![];
        };
        c.busy = false;
        if c.request["expiresAt"].as_u64().is_none_or(|v| v <= now()) {
            return vec![];
        }
        c.targets = targets;
        c.targets.values().cloned().collect()
    }
    pub async fn approve(&self, proof: Value) -> bool {
        let Some(authority) = self.authority.upgrade() else {
            return false;
        };
        let session = text(&proof, "sessionID").to_owned();
        if !authority.usable(&session) || !validation::proof(&proof) {
            return false;
        }
        let prepared = {
            let mut state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(entry) = state.entries.get(&session) else {
                return false;
            };
            if !self.owned(&state, entry) {
                return false;
            }
            let Some(c) = entry.candidate.as_ref() else {
                return false;
            };
            if c.busy
                || c.proof.is_some()
                || c.request["candidateID"] != proof["candidateID"]
                || c.request["expiresAt"].as_u64().is_none_or(|v| v <= now())
            {
                return false;
            }
            let Some(target) = c.targets.get(text(&proof, "targetID")).cloned() else {
                return false;
            };
            if c.request["purpose"] == "confirm" {
                if entry.busy
                    || entry.revision != c.request["revision"].as_u64()
                    || entry
                        .target
                        .as_ref()
                        .is_none_or(|t| t["id"] != proof["targetID"])
                {
                    return false;
                }
                state
                    .entries
                    .get_mut(&session)
                    .expect("found entry")
                    .candidate
                    .as_mut()
                    .expect("found candidate")
                    .proof = Some(proof);
                return true;
            }
            let target_key = (self.key.clone(), text(&target, "id").to_owned());
            if state.targets.contains_key(&target_key) || state.targets.len() >= 128 {
                return false;
            }
            state.targets.insert(target_key, session.clone());
            let entry = state.entries.get_mut(&session).expect("found entry");
            entry.candidate = None;
            entry.target = Some(target.clone());
            (entry.generation.clone(), target, entry.cancel.subscribe())
        };
        let (generation, target, mut cancel) = prepared;
        let attached = tokio::select! {r=tokio::time::timeout(authority.options.timeout,self.driver.call(Operation::Attach,json!({"target":target,"proof":proof}),cancel.clone()))=>r.ok().and_then(Result::ok),_=cancel.wait_for(|v|*v)=>None};
        let lease = attached
            .as_ref()
            .and_then(|v| v["id"].as_str())
            .filter(|s| validation::id(s))
            .map(str::to_owned);
        let Some(lease) = lease else {
            authority.retire(&session, Some(&generation), "target_lost");
            let mut state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = state.entries.get_mut(&session)
                && entry.generation == generation
            {
                entry.status["cleanup"] = json!("failed");
            }
            return false;
        };
        let mut state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
        let owned = state
            .entries
            .get(&session)
            .is_some_and(|e| self.owned(&state, e));
        let Some(entry) = state.entries.get_mut(&session) else {
            return false;
        };
        if !owned || entry.generation != generation || entry.status["state"] != "pending" {
            drop(state);
            authority.detach(Cleanup {
                session,
                generation,
                driver: self.driver.clone(),
                lease,
                key: self.key.clone(),
                target: Some(text(&target, "id").into()),
                reason: "target_lost",
            });
            return false;
        }
        entry.lease = Some(lease);
        entry.status = json!({"state":"active","platform":self.driver.platform(),"generation":generation,"label":validation::target_label(&target)});
        if let Some(timer) = entry.timer.take() {
            timer.abort();
        }
        entry.timer = Some(authority.expiry(&session, &generation, Duration::from_secs(900)));
        drop(state);
        (authority.options.changed)(&session, &generation);
        true
    }
    pub fn reject(&self, candidate_id: &str) -> bool {
        let Some(authority) = self.authority.upgrade() else {
            return false;
        };
        let mut state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
        let session = state
            .entries
            .iter()
            .find(|(_, e)| {
                self.owned(&state, e)
                    && e.candidate.as_ref().is_some_and(|c| {
                        c.request["candidateID"] == candidate_id && c.proof.is_none()
                    })
            })
            .map(|(s, _)| s.clone());
        let Some(session) = session else {
            return false;
        };
        let entry = state.entries.get_mut(&session).expect("found entry");
        if entry
            .candidate
            .as_ref()
            .is_some_and(|c| c.request["purpose"] == "confirm")
        {
            entry.candidate = None;
            return true;
        }
        let generation = entry.generation.clone();
        drop(state);
        authority.retire(&session, Some(&generation), "rejected")
    }
    fn owner(&self, lease: &str) -> Option<(Arc<Authority>, String, String)> {
        let authority = self.authority.upgrade()?;
        let found = {
            let state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
            state
                .entries
                .iter()
                .find(|(_, e)| self.owned(&state, e) && e.lease.as_deref() == Some(lease))
                .map(|(s, e)| (s.clone(), e.generation.clone()))
        }?;
        Some((authority, found.0, found.1))
    }
    pub fn pause(&self, lease: &str, reason: &str) -> bool {
        self.owner(lease)
            .is_some_and(|(a, s, g)| a.pause_session(&s, &g, reason))
    }
    pub fn resume(&self, lease: &str) -> bool {
        self.owner(lease).is_some_and(|(a, s, g)| a.unpause(&s, &g))
    }
    pub fn stop(&self, lease: &str, reason: &'static str) -> bool {
        if !matches!(reason, "stopped" | "target_lost" | "permission") {
            return false;
        }
        self.owner(lease)
            .is_some_and(|(a, s, g)| a.retire(&s, Some(&g), reason))
    }
    pub async fn capture(&self, lease: &str, input: Value) -> bool {
        let Some((authority, session, generation)) = self.owner(lease) else {
            return false;
        };
        let admission = authority
            .capture
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let Some(admission) = admission else {
            return false;
        };
        if !authority.usable(&session) {
            authority.revoke(&session);
            return false;
        }
        if !validation::frame(&input["frame"]) {
            return false;
        }
        let mut capture = {
            let mut state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(entry) = state.entries.get_mut(&session) else {
                return false;
            };
            if entry.capturing || !matches!(text(&entry.status, "state"), "active" | "paused") {
                return false;
            }
            entry.capturing = true;
            json!({"label":entry.status["label"],"frame":input["frame"]})
        };
        if let Some(title) = input["title"].as_str() {
            let title = bounded_label(&validation::redact(title));
            if !title.is_empty() {
                capture["title"] = json!(title);
            }
        }
        if let Some(raw) = input["url"].as_str()
            && let Ok(mut url) = Url::parse(raw)
            && matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
        {
            url.set_query(None);
            url.set_fragment(None);
            capture["url"] = json!(url.as_str());
        }
        let result = admission(session.clone(), generation.clone(), capture)
            .await
            .is_ok();
        let mut state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = state.entries.get_mut(&session)
            && entry.generation == generation
        {
            entry.capturing = false;
        }
        result
    }
    pub fn disconnect(&self) {
        let Some(authority) = self.authority.upgrade() else {
            return;
        };
        let mut state = authority.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .drivers
            .get(&self.key)
            .is_none_or(|d| !Arc::ptr_eq(d, &self.driver))
        {
            return;
        }
        let sessions = state
            .entries
            .iter()
            .filter(|(_, e)| self.owned(&state, e))
            .map(|(s, _)| s.clone())
            .collect::<Vec<_>>();
        state.drivers.remove(&self.key);
        drop(state);
        for session in sessions {
            authority.retire(&session, None, "disconnected");
        }
    }
}
struct Scope {
    cancel: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}
impl Scope {
    fn new(mut parent: watch::Receiver<bool>, timeout: Duration) -> Self {
        let (cancel, _) = watch::channel(*parent.borrow());
        let signal = cancel.clone();
        let task = tokio::spawn(async move {
            tokio::select! {_=tokio::time::sleep(timeout)=>{},_=parent.wait_for(|v|*v)=>{},}
            signal.send_replace(true);
        });
        Self { cancel, task }
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
        self.task.abort();
    }
}

pub(crate) fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub(crate) fn now() -> u64 {
    super::now() as u64
}
pub(crate) fn refused(reason: &str) -> Value {
    json!({"outcome":"refused","reason":reason})
}
fn bounded_label(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(128)
        .collect()
}
fn valid_action(target: &Value, action: &Value) -> bool {
    if !valid("Action", action)
        || action["platform"]
            != if target["kind"] == "macos-window" {
                "macos"
            } else {
                "chrome"
            }
    {
        return false;
    }
    if action["type"] != "navigate" {
        return true;
    }
    let Ok(url) = Url::parse(text(action, "url")) else {
        return false;
    };
    url.origin().ascii_serialization() == text(target, "origin")
        && url.path() == text(target, "pathname")
        && (target["kind"] == "chrome-tab"
            || target["url"]
                .as_str()
                .and_then(|u| Url::parse(u).ok())
                .as_ref()
                == Some(&url))
}
