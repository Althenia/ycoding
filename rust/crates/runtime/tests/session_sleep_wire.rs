mod support;

use prost::Message;
use std::{sync::Arc, time::Duration};
use support::*;
use tokio::time::timeout;
use ycoding_core::{
    platform::{
        keep_awake,
        process::{Command, Input, Output},
    },
    ycoding_schema::{parse_json, session},
    ycoding_store::session::NewEvent,
};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

const ROOT: &str = "ses_sleep_root";
const CHILD: &str = "ses_sleep_kid";
const SPARE: &str = "ses_sleep_spare";
const SPARE_CHILD: &str = "ses_sleep_spare_kid";

fn fake_keep_awake() -> keep_awake::Service {
    keep_awake::Service::with_command(
        true,
        Arc::new(|| {
            let mut command = Command::new("/bin/sleep", ["3600"]);
            command.stdin = Input::Ignore;
            command.stdout = Output::Ignore;
            command.stderr = Output::Ignore;
            command
        }),
    )
}

async fn create(id: &str, parent: Option<&str>) {
    let parent = parent.map_or_else(String::new, |parent| format!(r#","parentID":"{parent}""#));
    world()
        .core
        .sessions
        .create(NewEvent {
            id: format!("evt_create_{id}").as_str().into(),
            aggregate_id: id.into(),
            created: 5,
            type_: "session.created.2".into(),
            data: parse_json(&format!(
                r#"{{"sessionID":"{id}","projectID":"prj_one","location":{{"directory":"/project"}},"title":"Sleep","created":5{parent}}}"#
            ))
            .unwrap(),
        })
        .await
        .unwrap();
}

fn set(id: &str, kind: v5::session_autonomy_set::Kind) -> Vec<u8> {
    v5::SessionAutonomySetRequest {
        params: v5::SessionAutonomySetRequestParams {
            session_id: text(id),
        },
        payload: v5::SessionAutonomySet { kind: Some(kind) },
    }
    .encode_to_vec()
}

async fn sleep(client: &mut Client, id: &str, asleep: bool) -> v5::SessionAutonomyView {
    let result: v5::SessionAutonomySetResult = success(
        client
            .call(
                "session.autonomy.set",
                session_scope(id),
                set(
                    id,
                    v5::session_autonomy_set::Kind::Value3(v5::SessionAutonomySetValue3 {
                        sleep: asleep,
                    }),
                ),
            )
            .await,
    );
    result.data
}

async fn get(client: &mut Client, id: &str) -> v5::SessionAutonomyView {
    let result: v5::SessionAutonomyGetResult = success(
        client
            .call(
                "session.autonomy.get",
                session_scope(id),
                v5::SessionAutonomyGetRequest {
                    params: v5::SessionAutonomyGetRequestParams {
                        session_id: text(id),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    result.data
}

fn asleep(state: &v5::SessionAutonomyView) -> bool {
    state.sleep.is_some()
}

fn held(awake: &keep_awake::Service) -> bool {
    awake.get().sleep_hold == Some(true)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sleep_is_family_wide_held_until_a_user_prompt_root_archive_or_root_removal_wakes_it() {
    timeout(Duration::from_secs(60), async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        for (id, parent) in [
            (ROOT, None),
            (CHILD, Some(ROOT)),
            (SPARE, None),
            (SPARE_CHILD, Some(SPARE)),
        ] {
            create(id, parent).await;
        }
        let awake = fake_keep_awake();
        let _attached = world().core.autonomy.clone().with_keep_awake(awake.clone());

        let entered = sleep(&mut client, CHILD, true).await;
        assert!(
            asleep(&entered),
            "the asking child reports the family sleep"
        );
        assert!(asleep(&get(&mut client, ROOT).await));
        assert_eq!(entered, get(&mut client, CHILD).await);
        assert!(held(&awake));

        let yolo: v5::SessionAutonomySetResult = success(
            client
                .call(
                    "session.autonomy.set",
                    session_scope(CHILD),
                    set(
                        CHILD,
                        v5::session_autonomy_set::Kind::Value2(v5::SessionAutonomySetValue2 {
                            yolo: v5::SessionAutonomyYolo {
                                kind: Some(v5::session_autonomy_yolo::Kind::Value1(1.0)),
                            },
                        }),
                    ),
                )
                .await,
        );
        assert_eq!(
            yolo.data,
            get(&mut client, CHILD).await,
            "a child mutation response must agree with the inherited read"
        );
        assert!(asleep(&yolo.data));
        assert_eq!(
            yolo.data.yolo.kind,
            Some(v5::session_autonomy_yolo::Kind::Value1(1.0))
        );

        let _: v5::SessionSyntheticResult = success(
            client
                .call(
                    "session.synthetic",
                    session_scope(ROOT),
                    v5::SessionSyntheticRequest {
                        params: v5::SessionSyntheticRequestParams {
                            session_id: text(ROOT),
                        },
                        payload: v5::SessionSyntheticRequestPayload {
                            text: text("Runtime note"),
                            resume: Some(false),
                            ..Default::default()
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert!(
            asleep(&get(&mut client, ROOT).await),
            "synthetic input never wakes the family"
        );
        assert!(held(&awake));

        let _: v5::SessionPromptResult = success(
            client
                .call(
                    "session.prompt",
                    session_scope(CHILD),
                    v5::SessionPromptRequest {
                        params: v5::SessionPromptRequestParams {
                            session_id: text(CHILD),
                        },
                        payload: v5::SessionPromptRequestPayload {
                            text: text("I am back"),
                            resume: Some(false),
                            ..Default::default()
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert!(!asleep(&get(&mut client, ROOT).await));
        assert!(!asleep(&get(&mut client, CHILD).await));
        assert!(!held(&awake));

        let unchanged = sleep(&mut client, ROOT, false).await;
        assert!(!asleep(&unchanged), "waking an awake family is a no-op");

        assert!(asleep(&sleep(&mut client, ROOT, true).await));
        let archive = |id: &str| {
            v5::SessionArchiveRequest {
                params: v5::SessionArchiveRequestParams {
                    session_id: text(id),
                },
            }
            .encode_to_vec()
        };
        let _: v5::SessionArchiveResult = success(
            client
                .call("session.archive", session_scope(CHILD), archive(CHILD))
                .await,
        );
        assert!(
            asleep(&get(&mut client, ROOT).await),
            "archiving a child keeps the family asleep"
        );
        assert!(held(&awake));
        let _: v5::SessionArchiveResult = success(
            client
                .call("session.archive", session_scope(ROOT), archive(ROOT))
                .await,
        );
        assert!(!asleep(&get(&mut client, ROOT).await));
        assert!(!held(&awake));

        assert!(asleep(&sleep(&mut client, SPARE_CHILD, true).await));
        assert!(held(&awake));
        let _: v5::SessionRemoveResult = success(
            client
                .call(
                    "session.remove",
                    session_scope(SPARE),
                    v5::SessionRemoveRequest {
                        params: v5::SessionRemoveRequestParams {
                            session_id: text(SPARE),
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert!(
            world()
                .core
                .sessions
                .get(&session::Id::new(SPARE).unwrap())
                .unwrap()
                .is_none()
        );
        assert!(!held(&awake), "removing a sleeping root releases its hold");

        awake.close().await;
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
