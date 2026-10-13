mod support;
mod telemetry_support;
use prost::{Message, Name};
use std::sync::Arc;
use support::*;
use telemetry_support::{batch, consent, query};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

#[tokio::test]
async fn remote_client_append_requires_consent_and_preserves_bounded_web_samples() {
    use ycoding_runtime::{
        Environment, Settled, Subscriptions,
        connector::{Credential, Enrolled, Peer},
    };

    let environment = Arc::new(Environment {
        services: services(LocalAuth::disabled(), true),
        urls: vec![],
        subscriptions: Subscriptions::default(),
        uploads: Default::default(),
    });
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let peer = Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "stand-in-token".into(),
            now + 60_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now,
    )
    .unwrap();
    let dispatcher = standard().unwrap();
    let call = async |name: &str, payload: Vec<u8>| {
        let Some(Settled::Result(result)) = dispatcher
            .invoke_remote(
                environment.clone(),
                "remote-telemetry".into(),
                &peer,
                v5::Request {
                    request_id: name.into(),
                    operation_id: operation(name).operation_id,
                    scope: machine(),
                    payload,
                },
            )
            .await
        else {
            panic!("remote operation was not admitted")
        };
        result.outcome.unwrap()
    };
    let web = v5::TelemetrySample {
        kind: Some(v5::telemetry_sample::Kind::Value3(
            v5::TelemetryClientSample {
                kind: 1,
                at: text("2026-10-04T12:00:00.000Z"),
                surface: 2,
                metric: 3,
                duration_ms: 70,
            },
        )),
    };
    let v5::result::Outcome::Error(disabled) =
        call("telemetry.append", batch(vec![web.clone()])).await
    else {
        panic!("consent was required")
    };
    assert_eq!(disabled.type_name, v5::TelemetryDisabled::full_name());
    let v5::result::Outcome::Success(enabled) =
        call("telemetry.consent.set", consent(true, 1.0)).await
    else {
        panic!("consent was rejected")
    };
    assert!(
        v5::TelemetryConsentSetResult::decode(enabled.payload.as_slice())
            .unwrap()
            .data
            .enabled
    );
    let v5::result::Outcome::Success(appended) =
        call("telemetry.append", batch(vec![web.clone(); 20])).await
    else {
        panic!("web samples were rejected")
    };
    assert_eq!(
        v5::TelemetryAppendResult::decode(appended.payload.as_slice())
            .unwrap()
            .accepted,
        20
    );
    let v5::result::Outcome::Success(page) = call("telemetry.list", query(Some(200), None)).await
    else {
        panic!("remote telemetry list was rejected")
    };
    let page = v5::TelemetryListResult::decode(page.payload.as_slice()).unwrap();
    assert_eq!(page.data.data.items.len(), 20);
    assert!(page.data.data.items.iter().all(|entry| entry.sample == web));
    for samples in [vec![], vec![web.clone(); 21]] {
        let v5::result::Outcome::Error(invalid) = call("telemetry.append", batch(samples)).await
        else {
            panic!("unbounded batch was admitted")
        };
        assert_eq!(invalid.type_name, v5::InvalidRequestError::full_name());
    }
    let v5::result::Outcome::Success(disabled) =
        call("telemetry.consent.set", consent(false, 1.0)).await
    else {
        panic!("opt-out was rejected")
    };
    assert!(
        !v5::TelemetryConsentSetResult::decode(disabled.payload.as_slice())
            .unwrap()
            .data
            .enabled
    );
    let v5::result::Outcome::Error(disabled) = call("telemetry.append", batch(vec![web])).await
    else {
        panic!("opt-out was ignored")
    };
    assert_eq!(disabled.type_name, v5::TelemetryDisabled::full_name());
    let v5::result::Outcome::Success(page) = call("telemetry.list", query(None, None)).await else {
        panic!("remote telemetry list was rejected")
    };
    assert!(
        v5::TelemetryListResult::decode(page.payload.as_slice())
            .unwrap()
            .data
            .data
            .items
            .is_empty()
    );
}
