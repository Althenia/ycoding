use prost::Message;
use ycoding_protocol::{WireError, decode_lossless, decode_strict, encode_lossless, v5};

fn hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

#[test]
fn typescript_browser_fences_preserve_safe_uint64_and_lone_units() {
    let bytes = hex("08ffffffffffffff0f1204120200d81a030a0163");
    let mut value = v5::BrowserOpenRequestPayload {
        generation: 9007199254740991,
        url: encode_lossless(&[0xd800]),
        call_id: encode_lossless(&[99]),
    };
    assert_eq!(value.encode_to_vec(), bytes);
    let decoded = decode_strict::<v5::BrowserOpenRequestPayload>(&bytes).unwrap();
    assert_eq!(decoded.generation, 9007199254740991);
    assert_eq!(decode_lossless(&decoded.url, 1).unwrap(), [0xd800]);
    assert_eq!(decoded.encode_to_vec(), bytes);
    value.generation = 9007199254740992;
    assert_eq!(
        decode_strict::<v5::BrowserOpenRequestPayload>(&value.encode_to_vec()).unwrap_err(),
        WireError("integer constraint")
    );
}

#[test]
fn typescript_pty_input_preserves_optional_empty_collections() {
    let bytes = hex("0a070a057365735f781a003200");
    let value = v5::PtyCreateRequestPayload {
        session_id: encode_lossless(&"ses_x".encode_utf16().collect::<Vec<_>>()),
        args: Some(v5::PtyCreateRequestPayloadArgs { items: vec![] }),
        env: Some(v5::PtyCreateRequestPayloadEnv { entries: vec![] }),
        ..Default::default()
    };
    assert_eq!(value.encode_to_vec(), bytes);
    let decoded = decode_strict::<v5::PtyCreateRequestPayload>(&bytes).unwrap();
    assert!(decoded.args.as_ref().unwrap().items.is_empty());
    assert!(decoded.env.as_ref().unwrap().entries.is_empty());
    assert!(decoded.command.is_none());
    assert_eq!(decoded.encode_to_vec(), bytes);
    assert_eq!(
        decode_strict::<v5::PtyCreateRequestPayload>(&[]).unwrap_err(),
        WireError("required presence")
    );
}

#[test]
fn browser_action_result_has_no_input_transport_field() {
    let text = |value: &str| encode_lossless(&value.encode_utf16().collect::<Vec<_>>());
    let result = v5::BrowserActionResult {
        call_id: text("call_contract"),
        tab: v5::BrowserTab {
            id: text("btab_contract"),
            session_id: text("ses_contract"),
            title: text("Fixture"),
            page: v5::BrowserPage {
                origin: text("https://example.test"),
                path: text("/"),
            },
            status: 1,
            generation: 1,
            document_generation: 2,
            observation_revision: 3,
            ..Default::default()
        },
        status: 1,
        message: None,
        capture: None,
        group_id: Some(0),
    };
    let mut bytes = result.encode_to_vec();
    assert_eq!(
        decode_strict::<v5::BrowserActionResult>(&bytes).unwrap(),
        result
    );
    bytes.extend_from_slice(&[0x38, 1]);
    assert_eq!(
        decode_strict::<v5::BrowserActionResult>(&bytes).unwrap_err(),
        WireError("unknown field")
    );
}

#[test]
fn typescript_shell_metadata_preserves_lone_keys_and_fractional_values() {
    let bytes = hex("0a110a04120200d8120919000000000000e0bf");
    let value = v5::ShellInfoMetadata {
        entries: vec![v5::ShellInfoMetadataEntry {
            key: encode_lossless(&[0xd800]),
            value: v5::Value {
                kind: Some(v5::value::Kind::Number(-0.5)),
            },
        }],
    };
    assert_eq!(value.encode_to_vec(), bytes);
    let decoded = decode_strict::<v5::ShellInfoMetadata>(&bytes).unwrap();
    assert_eq!(
        decode_lossless(&decoded.entries[0].key, 1).unwrap(),
        [0xd800]
    );
    assert_eq!(
        decoded.entries[0].value.kind,
        Some(v5::value::Kind::Number(-0.5))
    );
    assert_eq!(decoded.encode_to_vec(), bytes);
}

#[test]
fn typescript_errors_preserve_closed_tags_and_empty_message_presence() {
    let bytes = hex("080112020a00");
    let value = v5::ForbiddenError {
        tag: 1,
        message: encode_lossless(&[]),
    };
    assert_eq!(value.encode_to_vec(), bytes);
    assert_eq!(
        decode_strict::<v5::ForbiddenError>(&bytes)
            .unwrap()
            .encode_to_vec(),
        bytes
    );
    assert_eq!(
        decode_strict::<v5::ForbiddenError>(&[8, 99, 18, 2, 10, 0]).unwrap_err(),
        WireError("enum")
    );
}

#[test]
fn typescript_asset_metadata_and_pty_bounds_preserve_byte_counts() {
    let bytes = hex("0a020a001000");
    let value = v5::PlatformAssetMetadata {
        mime: encode_lossless(&[]),
        byte_count: 0,
    };
    assert_eq!(value.encode_to_vec(), bytes);
    assert_eq!(
        decode_strict::<v5::PlatformAssetMetadata>(&bytes)
            .unwrap()
            .encode_to_vec(),
        bytes
    );
    let size = hex("08c80110f403");
    assert_eq!(
        v5::PtySize {
            rows: 200,
            cols: 500
        }
        .encode_to_vec(),
        size
    );
    assert_eq!(
        decode_strict::<v5::PtySize>(&size).unwrap().encode_to_vec(),
        size
    );
    assert_eq!(
        decode_strict::<v5::PtySize>(
            &v5::PtySize {
                rows: 201,
                cols: 500
            }
            .encode_to_vec()
        )
        .unwrap_err(),
        WireError("integer constraint")
    );
}
