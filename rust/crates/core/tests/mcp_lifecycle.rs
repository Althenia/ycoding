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
    assert_eq!(service.tools().await.unwrap().len(), 2);
    service.disconnect("disabled").await.unwrap();
    assert_eq!(service.servers().unwrap()[0].status, Status::Disabled);
    assert!(service.tools().await.unwrap().is_empty());
    service.remove("disabled").await.unwrap();
    assert!(service.servers().unwrap().is_empty());
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
        if status == Status::Connected { 2 } else { 0 }
    );
    service.disconnect("server").await.unwrap();
    assert!(service.tools().await.unwrap().is_empty());
    service.shutdown().await.unwrap();
}
