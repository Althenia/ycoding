#![cfg(unix)]
mod support;
use prost::{Message, Name};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use support::wire::{ask, location_scope, query, refuse};
use support::*;
use ycoding_core::{
    platform::{filesystem, git, project_copy, pty, shell},
    resources::{
        attachment_store,
        config::{Configuration, LoadOptions, Roots},
    },
    ycoding_schema::{
        DomainEncode, LosslessString, prompt::ManagedAttachmentContent, stringify_json,
    },
};
use ycoding_protocol::{connection::Outcome, v5};
use ycoding_runtime::{LocalAuth, PlatformServices, Server, ServiceSet, standard};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    roots: Roots,
    owner: String,
    other: String,
    platform: Arc<PlatformServices>,
}

impl Fixture {
    async fn new() -> Self {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("ycoding-resource-ops-{}-{n}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("source")).unwrap();
        fs::write(root.join("source/notes.txt"), "resource notes").unwrap();
        std::os::unix::fs::symlink(root.parent().unwrap(), root.join("outside")).unwrap();
        let directory = root.to_str().unwrap();
        let project = format!("prj_resource{n}");
        let owner = format!("ses_resource{n}");
        let other = format!("ses_resource_other{n}");
        insert_project(&project, directory).await;
        insert_session_of(&project, &owner, directory, None).await;
        insert_session_of(&project, &other, directory, None).await;
        let roots = Roots::development(&root).unwrap();
        let config = Arc::new(
            Configuration::load(LoadOptions {
                directory: root.clone(),
                roots: roots.clone(),
                project: false,
                file: None,
                content: Some("{\"shell\":\"/bin/sh\"}".into()),
                env: Default::default(),
            })
            .unwrap(),
        );
        let search = Arc::new(
            filesystem::search::Service::new(&root, filesystem::search::Backend::Fff).unwrap(),
        );
        let git = Arc::new(git::Service::new(16 * 1024 * 1024));
        let copies = Arc::new(
            project_copy::Copies::new(
                &root,
                git.clone(),
                world().store.clone(),
                Arc::new(|_| Ok(())),
            )
            .unwrap(),
        );
        let platform = Arc::new(PlatformServices {
            shell: Arc::new(
                shell::Shell::new(&roots, root.clone(), &project, world().store.clone())
                    .await
                    .unwrap(),
            ),
            pty: Arc::new(pty::Pty::new(root.clone())),
            tickets: Mutex::new(pty::ticket::Tickets::default()),
            config,
            filesystem: Arc::new(filesystem::Location::new(&root).unwrap()),
            search,
            git,
            copies,
        });
        Self {
            root,
            roots,
            owner,
            other,
            platform,
        }
    }

    fn directory(&self) -> &str {
        self.root.to_str().unwrap()
    }

    async fn open(&self) -> (Server, Client) {
        let mut services = services(LocalAuth::disabled(), true);
        let platform = self.platform.clone();
        let directory = self.directory().to_owned();
        services.core.as_mut().unwrap().platform = Some(Arc::new(move |location| {
            if location.directory.as_lossless().as_str() != Some(&directory)
                || location.workspace_id.is_some()
            {
                return Err("Unknown platform Location".into());
            }
            Ok(platform.clone())
        }));
        let server = start(services, standard().unwrap()).await;
        let client = Client::open(server.address(), &[]).await.unwrap();
        (server, client)
    }

    async fn user_message(
        &self,
        session: &str,
        id: &str,
        files: &[(&ManagedAttachmentContent, &str)],
    ) {
        let files = files
            .iter()
            .map(|(content, mime)| {
                format!(
                    r#"{{"content":{},"mime":"{mime}","name":"note"}}"#,
                    stringify_json(&content.encode())
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        insert_message(
            session,
            id,
            "user",
            1,
            &format!(
                r#"{{"text":"see files","time":{{"created":1,"consumed":1}},"files":[{files}]}}"#
            ),
        )
        .await;
    }

    async fn shutdown(&self) {
        self.platform.shell.shutdown().await.unwrap();
        self.platform.pty.shutdown().await.unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn fs_read(path: &str, directory: Option<&str>) -> Vec<u8> {
    v5::FsReadRequest {
        params: v5::PlatformAssetPath { path: text(path) },
        query: v5::LocationQuery {
            location: directory.map(|directory| v5::LocationQueryLocation {
                directory: Some(text(directory)),
                workspace: None,
            }),
        },
    }
    .encode_to_vec()
}

fn attachment(session: &str, digest: &str) -> v5::SessionAttachmentReadRequest {
    v5::SessionAttachmentReadRequest {
        params: v5::SessionAttachmentReadRequestParams {
            session_id: text(session),
            digest: text(digest),
        },
    }
}

fn digest(content: &ManagedAttachmentContent) -> String {
    content.digest.0.to_utf8().unwrap()
}

fn asset(outcome: Outcome) -> (v5::AssetMetadataResult, Vec<u8>) {
    let Outcome::AssetSuccess {
        metadata, bytes, ..
    } = outcome
    else {
        panic!("asset success expected, got {outcome:?}")
    };
    ((*metadata).clone(), bytes.to_vec())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_read_serves_location_files_and_rejects_escapes_directories_and_scope_mismatch() {
    let fixture = Fixture::new().await;
    fs::write(
        fixture
            .root
            .parent()
            .unwrap()
            .join(format!("{}-sibling.txt", fixture.owner)),
        "outside",
    )
    .unwrap();
    let (server, mut client) = fixture.open().await;
    let (metadata, bytes) = asset(
        client
            .call(
                "fs.read",
                location_scope(fixture.directory()),
                fs_read("source/notes.txt", None),
            )
            .await,
    );
    assert_eq!(bytes, b"resource notes");
    assert_eq!(units(&metadata.mime), "text/plain");
    assert_eq!(metadata.byte_count, 14);
    assert_eq!(metadata.metadata.type_name, "ycoding.v5.fs_read_Result");
    let explicit = asset(
        client
            .call(
                "fs.read",
                location_scope(fixture.directory()),
                fs_read("./source/../source/notes.txt", Some(fixture.directory())),
            )
            .await,
    );
    assert_eq!(explicit.1, b"resource notes");
    let sibling = format!("../{}-sibling.txt", fixture.owner);
    let absolute = fixture
        .root
        .parent()
        .unwrap()
        .join(format!("{}-sibling.txt", fixture.owner));
    for (path, directory) in [
        (sibling.as_str(), None),
        (absolute.to_str().unwrap(), None),
        ("outside/whatever", None),
        ("source", None),
        ("source/missing.txt", None),
        ("source/notes.txt", Some("/elsewhere")),
    ] {
        let payload = rejected(
            client
                .call(
                    "fs.read",
                    location_scope(fixture.directory()),
                    fs_read(path, directory),
                )
                .await,
        );
        assert_eq!(
            payload.type_name,
            v5::InvalidRequestError::full_name(),
            "{path}"
        );
    }
    let forbidden = v5::InvalidRequestError::decode(
        rejected(
            client
                .call(
                    "fs.read",
                    location_scope(fixture.directory()),
                    fs_read(&sibling, None),
                )
                .await,
        )
        .payload
        .as_slice(),
    )
    .unwrap();
    assert_eq!(
        forbidden.kind.as_ref().map(units).as_deref(),
        Some("forbidden")
    );
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn location_get_reports_location_project_and_backend_roots_only_on_that_read() {
    let fixture = Fixture::new().await;
    let (server, mut client) = fixture.open().await;
    let location: v5::LocationGetResult = ask(
        &mut client,
        "location.get",
        location_scope(fixture.directory()),
        v5::LocationGetRequest {
            query: query(fixture.directory(), None),
        },
    )
    .await;
    assert_eq!(units(&location.data.directory), fixture.directory());
    assert_eq!(location.data.workspace_id, None);
    assert_eq!(units(&location.data.project.directory), fixture.directory());
    assert!(units(&location.data.project.id).starts_with("prj_resource"));
    let paths = location.data.backend_paths.unwrap();
    assert_eq!(units(&paths.home), fixture.roots.home.to_str().unwrap());
    assert_eq!(units(&paths.state), fixture.roots.state.to_str().unwrap());
    assert_eq!(
        units(&paths.worktree),
        fixture.roots.data.join("worktree").to_str().unwrap()
    );
    assert_eq!(units(&paths.config), fixture.roots.config.to_str().unwrap());
    let listed: v5::FsListResult = ask(
        &mut client,
        "fs.list",
        location_scope(fixture.directory()),
        v5::FsListRequest {
            query: v5::FsListRequestQuery {
                location: None,
                path: None,
            },
        },
    )
    .await;
    assert_eq!(listed.location.backend_paths, None);
    let _: v5::InvalidRequestError = refuse(
        &mut client,
        "location.get",
        location_scope(fixture.directory()),
        v5::LocationGetRequest {
            query: query("/elsewhere", None),
        },
    )
    .await;
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_attachment_read_serves_only_that_sessions_verified_managed_bytes() {
    let fixture = Fixture::new().await;
    let store = attachment_store::Store::new(fixture.roots.data.clone()).unwrap();
    let sent = store.import(b"attached bytes").unwrap();
    let foreign = store.import(b"another session").unwrap();
    let tampered = store.import(b"original").unwrap();
    let target = store.absolute_path(&tampered).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&target, b"modified").unwrap();
    let mut oversized = sent.clone();
    oversized.digest =
        ycoding_core::ycoding_schema::prompt::AttachmentDigest("e".repeat(64).into());
    oversized.path = format!("attachments/sha256/ee/{}", "e".repeat(64)).into();
    oversized.bytes =
        ycoding_core::ycoding_schema::schema::NonNegativeInt::new(10 * 1024 * 1024 + 1).unwrap();
    fixture
        .user_message(
            &fixture.owner,
            &format!("msg_{}_files", fixture.owner),
            &[
                (&sent, "text/plain"),
                (&tampered, "text/plain"),
                (&oversized, "application/octet-stream"),
            ],
        )
        .await;
    fixture
        .user_message(
            &fixture.other,
            &format!("msg_{}_files", fixture.other),
            &[(&foreign, "text/plain")],
        )
        .await;
    let (server, mut client) = fixture.open().await;
    let (metadata, bytes) = asset(
        client
            .call(
                "session.attachment.read",
                session_scope(&fixture.owner),
                attachment(&fixture.owner, &digest(&sent)).encode_to_vec(),
            )
            .await,
    );
    assert_eq!(bytes, b"attached bytes");
    assert_eq!(units(&metadata.mime), "text/plain");
    assert_eq!(
        metadata.metadata.type_name,
        "ycoding.v5.session_attachment_read_Result"
    );
    let unknown = "0".repeat(64);
    for missing in [digest(&foreign), unknown, digest(&tampered)] {
        let error: v5::AttachmentNotFoundError = refuse(
            &mut client,
            "session.attachment.read",
            session_scope(&fixture.owner),
            attachment(&fixture.owner, &missing),
        )
        .await;
        assert_eq!(
            units(&error.message),
            "Attachment not found in this Session"
        );
    }
    let _: v5::AttachmentTooLargeError = refuse(
        &mut client,
        "session.attachment.read",
        session_scope(&fixture.owner),
        attachment(&fixture.owner, &digest(&oversized)),
    )
    .await;
    for invalid in [
        digest(&sent).to_uppercase(),
        attachment_store::managed_uri(&sent),
    ] {
        let _: v5::InvalidRequestError = refuse(
            &mut client,
            "session.attachment.read",
            session_scope(&fixture.owner),
            attachment(&fixture.owner, &invalid),
        )
        .await;
    }
    let _: v5::SessionNotFoundError = refuse(
        &mut client,
        "session.attachment.read",
        session_scope("ses_resource_unknown"),
        attachment("ses_resource_unknown", &digest(&sent)),
    )
    .await;
    let _: v5::InvalidRequestError = refuse(
        &mut client,
        "session.attachment.read",
        session_scope(&fixture.other),
        attachment(&fixture.owner, &digest(&sent)),
    )
    .await;
    let (_, foreign_bytes) = asset(
        client
            .call(
                "session.attachment.read",
                session_scope(&fixture.other),
                attachment(&fixture.other, &digest(&foreign)).encode_to_vec(),
            )
            .await,
    );
    assert_eq!(foreign_bytes, b"another session");
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn debug_location_evict_drops_the_cache_key_while_held_leases_stay_usable() {
    let fixture = Fixture::new().await;
    let (server, mut client) = fixture.open().await;
    let directory: LosslessString = fixture.directory().into();
    let locations = world().core.locations.clone();
    let listed = |result: &v5::DebugLocationResult| {
        result.items.iter().any(|item| {
            units(&item.directory) == fixture.directory() && item.workspace_id.is_none()
        })
    };
    let before: v5::DebugLocationResult = ask(
        &mut client,
        "debug.location",
        machine(),
        v5::DebugLocationRequest {},
    )
    .await;
    assert!(!listed(&before));
    let held = locations.location(&directory, None).unwrap();
    let cached = locations.location(&directory, None).unwrap();
    assert!(std::ptr::eq::<ServiceSet>(&**held, &**cached));
    drop(cached);
    let present: v5::DebugLocationResult = ask(
        &mut client,
        "debug.location",
        machine(),
        v5::DebugLocationRequest {},
    )
    .await;
    assert!(listed(&present));
    let evicted: v5::DebugLocationEvictResult = ask(
        &mut client,
        "debug.location.evict",
        location_scope(&format!("{}/source/..", fixture.directory())),
        v5::DebugLocationEvictRequest {
            query: v5::LocationQuery { location: None },
        },
    )
    .await;
    assert_eq!(evicted.data, v5::Empty {});
    let after: v5::DebugLocationResult = ask(
        &mut client,
        "debug.location",
        machine(),
        v5::DebugLocationRequest {},
    )
    .await;
    assert!(!listed(&after));
    assert_eq!(held.info.directory.as_lossless(), &directory);
    assert!(held.permissions.list().is_empty());
    let rebuilt = locations.location(&directory, None).unwrap();
    assert!(!std::ptr::eq::<ServiceSet>(&**held, &**rebuilt));
    assert_eq!(rebuilt.info.project.id, held.info.project.id);
    assert!(
        world()
            .core
            .sessions
            .get(&ycoding_core::ycoding_schema::session::Id::new(fixture.owner.as_str()).unwrap())
            .unwrap()
            .is_some()
    );
    let _: v5::DebugLocationEvictResult = ask(
        &mut client,
        "debug.location.evict",
        location_scope("/never/acquired"),
        v5::DebugLocationEvictRequest {
            query: query("/never/acquired", None),
        },
    )
    .await;
    let _: v5::InvalidRequestError = refuse(
        &mut client,
        "debug.location.evict",
        location_scope(fixture.directory()),
        v5::DebugLocationEvictRequest {
            query: query("/elsewhere", None),
        },
    )
    .await;
    drop(rebuilt);
    drop(held);
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}
