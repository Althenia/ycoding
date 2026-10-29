use std::io::{BufRead, Write};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use clatter::bytearray::ByteArray;
use clatter::crypto::cipher::AesGcm;
use clatter::crypto::dh::X25519;
use clatter::crypto::hash::Sha256;
use clatter::crypto::kem::rust_crypto_ml_kem::MlKem768;
use clatter::handshakepattern::noise_hybrid_ik;
use clatter::traits::{Dh, Handshaker, Kem};
use clatter::transportstate::TransportState;
use clatter::{HybridHandshake, HybridHandshakeParams};
use serde::{Deserialize, Serialize};

const NOISE_SUITE: &str = "Noise_hybridIK_X25519+MLKEM768_AESGCM_SHA256";
const PROLOGUE_DOMAIN: &[u8] = b"codex-exec-server-relay-noise/v1";

type Handshake = HybridHandshake<X25519, MlKem768, MlKem768, AesGcm, Sha256>;
type Transport = TransportState<AesGcm, Sha256>;

#[derive(Clone, Serialize, Deserialize)]
pub struct NoisePublicKey {
    pub suite: String,
    pub x25519_public_key: String,
    pub mlkem768_public_key: String,
}

#[derive(Deserialize)]
#[serde(tag = "command")]
enum InputCommand {
    #[serde(rename = "start")]
    Start {
        responder_public_key: NoisePublicKey,
        environment_id: String,
        executor_registration_id: String,
        stream_id: String,
        payload_hex: String,
    },
    #[serde(rename = "finish")]
    Finish {
        response_hex: String,
    },
    #[serde(rename = "encrypt")]
    Encrypt {
        plaintext_hex: String,
    },
    #[serde(rename = "decrypt")]
    Decrypt {
        ciphertext_hex: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "status")]
enum OutputResponse {
    #[serde(rename = "ok")]
    Ok {
        #[serde(skip_serializing_if = "Option::is_none")]
        initiator_public_key: Option<NoisePublicKey>,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_hex: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ciphertext_hex: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        plaintext_hex: Option<String>,
    },
    #[serde(rename = "error")]
    Error {
        message: String,
    },
}

fn build_prologue(env_id: &str, reg_id: &str, stream_id: &str) -> Vec<u8> {
    let mut prologue = Vec::new();
    append_prologue_part(&mut prologue, PROLOGUE_DOMAIN);
    append_prologue_part(&mut prologue, env_id.as_bytes());
    append_prologue_part(&mut prologue, reg_id.as_bytes());
    append_prologue_part(&mut prologue, stream_id.as_bytes());
    prologue
}

fn append_prologue_part(prologue: &mut Vec<u8>, part: &[u8]) {
    let len = part.len() as u64;
    prologue.extend_from_slice(&len.to_be_bytes());
    prologue.extend_from_slice(part);
}

fn hex_encode(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("Odd length hex string".to_string());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn decode_pk(pk: &NoisePublicKey) -> Result<(<X25519 as Dh>::PubKey, <MlKem768 as Kem>::PubKey), String> {
    if pk.suite != NOISE_SUITE {
        return Err("Invalid suite".to_string());
    }
    let dh_bytes = STANDARD.decode(&pk.x25519_public_key).map_err(|e| e.to_string())?;
    let dh: <X25519 as Dh>::PubKey = dh_bytes.try_into().map_err(|_| "Invalid DH key length".to_string())?;
    let kem_bytes = STANDARD.decode(&pk.mlkem768_public_key).map_err(|e| e.to_string())?;
    if kem_bytes.len() != 1184 {
        return Err("Invalid ML-KEM-768 key length".to_string());
    }
    let kem = <MlKem768 as Kem>::PubKey::from_slice(&kem_bytes);
    Ok((dh, kem))
}


fn print_steps() {
    let env_id = "env-1";
    let reg_id = "reg-1";
    let stream_id = "stream-1";
    let prologue = build_prologue(env_id, reg_id, stream_id);

    let resp_dh = X25519::genkey().unwrap();
    let resp_kem = MlKem768::genkey().unwrap();
    let init_dh = X25519::genkey().unwrap();
    let init_kem = MlKem768::genkey().unwrap();

    let params_init = HybridHandshakeParams::new(noise_hybrid_ik(), true)
        .with_prologue(&prologue)
        .with_s(init_dh.clone())
        .with_s_kem(init_kem.clone())
        .with_rs(resp_dh.public)
        .with_rs_kem(resp_kem.public.clone());
    let mut hs_init = Handshake::new(params_init).unwrap();

    let payload = b"token";
    let overhead = hs_init.get_next_message_overhead().unwrap();
    let mut msg1 = vec![0u8; payload.len() + overhead];

    let len1 = hs_init.write_message(payload, &mut msg1).unwrap();

    msg1.truncate(len1);

    println!("PROLOGUE: {}", hex_encode(&prologue));
    println!("RESP_DH_PUB: {}", hex_encode(&resp_dh.public));
    println!("RESP_DH_PRIV: {}", hex_encode(resp_dh.secret.as_slice()));
    println!("RESP_KEM_PUB: {}", hex_encode(resp_kem.public.as_slice()));
    println!("RESP_KEM_PRIV: {}", hex_encode(resp_kem.secret.as_slice()));
    println!("MSG1: {}", hex_encode(&msg1));
}

fn main() {
    if std::env::args().any(|a| a == "--print-steps") {
        print_steps();
        return;
    }

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    let mut pending_handshake: Option<Handshake> = None;
    let mut active_transport: Option<Transport> = None;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let cmd: InputCommand = match serde_json::from_str(trimmed) {
            Ok(c) => c,
            Err(e) => {
                let out = OutputResponse::Error { message: e.to_string() };
                let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                let _ = stdout.flush();
                continue;
            }
        };

        let response = match cmd {
            InputCommand::Start {
                responder_public_key,
                environment_id,
                executor_registration_id,
                stream_id,
                payload_hex,
            } => {
                let (rs_dh, rs_kem) = match decode_pk(&responder_public_key) {
                    Ok(pair) => pair,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let dh_key = match X25519::genkey() {
                    Ok(k) => k,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e.to_string() };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };
                let kem_key = match MlKem768::genkey() {
                    Ok(k) => k,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e.to_string() };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let initiator_pk = NoisePublicKey {
                    suite: NOISE_SUITE.to_string(),
                    x25519_public_key: STANDARD.encode(dh_key.public),
                    mlkem768_public_key: STANDARD.encode(kem_key.public.as_slice()),
                };

                let prologue = build_prologue(&environment_id, &executor_registration_id, &stream_id);
                let payload = match hex_decode(&payload_hex) {
                    Ok(p) => p,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let params = HybridHandshakeParams::new(noise_hybrid_ik(), true)
                    .with_prologue(&prologue)
                    .with_s(dh_key)
                    .with_s_kem(kem_key)
                    .with_rs(rs_dh)
                    .with_rs_kem(rs_kem);

                let mut handshake = match Handshake::new(params) {
                    Ok(h) => h,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e.to_string() };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let overhead = match handshake.get_next_message_overhead() {
                    Ok(o) => o,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e.to_string() };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let mut output = vec![0u8; payload.len() + overhead];
                let out_len = match handshake.write_message(&payload, &mut output) {
                    Ok(l) => l,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e.to_string() };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };
                output.truncate(out_len);
                pending_handshake = Some(handshake);

                OutputResponse::Ok {
                    initiator_public_key: Some(initiator_pk),
                    request_hex: Some(hex_encode(&output)),
                    ciphertext_hex: None,
                    plaintext_hex: None,
                }
            }
            InputCommand::Finish { response_hex } => {
                let mut hs = match pending_handshake.take() {
                    Some(h) => h,
                    None => {
                        let out = OutputResponse::Error { message: "No pending handshake".to_string() };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let resp_bytes = match hex_decode(&response_hex) {
                    Ok(b) => b,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let overhead = match hs.get_next_message_overhead() {
                    Ok(o) => o,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e.to_string() };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let mut payload = vec![0u8; resp_bytes.len().saturating_sub(overhead)];
                let p_len = match hs.read_message(&resp_bytes, &mut payload) {
                    Ok(l) => l,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e.to_string() };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                if p_len != 0 {
                    let out = OutputResponse::Error { message: "Handshake response payload must be empty".to_string() };
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                    let _ = stdout.flush();
                    continue;
                }

                let transport = match hs.finalize() {
                    Ok(t) => t,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e.to_string() };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };
                active_transport = Some(transport);

                OutputResponse::Ok {
                    initiator_public_key: None,
                    request_hex: None,
                    ciphertext_hex: None,
                    plaintext_hex: None,
                }
            }
            InputCommand::Encrypt { plaintext_hex } => {
                let transport = match active_transport.as_mut() {
                    Some(t) => t,
                    None => {
                        let out = OutputResponse::Error { message: "No active transport".to_string() };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let pt = match hex_decode(&plaintext_hex) {
                    Ok(p) => p,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let mut buf = vec![0u8; pt.len() + 16];
                match transport.send(&pt, &mut buf) {
                    Ok(len) => {
                        buf.truncate(len);
                        OutputResponse::Ok {
                            initiator_public_key: None,
                            request_hex: None,
                            ciphertext_hex: Some(hex_encode(&buf)),
                            plaintext_hex: None,
                        }
                    }
                    Err(e) => OutputResponse::Error { message: e.to_string() },
                }
            }
            InputCommand::Decrypt { ciphertext_hex } => {
                let transport = match active_transport.as_mut() {
                    Some(t) => t,
                    None => {
                        let out = OutputResponse::Error { message: "No active transport".to_string() };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let ct = match hex_decode(&ciphertext_hex) {
                    Ok(c) => c,
                    Err(e) => {
                        let out = OutputResponse::Error { message: e };
                        let _ = writeln!(stdout, "{}", serde_json::to_string(&out).unwrap());
                        let _ = stdout.flush();
                        continue;
                    }
                };

                let mut buf = vec![0u8; ct.len()];
                match transport.receive(&ct, &mut buf) {
                    Ok(len) => {
                        buf.truncate(len);
                        OutputResponse::Ok {
                            initiator_public_key: None,
                            request_hex: None,
                            ciphertext_hex: None,
                            plaintext_hex: Some(hex_encode(&buf)),
                        }
                    }
                    Err(e) => OutputResponse::Error { message: e.to_string() },
                }
            }
        };

        let _ = writeln!(stdout, "{}", serde_json::to_string(&response).unwrap());
        let _ = stdout.flush();
    }
}

#[cfg(test)]
mod debug_tests {
    use super::*;

    #[test]
    fn test_handshake_steps() {
        let env_id = "env-1";
        let reg_id = "reg-1";
        let stream_id = "stream-1";
        let prologue = build_prologue(env_id, reg_id, stream_id);

        let resp_dh = X25519::genkey().unwrap();
        let resp_kem = MlKem768::genkey().unwrap();

        let init_dh = X25519::genkey().unwrap();
        let init_kem = MlKem768::genkey().unwrap();

        let params_init = HybridHandshakeParams::new(noise_hybrid_ik(), true)
            .with_prologue(&prologue)
            .with_s(init_dh)
            .with_s_kem(init_kem)
            .with_rs(resp_dh.public)
            .with_rs_kem(resp_kem.public.clone());
        let mut hs_init = Handshake::new(params_init).unwrap();

        let payload = b"token";
        let overhead = hs_init.get_next_message_overhead().unwrap();
        let mut msg1 = vec![0u8; payload.len() + overhead];
        let len1 = hs_init.write_message(payload, &mut msg1).unwrap();
        msg1.truncate(len1);

        println!("msg1 len: {}", msg1.len());
        println!("prologue hex: {}", hex_encode(&prologue));
        println!("resp_dh pub hex: {}", hex_encode(&resp_dh.public));
        println!("resp_dh priv hex: {}", hex_encode(resp_dh.secret.as_slice()));
        println!("resp_kem priv hex: {}", hex_encode(resp_kem.secret.as_slice()));
        println!("msg1 hex: {}", hex_encode(&msg1));
        println!("resp_kem pub hex: {}", hex_encode(resp_kem.public.as_slice()));

        let params_resp = HybridHandshakeParams::new(noise_hybrid_ik(), false)
            .with_prologue(&prologue)
            .with_s(resp_dh)
            .with_s_kem(resp_kem);
        let mut hs_resp = Handshake::new(params_resp).unwrap();
        let overhead_resp = hs_resp.get_next_message_overhead().unwrap();
        let mut pt = vec![0u8; msg1.len().saturating_sub(overhead_resp)];
        let pt_len = hs_resp.read_message(&msg1, &mut pt).unwrap();
        pt.truncate(pt_len);
        let mut msg2 = vec![0u8; hs_resp.get_next_message_overhead().unwrap()];
        let len2 = hs_resp.write_message(&[], &mut msg2).unwrap();
        msg2.truncate(len2);
        let tr = hs_resp.finalize().unwrap();
        println!("Handshake complete! msg2 len: {}", msg2.len());
        println!("Handshake hash: {}", hex_encode(tr.get_handshake_hash().as_slice()));
    }
}
