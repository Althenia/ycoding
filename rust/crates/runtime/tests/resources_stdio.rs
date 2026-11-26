use std::{
    io::Write,
    process::{Command, Stdio},
};
use ycoding_core::ycoding_schema::{JsonValue, parse_json, stringify_json};

fn invoke(input: JsonValue) -> JsonValue {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ycoding-runtime"))
        .arg("--ycoding-internal-resources-v1")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stringify_json(&input).as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    parse_json(std::str::from_utf8(&output.stdout).unwrap()).unwrap()
}

#[test]
fn resources_stdio_preserves_embedded_skills_and_rejects_url_and_write_requests() {
    let location = if cfg!(windows) {
        "C:/embedded/SKILL.md"
    } else {
        "/embedded/SKILL.md"
    };
    let skill = parse_json(&format!(r#"{{"id":"guide","name":"Guide","location":"{location}","content":"Loaded without a skill file."}}"#)).unwrap();
    let result = invoke(
        parse_json(&format!(
            r#"{{"operation":"skill","sources":[{{"type":"embedded","skill":{}}}]}}"#,
            stringify_json(&skill)
        ))
        .unwrap(),
    );
    assert_eq!(
        result,
        parse_json(&format!(
            r#"{{"ok":true,"value":[{}]}}"#,
            stringify_json(&skill)
        ))
        .unwrap()
    );
    for rejected in [
        r#"{"operation":"skill","sources":[{"type":"url","url":"https://example.invalid/skills"}]}"#,
        r#"{"operation":"memory","action":"write"}"#,
    ] {
        assert_eq!(
            invoke(parse_json(rejected).unwrap()),
            parse_json(r#"{"ok":false,"code":"InvalidConcept"}"#).unwrap()
        );
    }
}

#[test]
fn resources_stdio_checks_approved_root_before_opening_content() {
    let dir = std::env::current_dir().unwrap().canonicalize().unwrap();
    let data = dir.join("uncreated-stdio-test-memory-root");
    let root = data.join("memory/knowledge");
    let path_json =
        |path: &std::path::Path| stringify_json(&JsonValue::String(path.to_str().unwrap().into()));
    let request = |approved_root| {
        parse_json(&format!(
        r#"{{"operation":"memory","action":"list","scope":"knowledge","approvedRoot":{},"directory":{},"data":{},"home":{},"limits":{{"enabled":true,"max_concept_bytes":65536,"max_bundle_bytes":8388608,"max_concepts":1000}}}}"#,
        path_json(approved_root), path_json(&dir), path_json(&data), path_json(&dir),
    )).unwrap()
    };
    assert!(!data.exists());
    assert_eq!(
        invoke(request(&dir)),
        parse_json(r#"{"ok":false,"code":"UnsafePath"}"#).unwrap()
    );
    assert_eq!(
        invoke(request(&root)),
        parse_json(r#"{"ok":true,"value":{"concepts":[],"total":0,"warnings":[]}}"#).unwrap()
    );
    assert!(!data.exists());
}
