mod support;

use std::time::Duration;
use support::{wire::*, *};
use ycoding_core::process::guardrails::Input;
use ycoding_core::tools::policy::{Effect, questions::Admission};
use ycoding_core::ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, question, session_id::SessionId,
};
use ycoding_protocol::v5;

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn mentions(kind: &str, key: &str, id: &str) -> bool {
    published(kind).iter().any(|event| {
        matches!(&event.data, JsonValue::Object(object)
            if object.get(&LosslessString::from(key)) == Some(&JsonValue::String(id.into())))
    })
}

fn create(
    session: &str,
    action: &str,
    resource: &str,
    save: bool,
) -> v5::SessionPermissionCreateRequest {
    v5::SessionPermissionCreateRequest {
        params: v5::SessionPermissionCreateRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionPermissionCreateRequestPayload {
            id: None,
            action: text(action),
            resources: v5::SessionPermissionCreateRequestPayloadResources {
                items: vec![text(resource)],
            },
            save: save.then(|| v5::SessionPermissionCreateRequestPayloadSave {
                items: vec![text(resource)],
            }),
            metadata: None,
            source: None,
            agent: None,
        },
    }
}

fn session_list(session: &str) -> v5::SessionPermissionListRequest {
    v5::SessionPermissionListRequest {
        params: v5::SessionPermissionListRequestParams {
            session_id: text(session),
        },
    }
}

fn permission_ids(list: &v5::SessionPermissionListResult) -> Vec<String> {
    list.data.items.iter().map(|item| units(&item.id)).collect()
}

fn reply(session: &str, id: &str, reply: v5::PermissionReply) -> v5::SessionPermissionReplyRequest {
    v5::SessionPermissionReplyRequest {
        params: v5::SessionPermissionReplyRequestParams {
            session_id: text(session),
            request_id: text(id),
        },
        payload: v5::SessionPermissionReplyRequestPayload {
            reply: reply as i32,
            message: None,
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_requests_are_asked_listed_replied_and_never_cross_sessions() {
    bounded(async {
        insert_session("ses_perm_a", "/loc/perm", None).await;
        insert_session("ses_perm_b", "/loc/perm", None).await;
        let (server, mut client) = open().await;
        let scope = session_scope("ses_perm_a");

        let created: v5::SessionPermissionCreateResult = ask(
            &mut client,
            "session.permission.create",
            scope.clone(),
            create("ses_perm_a", "bash_flow", "ls", true),
        )
        .await;
        assert_eq!(created.data.effect, v5::PermissionEffect::Ask as i32);
        let id = units(&created.data.id);
        assert!(id.starts_with("per_"), "{id}");
        assert!(mentions("permission.asked", "id", &id));

        let listed: v5::SessionPermissionListResult = ask(
            &mut client,
            "session.permission.list",
            scope.clone(),
            session_list("ses_perm_a"),
        )
        .await;
        assert_eq!(permission_ids(&listed), vec![id.clone()]);
        let item = &listed.data.items[0];
        assert_eq!(units(&item.session_id), "ses_perm_a");
        assert_eq!(units(&item.action), "bash_flow");
        assert_eq!(
            item.resources.items.iter().map(units).collect::<Vec<_>>(),
            ["ls"]
        );
        assert_eq!(
            item.save
                .as_ref()
                .unwrap()
                .items
                .iter()
                .map(units)
                .collect::<Vec<_>>(),
            ["ls"]
        );

        let other: v5::SessionPermissionListResult = ask(
            &mut client,
            "session.permission.list",
            session_scope("ses_perm_b"),
            session_list("ses_perm_b"),
        )
        .await;
        assert!(other.data.items.is_empty());

        let get = |session: &str| v5::SessionPermissionGetRequest {
            params: v5::SessionPermissionGetRequestParams {
                session_id: text(session),
                request_id: text(&id),
            },
        };
        let fetched: v5::SessionPermissionGetResult = ask(
            &mut client,
            "session.permission.get",
            scope.clone(),
            get("ses_perm_a"),
        )
        .await;
        assert_eq!(units(&fetched.data.id), id);
        let missing: v5::PermissionNotFoundError = refuse(
            &mut client,
            "session.permission.get",
            session_scope("ses_perm_b"),
            get("ses_perm_b"),
        )
        .await;
        assert_eq!(units(&missing.request_id), id);
        let _: v5::PermissionNotFoundError = refuse(
            &mut client,
            "session.permission.reply",
            session_scope("ses_perm_b"),
            reply("ses_perm_b", &id, v5::PermissionReply::Once),
        )
        .await;

        let location: v5::PermissionRequestListResult = ask(
            &mut client,
            "permission.request.list",
            location_scope("/loc/perm"),
            v5::PermissionRequestListRequest {
                query: query("/loc/perm", None),
            },
        )
        .await;
        assert_eq!(units(&location.location.directory), "/loc/perm");
        assert_eq!(units(&location.location.project.id), "prj_one");
        assert_eq!(units(&location.location.project.directory), "/project");
        assert!(location.location.workspace_id.is_none());
        assert_eq!(
            location
                .data
                .items
                .iter()
                .map(|item| units(&item.id))
                .collect::<Vec<_>>(),
            vec![id.clone()]
        );

        let equivalent: v5::PermissionRequestListResult = ask(
            &mut client,
            "permission.request.list",
            location_scope("/loc/./perm/extra/../"),
            v5::PermissionRequestListRequest {
                query: v5::LocationQuery { location: None },
            },
        )
        .await;
        assert_eq!(
            equivalent.data.items.len(),
            1,
            "equivalent references share one graph"
        );
        let disagree: v5::InvalidRequestError = refuse(
            &mut client,
            "permission.request.list",
            location_scope("/loc/perm"),
            v5::PermissionRequestListRequest {
                query: query("/loc/elsewhere", None),
            },
        )
        .await;
        assert!(units(&disagree.message).contains("disagree"));

        let done: v5::SessionPermissionReplyResult = ask(
            &mut client,
            "session.permission.reply",
            scope.clone(),
            reply("ses_perm_a", &id, v5::PermissionReply::Always),
        )
        .await;
        assert_eq!(done.data, v5::Empty {});
        assert!(mentions("permission.replied", "requestID", &id));
        let drained: v5::SessionPermissionListResult = ask(
            &mut client,
            "session.permission.list",
            scope.clone(),
            session_list("ses_perm_a"),
        )
        .await;
        assert!(drained.data.items.is_empty());
        let _: v5::PermissionNotFoundError = refuse(
            &mut client,
            "session.permission.reply",
            scope.clone(),
            reply("ses_perm_a", &id, v5::PermissionReply::Once),
        )
        .await;

        let saved: v5::PermissionSavedListResult = ask(
            &mut client,
            "permission.saved.list",
            location_scope("/loc/perm"),
            v5::PermissionSavedListRequest {
                query: v5::PermissionSavedListRequestQuery { project_id: None },
            },
        )
        .await;
        let entry = saved
            .data
            .items
            .iter()
            .find(|item| units(&item.action) == "bash_flow")
            .expect("the always reply saved the permission for the Location's project");
        assert_eq!(units(&entry.project_id), "prj_one");
        assert_eq!(units(&entry.resource), "ls");
        let again: v5::SessionPermissionCreateResult = ask(
            &mut client,
            "session.permission.create",
            scope.clone(),
            create("ses_perm_a", "bash_flow", "ls", false),
        )
        .await;
        assert_eq!(again.data.effect, v5::PermissionEffect::Allow as i32);
        let _: v5::PermissionSavedRemoveResult = ask(
            &mut client,
            "permission.saved.remove",
            location_scope("/loc/perm"),
            v5::PermissionSavedRemoveRequest {
                params: v5::PermissionSavedRemoveRequestParams {
                    id: entry.id.clone(),
                },
            },
        )
        .await;
        let after: v5::PermissionSavedListResult = ask(
            &mut client,
            "permission.saved.list",
            location_scope("/loc/perm"),
            v5::PermissionSavedListRequest {
                query: v5::PermissionSavedListRequestQuery {
                    project_id: Some(text("prj_one")),
                },
            },
        )
        .await;
        assert!(
            after
                .data
                .items
                .iter()
                .all(|item| units(&item.action) != "bash_flow")
        );

        for (action, effect) in [
            ("read", v5::PermissionEffect::Allow),
            ("blocked", v5::PermissionEffect::Deny),
        ] {
            let decided: v5::SessionPermissionCreateResult = ask(
                &mut client,
                "session.permission.create",
                scope.clone(),
                create("ses_perm_a", action, "x", false),
            )
            .await;
            assert_eq!(decided.data.effect, effect as i32, "{action}");
        }
        let still: v5::SessionPermissionListResult = ask(
            &mut client,
            "session.permission.list",
            scope.clone(),
            session_list("ses_perm_a"),
        )
        .await;
        assert!(still.data.items.is_empty());

        let unknown: v5::SessionNotFoundError = refuse(
            &mut client,
            "session.permission.create",
            session_scope("ses_perm_missing"),
            create("ses_perm_missing", "bash_flow", "ls", false),
        )
        .await;
        assert_eq!(units(&unknown.session_id), "ses_perm_missing");
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspaces_are_separate_location_graphs() {
    bounded(async {
        insert_session("ses_ws_plain", "/loc/ws", None).await;
        insert_session("ses_ws_other", "/loc/ws", Some("wrk_other")).await;
        let (server, mut client) = open().await;
        let _: v5::SessionPermissionCreateResult = ask(
            &mut client,
            "session.permission.create",
            session_scope("ses_ws_plain"),
            create("ses_ws_plain", "bash_ws", "ls", false),
        )
        .await;
        let plain: v5::PermissionRequestListResult = ask(
            &mut client,
            "permission.request.list",
            location_scope("/loc/ws"),
            v5::PermissionRequestListRequest {
                query: query("/loc/ws", None),
            },
        )
        .await;
        assert_eq!(plain.data.items.len(), 1);
        let other: v5::PermissionRequestListResult = ask(
            &mut client,
            "permission.request.list",
            location_scope("/loc/ws"),
            v5::PermissionRequestListRequest {
                query: query("/loc/ws", Some("wrk_other")),
            },
        )
        .await;
        assert_eq!(
            units(other.location.workspace_id.as_ref().unwrap()),
            "wrk_other"
        );
        assert!(other.data.items.is_empty());
        let unrecorded: v5::PermissionRequestListResult = ask(
            &mut client,
            "permission.request.list",
            location_scope("/loc/never"),
            v5::PermissionRequestListRequest {
                query: query("/loc/never", None),
            },
        )
        .await;
        assert_eq!(units(&unrecorded.location.project.id), "global");
        assert_eq!(units(&unrecorded.location.project.directory), "/");
        assert!(unrecorded.data.items.is_empty());
        server.shutdown().await.unwrap();
    })
    .await;
}

fn question_request(id: &str, session: &str) -> question::Request {
    question::Request {
        id: question::Id::decode(&JsonValue::String(id.into())).unwrap(),
        session_id: SessionId::new(session).unwrap(),
        questions: vec![question::Info {
            question: "Which?".into(),
            header: "Pick".into(),
            options: vec![question::Option {
                label: "One".into(),
                description: "first".into(),
            }],
            multiple: None,
            custom: None,
        }],
        tool: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn questions_are_listed_replied_and_rejected_only_through_their_owning_session() {
    bounded(async {
        insert_session("ses_q_a", "/loc/question", None).await;
        insert_session("ses_q_b", "/loc/question", None).await;
        let (server, mut client) = open().await;
        let (_, services) = world()
            .core
            .locations
            .session(&SessionId::new("ses_q_a").unwrap())
            .unwrap();
        let mut waits = Vec::new();
        for (id, session) in [
            ("que_reply", "ses_q_a"),
            ("que_reject", "ses_q_a"),
            ("que_other", "ses_q_b"),
        ] {
            let Admission::Pending(wait) = services
                .questions
                .ask(question_request(id, session))
                .unwrap()
            else {
                panic!("a question at normal autonomy stays pending");
            };
            waits.push(wait);
        }
        let list = |session: &str| v5::SessionQuestionListRequest {
            params: v5::SessionQuestionListRequestParams {
                session_id: text(session),
            },
        };
        let ids = |result: &v5::SessionQuestionListResult| {
            result
                .data
                .items
                .iter()
                .map(|item| units(&item.id))
                .collect::<Vec<_>>()
        };
        let own: v5::SessionQuestionListResult = ask(
            &mut client,
            "session.question.list",
            session_scope("ses_q_a"),
            list("ses_q_a"),
        )
        .await;
        assert_eq!(ids(&own), ["que_reply", "que_reject"]);
        let first = &own.data.items[0];
        assert_eq!(units(&first.session_id), "ses_q_a");
        assert_eq!(units(&first.questions.items[0].question), "Which?");
        assert_eq!(
            units(&first.questions.items[0].options.items[0].label),
            "One"
        );
        let sibling: v5::SessionQuestionListResult = ask(
            &mut client,
            "session.question.list",
            session_scope("ses_q_b"),
            list("ses_q_b"),
        )
        .await;
        assert_eq!(ids(&sibling), ["que_other"]);
        let location: v5::QuestionRequestListResult = ask(
            &mut client,
            "question.request.list",
            location_scope("/loc/question"),
            v5::QuestionRequestListRequest {
                query: query("/loc/question", None),
            },
        )
        .await;
        assert_eq!(units(&location.location.project.id), "prj_one");
        assert_eq!(
            location
                .data
                .items
                .iter()
                .map(|item| units(&item.id))
                .collect::<Vec<_>>(),
            ["que_reply", "que_reject", "que_other"]
        );

        let reply = |session: &str, id: &str| v5::SessionQuestionReplyRequest {
            params: v5::SessionQuestionReplyRequestParams {
                session_id: text(session),
                request_id: text(id),
            },
            payload: v5::QuestionReply {
                answers: v5::QuestionReplyAnswers {
                    items: vec![v5::QuestionAnswer {
                        items: vec![text("One")],
                    }],
                },
            },
        };
        let foreign: v5::QuestionNotFoundError = refuse(
            &mut client,
            "session.question.reply",
            session_scope("ses_q_b"),
            reply("ses_q_b", "que_reply"),
        )
        .await;
        assert_eq!(units(&foreign.request_id), "que_reply");
        let _: v5::SessionQuestionReplyResult = ask(
            &mut client,
            "session.question.reply",
            session_scope("ses_q_a"),
            reply("ses_q_a", "que_reply"),
        )
        .await;
        let mut waits = waits.into_iter();
        let answers = waits.next().unwrap().await.unwrap().unwrap();
        assert_eq!(answers, vec![vec![LosslessString::from("One")]]);
        assert!(mentions("question.replied", "requestID", "que_reply"));

        let reject = |session: &str, id: &str| v5::SessionQuestionRejectRequest {
            params: v5::SessionQuestionRejectRequestParams {
                session_id: text(session),
                request_id: text(id),
            },
        };
        let _: v5::QuestionNotFoundError = refuse(
            &mut client,
            "session.question.reject",
            session_scope("ses_q_b"),
            reject("ses_q_b", "que_reject"),
        )
        .await;
        let _: v5::SessionQuestionRejectResult = ask(
            &mut client,
            "session.question.reject",
            session_scope("ses_q_a"),
            reject("ses_q_a", "que_reject"),
        )
        .await;
        assert!(waits.next().unwrap().await.unwrap().is_err());
        assert!(mentions("question.rejected", "requestID", "que_reject"));
        let _: v5::QuestionNotFoundError = refuse(
            &mut client,
            "session.question.reject",
            session_scope("ses_q_a"),
            reject("ses_q_a", "que_reject"),
        )
        .await;
        let remaining: v5::SessionQuestionListResult = ask(
            &mut client,
            "session.question.list",
            session_scope("ses_q_a"),
            list("ses_q_a"),
        )
        .await;
        assert!(remaining.data.items.is_empty());
        server.shutdown().await.unwrap();
    })
    .await;
}

fn review(session: &str, command: &str) -> Input {
    Input {
        session_id: SessionId::new(session).unwrap(),
        action: "shell".into(),
        resources: vec![command.into()],
        metadata: None,
        skip_review: false,
        holder: None,
        defer_shell: false,
        source: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guardrail_reviews_are_listed_counted_and_replied_through_the_session_location() {
    bounded(async {
        insert_session("ses_g_root", "/loc/guard", None).await;
        let (server, mut client) = open().await;
        let (_, services) = world()
            .core
            .locations
            .session(&SessionId::new("ses_g_root").unwrap())
            .unwrap();
        let scope = session_scope("ses_g_root");
        let status = |session: &str| v5::SessionGuardrailStatusRequest {
            params: v5::SessionGuardrailStatusRequestParams {
                session_id: text(session),
            },
        };
        let list = |session: &str| v5::SessionGuardrailRequestListRequest {
            params: v5::SessionGuardrailRequestListRequestParams {
                session_id: text(session),
            },
        };
        let reply = |id: &str, reply: v5::GuardrailReply| v5::SessionGuardrailRequestReplyRequest {
            params: v5::SessionGuardrailRequestReplyRequestParams {
                session_id: text("ses_g_root"),
                request_id: text(id),
            },
            payload: v5::SessionGuardrailRequestReplyRequestPayload {
                reply: reply as i32,
            },
        };

        let ordinary = services
            .guardrails
            .assert(review("ses_g_root", "touch /other/file"))
            .unwrap();
        assert_eq!(ordinary.effect, Effect::Ask);
        let ordinary_id = ordinary.request.as_ref().unwrap().id.clone();
        let ordinary_name = units(&convert_id(&ordinary_id));

        let pending: v5::SessionGuardrailRequestListResult = ask(
            &mut client,
            "session.guardrail.request.list",
            scope.clone(),
            list("ses_g_root"),
        )
        .await;
        assert_eq!(pending.data.items.len(), 1);
        let item = &pending.data.items[0];
        assert_eq!(units(&item.id), ordinary_name);
        assert_eq!(units(&item.root_session_id), "ses_g_root");
        assert_eq!(units(&item.action), "shell");
        assert_eq!(
            item.resources.items.iter().map(units).collect::<Vec<_>>(),
            ["touch /other/file"]
        );
        assert!(!units(&item.reason).is_empty());
        assert_ne!(item.hard_review, Some(true));

        let counted: v5::SessionGuardrailStatusResult = ask(
            &mut client,
            "session.guardrail.status",
            scope.clone(),
            status("ses_g_root"),
        )
        .await;
        assert_eq!(units(&counted.data.root_session_id), "ses_g_root");
        assert_eq!(units(&counted.data.profile), "standard");
        let reviews = counted
            .data
            .counters
            .items
            .iter()
            .find(|counter| units(&counter.id) == "reviews")
            .unwrap();
        assert_eq!((reviews.current, reviews.limit), (1, 16));
        assert_eq!(reviews.scope, v5::GuardrailCounterScope::Family as i32);
        assert_eq!(counted.data.approvals, 0);

        let _: v5::GuardrailRequestNotFoundError = refuse(
            &mut client,
            "session.guardrail.request.reply",
            scope.clone(),
            reply("grq_missing", v5::GuardrailReply::Once),
        )
        .await;
        let _: v5::SessionGuardrailRequestReplyResult = ask(
            &mut client,
            "session.guardrail.request.reply",
            scope.clone(),
            reply(&ordinary_name, v5::GuardrailReply::Once),
        )
        .await;
        ordinary.wait.unwrap().await.unwrap().unwrap().release();
        assert!(mentions("guardrail.replied", "requestID", &ordinary_name));
        let approved: v5::SessionGuardrailStatusResult = ask(
            &mut client,
            "session.guardrail.status",
            scope.clone(),
            status("ses_g_root"),
        )
        .await;
        assert_eq!(approved.data.approvals, 1);

        let hard = services
            .guardrails
            .assert(review("ses_g_root", "rm -rf ~/notes"))
            .unwrap();
        let hard_name = units(&convert_id(&hard.request.as_ref().unwrap().id));
        let hard_listed: v5::SessionGuardrailRequestListResult = ask(
            &mut client,
            "session.guardrail.request.list",
            scope.clone(),
            list("ses_g_root"),
        )
        .await;
        assert_eq!(hard_listed.data.items[0].hard_review, Some(true));
        let _: v5::SessionGuardrailRequestReplyResult = ask(
            &mut client,
            "session.guardrail.request.reply",
            scope.clone(),
            reply(&hard_name, v5::GuardrailReply::Always),
        )
        .await;
        assert!(
            hard.wait.unwrap().await.unwrap().is_err(),
            "a hard review never accepts Always"
        );

        let rejected = services
            .guardrails
            .assert(review("ses_g_root", "touch /other/second"))
            .unwrap();
        let rejected_name = units(&convert_id(&rejected.request.as_ref().unwrap().id));
        let _: v5::SessionGuardrailRequestReplyResult = ask(
            &mut client,
            "session.guardrail.request.reply",
            scope.clone(),
            reply(&rejected_name, v5::GuardrailReply::Reject),
        )
        .await;
        assert!(rejected.wait.unwrap().await.unwrap().is_err());

        let unknown: v5::SessionNotFoundError = refuse(
            &mut client,
            "session.guardrail.status",
            session_scope("ses_g_missing"),
            status("ses_g_missing"),
        )
        .await;
        assert_eq!(units(&unknown.session_id), "ses_g_missing");
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guardrail_always_reply_records_a_durable_directory_approval_for_the_root_family() {
    use ycoding_core::ycoding_store::{
        IndexOrder, IndexQuery, KeyPart, session::EventTable, tuple_key,
    };
    bounded(async {
        insert_session("ses_g_always", "/loc/guard-always", None).await;
        insert_session("ses_g_always_other", "/loc/guard-always", None).await;
        let (server, mut client) = open().await;
        let (_, services) = world()
            .core
            .locations
            .session(&SessionId::new("ses_g_always").unwrap())
            .unwrap();
        let reviewed = services
            .guardrails
            .assert(review("ses_g_always", "touch /other/always/file"))
            .unwrap();
        assert_eq!(reviewed.effect, Effect::Ask);
        let name = units(&convert_id(&reviewed.request.as_ref().unwrap().id));
        let _: v5::SessionGuardrailRequestReplyResult = ask(
            &mut client,
            "session.guardrail.request.reply",
            session_scope("ses_g_always"),
            v5::SessionGuardrailRequestReplyRequest {
                params: v5::SessionGuardrailRequestReplyRequestParams {
                    session_id: text("ses_g_always"),
                    request_id: text(&name),
                },
                payload: v5::SessionGuardrailRequestReplyRequestPayload {
                    reply: v5::GuardrailReply::Always as i32,
                },
            },
        )
        .await;
        reviewed.wait.unwrap().await.unwrap().unwrap().release();

        let prefix = tuple_key(&[
            KeyPart::String(&"ses_g_always".into()),
            KeyPart::String(&"session.guardrail.approved.1".into()),
        ]);
        let events = world()
            .store
            .snapshot()
            .unwrap()
            .index_range::<EventTable>(
                "event_aggregate_type_seq_idx",
                IndexQuery {
                    lower: std::ops::Bound::Unbounded,
                    upper: std::ops::Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: None,
                    limit: 8,
                },
            )
            .unwrap();
        assert_eq!(events.len(), 1);
        let JsonValue::Object(data) = &events[0].record.data else {
            panic!("approval data is an object")
        };
        assert_eq!(
            data.get(&LosslessString::from("directories")),
            Some(&JsonValue::Array(vec![
                JsonValue::String("/loc/guard-always".into()),
                JsonValue::String("/other/always".into())
            ]))
        );
        let reused = services
            .guardrails
            .assert(review("ses_g_always", "touch /other/always/nested/next"))
            .unwrap();
        assert_eq!(reused.effect, Effect::Allow);
        reused.reservation.unwrap().release();
        for (session, command) in [
            ("ses_g_always", "touch /other/elsewhere"),
            ("ses_g_always_other", "touch /other/always/next"),
        ] {
            assert_eq!(
                services
                    .guardrails
                    .evaluate(&review(session, command))
                    .unwrap()
                    .effect,
                Effect::Ask,
                "{session} {command}"
            );
        }
        server.shutdown().await.unwrap();
    })
    .await;
}

fn convert_id(id: &ycoding_core::ycoding_schema::guardrail::RequestId) -> v5::LosslessString {
    use ycoding_core::ycoding_schema::DomainEncode;
    let JsonValue::String(value) = id.encode() else {
        unreachable!("identifiers encode as strings")
    };
    text(&String::from_utf16_lossy(
        &value.code_units().collect::<Vec<_>>(),
    ))
}
