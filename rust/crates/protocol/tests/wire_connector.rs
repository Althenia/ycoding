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
            v5::PeerRole::RemoteClient => assert_eq!(ids.len(), 87),
            v5::PeerRole::Relay => assert_eq!(ids.len(), 84),
            v5::PeerRole::Agent | v5::PeerRole::Server => assert!(ids.is_empty()),
            v5::PeerRole::LocalClient => assert!(!ids.is_empty()),
        }
    }
    for operation in OPERATIONS.iter().filter(|item| item.operation_id >= 5000) {
        assert_eq!(
            operation
                .roles
                .contains(&(v5::PeerRole::LocalClient as i32)),
            [5008, 5013, 5018].contains(&operation.operation_id)
        );
        assert!(!operation.roles.contains(&(v5::PeerRole::Agent as i32)));
        assert!(!operation.roles.contains(&(v5::PeerRole::Server as i32)));
    }
}

#[test]
fn local_family_reads_preserve_ids_shapes_errors_and_remote_authority() {
    for (name, id, request, result, paging) in [
        (
            "session.capturedChanges.list",
            5008,
            "session_capturedChanges_list_Request",
            "session_capturedChanges_list_Result",
            2,
        ),
        (
            "session.team.economics",
            5013,
            "session_team_economics_Request",
            "session_team_economics_Result",
            1,
        ),
        (
            "session.family.activity",
            5018,
            "session_family_activity_Request",
            "session_family_activity_Result",
            1,
        ),
    ] {
        let operation = OPERATIONS
            .iter()
            .find(|item| item.diagnostic_name == name)
            .unwrap();
        assert_eq!(operation.operation_id, id);
        assert_eq!(operation.roles, vec![1, 2, 3]);
        assert_eq!(operation.request_type, format!("ycoding.v5.{request}"));
        assert_eq!(operation.result_type, format!("ycoding.v5.{result}"));
        assert_eq!(operation.error_types, vec!["ycoding.v5.Connector_Error"]);
        assert_eq!(
            (
                operation.scope,
                operation.mutation,
                operation.settlement,
                operation.paging,
                operation.streaming
            ),
            (3, 1, 1, paging, 2)
        );
    }
    let typescript = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/protocol/src/generated/v5/contract.ts"),
    )
    .unwrap();
    assert!(typescript.starts_with(&format!(
        "export const CONTRACT_DIGEST = {:?}",
        ycoding_protocol::CONTRACT_DIGEST
    )));
    assert_ne!(
        ycoding_protocol::CONTRACT_DIGEST,
        "03ed82fc9cc1926cab3a2a448f0d45c96fb514cf0fd00880e846f2fea19b6054"
    );
}

#[test]
fn relay_only_mcp_request_carries_bounded_typed_http_exchange() {
    let operation = OPERATIONS
        .iter()
        .find(|item| item.operation_id == 5044)
        .unwrap();
    assert_eq!(operation.diagnostic_name, "mcp.request");
    assert_eq!(operation.roles, [v5::PeerRole::Relay as i32]);
    assert_eq!(operation.scope, v5::ScopeKind::Machine as i32);
    assert_eq!(operation.mutation, v5::MutationClass::Mutation as i32);
    assert_eq!(operation.streaming, v5::Streaming::TypedBulk as i32);
    assert_eq!(operation.sensitivity, v5::Sensitivity::Secret as i32);
    assert_eq!(operation.request_type, "ycoding.v5.mcp_request_Request");
    assert_eq!(operation.result_type, "ycoding.v5.mcp_request_Result");
    assert_eq!(operation.error_types, ["ycoding.v5.Connector_Error"]);
    let text = |value: &str| encode_lossless(&value.encode_utf16().collect::<Vec<_>>());
    let request = |headers: usize, body: &str, epoch: &str| {
        v5::ConnectorMcpRequest {
            body: text(body),
            headers: (0..headers)
                .map(|_| v5::ConnectorMcpHeader {
                    name: "accept".into(),
                    value: text("application/json"),
                })
                .collect(),
            principal: v5::ConnectorMcpPrincipal {
                owner_id: "owner".into(),
                device_id: "device".into(),
                client_id: text("https://client.example/metadata"),
            },
            epoch: epoch.into(),
        }
        .encode_to_vec()
    };
    let validate =
        |bytes: &[u8]| ycoding_protocol::validate_binary("ycoding.v5.Connector_McpRequest", bytes);
    assert!(validate(&request(5, "{}", "epoch")).is_ok());
    assert!(validate(&request(6, "{}", "epoch")).is_err());
    assert!(validate(&request(1, "", "epoch")).is_err());
    assert!(validate(&request(1, &"x".repeat(32_769), "epoch")).is_err());
    assert!(validate(&request(1, "{}", &"e".repeat(65))).is_err());
    let response = |status: u32, body: &str| {
        v5::ConnectorMcpResponse {
            status,
            content_type: "application/json".into(),
            body: text(body),
        }
        .encode_to_vec()
    };
    let validate =
        |bytes: &[u8]| ycoding_protocol::validate_binary("ycoding.v5.Connector_McpResponse", bytes);
    assert!(validate(&response(202, "")).is_ok());
    assert!(validate(&response(199, "{}")).is_err());
    assert!(validate(&response(600, "{}")).is_err());
    assert!(validate(&response(200, &"x".repeat(2_097_153))).is_err());
}

#[test]
fn quota_pace_text_is_nonempty_trim_stable_control_free_and_bounded() {
    let quota = |provider: &str| {
        v5::QuotaPace {
            provider_id: encode_lossless(&provider.encode_utf16().collect::<Vec<_>>()),
            window_id: encode_lossless(&"weekly".encode_utf16().collect::<Vec<_>>()),
            milestone: v5::QuotaPaceMilestone::AlmostOut as i32,
            reset_at: 1,
        }
        .encode_to_vec()
    };
    let validate = |bytes: &[u8]| ycoding_protocol::validate_binary("ycoding.v5.QuotaPace", bytes);
    assert!(validate(&quota("openai")).is_ok());
    assert!(validate(&quota(&"\u{1F600}".repeat(64))).is_ok());
    for invalid in [
        "",
        " openai",
        "a".repeat(65).as_str(),
        "a\u{0}b",
        "a\u{202e}b",
    ] {
        assert_eq!(
            validate(&quota(invalid)).err(),
            Some(WireError("title constraint")),
            "{invalid:?}"
        );
    }
}
