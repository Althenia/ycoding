mod support;

use std::time::Duration;
use support::{wire::*, *};
use ycoding_protocol::v5;

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

#[derive(Default)]
struct Create<'a> {
    id: Option<&'a str>,
    parent: Option<&'a str>,
    agent: Option<&'a str>,
    model: Option<v5::ModelRef>,
    directory: Option<&'a str>,
}

fn request(create: Create) -> v5::SessionCreateRequest {
    v5::SessionCreateRequest {
        payload: v5::SessionCreateRequestPayload {
            id: create.id.map(text),
            parent_id: create.parent.map(text),
            agent: create.agent.map(text),
            model: create.model,
            location: create.directory.map(|directory| v5::LocationRef {
                directory: text(directory),
                workspace_id: None,
            }),
            title: None,
            scope: None,
        },
    }
}

fn model(profile: Option<&str>) -> v5::ModelRef {
    v5::ModelRef {
        id: text("m1"),
        provider_id: text("p1"),
        variant: Some(text("high")),
        profile: profile.map(text),
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ycoding-create-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::canonicalize(path).unwrap()
}

fn path_text(path: &std::path::Path) -> &str {
    path.to_str().unwrap()
}

fn opened(directory: &str) -> bool {
    world()
        .core
        .sessions
        .project_directories(&"global".into())
        .unwrap()
        .iter()
        .any(|entry| entry.directory.as_lossless().as_str() == Some(directory))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sessions_are_created_in_a_recorded_location_with_agent_model_and_a_stable_identity() {
    bounded(async {
        let root = scratch("recorded");
        let project = root.join("project");
        let recorded = project.join("sub/dir");
        std::fs::create_dir_all(&recorded).unwrap();
        let recorded = path_text(&recorded);
        insert_project("prj_create", path_text(&project)).await;
        insert_session_of("prj_create", "ses_create_seed", recorded, None).await;
        let (server, mut client) = open().await;
        let scope = location_scope(recorded);

        let created: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            scope.clone(),
            request(Create {
                agent: Some("build"),
                model: Some(model(None)),
                directory: Some(recorded),
                ..Create::default()
            }),
        )
        .await;
        let info = &created.data;
        let id = units(&info.id);
        assert!(id.starts_with("ses_"), "{id}");
        assert_eq!(units(info.agent.as_ref().unwrap()), "build");
        assert_eq!(units(&info.project_id), "prj_create");
        assert_eq!(units(&info.location.directory), recorded);
        assert_eq!(units(info.subpath.as_ref().unwrap()), "sub/dir");
        let chosen = info.model.as_ref().unwrap();
        assert_eq!(units(&chosen.id), "m1");
        assert_eq!(units(&chosen.provider_id), "p1");
        assert_eq!(units(chosen.variant.as_ref().unwrap()), "high");
        assert!(chosen.profile.is_none());
        let title = units(&info.title);
        assert!(title.starts_with("New session - 20"), "{title}");
        assert!(title.ends_with('Z') && title.len() == 38, "{title}");

        let fetched: v5::SessionGetResult = ask(
            &mut client,
            "session.get",
            session_scope(&id),
            v5::SessionGetRequest {
                params: v5::SessionGetRequestParams {
                    session_id: text(&id),
                },
            },
        )
        .await;
        assert_eq!(fetched.data, created.data);

        let retried: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            scope.clone(),
            request(Create {
                id: Some(&id),
                agent: Some("other"),
                directory: Some(recorded),
                ..Create::default()
            }),
        )
        .await;
        assert_eq!(
            retried.data, created.data,
            "the first creation owns the identity"
        );

        let child: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope("/never/used"),
            request(Create {
                parent: Some(&id),
                ..Create::default()
            }),
        )
        .await;
        assert_eq!(units(child.data.parent_id.as_ref().unwrap()), id);
        assert_eq!(units(&child.data.location.directory), recorded);
        assert_eq!(units(&child.data.model.as_ref().unwrap().id), "m1");

        let missing: v5::SessionNotFoundError = refuse(
            &mut client,
            "session.create",
            scope.clone(),
            request(Create {
                parent: Some("ses_create_missing"),
                ..Create::default()
            }),
        )
        .await;
        assert_eq!(units(&missing.session_id), "ses_create_missing");
        let decision: v5::InvalidRequestError = refuse(
            &mut client,
            "session.create",
            scope.clone(),
            request(Create {
                agent: Some("decision"),
                directory: Some(recorded),
                ..Create::default()
            }),
        )
        .await;
        assert_eq!(units(decision.field.as_ref().unwrap()), "agent");
        let missing = root.join("never/recorded");
        assert!(!missing.exists());
        let unrecorded: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(&format!("{}/never/./recorded/", path_text(&root))),
            request(Create {
                directory: Some(&format!("{}/never/./recorded/", path_text(&root))),
                ..Create::default()
            }),
        )
        .await;
        assert!(missing.is_dir());
        assert!(opened(path_text(&missing)));
        assert_eq!(units(&unrecorded.data.project_id), "global");
        assert_eq!(
            units(&unrecorded.data.location.directory),
            path_text(&missing)
        );
        assert_eq!(
            unrecorded.data.subpath.as_ref().map(units).as_deref(),
            path_text(&missing).strip_prefix('/')
        );
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_root_folders_that_are_files_or_relative_are_refused_before_anything_is_recorded()
{
    bounded(async {
        let root = scratch("refused");
        let file = root.join("plain-file");
        std::fs::write(&file, "x").unwrap();
        let child = file.join("child");
        let (server, mut client) = open().await;
        for directory in [
            path_text(&file),
            path_text(&child),
            "relative/project",
            "~other/project",
            "",
        ] {
            let error: v5::InvalidRequestError = refuse(
                &mut client,
                "session.create",
                location_scope(directory),
                request(Create {
                    id: Some("ses_create_refused_folder"),
                    directory: Some(directory),
                    ..Create::default()
                }),
            )
            .await;
            assert_eq!(
                error.field.as_ref().map(units).as_deref(),
                Some("location.directory"),
                "{directory}"
            );
            assert!(!opened(directory), "{directory}");
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "x");
        assert!(!std::path::Path::new("relative/project").exists());
        let missing: v5::SessionNotFoundError = refuse(
            &mut client,
            "session.get",
            session_scope("ses_create_refused_folder"),
            v5::SessionGetRequest {
                params: v5::SessionGetRequestParams {
                    session_id: text("ses_create_refused_folder"),
                },
            },
        )
        .await;
        assert_eq!(units(&missing.session_id), "ses_create_refused_folder");

        let untouched = root.join("workspace-folder");
        let scoped = v5::SessionCreateRequest {
            payload: v5::SessionCreateRequestPayload {
                id: Some(text("ses_create_workspace_folder")),
                location: Some(v5::LocationRef {
                    directory: text(path_text(&untouched)),
                    workspace_id: Some(text("wrk_exact")),
                }),
                ..Default::default()
            },
        };
        let _ = client
            .call(
                "session.create",
                location_scope(path_text(&untouched)),
                prost::Message::encode_to_vec(&scoped),
            )
            .await;
        assert!(!untouched.exists());
        server.shutdown().await.unwrap();
    })
    .await;
}
