use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use ycoding_core::dots::noise::{
    Accept, AcceptError, Accepted, Error, Identity, MAX_NOISE_MESSAGE_LEN, MAX_SEND_PLAINTEXT_LEN,
    NOISE_PROTOCOL_NAME, NOISE_SUITE, PROLOGUE_DOMAIN, PublicKey, TAG_LEN, Transport,
    accept_handshake, build_prologue,
};

const REFERENCE_BINARY_ENV: &str = "CCA_NOISE_REFERENCE_BIN";
const MESSAGE_ONE_MIN_LEN: usize = 3568;

struct Peer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Peer {
    fn spawn() -> Self {
        let path = std::env::var_os(REFERENCE_BINARY_ENV).map(PathBuf::from).unwrap_or_else(|| {
            panic!(
                "{REFERENCE_BINARY_ENV} must point at the Clatter reference binary; build it with: \
                 cargo build --locked --offline --release --manifest-path ../packages/cli/test/fixture/cca-noise-reference/Cargo.toml \
                 (run from rust/)"
            )
        });
        assert!(
            path.exists(),
            "CCA Noise reference binary not found at {}",
            path.display()
        );
        let mut child = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn reference peer");
        let stdin = child.stdin.take().expect("peer stdin");
        let stdout = BufReader::new(child.stdout.take().expect("peer stdout"));
        Self {
            child,
            stdin,
            stdout,
        }
    }

    fn call(&mut self, command: Value) -> Value {
        writeln!(self.stdin, "{command}").expect("write peer command");
        self.stdin.flush().expect("flush peer command");
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("read peer reply");
        serde_json::from_str(line.trim()).expect("peer reply json")
    }

    fn start(
        &mut self,
        key: &PublicKey,
        env: &str,
        reg: &str,
        stream: &str,
        payload: &[u8],
    ) -> Value {
        self.call(json!({
            "command": "start",
            "responder_public_key": {
                "suite": key.suite,
                "x25519_public_key": key.x25519_public_key,
                "mlkem768_public_key": key.mlkem768_public_key,
            },
            "environment_id": env,
            "executor_registration_id": reg,
            "stream_id": stream,
            "payload_hex": hex_encode(payload),
        }))
    }

    fn finish(&mut self, response: &[u8]) -> Value {
        self.call(json!({ "command": "finish", "response_hex": hex_encode(response) }))
    }

    fn encrypt(&mut self, plaintext: &[u8]) -> Vec<u8> {
        let reply =
            self.call(json!({ "command": "encrypt", "plaintext_hex": hex_encode(plaintext) }));
        assert_eq!(reply["status"], "ok", "{reply}");
        hex_decode(reply["ciphertext_hex"].as_str().expect("ciphertext_hex"))
    }

    fn decrypt(&mut self, ciphertext: &[u8]) -> Value {
        self.call(json!({ "command": "decrypt", "ciphertext_hex": hex_encode(ciphertext) }))
    }

    fn decrypt_ok(&mut self, ciphertext: &[u8]) -> Vec<u8> {
        let reply = self.decrypt(ciphertext);
        assert_eq!(reply["status"], "ok", "{reply}");
        hex_decode(reply["plaintext_hex"].as_str().expect("plaintext_hex"))
    }

    fn request(
        &mut self,
        key: &PublicKey,
        env: &str,
        reg: &str,
        stream: &str,
        payload: &[u8],
    ) -> (Vec<u8>, Value) {
        let reply = self.start(key, env, reg, stream, payload);
        assert_eq!(reply["status"], "ok", "{reply}");
        let request = hex_decode(reply["request_hex"].as_str().expect("request_hex"));
        (request, reply["initiator_public_key"].clone())
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn hex_encode(data: &[u8]) -> String {
    data.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(text: &str) -> Vec<u8> {
    assert_eq!(text.len() % 2, 0);
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("hex digit"))
        .collect()
}

fn base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    for byte in text.bytes().take_while(|byte| *byte != b'=') {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            other => panic!("invalid base64 byte {other}"),
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    out
}

fn length_prefixed(part: &[u8]) -> Vec<u8> {
    let mut out = (part.len() as u64).to_be_bytes().to_vec();
    out.extend_from_slice(part);
    out
}

fn expected_prologue(env: &[u8], reg: &[u8], stream: &[u8]) -> Vec<u8> {
    [PROLOGUE_DOMAIN.as_bytes(), env, reg, stream]
        .iter()
        .flat_map(|part| length_prefixed(part))
        .collect()
}

fn identity() -> Identity {
    Identity::generate().expect("identity")
}

async fn accept(
    identity: &Identity,
    ids: (&str, &str, &str),
    request: &[u8],
) -> Result<Accepted, AcceptError<&'static str>> {
    accept_handshake(
        Accept {
            identity,
            environment_id: ids.0,
            registration_id: ids.1,
            stream_id: ids.2,
            request,
        },
        |_key, _authorization| async { Ok::<(), &'static str>(()) },
    )
    .await
}

async fn accept_counting(
    identity: &Identity,
    ids: (&str, &str, &str),
    request: &[u8],
    calls: &Arc<AtomicUsize>,
) -> Result<Accepted, AcceptError<&'static str>> {
    let calls = Arc::clone(calls);
    accept_handshake(
        Accept {
            identity,
            environment_id: ids.0,
            registration_id: ids.1,
            stream_id: ids.2,
            request,
        },
        move |_key, _authorization| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok::<(), &'static str>(())
        },
    )
    .await
}

const IDS: (&str, &str, &str) = ("env-1", "reg-1", "stream-1");

async fn complete_handshake(peer: &mut Peer, identity: &Identity, payload: &[u8]) -> Transport {
    let (request, _) = peer.request(identity.public_key(), IDS.0, IDS.1, IDS.2, payload);
    let accepted = accept(identity, IDS, &request)
        .await
        .expect("accepted handshake");
    let reply = peer.finish(&accepted.response);
    assert_eq!(reply["status"], "ok", "{reply}");
    accepted.transport
}

#[test]
fn constants_match_the_canonical_suite() {
    assert_eq!(NOISE_SUITE, "Noise_hybridIK_X25519+MLKEM768_AESGCM_SHA256");
    assert_eq!(
        NOISE_PROTOCOL_NAME,
        "Noise_hybridIK_25519+MLKEM768_AESGCM_SHA256"
    );
    assert_eq!(PROLOGUE_DOMAIN, "codex-exec-server-relay-noise/v1");
    assert_eq!(MAX_NOISE_MESSAGE_LEN, 65535);
    assert_eq!(MAX_SEND_PLAINTEXT_LEN, 65519);
    assert_eq!(TAG_LEN, 16);
    assert_eq!(MAX_SEND_PLAINTEXT_LEN + TAG_LEN, MAX_NOISE_MESSAGE_LEN);
}

#[test]
fn identity_exposes_exact_suite_and_key_lengths_without_leaking_secrets() {
    let identity = identity();
    let public_key = identity.public_key();
    assert_eq!(public_key.suite, NOISE_SUITE);
    assert_eq!(base64_decode(&public_key.x25519_public_key).len(), 32);
    assert_eq!(base64_decode(&public_key.mlkem768_public_key).len(), 1184);
    let other = Identity::generate().expect("second identity");
    assert_ne!(identity.public_key(), other.public_key());
    let rendered = format!("{identity:?}");
    assert!(!rendered.contains("PrivateKey"));
    assert!(rendered.contains(&public_key.x25519_public_key));
}

#[test]
fn prologue_is_four_u64_be_length_prefixed_parts() {
    let prologue = build_prologue("env-123", "reg-456", "stream-789").expect("prologue");
    let mut expected = Vec::new();
    expected.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 32]);
    expected.extend_from_slice(b"codex-exec-server-relay-noise/v1");
    expected.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 7]);
    expected.extend_from_slice(b"env-123");
    expected.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 7]);
    expected.extend_from_slice(b"reg-456");
    expected.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 10]);
    expected.extend_from_slice(b"stream-789");
    assert_eq!(prologue, expected);
    assert_eq!(prologue.len(), 8 * 4 + 32 + 7 + 7 + 10);
}

#[test]
fn prologue_trims_exactly_the_javascript_whitespace_set() {
    let js_whitespace = "\u{9}\u{a}\u{b}\u{c}\u{d}\u{20}\u{a0}\u{1680}\u{2000}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
    let padded = format!("{js_whitespace}env{js_whitespace}");
    assert_eq!(
        build_prologue(&padded, " reg\t", "\nstream\u{feff}").expect("trimmed"),
        expected_prologue(b"env", b"reg", b"stream"),
    );
    assert_eq!(
        build_prologue("env", "reg", "\u{85}stream").expect("nel kept"),
        expected_prologue(b"env", b"reg", "\u{85}stream".as_bytes()),
    );
    assert_eq!(
        build_prologue("env", "reg", "stream\u{200b}").expect("zero width space kept"),
        expected_prologue(b"env", b"reg", "stream\u{200b}".as_bytes()),
    );
}

#[test]
fn prologue_inner_whitespace_and_multibyte_ids_are_preserved_as_utf8() {
    assert_eq!(
        build_prologue("e n\tv", "r\u{e9}g", "\u{1f600}").expect("prologue"),
        expected_prologue(b"e n\tv", "r\u{e9}g".as_bytes(), "\u{1f600}".as_bytes()),
    );
    let long = "x".repeat(70_000);
    assert_eq!(
        build_prologue(&long, "reg", "stream").expect("long"),
        expected_prologue(long.as_bytes(), b"reg", b"stream"),
    );
}

#[test]
fn prologue_rejects_empty_or_whitespace_only_ids_in_canonical_order() {
    assert_eq!(
        build_prologue("", "reg", "stream"),
        Err(Error::EnvironmentIdRequired)
    );
    assert_eq!(
        build_prologue(" \t\u{feff}", "reg", "stream"),
        Err(Error::EnvironmentIdRequired)
    );
    assert_eq!(
        build_prologue("env", "", "stream"),
        Err(Error::RegistrationIdRequired)
    );
    assert_eq!(
        build_prologue("env", "\u{2028}", "stream"),
        Err(Error::RegistrationIdRequired)
    );
    assert_eq!(
        build_prologue("env", "reg", ""),
        Err(Error::StreamIdRequired)
    );
    assert_eq!(
        build_prologue("env", "reg", "\n"),
        Err(Error::StreamIdRequired)
    );
    assert_eq!(
        build_prologue("", "", ""),
        Err(Error::EnvironmentIdRequired)
    );
    assert_eq!(
        build_prologue("env", "", ""),
        Err(Error::RegistrationIdRequired)
    );
}

#[test]
fn errors_render_canonical_messages_without_secret_material() {
    let cases = [
        (Error::EnvironmentIdRequired, "Environment ID is required"),
        (Error::RegistrationIdRequired, "Registration ID is required"),
        (Error::StreamIdRequired, "Stream ID is required"),
        (
            Error::InvalidRequestLength,
            "Invalid Noise handshake message 1 length",
        ),
        (
            Error::DecapsulationFailed,
            "Noise handshake decapsulation failed",
        ),
        (
            Error::InvalidEphemeralKemKey,
            "Invalid initiator ephemeral KEM public key",
        ),
        (
            Error::EsDiffieHellmanFailed,
            "Noise handshake ES diffie-hellman failed",
        ),
        (
            Error::InitiatorDhKeyDecryptionFailed,
            "Noise handshake initiator DH key decryption failed",
        ),
        (
            Error::InitiatorKemKeyDecryptionFailed,
            "Noise handshake initiator KEM key decryption failed",
        ),
        (
            Error::InvalidStaticKemKey,
            "Invalid initiator static KEM public key",
        ),
        (
            Error::SsDiffieHellmanFailed,
            "Noise handshake SS diffie-hellman failed",
        ),
        (
            Error::PayloadDecryptionFailed,
            "Noise handshake payload decryption failed",
        ),
        (
            Error::InvalidAuthorizationPayload,
            "Noise handshake authorization payload is invalid",
        ),
        (Error::TransportBroken, "Noise transport is broken"),
        (
            Error::PlaintextTooLong,
            "Noise plaintext exceeds maximum message length",
        ),
        (Error::SendNonceOverflow, "Noise send nonce overflow"),
        (
            Error::InvalidCiphertextLength,
            "Invalid Noise ciphertext length",
        ),
        (Error::ReceiveNonceOverflow, "Noise receive nonce overflow"),
        (Error::EncryptionFailed, "Noise encryption failed"),
        (Error::DecryptionFailed, "Noise decryption failed"),
    ];
    for (error, message) in cases {
        assert_eq!(error.to_string(), message);
    }
}

#[tokio::test]
async fn handshake_rejects_wrong_request_lengths_before_authorization() {
    let identity = identity();
    let calls = Arc::new(AtomicUsize::new(0));
    for length in [
        0,
        100,
        MESSAGE_ONE_MIN_LEN - 1,
        MAX_NOISE_MESSAGE_LEN + 1,
        70_000,
    ] {
        let result = accept_counting(&identity, IDS, &vec![0u8; length], &calls).await;
        assert!(
            matches!(result, Err(AcceptError::Noise(Error::InvalidRequestLength))),
            "length {length}: {result:?}"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn handshake_checks_request_length_before_prologue_ids() {
    let identity = identity();
    let result = accept(&identity, ("", "", ""), &[0u8; 10]).await;
    assert!(
        matches!(result, Err(AcceptError::Noise(Error::InvalidRequestLength))),
        "{result:?}"
    );
}

#[tokio::test]
async fn handshake_rejects_blank_ids_before_authorization() {
    let identity = identity();
    let calls = Arc::new(AtomicUsize::new(0));
    let request = vec![0u8; MESSAGE_ONE_MIN_LEN];
    let result = accept_counting(&identity, (" ", "reg", "stream"), &request, &calls).await;
    assert!(
        matches!(
            result,
            Err(AcceptError::Noise(Error::EnvironmentIdRequired))
        ),
        "{result:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn handshake_rejects_unauthenticated_garbage_of_valid_length_before_authorization() {
    let identity = identity();
    let calls = Arc::new(AtomicUsize::new(0));
    for length in [MESSAGE_ONE_MIN_LEN, 4096, MAX_NOISE_MESSAGE_LEN] {
        let request = (0..length)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let result = accept_counting(&identity, IDS, &request, &calls).await;
        assert!(
            matches!(result, Err(AcceptError::Noise(_))),
            "length {length}"
        );
        assert!(
            !matches!(result, Err(AcceptError::Noise(Error::InvalidRequestLength))),
            "length {length}"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn runs_bidirectional_exchange_with_the_clatter_reference_peer() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let secret = "synthetic-harness-key-authorization-token";
    let (request, initiator_key) = peer.request(
        identity.public_key(),
        "env-test-id",
        "reg-test-id",
        "stream-test-uuid",
        secret.as_bytes(),
    );

    let seen: Arc<Mutex<Option<(PublicKey, String)>>> = Arc::new(Mutex::new(None));
    let capture = Arc::clone(&seen);
    let accepted = accept_handshake(
        Accept {
            identity: &identity,
            environment_id: "env-test-id",
            registration_id: "reg-test-id",
            stream_id: "stream-test-uuid",
            request: &request,
        },
        move |key, authorization| async move {
            *capture.lock().unwrap() = Some((key, authorization));
            Ok::<(), &'static str>(())
        },
    )
    .await
    .expect("accepted");

    let (key, authorization) = seen.lock().unwrap().take().expect("authorize ran");
    assert_eq!(authorization, secret);
    assert_eq!(key.suite, NOISE_SUITE);
    assert_eq!(
        key.x25519_public_key,
        initiator_key["x25519_public_key"].as_str().unwrap()
    );
    assert_eq!(
        key.mlkem768_public_key,
        initiator_key["mlkem768_public_key"].as_str().unwrap()
    );
    assert_eq!(
        accepted.response.len(),
        1088 + 1088 + TAG_LEN + 32 + 1184 + TAG_LEN
    );

    let mut raw = base64_decode(initiator_key["x25519_public_key"].as_str().unwrap());
    raw.extend(base64_decode(
        initiator_key["mlkem768_public_key"].as_str().unwrap(),
    ));
    let expected = hex_encode(aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, &raw).as_ref());
    assert_eq!(accepted.harness_key_sha256, expected);

    let reply = peer.finish(&accepted.response);
    assert_eq!(reply["status"], "ok", "{reply}");
    let transport = accepted.transport;

    let from_peer = peer.encrypt(b"hello from rust harness");
    assert_eq!(
        transport.decrypt(&from_peer).expect("decrypt"),
        b"hello from rust harness"
    );
    let to_peer = transport.encrypt(b"hello from executor").expect("encrypt");
    assert_eq!(peer.decrypt_ok(&to_peer), b"hello from executor");
    for index in 0..5 {
        let message = format!("ping pong {index}");
        let ciphertext = transport.encrypt(message.as_bytes()).expect("encrypt");
        assert_eq!(peer.decrypt_ok(&ciphertext), message.as_bytes());
        let inbound = peer.encrypt(message.as_bytes());
        assert_eq!(
            transport.decrypt(&inbound).expect("decrypt"),
            message.as_bytes()
        );
    }
}

#[tokio::test]
async fn authorization_denial_propagates_and_produces_no_response_or_transport() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let (request, _) = peer.request(identity.public_key(), IDS.0, IDS.1, IDS.2, b"token");
    let result = accept_handshake(
        Accept {
            identity: &identity,
            environment_id: IDS.0,
            registration_id: IDS.1,
            stream_id: IDS.2,
            request: &request,
        },
        |_key, _authorization| async { Err::<(), &'static str>("Authorization denied") },
    )
    .await;
    assert!(
        matches!(
            result,
            Err(AcceptError::Authorization("Authorization denied"))
        ),
        "{result:?}"
    );
}

#[tokio::test]
async fn authorization_runs_exactly_once_on_success() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let calls = Arc::new(AtomicUsize::new(0));
    let (request, _) = peer.request(identity.public_key(), IDS.0, IDS.1, IDS.2, b"token");
    accept_counting(&identity, IDS, &request, &calls)
        .await
        .expect("accepted");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn authorization_future_is_awaited_before_the_handshake_is_accepted() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let (request, _) = peer.request(identity.public_key(), IDS.0, IDS.1, IDS.2, b"token");
    let order = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&order);
    let accepted = accept_handshake(
        Accept {
            identity: &identity,
            environment_id: IDS.0,
            registration_id: IDS.1,
            stream_id: IDS.2,
            request: &request,
        },
        move |_key, _authorization| async move {
            tokio::task::yield_now().await;
            recorder.lock().unwrap().push("authorized");
            Ok::<(), &'static str>(())
        },
    )
    .await;
    order.lock().unwrap().push("accepted");
    assert!(accepted.is_ok());
    assert_eq!(*order.lock().unwrap(), vec!["authorized", "accepted"]);
}

#[tokio::test]
async fn wrong_prologue_identity_fails_handshake_before_authorization() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let (request, _) = peer.request(
        identity.public_key(),
        "env-A",
        "reg-A",
        "stream-A",
        b"token",
    );
    let calls = Arc::new(AtomicUsize::new(0));
    for ids in [
        ("env-B", "reg-A", "stream-A"),
        ("env-A", "reg-B", "stream-A"),
        ("env-A", "reg-A", "stream-B"),
    ] {
        let result = accept_counting(&identity, ids, &request, &calls).await;
        assert!(matches!(result, Err(AcceptError::Noise(_))), "{ids:?}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn prologue_ids_are_javascript_trimmed_on_both_sides_of_the_handshake() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let (request, _) = peer.request(
        identity.public_key(),
        "env-A",
        "reg-A",
        "stream-A",
        b"token",
    );
    let accepted = accept(
        &identity,
        (" env-A\t", "\u{feff}reg-A", "stream-A\u{2029}"),
        &request,
    )
    .await;
    assert!(accepted.is_ok(), "{accepted:?}");
}

#[tokio::test]
async fn handshake_for_a_different_identity_fails_before_authorization() {
    let mut peer = Peer::spawn();
    let intended = identity();
    let other = identity();
    let (request, _) = peer.request(intended.public_key(), IDS.0, IDS.1, IDS.2, b"token");
    let calls = Arc::new(AtomicUsize::new(0));
    let result = accept_counting(&other, IDS, &request, &calls).await;
    assert!(matches!(result, Err(AcceptError::Noise(_))), "{result:?}");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn one_byte_tampering_in_each_message_one_region_fails_before_authorization() {
    let mut peer = Peer::spawn();
    let identity = identity();
    type Region = (&'static str, fn(usize) -> usize);
    let regions: [Region; 6] = [
        ("kem ciphertext", |_| 10),
        ("ephemeral dh", |_| 1088 + 5),
        ("ephemeral kem", |_| 1120 + 5),
        ("encrypted dh static", |_| 2304 + 5),
        ("encrypted kem static", |_| 2352 + 5),
        ("payload tag", |length| length - 1),
    ];
    let calls = Arc::new(AtomicUsize::new(0));
    for (name, offset) in regions {
        let (mut request, _) = peer.request(identity.public_key(), IDS.0, IDS.1, IDS.2, b"token");
        let at = offset(request.len());
        request[at] ^= 0x01;
        let result = accept_counting(&identity, IDS, &request, &calls).await;
        assert!(matches!(result, Err(AcceptError::Noise(_))), "{name}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn invalid_authorization_payloads_fail_before_authorization_and_the_maximum_is_accepted() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let calls = Arc::new(AtomicUsize::new(0));
    for payload in [vec![0x61u8; 4097], vec![0xff, 0xfe, 0x61]] {
        let (request, _) = peer.request(identity.public_key(), IDS.0, IDS.1, IDS.2, &payload);
        let result = accept_counting(&identity, IDS, &request, &calls).await;
        assert!(
            matches!(
                result,
                Err(AcceptError::Noise(Error::InvalidAuthorizationPayload))
            ),
            "{result:?}"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    let maximum = vec![0x62u8; 4096];
    let (request, _) = peer.request(identity.public_key(), IDS.0, IDS.1, IDS.2, &maximum);
    let seen = Arc::new(Mutex::new(String::new()));
    let capture = Arc::clone(&seen);
    accept_handshake(
        Accept {
            identity: &identity,
            environment_id: IDS.0,
            registration_id: IDS.1,
            stream_id: IDS.2,
            request: &request,
        },
        move |_key, authorization| async move {
            *capture.lock().unwrap() = authorization;
            Ok::<(), &'static str>(())
        },
    )
    .await
    .expect("maximum payload accepted");
    assert_eq!(seen.lock().unwrap().as_bytes(), maximum.as_slice());
}

#[tokio::test]
async fn empty_authorization_payload_is_accepted_as_an_empty_string() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let (request, _) = peer.request(identity.public_key(), IDS.0, IDS.1, IDS.2, b"");
    let seen = Arc::new(Mutex::new(Some("unset".to_string())));
    let capture = Arc::clone(&seen);
    accept_handshake(
        Accept {
            identity: &identity,
            environment_id: IDS.0,
            registration_id: IDS.1,
            stream_id: IDS.2,
            request: &request,
        },
        move |_key, authorization| async move {
            *capture.lock().unwrap() = Some(authorization);
            Ok::<(), &'static str>(())
        },
    )
    .await
    .expect("empty payload accepted");
    assert_eq!(seen.lock().unwrap().as_deref(), Some(""));
}

#[tokio::test]
async fn authorization_payload_drops_one_leading_utf8_bom_like_the_canonical_decoder() {
    let mut peer = Peer::spawn();
    let identity = identity();
    for (payload, expected) in [
        (vec![0xef, 0xbb, 0xbf, b'a'], "a"),
        (vec![0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, b'a'], "\u{feff}a"),
        (vec![b'a', 0xef, 0xbb, 0xbf], "a\u{feff}"),
    ] {
        let (request, _) = peer.request(identity.public_key(), IDS.0, IDS.1, IDS.2, &payload);
        let seen = Arc::new(Mutex::new(String::new()));
        let capture = Arc::clone(&seen);
        accept_handshake(
            Accept {
                identity: &identity,
                environment_id: IDS.0,
                registration_id: IDS.1,
                stream_id: IDS.2,
                request: &request,
            },
            move |_key, authorization| async move {
                *capture.lock().unwrap() = authorization;
                Ok::<(), &'static str>(())
            },
        )
        .await
        .expect("accepted");
        assert_eq!(*seen.lock().unwrap(), expected);
    }
}

#[tokio::test]
async fn transport_exchanges_empty_and_maximum_records_in_both_directions() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let transport = complete_handshake(&mut peer, &identity, b"token").await;
    for size in [0usize, MAX_SEND_PLAINTEXT_LEN] {
        let outbound = (0..size)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let ciphertext = transport.encrypt(&outbound).expect("encrypt");
        assert_eq!(ciphertext.len(), size + TAG_LEN);
        assert_eq!(peer.decrypt_ok(&ciphertext), outbound);

        let inbound = (0..size)
            .map(|index| ((index * 7) % 251) as u8)
            .collect::<Vec<_>>();
        let sealed = peer.encrypt(&inbound);
        assert_eq!(transport.decrypt(&sealed).expect("decrypt"), inbound);
    }
}

#[tokio::test]
async fn oversized_plaintext_is_rejected_without_breaking_or_advancing_the_transport() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let transport = complete_handshake(&mut peer, &identity, b"token").await;
    assert_eq!(
        transport.encrypt(&vec![0u8; MAX_SEND_PLAINTEXT_LEN + 1]),
        Err(Error::PlaintextTooLong)
    );
    let ciphertext = transport.encrypt(b"first record").expect("still usable");
    assert_eq!(peer.decrypt_ok(&ciphertext), b"first record");
}

#[tokio::test]
async fn send_nonces_advance_per_record_and_follow_encrypt_order() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let transport = complete_handshake(&mut peer, &identity, b"token").await;
    let first = transport.encrypt(b"same plaintext").expect("encrypt");
    let second = transport.encrypt(b"same plaintext").expect("encrypt");
    assert_ne!(first, second);
    assert_eq!(peer.decrypt_ok(&first), b"same plaintext");
    assert_eq!(peer.decrypt_ok(&second), b"same plaintext");
    for index in 0..10 {
        let message = format!("ordered {index}");
        let ciphertext = transport.encrypt(message.as_bytes()).expect("encrypt");
        assert_eq!(peer.decrypt_ok(&ciphertext), message.as_bytes());
    }
}

#[tokio::test]
async fn concurrent_encrypts_never_reuse_a_nonce() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let transport = Arc::new(complete_handshake(&mut peer, &identity, b"token").await);
    let workers = (0..10)
        .map(|_| {
            let transport = Arc::clone(&transport);
            std::thread::spawn(move || {
                (0..20)
                    .map(|_| transport.encrypt(b"same plaintext").unwrap())
                    .collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    let mut ciphertexts = workers
        .into_iter()
        .flat_map(|worker| worker.join().expect("worker"))
        .collect::<Vec<_>>();
    assert_eq!(ciphertexts.len(), 200);
    ciphertexts.sort();
    ciphertexts.dedup();
    assert_eq!(ciphertexts.len(), 200);
}

#[tokio::test]
async fn receive_nonces_require_record_order() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let transport = complete_handshake(&mut peer, &identity, b"token").await;
    let records = (0..10)
        .map(|index| peer.encrypt(format!("ordered {index}").as_bytes()))
        .collect::<Vec<_>>();
    for (index, record) in records.iter().enumerate() {
        assert_eq!(
            transport.decrypt(record).expect("in order"),
            format!("ordered {index}").as_bytes()
        );
    }
}

#[tokio::test]
async fn out_of_order_record_fails_and_breaks_the_transport() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let transport = complete_handshake(&mut peer, &identity, b"token").await;
    let first = peer.encrypt(b"one");
    let second = peer.encrypt(b"two");
    assert_eq!(transport.decrypt(&second), Err(Error::DecryptionFailed));
    assert_eq!(transport.decrypt(&first), Err(Error::TransportBroken));
}

#[tokio::test]
async fn replayed_record_fails_and_breaks_the_transport() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let transport = complete_handshake(&mut peer, &identity, b"token").await;
    let record = peer.encrypt(b"one");
    assert_eq!(transport.decrypt(&record).expect("first delivery"), b"one");
    assert_eq!(transport.decrypt(&record), Err(Error::DecryptionFailed));
    assert_eq!(transport.encrypt(b"after"), Err(Error::TransportBroken));
}

#[tokio::test]
async fn corrupted_record_fails_and_breaks_both_directions_permanently() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let transport = complete_handshake(&mut peer, &identity, b"token").await;
    let mut corrupt = peer.encrypt(b"msg");
    corrupt[0] ^= 0xff;
    assert_eq!(transport.decrypt(&corrupt), Err(Error::DecryptionFailed));
    let valid = peer.encrypt(b"msg2");
    assert_eq!(transport.decrypt(&valid), Err(Error::TransportBroken));
    assert_eq!(
        transport.encrypt(b"after break"),
        Err(Error::TransportBroken)
    );
}

#[tokio::test]
async fn corrupted_tag_fails_decryption() {
    let mut peer = Peer::spawn();
    let identity = identity();
    let transport = complete_handshake(&mut peer, &identity, b"token").await;
    let mut record = peer.encrypt(b"msg");
    let last = record.len() - 1;
    record[last] ^= 0x01;
    assert_eq!(transport.decrypt(&record), Err(Error::DecryptionFailed));
}

#[tokio::test]
async fn short_and_oversized_ciphertexts_fail_with_length_error_and_break_the_transport() {
    for ciphertext in [
        vec![],
        vec![0u8; TAG_LEN - 1],
        vec![0u8; MAX_NOISE_MESSAGE_LEN + 1],
    ] {
        let mut peer = Peer::spawn();
        let identity = identity();
        let transport = complete_handshake(&mut peer, &identity, b"token").await;
        assert_eq!(
            transport.decrypt(&ciphertext),
            Err(Error::InvalidCiphertextLength)
        );
        let record = peer.encrypt(b"after");
        assert_eq!(transport.decrypt(&record), Err(Error::TransportBroken));
        assert_eq!(transport.encrypt(b"after"), Err(Error::TransportBroken));
    }
}

#[tokio::test]
async fn second_handshake_with_the_same_identity_yields_an_independent_transport() {
    let identity = identity();
    let mut first_peer = Peer::spawn();
    let mut second_peer = Peer::spawn();
    let first = complete_handshake(&mut first_peer, &identity, b"token").await;
    let second = complete_handshake(&mut second_peer, &identity, b"token").await;

    let ciphertext = second.encrypt(b"second session").expect("encrypt");
    assert_eq!(second_peer.decrypt_ok(&ciphertext), b"second session");
    let inbound = first_peer.encrypt(b"first still live");
    assert_eq!(
        first.decrypt(&inbound).expect("decrypt"),
        b"first still live"
    );
    assert!(first_peer.decrypt(&ciphertext)["status"] != "ok");
}

#[tokio::test]
async fn responses_for_one_handshake_do_not_complete_another_peers_handshake() {
    let identity = identity();
    let mut first_peer = Peer::spawn();
    let mut second_peer = Peer::spawn();
    let (first_request, _) =
        first_peer.request(identity.public_key(), IDS.0, IDS.1, IDS.2, b"token");
    let (second_request, _) =
        second_peer.request(identity.public_key(), IDS.0, IDS.1, IDS.2, b"token");
    let first = accept(&identity, IDS, &first_request).await.expect("first");
    let second = accept(&identity, IDS, &second_request)
        .await
        .expect("second");
    assert_ne!(first.response, second.response);
    let reply = second_peer.finish(&first.response);
    assert_eq!(reply["status"], "error", "{reply}");
}
