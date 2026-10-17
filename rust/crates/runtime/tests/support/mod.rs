#![allow(dead_code)]

use prost::{Message, Name};
use std::{
    collections::{BTreeSet, VecDeque},
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use ycoding_core::platform::git;
use ycoding_core::process::guardrails::{Limits, Paths, Settings};
use ycoding_core::resources::{agent, memory};
use ycoding_core::session::{
    execution::{Execution, Locations, Runner},
    helper_generation::{Generate, Generation, Request},
    prediction, prompt_generator, run_coordinator,
    store::Service as SessionStore,
};
use ycoding_core::tools::policy::Event as Published;
use ycoding_core::ycoding_schema::{location, parse_json, permission};
use ycoding_core::ycoding_store::{Metadata, Options, Store, project, session};
use ycoding_protocol::{
    OPERATIONS,
    connection::{Budgets, Close, Config, Connection, Decision, Outcome},
    decode_strict, v5,
};
use ycoding_runtime::{
    Configuration, Core, Dispatcher, HelperEnvironment, Identity, LocalAuth, Server, Services,
    SnapshotSettings, serve_with,
};

pub mod catalog;
#[path = "../../../core/tests/report_support/mod.rs"]
pub mod report_support;
pub mod usage;
pub mod wire;
pub use catalog::{CATALOG, record};

pub const WAIT: Duration = Duration::from_secs(5);

pub const SESSIONS: &[&str] = &[
    "ses_rich",
    "ses_history",
    "ses_pending",
    "ses_get",
    "ses_other",
    "ses_prompt",
    "ses_retry",
    "ses_files",
    "ses_conflict_a",
    "ses_conflict_b",
    "ses_interrupt",
    "ses_auto",
    "ses_team",
    "ses_team_two",
    "ses_doomed",
    "ses_doomed_two",
    "ses_list_a",
    "ses_list_b",
    "ses_list_c",
    "ses_state_flags",
    "ses_state_todo",
    "ses_state_diag",
    "ses_state_commit",
    "ses_predict_text",
    "ses_predict_hint",
    "ses_predict_cancel",
    "ses_predict_unwired",
    "ses_predict_child",
    "ses_prompt_text",
    "ses_prompt_cancel",
    "ses_prompt_unwired",
];

const PREDICTABLE: &[&str] = &[
    "ses_predict_text",
    "ses_predict_hint",
    "ses_predict_cancel",
    "ses_predict_unwired",
    "ses_predict_child",
    "ses_prompt_text",
    "ses_prompt_cancel",
    "ses_prompt_unwired",
];

struct TestLocations(Arc<ActiveChildren>);

impl Locations for TestLocations {
    fn get(&self, location: &location::Ref) -> Result<Arc<dyn Runner>, run_coordinator::Error> {
        if location.directory.as_lossless().as_str() == Some("/project/team") {
            return Ok(self.0.clone());
        }
        Err(run_coordinator::Error::Closed)
    }
}

pub struct ActiveChildren(
    tokio::sync::watch::Sender<BTreeSet<ycoding_core::ycoding_schema::session::Id>>,
);

impl Runner for ActiveChildren {
    fn drain(&self, mut request: run_coordinator::DrainRequest) -> run_coordinator::RunFuture {
        self.0.send_modify(|started| {
            started.insert(request.session_id);
        });
        Box::pin(async move {
            Err(run_coordinator::Error::Interrupted(
                request.cancellation.cancelled().await,
            ))
        })
    }
}

impl ActiveChildren {
    pub async fn started(&self, id: &ycoding_core::ycoding_schema::session::Id) {
        let mut started = self.0.subscribe();
        started
            .wait_for(|started| started.contains(id))
            .await
            .unwrap();
    }
}

pub struct World {
    _reports: report_support::Reports,
    pub core: Core,
    pub store: ycoding_core::ycoding_store::Client,
    pub active_children: Arc<ActiveChildren>,
}

pub fn world() -> &'static World {
    static WORLD: OnceLock<World> = OnceLock::new();
    WORLD.get_or_init(|| {
        let directory =
            std::env::temp_dir().join(format!("ycoding-runtime-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("runtime.redb");
        let _ = std::fs::remove_file(&path);
        let store =
            Store::initialize(&path, Options::core(), CATALOG, Metadata::new([7; 16], 1)).unwrap();
        store
            .submit(|tx| {
                project::ProjectTable::insert(
                    tx,
                    &project::Project {
                        id: "prj_one".into(),
                        worktree: "/project".into(),
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: 1,
                        time_updated: 1,
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    },
                )?;
                for id in SESSIONS {
                    let mut row = record(id);
                    if *id == "ses_predict_child" {
                        row.parent_id = Some("ses_rich".into());
                    }
                    if *id == "ses_team" || *id == "ses_team_two" {
                        row.directory = "/project/team".into();
                    }
                    if *id == "ses_predict_unwired" || *id == "ses_prompt_unwired" {
                        row.directory = UNWIRED.into();
                    }
                    session::SessionTable::insert(tx, &row)?;
                }
                for message in rich_messages() {
                    session::MessageTable::insert(tx, &message)?;
                }
                for id in PREDICTABLE {
                    session::MessageTable::insert(
                        tx,
                        &message(
                            id,
                            &format!("msg_{id}_user"),
                            "user",
                            1,
                            r#"{"text":"Fix the failing build","time":{"created":1,"consumed":1}}"#,
                        ),
                    )?;
                    session::MessageTable::insert(
                        tx,
                        &message(
                            id,
                            &format!("msg_{id}_assistant"),
                            "assistant",
                            2,
                            r#"{"agent":"build","model":{"providerID":"openai","id":"gpt-reasoning"},"content":[{"type":"text","text":"The build is fixed."}],"time":{"created":2,"completed":2}}"#,
                        ),
                    )?;
                    session::reserve_sequence(tx, &(*id).into(), 2)?;
                }
                for index in 0..205 {
                    session::MessageTable::insert(
                        tx,
                        &message(
                            "ses_history",
                            &format!("msg_h_{index:03}"),
                            "synthetic",
                            index * 2,
                            &format!(
                                r#"{{"text":"{index:03}-{}","time":{{"created":{index}}}}}"#,
                                "x".repeat(1000)
                            ),
                        ),
                    )?;
                }
                session::reserve_sequence(tx, &"ses_history".into(), 500)?;
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        let client = store.client();
        let reports = report_support::start(client.clone());
        std::mem::forget(store);
        let active_children = Arc::new(ActiveChildren(tokio::sync::watch::channel(BTreeSet::new()).0));
        let execution = Execution::install(
            SessionStore::new(client.clone()),
            Arc::new(TestLocations(active_children.clone())),
            ycoding_core::job::Jobs::new(),
            None,
        )
        .unwrap();
        World {
            _reports: reports,
            core: Core::new(client.clone(), execution, configuration()),
            store: client,
            active_children,
        }
    })
}

fn message(session: &str, id: &str, kind: &str, seq: i64, data: &str) -> session::Message {
    session::Message {
        id: id.into(),
        session_id: session.into(),
        type_: kind.into(),
        seq,
        time_created: seq,
        time_updated: seq,
        data: parse_json(data).unwrap(),
    }
}

fn rich_messages() -> Vec<session::Message> {
    let rows: [(&str, &str, &str); 11] = [
        (
            "msg_rich_01",
            "agent-switched",
            r#"{"time":{"created":1},"agent":"build","metadata":{"origin":"seed"}}"#,
        ),
        (
            "msg_rich_02",
            "model-switched",
            r#"{"time":{"created":2},"model":{"id":"m1","providerID":"p1","variant":"high"},"previous":{"id":"m0","providerID":"p1"}}"#,
        ),
        (
            "msg_rich_03",
            "user",
            r#"{"time":{"created":3,"consumed":4},"text":"hello","agents":[{"name":"reviewer","mention":{"start":0,"end":5,"text":"@rev"}}],"metadata":{"k":[1,true,null,"x"]}}"#,
        ),
        (
            "msg_rich_04",
            "synthetic",
            r#"{"time":{"created":5},"text":"note","description":"d"}"#,
        ),
        (
            "msg_rich_05",
            "system",
            r#"{"time":{"created":6},"text":"sys"}"#,
        ),
        (
            "msg_rich_06",
            "skill",
            r#"{"time":{"created":7},"skill":"review","name":"review","text":"body"}"#,
        ),
        (
            "msg_rich_07",
            "shell",
            r#"{"time":{"created":8,"completed":9},"shellID":"sh_one","command":"ls","status":"memory-limit","exit":0,"output":{"output":"a\n","cursor":0,"size":2,"truncated":false}}"#,
        ),
        (
            "msg_rich_08",
            "assistant",
            r#"{"time":{"created":10,"completed":11},"agent":"build","model":{"id":"m1","providerID":"p1"},"content":[{"type":"text","text":"hi","phase":"final_answer"},{"type":"reasoning","text":"think","state":{"sig":"x"},"time":{"created":10,"completed":10}},{"type":"tool","id":"call_1","name":"read","executed":true,"state":{"status":"completed","input":{"path":"a"},"content":[{"type":"text","text":"ok"},{"type":"file","uri":"file:///a","mime":"text/plain","name":"a"}],"structured":{"lines":1},"result":{"ok":true}},"time":{"created":10,"ran":10,"completed":11}},{"type":"tool","id":"call_2","name":"write","state":{"status":"streaming","input":"{\"pa"},"time":{"created":10}}],"finish":"tool-calls","cost":0.5,"tokens":{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}},"diagnostics":{"contextLimit":1000,"contextBreakdown":{"system":1,"tools":2,"user":3,"assistant":4,"reasoning":5,"toolCalls":6,"other":7},"providerCache":{"mechanism":"none","readReported":false,"writeReported":true}},"error":{"type":"x","message":"y"},"retry":{"attempt":1,"at":12,"error":{"type":"t","message":"m"}}}"#,
        ),
        (
            "msg_rich_09",
            "compaction",
            r#"{"time":{"created":12},"jobID":"cmp_0","trigger":"consider","status":"pending"}"#,
        ),
        (
            "msg_rich_10",
            "compaction",
            r#"{"time":{"created":13},"jobID":"cmp_1","trigger":"manual","status":"running","pressure":{"estimatedInputTokens":10,"safeInputTokens":20}}"#,
        ),
        (
            "msg_rich_11",
            "compaction",
            r#"{"time":{"created":14},"jobID":"cmp_2","trigger":"advised","status":"failed","code":"provider_failed","error":{"type":"provider","message":"boom"}}"#,
        ),
    ];
    rows.iter()
        .enumerate()
        .map(|(index, (id, kind, data))| message("ses_rich", id, kind, index as i64 + 1, data))
        .collect()
}

pub fn services(auth: LocalAuth, core: bool) -> Services {
    Services {
        identity: Identity {
            version: "9.9.9-test".into(),
            pid: std::process::id() as u64,
            source_epoch: "source-epoch-test".into(),
        },
        auth,
        cors: Vec::new(),
        budgets: Budgets::default(),
        core: core.then(|| world().core.clone()),
    }
}

pub fn bare_dispatcher() -> Dispatcher {
    Dispatcher::new(OPERATIONS.clone())
}

pub async fn start(services: Services, dispatcher: Dispatcher) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    serve_with(listener, services, dispatcher).await.unwrap()
}

pub fn operation(name: &str) -> v5::OperationDescriptor {
    OPERATIONS
        .iter()
        .find(|descriptor| descriptor.diagnostic_name == name)
        .unwrap_or_else(|| panic!("operation {name}"))
        .clone()
}

pub fn machine() -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Machine(v5::Empty {})),
    }
}

pub fn session_scope(id: &str) -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Session(id.into())),
    }
}

pub fn text(value: &str) -> v5::LosslessString {
    v5::LosslessString {
        encoding: Some(v5::lossless_string::Encoding::Utf8(value.into())),
    }
}

pub fn units(value: &v5::LosslessString) -> String {
    match value.encoding.as_ref().unwrap() {
        v5::lossless_string::Encoding::Utf8(text) => text.clone(),
        v5::lossless_string::Encoding::Utf16LeUnits(_) => panic!("unexpected code-unit branch"),
    }
}

pub struct Socket {
    stream: TcpStream,
    buffer: Vec<u8>,
}

pub enum Received {
    Binary(Vec<u8>),
    Close(u16, String),
    Eof,
}

impl Socket {
    pub async fn connect(address: SocketAddr, headers: &[(&str, String)]) -> Result<Self, u16> {
        let mut stream = TcpStream::connect(address).await.unwrap();
        let mut request = format!(
            "GET /ws/v5/local HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
        );
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buffer = Vec::new();
        let end = loop {
            if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                break position + 4;
            }
            let mut chunk = [0u8; 4096];
            let read = timeout(WAIT, stream.read(&mut chunk))
                .await
                .unwrap()
                .unwrap();
            assert!(read > 0, "upgrade response closed early");
            buffer.extend_from_slice(&chunk[..read]);
        };
        let head = String::from_utf8_lossy(&buffer[..end]).to_string();
        let status = head
            .split_whitespace()
            .nth(1)
            .and_then(|status| status.parse::<u16>().ok())
            .unwrap();
        if status != 101 {
            return Err(status);
        }
        buffer.drain(..end);
        Ok(Self { stream, buffer })
    }

    pub async fn send_binary(&mut self, payload: &[u8]) {
        self.write(2, payload).await;
    }

    pub async fn send_text(&mut self, payload: &str) {
        self.write(1, payload.as_bytes()).await;
    }

    async fn write(&mut self, opcode: u8, payload: &[u8]) {
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        let mut out = vec![0x80 | opcode];
        match payload.len() {
            length if length < 126 => out.push(0x80 | length as u8),
            length if length <= 0xffff => {
                out.push(0x80 | 126);
                out.extend((length as u16).to_be_bytes());
            }
            length => {
                out.push(0x80 | 127);
                out.extend((length as u64).to_be_bytes());
            }
        }
        out.extend(mask);
        out.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
        let _ = self.stream.write_all(&out).await;
    }

    pub async fn receive(&mut self) -> Received {
        self.receive_within(WAIT)
            .await
            .expect("timed out waiting for the server")
    }

    pub async fn receive_within(&mut self, wait: Duration) -> Option<Received> {
        loop {
            if let Some((opcode, payload, used)) = parse(&self.buffer) {
                self.buffer.drain(..used);
                match opcode {
                    2 => return Some(Received::Binary(payload)),
                    8 => {
                        let code = payload
                            .get(..2)
                            .map_or(1005, |code| u16::from_be_bytes([code[0], code[1]]));
                        let reason = String::from_utf8_lossy(payload.get(2..).unwrap_or(&[]));
                        return Some(Received::Close(code, reason.into()));
                    }
                    _ => continue,
                }
            }
            let mut chunk = [0u8; 8192];
            match timeout(wait, self.stream.read(&mut chunk)).await {
                Ok(Ok(read)) if read > 0 => self.buffer.extend_from_slice(&chunk[..read]),
                Ok(_) => return Some(Received::Eof),
                Err(_) => return None,
            }
        }
    }

    pub async fn expect_end(&mut self) -> Option<(u16, String)> {
        loop {
            match self.receive().await {
                Received::Close(code, reason) => return Some((code, reason)),
                Received::Eof => return None,
                Received::Binary(_) => continue,
            }
        }
    }
}

fn parse(buffer: &[u8]) -> Option<(u8, Vec<u8>, usize)> {
    let first = *buffer.first()?;
    let second = *buffer.get(1)?;
    let (length, header) = match second & 0x7f {
        126 => (
            u16::from_be_bytes([*buffer.get(2)?, *buffer.get(3)?]) as usize,
            4,
        ),
        127 => (
            u64::from_be_bytes(buffer.get(2..10)?.try_into().ok()?) as usize,
            10,
        ),
        length => (length as usize, 2),
    };
    let payload = buffer.get(header..header + length)?.to_vec();
    Some((first & 0x0f, payload, header + length))
}

pub enum Event {
    Settled(String, Outcome, u64),
    Closed(Close),
}

pub fn session_log_record(record: &v5::EventRecord) -> v5::EventRecord {
    if record.event.type_name == v5::SessionLogItem::full_name() {
        return record.clone();
    }
    assert_eq!(record.event.type_name, v5::PublicEvent::full_name());
    decode_strict::<v5::PublicEvent>(&record.event.payload).unwrap();
    let mut body = record.event.payload.as_slice();
    let tag = prost::encoding::decode_varint(&mut body).unwrap() >> 3;
    let descriptor = ycoding_protocol::PUBLIC_EVENTS
        .iter()
        .find(|event| u64::from(event.2) == tag)
        .unwrap();
    assert!(descriptor.1);
    let variant = descriptor
        .3
        .strip_prefix("ycoding.v5.SessionLogItemValue")
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let mut payload = Vec::new();
    prost::encoding::encode_varint((variant << 3) | 2, &mut payload);
    payload.extend_from_slice(body);
    decode_strict::<v5::SessionLogItem>(&payload).unwrap();
    let mut record = record.clone();
    record.event = v5::TypedPayload {
        type_name: v5::SessionLogItem::full_name(),
        payload,
    };
    record
}

pub struct Client {
    pub socket: Socket,
    pub connection: Connection,
    started: Instant,
    pub hold: bool,
    pub events: VecDeque<Event>,
    pub batches: VecDeque<v5::EventBatch>,
    pub ended: Vec<String>,
    pub resyncs: Vec<v5::ResyncRequired>,
    pub last_frame_len: usize,
    pub close: Option<(u16, String)>,
    pub established: bool,
    pub epoch: String,
    pub source_epoch: String,
}

impl Client {
    pub async fn open(address: SocketAddr, headers: &[(&str, String)]) -> Result<Self, u16> {
        Self::open_with(address, headers, Budgets::default()).await
    }

    pub async fn open_with(
        address: SocketAddr,
        headers: &[(&str, String)],
        budgets: Budgets,
    ) -> Result<Self, u16> {
        let socket = Socket::connect(address, headers).await?;
        let connection = Connection::new(
            Config {
                local_role: v5::PeerRole::LocalClient,
                peer_role: v5::PeerRole::Server,
                source_epoch: "client-source".into(),
                connection_epoch: "client-connection".into(),
                budgets,
                authorized_sessions: BTreeSet::new(),
                authorized_workspaces: BTreeSet::new(),
                reservation: None,
                event_types: BTreeSet::from([
                    "ycoding.v5.SessionLogItem".into(),
                    "ycoding.v5.PublicEvent".into(),
                ]),
            },
            OPERATIONS.clone(),
            0,
        )
        .unwrap();
        let mut client = Self {
            socket,
            connection,
            started: Instant::now(),
            hold: false,
            events: VecDeque::new(),
            batches: VecDeque::new(),
            ended: Vec::new(),
            resyncs: Vec::new(),
            last_frame_len: 0,
            close: None,
            established: false,
            epoch: String::new(),
            source_epoch: String::new(),
        };
        client.connection.start(client.now()).unwrap();
        while !client.established && client.close.is_none() {
            client.step().await;
        }
        Ok(client)
    }

    pub fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    pub async fn pump(&mut self) {
        loop {
            let now = self.now();
            let Some(prepared) = self.connection.prepare_handoff(now) else {
                break;
            };
            let bytes = prepared.frame().encode_to_vec();
            let decisions = self
                .connection
                .handoff(prepared, bytes.len() as u64, now)
                .unwrap();
            if decisions
                .iter()
                .any(|decision| matches!(decision, Decision::Send(_)))
            {
                self.socket.send_binary(&bytes).await;
            }
            self.absorb(decisions, None);
        }
        let notifications = self.connection.take_decisions();
        self.absorb(notifications, None);
    }

    pub async fn step(&mut self) {
        self.pump().await;
        match self.socket.receive_within(Duration::from_millis(20)).await {
            Some(Received::Binary(bytes)) => self.feed(&bytes),
            Some(Received::Close(code, reason)) => self.close = Some((code, reason)),
            Some(Received::Eof) => self.close = Some((0, String::new())),
            None => {}
        }
        self.pump().await;
    }

    pub async fn run_for(&mut self, wait: Duration) {
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline && self.close.is_none() {
            self.step().await;
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        self.last_frame_len = bytes.len();
        let now = self.now();
        let token = self
            .connection
            .admit_incoming(bytes.len() as u64)
            .expect("client admits server frame");
        let frame = decode_strict::<v5::Frame>(bytes).expect("server frame decodes");
        let ordinal = frame.delivery_ordinal;
        if let Some(v5::frame::Body::Ready(ready)) = &frame.body {
            self.epoch = ready.connection_epoch.clone();
            self.source_epoch = ready.source_epoch.clone();
        }
        let decisions = self.connection.accept_incoming(&token, frame, now).unwrap();
        self.absorb(decisions, ordinal);
    }

    fn absorb(&mut self, decisions: Vec<Decision>, ordinal: Option<u64>) {
        let closing = decisions.iter().find_map(|decision| match decision {
            Decision::Closed(close) => Some(close.clone()),
            _ => None,
        });
        if let Some(close) = closing {
            self.close = Some((close.code, format!("client machine: {}", close.reason())));
            self.events.push_back(Event::Closed(close));
            return;
        }
        for decision in decisions {
            match decision {
                Decision::Established => self.established = true,
                Decision::Settled {
                    request_id,
                    outcome,
                } => {
                    let ordinal = ordinal.unwrap_or(0);
                    if !self.hold
                        && ordinal > 0
                        && !matches!(
                            outcome,
                            Outcome::BulkSuccess { .. } | Outcome::AssetSuccess { .. }
                        )
                    {
                        let now = self.now();
                        self.connection
                            .consume(v5::LedgerClass::Normal, ordinal, now)
                            .unwrap();
                    }
                    if let Outcome::BulkSuccess { start, .. }
                    | Outcome::AssetSuccess { start, .. } = &outcome
                    {
                        self.connection.release_bulk(&start.transfer_id).unwrap();
                    }
                    self.events
                        .push_back(Event::Settled(request_id, outcome, ordinal));
                }
                Decision::Closed(close) => self.events.push_back(Event::Closed(close)),
                Decision::Events(batch) => {
                    let ordinal = ordinal.unwrap_or(0);
                    if !self.hold && ordinal > 0 {
                        let now = self.now();
                        self.connection
                            .consume(v5::LedgerClass::Event, ordinal, now)
                            .unwrap();
                    }
                    self.batches.push_back(batch);
                }
                Decision::StreamComplete(subscription) => {
                    self.ended.push(subscription);
                }
                Decision::Resync(resync) => self.resyncs.push(resync),
                _ => {}
            }
        }
    }

    pub fn consume(&mut self, ordinal: u64) {
        let now = self.now();
        self.connection
            .consume(v5::LedgerClass::Normal, ordinal, now)
            .unwrap();
    }

    pub async fn send(&mut self, name: &str, scope: v5::Scope, payload: Vec<u8>) -> String {
        let descriptor = operation(name);
        let reserve = v5::Frame {
            revision: 5,
            connection_epoch: Some("x".repeat(64)),
            ledger: Some(v5::LedgerClass::Normal as i32),
            delivery_ordinal: Some(u64::MAX),
            tiny_consumed_through: Some(u64::MAX),
            body: Some(v5::frame::Body::Request(v5::Request {
                request_id: u64::MAX.to_string(),
                operation_id: descriptor.operation_id,
                scope: scope.clone(),
                payload: payload.clone(),
            })),
        }
        .encoded_len() as u64;
        let now = self.now();
        let id = self
            .connection
            .request(descriptor.operation_id, scope, payload, reserve, now)
            .unwrap();
        self.pump().await;
        id
    }

    pub async fn settle(&mut self, request_id: &str) -> Outcome {
        self.settle_held(request_id).await.0
    }

    pub async fn settle_held(&mut self, request_id: &str) -> (Outcome, u64) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(Instant::now() < deadline, "timed out settling {request_id}");
            if let Some(position) = self
                .events
                .iter()
                .position(|event| matches!(event, Event::Settled(id, _, _) if id == request_id))
            {
                let Some(Event::Settled(_, outcome, ordinal)) = self.events.remove(position) else {
                    unreachable!()
                };
                return (outcome, ordinal);
            }
            assert!(
                !self
                    .events
                    .iter()
                    .any(|event| matches!(event, Event::Closed(_)))
                    && self.close.is_none(),
                "connection closed while waiting for {request_id}: {:?} {:?}",
                self.close,
                self.events.iter().find_map(|event| match event {
                    Event::Closed(close) => Some(close.category),
                    _ => None,
                })
            );
            self.step().await;
        }
    }

    pub async fn call(&mut self, name: &str, scope: v5::Scope, payload: Vec<u8>) -> Outcome {
        let id = self.send(name, scope, payload).await;
        self.settle(&id).await
    }

    pub async fn subscribe_log(&mut self, request_id: &str, scope: v5::Scope) -> String {
        let outcome = self.settle(request_id).await;
        let result: v5::SessionLogResult = success(outcome);
        let sub = match result.subscription_id.encoding.as_ref().unwrap() {
            v5::lossless_string::Encoding::Utf8(id) => id.clone(),
            v5::lossless_string::Encoding::Utf16LeUnits(_) => {
                panic!("unexpected subscription ID branch")
            }
        };
        let now = self.now();
        self.connection
            .accept_subscription(
                request_id,
                sub.clone(),
                scope,
                now,
                ycoding_protocol::connection::Direction::Receive,
                None,
            )
            .unwrap();
        self.connection.begin_hydration(&sub).unwrap();
        let now = self.now();
        let source_epoch = self.source_epoch.clone();
        for decision in self
            .connection
            .complete_hydration(&sub, source_epoch, now)
            .unwrap()
        {
            self.absorb(vec![decision], None);
        }
        self.pump().await;
        sub
    }

    pub async fn subscribe_events(&mut self, request_id: &str, scope: v5::Scope) -> String {
        let outcome = self.settle(request_id).await;
        let result: v5::EventSubscribeResult = success(outcome);
        let sub = match result.subscription_id.encoding.as_ref().unwrap() {
            v5::lossless_string::Encoding::Utf8(id) => id.clone(),
            v5::lossless_string::Encoding::Utf16LeUnits(_) => {
                panic!("unexpected subscription ID branch")
            }
        };
        let now = self.now();
        self.connection
            .accept_subscription(
                request_id,
                sub.clone(),
                scope,
                now,
                ycoding_protocol::connection::Direction::Receive,
                None,
            )
            .unwrap();
        self.connection.begin_hydration(&sub).unwrap();
        let now = self.now();
        let source_epoch = self.source_epoch.clone();
        for decision in self
            .connection
            .complete_hydration(&sub, source_epoch, now)
            .unwrap()
        {
            self.absorb(vec![decision], None);
        }
        self.pump().await;
        sub
    }

    pub async fn closed(&mut self) -> (u16, String) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(close) = self.close.clone() {
                return close;
            }
            assert!(Instant::now() < deadline, "timed out waiting for close");
            self.step().await;
        }
    }
}

pub fn success<T: Message + Default>(outcome: Outcome) -> T {
    match outcome {
        Outcome::Success { payload, .. } => T::decode(payload.payload.as_slice()).unwrap(),
        Outcome::BulkSuccess { bytes, .. } => T::decode(bytes.as_slice()).unwrap(),
        other => panic!("expected success, got {other:?}"),
    }
}

pub fn rejected(outcome: Outcome) -> v5::TypedPayload {
    match outcome {
        Outcome::Rejected(payload) => payload,
        other => panic!("expected rejection, got {other:?}"),
    }
}

pub fn basic(password: &str) -> String {
    format!(
        "Basic {}",
        encode_base64(format!("ycoding:{password}").as_bytes())
    )
}

pub fn basic_for(username: &str, password: &str) -> String {
    format!(
        "Basic {}",
        encode_base64(format!("{username}:{password}").as_bytes())
    )
}

fn encode_base64(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    input
        .chunks(3)
        .flat_map(|chunk| {
            let value = chunk.iter().enumerate().fold(0u32, |value, (index, byte)| {
                value | (u32::from(*byte) << (16 - 8 * index))
            });
            (0..4).map(move |index| {
                if index > chunk.len() {
                    '='
                } else {
                    ALPHABET[((value >> (18 - 6 * index)) & 0x3f) as usize] as char
                }
            })
        })
        .collect()
}

static PUBLISHED: Mutex<Vec<Published>> = Mutex::new(Vec::new());

pub fn published(kind: &str) -> Vec<Published> {
    PUBLISHED
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.type_ == kind)
        .cloned()
        .collect()
}

pub fn snapshot_data() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("runtime-snapshots-{}", std::process::id()))
}

pub const UNWIRED: &str = "/unwired";

pub struct Script {
    reply: Mutex<Option<String>>,
    gate: Mutex<Option<Arc<tokio::sync::Notify>>>,
    started: tokio::sync::Notify,
    requests: Mutex<Vec<(String, String)>>,
    interrupted: std::sync::atomic::AtomicUsize,
}

impl Script {
    pub fn reply(&self, text: Option<&str>) {
        *self.reply.lock().unwrap() = text.map(str::to_owned);
    }

    pub fn hold(&self) -> Arc<tokio::sync::Notify> {
        let gate = Arc::new(tokio::sync::Notify::new());
        *self.gate.lock().unwrap() = Some(gate.clone());
        gate
    }

    pub async fn started(&self) {
        timeout(WAIT, self.started.notified())
            .await
            .expect("the helper received no request");
    }

    pub fn requests(&self) -> Vec<(String, String)> {
        self.requests.lock().unwrap().clone()
    }

    pub fn interrupted(&self) -> usize {
        self.interrupted.load(std::sync::atomic::Ordering::SeqCst)
    }
}

pub fn script(session: &str) -> Arc<Script> {
    generate_state()
        .scripts
        .lock()
        .unwrap()
        .entry(session.to_owned())
        .or_insert_with(|| {
            Arc::new(Script {
                reply: Mutex::new(None),
                gate: Mutex::new(None),
                started: tokio::sync::Notify::new(),
                requests: Mutex::new(Vec::new()),
                interrupted: std::sync::atomic::AtomicUsize::new(0),
            })
        })
        .clone()
}

struct ScriptedGenerate {
    scripts: Mutex<std::collections::BTreeMap<String, Arc<Script>>>,
}

fn generate_state() -> &'static ScriptedGenerate {
    static STATE: OnceLock<ScriptedGenerate> = OnceLock::new();
    STATE.get_or_init(|| ScriptedGenerate {
        scripts: Mutex::new(std::collections::BTreeMap::new()),
    })
}

struct Scripted;

impl Generate for Scripted {
    fn resolves(
        &self,
        _: &ycoding_core::ycoding_schema::session::Info,
        _: ycoding_core::tools::policy::helper::Role,
        _: &ycoding_core::ycoding_schema::agent::Info,
    ) -> bool {
        true
    }

    fn generate<'a>(&'a self, request: Request<'a>) -> Generation<'a> {
        Box::pin(async move {
            let script = script(&request.session.id.as_lossless().to_utf8().unwrap());
            script
                .requests
                .lock()
                .unwrap()
                .push((request.source.to_owned(), request.user.clone()));
            script.started.notify_one();
            let gate = script.gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                tokio::select! {
                    _ = gate.notified() => {}
                    _ = request.cancellation.cancelled() => {
                        script.interrupted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        return None;
                    }
                }
            }
            if request.cancellation.is_cancelled() {
                return None;
            }
            script.reply.lock().unwrap().clone()
        })
    }
}

fn generate() -> Arc<dyn Generate> {
    Arc::new(Scripted)
}

fn helper_memory() -> Arc<memory::Service> {
    static MEMORY: OnceLock<Arc<memory::Service>> = OnceLock::new();
    MEMORY
        .get_or_init(|| {
            let directory = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
                .join(format!("runtime-memory-{}", std::process::id()));
            std::fs::create_dir_all(&directory).unwrap();
            Arc::new(
                memory::Service::new(memory::Options {
                    directory: directory.clone(),
                    home: directory.clone(),
                    data: directory.join("data"),
                    repository: None,
                    limits: memory::Limits::default(),
                })
                .unwrap(),
            )
        })
        .clone()
}

fn configuration() -> Configuration {
    let rule = |action: &str, resource: &str, effect: &str| permission::Rule {
        action: action.into(),
        resource: resource.into(),
        effect: permission::Effect(effect.into()),
    };
    let mut build = agent::empty("build".into());
    build.permissions = vec![
        rule("*", "*", "ask"),
        rule("read", "*", "allow"),
        rule("blocked", "*", "deny"),
    ];
    Configuration {
        helpers: Some(Arc::new(|info| {
            (info.directory.as_lossless().to_utf8().ok()? != UNWIRED).then(|| HelperEnvironment {
                generate: generate(),
                memory: helper_memory(),
            })
        })),
        agents: Arc::new(agent::Service::new(vec![
            build,
            prediction::agent(),
            prompt_generator::agent(),
        ])),
        publisher: Arc::new(|event| {
            PUBLISHED.lock().unwrap().push(event);
            Ok(())
        }),
        guardrails: Settings {
            paths: Paths {
                workdir: "".into(),
                project: "".into(),
                home: "/home/operator".into(),
                tmpdir: None,
                trusted_paths: vec![],
            },
            global_roots: vec![],
            custom: Arc::new(Vec::new),
            enabled: true,
            limits: Limits::default(),
            decide_reviews: false,
            decide_hard_reviews: true,
        },
        snapshots: SnapshotSettings {
            git: Arc::new(git::Service::new(16 * 1024 * 1024)),
            data: snapshot_data(),
            enabled: true,
        },
    }
}

pub async fn insert_session(id: &str, directory: &str, workspace: Option<&str>) {
    insert_session_of("prj_one", id, directory, workspace).await;
}

pub async fn insert_project(id: &str, worktree: &str) {
    let (id, worktree) = (id.to_string(), worktree.to_string());
    world()
        .store
        .submit(move |tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: id.into(),
                    worktree: worktree.into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
}

pub async fn insert_message(session: &str, id: &str, kind: &str, seq: i64, data: &str) {
    let row = message(session, id, kind, seq, data);
    world()
        .store
        .submit(move |tx| {
            session::MessageTable::insert(tx, &row)?;
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
}

pub async fn insert_session_of(project: &str, id: &str, directory: &str, workspace: Option<&str>) {
    let mut row = record(id);
    row.project_id = project.into();
    row.directory = directory.into();
    row.workspace_id = workspace.map(Into::into);
    world()
        .store
        .submit(move |tx| {
            session::SessionTable::insert(tx, &row)?;
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
}
