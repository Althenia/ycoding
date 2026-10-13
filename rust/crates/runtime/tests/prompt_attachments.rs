#![cfg(unix)]
mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use prost::{Message, Name};
use remote_derived_support::{Fixture, now, world};
use std::{fs, path::Path, sync::Arc};
use support::{operation, session_scope, text, units};
use ycoding_core::{
    resources::{attachment_store, reference},
    ycoding_schema::{DomainDecode, parse_json, session},
};
use ycoding_protocol::{decode_strict, v5};
use ycoding_runtime::{
    Environment, Settled,
    connector::{Credential, Enrolled, Peer},
    standard,
};

fn peer() -> Peer {
    Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "owner-a".into(), "device-a".into()).unwrap(),
        &Credential::new(
            "stand-in-token".into(),
            now() + 60_000,
            "owner-a".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap()
}

fn request(name: &str, session: &str, payload: Vec<u8>) -> v5::Request {
    v5::Request {
        request_id: "request-a".into(),
        operation_id: operation(name).operation_id,
        scope: session_scope(session),
        payload,
    }
}

fn prompt(session: &str, id: &str, uris: &[&str]) -> Vec<u8> {
    v5::SessionPromptRequest {
        params: v5::SessionPromptRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionPromptRequestPayload {
            id: Some(text(id)),
            text: text("see attachments"),
            files: Some(v5::SessionPromptRequestPayloadFiles {
                items: uris
                    .iter()
                    .map(|uri| v5::PromptInputFileAttachment {
                        uri: text(uri),
                        name: None,
                        description: None,
                        mention: None,
                    })
                    .collect(),
            }),
            agents: None,
            metadata: None,
            delivery: Some(v5::SessionPromptRequestPayloadDelivery::Queue as i32),
            resume: Some(false),
        },
    }
    .encode_to_vec()
}

fn upload(id: &str, index: u64, offset: u64, last: bool, data: &[u8]) -> Vec<u8> {
    v5::SessionAttachmentUploadRequest {
        payload: v5::SessionAttachmentUploadRequestPayload {
            upload_id: text(id),
            index,
            last,
            data: data.to_vec(),
            offset,
        },
    }
    .encode_to_vec()
}

fn success<T: Message + Name + Default>(settled: Option<Settled>) -> T {
    let Some(Settled::Result(result)) = settled else {
        panic!("expected inline result");
    };
    let outcome = result.outcome.unwrap();
    let v5::result::Outcome::Success(payload) = outcome else {
        panic!("expected success, got {outcome:?}");
    };
    assert_eq!(payload.type_name, T::full_name());
    decode_strict(&payload.payload).unwrap()
}

fn failure<E: Message + Name + Default>(settled: Option<Settled>) -> E {
    let Some(Settled::Result(result)) = settled else {
        panic!("expected inline result");
    };
    let Some(v5::result::Outcome::Error(payload)) = result.outcome else {
        panic!("expected failure");
    };
    assert_eq!(payload.type_name, E::full_name());
    decode_strict(&payload.payload).unwrap()
}

fn files(result: &v5::SessionPromptResult) -> Vec<(String, String, Option<String>)> {
    result
        .data
        .data
        .files
        .as_ref()
        .unwrap()
        .items
        .iter()
        .map(|file| {
            (
                units(&file.content.digest),
                units(&file.mime),
                file.name.as_ref().map(units),
            )
        })
        .collect()
}

async fn read(environment: &Arc<Environment>, session: &str, digest: &str) -> Vec<u8> {
    let settled = standard()
        .unwrap()
        .invoke(
            environment.clone(),
            "local".into(),
            request(
                "session.attachment.read",
                session,
                v5::SessionAttachmentReadRequest {
                    params: v5::SessionAttachmentReadRequestParams {
                        session_id: text(session),
                        digest: text(digest),
                    },
                }
                .encode_to_vec(),
            ),
        )
        .await;
    let Some(Settled::Asset { bulk, .. }) = settled else {
        panic!("expected an attachment asset");
    };
    bulk.body
}

fn uri(path: &Path) -> String {
    url::Url::from_file_path(path).unwrap().into()
}

fn managed_files(fixture: &Fixture) -> usize {
    fn count(path: &Path) -> usize {
        fs::read_dir(path).map_or(0, |entries| {
            entries
                .map(|entry| entry.unwrap().path())
                .map(|path| if path.is_dir() { count(&path) } else { 1 })
                .sum()
        })
    }
    count(&fixture.path.join("data/ycoding/attachments"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_prompts_materialize_files_ranges_directories_data_urls_and_managed_uris_once() {
    let fixture = Fixture::new().await;
    let environment = fixture.environment(true);
    let dispatcher = standard().unwrap();
    fs::write(fixture.path.join("notes.txt"), "one\ntwo\nthree").unwrap();
    fs::create_dir_all(fixture.path.join("folder/zeta")).unwrap();
    fs::write(fixture.path.join("folder/beta.txt"), "b").unwrap();
    fs::write(fixture.path.join("folder/Alpha.txt"), "a").unwrap();
    let image = include_bytes!("../../core/src/resources/image/small.png");
    fs::write(fixture.path.join("small.png"), image).unwrap();
    let outside = fixture.path.with_extension("outside.txt");
    fs::write(&outside, "outside the Location").unwrap();
    let notes = format!("{}?start=2&end=3", uri(&fixture.path.join("notes.txt")));
    let folder = uri(&fixture.path.join("folder"));
    let picture = uri(&fixture.path.join("small.png"));
    let outside_uri = uri(&outside);
    let admitted: v5::SessionPromptResult = success(
        dispatcher
            .invoke(
                environment.clone(),
                "local".into(),
                request(
                    "session.prompt",
                    &fixture.root,
                    prompt(
                        &fixture.root,
                        "msg_attachments_local",
                        &[
                            &notes,
                            &folder,
                            "data:text/plain;base64,aGVsbG8gZGF0YQ==",
                            "data:,a%20b",
                            &picture,
                            &outside_uri,
                        ],
                    ),
                ),
            )
            .await,
    );
    let materialized = files(&admitted);
    let shape = materialized
        .iter()
        .map(|(_, mime, name)| (mime.as_str(), name.as_deref()))
        .collect::<Vec<_>>();
    let outside_name = outside.file_name().unwrap().to_str().unwrap().to_owned();
    assert_eq!(
        shape,
        [
            ("text/plain", Some("notes.txt")),
            ("application/x-directory", Some("folder")),
            ("text/plain", None),
            ("text/plain", None),
            ("image/png", Some("small.png")),
            ("text/plain", Some(outside_name.as_str())),
        ]
    );
    let mut bytes = Vec::new();
    for (digest, _, _) in &materialized {
        bytes.push(read(&environment, &fixture.root, digest).await);
    }
    assert_eq!(
        bytes,
        [
            b"two\nthree".to_vec(),
            b"zeta/\nAlpha.txt\nbeta.txt".to_vec(),
            b"hello data".to_vec(),
            b"a b".to_vec(),
            image.to_vec(),
            b"outside the Location".to_vec(),
        ]
    );
    let stored = managed_files(&fixture);
    let retried: v5::SessionPromptResult = success(
        dispatcher
            .invoke(
                environment.clone(),
                "local".into(),
                request(
                    "session.prompt",
                    &fixture.root,
                    prompt(
                        &fixture.root,
                        "msg_attachments_local",
                        &["data:,a retried attachment"],
                    ),
                ),
            )
            .await,
    );
    assert_eq!(retried, admitted, "the first admission owns the input ID");
    assert_eq!(managed_files(&fixture), stored, "a retry imports nothing");
    let reused_uri = format!("ycoding-attachment://sha256/{}", materialized[0].0);
    let reused: v5::SessionPromptResult = success(
        dispatcher
            .invoke(
                environment.clone(),
                "local".into(),
                request(
                    "session.prompt",
                    &fixture.other,
                    prompt(&fixture.other, "msg_attachments_reused", &[&reused_uri]),
                ),
            )
            .await,
    );
    assert_eq!(
        files(&reused),
        [(materialized[0].0.clone(), "text/plain".into(), None)]
    );
    assert_eq!(
        read(&environment, &fixture.other, &materialized[0].0).await,
        b"two\nthree"
    );
    fs::remove_file(outside).unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_prompt_attachment_failures_are_typed_file_errors_that_admit_nothing() {
    let fixture = Fixture::new().await;
    let environment = fixture.environment(true);
    let dispatcher = standard().unwrap();
    fs::write(
        fixture.path.join("large.bin"),
        vec![b'x'; attachment_store::MAX_BYTES + 1],
    )
    .unwrap();
    let missing = uri(&fixture.path.join("missing.txt"));
    let large = uri(&fixture.path.join("large.bin"));
    let unknown = format!("ycoding-attachment://sha256/{}", "0".repeat(64));
    for (index, (attachment, message)) in [
        (
            missing.clone(),
            format!("Unable to read attachment: {missing}"),
        ),
        (
            large.clone(),
            format!("Attachment exceeds the 20971520 byte limit: {large}"),
        ),
        (
            "https://example.com/x".into(),
            "Unsupported attachment URI: https://example.com/x".into(),
        ),
        (
            "data:text/plain;base64,aGk".into(),
            "Invalid attachment data URL".into(),
        ),
        (
            "file:///dev/null".into(),
            "Attachment is not a file: file:///dev/null".into(),
        ),
        (unknown, "Unable to access managed attachment".into()),
    ]
    .into_iter()
    .enumerate()
    {
        let id = format!("msg_attachments_failed_{index}");
        let error: v5::InvalidRequestError = failure(
            dispatcher
                .invoke(
                    environment.clone(),
                    "local".into(),
                    request(
                        "session.prompt",
                        &fixture.root,
                        prompt(&fixture.root, &id, &[&attachment]),
                    ),
                )
                .await,
        );
        assert_eq!(units(&error.message), message);
        assert_eq!(error.field.as_ref().map(units).as_deref(), Some("files"));
        assert!(
            world()
                .core
                .sessions
                .pending(
                    &ycoding_core::ycoding_schema::session_message::Id::new(id.as_str()).unwrap()
                )
                .unwrap()
                .is_none()
        );
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_prompts_attach_location_files_catalog_references_and_their_own_uploads_only() {
    let mut fixture = Fixture::new().await;
    let outside = fixture.path.with_extension("referenced.txt");
    fs::write(&outside, "referenced outside").unwrap();
    let unlisted = fixture.path.with_extension("unlisted.txt");
    fs::write(&unlisted, "not in the catalog").unwrap();
    fixture.catalogs.references = Arc::new(reference::Service::from_infos(vec![
        ycoding_core::ycoding_schema::reference::Info::decode(
            &parse_json(&format!(
                r#"{{"name":"guide","path":"{}","source":{{"type":"local","path":"{}"}}}}"#,
                outside.display(),
                outside.display()
            ))
            .unwrap(),
        )
        .unwrap(),
    ]));
    fs::write(fixture.path.join("inside.txt"), "inside the Location").unwrap();
    let environment = fixture.environment(true);
    let dispatcher = standard().unwrap();
    let id = "1b4e28ba-2fa1-4d3b-9b5a-3f2b8f6c9d10";
    let first: v5::SessionAttachmentUploadResult = success(
        dispatcher
            .invoke_remote(
                environment.clone(),
                "remote-a".into(),
                &peer(),
                request(
                    "session.attachment.upload",
                    &fixture.root,
                    upload(id, 0, 0, false, b"uploaded "),
                ),
            )
            .await,
    );
    assert_eq!(
        first.kind,
        Some(v5::session_attachment_upload_result::Kind::Value2(
            v5::SessionAttachmentUploadResultValue2 { received: 9 }
        ))
    );
    let order: v5::ConnectorError = failure(
        dispatcher
            .invoke_remote(
                environment.clone(),
                "remote-a".into(),
                &peer(),
                request(
                    "session.attachment.upload",
                    &fixture.root,
                    upload(id, 2, 9, true, b"bytes"),
                ),
            )
            .await,
    );
    assert_eq!(order.code, 1);
    let last: v5::SessionAttachmentUploadResult = success(
        dispatcher
            .invoke_remote(
                environment.clone(),
                "remote-a".into(),
                &peer(),
                request(
                    "session.attachment.upload",
                    &fixture.root,
                    upload(id, 1, 9, true, b"bytes"),
                ),
            )
            .await,
    );
    let Some(v5::session_attachment_upload_result::Kind::Value1(uploaded)) = last.kind else {
        panic!("the last chunk returns the upload reference");
    };
    let uploaded = units(&uploaded.uri);
    assert_eq!(uploaded, format!("ycoding-upload://{id}"));
    assert_eq!(environment.uploads.retained(), (1, 14));
    for (chunk, code) in [
        (upload("not-a-uuid", 0, 0, true, b"x"), 1),
        (
            upload("2b4e28ba-2fa1-4d3b-9b5a-3f2b8f6c9d10", 1, 0, true, b"x"),
            1,
        ),
    ] {
        let error: v5::ConnectorError = failure(
            dispatcher
                .invoke_remote(
                    environment.clone(),
                    "remote-a".into(),
                    &peer(),
                    request("session.attachment.upload", &fixture.root, chunk),
                )
                .await,
        );
        assert_eq!(error.code, code);
    }
    assert!(
        dispatcher
            .invoke(
                environment.clone(),
                "local".into(),
                request(
                    "session.attachment.upload",
                    &fixture.root,
                    upload(id, 0, 0, true, b"x"),
                ),
            )
            .await
            .is_none(),
        "uploads are a remote-only operation"
    );
    let inside = uri(&fixture.path.join("inside.txt"));
    let referenced = uri(&outside);
    let admitted: v5::SessionPromptResult = success(
        dispatcher
            .invoke_remote(
                environment.clone(),
                "remote-a".into(),
                &peer(),
                request(
                    "session.prompt",
                    &fixture.root,
                    prompt(
                        &fixture.root,
                        "msg_attachments_remote",
                        &[&uploaded, &inside, &referenced],
                    ),
                ),
            )
            .await,
    );
    let mut bytes = Vec::new();
    for (digest, _, _) in files(&admitted) {
        bytes.push(read(&environment, &fixture.root, &digest).await);
    }
    assert_eq!(
        bytes,
        [
            b"uploaded bytes".to_vec(),
            b"inside the Location".to_vec(),
            b"referenced outside".to_vec(),
        ]
    );
    let unlisted = uri(&unlisted);
    let managed = format!("ycoding-attachment://sha256/{}", files(&admitted)[0].0);
    let unstaged = "ycoding-upload://3b4e28ba-2fa1-4d3b-9b5a-3f2b8f6c9d10".to_owned();
    let outside = "Attachment is outside the Session Location and current catalog";
    let unavailable = "Attachment upload is unavailable or incomplete";
    for (index, (connection, session, attachment, message)) in [
        ("remote-b", &fixture.root, uploaded.as_str(), unavailable),
        ("remote-a", &fixture.other, uploaded.as_str(), unavailable),
        ("remote-a", &fixture.root, unstaged.as_str(), unavailable),
        ("remote-a", &fixture.root, unlisted.as_str(), outside),
        ("remote-a", &fixture.root, "data:,inline", outside),
        ("remote-a", &fixture.root, managed.as_str(), outside),
    ]
    .into_iter()
    .enumerate()
    {
        let error: v5::InvalidRequestError = failure(
            dispatcher
                .invoke_remote(
                    environment.clone(),
                    connection.into(),
                    &peer(),
                    request(
                        "session.prompt",
                        session,
                        prompt(
                            session,
                            &format!("msg_attachments_refused_{index}"),
                            &[attachment],
                        ),
                    ),
                )
                .await,
        );
        assert_eq!(units(&error.message), message, "{attachment}");
    }
    let local: v5::InvalidRequestError = failure(
        dispatcher
            .invoke(
                environment.clone(),
                "remote-a".into(),
                request(
                    "session.prompt",
                    &fixture.root,
                    prompt(&fixture.root, "msg_attachments_refused_local", &[&uploaded]),
                ),
            )
            .await,
    );
    assert_eq!(
        units(&local.message),
        format!("Unsupported attachment URI: {uploaded}")
    );
    assert_eq!(
        environment.uploads.retained(),
        (1, 14),
        "admission keeps the staged upload"
    );
    assert!(
        world()
            .core
            .sessions
            .pending_list(&session::Id::new(fixture.root.as_str()).unwrap())
            .unwrap()
            .iter()
            .all(|pending| !pending
                .id
                .as_str()
                .unwrap()
                .starts_with("msg_attachments_refused"))
    );
    assert!(
        world()
            .core
            .sessions
            .pending_list(&session::Id::new(fixture.other.as_str()).unwrap())
            .unwrap()
            .iter()
            .all(|pending| !pending
                .id
                .as_str()
                .unwrap()
                .starts_with("msg_attachments_refused"))
    );
    fs::remove_file(fixture.path.with_extension("referenced.txt")).unwrap();
    fs::remove_file(fixture.path.with_extension("unlisted.txt")).unwrap();
    fixture.close().await;
}
