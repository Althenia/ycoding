use super::{
    Authority, ConsentError, Driver, Error, Native, Operation, now, refused, text, uuid, validation,
};
use crate::platform::computer::Future;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};

pub const APPLICATION: &str = "YCoding Interaction.app";
pub const BUNDLE_ID: &str = "app.ycoding.interaction";
pub const EXECUTABLE: &str = "ycoding-interaction";
pub const SIGNING_SHA1: &str = "9dd524184b0db949ffac7f0ada0ae860ac7f5f85";
pub struct IsolatedConsent {
    link: Arc<Link>,
    candidate: String,
}
impl IsolatedConsent {
    pub fn cancelled(&self) -> watch::Receiver<bool> {
        self.link.cancel.subscribe()
    }
    pub async fn bind(&self, lease: &str, cancel: watch::Receiver<bool>) -> Result<bool, Error> {
        let reply = self
            .link
            .request(
                "bindIsolated",
                json!({"candidateID":self.candidate,"lease":lease}),
                cancel,
            )
            .await?;
        Ok(
            text(&reply, "candidateID").eq_ignore_ascii_case(&self.candidate)
                && text(&reply, "lease").eq_ignore_ascii_case(lease),
        )
    }
    pub async fn close(&self) -> Result<(), Error> {
        self.link.close();
        self.link.join().await
    }
}
pub type Verify = Arc<dyn Fn(String, watch::Receiver<bool>) -> Future<'static, bool> + Send + Sync>;
pub struct Options {
    pub application: PathBuf,
    pub executable: PathBuf,
    pub verify: Verify,
}
pub struct Adapter {
    options: Options,
    native: Mutex<Option<Native>>,
    offers: Mutex<HashMap<String, Offer>>,
    claims: Mutex<HashMap<String, Arc<Claim>>>,
    prepared: Mutex<HashMap<String, (Arc<Claim>, Value)>>,
    identities: Mutex<HashMap<String, String>>,
    approving: Mutex<HashSet<String>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    cancel: watch::Sender<bool>,
}
struct Offer {
    request: Value,
    windows: HashMap<String, (Value, Value)>,
}
struct Claim {
    target: Value,
    window: Value,
    lease: String,
    link: Arc<Link>,
    state: Mutex<ClaimState>,
}
#[derive(Default)]
struct ClaimState {
    last: u64,
    revision: Option<(u64, String, HashMap<String, String>)>,
    paused: Option<String>,
    confirmation: Option<(Value, u64, Value, String, u64)>,
}
impl Adapter {
    pub async fn confirm_isolated(
        self: &Arc<Self>,
        request: Value,
        cancel: watch::Receiver<bool>,
    ) -> Result<Option<IsolatedConsent>, Error> {
        if request["expiresAt"]
            .as_u64()
            .is_none_or(|v| v <= now() || v > now() + 60000)
        {
            return Ok(None);
        }
        let Ok(link) = self.start(cancel.clone()).await else {
            return Ok(None);
        };
        let result = link
            .request("confirmIsolated", json!({"isolated":request}), cancel)
            .await;
        if result.as_ref().is_ok_and(|v| {
            v["consent"] == "approved"
                && text(v, "candidateID").eq_ignore_ascii_case(text(&request, "candidateID"))
        }) {
            return Ok(Some(IsolatedConsent {
                link,
                candidate: text(&request, "candidateID").into(),
            }));
        }
        link.close();
        link.join().await?;
        Ok(None)
    }
    pub fn installed(application: PathBuf, certificate_sha1: &str) -> Result<Arc<Self>, Error> {
        if !cfg!(target_os = "macos")
            || !application.is_absolute()
            || application.file_name().is_none_or(|n| n != APPLICATION)
            || certificate_sha1.len() != 40
            || !certificate_sha1.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(Error("unavailable"));
        }
        let requirement = format!(
            "=identifier \"{BUNDLE_ID}\" and certificate leaf = H\"{}\"",
            certificate_sha1.to_ascii_lowercase()
        );
        let verify: Verify = Arc::new(move |subject, mut cancel| {
            let requirement = requirement.clone();
            Box::pin(async move {
                let mut command = tokio::process::Command::new("/usr/bin/codesign");
                command
                    .args([
                        "--verify",
                        "--strict",
                        "--verbose=1",
                        "-R",
                        &requirement,
                        &subject,
                    ])
                    .kill_on_drop(true)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                tokio::select! {result=command.status()=>result.is_ok_and(|s|s.success()),_=cancel.wait_for(|v|*v)=>false}
            })
        });
        let executable = application.join("Contents/MacOS").join(EXECUTABLE);
        Ok(Self::new(Options {
            application,
            executable,
            verify,
        }))
    }
    pub fn new(options: Options) -> Arc<Self> {
        Arc::new(Self {
            options,
            native: Mutex::new(None),
            offers: Mutex::new(HashMap::new()),
            claims: Mutex::new(HashMap::new()),
            prepared: Mutex::new(HashMap::new()),
            identities: Mutex::new(HashMap::new()),
            approving: Mutex::new(HashSet::new()),
            tasks: Mutex::new(vec![]),
            cancel: watch::channel(false).0,
        })
    }
    pub fn mount(self: &Arc<Self>, authority: &Arc<Authority>) -> Result<Native, Error> {
        let native = authority.register("macos", Arc::new(MacDriver(Arc::downgrade(self))))?;
        let mut events = native.subscribe().ok_or(Error("unavailable"))?;
        *self.native.lock().unwrap_or_else(|e| e.into_inner()) = Some(native.clone());
        let weak = Arc::downgrade(self);
        let mut cancel = self.cancel.subscribe();
        let channel = native.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _=cancel.wait_for(|v|*v)=>break,
                    event=events.recv()=>match event {
                        Ok((key,request))if key=="macos"=>{
                            let Some(adapter)=weak.upgrade()else{break;};
                            let native=channel.clone();
                            let id=text(&request,"candidateID").to_owned();
                            let pending=tokio::spawn(async move{
                                let Some(scoped)=native.cancellation(&id)else{return;};
                                let choice=request.clone();
                                native.consent(&request,scoped,move|targets,scoped|async move{
                                    let selected=adapter.choose(&choice,&targets,scoped.clone()).await.map_err(|_|Error("not_chosen"))?.ok_or(Error("not_chosen"))?;
                                    if *scoped.borrow(){return Err(Error("aborted").into());}
                                    adapter.approve(&id,&selected,scoped).await
                                }).await;
                            });
                            if let Some(adapter)=weak.upgrade(){adapter.tasks.lock().unwrap_or_else(|e|e.into_inner()).push(pending);}
                        },
                        Ok(_)=>{},Err(_)=>break,
                    }
                }
            }
        });
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(task);
        Ok(native)
    }
    async fn start(self: &Arc<Self>, cancel: watch::Receiver<bool>) -> Result<Arc<Link>, Error> {
        if *self.cancel.borrow() || *cancel.borrow() {
            return Err(Error("stopped"));
        }
        let file = tokio::fs::File::open(&self.options.executable)
            .await
            .map_err(|_| Error("unavailable"))?;
        let before = file.metadata().await.map_err(|_| Error("unavailable"))?;
        if !before.is_file()
            || !(self.options.verify)(
                self.options.application.to_string_lossy().into_owned(),
                cancel.clone(),
            )
            .await
        {
            return Err(Error("unavailable"));
        }
        let after = tokio::fs::metadata(&self.options.executable)
            .await
            .map_err(|_| Error("unavailable"))?;
        if !same_file(&before, &after) {
            return Err(Error("unavailable"));
        }
        let weak = Arc::downgrade(self);
        let link = Link::start(
            &self.options.executable,
            Arc::new(move |event| {
                if let Some(adapter) = weak.upgrade() {
                    adapter.event(event);
                }
            }),
        )
        .await?;
        if !(self.options.verify)(link.pid.to_string(), cancel.clone()).await {
            link.close();
            link.join().await?;
            return Err(Error("unavailable"));
        }
        if let Err(error) = link
            .request(
                "hello",
                json!({"version":1,"ownerPID":std::process::id()}),
                cancel,
            )
            .await
        {
            link.close();
            link.join().await?;
            return Err(error.into());
        }
        Ok(link)
    }
    fn event(&self, event: Value) {
        let lease = text(&event, "lease").to_ascii_lowercase();
        let claim = self
            .claims
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&lease)
            .cloned();
        let native = self
            .native
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let (Some(claim), Some(native)) = (claim, native) else {
            return;
        };
        match text(&event, "state") {
            "paused" => {
                let reason = text(&event, "reason");
                if validation::pause_reason(reason) {
                    let mut state = claim.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.paused = Some(reason.into());
                    state.revision = None;
                    state.confirmation = None;
                    drop(state);
                    native.pause(&lease, reason);
                }
            }
            "resumed" => {
                claim.state.lock().unwrap_or_else(|e| e.into_inner()).paused = None;
                native.resume(&lease);
            }
            _ => {
                native.stop(
                    &lease,
                    if event["state"] == "stopped" {
                        "stopped"
                    } else {
                        "target_lost"
                    },
                );
                claim.link.close();
            }
        }
    }
    pub async fn available(self: &Arc<Self>, cancel: watch::Receiver<bool>) -> bool {
        let result = self.start(cancel).await;
        if let Ok(link) = result {
            link.close();
            link.join().await.is_ok()
        } else {
            false
        }
    }
    pub fn profile_confirmation(self: &Arc<Self>) -> super::chrome::Confirm {
        let weak = Arc::downgrade(self);
        Arc::new(move |profile, cancel| {
            let weak = weak.clone();
            Box::pin(async move {
                let Some(adapter) = weak.upgrade() else {
                    return false;
                };
                let Ok(link) = adapter.start(cancel.clone()).await else {
                    return false;
                };
                let mut profile = profile;
                profile["expiresAt"] = json!(now() + 60000);
                let result = link
                    .request("confirmChromeProfile", json!({"profile":profile}), cancel)
                    .await
                    .is_ok_and(|r| r["consent"] == "approved");
                link.close();
                result && link.join().await.is_ok()
            })
        })
    }
    async fn choose(
        self: &Arc<Self>,
        request: &Value,
        targets: &[Value],
        cancel: watch::Receiver<bool>,
    ) -> Result<Option<String>, Error> {
        let windows = {
            let offers = self.offers.lock().unwrap_or_else(|e| e.into_inner());
            let offer = offers
                .get(text(request, "candidateID"))
                .ok_or(Error("stale"))?;
            targets
                .iter()
                .map(|t| {
                    offer
                        .windows
                        .get(text(t, "id"))
                        .map(|(_, w)| json!({"id":t["id"],"target":w}))
                })
                .collect::<Option<Vec<_>>>()
                .ok_or(Error("stale"))?
        };
        if windows.is_empty() || windows.len() > 64 {
            return Ok(None);
        }
        if request["purpose"] == "confirm" {
            return Ok(windows
                .first()
                .filter(|t| t["id"] == request["targetID"])
                .map(|t| text(t, "id").into()));
        }
        let link = self.start(cancel.clone()).await?;
        let result=link.request("choose",json!({"choices":{"candidateID":request["candidateID"],"sessionID":request["sessionID"],"expiresAt":request["expiresAt"],"windows":windows}}),cancel).await;
        link.close();
        link.join().await?;
        let reply = result?;
        let selected = text(&reply, "selected").to_ascii_lowercase();
        Ok(windows
            .iter()
            .any(|t| t["id"] == selected)
            .then_some(selected))
    }
    pub async fn approve(
        self: &Arc<Self>,
        candidate: &str,
        target_id: &str,
        cancel: watch::Receiver<bool>,
    ) -> Result<(), ConsentError> {
        let prepared = {
            let offers = self.offers.lock().unwrap_or_else(|e| e.into_inner());
            offers.get(candidate).and_then(|o| {
                o.windows
                    .get(target_id)
                    .map(|(t, w)| (o.request.clone(), t.clone(), w.clone()))
            })
        };
        let Some((request, target, window)) = prepared else {
            return Err(Error("stale").into());
        };
        if request["expiresAt"].as_u64().is_none_or(|v| v <= now())
            || *cancel.borrow()
            || *self.cancel.borrow()
        {
            return Err(Error("stale").into());
        }
        let scope = super::Scope::new(
            cancel,
            Duration::from_millis(
                request["expiresAt"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_sub(now())
                    .min(60_000),
            ),
        );
        let mut cancel = scope.cancel.subscribe();
        let Some(native) = self
            .native
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        else {
            return Err(Error("stale").into());
        };
        if !native
            .pending()
            .iter()
            .any(|p| p["candidateID"] == candidate && p["sessionID"] == request["sessionID"])
            || !self
                .approving
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(candidate.into())
        {
            return Err(Error("stale").into());
        }
        let _approval = Approval {
            adapter: self,
            candidate,
        };
        let Ok(authorization) = uuid() else {
            return Err(Error("error").into());
        };
        let proof = json!({"candidateID":candidate,"sessionID":request["sessionID"],"targetID":target_id,"authorization":authorization});
        let result: Result<(), ConsentError> = async {
            if request["purpose"] == "confirm" {
                let claim = self
                    .claims
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .values()
                    .find(|c| c.target["id"] == target_id)
                    .cloned()
                    .ok_or(Error("stale"))?;
                let revision = claim
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .revision
                    .clone()
                    .ok_or(Error("stale"))?;
                let (number, stamp, controls) = &revision;
                if request["revision"] != *number
                    || request["action"]["platform"] != "macos"
                    || *claim.link.cancel.borrow()
                {
                    return Err(Error("stale").into());
                }
                let mut wire = wire_action(&request["action"], controls)?;
                wire["target"] = window;
                wire["lease"] = json!(claim.lease);
                wire["revision"] = json!(stamp);
                let mut reply = claim
                    .link
                    .request("authorize", wire.clone(), cancel.clone())
                    .await;
                for delay in [100, 200, 400, 800] {
                    if !reply
                        .as_ref()
                        .is_err_and(|error| matches!(error.0.as_str(), "unverified" | "busy"))
                    {
                        break;
                    }
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(delay)) => {},
                        _ = cancel.wait_for(|v| *v) => return Err(Error("stale").into()),
                    }
                    if *cancel.borrow()
                        || *claim.link.cancel.borrow()
                        || claim
                            .state
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .revision
                            .as_ref()
                            != Some(&revision)
                    {
                        return Err(Error("stale").into());
                    }
                    reply = claim
                        .link
                        .request("authorize", wire.clone(), cancel.clone())
                        .await;
                }
                let reply = reply?;
                if *cancel.borrow()
                    || *claim.link.cancel.borrow()
                    || claim
                        .state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .revision
                        .as_ref()
                        != Some(&revision)
                {
                    return Err(Error("stale").into());
                }
                if !validation::id(&text(&reply, "authorization").to_ascii_lowercase()) {
                    return Err(Error("invalid_reply").into());
                }
                {
                    let mut state = claim.state.lock().unwrap_or_else(|e| e.into_inner());
                    if state.revision.as_ref() != Some(&revision) {
                        return Err(Error("stale").into());
                    }
                    state.confirmation = Some((
                        proof.clone(),
                        *number,
                        request["action"].clone(),
                        text(&reply, "authorization").into(),
                        request["expiresAt"].as_u64().unwrap_or(0),
                    ));
                }
                let accepted = native.approve(proof).await;
                if !accepted {
                    claim
                        .state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .confirmation = None;
                }
                return if accepted {
                    Ok(())
                } else {
                    Err(Error("authority_declined").into())
                };
            }
            let link = self.start(cancel.clone()).await?;
            let reply = match link
                .request("attach", json!({"target":window}), cancel.clone())
                .await
            {
                Ok(reply) => reply,
                Err(error) => {
                    link.close();
                    link.join().await?;
                    return Err(error);
                }
            };
            let lease = text(&reply, "lease").to_ascii_lowercase();
            if *link.cancel.borrow() || *cancel.borrow() {
                link.close();
                link.join().await?;
                return Err(Error("stale").into());
            }
            if !validation::id(&lease) {
                link.close();
                link.join().await?;
                return Err(Error("invalid_reply").into());
            }
            let claim = Arc::new(Claim {
                target,
                window,
                lease: lease.clone(),
                link: link.clone(),
                state: Mutex::new(ClaimState::default()),
            });
            self.prepared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(authorization.clone(), (claim, proof.clone()));
            let accepted = native.approve(proof).await;
            self.prepared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&authorization);
            if !accepted {
                link.close();
                link.join().await?;
            }
            if accepted && !*link.cancel.borrow() {
                Ok(())
            } else {
                Err(Error("authority_declined").into())
            }
        }
        .await;
        result
    }
    async fn operation(
        self: &Arc<Self>,
        op: Operation,
        input: Value,
        cancel: watch::Receiver<bool>,
    ) -> Result<Value, Error> {
        if op == Operation::Inventory {
            let mut windows = HashMap::new();
            if input["purpose"] == "confirm" {
                if let Some(claim) = self
                    .claims
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .values()
                    .find(|c| c.target["id"] == input["targetID"])
                    .cloned()
                {
                    windows.insert(
                        text(&claim.target, "id").to_owned(),
                        (claim.target.clone(), claim.window.clone()),
                    );
                }
            } else if input["selection"]["platform"] == "macos" {
                let link = self.start(cancel.clone()).await?;
                let result = link.request("inventory", json!({}), cancel).await;
                link.close();
                link.join().await?;
                let result = result?;
                let targets = result["targets"]
                    .as_array()
                    .filter(|v| v.len() <= 64)
                    .ok_or(Error("unavailable"))?;
                for entry in targets {
                    let window = &entry["target"];
                    if !exact_window(window) || !entry["label"].is_string() {
                        continue;
                    }
                    let key = window.to_string();
                    let id = {
                        let mut identities =
                            self.identities.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(id) = identities.get(&key) {
                            id.clone()
                        } else {
                            let id = uuid()?;
                            identities.insert(key, id.clone());
                            id
                        }
                    };
                    let target = json!({"kind":"macos-window","id":id,"bundleID":window["bundleID"],"label":label(&format!("{} · Window {}",text(entry,"label"),window["windowID"]))});
                    windows.insert(id, (target, window.clone()));
                }
            }
            let result = windows.values().map(|(t, _)| t.clone()).collect::<Vec<_>>();
            let mut offers = self.offers.lock().unwrap_or_else(|e| e.into_inner());
            offers.retain(|_, o| o.request["expiresAt"].as_u64().is_some_and(|v| v > now()));
            offers.insert(
                text(&input, "candidateID").into(),
                Offer {
                    request: input,
                    windows,
                },
            );
            return Ok(json!(result));
        }
        if op == Operation::Attach {
            let proof = &input["proof"];
            let ready = self
                .prepared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(text(proof, "authorization"))
                .ok_or(Error("notAuthorized"))?;
            if ready.1 != *proof || ready.0.target != input["target"] || *cancel.borrow() {
                ready.0.link.close();
                return Err(Error("notAuthorized"));
            }
            let lease = ready.0.lease.clone();
            self.claims
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(lease.clone(), ready.0);
            return Ok(json!({"id":lease}));
        }
        let id = text(&input, "id");
        let claim = self
            .claims
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or(Error("target_lost"))?;
        if op == Operation::Detach {
            self.claims
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(id);
            let result = claim
                .link
                .request("detach", json!({"lease":id}), cancel)
                .await;
            claim.link.close();
            claim.link.join().await?;
            return result.map_err(Error::from);
        }
        if op == Operation::Run {
            return Ok(refused("unsupported"));
        }
        if let Some(reason) = claim
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .paused
            .clone()
            && !matches!(op, Operation::Resume | Operation::Preview)
        {
            return if op == Operation::Observe {
                Err(Error("paused"))
            } else {
                Ok(json!({"outcome":"paused","reason":reason}))
            };
        }
        match op {
            Operation::Observe => {
                {
                    let mut state = claim.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.revision = None;
                    state.confirmation = None;
                }
                let reply = claim
                    .link
                    .request("observe", json!({"target":claim.window,"lease":id}), cancel)
                    .await?;
                let observed = &reply["observation"];
                let stamp = text(observed, "revision");
                if stamp.len() != 64 || !stamp.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(Error("unavailable"));
                }
                let controls = observed["controls"]
                    .as_array()
                    .filter(|v| v.len() <= 200)
                    .ok_or(Error("unavailable"))?;
                let mut mapping = HashMap::new();
                let mut elements = vec![];
                for control in controls {
                    let native = text(control, "id");
                    if native.split('.').count() > 17
                        || native.split('.').next() != Some("0")
                        || !native
                            .split('.')
                            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                        || !control["role"].is_string()
                        || !control["label"].is_string()
                        || !control["actions"].is_array()
                    {
                        return Err(Error("unavailable"));
                    }
                    let id = uuid()?;
                    mapping.insert(id.clone(), native.into());
                    elements.push(json!({"id":id,"role":label(text(control,"role")),"label":label(text(control,"label")),"editable":control["actions"].as_array().is_some_and(|a|a.contains(&json!("replaceText")))}));
                }
                let mut state = claim.state.lock().unwrap_or_else(|e| e.into_inner());
                state.last += 1;
                let number = state.last;
                state.revision = Some((number, stamp.into(), mapping));
                Ok(json!({"revision":number,"elements":elements}))
            }
            Operation::Perform => {
                let action = &input["action"];
                let revision = input["revision"].as_u64().ok_or(Error("stale"))?;
                let (current, confirmation) = {
                    let state = claim.state.lock().unwrap_or_else(|e| e.into_inner());
                    (state.revision.clone(), state.confirmation.clone())
                };
                let Some((number, stamp, controls)) = current else {
                    return Ok(refused("stale"));
                };
                if number != revision || *cancel.borrow() {
                    return Ok(refused("stale"));
                }
                let authorized = confirmation
                    .as_ref()
                    .is_some_and(|(proof, r, a, _, expires)| {
                        input["consent"] == *proof
                            && *r == revision
                            && a == action
                            && *expires > now()
                    });
                if (action["type"] == "press" || action["destructive"] == true) && !authorized {
                    return Ok(refused("confirmation_required"));
                }
                let mut fields = wire_action(action, &controls)?;
                fields["target"] = claim.window.clone();
                fields["lease"] = json!(id);
                fields["revision"] = json!(stamp);
                if let Some((_, _, _, receipt, _)) = confirmation {
                    fields["authorization"] = json!(receipt);
                }
                {
                    let mut state = claim.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.revision = None;
                    state.confirmation = None;
                }
                match claim.link.request("perform", fields, cancel).await {
                    Ok(_) => Ok(json!({"outcome":"applied"})),
                    Err(error) if error.0 == "paused" => Ok(
                        json!({"outcome":"paused","reason":claim.state.lock().unwrap_or_else(|e|e.into_inner()).paused.clone().ok_or(Error("stale"))?}),
                    ),
                    Err(error) if error.0 == "uncertain" => Ok(json!({"outcome":"uncertain"})),
                    Err(error) => {
                        if error.0 == "confirmationRequired" {
                            claim
                                .state
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .revision = Some((number, stamp, controls));
                        }
                        Ok(refused(refusal(&error.0)))
                    }
                }
            }
            Operation::Preview => {
                let reply = claim
                    .link
                    .request("preview", json!({"target":claim.window,"lease":id}), cancel)
                    .await?;
                let frame = json!({"mimeType":"image/jpeg","base64":reply["preview"]["image"],"width":reply["preview"]["width"],"height":reply["preview"]["height"]});
                Ok(
                    if text(&reply, "lease").eq_ignore_ascii_case(id) && validation::frame(&frame) {
                        frame
                    } else {
                        Value::Null
                    },
                )
            }
            Operation::Resume => {
                let reply = claim
                    .link
                    .request("resume", json!({"lease":id}), cancel)
                    .await?;
                let resumed = text(&reply, "lease").eq_ignore_ascii_case(id);
                if resumed {
                    claim.state.lock().unwrap_or_else(|e| e.into_inner()).paused = None;
                }
                Ok(json!(resumed))
            }
            _ => Err(Error("unsupported")),
        }
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        self.cancel.send_replace(true);
        if let Some(native) = self.native.lock().unwrap_or_else(|e| e.into_inner()).take() {
            native.disconnect();
        }
        let claims = self
            .claims
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for claim in &claims {
            claim.link.close();
        }
        for claim in claims {
            claim.link.join().await?;
        }
        loop {
            let tasks = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(|e| e.into_inner()));
            if tasks.is_empty() {
                break;
            }
            for task in tasks {
                task.await.map_err(|_| Error("unavailable"))?;
            }
        }
        Ok(())
    }
}
impl Drop for Adapter {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
        for claim in self
            .claims
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            claim.link.close();
        }
    }
}
struct MacDriver(Weak<Adapter>);
impl Driver for MacDriver {
    fn platform(&self) -> &'static str {
        "macos"
    }
    fn call(
        &self,
        op: Operation,
        input: Value,
        cancel: watch::Receiver<bool>,
    ) -> Future<'_, Result<Value, Error>> {
        Box::pin(async move {
            self.0
                .upgrade()
                .ok_or(Error("unavailable"))?
                .operation(op, input, cancel)
                .await
        })
    }
}
struct WireRequest {
    operation: String,
    body: Value,
    reply: oneshot::Sender<Result<Value, ConsentError>>,
}
struct Approval<'a> {
    adapter: &'a Adapter,
    candidate: &'a str,
}
impl Drop for Approval<'_> {
    fn drop(&mut self) {
        self.adapter
            .approving
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(self.candidate);
        self.adapter
            .offers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(self.candidate);
    }
}
struct Link {
    pid: u32,
    requests: mpsc::Sender<WireRequest>,
    cancel: watch::Sender<bool>,
    task: tokio::sync::Mutex<Option<JoinHandle<Result<(), Error>>>>,
}
impl Link {
    async fn start(
        executable: &Path,
        event: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Result<Arc<Self>, Error> {
        let mut command = tokio::process::Command::new(executable);
        command.env_clear();
        for key in ["HOME", "TMPDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| Error("unavailable"))?;
        let pid = child.id().ok_or(Error("unavailable"))?;
        let mut input = child.stdin.take().ok_or(Error("unavailable"))?;
        let output = child.stdout.take().ok_or(Error("unavailable"))?;
        let generation = uuid()?;
        let (requests, mut receive) = mpsc::channel::<WireRequest>(4);
        let (cancel, mut cancelled) = watch::channel(false);
        let ended = cancel.clone();
        let task = tokio::spawn(async move {
            let mut reader = BufReader::new(output);
            let mut line = Vec::new();
            let mut next = 0u32;
            let mut waiting = HashMap::new();
            let mut lease = String::new();
            loop {
                let mut bounded = (&mut reader).take(1048577);
                tokio::select! {
                    _=async { let _=cancelled.wait_for(|v|*v).await; }=>break,
                    request=receive.recv()=>{let Some(request)=request else{break;};if next==u32::MAX || waiting.len()>=4{let _=request.reply.send(Err(Error("busy").into()));continue;}next+=1;let mut body=request.body;body["id"]=json!(next);body["generation"]=json!(generation);body["operation"]=json!(request.operation);let payload=body.to_string();if payload.len()>1048576{let _=request.reply.send(Err(Error("invalidRequest").into()));continue;}waiting.insert(next,(request.operation,request.reply));if input.write_all(format!("{payload}\n").as_bytes()).await.is_err(){break;}},
                    result=bounded.read_until(b'\n',&mut line)=>{
                        if !matches!(result,Ok(n)if n>0) || line.len()>1048576{break;}let Ok(reply)=serde_json::from_slice::<Value>(&line)else{break;};line.clear();if !text(&reply,"generation").eq_ignore_ascii_case(&generation){break;}
                        if reply.get("id").is_none(){if matches!(text(&reply,"state"),"stopped"|"resumed") && validation::id(&text(&reply,"lease").to_ascii_lowercase()){event(reply);continue;}break;}
                        let Some(id)=reply["id"].as_u64().and_then(|n|u32::try_from(n).ok())else{break;};let Some((op,sender))=waiting.remove(&id)else{break;};
                        if op=="attach" && validation::id(&text(&reply,"lease").to_ascii_lowercase()){lease=text(&reply,"lease").to_ascii_lowercase();}
                        let result=match text(&reply,"state"){"ok"=>Ok(reply),"paused" if validation::pause_reason(text(&reply,"reason")) && validation::id(&text(&reply,"lease").to_ascii_lowercase())=>{event(reply);Err(Error("paused").into())},"uncertain"=>Err(Error("uncertain").into()),"refused" if !text(&reply,"code").is_empty() && text(&reply,"code").len()<=40 && text(&reply,"code").bytes().all(|b|b.is_ascii_alphabetic())=>Err(ConsentError(text(&reply,"code").into())),_=>{let _=sender.send(Err(Error(if op=="perform"{"uncertain"}else{"unavailable"}).into()));break;}};let _=sender.send(result);
                    }
                }
            }
            drop(input);
            let killed = match child.try_wait() {
                Ok(Some(_)) => Ok(()),
                Ok(None) => child.start_kill().map_err(|_| Error("cleanup")),
                Err(_) => Err(Error("cleanup")),
            };
            let waited = child.wait().await.map(|_| ()).map_err(|_| Error("cleanup"));
            for (_, (op, sender)) in waiting {
                let _ = sender.send(Err(Error(if op == "perform" {
                    "uncertain"
                } else {
                    "unavailable"
                })
                .into()));
            }
            ended.send_replace(true);
            event(json!({"state":"disconnected","lease":lease}));
            killed.and(waited)
        });
        Ok(Arc::new(Self {
            pid,
            requests,
            cancel,
            task: tokio::sync::Mutex::new(Some(task)),
        }))
    }
    async fn request(
        &self,
        operation: &str,
        body: Value,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<Value, ConsentError> {
        if *self.cancel.borrow() || *cancel.borrow() {
            return Err(Error("stopped").into());
        }
        let mut lifetime = self.cancel.subscribe();
        let (reply, receive) = oneshot::channel();
        let request = WireRequest {
            operation: operation.into(),
            body,
            reply,
        };
        let result = tokio::select! {biased;result=async{self.requests.send(request).await.map_err(|_|Error("unavailable"))?;receive.await.map_err(|_|Error("unavailable"))?}=>result,_=cancel.wait_for(|v|*v)=>Err(Error("stopped").into()),_=lifetime.wait_for(|v|*v)=>Err(Error(if operation=="perform"{"uncertain"}else{"unavailable"}).into()),_=tokio::time::sleep(Duration::from_secs(if matches!(operation,"choose"|"authorize"|"confirmChromeProfile"|"confirmIsolated"){60}else{10}))=>Err(Error("uncertain").into())};
        if result
            .as_ref()
            .is_err_and(|error| matches!(error.0.as_str(), "stopped" | "uncertain"))
        {
            self.close();
        }
        result
    }
    fn close(&self) {
        self.cancel.send_replace(true);
    }
    async fn join(&self) -> Result<(), Error> {
        if let Some(task) = self.task.lock().await.take() {
            task.await.map_err(|_| Error("unavailable"))??;
        }
        Ok(())
    }
}
impl Drop for Link {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}
fn wire_action(action: &Value, controls: &HashMap<String, String>) -> Result<Value, Error> {
    if action["platform"] != "macos" {
        return Err(Error("policy"));
    }
    if action["type"] == "scroll" {
        return Ok(json!({"action":"scroll","deltaY":action["deltaY"]}));
    }
    let control = controls
        .get(text(action, "elementID"))
        .ok_or(Error("staleRevision"))?;
    let mut fields = json!({"action":if action["type"]=="press"{"press"}else{"replaceText"},"controlID":control});
    if action.get("destructive").is_some() {
        fields["destructive"] = action["destructive"].clone();
    }
    if action["type"] == "setValue" {
        fields["text"] = action["text"].clone();
    }
    Ok(fields)
}
fn exact_window(window: &Value) -> bool {
    window["pid"]
        .as_u64()
        .is_some_and(|n| (2..=2147483647).contains(&n))
        && window["windowID"]
            .as_u64()
            .is_some_and(|n| (1..=4294967295).contains(&n))
        && text(window, "started")
            .split_once(':')
            .is_some_and(|(a, b)| {
                !a.is_empty()
                    && a.len() <= 18
                    && !b.is_empty()
                    && b.len() <= 6
                    && a.bytes().chain(b.bytes()).all(|c| c.is_ascii_digit())
            })
        && text(window, "bundleID").len() <= 256
        && text(window, "bundleID").split('.').count() > 1
        && text(window, "bundleID")
            .split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}
fn label(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{200b}' | '\u{202e}'))
        .take(256)
        .collect()
}
impl From<ConsentError> for Error {
    fn from(error: ConsentError) -> Self {
        Self(native_code(&error.0))
    }
}
fn native_code(code: &str) -> &'static str {
    match code {
        "staleRevision" => "staleRevision",
        "stopped" => "stopped",
        "sensitive" => "sensitive",
        "captcha" => "captcha",
        "permissionMissing" => "permissionMissing",
        "notAuthorized" => "notAuthorized",
        "targetChanged" => "targetChanged",
        "unavailable" => "unavailable",
        "confirmationRequired" => "confirmationRequired",
        "busy" => "busy",
        "paused" => "paused",
        "unsupported" => "unsupported",
        "unverified" => "unverified",
        _ => "invalid",
    }
}
fn refusal(code: &str) -> &'static str {
    match code {
        "staleRevision" | "stopped" => "stale",
        "sensitive" => "sensitive",
        "captcha" => "captcha",
        "permissionMissing" | "notAuthorized" => "permission",
        "targetChanged" | "unavailable" => "target_lost",
        "confirmationRequired" => "confirmation_required",
        "busy" | "paused" => "busy",
        "unsupported" | "unverified" => "unsupported",
        _ => "policy",
    }
}
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.len() == b.len()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        a.len() == b.len() && a.modified().ok() == b.modified().ok()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn executable(source: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("ycoding-interaction-helper-{}", uuid().unwrap()));
        std::fs::write(&path, format!("#!/bin/sh\n{source}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
    #[tokio::test]
    async fn helper_disconnect_revokes_the_bound_lease_and_notifies_its_lifetime() {
        let executable = executable(
            r#"while IFS= read -r line; do
case "$line" in *'"operation":"die"'*) exit 0;; esac
id=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"id":\([0-9]*\).*/\1/p')
generation=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"generation":"\([^"]*\)".*/\1/p')
printf '{"id":%s,"generation":"%s","state":"ok","lease":"10000000-0000-4000-8000-000000000001"}\n' "$id" "$generation"
done"#,
        );
        let (events, mut receive) = mpsc::unbounded_channel();
        let link = Link::start(
            &executable,
            Arc::new(move |event| {
                events.send(event).unwrap();
            }),
        )
        .await
        .unwrap();
        let attached = link
            .request("attach", json!({}), super::super::signal())
            .await
            .unwrap();
        assert_eq!(attached["lease"], "10000000-0000-4000-8000-000000000001");
        assert!(
            link.request("die", json!({}), super::super::signal())
                .await
                .is_err()
        );
        link.join().await.unwrap();
        assert!(*link.cancel.borrow());
        let lost = receive.recv().await.unwrap();
        assert_eq!(lost["state"], "disconnected");
        assert_eq!(lost["lease"], attached["lease"]);
        std::fs::remove_file(executable).unwrap();
    }
    #[tokio::test]
    async fn helper_identity_and_generation_are_verified_before_accepting_replies() {
        let executable = executable(
            "while IFS= read -r line; do printf '{\"id\":1,\"generation\":\"invalid\",\"state\":\"ok\"}\\n'; done",
        );
        let adapter = Adapter::new(Options {
            application: PathBuf::from("/synthetic/YCoding Interaction.app"),
            executable: executable.clone(),
            verify: Arc::new(|_, _| Box::pin(async { false })),
        });
        assert!(!adapter.available(super::super::signal()).await);
        adapter.shutdown().await.unwrap();
        let link = Link::start(&executable, Arc::new(|_| {})).await.unwrap();
        assert_eq!(
            link.request("hello", json!({}), super::super::signal())
                .await,
            Err(ConsentError("unavailable".into()))
        );
        link.join().await.unwrap();
        assert!(*link.cancel.borrow());
        std::fs::remove_file(executable).unwrap();
    }
    async fn confirm_fixture(mode: &str) -> (Result<(), ConsentError>, Vec<String>) {
        let log =
            std::env::temp_dir().join(format!("ycoding-interaction-consent-{}", uuid().unwrap()));
        let executable = executable(&format!(
            r#"authorized=0
while IFS= read -r line; do
id=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"id":\([0-9]*\).*/\1/p')
generation=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"generation":"\([^"]*\)".*/\1/p')
operation=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"operation":"\([^"]*\)".*/\1/p')
printf '%s\n' "$operation" >> '{}'
state=ok
fields=''
case "$operation" in
inventory) fields=',"targets":[{{"target":{{"pid":4100,"started":"100:21","bundleID":"local.synthetic.Example","windowID":72}},"label":"Synthetic"}}]';;
attach|resume) fields=',"lease":"10000000-0000-4000-8000-000000000001"';;
observe) fields=',"lease":"10000000-0000-4000-8000-000000000001","observation":{{"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","controls":[{{"id":"0.1","role":"AXButton","label":"Increment","actions":["press"]}}]}}';;
authorize)
authorized=$((authorized + 1))
if [ '{mode}' = stopped ] || [ '{mode}' = revision ]; then state=refused; fields=',"code":"unverified"'
elif [ '{mode}' = cold ] && [ "$authorized" -eq 1 ]; then state=refused; fields=',"code":"unverified"'
elif [ '{mode}' = cold ] && [ "$authorized" -eq 2 ]; then state=refused; fields=',"code":"busy"'
elif [ '{mode}' = denied ]; then state=refused; fields=',"code":"notAuthorized"'
elif [ '{mode}' = busy ]; then state=refused; fields=',"code":"busy"'
elif [ '{mode}' = invalid ]; then fields=',"authorization":"invalid"'
elif [ '{mode}' = custom ]; then state=refused; fields=',"code":"customRefusal"'
else fields=',"authorization":"10000000-0000-4000-8000-000000000002"'; fi;;
esac
printf '{{"id":%s,"generation":"%s","state":"%s"%s}}\n' "$id" "$generation" "$state" "$fields"
if [ '{mode}' = stopped ] && [ "$operation" = authorize ]; then printf '{{"generation":"%s","state":"stopped","lease":"10000000-0000-4000-8000-000000000001"}}\n' "$generation"; fi
done"#,
            log.display()
        ));
        let adapter = Adapter::new(Options {
            application: PathBuf::from("/synthetic/YCoding Interaction.app"),
            executable: executable.clone(),
            verify: Arc::new(|_, _| Box::pin(async { true })),
        });
        let authority = Authority::new(super::super::Options::default());
        let native = authority
            .register("macos", Arc::new(MacDriver(Arc::downgrade(&adapter))))
            .unwrap();
        *adapter.native.lock().unwrap() = Some(native.clone());
        let status = authority
            .request("ses_confirm", json!({"platform":"macos"}))
            .unwrap();
        let generation = text(&status, "generation");
        let request = native.pending()[0].clone();
        let targets = native.inventory(text(&request, "candidateID")).await;
        assert_eq!(targets.len(), 1);
        adapter
            .approve(
                text(&request, "candidateID"),
                text(&targets[0], "id"),
                super::super::signal(),
            )
            .await
            .unwrap();
        let observation = authority.observe("ses_confirm", generation).await.unwrap();
        let action = json!({"platform":"macos","type":"press","elementID":observation["elements"][0]["id"],"destructive":true});
        assert!(
            authority
                .confirmation("ses_confirm", generation, 1, action.clone())
                .unwrap()
                .is_none()
        );
        let request = native.pending()[0].clone();
        let targets = native.inventory(text(&request, "candidateID")).await;
        let approval = adapter.approve(
            text(&request, "candidateID"),
            text(&targets[0], "id"),
            super::super::signal(),
        );
        let approved = if mode == "revision" {
            let (approved, observed) =
                tokio::join!(biased;approval,authority.observe("ses_confirm",generation));
            assert_eq!(observed.unwrap()["revision"], 2);
            approved
        } else {
            approval.await
        };
        let result = authority
            .perform(
                "ses_confirm",
                generation,
                1,
                "10000000-0000-4000-8000-000000000003",
                action,
            )
            .await;
        if approved.is_ok() {
            assert_eq!(result["outcome"], "applied");
        } else if matches!(mode, "stopped" | "revision") {
            assert_eq!(result["reason"], "stale");
        } else {
            assert_eq!(result["reason"], "confirmation_required");
        }
        authority.shutdown().await.unwrap();
        adapter.shutdown().await.unwrap();
        let operations = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        std::fs::remove_file(log).unwrap();
        std::fs::remove_file(executable).unwrap();
        (approved, operations)
    }
    #[tokio::test]
    async fn confirmation_retries_only_pre_authentication_refusals() {
        let (approved, operations) = confirm_fixture("cold").await;
        assert_eq!(approved, Ok(()));
        assert_eq!(operations.iter().filter(|op| *op == "authorize").count(), 3);
    }
    #[tokio::test]
    async fn confirmation_preserves_declined_and_invalid_receipts_without_retry() {
        for (mode, reason, attempts) in [
            ("denied", "notAuthorized", 1),
            ("invalid", "invalid_reply", 1),
            ("busy", "busy", 5),
            ("custom", "customRefusal", 1),
        ] {
            let (approved, operations) = confirm_fixture(mode).await;
            assert_eq!(approved, Err(ConsentError(reason.into())));
            assert_eq!(
                operations.iter().filter(|op| *op == "authorize").count(),
                attempts
            );
        }
    }
    #[tokio::test]
    async fn confirmation_does_not_retry_after_lease_or_revision_changes() {
        for mode in ["stopped", "revision"] {
            let (approved, operations) = confirm_fixture(mode).await;
            assert_eq!(approved, Err(ConsentError("stale".into())));
            assert_eq!(operations.iter().filter(|op| *op == "authorize").count(), 1);
        }
    }
}
