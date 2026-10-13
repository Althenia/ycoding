use prost::Message;
use ycoding_protocol::{
    OPERATIONS, PUBLIC_EVENTS, WireError, decode_lossless, decode_strict, encode_lossless, v5,
};

fn vector(name: &str) -> Vec<u8> {
    let manifest = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../protocol/ycoding/v5/testdata/manifest.tsv"),
    )
    .unwrap();
    let hex = manifest
        .lines()
        .map(|line| line.split('\t').collect::<Vec<_>>())
        .find(|row| row[0] == name)
        .unwrap()[4];
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect()
}

#[test]
fn public_event_membership_and_durability_are_closed() {
    assert_eq!(PUBLIC_EVENTS.len(), 101);
    assert_eq!(PUBLIC_EVENTS.iter().filter(|event| event.1).count(), 51);
    assert_eq!(
        PUBLIC_EVENTS
            .iter()
            .filter(|event| event.0.starts_with("session."))
            .count(),
        60
    );
    assert!(
        PUBLIC_EVENTS
            .iter()
            .filter(|event| event.1)
            .all(|event| event.3.starts_with("ycoding.v5.SessionLogItemValue"))
    );
    for forbidden in [
        "server.connected",
        "log.synced",
        "session.profile.bound",
        "session.usage.recorded",
        "session.provider.request.recorded",
        "session.compaction.replaced",
        "mcp.tools.changed",
    ] {
        assert!(!PUBLIC_EVENTS.iter().any(|event| event.0 == forbidden));
    }
    for (name, payload) in [
        ("event.subscribe", "ycoding.v5.PublicEvent"),
        ("session.log", "ycoding.v5.SessionLogItem"),
    ] {
        assert_eq!(
            OPERATIONS
                .iter()
                .find(|operation| operation.diagnostic_name == name)
                .unwrap()
                .event_types,
            [payload]
        );
    }
}

#[test]
fn public_corpus_reuses_durable_shapes_and_preserves_ephemeral_utf16() {
    for name in ["public-catalog", "public-text-delta", "public-durable"] {
        let bytes = vector(name);
        assert_eq!(
            decode_strict::<v5::PublicEvent>(&bytes)
                .unwrap()
                .encode_to_vec(),
            bytes
        );
    }
    let delta = decode_strict::<v5::PublicEvent>(&vector("public-text-delta")).unwrap();
    let Some(v5::public_event::Kind::SessionTextDelta(delta)) = delta.kind else {
        panic!("delta branch")
    };
    assert_eq!(decode_lossless(&delta.data.delta, 16).unwrap(), [0xd800]);
    let durable = decode_strict::<v5::PublicEvent>(&vector("public-durable")).unwrap();
    let Some(v5::public_event::Kind::SessionRevertCleared(event)) = durable.kind else {
        panic!("durable branch")
    };
    assert_eq!(event.durable.seq, 1);
    let log = v5::SessionLogItem {
        kind: Some(v5::session_log_item::Kind::Value50(event)),
    };
    assert_eq!(
        decode_strict::<v5::SessionLogItem>(&log.encode_to_vec())
            .unwrap()
            .encode_to_vec(),
        log.encode_to_vec()
    );
    assert_eq!(
        decode_strict::<v5::PublicEvent>(&vector("public-event-empty")).unwrap_err(),
        WireError("required presence")
    );
    assert_eq!(
        decode_strict::<v5::PublicEvent>(&vector("public-event-duplicate")).unwrap_err(),
        WireError("duplicate oneof")
    );
    assert_eq!(
        decode_strict::<v5::PublicEventCatalogUpdated>(&vector("ephemeral-durable")).unwrap_err(),
        WireError("unknown field")
    );
}

#[test]
fn raw_upload_corpus_preserves_octets_offsets_and_byte_bounds() {
    let bytes = vector("upload-raw");
    let value = decode_strict::<v5::SessionAttachmentUploadRequestPayload>(&bytes).unwrap();
    assert_eq!(value.data, [0, 255]);
    assert_eq!(value.index, 0);
    assert_eq!(value.offset, 0);
    assert!(value.last);
    assert_eq!(value.encode_to_vec(), bytes);
    for count in [0, 1, 21000, 21001] {
        let value = v5::SessionAttachmentUploadRequestPayload {
            upload_id: encode_lossless(
                &"00000000-0000-4000-8000-000000000001"
                    .encode_utf16()
                    .collect::<Vec<_>>(),
            ),
            data: vec![0; count],
            index: 0,
            last: true,
            offset: 0,
        };
        assert_eq!(
            decode_strict::<v5::SessionAttachmentUploadRequestPayload>(&value.encode_to_vec())
                .is_ok(),
            count > 0 && count <= 21000
        );
    }
    assert_eq!(
        decode_strict::<v5::SessionAttachmentUploadRequestPayload>(&vector("upload-empty"))
            .unwrap_err(),
        WireError("count constraint")
    );
}
