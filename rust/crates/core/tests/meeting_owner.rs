use serde_json::{Value, json};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use ycoding_core::meeting::BoxFuture;
use ycoding_core::meeting::config::{AnalysisModel, MeetingConfig, TranscriptionConfig};
use ycoding_core::meeting::discovery::Control;
use ycoding_core::meeting::intelligence::{Generate, Mcp, McpResult, McpServer, McpTool};
use ycoding_core::meeting::owner::{Catalog, CatalogModel};
use ycoding_core::meeting::pcm::AudioChunk;
use ycoding_core::meeting::runtime::ProviderFactory;
use ycoding_core::meeting::service::{MeetingService, ServiceOptions};
use ycoding_core::meeting::transcription::{
    Health, TranscribeContext, Transcript, TranscriptionError, TranscriptionProvider,
};

static NEXT: AtomicU64 = AtomicU64::new(0);

async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(25), work)
        .await
        .expect("owner settings test exceeded 25 seconds")
}

struct Silent;

impl TranscriptionProvider for Silent {
    fn id(&self) -> &str {
        "huggingface"
    }
    fn initialize<'a>(
        &'a self,
        _: &'a TranscriptionConfig,
    ) -> BoxFuture<'a, Result<(), TranscriptionError>> {
        Box::pin(async { Ok(()) })
    }
    fn transcribe<'a>(
        &'a self,
        _: &'a AudioChunk,
        _: TranscribeContext,
    ) -> BoxFuture<'a, Result<Vec<Transcript>, TranscriptionError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn health_check(&self) -> BoxFuture<'_, Result<Health, TranscriptionError>> {
        Box::pin(async {
            Ok(Health {
                healthy: true,
                initialized: true,
                metrics: None,
            })
        })
    }
    fn dispose(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

struct Inventory {
    models: Vec<CatalogModel>,
    servers: Vec<McpServer>,
    tools: Vec<McpTool>,
    catalog_fails: bool,
}

struct Registry {
    inventory: Mutex<Inventory>,
    calls: Mutex<Vec<(String, String)>>,
}

impl Mcp for Registry {
    fn tools(&self) -> BoxFuture<'_, Result<Vec<McpTool>, String>> {
        let tools = self.inventory.lock().unwrap().tools.clone();
        Box::pin(async move { Ok(tools) })
    }

    fn servers(&self) -> BoxFuture<'_, Result<Vec<McpServer>, String>> {
        let servers = self.inventory.lock().unwrap().servers.clone();
        Box::pin(async move { Ok(servers) })
    }

    fn call_tool(
        &self,
        server: &str,
        name: &str,
        _: Value,
    ) -> BoxFuture<'_, Result<McpResult, String>> {
        self.calls
            .lock()
            .unwrap()
            .push((server.to_owned(), name.to_owned()));
        Box::pin(async {
            Ok(McpResult {
                is_error: false,
                structured: Some(json!({ "documents": [] })),
                text: Vec::new(),
            })
        })
    }
}

fn model(id: &str, name: &str, enabled: bool, status: &str, variants: &[&str]) -> CatalogModel {
    CatalogModel {
        provider_id: "p".into(),
        id: id.into(),
        name: name.into(),
        enabled: Some(enabled),
        status: Some(status.into()),
        variants: variants
            .iter()
            .map(|variant| (*variant).to_owned())
            .collect(),
        profiles: Vec::new(),
    }
}

fn tool(server: &str, name: &str, input_schema: Option<Value>) -> McpTool {
    McpTool {
        server: server.into(),
        name: name.into(),
        input_schema,
    }
}

fn revision_aware() -> Value {
    json!({
        "type": "object",
        "properties": { "id": {}, "content": {}, "expectedRevision": {} },
        "required": ["id", "content", "expectedRevision"],
    })
}

fn inventory() -> Inventory {
    Inventory {
        models: vec![
            model("m1", "Model One", true, "active", &["fast", "deep"]),
            model("m2", "Model Two", false, "active", &[]),
            model("m3", "Model Three", true, "deprecated", &[]),
        ],
        servers: vec![
            McpServer {
                name: "docs".into(),
                status: Some("connected".into()),
            },
            McpServer {
                name: "wiki".into(),
                status: Some("failed".into()),
            },
        ],
        tools: vec![
            tool("docs", "search", None),
            tool("docs", "read", None),
            tool("docs", "replace", Some(revision_aware())),
            tool("wiki", "find", None),
            tool("wiki", "get", None),
            tool(
                "wiki",
                "put",
                Some(json!({ "type": "object", "properties": { "id": {} }, "required": ["id"] })),
            ),
            tool("notes", "lookup", None),
        ],
        catalog_fails: false,
    }
}

type Created = Arc<Mutex<Vec<(Option<String>, AnalysisModel)>>>;

struct Fixture {
    directory: PathBuf,
    service: Option<MeetingService>,
    registry: Arc<Registry>,
    created: Created,
    hold: Arc<Notify>,
    held: Arc<Notify>,
    http: reqwest::Client,
}

impl Fixture {
    async fn start(config: Value, inventory: Inventory) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "ycoding-meeting-owner-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut fixture = Self {
            directory,
            service: None,
            registry: Arc::new(Registry {
                inventory: Mutex::new(inventory),
                calls: Mutex::new(Vec::new()),
            }),
            created: Created::default(),
            hold: Arc::new(Notify::new()),
            held: Arc::new(Notify::new()),
            http: reqwest::Client::builder().no_proxy().build().unwrap(),
        };
        fixture.service = Some(fixture.launch(config).await);
        let database = fixture.service().runtime().database().clone();
        database
            .create_meeting("meeting-1", "Owner settings", "analysis-session")
            .await
            .unwrap();
        database
            .put_segment(&json!({
                "id": "segment-1", "meetingID": "meeting-1", "sequence": 1, "source": "remote",
                "speakerID": "remote-unknown", "startMs": 0, "endMs": 900,
                "rawText": "Rollout decision pending", "text": "Rollout decision pending",
                "state": "final", "model": "speech", "createdAt": "2026-10-12T00:00:00.000Z",
            }))
            .await
            .unwrap();
        fixture
            .control(json!({ "action": "select", "meetingID": "meeting-1" }))
            .await;
        fixture
    }

    async fn launch(&self, config: Value) -> MeetingService {
        let created = self.created.clone();
        let factory: ProviderFactory =
            Arc::new(|_| Ok(Arc::new(Silent) as Arc<dyn TranscriptionProvider>));
        let mut options = ServiceOptions::new(
            self.directory.clone(),
            MeetingConfig::parse(&config).unwrap(),
            Arc::new(move |parent, model| {
                let mut created = created.lock().unwrap();
                created.push((parent, model));
                let session = format!("session-{}", created.len());
                Box::pin(async move { Ok(session) })
            }),
        );
        options.provider_factory = Some(factory);
        let (hold, held) = (self.hold.clone(), self.held.clone());
        let generate: Generate = Arc::new(move |_, prompt| {
            let (hold, held) = (hold.clone(), held.clone());
            Box::pin(async move {
                if prompt.contains("\"question\":\"hold\"") {
                    held.notify_one();
                    hold.notified().await;
                }
                Ok(if prompt.contains("\"question\":") {
                    "Advisory answer [segment-1]".to_owned()
                } else {
                    json!({ "summary": "Rollout pending", "findings": [], "proposals": [] })
                        .to_string()
                })
            })
        });
        options.generate = Some(generate);
        options.mcp = Some(self.registry.clone());
        let registry = self.registry.clone();
        let catalog: Catalog = Arc::new(move || {
            let inventory = registry.inventory.lock().unwrap();
            let result = if inventory.catalog_fails {
                Err("catalog unavailable".to_owned())
            } else {
                Ok(inventory.models.clone())
            };
            Box::pin(async move { result })
        });
        options.catalog = Some(catalog);
        MeetingService::start(options).await.unwrap()
    }

    fn service(&self) -> &MeetingService {
        self.service.as_ref().unwrap()
    }

    fn url(&self) -> String {
        self.service().url().to_owned()
    }

    async fn control(&self, input: Value) -> Value {
        Control::connect(&self.directory)
            .unwrap()
            .send(&input)
            .await
            .unwrap()
    }

    async fn links(&self) -> (String, String) {
        let ordinary = self.control(json!({ "action": "view" })).await;
        let owner = self.control(json!({ "action": "owner-view" })).await;
        let key = ordinary["url"]
            .as_str()
            .unwrap()
            .split_once("#key=")
            .unwrap()
            .1
            .to_owned();
        let owner = owner["url"]
            .as_str()
            .unwrap()
            .split_once("&owner=")
            .unwrap()
            .1
            .to_owned();
        (key, owner)
    }

    async fn request(&self, route: &str, token: &str, body: Option<Value>) -> (u16, Value) {
        let url = format!("{}{route}", self.url());
        let request = match body {
            Some(body) => self
                .http
                .post(url)
                .header("content-type", "application/json")
                .body(body.to_string()),
            None => self.http.get(url),
        };
        let response = request
            .header("origin", self.url())
            .header("authorization", format!("Bearer {token}"))
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or(Value::String(text)),
        )
    }

    async fn read(&self, owner: &str) -> Value {
        let (status, body) = self.request("/view/owner/settings", owner, None).await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn save(&self, owner: &str, update: Value) -> (u16, Value) {
        self.request("/view/owner/settings", owner, Some(update))
            .await
    }

    async fn ask(&self, key: &str, question: &str) -> Value {
        let (status, body) = self
            .request("/view/ask", key, Some(json!({ "question": question })))
            .await;
        assert_eq!(status, 200, "{body}");
        body
    }

    fn last_created(&self) -> (Option<String>, AnalysisModel) {
        self.created.lock().unwrap().last().cloned().unwrap()
    }

    fn saved(&self) -> Option<Value> {
        std::fs::read_to_string(self.directory.join("settings.json"))
            .ok()
            .map(|text| serde_json::from_str(&text).unwrap())
    }

    fn calls(&self) -> Vec<(String, String)> {
        self.registry.calls.lock().unwrap().clone()
    }

    async fn summarize(&self, sequence: u64) {
        self.service()
            .runtime()
            .database()
            .put_segment(&json!({
                "id": format!("segment-{sequence}"), "meetingID": "meeting-1", "sequence": sequence,
                "source": "remote", "speakerID": "remote-unknown", "startMs": sequence * 1000,
                "endMs": sequence * 1000 + 900, "rawText": "Rollout owner named", "text": "Rollout owner named",
                "state": "final", "model": "speech", "createdAt": "2026-10-12T00:00:00.000Z",
            }))
            .await
            .unwrap();
        self.registry.calls.lock().unwrap().clear();
        self.control(json!({ "action": "summary", "meetingID": "meeting-1" }))
            .await;
        self.service().runtime().settled().await;
    }

    async fn shutdown(mut self) {
        if let Some(service) = self.service.take() {
            service.shutdown().await.unwrap();
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn explicit(id: &str, variant: Option<&str>, profile: Option<&str>) -> AnalysisModel {
    AnalysisModel::Explicit {
        id: id.into(),
        provider_id: "p".into(),
        variant: variant.map(Into::into),
        profile: profile.map(Into::into),
    }
}

fn binding(server: &str, search: &str, read: &str, write: Option<&str>, enabled: bool) -> Value {
    let mut binding =
        json!({ "server": server, "search": search, "read": read, "enabled": enabled });
    if let Some(write) = write {
        binding["write"] = json!(write);
    }
    binding
}

fn quiet() -> Value {
    json!({ "analysis": { "incremental": false } })
}

#[tokio::test]
async fn owner_read_returns_live_catalog_and_registry_inventory_without_calling_tools() {
    bounded(async {
        let f = Fixture::start(quiet(), inventory()).await;
        let (key, owner) = f.links().await;
        let settings = f.read(&owner).await;
        assert_eq!(settings["askModel"], "inherit");
        assert_eq!(settings["analysisModel"], "inherit");
        assert_eq!(
            settings["models"],
            json!([
                { "providerID": "p", "id": "m1", "name": "Model One", "enabled": true, "status": "active", "variants": ["fast", "deep"] },
                { "providerID": "p", "id": "m2", "name": "Model Two", "enabled": false, "status": "active", "variants": [] },
                { "providerID": "p", "id": "m3", "name": "Model Three", "enabled": true, "status": "deprecated", "variants": [] },
            ])
        );
        assert_eq!(
            settings["servers"],
            json!([
                { "name": "docs", "status": "connected", "tools": ["search", "read", "replace"] },
                { "name": "wiki", "status": "failed", "tools": ["find", "get", "put"] },
                { "name": "notes", "tools": ["lookup"] },
            ])
        );
        assert_eq!(
            settings["knowledge"],
            json!({ "mcpEnabled": true, "autoApply": false, "requireApproval": true, "bindings": [] })
        );
        assert!(f.calls().is_empty());
        let text = settings.to_string();
        assert!(!text.contains(&owner) && !text.contains(&key));
        let (status, state) = f.request("/view/state", &key, None).await;
        assert_eq!(status, 200);
        assert!(!state.to_string().contains(&owner));
        assert_eq!(f.request("/view/state", &owner, None).await.0, 401);
        f.shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn owner_read_reports_profiles_only_when_the_catalog_does_and_fails_explicitly_on_catalog_errors()
 {
    bounded(async {
        let mut profiled = inventory();
        profiled.models[0].profiles = vec!["acct".into(), "work".into()];
        profiled.models[1].enabled = None;
        profiled.models[1].status = None;
        let f = Fixture::start(quiet(), profiled).await;
        let (_, owner) = f.links().await;
        let settings = f.read(&owner).await;
        assert_eq!(settings["models"][0]["profiles"], json!(["acct", "work"]));
        assert!(settings["models"][2].get("profiles").is_none());
        assert_eq!(
            settings["models"][1],
            json!({ "providerID": "p", "id": "m2", "name": "Model Two", "variants": [] })
        );
        f.registry.inventory.lock().unwrap().catalog_fails = true;
        assert_eq!(
            f.request("/view/owner/settings", &owner, None).await,
            (500, json!({ "error": "owner_failed" }))
        );
        assert_eq!(
            f.save(&owner, json!({ "askModel": "inherit" })).await,
            (500, json!({ "error": "owner_failed" }))
        );
        assert!(f.saved().is_none());
        f.shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn owner_update_rejects_selections_absent_from_live_inventory_and_persists_nothing() {
    bounded(async {
        let mut profiled = inventory();
        profiled.models[0].profiles = vec!["acct".into()];
        let f = Fixture::start(quiet(), profiled).await;
        let (_, owner) = f.links().await;
        for rejected in [
            json!({ "askModel": { "providerID": "p", "id": "missing" } }),
            json!({ "askModel": { "providerID": "q", "id": "m1" } }),
            json!({ "askModel": { "providerID": "p", "id": "m1", "variant": "missing" } }),
            json!({ "askModel": { "providerID": "p", "id": "m1", "profile": "other" } }),
            json!({ "askModel": { "providerID": "p", "id": "m2" } }),
            json!({ "askModel": { "providerID": "p", "id": "m3" } }),
            json!({ "knowledge": { "mcpEnabled": true, "bindings": [binding("missing", "search", "read", None, true)] } }),
            json!({ "knowledge": { "mcpEnabled": true, "bindings": [binding("docs", "missing", "read", None, true)] } }),
            json!({ "knowledge": { "mcpEnabled": true, "bindings": [binding("docs", "search", "missing", None, true)] } }),
            json!({ "knowledge": { "mcpEnabled": true, "bindings": [binding("docs", "search", "read", Some("missing"), true)] } }),
            json!({ "knowledge": { "mcpEnabled": true, "bindings": [binding("docs", "find", "get", None, true)] } }),
            json!({ "knowledge": { "mcpEnabled": true, "bindings": [
                binding("docs", "search", "read", None, true),
                binding("docs", "search", "read", None, false),
            ] } }),
            json!({ "knowledge": { "mcpEnabled": false, "bindings": [
                binding("offline", "a", "b", None, false),
                binding("offline", "a", "b", None, false),
            ] } }),
            json!({ "askModel": { "providerID": "p", "id": "m1" }, "knowledge": { "mcpEnabled": true, "bindings": [binding("missing", "s", "r", None, true)] } }),
        ] {
            assert_eq!(
                f.save(&owner, rejected.clone()).await,
                (422, json!({ "error": "selection_unavailable" })),
                "accepted {rejected}"
            );
        }
        assert!(f.saved().is_none());
        let settings = f.read(&owner).await;
        assert_eq!(settings["askModel"], "inherit");
        assert_eq!(settings["knowledge"]["bindings"], json!([]));
        assert!(f.calls().is_empty());
        assert_eq!(
            f.save(&owner, json!({ "askModel": { "providerID": "p", "id": "m1", "variant": "deep", "profile": "acct" } }))
                .await
                .0,
            200
        );
        f.shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn owner_update_persists_through_settings_and_applies_active_bindings_to_new_retrieval() {
    bounded(async {
        let f = Fixture::start(quiet(), inventory()).await;
        let (key, owner) = f.links().await;
        let (status, settings) = f
            .save(
                &owner,
                json!({
                    "askModel": { "providerID": "p", "id": "m1", "variant": "deep" },
                    "knowledge": { "mcpEnabled": true, "bindings": [
                        binding("docs", "search", "read", Some("replace"), true),
                        binding("wiki", "find", "get", Some("put"), false),
                        binding("notes", "lookup", "lookup", None, false),
                    ] },
                }),
            )
            .await;
        assert_eq!(status, 200, "{settings}");
        assert_eq!(settings["askModel"], json!({ "providerID": "p", "id": "m1", "variant": "deep" }));
        assert_eq!(settings["models"].as_array().unwrap().len(), 3);
        assert_eq!(
            settings["knowledge"]["bindings"],
            json!([
                { "server": "docs", "search": "search", "read": "read", "write": "replace", "enabled": true, "writeCapability": "revision-aware" },
                { "server": "wiki", "search": "find", "read": "get", "write": "put", "enabled": false, "writeCapability": "manual-only" },
                { "server": "notes", "search": "lookup", "read": "lookup", "enabled": false },
            ])
        );
        let saved = f.saved().unwrap();
        assert_eq!(saved["analysis"]["askModel"], json!({ "providerID": "p", "id": "m1", "variant": "deep" }));
        assert_eq!(saved["analysis"]["model"], "inherit");
        assert_eq!(saved["analysis"]["incremental"], false);
        assert_eq!(saved["knowledge"]["autoApply"], false);
        assert_eq!(saved["knowledge"]["requireApproval"], true);
        assert_eq!(saved["knowledge"]["bindings"].as_array().unwrap().len(), 3);
        assert!(saved["knowledge"]["bindings"][0].get("writeCapability").is_none());
        assert_eq!(saved["transcription"]["provider"], "huggingface");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(f.directory.join("settings.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(f.calls().is_empty());
        assert_eq!(f.request("/view/state", &key, None).await.0, 200);

        f.summarize(2).await;
        let calls = f.calls();
        assert!(calls.contains(&("docs".into(), "search".into())), "{calls:?}");
        assert!(calls.iter().all(|(server, _)| server == "docs"), "{calls:?}");

        let (status, _) = f
            .save(
                &owner,
                json!({ "knowledge": { "mcpEnabled": false, "bindings": [
                    binding("docs", "search", "read", Some("replace"), true),
                ] } }),
            )
            .await;
        assert_eq!(status, 200);
        f.summarize(3).await;
        assert!(f.calls().is_empty(), "{:?}", f.calls());
        assert_eq!(
            f.read(&owner).await["askModel"],
            json!({ "providerID": "p", "id": "m1", "variant": "deep" })
        );
        f.shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn disabling_a_connector_or_turning_connectors_off_needs_no_live_tools_but_enabling_does() {
    bounded(async {
        let f = Fixture::start(quiet(), inventory()).await;
        let (_, owner) = f.links().await;
        let offline = binding("offline", "find", "get", Some("put"), false);
        let (status, settings) = f
            .save(
                &owner,
                json!({ "knowledge": { "mcpEnabled": true, "bindings": [offline.clone()] } }),
            )
            .await;
        assert_eq!(status, 200);
        let mut reported = offline.clone();
        reported["writeCapability"] = json!("unavailable");
        assert_eq!(settings["knowledge"]["bindings"], json!([reported]));
        let inactive = binding("offline", "find", "get", Some("put"), true);
        assert_eq!(
            f.save(
                &owner,
                json!({ "knowledge": { "mcpEnabled": false, "bindings": [inactive.clone()] } })
            )
            .await
            .0,
            200
        );
        let saved = f.saved().unwrap();
        assert_eq!(saved["knowledge"]["bindings"], json!([inactive.clone()]));
        assert_eq!(saved["knowledge"]["mcpEnabled"], false);
        f.summarize(2).await;
        assert!(f.calls().is_empty());
        assert_eq!(
            f.save(
                &owner,
                json!({ "knowledge": { "mcpEnabled": true, "bindings": [inactive] } })
            )
            .await,
            (422, json!({ "error": "selection_unavailable" }))
        );
        assert_eq!(f.saved().unwrap()["knowledge"]["mcpEnabled"], false);
        assert_eq!(f.read(&owner).await["knowledge"]["mcpEnabled"], false);
        f.shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn saved_ask_model_selects_future_question_sessions_only_and_never_rebinds_analysis() {
    bounded(async {
        let f = Fixture::start(quiet(), inventory()).await;
        let (key, owner) = f.links().await;
        f.ask(&key, "What is pending?").await;
        assert_eq!(f.last_created(), (None, AnalysisModel::Inherit));
        assert_eq!(
            f.save(
                &owner,
                json!({ "askModel": { "providerID": "p", "id": "m1", "variant": "fast" } })
            )
            .await
            .0,
            200
        );
        f.ask(&key, "What changed?").await;
        assert_eq!(f.last_created(), (None, explicit("m1", Some("fast"), None)));
        let meeting = f
            .service()
            .runtime()
            .database()
            .get_meeting("meeting-1")
            .unwrap()
            .unwrap();
        assert_eq!(meeting["sessionID"], "analysis-session");
        let started = f
            .control(json!({ "action": "start", "title": "Next" }))
            .await;
        assert!(started.get("error").is_none(), "{started}");
        assert_eq!(f.last_created(), (None, AnalysisModel::Inherit));
        f.control(json!({ "action": "select", "meetingID": "meeting-1" }))
            .await;
        assert_eq!(
            f.save(&owner, json!({ "askModel": "inherit" })).await.0,
            200
        );
        f.ask(&key, "And now?").await;
        assert_eq!(f.last_created(), (None, AnalysisModel::Inherit));
        assert_eq!(f.saved().unwrap()["analysis"]["askModel"], "inherit");
        f.shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn inherited_ask_model_captures_the_explicit_analysis_selection_with_its_profile() {
    bounded(async {
        let analysis =
            json!({ "providerID": "p", "id": "m1", "variant": "deep", "profile": "acct" });
        let f = Fixture::start(
            json!({ "analysis": { "incremental": false, "model": analysis.clone() } }),
            inventory(),
        )
        .await;
        let (key, owner) = f.links().await;
        let settings = f.read(&owner).await;
        assert_eq!(settings["askModel"], "inherit");
        assert_eq!(settings["analysisModel"], analysis);
        f.ask(&key, "What is pending?").await;
        assert_eq!(
            f.last_created(),
            (None, explicit("m1", Some("deep"), Some("acct")))
        );
        assert_eq!(
            f.save(
                &owner,
                json!({ "askModel": { "providerID": "p", "id": "m1", "variant": "fast" } })
            )
            .await
            .0,
            200
        );
        f.ask(&key, "And now?").await;
        assert_eq!(f.last_created(), (None, explicit("m1", Some("fast"), None)));
        f.control(json!({ "action": "start", "title": "Analysis keeps its model" }))
            .await;
        assert_eq!(
            f.last_created(),
            (None, explicit("m1", Some("deep"), Some("acct")))
        );
        let saved = f.saved().unwrap();
        assert_eq!(saved["analysis"]["model"], analysis);
        assert_eq!(
            f.save(&owner, json!({ "askModel": "inherit" })).await.0,
            200
        );
        f.control(json!({ "action": "select", "meetingID": "meeting-1" }))
            .await;
        f.ask(&key, "Once more?").await;
        assert_eq!(
            f.last_created(),
            (None, explicit("m1", Some("deep"), Some("acct")))
        );
        f.shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn an_in_flight_question_keeps_its_admitted_model_while_the_owner_saves_a_new_one() {
    bounded(async {
        let f = Arc::new(Fixture::start(quiet(), inventory()).await);
        let (key, owner) = f.links().await;
        assert_eq!(
            f.save(
                &owner,
                json!({ "askModel": { "providerID": "p", "id": "m1", "variant": "fast" } })
            )
            .await
            .0,
            200
        );
        let held = f.held.notified();
        let pending = {
            let (f, key) = (f.clone(), key.clone());
            tokio::spawn(async move { f.ask(&key, "hold").await })
        };
        held.await;
        assert_eq!(f.last_created(), (None, explicit("m1", Some("fast"), None)));
        let (status, settings) = f
            .save(
                &owner,
                json!({ "askModel": { "providerID": "p", "id": "m1", "variant": "deep" } }),
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(settings["askModel"]["variant"], "deep");
        let (_, state) = f.request("/view/state", &key, None).await;
        assert_eq!(state["ask"]["busy"], true);
        f.hold.notify_one();
        assert_eq!(pending.await.unwrap()["status"], "answered");
        assert_eq!(f.created.lock().unwrap().len(), 1);
        f.ask(&key, "After the change?").await;
        assert_eq!(f.last_created(), (None, explicit("m1", Some("deep"), None)));
        Arc::into_inner(f).unwrap().shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn knowledge_only_saves_preserve_a_saved_variant_the_catalog_no_longer_reports() {
    bounded(async {
        let f = Fixture::start(quiet(), inventory()).await;
        let (_, owner) = f.links().await;
        assert_eq!(
            f.save(&owner, json!({ "askModel": { "providerID": "p", "id": "m1", "variant": "fast", "profile": "acct" } }))
                .await
                .0,
            200
        );
        f.registry.inventory.lock().unwrap().models[0].variants = vec!["deep".into()];
        let (status, settings) = f
            .save(&owner, json!({ "knowledge": { "mcpEnabled": true, "bindings": [binding("docs", "search", "read", None, true)] } }))
            .await;
        assert_eq!(status, 200);
        let preserved = json!({ "providerID": "p", "id": "m1", "variant": "fast", "profile": "acct" });
        assert_eq!(settings["askModel"], preserved);
        assert_eq!(settings["models"][0]["variants"], json!(["deep"]));
        assert_eq!(f.saved().unwrap()["analysis"]["askModel"], preserved);
        assert_eq!(
            f.save(&owner, json!({ "askModel": { "providerID": "p", "id": "m1", "variant": "fast" } }))
                .await,
            (422, json!({ "error": "selection_unavailable" }))
        );
        f.shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn owner_read_keeps_every_inventory_entry_and_fails_instead_of_truncating_beyond_the_bound() {
    bounded(async {
        let mut large = inventory();
        large.models = (0..585)
            .map(|index| {
                let variants: Vec<String> = if index == 584 {
                    (0..70).map(|variant| format!("v{variant}")).collect()
                } else {
                    Vec::new()
                };
                CatalogModel {
                    variants,
                    ..model(&format!("m{index}"), &format!("Model {index}"), true, "active", &[])
                }
            })
            .collect();
        large.servers = (0..70)
            .map(|index| McpServer {
                name: format!("s{index}"),
                status: Some("connected".into()),
            })
            .collect();
        large.tools = (0..140)
            .map(|index| tool("s69", &format!("t{index}"), None))
            .chain([tool("s69", "search", None), tool("s69", "read", None)])
            .collect();
        let f = Fixture::start(quiet(), large).await;
        let (_, owner) = f.links().await;
        let settings = f.read(&owner).await;
        assert_eq!(settings["models"].as_array().unwrap().len(), 585);
        assert_eq!(settings["models"][584]["id"], "m584");
        assert_eq!(settings["models"][584]["variants"].as_array().unwrap().len(), 70);
        assert_eq!(settings["servers"].as_array().unwrap().len(), 70);
        assert_eq!(settings["servers"][69]["tools"].as_array().unwrap().len(), 142);
        assert_eq!(
            f.save(&owner, json!({ "askModel": { "providerID": "p", "id": "m584", "variant": "v69" } }))
                .await
                .0,
            200
        );
        assert_eq!(
            f.save(&owner, json!({ "knowledge": { "mcpEnabled": true, "bindings": [binding("s69", "search", "read", None, true)] } }))
                .await
                .0,
            200
        );
        f.registry.inventory.lock().unwrap().models = (0..4000)
            .map(|index| {
                model(
                    &format!("m{index}"),
                    &format!("Model {index} {}", "x".repeat(300)),
                    true,
                    "active",
                    &["fast"],
                )
            })
            .collect();
        assert_eq!(
            f.request("/view/owner/settings", &owner, None).await,
            (500, json!({ "error": "owner_failed" }))
        );
        f.shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn saved_owner_settings_survive_restart_while_each_bridge_issues_a_fresh_owner_key() {
    bounded(async {
        let mut f = Fixture::start(quiet(), inventory()).await;
        let (_, first) = f.links().await;
        let update = json!({
            "askModel": { "providerID": "p", "id": "m1", "variant": "deep", "profile": "acct" },
            "knowledge": { "mcpEnabled": true, "bindings": [binding("wiki", "find", "get", Some("put"), false)] },
        });
        assert_eq!(f.save(&first, update).await.0, 200);
        f.service.take().unwrap().shutdown().await.unwrap();
        f.service = Some(f.launch(quiet()).await);
        let (_, second) = f.links().await;
        assert_ne!(first, second);
        assert_eq!(f.request("/view/owner/settings", &first, None).await.0, 401);
        let settings = f.read(&second).await;
        assert_eq!(
            settings["askModel"],
            json!({ "providerID": "p", "id": "m1", "variant": "deep", "profile": "acct" })
        );
        assert_eq!(settings["knowledge"]["bindings"][0]["enabled"], false);
        f.shutdown().await;
    })
    .await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_settings_write_keeps_the_previous_configuration_live() {
    use std::os::unix::fs::PermissionsExt;
    bounded(async {
        let f = Fixture::start(quiet(), inventory()).await;
        let (key, owner) = f.links().await;
        let permissions = std::fs::metadata(&f.directory).unwrap().permissions();
        std::fs::set_permissions(&f.directory, std::fs::Permissions::from_mode(0o500)).unwrap();
        let failed = f
            .save(
                &owner,
                json!({ "askModel": { "providerID": "p", "id": "m1", "variant": "deep" } }),
            )
            .await;
        std::fs::set_permissions(&f.directory, permissions).unwrap();
        assert_eq!(failed, (500, json!({ "error": "owner_failed" })));
        assert_eq!(f.read(&owner).await["askModel"], "inherit");
        f.ask(&key, "Still inherited?").await;
        assert_eq!(f.last_created(), (None, AnalysisModel::Inherit));
        f.shutdown().await;
    })
    .await;
}
