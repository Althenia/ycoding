mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use prost::{Message, Name};
use remote_derived_support::{Fixture, create, expired_peer, now, world};
use std::sync::Arc;
use support::{operation, session_scope, text, units};
use ycoding_core::{
    session::{
        pending::{Promotion, Request},
        retention,
    },
    ycoding_schema::{DomainDecode, parse_json, session, session_message, session_pending},
    ycoding_store::{
        KeyPart,
        resources::{self, RequestTable},
        session::{Document, SessionTable, Task, TaskTable},
        tuple_key,
    },
};
use ycoding_protocol::{decode_strict, v5};
use ycoding_runtime::{
    Environment, Settled,
    connector::{Credential, Enrolled, Peer},
    standard,
};

const DAY: i64 = 86_400_000;

fn peer() -> Peer {
    Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "accounting-test".into(),
            now() + 60_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap()
}

async fn call<Q: Message>(
    environment: Arc<Environment>,
    name: &str,
    scope: v5::Scope,
    request: Q,
    peer: Option<&Peer>,
) -> v5::TypedPayload {
    let dispatcher = standard().unwrap();
    let request = v5::Request {
        request_id: "accounting-request".into(),
        operation_id: operation(name).operation_id,
        scope,
        payload: request.encode_to_vec(),
    };
    let settled = match peer {
        Some(peer) => {
            dispatcher
                .invoke_remote(environment, "accounting-connection".into(), peer, request)
                .await
        }
        None => {
            dispatcher
                .invoke(environment, "accounting-connection".into(), request)
                .await
        }
    };
    let Some(Settled::Result(result)) = settled else {
        panic!("missing inline settlement for {name}")
    };
    match result.outcome.unwrap() {
        v5::result::Outcome::Success(payload) | v5::result::Outcome::Error(payload) => payload,
        _ => panic!("unexpected asset"),
    }
}

fn success<R: Message + Name + Default>(payload: v5::TypedPayload) -> R {
    assert_eq!(
        payload.type_name,
        R::full_name(),
        "{:?}",
        v5::InvalidRequestError::decode(payload.payload.as_slice())
    );
    decode_strict(&payload.payload).unwrap()
}

fn declared(name: &str, payload: &v5::TypedPayload, expected: String) {
    assert!(operation(name).error_types.contains(&payload.type_name));
    assert_eq!(payload.type_name, expected, "{name}");
}

fn prompt_request(session: &str, ids: &[&str]) -> v5::SessionPromptCostsRequest {
    v5::SessionPromptCostsRequest {
        params: v5::SessionPromptCostsRequestParams {
            session_id: text(session),
        },
        query: v5::UsageAccountingPromptInput {
            input_i_ds: v5::UsageAccountingPromptInputInputIDs {
                items: ids.iter().map(|id| text(id)).collect(),
            },
        },
    }
}

fn task_request(session: &str, ids: &[&str]) -> v5::SessionTaskCostsRequest {
    v5::SessionTaskCostsRequest {
        params: v5::SessionTaskCostsRequestParams {
            session_id: text(session),
        },
        query: v5::UsageAccountingTaskInput {
            session_i_ds: v5::UsageAccountingTaskInputSessionIDs {
                items: ids.iter().map(|id| text(id)).collect(),
            },
        },
    }
}

async fn promote(session: &str, input: &str, created: i64) {
    let sessions = &world().core.sessions;
    let user = session_pending::Message::decode(
        &parse_json(r#"{"type":"user","data":{"text":"Work"},"delivery":"steer"}"#).unwrap(),
    )
    .unwrap();
    sessions
        .admit_input(Request {
            id: session_message::Id::new(input).unwrap(),
            session_id: session::Id::new(session).unwrap(),
            input: user,
            event_id: ycoding_core::ycoding_schema::event::Id::new(format!("evt_{input}")).unwrap(),
            created,
        })
        .await
        .unwrap();
    assert_eq!(
        sessions
            .promote_input(
                &session::Id::new(session).unwrap(),
                session_message::Id::new(input).unwrap().as_lossless(),
                created + 1,
            )
            .await
            .unwrap(),
        Promotion::Promoted
    );
}

fn anchor_document(
    session: &str,
    input: &str,
) -> Document<ycoding_core::ycoding_schema::usage_anchor::Ref> {
    Document::new(
        parse_json(&format!(
            r#"{{"sessionID":"{session}","inputID":"{input}"}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

fn request_row(
    id: &str,
    session: &str,
    number: i64,
    source: &str,
    anchor: Option<(&str, &str)>,
    cost: Option<f64>,
) -> resources::Request {
    resources::Request {
        id: id.into(),
        session_id: session.into(),
        input_id: None,
        assistant_message_id: None,
        connection_identity_digest: Some("private-connection".into()),
        source: source.into(),
        agent: "build".into(),
        model: Document::new(
            parse_json(r#"{"providerID":"private-provider","id":"private-model"}"#).unwrap(),
        )
        .unwrap(),
        route_id: "private-route".into(),
        prompt_cache_key: "private-cache-key".into(),
        system_digest: "private-system".into(),
        tool_digest: "private-tool".into(),
        request: number,
        attempts: 1,
        invalidation: "first-request".into(),
        continuation: "full".into(),
        cache_read_reported: None,
        timing: None,
        cost,
        tokens: Document::new(
            parse_json(r#"{"input":1,"output":2,"reasoning":3,"cache":{"read":4,"write":5}}"#)
                .unwrap(),
        )
        .unwrap(),
        time_created: now() - 1000 * number,
        usage_anchor: anchor.map(|(session, input)| anchor_document(session, input)),
    }
}

fn task_row(session: &str, parent: &str, input: &str, anchor: (&str, &str)) -> Task {
    Task {
        session_id: session.into(),
        parent_id: parent.into(),
        parent_assistant_message_id: format!("msg_{session}_launch").as_str().into(),
        tool_call_id: format!("call_{session}").as_str().into(),
        input_id: input.into(),
        description: "Explore".into(),
        agent: "explore".into(),
        model: Document::new(parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap()).unwrap(),
        prompt_digest: "d".repeat(64).as_str().into(),
        background: 1,
        delivery: "steer".into(),
        state: "completed".into(),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: None,
        question_time: None,
        attempt_started: now(),
        owner_pid: None,
        owner_started: None,
        revision: 0,
        time_created: now(),
        time_updated: now(),
        usage_anchor: Some(anchor_document(anchor.0, anchor.1)),
    }
}

struct Seeded {
    task: String,
    input: String,
}

async fn seed(fixture: &Fixture) -> Seeded {
    let task = format!("{}_task", fixture.root);
    let input = format!("msg_acct_{}", fixture.root);
    create(
        &task,
        &fixture.project,
        &fixture.directory,
        Some(&fixture.root),
        "explore",
    )
    .await;
    promote(&fixture.root, &input, now() - 10_000).await;
    let rows = [
        request_row(
            &format!("prq_root_{}", fixture.root),
            &fixture.root,
            1,
            "step",
            Some((&fixture.root, &input)),
            Some(2.0),
        ),
        request_row(
            &format!("prq_task_{}", fixture.root),
            &task,
            1,
            "title",
            Some((&fixture.root, &input)),
            Some(3.0),
        ),
    ];
    let launch = task_row(
        &task,
        &fixture.root,
        &format!("msg_launch_{}", fixture.root),
        (&fixture.root, &input),
    );
    world()
        .store
        .submit(move |tx| {
            TaskTable::put(tx, &launch)?;
            rows.iter()
                .try_for_each(|row| RequestTable::insert(tx, row))
        })
        .unwrap()
        .await
        .unwrap();
    Seeded { task, input }
}

fn private(bytes: &[u8], fixture: &Fixture) {
    let payload = String::from_utf8_lossy(bytes).into_owned();
    for marker in [
        "private-connection",
        "private-provider",
        "private-model",
        "private-route",
        "private-cache-key",
        "private-system",
        "private-tool",
        "prq_",
        fixture.directory.as_str(),
        fixture.project.as_str(),
    ] {
        assert!(!payload.contains(marker), "{marker}");
    }
}

#[test]
fn accounting_reads_are_private_unpaged_session_reads_for_local_remote_and_relay_peers() {
    for (name, id, request, result) in [
        (
            "session.promptCosts",
            4084,
            v5::SessionPromptCostsRequest::full_name(),
            v5::SessionPromptCostsResult::full_name(),
        ),
        (
            "session.taskCosts",
            4085,
            v5::SessionTaskCostsRequest::full_name(),
            v5::SessionTaskCostsResult::full_name(),
        ),
    ] {
        let descriptor = operation(name);
        assert_eq!(descriptor.operation_id, id);
        assert_eq!(descriptor.request_type, request);
        assert_eq!(descriptor.result_type, result);
        assert_eq!(descriptor.scope, v5::ScopeKind::Session as i32);
        assert_eq!(descriptor.mutation, v5::MutationClass::Read as i32);
        assert_eq!(descriptor.paging, v5::Paging::Unpaged as i32);
        assert_eq!(descriptor.streaming, v5::Streaming::TypedBulk as i32);
        assert!(descriptor.role_scopes.is_empty());
        for error in [
            v5::SessionNotFoundError::full_name(),
            v5::InvalidRequestError::full_name(),
            v5::ServiceUnavailableError::full_name(),
            v5::UnauthorizedError::full_name(),
        ] {
            assert!(descriptor.error_types.contains(&error), "{name} {error}");
        }
        for role in [
            v5::PeerRole::LocalClient,
            v5::PeerRole::RemoteClient,
            v5::PeerRole::Relay,
        ] {
            assert!(descriptor.roles.contains(&(role as i32)), "{name}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_and_remote_reads_return_the_same_prompt_and_task_costs() {
    let fixture = Fixture::new().await;
    let seeded = seed(&fixture).await;
    let environment = fixture.environment(true);
    let peer = peer();
    let missing = format!("msg_missing_{}", fixture.root);
    for peer in [None, Some(&peer)] {
        let prompts: v5::SessionPromptCostsResult = success(
            call(
                environment.clone(),
                "session.promptCosts",
                session_scope(&fixture.root),
                prompt_request(&fixture.root, &[&seeded.input, &missing]),
                peer,
            )
            .await,
        );
        let data = &prompts.data;
        assert_eq!(data.history, 1);
        assert_eq!(data.unattributed.requests, 0);
        assert_eq!(
            (
                data.unattributed.cost.total,
                data.unattributed.cost.known,
                data.unattributed.cost.provenance
            ),
            (None, None, None)
        );
        assert_eq!(data.units.items.len(), 2);
        let unit = &data.units.items[0];
        assert_eq!(units(&unit.anchor.session_id), fixture.root);
        assert_eq!(units(&unit.anchor.input_id), seeded.input);
        assert_eq!((unit.status, unit.attribution, unit.history), (1, 1, 1));
        assert_eq!(unit.total.requests, 2);
        assert_eq!(
            (
                unit.total.cost.total,
                unit.total.cost.known,
                unit.total.cost.priced_requests,
                unit.total.cost.unpriced_requests,
                unit.total.cost.provenance
            ),
            (Some(5.0), Some(5.0), 2, 0, Some(1))
        );
        assert_eq!(
            (
                unit.total.tokens.input,
                unit.total.tokens.output,
                unit.total.tokens.reasoning,
                unit.total.tokens.cache.read,
                unit.total.tokens.cache.write
            ),
            (2.0, 4.0, 6.0, 8.0, 10.0)
        );
        assert_eq!(unit.main.cost.total, Some(2.0));
        assert_eq!(unit.children.cost.total, Some(3.0));
        assert_eq!(unit.helpers.items.len(), 1);
        assert_eq!(unit.helpers.items[0].source, 2);
        assert_eq!(unit.helpers.items[0].cost.total, Some(3.0));
        let unknown = &data.units.items[1];
        assert_eq!(units(&unknown.anchor.input_id), missing);
        assert_eq!(
            (unknown.status, unknown.attribution, unknown.history),
            (1, 3, 2)
        );
        assert_eq!(unknown.total.requests, 0);
        assert_eq!(unknown.total.cost.total, None);
        private(&prompts.encode_to_vec(), &fixture);

        let tasks: v5::SessionTaskCostsResult = success(
            call(
                environment.clone(),
                "session.taskCosts",
                session_scope(&fixture.root),
                task_request(&fixture.root, &[&seeded.task]),
                peer,
            )
            .await,
        );
        let data = &tasks.data;
        assert_eq!(data.history, 1);
        assert_eq!(data.total.requests, 1);
        assert_eq!(data.total.cost.total, Some(3.0));
        let task = &data.tasks.items[0];
        assert_eq!(units(&task.session_id), seeded.task);
        let anchor = task.usage_anchor.as_ref().unwrap();
        assert_eq!(
            (units(&anchor.session_id), units(&anchor.input_id)),
            (fixture.root.clone(), seeded.input.clone())
        );
        assert_eq!((task.status, task.attribution, task.history), (1, 1, 1));
        assert_eq!(task.total.cost.total, Some(3.0));
        assert_eq!(task.main.cost.total, Some(3.0));
        assert_eq!(task.children.requests, 0);
        assert_eq!(task.helpers.items[0].source, 2);
        private(&tasks.encode_to_vec(), &fixture);
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_identifier_lists_and_mismatched_sessions_are_invalid_requests() {
    let fixture = Fixture::new().await;
    let seeded = seed(&fixture).await;
    let environment = fixture.environment(true);
    let peer = peer();
    let many_inputs = (0..101)
        .map(|index| format!("msg_many_{index}"))
        .collect::<Vec<_>>();
    let many_sessions = (0..101)
        .map(|index| format!("ses_many_{index}"))
        .collect::<Vec<_>>();
    let many_inputs = many_inputs.iter().map(String::as_str).collect::<Vec<_>>();
    let many_sessions = many_sessions.iter().map(String::as_str).collect::<Vec<_>>();
    for peer in [None, Some(&peer)] {
        for request in [
            prompt_request(&fixture.root, &[]),
            prompt_request(&fixture.root, &many_inputs),
            prompt_request(&fixture.root, &[&seeded.input, &seeded.input]),
            prompt_request(&fixture.root, &["ses_not_a_message"]),
            prompt_request(&fixture.child, &[&seeded.input]),
        ] {
            let payload = call(
                environment.clone(),
                "session.promptCosts",
                session_scope(&fixture.root),
                request,
                peer,
            )
            .await;
            declared(
                "session.promptCosts",
                &payload,
                v5::InvalidRequestError::full_name(),
            );
        }
        for request in [
            task_request(&fixture.root, &[]),
            task_request(&fixture.root, &many_sessions),
            task_request(&fixture.root, &[&seeded.task, &seeded.task]),
            task_request(&fixture.root, &["msg_not_a_session"]),
            task_request(&fixture.child, &[&seeded.task]),
        ] {
            let payload = call(
                environment.clone(),
                "session.taskCosts",
                session_scope(&fixture.root),
                request,
                peer,
            )
            .await;
            declared(
                "session.taskCosts",
                &payload,
                v5::InvalidRequestError::full_name(),
            );
        }
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_costs_name_the_rejected_session_and_unknown_scopes_are_not_found() {
    let fixture = Fixture::new().await;
    let seeded = seed(&fixture).await;
    let environment = fixture.environment(true);
    let peer = peer();
    for peer in [None, Some(&peer)] {
        for (requested, rejected) in [
            (
                vec![seeded.task.as_str(), fixture.other.as_str()],
                &fixture.other,
            ),
            (vec![fixture.child.as_str()], &fixture.child),
            (vec![fixture.root.as_str()], &fixture.root),
        ] {
            let payload = call(
                environment.clone(),
                "session.taskCosts",
                session_scope(&fixture.root),
                task_request(&fixture.root, &requested),
                peer,
            )
            .await;
            declared(
                "session.taskCosts",
                &payload,
                v5::SessionNotFoundError::full_name(),
            );
            let error = v5::SessionNotFoundError::decode(payload.payload.as_slice()).unwrap();
            assert_eq!(units(&error.session_id), *rejected, "{requested:?}");
        }
        let unknown = "ses_acct_unknown_scope";
        for (name, payload) in [
            (
                "session.promptCosts",
                call(
                    environment.clone(),
                    "session.promptCosts",
                    session_scope(unknown),
                    prompt_request(unknown, &[&seeded.input]),
                    peer,
                )
                .await,
            ),
            (
                "session.taskCosts",
                call(
                    environment.clone(),
                    "session.taskCosts",
                    session_scope(unknown),
                    task_request(unknown, &[&seeded.task]),
                    peer,
                )
                .await,
            ),
        ] {
            declared(name, &payload, v5::SessionNotFoundError::full_name());
        }
    }
    for (name, payload) in [
        (
            "session.promptCosts",
            call(
                environment.clone(),
                "session.promptCosts",
                session_scope(&fixture.root),
                prompt_request(&fixture.root, &[&seeded.input]),
                Some(&expired_peer()),
            )
            .await,
        ),
        (
            "session.taskCosts",
            call(
                environment.clone(),
                "session.taskCosts",
                session_scope(&fixture.root),
                task_request(&fixture.root, &[&seeded.task]),
                Some(&expired_peer()),
            )
            .await,
        ),
    ] {
        declared(name, &payload, v5::UnauthorizedError::full_name());
    }
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_read_takes_records_days_from_the_runtime_retention_accessor() {
    let fixture = Fixture::new().await;
    let seeded = seed(&fixture).await;
    let key = tuple_key(&[KeyPart::String(&fixture.root.as_str().into())]);
    world()
        .store
        .submit(move |tx| {
            let mut row = tx.get::<SessionTable>(&key)?.unwrap();
            row.time_created = now() - 2 * DAY;
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .await
        .unwrap();
    let read = |environment: Arc<Environment>| {
        let root = fixture.root.clone();
        let input = seeded.input.clone();
        async move {
            let result: v5::SessionPromptCostsResult = success(
                call(
                    environment,
                    "session.promptCosts",
                    session_scope(&root),
                    prompt_request(&root, &[&input]),
                    None,
                )
                .await,
            );
            result.data
        }
    };
    let retained = read(fixture.environment(true)).await;
    assert_eq!(retained.history, 1);
    assert_eq!(retained.units.items[0].history, 1);
    assert_eq!(retained.units.items[0].total.cost.total, Some(5.0));

    let mut short = fixture.environment(true);
    Arc::get_mut(&mut short)
        .unwrap()
        .services
        .core
        .as_mut()
        .unwrap()
        .retention = Arc::new(|| retention::Settings {
        records_days: 1,
        ..retention::Settings::default()
    });
    let partial = read(short).await;
    assert_eq!(partial.history, 2);
    assert_eq!(partial.units.items[0].history, 1);
    assert_eq!(partial.units.items[0].total.cost.total, Some(5.0));
    fixture.close().await;
}
