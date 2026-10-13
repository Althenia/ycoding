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
fn typescript_remote_goal_branches_use_canonical_autonomy() {
    for kind in [
        v5::session_autonomy_set_value1_goal::Kind::Value1(encode_lossless(
            &"finish".encode_utf16().collect::<Vec<_>>(),
        )),
        v5::session_autonomy_set_value1_goal::Kind::Value2(true),
        v5::session_autonomy_set_value1_goal::Kind::Clear(v5::Empty {}),
    ] {
        let value = v5::SessionAutonomySet {
            kind: Some(v5::session_autonomy_set::Kind::Value1(
                v5::SessionAutonomySetValue1 {
                    yolo: None,
                    goal: v5::SessionAutonomySetValue1Goal { kind: Some(kind) },
                    max_no_progress: Some(1),
                },
            )),
        };
        let bytes = value.encode_to_vec();
        assert_eq!(
            decode_strict::<v5::SessionAutonomySet>(&bytes)
                .unwrap()
                .encode_to_vec(),
            bytes
        );
    }
    assert_eq!(
        decode_strict::<v5::SessionAutonomySetValue1Goal>(&[16, 1, 26, 0]).unwrap_err(),
        WireError("duplicate oneof")
    );
    assert_eq!(
        OPERATIONS
            .iter()
            .find(|operation| operation.diagnostic_name == "session.autonomy.set")
            .unwrap()
            .operation_id,
        4012
    );
}

#[test]
fn typescript_file_matches_preserve_uri_kind_and_input_bounds() {
    let bytes = hex("12160a140a030a017810011a0b0a0966696c653a2f2f2f78");
    let value = v5::FsFindResult {
        location: None,
        data: v5::FsFindResultData {
            items: vec![v5::FileSystemEntry {
                path: encode_lossless(&[120]),
                uri: Some(encode_lossless(
                    &"file:///x".encode_utf16().collect::<Vec<_>>(),
                )),
                r#type: 1,
            }],
        },
    };
    assert_eq!(value.encode_to_vec(), bytes);
    let decoded = decode_strict::<v5::FsFindResult>(&bytes).unwrap();
    assert_eq!(
        decode_lossless(decoded.data.items[0].uri.as_ref().unwrap(), 32).unwrap(),
        "file:///x".encode_utf16().collect::<Vec<_>>()
    );
    assert_eq!(decoded.data.items[0].r#type, 1);
    assert!(decoded.location.is_none());
    let mut input = v5::FsFindRequestQuery {
        query: encode_lossless(&[120]),
        limit: Some(50),
        ..Default::default()
    };
    assert!(decode_strict::<v5::FsFindRequestQuery>(&input.encode_to_vec()).is_ok());
    input.limit = Some(0);
    assert_eq!(
        decode_strict::<v5::FsFindRequestQuery>(&input.encode_to_vec()).unwrap_err(),
        WireError("integer constraint")
    );
}

#[test]
fn typescript_forms_use_shared_result_and_auth_retains_markers() {
    let value = v5::SessionFormListResult {
        data: v5::SessionFormListResultData { items: vec![] },
    };
    assert_eq!(value.encode_to_vec(), [10, 0]);
    assert!(
        decode_strict::<v5::SessionFormListResult>(&[10, 0])
            .unwrap()
            .data
            .items
            .is_empty()
    );
    assert_eq!(
        decode_strict::<v5::SessionFormListResult>(&[]).unwrap_err(),
        WireError("required presence")
    );
    let bytes = [10, 2, 8, 1];
    assert_eq!(
        decode_strict::<v5::ProviderAuthKeyResult>(&bytes)
            .unwrap()
            .encode_to_vec(),
        bytes
    );
    assert_eq!(
        decode_strict::<v5::ProviderAuthCompleteResult>(&bytes)
            .unwrap()
            .encode_to_vec(),
        bytes
    );
    assert_eq!(
        decode_strict::<v5::ProviderAuthKeyResult>(&[10, 0]).unwrap_err(),
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
            v5::PeerRole::RemoteClient => assert_eq!(ids.len(), 70),
            v5::PeerRole::Relay => assert_eq!(ids.len(), 66),
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
