#![cfg(unix)]
mod support;
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use support::wire::{ask, location_scope, query, refuse};
use support::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};
use ycoding_core::{
    platform::{filesystem, git, project_copy, pty, shell},
    resources::config::{Configuration, LoadOptions, Roots},
    tools::policy::Event,
    ycoding_schema::{DomainDecode, DomainEncode, JsonValue, shell::Status},
    ycoding_store::{
        KeyPart,
        project::{Directory, DirectoryTable},
        tuple_key,
    },
};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, PlatformServices, Server, standard};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    owner: String,
    other: String,
    project: String,
    platform: Arc<PlatformServices>,
    events: Arc<Mutex<Vec<Event>>>,
}
impl Fixture {
    async fn new() -> Self {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("ycoding-wire-platform-{}-{n}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("source")).unwrap();
        fs::write(root.join("source/a.ts"), "a").unwrap();
        fs::write(root.join("z.ts"), "z").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/ignored.ts"), "ignored").unwrap();
        let directory = root.to_str().unwrap();
        let project = format!("prj_platform{n}");
        let owner = format!("ses_platform{n}");
        let other = format!("ses_platform_other{n}");
        insert_project(&project, directory).await;
        insert_session_of(&project, &owner, directory, None).await;
        insert_session_of(&project, &other, directory, None).await;
        let row = Directory {
            project_id: project.clone().into(),
            directory: directory.into(),
            type_: Some("root".into()),
            strategy: None,
            time_created: 1,
        };
        world()
            .store
            .submit(move |tx| tx.put::<DirectoryTable>(&row))
            .unwrap()
            .await
            .unwrap();
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
        let scanned = search.clone();
        assert!(
            tokio::task::spawn_blocking(move || scanned.wait_for_scan(WAIT))
                .await
                .unwrap()
        );
        let git = Arc::new(git::Service::new(16 * 1024 * 1024));
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let copies = Arc::new(
            project_copy::Copies::new(
                &root,
                git.clone(),
                world().store.clone(),
                Arc::new(move |event| {
                    sink.lock().unwrap().push(event);
                    Ok(())
                }),
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
            owner,
            other,
            project,
            platform,
            events,
        }
    }
    fn directory(&self) -> &str {
        self.root.to_str().unwrap()
    }
    fn scope(&self) -> v5::Scope {
        location_scope(self.directory())
    }
    fn owned(&self, owner: &str) -> v5::PtyOwnedLocationQuery {
        v5::PtyOwnedLocationQuery {
            location: Some(v5::PtyOwnedLocationQueryLocation {
                directory: Some(text(self.directory())),
                workspace: None,
            }),
            session_id: text(owner),
        }
    }
    async fn open(&self) -> (Server, Client) {
        let mut services = services(LocalAuth::with_password("platform-test"), true);
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
        services.core.as_mut().unwrap().platform_default_location =
            Some(ycoding_core::ycoding_schema::location::Ref {
                directory: ycoding_core::ycoding_schema::schema::AbsolutePath::new(
                    self.directory(),
                )
                .unwrap(),
                workspace_id: None,
            });
        let server = start(services, standard().unwrap()).await;
        let client = Client::open(
            server.address(),
            &[("Authorization", basic("platform-test"))],
        )
        .await
        .unwrap();
        (server, client)
    }
    async fn shutdown(&self) {
        self.platform.shell.shutdown().await.unwrap();
        self.platform.pty.shutdown().await.unwrap();
    }
    async fn shell(&self, client: &mut Client, command: &str, timeout: u64) -> v5::ShellInfo {
        ask::<_, v5::ShellCreateResult>(
            client,
            "shell.create",
            self.scope(),
            v5::ShellCreateRequest {
                query: query(self.directory(), None),
                payload: v5::ShellCreateRequestPayload {
                    command: text(command),
                    cwd: None,
                    timeout,
                    memory_limit_mb: Some(0),
                    metadata: None,
                },
            },
        )
        .await
        .data
    }
    async fn pty(&self, client: &mut Client, command: &str, args: Vec<&str>) -> v5::Pty {
        ask::<_, v5::PtyCreateResult>(
            client,
            "pty.create",
            self.scope(),
            v5::PtyCreateRequest {
                query: query(self.directory(), None),
                payload: v5::PtyCreateRequestPayload {
                    session_id: text(&self.owner),
                    command: Some(text(command)),
                    args: Some(v5::PtyCreateRequestPayloadArgs {
                        items: args.into_iter().map(text).collect(),
                    }),
                    ..Default::default()
                },
            },
        )
        .await
        .data
    }
    fn git(&self, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().into()
    }
    fn repository(&self) {
        self.git(&["init", "-b", "main"]);
        self.git(&["config", "user.name", "Test"]);
        self.git(&["config", "user.email", "test@ycoding.test"]);
        self.git(&["config", "commit.gpgsign", "false"]);
        self.git(&["commit", "--allow-empty", "-m", "initial"]);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_wire_pages_utf8_and_malformed_capture_by_bytes_and_removes_exited_shell() {
    let fixture = Fixture::new().await;
    let (server, mut client) = fixture.open().await;
    let info = fixture
        .shell(
            &mut client,
            "printf '\\303\\251\\342\\202\\254\\360\\237\\230\\200\\342A\\303\\251\\360\\237\\230'",
            0,
        )
        .await;
    let id =
        ycoding_core::ycoding_schema::shell::Id::decode(&JsonValue::String(units(&info.id).into()))
            .unwrap();
    let exited = fixture.platform.shell.wait(&id).await.unwrap();
    assert_eq!(exited.status, Status::Exited);
    let bytes = fs::read(units(&info.file)).unwrap();
    for limit in [1, 2, 3, 4, 5, 13, 65536] {
        let mut cursor = 0;
        let mut joined = String::new();
        while cursor < bytes.len() as u64 {
            let page: v5::ShellOutputResult = ask(
                &mut client,
                "shell.output",
                fixture.scope(),
                v5::ShellOutputRequest {
                    params: v5::ShellOutputRequestParams {
                        id: info.id.clone(),
                    },
                    query: v5::ShellOutputRequestQuery {
                        location: None,
                        cursor: Some(cursor),
                        limit: Some(limit),
                    },
                },
            )
            .await;
            assert!(page.data.cursor > cursor && page.data.cursor - cursor <= limit + 3);
            assert_eq!(page.data.size, bytes.len() as u64);
            cursor = page.data.cursor;
            joined.push_str(&units(&page.data.output));
        }
        assert_eq!(joined, String::from_utf8_lossy(&bytes));
    }
    let zero: v5::ShellOutputResult = ask(
        &mut client,
        "shell.output",
        fixture.scope(),
        v5::ShellOutputRequest {
            params: v5::ShellOutputRequestParams {
                id: info.id.clone(),
            },
            query: v5::ShellOutputRequestQuery {
                location: None,
                cursor: Some(1),
                limit: Some(0),
            },
        },
    )
    .await;
    assert_eq!(zero.data.cursor, 1);
    assert_eq!(units(&zero.data.output), "");
    let beyond: v5::ShellOutputResult = ask(
        &mut client,
        "shell.output",
        fixture.scope(),
        v5::ShellOutputRequest {
            params: v5::ShellOutputRequestParams {
                id: info.id.clone(),
            },
            query: v5::ShellOutputRequestQuery {
                location: None,
                cursor: Some(999),
                limit: Some(1),
            },
        },
    )
    .await;
    assert_eq!(beyond.data.cursor, bytes.len() as u64);
    let list: v5::ShellListResult = ask(
        &mut client,
        "shell.list",
        fixture.scope(),
        v5::ShellListRequest {
            query: query(fixture.directory(), None),
        },
    )
    .await;
    assert!(list.data.items.is_empty());
    let get: v5::ShellGetResult = ask(
        &mut client,
        "shell.get",
        fixture.scope(),
        v5::ShellGetRequest {
            params: v5::ShellGetRequestParams {
                id: info.id.clone(),
            },
            query: query(fixture.directory(), None),
        },
    )
    .await;
    assert_eq!(get.data.status, v5::ShellInfoStatus::Exited as i32);
    assert_eq!(get.data.exit, Some(0.0));
    let _: v5::ShellRemoveResult = ask(
        &mut client,
        "shell.remove",
        fixture.scope(),
        v5::ShellRemoveRequest {
            params: v5::ShellRemoveRequestParams {
                id: info.id.clone(),
            },
            query: query(fixture.directory(), None),
        },
    )
    .await;
    assert!(!PathBuf::from(units(&info.file)).exists());
    let missing: v5::ShellNotFoundError = refuse(
        &mut client,
        "shell.get",
        fixture.scope(),
        v5::ShellGetRequest {
            params: v5::ShellGetRequestParams {
                id: info.id.clone(),
            },
            query: query(fixture.directory(), None),
        },
    )
    .await;
    assert_eq!(missing.id, info.id);
    for character in ["é", "€", "😀"] {
        for phase in 1..character.len() {
            let bytes = format!("{}{}z", "a".repeat(65536 - phase), character).into_bytes();
            fs::write(fixture.root.join("capture.bin"), &bytes).unwrap();
            let large = fixture.shell(&mut client, "cat capture.bin", 0).await;
            let id = ycoding_core::ycoding_schema::shell::Id::decode(&JsonValue::String(
                units(&large.id).into(),
            ))
            .unwrap();
            fixture.platform.shell.wait(&id).await.unwrap();
            let mut joined = String::new();
            let mut cursor = 0;
            while cursor < bytes.len() as u64 {
                let page: v5::ShellOutputResult = ask(
                    &mut client,
                    "shell.output",
                    fixture.scope(),
                    v5::ShellOutputRequest {
                        params: v5::ShellOutputRequestParams {
                            id: large.id.clone(),
                        },
                        query: v5::ShellOutputRequestQuery {
                            location: None,
                            cursor: Some(cursor),
                            limit: Some(65536),
                        },
                    },
                )
                .await;
                assert!(page.data.cursor - cursor <= 65539);
                cursor = page.data.cursor;
                joined.push_str(&units(&page.data.output));
            }
            assert_eq!(joined, String::from_utf8_lossy(&bytes));
        }
    }
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_wire_timeout_clear_replace_and_running_removal_share_tool_service() {
    let fixture = Fixture::new().await;
    let (server, mut client) = fixture.open().await;
    let info = fixture.shell(&mut client, "sleep 30", 0).await;
    let id =
        ycoding_core::ycoding_schema::shell::Id::decode(&JsonValue::String(units(&info.id).into()))
            .unwrap();
    let cleared: v5::ShellTimeoutResult = ask(
        &mut client,
        "shell.timeout",
        fixture.scope(),
        v5::ShellTimeoutRequest {
            params: v5::ShellTimeoutRequestParams {
                id: info.id.clone(),
            },
            query: query(fixture.directory(), None),
            payload: v5::ShellTimeoutRequestPayload { timeout: 0 },
        },
    )
    .await;
    assert_eq!(cleared.data.status, v5::ShellInfoStatus::Running as i32);
    let _: v5::ShellTimeoutResult = ask(
        &mut client,
        "shell.timeout",
        fixture.scope(),
        v5::ShellTimeoutRequest {
            params: v5::ShellTimeoutRequestParams {
                id: info.id.clone(),
            },
            query: query(fixture.directory(), None),
            payload: v5::ShellTimeoutRequestPayload { timeout: 10 },
        },
    )
    .await;
    assert_eq!(
        tokio::time::timeout(WAIT, fixture.platform.shell.wait(&id))
            .await
            .unwrap()
            .unwrap()
            .status,
        Status::Timeout
    );
    let running = fixture.shell(&mut client, "sleep 30", 0).await;
    assert!(
        fixture
            .platform
            .shell
            .list()
            .iter()
            .any(|item| item.id.encode() == JsonValue::String(units(&running.id).into()))
    );
    let _: v5::ShellRemoveResult = ask(
        &mut client,
        "shell.remove",
        fixture.scope(),
        v5::ShellRemoveRequest {
            params: v5::ShellRemoveRequestParams { id: running.id },
            query: query(fixture.directory(), None),
        },
    )
    .await;
    assert!(fixture.platform.shell.list().is_empty());
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_required_sandbox_answers_typed_service_unavailable_without_spawning() {
    let mut fixture = Fixture::new().await;
    let config = Configuration::load(LoadOptions {
        directory: fixture.root.clone(),
        roots: Roots::development(&fixture.root).unwrap(),
        project: false,
        file: None,
        content: Some("{\"shell\":\"/bin/sh\",\"shell_sandbox\":\"required\"}".into()),
        env: Default::default(),
    })
    .unwrap();
    Arc::get_mut(&mut fixture.platform).unwrap().config = Arc::new(config);
    let (server, mut client) = fixture.open().await;
    let error: v5::ServiceUnavailableError = refuse(
        &mut client,
        "shell.create",
        fixture.scope(),
        v5::ShellCreateRequest {
            query: query(fixture.directory(), None),
            payload: v5::ShellCreateRequestPayload {
                command: text("true"),
                timeout: 0,
                ..Default::default()
            },
        },
    )
    .await;
    assert_eq!(units(error.service.as_ref().unwrap()), "shell-sandbox");
    assert!(fixture.platform.shell.list().is_empty());
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_rejects_scope_mismatch_and_symlink_escape_while_shell_preserves_explicit_cwd() {
    let fixture = Fixture::new().await;
    std::os::unix::fs::symlink(fixture.root.parent().unwrap(), fixture.root.join("outside"))
        .unwrap();
    let (server, mut client) = fixture.open().await;
    let outside = fixture.root.parent().unwrap().to_str().unwrap();
    let shell: v5::ShellCreateResult = ask(
        &mut client,
        "shell.create",
        fixture.scope(),
        v5::ShellCreateRequest {
            query: query(fixture.directory(), None),
            payload: v5::ShellCreateRequestPayload {
                command: text("pwd"),
                cwd: Some(text(outside)),
                timeout: 0,
                memory_limit_mb: Some(0),
                metadata: None,
            },
        },
    )
    .await;
    let id = ycoding_core::ycoding_schema::shell::Id::decode(&JsonValue::String(
        units(&shell.data.id).into(),
    ))
    .unwrap();
    fixture.platform.shell.wait(&id).await.unwrap();
    assert_eq!(units(&shell.data.cwd), outside);
    let _: v5::InvalidRequestError = refuse(
        &mut client,
        "fs.list",
        fixture.scope(),
        v5::FsListRequest {
            query: v5::FsListRequestQuery {
                location: Some(v5::FsListRequestQueryLocation {
                    directory: Some(text("/elsewhere")),
                    workspace: None,
                }),
                path: None,
            },
        },
    )
    .await;
    let _: v5::InvalidRequestError = refuse(
        &mut client,
        "fs.list",
        fixture.scope(),
        v5::FsListRequest {
            query: v5::FsListRequestQuery {
                location: None,
                path: Some(text("outside")),
            },
        },
    )
    .await;
    assert!(fixture.platform.shell.list().is_empty());
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_wire_lists_sorted_direct_children_and_find_honors_type_limit_and_ignores() {
    let fixture = Fixture::new().await;
    let (server, mut client) = fixture.open().await;
    let list: v5::FsListResult = ask(
        &mut client,
        "fs.list",
        fixture.scope(),
        v5::FsListRequest {
            query: v5::FsListRequestQuery {
                location: None,
                path: Some(text("source")),
            },
        },
    )
    .await;
    assert_eq!(list.data.items.len(), 1);
    assert_eq!(units(&list.data.items[0].path), "source/a.ts");
    let find: v5::FsFindResult = ask(
        &mut client,
        "fs.find",
        fixture.scope(),
        v5::FsFindRequest {
            query: v5::FsFindRequestQuery {
                location: None,
                query: text("a.ts"),
                r#type: Some(v5::FsFindRequestQueryType::File as i32),
                limit: Some(1),
            },
        },
    )
    .await;
    assert_eq!(find.data.items.len(), 1);
    assert_eq!(units(&find.data.items[0].path), "source/a.ts");
    assert!(
        find.data
            .items
            .iter()
            .all(|item| item.r#type == v5::FileSystemEntryType::FilesystemEntryTypeFile as i32)
    );
    let ignored: v5::FsFindResult = ask(
        &mut client,
        "fs.find",
        fixture.scope(),
        v5::FsFindRequest {
            query: v5::FsFindRequestQuery {
                location: None,
                query: text("ignored.ts"),
                r#type: Some(v5::FsFindRequestQueryType::File as i32),
                limit: Some(10),
            },
        },
    )
    .await;
    assert!(ignored.data.items.is_empty());
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn vcs_wire_empty_nonrepository_and_git_status_branch_context_and_branch_diff() {
    let fixture = Fixture::new().await;
    let (server, mut client) = fixture.open().await;
    let empty: v5::VcsStatusResult = ask(
        &mut client,
        "vcs.status",
        fixture.scope(),
        v5::VcsStatusRequest {
            query: query(fixture.directory(), None),
        },
    )
    .await;
    assert!(empty.data.items.is_empty());
    let empty: v5::VcsBranchResult = ask(
        &mut client,
        "vcs.branch",
        fixture.scope(),
        v5::VcsBranchRequest {
            query: query(fixture.directory(), None),
        },
    )
    .await;
    assert!(empty.data.current.is_none() && empty.data.default.is_none());
    fixture.repository();
    fs::write(fixture.root.join("base.txt"), "a\nb\nc\nd\n").unwrap();
    fixture.git(&["add", "base.txt"]);
    fixture.git(&["commit", "-m", "base"]);
    fs::write(fixture.root.join("base.txt"), "a\nb\nchanged\nd\n").unwrap();
    fs::write(fixture.root.join("new.txt"), "new\n").unwrap();
    let branch: v5::VcsBranchResult = ask(
        &mut client,
        "vcs.branch",
        fixture.scope(),
        v5::VcsBranchRequest {
            query: query(fixture.directory(), None),
        },
    )
    .await;
    assert_eq!(units(branch.data.current.as_ref().unwrap()), "main");
    assert_eq!(units(branch.data.default.as_ref().unwrap()), "main");
    let status: v5::VcsStatusResult = ask(
        &mut client,
        "vcs.status",
        fixture.scope(),
        v5::VcsStatusRequest {
            query: query(fixture.directory(), None),
        },
    )
    .await;
    let base = status
        .data
        .items
        .iter()
        .find(|file| units(&file.file) == "base.txt")
        .unwrap();
    assert_eq!((base.additions, base.deletions), (1, 1));
    let diff: v5::VcsDiffResult = ask(
        &mut client,
        "vcs.diff",
        fixture.scope(),
        v5::VcsDiffRequest {
            query: v5::VcsDiffRequestQuery {
                location: None,
                mode: v5::VcsMode::Working as i32,
                context: Some(0),
            },
        },
    )
    .await;
    let patch = units(
        &diff
            .data
            .items
            .iter()
            .find(|file| units(&file.file) == "base.txt")
            .unwrap()
            .patch,
    );
    assert!(patch.contains("-c\n+changed"));
    assert!(!patch.contains(" a\n"));
    fixture.git(&["checkout", "-b", "feature"]);
    fixture.git(&["add", "base.txt", "new.txt"]);
    fixture.git(&["commit", "-m", "feature"]);
    let diff: v5::VcsDiffResult = ask(
        &mut client,
        "vcs.diff",
        fixture.scope(),
        v5::VcsDiffRequest {
            query: v5::VcsDiffRequestQuery {
                location: None,
                mode: v5::VcsMode::Branch as i32,
                context: None,
            },
        },
    )
    .await;
    assert!(
        diff.data
            .items
            .iter()
            .any(|file| units(&file.file) == "base.txt")
    );
    fixture.git(&["checkout", "--detach"]);
    let branch: v5::VcsBranchResult = ask(
        &mut client,
        "vcs.branch",
        fixture.scope(),
        v5::VcsBranchRequest {
            query: query(fixture.directory(), None),
        },
    )
    .await;
    assert!(branch.data.current.is_none());
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_copy_wire_persists_suffixes_force_error_and_refresh() {
    let fixture = Fixture::new().await;
    fixture.repository();
    let (server, mut client) = fixture.open().await;
    let create = |strategy: &str, parent: &str| v5::ProjectCopyCreateRequest {
        params: v5::ProjectCopyCreateRequestParams {
            project_id: text(&fixture.project),
        },
        query: query(fixture.directory(), None),
        payload: v5::ProjectCopyCreateRequestPayload {
            strategy: text(strategy),
            directory: text(parent),
            name: Some(text("copy")),
        },
    };
    let _: v5::ProjectCopyError = refuse(
        &mut client,
        "projectCopy.create",
        fixture.scope(),
        create("missing", fixture.directory()),
    )
    .await;
    let first: v5::ProjectCopyCreateResult = ask(
        &mut client,
        "projectCopy.create",
        fixture.scope(),
        create(
            "git_worktree",
            fixture.root.join("copies").to_str().unwrap(),
        ),
    )
    .await;
    let second: v5::ProjectCopyCreateResult = ask(
        &mut client,
        "projectCopy.create",
        fixture.scope(),
        create(
            "git_worktree",
            fixture.root.join("copies").to_str().unwrap(),
        ),
    )
    .await;
    assert!(units(&second.data.directory).ends_with("copy-2"));
    fs::write(
        PathBuf::from(units(&first.data.directory)).join("dirty.txt"),
        "dirty",
    )
    .unwrap();
    let remove = |directory: &v5::LosslessString, force| v5::ProjectCopyRemoveRequest {
        params: v5::ProjectCopyRemoveRequestParams {
            project_id: text(&fixture.project),
        },
        query: query(fixture.directory(), None),
        payload: v5::ProjectCopyRemoveRequestPayload {
            directory: directory.clone(),
            force,
        },
    };
    let error: v5::ProjectCopyError = refuse(
        &mut client,
        "projectCopy.remove",
        fixture.scope(),
        remove(&first.data.directory, false),
    )
    .await;
    assert_eq!(error.data.force_required, Some(true));
    let _: v5::ProjectCopyRemoveResult = ask(
        &mut client,
        "projectCopy.remove",
        fixture.scope(),
        remove(&first.data.directory, true),
    )
    .await;
    assert!(!PathBuf::from(units(&first.data.directory)).exists());
    let count = fixture.events.lock().unwrap().len();
    let refresh = || v5::ProjectCopyRefreshRequest {
        params: v5::ProjectCopyRefreshRequestParams {
            project_id: text(&fixture.project),
        },
        query: query(fixture.directory(), None),
    };
    let _: v5::ProjectCopyRefreshResult = ask(
        &mut client,
        "projectCopy.refresh",
        fixture.scope(),
        refresh(),
    )
    .await;
    assert_eq!(fixture.events.lock().unwrap().len(), count);
    fixture.git(&[
        "worktree",
        "remove",
        second
            .data
            .directory
            .encoding
            .as_ref()
            .and_then(|value| match value {
                v5::lossless_string::Encoding::Utf8(value) => Some(value.as_str()),
                _ => None,
            })
            .unwrap(),
    ]);
    let _: v5::ProjectCopyRefreshResult = ask(
        &mut client,
        "projectCopy.refresh",
        fixture.scope(),
        refresh(),
    )
    .await;
    let key = tuple_key(&[
        KeyPart::String(&fixture.project.clone().into()),
        KeyPart::String(&units(&second.data.directory).into()),
    ]);
    assert!(
        world()
            .store
            .snapshot()
            .unwrap()
            .get::<DirectoryTable>(&key)
            .unwrap()
            .is_none()
    );
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_copy_refresh_discovers_external_worktrees_prunes_missing_and_preserves_unknown_strategy()
 {
    let fixture = Fixture::new().await;
    fixture.repository();
    let outside = fixture.root.with_extension("external");
    fixture.git(&[
        "worktree",
        "add",
        "--detach",
        outside.to_str().unwrap(),
        "HEAD",
    ]);
    let unknown = fixture.root.join("unknown");
    fs::create_dir(&unknown).unwrap();
    let row = Directory {
        project_id: fixture.project.clone().into(),
        directory: unknown.to_str().unwrap().into(),
        type_: Some("copy".into()),
        strategy: Some("missing".into()),
        time_created: 1,
    };
    world()
        .store
        .submit(move |tx| tx.put::<DirectoryTable>(&row))
        .unwrap()
        .await
        .unwrap();
    let (server, mut client) = fixture.open().await;
    let refresh = || v5::ProjectCopyRefreshRequest {
        params: v5::ProjectCopyRefreshRequestParams {
            project_id: text(&fixture.project),
        },
        query: query(fixture.directory(), None),
    };
    let _: v5::ProjectCopyRefreshResult = ask(
        &mut client,
        "projectCopy.refresh",
        fixture.scope(),
        refresh(),
    )
    .await;
    let key = tuple_key(&[
        KeyPart::String(&fixture.project.clone().into()),
        KeyPart::String(&outside.to_str().unwrap().into()),
    ]);
    assert_eq!(
        world()
            .store
            .snapshot()
            .unwrap()
            .get::<DirectoryTable>(&key)
            .unwrap()
            .unwrap()
            .strategy
            .as_ref()
            .unwrap()
            .as_str(),
        Some("git_worktree")
    );
    let error: v5::ProjectCopyError = refuse(
        &mut client,
        "projectCopy.remove",
        fixture.scope(),
        v5::ProjectCopyRemoveRequest {
            params: v5::ProjectCopyRemoveRequestParams {
                project_id: text(&fixture.project),
            },
            query: query(fixture.directory(), None),
            payload: v5::ProjectCopyRemoveRequestPayload {
                directory: text(unknown.to_str().unwrap()),
                force: true,
            },
        },
    )
    .await;
    assert!(units(&error.data.message).contains("strategy unavailable"));
    assert!(unknown.is_dir());
    fixture.git(&["worktree", "remove", outside.to_str().unwrap()]);
    let _: v5::ProjectCopyRefreshResult = ask(
        &mut client,
        "projectCopy.refresh",
        fixture.scope(),
        refresh(),
    )
    .await;
    assert!(
        world()
            .store
            .snapshot()
            .unwrap()
            .get::<DirectoryTable>(&key)
            .unwrap()
            .is_none()
    );
    let count = fixture.events.lock().unwrap().len();
    let _: v5::ProjectCopyRefreshResult = ask(
        &mut client,
        "projectCopy.refresh",
        fixture.scope(),
        refresh(),
    )
    .await;
    assert_eq!(fixture.events.lock().unwrap().len(), count);
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_create_validates_session_location_and_reports_active_limit() {
    let fixture = Fixture::new().await;
    let (server, mut client) = fixture.open().await;
    let _: v5::SessionNotFoundError = refuse(
        &mut client,
        "pty.create",
        fixture.scope(),
        v5::PtyCreateRequest {
            query: query(fixture.directory(), None),
            payload: v5::PtyCreateRequestPayload {
                session_id: text("ses_get"),
                command: Some(text("/bin/cat")),
                ..Default::default()
            },
        },
    )
    .await;
    for _ in 0..8 {
        fixture.pty(&mut client, "/bin/cat", vec![]).await;
    }
    let error: v5::PtyResourceLimitError = refuse(
        &mut client,
        "pty.create",
        fixture.scope(),
        v5::PtyCreateRequest {
            query: query(fixture.directory(), None),
            payload: v5::PtyCreateRequestPayload {
                session_id: text(&fixture.owner),
                command: Some(text("/bin/cat")),
                ..Default::default()
            },
        },
    )
    .await;
    assert_eq!(units(&error.resource), "active");
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_wire_ownership_resize_control_stale_fences_exit_and_cleanup() {
    let fixture = Fixture::new().await;
    let (server, mut client) = fixture.open().await;
    let info = fixture.pty(&mut client, "/bin/cat", vec![]).await;
    let listed: v5::PtyListResult = ask(
        &mut client,
        "pty.list",
        fixture.scope(),
        v5::PtyListRequest {
            query: fixture.owned(&fixture.owner),
        },
    )
    .await;
    assert_eq!(listed.data.items.len(), 1);
    let other: v5::PtyListResult = ask(
        &mut client,
        "pty.list",
        fixture.scope(),
        v5::PtyListRequest {
            query: fixture.owned(&fixture.other),
        },
    )
    .await;
    assert!(other.data.items.is_empty());
    let _: v5::ForbiddenError = refuse(
        &mut client,
        "pty.get",
        fixture.scope(),
        v5::PtyGetRequest {
            params: v5::PtyGetRequestParams {
                pty_id: info.id.clone(),
            },
            query: fixture.owned(&fixture.other),
        },
    )
    .await;
    let resized: v5::PtyUpdateResult = ask(
        &mut client,
        "pty.update",
        fixture.scope(),
        v5::PtyUpdateRequest {
            params: v5::PtyUpdateRequestParams {
                pty_id: info.id.clone(),
            },
            query: query(fixture.directory(), None),
            payload: v5::PtyUpdateRequestPayload {
                session_id: text(&fixture.owner),
                generation: info.generation,
                expected_fence: info.control.fence,
                actor: v5::PtyUpdateRequestPayloadActor::Agent as i32,
                title: Some(text("resized")),
                size: Some(v5::PtySize {
                    rows: 32,
                    cols: 100,
                }),
            },
        },
    )
    .await;
    assert_eq!((resized.data.size.rows, resized.data.size.cols), (32, 100));
    assert_eq!(units(&resized.data.title), "resized");
    let control = |fence, action| v5::PtyControlRequest {
        params: v5::PtyControlRequestParams {
            pty_id: info.id.clone(),
        },
        query: query(fixture.directory(), None),
        payload: v5::PtyControlRequestPayload {
            session_id: text(&fixture.owner),
            generation: info.generation,
            expected_fence: fence,
            action,
        },
    };
    let taken: v5::PtyControlResult = ask(
        &mut client,
        "pty.control",
        fixture.scope(),
        control(
            info.control.fence,
            v5::PtyControlRequestPayloadAction::Take as i32,
        ),
    )
    .await;
    assert_eq!(taken.data.control.owner, v5::PtyControlOwner::User as i32);
    let _: v5::PtyConflictError = refuse(
        &mut client,
        "pty.control",
        fixture.scope(),
        control(
            info.control.fence,
            v5::PtyControlRequestPayloadAction::Pause as i32,
        ),
    )
    .await;
    let paused: v5::PtyControlResult = ask(
        &mut client,
        "pty.control",
        fixture.scope(),
        control(
            taken.data.control.fence,
            v5::PtyControlRequestPayloadAction::Pause as i32,
        ),
    )
    .await;
    assert_eq!(
        paused.data.control.owner,
        v5::PtyControlOwner::Paused as i32
    );
    let _: v5::PtyControlResult = ask(
        &mut client,
        "pty.control",
        fixture.scope(),
        control(
            paused.data.control.fence,
            v5::PtyControlRequestPayloadAction::Agent as i32,
        ),
    )
    .await;
    let _: v5::PtyRemoveResult = ask(
        &mut client,
        "pty.remove",
        fixture.scope(),
        v5::PtyRemoveRequest {
            params: v5::PtyRemoveRequestParams {
                pty_id: info.id.clone(),
            },
            query: fixture.owned(&fixture.owner),
        },
    )
    .await;
    let _: v5::PtyNotFoundError = refuse(
        &mut client,
        "pty.get",
        fixture.scope(),
        v5::PtyGetRequest {
            params: v5::PtyGetRequestParams { pty_id: info.id },
            query: fixture.owned(&fixture.owner),
        },
    )
    .await;
    let exited = fixture
        .pty(&mut client, "/bin/sh", vec!["-c", "exit 7"])
        .await;
    let id =
        ycoding_core::ycoding_schema::pty::Id::decode(&JsonValue::String(units(&exited.id).into()))
            .unwrap();
    let owner = ycoding_core::ycoding_schema::session_id::SessionId::decode(&JsonValue::String(
        fixture.owner.clone().into(),
    ))
    .unwrap();
    fixture.platform.pty.wait(&id, &owner).await.unwrap();
    let retained: v5::PtyGetResult = ask(
        &mut client,
        "pty.get",
        fixture.scope(),
        v5::PtyGetRequest {
            params: v5::PtyGetRequestParams { pty_id: exited.id },
            query: fixture.owned(&fixture.owner),
        },
    )
    .await;
    assert_eq!(retained.data.exit_code, Some(7));
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

fn encoded(input: &str) -> String {
    input
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
async fn external(
    address: std::net::SocketAddr,
    path: String,
    headers: &[(&str, String)],
) -> (Result<Socket, u16>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut input, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        loop {
            let byte = input.read_u8().await.unwrap();
            header.push(byte);
            if header.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let header = String::from_utf8(header).unwrap().replacen(
            "GET /ws/v5/local ",
            &format!("GET {path} "),
            1,
        );
        let mut output = TcpStream::connect(address).await.unwrap();
        output.write_all(header.as_bytes()).await.unwrap();
        let _ = tokio::io::copy_bidirectional(&mut input, &mut output).await;
    });
    (Socket::connect(proxy, headers).await, task)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_external_ticket_auth_single_use_origin_byte_stream_and_shutdown() {
    let fixture = Fixture::new().await;
    let (server, mut client) = fixture.open().await;
    let info = fixture.pty(&mut client, "/bin/cat", vec![]).await;
    let control: v5::PtyControlResult = ask(
        &mut client,
        "pty.control",
        fixture.scope(),
        v5::PtyControlRequest {
            params: v5::PtyControlRequestParams {
                pty_id: info.id.clone(),
            },
            query: query(fixture.directory(), None),
            payload: v5::PtyControlRequestPayload {
                session_id: text(&fixture.owner),
                generation: info.generation,
                expected_fence: info.control.fence,
                action: v5::PtyControlRequestPayloadAction::Take as i32,
            },
        },
    )
    .await;
    let request = || v5::PtyConnectTokenRequest {
        params: v5::PtyConnectTokenRequestParams {
            pty_id: info.id.clone(),
        },
        query: query(fixture.directory(), None),
        headers: v5::PtyConnectTokenRequestHeaders {
            x_ycoding_ticket: 1,
        },
        payload: v5::PtyConnectTokenRequestPayload {
            session_id: text(&fixture.owner),
            access:
                v5::PtyConnectTokenRequestPayloadAccess::PtyConnecttokenRequestPayloadAccessControl
                    as i32,
            generation: info.generation,
            expected_fence: Some(control.data.control.fence),
        },
    };
    let token: v5::PtyConnectTokenResult =
        ask(&mut client, "pty.connectToken", fixture.scope(), request()).await;
    let path = format!(
        "/api/pty/{}/connect?location[directory]={}&sessionID={}&access=control&generation=1e0&generation=999&fence={}.0&ticket={}",
        units(&info.id),
        encoded(fixture.directory()),
        fixture.owner,
        control.data.control.fence,
        units(&token.data.ticket)
    );
    let (forbidden, task) = external(
        server.address(),
        path.clone(),
        &[("Origin", "https://untrusted.invalid".into())],
    )
    .await;
    assert!(matches!(forbidden, Err(403)));
    task.await.unwrap();
    let (socket, task) = external(server.address(), path.clone(), &[]).await;
    let mut socket = socket.unwrap();
    assert!(
        matches!(socket.receive().await, Received::Binary(bytes) if matches!(pty::protocol::decode_server_frame(&bytes), Some(pty::protocol::ServerFrame::Control(pty::protocol::ControlFrame::Replay { .. }))))
    );
    socket.send_binary(&vec![b'x'; 65537]).await;
    socket.send_binary(b"hello\n").await;
    let mut bytes = Vec::new();
    while !String::from_utf8_lossy(&bytes).contains("hello") {
        match socket.receive().await {
            Received::Binary(frame) => {
                if let Some(pty::protocol::ServerFrame::Data(data)) =
                    pty::protocol::decode_server_frame(&frame)
                {
                    bytes.extend(data);
                }
            }
            _ => panic!("stream ended without bytes"),
        }
    }
    let (reused, retry) = external(server.address(), path, &[]).await;
    assert!(!bytes.contains(&b'x'));
    assert!(matches!(reused, Err(403)));
    retry.await.unwrap();
    drop(client);
    server.shutdown().await.unwrap();
    let mut ended = false;
    loop {
        match socket.receive().await {
            Received::Binary(frame) => {
                ended |= matches!(pty::protocol::decode_server_frame(&frame), Some(pty::protocol::ServerFrame::Control(pty::protocol::ControlFrame::End { reason, .. })) if reason == "service_shutdown")
            }
            Received::Close(code, _) => {
                assert_eq!(code, 1012);
                break;
            }
            Received::Eof => panic!("missing shutdown close"),
        }
    }
    assert!(ended);
    drop(socket);
    task.await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_external_expired_ticket_and_stale_control_are_rejected() {
    let fixture = Fixture::new().await;
    let (server, mut client) = fixture.open().await;
    let info = fixture.pty(&mut client, "/bin/cat", vec![]).await;
    *fixture.platform.tickets.lock().unwrap() = pty::ticket::Tickets::new(Duration::ZERO);
    let token: v5::PtyConnectTokenResult = ask(&mut client, "pty.connectToken", fixture.scope(), v5::PtyConnectTokenRequest { params: v5::PtyConnectTokenRequestParams { pty_id: info.id.clone() }, query: query(fixture.directory(), None), headers: v5::PtyConnectTokenRequestHeaders { x_ycoding_ticket: 1 }, payload: v5::PtyConnectTokenRequestPayload { session_id: text(&fixture.owner), access: v5::PtyConnectTokenRequestPayloadAccess::PtyConnecttokenRequestPayloadAccessInspect as i32, generation: info.generation, expected_fence: None } }).await;
    let path = format!(
        "/api/pty/{}/connect?sessionID={}&access=inspect&generation=1&ticket={}",
        units(&info.id),
        fixture.owner,
        units(&token.data.ticket)
    );
    let (expired, task) = external(server.address(), path, &[]).await;
    assert!(matches!(expired, Err(403)));
    task.await.unwrap();
    let _: v5::PtyConflictError = refuse(&mut client, "pty.connectToken", fixture.scope(), v5::PtyConnectTokenRequest { params: v5::PtyConnectTokenRequestParams { pty_id: info.id.clone() }, query: query(fixture.directory(), None), headers: v5::PtyConnectTokenRequestHeaders { x_ycoding_ticket: 1 }, payload: v5::PtyConnectTokenRequestPayload { session_id: text(&fixture.owner), access: v5::PtyConnectTokenRequestPayloadAccess::PtyConnecttokenRequestPayloadAccessControl as i32, generation: info.generation, expected_fence: Some(info.control.fence) } }).await;
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_wire_reports_queue_position_and_removes_queued_shells() {
    let fixture = Fixture::new().await;
    let (server, mut client) = fixture.open().await;
    let enqueue = |command: &'static str| {
        let fixture = &fixture;
        async move {
            let input = ycoding_core::ycoding_schema::shell::CreateInput::decode(
                &ycoding_core::ycoding_schema::parse_json(&format!(
                    r#"{{"command":"{command}","timeout":0}}"#
                ))
                .unwrap(),
            )
            .unwrap();
            let mut prepared = fixture
                .platform
                .shell
                .prepare(input, &fixture.platform.config)
                .unwrap();
            fixture
                .platform
                .shell
                .enqueue(&mut prepared, "ses_wire_queue", None)
                .await
                .unwrap()
        }
    };
    let holder = enqueue("sleep 30").await;
    let waiting = enqueue("printf queued").await;
    assert_eq!(waiting.status, Status::Queued);
    let holder_id = text_of(&holder.id);
    let waiting_id = text_of(&waiting.id);
    let mut get = async |id: String| {
        ask::<_, v5::ShellGetResult>(
            &mut client,
            "shell.get",
            fixture.scope(),
            v5::ShellGetRequest {
                params: v5::ShellGetRequestParams { id: text(&id) },
                query: query(fixture.directory(), None),
            },
        )
        .await
        .data
    };
    for _ in 0..500 {
        if get(holder_id.clone()).await.status == v5::ShellInfoStatus::Running as i32 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let running = get(holder_id.clone()).await;
    assert_eq!(running.status, v5::ShellInfoStatus::Running as i32);
    assert!(running.queue_position.is_none());
    assert!(running.time.queued.is_some());
    let queued = get(waiting_id.clone()).await;
    assert_eq!(queued.status, v5::ShellInfoStatus::Queued as i32);
    assert_eq!(queued.queue_position, Some(1));
    assert!(queued.pid.is_none() && queued.exit.is_none() && queued.time.queued.is_none());
    let list: v5::ShellListResult = ask(
        &mut client,
        "shell.list",
        fixture.scope(),
        v5::ShellListRequest {
            query: query(fixture.directory(), None),
        },
    )
    .await;
    let mut listed: Vec<_> = list
        .data
        .items
        .iter()
        .map(|item| (units(&item.id), item.status))
        .collect();
    listed.sort();
    let mut expected = vec![
        (holder_id.clone(), v5::ShellInfoStatus::Running as i32),
        (waiting_id.clone(), v5::ShellInfoStatus::Queued as i32),
    ];
    expected.sort();
    assert_eq!(listed, expected);
    let _: v5::ShellRemoveResult = ask(
        &mut client,
        "shell.remove",
        fixture.scope(),
        v5::ShellRemoveRequest {
            params: v5::ShellRemoveRequestParams {
                id: text(&waiting_id),
            },
            query: query(fixture.directory(), None),
        },
    )
    .await;
    let missing: v5::ShellNotFoundError = refuse(
        &mut client,
        "shell.get",
        fixture.scope(),
        v5::ShellGetRequest {
            params: v5::ShellGetRequestParams {
                id: text(&waiting_id),
            },
            query: query(fixture.directory(), None),
        },
    )
    .await;
    assert_eq!(units(&missing.id), waiting_id);
    let _: v5::ShellRemoveResult = ask(
        &mut client,
        "shell.remove",
        fixture.scope(),
        v5::ShellRemoveRequest {
            params: v5::ShellRemoveRequestParams {
                id: text(&holder_id),
            },
            query: query(fixture.directory(), None),
        },
    )
    .await;
    drop(client);
    server.shutdown().await.unwrap();
    fixture.shutdown().await;
}

fn text_of(id: &ycoding_core::ycoding_schema::shell::Id) -> String {
    match id.encode() {
        JsonValue::String(value) => value.to_utf8().unwrap(),
        other => panic!("{other:?}"),
    }
}
