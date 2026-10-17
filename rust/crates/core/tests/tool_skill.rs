include!("tool_fixture.rs");
use std::{fs, sync::Arc};
use ycoding_core::tools::{
    builtin::{read::Read, skill},
    context::{
        Context,
        consumers::{ActiveSkill, ConsumerFuture, ReadInstructions},
    },
};
use ycoding_schema::{schema::AbsolutePath, skill::Info};

#[derive(Default)]
struct Instructions(std::sync::Mutex<Vec<std::path::PathBuf>>);

#[tokio::test]
async fn all_skill_sources_and_explicit_active_resource_loads_obey_selection() {
    use served::*;
    use ycoding_core::resources::{config::Entry, mcp::skills as mcp_skills};
    use ycoding_schema::skill::{EmbeddedSource, Source};
    let fixture = ToolFixture::new();
    let info = effect_info(&fixture);
    let mcp_id = mcp_skills::id(&"loopback".into(), &"skill://a/SKILL.md".into());
    for capabilities in [
        serde_json::json!({"skills":{"enabled":false}}),
        serde_json::json!({"skills":{"allow":["effect","report",mcp_id],"deny":["effect"]}}),
    ] {
        let entries = [Entry::Document {
            path: None,
            info: parse_json(
                &serde_json::json!({"skills":[fixture.root],"capabilities":capabilities})
                    .to_string(),
            )
            .unwrap(),
        }];
        let mut catalog = Catalog::from_entries(
            &entries,
            &fixture.root,
            &fixture.root,
            &fixture.root.join("cache"),
        )
        .unwrap();
        for id in ["effect", "ycoding", "report", &mcp_id] {
            let mut embedded = info.clone();
            embedded.id = id.into();
            embedded.name = format!("embedded {id}").into();
            catalog.source(Source::Embedded(EmbeddedSource { skill: embedded }));
        }
        let actual = catalog.list().await.unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|skill| skill.id.as_str().unwrap())
                .collect::<Vec<_>>(),
            if capabilities["skills"]["enabled"] == false {
                vec![]
            } else {
                vec!["report", mcp_id.as_str()]
            }
        );
    }
    let server = Loopback::start().await;
    let service = Arc::new(server.service(fixture.root.clone()));
    let tool = tool(
        &fixture,
        catalog(&fixture, vec![info.clone()]),
        &service,
        None,
    );
    let sessions = Sessions::new(fixture.authority.store.client());
    let first = call(&tool, fixture.context(), serde_json::json!({"id":"effect"}))
        .await
        .unwrap();
    record(&sessions, "first", 100, "effect", &first.structured).await;
    let mcp = call(&tool, fixture.context(), serde_json::json!({"id":mcp_id}))
        .await
        .unwrap();
    record(&sessions, "mcp", 101, &mcp_id, &mcp.structured).await;
    let before = sessions.transcript(&fixture.context().session_id).unwrap();
    let mcp_entries = service.skill_catalog().await.unwrap();
    assert_eq!(mcp_entries.len(), 1);
    assert_eq!(tool.skills.lock().await.mcp(mcp_entries.clone()).len(), 1);
    let hidden = [Entry::Document {
        path: None,
        info: parse_json(r#"{"capabilities":{"skills":{"allow":[]}}}"#).unwrap(),
    }];
    let mut selected = Catalog::from_entries(
        &hidden,
        &fixture.root,
        &fixture.root,
        &fixture.root.join("cache"),
    )
    .unwrap();
    selected.source(Source::Embedded(EmbeddedSource { skill: info }));
    assert!(selected.mcp(mcp_entries).is_empty());
    *tool.skills.lock().await = selected;
    for id in ["effect", mcp_id.as_str()] {
        for resource in [None, Some("SKILL.md")] {
            let mut input = serde_json::json!({"id":id});
            if let Some(resource) = resource {
                input["resource"] = resource.into();
            }
            assert_eq!(
                failure(call(&tool, fixture.context(), input).await),
                format!("Unable to load skill {id}")
            );
        }
    }
    assert_eq!(
        sessions.transcript(&fixture.context().session_id).unwrap(),
        before
    );
    service.shutdown().await.unwrap();
    fixture.cleanup();
}
impl ReadInstructions for Instructions {
    fn load(&self, _: Context, paths: Vec<std::path::PathBuf>) -> ConsumerFuture<'_, ()> {
        Box::pin(async move {
            self.0.lock().unwrap().extend(paths);
            Ok(())
        })
    }
}

#[tokio::test]
async fn local_skill_rendering_and_active_resource_reads_are_fenced_to_the_skill_directory() {
    let fixture = ToolFixture::new();
    fs::create_dir_all(fixture.root.join("effect")).unwrap();
    fs::write(fixture.root.join("effect/SKILL.md"), "skill").unwrap();
    fs::write(fixture.root.join("effect/reference.md"), "reference text").unwrap();
    fs::write(fixture.root.join("outside.md"), "outside").unwrap();
    let info = Info {
        id: "effect".into(),
        name: "Effect & Rust".into(),
        description: None,
        slash: None,
        autoinvoke: None,
        conflicts: None,
        location: AbsolutePath::new(
            fixture
                .root
                .join("effect/SKILL.md")
                .to_string_lossy()
                .as_ref(),
        )
        .unwrap(),
        content: "\nUse <effect>.\n".into(),
    };
    let output = skill::load_local(&info, &fixture.policy, fixture.context(), None)
        .await
        .unwrap();
    let text = output.output.as_str().unwrap();
    assert!(text.starts_with("<skill_content name=\"Effect &amp; Rust\">\n# Skill: Effect &amp; Rust\n\nUse <effect>.\n\n"));
    assert!(text.contains(&format!(
        "<file>{}</file>",
        fixture.root.join("effect/reference.md").display()
    )));
    assert!(!text.contains("<file>SKILL.md</file>"));
    let instructions = Arc::new(Instructions::default());
    let reader = Read {
        paths: fixture.paths(),
        policy: fixture.policy.clone(),
        instructions: instructions.clone(),
        collator: Arc::new(|left, right| left.cmp(right)),
    };
    let active = ActiveSkill {
        id: "effect".into(),
        name: "Held name".into(),
        entry: None,
    };
    let resource =
        skill::read_local_resource(&info, &active, "reference.md", &reader, fixture.context())
            .await
            .unwrap();
    assert_eq!(resource.name.as_str(), Some("Held name"));
    assert_eq!(resource.already_active, Some(true));
    assert!(
        resource
            .output
            .as_str()
            .unwrap()
            .ends_with(">\nreference text\n</skill_resource>")
    );
    assert!(instructions.0.lock().unwrap().is_empty());
    assert!(
        skill::read_local_resource(&info, &active, "../outside.md", &reader, fixture.context())
            .await
            .is_err()
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            fixture.root.join("outside.md"),
            fixture.root.join("effect/link.md"),
        )
        .unwrap();
        assert!(
            skill::read_local_resource(&info, &active, "link.md", &reader, fixture.context())
                .await
                .is_err()
        );
    }
    fixture.cleanup();
}

#[tokio::test]
async fn managed_skill_tool_records_durable_invocation_and_keeps_accounting_failures_best_effort() {
    use ycoding_core::{
        event_feed::Feed,
        resources::{
            agent, command,
            project_artifact::{accounting, source, source_registry, store},
            skill::Service,
        },
        session,
    };
    use ycoding_schema::{DomainDecode, JsonValue, ObjectEncoder, project, project_artifact};
    use ycoding_store::{artifacts, session::NewEvent};
    let fixture = ToolFixture::new();
    let client = fixture.authority.store.client();
    let registry = Arc::new(std::sync::Mutex::new(source_registry::Registry::default()));
    let accounting = accounting::Service::new(client.clone(), "secret".into());
    let artifacts = store::Service::new(
        client.clone(),
        store::Paths {
            data: fixture.root.join("data"),
            home: fixture.root.join("home"),
            config: fixture.root.join("config"),
        },
        registry.clone(),
    )
    .with_accounting(accounting.clone());
    let written = artifacts.write_manual(store::ManualWriteInput { scope: project_artifact::ScopeSelector::Project, project_id: Some(project::Id::decode(&JsonValue::String("project".into())).unwrap()), id: "review", definition: &project_artifact::Definition::decode(&ycoding_schema::parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review safely."}"#).unwrap()).unwrap(), expected: None, now: 100 }).unwrap();
    let source = source::Service::new(
        source::Options {
            client: client.clone(),
            store: artifacts,
            accounting,
            registry,
            location: ycoding_schema::location::Ref::decode(
                &ycoding_schema::parse_json(r#"{"directory":"/workspace/project"}"#).unwrap(),
            )
            .unwrap(),
            project_id: project::Id::decode(&JsonValue::String("project".into())).unwrap(),
            project_directory: "/workspace/project".into(),
            data_root: fixture.root.join("data"),
        },
        source::Catalogs {
            agents: agent::Service::new(vec![]),
            commands: command::Service::default(),
            skills: Service::new(&fixture.root.join("cache")),
        },
    );
    source.refresh().await;
    let mut catalogs = source.catalogs().await;
    let info = catalogs.skills.list().await.unwrap().remove(0);
    let sessions = session::store::Service::new(client.clone());
    for (id, kind, fields) in [
        (
            "evt_skill_step",
            "session.step.started.1",
            r#"{"sessionID":"ses_tool","assistantMessageID":"msg_tool","agent":"test","model":{"providerID":"test","id":"model"}}"#,
        ),
        (
            "evt_skill_call",
            "session.tool.called.1",
            r#"{"sessionID":"ses_tool","assistantMessageID":"msg_tool","callID":"call_tool","input":{},"executed":false}"#,
        ),
    ] {
        sessions
            .publish(NewEvent {
                id: id.into(),
                aggregate_id: "ses_tool".into(),
                created: 200,
                type_: kind.into(),
                data: ycoding_schema::parse_json(fields).unwrap(),
            })
            .await
            .unwrap();
    }
    let feed = Feed::attach(&client);
    let governor = source.start(&feed).unwrap();
    for _ in 0..2 {
        let output = skill::load_local(&info, &fixture.policy, fixture.context(), Some(&source))
            .await
            .unwrap();
        assert!(output.output.as_str().unwrap().contains("Review safely."));
    }
    let rows = client
        .snapshot()
        .unwrap()
        .scan::<artifacts::ActivationTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            10,
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].source.as_str(), Some("skill-tool"));
    assert_eq!(rows[0].version_id, *written.version_id.as_lossless());
    assert_eq!(rows[0].activated_at, 200);
    let mut missing = fixture.context();
    missing.call_id = "missing".into();
    skill::load_local(&info, &fixture.policy, missing, Some(&source))
        .await
        .unwrap();
    assert!(source.diagnostics().contains(&"activation-failed"));
    sessions
        .publish(NewEvent {
            id: "evt_skill_terminal".into(),
            aggregate_id: "ses_tool".into(),
            created: 250,
            type_: "session.execution.succeeded.1".into(),
            data: ObjectEncoder::new().field("sessionID", "ses_tool").finish(),
        })
        .await
        .unwrap();
    governor.close().await.unwrap();
    assert_eq!(
        client
            .snapshot()
            .unwrap()
            .scan::<artifacts::ObservationTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                10
            )
            .unwrap()
            .len(),
        1
    );
    fixture.cleanup();
}

mod served {
    use super::*;
    use serde_json::{Value, json};
    use std::{collections::BTreeMap, path::PathBuf};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        task::JoinHandle,
    };
    pub use ycoding_ai::llm::ToolOutput;
    pub use ycoding_core::{
        resources::skill::Service as Catalog, session::store::Service as Sessions,
    };
    use ycoding_core::{
        resources::{
            config::Entry,
            mcp::{Service as Mcp, client::Hooks, skills as mcp_skills},
        },
        tools::{
            builtin::skill::SkillTool,
            context::Context as ToolContext,
            registry::{Failure, Tool},
        },
    };
    use ycoding_schema::{
        JsonObject,
        permission::{Effect, Rule},
        skill::{EmbeddedSource, Source},
    };
    pub use ycoding_schema::{JsonValue, parse_json};
    pub use ycoding_store::session::NewEvent;

    pub const SKILL_MD: &str = "---\nname: a\ndescription: d\n---\n# Guide\n";

    pub struct Loopback {
        pub url: String,
        task: JoinHandle<()>,
    }
    impl Loopback {
        pub async fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/mcp", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    tokio::spawn(async move {
                        let mut request = Vec::new();
                        let mut buffer = [0; 2048];
                        let end = loop {
                            let length = stream.read(&mut buffer).await.unwrap();
                            if length == 0 {
                                return;
                            }
                            request.extend_from_slice(&buffer[..length]);
                            if let Some(offset) =
                                request.windows(4).position(|window| window == b"\r\n\r\n")
                            {
                                break offset + 4;
                            }
                        };
                        let headers = String::from_utf8(request[..end].to_vec()).unwrap();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.split_once(':')
                                    .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                                    .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        while request.len() < end + length {
                            let read = stream.read(&mut buffer).await.unwrap();
                            if read == 0 {
                                return;
                            }
                            request.extend_from_slice(&buffer[..read]);
                        }
                        let body: Value = if length == 0 {
                            Value::Null
                        } else {
                            serde_json::from_slice(&request[end..end + length]).unwrap()
                        };
                        let (status, response) =
                            if headers.starts_with("POST") && body.get("id").is_some() {
                                (200, reply(&body).to_string())
                            } else {
                                (
                                    if headers.starts_with("POST") {
                                        202
                                    } else {
                                        405
                                    },
                                    String::new(),
                                )
                            };
                        let head = format!(
                            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            response.len()
                        );
                        stream.write_all(head.as_bytes()).await.unwrap();
                        stream.write_all(response.as_bytes()).await.unwrap();
                    });
                }
            });
            Self { url, task }
        }
        pub fn entry(&self) -> Value {
            json!({"uri":"skill://a/SKILL.md","frontmatter":{"name":"a","description":"d"},"resources":[{"uri":"skill://a/SKILL.md","digest":mcp_skills::digest(SKILL_MD.as_bytes()),"size":SKILL_MD.len()}]})
        }
        pub fn service(&self, directory: PathBuf) -> Mcp {
            let document = parse_json(
                &json!({"mcp":{"servers":{"loopback":{"type":"remote","url":self.url,"oauth":false}}}})
                    .to_string(),
            )
            .unwrap();
            Mcp::new(
                &[Entry::Document {
                    path: None,
                    info: document,
                }],
                directory,
                "1".into(),
                BTreeMap::new(),
                Hooks::default(),
            )
            .unwrap()
        }
    }
    impl Drop for Loopback {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    fn reply(body: &Value) -> Value {
        let entry = json!({"uri":"skill://a/SKILL.md","frontmatter":{"name":"a","description":"d"},"resources":[{"uri":"skill://a/SKILL.md","digest":mcp_skills::digest(SKILL_MD.as_bytes()),"size":SKILL_MD.len()}]});
        let result = match body["method"].as_str().unwrap() {
            "initialize" => Ok(
                json!({"protocolVersion":"2025-11-25","serverInfo":{"name":"loopback","version":"1"},"capabilities":{"tools":{},"prompts":{},"resources":{},"extensions":{"io.modelcontextprotocol/skills":{"directoryRead":true}}}}),
            ),
            "tools/list" => Ok(json!({"tools":[]})),
            "prompts/list" => Ok(json!({"prompts":[]})),
            "resources/list" => Ok(json!({"resources":[]})),
            "resources/templates/list" => Ok(json!({"resourceTemplates":[]})),
            "skills/list" => Ok(
                json!({"resultType":"complete","ttlMs":0,"cacheScope":"server","skills":[entry]}),
            ),
            "skills/get" => {
                Ok(json!({"resultType":"complete","ttlMs":0,"cacheScope":"server","skill":entry}))
            }
            "resources/read" => {
                Ok(json!({"contents":[{"uri":body["params"]["uri"],"text":SKILL_MD}]}))
            }
            _ => Err(-32601),
        };
        match result {
            Ok(result) => json!({"jsonrpc":"2.0","id":body["id"],"result":result}),
            Err(code) => {
                json!({"jsonrpc":"2.0","id":body["id"],"error":{"code":code,"message":"Method not found"}})
            }
        }
    }

    pub fn effect_info(fixture: &ToolFixture) -> ycoding_schema::skill::Info {
        fs::create_dir_all(fixture.root.join("effect")).unwrap();
        fs::write(fixture.root.join("effect/SKILL.md"), "skill").unwrap();
        fs::write(fixture.root.join("effect/reference.md"), "reference text").unwrap();
        fs::write(fixture.root.join("outside.md"), "outside").unwrap();
        ycoding_schema::skill::Info {
            id: "effect".into(),
            name: "Effect".into(),
            description: Some("Use Effect".into()),
            slash: None,
            autoinvoke: None,
            conflicts: Some(ycoding_schema::skill::Conflicts {
                skills: vec!["other".into()],
                instructions: vec![],
            }),
            location: AbsolutePath::new(
                fixture
                    .root
                    .join("effect/SKILL.md")
                    .to_string_lossy()
                    .as_ref(),
            )
            .unwrap(),
            content: "# Effect\n\nGuidance".into(),
        }
    }

    pub fn catalog(fixture: &ToolFixture, skills: Vec<ycoding_schema::skill::Info>) -> Catalog {
        let mut catalog = Catalog::new(&fixture.root.join("cache"));
        for skill in skills {
            catalog.source(Source::Embedded(EmbeddedSource { skill }));
        }
        catalog
    }

    pub fn tool(
        fixture: &ToolFixture,
        catalog: Catalog,
        mcp: &Arc<Mcp>,
        artifacts: Option<ycoding_core::resources::project_artifact::source::Service>,
    ) -> SkillTool {
        SkillTool {
            skills: Arc::new(tokio::sync::Mutex::new(catalog)),
            mcp: Arc::downgrade(mcp),
            sessions: Sessions::new(fixture.authority.store.client()),
            reader: Read {
                paths: fixture.paths(),
                policy: fixture.policy.clone(),
                instructions: Arc::new(Instructions::default()),
                collator: Arc::new(|left, right| left.cmp(right)),
            },
            policy: fixture.policy.clone(),
            artifacts,
        }
    }

    pub fn empty_mcp(fixture: &ToolFixture) -> Mcp {
        Mcp::new(
            &[],
            fixture.root.clone(),
            "1".into(),
            BTreeMap::new(),
            Hooks::default(),
        )
        .unwrap()
    }

    pub async fn call(
        tool: &SkillTool,
        context: ToolContext,
        input: Value,
    ) -> Result<ToolOutput, Failure> {
        tool.settle(parse_json(&input.to_string()).unwrap(), context)
            .await
    }

    pub fn text(output: &ToolOutput) -> String {
        match output.content.as_slice() {
            [ycoding_schema::llm::ToolContent::Text(text)] => {
                text.text.as_str().unwrap().to_owned()
            }
            other => panic!("unexpected content {other:?}"),
        }
    }

    pub fn failure(result: Result<ToolOutput, Failure>) -> String {
        match result {
            Err(Failure::Tool { message, .. }) => message,
            Err(other) => panic!("unexpected failure {other:?}"),
            Ok(output) => panic!("unexpected success {output:?}"),
        }
    }

    pub fn field(output: &ToolOutput, key: &str) -> Option<JsonValue> {
        let JsonValue::Object(structured) = &output.structured else {
            panic!("structured output is not an object")
        };
        structured.get(&key.into()).cloned()
    }

    pub fn string(output: &ToolOutput, key: &str) -> Option<String> {
        match field(output, key) {
            Some(JsonValue::String(value)) => value.as_str().map(str::to_owned),
            _ => None,
        }
    }

    pub fn flag(output: &ToolOutput, key: &str) -> Option<bool> {
        match field(output, key) {
            Some(JsonValue::Bool(value)) => Some(value),
            _ => None,
        }
    }

    pub async fn record(
        sessions: &Sessions,
        assistant: &str,
        now: i64,
        id: &str,
        output: &JsonValue,
    ) {
        let steps: [(&str, &str, JsonValue); 5] = [
            (
                "session.step.started.1",
                "step",
                parse_json(r#"{"agent":"build","model":{"providerID":"local","id":"test"}}"#)
                    .unwrap(),
            ),
            (
                "session.tool.input.started.1",
                "input",
                parse_json(r#"{"name":"skill"}"#).unwrap(),
            ),
            (
                "session.tool.input.ended.1",
                "ended",
                parse_json(r#"{"text":"{}"}"#).unwrap(),
            ),
            (
                "session.tool.called.1",
                "called",
                parse_json(&format!(r#"{{"input":{{"id":"{id}"}},"executed":false}}"#)).unwrap(),
            ),
            ("session.tool.success.1", "success", {
                let mut data = JsonObject::new();
                data.insert("structured".into(), output.clone());
                data.insert("content".into(), JsonValue::Array(vec![]));
                data.insert("executed".into(), JsonValue::Bool(false));
                JsonValue::Object(data)
            }),
        ];
        for (kind, suffix, fields) in steps {
            let JsonValue::Object(mut data) = fields else {
                unreachable!()
            };
            data.insert("sessionID".into(), JsonValue::String("ses_tool".into()));
            data.insert(
                "assistantMessageID".into(),
                JsonValue::String(format!("msg_{assistant}").into()),
            );
            if suffix != "step" {
                data.insert(
                    "callID".into(),
                    JsonValue::String(format!("call_{assistant}").into()),
                );
            }
            sessions
                .publish(NewEvent {
                    id: format!("evt_{assistant}_{suffix}").into(),
                    aggregate_id: "ses_tool".into(),
                    created: now,
                    type_: kind.into(),
                    data: JsonValue::Object(data),
                })
                .await
                .unwrap();
        }
    }

    pub fn deny_all(action: &str) -> Vec<Rule> {
        vec![Rule {
            action: action.into(),
            resource: "*".into(),
            effect: Effect("deny".into()),
        }]
    }
}

#[tokio::test]
async fn skill_tool_is_advertised_with_the_ts_contract_and_follows_the_permission_filter() {
    use served::*;
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let mcp = Arc::new(empty_mcp(&fixture));
    let _registration = registry
        .register(
            vec![(
                "skill".into(),
                Arc::new(tool(&fixture, catalog(&fixture, vec![]), &mcp, None))
                    as Arc<dyn ycoding_core::tools::registry::Tool>,
            )],
            ycoding_core::tools::registry::Options::direct(),
        )
        .unwrap();
    let definitions = registry.materialize(&[]).definitions;
    assert_eq!(definitions.len(), 1);
    let definition = &definitions[0];
    assert_eq!(definition.name.as_str(), Some("skill"));
    assert_eq!(
        definition.description.as_str().unwrap(),
        "Load a specialized skill when the task at hand matches one of the available skills in the instructions.\n\nUse this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill.\n\nThe skill ID must match one of the available skills in the instructions."
    );
    let schema = ycoding_schema::stringify_json(&definition.input_schema);
    assert!(schema.contains(r#""required":["id"]"#), "{schema}");
    assert!(schema.contains("The ID of the skill from the available skills list"));
    assert!(schema.contains("Supporting file path for an active skill."));
    assert!(
        registry
            .materialize(&deny_all("skill"))
            .definitions
            .is_empty()
    );
    fixture.cleanup();
}

#[tokio::test]
async fn skill_tool_loads_authorized_skills_and_rejects_denied_unknown_and_inactive_ids() {
    use served::*;
    let fixture = ToolFixture::new();
    let info = effect_info(&fixture);
    let mcp = Arc::new(empty_mcp(&fixture));
    let tool = tool(&fixture, catalog(&fixture, vec![info.clone()]), &mcp, None);
    let loaded = call(
        &tool,
        fixture.context(),
        serde_json::json!({"id": "effect"}),
    )
    .await
    .unwrap();
    let reference = fixture.root.join("effect/reference.md");
    assert_eq!(
        text(&loaded),
        skill::to_model_output(&info, &[reference.to_string_lossy().into_owned()])
            .as_str()
            .unwrap()
    );
    assert_eq!(string(&loaded, "name").as_deref(), Some("Effect"));
    assert_eq!(
        string(&loaded, "directory").as_deref(),
        fixture.root.join("effect").to_str()
    );
    assert_eq!(flag(&loaded, "alreadyActive"), None);
    assert!(
        ycoding_schema::stringify_json(&field(&loaded, "conflicts").unwrap())
            .contains(r#""skills":["other"]"#)
    );
    assert_eq!(
        failure(
            call(
                &tool,
                fixture.context(),
                serde_json::json!({"id": "missing"})
            )
            .await
        ),
        "Unable to load skill missing"
    );
    assert_eq!(
        failure(
            call(
                &tool,
                fixture.context(),
                serde_json::json!({"id": "effect", "resource": "reference.md"})
            )
            .await
        ),
        "Unable to load skill effect"
    );
    fixture.deny("skill", "effect");
    assert_eq!(
        failure(
            call(
                &tool,
                fixture.context(),
                serde_json::json!({"id": "effect"})
            )
            .await
        ),
        "Unable to load skill effect"
    );
    fixture.cleanup();
}

#[tokio::test]
async fn skill_tool_reports_a_duplicate_load_as_already_active_without_a_new_activation() {
    use served::*;
    use ycoding_core::session::skill_status;
    let fixture = ToolFixture::new();
    let info = effect_info(&fixture);
    let mcp = Arc::new(empty_mcp(&fixture));
    let tool = tool(&fixture, catalog(&fixture, vec![info]), &mcp, None);
    let sessions = Sessions::new(fixture.authority.store.client());
    let first = call(
        &tool,
        fixture.context(),
        serde_json::json!({"id": "effect"}),
    )
    .await
    .unwrap();
    record(&sessions, "first", 100, "effect", &first.structured).await;
    let active = skill_status::list(
        &sessions.transcript(&fixture.context().session_id).unwrap(),
        &[],
    );
    assert_eq!(active.len(), 1);
    let second = call(
        &tool,
        fixture.context(),
        serde_json::json!({"id": "effect"}),
    )
    .await
    .unwrap();
    assert_eq!(
        text(&second),
        "Skill Effect is already active for this session."
    );
    assert_eq!(flag(&second, "alreadyActive"), Some(true));
    assert_eq!(string(&second, "directory").as_deref(), Some(""));
    record(&sessions, "second", 200, "effect", &second.structured).await;
    let statuses = skill_status::list(
        &sessions.transcript(&fixture.context().session_id).unwrap(),
        &[],
    );
    assert_eq!(statuses.len(), 1);
    assert_eq!(
        statuses[0].activation_message_id.as_lossless().as_str(),
        Some("msg_first")
    );
    let resource = call(
        &tool,
        fixture.context(),
        serde_json::json!({"id": "effect", "resource": "reference.md"}),
    )
    .await
    .unwrap();
    assert!(text(&resource).ends_with(">\nreference text\n</skill_resource>"));
    assert_eq!(flag(&resource, "alreadyActive"), Some(true));
    assert_eq!(
        failure(
            call(
                &tool,
                fixture.context(),
                serde_json::json!({"id": "effect", "resource": "../outside.md"})
            )
            .await
        ),
        "Unable to read ../outside.md for skill effect"
    );
    fixture.cleanup();
}

#[tokio::test]
async fn skill_tool_loads_an_mcp_served_skill_under_a_content_bound_approval_and_reads_its_resources()
 {
    use served::*;
    use ycoding_core::{resources::mcp::skills as mcp_skills, session::skill_status};
    let fixture = ToolFixture::new();
    let server = Loopback::start().await;
    let held = mcp_skills::entry(
        &"loopback".into(),
        &parse_json(&server.entry().to_string()).unwrap(),
    )
    .unwrap();
    let id = mcp_skills::id(&"loopback".into(), &held.uri);
    let manifest = mcp_skills::identity_by(&held, |left, right| left.cmp(right));
    let mcp = Arc::new(server.service(fixture.root.clone()));
    let tool = tool(&fixture, catalog(&fixture, vec![]), &mcp, None);
    let sessions = Sessions::new(fixture.authority.store.client());
    fixture.deny("skill", &manifest);
    assert_eq!(
        failure(call(&tool, fixture.context(), serde_json::json!({"id": id})).await),
        format!("Unable to load skill {id}")
    );
    fixture.authority.rules.lock().unwrap().pop();
    let loaded = call(&tool, fixture.context(), serde_json::json!({"id": id}))
        .await
        .unwrap();
    let body = text(&loaded);
    assert!(
        body.starts_with("<skill_content name=\"a\" origin=\"loopback\">\n# Skill: a\n\n# Guide\n\nBase directory for this skill: skill://a\n"),
        "{body}"
    );
    assert!(body.contains("This skill is served over MCP by \"loopback\"."));
    assert!(body.contains("<skill_files>\n</skill_files>"));
    assert_eq!(string(&loaded, "name").as_deref(), Some("a"));
    assert_eq!(string(&loaded, "directory").as_deref(), Some(""));
    assert_eq!(
        field(&loaded, "entry"),
        Some(ycoding_schema::DomainEncode::encode(&held))
    );
    assert_eq!(
        failure(
            call(
                &tool,
                fixture.context(),
                serde_json::json!({"id": id, "resource": "SKILL.md"})
            )
            .await
        ),
        format!("Unable to load skill {id}")
    );
    record(&sessions, "mcp", 100, &id, &loaded.structured).await;
    assert!(
        skill_status::mcp_activation(
            &sessions.transcript(&fixture.context().session_id).unwrap(),
            &id.as_str().into()
        )
        .is_some()
    );
    let again = call(&tool, fixture.context(), serde_json::json!({"id": id}))
        .await
        .unwrap();
    assert_eq!(text(&again), "Skill a is already active for this session.");
    assert_eq!(flag(&again, "alreadyActive"), Some(true));
    let resource = call(
        &tool,
        fixture.context(),
        serde_json::json!({"id": id, "resource": "SKILL.md"}),
    )
    .await
    .unwrap();
    assert_eq!(
        text(&resource),
        format!("<skill_resource uri=\"skill://a/SKILL.md\">\n{SKILL_MD}\n</skill_resource>")
    );
    assert_eq!(flag(&resource, "alreadyActive"), Some(true));
    for reference in ["other.md", "../b/SKILL.md"] {
        assert_eq!(
            failure(
                call(
                    &tool,
                    fixture.context(),
                    serde_json::json!({"id": id, "resource": reference})
                )
                .await
            ),
            format!("Unable to read {reference} for skill {id}")
        );
    }
    fixture.deny("skill", &manifest);
    assert_eq!(
        failure(
            call(
                &tool,
                fixture.context(),
                serde_json::json!({"id": id, "resource": "SKILL.md"})
            )
            .await
        ),
        format!("Unable to read SKILL.md for skill {id}")
    );
    fixture.cleanup();
}

#[tokio::test]
async fn mcp_skill_calls_retain_the_service_through_approval_and_release_it_on_settlement() {
    use served::*;
    use ycoding_core::tools::policy::permissions::Permissions;
    for resource in [false, true] {
        let fixture = ToolFixture::new();
        let server = Loopback::start().await;
        let mcp = Arc::new(server.service(fixture.root.clone()));
        let id = ycoding_core::resources::mcp::skills::id(
            &"loopback".into(),
            &"skill://a/SKILL.md".into(),
        );
        let mut tool = tool(&fixture, catalog(&fixture, vec![]), &mcp, None);
        assert_eq!(Arc::strong_count(&mcp), 1);
        if resource {
            let loaded = call(&tool, fixture.context(), serde_json::json!({"id": id}))
                .await
                .unwrap();
            record(&tool.sessions, "mcp", 100, &id, &loaded.structured).await;
        }
        fixture.authority.session("ses_tool", None, 0, false, None);
        fixture.authority.rules.lock().unwrap().clear();
        let requested = Arc::new(tokio::sync::Notify::new());
        let notify = requested.clone();
        let publisher = fixture.authority.publisher();
        let permissions = Permissions::new(
            fixture.authority.authority(),
            ycoding_schema::project_id::ProjectId::new("project").unwrap(),
            Arc::new(move |event| {
                publisher(event)?;
                notify.notify_one();
                Ok(())
            }),
        );
        tool.policy = Arc::new(ycoding_core::tools::context::policy::LeafPolicy {
            permissions: permissions.clone(),
            guardrails: fixture.policy.guardrails.clone(),
        });
        let input = if resource {
            serde_json::json!({"id": id, "resource": "SKILL.md"})
        } else {
            serde_json::json!({"id": id})
        };
        let held = Arc::downgrade(&mcp);
        let mut pending = Box::pin(call(&tool, fixture.context(), input.clone()));
        tokio::select! {
            result = &mut pending => panic!("skill call settled before approval: {result:?}"),
            _ = requested.notified() => {},
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => panic!("skill approval was not requested"),
        }
        drop(mcp);
        assert!(held.upgrade().is_some());
        permissions
            .reply(
                &permissions.list()[0].id,
                ycoding_schema::permission::Reply("once".into()),
                None,
            )
            .unwrap();
        let output = pending.await.unwrap();
        assert!(text(&output).contains("# Guide"));
        assert_eq!(flag(&output, "alreadyActive"), resource.then_some(true));
        assert!(held.upgrade().is_none());
        let expected = if resource {
            format!("Unable to read SKILL.md for skill {id}")
        } else {
            format!("Unable to load skill {id}")
        };
        assert_eq!(
            failure(call(&tool, fixture.context(), input).await),
            expected
        );
        fixture.cleanup();
    }
}

#[tokio::test]
async fn skill_tool_loads_a_managed_artifact_skill_and_records_its_skill_tool_activation() {
    use served::*;
    use ycoding_core::{
        event_feed::Feed,
        resources::{
            agent, command,
            project_artifact::{accounting, source, source_registry, store},
        },
    };
    use ycoding_schema::{DomainDecode, project, project_artifact};
    use ycoding_store::artifacts;
    let fixture = ToolFixture::new();
    let client = fixture.authority.store.client();
    let registry = Arc::new(std::sync::Mutex::new(source_registry::Registry::default()));
    let accounting = accounting::Service::new(client.clone(), "secret".into());
    let artifacts = store::Service::new(
        client.clone(),
        store::Paths {
            data: fixture.root.join("data"),
            home: fixture.root.join("home"),
            config: fixture.root.join("config"),
        },
        registry.clone(),
    )
    .with_accounting(accounting.clone());
    artifacts.write_manual(store::ManualWriteInput { scope: project_artifact::ScopeSelector::Project, project_id: Some(project::Id::decode(&JsonValue::String("project".into())).unwrap()), id: "review", definition: &project_artifact::Definition::decode(&parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review safely."}"#).unwrap()).unwrap(), expected: None, now: 100 }).unwrap();
    let source = source::Service::new(
        source::Options {
            client: client.clone(),
            store: artifacts,
            accounting,
            registry,
            location: ycoding_schema::location::Ref::decode(
                &parse_json(r#"{"directory":"/workspace/project"}"#).unwrap(),
            )
            .unwrap(),
            project_id: project::Id::decode(&JsonValue::String("project".into())).unwrap(),
            project_directory: "/workspace/project".into(),
            data_root: fixture.root.join("data"),
        },
        source::Catalogs {
            agents: agent::Service::new(vec![]),
            commands: command::Service::default(),
            skills: Catalog::new(&fixture.root.join("cache")),
        },
    );
    source.refresh().await;
    let catalogs = source.catalogs().await;
    let sessions = Sessions::new(client.clone());
    for (id, kind, fields) in [
        (
            "evt_managed_step",
            "session.step.started.1",
            r#"{"sessionID":"ses_tool","assistantMessageID":"msg_tool","agent":"test","model":{"providerID":"test","id":"model"}}"#,
        ),
        (
            "evt_managed_call",
            "session.tool.called.1",
            r#"{"sessionID":"ses_tool","assistantMessageID":"msg_tool","callID":"call_tool","input":{},"executed":false}"#,
        ),
    ] {
        sessions
            .publish(NewEvent {
                id: id.into(),
                aggregate_id: "ses_tool".into(),
                created: 200,
                type_: kind.into(),
                data: parse_json(fields).unwrap(),
            })
            .await
            .unwrap();
    }
    let feed = Feed::attach(&client);
    let governor = source.start(&feed).unwrap();
    let mcp = Arc::new(empty_mcp(&fixture));
    let tool = tool(&fixture, catalogs.skills, &mcp, Some(source));
    let loaded = call(
        &tool,
        fixture.context(),
        serde_json::json!({"id": "review"}),
    )
    .await
    .unwrap();
    assert!(text(&loaded).contains("Review safely."));
    assert_eq!(string(&loaded, "name").as_deref(), Some("Review"));
    let rows = client
        .snapshot()
        .unwrap()
        .scan::<artifacts::ActivationTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            10,
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].source.as_str(), Some("skill-tool"));
    governor.close().await.unwrap();
    fixture.cleanup();
}

enum GoalStep {
    Activate,
    Complete,
    Stop,
}

async fn managed_goal_source(
    location: &str,
) -> (
    ToolFixture,
    ycoding_store::Client,
    ycoding_core::resources::project_artifact::source::Service,
    Info,
) {
    use ycoding_core::{
        resources::{
            agent, command,
            project_artifact::{accounting, source, source_registry, store},
            skill::Service,
        },
        session,
    };
    use ycoding_schema::{DomainDecode, JsonValue, project, project_artifact};
    use ycoding_store::session::NewEvent;
    let fixture = ToolFixture::new();
    let client = fixture.authority.store.client();
    let registry = Arc::new(std::sync::Mutex::new(source_registry::Registry::default()));
    let accounting = accounting::Service::new(client.clone(), "secret".into());
    let artifacts_store = store::Service::new(
        client.clone(),
        store::Paths {
            data: fixture.root.join("data"),
            home: fixture.root.join("home"),
            config: fixture.root.join("config"),
        },
        registry.clone(),
    )
    .with_accounting(accounting.clone());
    artifacts_store.write_manual(store::ManualWriteInput { scope: project_artifact::ScopeSelector::Project, project_id: Some(project::Id::decode(&JsonValue::String("project".into())).unwrap()), id: "review", definition: &project_artifact::Definition::decode(&ycoding_schema::parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review safely."}"#).unwrap()).unwrap(), expected: None, now: 100 }).unwrap();
    let source = source::Service::new(
        source::Options {
            client: client.clone(),
            store: artifacts_store,
            accounting,
            registry,
            location: ycoding_schema::location::Ref::decode(
                &ycoding_schema::parse_json(&format!(r#"{{"directory":"{location}"}}"#)).unwrap(),
            )
            .unwrap(),
            project_id: project::Id::decode(&JsonValue::String("project".into())).unwrap(),
            project_directory: "/workspace/project".into(),
            data_root: fixture.root.join("data"),
        },
        source::Catalogs {
            agents: agent::Service::new(vec![]),
            commands: command::Service::default(),
            skills: Service::new(&fixture.root.join("cache")),
        },
    );
    source.refresh().await;
    let mut catalogs = source.catalogs().await;
    let info = catalogs.skills.list().await.unwrap().remove(0);
    let sessions = session::store::Service::new(client.clone());
    for (id, kind, fields) in [
        (
            "evt_goal_step",
            "session.step.started.1",
            r#"{"sessionID":"ses_tool","assistantMessageID":"msg_tool","agent":"test","model":{"providerID":"test","id":"model"}}"#,
        ),
        (
            "evt_goal_call",
            "session.tool.called.1",
            r#"{"sessionID":"ses_tool","assistantMessageID":"msg_tool","callID":"call_tool","input":{},"executed":false}"#,
        ),
    ] {
        sessions
            .publish(NewEvent {
                id: id.into(),
                aggregate_id: "ses_tool".into(),
                created: 200,
                type_: kind.into(),
                data: ycoding_schema::parse_json(fields).unwrap(),
            })
            .await
            .unwrap();
    }
    (fixture, client, source, info)
}

async fn terminal_rows_after_burst(
    location: &str,
    active_at_start: bool,
    during: Vec<GoalStep>,
) -> (Vec<(i64, String)>, Vec<&'static str>) {
    use ycoding_core::{
        event_feed::Feed,
        session::{self, autonomy},
    };
    use ycoding_schema::ObjectEncoder;
    use ycoding_store::{artifacts, session::NewEvent};
    let (fixture, client, source, info) = managed_goal_source(location).await;
    let id = ycoding_schema::session::Id::new("ses_tool").unwrap();
    if active_at_start {
        autonomy::Service::new(client.clone())
            .set_goal(&id, autonomy::Goal::new("Ship the change", None, None))
            .await
            .unwrap();
    }
    let feed = Feed::attach(&client);
    let governor = source.start(&feed).unwrap();
    skill::load_local(&info, &fixture.policy, fixture.context(), Some(&source))
        .await
        .unwrap();
    let burst = {
        let client = client.clone();
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(async move {
                    let sessions = session::store::Service::new(client.clone());
                    let goals = autonomy::Service::new(client);
                    sessions
                        .publish(NewEvent {
                            id: "evt_goal_started".into(),
                            aggregate_id: "ses_tool".into(),
                            created: 300,
                            type_: "session.execution.started.1".into(),
                            data: ObjectEncoder::new().field("sessionID", "ses_tool").finish(),
                        })
                        .await
                        .unwrap();
                    for step in during {
                        match step {
                            GoalStep::Activate => goals
                                .set_goal(&id, autonomy::Goal::new("Ship the change", None, None))
                                .await
                                .unwrap(),
                            GoalStep::Complete => goals.complete(&id).await.unwrap(),
                            GoalStep::Stop => goals.stop(&id).await.unwrap(),
                        };
                    }
                    sessions
                        .publish(NewEvent {
                            id: "evt_goal_succeeded".into(),
                            aggregate_id: "ses_tool".into(),
                            created: 400,
                            type_: "session.execution.succeeded.1".into(),
                            data: ObjectEncoder::new().field("sessionID", "ses_tool").finish(),
                        })
                        .await
                        .unwrap();
                });
        })
    };
    burst.join().unwrap();
    governor.close().await.unwrap();
    let terminals = client
        .snapshot()
        .unwrap()
        .scan::<artifacts::TerminalTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            10,
        )
        .unwrap()
        .into_iter()
        .map(|row| (row.goal_mode, row.goal_status.as_str().unwrap().to_string()))
        .collect();
    let diagnostics = source.diagnostics();
    fixture.cleanup();
    (terminals, diagnostics)
}

#[tokio::test]
async fn w49_r1_a_goal_active_at_execution_start_stays_captured_after_it_completes_before_the_drain()
 {
    let (terminals, diagnostics) =
        terminal_rows_after_burst("/workspace/project", true, vec![GoalStep::Complete]).await;
    assert_eq!(terminals, vec![(1, "completed".to_string())]);
    assert!(!diagnostics.contains(&"terminal-observation-failed"));
}

#[tokio::test]
async fn w49_r1_a_goal_active_at_execution_start_stays_captured_after_it_stops_before_the_drain() {
    let (terminals, diagnostics) =
        terminal_rows_after_burst("/workspace/project", true, vec![GoalStep::Stop]).await;
    assert_eq!(terminals, vec![(1, "stopped".to_string())]);
    assert!(!diagnostics.contains(&"terminal-observation-failed"));
}

#[tokio::test]
async fn w49_r2_executions_in_another_location_record_nothing() {
    let (own, _) = terminal_rows_after_burst("/workspace/project", true, vec![]).await;
    assert_eq!(own, vec![(1, "none".to_string())]);
    let (other, diagnostics) = terminal_rows_after_burst("/workspace/other", true, vec![]).await;
    assert!(other.is_empty(), "{other:?}");
    assert!(!diagnostics.contains(&"terminal-observation-failed"));
}

#[tokio::test]
async fn w49_r3_a_goal_inactive_at_execution_start_stays_outside_goal_mode_after_one_activates() {
    let (terminals, diagnostics) =
        terminal_rows_after_burst("/workspace/project", false, vec![GoalStep::Activate]).await;
    assert_eq!(terminals, vec![(0, "none".to_string())]);
    assert!(!diagnostics.contains(&"terminal-observation-failed"));
}

fn execution_event(id: &str, kind: &str, created: i64) -> ycoding_store::session::NewEvent {
    ycoding_store::session::NewEvent {
        id: id.into(),
        aggregate_id: "ses_tool".into(),
        created,
        type_: kind.into(),
        data: ycoding_schema::ObjectEncoder::new()
            .field("sessionID", "ses_tool")
            .finish(),
    }
}

fn keyed_terminal_rows(client: &ycoding_store::Client) -> Vec<(String, i64, String)> {
    let mut rows = client
        .snapshot()
        .unwrap()
        .scan::<ycoding_store::artifacts::TerminalTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            10,
        )
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.terminal_message_id
                    .as_ref()
                    .and_then(|message| message.as_str())
                    .unwrap_or_default()
                    .to_string(),
                row.goal_mode,
                row.goal_status.as_str().unwrap().to_string(),
            )
        })
        .collect::<Vec<_>>();
    rows.sort();
    rows
}

#[tokio::test]
async fn w49_r4_a_lagging_governor_keeps_each_execution_start_with_its_own_terminal() {
    use ycoding_core::{
        event_feed::Feed,
        session::{self, autonomy},
    };
    use ycoding_store::session::NewEvent;
    let (fixture, client, source, info) = managed_goal_source("/workspace/project").await;
    let id = ycoding_schema::session::Id::new("ses_tool").unwrap();
    let feed = Feed::attach(&client);
    let governor = source.start(&feed).unwrap();
    skill::load_local(&info, &fixture.policy, fixture.context(), Some(&source))
        .await
        .unwrap();
    let burst = {
        let client = client.clone();
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(async move {
                    let sessions = session::store::Service::new(client.clone());
                    let goals = autonomy::Service::new(client);
                    sessions
                        .publish(execution_event(
                            "evt_two_a_started",
                            "session.execution.started.1",
                            300,
                        ))
                        .await
                        .unwrap();
                    sessions
                        .publish(execution_event(
                            "evt_two_a_succeeded",
                            "session.execution.succeeded.1",
                            400,
                        ))
                        .await
                        .unwrap();
                    goals
                        .set_goal(&id, autonomy::Goal::new("Ship the change", None, None))
                        .await
                        .unwrap();
                    sessions
                        .publish(execution_event(
                            "evt_two_b_started",
                            "session.execution.started.1",
                            500,
                        ))
                        .await
                        .unwrap();
                });
        })
    };
    burst.join().unwrap();
    governor.flush().await.unwrap();
    let sessions = session::store::Service::new(client.clone());
    sessions
        .publish(NewEvent {
            id: "evt_two_b_step".into(),
            aggregate_id: "ses_tool".into(),
            created: 600,
            type_: "session.step.started.1".into(),
            data: ycoding_schema::parse_json(
                r#"{"sessionID":"ses_tool","assistantMessageID":"msg_b","agent":"test","model":{"providerID":"test","id":"model"}}"#,
            )
            .unwrap(),
        })
        .await
        .unwrap();
    sessions
        .publish(execution_event(
            "evt_two_b_succeeded",
            "session.execution.succeeded.1",
            700,
        ))
        .await
        .unwrap();
    governor.close().await.unwrap();
    let rows = keyed_terminal_rows(&client);
    let diagnostics = source.diagnostics();
    fixture.cleanup();
    assert_eq!(
        rows,
        vec![
            ("msg_b".to_string(), 1, "none".to_string()),
            ("msg_tool".to_string(), 0, "none".to_string())
        ]
    );
    assert!(!diagnostics.contains(&"terminal-observation-failed"));
}

#[tokio::test]
async fn w49_r5_an_execution_started_before_the_governor_runs_is_not_goal_mode() {
    use ycoding_core::{
        event_feed::Feed,
        session::{self, autonomy},
    };
    let (fixture, client, source, info) = managed_goal_source("/workspace/project").await;
    let id = ycoding_schema::session::Id::new("ses_tool").unwrap();
    autonomy::Service::new(client.clone())
        .set_goal(&id, autonomy::Goal::new("Ship the change", None, None))
        .await
        .unwrap();
    let sessions = session::store::Service::new(client.clone());
    sessions
        .publish(execution_event(
            "evt_early_started",
            "session.execution.started.1",
            300,
        ))
        .await
        .unwrap();
    let feed = Feed::attach(&client);
    let governor = source.start(&feed).unwrap();
    skill::load_local(&info, &fixture.policy, fixture.context(), Some(&source))
        .await
        .unwrap();
    sessions
        .publish(execution_event(
            "evt_early_succeeded",
            "session.execution.succeeded.1",
            400,
        ))
        .await
        .unwrap();
    governor.close().await.unwrap();
    let rows = keyed_terminal_rows(&client);
    let diagnostics = source.diagnostics();
    fixture.cleanup();
    assert_eq!(rows, vec![("msg_tool".to_string(), 0, "none".to_string())]);
    assert!(!diagnostics.contains(&"terminal-observation-failed"));
}
