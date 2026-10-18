use crate::resources::mcp::skills::{decode_base64, encode_base64};
use ring::{
    aead, digest, hmac,
    rand::{SecureRandom, SystemRandom},
};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidSecret,
    Unavailable,
}

pub struct SecretBox {
    key: [u8; 32],
}

const MAX_SEQUENCE: i64 = 9_007_199_254_740_991;

impl SecretBox {
    pub fn new(key: [u8; 32]) -> Self {
        Self { key }
    }

    pub fn load_or_create(path: &Path) -> Result<Self, Error> {
        #[cfg(unix)]
        {
            key_file(path).map(Self::new)
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            Err(Error::Unavailable)
        }
    }

    pub fn encrypt(&self, plain: &[u8]) -> Result<String, Error> {
        let key = aead::UnboundKey::new(&aead::AES_256_GCM, &self.key)
            .map(aead::LessSafeKey::new)
            .map_err(|_| Error::Unavailable)?;
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| Error::Unavailable)?;
        let mut ciphertext = plain.to_vec();
        let tag = key
            .seal_in_place_separate_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::empty(),
                &mut ciphertext,
            )
            .map_err(|_| Error::Unavailable)?;
        let mut envelope = Vec::with_capacity(28 + ciphertext.len());
        envelope.extend_from_slice(&nonce);
        envelope.extend_from_slice(tag.as_ref());
        envelope.extend_from_slice(&ciphertext);
        Ok(encode_base64(&envelope, false))
    }

    pub fn decrypt(&self, ciphertext: &str) -> Option<Vec<u8>> {
        let envelope = canonical_base64(ciphertext, false)?;
        if envelope.len() <= 28 {
            return None;
        }
        let nonce = aead::Nonce::try_assume_unique_for_key(&envelope[..12]).ok()?;
        let tag = aead::Tag::try_from(&envelope[12..28]).ok()?;
        let key =
            aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &self.key).ok()?);
        let mut plain = envelope[28..].to_vec();
        key.open_in_place_separate_tag(nonce, aead::Aad::empty(), tag, &mut plain, 0..)
            .ok()?;
        Some(plain)
    }

    pub fn fingerprint(&self, secret: &[u8]) -> String {
        digest::digest(&digest::SHA256, secret).as_ref()[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    pub fn encode_cursor(&self, scope: &str, seq: i64) -> Option<String> {
        if !(0..=MAX_SEQUENCE).contains(&seq) {
            return None;
        }
        let key = hmac::Key::new(hmac::HMAC_SHA256, &self.key);
        let tag = hmac::sign(&key, format!("mcp-events-cursor:{scope}:{seq}").as_bytes());
        Some(format!(
            "cur_{}.{}",
            encode_base64(seq.to_string().as_bytes(), true),
            encode_base64(tag.as_ref(), true)
        ))
    }

    pub fn decode_cursor(&self, scope: &str, cursor: &str) -> Option<i64> {
        let (payload, signature) = cursor.strip_prefix("cur_")?.split_once('.')?;
        let payload = canonical_base64(payload, true)?;
        let value = std::str::from_utf8(&payload).ok()?;
        let seq = value.parse::<i64>().ok()?;
        if !(0..=MAX_SEQUENCE).contains(&seq) || seq.to_string() != value {
            return None;
        }
        let signature = canonical_base64(signature, true)?;
        let key = hmac::Key::new(hmac::HMAC_SHA256, &self.key);
        hmac::verify(
            &key,
            format!("mcp-events-cursor:{scope}:{seq}").as_bytes(),
            &signature,
        )
        .ok()?;
        Some(seq)
    }
}

pub fn decode_secret(secret: &str) -> Result<Vec<u8>, Error> {
    let encoded = secret.strip_prefix("whsec_").ok_or(Error::InvalidSecret)?;
    if !(32..=88).contains(&encoded.len()) || !encoded.len().is_multiple_of(4) {
        return Err(Error::InvalidSecret);
    }
    let secret = canonical_base64(encoded, false).ok_or(Error::InvalidSecret)?;
    if !(24..=64).contains(&secret.len()) {
        return Err(Error::InvalidSecret);
    }
    Ok(secret)
}

fn canonical_base64(text: &str, url: bool) -> Option<Vec<u8>> {
    let bytes = decode_base64(text);
    (encode_base64(&bytes, url) == text).then_some(bytes)
}

#[cfg(unix)]
fn key_file(path: &Path) -> Result<[u8; 32], Error> {
    use std::{
        ffi::CString,
        fs::{DirBuilder, OpenOptions},
        io::Write,
        os::{
            fd::AsRawFd,
            unix::{
                ffi::OsStrExt,
                fs::{DirBuilderExt, OpenOptionsExt},
            },
        },
    };
    let name = CString::new(path.file_name().ok_or(Error::Unavailable)?.as_bytes())
        .map_err(|_| Error::Unavailable)?;
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    match std::fs::symlink_metadata(parent) {
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(Error::Unavailable);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .map_err(|_| Error::Unavailable)?;
        }
        Err(_) => return Err(Error::Unavailable),
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(parent)
        .map_err(|_| Error::Unavailable)?;
    use std::os::unix::fs::MetadataExt;
    let metadata = directory.metadata().map_err(|_| Error::Unavailable)?;
    if !metadata.is_dir() || metadata.uid() != unsafe { libc::getuid() } {
        return Err(Error::Unavailable);
    }
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    match open_key(directory.as_raw_fd(), &name, flags) {
        Ok(file) => return read_key(file),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(Error::Unavailable),
    }
    let mut key = [0; 32];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| Error::Unavailable)?;
    let mut file = match open_key(
        directory.as_raw_fd(),
        &name,
        libc::O_WRONLY
            | libc::O_CREAT
            | libc::O_EXCL
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK,
    ) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return read_key(
                open_key(directory.as_raw_fd(), &name, flags).map_err(|_| Error::Unavailable)?,
            );
        }
        Err(_) => return Err(Error::Unavailable),
    };
    if !private_file(&file.metadata().map_err(|_| Error::Unavailable)?) {
        return Err(Error::Unavailable);
    }
    file.write_all(&key).map_err(|_| Error::Unavailable)?;
    file.sync_all().map_err(|_| Error::Unavailable)?;
    directory.sync_all().map_err(|_| Error::Unavailable)?;
    let metadata = file.metadata().map_err(|_| Error::Unavailable)?;
    if !private_file(&metadata) || metadata.len() != 32 {
        return Err(Error::Unavailable);
    }
    Ok(key)
}

#[cfg(unix)]
fn open_key(
    directory: std::os::fd::RawFd,
    name: &std::ffi::CStr,
    flags: i32,
) -> std::io::Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    let fd = unsafe { libc::openat(directory, name.as_ptr(), flags, 0o600 as libc::c_uint) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn private_file(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.is_file()
        && metadata.mode() & 0o077 == 0
        && metadata.uid() == unsafe { libc::getuid() }
}

#[cfg(unix)]
fn read_key(mut file: std::fs::File) -> Result<[u8; 32], Error> {
    use std::io::Read;
    let metadata = file.metadata().map_err(|_| Error::Unavailable)?;
    if !private_file(&metadata) || metadata.len() != 32 {
        return Err(Error::Unavailable);
    }
    let mut key = [0; 32];
    file.read_exact(&mut key).map_err(|_| Error::Unavailable)?;
    let mut extra = [0; 1];
    if file.read(&mut extra).map_err(|_| Error::Unavailable)? != 0 {
        return Err(Error::Unavailable);
    }
    let metadata = file.metadata().map_err(|_| Error::Unavailable)?;
    if !private_file(&metadata) || metadata.len() != 32 {
        return Err(Error::Unavailable);
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::{Error, SecretBox, decode_secret};
    #[cfg(unix)]
    use std::path::Path;
    use std::{
        collections::BTreeSet,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    const NIST_WIRE: &str = "AAAAAAAAAAAAAAAA0NHIp5mZa/AmW5i11Iq5Gc6nQD1NYGtuB07F07rznRg=";
    const NODE_WIRE: &str =
        "AAECAwQFBgcICQoLFKQbyzqql7j4ZU9eab0o9kC2cUvI51oJNsJhoeDugPK413k5PtilHxmaDm2DWhwk";
    const SECRET_32: &str = "whsec_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
    const SCOPE: &str = "synthetic-subscription";
    const CURSOR_ZERO: &str = "cur_MA.EWtsBnqldsB3Rt8d25bFAhq_H4-1i4qDEtSYFlFfqZo";
    const CURSOR_ONE: &str = "cur_MQ._dNKZK2-MkrnyHyhFZq2lzv4pmSTzqV9OZpwZatEBUE";
    const CURSOR_MAX: &str =
        "cur_OTAwNzE5OTI1NDc0MDk5MQ.f8TUfSprmcJeeSO2S-vwas-VeO1Pwj4WVwtIlfkTeDs";

    #[test]
    fn decrypts_independently_pinned_aes_256_gcm_vectors_with_nonce_tag_ciphertext_layout() {
        assert_eq!(
            SecretBox::new([0; 32]).decrypt(NIST_WIRE),
            Some(vec![0; 16])
        );
        assert_eq!(
            SecretBox::new([3; 32]).decrypt(NODE_WIRE),
            Some(vec![7; 32])
        );
        assert!(SecretBox::new([4; 32]).decrypt(NODE_WIRE).is_none());
    }

    #[test]
    fn encrypts_binary_secret_sizes_with_fresh_nonces_and_standard_base64() {
        let box_ = SecretBox::new([3; 32]);
        for (size, wire_length) in [(24, 72), (32, 80), (64, 124)] {
            let plain = (0..size).map(|index| index as u8).collect::<Vec<_>>();
            let mut nonces = BTreeSet::new();
            for _ in 0..8 {
                let cipher = box_.encrypt(&plain).unwrap();
                assert_eq!(cipher.len(), wire_length);
                assert!(
                    cipher
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric()
                            || matches!(byte, b'+' | b'/' | b'='))
                );
                assert_eq!(box_.decrypt(&cipher), Some(plain.clone()));
                assert!(nonces.insert(cipher[..16].to_owned()));
            }
        }
    }

    #[test]
    fn rejects_nonce_tag_ciphertext_tampering_and_truncated_or_noncanonical_envelopes() {
        let box_ = SecretBox::new([3; 32]);
        for position in [0, 16, 40, NODE_WIRE.len() - 1] {
            let mut bytes = NODE_WIRE.as_bytes().to_vec();
            bytes[position] = if bytes[position] == b'A' { b'B' } else { b'A' };
            assert!(box_.decrypt(&String::from_utf8(bytes).unwrap()).is_none());
        }
        for invalid in [
            String::new(),
            "bogus".into(),
            "AAAAAAAAAAAAAAAAUw+K+8dFNrmpY7TxxMtziw==".into(),
            "A".repeat(36),
            "A".repeat(40),
            NODE_WIRE[..NODE_WIRE.len() - 4].to_owned(),
            format!("{NODE_WIRE}é"),
        ] {
            assert!(box_.decrypt(&invalid).is_none());
        }
        let zero = SecretBox::new([0; 32]);
        for invalid in [
            NIST_WIRE.trim_end_matches('=').to_owned(),
            format!("{NIST_WIRE}="),
            format!("{NIST_WIRE}\n"),
            NIST_WIRE.replace('/', "_"),
            format!("{}h=", &NIST_WIRE[..NIST_WIRE.len() - 2]),
        ] {
            assert!(zero.decrypt(&invalid).is_none());
        }
        assert!(
            zero.decrypt("AAAAAAAAAAAAAAAAUw+K+8dFNrmpY7TxxMtziw==")
                .is_none()
        );
    }

    #[test]
    fn fingerprint_is_the_key_independent_first_32_lowercase_sha256_hex_digits() {
        for key in [[3; 32], [9; 32]] {
            let box_ = SecretBox::new(key);
            assert_eq!(
                box_.fingerprint(&[7; 32]),
                "4bb06f8e4e3a7715d201d573d0aa4237"
            );
            assert_eq!(box_.fingerprint(&[]), "e3b0c44298fc1c149afbf4c8996fb924");
        }
    }

    #[test]
    fn accepts_only_canonical_prefixed_standard_base64_with_24_through_64_decoded_bytes() {
        for (size, encoded) in [
            (24, "BwcH".repeat(8)),
            (25, format!("{}Bw==", "BwcH".repeat(8))),
            (32, SECRET_32.trim_start_matches("whsec_").to_owned()),
            (63, "BwcH".repeat(21)),
            (64, format!("{}Bw==", "BwcH".repeat(21))),
        ] {
            assert_eq!(
                decode_secret(&format!("whsec_{encoded}")).unwrap(),
                vec![7; size]
            );
        }
        assert_eq!(
            decode_secret(&format!("whsec_{}", "/".repeat(32))).unwrap(),
            vec![255; 24]
        );
        assert_eq!(
            decode_secret(&format!("whsec_{}", "+".repeat(32))).unwrap(),
            [251, 239, 190].repeat(8)
        );
        for invalid in [
            "secret".to_owned(),
            "whsec_".into(),
            "whsec_!!!".into(),
            "whsec_====".into(),
            SECRET_32.trim_start_matches("whsec_").to_owned(),
            SECRET_32.replacen("whsec_", "Whsec_", 1),
            format!(" {SECRET_32}"),
            format!("{SECRET_32}\n"),
            SECRET_32.trim_end_matches('=').to_owned(),
            format!("{SECRET_32}="),
            format!("{}d=", &SECRET_32[..SECRET_32.len() - 2]),
            format!("whsec_{}Bx==", "BwcH".repeat(21)),
            format!("whsec_{}Bwc=", "BwcH".repeat(7)),
            format!("whsec_{}Bwc=", "BwcH".repeat(21)),
            format!("whsec_{}", "_".repeat(32)),
            format!("whsec_{}", "-".repeat(32)),
        ] {
            let failure = decode_secret(&invalid).unwrap_err();
            assert!(matches!(&failure, Error::InvalidSecret));
            assert_eq!(format!("{failure:?}"), "InvalidSecret");
        }
    }

    #[test]
    fn cursors_match_pinned_node_hmac_vectors_and_safe_integer_boundaries() {
        let box_ = SecretBox::new([3; 32]);
        for (seq, expected) in [
            (0, CURSOR_ZERO),
            (1, CURSOR_ONE),
            (9_007_199_254_740_991, CURSOR_MAX),
        ] {
            assert_eq!(box_.encode_cursor(SCOPE, seq).as_deref(), Some(expected));
            assert_eq!(box_.decode_cursor(SCOPE, expected), Some(seq));
        }
        let unicode = "cur_NDI.PYN-pWa3FXqv4XcnA8VwazAQnwI4Pysq2cXIRo-RvkM";
        assert_eq!(
            box_.encode_cursor("scope:ไทย", 42).as_deref(),
            Some(unicode)
        );
        assert_eq!(box_.decode_cursor("scope:ไทย", unicode), Some(42));
        for seq in [-1, i64::MIN, 9_007_199_254_740_992, i64::MAX] {
            assert!(box_.encode_cursor(SCOPE, seq).is_none());
        }
        for cursor in [
            "cur_LTE._B1j5ATGsj5NcuvWJ2Bhv9E03yAma6rRa5q1WfN63u4",
            "cur_OTAwNzE5OTI1NDc0MDk5Mg.-cdo2wpfKld1nY5g4bedfqA99P2gG3WAdoaFzMzAhH8",
        ] {
            assert!(box_.decode_cursor(SCOPE, cursor).is_none());
        }
    }

    #[test]
    fn cursor_authentication_rejects_other_scopes_keys_payloads_and_tags() {
        let box_ = SecretBox::new([3; 32]);
        assert!(
            box_.decode_cursor("other-subscription", CURSOR_ONE)
                .is_none()
        );
        assert!(
            SecretBox::new([4; 32])
                .decode_cursor(SCOPE, CURSOR_ONE)
                .is_none()
        );
        for cursor in [
            "".to_owned(),
            "cur_".into(),
            "cur_MQ".into(),
            "cur_MQ.".into(),
            CURSOR_ONE.replacen("cur_", "other_", 1),
            CURSOR_ONE.replacen("cur_MQ.", "cur_Mg.", 1),
            CURSOR_ONE.replacen("._", ".A", 1),
            format!("{CURSOR_ONE}.extra"),
            format!("{CURSOR_ONE}="),
            format!("{CURSOR_ONE}\n"),
            "cur_bm90LWEtbnVtYmVy._dNKZK2-MkrnyHyhFZq2lzv4pmSTzqV9OZpwZatEBUE".into(),
        ] {
            assert!(box_.decode_cursor(SCOPE, &cursor).is_none());
        }
    }

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "ycoding-mcp-events-crypto-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                std::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&path)
                    .unwrap();
            }
            #[cfg(not(unix))]
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[cfg(unix)]
    fn write_key(path: &Path, bytes: &[u8], mode: u32) {
        use std::{
            io::Write,
            os::unix::fs::{OpenOptionsExt, PermissionsExt},
        };
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
        file.set_permissions(std::fs::Permissions::from_mode(mode))
            .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn creates_private_raw_key_once_and_reopens_without_replacement() {
        use std::os::unix::fs::MetadataExt;
        let directory = Directory::new();
        let parent = directory.0.join("private");
        let path = parent.join("key");
        assert!(!parent.exists());
        let first = SecretBox::load_or_create(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let metadata = std::fs::symlink_metadata(&path).unwrap();
        assert_eq!(bytes.len(), 32);
        assert_eq!(metadata.mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&parent).unwrap().mode() & 0o777, 0o700);
        assert_eq!(metadata.uid(), unsafe { libc::getuid() });
        assert!(metadata.is_file() && !metadata.file_type().is_symlink());
        let cipher = first.encrypt(&[7; 32]).unwrap();
        let reopened = SecretBox::load_or_create(&path).unwrap();
        assert_eq!(reopened.decrypt(&cipher), Some(vec![7; 32]));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let after = std::fs::metadata(&path).unwrap();
        assert_eq!(after.ino(), metadata.ino());
        assert_eq!(after.mtime(), metadata.mtime());
        assert_eq!(after.mtime_nsec(), metadata.mtime_nsec());
    }

    #[cfg(unix)]
    #[test]
    fn existing_read_only_private_key_remains_unchanged_and_matches_node_ciphertext() {
        use std::os::unix::fs::PermissionsExt;
        let directory = Directory::new();
        let path = directory.0.join("key");
        write_key(&path, &[3; 32], 0o400);
        let box_ = SecretBox::load_or_create(&path).unwrap();
        assert_eq!(box_.decrypt(NODE_WIRE), Some(vec![7; 32]));
        assert_eq!(std::fs::read(&path).unwrap(), [3; 32]);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o400
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_unsafe_key_modes_bad_lengths_and_nonregular_files_without_rewriting() {
        use std::os::unix::fs::PermissionsExt;
        let directory = Directory::new();
        for mode in [0o604, 0o620, 0o640, 0o666] {
            let path = directory.0.join(format!("mode-{mode}"));
            write_key(&path, &[3; 32], mode);
            assert!(matches!(
                SecretBox::load_or_create(&path),
                Err(Error::Unavailable)
            ));
            assert_eq!(std::fs::read(&path).unwrap(), [3; 32]);
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
        for length in [0, 1, 28, 31, 33, 64] {
            let path = directory.0.join(format!("length-{length}"));
            write_key(&path, &vec![3; length], 0o600);
            assert!(matches!(
                SecretBox::load_or_create(&path),
                Err(Error::Unavailable)
            ));
            assert_eq!(std::fs::read(&path).unwrap(), vec![3; length]);
        }
        let path = directory.0.join("directory");
        std::fs::create_dir(&path).unwrap();
        assert!(matches!(
            SecretBox::load_or_create(&path),
            Err(Error::Unavailable)
        ));
        let parent = directory.0.join("parent-file");
        write_key(&parent, &[3; 32], 0o600);
        assert!(matches!(
            SecretBox::load_or_create(&parent.join("key")),
            Err(Error::Unavailable)
        ));
        assert_eq!(std::fs::read(&parent).unwrap(), [3; 32]);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_key_and_parent_symlinks_without_following_or_creating_targets() {
        use std::os::unix::fs::symlink;
        let directory = Directory::new();
        let target = directory.0.join("target");
        write_key(&target, &[3; 32], 0o600);
        let link = directory.0.join("key-link");
        symlink(&target, &link).unwrap();
        assert!(matches!(
            SecretBox::load_or_create(&link),
            Err(Error::Unavailable)
        ));
        assert_eq!(std::fs::read(&target).unwrap(), [3; 32]);
        let missing = directory.0.join("missing");
        let dangling = directory.0.join("dangling");
        symlink(&missing, &dangling).unwrap();
        assert!(matches!(
            SecretBox::load_or_create(&dangling),
            Err(Error::Unavailable)
        ));
        assert!(!missing.exists());
        let real_parent = directory.0.join("real-parent");
        std::fs::DirBuilder::new().create(&real_parent).unwrap();
        let parent_link = directory.0.join("parent-link");
        symlink(&real_parent, &parent_link).unwrap();
        assert!(matches!(
            SecretBox::load_or_create(&parent_link.join("key")),
            Err(Error::Unavailable)
        ));
        assert!(!real_parent.join("key").exists());
    }

    #[cfg(unix)]
    #[test]
    fn same_length_key_corruption_fails_cipher_authentication_without_silent_repair() {
        let directory = Directory::new();
        let path = directory.0.join("key");
        write_key(&path, &[3; 32], 0o600);
        let first = SecretBox::load_or_create(&path).unwrap();
        let cipher = first.encrypt(&[7; 32]).unwrap();
        std::fs::write(&path, [4; 32]).unwrap();
        let changed = SecretBox::load_or_create(&path).unwrap();
        assert!(changed.decrypt(&cipher).is_none());
        assert_eq!(first.decrypt(&cipher), Some(vec![7; 32]));
        assert_eq!(std::fs::read(&path).unwrap(), [4; 32]);
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_creation_never_clobbers_the_winner_or_adopts_partial_key_bytes() {
        use std::sync::{Arc, Barrier};
        let directory = Directory::new();
        let path = directory.0.join("key");
        let barrier = Arc::new(Barrier::new(8));
        let attempts = (0..8)
            .map(|_| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    SecretBox::load_or_create(&path)
                })
            })
            .collect::<Vec<_>>();
        let outcomes = attempts
            .into_iter()
            .map(|thread| thread.join().expect("key loader panicked"))
            .collect::<Vec<_>>();
        let final_bytes = std::fs::read(&path).unwrap();
        assert_eq!(final_bytes.len(), 32);
        let final_box = SecretBox::load_or_create(&path).unwrap();
        let mut successes = 0;
        for outcome in outcomes {
            match outcome {
                Ok(box_) => {
                    successes += 1;
                    assert_eq!(
                        final_box.decrypt(&box_.encrypt(&[7; 32]).unwrap()),
                        Some(vec![7; 32])
                    );
                }
                Err(error) => assert!(matches!(error, Error::Unavailable)),
            }
        }
        assert!(successes >= 1);
        assert_eq!(std::fs::read(&path).unwrap(), final_bytes);
    }

    #[cfg(not(unix))]
    #[test]
    fn unsupported_platform_secure_storage_fails_closed_without_creating_a_key() {
        let directory = Directory::new();
        let path = directory.0.join("key");
        assert!(matches!(
            SecretBox::load_or_create(&path),
            Err(Error::Unavailable)
        ));
        assert!(!path.exists());
    }
}
