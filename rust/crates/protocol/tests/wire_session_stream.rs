use prost::Message;
use std::{fs, path::PathBuf};
use ycoding_protocol::{WireConnection, WireError, decode_strict, v5};

fn bytes() -> Vec<u8> {
    vec![
        8, 5, 18, 5, 101, 112, 111, 99, 104, 24, 2, 32, 1, 154, 1, 3, 10, 1, 115,
    ]
}

fn vector(name: &str) -> Vec<u8> {
    let manifest = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../protocol/ycoding/v5/testdata/manifest.tsv"),
    )
    .unwrap();
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

#[test]
fn finite_event_streams_end_on_the_server_event_ledger() {
    let bytes = bytes();
    assert!(decode_strict::<v5::Frame>(&bytes).is_ok());
    let mut connection = WireConnection::default();
    for (name, role) in [
        ("hello", v5::PeerRole::LocalClient),
        ("ready", v5::PeerRole::Server),
        ("request", v5::PeerRole::LocalClient),
    ] {
        connection.observe(&vector(name), role, 0).unwrap();
    }
    assert!(connection.observe(&bytes, v5::PeerRole::Server, 0).is_ok());
}

#[test]
fn stream_end_rejects_client_direction_wrong_ledger_and_duplicate_body() {
    let bytes = bytes();
    assert_eq!(
        WireConnection::default()
            .observe(&bytes, v5::PeerRole::LocalClient, 0)
            .unwrap_err(),
        WireError("direction")
    );
    let mut wrong = bytes.clone();
    wrong[10] = 1;
    assert_eq!(
        WireConnection::default()
            .observe(&wrong, v5::PeerRole::Server, 0)
            .unwrap_err(),
        WireError("ledger header")
    );
    let mut duplicate = bytes.clone();
    duplicate.extend_from_slice(&bytes[13..]);
    assert_eq!(
        decode_strict::<v5::Frame>(&duplicate).unwrap_err(),
        WireError("duplicate singular")
    );
    let mut empty = bytes[..13].to_vec();
    empty.extend_from_slice(&[154, 1, 2, 10, 0]);
    assert_eq!(
        WireConnection::default()
            .observe(&empty, v5::PeerRole::Server, 0)
            .unwrap_err(),
        WireError("stream end subscription")
    );
}

#[test]
fn stream_end_negatives_retain_their_specific_rejection_reasons() {
    for (name, reason, sender) in [
        ("stream-end-client", "direction", v5::PeerRole::LocalClient),
        (
            "stream-end-duplicate",
            "duplicate singular",
            v5::PeerRole::Server,
        ),
    ] {
        let bytes = vector(name);
        assert_eq!(
            WireConnection::default()
                .observe(&bytes, sender, 0)
                .unwrap_err(),
            WireError(reason),
            "{name}"
        );
    }
}

#[test]
fn test_026_stream_terminal_table_rejects_eof_and_foreign_frames() {
    let full = bytes();
    for cut in [0, 5, 12, full.len() - 1] {
        assert!(
            decode_strict::<v5::Frame>(&full[..cut]).is_err(),
            "premature EOF at {cut}"
        );
    }
    let mut connection = WireConnection::default();
    for (name, role) in [
        ("hello", v5::PeerRole::LocalClient),
        ("ready", v5::PeerRole::Server),
        ("request", v5::PeerRole::LocalClient),
    ] {
        connection.observe(&vector(name), role, 0).unwrap();
    }
    assert!(connection.observe(&full, v5::PeerRole::Server, 0).is_ok());
    assert_eq!(
        connection
            .observe(&full, v5::PeerRole::LocalClient, 0)
            .unwrap_err(),
        WireError("direction"),
        "foreign client cannot terminate a server stream"
    );
    let mut connection =
        WireConnection::new(v5::PeerRole::RemoteClient, v5::PeerRole::Relay).unwrap();
    assert_eq!(
        connection
            .observe(&full, v5::PeerRole::RemoteClient, 0)
            .unwrap_err(),
        WireError("direction"),
        "foreign remote client cannot terminate a relay stream"
    );
}

#[test]
fn stream_end_sender_set_is_exactly_server_agent_and_relay() {
    for (client, server, sender) in [
        (
            v5::PeerRole::LocalClient,
            v5::PeerRole::Server,
            v5::PeerRole::Server,
        ),
        (
            v5::PeerRole::Agent,
            v5::PeerRole::Relay,
            v5::PeerRole::Agent,
        ),
        (
            v5::PeerRole::RemoteClient,
            v5::PeerRole::Relay,
            v5::PeerRole::Relay,
        ),
    ] {
        let mut connection = WireConnection::new(client, server).unwrap();
        let mut hello = decode_strict::<v5::Frame>(&vector("hello")).unwrap();
        if let Some(v5::frame::Body::Hello(value)) = &mut hello.body {
            value.role = client as i32;
        }
        connection
            .observe(&hello.encode_to_vec(), client, 0)
            .unwrap();
        let mut ready = decode_strict::<v5::Frame>(&vector("ready")).unwrap();
        if let Some(v5::frame::Body::Ready(value)) = &mut ready.body {
            value.role = server as i32;
        }
        connection
            .observe(&ready.encode_to_vec(), server, 0)
            .unwrap();
        connection.observe(&vector("ping"), client, 0).unwrap();
        assert!(connection.observe(&bytes(), sender, 0).is_ok());
    }
    for sender in [v5::PeerRole::LocalClient, v5::PeerRole::RemoteClient] {
        let mut connection = if sender == v5::PeerRole::LocalClient {
            WireConnection::default()
        } else {
            WireConnection::new(sender, v5::PeerRole::Relay).unwrap()
        };
        assert_eq!(
            connection.observe(&bytes(), sender, 0).unwrap_err(),
            WireError("direction")
        );
    }
}
