use super::{Future, macos::NativeClient, types::*};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::watch;

pub trait Invoke: Send + Sync {
    fn invoke<'a>(
        &'a self,
        request: Request,
        signal: watch::Receiver<bool>,
    ) -> Future<'a, Result<Success, NativeError>>;
}
impl Invoke for NativeClient {
    fn invoke<'a>(
        &'a self,
        request: Request,
        signal: watch::Receiver<bool>,
    ) -> Future<'a, Result<Success, NativeError>> {
        Box::pin(self.invoke_with_signal(request, signal))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Native(NativeError),
    Ownership(String),
}
impl From<NativeError> for Error {
    fn from(error: NativeError) -> Self {
        Self::Native(error)
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Native(error) => error.fmt(f),
            Self::Ownership(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for Error {}

struct Claim {
    location: u64,
    session: String,
    revision: String,
}
struct Active {
    location: u64,
    session: String,
    call: String,
    target: String,
    token: u64,
    cancellation: watch::Sender<bool>,
}
struct Display {
    directory: PathBuf,
    id: u32,
}
#[derive(Clone)]
struct Staged {
    session: String,
    target: Target,
    frame: super::electron::Rect,
}
#[derive(Default)]
struct State {
    claims: HashMap<String, Claim>,
    calls: HashMap<(String, String), Arc<Active>>,
    targets: HashMap<String, Arc<Active>>,
    displays: HashMap<u64, Display>,
    staged: HashMap<(u64, String), Staged>,
}

pub struct Coordinator {
    invoke: Arc<dyn Invoke>,
    platform: String,
    state: Mutex<State>,
    desktop: tokio::sync::Mutex<()>,
    sequence: AtomicU64,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}
#[derive(Clone)]
pub struct Service {
    coordinator: Arc<Coordinator>,
    location: u64,
}

impl Coordinator {
    pub fn new(invoke: Arc<dyn Invoke>, platform: impl Into<String>) -> Arc<Self> {
        Arc::new(Self {
            invoke,
            platform: platform.into(),
            state: Mutex::new(State::default()),
            desktop: tokio::sync::Mutex::new(()),
            sequence: AtomicU64::new(1),
            tasks: Mutex::new(Vec::new()),
        })
    }
    pub fn service(self: &Arc<Self>) -> Service {
        Service {
            coordinator: self.clone(),
            location: self.sequence.fetch_add(1, Ordering::Relaxed),
        }
    }
    fn begin(
        self: &Arc<Self>,
        location: u64,
        request: &Request,
        cancellation: watch::Sender<bool>,
    ) -> Result<CallGuard, Error> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let call_key = (
            request.owner.session_id.clone(),
            request.owner.call_id.clone(),
        );
        if state.calls.contains_key(&call_key) {
            return Err(Error::Ownership(
                "This Session already has an active computer call with that ID".into(),
            ));
        }
        let key = request.target.as_ref().map(Target::key).unwrap_or_else(|| {
            format!(
                "unclaimed\0{}\0{}",
                request.owner.session_id, request.owner.call_id
            )
        });
        if state.targets.contains_key(&key) {
            return Err(Error::Ownership(
                "Target already has an active computer call".into(),
            ));
        }
        let claim = state.claims.get(&key);
        if claim.is_some_and(|claim| claim.session != request.owner.session_id) {
            return Err(Error::Ownership(
                "Target is owned by another Session".into(),
            ));
        }
        if let Some(revision) = &request.expected_revision {
            let Some(claim) = claim else {
                return Err(Error::Ownership(
                    "Target must be inspected by this Session before mutation".into(),
                ));
            };
            if claim.revision != *revision || claim.location != location {
                return Err(Error::Ownership(
                    "Target revision is stale; inspect it again before mutation".into(),
                ));
            }
        }
        let active = Arc::new(Active {
            location,
            session: request.owner.session_id.clone(),
            call: request.owner.call_id.clone(),
            target: key.clone(),
            token: self.sequence.fetch_add(1, Ordering::Relaxed),
            cancellation,
        });
        state.calls.insert(call_key, active.clone());
        state.targets.insert(key, active.clone());
        Ok(CallGuard {
            coordinator: self.clone(),
            active,
            settled: false,
        })
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(|e| e.into_inner()));
        for task in tasks {
            task.await
                .map_err(|_| Error::Ownership("Computer settlement task failed".into()))?;
        }
        Ok(())
    }
    pub async fn release_session(self: &Arc<Self>, session: &str) -> Result<(), Error> {
        let locations = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state
                .claims
                .values()
                .filter(|claim| claim.session == session)
                .map(|claim| claim.location)
                .chain(
                    state
                        .calls
                        .values()
                        .filter(|active| active.session == session)
                        .map(|active| active.location),
                )
                .chain(
                    state
                        .staged
                        .iter()
                        .filter(|(_, window)| window.session == session)
                        .map(|((location, _), _)| *location),
                )
                .collect::<std::collections::HashSet<_>>()
        };
        let mut failure = None;
        for location in locations {
            if let Err(error) = (Service {
                coordinator: self.clone(),
                location,
            })
            .release(Some(session))
            .await
                && failure.is_none()
            {
                failure = Some(error);
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

struct Cancellation {
    sender: watch::Sender<bool>,
    settled: bool,
}
impl Drop for Cancellation {
    fn drop(&mut self) {
        if !self.settled {
            self.sender.send_replace(true);
        }
    }
}

struct CallGuard {
    coordinator: Arc<Coordinator>,
    active: Arc<Active>,
    settled: bool,
}
impl Drop for CallGuard {
    fn drop(&mut self) {
        let mut state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let key = (self.active.session.clone(), self.active.call.clone());
        if state
            .calls
            .get(&key)
            .is_some_and(|call| call.token == self.active.token)
        {
            state.calls.remove(&key);
        }
        if state
            .targets
            .get(&self.active.target)
            .is_some_and(|call| call.token == self.active.token)
        {
            state.targets.remove(&self.active.target);
        }
        if !self.settled {
            state.claims.remove(&self.active.target);
            self.active.cancellation.send_replace(true);
        }
    }
}

impl Service {
    pub fn status(&self) -> Value {
        let platform = match self.coordinator.platform.as_str() {
            "darwin" => "macos",
            "win32" => "windows",
            other => other,
        };
        json!({"platform":platform,"state":if platform=="macos" {"supported"}else{"unsupported"},"capabilities":if platform=="macos" {json!([
            {"platform":"macos","application":"iterm","identity":{"kind":"macos.bundle_id","value":"com.googlecode.iterm2"},"operations":["inspect","send_text"]},
            {"platform":"macos","application":"finder","identity":{"kind":"macos.bundle_id","value":"com.apple.finder"},"operations":["inspect","move"]},
            {"platform":"macos","application":"desktop","identity":{"kind":"macos.bundle_id","value":"explicit-running-app"},"operations":["list","launch","inspect","capture","click","drag","type","scroll","key","stage","unstage"]},
            {"platform":"macos","application":"webbrowser","identity":{"kind":"macos.bundle_id","value":"com.apple.Safari,com.google.Chrome"},"operations":["tabs","navigate","back","forward","reload","new_tab","close_tab","eval"]}
        ])}else{json!([])}})
    }
    pub async fn execute(&self, request: Request) -> Result<Success, Error> {
        let (cancellation, _) = watch::channel(false);
        let mut guard = Cancellation {
            sender: cancellation.clone(),
            settled: false,
        };
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let service = self.clone();
        let task = tokio::spawn(async move {
            let result = service.run(request, cancellation).await;
            let _ = sender.send(result);
        });
        self.coordinator
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(task);
        let result = receiver
            .await
            .map_err(|_| Error::Ownership("Computer settlement task failed".into()))?;
        guard.settled = true;
        result
    }
    async fn run(
        &self,
        mut request: Request,
        cancellation: watch::Sender<bool>,
    ) -> Result<Success, Error> {
        if self.coordinator.platform != "darwin" {
            return Err(NativeError::new(
                Code::UnsupportedPlatform,
                format!(
                    "Native computer use has no provider for {}",
                    self.coordinator.platform
                ),
                Outcome::NotStarted,
            )
            .into());
        }
        if *cancellation.borrow() {
            return Err(Error::Ownership(
                "Computer call was cancelled; inspect the target again".into(),
            ));
        }
        let mut call = self
            .coordinator
            .begin(self.location, &request, cancellation)?;
        let desktop = request.operation.desktop_mutation()
            || (request.operation == Operation::DesktopLaunch
                && request.fields().get("remoteDebugging") == Some(&Value::Bool(true)));
        let _desktop = if desktop {
            Some(self.coordinator.desktop.lock().await)
        } else {
            None
        };
        let result=async {
            if *call.active.cancellation.borrow() {return Err(Error::Ownership("Computer call was cancelled; inspect the target again".into()));}
            if request.operation==Operation::DesktopStage {
                let target=request.target.clone().ok_or_else(||NativeError::new(Code::InvalidRequest,"Stage requires an explicit target",Outcome::NotStarted))?;
                let key=target.key();
                let existing=self.coordinator.state.lock().unwrap_or_else(|e|e.into_inner()).staged.get(&(self.location,key.clone())).cloned();
                if let Some(existing)=existing {
                    if existing.session!=request.owner.session_id {return Err(Error::Ownership("Window is staged by another Session".into()));}
                    return Ok(Success {action:Operation::DesktopStage,revision:request.expected_revision.clone().unwrap_or_default(),detail:json!({"originalFrame":{"x":existing.frame.x,"y":existing.frame.y,"width":existing.frame.width,"height":existing.frame.height}})});
                }
                let display=self.coordinator.state.lock().unwrap_or_else(|e|e.into_inner()).displays.get(&self.location).map(|d|d.id);
                let display=match display {Some(display)=>display,None=>self.start_display(&request.owner,call.active.cancellation.subscribe()).await?};
                request=Request::stage(request.owner.clone(),target,request.expected_revision.clone().ok_or_else(||Error::Ownership("Stage requires an inspected revision".into()))?,display)?;
                if *call.active.cancellation.borrow() {return Err(Error::Ownership("Computer call was cancelled; inspect the target again".into()));}
            }
            let output=self.coordinator.invoke.invoke(request.clone(),call.active.cancellation.subscribe()).await?;
            if request.operation==Operation::DesktopStage {
                let frame=frame(output.detail.get("originalFrame")).ok_or_else(||NativeError::new(Code::InvalidResponse,"The native stage response omitted the original window frame",Outcome::Unknown))?;
                let target=request.target.clone().ok_or_else(||NativeError::new(Code::InvalidRequest,"Stage requires an explicit target",Outcome::NotStarted))?;
                self.coordinator.state.lock().unwrap_or_else(|e|e.into_inner()).staged.insert((self.location,target.key()),Staged {session:request.owner.session_id.clone(),target,frame});
            }
            if *call.active.cancellation.borrow() {
                return Err(if request.operation.mutating() {
                    NativeError::new(Code::UnknownOutcome,"Computer mutation was cancelled; inspect the target again",Outcome::Unknown).into()
                } else { Error::Ownership("Computer call was cancelled; inspect the target again".into()) });
            }
            if request.operation==Operation::BrowserTabs {self.claim_browser_windows(&request,&output)?;}
            if let Some(target)=&request.target {
                let mut state=self.coordinator.state.lock().unwrap_or_else(|e|e.into_inner());
                if request.operation==Operation::FinderMove {state.claims.remove(&target.key());}
                if request.operation!=Operation::FinderMove {state.claims.insert(target.key(),Claim {location:self.location,session:request.owner.session_id.clone(),revision:output.revision.clone()});}
            }
            if request.operation==Operation::DesktopUnstage {self.remove_staged(&call.active.target)?;}
            Ok(output)
        }.await;
        if let Err(error) = &result {
            if matches!(error, Error::Ownership(_))
                || matches!(error,Error::Native(native) if native.outcome==Some(Outcome::Unknown) || matches!(native.code,Code::StaleRevision|Code::TargetNotFound))
            {
                self.coordinator
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .claims
                    .remove(&call.active.target);
            }
            if request.operation == Operation::DesktopStage {
                self.stop_display_when_empty()?;
            }
            if request.operation == Operation::DesktopUnstage
                && matches!(error,Error::Native(native) if native.code==Code::TargetNotFound)
            {
                self.remove_staged(&call.active.target)?;
            }
        }
        if (request.operation == Operation::DesktopQuit
            || (request.operation == Operation::DesktopLaunch
                && request.fields().get("remoteDebugging") == Some(&Value::Bool(true))))
            && let Some(bundle) = request.fields().get("bundleID").and_then(Value::as_str)
        {
            let prefix = if request.operation == Operation::DesktopQuit {
                format!(
                    "macos\0desktop\0{bundle}\0{}\0",
                    request
                        .fields()
                        .get("pid")
                        .and_then(Value::as_u64)
                        .unwrap_or_default()
                )
            } else {
                format!("macos\0desktop\0{bundle}\0")
            };
            self.coordinator
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .claims
                .retain(|key, _| !key.starts_with(&prefix));
        }
        call.settled = true;
        result
    }
    pub fn cancel(&self, session: &str, call: &str) -> bool {
        let mut state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(active) = state
            .calls
            .get(&(session.into(), call.into()))
            .filter(|active| active.location == self.location)
            .cloned()
        else {
            return false;
        };
        active.cancellation.send_replace(true);
        state.claims.remove(&active.target);
        true
    }
    fn claim_browser_windows(&self, request: &Request, result: &Success) -> Result<(), Error> {
        let bundle = request
            .fields()
            .get("bundleID")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                NativeError::new(
                    Code::InvalidRequest,
                    "Missing browser identity",
                    Outcome::NotStarted,
                )
            })?;
        let windows = result
            .detail
            .get("browserWindows")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let claims = windows
            .iter()
            .map(|window| {
                let id = window
                    .get("window_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        NativeError::new(
                            Code::InvalidResponse,
                            "Invalid browser window identity",
                            Outcome::Unknown,
                        )
                    })?;
                let revision = window
                    .get("revision")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        NativeError::new(
                            Code::InvalidResponse,
                            "Invalid browser window revision",
                            Outcome::Unknown,
                        )
                    })?;
                Ok((
                    format!("macos\0webbrowser\0{bundle}\0{id}"),
                    revision.to_string(),
                ))
            })
            .collect::<Result<Vec<_>, NativeError>>()?;
        let mut state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if claims.iter().any(|(key, _)| {
            state.claims.get(key).is_some_and(|claim| {
                claim.session != request.owner.session_id || claim.location != self.location
            })
        }) {
            return Err(Error::Ownership(
                "Browser window is owned by another Session or Location".into(),
            ));
        }
        let prefix = format!("macos\0webbrowser\0{bundle}\0");
        state.claims.retain(|key, claim| {
            claim.session != request.owner.session_id || !key.starts_with(&prefix)
        });
        for (key, revision) in claims {
            state.claims.insert(
                key,
                Claim {
                    location: self.location,
                    session: request.owner.session_id.clone(),
                    revision,
                },
            );
        }
        Ok(())
    }
    async fn start_display(
        &self,
        owner: &Owner,
        signal: watch::Receiver<bool>,
    ) -> Result<u32, Error> {
        let directory = std::env::temp_dir().join(
            super::super::identifier("ycoding-agent-display-").map_err(|_| {
                NativeError::new(
                    Code::BackgroundUnavailable,
                    "Could not create the agent display control directory",
                    Outcome::NotStarted,
                )
            })?,
        );
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory).map_err(|_| {
            NativeError::new(
                Code::BackgroundUnavailable,
                "Could not create the agent display control directory",
                Outcome::NotStarted,
            )
        })?;
        let request = Request::display_hold(
            Owner {
                session_id: owner.session_id.clone(),
                call_id: format!("{}:display-owner", owner.call_id),
            },
            directory.to_string_lossy().into(),
            std::process::id(),
        );
        let result = self.coordinator.invoke.invoke(request, signal).await;
        if let Err(error) = result {
            if error.code == Code::BackgroundUnavailable {
                std::fs::remove_dir_all(&directory).map_err(|_| {
                    NativeError::new(
                        Code::NativeFailure,
                        "Could not clean the display control directory",
                        Outcome::NotStarted,
                    )
                })?;
            }
            if error.code != Code::BackgroundUnavailable {
                std::fs::write(directory.join("stop"), b"").map_err(|_| {
                    NativeError::new(
                        Code::NativeFailure,
                        "Could not stop the agent display owner",
                        Outcome::Unknown,
                    )
                })?;
            }
            return Err(error.into());
        }
        let output = result?;
        let display = output.detail.get("display");
        let id = display
            .and_then(|d| d.get("id"))
            .and_then(Value::as_u64)
            .and_then(|id| u32::try_from(id).ok())
            .filter(|id| *id > 0);
        let usable = display.is_some_and(|d| {
            ["width", "height"]
                .iter()
                .all(|name| d.get(*name).and_then(Value::as_f64).is_some_and(|n| n > 0.))
        });
        if !usable || id.is_none() {
            std::fs::write(directory.join("stop"), b"").map_err(|_| {
                NativeError::new(
                    Code::NativeFailure,
                    "Could not stop the agent display owner",
                    Outcome::Unknown,
                )
            })?;
            return Err(NativeError::new(
                Code::BackgroundUnavailable,
                "The agent display owner returned no usable display bounds",
                Outcome::NotStarted,
            )
            .into());
        }
        let id = id.ok_or_else(|| {
            NativeError::new(
                Code::BackgroundUnavailable,
                "The agent display owner returned no usable display bounds",
                Outcome::NotStarted,
            )
        })?;
        self.coordinator
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .displays
            .insert(self.location, Display { directory, id });
        Ok(id)
    }
    pub async fn stage(
        &self,
        owner: Owner,
        target: Target,
        revision: String,
    ) -> Result<Success, Error> {
        self.execute(Request::stage(owner, target, revision, 0)?)
            .await
    }
    pub async fn unstage(&self, owner: Owner, target: Target) -> Result<Success, Error> {
        let window = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .staged
            .get(&(self.location, target.key()))
            .cloned()
            .ok_or_else(|| {
                NativeError::new(
                    Code::TargetNotFound,
                    "Window is not staged in this Location",
                    Outcome::NotStarted,
                )
            })?;
        if window.session != owner.session_id {
            return Err(Error::Ownership(
                "Window is staged by another Session".into(),
            ));
        }
        self.execute(Request::unstage(owner, target, window.frame)?)
            .await
    }
    fn remove_staged(&self, key: &str) -> Result<(), Error> {
        self.coordinator
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .staged
            .remove(&(self.location, key.into()));
        self.stop_display_when_empty()
    }
    fn stop_display_when_empty(&self) -> Result<(), Error> {
        let mut state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state
            .staged
            .keys()
            .any(|(location, _)| *location == self.location)
        {
            return Ok(());
        }
        if let Some(display) = state.displays.get(&self.location) {
            std::fs::write(display.directory.join("stop"), b"").map_err(|_| {
                NativeError::new(
                    Code::NativeFailure,
                    "Could not stop the agent display owner",
                    Outcome::Unknown,
                )
            })?;
            state.displays.remove(&self.location);
        }
        Ok(())
    }
    pub async fn release_session(&self, session: &str) -> Result<(), Error> {
        self.coordinator.release_session(session).await
    }
    pub async fn release_location(&self) -> Result<(), Error> {
        self.release(None).await
    }
    async fn release(&self, session: Option<&str>) -> Result<(), Error> {
        let windows = {
            let mut state = self
                .coordinator
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            state.claims.retain(|_, claim| {
                !(claim.location == self.location
                    && session.is_none_or(|session| claim.session == session))
            });
            for active in state.calls.values().filter(|active| {
                active.location == self.location
                    && session.is_none_or(|session| active.session == session)
            }) {
                active.cancellation.send_replace(true);
            }
            state
                .staged
                .iter()
                .filter(|((location, _), window)| {
                    *location == self.location
                        && session.is_none_or(|session| window.session == session)
                })
                .map(|(_, window)| window.clone())
                .collect::<Vec<_>>()
        };
        let mut failure = None;
        for window in windows {
            let call = super::super::identifier("display-restore-").map_err(|error| {
                NativeError::new(Code::NativeFailure, error.to_string(), Outcome::NotStarted)
            })?;
            if let Err(error) = self
                .unstage(
                    Owner {
                        session_id: window.session,
                        call_id: call,
                    },
                    window.target,
                )
                .await
                && failure.is_none()
            {
                failure = Some(error);
            }
        }
        self.stop_display_when_empty()?;
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn frame(value: Option<&Value>) -> Option<super::electron::Rect> {
    let value = value?;
    Some(super::electron::Rect {
        x: value.get("x")?.as_f64()?,
        y: value.get("y")?.as_f64()?,
        width: value.get("width")?.as_f64()?,
        height: value.get("height")?.as_f64()?,
    })
}
