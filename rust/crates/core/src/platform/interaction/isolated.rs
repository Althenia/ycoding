use super::{
    Authority, ConsentError, Driver, Error, Native, Operation,
    macos::{Adapter, IsolatedConsent},
    now, refused,
    script::{self, Runner},
    text, uuid, validation,
};
use crate::platform::{
    browser::cdp::{Client, Event},
    computer::Future,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle};
use url::Url;

pub struct Isolated {
    macos: Option<Arc<Adapter>>,
    native: Mutex<Option<Native>>,
    offers: Mutex<HashMap<String, Offer>>,
    prepared: Mutex<HashMap<String, (Value, IsolatedConsent)>>,
    active: Mutex<HashMap<String, Arc<Active>>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    cancel: watch::Sender<bool>,
    executable: PathBuf,
}
struct Offer {
    request: Value,
    target: Value,
}
struct Active {
    page: Arc<Page>,
    pipe: Arc<super::isolated_pipe::Pipe>,
    consent: IsolatedConsent,
}
impl Isolated {
    pub fn installed(macos: Option<Arc<Adapter>>) -> Arc<Self> {
        Arc::new(Self {
            macos,
            native: Mutex::new(None),
            offers: Mutex::new(HashMap::new()),
            prepared: Mutex::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
            tasks: Mutex::new(vec![]),
            cancel: watch::channel(false).0,
            executable: PathBuf::from(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            ),
        })
    }
    pub fn mount(self: &Arc<Self>, authority: &Arc<Authority>) -> Result<Native, Error> {
        let native = authority.register(
            "chrome-isolated",
            Arc::new(IsolatedDriver(Arc::downgrade(self))),
        )?;
        let mut events = native.subscribe().ok_or(Error("unavailable"))?;
        *self.native.lock().unwrap_or_else(|e| e.into_inner()) = Some(native.clone());
        let weak = Arc::downgrade(self);
        let channel = native.clone();
        let mut cancel = self.cancel.subscribe();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _=cancel.wait_for(|v|*v)=>break,
                    event=events.recv()=>match event {
                        Ok((key,request))if key=="chrome-isolated"=>{
                            let Some(owner)=weak.upgrade()else{break;};
                            let channel=channel.clone();
                            let task=tokio::spawn(async move{
                                let id=text(&request,"candidateID").to_owned();
                                let Some(scoped)=channel.cancellation(&id)else{return;};
                                let choice=request.clone();
                                channel.consent(&request,scoped,move|targets,scoped|async move{
                                    if targets.len()!=1 || targets[0]["kind"]!="chrome-isolated"{return Err(Error("target_mismatch").into());}
                                    owner.approve(&choice,&targets[0],scoped).await
                                }).await;
                            });
                            if let Some(owner)=weak.upgrade(){owner.tasks.lock().unwrap_or_else(|e|e.into_inner()).push(task);}
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
    async fn approve(
        &self,
        request: &Value,
        target: &Value,
        cancel: watch::Receiver<bool>,
    ) -> Result<(), ConsentError> {
        let macos = self.macos.as_ref().ok_or(Error("not_confirmed"))?;
        let consent=macos.confirm_isolated(json!({"candidateID":request["candidateID"],"sessionID":request["sessionID"],"url":target["url"],"expiresAt":request["expiresAt"]}),cancel.clone()).await.map_err(|_|Error("error"))?.ok_or(Error("not_confirmed"))?;
        if *cancel.borrow() {
            consent.close().await?;
            return Err(Error("aborted").into());
        }
        let Ok(authorization) = uuid() else {
            consent.close().await?;
            return Err(Error("error").into());
        };
        let proof = json!({"candidateID":request["candidateID"],"sessionID":request["sessionID"],"targetID":target["id"],"authorization":authorization});
        self.prepared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(authorization.clone(), (proof.clone(), consent));
        let native = self
            .native
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let accepted = match native {
            Some(native) => native.approve(proof).await,
            None => false,
        };
        let unused = self
            .prepared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&authorization);
        if let Some((_, consent)) = unused {
            consent.close().await.map_err(|_| Error("error"))?;
        }
        if accepted {
            Ok(())
        } else {
            Err(Error("authority_declined").into())
        }
    }
    async fn operation(
        self: &Arc<Self>,
        op: Operation,
        input: Value,
        cancel: watch::Receiver<bool>,
    ) -> Result<Value, Error> {
        if op == Operation::Inventory {
            if input["purpose"] != "attach"
                || input["selection"]["mode"] != "isolated"
                || input["expiresAt"]
                    .as_u64()
                    .is_none_or(|v| v <= now() || v > now() + 60000)
            {
                return Ok(json!([]));
            }
            let url = Url::parse(text(&input["selection"], "url")).map_err(|_| Error("invalid"))?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Ok(json!([]));
            }
            let mut offers = self.offers.lock().unwrap_or_else(|e| e.into_inner());
            offers.retain(|_, o| o.request["expiresAt"].as_u64().is_some_and(|v| v > now()));
            let id = text(&input, "candidateID").to_owned();
            if let Some(offer) = offers.get(&id) {
                return Ok(json!([offer.target]));
            }
            if offers.len() >= 64 {
                return Ok(json!([]));
            }
            let target = json!({"kind":"chrome-isolated","id":uuid()?,"label":"Temporary isolated Chrome","origin":url.origin().ascii_serialization(),"pathname":url.path(),"url":url.as_str()});
            offers.insert(
                id,
                Offer {
                    request: input,
                    target: target.clone(),
                },
            );
            return Ok(json!([target]));
        }
        if op == Operation::Attach {
            let proof = &input["proof"];
            let ready = self
                .prepared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(text(proof, "authorization"))
                .ok_or(Error("permission"))?;
            let offer = self
                .offers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(text(proof, "candidateID"))
                .ok_or(Error("stale"))?;
            if ready.0 != *proof
                || offer.target != input["target"]
                || offer.request["sessionID"] != proof["sessionID"]
                || self.active.lock().unwrap_or_else(|e| e.into_inner()).len() >= 4
                || *cancel.borrow()
            {
                ready.1.close().await?;
                return Err(Error("stale"));
            }
            if !crate::platform::browser::chrome::installed_availability()
                .await
                .available
            {
                ready.1.close().await?;
                return Err(Error("unavailable"));
            }
            let id = uuid()?;
            if !ready.1.bind(&id, cancel.clone()).await? {
                ready.1.close().await?;
                return Err(Error("permission"));
            }
            let pipe =
                super::isolated_pipe::Pipe::launch(&self.executable, ready.1.cancelled()).await?;
            let page = match Page::attach(
                pipe.client.clone(),
                text(&offer.target, "url"),
                cancel.clone(),
            )
            .await
            {
                Ok(page) => page,
                Err(error) => {
                    pipe.close().await?;
                    ready.1.close().await?;
                    return Err(error);
                }
            };
            let active = Arc::new(Active {
                page: page.clone(),
                pipe: pipe.clone(),
                consent: ready.1,
            });
            self.active
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.clone(), active.clone());
            let native = self
                .native
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .ok_or(Error("unavailable"))?;
            let mut lost = page.lost.subscribe();
            let mut stopped = active.consent.cancelled();
            let lease = id.clone();
            let mut pipe_stop = pipe.cancel.subscribe();
            let task = tokio::spawn(async move {
                tokio::select! {_=lost.wait_for(|v|*v)=>{native.stop(&lease,"target_lost");},_=stopped.wait_for(|v|*v)=>{native.stop(&lease,"stopped");},_=pipe_stop.wait_for(|v|*v)=>{native.stop(&lease,"target_lost");}}
            });
            self.tasks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(task);
            return Ok(json!({"id":id}));
        }
        let id = text(&input, "id");
        let active = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or(Error("target_lost"))?;
        match op {
            Operation::Observe => active.page.observe(cancel).await,
            Operation::Perform => active.page.perform(&input["action"], cancel).await,
            Operation::Preview => active.page.preview(cancel).await,
            Operation::Resume => Ok(json!(false)),
            Operation::Run => active.page.run(id, &input["script"], cancel).await,
            Operation::Detach => {
                self.active
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(id);
                active.page.close().await?;
                active.consent.close().await?;
                active.pipe.close().await?;
                Ok(Value::Null)
            }
            _ => Err(Error("unsupported")),
        }
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        self.cancel.send_replace(true);
        if let Some(native) = self.native.lock().unwrap_or_else(|e| e.into_inner()).take() {
            native.disconnect();
        }
        let active = std::mem::take(&mut *self.active.lock().unwrap_or_else(|e| e.into_inner()));
        for active in active.into_values() {
            active.page.close().await?;
            active.consent.close().await?;
            active.pipe.close().await?;
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
impl Drop for Isolated {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}
struct IsolatedDriver(Weak<Isolated>);
impl Driver for IsolatedDriver {
    fn platform(&self) -> &'static str {
        "chrome"
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

pub struct Page {
    client: Arc<Client>,
    session: String,
    target: String,
    origin: String,
    pathname: String,
    url: String,
    frame: String,
    document: Mutex<String>,
    context: AtomicU64,
    revision: AtomicU64,
    refs: Mutex<HashSet<String>>,
    lost: watch::Sender<bool>,
    transition: AtomicBool,
    preview_epoch: AtomicU64,
    events: Mutex<Option<JoinHandle<()>>>,
    runner: Runner,
}
impl Page {
    pub async fn attach(
        client: Arc<Client>,
        url: &str,
        cancel: watch::Receiver<bool>,
    ) -> Result<Arc<Self>, Error> {
        let approved = Url::parse(url).map_err(|_| Error("invalid"))?;
        let origin = approved.origin().ascii_serialization();
        let pathname = approved.path().to_owned();
        let browser = |method, params| {
            let client = client.clone();
            let cancel = cancel.clone();
            async move {
                client
                    .send(method, params, None, Some(cancel), None)
                    .await
                    .map_err(|_| Error("unavailable"))
            }
        };
        let context = browser(
            "Target.createBrowserContext",
            json!({"disposeOnDetach":true}),
        )
        .await?;
        let context_id = text(&context, "browserContextId");
        if context_id.is_empty() {
            return Err(Error("unavailable"));
        }
        browser(
            "Browser.setDownloadBehavior",
            json!({"behavior":"deny","browserContextId":context_id,"eventsEnabled":true}),
        )
        .await?;
        let targets = browser(
            "Target.getTargets",
            json!({"filter":[{"type":"page","exclude":false},{"exclude":true}]}),
        )
        .await?;
        let targets = targets["targetInfos"]
            .as_array()
            .filter(|v| v.len() <= 1)
            .ok_or(Error("unavailable"))?;
        for target in targets {
            if target["type"] != "page"
                || target["url"] != "about:blank"
                || target.get("openerId").is_some()
                || target["attached"] != false
            {
                return Err(Error("policy"));
            }
        }
        let created = browser(
            "Target.createTarget",
            json!({"url":"about:blank","browserContextId":context_id,"background":true}),
        )
        .await?;
        let target = text(&created, "targetId").to_owned();
        if target.is_empty() {
            return Err(Error("unavailable"));
        }
        let attached = browser(
            "Target.attachToTarget",
            json!({"targetId":target,"flatten":true}),
        )
        .await?;
        let session = text(&attached, "sessionId").to_owned();
        if session.is_empty() {
            return Err(Error("unavailable"));
        }
        for bootstrap in targets {
            if browser(
                "Target.closeTarget",
                json!({"targetId":bootstrap["targetId"]}),
            )
            .await?["success"]
                != true
            {
                return Err(Error("unavailable"));
            }
        }
        let send = |method, params| {
            let client = client.clone();
            let cancel = cancel.clone();
            let session = session.clone();
            async move {
                client
                    .send(method, params, Some(&session), Some(cancel), None)
                    .await
                    .map_err(|_| Error("unavailable"))
            }
        };
        send("Page.enable", json!({})).await?;
        send("Page.setLifecycleEventsEnabled", json!({"enabled":true})).await?;
        send(
            "Page.setInterceptFileChooserDialog",
            json!({"enabled":true,"cancel":true}),
        )
        .await?;
        let tree = send("Page.getFrameTree", json!({})).await?;
        let frame = text(&tree["frameTree"]["frame"], "id").to_owned();
        if frame.is_empty() || tree["frameTree"]["frame"]["url"] != "about:blank" {
            return Err(Error("policy"));
        }
        let runner = Runner::new(client.clone(), session.clone());
        let page = Arc::new(Self {
            client: client.clone(),
            session,
            target,
            origin,
            pathname,
            url: approved.to_string(),
            frame,
            document: Mutex::new(String::new()),
            context: AtomicU64::new(0),
            revision: AtomicU64::new(0),
            refs: Mutex::new(HashSet::new()),
            lost: watch::channel(false).0,
            transition: AtomicBool::new(true),
            preview_epoch: AtomicU64::new(0),
            events: Mutex::new(None),
            runner,
        });
        let mut events = client.subscribe();
        let weak = Arc::downgrade(&page);
        let task = tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        let Some(page) = weak.upgrade() else {
                            break;
                        };
                        if page.event(event).await.is_err() {
                            page.lost.send_replace(true);
                            break;
                        }
                    }
                    Err(_) => {
                        if let Some(page) = weak.upgrade() {
                            page.lost.send_replace(true);
                        }
                        break;
                    }
                }
            }
        });
        *page.events.lock().unwrap_or_else(|e| e.into_inner()) = Some(task);
        browser("Target.setAutoAttach",json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true,"filter":[{"type":"page","exclude":false},{"type":"iframe","exclude":false},{"exclude":true}]})).await?;
        page.send("Fetch.enable",json!({"patterns":[{"urlPattern":"*","resourceType":"Document","requestStage":"Request"}]}),cancel.clone()).await?;
        page.navigate(cancel).await?;
        Ok(page)
    }
    async fn send(
        &self,
        method: &str,
        params: Value,
        cancel: watch::Receiver<bool>,
    ) -> Result<Value, Error> {
        self.client
            .send(method, params, Some(&self.session), Some(cancel), None)
            .await
            .map_err(|_| Error("uncertain"))
    }
    async fn event(&self, event: Event) -> Result<(), Error> {
        let params = event
            .params
            .map(|v| serde_json::from_str::<Value>(&ycoding_schema::stringify_json(&v)))
            .transpose()
            .map_err(|_| Error("invalid"))?
            .unwrap_or(Value::Null);
        if event.method == "Target.attachedToTarget" {
            let target = &params["targetInfo"];
            if target["targetId"] != self.target {
                self.client
                    .send(
                        "Target.closeTarget",
                        json!({"targetId":target["targetId"]}),
                        None,
                        None,
                        None,
                    )
                    .await
                    .map_err(|_| Error("target_lost"))?;
                return Err(Error("target_lost"));
            }
            return Ok(());
        }
        if event.method == "Target.detachedFromTarget" && params["sessionId"] == self.session {
            return Err(Error("target_lost"));
        }
        if event.method == "Browser.downloadWillBegin" {
            return Err(Error("target_lost"));
        }
        if event.session_id.as_deref() != Some(&self.session) {
            return Ok(());
        }
        if event.method.starts_with("Page.frame") || event.method == "DOM.documentUpdated" {
            self.preview_epoch.fetch_add(1, Ordering::AcqRel);
        }
        if matches!(
            event.method.as_str(),
            "Page.frameAttached" | "Inspector.targetCrashed"
        ) {
            return Err(Error("target_lost"));
        }
        if !self.transition.load(Ordering::Acquire)
            && ((event.method == "Page.frameNavigated" && params["frame"]["id"] == self.frame)
                || (event.method == "Page.navigatedWithinDocument"
                    && params["frameId"] == self.frame))
        {
            return Err(Error("target_lost"));
        }
        if event.method == "Fetch.requestPaused" {
            let raw = text(&params["request"], "url");
            let allowed = params["frameId"] == self.frame
                && params.get("redirectedRequestId").is_none()
                && Url::parse(raw).is_ok_and(|mut u| {
                    u.set_fragment(None);
                    let mut approved = Url::parse(&self.url).expect("approved URL");
                    approved.set_fragment(None);
                    u == approved
                });
            self.send(
                if allowed {
                    "Fetch.continueRequest"
                } else {
                    "Fetch.failRequest"
                },
                if allowed {
                    json!({"requestId":params["requestId"]})
                } else {
                    json!({"requestId":params["requestId"],"errorReason":"BlockedByClient"})
                },
                super::signal(),
            )
            .await?;
            if !allowed {
                return Err(Error("target_lost"));
            }
        }
        Ok(())
    }
    async fn frame(&self, cancel: watch::Receiver<bool>) -> Result<Value, Error> {
        let tree = self.send("Page.getFrameTree", json!({}), cancel).await?;
        let tree = &tree["frameTree"];
        if tree
            .get("childFrames")
            .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
            || tree["frame"].get("parentId").is_some()
        {
            return Err(Error("target_lost"));
        }
        Ok(tree["frame"].clone())
    }
    async fn verify(&self, cancel: watch::Receiver<bool>) -> Result<(), Error> {
        if *self.lost.borrow() {
            return Err(Error("target_lost"));
        }
        let frame = self.frame(cancel.clone()).await?;
        let matches = frame["id"] == self.frame
            && frame["loaderId"] == *self.document.lock().unwrap_or_else(|e| e.into_inner())
            && frame["securityOrigin"] == self.origin
            && frame.get("unreachableUrl").is_none()
            && Url::parse(text(&frame, "url")).is_ok_and(|u| {
                u.origin().ascii_serialization() == self.origin && u.path() == self.pathname
            });
        if !matches {
            self.lost.send_replace(true);
            return Err(Error("target_lost"));
        }
        if self.context.load(Ordering::Acquire) != 0
            && self.page(json!({"operation":"scope"}), cancel).await?["verified"] != true
        {
            return Err(Error("target_lost"));
        }
        Ok(())
    }
    async fn navigate(&self, mut cancel: watch::Receiver<bool>) -> Result<(), Error> {
        self.transition.store(true, Ordering::Release);
        let mut events = self.client.subscribe();
        let navigation = self
            .send(
                "Page.navigate",
                json!({"url":self.url,"frameId":self.frame}),
                cancel.clone(),
            )
            .await?;
        if navigation.get("errorText").is_some()
            || navigation["isDownload"] == true
            || text(&navigation, "loaderId").is_empty()
        {
            return Err(Error("target_lost"));
        }
        let completed = async {
            loop {
                let event = events.recv().await.map_err(|_| Error("target_lost"))?;
                if event.session_id.as_deref() != Some(&self.session)
                    || event.method != "Page.lifecycleEvent"
                {
                    continue;
                }
                let params = event.params.ok_or(Error("invalid"))?;
                let params: Value = serde_json::from_str(&ycoding_schema::stringify_json(&params))
                    .map_err(|_| Error("invalid"))?;
                if params["name"] == "DOMContentLoaded"
                    && params["loaderId"] == navigation["loaderId"]
                {
                    return Ok::<(), Error>(());
                }
            }
        };
        tokio::select! {r=tokio::time::timeout(Duration::from_secs(10),completed)=>r.map_err(|_|Error("target_lost"))??,_=cancel.wait_for(|v|*v)=>return Err(Error("stale"))};
        *self.document.lock().unwrap_or_else(|e| e.into_inner()) =
            text(&navigation, "loaderId").into();
        let world = self
            .send(
                "Page.createIsolatedWorld",
                json!({"frameId":self.frame,"worldName":"ycoding-interaction-isolated"}),
                cancel.clone(),
            )
            .await?;
        self.context.store(
            world["executionContextId"]
                .as_u64()
                .ok_or(Error("unavailable"))?,
            Ordering::Release,
        );
        self.verify(cancel).await?;
        self.transition.store(false, Ordering::Release);
        Ok(())
    }
    async fn page(&self, mut input: Value, cancel: watch::Receiver<bool>) -> Result<Value, Error> {
        input["origin"] = json!(self.origin);
        input["pathname"] = json!(self.pathname);
        input["isolated"] = json!(true);
        let result=self.send("Runtime.callFunctionOn",json!({"executionContextId":self.context.load(Ordering::Acquire),"functionDeclaration":script::source("page"),"returnByValue":true,"userGesture":false,"arguments":[{"value":input}]}),cancel).await?;
        if result.get("exceptionDetails").is_some() {
            return Err(Error("uncertain"));
        }
        Ok(result["result"]["value"].clone())
    }
    pub async fn observe(&self, cancel: watch::Receiver<bool>) -> Result<Value, Error> {
        self.verify(cancel.clone()).await?;
        let result = self
            .page(json!({"operation":"observe"}), cancel.clone())
            .await?;
        self.verify(cancel).await?;
        let elements = result["elements"].as_array().ok_or(Error("unavailable"))?;
        let revision = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
        *self.refs.lock().unwrap_or_else(|e| e.into_inner()) =
            elements.iter().map(|e| text(e, "id").to_owned()).collect();
        Ok(json!({"revision":revision,"pathname":self.pathname,"elements":elements}))
    }
    pub async fn perform(
        &self,
        action: &Value,
        cancel: watch::Receiver<bool>,
    ) -> Result<Value, Error> {
        if action["destructive"] == true {
            return Ok(refused("unsupported"));
        }
        if action.get("elementID").is_some()
            && !self
                .refs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains(text(action, "elementID"))
        {
            return Ok(refused("stale"));
        }
        self.verify(cancel.clone()).await?;
        if action["type"] == "navigate" {
            if action["url"] != self.url {
                return Ok(refused("policy"));
            }
            self.navigate(cancel.clone()).await?;
        } else {
            let mut input = action.clone();
            input
                .as_object_mut()
                .ok_or(Error("policy"))?
                .remove("platform");
            input["operation"] = action["type"].clone();
            let result = self.page(input, cancel.clone()).await?;
            if !result["refusal"].is_null() {
                return Ok(refused(text(&result, "refusal")));
            }
            if result["applied"] != true {
                return Ok(json!({"outcome":"uncertain"}));
            }
        }
        self.refs.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.verify(cancel).await?;
        Ok(json!({"outcome":"applied"}))
    }
    pub async fn run(
        &self,
        lease: &str,
        script: &Value,
        cancel: watch::Receiver<bool>,
    ) -> Result<Value, Error> {
        self.verify(cancel.clone()).await?;
        self.refs.lock().unwrap_or_else(|e| e.into_inner()).clear();
        let result = self.runner.run(lease, script, cancel).await?;
        if self.verify(super::signal()).await.is_err() {
            self.lost.send_replace(true);
        }
        Ok(result)
    }
    pub async fn preview(&self, cancel: watch::Receiver<bool>) -> Result<Value, Error> {
        self.verify(cancel.clone()).await?;
        let epoch = self.preview_epoch.load(Ordering::Acquire);
        let before = self
            .page(json!({"operation":"preview"}), cancel.clone())
            .await?;
        if before["safe"] != true || !before["ticket"].is_string() {
            return Ok(Value::Null);
        }
        let dom = self
            .send(
                "DOM.getDocument",
                json!({"depth":32,"pierce":true}),
                cancel.clone(),
            )
            .await?;
        if crate::platform::browser::capture::assert_safe(&dom["root"]).is_err() {
            return Ok(Value::Null);
        }
        let view = self
            .send("Page.getLayoutMetrics", json!({}), cancel.clone())
            .await?;
        let view = &view["cssVisualViewport"];
        let width = view["clientWidth"]
            .as_f64()
            .filter(|w| *w > 0. && *w <= 960.)
            .ok_or(Error("unavailable"))?;
        let height = view["clientHeight"]
            .as_f64()
            .filter(|h| *h > 0. && *h <= 720.)
            .ok_or(Error("unavailable"))?;
        if self
            .page(
                json!({"operation":"preview","ticket":before["ticket"],"keep":true}),
                cancel.clone(),
            )
            .await?["safe"]
            != true
        {
            return Ok(Value::Null);
        }
        let output=self.send("Page.captureScreenshot",json!({"format":"jpeg","quality":65,"fromSurface":true,"captureBeyondViewport":false,"clip":{"x":view["pageX"],"y":view["pageY"],"width":width,"height":height,"scale":1}}),cancel.clone()).await?;
        self.verify(cancel.clone()).await?;
        let dom = self
            .send(
                "DOM.getDocument",
                json!({"depth":32,"pierce":true}),
                cancel.clone(),
            )
            .await?;
        if crate::platform::browser::capture::assert_safe(&dom["root"]).is_err()
            || self
                .page(
                    json!({"operation":"preview","ticket":before["ticket"]}),
                    cancel,
                )
                .await?["safe"]
                != true
            || epoch != self.preview_epoch.load(Ordering::Acquire)
        {
            return Ok(Value::Null);
        }
        let frame = json!({"mimeType":"image/jpeg","base64":output["data"],"width":width as u64,"height":height as u64});
        Ok(if validation::frame(&frame) {
            frame
        } else {
            Value::Null
        })
    }
    pub async fn close(&self) -> Result<(), Error> {
        self.lost.send_replace(true);
        let task = self.events.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(task) = task {
            task.abort();
            match task.await {
                Ok(()) => {}
                Err(e) if e.is_cancelled() => {}
                Err(_) => return Err(Error("cleanup")),
            }
        }
        self.runner.discard().await
    }
}
impl Drop for Page {
    fn drop(&mut self) {
        self.lost.send_replace(true);
        if let Some(task) = self.events.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
    }
}
