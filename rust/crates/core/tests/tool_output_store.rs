use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime},
};
use ycoding_ai::llm::ToolOutput;
use ycoding_core::resources::{
    config::{Configuration, LoadOptions, Roots},
    tool_output_store::Store,
};
use ycoding_schema::{
    JsonValue, LosslessString,
    llm::{ToolContent, ToolFileContent, ToolTextContent},
    parse_json,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-wp009-store-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn text(text: impl Into<LosslessString>) -> ToolContent {
    ToolContent::Text(ToolTextContent { text: text.into() })
}

#[tokio::test]
async fn bounds_aggregate_preserving_exact_file_media_and_structured_data() {
    let fixture = Fixture::new();
    let roots = Roots::development(&fixture.0).unwrap();
    let store = Store::new(&roots);
    let media = ToolContent::File(ToolFileContent {
        uri: "data:large".into(),
        mime: "image/png".into(),
        name: None,
    });
    let original = format!("HEAD{}TAIL", "é😀".repeat(15000));
    let output = ToolOutput {
        structured: JsonValue::Bool(true),
        content: vec![text(&original[..4]), text(&original[4..]), media.clone()],
    };
    let bounded = store.bound(output.clone(), None).await.unwrap();
    assert_eq!(bounded.output.structured, output.structured);
    assert_eq!(bounded.output.content[1], media);
    assert_eq!(bounded.output_paths.len(), 1);
    assert_eq!(
        fs::read_to_string(&bounded.output_paths[0]).unwrap(),
        original
    );
    let ToolContent::Text(preview) = &bounded.output.content[0] else {
        panic!("missing preview")
    };
    let preview = preview.text.to_utf8().unwrap();
    assert!(preview.len() <= 50 * 1024);
    assert!(preview.starts_with("HEAD") && preview.ends_with("TAIL"));
    assert!(preview.contains(bounded.output_paths[0].to_str().unwrap()));
    let native = ToolOutput {
        structured: JsonValue::Null,
        content: vec![media],
    };
    assert_eq!(
        store.bound(native.clone(), None).await.unwrap().output,
        native
    );
}

#[tokio::test]
async fn configured_limits_structured_only_utf16_and_retention_integrity() {
    let fixture = Fixture::new();
    let roots = Roots::development(&fixture.0).unwrap();
    let configuration = Configuration::load(LoadOptions {
        directory: fixture.0.clone(),
        roots: roots.clone(),
        project: false,
        file: None,
        content: Some("{\"tool_output\":{\"max_lines\":6,\"max_bytes\":256}}".into()),
        env: Default::default(),
    })
    .unwrap();
    let store = Store::new(&roots);
    let structured = parse_json(&format!("{{\"a\":\"{}\"}}", "x".repeat(400))).unwrap();
    let result = store
        .bound(
            ToolOutput {
                structured: structured.clone(),
                content: Vec::new(),
            },
            Some(&configuration),
        )
        .await
        .unwrap();
    assert_eq!(
        parse_json(&fs::read_to_string(&result.output_paths[0]).unwrap()).unwrap(),
        structured
    );
    let ToolContent::Text(preview) = &result.output.content[0] else {
        panic!("missing preview")
    };
    assert!(preview.text.to_utf8().unwrap().len() <= 256);
    assert!(preview.text.to_utf8().unwrap().split('\n').count() <= 6);
    let surrogate = ToolOutput {
        structured: JsonValue::Null,
        content: vec![
            text(LosslessString::from_utf16(vec![0xd83d])),
            text(LosslessString::from_utf16(vec![0xde00; 100])),
        ],
    };
    let result = store.bound(surrogate, Some(&configuration)).await.unwrap();
    assert!(
        fs::read_to_string(&result.output_paths[0])
            .unwrap()
            .starts_with("😀")
    );
    let old = roots.data.join("tool-output/tool_old");
    fs::write(&old, "old").unwrap();
    fs::File::open(&old)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(8 * 86400))
        .unwrap();
    let untouched = roots.data.join("tool-output/unmanaged");
    fs::write(&untouched, "keep").unwrap();
    fs::File::open(&untouched)
        .unwrap()
        .set_modified(SystemTime::UNIX_EPOCH)
        .unwrap();
    store.cleanup(SystemTime::now()).await.unwrap();
    assert!(!old.exists());
    assert_eq!(fs::read_to_string(untouched).unwrap(), "keep");
    assert!(result.output_paths[0].exists());
}

#[tokio::test]
async fn write_failure_is_reported_without_fabricated_output_path() {
    let fixture = Fixture::new();
    let roots = Roots::development(&fixture.0).unwrap();
    fs::create_dir_all(&roots.data).unwrap();
    fs::write(roots.data.join("tool-output"), "not a directory").unwrap();
    let result = Store::new(&roots)
        .bound(
            ToolOutput {
                structured: JsonValue::Null,
                content: vec![text("x".repeat(51201))],
            },
            None,
        )
        .await;
    assert!(result.is_err());
}
