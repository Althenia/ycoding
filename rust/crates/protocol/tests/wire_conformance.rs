use prost::Message;
use std::{fs, path::PathBuf};
use ycoding_protocol::{
    CONTRACT_DIGEST, WireConnection, decode_lossless, decode_strict, encode_lossless, limits, v5,
    validate_binary,
};
#[path = "../src/contract_hash.rs"]
mod contract_hash;

#[test]
fn contract_hash_matches_standard_vectors() {
    for (input, expected) in [
        (
            "",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ),
        (
            "abc",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        ),
        (
            "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        ),
    ] {
        assert_eq!(
            contract_hash::sha256(input.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            expected
        );
    }
}

fn bounded<T: Message + Default + prost::Name>(count: usize, limit: usize, value: T) {
    assert_eq!(
        decode_strict::<T>(&value.encode_to_vec()).is_ok(),
        count <= limit,
        "{} count {count}",
        T::full_name()
    );
}

#[test]
fn canonical_control_collection_limits() {
    for count in [500, 501] {
        let ids: Vec<_> = (0..count).map(|index| format!("s{index}")).collect();
        bounded(
            count,
            500,
            v5::Status {
                running: ids.clone(),
                ..Default::default()
            },
        );
        bounded(
            count,
            500,
            v5::Status {
                attention: ids.clone(),
                ..Default::default()
            },
        );
        bounded(
            count,
            500,
            v5::Status {
                outstanding: Some(v5::IdentifierList { items: ids.clone() }),
                ..Default::default()
            },
        );
        bounded(
            count,
            500,
            v5::Status {
                failed: Some(v5::IdentifierList { items: ids.clone() }),
                ..Default::default()
            },
        );
        bounded(
            count,
            500,
            v5::Status {
                details: Some(v5::AttentionList {
                    items: ids
                        .iter()
                        .map(|id| v5::AttentionDetail {
                            session_id: id.clone(),
                            ..Default::default()
                        })
                        .collect(),
                }),
                ..Default::default()
            },
        );
    }
    for count in [200, 201] {
        bounded(
            count,
            200,
            v5::Completions {
                items: (0..count)
                    .map(|index| v5::Completion {
                        id: format!("e{index}"),
                        sequence: 1,
                        created_ms: 0,
                        session_id: format!("s{index}"),
                        title: None,
                    })
                    .collect(),
                more: false,
            },
        );
    }
    for count in [64, 65] {
        bounded(
            count,
            64,
            v5::SubscriptionSnapshot {
                client_id: "c".into(),
                session_ids: (0..count).map(|index| format!("s{index}")).collect(),
            },
        );
    }
    for count in [100, 101] {
        bounded(
            count,
            100,
            v5::NoticesAdded {
                notices: (0..count)
                    .map(|index| v5::NoticeRecord {
                        id: format!("n{index}"),
                        category: 1,
                        session_id: "s".into(),
                        created_ms: 0,
                    })
                    .collect(),
                total: count as u64,
            },
        );
        bounded(
            count,
            100,
            v5::NoticesRemoved {
                ids: (0..count).map(|index| format!("n{index}")).collect(),
                total: count as u64,
            },
        );
        bounded(
            count,
            100,
            v5::NoticesPresent {
                items: (0..count)
                    .map(|_| v5::Presentation {
                        kind: Some(v5::presentation::Kind::Offline(v5::Offline { at_ms: 1 })),
                    })
                    .collect(),
            },
        );
    }
}

#[test]
fn title_codepoints_lossless_whitespace_controls_and_bidi() {
    for text in [
        "😀".repeat(120),
        "title".into(),
        "inside\u{feff}value".into(),
    ] {
        let value = v5::Blocked {
            session_id: "s".into(),
            title: Some(encode_lossless(&text.encode_utf16().collect::<Vec<_>>())),
        };
        assert!(decode_strict::<v5::Blocked>(&value.encode_to_vec()).is_ok());
    }
    for count in [120, 121] {
        let value = v5::Blocked {
            session_id: "s".into(),
            title: Some(encode_lossless(&vec![0xd800; count])),
        };
        assert_eq!(
            decode_strict::<v5::Blocked>(&value.encode_to_vec()).is_ok(),
            count <= 120
        );
    }
    for text in [
        "😀".repeat(121),
        "".into(),
        " title".into(),
        "title ".into(),
        "\u{feff}title".into(),
        "title\u{feff}".into(),
        "a\0b".into(),
        "a\u{85}b".into(),
        "a\u{202e}b".into(),
        "a\u{2067}b".into(),
    ] {
        let value = v5::Blocked {
            session_id: "s".into(),
            title: Some(encode_lossless(&text.encode_utf16().collect::<Vec<_>>())),
        };
        assert!(
            decode_strict::<v5::Blocked>(&value.encode_to_vec()).is_err(),
            "{text:?}"
        );
    }
    let title = Some(encode_lossless(&[0x20]));
    assert!(
        decode_strict::<v5::AttentionDetail>(
            &v5::AttentionDetail {
                session_id: "s".into(),
                title: title.clone(),
                need: None
            }
            .encode_to_vec()
        )
        .is_err()
    );
    assert!(
        decode_strict::<v5::AlertDetail>(
            &v5::AlertDetail {
                title: title.clone(),
                ..Default::default()
            }
            .encode_to_vec()
        )
        .is_err()
    );
    assert!(
        decode_strict::<v5::Completion>(
            &v5::Completion {
                title,
                ..Default::default()
            }
            .encode_to_vec()
        )
        .is_err()
    );
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../protocol/ycoding/v5/testdata")
}
fn vector(name: &str) -> Vec<u8> {
    let manifest = fs::read_to_string(fixtures().join("manifest.tsv")).unwrap();
    let hex = manifest
        .lines()
        .map(|line| line.split('\t').collect::<Vec<_>>())
        .find(|row| row[0] == name)
        .unwrap()[4];
    assert_eq!(hex.len() % 2, 0);
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect()
}
fn frame(name: &str) -> v5::Frame {
    decode_strict(&vector(name)).unwrap()
}
fn reencode<T: Message + Default + prost::Name>(bytes: &[u8]) -> Vec<u8> {
    decode_strict::<T>(bytes).unwrap().encode_to_vec()
}

#[test]
fn independent_golden_and_negative_vectors() {
    let manifest = fs::read_to_string(fixtures().join("manifest.tsv")).unwrap();
    let mut counts = (0, 0);
    for line in manifest.lines() {
        let row: Vec<_> = line.split('\t').collect();
        let bytes = vector(row[0]);
        if row[2] == "invalid" {
            if row[3] != "0" {
                let role = v5::PeerRole::try_from(row[3].parse::<i32>().unwrap()).unwrap();
                assert!(
                    WireConnection::default().observe(&bytes, role, 0).is_err(),
                    "{}",
                    row[0]
                );
            } else {
                assert!(validate_binary(row[1], &bytes).is_err(), "{}", row[0]);
            }
            counts.1 += 1;
            continue;
        }
        let encoded = match row[1] {
            "ycoding.v5.Frame" => reencode::<v5::Frame>(&bytes),
            "ycoding.v5.LosslessString" => reencode::<v5::LosslessString>(&bytes),
            "ycoding.v5.Value" => reencode::<v5::Value>(&bytes),
            "ycoding.v5.ClearableString" => reencode::<v5::ClearableString>(&bytes),
            "ycoding.v5.ClearableBool" => reencode::<v5::ClearableBool>(&bytes),
            "ycoding.v5.ClearableUint64" => reencode::<v5::ClearableUint64>(&bytes),
            "ycoding.v5.StringList" => reencode::<v5::StringList>(&bytes),
            "ycoding.v5.Scope" => reencode::<v5::Scope>(&bytes),
            "ycoding.v5.Credit" => reencode::<v5::Credit>(&bytes),
            "ycoding.v5.fs_read_Result" => reencode::<v5::FsReadResult>(&bytes),
            "ycoding.v5.OperationDescriptor" => reencode::<v5::OperationDescriptor>(&bytes),
            "ycoding.v5.PublicEvent" => reencode::<v5::PublicEvent>(&bytes),
            "ycoding.v5.session_attachment_upload_Request_payload" => {
                reencode::<v5::SessionAttachmentUploadRequestPayload>(&bytes)
            }
            name => panic!("unhandled golden type {name}"),
        };
        assert_eq!(encoded, bytes, "{}", row[0]);
        counts.0 += 1;
    }
    assert_eq!(counts, (53, 42));
}

#[test]
fn duplicate_singular_command_is_rejected() {
    assert!(validate_binary("ycoding.v5.LosslessString", &[10, 0, 10, 0]).is_err());
}

#[test]
fn unknown_command_field_is_rejected() {
    assert!(validate_binary("ycoding.v5.LosslessString", &[10, 0, 24, 1]).is_err());
}

#[test]
fn lossless_encoders_match_independent_goldens_and_preserve_units() {
    let cases: &[(&str, &[u16])] = &[
        ("empty-string", &[]),
        ("scalar-string", &[0x41, 0xfeff, 0xd83d, 0xde00]),
        ("lone-high", &[0xd800]),
        ("lone-low", &[0xdc00]),
        ("mixed-units", &[0x41, 0xfffe, 0xdbff, 0xdfff, 0xd800]),
    ];
    for (name, units) in cases {
        let value = encode_lossless(units);
        assert_eq!(value.encode_to_vec(), vector(name));
        assert_eq!(decode_lossless(&value, units.len()).unwrap(), *units);
    }
    assert!(decode_lossless(&encode_lossless(&[0xd83d, 0xde00]), 1).is_err());
    assert_eq!(
        decode_strict::<v5::ClearableUint64>(&vector("bigint"))
            .unwrap()
            .state,
        Some(v5::clearable_uint64::State::Value(u64::MAX))
    );
    let value = v5::Value {
        kind: Some(v5::value::Kind::Number(-0.0)),
    };
    let decoded = decode_strict::<v5::Value>(&value.encode_to_vec()).unwrap();
    match decoded.kind {
        Some(v5::value::Kind::Number(number)) => assert!(number.is_sign_negative()),
        _ => panic!("number"),
    }
}

fn connected(client: v5::PeerRole, server: v5::PeerRole) -> WireConnection {
    let mut connection = WireConnection::new(client, server).unwrap();
    let mut hello = frame("hello");
    if let Some(v5::frame::Body::Hello(body)) = &mut hello.body {
        body.role = client as i32;
    }
    let mut ready = frame("ready");
    if let Some(v5::frame::Body::Ready(body)) = &mut ready.body {
        body.role = server as i32;
    }
    connection
        .observe(&hello.encode_to_vec(), client, 0)
        .unwrap();
    connection
        .observe(&ready.encode_to_vec(), server, 1)
        .unwrap();
    connection.observe(&vector("ping"), client, 2).unwrap();
    connection
}

#[test]
fn epochs_direction_and_repeated_handshakes_reject_without_corrupting_state() {
    let mut connection = connected(v5::PeerRole::LocalClient, v5::PeerRole::Server);
    assert!(
        connection
            .observe(&vector("hello"), v5::PeerRole::LocalClient, 3)
            .is_err()
    );
    for (name, role) in [
        ("request", v5::PeerRole::LocalClient),
        ("result", v5::PeerRole::Server),
        ("error", v5::PeerRole::Server),
        ("events", v5::PeerRole::Server),
        ("bulk-start", v5::PeerRole::Server),
        ("bulk-piece", v5::PeerRole::Server),
        ("bulk-end", v5::PeerRole::Server),
        ("bulk-error", v5::PeerRole::Server),
        ("pong", v5::PeerRole::Server),
        ("cancel", v5::PeerRole::LocalClient),
        ("credit", v5::PeerRole::LocalClient),
        ("priority", v5::PeerRole::LocalClient),
        ("inventory_invalidated", v5::PeerRole::Server),
        ("status", v5::PeerRole::Server),
        ("completions", v5::PeerRole::Server),
        ("blocked", v5::PeerRole::Server),
        ("resync_required", v5::PeerRole::Server),
        ("failure", v5::PeerRole::Server),
    ] {
        assert_eq!(
            connection.observe(&vector(name), role, 3).unwrap().revision,
            5
        );
        let mut invalid = frame(name);
        invalid.connection_epoch = Some("stale".into());
        assert!(
            connection
                .observe(&invalid.encode_to_vec(), role, 4)
                .is_err(),
            "{name}"
        );
        invalid.connection_epoch = None;
        assert!(
            connection
                .observe(&invalid.encode_to_vec(), role, 4)
                .is_err(),
            "{name}"
        );
    }
    assert!(
        connection
            .observe(&vector("request"), v5::PeerRole::Server, 3)
            .is_err()
    );
    let mut remote = connected(v5::PeerRole::RemoteClient, v5::PeerRole::Relay);
    remote
        .observe(&vector("notice"), v5::PeerRole::Relay, 3)
        .unwrap();
    let mut agent = connected(v5::PeerRole::Agent, v5::PeerRole::Relay);
    agent
        .observe(&vector("subscription_snapshot"), v5::PeerRole::Relay, 3)
        .unwrap();
}

#[test]
fn handshake_identity_windows_and_timeout() {
    for change in 0..3 {
        let mut hello = frame("hello");
        if change == 0 {
            hello.revision = 6;
        }
        if let Some(v5::frame::Body::Hello(body)) = &mut hello.body {
            if change == 1 {
                body.contract_digest[0] ^= 1;
            }
            if change == 2 {
                body.receive_windows.normal_bytes += 1;
            }
        }
        assert!(
            WireConnection::default()
                .observe(&hello.encode_to_vec(), v5::PeerRole::LocalClient, 0)
                .is_err()
        );
    }
    let mut state = WireConnection::default();
    state
        .observe(&vector("hello"), v5::PeerRole::LocalClient, 0)
        .unwrap();
    assert!(
        state
            .observe(&vector("ready"), v5::PeerRole::Server, 5000)
            .is_err()
    );
    let mut state = WireConnection::default();
    state
        .observe(&vector("hello"), v5::PeerRole::LocalClient, 0)
        .unwrap();
    state
        .observe(&vector("ready"), v5::PeerRole::Server, 1)
        .unwrap();
    assert!(
        state
            .observe(&vector("ping"), v5::PeerRole::LocalClient, 5001)
            .is_err()
    );
    if let Some(v5::frame::Body::Hello(hello)) = frame("hello").body {
        assert_eq!(
            hello
                .contract_digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            CONTRACT_DIGEST
        );
    } else {
        panic!("Hello")
    }
}

#[test]
fn depth_64_decodes_depth_65_rejects_and_field_limit_is_exact() {
    let mut value = v5::Value {
        kind: Some(v5::value::Kind::Null(v5::Empty {})),
    };
    for _ in 1..64 {
        value = v5::Value {
            kind: Some(v5::value::Kind::List(v5::ValueList { items: vec![value] })),
        };
    }
    assert!(decode_strict::<v5::Value>(&value.encode_to_vec()).is_ok());
    value = v5::Value {
        kind: Some(v5::value::Kind::List(v5::ValueList { items: vec![value] })),
    };
    assert_eq!(
        decode_strict::<v5::Value>(&value.encode_to_vec())
            .unwrap_err()
            .0,
        "depth limit"
    );
    let list = v5::ValueList {
        items: vec![
            v5::Value {
                kind: Some(v5::value::Kind::Null(v5::Empty {}))
            };
            32768
        ],
    };
    assert!(decode_strict::<v5::ValueList>(&list.encode_to_vec()).is_ok());
    let mut nested = vec![];
    for _ in 0..201 {
        let mut bytes = vec![10];
        let mut length = nested.len();
        while length > 127 {
            bytes.push((length as u8 & 127) | 128);
            length >>= 7;
        }
        bytes.push(length as u8);
        bytes.extend(nested);
        nested = bytes;
    }
    assert_eq!(
        decode_strict::<v5::Empty>(&nested).unwrap_err().0,
        "unknown field"
    );
}

#[test]
fn byte_count_and_frame_budgets() {
    let mut connection = connected(v5::PeerRole::LocalClient, v5::PeerRole::Server);
    let mut request = frame("request");
    for size in [
        limits::INLINE_BODY_BYTES - 1,
        limits::INLINE_BODY_BYTES,
        limits::INLINE_BODY_BYTES + 1,
    ] {
        if let Some(v5::frame::Body::Request(body)) = &mut request.body {
            body.payload = vec![0; size as usize];
        }
        assert_eq!(
            connection
                .observe(&request.encode_to_vec(), v5::PeerRole::LocalClient, 3)
                .is_ok(),
            size <= limits::INLINE_BODY_BYTES
        );
    }
    let mut piece = frame("bulk-piece");
    for size in [
        limits::BULK_PIECE_BYTES - 1,
        limits::BULK_PIECE_BYTES,
        limits::BULK_PIECE_BYTES + 1,
    ] {
        if let Some(v5::frame::Body::BulkPiece(body)) = &mut piece.body {
            body.data = vec![0; size as usize];
        }
        assert_eq!(
            connection
                .observe(&piece.encode_to_vec(), v5::PeerRole::Server, 3)
                .is_ok(),
            size <= limits::BULK_PIECE_BYTES
        );
    }
    assert_eq!(
        connection
            .observe(
                &vec![0; limits::CLIENT_FRAME_BYTES as usize + 1],
                v5::PeerRole::LocalClient,
                3
            )
            .unwrap_err()
            .0,
        "frame byte limit"
    );
    assert_eq!(
        connection
            .observe(
                &vec![0; limits::SERVER_FRAME_BYTES as usize + 1],
                v5::PeerRole::Server,
                3
            )
            .unwrap_err()
            .0,
        "frame byte limit"
    );
    let mut events = frame("events");
    if let Some(v5::frame::Body::EventBatch(body)) = &mut events.body {
        body.events = vec![body.events[0].clone(); 64];
    }
    assert!(
        connection
            .observe(&events.encode_to_vec(), v5::PeerRole::Server, 3)
            .is_ok()
    );
    if let Some(v5::frame::Body::EventBatch(body)) = &mut events.body {
        body.events.push(body.events[0].clone());
    }
    assert!(
        connection
            .observe(&events.encode_to_vec(), v5::PeerRole::Server, 3)
            .is_err()
    );
}

#[test]
fn early_class_budgets_and_bulk_headers() {
    assert_eq!(
        WireConnection::default()
            .observe(
                &vec![0; limits::HANDSHAKE_BYTES as usize + 1],
                v5::PeerRole::LocalClient,
                0
            )
            .unwrap_err()
            .0,
        "handshake byte limit"
    );
    let mut connection = connected(v5::PeerRole::LocalClient, v5::PeerRole::Server);
    let mut tiny = frame("ping");
    tiny.connection_epoch = Some("x".repeat(limits::TINY_FRAME_BYTES as usize));
    assert_eq!(
        connection
            .observe(&tiny.encode_to_vec(), v5::PeerRole::LocalClient, 3)
            .unwrap_err()
            .0,
        "tiny byte limit"
    );
    let mut request = frame("request");
    request.ledger = None;
    assert!(
        connection
            .observe(&request.encode_to_vec(), v5::PeerRole::LocalClient, 3)
            .is_err()
    );
    request.ledger = Some(v5::LedgerClass::Normal as i32);
    request.delivery_ordinal = Some(0);
    assert!(
        connection
            .observe(&request.encode_to_vec(), v5::PeerRole::LocalClient, 3)
            .is_err()
    );
    let mut start = frame("bulk-start");
    if let Some(v5::frame::Body::BulkStart(body)) = &mut start.body {
        body.byte_count = limits::BULK_MESSAGE_BYTES;
        body.chunk_count = limits::BULK_PIECES as u32;
    }
    assert!(
        connection
            .observe(&start.encode_to_vec(), v5::PeerRole::Server, 3)
            .is_ok()
    );
    if let Some(v5::frame::Body::BulkStart(body)) = &mut start.body {
        body.byte_count += 1;
    }
    assert!(
        connection
            .observe(&start.encode_to_vec(), v5::PeerRole::Server, 3)
            .is_err()
    );
    if let Some(v5::frame::Body::BulkStart(body)) = &mut start.body {
        body.byte_count -= 1;
        body.chunk_count += 1;
    }
    assert!(
        connection
            .observe(&start.encode_to_vec(), v5::PeerRole::Server, 3)
            .is_err()
    );
    let mut end = frame("bulk-end");
    if let Some(v5::frame::Body::BulkEnd(body)) = &mut end.body {
        body.byte_count = limits::BULK_MESSAGE_BYTES + 1;
    }
    assert!(
        connection
            .observe(&end.encode_to_vec(), v5::PeerRole::Server, 3)
            .is_err()
    );
    for size in [
        limits::EVENT_BATCH_BYTES - 1,
        limits::EVENT_BATCH_BYTES,
        limits::EVENT_BATCH_BYTES + 1,
    ] {
        let mut event = frame("events");
        if let Some(v5::frame::Body::EventBatch(body)) = &mut event.body {
            body.events[0].event.payload = vec![0; size as usize - 128];
        }
        let length = event.encoded_len();
        if let Some(v5::frame::Body::EventBatch(body)) = &mut event.body {
            let payload = &mut body.events[0].event.payload;
            payload.resize(payload.len() + size as usize - length, 0);
        }
        let bytes = event.encode_to_vec();
        assert_eq!(bytes.len(), size as usize);
        assert_eq!(
            connection.observe(&bytes, v5::PeerRole::Server, 3).is_ok(),
            size <= limits::EVENT_BATCH_BYTES
        );
    }
}

#[test]
fn test_024_version_digest_role_epoch_and_deadline_matrix() {
    for revision in [4, 6] {
        let mut hello = frame("hello");
        hello.revision = revision;
        assert!(
            WireConnection::default()
                .observe(&hello.encode_to_vec(), v5::PeerRole::LocalClient, 0)
                .is_err(),
            "revision {revision}"
        );
    }
    let mut hello = frame("hello");
    if let Some(v5::frame::Body::Hello(body)) = &mut hello.body {
        body.contract_digest[0] ^= 1;
    }
    assert!(
        WireConnection::default()
            .observe(&hello.encode_to_vec(), v5::PeerRole::LocalClient, 0)
            .is_err(),
        "digest"
    );
    let mut hello = frame("hello");
    hello.connection_epoch = Some("fabricated".into());
    assert!(
        WireConnection::default()
            .observe(&hello.encode_to_vec(), v5::PeerRole::LocalClient, 0)
            .is_err(),
        "fabricated hello epoch"
    );
    assert!(
        WireConnection::default()
            .observe(&vector("request"), v5::PeerRole::LocalClient, 0)
            .is_err(),
        "pre-Ready request"
    );
    let mut concatenated = vector("hello");
    concatenated.extend_from_slice(&vector("ping"));
    assert!(
        WireConnection::default()
            .observe(&concatenated, v5::PeerRole::LocalClient, 0)
            .is_err(),
        "concatenated frames"
    );
    for (client, server) in [
        (v5::PeerRole::LocalClient, v5::PeerRole::Server),
        (v5::PeerRole::RemoteClient, v5::PeerRole::Relay),
        (v5::PeerRole::Agent, v5::PeerRole::Relay),
    ] {
        assert!(
            WireConnection::new(client, server).is_ok(),
            "{client:?}/{server:?}"
        );
        connected(client, server);
    }
    for (client, server) in [
        (v5::PeerRole::LocalClient, v5::PeerRole::Relay),
        (v5::PeerRole::RemoteClient, v5::PeerRole::Server),
        (v5::PeerRole::Agent, v5::PeerRole::Server),
        (v5::PeerRole::Server, v5::PeerRole::LocalClient),
        (v5::PeerRole::Relay, v5::PeerRole::RemoteClient),
        (v5::PeerRole::RemoteClient, v5::PeerRole::Agent),
    ] {
        assert!(
            WireConnection::new(client, server).is_err(),
            "{client:?}/{server:?}"
        );
    }
    let mut mismatched = frame("hello");
    if let Some(v5::frame::Body::Hello(body)) = &mut mismatched.body {
        body.role = v5::PeerRole::Server as i32;
    }
    assert!(
        WireConnection::default()
            .observe(&mismatched.encode_to_vec(), v5::PeerRole::LocalClient, 0)
            .is_err(),
        "hello role does not match sender"
    );
    let mut state = WireConnection::default();
    state
        .observe(&vector("hello"), v5::PeerRole::LocalClient, 0)
        .unwrap();
    state
        .observe(&vector("ready"), v5::PeerRole::Server, 4999)
        .unwrap();
    assert!(
        state
            .observe(&vector("ping"), v5::PeerRole::LocalClient, 9998)
            .is_ok()
    );
    let mut state = WireConnection::default();
    state
        .observe(&vector("hello"), v5::PeerRole::LocalClient, 0)
        .unwrap();
    state
        .observe(&vector("ready"), v5::PeerRole::Server, 4999)
        .unwrap();
    assert_eq!(
        state
            .observe(&vector("ping"), v5::PeerRole::LocalClient, 9999)
            .unwrap_err()
            .0,
        "handshake timeout"
    );
}

#[test]
fn test_029_depth_field_frame_and_event_count_n_minus1_n_n_plus1() {
    for (depth, accepted) in [(63, true), (64, true), (65, false)] {
        let mut value = v5::Value {
            kind: Some(v5::value::Kind::Null(v5::Empty {})),
        };
        for _ in 1..depth {
            value = v5::Value {
                kind: Some(v5::value::Kind::List(v5::ValueList { items: vec![value] })),
            };
        }
        assert_eq!(
            decode_strict::<v5::Value>(&value.encode_to_vec()).is_ok(),
            accepted,
            "depth {depth}"
        );
    }
    for (count, accepted) in [(32767, true), (32768, true), (32769, false)] {
        let list = v5::ValueList {
            items: vec![
                v5::Value {
                    kind: Some(v5::value::Kind::Null(v5::Empty {}))
                };
                count
            ],
        };
        assert_eq!(
            decode_strict::<v5::ValueList>(&list.encode_to_vec()).is_ok(),
            accepted,
            "fields {count}"
        );
    }
    let mut connection = connected(v5::PeerRole::LocalClient, v5::PeerRole::Server);
    for (count, accepted) in [(63, true), (64, true), (65, false)] {
        let mut events = frame("events");
        if let Some(v5::frame::Body::EventBatch(body)) = &mut events.body {
            body.events = vec![body.events[0].clone(); count];
        }
        assert_eq!(
            connection
                .observe(&events.encode_to_vec(), v5::PeerRole::Server, 3)
                .is_ok(),
            accepted,
            "events {count}"
        );
    }
    assert_ne!(
        connection
            .observe(
                &vec![0; limits::CLIENT_FRAME_BYTES as usize],
                v5::PeerRole::LocalClient,
                3
            )
            .unwrap_err()
            .0,
        "frame byte limit"
    );
    assert_eq!(
        connection
            .observe(
                &vec![0; limits::CLIENT_FRAME_BYTES as usize + 1],
                v5::PeerRole::LocalClient,
                3
            )
            .unwrap_err()
            .0,
        "frame byte limit"
    );
}

#[test]
fn test_026_bulk_frames_in_order_and_truncated_final_is_premature_eof() {
    let mut connection = connected(v5::PeerRole::LocalClient, v5::PeerRole::Server);
    let start = frame("bulk-start");
    assert!(
        connection
            .observe(&start.encode_to_vec(), v5::PeerRole::Server, 3)
            .is_ok()
    );
    let piece = frame("bulk-piece");
    assert!(
        connection
            .observe(&piece.encode_to_vec(), v5::PeerRole::Server, 3)
            .is_ok()
    );
    let end = frame("bulk-end");
    assert!(
        connection
            .observe(&end.encode_to_vec(), v5::PeerRole::Server, 3)
            .is_ok()
    );
    let truncated = &vector("bulk-end")[..3];
    assert!(
        decode_strict::<v5::Frame>(truncated).is_err(),
        "premature EOF at codec level"
    );
}
