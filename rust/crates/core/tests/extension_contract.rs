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
        "SessionCreate",
        "SessionGenerate",
        "SessionCommand",
        "SessionSynthetic",
    ] {
        assert!(
            source.contains(&format!("message {message} {{")),
            "{message}"
        );
    }
}

#[test]
fn session_host_call_additions_use_the_next_tags_and_generated_strict_rules() {
    use prost::Message;
    use ycoding_core::extension::{v5, wire};
    let call = v5::Call {
        invocation: 1,
        session_id: "ses_one".into(),
        message_id: "msg_one".into(),
        call_id: wire::text(&"call_one".into()),
        agent: "test".into(),
    };
    let prefix = v5::HostCall {
        call: call.clone(),
        request: 1,
        operation: None,
    }
    .encode_to_vec();
    for (tag, operation) in [
        (
            10,
            v5::host_call::Operation::SessionCreate(v5::SessionCreate::default()),
        ),
        (
            11,
            v5::host_call::Operation::SessionGenerate(v5::SessionGenerate {
                session: "ses_one".into(),
                prompt: wire::text(&"Generate".into()),
            }),
        ),
        (
            12,
            v5::host_call::Operation::SessionCommand(v5::SessionCommand {
                session: "ses_one".into(),
                message: "msg_one".into(),
                command: wire::text(&"test".into()),
                arguments: wire::text(&"".into()),
                input: wire::value(&ycoding_schema::JsonValue::Null),
                agent: None,
                model: None,
                resume: Some(false),
            }),
        ),
        (
            13,
            v5::host_call::Operation::SessionSynthetic(v5::SessionSynthetic {
                session: "ses_one".into(),
                message: "msg_one".into(),
                input: wire::value(&ycoding_schema::JsonValue::Null),
                resume: Some(false),
            }),
        ),
    ] {
        let host = v5::HostCall {
            call: call.clone(),
            request: 1,
            operation: Some(operation),
        };
        let bytes = host.encode_to_vec();
        assert_eq!(&bytes[..prefix.len()], prefix.as_slice());
        assert_eq!(bytes[prefix.len()], (tag << 3) | 2);
        assert_eq!(
            wire::decode::<v5::HostCall>(&bytes, ".ycoding.extension.v5.HostCall").unwrap(),
            host
        );
    }
}
