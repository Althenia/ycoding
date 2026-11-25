use std::fmt;
use std::future::Future;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use aws_lc_rs::{aead, agreement, digest, hmac, kem};

use super::access::trim_units;

pub const NOISE_SUITE: &str = "Noise_hybridIK_X25519+MLKEM768_AESGCM_SHA256";
pub const NOISE_PROTOCOL_NAME: &str = "Noise_hybridIK_25519+MLKEM768_AESGCM_SHA256";
pub const PROLOGUE_DOMAIN: &str = "codex-exec-server-relay-noise/v1";
pub const MAX_NOISE_MESSAGE_LEN: usize = 65535;
pub const MAX_SEND_PLAINTEXT_LEN: usize = 65519;
pub const TAG_LEN: usize = 16;

const X25519_PUBLIC_LEN: usize = 32;
const MLKEM768_PUBLIC_LEN: usize = 1184;
const MLKEM768_CIPHERTEXT_LEN: usize = 1088;
const ENCRYPTED_X25519_STATIC_LEN: usize = X25519_PUBLIC_LEN + TAG_LEN;
const ENCRYPTED_MLKEM768_STATIC_LEN: usize = MLKEM768_PUBLIC_LEN + TAG_LEN;
const MESSAGE_ONE_MIN_LEN: usize = MLKEM768_CIPHERTEXT_LEN
    + X25519_PUBLIC_LEN
    + MLKEM768_PUBLIC_LEN
    + ENCRYPTED_X25519_STATIC_LEN
    + ENCRYPTED_MLKEM768_STATIC_LEN
    + TAG_LEN;
const MAX_AUTHORIZATION_LEN: usize = 4096;

type Key = [u8; 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Environment ID is required")]
    EnvironmentIdRequired,
    #[error("Registration ID is required")]
    RegistrationIdRequired,
    #[error("Stream ID is required")]
    StreamIdRequired,
    #[error("Noise key generation failed")]
    KeyGenerationFailed,
    #[error("Invalid Noise handshake message 1 length")]
    InvalidRequestLength,
    #[error("Noise handshake decapsulation failed")]
    DecapsulationFailed,
    #[error("Invalid initiator ephemeral KEM public key")]
    InvalidEphemeralKemKey,
    #[error("Noise handshake ES diffie-hellman failed")]
    EsDiffieHellmanFailed,
    #[error("Noise handshake initiator DH key decryption failed")]
    InitiatorDhKeyDecryptionFailed,
    #[error("Noise handshake initiator KEM key decryption failed")]
    InitiatorKemKeyDecryptionFailed,
    #[error("Invalid initiator static KEM public key")]
    InvalidStaticKemKey,
    #[error("Noise handshake SS diffie-hellman failed")]
    SsDiffieHellmanFailed,
    #[error("Noise handshake payload decryption failed")]
    PayloadDecryptionFailed,
    #[error("Noise handshake authorization payload is invalid")]
    InvalidAuthorizationPayload,
    #[error("Noise handshake response failed")]
    ResponseFailed,
    #[error("Noise transport is broken")]
    TransportBroken,
    #[error("Noise plaintext exceeds maximum message length")]
    PlaintextTooLong,
    #[error("Noise send nonce overflow")]
    SendNonceOverflow,
    #[error("Invalid Noise ciphertext length")]
    InvalidCiphertextLength,
    #[error("Noise receive nonce overflow")]
    ReceiveNonceOverflow,
    #[error("Noise encryption failed")]
    EncryptionFailed,
    #[error("Noise decryption failed")]
    DecryptionFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcceptError<E> {
    Noise(Error),
    Authorization(E),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicKey {
    pub suite: String,
    pub x25519_public_key: String,
    pub mlkem768_public_key: String,
}

pub struct Identity {
    x25519: agreement::PrivateKey,
    x25519_public: [u8; X25519_PUBLIC_LEN],
    mlkem: kem::DecapsulationKey,
    mlkem_public: Vec<u8>,
    public_key: PublicKey,
}

impl Identity {
    pub fn generate() -> Result<Self, Error> {
        let x25519 = agreement::PrivateKey::generate(&agreement::X25519)
            .map_err(|_| Error::KeyGenerationFailed)?;
        let x25519_public = x25519
            .compute_public_key()
            .ok()
            .and_then(|public| <[u8; X25519_PUBLIC_LEN]>::try_from(public.as_ref()).ok())
            .ok_or(Error::KeyGenerationFailed)?;
        let mlkem = kem::DecapsulationKey::generate(&kem::ML_KEM_768)
            .map_err(|_| Error::KeyGenerationFailed)?;
        let mlkem_public = mlkem
            .encapsulation_key()
            .and_then(|key| key.key_bytes())
            .map(|bytes| {
                let raw: &[u8] = bytes.as_ref();
                raw.to_vec()
            })
            .map_err(|_| Error::KeyGenerationFailed)?;
        if mlkem_public.len() != MLKEM768_PUBLIC_LEN {
            return Err(Error::KeyGenerationFailed);
        }
        let public_key = PublicKey {
            suite: NOISE_SUITE.to_owned(),
            x25519_public_key: base64_encode(&x25519_public),
            mlkem768_public_key: base64_encode(&mlkem_public),
        };
        Ok(Self {
            x25519,
            x25519_public,
            mlkem,
            mlkem_public,
            public_key,
        })
    }

    pub fn public_key(&self) -> &PublicKey {
        &self.public_key
    }
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity")
            .field("public_key", &self.public_key)
            .finish_non_exhaustive()
    }
}

pub struct Accept<'a> {
    pub identity: &'a Identity,
    pub environment_id: &'a str,
    pub registration_id: &'a str,
    pub stream_id: &'a str,
    pub request: &'a [u8],
}

#[derive(Debug)]
pub struct Accepted {
    pub response: Vec<u8>,
    pub transport: Transport,
    pub harness_key_sha256: String,
}

struct Direction {
    key: Key,
    nonce: u128,
}

pub struct Transport {
    send: Mutex<Direction>,
    recv: Mutex<Direction>,
    broken: AtomicBool,
}

impl fmt::Debug for Transport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Transport").finish_non_exhaustive()
    }
}

impl Transport {
    fn new(send_key: Key, recv_key: Key) -> Self {
        Self {
            send: Mutex::new(Direction {
                key: send_key,
                nonce: 0,
            }),
            recv: Mutex::new(Direction {
                key: recv_key,
                nonce: 0,
            }),
            broken: AtomicBool::new(false),
        }
    }

    fn break_with(&self, error: Error) -> Error {
        self.broken.store(true, Ordering::SeqCst);
        error
    }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
        let Ok(mut send) = self.send.lock() else {
            return Err(self.break_with(Error::TransportBroken));
        };
        if self.broken.load(Ordering::SeqCst) {
            return Err(Error::TransportBroken);
        }
        if plaintext.len() > MAX_SEND_PLAINTEXT_LEN {
            return Err(Error::PlaintextTooLong);
        }
        let Ok(nonce) = u64::try_from(send.nonce) else {
            return Err(self.break_with(Error::SendNonceOverflow));
        };
        send.nonce += 1;
        seal(&send.key, nonce, &[], plaintext)
            .map_err(|()| self.break_with(Error::EncryptionFailed))
    }

    pub fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, Error> {
        let Ok(mut recv) = self.recv.lock() else {
            return Err(self.break_with(Error::TransportBroken));
        };
        if self.broken.load(Ordering::SeqCst) {
            return Err(Error::TransportBroken);
        }
        if ciphertext.len() < TAG_LEN || ciphertext.len() > MAX_NOISE_MESSAGE_LEN {
            return Err(self.break_with(Error::InvalidCiphertextLength));
        }
        let Ok(nonce) = u64::try_from(recv.nonce) else {
            return Err(self.break_with(Error::ReceiveNonceOverflow));
        };
        recv.nonce += 1;
        open(&recv.key, nonce, &[], ciphertext)
            .map_err(|()| self.break_with(Error::DecryptionFailed))
    }
}

pub fn build_prologue(
    environment_id: &str,
    registration_id: &str,
    stream_id: &str,
) -> Result<Vec<u8>, Error> {
    let environment = js_trim(environment_id);
    if environment.is_empty() {
        return Err(Error::EnvironmentIdRequired);
    }
    let registration = js_trim(registration_id);
    if registration.is_empty() {
        return Err(Error::RegistrationIdRequired);
    }
    let stream = js_trim(stream_id);
    if stream.is_empty() {
        return Err(Error::StreamIdRequired);
    }
    let parts = [
        PROLOGUE_DOMAIN.as_bytes(),
        environment.as_bytes(),
        registration.as_bytes(),
        stream.as_bytes(),
    ];
    let mut prologue = Vec::with_capacity(parts.iter().map(|part| 8 + part.len()).sum());
    for part in parts {
        prologue.extend_from_slice(&(part.len() as u64).to_be_bytes());
        prologue.extend_from_slice(part);
    }
    Ok(prologue)
}

pub async fn accept_handshake<F, Fut, E>(
    input: Accept<'_>,
    authorize: F,
) -> Result<Accepted, AcceptError<E>>
where
    F: FnOnce(PublicKey, String) -> Fut,
    Fut: Future<Output = Result<(), E>>,
{
    let pending = Pending::read(&input).map_err(AcceptError::Noise)?;
    authorize(
        pending.initiator_public_key(),
        pending.authorization.clone(),
    )
    .await
    .map_err(AcceptError::Authorization)?;
    pending.respond().map_err(AcceptError::Noise)
}

struct Pending {
    h: Key,
    ck: Key,
    initiator_ephemeral_dh: [u8; X25519_PUBLIC_LEN],
    initiator_static_dh: [u8; X25519_PUBLIC_LEN],
    initiator_ephemeral_kem: kem::EncapsulationKey,
    initiator_static_kem: kem::EncapsulationKey,
    initiator_static_kem_bytes: Vec<u8>,
    authorization: String,
}

impl Pending {
    fn initiator_public_key(&self) -> PublicKey {
        PublicKey {
            suite: NOISE_SUITE.to_owned(),
            x25519_public_key: base64_encode(&self.initiator_static_dh),
            mlkem768_public_key: base64_encode(&self.initiator_static_kem_bytes),
        }
    }

    fn read(input: &Accept<'_>) -> Result<Self, Error> {
        let request = input.request;
        if request.len() < MESSAGE_ONE_MIN_LEN || request.len() > MAX_NOISE_MESSAGE_LEN {
            return Err(Error::InvalidRequestLength);
        }
        let identity = input.identity;

        let mut h = sha256(&[NOISE_PROTOCOL_NAME.as_bytes()]);
        let mut ck = h;
        let prologue =
            build_prologue(input.environment_id, input.registration_id, input.stream_id)?;
        mix_hash(&mut h, &prologue);
        mix_hash(&mut h, &identity.x25519_public);
        mix_hash(&mut h, &identity.mlkem_public);

        let (static_kem_ciphertext, rest) = request.split_at(MLKEM768_CIPHERTEXT_LEN);
        mix_hash(&mut h, static_kem_ciphertext);
        let static_kem_secret = identity
            .mlkem
            .decapsulate(kem::Ciphertext::from(static_kem_ciphertext))
            .map_err(|_| Error::DecapsulationFailed)?;
        let (next_ck, temp_h, _) = hkdf3(&ck, static_kem_secret.as_ref());
        ck = next_ck;
        mix_hash(&mut h, &temp_h);

        let (ephemeral_dh, rest) = rest.split_at(X25519_PUBLIC_LEN);
        mix_hash(&mut h, ephemeral_dh);
        let (ephemeral_kem, rest) = rest.split_at(MLKEM768_PUBLIC_LEN);
        mix_hash(&mut h, ephemeral_kem);
        let initiator_ephemeral_kem = kem::EncapsulationKey::new(&kem::ML_KEM_768, ephemeral_kem)
            .map_err(|_| Error::InvalidEphemeralKemKey)?;

        let dh_es = x25519_agree(&identity.x25519, ephemeral_dh)
            .map_err(|()| Error::EsDiffieHellmanFailed)?;
        let (next_ck, mut cipher_key) = hkdf2(&ck, &dh_es);
        ck = next_ck;

        let (encrypted_static_dh, rest) = rest.split_at(ENCRYPTED_X25519_STATIC_LEN);
        let static_dh = open(&cipher_key, 0, &h, encrypted_static_dh)
            .map_err(|()| Error::InitiatorDhKeyDecryptionFailed)?;
        mix_hash(&mut h, encrypted_static_dh);

        let (encrypted_static_kem, payload_ciphertext) =
            rest.split_at(ENCRYPTED_MLKEM768_STATIC_LEN);
        let static_kem = open(&cipher_key, 1, &h, encrypted_static_kem)
            .map_err(|()| Error::InitiatorKemKeyDecryptionFailed)?;
        mix_hash(&mut h, encrypted_static_kem);
        let initiator_static_kem = kem::EncapsulationKey::new(&kem::ML_KEM_768, &static_kem)
            .map_err(|_| Error::InvalidStaticKemKey)?;

        let initiator_static_dh = <[u8; X25519_PUBLIC_LEN]>::try_from(static_dh.as_slice())
            .map_err(|_| Error::InitiatorDhKeyDecryptionFailed)?;
        let dh_ss = x25519_agree(&identity.x25519, &initiator_static_dh)
            .map_err(|()| Error::SsDiffieHellmanFailed)?;
        let (next_ck, next_key) = hkdf2(&ck, &dh_ss);
        ck = next_ck;
        cipher_key = next_key;

        let payload = open(&cipher_key, 0, &h, payload_ciphertext)
            .map_err(|()| Error::PayloadDecryptionFailed)?;
        mix_hash(&mut h, payload_ciphertext);

        if payload.len() > MAX_AUTHORIZATION_LEN {
            return Err(Error::InvalidAuthorizationPayload);
        }
        let authorization =
            String::from_utf8(payload).map_err(|_| Error::InvalidAuthorizationPayload)?;
        let authorization = match authorization.strip_prefix('\u{feff}') {
            Some(stripped) => stripped.to_owned(),
            None => authorization,
        };

        Ok(Self {
            h,
            ck,
            initiator_ephemeral_dh: <[u8; X25519_PUBLIC_LEN]>::try_from(ephemeral_dh)
                .map_err(|_| Error::EsDiffieHellmanFailed)?,
            initiator_static_dh,
            initiator_ephemeral_kem,
            initiator_static_kem,
            initiator_static_kem_bytes: static_kem,
            authorization,
        })
    }

    fn respond(self) -> Result<Accepted, Error> {
        let Self {
            mut h,
            mut ck,
            initiator_ephemeral_dh,
            initiator_static_dh,
            initiator_ephemeral_kem,
            initiator_static_kem,
            initiator_static_kem_bytes,
            ..
        } = self;

        let (ephemeral_kem_ciphertext, ephemeral_kem_secret) =
            initiator_ephemeral_kem.encapsulate().map_err(failed)?;
        let ephemeral_kem_ciphertext = ephemeral_kem_ciphertext.as_ref().to_vec();
        mix_hash(&mut h, &ephemeral_kem_ciphertext);
        let (next_ck, mut cipher_key) = hkdf2(&ck, ephemeral_kem_secret.as_ref());
        ck = next_ck;

        let (static_kem_ciphertext, static_kem_secret) =
            initiator_static_kem.encapsulate().map_err(failed)?;
        let encrypted_static_kem_ciphertext =
            seal(&cipher_key, 0, &h, static_kem_ciphertext.as_ref()).map_err(failed)?;
        mix_hash(&mut h, &encrypted_static_kem_ciphertext);
        let (next_ck, temp_h, _) = hkdf3(&ck, static_kem_secret.as_ref());
        ck = next_ck;
        mix_hash(&mut h, &temp_h);

        let ephemeral_dh = agreement::PrivateKey::generate(&agreement::X25519).map_err(failed)?;
        let ephemeral_dh_public = ephemeral_dh.compute_public_key().map_err(failed)?;
        let ephemeral_dh_public = ephemeral_dh_public.as_ref().to_vec();
        let ephemeral_kem = kem::DecapsulationKey::generate(&kem::ML_KEM_768).map_err(failed)?;
        let ephemeral_kem_public = ephemeral_kem
            .encapsulation_key()
            .and_then(|key| key.key_bytes())
            .map(|bytes| {
                let raw: &[u8] = bytes.as_ref();
                raw.to_vec()
            })
            .map_err(failed)?;
        mix_hash(&mut h, &ephemeral_dh_public);
        mix_hash(&mut h, &ephemeral_kem_public);

        let dh_ee = x25519_agree(&ephemeral_dh, &initiator_ephemeral_dh).map_err(failed)?;
        let (next_ck, _) = hkdf2(&ck, &dh_ee);
        ck = next_ck;

        let dh_se = x25519_agree(&ephemeral_dh, &initiator_static_dh).map_err(failed)?;
        let (next_ck, next_key) = hkdf2(&ck, &dh_se);
        ck = next_ck;
        cipher_key = next_key;

        let response_payload_ciphertext = seal(&cipher_key, 0, &h, &[]).map_err(failed)?;

        let mut response = Vec::with_capacity(
            ephemeral_kem_ciphertext.len()
                + encrypted_static_kem_ciphertext.len()
                + ephemeral_dh_public.len()
                + ephemeral_kem_public.len()
                + response_payload_ciphertext.len(),
        );
        response.extend_from_slice(&ephemeral_kem_ciphertext);
        response.extend_from_slice(&encrypted_static_kem_ciphertext);
        response.extend_from_slice(&ephemeral_dh_public);
        response.extend_from_slice(&ephemeral_kem_public);
        response.extend_from_slice(&response_payload_ciphertext);

        let (recv_key, send_key) = hkdf2(&ck, &[]);
        Ok(Accepted {
            response,
            transport: Transport::new(send_key, recv_key),
            harness_key_sha256: crate::cca::encoding::hex(&sha256(&[
                &initiator_static_dh,
                &initiator_static_kem_bytes,
            ])),
        })
    }
}

fn failed<T>(_: T) -> Error {
    Error::ResponseFailed
}

fn js_trim(value: &str) -> String {
    let units = value.encode_utf16().collect::<Vec<_>>();
    String::from_utf16_lossy(trim_units(&units))
}

fn sha256(parts: &[&[u8]]) -> Key {
    let mut context = digest::Context::new(&digest::SHA256);
    for part in parts {
        context.update(part);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(context.finish().as_ref());
    out
}

fn mix_hash(h: &mut Key, data: &[u8]) {
    let next = sha256(&[h.as_slice(), data]);
    *h = next;
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Key {
    let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data);
    let mut out = [0u8; 32];
    out.copy_from_slice(tag.as_ref());
    out
}

fn expand(temp_key: &Key, previous: &Key, counter: u8) -> Key {
    let mut block = [0u8; 33];
    block[..32].copy_from_slice(previous);
    block[32] = counter;
    hmac_sha256(temp_key, &block)
}

fn hkdf2(chaining_key: &Key, input_key_material: &[u8]) -> (Key, Key) {
    let temp_key = hmac_sha256(chaining_key, input_key_material);
    let out1 = hmac_sha256(&temp_key, &[1]);
    let out2 = expand(&temp_key, &out1, 2);
    (out1, out2)
}

fn hkdf3(chaining_key: &Key, input_key_material: &[u8]) -> (Key, Key, Key) {
    let temp_key = hmac_sha256(chaining_key, input_key_material);
    let out1 = hmac_sha256(&temp_key, &[1]);
    let out2 = expand(&temp_key, &out1, 2);
    let out3 = expand(&temp_key, &out2, 3);
    (out1, out2, out3)
}

fn cipher(key: &Key, nonce: u64) -> Result<(aead::LessSafeKey, aead::Nonce), ()> {
    let mut iv = [0u8; aead::NONCE_LEN];
    iv[4..].copy_from_slice(&nonce.to_be_bytes());
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| ())?;
    Ok((
        aead::LessSafeKey::new(unbound),
        aead::Nonce::assume_unique_for_key(iv),
    ))
}

fn seal(key: &Key, nonce: u64, associated_data: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, ()> {
    let (key, nonce) = cipher(key, nonce)?;
    let mut out = plaintext.to_vec();
    let tag = key
        .seal_in_place_separate_tag(nonce, aead::Aad::from(associated_data), &mut out)
        .map_err(|_| ())?;
    out.extend_from_slice(tag.as_ref());
    Ok(out)
}

fn open(key: &Key, nonce: u64, associated_data: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, ()> {
    if ciphertext.len() < TAG_LEN {
        return Err(());
    }
    let (key, nonce) = cipher(key, nonce)?;
    let mut out = ciphertext.to_vec();
    let plaintext_len = key
        .open_in_place(nonce, aead::Aad::from(associated_data), &mut out)
        .map_err(|_| ())?
        .len();
    out.truncate(plaintext_len);
    Ok(out)
}

fn x25519_agree(private: &agreement::PrivateKey, public: &[u8]) -> Result<Key, ()> {
    if public.len() != X25519_PUBLIC_LEN {
        return Err(());
    }
    agreement::agree(
        private,
        agreement::UnparsedPublicKey::new(&agreement::X25519, public),
        (),
        |shared| Key::try_from(shared).map_err(|_| ()),
    )
}

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let block = (u32::from(chunk[0]) << 16)
            | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        let symbol = |shift: u32| char::from(ALPHABET[((block >> shift) & 0x3f) as usize]);
        out.push(symbol(18));
        out.push(symbol(12));
        out.push(if chunk.len() > 1 { symbol(6) } else { '=' });
        out.push(if chunk.len() > 2 { symbol(0) } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paired() -> (Transport, Transport) {
        (
            Transport::new([1; 32], [2; 32]),
            Transport::new([2; 32], [1; 32]),
        )
    }

    #[test]
    fn final_send_nonce_is_usable_then_the_next_encrypt_overflows_and_breaks_the_transport() {
        let (sender, receiver) = paired();
        sender.send.lock().unwrap().nonce = u128::from(u64::MAX);
        receiver.recv.lock().unwrap().nonce = u128::from(u64::MAX);
        let record = sender.encrypt(b"last").expect("final nonce");
        assert_eq!(receiver.decrypt(&record).expect("final nonce"), b"last");
        assert_eq!(sender.encrypt(b"next"), Err(Error::SendNonceOverflow));
        assert_eq!(sender.encrypt(b"again"), Err(Error::TransportBroken));
        assert_eq!(sender.decrypt(&[0u8; TAG_LEN]), Err(Error::TransportBroken));
        assert_eq!(
            receiver.decrypt(&[0u8; TAG_LEN]),
            Err(Error::ReceiveNonceOverflow)
        );
        assert_eq!(receiver.encrypt(b"after"), Err(Error::TransportBroken));
    }

    #[test]
    fn plaintext_limit_is_checked_before_nonce_exhaustion_and_does_not_break() {
        let (sender, _) = paired();
        sender.send.lock().unwrap().nonce = u128::from(u64::MAX) + 1;
        assert_eq!(
            sender.encrypt(&vec![0u8; MAX_SEND_PLAINTEXT_LEN + 1]),
            Err(Error::PlaintextTooLong)
        );
        assert_eq!(sender.encrypt(b""), Err(Error::SendNonceOverflow));
    }

    #[test]
    fn ciphertext_length_is_checked_before_receive_nonce_exhaustion() {
        let (_, receiver) = paired();
        receiver.recv.lock().unwrap().nonce = u128::from(u64::MAX) + 1;
        assert_eq!(
            receiver.decrypt(&[0u8; TAG_LEN - 1]),
            Err(Error::InvalidCiphertextLength)
        );
        assert_eq!(
            receiver.decrypt(&[0u8; TAG_LEN]),
            Err(Error::TransportBroken)
        );
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        for (raw, encoded) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_encode(raw), encoded);
        }
    }
}
