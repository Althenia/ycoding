use std::path::Path;
use ycoding_core::resources::{config::Entry, mcp::configuration};
use ycoding_schema::{DomainDecode, mcp::ServerConfig, parse_json};

#[test]
fn ordered_documents_replace_servers_and_overlay_all_global_timeout_defaults() {
    let documents = [
        Entry::Document { path: None, info: parse_json(r#"{"mcp":{"timeout":{"startup":12,"catalog":25},"servers":{"a":{"type":"local","command":["bun","a"],"timeout":{"execution":50}},"b":{"type":"remote","url":"https://example.invalid","disabled":true}}}}"#).unwrap() },
        Entry::Directory("/irrelevant".into()),
        Entry::Document { path: None, info: parse_json(r#"{"mcp":{"timeout":{"startup":30,"execution":75},"servers":{"a":{"type":"local","command":["bun","replacement"],"timeout":{"catalog":9}},"c":{"type":"local","command":["bun","c"]}}}}"#).unwrap() },
    ];
    let definitions = configuration::from_entries(&documents).unwrap();
    assert_eq!(
        definitions
            .servers
            .iter()
            .map(|s| s.0.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["a", "b", "c"]
    );
    let ServerConfig::Local(a) = &definitions.servers[0].1 else {
        panic!()
    };
    assert_eq!(a.command[1], "replacement".into());
    let timeout = a.timeout.as_ref().unwrap();
    assert_eq!(timeout.startup.unwrap().get(), 30);
    assert_eq!(timeout.catalog.unwrap().get(), 9);
    assert_eq!(timeout.execution.unwrap().get(), 75);
    let ServerConfig::Remote(b) = &definitions.servers[1].1 else {
        panic!()
    };
    assert_eq!(b.disabled, Some(true));
    assert_eq!(b.timeout.as_ref().unwrap().execution.unwrap().get(), 75);
    let added = definitions.resolve(
        ServerConfig::decode(
            &parse_json(r#"{"type":"local","command":["bun"],"timeout":{"startup":1}}"#).unwrap(),
        )
        .unwrap(),
    );
    let ServerConfig::Local(added) = added else {
        panic!()
    };
    assert_eq!(added.timeout.unwrap().catalog.unwrap().get(), 25);
}

#[test]
fn local_working_directory_is_location_relative_not_config_relative() {
    assert_eq!(
        configuration::working_directory(Path::new("/location/a"), Some("../b")),
        Path::new("/location/b")
    );
    assert_eq!(
        configuration::working_directory(Path::new("/location"), Some("/absolute")),
        Path::new("/absolute")
    );
    assert_eq!(
        configuration::working_directory(Path::new("/location"), None),
        Path::new("/location")
    );
}
