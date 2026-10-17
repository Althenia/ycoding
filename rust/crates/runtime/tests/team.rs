mod support;

use prost::{Message, Name};
use std::time::Duration;
use support::*;
use tokio::time::timeout;
use ycoding_core::session::{
    autonomy::Goal,
    orchestration::{LaunchInput, Prepared},
};
use ycoding_core::ycoding_schema::{DomainDecode, model, parse_json, session, session_message};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn yolo(level: u8) -> v5::SessionAutonomyYolo {
    use v5::session_autonomy_yolo::Kind;
    let value = f64::from(level);
    v5::SessionAutonomyYolo {
        kind: Some(Kind::Value1(value)),
    }
}

fn level(yolo: &v5::SessionAutonomyYolo) -> f64 {
    use v5::session_autonomy_yolo::Kind;
    match yolo.kind.unwrap() {
        Kind::Value1(value) | Kind::Value2(value) | Kind::Value3(value) => value,
    }
}

fn autonomy_get(session: &str) -> Vec<u8> {
    v5::SessionAutonomyGetRequest {
        params: v5::SessionAutonomyGetRequestParams {
            session_id: text(session),
        },
    }
    .encode_to_vec()
}

fn autonomy_set(session: &str, kind: v5::session_autonomy_set::Kind) -> Vec<u8> {
    v5::SessionAutonomySetRequest {
        params: v5::SessionAutonomySetRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionAutonomySet { kind: Some(kind) },
    }
    .encode_to_vec()
}

fn goal_set(
    yolo: Option<v5::SessionAutonomyYolo>,
    goal: v5::session_autonomy_set_value1_goal::Kind,
) -> v5::session_autonomy_set::Kind {
    v5::session_autonomy_set::Kind::Value1(v5::SessionAutonomySetValue1 {
        yolo,
        goal: v5::SessionAutonomySetValue1Goal { kind: Some(goal) },
        max_no_progress: None,
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn autonomy_get_and_set_round_trip_the_durable_state() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let scope = || session_scope("ses_auto");
        let id = session::Id::new("ses_auto").unwrap();
        let core = &world().core;

        let initial: v5::SessionAutonomyGetResult = success(
            client
                .call("session.autonomy.get", scope(), autonomy_get("ses_auto"))
                .await,
        );
        assert_eq!(
            initial.data.mode,
            v5::SessionAutonomyMode::SessionautonomymodeNormal as i32
        );
        assert_eq!(level(&initial.data.yolo), 0.0);
        assert!(initial.data.goal.is_none());

        for expected in [0, 1, 2] {
            let set: v5::SessionAutonomySetResult = success(
                client
                    .call(
                        "session.autonomy.set",
                        scope(),
                        autonomy_set(
                            "ses_auto",
                            v5::session_autonomy_set::Kind::Value2(v5::SessionAutonomySetValue2 {
                                yolo: yolo(expected),
                            }),
                        ),
                    )
                    .await,
            );
            assert_eq!(set.data.yolo, yolo(expected));
            assert_eq!(core.autonomy.get(&id).unwrap().yolo.get(), expected);
        }

        let descriptor = operation("session.autonomy.set");
        let no_goal = rejected(
            client
                .call(
                    "session.autonomy.set",
                    scope(),
                    autonomy_set(
                        "ses_auto",
                        goal_set(
                            None,
                            v5::session_autonomy_set_value1_goal::Kind::Value2(true),
                        ),
                    ),
                )
                .await,
        );
        assert_eq!(no_goal.type_name, v5::InvalidRequestError::full_name());
        let error = v5::InvalidRequestError::decode(no_goal.payload.as_slice()).unwrap();
        assert_eq!(units(&error.field.unwrap()), "goal");
        assert!(units(&error.message).contains("No retained goal to resume"));

        let calculated = rejected(
            client
                .call(
                    "session.autonomy.set",
                    scope(),
                    autonomy_set(
                        "ses_auto",
                        goal_set(
                            None,
                            v5::session_autonomy_set_value1_goal::Kind::Value1(text("ship it")),
                        ),
                    ),
                )
                .await,
        );
        assert_eq!(calculated.type_name, v5::UnknownError::full_name());
        assert!(descriptor.error_types.contains(&calculated.type_name));
        assert!(core.autonomy.get(&id).unwrap().goal.is_none());

        core.autonomy
            .set_goal(&id, Goal::new("ship it", None, Some(5)))
            .await
            .unwrap();
        let active: v5::SessionAutonomyGetResult = success(
            client
                .call("session.autonomy.get", scope(), autonomy_get("ses_auto"))
                .await,
        );
        let goal = active.data.goal.unwrap();
        assert_eq!(units(&goal.text), "ship it");
        assert_eq!(
            goal.status,
            v5::SessionAutonomyGoalStatus::SessionautonomygoalstatusActive as i32
        );
        assert_eq!(
            (goal.iteration, goal.no_progress, goal.max_no_progress),
            (0, 0, 5)
        );

        let stopped: v5::SessionAutonomySetResult = success(
            client
                .call(
                    "session.autonomy.set",
                    scope(),
                    autonomy_set(
                        "ses_auto",
                        goal_set(
                            Some(yolo(1)),
                            v5::session_autonomy_set_value1_goal::Kind::Clear(v5::Empty {}),
                        ),
                    ),
                )
                .await,
        );
        assert_eq!(level(&stopped.data.yolo), 1.0);
        assert_eq!(
            stopped.data.goal.unwrap().status,
            v5::SessionAutonomyGoalStatus::SessionautonomygoalstatusStopped as i32
        );

        let resumed: v5::SessionAutonomySetResult = success(
            client
                .call(
                    "session.autonomy.set",
                    scope(),
                    autonomy_set(
                        "ses_auto",
                        goal_set(
                            None,
                            v5::session_autonomy_set_value1_goal::Kind::Value2(true),
                        ),
                    ),
                )
                .await,
        );
        assert_eq!(
            resumed.data.goal.unwrap().status,
            v5::SessionAutonomyGoalStatus::SessionautonomygoalstatusActive as i32
        );
        assert!(core.autonomy.get(&id).unwrap().goal.unwrap().is_active());

        for invalid in [3, 7] {
            let out_of_range = rejected(
                client
                    .call(
                        "session.autonomy.set",
                        scope(),
                        autonomy_set(
                            "ses_auto",
                            v5::session_autonomy_set::Kind::Value2(v5::SessionAutonomySetValue2 {
                                yolo: yolo(invalid),
                            }),
                        ),
                    )
                    .await,
            );
            assert_eq!(out_of_range.type_name, v5::InvalidRequestError::full_name());
            assert_eq!(core.autonomy.get(&id).unwrap().yolo.get(), 1);
        }

        let missing = rejected(
            client
                .call(
                    "session.autonomy.get",
                    session_scope("ses_missing"),
                    autonomy_get("ses_missing"),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        server.shutdown().await.unwrap();
    })
    .await;
}

fn launch_input(parent: &str, call: &str) -> LaunchInput {
    LaunchInput {
        parent_id: session::Id::new(parent).unwrap(),
        parent_assistant_message_id: session_message::Id::new("msg_parent").unwrap(),
        tool_call_id: call.into(),
        description: "Explore".into(),
        prompt: "Look around".into(),
        depth_limit: 1,
        prepared: Prepared {
            agent: "explore".into(),
            caller_permissions: Default::default(),
            model: model::Ref::decode(
                &parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap(),
            )
            .unwrap(),
            profile_binding: None,
        },
        guardrails: world()
            .core
            .locations
            .session(&session::Id::new(parent).unwrap())
            .unwrap()
            .1
            .guardrails
            .clone(),
    }
}

async fn launched(parent: &str, call: &str) -> String {
    let child = world()
        .core
        .orchestration
        .launch(launch_input(parent, call))
        .await
        .unwrap()
        .session_id;
    world().active_children.started(&child).await;
    child.as_lossless().to_utf8().unwrap()
}

fn list_request(parent: &str, limit: Option<u64>, cursor: Option<&str>) -> Vec<u8> {
    v5::SessionSubagentListRequest {
        params: v5::SessionSubagentListRequestParams {
            parent_id: text(parent),
        },
        query: v5::SessionSubagentListQuery {
            limit,
            cursor: cursor.map(text),
        },
    }
    .encode_to_vec()
}

fn control(parent: &str, child: &str) -> (v5::LosslessString, v5::LosslessString) {
    (text(parent), text(child))
}

fn cancel_request(parent: &str, child: &str) -> Vec<u8> {
    let (parent_id, child_id) = control(parent, child);
    v5::SessionSubagentCancelRequest {
        params: v5::SessionSubagentCancelRequestParams {
            parent_id,
            child_id,
        },
    }
    .encode_to_vec()
}

fn resume_request(parent: &str, child: &str) -> Vec<u8> {
    let (parent_id, child_id) = control(parent, child);
    v5::SessionSubagentResumeRequest {
        params: v5::SessionSubagentResumeRequestParams {
            parent_id,
            child_id,
        },
    }
    .encode_to_vec()
}

fn message_request(parent: &str, child: &str, id: &str, queue: bool) -> Vec<u8> {
    let (parent_id, child_id) = control(parent, child);
    v5::SessionSubagentMessageRequest {
        params: v5::SessionSubagentMessageRequestParams {
            parent_id,
            child_id,
        },
        payload: v5::SessionSubagentMessage {
            message_id: text(id),
            text: text("Check the tests too"),
            delivery: if queue {
                v5::SessionSubagentMessageDelivery::SessionsubagentmessageDeliveryQueue
            } else {
                v5::SessionSubagentMessageDelivery::SessionsubagentmessageDeliverySteer
            } as i32,
        },
    }
    .encode_to_vec()
}

fn answer_request(parent: &str, child: &str, question: &str, answer: Option<&str>) -> Vec<u8> {
    v5::SessionSubagentAnswerRequest {
        params: v5::SessionSubagentAnswerRequestParams {
            parent_id: text(parent),
            child_id: text(child),
            question_id: text(question),
        },
        payload: v5::SessionSubagentAnswer {
            text: answer.map(text),
            data: None,
        },
    }
    .encode_to_vec()
}

fn state(task: &v5::SessionOrchestrationTask) -> v5::SessionOrchestrationTaskState {
    v5::SessionOrchestrationTaskState::try_from(task.state).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn subagent_list_pages_owned_children_with_a_summary_and_parent_bound_cursors() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let first = launched("ses_team", "call_list_a").await;
        let second = launched("ses_team", "call_list_b").await;

        let all: v5::SessionSubagentListResult = success(
            client
                .call(
                    "session.subagent.list",
                    session_scope("ses_team"),
                    list_request("ses_team", None, None),
                )
                .await,
        );
        let page = all.data;
        let mut ids = page
            .data
            .items
            .iter()
            .map(|task| units(&task.session_id))
            .collect::<Vec<_>>();
        ids.sort();
        let mut expected = vec![first.clone(), second.clone()];
        expected.sort();
        assert_eq!(ids, expected);
        assert_eq!(
            (
                page.summary.total,
                page.summary.active,
                page.summary.running,
                page.summary.waiting
            ),
            (2, 2, 2, 0)
        );
        assert!(page.cursor.previous.is_none() && page.cursor.next.is_none());
        let task = &page.data.items[0];
        assert_eq!(units(&task.parent_id), "ses_team");
        assert_eq!(units(&task.description), "Explore");
        assert_eq!(units(&task.agent), "explore");
        assert_eq!(
            (units(&task.model.provider_id), units(&task.model.id)),
            ("local".to_string(), "test".to_string())
        );
        assert!(task.background);
        assert_eq!(
            state(task),
            v5::SessionOrchestrationTaskState::SessionorchestrationTaskStateRunning
        );

        let head: v5::SessionSubagentListResult = success(
            client
                .call(
                    "session.subagent.list",
                    session_scope("ses_team"),
                    list_request("ses_team", Some(1), None),
                )
                .await,
        );
        assert_eq!(head.data.data.items.len(), 1);
        assert_eq!(head.data.summary.total, 2);
        let cursor = units(
            head.data
                .cursor
                .next
                .as_ref()
                .expect("a second page exists"),
        );
        let tail: v5::SessionSubagentListResult = success(
            client
                .call(
                    "session.subagent.list",
                    session_scope("ses_team"),
                    list_request("ses_team", Some(1), Some(&cursor)),
                )
                .await,
        );
        assert_eq!(tail.data.data.items.len(), 1);
        assert_ne!(
            units(&tail.data.data.items[0].session_id),
            units(&head.data.data.items[0].session_id)
        );
        assert!(tail.data.cursor.previous.is_some() && tail.data.cursor.next.is_none());

        let descriptor = operation("session.subagent.list");
        for (parent, cursor) in [
            ("ses_team", "not a cursor"),
            ("ses_team_two", cursor.as_str()),
        ] {
            let payload = rejected(
                client
                    .call(
                        "session.subagent.list",
                        session_scope(parent),
                        list_request(parent, Some(1), Some(cursor)),
                    )
                    .await,
            );
            assert_eq!(payload.type_name, v5::InvalidCursorError::full_name());
            assert!(descriptor.error_types.contains(&payload.type_name));
        }
        let missing = rejected(
            client
                .call(
                    "session.subagent.list",
                    session_scope("ses_missing"),
                    list_request("ses_missing", None, None),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        for child in [first, second] {
            world()
                .core
                .orchestration
                .cancel(
                    &session::Id::new("ses_team").unwrap(),
                    &session::Id::new(child).unwrap(),
                )
                .await
                .unwrap();
        }
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn subagent_controls_act_on_owned_children_and_reject_foreign_or_unknown_ones() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let child = launched("ses_team_two", "call_control").await;
        let child_id = session::Id::new(child.as_str()).unwrap();
        let scope = || session_scope("ses_team_two");
        let pending_before = world().core.sessions.pending_list(&child_id).unwrap().len();

        let sent: v5::SessionSubagentMessageResult = success(
            client
                .call(
                    "session.subagent.message",
                    scope(),
                    message_request("ses_team_two", &child, "msg_sub_one", true),
                )
                .await,
        );
        assert_eq!(units(&sent.data.session_id), child);
        assert!(world().core.execution.active().contains(&child_id));
        assert_eq!(
            world().core.sessions.pending_list(&child_id).unwrap().len(),
            pending_before + 1
        );

        let none_open = rejected(
            client
                .call(
                    "session.subagent.answer",
                    scope(),
                    answer_request("ses_team_two", &child, "qst_none", Some("yes")),
                )
                .await,
        );
        assert_eq!(none_open.type_name, v5::QuestionNotFoundError::full_name());
        let error = v5::QuestionNotFoundError::decode(none_open.payload.as_slice()).unwrap();
        assert_eq!(units(&error.request_id), "qst_none");

        let foreign = rejected(
            client
                .call(
                    "session.subagent.cancel",
                    scope(),
                    cancel_request("ses_team_two", "ses_get"),
                )
                .await,
        );
        assert_eq!(foreign.type_name, v5::ForbiddenError::full_name());
        let unknown = rejected(
            client
                .call(
                    "session.subagent.cancel",
                    scope(),
                    cancel_request("ses_team_two", "ses_nope"),
                )
                .await,
        );
        assert_eq!(unknown.type_name, v5::SessionNotFoundError::full_name());
        assert_eq!(
            units(
                &v5::SessionNotFoundError::decode(unknown.payload.as_slice())
                    .unwrap()
                    .session_id
            ),
            "ses_nope"
        );

        let resumed: v5::SessionSubagentResumeResult = success(
            client
                .call(
                    "session.subagent.resume",
                    scope(),
                    resume_request("ses_team_two", &child),
                )
                .await,
        );
        assert_eq!(
            state(&resumed.data),
            v5::SessionOrchestrationTaskState::SessionorchestrationTaskStateRunning
        );
        assert!(world().core.execution.active().contains(&child_id));

        let cancelled: v5::SessionSubagentCancelResult = success(
            client
                .call(
                    "session.subagent.cancel",
                    scope(),
                    cancel_request("ses_team_two", &child),
                )
                .await,
        );
        assert_eq!(
            state(&cancelled.data),
            v5::SessionOrchestrationTaskState::SessionorchestrationTaskStateCancelled
        );

        let conflict = rejected(
            client
                .call(
                    "session.subagent.resume",
                    scope(),
                    resume_request("ses_team_two", &child),
                )
                .await,
        );
        assert_eq!(conflict.type_name, v5::ConflictError::full_name());
        assert!(
            units(
                &v5::ConflictError::decode(conflict.payload.as_slice())
                    .unwrap()
                    .message
            )
            .contains("cancelled")
        );
        assert!(
            operation("session.subagent.resume")
                .error_types
                .contains(&conflict.type_name)
        );
        server.shutdown().await.unwrap();
    })
    .await;
}
