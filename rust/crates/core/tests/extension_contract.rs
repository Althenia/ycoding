#[test]
fn extension_channel_is_core_owned_and_separate_from_application_wire() {
    let source = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../protocol/ycoding/extension/v5/extension.proto"
    ))
    .expect("Core must own a canonical extension channel descriptor");
    assert!(source.contains("package ycoding.extension.v5;"));
    assert!(!source.contains("import "));
    for message in [
        "HostFrame",
        "ChildFrame",
        "Hello",
        "Ready",
        "RegisterTools",
        "Execute",
        "Result",
        "Progress",
        "Cancel",
        "Cleanup",
        "Shutdown",
        "Diagnostic",
    ] {
        assert!(
            source.contains(&format!("message {message} {{")),
            "{message}"
        );
    }
}
