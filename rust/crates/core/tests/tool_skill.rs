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
        mcp: Mcp,
        artifacts: Option<ycoding_core::resources::project_artifact::source::Service>,
    ) -> SkillTool {
        SkillTool {
            skills: Arc::new(tokio::sync::Mutex::new(catalog)),
            mcp: Arc::new(mcp),
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
    let _registration = registry
        .register(
            vec![(
                "skill".into(),
                Arc::new(tool(
                    &fixture,
                    catalog(&fixture, vec![]),
                    empty_mcp(&fixture),
                    None,
                )) as Arc<dyn ycoding_core::tools::registry::Tool>,
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
    let tool = tool(
        &fixture,
        catalog(&fixture, vec![info.clone()]),
        empty_mcp(&fixture),
        None,
    );
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
    let tool = tool(
        &fixture,
        catalog(&fixture, vec![info]),
        empty_mcp(&fixture),
        None,
    );
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
    let tool = tool(
        &fixture,
        catalog(&fixture, vec![]),
        server.service(fixture.root.clone()),
        None,
    );
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
    let tool = tool(&fixture, catalogs.skills, empty_mcp(&fixture), Some(source));
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
