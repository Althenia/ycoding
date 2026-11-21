mod support;

use prost::{Message, Name};
use std::time::Duration;
use support::{wire::*, *};
use tokio::time::timeout;
use ycoding_protocol::v5;

fn text(value: &str) -> v5::LosslessString {
    v5::LosslessString {
        encoding: Some(v5::lossless_string::Encoding::Utf8(value.into())),
    }
}

fn target(revision: &str) -> v5::DotsComputerTarget {
    v5::DotsComputerTarget {
        dot_id: text("dot"),
        thread_id: text("thread"),
        environment_id: text("environment"),
        revision: text(revision),
    }
}

fn detach(expected_target: Option<v5::DotsComputerTarget>) -> Vec<u8> {
    v5::DotsDetachRequest {
        payload: v5::DotsComputerDetach { expected_target },
    }
    .encode_to_vec()
}

fn remove(expected_target: Option<v5::DotsComputerTarget>) -> Vec<u8> {
    v5::DotsRemoveRequest {
        payload: v5::DotsComputerRemove { expected_target },
    }
    .encode_to_vec()
}

fn invalid(payload: v5::TypedPayload) -> v5::InvalidRequestError {
    assert_eq!(payload.type_name, v5::InvalidRequestError::full_name());
    v5::InvalidRequestError::decode(payload.payload.as_slice()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detach_and_removal_reach_the_service_boundary_and_are_unavailable_without_native_dots() {
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = open().await;
        let expected = target(&"a".repeat(64));
        for (name, payload) in [
            ("dots.detach", detach(None)),
            ("dots.detach", detach(Some(expected.clone()))),
            ("dots.remove", remove(None)),
            ("dots.remove", remove(Some(expected))),
        ] {
            let error = invalid(rejected(client.call(name, machine(), payload).await));
            assert_eq!(
                error.kind.as_ref().map(units),
                Some("unavailable".to_owned()),
                "{name}"
            );
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_malformed_expected_target_is_refused_before_any_native_service() {
    timeout(Duration::from_secs(60), async {
        let (_server, mut client) = open().await;
        for revision in ["A".repeat(64), "a".repeat(63), "a".repeat(65)] {
            for (name, payload) in [
                ("dots.detach", detach(Some(target(&revision)))),
                ("dots.remove", remove(Some(target(&revision)))),
            ] {
                let error = invalid(rejected(client.call(name, machine(), payload).await));
                assert_ne!(
                    error.kind.as_ref().map(units),
                    Some("unavailable".to_owned()),
                    "{name} {revision:?} must be refused before the native service is consulted"
                );
            }
        }
    })
    .await
    .unwrap();
}
