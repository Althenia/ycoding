#![cfg(unix)]
mod support;
use prost::{Message, Name};
use std::{
    fs,
    ops::Bound,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use support::wire::{ask, location_scope, query, refuse};
use support::*;
use ycoding_core::ycoding_store::{KeyPart, project, tuple_key};
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
        Self::create(true, None).await
    }

    async fn create(recorded: bool, origin: Option<&str>) -> Self {
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
        if recorded {
            insert_project(&project, directory).await;
            insert_session_of(&project, &owner, directory, None).await;
            insert_session_of(&project, &other, directory, None).await;
        }
        if let Some(origin) = origin {
            for args in [
                &["init", "-q", "-b", "main"][..],
                &["config", "commit.gpgsign", "false"],
                &["config", "user.name", "Test"],
                &["config", "user.email", "test@ycoding.test"],
                &["commit", "-q", "--allow-empty", "-m", "root"],
            ] {
                git(&root, args);
            }
            if !origin.is_empty() {
                git(&root, &["remote", "add", "origin", origin]);
            }
        }
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
            tickets: Arc::new(Mutex::new(pty::ticket::Tickets::default())),
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
        services.core.as_mut().unwrap().roots = Some(self.roots.clone());
        services.core.as_mut().unwrap().attachments = Some(Arc::new(
            attachment_store::Store::new(self.roots.data.clone()).unwrap(),
        ));
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

fn git(cwd: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
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

#[tokio::test]
async fn cold_storage_and_metadata_reads_preserve_scope_and_location_query_validation() {
    use ycoding_runtime::{
        Environment, Settled, Subscriptions,
        connector::{Credential, Enrolled, Peer},
    };

    let fixture = Fixture::new().await;
    let standalone = format!("{}_standalone", fixture.owner);
    insert_session_of(
        &format!(
            "prj_resource{}",
            fixture.owner.trim_start_matches("ses_resource")
        ),
        &standalone,
        fixture.directory(),
        None,
    )
    .await;
    let standalone_key = LosslessString::from(standalone.as_str());
    world()
        .store
        .submit(move |tx| {
            use ycoding_core::ycoding_store::session::SessionTable;
            let mut row = tx
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&standalone_key)]))?
                .unwrap();
            row.scope = "standalone".into();
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .await
        .unwrap();
    let mut settings = services(LocalAuth::disabled(), true);
    let metadata = settings.core.as_mut().unwrap();
    metadata.roots = Some(fixture.roots.clone());
    let configuration = fixture.platform.config.clone();
    metadata.configuration = Some(Arc::new(move |_| Ok(configuration.clone())));
    metadata.platform = Some(Arc::new(|_| {
        Err("Cold read reached platform composition".into())
    }));
    metadata.catalogs = Some(Arc::new(|_| {
        Err("Cold read reached catalog composition".into())
    }));
    metadata.mcp = Some(Arc::new(
        |_| Err("Cold read reached MCP composition".into()),
    ));
    let environment = Arc::new(Environment {
        services: settings,
        urls: vec![],
        subscriptions: Subscriptions::default(),
        uploads: Default::default(),
    });
    let core = environment.services.core.as_ref().unwrap();
    let project = core
        .sessions
        .get(&ycoding_core::ycoding_schema::session::Id::new(fixture.owner.as_str()).unwrap())
        .unwrap()
        .unwrap()
        .project_id;
    let project_requests = |location: Option<v5::LocationQueryLocation>| {
        [
            (
                "project.current",
                v5::ProjectCurrentRequest {
                    query: v5::LocationQuery {
                        location: location.clone(),
                    },
                }
                .encode_to_vec(),
            ),
            (
                "project.directories",
                v5::ProjectDirectoriesRequest {
                    params: v5::ProjectDirectoriesRequestParams {
                        project_id: text(project.as_lossless().as_str().unwrap()),
                    },
                    query: v5::LocationQuery { location },
                }
                .encode_to_vec(),
            ),
        ]
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let peer = Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-cold".into()).unwrap(),
        &Credential::new(
            "cold-read-fixture".into(),
            now + 60_000,
            "https://relay.invalid".into(),
            "device-cold".into(),
        ),
        now,
    )
    .unwrap();
    let dispatcher = standard().unwrap();
    let cold = || {
        !core
            .locations
            .cached()
            .iter()
            .any(|(directory, _)| directory.as_str() == Some(fixture.directory()))
    };
    assert!(cold());
    for remote in [false, true] {
        let scope = if remote {
            session_scope(&fixture.owner)
        } else {
            location_scope(fixture.directory())
        };
        let mut cases = vec![(
            "session.todo.list",
            session_scope(&fixture.owner),
            v5::SessionTodoListRequest {
                params: v5::SessionTodoListRequestParams {
                    session_id: text(&fixture.owner),
                },
            }
            .encode_to_vec(),
            true,
        )];
        for (id, accepted) in [
            (fixture.owner.as_str(), true),
            ("ses_cold_missing", false),
            (standalone.as_str(), false),
        ] {
            cases.push((
                "session.instructions.entry.list",
                session_scope(id),
                v5::SessionInstructionsEntryListRequest {
                    params: v5::SessionInstructionsEntryListRequestParams {
                        session_id: text(id),
                    },
                }
                .encode_to_vec(),
                accepted,
            ));
        }
        if !remote {
            for (query, accepted) in [
                v5::LocationQuery { location: None },
                query(fixture.directory(), None),
                query("/different", None),
            ]
            .into_iter()
            .zip([true, true, false])
            {
                cases.push((
                    "config.diagnostics",
                    scope.clone(),
                    v5::ConfigDiagnosticsRequest {
                        query: query.clone(),
                    }
                    .encode_to_vec(),
                    accepted,
                ));
                cases.push((
                    "location.get",
                    scope.clone(),
                    v5::LocationGetRequest { query }.encode_to_vec(),
                    accepted,
                ));
            }
        }
        for (name, payload) in project_requests(None) {
            cases.push((name, scope.clone(), payload, true));
        }
        for location in [
            v5::LocationQueryLocation::default(),
            v5::LocationQueryLocation {
                directory: Some(text(fixture.directory())),
                workspace: None,
            },
            v5::LocationQueryLocation {
                directory: None,
                workspace: Some(text("wrk_cold_read")),
            },
        ] {
            for (name, payload) in project_requests(Some(location)) {
                cases.push((name, scope.clone(), payload, !remote));
            }
        }
        if remote {
            for (name, payload) in project_requests(None) {
                cases.push((
                    name,
                    session_scope("ses_cold_missing"),
                    payload.clone(),
                    false,
                ));
                cases.push((
                    name,
                    v5::Scope {
                        target: Some(v5::scope::Target::Workspace("wrk_cold_unadvertised".into())),
                    },
                    payload,
                    false,
                ));
            }
            cases.push((
                "session.todo.list",
                session_scope("ses_cold_missing"),
                v5::SessionTodoListRequest {
                    params: v5::SessionTodoListRequestParams {
                        session_id: text("ses_cold_missing"),
                    },
                }
                .encode_to_vec(),
                false,
            ));
        } else {
            for location in [
                v5::LocationQueryLocation {
                    directory: Some(text("/different")),
                    workspace: None,
                },
                v5::LocationQueryLocation {
                    directory: None,
                    workspace: Some(text("invalid-workspace")),
                },
            ] {
                for (name, payload) in project_requests(Some(location)) {
                    cases.push((name, scope.clone(), payload, false));
                }
            }
            for (name, payload) in project_requests(None) {
                cases.push((name, machine(), payload.clone(), false));
                cases.push((name, location_scope("relative-directory"), payload, false));
            }
        }
        for (name, scope, payload, accepted) in cases {
            let request = v5::Request {
                request_id: format!("cold-{name}"),
                operation_id: operation(name).operation_id,
                scope,
                payload,
            };
            let settled = if remote {
                dispatcher
                    .invoke_remote(
                        environment.clone(),
                        "cold-connection".into(),
                        &peer,
                        request,
                    )
                    .await
            } else {
                dispatcher
                    .invoke(environment.clone(), "cold-connection".into(), request)
                    .await
            };
            let roles = &operation(name).roles;
            let permitted = if remote {
                roles.contains(&(v5::PeerRole::Relay as i32))
                    && roles.contains(&(v5::PeerRole::RemoteClient as i32))
            } else {
                roles.contains(&(v5::PeerRole::LocalClient as i32))
            };
            if !permitted {
                assert!(settled.is_none(), "disallowed role dispatched {name}");
                continue;
            }
            let outcome = match settled {
                Some(Settled::Result(result)) => result.outcome.unwrap(),
                Some(Settled::Bulk(bulk)) => {
                    assert_eq!(operation(name).streaming, v5::Streaming::TypedBulk as i32);
                    assert_eq!(bulk.content_kind, v5::ContentKind::TypedMessage);
                    v5::result::Outcome::Success(v5::TypedPayload {
                        type_name: bulk.type_name,
                        payload: bulk.body,
                    })
                }
                _ => panic!("missing settlement for {name}"),
            };
            match (accepted, outcome) {
                (true, v5::result::Outcome::Success(payload)) => {
                    assert_eq!(payload.type_name, operation(name).result_type);
                    if name == "session.todo.list" {
                        assert!(
                            v5::SessionTodoListResult::decode(payload.payload.as_slice())
                                .unwrap()
                                .data
                                .items
                                .is_empty()
                        );
                    }
                    if name == "session.instructions.entry.list" {
                        assert!(
                            v5::SessionInstructionsEntryListResult::decode(
                                payload.payload.as_slice()
                            )
                            .unwrap()
                            .data
                            .items
                            .is_empty()
                        );
                    }
                    if name == "location.get" {
                        let location = v5::LocationGetResult::decode(payload.payload.as_slice())
                            .unwrap()
                            .data;
                        assert_eq!(units(&location.directory), fixture.directory());
                        assert_eq!(
                            units(&location.backend_paths.unwrap().config),
                            fixture.roots.config.to_str().unwrap()
                        );
                    }
                    if name == "config.diagnostics" {
                        assert!(
                            v5::ConfigDiagnosticsResult::decode(payload.payload.as_slice())
                                .unwrap()
                                .data
                                .items
                                .is_empty()
                        );
                    }
                    if name == "project.current" {
                        let current =
                            v5::ProjectCurrentResult::decode(payload.payload.as_slice()).unwrap();
                        assert_eq!(units(&current.data.directory), fixture.directory());
                        assert_eq!(
                            units(&current.data.id),
                            project.as_lossless().as_str().unwrap()
                        );
                    }
                }
                (false, v5::result::Outcome::Error(payload)) => {
                    assert!(operation(name).error_types.contains(&payload.type_name));
                }
                _ => panic!("unexpected result for {name}, remote={remote}, accepted={accepted}"),
            }
            assert!(cold(), "{name} acquired Location services, remote={remote}");
        }
    }
    fixture.shutdown().await;
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

fn location_get(fixture: &Fixture) -> v5::LocationGetRequest {
    v5::LocationGetRequest {
        query: query(fixture.directory(), None),
    }
}

fn project_row(id: &str) -> Option<project::Project> {
    world()
        .store
        .snapshot()
        .unwrap()
        .get::<project::ProjectTable>(&tuple_key(&[KeyPart::String(&id.into())]))
        .unwrap()
}

fn directory_rows(directory: &str) -> Vec<project::Directory> {
    world()
        .store
        .snapshot()
        .unwrap()
        .scan::<project::DirectoryTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
        .into_iter()
        .filter(|row| row.directory.as_str() == Some(directory))
        .collect()
}

const OPENED_REMOTE: &str = "git@github.com:resource-ops/opened.git";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn location_get_opens_and_records_a_never_seen_directory_once_with_its_filesystem_identity() {
    let fixture = Fixture::create(false, Some(OPENED_REMOTE)).await;
    let id = ycoding_core::platform::project_identity::remote_id(OPENED_REMOTE).unwrap();
    assert!(project_row(&id).is_none());
    let (server, mut client) = fixture.open().await;
    let mut recorded = Vec::new();
    for _ in 0..2 {
        let location: v5::LocationGetResult = ask(
            &mut client,
            "location.get",
            location_scope(fixture.directory()),
            location_get(&fixture),
        )
        .await;
        assert_eq!(units(&location.data.project.id), id);
        assert_eq!(units(&location.data.project.directory), fixture.directory());
        recorded.push((
            project_row(&id).unwrap(),
            directory_rows(fixture.directory()),
        ));
    }
    assert_eq!(
        recorded[0], recorded[1],
        "recording an opened directory is idempotent"
    );
    let (project, directories) = &recorded[0];
    assert_eq!(project.worktree.as_str(), Some(fixture.directory()));
    assert_eq!(
        project.vcs.as_ref().and_then(LosslessString::as_str),
        Some("git")
    );
    assert!(project.sandboxes.is_empty());
    assert_eq!(directories.len(), 1);
    assert_eq!(directories[0].project_id.as_str(), Some(id.as_str()));
    assert_eq!(
        (
            directories[0].type_.clone(),
            directories[0].strategy.clone()
        ),
        (None, None)
    );
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_create_in_a_never_seen_directory_records_its_resolved_project_and_opened_directory()
 {
    let origin = "https://github.com/resource-ops/created.git";
    let fixture = Fixture::create(false, Some(origin)).await;
    let id = ycoding_core::platform::project_identity::remote_id(origin).unwrap();
    let (server, mut client) = fixture.open().await;
    let created: v5::SessionCreateResult = ask(
        &mut client,
        "session.create",
        location_scope(fixture.directory()),
        v5::SessionCreateRequest {
            payload: v5::SessionCreateRequestPayload {
                location: Some(v5::LocationRef {
                    directory: text(fixture.directory()),
                    workspace_id: None,
                }),
                ..Default::default()
            },
        },
    )
    .await;
    assert_eq!(units(&created.data.project_id), id);
    assert_eq!(units(&created.data.location.directory), fixture.directory());
    assert_eq!(created.data.subpath, None);
    let project = project_row(&id).unwrap();
    assert_eq!(project.worktree.as_str(), Some(fixture.directory()));
    assert_eq!(
        project.vcs.as_ref().and_then(LosslessString::as_str),
        Some("git")
    );
    let directories = directory_rows(fixture.directory());
    assert_eq!(directories.len(), 1);
    assert_eq!(directories[0].project_id.as_str(), Some(id.as_str()));
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recorded_projects_keep_their_ids_and_matching_rows_take_the_filesystem_directory() {
    let imported = Fixture::create(false, Some("")).await;
    let imported_id = format!("prj_imported_{}", imported.owner);
    insert_project(&imported_id, imported.directory()).await;
    let (server, mut client) = imported.open().await;
    let location: v5::LocationGetResult = ask(
        &mut client,
        "location.get",
        location_scope(imported.directory()),
        location_get(&imported),
    )
    .await;
    assert_eq!(units(&location.data.project.id), imported_id);
    assert_eq!(
        units(&location.data.project.directory),
        imported.directory()
    );
    let directories = directory_rows(imported.directory());
    assert_eq!(directories.len(), 1);
    assert_eq!(
        directories[0].project_id.as_str(),
        Some(imported_id.as_str())
    );
    drop(client);
    server.shutdown().await.unwrap();
    imported.shutdown().await;

    let matching = Fixture::create(false, Some("")).await;
    let root = git(&matching.root, &["rev-list", "--max-parents=0", "HEAD"]);
    insert_project(&root, "/recorded/elsewhere").await;
    let row = project::Directory {
        project_id: root.as_str().into(),
        directory: matching.directory().into(),
        type_: Some("copy".into()),
        strategy: Some("git_worktree".into()),
        time_created: 1,
    };
    world()
        .store
        .submit(move |tx| tx.put::<project::DirectoryTable>(&row))
        .unwrap()
        .await
        .unwrap();
    let (server, mut client) = matching.open().await;
    let location: v5::LocationGetResult = ask(
        &mut client,
        "location.get",
        location_scope(matching.directory()),
        location_get(&matching),
    )
    .await;
    assert_eq!(units(&location.data.project.id), root);
    assert_eq!(
        units(&location.data.project.directory),
        matching.directory()
    );
    assert_eq!(
        project_row(&root).unwrap().worktree.as_str(),
        Some("/recorded/elsewhere")
    );
    drop(client);
    server.shutdown().await.unwrap();
    matching.shutdown().await;
}
