use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use ycoding_core::resources::mcp::{
    Event, Service,
    client::{Connection, Error, Hooks},
    skills,
};
use ycoding_schema::{
    DomainDecode,
    mcp::{ServerConfig, Status},
    mcp_skill::{File, Reason, Resources},
    parse_json,
};

static NEXT: AtomicU64 = AtomicU64::new(0);
const EXTENSION: &str = "io.modelcontextprotocol/skills";

struct Table {
    directory: PathBuf,
    state: PathBuf,
}
impl Table {
    fn new(table: Value) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "ycoding-mcp-table-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        let this = Self {
            state: directory.join("table.json"),
            directory,
        };
        this.set(table);
        this
    }
    fn set(&self, mut table: Value) {
        table["log"] = json!(self.directory.join("requests.log"));
        fs::write(&self.state, table.to_string()).unwrap();
    }
    fn config(&self, extra: Value) -> ServerConfig {
        let mut value = json!({"type":"local","command":["python3",Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/mcp_table.py"),self.state]});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        ServerConfig::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
    }
    async fn connect(&self) -> Connection {
        Connection::connect(
            "skills",
            &self.config(json!({})),
            &self.directory,
            "1.0.0",
            &BTreeMap::new(),
            Hooks::default(),
        )
        .await
        .unwrap()
    }
    fn service(&self) -> Service {
        Service::new(
            &[],
            self.directory.clone(),
            "1".into(),
            BTreeMap::new(),
            Hooks::default(),
        )
        .unwrap()
    }
    fn requests(&self, method: &str) -> Vec<Value> {
        fs::read_to_string(self.directory.join("requests.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|request| request["method"] == method)
            .collect()
    }
}
impl Drop for Table {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.directory).unwrap();
    }
}

fn page(key: &str, items: Value, next: Option<&str>) -> Value {
    let mut value = json!({ key: items });
    if let Some(next) = next {
        value["nextCursor"] = json!(next);
    }
    value
}

fn listing(skills: Value, next: Option<&str>) -> Value {
    let mut value = page("skills", skills, next);
    value["resultType"] = json!("complete");
    value["ttlMs"] = json!(300000);
    value["cacheScope"] = json!("public");
    value
}

fn skill_files(name: &str, files: &[(&str, &str)]) -> Value {
    json!({
        "uri": format!("skill://{name}/SKILL.md"),
        "frontmatter": {"name": name, "description": "d"},
        "resources": files
            .iter()
            .map(|(file, text)| json!({"uri": format!("skill://{name}/{file}"), "digest": skills::digest(text.as_bytes()), "size": text.len()}))
            .collect::<Vec<_>>(),
    })
}

fn resource_capabilities() -> Value {
    json!({"resources":{"listChanged":true}})
}

#[tokio::test]
async fn resource_lists_paginate_and_project_only_the_contract_fields() {
    let table = Table::new(json!({
        "capabilities": resource_capabilities(),
        "responses": {
            "resources/list": {
                "": page("resources", json!([{"name":"Readme","uri":"docs://readme","description":"Project docs","title":"Title","size":5}]), Some("resources-2")),
                "resources-2": page("resources", json!([{"name":"Logo","uri":"docs://logo","mimeType":"image/png","annotations":{"audience":["user"]}}]), None),
            },
            "resources/templates/list": {
                "": page("resourceTemplates", json!([{"name":"File","uriTemplate":"docs://{path}","title":"Title"}]), Some("templates-2")),
                "templates-2": page("resourceTemplates", json!([{"name":"Issue","uriTemplate":"issue://{id}","description":"Issue"}]), None),
            },
            "resources/read": {"docs://readme": {"contents":[
                {"uri":"docs://readme","text":"hello","mimeType":"text/plain","_meta":{"internal":true}},
                {"uri":"docs://logo","blob":"aGVsbG8=","mimeType":"image/png","_meta":{"internal":true}},
            ]}},
        },
    }));
    let connection = table.connect().await;
    assert_eq!(
        connection.resources().await.unwrap(),
        [
            json!({"name":"Readme","uri":"docs://readme","description":"Project docs"}),
            json!({"name":"Logo","uri":"docs://logo","mimeType":"image/png"}),
        ]
    );
    assert_eq!(
        connection.resource_templates().await.unwrap(),
        [
            json!({"name":"File","uriTemplate":"docs://{path}"}),
            json!({"name":"Issue","uriTemplate":"issue://{id}","description":"Issue"}),
        ]
    );
    assert_eq!(
        connection
            .read_resource("docs://readme", None)
            .await
            .unwrap()
            .unwrap(),
        json!({"contents":[
            {"type":"text","uri":"docs://readme","text":"hello","mimeType":"text/plain"},
            {"type":"blob","uri":"docs://logo","blob":"aGVsbG8=","mimeType":"image/png"},
        ]})
    );
    connection.close().await.unwrap();
}

#[tokio::test]
async fn resource_requests_are_skipped_when_the_capability_is_absent() {
    let table = Table::new(json!({
        "capabilities": {"tools":{}},
        "responses": {
            "resources/list": {"": page("resources", json!([{"name":"Readme","uri":"docs://readme"}]), None)},
            "resources/templates/list": {"": page("resourceTemplates", json!([]), None)},
            "resources/read": {"": {"contents":[]}},
        },
    }));
    let connection = table.connect().await;
    assert!(connection.resources().await.unwrap().is_empty());
    assert!(connection.resource_templates().await.unwrap().is_empty());
    assert!(
        connection
            .read_resource("docs://readme", None)
            .await
            .unwrap()
            .is_none()
    );
    for method in [
        "resources/list",
        "resources/templates/list",
        "resources/read",
    ] {
        assert!(table.requests(method).is_empty(), "{method}");
    }
    connection.close().await.unwrap();
}

#[tokio::test]
async fn unsupported_resource_and_template_list_methods_are_each_requested_once() {
    let table = Table::new(json!({"capabilities": resource_capabilities()}));
    let connection = table.connect().await;
    for _ in 0..2 {
        assert!(connection.resources().await.unwrap().is_empty());
        assert!(connection.resource_templates().await.unwrap().is_empty());
    }
    assert_eq!(table.requests("resources/list").len(), 1);
    assert_eq!(table.requests("resources/templates/list").len(), 1);
    connection.close().await.unwrap();
}

#[tokio::test]
async fn service_resource_catalog_is_fetched_per_call_and_reads_carry_server_and_uri() {
    let contents = json!([
        {"uri":"docs://readme","text":"hello","mimeType":"text/plain"},
        {"uri":"docs://logo","blob":"aGVsbG8=","mimeType":"image/png"},
    ]);
    let table = |resources: Value| {
        json!({
            "capabilities": resource_capabilities(),
            "responses": {
                "resources/list": {"": page("resources", resources, None)},
                "resources/templates/list": {"": page("resourceTemplates", json!([{"name":"File","uriTemplate":"docs://{path}"}]), None)},
                "resources/read": {"docs://readme": {"contents": contents}},
            },
        })
    };
    let fixture = Table::new(table(json!([{"name":"Readme","uri":"docs://readme"}])));
    let service = fixture.service();
    service
        .add("resources", fixture.config(json!({})))
        .await
        .unwrap();
    assert_eq!(
        service.resource_catalog().await.unwrap(),
        json!({
            "resources":[{"server":"resources","name":"Readme","uri":"docs://readme"}],
            "templates":[{"server":"resources","name":"File","uriTemplate":"docs://{path}"}],
        })
    );
    fixture.set(table(json!([{"name":"Guide","uri":"docs://guide"}])));
    assert_eq!(
        service.resource_catalog().await.unwrap()["resources"],
        json!([{"server":"resources","name":"Guide","uri":"docs://guide"}])
    );
    assert_eq!(
        service
            .read_resource("resources", "docs://readme", None)
            .await
            .unwrap()
            .unwrap(),
        json!({
            "server":"resources",
            "uri":"docs://readme",
            "contents":[
                {"type":"text","uri":"docs://readme","text":"hello","mimeType":"text/plain"},
                {"type":"blob","uri":"docs://logo","blob":"aGVsbG8=","mimeType":"image/png"},
            ],
        })
    );
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn resource_list_changed_notifications_surface_only_when_the_server_declares_them() {
    for declared in [true, false] {
        let table = Table::new(json!({
            "capabilities": {"tools":{"listChanged":true},"resources":{"listChanged":declared}},
            "responses": {"tools/list": {"": page("tools", json!([{"name":"notify","inputSchema":{"type":"object"}}]), None)}},
            "notify": ["notifications/resources/list_changed","notifications/tools/list_changed"],
        }));
        let service = table.service();
        service
            .add("resources", table.config(json!({})))
            .await
            .unwrap();
        service.tools().await.unwrap();
        let mut events = service.subscribe();
        service
            .call_tool("resources", "notify", json!({}), None)
            .await
            .unwrap();
        let mut resources_changed = false;
        loop {
            match tokio::time::timeout(Duration::from_secs(10), events.recv())
                .await
                .unwrap()
                .unwrap()
            {
                Event::ResourcesChanged(server) => {
                    assert_eq!(server, "resources");
                    resources_changed = true;
                }
                Event::ToolsChanged(_) => break,
                _ => (),
            }
        }
        assert_eq!(resources_changed, declared);
        service.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn runtime_lifecycle_reports_unknown_servers_and_replaces_definitions_in_place() {
    let table = Table::new(json!({
        "capabilities": {"tools":{}},
        "responses": {"tools/list": {"": page("tools", json!([{"name":"first","inputSchema":{"type":"object"}}]), None)}},
    }));
    let service = table.service();
    for result in [
        service.connect("missing").await,
        service.disconnect("missing").await,
        service.remove("missing").await,
    ] {
        let error = result.unwrap_err();
        assert_eq!(error, Error::NotFound("missing".into()));
        assert_eq!(error.to_string(), "MCP server not found: missing");
    }
    let status = |service: &Service| service.servers().unwrap()[0].status.clone();
    service
        .add("dynamic", table.config(json!({})))
        .await
        .unwrap();
    service.tools().await.unwrap();
    assert_eq!(status(&service), Status::Connected);
    service
        .add("dynamic", table.config(json!({"disabled":true})))
        .await
        .unwrap();
    assert_eq!(service.servers().unwrap().len(), 1);
    assert_eq!(status(&service), Status::Disabled);
    assert!(service.tools().await.unwrap().is_empty());
    service.connect("dynamic").await.unwrap();
    assert_eq!(status(&service), Status::Connected);
    service.remove("dynamic").await.unwrap();
    assert!(service.servers().unwrap().is_empty());
    assert!(service.tools().await.unwrap().is_empty());
    assert_eq!(
        service.remove("dynamic").await,
        Err(Error::NotFound("dynamic".into()))
    );
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn service_checks_the_working_directory_before_spawning_and_connects_from_an_existing_one() {
    let table = Table::new(json!({
        "capabilities": {"tools":{}},
        "responses": {"tools/list": {"": page("tools", json!([]), None)}},
    }));
    let marker = table.directory.join("started");
    let config = table.config(json!({"environment":{"MCP_TABLE_MARKER":marker}}));
    let missing = table.directory.join("missing");
    let service = Service::new(
        &[],
        missing.clone(),
        "1".into(),
        BTreeMap::new(),
        Hooks::default(),
    )
    .unwrap();
    service.add("marker", config.clone()).await.unwrap();
    service.tools().await.unwrap();
    assert_eq!(
        service.servers().unwrap()[0].status,
        Status::Failed(format!("Working directory does not exist: {}", missing.display()).into())
    );
    assert!(!marker.exists());
    service.shutdown().await.unwrap();
    let service = table.service();
    service.add("marker", config).await.unwrap();
    service.tools().await.unwrap();
    assert_eq!(service.servers().unwrap()[0].status, Status::Connected);
    assert_eq!(fs::read_to_string(marker).unwrap(), "started");
    service.shutdown().await.unwrap();
}

#[test]
fn errors_expose_the_typescript_messages() {
    assert_eq!(
        Error::NotFound("demo".into()).to_string(),
        "MCP server not found: demo"
    );
    assert_eq!(
        Error::NeedsAuth("demo".into()).to_string(),
        "MCP server requires authentication: demo"
    );
    assert_eq!(Error::Connect("offline".into()).to_string(), "offline");
}

fn extension_capabilities(directory_read: bool) -> Value {
    json!({"resources":{},"extensions":{EXTENSION: if directory_read {json!({"directoryRead":true})} else {json!({})}}})
}

#[tokio::test]
async fn skills_extension_is_ignored_without_its_declaration_or_the_resources_capability() {
    for capabilities in [
        json!({"resources":{}}),
        json!({"extensions":{EXTENSION:{"directoryRead":true}}}),
    ] {
        let table = Table::new(json!({
            "capabilities": capabilities,
            "responses": {"skills/list": {"": listing(json!([skill_files("a", &[("SKILL.md", "x")])]), None)}},
        }));
        let connection = table.connect().await;
        assert!(connection.skill_entries().await.unwrap().is_empty());
        assert!(table.requests("skills/list").is_empty());
        connection.close().await.unwrap();
    }
}

#[tokio::test]
async fn skill_listing_paginates_metadata_only_and_requires_the_result_fields() {
    let first = skill_files("git-workflow", &[("SKILL.md", "# Git\n")]);
    let second = skill_files("refunds", &[("SKILL.md", "# Refunds\n")]);
    let table = Table::new(json!({
        "capabilities": extension_capabilities(true),
        "responses": {"skills/list": {
            "": listing(json!([first]), Some("page-2")),
            "page-2": listing(json!([second]), None),
        }},
    }));
    let connection = table.connect().await;
    let entries = connection.skill_entries().await.unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.uri.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["skill://git-workflow/SKILL.md", "skill://refunds/SKILL.md"]
    );
    assert!(entries.iter().all(|entry| entry.server == "skills".into()));
    assert_eq!(table.requests("skills/list").len(), 2);
    assert!(table.requests("resources/read").is_empty());
    table.set(json!({
        "capabilities": extension_capabilities(true),
        "responses": {"skills/list": {"": page("skills", json!([first]), None)}},
    }));
    assert!(
        connection
            .skill_entries()
            .await
            .unwrap_err()
            .to_string()
            .contains("ttlMs")
    );
    table.set(json!({
        "capabilities": extension_capabilities(true),
        "responses": {"skills/list": {"": listing(json!([]), None)}},
    }));
    assert!(connection.skill_entries().await.unwrap().is_empty());
    connection.close().await.unwrap();
}

#[tokio::test]
async fn malformed_and_oversized_skill_entries_are_dropped_from_the_listing() {
    let digest = format!("sha256:{}", "a".repeat(64));
    let resource = |uri: &str, size: u64| json!({"uri":uri,"digest":digest,"size":size});
    let frontmatter = json!({"name":"a","description":"d"});
    let cases = [
        json!({"uri":"skill://a/SKILL.md","frontmatter":frontmatter,"resources":[resource("skill://a/other.md",1)]}),
        json!({"uri":"skill://a/SKILL.md","frontmatter":frontmatter}),
        json!({"uri":"skill://a/SKILL.md","frontmatter":frontmatter,"resources":[{"uri":"skill://a/SKILL.md","digest":"sha256:short","size":1}]}),
        json!({"uri":"skill://a/SKILL.md","frontmatter":{"name":"a"},"resources":[resource("skill://a/SKILL.md",1)]}),
        json!({"uri":"skill://a/SKILL.md","frontmatter":frontmatter,"resources":[resource("skill://a/SKILL.md",1),resource("skill://a/../b/SKILL.md",1)]}),
        json!({"uri":"skill://a/SKILL.md","frontmatter":frontmatter,"resources":vec![resource("skill://a/SKILL.md",1);513]}),
        json!({"uri":"skill://a/SKILL.md","frontmatter":frontmatter,"resources":[resource("skill://a/SKILL.md",16777217)]}),
    ];
    for (index, raw) in cases.into_iter().enumerate() {
        let table = Table::new(json!({
            "capabilities": extension_capabilities(true),
            "responses": {"skills/list": {"": listing(json!([raw]), None)}},
        }));
        let connection = table.connect().await;
        assert!(
            connection.skill_entries().await.unwrap().is_empty(),
            "case {index}"
        );
        connection.close().await.unwrap();
    }
}

#[tokio::test]
async fn skill_entries_are_confirmed_by_get_and_files_are_verified_without_listing_reads() {
    let guide = "# Guide\n";
    let git = skill_files(
        "git",
        &[("SKILL.md", "# Git\n"), ("references/GUIDE.md", guide)],
    );
    let other = skill_files("refunds", &[("SKILL.md", "# Refunds\n")]);
    let get = |skill: &Value| json!({"resultType":"complete","ttlMs":0,"cacheScope":"public","skill":skill});
    let table = Table::new(json!({
        "capabilities": extension_capabilities(true),
        "responses": {
            "skills/list": {"": listing(json!([git]), None)},
            "skills/get": {git["uri"].as_str().unwrap(): get(&git), other["uri"].as_str().unwrap(): get(&other)},
            "resources/read": {"skill://git/references/GUIDE.md": {"contents":[{"uri":"skill://git/references/GUIDE.md","text":guide}]}},
        },
    }));
    let connection = table.connect().await;
    let service = table.service();
    service
        .add("skills", table.config(json!({})))
        .await
        .unwrap();
    assert_eq!(service.skill_catalog().await.unwrap().len(), 1);
    let confirmed = service
        .get_skill("skills", other["uri"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(confirmed.server, "skills".into());
    assert_eq!(confirmed.uri.as_str(), other["uri"].as_str());
    assert!(matches!(
        connection.skill_entry("skill://nope/SKILL.md").await,
        Err(Error::Rpc { code: -32602, .. })
    ));
    assert_eq!(
        service.get_skill("skills", "skill://nope/SKILL.md").await,
        Err(Error::Skill(Reason::NotFound))
    );
    assert!(table.requests("resources/read").is_empty());
    let entry = service
        .get_skill("skills", git["uri"].as_str().unwrap())
        .await
        .unwrap();
    let file = service
        .read_skill_resource("skills", &entry, "skill://git/references/GUIDE.md")
        .await
        .unwrap();
    assert!(matches!(&file, File::Text { text, .. } if text.as_str() == Some(guide)));
    assert_eq!(
        service
            .read_skill_resource("skills", &entry, "skill://git/references/OTHER.md")
            .await,
        Err(Error::Skill(Reason::UnlistedResource))
    );
    assert_eq!(table.requests("resources/read").len(), 1);
    service.shutdown().await.unwrap();
    connection.close().await.unwrap();
}

#[tokio::test]
async fn dynamic_manifests_list_but_decline_to_load_and_altered_sizes_fail_verification() {
    let mut dynamic = skill_files("git", &[("SKILL.md", "# Git\n")]);
    dynamic["resources"] = json!("dynamic");
    let mut resized = skill_files("sized", &[("SKILL.md", "# Sized\n")]);
    resized["resources"][0]["size"] = json!(9);
    let table = Table::new(json!({
        "capabilities": extension_capabilities(true),
        "responses": {
            "skills/list": {"": listing(json!([dynamic, resized]), None)},
            "resources/read": {"skill://sized/SKILL.md": {"contents":[{"uri":"skill://sized/SKILL.md","text":"# Sized\n"}]}},
        },
    }));
    let service = table.service();
    service
        .add("skills", table.config(json!({})))
        .await
        .unwrap();
    let entries = service.skill_catalog().await.unwrap();
    assert_eq!(entries.len(), 2);
    let dynamic = entries
        .iter()
        .find(|entry| entry.resources == Resources::Dynamic)
        .unwrap();
    assert_eq!(
        service
            .read_skill_resource("skills", dynamic, dynamic.uri.as_str().unwrap())
            .await,
        Err(Error::Skill(Reason::Dynamic))
    );
    assert!(table.requests("resources/read").is_empty());
    let sized = entries
        .iter()
        .find(|entry| entry.resources != Resources::Dynamic)
        .unwrap();
    assert_eq!(
        service
            .read_skill_resource("skills", sized, sized.uri.as_str().unwrap())
            .await,
        Err(Error::Skill(Reason::SizeMismatch))
    );
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn directory_reads_are_gated_paginated_and_project_the_contract_fields() {
    let table = Table::new(json!({
        "capabilities": extension_capabilities(false),
        "responses": {"resources/directory/read": {"skill://git": {"resultType":"complete","resources":[]}}},
    }));
    let connection = table.connect().await;
    assert!(
        connection
            .read_resource_directory("skill://git")
            .await
            .unwrap()
            .is_none()
    );
    assert!(table.requests("resources/directory/read").is_empty());
    connection.close().await.unwrap();

    let table = Table::new(json!({
        "capabilities": extension_capabilities(true),
        "responses": {"resources/directory/read": {
            "skill://git": {"resultType":"complete","resources":[{"uri":"skill://git/references","name":"references","mimeType":"inode/directory","title":"References"}],"nextCursor":"d2"},
            "d2": {"resultType":"complete","resources":[{"uri":"skill://git/SKILL.md","name":"SKILL.md","mimeType":"text/markdown","size":6}]},
        }},
    }));
    let connection = table.connect().await;
    assert_eq!(
        connection
            .read_resource_directory("skill://git")
            .await
            .unwrap()
            .unwrap(),
        [
            json!({"uri":"skill://git/references","name":"references","mimeType":"inode/directory"}),
            json!({"uri":"skill://git/SKILL.md","name":"SKILL.md","mimeType":"text/markdown"}),
        ]
    );
    assert_eq!(table.requests("resources/directory/read").len(), 2);
    connection.close().await.unwrap();
}
