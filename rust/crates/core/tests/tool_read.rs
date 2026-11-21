include!("tool_fixture.rs");
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use ycoding_core::tools::{
    builtin::read::Read,
    context::{
        Context,
        consumers::{ConsumerFuture, ReadInstructions},
    },
    registry::Options,
};
use ycoding_schema::{JsonValue, parse_json};
use ycoding_store::{KeyPart, session::InstructionEntryTable, tuple_key};

#[derive(Default)]
struct Instructions(Mutex<Vec<PathBuf>>);
impl ReadInstructions for Instructions {
    fn load(&self, _: Context, paths: Vec<PathBuf>) -> ConsumerFuture<'_, ()> {
        Box::pin(async move {
            self.0.lock().unwrap().extend(paths);
            Ok(())
        })
    }
}

#[tokio::test]
async fn real_read_pages_and_lists_and_hands_nested_instructions_to_the_session_boundary() {
    let fixture = ToolFixture::new();
    fs::create_dir_all(fixture.root.join("src")).unwrap();
    fs::write(fixture.root.join("AGENTS.md"), "root instructions").unwrap();
    fs::write(fixture.root.join("src/AGENTS.md"), "nested instructions").unwrap();
    fs::write(fixture.root.join("src/text.txt"), "one\ntwo\nthree\n").unwrap();
    let instructions = Arc::new(Instructions::default());
    let registry = fixture.registry();
    let _scope = registry
        .register(
            vec![(
                "read".into(),
                Arc::new(Read {
                    paths: fixture.paths(),
                    policy: fixture.policy.clone(),
                    instructions: instructions.clone(),
                    collator: Arc::new(|left, right| left.cmp(right)),
                }),
            )],
            Options::direct(),
        )
        .unwrap();
    assert_eq!(registry.materialize(&[]).definitions[0].input_schema, parse_json(r#"{"type":"object","properties":{"path":{"type":"string"},"offset":{"anyOf":[{"type":"integer","allOf":[{"exclusiveMinimum":0}]},{"type":"null"}],"description":"The 1-based directory entry or text line offset to start reading from"},"limit":{"anyOf":[{"type":"integer","allOf":[{"exclusiveMinimum":0},{"maximum":2000}]},{"type":"null"}],"description":"The maximum number of directory entries or text lines to read"}},"required":["path"],"additionalProperties":false}"#).unwrap());
    let page = registry
        .materialize(&[])
        .invoke(
            "read",
            parse_json(r#"{"path":"src/text.txt","offset":2,"limit":1}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(page.result, ycoding_ai::llm::ToolResultValue::Json(parse_json(r#"{"type":"text-page","content":"two","mime":"text/plain","offset":2,"truncated":true,"next":3}"#).unwrap()));
    assert_eq!(
        *instructions.0.lock().unwrap(),
        [fixture.root.join("src/AGENTS.md")]
    );
    let list = registry
        .materialize(&[])
        .invoke(
            "read",
            parse_json(r#"{"path":"src","offset":2,"limit":1}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(
        list.result,
        ycoding_ai::llm::ToolResultValue::Json(
            parse_json(r#"{"entries":[{"path":"text.txt","type":"file"}],"truncated":false}"#)
                .unwrap()
        )
    );
    fixture.deny("read", "src/text.txt");
    let denied = registry
        .materialize(&[])
        .invoke(
            "read",
            parse_json(r#"{"path":"src/text.txt"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(
        denied.result,
        ycoding_ai::llm::ToolResultValue::Error(JsonValue::String(
            "Unable to read src/text.txt".into()
        ))
    );
    fixture.cleanup();
}

#[tokio::test]
async fn external_reads_require_external_authority_and_never_load_local_instructions() {
    let fixture = ToolFixture::new();
    let outside = fixture
        .root
        .parent()
        .unwrap()
        .join(format!("tool_read_external_{}", std::process::id()));
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("external.txt"), "outside").unwrap();
    let instructions = Arc::new(Instructions::default());
    let registry = fixture.registry();
    let _scope = registry
        .register(
            vec![(
                "read".into(),
                Arc::new(Read {
                    paths: fixture.paths(),
                    policy: fixture.policy.clone(),
                    instructions: instructions.clone(),
                    collator: Arc::new(|left, right| left.cmp(right)),
                }),
            )],
            Options::direct(),
        )
        .unwrap();
    let input = parse_json(&format!(
        r#"{{"path":{}}}"#,
        ycoding_schema::stringify_json(&JsonValue::String(
            outside
                .join("external.txt")
                .to_string_lossy()
                .as_ref()
                .into()
        ))
    ))
    .unwrap();
    let output = registry
        .materialize(&[])
        .invoke("read", input.clone(), fixture.context())
        .await
        .unwrap()
        .output
        .unwrap();
    let JsonValue::Object(output) = output.structured else {
        panic!("content")
    };
    assert_eq!(
        output.get(&"content".into()),
        Some(&JsonValue::String("outside".into()))
    );
    assert!(instructions.0.lock().unwrap().is_empty());
    fixture.deny("external_directory", "*");
    let output = registry
        .materialize(&[])
        .invoke("read", input, fixture.context())
        .await
        .unwrap();
    assert!(matches!(
        output.result,
        ycoding_ai::llm::ToolResultValue::Error(_)
    ));
    fs::remove_dir_all(outside).unwrap();
    fixture.cleanup();
}

#[tokio::test]
async fn real_read_tool_injects_only_nested_agents_as_durable_synthetic_history() {
    let fixture = ToolFixture::new();
    fs::create_dir_all(fixture.root.join("src")).unwrap();
    fs::write(fixture.root.join("AGENTS.md"), "root instructions").unwrap();
    fs::write(fixture.root.join("src/AGENTS.md"), "nested instructions").unwrap();
    fs::write(fixture.root.join("src/file.txt"), "local").unwrap();
    fs::write(fixture.root.join("root.txt"), "root").unwrap();
    let outside = fixture.root.parent().unwrap().join(format!(
        "tool_read_outside_{}_{}",
        std::process::id(),
        fixture.root.file_name().unwrap().to_string_lossy()
    ));
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("external.txt"), "external").unwrap();
    let configuration = Arc::new(
        ycoding_core::resources::config::Configuration::load(
            ycoding_core::resources::config::LoadOptions {
                directory: fixture.root.clone(),
                roots: ycoding_core::resources::config::Roots::development(&fixture.root).unwrap(),
                project: true,
                file: None,
                content: Some("{}".into()),
                env: Default::default(),
            },
        )
        .unwrap(),
    );
    let store = fixture.authority.store.client();
    let registry = fixture.registry();
    let _scope = registry
        .register(
            vec![(
                "read".into(),
                Arc::new(Read {
                    paths: fixture.paths(),
                    policy: fixture.policy.clone(),
                    instructions: Arc::new(ycoding_core::session::read_instructions::Service::new(
                        ycoding_core::session::store::Service::new(store.clone()),
                        fixture.root.clone(),
                        configuration,
                    )),
                    collator: Arc::new(|left, right| left.cmp(right)),
                }),
            )],
            Options::direct(),
        )
        .unwrap();
    for _ in 0..2 {
        registry
            .materialize(&[])
            .invoke(
                "read",
                parse_json(r#"{"path":"src/file.txt"}"#).unwrap(),
                fixture.context(),
            )
            .await
            .unwrap();
    }
    let sessions = ycoding_core::session::store::Service::new(store.clone());
    let messages = sessions
        .context(&ycoding_schema::session::Id::new("ses_tool").unwrap())
        .unwrap();
    let synthetic = messages
        .iter()
        .filter_map(|message| match message {
            ycoding_schema::session_message::Info::Synthetic(message) => Some(message),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(synthetic.len(), 1);
    let nested = fixture.root.join("src/AGENTS.md");
    let expected_text = format!(
        "Instructions from: {}\nnested instructions",
        nested.display()
    );
    assert_eq!(synthetic[0].text.as_str(), Some(expected_text.as_str()));
    assert_eq!(
        synthetic[0].description.as_ref().unwrap().as_str(),
        Some("Loaded src/AGENTS.md")
    );
    let expected_paths = parse_json(&format!(
        r#"{{"instruction":{{"paths":[{}]}}}}"#,
        ycoding_schema::stringify_json(&JsonValue::String(
            nested.to_string_lossy().into_owned().into()
        ))
    ))
    .unwrap();
    let JsonValue::Object(expected_paths) = expected_paths else {
        panic!()
    };
    assert_eq!(synthetic[0].metadata, Some(expected_paths));
    registry
        .materialize(&[])
        .invoke(
            "read",
            parse_json(r#"{"path":"root.txt"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    registry
        .materialize(&[])
        .invoke(
            "read",
            parse_json(&format!(
                r#"{{"path":{}}}"#,
                ycoding_schema::stringify_json(&JsonValue::String(
                    outside
                        .join("external.txt")
                        .to_string_lossy()
                        .into_owned()
                        .into()
                ))
            ))
            .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(
        sessions
            .context(&ycoding_schema::session::Id::new("ses_tool").unwrap())
            .unwrap()
            .iter()
            .filter(|message| matches!(
                message,
                ycoding_schema::session_message::Info::Synthetic(_)
            ))
            .count(),
        1
    );
    let key = format!(
        "read.{}",
        ycoding_core::session::prompt_cache::sha256(&nested.to_string_lossy())
    );
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<InstructionEntryTable>(&tuple_key(&[
                KeyPart::String(&"ses_tool".into()),
                KeyPart::String(&key.into()),
            ]))
            .unwrap()
            .is_none()
    );
    fs::remove_dir_all(outside).unwrap();
    fixture.cleanup();
}

#[cfg(unix)]
#[tokio::test]
async fn real_read_tool_resolves_symlinked_agents_candidates_before_injection() {
    use std::os::unix::fs::symlink;

    let fixture = ToolFixture::new();
    fs::create_dir_all(fixture.root.join("docs")).unwrap();
    fs::create_dir_all(fixture.root.join("linked")).unwrap();
    fs::write(fixture.root.join("docs/AGENTS.md"), "resolved instructions").unwrap();
    fs::write(fixture.root.join("linked/file.txt"), "local").unwrap();
    symlink(
        fixture.root.join("docs/AGENTS.md"),
        fixture.root.join("linked/AGENTS.md"),
    )
    .unwrap();
    let configuration = Arc::new(
        ycoding_core::resources::config::Configuration::load(
            ycoding_core::resources::config::LoadOptions {
                directory: fixture.root.clone(),
                roots: ycoding_core::resources::config::Roots::development(&fixture.root).unwrap(),
                project: true,
                file: None,
                content: Some("{}".into()),
                env: Default::default(),
            },
        )
        .unwrap(),
    );
    let store = fixture.authority.store.client();
    let registry = fixture.registry();
    let _scope = registry
        .register(
            vec![(
                "read".into(),
                Arc::new(Read {
                    paths: fixture.paths(),
                    policy: fixture.policy.clone(),
                    instructions: Arc::new(ycoding_core::session::read_instructions::Service::new(
                        ycoding_core::session::store::Service::new(store.clone()),
                        fixture.root.clone(),
                        configuration,
                    )),
                    collator: Arc::new(|left, right| left.cmp(right)),
                }),
            )],
            Options::direct(),
        )
        .unwrap();
    registry
        .materialize(&[])
        .invoke(
            "read",
            parse_json(r#"{"path":"linked/file.txt"}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let messages = ycoding_core::session::store::Service::new(store)
        .context(&ycoding_schema::session::Id::new("ses_tool").unwrap())
        .unwrap();
    let synthetic = messages
        .iter()
        .find_map(|message| match message {
            ycoding_schema::session_message::Info::Synthetic(message) => Some(message),
            _ => None,
        })
        .unwrap();
    let source = fixture.root.join("docs/AGENTS.md");
    let expected_text = format!(
        "Instructions from: {}\nresolved instructions",
        source.display()
    );
    assert_eq!(synthetic.text.as_str(), Some(expected_text.as_str()));
    assert_eq!(
        synthetic.description.as_ref().unwrap().as_str(),
        Some("Loaded docs/AGENTS.md")
    );
    fixture.cleanup();
}
