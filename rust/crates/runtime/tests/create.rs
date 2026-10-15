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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sessions_are_created_in_a_recorded_location_with_agent_model_and_a_stable_identity() {
    bounded(async {
        insert_session("ses_create_seed", "/project/sub/dir", None).await;
        let (server, mut client) = open().await;
        let scope = location_scope("/project/sub/dir");

        let created: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            scope.clone(),
            request(Create {
                agent: Some("build"),
                model: Some(model(None)),
                directory: Some("/project/sub/dir"),
                ..Create::default()
            }),
        )
        .await;
        let info = &created.data;
        let id = units(&info.id);
        assert!(id.starts_with("ses_"), "{id}");
        assert_eq!(units(info.agent.as_ref().unwrap()), "build");
        assert_eq!(units(&info.project_id), "prj_one");
        assert_eq!(units(&info.location.directory), "/project/sub/dir");
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
                directory: Some("/project/sub/dir"),
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
        assert_eq!(units(&child.data.location.directory), "/project/sub/dir");
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
                directory: Some("/project/sub/dir"),
                ..Create::default()
            }),
        )
        .await;
        assert_eq!(units(decision.field.as_ref().unwrap()), "agent");
        let unrecorded: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope("/never/recorded"),
            request(Create {
                directory: Some("/never/recorded"),
                ..Create::default()
            }),
        )
        .await;
        assert_eq!(units(&unrecorded.data.project_id), "global");
        assert_eq!(
            units(&unrecorded.data.location.directory),
            "/never/recorded"
        );
        assert_eq!(
            unrecorded.data.subpath.as_ref().map(units).as_deref(),
            Some("never/recorded")
        );
        server.shutdown().await.unwrap();
    })
    .await;
}
