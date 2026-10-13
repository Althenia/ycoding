use prost::Message;
use ycoding_protocol::{
    OPERATION_IDS_BY_ROLE, OPERATIONS, WireError, decode_lossless, decode_strict, encode_lossless,
    v5,
};

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
fn typescript_connector_autonomy_preserves_zero_null_and_boolean() {
    for (bytes, kind) in [
        (
            hex("0a02080012020800"),
            v5::remote_session_autonomy_set_request_payload_max_no_progress::Kind::Value1(0),
        ),
        (
            hex("0a02080012021200"),
            v5::remote_session_autonomy_set_request_payload_max_no_progress::Kind::Clear(
                v5::Empty {},
            ),
        ),
    ] {
        let value = v5::RemoteSessionAutonomySetRequestPayload {
            yolo: v5::ConnectorYolo {
                kind: Some(v5::connector_yolo::Kind::Value1(0)),
            },
            max_no_progress: Some(v5::RemoteSessionAutonomySetRequestPayloadMaxNoProgress {
                kind: Some(kind),
            }),
        };
        assert_eq!(value.encode_to_vec(), bytes);
        assert_eq!(
            decode_strict::<v5::RemoteSessionAutonomySetRequestPayload>(&bytes)
                .unwrap()
                .encode_to_vec(),
            bytes
        );
    }
    let value = v5::RemoteSessionAutonomySetRequestPayload {
        yolo: v5::ConnectorYolo {
            kind: Some(v5::connector_yolo::Kind::Value2(false)),
        },
        max_no_progress: None,
    };
    assert_eq!(value.encode_to_vec(), [10, 2, 16, 0]);
    let invalid = v5::RemoteSessionAutonomySetRequestPayload {
        max_no_progress: Some(v5::RemoteSessionAutonomySetRequestPayloadMaxNoProgress {
            kind: Some(
                v5::remote_session_autonomy_set_request_payload_max_no_progress::Kind::Value1(1001),
            ),
        }),
        ..value
    };
    assert_eq!(
        decode_strict::<v5::RemoteSessionAutonomySetRequestPayload>(&invalid.encode_to_vec())
            .unwrap_err(),
        WireError("integer constraint")
    );
    assert_eq!(
        decode_strict::<v5::RemoteSessionGoalSetRequestPayload>(&[8, 1]).unwrap_err(),
        WireError("wire type")
    );
}

#[test]
fn typescript_file_matches_preserve_uri_kind_and_input_bounds() {
    let bytes = hex("0a160a140a030a0178120b0a0966696c653a2f2f2f781801");
    let value = v5::ConnectorFileFind {
        files: v5::ConnectorFileFindFiles {
            items: vec![v5::ConnectorFileFindFilesItem {
                path: encode_lossless(&[120]),
                uri: encode_lossless(&"file:///x".encode_utf16().collect::<Vec<_>>()),
                kind: 1,
            }],
        },
    };
    assert_eq!(value.encode_to_vec(), bytes);
    let decoded = decode_strict::<v5::ConnectorFileFind>(&bytes).unwrap();
    assert_eq!(
        decode_lossless(&decoded.files.items[0].uri, 32).unwrap(),
        "file:///x".encode_utf16().collect::<Vec<_>>()
    );
    assert_eq!(decoded.files.items[0].kind, 1);
    let mut input = v5::RemoteSessionFsFindRequestPayload {
        query: encode_lossless(&[120]),
        limit: Some(50),
    };
    assert!(decode_strict::<v5::RemoteSessionFsFindRequestPayload>(&input.encode_to_vec()).is_ok());
    input.limit = Some(51);
    assert_eq!(
        decode_strict::<v5::RemoteSessionFsFindRequestPayload>(&input.encode_to_vec()).unwrap_err(),
        WireError("integer constraint")
    );
}

#[test]
fn typescript_form_arrays_and_auth_markers_remain_distinct() {
    let value = v5::RemoteSessionFormListResult { items: vec![] };
    assert!(value.encode_to_vec().is_empty());
    assert!(
        decode_strict::<v5::RemoteSessionFormListResult>(&[])
            .unwrap()
            .items
            .is_empty()
    );
    assert_eq!(
        decode_strict::<v5::SessionFormListResult>(&[]).unwrap_err(),
        WireError("required presence")
    );
    let bytes = [10, 2, 8, 1];
    assert_eq!(
        decode_strict::<v5::RemoteProviderAuthKeyResult>(&bytes)
            .unwrap()
            .encode_to_vec(),
        bytes
    );
    assert_eq!(
        decode_strict::<v5::RemoteProviderAuthCompleteResult>(&bytes)
            .unwrap()
            .encode_to_vec(),
        bytes
    );
    assert_eq!(
        decode_strict::<v5::RemoteProviderAuthKeyResult>(&[10, 0]).unwrap_err(),
        WireError("required presence")
    );
}

#[test]
fn family_activity_uses_eighty_codepoints_not_utf16_units() {
    let mut value = v5::SessionFamilyActivityResultDataItemActivity {
        kind: 1,
        room: 1,
        text: encode_lossless(&"😀".repeat(80).encode_utf16().collect::<Vec<_>>()),
    };
    assert!(
        decode_strict::<v5::SessionFamilyActivityResultDataItemActivity>(&value.encode_to_vec())
            .is_ok()
    );
    value.text = encode_lossless(&"😀".repeat(81).encode_utf16().collect::<Vec<_>>());
    assert_eq!(
        decode_strict::<v5::SessionFamilyActivityResultDataItemActivity>(&value.encode_to_vec())
            .unwrap_err(),
        WireError("text constraint")
    );
}

#[test]
fn typescript_notice_pages_reuse_foundation_vocabulary_and_empty_settlement() {
    let bytes = [10, 4, 10, 2, 16, 0, 24, 0];
    let value = v5::ConnectorNoticePage {
        notice: v5::Notice {
            kind: Some(v5::notice::Kind::Added(v5::NoticesAdded {
                notices: vec![],
                total: 0,
            })),
        },
        next: None,
        unavailable: false,
    };
    assert_eq!(value.encode_to_vec(), bytes);
    assert_eq!(
        decode_strict::<v5::ConnectorNoticePage>(&bytes)
            .unwrap()
            .encode_to_vec(),
        bytes
    );
    let settled = v5::ConnectorNoticeSettlement {
        data: v5::Empty {},
        notification: None,
    };
    assert_eq!(settled.encode_to_vec(), [10, 0]);
    let empty = v5::ConnectorNoticeIDs { ids: vec![] };
    assert_eq!(
        decode_strict::<v5::ConnectorNoticeIDs>(&empty.encode_to_vec()).unwrap_err(),
        WireError("count constraint")
    );
    let oversized = v5::ConnectorNoticeIDs {
        ids: (1..=101).map(|id| format!("ntc_{id}")).collect(),
    };
    assert_eq!(
        decode_strict::<v5::ConnectorNoticeIDs>(&oversized.encode_to_vec()).unwrap_err(),
        WireError("collection limit")
    );
}

#[test]
fn generated_role_allowlists_are_closed_and_match_descriptors() {
    for (role, ids) in OPERATION_IDS_BY_ROLE {
        assert_eq!(
            *ids,
            OPERATIONS
                .iter()
                .filter(|item| item.roles.contains(role))
                .map(|item| item.operation_id)
                .collect::<Vec<_>>()
        );
        match v5::PeerRole::try_from(*role).unwrap() {
            v5::PeerRole::RemoteClient => assert_eq!(ids.len(), 74),
            v5::PeerRole::Relay => assert_eq!(ids.len(), 70),
            v5::PeerRole::Agent | v5::PeerRole::Server => assert!(ids.is_empty()),
            v5::PeerRole::LocalClient => assert!(!ids.is_empty()),
        }
    }
    for operation in OPERATIONS.iter().filter(|item| item.operation_id >= 5000) {
        assert!(
            !operation
                .roles
                .contains(&(v5::PeerRole::LocalClient as i32))
        );
        assert!(!operation.roles.contains(&(v5::PeerRole::Agent as i32)));
        assert!(!operation.roles.contains(&(v5::PeerRole::Server as i32)));
    }
}
