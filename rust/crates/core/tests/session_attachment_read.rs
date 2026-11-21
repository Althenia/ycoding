#![cfg(unix)]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::attachment_store::Store;
use ycoding_core::session::{
    attachment_read::{MAX_READ_BYTES, ReadError},
    pending::Request,
    store::Service,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, LosslessString, parse_json, prompt::ManagedAttachmentContent,
    session, session_message, session_pending,
};
use ycoding_store::session::{Message, MessageTable};

#[path = "session_support/mod.rs"]
mod support;

#[path = "session_support/checkpoint.rs"]
mod checkpoint;

#[tokio::test]
async fn pruning_removes_only_the_session_attachment_reference_not_the_file() {
    let temp = Temp::new();
    let attachments = Store::new(temp.0.join("data")).unwrap();
    let store = support::store();
    let sessions = Service::new(store.client());
    let scenario = checkpoint::scenario(&store.client(), &sessions, "ses_one", 1).await;
    let content = attachments.import(b"covered attachment").unwrap();
    let files = parse_json(&format!("[{}]", file(&content, "text/plain"))).unwrap();
    store
        .submit(move |tx| {
            let mut row = tx
                .get::<MessageTable>(&checkpoint::key(&scenario.ids.covered_user))?
                .unwrap();
            let ycoding_schema::JsonValue::Object(data) = &mut row.data else {
                panic!()
            };
            data.insert("files".into(), files);
            MessageTable::put(tx, &row)
        })
        .unwrap()
        .await
        .unwrap();
    let id = checkpoint::id("ses_one");
    assert_eq!(
        sessions
            .attachment_read(&attachments, &id, &digest(&content))
            .unwrap()
            .bytes,
        b"covered attachment"
    );
    assert!(
        sessions
            .prune_compacted(&id, 2, Vec::new)
            .await
            .unwrap()
            .messages
            > 0
    );
    assert!(matches!(
        sessions.attachment_read(&attachments, &id, &digest(&content)),
        Err(ReadError::NotFound)
    ));
    assert_eq!(attachments.read(&content).unwrap(), b"covered attachment");
}

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-attachment-read-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn file(content: &ManagedAttachmentContent, mime: &str) -> String {
    format!(
        r#"{{"content":{},"mime":"{mime}","name":"note"}}"#,
        ycoding_schema::stringify_json(&content.encode())
    )
}

fn digest(content: &ManagedAttachmentContent) -> LosslessString {
    content.digest.0.clone()
}

async fn user_message(store: &ycoding_store::Store, session: &str, id: &str, files: &[String]) {
    let row = Message {
        id: id.into(),
        session_id: session.into(),
        type_: "user".into(),
        seq: 1,
        time_created: 1,
        time_updated: 1,
        data: parse_json(&format!(
            r#"{{"text":"see files","time":{{"created":1,"consumed":1}},"files":[{}]}}"#,
            files.join(",")
        ))
        .unwrap(),
    };
    store
        .submit(move |tx| MessageTable::insert(tx, &row))
        .unwrap()
        .await
        .unwrap();
}

#[tokio::test]
async fn reads_only_managed_attachments_referenced_by_that_session() {
    let temp = Temp::new();
    let attachments = Store::new(temp.0.join("data")).unwrap();
    let store = support::store();
    let sessions = Service::new(store.client());
    let sent = attachments.import(b"sent with a message").unwrap();
    let queued = attachments.import(b"queued input").unwrap();
    let foreign = attachments.import(b"another session").unwrap();
    let unreferenced = attachments.import(b"never referenced").unwrap();
    user_message(&store, "ses_one", "msg_sent", &[file(&sent, "text/plain")]).await;
    user_message(
        &store,
        "ses_two",
        "msg_foreign",
        &[file(&foreign, "text/plain")],
    )
    .await;
    sessions
        .admit(Request {
            id: session_message::Id::new("msg_queued").unwrap(),
            session_id: session::Id::new("ses_one").unwrap(),
            input: session_pending::Message::decode(
                &parse_json(&format!(
                    r#"{{"type":"user","data":{{"text":"later","files":[{}]}},"delivery":"queue"}}"#,
                    file(&queued, "image/png")
                ))
                .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_queued").unwrap(),
            created: 2,
        })
        .await
        .unwrap();
    let one = session::Id::new("ses_one").unwrap();
    let read = sessions
        .attachment_read(&attachments, &one, &digest(&sent))
        .unwrap();
    assert_eq!(read.bytes, b"sent with a message");
    assert_eq!(read.mime, "text/plain".into());
    let read = sessions
        .attachment_read(&attachments, &one, &digest(&queued))
        .unwrap();
    assert_eq!(read.bytes, b"queued input");
    assert_eq!(read.mime, "image/png".into());
    for missing in [digest(&foreign), digest(&unreferenced)] {
        assert!(matches!(
            sessions.attachment_read(&attachments, &one, &missing),
            Err(ReadError::NotFound)
        ));
    }
    assert!(matches!(
        sessions.attachment_read(
            &attachments,
            &session::Id::new("ses_two").unwrap(),
            &digest(&foreign)
        ),
        Ok(read) if read.bytes == b"another session"
    ));
    assert!(matches!(
        sessions.attachment_read(
            &attachments,
            &session::Id::new("ses_unknown").unwrap(),
            &digest(&sent)
        ),
        Err(ReadError::SessionNotFound)
    ));
    let uppercase: LosslessString = digest(&sent).to_utf8().unwrap().to_uppercase().into();
    for invalid in [
        uppercase,
        format!(
            "ycoding-attachment://sha256/{}",
            digest(&sent).to_utf8().unwrap()
        )
        .into(),
        "".into(),
    ] {
        assert!(matches!(
            sessions.attachment_read(&attachments, &one, &invalid),
            Err(ReadError::InvalidDigest)
        ));
    }
}

#[tokio::test]
async fn tampered_references_and_files_read_as_not_found_and_size_is_capped_before_reading() {
    let temp = Temp::new();
    let attachments = Store::new(temp.0.join("data")).unwrap();
    let store = support::store();
    let sessions = Service::new(store.client());
    let modified = attachments.import(b"original bytes").unwrap();
    let relocated = attachments.import(b"relocated").unwrap();
    let limit = attachments
        .import(&vec![7; MAX_READ_BYTES as usize])
        .unwrap();
    let target = attachments.absolute_path(&modified).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&target, b"modified bytes").unwrap();
    let mut moved = relocated.clone();
    moved.path = format!(
        "attachments/sha256/00/{}",
        digest(&relocated).to_utf8().unwrap()
    )
    .into();
    let mut oversized = modified.clone();
    oversized.digest = ycoding_schema::prompt::AttachmentDigest("f".repeat(64).into());
    oversized.path = format!("attachments/sha256/ff/{}", "f".repeat(64)).into();
    oversized.bytes = ycoding_schema::schema::NonNegativeInt::new(MAX_READ_BYTES + 1).unwrap();
    user_message(
        &store,
        "ses_one",
        "msg_tampered",
        &[
            file(&modified, "text/plain"),
            file(&moved, "text/plain"),
            file(&oversized, "application/octet-stream"),
            file(&limit, "application/octet-stream"),
        ],
    )
    .await;
    let one = session::Id::new("ses_one").unwrap();
    for tampered in [digest(&modified), digest(&relocated)] {
        assert!(matches!(
            sessions.attachment_read(&attachments, &one, &tampered),
            Err(ReadError::NotFound)
        ));
    }
    assert!(matches!(
        sessions.attachment_read(&attachments, &one, &digest(&oversized)),
        Err(ReadError::TooLarge)
    ));
    assert_eq!(
        sessions
            .attachment_read(&attachments, &one, &digest(&limit))
            .unwrap()
            .bytes
            .len() as i64,
        MAX_READ_BYTES
    );
}
