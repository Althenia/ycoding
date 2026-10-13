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
