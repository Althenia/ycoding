#[path = "guardrail_service_decisions_support/fake.rs"]
mod evaluator_support;
mod support {
    include!("guardrail_service_decisions_support/mod.rs");
    include!("guardrail_service_decisions_support/events.rs");
}

use evaluator_support::Fake;
use std::{sync::Arc, time::Duration};
use support::{Fixture, Harness, response};
use ycoding_core::{
    coordination::{
        decision_context::Service as Context,
        decisions::{Gate, Reconsider, Source},
        runtime::Decision,
    },
    process::guardrails::{Error as GuardrailError, Guardrails, Input, Limits, Paths, Settings},
    resources::decision,
    session::review::{self, FingerprintInput},
    tools::policy::{
        Effect,
        permissions::{Error as PermissionError, Permissions},
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, guardrail, parse_json, permission,
    session_id::SessionId,
};
use ycoding_store::session::{Message, MessageTable, NewEvent};

const BOUND: Duration = Duration::from_secs(10);
const COMMAND: &str = "TOKEN=synthetic-secret touch /outside/private-target";

async fn until(condition: impl Fn() -> bool) {
    tokio::time::timeout(BOUND, async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("condition holds");
}

fn rule(action: &str, resource: &str, effect: &str) -> permission::Rule {
    permission::Rule {
        action: action.into(),
        resource: resource.into(),
        effect: permission::Effect(effect.into()),
    }
}

fn request(session: &SessionId, id: &str, explicit: bool) -> permission::Request {
    permission::Request {
        id: permission::Id::new(id).unwrap(),
        session_id: session.clone(),
        action: "edit".into(),
        resources: vec!["src/a.rs".into()],
        save: None,
        metadata: explicit.then(|| {
            let JsonValue::Object(metadata) =
                parse_json(r#"{"requireExplicitDecision":true}"#).unwrap()
            else {
                unreachable!()
            };
            metadata
        }),
        source: None,
        escalation: None,
        coordination_escalation: None,
    }
}

fn permission_fingerprint() -> String {
    review::fingerprint(&FingerprintInput {
        action: "edit".into(),
        resources: vec!["src/a.rs".into()],
        workdir: "".into(),
        rule_ids: vec![],
        hard_review: false,
        metadata: None,
    })
    .as_lossless()
    .to_utf8()
    .unwrap()
}

fn append(fixture: &Fixture, session: &str, id: &str, created: i64, kind: &str, data: String) {
    let event = NewEvent {
        id: id.into(),
        aggregate_id: session.into(),
        created,
        type_: kind.into(),
        data: parse_json(&data).unwrap(),
    };
    fixture
        .store
        .submit(move |tx| {
            ycoding_store::session::append(tx, &event, None)?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn review_event(fixture: &Fixture, session: &str, item: &str, created: i64, reply: &str) {
    append(
        fixture,
        session,
        &format!("evt_{item}_deferred"),
        created,
        "session.review.deferred.1",
        format!(
            r#"{{"itemID":"{item}","kind":"permission","reason":"defer_entry","origin":{{"requestID":"per_{item}"}},"payload":{{"type":"permission","action":"edit","resources":["src/a.rs"],"fingerprint":"{}","fingerprintVersion":2,"requestID":"per_{item}"}}}}"#,
            permission_fingerprint()
        ),
    );
    append(
        fixture,
        session,
        &format!("evt_{item}_decided"),
        created,
        "session.review.decided.1",
        format!(r#"{{"itemID":"{item}","decision":{{"kind":"permission","reply":"{reply}"}}}}"#),
    );
}

fn human_message(client: &ycoding_store::Client, session: &str) {
    let data = parse_json(
        r#"{"text":"Never edit that file","time":{"created":9},"metadata":{"inputOrigin":"human"}}"#,
    )
    .unwrap();
    let session = session.to_owned();
    client
        .submit(move |tx| {
            tx.put::<MessageTable>(&Message {
                id: "msg_late".into(),
                session_id: session.into(),
                type_: "user".into(),
                seq: 9,
                time_created: 9,
                time_updated: 9,
                data,
            })?;
            Ok(())
        })
        .and_then(|receipt| receipt.wait())
        .unwrap();
}

fn managed_child(fixture: &Fixture, parent: &str, child: &str, modes: [&str; 3]) -> SessionId {
    let id = fixture.session_with(child, Some(parent), modes, false, None);
    let (parent, child) = (parent.to_owned(), child.to_owned());
    fixture
        .store
        .submit(move |tx| {
            ycoding_store::session::TaskTable::insert(
                tx,
                &ycoding_store::session::Task {
                    session_id: child.as_str().into(),
                    parent_id: parent.as_str().into(),
                    parent_assistant_message_id: "msg_parent".into(),
                    tool_call_id: format!("call_{child}").as_str().into(),
                    input_id: format!("msg_input_{child}").as_str().into(),
                    description: "Work".into(),
                    agent: "test".into(),
                    model: ycoding_store::session::Document::<ycoding_schema::model::Ref>::new(
                        parse_json(r#"{"providerID":"openai","id":"fixture"}"#).unwrap(),
                    )?,
                    prompt_digest: "0".repeat(64).as_str().into(),
                    background: 1,
                    delivery: "steer".into(),
                    state: "running".into(),
                    progress: None,
                    progress_time: None,
                    question_id: None,
                    question: None,
                    question_data: None,
                    question_time: None,
                    usage_anchor: None,
                    attempt_started: 0,
                    owner_pid: None,
                    owner_started: None,
                    revision: 0,
                    time_created: 1,
                    time_updated: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    id
}

struct Ordinary {
    _harness: Harness,
    session: SessionId,
    permissions: Permissions,
    fake: Arc<Fake>,
}

fn ordinary(modes: [&str; 3], before: impl FnOnce(&Fixture)) -> Ordinary {
    let harness = Harness::new();
    let fixture = &harness.fixture;
    fixture.rules.lock().unwrap().push(rule("edit", "*", "ask"));
    let session = fixture.session_with("ses_member", None, modes, false, None);
    before(fixture);
    let fake = Fake::new(vec![grades(0.95, 0.02, 0.02)]);
    let permissions = fixture.permissions().with_decision(fake.clone(), true);
    Ordinary {
        _harness: harness,
        session,
        permissions,
        fake,
    }
}

impl Ordinary {
    fn assert(&self, explicit: bool) -> tokio::task::JoinHandle<Result<(), PermissionError>> {
        let permissions = self.permissions.clone();
        let request = request(&self.session, "per_member", explicit);
        tokio::spawn(async move { permissions.assert(request, None).await })
    }

    async fn held(&self, waiting: &tokio::task::JoinHandle<Result<(), PermissionError>>) {
        until(|| !self.permissions.list().is_empty()).await;
        assert!(!waiting.is_finished(), "no grant was issued");
    }

    fn unassessed(&self) {
        assert!(self.fake.seen.lock().unwrap().is_empty());
        assert_eq!(self.fake.replies.lock().unwrap().len(), 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn yolo_admits_ordinary_and_explicit_requests_without_assessment() {
    let case = ordinary(["yolo", "manual", "manual"], |_| {});
    for explicit in [false, true] {
        tokio::time::timeout(BOUND, case.assert(explicit))
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(case.permissions.list().is_empty());
    }
    case.unassessed();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_denies_and_permission_ceilings_block_requests_in_every_mode() {
    for mode in ["manual", "auto", "yolo"] {
        for ceiling in [false, true] {
            let case = ordinary([mode, "manual", "manual"], |fixture| {
                if !ceiling {
                    fixture
                        .rules
                        .lock()
                        .unwrap()
                        .push(rule("edit", "*", "deny"));
                }
            });
            if ceiling {
                case._harness.fixture.session_with(
                    "ses_member",
                    None,
                    [mode, "manual", "manual"],
                    false,
                    Some(vec![rule("edit", "*", "deny")]),
                );
            }
            let result = tokio::time::timeout(BOUND, case.assert(true))
                .await
                .unwrap()
                .unwrap();
            assert!(result.is_err(), "mode={mode} ceiling={ceiling}");
            assert!(case.permissions.list().is_empty());
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switching_to_yolo_rechecks_the_ceiling_before_settling_a_pending_request() {
    let case = ordinary(["manual", "manual", "manual"], |_| {});
    let waiting = case.assert(true);
    case.held(&waiting).await;
    case._harness.fixture.session_with(
        "ses_member",
        None,
        ["yolo", "manual", "manual"],
        false,
        Some(vec![rule("edit", "*", "deny")]),
    );
    case.permissions.reconcile_autonomy(&case.session).unwrap();
    assert!(
        tokio::time::timeout(BOUND, waiting)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(case.permissions.list().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn yolo_ignores_a_durable_rejection_without_granting_a_later_manual_reissue() {
    let case = ordinary(["yolo", "manual", "manual"], |fixture| {
        review_event(fixture, "ses_member", "rvw_one", 10, "reject")
    });
    tokio::time::timeout(BOUND, case.assert(false))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(case.permissions.list().is_empty());
    case._harness.fixture.session_with(
        "ses_member",
        None,
        ["manual", "manual", "manual"],
        false,
        None,
    );
    let waiting = case.assert(false);
    case.held(&waiting).await;
    case.unassessed();
    case.permissions.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_auto_is_held_by_a_durable_rejection_until_a_later_approval_reopens() {
    let harness = Harness::new();
    let fixture = &harness.fixture;
    fixture.rules.lock().unwrap().push(rule("edit", "*", "ask"));
    let session = fixture.session("ses_member", None, 1, false, None);
    review_event(fixture, "ses_member", "rvw_one", 10, "reject");

    let restarted = fixture.permissions();
    let held = tokio::spawn({
        let permissions = restarted.clone();
        let request = request(&session, "per_member", false);
        async move { permissions.assert(request, None).await }
    });
    until(|| !restarted.list().is_empty()).await;
    assert!(!held.is_finished());
    restarted.shutdown();

    review_event(fixture, "ses_member", "rvw_two", 20, "once");
    let reopened = fixture.permissions();
    tokio::time::timeout(
        BOUND,
        reopened.assert(request(&session, "per_reopened", false), None),
    )
    .await
    .unwrap()
    .unwrap();
}

#[tokio::test]
async fn a_managed_ancestor_change_moves_the_child_authority_digest() {
    let fixture = Fixture::default();
    fixture.session_with(
        "ses_parent",
        None,
        ["manual", "manual", "manual"],
        false,
        None,
    );
    let child = managed_child(
        &fixture,
        "ses_parent",
        "ses_child",
        ["manual", "manual", "manual"],
    );
    let context = Context::new(fixture.store.client());
    let before = context.read(&child).unwrap();
    let JsonValue::Object(object) = before.value() else {
        panic!("context is an object")
    };
    let Some(JsonValue::Array(ancestors)) = object.get(&"ancestors".into()) else {
        panic!("ancestors is an array")
    };
    assert_eq!(
        ancestors.len(),
        1,
        "the managed task parent is the nearest ancestor"
    );
    let digest = context.authority_digest(&child).unwrap();
    human_message(&fixture.store.client(), "ses_parent");
    assert_ne!(context.authority_digest(&child).unwrap(), digest);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coordinator_permission_decline_delivers_project_coordination_feedback() {
    let case = ordinary(["manual", "manual", "manual"], |_| {});
    let waiting = case.assert(false);
    case.held(&waiting).await;
    let id = permission::Id::new("per_member").unwrap();
    let fingerprint = case.permissions.snapshot(&id).unwrap().fingerprint;
    let result = case
        .permissions
        .reconsider(&id, reconsider(&fingerprint, Some(Decision::Decline)))
        .await
        .unwrap();
    assert!(result.settled);
    let outcome = tokio::time::timeout(BOUND, waiting).await.unwrap().unwrap();
    let Err(PermissionError::Corrected(feedback)) = outcome else {
        panic!("a coordinator decline is delivered as corrective feedback: {outcome:?}")
    };
    let feedback = feedback.to_utf8().unwrap();
    assert!(feedback.contains("Project coordination, not a human decision"));
    assert!(feedback.contains("Synthetic coordinator reason"));
    case.unassessed();
}

fn settings() -> Settings {
    Settings {
        paths: Paths {
            workdir: "/workspace/project".into(),
            project: "/workspace/project".into(),
            home: "/home/operator".into(),
            tmpdir: None,
            trusted_paths: vec![],
        },
        global_roots: vec![],
        custom: Arc::new(Vec::new),
        enabled: true,
        limits: Limits::default(),
        decide_reviews: true,
        decide_hard_reviews: true,
    }
}

fn grades(allow: f64, deny: f64, escalate: f64) -> Result<JsonValue, decision::Error> {
    let entries = [("allow", allow), ("deny", deny), ("escalate", escalate)]
        .into_iter()
        .map(|(choice, confidence)| {
            format!(r#"{{"choice":"{choice}","confidence":{confidence},"evidence":"Reviewed the synthetic command"}}"#)
        })
        .collect::<Vec<_>>()
        .join(",");
    response(&format!(
        r#"{{"name":"guardrail","type":"choice","answer":null,"choice":null,"score":null,"confidence":0,"grades":[{entries}]}}"#
    ))
}

fn review_input(session: &SessionId) -> Input {
    Input {
        session_id: session.clone(),
        action: "shell".into(),
        resources: vec![COMMAND.into()],
        metadata: None,
        skip_review: false,
        holder: None,
        source: Some(guardrail::Source {
            message_id: ycoding_schema::session_message::Id::new("msg_synthetic_source").unwrap(),
            call_id: "call_synthetic_source".into(),
        }),
    }
}

fn guardrails(harness: &Harness, fake: &Arc<Fake>) -> Guardrails {
    Guardrails::new(
        harness.fixture.authority(),
        harness.fixture.permissions(),
        settings(),
        harness.publish.clone(),
    )
    .with_reviews(harness.review_policy())
    .with_decision(fake.clone())
    .with_context(Arc::new(Context::new(harness.fixture.store.client())))
}

fn root_session(harness: &Harness, guardrails: &str) -> SessionId {
    harness.fixture.session_with(
        "ses_root",
        None,
        ["manual", guardrails, "manual"],
        false,
        None,
    )
}

fn source() -> Source {
    Source {
        coordinator_session_id: SessionId::new("ses_coordinator").unwrap(),
        group_id: Some("cgrp_synthetic".into()),
        rationale: "Synthetic coordinator reason".into(),
    }
}

fn reconsider<T>(fingerprint: &LosslessString, decision: Option<Decision>) -> Reconsider<T> {
    Reconsider {
        fingerprint: fingerprint.clone(),
        source: source(),
        decision,
        answer: None,
        confidence: None,
        gate: Gate {
            validate: Arc::new(|_| Box::pin(async { true })),
            current: Arc::new(|| true),
        },
    }
}

async fn settled(
    wait: ycoding_core::tools::policy::Wait<
        Result<ycoding_core::process::guardrails::Reservation, GuardrailError>,
    >,
) -> Result<ycoding_core::process::guardrails::Reservation, GuardrailError> {
    tokio::time::timeout(BOUND, wait)
        .await
        .expect("guardrail settlement timed out")
        .expect("guardrail sender dropped")
}

fn feedback(
    outcome: Result<ycoding_core::process::guardrails::Reservation, GuardrailError>,
) -> String {
    match outcome {
        Err(error @ GuardrailError::Corrected(_)) => error
            .review_message()
            .expect("corrective feedback is a review message"),
        Err(other) => panic!("expected corrective feedback, got {other:?}"),
        Ok(_) => panic!("expected corrective feedback, got a reservation"),
    }
}

#[test]
fn only_corrective_errors_carry_a_review_message() {
    assert_eq!(
        GuardrailError::Corrected("Do not retry.".into()).review_message(),
        Some("Do not retry.".to_owned())
    );
    assert_eq!(GuardrailError::Declined.review_message(), None);
    assert_eq!(GuardrailError::NotFound.review_message(), None);
}

#[tokio::test]
async fn yolo_ignores_an_explicit_guardrail_rejection_without_granting_a_later_manual_reissue() {
    let harness = Harness::new();
    let root = root_session(&harness, "manual");
    let fake = Fake::new(vec![grades(0.95, 0.02, 0.02)]);
    let service = guardrails(&harness, &fake);

    let first = service.assert(review_input(&root)).unwrap();
    let rejected = first.request.unwrap();
    service
        .reply(&root, &rejected.id, guardrail::Reply::Reject)
        .unwrap();
    assert!(matches!(
        settled(first.wait.unwrap()).await,
        Err(GuardrailError::Declined)
    ));

    root_session(&harness, "yolo");
    let admitted = service.assert(review_input(&root)).unwrap();
    assert_eq!(admitted.effect, Effect::Allow);
    assert!(admitted.request.is_none());
    admitted.reservation.unwrap().release();

    root_session(&harness, "manual");
    let reissued = service.assert(review_input(&root)).unwrap();
    assert_eq!(reissued.effect, Effect::Ask);
    let again = reissued.request.unwrap();
    service
        .reply(&root, &again.id, guardrail::Reply::Reject)
        .unwrap();
    assert!(matches!(
        settled(reissued.wait.unwrap()).await,
        Err(GuardrailError::Declined)
    ));
    assert!(fake.seen.lock().unwrap().is_empty());
    assert_eq!(fake.replies.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn coordinator_decline_delivers_project_coordination_feedback() {
    let harness = Harness::new();
    let root = root_session(&harness, "manual");
    let fake = Fake::new(vec![]);
    let service = guardrails(&harness, &fake);
    let admission = service.assert(review_input(&root)).unwrap();
    let asked = guardrail::Request::decode(&harness.event("guardrail.asked").await).unwrap();
    let fingerprint = service
        .request_snapshot(&root, &asked.id)
        .unwrap()
        .unwrap()
        .fingerprint;
    let result = service
        .reconsider(
            &root,
            &asked.id,
            reconsider(&fingerprint, Some(Decision::Decline)),
        )
        .await
        .unwrap();
    assert!(result.settled);
    let text = feedback(settled(admission.wait.unwrap()).await);
    assert!(text.contains("Project coordination, not a human decision"));
    assert!(text.contains("Synthetic coordinator reason"));
    assert!(fake.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_human_rejection_stays_a_plain_decline() {
    let harness = Harness::new();
    let root = root_session(&harness, "manual");
    let fake = Fake::new(vec![]);
    let service = guardrails(&harness, &fake);
    let admission = service.assert(review_input(&root)).unwrap();
    let asked = guardrail::Request::decode(&harness.event("guardrail.asked").await).unwrap();
    service
        .reply(&root, &asked.id, guardrail::Reply::Reject)
        .unwrap();
    assert!(matches!(
        settled(admission.wait.unwrap()).await,
        Err(GuardrailError::Declined)
    ));
    assert!(fake.seen.lock().unwrap().is_empty());
}
