mod support;

use std::time::Duration;
use support::{wire::*, *};
use ycoding_core::session::autonomy::DecisionMode;
use ycoding_core::ycoding_schema::session;
use ycoding_protocol::v5;

const MANUAL: i32 = 1;
const YOLO: i32 = 2;
const AUTO: i32 = 3;

fn change(
    permissions: Option<i32>,
    guardrails: Option<i32>,
    answers: Option<i32>,
    accept_yolo: bool,
) -> v5::AutonomyDefaultsSetRequest {
    v5::AutonomyDefaultsSetRequest {
        payload: v5::AutonomyDefaultsSetRequestPayload {
            permissions,
            guardrails,
            answers,
            accept_yolo: accept_yolo.then_some(true),
        },
    }
}

fn create(parent: Option<&str>, directory: &str) -> v5::SessionCreateRequest {
    v5::SessionCreateRequest {
        payload: v5::SessionCreateRequestPayload {
            id: None,
            parent_id: parent.map(text),
            agent: None,
            model: None,
            location: parent.is_none().then(|| v5::LocationRef {
                directory: text(directory),
                workspace_id: None,
            }),
            title: None,
            scope: None,
        },
    }
}

fn modes(id: &str) -> (DecisionMode, DecisionMode, DecisionMode) {
    let state = world()
        .core
        .autonomy
        .get(&session::Id::new(id).unwrap())
        .unwrap();
    (state.permissions, state.guardrails, state.answers)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saved_defaults_apply_to_new_root_sessions_only_and_yolo_needs_acceptance() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let root = std::env::temp_dir().join(format!("ycoding-defaults-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let directory = root.to_str().unwrap();
        insert_project("prj_defaults", directory).await;
        insert_session_of("prj_defaults", "ses_defaults_seed", directory, None).await;
        let (server, mut client) = open().await;

        let initial: v5::AutonomyDefaultsGetResult = ask(
            &mut client,
            "autonomyDefaults.get",
            machine(),
            v5::AutonomyDefaultsGetRequest {},
        )
        .await;
        assert_eq!(
            (
                initial.data.permissions,
                initial.data.guardrails,
                initial.data.answers
            ),
            (MANUAL, MANUAL, MANUAL)
        );
        assert!(initial.data.yolo_accepted_at.is_none());
        let before: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(directory),
            create(None, directory),
        )
        .await;
        assert_eq!(
            modes(&units(&before.data.id)),
            (
                DecisionMode::Manual,
                DecisionMode::Manual,
                DecisionMode::Manual
            )
        );

        let refused: v5::InvalidRequestError = refuse(
            &mut client,
            "autonomyDefaults.set",
            machine(),
            change(Some(YOLO), None, None, false),
        )
        .await;
        assert_eq!(
            refused.field.as_ref().map(units).as_deref(),
            Some("acceptYolo")
        );
        let unchanged: v5::AutonomyDefaultsGetResult = ask(
            &mut client,
            "autonomyDefaults.get",
            machine(),
            v5::AutonomyDefaultsGetRequest {},
        )
        .await;
        assert_eq!(unchanged.data.permissions, MANUAL);

        let saved: v5::AutonomyDefaultsSetResult = ask(
            &mut client,
            "autonomyDefaults.set",
            machine(),
            change(Some(YOLO), Some(AUTO), None, true),
        )
        .await;
        assert_eq!(
            (
                saved.data.permissions,
                saved.data.guardrails,
                saved.data.answers
            ),
            (YOLO, AUTO, MANUAL)
        );
        let accepted = saved.data.yolo_accepted_at.unwrap();
        assert!(accepted.permissions.is_some_and(|at| at > 0));
        assert_eq!((accepted.guardrails, accepted.answers), (None, None));
        assert!(
            std::fs::read_to_string(world().global_config.join("ycoding.json"))
                .unwrap()
                .contains("yolo_accepted_at")
        );

        let root_session: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(directory),
            create(None, directory),
        )
        .await;
        let root_id = units(&root_session.data.id);
        assert_eq!(
            modes(&root_id),
            (DecisionMode::Yolo, DecisionMode::Auto, DecisionMode::Manual)
        );
        assert_eq!(
            modes(&units(&before.data.id)),
            (
                DecisionMode::Manual,
                DecisionMode::Manual,
                DecisionMode::Manual
            ),
            "existing sessions keep their own mode"
        );
        let child: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(directory),
            create(Some(&root_id), directory),
        )
        .await;
        assert_eq!(
            modes(&units(&child.data.id)),
            (
                DecisionMode::Manual,
                DecisionMode::Manual,
                DecisionMode::Manual
            )
        );

        let reset: v5::AutonomyDefaultsSetResult = ask(
            &mut client,
            "autonomyDefaults.set",
            machine(),
            change(Some(MANUAL), Some(MANUAL), Some(MANUAL), false),
        )
        .await;
        assert_eq!(
            (
                reset.data.permissions,
                reset.data.guardrails,
                reset.data.answers
            ),
            (MANUAL, MANUAL, MANUAL)
        );
        assert!(reset.data.yolo_accepted_at.is_none());
        let after: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(directory),
            create(None, directory),
        )
        .await;
        assert_eq!(
            modes(&units(&after.data.id)),
            (
                DecisionMode::Manual,
                DecisionMode::Manual,
                DecisionMode::Manual
            )
        );
        server.shutdown().await.unwrap();
    })
    .await
    .expect("test exceeded its time bound");
}
