use prost::{Message, Name};
use std::{collections::BTreeSet, fmt::Debug};
use ycoding_protocol::connection::{Budgets, Config, Connection, ProtocolError};
use ycoding_protocol::{OPERATIONS, WireError, decode_strict, encode_lossless, v5};

fn text(value: &str) -> v5::LosslessString {
    encode_lossless(&value.encode_utf16().collect::<Vec<_>>())
}

fn round_trip<T: Message + Name + Default + PartialEq + Debug>(value: T) -> Vec<u8> {
    let bytes = value.encode_to_vec();
    let decoded = decode_strict::<T>(&bytes).unwrap();
    assert_eq!(decoded, value);
    assert_eq!(decoded.encode_to_vec(), bytes);
    bytes
}

fn target() -> v5::ConfigurationTarget {
    v5::ConfigurationTarget {
        scope: 1,
        path: text("/backend/ycoding.jsonc"),
    }
}

fn device() -> v5::RemoteDevice {
    v5::RemoteDevice {
        device_id: text("dev_1"),
        name: text("Test"),
        relay_origin: text("https://relay.example"),
        enrolled_at: 0,
        credential_state: 1,
        credential_expires_at: None,
    }
}

#[test]
fn m3_provider_endpoints_models_scopes_and_write_registration_settlement_round_trip() {
    assert!(decode_strict::<v5::ProviderEndpoint>(&[0x12, 0]).is_err());
    for kind in [v5::provider_endpoint::Kind::Openai(
        v5::ProviderEndpointOpenAi {
            base_url: text("https://models.example/v1"),
            api: 2,
        },
    )] {
        for models in [
            None,
            Some(v5::ProviderEndpointModels { items: vec![] }),
            Some(v5::ProviderEndpointModels {
                items: vec![v5::ProviderEndpointModel {
                    id: text("model"),
                    model_id: Some(text("upstream")),
                    name: Some(text("Model")),
                    family: Some(text("test")),
                    api: Some(1),
                    disabled: Some(false),
                    tools: Some(false),
                }],
            }),
        ] {
            round_trip(v5::ProviderConfigureRequest {
                query: Default::default(),
                payload: v5::ProviderConfigureRequestPayload {
                    provider_id: text("custom"),
                    scope: 2,
                    endpoint: v5::ProviderEndpoint {
                        kind: Some(kind.clone()),
                    },
                    catalog: Some(1),
                    models,
                },
            });
        }
    }
    round_trip(v5::ProviderConfigureResult {
        data: v5::ProviderConfigureResultData {
            provider_id: text("custom"),
            target: target(),
            registered: true,
        },
    });
    let bytes = round_trip(v5::ProviderEndpointOpenAi {
        base_url: text("https://models.example/v1"),
        api: 1,
    });
    assert_eq!(
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
        "0a1b0a1968747470733a2f2f6d6f64656c732e6578616d706c652f76311001"
    );
}

#[test]
fn m4_persistent_requests_reuse_local_and_remote_mcp_configs_with_redacted_results() {
    for kind in [
        v5::mcp_add_request_payload_config::Kind::Value1(v5::McpLocalConfig {
            r#type: 1,
            command: v5::McpLocalConfigCommand {
                items: vec![text("test-server")],
            },
            environment: Some(v5::McpLocalConfigEnvironment {
                entries: vec![v5::McpLocalConfigEnvironmentEntry {
                    key: text("TOKEN"),
                    value: text("synthetic"),
                }],
            }),
            ..Default::default()
        }),
        v5::mcp_add_request_payload_config::Kind::Value2(v5::McpRemoteConfig {
            r#type: 1,
            url: text("https://mcp.example"),
            headers: Some(v5::McpRemoteConfigHeaders {
                entries: vec![v5::McpRemoteConfigHeadersEntry {
                    key: text("Authorization"),
                    value: text("synthetic"),
                }],
            }),
            ..Default::default()
        }),
    ] {
        round_trip(v5::McpConfigureRequest {
            query: Default::default(),
            payload: v5::McpConfigureRequestPayload {
                name: text("test"),
                scope: 1,
                config: v5::McpAddRequestPayloadConfig { kind: Some(kind) },
            },
        });
    }
    round_trip(v5::McpConfigureResult {
        data: v5::McpConfigureResultData {
            name: text("test"),
            target: target(),
            reloaded: true,
        },
    });
}

#[test]
fn m5_package_identity_digests_and_presentation_assets_round_trip() {
    round_trip(v5::FrontendPackageResolveRequest {
        query: Default::default(),
        payload: v5::FrontendPackageResolveRequestPayload {
            spec: text("@example/tui@1.0.0"),
        },
    });
    for assets in [None, Some(v5::FrontendPackageAssets { items: vec![] })] {
        round_trip(v5::FrontendPackageResolveResult {
            data: v5::FrontendPackageDescriptor {
                name: text("@example/tui"),
                version: text("1.0.0"),
                digest: text(&"a".repeat(64)),
                root: text("/backend/package"),
                entrypoint: v5::FrontendPackageAsset {
                    path: text("tui.js"),
                    digest: text(&"b".repeat(64)),
                },
                assets,
            },
        });
    }
}

#[test]
fn m10_enrollment_replace_and_redacted_device_status_round_trip() {
    for replace in [None, Some(false), Some(true)] {
        round_trip(v5::RemoteEnrollRequest {
            payload: v5::RemoteEnrollRequestPayload {
                relay_origin: text("https://relay.example"),
                enrollment_id: text("enr_1"),
                code: text("TEST-CODE"),
                name: Some(text("Test")),
                replace,
            },
        });
    }
    round_trip(v5::RemoteEnrollResult { data: device() });
    round_trip(v5::RemoteGetResult {
        data: v5::RemoteGetResultData {
            state: 1,
            message: None,
            device: Some(device()),
        },
    });
    round_trip(v5::RemoteEnrollmentPartialFailure {
        tag: 1,
        device: device(),
    });
}

#[test]
fn m3_m4_m5_m10_failures_are_closed_and_partial_writes_retain_the_target() {
    for code in 1..=4 {
        round_trip(v5::ConfigurationWriteError { tag: 1, code });
    }
    for code in 1..=5 {
        round_trip(v5::FrontendPackageError { tag: 1, code });
    }
    for code in 1..=7 {
        round_trip(v5::RemoteEnrollmentError { tag: 1, code });
    }
    for stage in [1, 2] {
        round_trip(v5::ConfigurationPartialFailure {
            tag: 1,
            target: target(),
            stage,
        });
    }
    assert!(decode_strict::<v5::ConfigurationWriteError>(&[8, 1, 16, 5]).is_err());
    assert!(decode_strict::<v5::FrontendPackageError>(&[8, 1, 16, 6]).is_err());
    assert!(decode_strict::<v5::RemoteEnrollmentError>(&[8, 1, 16, 8]).is_err());
    assert!(decode_strict::<v5::ProviderConfigureRequest>(&[]).is_err());
    assert!(decode_strict::<v5::McpConfigureRequest>(&[]).is_err());
    assert!(decode_strict::<v5::FrontendPackageResolveRequest>(&[]).is_err());
    assert!(decode_strict::<v5::RemoteEnrollRequest>(&[]).is_err());
}

#[test]
fn m3_m5_m10_request_and_asset_budgets_reject_overflow_and_unknown_credentials() {
    for count in [256, 257] {
        let value = v5::ProviderEndpointModels {
            items: vec![
                v5::ProviderEndpointModel {
                    id: text("model"),
                    ..Default::default()
                };
                count
            ],
        };
        assert_eq!(
            decode_strict::<v5::ProviderEndpointModels>(&value.encode_to_vec()).is_ok(),
            count == 256
        );
    }
    for count in [1024, 1025] {
        let value = v5::FrontendPackageAssets {
            items: vec![
                v5::FrontendPackageAsset {
                    path: text("asset"),
                    digest: text(&"a".repeat(64)),
                };
                count
            ],
        };
        assert_eq!(
            decode_strict::<v5::FrontendPackageAssets>(&value.encode_to_vec()).is_ok(),
            count == 1024
        );
    }
    for count in [2048, 2049] {
        let value = v5::FrontendPackageResolveRequestPayload {
            spec: text(&"x".repeat(count)),
        };
        assert_eq!(
            decode_strict::<v5::FrontendPackageResolveRequestPayload>(&value.encode_to_vec())
                .is_ok(),
            count == 2048
        );
    }
    let mut bytes = v5::ProviderConfigureRequestPayload {
        provider_id: text("custom"),
        scope: 1,
        endpoint: v5::ProviderEndpoint {
            kind: Some(v5::provider_endpoint::Kind::Openai(
                v5::ProviderEndpointOpenAi {
                    base_url: text("https://models.example"),
                    api: 1,
                },
            )),
        },
        catalog: None,
        models: None,
    }
    .encode_to_vec();
    bytes.extend([50, 0]);
    assert_eq!(
        decode_strict::<v5::ProviderConfigureRequestPayload>(&bytes).unwrap_err(),
        WireError("unknown field")
    );
}

#[test]
fn s2_m8_backend_paths_and_skill_scope_remain_optional_additions() {
    for backend_paths in [
        None,
        Some(v5::BackendPaths {
            home: text("/backend/home"),
            state: text("/backend/state"),
            worktree: text("/backend/worktree"),
            config: text("/backend/config"),
        }),
    ] {
        round_trip(v5::LocationInfo {
            directory: text("/backend/project"),
            workspace_id: None,
            project: v5::LocationInfoProject {
                id: text("prj_1"),
                directory: text("/backend/project"),
            },
            backend_paths,
        });
    }
    for scope in [None, Some(1), Some(2)] {
        round_trip(v5::SkillInfo {
            id: text("test"),
            name: text("Test"),
            location: text("/backend/skill"),
            content: text("Test"),
            scope,
            ..Default::default()
        });
    }
}

#[test]
fn m3_m4_m5_m10_descriptors_reject_remote_roles_before_dispatch() {
    for (name, id, scope) in [
        ("provider.configure", 2060, 2),
        ("mcp.configure", 2061, 2),
        ("frontendPackage.resolve", 2062, 2),
        ("remote.enroll", 3053, 1),
    ] {
        let descriptor = OPERATIONS
            .iter()
            .find(|operation| operation.diagnostic_name == name)
            .unwrap();
        assert_eq!(descriptor.operation_id, id);
        assert_eq!(descriptor.roles, vec![v5::PeerRole::LocalClient as i32]);
        assert_eq!(
            (
                descriptor.scope,
                descriptor.mutation,
                descriptor.settlement,
                descriptor.paging,
                descriptor.streaming
            ),
            (scope, 2, 1, 1, 2)
        );
        for role in [v5::PeerRole::RemoteClient, v5::PeerRole::Relay] {
            let mut client = Connection::new(
                Config {
                    local_role: role,
                    peer_role: if role == v5::PeerRole::RemoteClient {
                        v5::PeerRole::Relay
                    } else {
                        v5::PeerRole::Agent
                    },
                    source_epoch: "source".into(),
                    connection_epoch: "connection".into(),
                    budgets: Budgets::default(),
                    authorized_sessions: BTreeSet::new(),
                    authorized_workspaces: BTreeSet::new(),
                    reservation: None,
                    event_types: BTreeSet::new(),
                },
                OPERATIONS.clone(),
                0,
            )
            .unwrap();
            assert_eq!(
                client.request(
                    id,
                    v5::Scope {
                        target: Some(v5::scope::Target::Machine(v5::Empty {}))
                    },
                    vec![],
                    512,
                    0
                ),
                Err(ProtocolError::Direction)
            );
            assert_eq!(client.stats().pending_requests, 0);
        }
    }
}
