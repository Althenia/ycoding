use std::path::Path;
use ycoding_core::resources::skill;
use ycoding_core::session::skill::path_triggered;
use ycoding_schema::{DomainDecode, JsonValue, parse_json};

#[test]
fn malformed_event_identifiers_cannot_enable_automatic_activation() {
    for events in [
        "command.invoked path.selected",
        "command.invoked,,path.selected",
    ] {
        let data = parse_json(&format!(
            r#"{{"name":"test","description":"d","metadata":{{"activation":"auto","events":"{events}"}}}}"#
        ))
        .unwrap();
        let info =
            skill::from_frontmatter(Path::new("/fixture/skills/test/SKILL.md"), &data, "body")
                .unwrap();
        assert_eq!(info.autoinvoke, Some(false), "{events}");
    }
}

#[test]
fn path_cues_match_only_valid_workspace_relative_globs() {
    let metadata = ycoding_schema::JsonObject::decode(
        &parse_json(
            r#"{"version":"1","activation":"auto","paths":"rust/**/*.rs, rust/**/Cargo.toml"}"#,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(path_triggered(&metadata, "rust/crates/core/src/lib.rs"));
    assert!(path_triggered(&metadata, "rust/Cargo.toml"));
    assert!(!path_triggered(
        &metadata,
        "rust/crates/core/src/lib.rs.bak"
    ));
    assert!(!path_triggered(&metadata, "../rust/Cargo.toml"));
    let invalid = ycoding_schema::JsonObject::decode(
        &parse_json(r#"{"version":"1","activation":"auto","paths":"../outside/**"}"#).unwrap(),
    )
    .unwrap();
    assert!(!path_triggered(&invalid, "outside/a"));
}

#[test]
fn malformed_known_metadata_disables_every_cue() {
    for extra in [
        r#""version":[]"#,
        r#""version":"  ""#,
        r#""paths":"../outside/**""#,
        r#""paths":"/absolute/**""#,
    ] {
        let metadata = ycoding_schema::JsonObject::decode(&parse_json(&format!(r#"{{"activation":"auto","events":"command.invoked","commands":"cargo check",{extra}}}"#)).unwrap()).unwrap();
        assert!(!ycoding_core::session::skill::triggered(
            &metadata,
            "command.invoked",
            Some(&["cargo".into(), "check".into()])
        ));
        assert!(!path_triggered(&metadata, "rust/src/lib.rs"));
    }
}

#[test]
fn trusted_event_and_command_cues_match_exact_boundaries() {
    let JsonValue::Object(event) =
        parse_json(r#"{"activation":"auto","events":"command.invoked"}"#).unwrap()
    else {
        panic!()
    };
    let JsonValue::Object(command) =
        parse_json(r#"{"activation":"auto","commands":"cargo check"}"#).unwrap()
    else {
        panic!()
    };
    let JsonValue::Object(manual) =
        parse_json(r#"{"activation":"manual","events":"command.invoked"}"#).unwrap()
    else {
        panic!()
    };
    let JsonValue::Object(invalid) =
        parse_json(r#"{"activation":"auto","events":["command.invoked"]}"#).unwrap()
    else {
        panic!()
    };
    let check = vec!["cargo".into(), "check".into(), "--workspace".into()];
    let near = vec!["cargo".into(), "checker".into()];
    assert!(ycoding_core::session::skill::triggered(
        &event,
        "command.invoked",
        None
    ));
    assert!(!ycoding_core::session::skill::triggered(
        &event,
        "\"command.invoked\"",
        None
    ));
    assert!(ycoding_core::session::skill::triggered(
        &command,
        "command.invoked",
        Some(&check)
    ));
    assert!(!ycoding_core::session::skill::triggered(
        &command,
        "command.invoked",
        Some(&near)
    ));
    assert!(!ycoding_core::session::skill::triggered(
        &manual,
        "command.invoked",
        None
    ));
    assert!(!ycoding_core::session::skill::triggered(
        &invalid,
        "command.invoked",
        None
    ));
}

#[tokio::test]
async fn catalog_discards_superseded_metadata_when_embedded_source_wins() {
    use std::fs;
    use ycoding_schema::{
        DomainDecode,
        skill::{DirectorySource, EmbeddedSource, Info, Source},
    };
    let root =
        std::env::temp_dir().join(format!("ycoding-activation-catalog-{}", std::process::id()));
    fs::create_dir_all(root.join("sample")).unwrap();
    fs::write(
        root.join("sample/SKILL.md"),
        "---\nname: sample\ndescription: sample skill\nmetadata: {activation: auto, events: command.invoked}\n---\nbody",
    )
    .unwrap();
    let mut service = skill::Service::new(&root);
    service.source(Source::Directory(DirectorySource {
        path: ycoding_core::resources::discovery::absolute_path(&root).unwrap(),
    }));
    let first = service.list().await.unwrap();
    assert!(service.activation_metadata(&first[0]).is_some());
    let embedded = Info::decode(&parse_json(r#"{"id":"sample","name":"sample","location":"/embedded/sample/SKILL.md","content":"embedded"}"#).unwrap()).unwrap();
    service.source(Source::Embedded(EmbeddedSource { skill: embedded }));
    let last = service.list().await.unwrap();
    assert_eq!(last.len(), 1);
    assert!(service.activation_metadata(&last[0]).is_none());
    assert!(service.activation_metadata(&first[0]).is_none());
    fs::remove_dir_all(root).unwrap();
}
