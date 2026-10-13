use ycoding_ai::cursor::{framing, protobuf, request, wire};
use ycoding_schema::{JsonValue, parse_json, stringify_json};

fn bytes(text: &str) -> Vec<u8> {
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn fixture(name: &str) -> Vec<u8> {
    let fixtures: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/cursor/wire.json")).unwrap();
    bytes(fixtures[name].as_str().unwrap())
}

fn input() -> request::RunRequest {
    request::RunRequest::new("conv", "msg", "composer-fixture", "Hello")
}

#[test]
fn cursor_protobuf_value_matches_committed_javascript_bytes() {
    for (json, hex) in [
        ("null", "0800"),
        ("1.5", "11000000000000f83f"),
        ("true", "2001"),
        ("\"Hi\"", "1a024869"),
        ("[false,null]", "32080a0220000a020800"),
        (
            "{\"z\":1,\"a\":\"x\"}",
            "2a1a0a080a016112031a01780a0e0a017a120911000000000000f03f",
        ),
        (
            "{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"string\"}},\"required\":[\"x\"]}",
            "2a540a2b0a0a70726f70657274696573121d2a1b0a190a017812142a120a100a047479706512081a06737472696e670a130a087265717569726564120732050a031a01780a100a047479706512081a066f626a656374",
        ),
    ] {
        let value = parse_json(json).unwrap();
        assert_eq!(protobuf::encode_value(&value).unwrap(), bytes(hex));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&stringify_json(
                &protobuf::decode_value(&bytes(hex)).unwrap()
            ))
            .unwrap(),
            serde_json::from_str::<serde_json::Value>(json).unwrap()
        );
    }
    let surrogate = parse_json("{\"\\ud800\":\"\\ud800\"}").unwrap();
    assert_eq!(
        protobuf::decode_value(&protobuf::encode_value(&surrogate).unwrap()).unwrap(),
        parse_json("{\"�\":\"�\"}").unwrap()
    );
}

#[test]
fn cursor_value_text_decoder_strips_bom_but_message_strings_do_not() {
    assert_eq!(
        protobuf::decode_value(&bytes("1a06efbbbf616263")).unwrap(),
        JsonValue::String("abc".into())
    );
    assert_eq!(
        protobuf::decode_value(&bytes("2a0e0a0c0a06efbbbf61626312020800")).unwrap(),
        parse_json("{\"abc\":null}").unwrap()
    );
    let raw = bytes("0a06efbbbf616263");
    assert_eq!(
        protobuf::fields(&raw).unwrap()[0].text().unwrap(),
        "\u{feff}abc"
    );
    let mut message = Vec::new();
    protobuf::write_string(
        &mut message,
        1,
        &ycoding_schema::LosslessString::from_utf16(vec![0xd800]),
    )
    .unwrap();
    assert_eq!(message, bytes("0a03eda080"));
}

#[test]
fn cursor_strict_wire_reader_rejects_partial_and_overflow_messages() {
    for hex in [
        "00",
        "08",
        "0880",
        "08ffffffffffffffffff02",
        "8080808010",
        "0affffffff10",
        "0a02ff",
        "090000",
        "0d0000",
        "0b",
        "0c",
        "0e",
        "0f",
        "0a0180ff",
    ] {
        assert!(protobuf::fields(&bytes(hex)).is_err(), "{hex}");
    }
    let full = bytes("08ffffffffffffffffff0109000000000000f03f0d010203040a00");
    let fields = protobuf::fields(&full).unwrap();
    assert_eq!(fields[0].varint().unwrap(), u64::MAX);
    assert_eq!(fields[1].wire_type(), 1);
    assert_eq!(fields[2].wire_type(), 5);
    assert!(fields[3].bytes().unwrap().is_empty());
    assert!(protobuf::fields(&[]).unwrap().is_empty());
}

#[test]
fn cursor_connect_framing_preserves_flags_and_every_fragment_boundary() {
    let raw = bytes("000000000308960102000000027b7d");
    assert_eq!(framing::encode(0, &[8, 150, 1]).unwrap(), raw[..8]);
    for split in 0..=raw.len() {
        let mut decoder = framing::Decoder::default();
        let mut frames = decoder.push(&raw[..split]);
        frames.extend(decoder.push(&raw[split..]));
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].payload, [8, 150, 1]);
        assert_eq!(frames[1].flags, framing::END_STREAM);
        assert_eq!(frames[1].payload, b"{}");
        assert!(decoder.finish().is_ok());
    }
    let mut decoder = framing::Decoder::default();
    assert!(decoder.push(&raw[..7]).is_empty());
    assert!(decoder.finish().is_err());
    assert_eq!(framing::encode(0, &[]).unwrap(), [0, 0, 0, 0, 0]);
}

#[test]
fn cursor_gzip_frames_roundtrip_and_reject_corruption() {
    let encoded = framing::encode(framing::GZIP, b"Hello").unwrap();
    let mut decoder = framing::Decoder::default();
    let frame = decoder.push(&encoded).pop().unwrap();
    assert_eq!(frame.decode().unwrap(), b"Hello");
    assert!(
        framing::Frame {
            flags: 1,
            payload: vec![1, 2, 3]
        }
        .decode()
        .is_err()
    );
}

#[test]
fn cursor_gunzip_matches_node_for_concatenated_members() {
    let first = framing::encode(framing::GZIP, b"Hello").unwrap();
    let second = framing::encode(framing::GZIP, b" world").unwrap();
    let frame = framing::Frame {
        flags: framing::GZIP,
        payload: [first[5..].to_vec(), second[5..].to_vec()].concat(),
    };
    assert_eq!(frame.decode().unwrap(), b"Hello world");
}

#[test]
fn cursor_gzip_matches_node_header_deflate_and_zero_padding() {
    let mut expected = bytes("01000000191f8b0800000000000013f348cdc9c907008289d1f705000000");
    if !cfg!(target_os = "macos") {
        expected[14] = if cfg!(windows) { 0 } else { 3 };
    }
    assert_eq!(framing::encode(framing::GZIP, b"Hello").unwrap(), expected);
    for tail in [&[0][..], &[0, 0, 0], &[0, 1, 2, 3]] {
        let frame = framing::Frame {
            flags: framing::GZIP,
            payload: [expected[5..].to_vec(), tail.to_vec()].concat(),
        };
        assert_eq!(frame.decode().unwrap(), b"Hello");
    }
}

#[test]
fn cursor_run_seed_variants_and_resume_match_javascript_bytes() {
    assert_eq!(request::heartbeat(), fixture("heartbeat"));
    assert_eq!(input().encode().unwrap(), fixture("minimal"));
    let history = vec![
        request::History::new("system", "Ignored"),
        request::History::new("user", "Before"),
        request::History::new("assistant", "Done"),
        request::History::new("user", ""),
    ];
    assert_eq!(
        request::seed(Some(&"Rules".into()), &history).unwrap(),
        fixture("seed")
    );
    let mut variant = input();
    variant.system_prompt = Some("Rules".into());
    variant.group_id = Some("group".into());
    variant.max_mode = true;
    variant.parameters = vec![
        ("effort".into(), "high".into()),
        ("fast".into(), "true".into()),
    ];
    let tool = request::Descriptor {
        name: "opencode-read".into(),
        description: "Read".into(),
        input_schema: parse_json(
            "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}}",
        )
        .unwrap(),
        provider: "opencode".into(),
        tool_name: "read".into(),
    };
    variant.descriptors = vec![tool.clone()];
    let mut context = Vec::new();
    protobuf::write_bytes(&mut context, 7, &tool.encode().unwrap()).unwrap();
    protobuf::write_varint(&mut context, 17, 0).unwrap();
    protobuf::write_varint(&mut context, 24, 0).unwrap();
    variant.request_context = Some(context);
    assert_eq!(variant.encode().unwrap(), fixture("variant"));
    let mut resume = input();
    resume.action = request::Action::Resume;
    resume.checkpoint = Some(bytes("0a03ff0080"));
    assert_eq!(resume.encode().unwrap(), fixture("resume"));
}

#[test]
fn cursor_selected_image_and_checkpoint_echo_preserve_wire_bytes() {
    let mut image = input();
    image.text = "Look".into();
    image.images = vec![request::Image {
        uuid: "image-id".into(),
        filename: Some("a.png".into()),
        mime_type: "image/png".into(),
        data: vec![0, 1, 255],
    }];
    assert_eq!(image.encode().unwrap(), fixture("image"));
    let wire::ServerMessage::Checkpoint(checkpoint) = wire::decode(&fixture("checkpoint")).unwrap()
    else {
        panic!("checkpoint expected");
    };
    assert_eq!(checkpoint, bytes("0a03ff0080"));
    image.checkpoint = Some(checkpoint.clone());
    let encoded = image.encode().unwrap();
    let outer = protobuf::fields(&encoded).unwrap();
    let run = protobuf::fields(outer[0].bytes().unwrap()).unwrap();
    assert_eq!(run[0].bytes().unwrap(), checkpoint);
}

#[test]
fn cursor_mcp_exec_decode_and_correlated_replies_match_javascript_bytes() {
    let wire::ServerMessage::Exec(exec) = wire::decode(&fixture("mcp")).unwrap() else {
        panic!("exec expected");
    };
    assert_eq!(exec.id, 7);
    assert_eq!(exec.exec_id.as_deref(), Some("exec"));
    let mcp = exec.mcp().unwrap().unwrap();
    assert_eq!(mcp.call_id, "call");
    assert_eq!(mcp.tool_name.as_deref(), Some("read"));
    assert_eq!(mcp.input, parse_json("{\"path\":\"a.ts\"}").unwrap());
    assert_eq!(
        exec.mcp_result(Ok("Read a.ts"), 0).unwrap(),
        fixture("mcpResult")
    );
    assert_eq!(
        exec.mcp_result(Err("Denied"), 0).unwrap(),
        fixture("mcpError")
    );
    assert_eq!(exec.close().unwrap(), fixture("close"));
    assert_eq!(protobuf::decode_value(&[]).unwrap(), JsonValue::Null);
}
