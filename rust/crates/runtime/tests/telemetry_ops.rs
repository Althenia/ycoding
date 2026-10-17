mod support;
mod telemetry_support;
use prost::{Message, Name};
use std::sync::Arc;
use support::*;
use telemetry_support::{batch, consent, query};
use ycoding_protocol::{decode_strict, v5};
use ycoding_runtime::{LocalAuth, standard};

fn sample() -> v5::TelemetrySample {
    v5::TelemetrySample {
        kind: Some(v5::telemetry_sample::Kind::Value1(
            v5::TelemetryRequestSample {
                kind: 1,
                at: text("2026-10-04T12:00:00.000Z"),
                operation: 8,
                outcome: 1,
                reason: None,
                queue_ms: 5,
                settlement_ms: Some(20),
                total_ms: 25,
            },
        )),
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authenticated_global_consent_append_page_opt_out_and_keep_awake_wire() {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let mut settings = services(LocalAuth::with_password("telemetry-test"), true);
        settings.core.as_mut().unwrap().keep_awake =
            ycoding_core::platform::keep_awake::Service::with_command(
                false,
                Arc::new(|| panic!("unsupported should not spawn")),
            );
        let server = start(settings, standard().unwrap()).await;
        assert_eq!(
            Socket::connect(server.address(), &[]).await.err(),
            Some(401)
        );
        let mut client = Client::open(
            server.address(),
            &[("Authorization", basic("telemetry-test"))],
        )
        .await
        .unwrap();
        let state: v5::TelemetryConsentGetResult = success(
            client
                .call("telemetry.consent.get", machine(), Vec::new())
                .await,
        );
        assert_eq!(state.data.notice_version, 1.0);
        assert!(state.data.consent.is_none());
        let disabled = rejected(
            client
                .call("telemetry.append", machine(), batch(vec![sample()]))
                .await,
        );
        assert_eq!(disabled.type_name, v5::TelemetryDisabled::full_name());
        assert_eq!(
            v5::TelemetryDisabled::decode(disabled.payload.as_slice())
                .unwrap()
                .tag,
            1
        );
        let empty: v5::TelemetryListResult = success(
            client
                .call("telemetry.list", machine(), query(None, None))
                .await,
        );
        assert!(empty.data.data.items.is_empty());
        let invalid = rejected(
            client
                .call("telemetry.consent.set", machine(), consent(true, 2.0))
                .await,
        );
        assert_eq!(invalid.type_name, v5::InvalidRequestError::full_name());
        let chosen: v5::TelemetryConsentSetResult = success(
            client
                .call("telemetry.consent.set", machine(), consent(true, 1.0))
                .await,
        );
        assert!(chosen.data.enabled);
        assert!(chosen.data.decided_at > 0);
        let appended: v5::TelemetryAppendResult = success(
            client
                .call(
                    "telemetry.append",
                    machine(),
                    batch(vec![
                        sample(),
                        v5::TelemetrySample {
                            kind: Some(v5::telemetry_sample::Kind::Value3(
                                v5::TelemetryClientSample {
                                    kind: 1,
                                    at: text("2026-10-04T12:00:00.000Z"),
                                    surface: 2,
                                    metric: 3,
                                    duration_ms: 70,
                                },
                            )),
                        },
                    ]),
                )
                .await,
        );
        assert_eq!(appended.accepted, 2);
        let first: v5::TelemetryListResult = success(
            client
                .call("telemetry.list", machine(), query(Some(1), None))
                .await,
        );
        assert_eq!(first.data.data.items.len(), 1);
        assert!(matches!(
            first.data.data.items[0].sample.kind,
            Some(v5::telemetry_sample::Kind::Value3(_))
        ));
        let next = first.data.cursor.next.unwrap();
        let second: v5::TelemetryListResult = success(
            client
                .call("telemetry.list", machine(), query(Some(1), Some(next)))
                .await,
        );
        assert_eq!(second.data.data.items[0].sample, sample());
        assert!(second.data.cursor.next.is_none());
        for start in (1..=77).step_by(20) {
            let rows = (start..=(start + 19).min(77))
                .map(|operation| {
                    let mut sample = sample();
                    if let Some(v5::telemetry_sample::Kind::Value1(row)) = &mut sample.kind {
                        row.operation = operation;
                    }
                    sample
                })
                .collect();
            let _: v5::TelemetryAppendResult = success(
                client
                    .call("telemetry.append", machine(), batch(rows))
                    .await,
            );
        }
        let all: v5::TelemetryListResult = success(
            client
                .call("telemetry.list", machine(), query(Some(200), None))
                .await,
        );
        for (index, entry) in all.data.data.items.iter().take(77).enumerate() {
            let Some(v5::telemetry_sample::Kind::Value1(row)) = &entry.sample.kind else {
                panic!("request sample expected");
            };
            assert_eq!(row.operation, 77 - index as i32);
        }
        for malformed in ["not-a-cursor", "Mw=="] {
            let invalid = rejected(
                client
                    .call(
                        "telemetry.list",
                        machine(),
                        query(None, Some(text(malformed))),
                    )
                    .await,
            );
            assert_eq!(invalid.type_name, v5::InvalidCursorError::full_name());
        }
        let mut invalid = sample();
        if let Some(v5::telemetry_sample::Kind::Value1(row)) = &mut invalid.kind {
            row.at = text("2026-02-30T12:00:00.000Z");
        }
        let invalid = rejected(
            client
                .call("telemetry.append", machine(), batch(vec![invalid]))
                .await,
        );
        assert_eq!(invalid.type_name, v5::InvalidRequestError::full_name());
        let invalid = v5::InvalidRequestError::decode(invalid.payload.as_slice()).unwrap();
        assert_eq!(units(&invalid.message), "Invalid telemetry sample");
        assert_eq!(units(&invalid.field.unwrap()), "samples");
        let _: v5::TelemetryConsentSetResult = success(
            client
                .call("telemetry.consent.set", machine(), consent(false, 1.0))
                .await,
        );
        let disabled = rejected(
            client
                .call("telemetry.append", machine(), batch(vec![sample()]))
                .await,
        );
        assert_eq!(disabled.type_name, v5::TelemetryDisabled::full_name());
        let empty: v5::TelemetryListResult = success(
            client
                .call("telemetry.list", machine(), query(None, None))
                .await,
        );
        assert!(empty.data.data.items.is_empty());
        let awake: v5::KeepAwakeGetResult =
            success(client.call("keepAwake.get", machine(), Vec::new()).await);
        assert_eq!(awake.data.state, 3);
        let changed: v5::KeepAwakeSetResult = success(
            client
                .call(
                    "keepAwake.set",
                    machine(),
                    v5::KeepAwakeSetRequest {
                        payload: v5::KeepAwakeSetRequestPayload { enabled: true },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert_eq!(changed.data, awake.data);
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[test]
fn wire_validation_rejects_batch_duration_enum_scope_payload_and_private_extra_fields() {
    for size in [0, 21] {
        assert!(decode_strict::<v5::TelemetryAppendRequest>(&batch(vec![sample(); size])).is_err());
    }
    assert!(decode_strict::<v5::TelemetryAppendRequest>(&batch(vec![sample(); 20])).is_ok());
    for duration in [600_001, u64::MAX] {
        let mut row = sample();
        if let Some(v5::telemetry_sample::Kind::Value1(sample)) = &mut row.kind {
            sample.queue_ms = duration;
        }
        assert!(decode_strict::<v5::TelemetryAppendRequest>(&batch(vec![row])).is_err());
    }
    let mut row = sample();
    if let Some(v5::telemetry_sample::Kind::Value1(sample)) = &mut row.kind {
        sample.operation = 999;
    }
    assert!(decode_strict::<v5::TelemetryAppendRequest>(&batch(vec![row])).is_err());
    assert!(decode_strict::<v5::TelemetryListRequest>(&query(Some(201), None)).is_err());
    let mut extra = batch(vec![sample()]);
    extra.extend_from_slice(&[0x12, 0x03, b'p', b'i', b'i']);
    assert!(decode_strict::<v5::TelemetryAppendRequest>(&extra).is_err());
    let mut extra = consent(true, 1.0);
    extra.extend_from_slice(&[0x12, 0x01, b'x']);
    assert!(decode_strict::<v5::TelemetryConsentSetRequest>(&extra).is_err());
}

#[test]
fn machine_telemetry_and_keep_awake_allow_the_declared_remote_roles() {
    for name in [
        "telemetry.consent.get",
        "telemetry.consent.set",
        "keepAwake.get",
        "keepAwake.set",
        "telemetry.append",
        "telemetry.list",
    ] {
        let op = operation(name);
        assert_eq!(op.scope, v5::ScopeKind::Machine as i32);
        assert_eq!(
            op.roles,
            [
                v5::PeerRole::LocalClient,
                v5::PeerRole::RemoteClient,
                v5::PeerRole::Relay,
            ]
            .map(|role| role as i32)
        );
    }
}
