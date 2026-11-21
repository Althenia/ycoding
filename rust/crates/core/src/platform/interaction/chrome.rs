use super::{
    Authority, Driver, Error, Native, Operation, now, refused, text, uuid, valid, validation,
};
use crate::platform::computer::Future;
use ring::digest::{SHA256, digest};
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
use tokio::{
    sync::{oneshot, watch},
    task::JoinHandle,
};
use url::Url;

pub const CONNECT_PATH: &str = "/api/interaction/chrome/connect";
pub const EXTENSION_ID: &str = "gdhiogddidamidlaagllklagfnghpjmn";
pub type Confirm = Arc<dyn Fn(Value, watch::Receiver<bool>) -> Future<'static, bool> + Send + Sync>;
pub struct Peer {
    pub url: String,
    pub origin: String,
    pub address: String,
    pub send: Arc<dyn Fn(String) -> bool + Send + Sync>,
    pub close: Arc<dyn Fn(u16) + Send + Sync>,
}
pub struct Transport {
    authority: Weak<Authority>,
    origin: String,
    profiles: Profiles,
    confirm: Confirm,
    current: Mutex<Option<Weak<Connection>>>,
    peers: Mutex<Vec<Weak<Connection>>>,
    enrolling: AtomicBool,
    closed: AtomicBool,
}
pub struct Channel {
    connection: Arc<Connection>,
}
impl Channel {
    pub async fn receive(&self, raw: &str) {
        if self.connection.receive(raw).await.is_err() {
            self.connection.disconnect(1008);
        }
    }
    pub fn disconnect(&self) {
        self.connection.disconnect(1008);
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        self.disconnect();
        let tasks = std::mem::take(
            &mut *self
                .connection
                .tasks
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        );
        for task in tasks {
            task.await.map_err(|_| Error("unavailable"))?;
        }
        Ok(())
    }
}
impl Drop for Channel {
    fn drop(&mut self) {
        self.connection.disconnect(1008);
    }
}
impl Transport {
    pub(super) fn origin(&self) -> &str {
        &self.origin
    }
    pub fn new(
        authority: &Arc<Authority>,
        origin: &str,
        profiles: PathBuf,
        confirm: Confirm,
    ) -> Result<Arc<Self>, Error> {
        let url = Url::parse(origin).map_err(|_| Error("not_loopback"))?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error("not_loopback"));
        }
        Ok(Arc::new(Self {
            authority: Arc::downgrade(authority),
            origin: url.origin().ascii_serialization(),
            profiles: Profiles {
                path: profiles,
                serial: tokio::sync::Mutex::new(()),
            },
            confirm,
            current: Mutex::new(None),
            peers: Mutex::new(vec![]),
            enrolling: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        }))
    }
    pub fn admit(&self, url: &str, origin: &str, address: &str) -> bool {
        !self.closed.load(Ordering::Acquire)
            && matches!(address, "127.0.0.1" | "::ffff:127.0.0.1")
            && origin == format!("chrome-extension://{EXTENSION_ID}")
            && (url == CONNECT_PATH || url == format!("{}{CONNECT_PATH}", self.origin))
    }
    pub fn connect(self: &Arc<Self>, peer: Peer) -> Result<Channel, Error> {
        if !self.admit(&peer.url, &peer.origin, &peer.address) {
            return Err(Error("authentication"));
        }
        let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        peers.retain(|p| {
            p.upgrade()
                .is_some_and(|p| !p.ended.load(Ordering::Acquire))
        });
        if peers.len() >= 4 {
            return Err(Error("busy"));
        }
        let connection = Arc::new(Connection {
            transport: Arc::downgrade(self),
            peer,
            ended: AtomicBool::new(false),
            stage: AtomicU64::new(0),
            requests: AtomicU64::new(0),
            pending_count: AtomicU64::new(0),
            profile: Mutex::new(None),
            native: Mutex::new(None),
            offers: Mutex::new(HashMap::new()),
            answering: Mutex::new(HashSet::new()),
            waiting: Mutex::new(HashMap::new()),
            leases: Mutex::new(HashMap::new()),
            revoked: Mutex::new(HashSet::new()),
            cancel: watch::channel(false).0,
            tasks: Mutex::new(vec![]),
        });
        let weak = Arc::downgrade(&connection);
        let mut cancel = connection.cancel.subscribe();
        let timer = tokio::spawn(async move {
            tokio::select! {_=tokio::time::sleep(Duration::from_secs(8))=>if let Some(c)=weak.upgrade() && c.stage.load(Ordering::Acquire)==0{c.disconnect(1008);},_=cancel.wait_for(|v|*v)=>{}}
        });
        connection
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(timer);
        peers.push(Arc::downgrade(&connection));
        Ok(Channel { connection })
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let peers = self
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        for peer in peers {
            peer.disconnect(1008);
        }
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        self.close();
    }
}
struct Profiles {
    path: PathBuf,
    serial: tokio::sync::Mutex<()>,
}
impl Profiles {
    async fn read(&self) -> Result<Vec<Value>, Error> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => {
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| Error("profiles"))?;
                if value["version"] != 1 {
                    return Err(Error("profiles"));
                }
                value["profiles"]
                    .as_array()
                    .filter(|v| v.len() <= 32)
                    .cloned()
                    .ok_or(Error("profiles"))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(_) => Err(Error("profiles")),
        }
    }
    async fn get(&self, id: &str) -> Result<Option<Value>, Error> {
        let _serial = self.serial.lock().await;
        Ok(self
            .read()
            .await?
            .into_iter()
            .find(|p| p["profileID"] == id))
    }
    async fn update(&self, id: &str, profile: Option<Value>) -> Result<(), Error> {
        let _serial = self.serial.lock().await;
        let mut profiles = self.read().await?;
        profiles.retain(|p| p["profileID"] != id);
        if let Some(profile) = profile {
            if profiles.len() >= 32 {
                profiles.remove(0);
            }
            profiles.push(profile);
        }
        let parent = self.path.parent().ok_or(Error("profiles"))?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| Error("profiles"))?;
        let staged = parent.join(format!("interaction-profiles-{}.tmp", uuid()?));
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        use tokio::io::AsyncWriteExt;
        let mut file = options.open(&staged).await.map_err(|_| Error("profiles"))?;
        let result = async {
            file.write_all(
                json!({"version":1,"profiles":profiles})
                    .to_string()
                    .as_bytes(),
            )
            .await?;
            file.flush().await?;
            tokio::fs::rename(&staged, &self.path).await
        }
        .await;
        if result.is_err() {
            tokio::fs::remove_file(&staged)
                .await
                .map_err(|_| Error("profiles"))?;
            return Err(Error("profiles"));
        }
        Ok(())
    }
}
type Reply = oneshot::Sender<Result<Value, Error>>;
struct Lease {
    input: Value,
    awaiting: bool,
}
struct Connection {
    transport: Weak<Transport>,
    peer: Peer,
    ended: AtomicBool,
    stage: AtomicU64,
    requests: AtomicU64,
    pending_count: AtomicU64,
    profile: Mutex<Option<String>>,
    native: Mutex<Option<Native>>,
    offers: Mutex<HashMap<String, Value>>,
    answering: Mutex<HashSet<String>>,
    waiting: Mutex<HashMap<String, Reply>>,
    leases: Mutex<HashMap<String, Lease>>,
    revoked: Mutex<HashSet<String>>,
    cancel: watch::Sender<bool>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}
impl Connection {
    fn native(&self) -> Result<Native, Error> {
        self.native
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or(Error("unavailable"))
    }
    fn send(&self, value: Value) -> bool {
        if self.ended.load(Ordering::Acquire) {
            return false;
        }
        let text = value.to_string();
        if text.len() > 262144 || !(self.peer.send)(text) {
            self.disconnect(1008);
            return false;
        }
        true
    }
    fn disconnect(&self, code: u16) {
        if self.ended.swap(true, Ordering::AcqRel) {
            return;
        }
        self.cancel.send_replace(true);
        if let Some(native) = self.native.lock().unwrap_or_else(|e| e.into_inner()).take() {
            native.disconnect();
        }
        let waiting = std::mem::take(&mut *self.waiting.lock().unwrap_or_else(|e| e.into_inner()));
        for reply in waiting.into_values() {
            let _ = reply.send(Err(Error("disconnected")));
        }
        self.offers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.leases
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        (self.peer.close)(code);
    }
    async fn invoke(
        &self,
        op: &str,
        input: Value,
        mut cancel: watch::Receiver<bool>,
        timeout: Duration,
    ) -> Result<Value, Error> {
        if self.ended.load(Ordering::Acquire)
            || self.stage.load(Ordering::Acquire) != 2
            || *cancel.borrow()
            || self.requests.fetch_add(1, Ordering::AcqRel) >= 2048
        {
            return Err(Error("unavailable"));
        }
        let id = uuid()?;
        let (send, receive) = oneshot::channel();
        {
            let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
            if waiting.len() >= 16 {
                return Err(Error("busy"));
            }
            waiting.insert(id.clone(), send);
        }
        let _pending = Pending {
            connection: self,
            id: id.clone(),
        };
        if !self.send(json!({"type":"request","id":id,"op":op,"input":input,"deadline":now()+timeout.as_millis() as u64})){return Err(Error("disconnected"));}
        tokio::select! {result=tokio::time::timeout(timeout,receive)=>result.map_err(|_|Error("uncertain"))?.map_err(|_|Error("disconnected"))?,_=cancel.wait_for(|v|*v)=>Err(Error("uncertain"))}
    }
    async fn handshake(self: &Arc<Self>, frame: Value) -> Result<(), Error> {
        if self
            .stage
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Error("authentication"));
        }
        let transport = self.transport.upgrade().ok_or(Error("disconnected"))?;
        let id = text(&frame, "profileID");
        if frame["version"] != 1 || !secret(id) {
            return Err(Error("authentication"));
        }
        let credential = match text(&frame, "type") {
            "enroll" => {
                let label = text(&frame, "profileLabel");
                if label.is_empty()
                    || label.chars().count() > 64
                    || label.trim() != label
                    || label.chars().any(|c| {
                        c.is_control()
                            || matches!(c, '\u{200b}' | '\u{202e}' | '\u{2066}'..='\u{2069}')
                    })
                {
                    return Err(Error("invalid"));
                }
                if transport.enrolling.swap(true, Ordering::AcqRel) {
                    self.disconnect(4409);
                    return Ok(());
                }
                let _enrolling = Enrolling(&transport.enrolling);
                let allowed = tokio::time::timeout(
                    Duration::from_secs(75),
                    (transport.confirm)(
                        json!({"profileLabel":label,"matchCode":match_code(id)}),
                        self.cancel.subscribe(),
                    ),
                )
                .await
                .unwrap_or(false);
                if !allowed || self.ended.load(Ordering::Acquire) {
                    self.disconnect(4401);
                    return Ok(());
                }
                let credential = secret_value()?;
                transport.profiles.update(id,Some(json!({"profileID":id,"digest":hash(&credential),"label":label,"created":now()}))).await?;
                if self.ended.load(Ordering::Acquire) {
                    transport.profiles.update(id, None).await?;
                    return Ok(());
                }
                Some(credential)
            }
            "authenticate" | "forget" => {
                let credential = text(&frame, "credential");
                let stored = transport.profiles.get(id).await?;
                let matched = frame["extensionID"] == EXTENSION_ID
                    && secret(credential)
                    && stored.as_ref().is_some_and(|p| {
                        constant_equal(text(p, "digest").as_bytes(), hash(credential).as_bytes())
                    });
                if frame["type"] == "forget" {
                    if matched {
                        transport.profiles.update(id, None).await?;
                    }
                    self.disconnect(4401);
                    return Ok(());
                }
                if !matched {
                    self.disconnect(4401);
                    return Ok(());
                }
                None
            }
            _ => return Err(Error("authentication")),
        };
        if self.ended.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut current = transport.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prior) = current.as_ref().and_then(Weak::upgrade)
            && !prior.ended.load(Ordering::Acquire)
        {
            if prior
                .profile
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_deref()
                != Some(id)
            {
                self.disconnect(4409);
                return Ok(());
            }
            prior.disconnect(1008);
        }
        let authority = transport.authority.upgrade().ok_or(Error("unavailable"))?;
        let native = authority.register("chrome", Arc::new(ChromeDriver(Arc::downgrade(self))))?;
        let mut events = native.subscribe().ok_or(Error("unavailable"))?;
        *self.native.lock().unwrap_or_else(|e| e.into_inner()) = Some(native.clone());
        *self.profile.lock().unwrap_or_else(|e| e.into_inner()) = Some(id.into());
        *current = Some(Arc::downgrade(self));
        drop(current);
        self.stage.store(2, Ordering::Release);
        let mut response = json!({"type":"authenticated","version":1});
        if let Some(credential) = credential {
            response["credential"] = json!(credential);
        }
        if !self.send(response) {
            return Ok(());
        }
        let weak = Arc::downgrade(self);
        let mut cancel = self.cancel.subscribe();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {_=cancel.wait_for(|v|*v)=>break,event=events.recv()=>match event{Ok((key,request))if key=="chrome"=>if let Some(connection)=weak.upgrade(){connection.tell_pending(request);},Ok(_)=>{},Err(_)=>{if let Some(connection)=weak.upgrade(){connection.disconnect(1008);}break;}}}
            }
        });
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(task);
        for pending in native.pending() {
            self.tell_pending(pending);
        }
        Ok(())
    }
    fn tell_pending(self: &Arc<Self>, request: Value) {
        let id = text(&request, "candidateID").to_owned();
        {
            let mut offers = self.offers.lock().unwrap_or_else(|e| e.into_inner());
            offers.retain(|_, r| r["expiresAt"].as_u64().is_some_and(|v| v > now()));
            if offers.len() >= 8 || offers.contains_key(&id) {
                return;
            }
            offers.insert(id.clone(), request.clone());
        }
        if !self.send(json!({"type":"pending","input":request})) {
            return;
        }
        let Ok(native) = self.native() else {
            return;
        };
        let weak = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            native.inventory(&id).await;
            if let Some(c) = weak.upgrade()
                && c.ended.load(Ordering::Acquire)
            {
                native.reject(&id);
            }
        });
        self.tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(task);
    }
    async fn receive(self: &Arc<Self>, raw: &str) -> Result<(), Error> {
        if self.ended.load(Ordering::Acquire) {
            return Ok(());
        }
        if raw.len() > 262144 {
            return Err(Error("invalid"));
        }
        let _count = Count(&self.pending_count);
        if self.pending_count.fetch_add(1, Ordering::AcqRel) >= 16 {
            return Err(Error("busy"));
        }
        let frame: Value = serde_json::from_str(raw).map_err(|_| Error("invalid"))?;
        if !frame.is_object() {
            return Err(Error("invalid"));
        }
        if self.stage.load(Ordering::Acquire) == 0 {
            return self.handshake(frame).await;
        }
        if self.stage.load(Ordering::Acquire) != 2 {
            return Err(Error("disconnected"));
        }
        let native = self.native()?;
        match text(&frame, "type") {
            "ping" => {}
            "result" | "error" => {
                let id = text(&frame, "id");
                if !validation::id(id) {
                    return Err(Error("invalid"));
                }
                if let Some(reply) = self
                    .waiting
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(id)
                {
                    let _ = reply.send(if frame["type"] == "result" {
                        Ok(frame["result"].clone())
                    } else {
                        Err(Error(error_code(text(&frame, "code"))))
                    });
                }
            }
            "approved" => {
                let proof = &frame["proof"];
                if !validation::proof(proof) {
                    return Err(Error("invalid"));
                }
                let id = text(proof, "candidateID").to_owned();
                let request = self
                    .offers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&id)
                    .cloned();
                if request.is_none_or(|r| {
                    r["sessionID"] != proof["sessionID"]
                        || r["expiresAt"].as_u64().is_none_or(|v| v <= now())
                }) {
                    return Ok(());
                }
                if !self
                    .answering
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(id.clone())
                {
                    return Ok(());
                }
                if !native.approve(proof.clone()).await {
                    self.send(json!({"type":"cancel","input":{"candidateID":id,"sessionID":proof["sessionID"]}}));
                }
                self.offers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                self.answering
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
            }
            "rejected" => {
                let id = text(&frame, "candidateID");
                if self
                    .offers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(id)
                    .is_some()
                {
                    native.reject(id);
                }
            }
            "revoked" => {
                let id = text(&frame, "leaseID");
                if !validation::id(id) {
                    return Err(Error("invalid"));
                }
                let leases = self.leases.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(lease) = leases.get(id)
                    && lease.input["epoch"] != frame["epoch"]
                {
                    return Ok(());
                }
                let live = leases.contains_key(id);
                drop(leases);
                let mut revoked = self.revoked.lock().unwrap_or_else(|e| e.into_inner());
                if revoked.len() >= 2048 {
                    return Err(Error("invalid"));
                }
                revoked.insert(id.into());
                drop(revoked);
                if live {
                    native.stop(
                        id,
                        if frame["reason"] == "stopped" {
                            "stopped"
                        } else {
                            "target_lost"
                        },
                    );
                }
            }
            "paused" | "resumed" | "capture" => {
                let id = text(&frame, "leaseID");
                let live = self
                    .leases
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(id)
                    .is_some_and(|l| l.input["epoch"] == frame["epoch"]);
                if !live {
                    return Ok(());
                }
                match text(&frame, "type") {
                    "paused" => {
                        let reason = text(&frame, "reason");
                        if !validation::pause_reason(reason) {
                            return Err(Error("invalid"));
                        }
                        if let Some(lease) = self
                            .leases
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .get_mut(id)
                        {
                            lease.awaiting = true;
                        }
                        native.pause(id, reason);
                    }
                    "resumed" => {
                        native.resume(id);
                    }
                    _ => {
                        native.capture(id, frame["capture"].clone()).await;
                    }
                }
            }
            _ => return Err(Error("invalid")),
        }
        Ok(())
    }
}
struct Pending<'a> {
    connection: &'a Connection,
    id: String,
}
struct Attaching {
    connection: Arc<Connection>,
    proof: Value,
    committed: bool,
}
impl Drop for Attaching {
    fn drop(&mut self) {
        if !self.committed {
            self.connection.send(json!({"type":"cancel","input":{"candidateID":self.proof["candidateID"],"sessionID":self.proof["sessionID"]}}));
        }
    }
}
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.connection
            .waiting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}
struct Enrolling<'a>(&'a AtomicBool);
impl Drop for Enrolling<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
struct Count<'a>(&'a AtomicU64);
impl Drop for Count<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
struct ChromeDriver(Weak<Connection>);
impl Driver for ChromeDriver {
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
            let c = self.0.upgrade().ok_or(Error("disconnected"))?;
            let timeout = Duration::from_secs(8);
            if op == Operation::Inventory {
                return c.invoke("inventory", input, cancel, timeout).await;
            }
            if op == Operation::Attach {
                let target = &input["target"];
                let proof = &input["proof"];
                if !matches!(text(target, "kind"), "chrome-tab" | "chrome-owned") {
                    return Err(Error("invalid"));
                }
                let mut attaching = Attaching {
                    connection: c.clone(),
                    proof: proof.clone(),
                    committed: false,
                };
                let result = c.invoke("attach", input.clone(), cancel, timeout).await;
                let valid = result.as_ref().is_ok_and(|v| {
                    validation::id(text(v, "leaseID"))
                        && v["sessionID"] == proof["sessionID"]
                        && v["targetID"] == proof["targetID"]
                        && v["pathname"] == target["pathname"]
                        && v["epoch"].as_u64().is_some_and(|n| n > 0)
                        && v["revision"] == 1
                        && !c
                            .revoked
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .contains(text(v, "leaseID"))
                });
                if !valid {
                    return Err(Error("invalid"));
                }
                let reply = result?;
                let id = text(&reply, "leaseID").to_owned();
                c.leases.lock().unwrap_or_else(|e|e.into_inner()).insert(id.clone(),Lease {input:json!({"leaseID":id,"sessionID":proof["sessionID"],"epoch":reply["epoch"],"revision":1,"pathname":target["pathname"]}),awaiting:false});
                attaching.committed = true;
                return Ok(json!({"id":id}));
            }
            let id = text(&input, "id");
            let (mut wire, awaiting) = {
                let leases = c.leases.lock().unwrap_or_else(|e| e.into_inner());
                let lease = leases.get(id).ok_or(Error("target_lost"))?;
                (lease.input.clone(), lease.awaiting)
            };
            if op == Operation::Detach {
                c.leases
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(id);
                wire["reason"] = input["reason"].clone();
                return c.invoke("detach", wire, cancel, timeout).await;
            }
            if op == Operation::Observe {
                let observed = c.invoke("observe", wire.clone(), cancel, timeout).await?;
                if !valid("Observation", &observed)
                    || observed["revision"].as_u64() <= wire["revision"].as_u64()
                    || observed["pathname"] != wire["pathname"]
                {
                    return Err(Error("stale"));
                }
                if let Some(lease) = c
                    .leases
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get_mut(id)
                {
                    lease.input["revision"] = observed["revision"].clone();
                    lease.awaiting = false;
                }
                return Ok(observed);
            }
            if op == Operation::Perform || op == Operation::Run {
                if awaiting
                    || (op == Operation::Perform && input["revision"] != wire["revision"])
                    || *cancel.borrow()
                {
                    return Ok(refused("stale"));
                }
                if (op == Operation::Run || input["action"]["type"] == "navigate")
                    && let Some(lease) = c
                        .leases
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get_mut(id)
                {
                    lease.awaiting = true;
                }
                for (key, value) in input.as_object().ok_or(Error("invalid"))? {
                    if key != "id" && key != "script" {
                        wire[key] = value.clone();
                    }
                }
                let wait = if op == Operation::Run {
                    let script = &input["script"];
                    for key in ["mode", "source", "timeoutMs"] {
                        wire[key] = script[key].clone();
                    }
                    wire["runID"] = json!(uuid()?);
                    Duration::from_millis(script["timeoutMs"].as_u64().unwrap_or(10000)) + timeout
                } else {
                    timeout
                };
                let result = c.invoke(op.as_str(), wire, cancel, wait).await;
                match result {
                    Ok(result) => {
                        if result["outcome"] == "paused" {
                            c.native()?.pause(id, text(&result, "reason"));
                        }
                        Ok(result)
                    }
                    Err(error) if matches!(error.0, "disconnected" | "uncertain") => {
                        if op == Operation::Perform {
                            Ok(json!({"outcome":"uncertain"}))
                        } else {
                            Err(error)
                        }
                    }
                    Err(error) => Ok(refused(match error.0 {
                        "consent" => "confirmation_required",
                        "ownership" | "stopped" => "target_lost",
                        "invalid" | "unavailable" => "unsupported",
                        "paused" => "busy",
                        other => other,
                    })),
                }
            } else {
                let result = c.invoke(op.as_str(), wire, cancel, timeout).await?;
                if op == Operation::Preview {
                    return Ok(
                        if result["status"] == "ready" && validation::frame(&result["frame"]) {
                            result["frame"].clone()
                        } else {
                            Value::Null
                        },
                    );
                }
                if op == Operation::Resume
                    && result == true
                    && let Some(lease) = c
                        .leases
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get_mut(id)
                {
                    lease.awaiting = true;
                }
                Ok(result)
            }
        })
    }
}
fn error_code(code: &str) -> &'static str {
    match code {
        "stale" => "stale",
        "sensitive" => "sensitive",
        "captcha" => "captcha",
        "policy" => "policy",
        "permission" => "permission",
        "target_lost" => "target_lost",
        "confirmation_required" => "confirmation_required",
        "busy" => "busy",
        "consent" => "consent",
        "ownership" => "ownership",
        "stopped" => "stopped",
        "unavailable" => "unavailable",
        "paused" => "paused",
        "uncertain" => "uncertain",
        "disconnected" => "disconnected",
        _ => "invalid",
    }
}
fn secret(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}
fn secret_value() -> Result<String, Error> {
    let bytes = super::super::random::<32>().map_err(|_| Error("unavailable"))?;
    Ok(crate::meeting::pcm::encode_base64(&bytes)
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_"))
}
fn hash(value: &str) -> String {
    digest(&SHA256, value.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn constant_equal(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
pub fn match_code(profile_id: &str) -> String {
    let hash = digest(
        &SHA256,
        format!("ycoding-chrome-profile:{profile_id}").as_bytes(),
    );
    let bits = hash.as_ref()[..5]
        .iter()
        .fold(0u64, |v, b| (v << 8) | u64::from(*b));
    let alphabet = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let code = (0..8)
        .map(|i| alphabet[((bits >> (35 - i * 5)) & 31) as usize] as char)
        .collect::<String>();
    format!("{}-{}", &code[..4], &code[4..])
}
