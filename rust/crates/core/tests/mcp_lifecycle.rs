use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::{
    config::Entry,
    mcp::{Service, client::Hooks},
};
use ycoding_schema::{
    DomainDecode,
    mcp::{ServerConfig, Status},
    parse_json,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-mcp-lifecycle-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn config(&self, disabled: bool) -> ServerConfig {
        let source = std::process::Command::new("bun")
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("src/resources/mcp/extract-fixture.mjs"),
            )
            .arg("mcp-output-schema")
            .arg(&self.0)
            .output()
            .unwrap();
        assert!(source.status.success());
        ServerConfig::decode(&parse_json(&json!({"type":"local","command":["bun",String::from_utf8(source.stdout).unwrap()],"disabled":disabled}).to_string()).unwrap()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[tokio::test]
async fn excluded_mcp_server_never_starts_on_boot_add_or_connect() {
    let fixture = Fixture::new();
    let marker = fixture.0.join("started");
    let config = json!({"type":"local","command":["bun","-e","await Bun.write(process.argv[1], 'started')",marker]});
    for capabilities in [
        json!({"mcp":{"enabled":false}}),
        json!({"mcp":{"allow":["allowed*"],"deny":["allowed-blocked"]}}),
    ] {
        let entries = [Entry::Document {path:None,info:parse_json(&json!({"capabilities":capabilities,"mcp":{"servers":{"excluded":config,"allowed-blocked":config}}}).to_string()).unwrap()}];
        let service = Service::new(
            &entries,
            fixture.0.clone(),
            "1".into(),
            BTreeMap::new(),
            Hooks::default(),
        )
        .unwrap();
        assert!(service.tools().await.unwrap().is_empty());
        assert!(!marker.exists(), "an excluded configured process started");
        assert!(
            service
                .servers()
                .unwrap()
                .iter()
                .all(|server| server.status == Status::Disabled)
        );
        service
            .add(
                "excluded-later",
                ServerConfig::decode(&parse_json(&config.to_string()).unwrap()).unwrap(),
            )
            .await
            .unwrap();
        for name in ["excluded", "excluded-later", "allowed-blocked"] {
            service.connect(name).await.unwrap();
        }
        assert!(service.tools().await.unwrap().is_empty());
        assert!(service.prompts().is_empty());
        assert!(service.instructions().await.unwrap().is_empty());
        assert!(service.skill_catalog().await.unwrap().is_empty());
        assert_eq!(
            service.resource_catalog().await.unwrap(),
            json!({"resources":[],"templates":[]})
        );
        assert!(!marker.exists(), "an excluded add/connect process started");
        assert!(
            service
                .servers()
                .unwrap()
                .iter()
                .all(|server| server.status == Status::Disabled)
        );
        if capabilities["mcp"]["enabled"] != false {
            service.add("allowed", fixture.config(true)).await.unwrap();
            service.connect("allowed").await.unwrap();
            assert_eq!(service.tools().await.unwrap().len(), 3);
        }
        service.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn configured_servers_start_in_background_and_disabled_servers_do_not_block_queries() {
    let fixture = Fixture::new();
    let config = fixture.config(true);
    let entries = [Entry::Document {
        path: None,
        info: parse_json(&format!(
            "{{\"mcp\":{{\"servers\":{{\"disabled\":{}}}}}}}",
            ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(&config))
        ))
        .unwrap(),
    }];
    let service = Service::new(
        &entries,
        fixture.0.clone(),
        "1".into(),
        BTreeMap::new(),
        Hooks::default(),
    )
    .unwrap();
    assert_eq!(service.servers().unwrap()[0].status, Status::Disabled);
    assert!(service.tools().await.unwrap().is_empty());
    assert!(service.prompts().is_empty());
    service.connect("disabled").await.unwrap();
    assert_eq!(service.servers().unwrap()[0].status, Status::Connected);
    assert_eq!(service.tools().await.unwrap().len(), 3);
    service.disconnect("disabled").await.unwrap();
    assert_eq!(service.servers().unwrap()[0].status, Status::Disabled);
    assert!(service.tools().await.unwrap().is_empty());
    service.remove("disabled").await.unwrap();
    assert!(service.servers().unwrap().is_empty());
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn interrupted_startup_releases_the_client_and_unblocks_catalog_readers() {
    let fixture = Fixture::new();
    let source = fixture.0.join("startup.ts");
    let marker = fixture.0.join("listing");
    fs::write(&source, r#"
const marker = process.argv[2]
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n")
    const request = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1)
    if (request.method === "server/discover") console.log(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code:-32601,message:"Legacy fixture"}}))
    if (request.method === "initialize") console.log(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{protocolVersion:"2025-11-25",serverInfo:{name:"interrupted",version:"1"},capabilities:{tools:{}}}}))
    if (request.method === "tools/list") await Bun.write(marker,String(process.pid))
  }
}
"#).unwrap();
    let service = Service::new(
        &[],
        fixture.0.clone(),
        "1".into(),
        BTreeMap::new(),
        Hooks::default(),
    )
    .unwrap();
    let config = ServerConfig::decode(
        &parse_json(
            &json!({
                "type":"local", "command":["bun",source,marker], "disabled":true,
            })
            .to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    service.add("interrupted", config).await.unwrap();
    let running = service.clone();
    let startup = tokio::spawn(async move { running.connect("interrupted").await });
    let pid: u32 = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(pid) = fs::read_to_string(&marker)
                && let Ok(pid) = pid.parse()
            {
                break pid;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    startup.abort();
    assert!(startup.await.unwrap_err().is_cancelled());
    assert_eq!(
        service.servers().unwrap()[0].status,
        Status::Failed("Connection interrupted".into())
    );
    assert!(service.tools().await.unwrap().is_empty());
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while ycoding_core::platform::process::is_alive(pid).unwrap() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn concurrent_same_server_lifecycle_operations_leave_a_consistent_catalog() {
    let fixture = Fixture::new();
    let config = fixture.config(true);
    let service = Service::new(
        &[],
        fixture.0.clone(),
        "1".into(),
        BTreeMap::new(),
        Hooks::default(),
    )
    .unwrap();
    service.add("server", config).await.unwrap();
    let (a, b, c, d) = tokio::join!(
        service.connect("server"),
        service.connect("server"),
        service.disconnect("server"),
        service.connect("server")
    );
    for result in [a, b, c, d] {
        result.unwrap();
    }
    let status = service.servers().unwrap()[0].status.clone();
    assert!(matches!(status, Status::Connected | Status::Disabled));
    assert_eq!(
        service.tools().await.unwrap().len(),
        if status == Status::Connected { 3 } else { 0 }
    );
    service.disconnect("server").await.unwrap();
    assert!(service.tools().await.unwrap().is_empty());
    service.shutdown().await.unwrap();
}
