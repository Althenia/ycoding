mod support;

use prost::{Message, Name};
use std::time::Duration;
use support::{wire::*, *};
use tokio::time::timeout;
use ycoding_protocol::v5;

fn attach(replace_others: bool) -> Vec<u8> {
    attach_with(replace_others, None)
}

fn text(value: &str) -> v5::LosslessString {
    v5::LosslessString {
        encoding: Some(v5::lossless_string::Encoding::Utf8(value.into())),
    }
}

fn target(dot: &str, thread: &str, environment: &str, revision: &str) -> v5::DotsComputerTarget {
    v5::DotsComputerTarget {
        dot_id: text(dot),
        thread_id: text(thread),
        environment_id: text(environment),
        revision: text(revision),
    }
}

fn attach_with(replace_others: bool, expected_target: Option<v5::DotsComputerTarget>) -> Vec<u8> {
    v5::DotsAttachRequest {
        payload: v5::DotsComputerAttach {
            replace_others,
            expected_target,
        },
    }
    .encode_to_vec()
}

fn invalid(payload: v5::TypedPayload) -> v5::InvalidRequestError {
    assert_eq!(payload.type_name, v5::InvalidRequestError::full_name());
    v5::InvalidRequestError::decode(payload.payload.as_slice()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_raw_false_replace_flag_reaches_the_service_boundary_and_is_unavailable_without_native_dots()
 {
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = open().await;
        let error = invalid(rejected(
            client.call("dots.attach", machine(), attach(false)).await,
        ));
        assert_eq!(
            error.kind.as_ref().map(units),
            Some("unavailable".to_owned())
        );
        let expected = target("dot", "thread", "environment", &"a".repeat(64));
        let error = invalid(rejected(
            client
                .call("dots.attach", machine(), attach_with(false, Some(expected)))
                .await,
        ));
        assert_eq!(
            error.kind.as_ref().map(units),
            Some("unavailable".to_owned())
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_with_literal_true_reaches_the_service_boundary_and_is_unavailable_without_native_dots()
 {
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = open().await;
        let error = invalid(rejected(
            client.call("dots.attach", machine(), attach(true)).await,
        ));
        assert_eq!(
            error.kind.as_ref().map(units),
            Some("unavailable".to_owned())
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_valid_expected_target_reaches_the_service_boundary() {
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = open().await;
        let expected = target("dot", "thread", "environment", &"a".repeat(64));
        let error = invalid(rejected(
            client
                .call("dots.attach", machine(), attach_with(true, Some(expected)))
                .await,
        ));
        assert_eq!(
            error.kind.as_ref().map(units),
            Some("unavailable".to_owned())
        );
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_malformed_expected_target_is_refused_before_any_native_service() {
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = open().await;
        for expected in [
            target("dot", "thread", "environment", &"A".repeat(64)),
            target("dot", "thread", "environment", &"a".repeat(63)),
            target("dot", "thread", "environment", &"a".repeat(65)),
        ] {
            let error = invalid(rejected(
                client
                    .call(
                        "dots.attach",
                        machine(),
                        attach_with(true, Some(expected.clone())),
                    )
                    .await,
            ));
            assert_ne!(
                error.kind.as_ref().map(units),
                Some("unavailable".to_owned()),
                "{expected:?} must be refused before the native service is consulted"
            );
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_expected_target_with_lone_surrogate_identities_reaches_the_service_boundary() {
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = open().await;
        let lone = |units: &[u16]| v5::LosslessString {
            encoding: Some(v5::lossless_string::Encoding::Utf16LeUnits(
                units.iter().flat_map(|unit| unit.to_le_bytes()).collect(),
            )),
        };
        let expected = v5::DotsComputerTarget {
            dot_id: lone(&[0xd800]),
            thread_id: lone(&[0x74, 0xdc00]),
            environment_id: text("environment"),
            revision: text(&"a".repeat(64)),
        };
        let error = invalid(rejected(
            client
                .call("dots.attach", machine(), attach_with(true, Some(expected)))
                .await,
        ));
        assert_eq!(
            error.kind.as_ref().map(units),
            Some("unavailable".to_owned())
        );
    })
    .await
    .unwrap();
}
