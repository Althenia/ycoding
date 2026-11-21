#![cfg(unix)]
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::{attachment_store::Store, image::Limits};
use ycoding_core::session::{
    attachment_admission::{Input, MAX_ATTACHMENT_BYTES, MaterializeError, detect},
    pending::Request,
    store::Service,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, LosslessString, parse_json, prompt::FileAttachment, session,
    session_message, session_pending, stringify_json,
};

#[path = "session_support/mod.rs"]
mod support;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-attachment-admission-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn uri(&self, name: &str) -> String {
        url::Url::from_file_path(self.0.join(name)).unwrap().into()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn input(uri: &str) -> Input {
    Input {
        uri: uri.into(),
        name: None,
        description: None,
        mention: None,
    }
}

fn materialize(
    sessions: &Service,
    store: &Store,
    uri: &str,
) -> Result<(FileAttachment, Vec<u8>), MaterializeError> {
    let file = sessions.materialize_attachment(store, Limits::default(), input(uri))?;
    let bytes = store.read(&file.content).unwrap();
    Ok((file, bytes))
}

fn error(sessions: &Service, store: &Store, uri: &str) -> String {
    match sessions.materialize_attachment(store, Limits::default(), input(uri)) {
        Err(MaterializeError::Attachment(message)) => message,
        other => panic!("{uri}: expected an attachment error, got {other:?}"),
    }
}

#[test]
fn mime_detection_matches_the_typescript_signatures_and_text_heuristic() {
    for (bytes, mime) in [
        (&b"\x89PNG\r\n\x1a\nrest"[..], "image/png"),
        (b"\xff\xd8\xffrest", "image/jpeg"),
        (b"GIF89a", "image/gif"),
        (b"BMrest", "image/bmp"),
        (b"%PDF-1.7", "application/pdf"),
        (b"RIFF\0\0\0\0WEBPVP8", "image/webp"),
        (b"\0\0\0\x1cftypavif", "image/avif"),
        (b"\0\0\0\x1cftypavis", "image/avif"),
        (b"", "text/plain"),
        (b"plain text\n", "text/plain"),
        (b"caf\xc3", "text/plain"),
        (b"caf\xc3(", "application/octet-stream"),
        (b"a\0b", "application/octet-stream"),
        (b"\x01\x02\x03\x04abcdef", "application/octet-stream"),
        (b"\x01\x02\x03abcdefg", "text/plain"),
        (b"\x01\x02abcdefgh", "text/plain"),
    ] {
        assert_eq!(detect(bytes), mime, "{bytes:?}");
    }
}

#[test]
fn data_urls_decode_canonical_base64_or_percent_text_and_ignore_the_declared_type() {
    let temp = Temp::new();
    let store = Store::new(temp.0.join("data")).unwrap();
    let sessions = Service::new(support::store().client());
    let (file, bytes) =
        materialize(&sessions, &store, "data:image/png;BASE64,aGVsbG8gZGF0YQ==").unwrap();
    assert_eq!(bytes, b"hello data");
    assert_eq!(file.mime, "text/plain".into());
    assert_eq!(file.name, None);
    let (_, bytes) = materialize(&sessions, &store, "data:,a%20b%E2%9C%93").unwrap();
    assert_eq!(bytes, "a b✓".as_bytes());
    for uri in [
        "data:text/plain;base64,aGk",
        "data:;base64,aGk=\n",
        "data:,bad%zz",
        "data:,%E2%9C",
        "data:no-comma",
    ] {
        assert_eq!(error(&sessions, &store, uri), "Invalid attachment data URL");
    }
}

#[test]
fn file_uris_read_files_line_ranges_and_directory_listings_with_typescript_errors() {
    let temp = Temp::new();
    let store = Store::new(temp.0.join("data")).unwrap();
    let sessions = Service::new(support::store().client());
    fs::write(temp.0.join("notes.txt"), "one\ntwo\nthree\nfour").unwrap();
    fs::create_dir_all(temp.0.join("folder/zeta")).unwrap();
    fs::write(temp.0.join("folder/beta.txt"), "b").unwrap();
    fs::write(temp.0.join("folder/Alpha.txt"), "a").unwrap();
    std::os::unix::fs::symlink(temp.0.join("notes.txt"), temp.0.join("folder/link")).unwrap();
    let notes = temp.uri("notes.txt");
    let (file, bytes) = materialize(&sessions, &store, &notes).unwrap();
    assert_eq!(bytes, b"one\ntwo\nthree\nfour");
    assert_eq!(
        (file.mime.clone(), file.name.clone()),
        ("text/plain".into(), Some("notes.txt".into()))
    );
    for (query, expected) in [
        ("?start=2&end=3", "two\nthree"),
        ("?start=3", "three\nfour"),
        ("?start=0x2&end=2", "two"),
        ("?start=0&end=2", "one\ntwo\nthree\nfour"),
        ("?start=2.5", "one\ntwo\nthree\nfour"),
        ("?start=9", ""),
        ("?start=3&end=2", ""),
        ("?start=2&end=3#ignored", "two\nthree"),
    ] {
        let (_, bytes) = materialize(&sessions, &store, &format!("{notes}{query}")).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), expected, "{query}");
    }
    let (folder, bytes) = materialize(&sessions, &store, &temp.uri("folder")).unwrap();
    assert_eq!(
        String::from_utf8(bytes).unwrap(),
        "zeta/\nAlpha.txt\nbeta.txt"
    );
    assert_eq!(
        (folder.mime, folder.name),
        ("application/x-directory".into(), Some("folder".into()))
    );
    let (folder, _) = materialize(
        &sessions,
        &store,
        &format!("{}?start=1", temp.uri("folder")),
    )
    .unwrap();
    assert_eq!(folder.mime, "application/x-directory".into());
    fs::write(
        temp.0.join("large.bin"),
        vec![b'x'; MAX_ATTACHMENT_BYTES + 1],
    )
    .unwrap();
    let missing = temp.uri("missing.txt");
    let large = temp.uri("large.bin");
    for (uri, message) in [
        (
            missing.clone(),
            format!("Unable to read attachment: {missing}"),
        ),
        (
            large.clone(),
            format!("Attachment exceeds the {MAX_ATTACHMENT_BYTES} byte limit: {large}"),
        ),
        (
            "not a uri".into(),
            "Invalid attachment URI: not a uri".into(),
        ),
        (
            "https://example.com/a".into(),
            "Unsupported attachment URI: https://example.com/a".into(),
        ),
        (
            "file:///tmp/a%2Fb".into(),
            "Invalid file URI: file:///tmp/a%2Fb".into(),
        ),
        (
            "file://remote.example/a".into(),
            "Invalid file URI: file://remote.example/a".into(),
        ),
        (
            "file:///dev/null".into(),
            "Attachment is not a file: file:///dev/null".into(),
        ),
    ] {
        assert_eq!(error(&sessions, &store, &uri), message);
    }
    let named = sessions
        .materialize_attachment(
            &store,
            Limits::default(),
            Input {
                uri: notes.as_str().into(),
                name: Some("chosen".into()),
                description: Some("why".into()),
                mention: None,
            },
        )
        .unwrap();
    assert_eq!(
        (named.name, named.description),
        (Some("chosen".into()), Some("why".into()))
    );
}

#[test]
fn image_attachments_are_normalized_to_the_location_limits() {
    let temp = Temp::new();
    let store = Store::new(temp.0.join("data")).unwrap();
    let sessions = Service::new(support::store().client());
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/resources/image/portrait.png");
    fs::copy(&source, temp.0.join("portrait.png")).unwrap();
    let original = fs::read(&source).unwrap();
    let unchanged = sessions
        .materialize_attachment(&store, Limits::default(), input(&temp.uri("portrait.png")))
        .unwrap();
    assert_eq!(unchanged.mime, "image/png".into());
    assert_eq!(store.read(&unchanged.content).unwrap(), original);
    let limits = Limits {
        max_width: 8,
        max_height: 8,
        ..Limits::default()
    };
    let resized = sessions
        .materialize_attachment(&store, limits, input(&temp.uri("portrait.png")))
        .unwrap();
    assert_ne!(resized.content.digest, unchanged.content.digest);
    assert!(resized.mime.as_str().unwrap().starts_with("image/"));
    let refused = Limits {
        auto_resize: false,
        ..limits
    };
    assert!(
        error_with(&sessions, &store, refused, &temp.uri("portrait.png"))
            .contains("exceeding configured limits")
    );
}

fn error_with(sessions: &Service, store: &Store, limits: Limits, uri: &str) -> String {
    match sessions.materialize_attachment(store, limits, input(uri)) {
        Err(MaterializeError::Attachment(message)) => message,
        other => panic!("expected an attachment error, got {other:?}"),
    }
}

#[tokio::test]
async fn managed_uris_reuse_stored_content_and_fall_back_to_recorded_admissions() {
    let temp = Temp::new();
    let store = Store::new(temp.0.join("data")).unwrap();
    let database = support::store();
    let sessions = Service::new(database.client());
    let stored = store.import(b"stored once").unwrap();
    let uri = ycoding_core::resources::attachment_store::managed_uri(&stored);
    let (file, bytes) = materialize(&sessions, &store, &uri).unwrap();
    assert_eq!(
        (file.content.clone(), bytes),
        (stored.clone(), b"stored once".to_vec())
    );
    assert_eq!(file.mime, "text/plain".into());
    let recorded = store.import(b"recorded only").unwrap();
    sessions
        .admit(Request {
            id: session_message::Id::new("msg_recorded").unwrap(),
            session_id: session::Id::new("ses_one").unwrap(),
            input: session_pending::Message::decode(
                &parse_json(&format!(
                    r#"{{"type":"user","data":{{"text":"x","files":[{{"content":{},"mime":"image/png"}}]}},"delivery":"queue"}}"#,
                    stringify_json(&recorded.encode())
                ))
                .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_recorded").unwrap(),
            created: 1,
        })
        .await
        .unwrap();
    fs::remove_file(store.absolute_path(&recorded).unwrap()).unwrap();
    let recorded_uri = ycoding_core::resources::attachment_store::managed_uri(&recorded);
    let fallback = sessions
        .materialize_attachment(&store, Limits::default(), input(&recorded_uri))
        .unwrap();
    assert_eq!(fallback.content, recorded);
    assert_eq!(fallback.mime, LosslessString::from("image/png"));
    let unknown = format!("ycoding-attachment://sha256/{}", "0".repeat(64));
    assert!(matches!(
        sessions.materialize_attachment(&store, Limits::default(), input(&unknown)),
        Err(MaterializeError::Attachment(_))
    ));
}
