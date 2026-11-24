#[path = "guardrail_service_decisions_support/fake.rs"]
mod evaluator_support;
mod support {
    include!("guardrail_service_decisions_support/mod.rs");
}

use evaluator_support::Fake;
use std::{ops::Bound, sync::Arc, time::Duration};
use support::{Fixture, Harness, response};
use ycoding_core::{
    coordination::{
        self,
        decision_context::Service as Context,
        decisions::{
            CoordinationDecisions, Gate, Options, Prior, PriorSource, PriorStatus, Reconsider,
            Rejections, Services, Source, explicit_rejected, guardrail_matches, permission_matches,
        },
        runtime::{DecisionOutcome, Decisions, PendingInput},
    },
    event_feed::Feed,
    process::guardrails::{Guardrails, Input, Limits, Paths, Settings},
    resources::decision,
    session::review::{self, FingerprintInput},
    tools::policy::{Effect, forms::Forms},
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, coordination as c, form, guardrail, parse_json,
    permission,
    session_id::SessionId,
    session_review::{Fingerprint, Payload},
};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart,
    project::Permission,
    session::{
        Document, EventTable, Message, MessageTable, NewEvent, Pending, PendingTable, Session,
        SessionTable,
    },
    tuple_key,
};

const BOUND: Duration = Duration::from_secs(10);
const COMMAND: &str = "TOKEN=synthetic-secret touch /outside/private-target";

fn get<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    let JsonValue::Object(object) = value else {
        panic!("expected an object holding {name}")
    };
    object
        .get(&name.into())
        .unwrap_or_else(|| panic!("missing {name}"))
}

fn text(value: &JsonValue) -> String {
    let JsonValue::String(value) = value else {
        panic!("expected a string")
    };
    value.to_utf8().unwrap()
}

fn sources(context: &JsonValue, list: &str) -> Vec<String> {
    let JsonValue::Array(items) = get(context, list) else {
        panic!("{list} is an array")
    };
    items.iter().map(|item| text(get(item, "source"))).collect()
}

fn len(context: &JsonValue, list: &str) -> usize {
    let JsonValue::Array(items) = get(context, list) else {
        panic!("{list} is an array")
    };
    items.len()
}

fn insert_message(fixture: &Fixture, session: &str, id: &str, seq: i64, kind: &str, data: &str) {
    let (session, id, kind, data) = (
        session.to_owned(),
        id.to_owned(),
        kind.to_owned(),
        parse_json(data).unwrap(),
    );
    fixture
        .store
        .submit(move |tx| {
            tx.put::<MessageTable>(&Message {
                id: id.into(),
                session_id: session.into(),
                type_: kind.into(),
                seq,
                time_created: seq,
                time_updated: seq,
                data,
            })?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn user(fixture: &Fixture, session: &str, id: &str, seq: i64, origin: Option<&str>) {
    let metadata = origin.map_or_else(String::new, |origin| {
        format!(r#","metadata":{{"inputOrigin":"{origin}"}}"#)
    });
    insert_message(
        fixture,
        session,
        id,
        seq,
        "user",
        &format!(r#"{{"text":"instruction {id}","time":{{"created":{seq}}}{metadata}}}"#),
    );
}

fn pending_row(fixture: &Fixture, session: &str, id: &str, seq: i64, delivery: &str, origin: &str) {
    let (session, id, delivery) = (session.to_owned(), id.to_owned(), delivery.to_owned());
    let data = parse_json(&format!(
        r#"{{"text":"steer {id}","metadata":{{"inputOrigin":"{origin}"}}}}"#
    ))
    .unwrap();
    fixture
        .store
        .submit(move |tx| {
            tx.put::<PendingTable>(&Pending {
                id: id.into(),
                session_id: session.into(),
                type_: "user".into(),
                data,
                delivery: Some(delivery.into()),
                admitted_seq: seq,
                time_created: seq,
            })?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn event(fixture: &Fixture, session: &str, id: &str, created: i64, kind: &str, data: &str) {
    let event = NewEvent {
        id: id.into(),
        aggregate_id: session.into(),
        created,
        type_: kind.into(),
        data: parse_json(data).unwrap(),
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

fn durable(fixture: &Fixture, session: &SessionId, kind: &str) -> Vec<JsonValue> {
    let prefix = tuple_key(&[
        KeyPart::String(session.as_lossless()),
        KeyPart::String(&kind.into()),
    ]);
    fixture
        .store
        .snapshot()
        .unwrap()
        .index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: None,
                limit: 128,
            },
        )
        .unwrap()
        .into_iter()
        .map(|row| row.record.data)
        .collect()
}

fn session_key(id: &str) -> Vec<u8> {
    tuple_key(&[KeyPart::String(&id.into())])
}

fn rewrite_session(
    fixture: &Fixture,
    id: &str,
    change: impl FnOnce(&mut Session) + Send + 'static,
) {
    let key = session_key(id);
    fixture
        .store
        .submit(move |tx| {
            let mut row = tx.get::<SessionTable>(&key)?.expect("session row");
            change(&mut row);
            tx.put::<SessionTable>(&row)?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn rule(action: &str, resource: &str, effect: &str) -> permission::Rule {
    permission::Rule {
        action: action.into(),
        resource: resource.into(),
        effect: permission::Effect(effect.into()),
    }
}

#[test]
fn context_labels_instruction_sources_and_leaves_direct_input_unreported() {
    let fixture = Fixture::default();
    let id = fixture.session(
        "ses_ctx",
        None,
        0,
        true,
        Some(vec![rule("edit", "*", "deny")]),
    );
    for (seq, origin) in [
        Some("human"),
        Some("direct"),
        Some("coordination"),
        Some("plugin"),
        Some("review"),
        None,
    ]
    .into_iter()
    .enumerate()
    {
        user(
            &fixture,
            "ses_ctx",
            &format!("msg_{seq}"),
            seq as i64 + 1,
            origin,
        );
    }
    pending_row(&fixture, "ses_ctx", "msg_steer_human", 1, "steer", "human");
    pending_row(&fixture, "ses_ctx", "msg_queued", 2, "queue", "human");
    pending_row(&fixture, "ses_ctx", "msg_steer_plain", 3, "steer", "plugin");

    let context = Context::new(fixture.store.client()).read(&id).unwrap();
    let context = context.value();
    assert_eq!(
        sources(context, "userInstructions"),
        [
            "human",
            "unreported-input",
            "coordination",
            "plugin",
            "review-decision",
            "unreported-input"
        ]
    );
    assert_eq!(
        sources(context, "pendingInstructions"),
        ["human", "plugin"],
        "only steering rows are current authority"
    );
    assert_eq!(text(get(get(context, "goal"), "text")), "Synthetic goal");
    assert_eq!(text(get(get(context, "goal"), "status")), "active");
    let authorization = get(context, "authorization");
    assert_eq!(text(get(authorization, "source")), "session-ceiling");
    assert_eq!(len(authorization, "ceiling"), 1);
    assert_eq!(len(context, "ancestors"), 0);
    assert_eq!(get(context, "ancestryTruncated"), &JsonValue::Bool(false));
    assert_eq!(
        get(get(context, "coverage"), "bounded"),
        &JsonValue::Bool(true)
    );
}

#[test]
fn authority_digest_tracks_authority_and_ignores_conversation_and_review_decisions() {
    let fixture = Fixture::default();
    let id = fixture.session("ses_ctx", None, 0, true, None);
    let service = Context::new(fixture.store.client());
    let digest = || service.authority_digest(&id).unwrap();
    let base = digest();
    assert_eq!(base, digest(), "the digest is deterministic");

    insert_message(
        &fixture,
        "ses_ctx",
        "msg_obs",
        1,
        "synthetic",
        r#"{"text":"observation","time":{"created":1}}"#,
    );
    assert_eq!(
        digest(),
        base,
        "conversation observations are not authority"
    );

    user(&fixture, "ses_ctx", "msg_review", 2, Some("review"));
    assert_eq!(
        len(service.read(&id).unwrap().value(), "userInstructions"),
        1
    );
    assert_eq!(
        digest(),
        base,
        "review decisions are not instruction authority"
    );

    user(&fixture, "ses_ctx", "msg_human", 3, Some("human"));
    let human = digest();
    assert_ne!(human, base);

    pending_row(&fixture, "ses_ctx", "msg_queued", 1, "queue", "human");
    assert_eq!(digest(), human, "queued work is not current authority");
    pending_row(&fixture, "ses_ctx", "msg_steer", 2, "steer", "human");
    let steered = digest();
    assert_ne!(steered, human);

    fixture
        .store
        .submit(|tx| {
            tx.put::<ycoding_store::project::PermissionTable>(&Permission {
                id: "per_saved".into(),
                project_id: "project".into(),
                action: "edit".into(),
                resource: "src/*".into(),
                time_created: 1,
                time_updated: 1,
            })?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let granted = digest();
    assert_ne!(granted, steered, "saved project grants are authority");

    rewrite_session(&fixture, "ses_ctx", |row| {
        row.permission = Some(Document::from_domain(&vec![rule("edit", "*", "deny")]).unwrap());
    });
    let ceilinged = digest();
    assert_ne!(ceilinged, granted, "the session ceiling is authority");

    rewrite_session(&fixture, "ses_ctx", |row| {
        row.autonomy = Some(
            parse_json(
                r#"{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"manual","goal":{"text":"Changed goal","iteration":0,"noProgress":0,"maxNoProgress":3,"status":"active"}}"#,
            )
            .unwrap(),
        );
    });
    assert_ne!(digest(), ceilinged, "the goal is authority");
}

fn fingerprint_of(action: &str, resource: &str) -> Fingerprint {
    review::fingerprint(&FingerprintInput {
        action: action.into(),
        resources: vec![resource.into()],
        workdir: "".into(),
        rule_ids: vec![],
        hard_review: false,
        metadata: None,
    })
}

fn permission_payload(version: u8, fingerprint: &str) -> Payload {
    Payload::decode(
        &parse_json(&format!(
            r#"{{"type":"permission","action":"edit","resources":["a"],"fingerprint":"{fingerprint}","fingerprintVersion":{version},"requestID":"per_old"}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn historical_fingerprints_match_only_legacy_permission_payloads() {
    let (current, historical) = ("a".repeat(64), "b".repeat(64));
    let (current, historical) = (
        LosslessString::from(current.as_str()),
        LosslessString::from(historical.as_str()),
    );
    let legacy = permission_payload(1, &"b".repeat(64));
    let modern = permission_payload(2, &"b".repeat(64));
    assert!(permission_matches(&legacy, &current, Some(&historical)));
    assert!(!permission_matches(&legacy, &current, None));
    assert!(!permission_matches(&modern, &current, Some(&historical)));
    for version in [1, 2] {
        let exact = permission_payload(version, &"a".repeat(64));
        assert!(permission_matches(&exact, &current, None), "v{version}");
    }
    let guardrail = Payload::decode(
        &parse_json(&format!(
            r#"{{"type":"guardrail","action":"shell","resources":["x"],"ruleIDs":["standard.review.x"],"reason":"r","hardReview":false,"directories":[],"fingerprint":"{}","requestID":"grq_one"}}"#,
            "b".repeat(64)
        ))
        .unwrap(),
    )
    .unwrap();
    assert!(!permission_matches(&guardrail, &current, Some(&historical)));
    assert!(guardrail_matches(&guardrail, &historical));
    assert!(!guardrail_matches(&guardrail, &current));
    assert!(!guardrail_matches(&legacy, &historical));
}

#[test]
fn explicit_rejection_holds_until_a_later_explicit_approval() {
    let review = |status| Prior {
        source: PriorSource::Review,
        status,
    };
    let explicit = Prior {
        source: PriorSource::Explicit,
        status: PriorStatus::Rejected,
    };
    use PriorStatus::*;
    assert!(!explicit_rejected(&[]));
    assert!(explicit_rejected(&[review(Approved), review(Rejected)]));
    assert!(!explicit_rejected(&[review(Rejected), review(Approved)]));
    assert!(!explicit_rejected(&[
        review(Rejected),
        review(ApprovedUsed)
    ]));
    assert!(explicit_rejected(&[
        review(Rejected),
        review(Withdrawn),
        review(Pending)
    ]));
    assert!(!explicit_rejected(&[review(Withdrawn), review(Pending)]));
    assert!(explicit_rejected(&[review(Approved), explicit]));
    assert!(explicit_rejected(&[explicit, review(Approved)]));

    let rejections = Rejections::default();
    let session = SessionId::new("ses_ctx").unwrap();
    let key = |index: usize| Rejections::key(&session, &format!("{index:064}").as_str().into());
    for index in 0..600 {
        rejections.record(key(index), true);
    }
    assert!(
        !rejections.contains(&key(0)),
        "the oldest rejection is evicted"
    );
    assert!(rejections.contains(&key(599)));
    rejections.record(key(599), false);
    assert!(
        !rejections.contains(&key(599)),
        "an approval clears the rejection"
    );
}

fn review_event(fixture: &Fixture, session: &str, item: &str, created: i64, reply: &str, fp: &str) {
    event(
        fixture,
        session,
        &format!("evt_{item}_deferred"),
        created,
        "session.review.deferred.1",
        &format!(
            r#"{{"itemID":"{item}","kind":"permission","reason":"defer_entry","origin":{{"requestID":"per_{item}"}},"payload":{{"type":"permission","action":"edit","resources":["src/a.rs"],"fingerprint":"{fp}","fingerprintVersion":2,"requestID":"per_{item}"}}}}"#
        ),
    );
    event(
        fixture,
        session,
        &format!("evt_{item}_decided"),
        created,
        "session.review.decided.1",
        &format!(r#"{{"itemID":"{item}","decision":{{"kind":"permission","reply":"{reply}"}}}}"#),
    );
}

fn request(session: &SessionId, id: &str) -> permission::Request {
    permission::Request {
        id: permission::Id::new(id).unwrap(),
        session_id: session.clone(),
        action: "edit".into(),
        resources: vec!["src/a.rs".into()],
        save: None,
        metadata: None,
        source: None,
        escalation: None,
        coordination_escalation: None,
    }
}

fn source() -> Source {
    Source {
        coordinator_session_id: SessionId::new("ses_coordinator").unwrap(),
        group_id: Some("cgrp_synthetic".into()),
        rationale: "Synthetic coordinator reason".into(),
    }
}

fn reconsider<T>(fingerprint: &LosslessString) -> Reconsider<T> {
    Reconsider {
        fingerprint: fingerprint.clone(),
        source: source(),
        decision: None,
        answer: None,
        confidence: None,
        gate: Gate {
            validate: Arc::new(|_| Box::pin(async { true })),
            current: Arc::new(|| true),
        },
    }
}

async fn until(condition: impl Fn() -> bool) {
    tokio::time::timeout(BOUND, async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("condition holds");
}

#[tokio::test]
async fn a_durable_rejection_survives_restart_and_only_a_later_approval_reopens() {
    let harness = Harness::new();
    let fixture = &harness.fixture;
    fixture.rules.lock().unwrap().push(rule("edit", "*", "ask"));
    let session = fixture.session_with(
        "ses_member",
        None,
        ["auto", "manual", "manual"],
        false,
        None,
    );
    let expected = fingerprint_of("edit", "src/a.rs");
    review_event(
        fixture,
        "ses_member",
        "rvw_one",
        10,
        "reject",
        &text_of(&expected),
    );

    let permissions = fixture.permissions();
    let waiting = tokio::spawn({
        let permissions = permissions.clone();
        let request = request(&session, "per_member");
        async move { permissions.assert(request, None).await }
    });
    until(|| !permissions.list().is_empty()).await;
    let id = permission::Id::new("per_member").unwrap();
    let fingerprint = permissions.snapshot(&id).unwrap().fingerprint;
    assert_eq!(&fingerprint, expected.as_lossless());

    let held = permissions
        .reconsider(&id, reconsider(&fingerprint))
        .await
        .unwrap();
    assert_eq!(held.outcome, DecisionOutcome::Escalated);
    assert_eq!(
        held.reason.as_ref().and_then(|reason| reason.as_str()),
        Some("explicit-rejected")
    );
    assert!(permissions.snapshot(&id).is_some());

    review_event(
        fixture,
        "ses_member",
        "rvw_two",
        20,
        "once",
        &text_of(&expected),
    );
    let reopened = permissions
        .reconsider(&id, reconsider(&fingerprint))
        .await
        .unwrap();
    assert!(reopened.settled);
    assert_eq!(reopened.outcome, DecisionOutcome::Allowed);
    assert_eq!(reopened.via, Some("auto-permission"));
    tokio::time::timeout(BOUND, waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

fn text_of(fingerprint: &Fingerprint) -> String {
    fingerprint.as_lossless().to_utf8().unwrap()
}

const ATTRIBUTION: [&str; 5] = [
    "choice",
    "actor",
    "coordinatorSessionID",
    "groupID",
    "rationale",
];

fn has(data: &JsonValue, key: &str) -> bool {
    matches!(data, JsonValue::Object(object) if object.get(&key.into()).is_some())
}

fn published(fixture: &Fixture, kind: &str) -> Vec<JsonValue> {
    fixture
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.type_ == kind)
        .map(|event| event.data.clone())
        .collect()
}

fn stored_autonomy(fixture: &Fixture, id: &str) -> Option<JsonValue> {
    fixture
        .store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&session_key(id))
        .unwrap()
        .expect("session row")
        .autonomy
}

fn invalid<T>(fingerprint: &LosslessString) -> Reconsider<T> {
    Reconsider {
        gate: Gate {
            validate: Arc::new(|_| Box::pin(async { false })),
            current: Arc::new(|| true),
        },
        ..reconsider(fingerprint)
    }
}

#[tokio::test]
async fn enabling_yolo_settles_a_manual_ask_without_evaluation_or_coordinator_attribution() {
    let harness = Harness::new();
    let fixture = &harness.fixture;
    fixture.rules.lock().unwrap().push(rule("edit", "*", "ask"));
    let session = fixture.session_with(
        "ses_member",
        None,
        ["manual", "manual", "manual"],
        false,
        None,
    );
    let permissions = fixture.permissions();
    let waiting = tokio::spawn({
        let permissions = permissions.clone();
        let request = request(&session, "per_member");
        async move { permissions.assert(request, None).await }
    });
    until(|| !permissions.list().is_empty()).await;
    let id = permission::Id::new("per_member").unwrap();
    let fingerprint = permissions.snapshot(&id).unwrap().fingerprint;

    let revoked = permissions
        .reconsider(&id, invalid(&fingerprint))
        .await
        .unwrap();
    assert!(!revoked.settled);
    assert_eq!(revoked.outcome, DecisionOutcome::Escalated);
    assert_eq!(
        revoked.reason.as_ref().and_then(|reason| reason.as_str()),
        Some("delegation-invalid")
    );
    assert!(permissions.snapshot(&id).is_some());

    fixture.session_with(
        "ses_member",
        None,
        ["yolo", "manual", "manual"],
        false,
        None,
    );
    let before = stored_autonomy(fixture, "ses_member");
    let result = permissions
        .reconsider(&id, reconsider(&fingerprint))
        .await
        .unwrap();
    assert!(result.settled);
    assert_eq!(result.outcome, DecisionOutcome::Allowed);
    assert_eq!(result.via, Some("yolo"));
    tokio::time::timeout(BOUND, waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let allowed = |fixture: &Fixture| {
        durable(fixture, &session, "session.permission.assessed.1")
            .into_iter()
            .filter(|data| text(get(data, "outcome")) == "allow")
            .collect::<Vec<_>>()
    };
    let assessed = allowed(fixture);
    assert_eq!(assessed.len(), 1);
    assert_eq!(text(get(&assessed[0], "requestID")), "per_member");
    assert_eq!(text(get(&assessed[0], "via")), "yolo");
    assert_eq!(text(get(&assessed[0], "reply")), "once");
    for key in ATTRIBUTION {
        assert!(!has(&assessed[0], key), "{key}");
    }
    let replied = published(fixture, "permission.replied");
    assert_eq!(replied.len(), 1);
    assert_eq!(text(get(&replied[0], "requestID")), "per_member");
    assert_eq!(text(get(&replied[0], "reply")), "once");
    assert_eq!(stored_autonomy(fixture, "ses_member"), before);

    let second = permissions
        .reconsider(&id, reconsider(&fingerprint))
        .await
        .unwrap();
    assert!(!second.settled);
    assert_eq!(second.outcome, DecisionOutcome::Stale);
    assert_eq!(allowed(fixture).len(), 1);
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
}

async fn settled(
    wait: ycoding_core::tools::policy::Wait<
        Result<
            ycoding_core::process::guardrails::Reservation,
            ycoding_core::process::guardrails::Error,
        >,
    >,
) -> Result<ycoding_core::process::guardrails::Reservation, ycoding_core::process::guardrails::Error>
{
    tokio::time::timeout(BOUND, wait)
        .await
        .expect("guardrail settlement timed out")
        .expect("guardrail sender dropped")
}

#[tokio::test]
async fn enabling_yolo_settles_a_manual_review_without_evaluation_or_coordinator_attribution() {
    let harness = Harness::new();
    let root = harness.fixture.session_with(
        "ses_root",
        None,
        ["manual", "manual", "manual"],
        false,
        None,
    );
    let fake = Fake::new(vec![grades(0.95, 0.02, 0.02)]);
    let service = guardrails(&harness, &fake);
    let admission = service.assert(review_input(&root)).unwrap();
    assert_eq!(admission.effect, Effect::Ask);
    let asked = admission.request.unwrap();
    assert_ne!(asked.hard_review, Some(true));
    let fingerprint = service
        .request_snapshot(&root, &asked.id)
        .unwrap()
        .unwrap()
        .fingerprint;

    let revoked = service
        .reconsider(&root, &asked.id, invalid(&fingerprint))
        .await
        .unwrap();
    assert!(!revoked.settled);
    assert_eq!(revoked.outcome, DecisionOutcome::Escalated);
    assert_eq!(
        revoked.reason.as_ref().and_then(|reason| reason.as_str()),
        Some("delegation-invalid")
    );
    assert!(
        service
            .request_snapshot(&root, &asked.id)
            .unwrap()
            .is_some()
    );

    harness
        .fixture
        .session_with("ses_root", None, ["manual", "yolo", "manual"], false, None);
    let before = stored_autonomy(&harness.fixture, "ses_root");
    let result = service
        .reconsider(&root, &asked.id, reconsider(&fingerprint))
        .await
        .unwrap();
    assert!(result.settled);
    assert_eq!(result.outcome, DecisionOutcome::Allowed);
    assert_eq!(result.via, Some("yolo"));
    settled(admission.wait.unwrap()).await.unwrap().release();
    assert!(fake.seen.lock().unwrap().is_empty());
    assert_eq!(fake.replies.lock().unwrap().len(), 1);

    let decided = durable(&harness.fixture, &root, "session.guardrail.decided.1");
    assert_eq!(decided.len(), 1);
    assert_eq!(
        guardrail::RequestId::decode(get(&decided[0], "requestID")).unwrap(),
        asked.id
    );
    assert_eq!(text(get(&decided[0], "reply")), "once");
    assert_eq!(text(get(&decided[0], "authority")), "yolo");
    for key in ATTRIBUTION {
        assert!(!has(&decided[0], key), "{key}");
    }
    let replied = published(&harness.fixture, "guardrail.replied")
        .iter()
        .map(|data| guardrail::RepliedData::decode(data).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(replied.len(), 1);
    assert_eq!(replied[0].request_id, asked.id);
    assert_eq!(replied[0].reply, guardrail::Reply::Once);
    assert_eq!(replied[0].authority, Some(guardrail::Authority::Yolo));
    assert!(replied[0].decided_by.is_none());
    assert!(replied[0].choice.is_none());
    assert_eq!(stored_autonomy(&harness.fixture, "ses_root"), before);

    let second = service
        .reconsider(&root, &asked.id, reconsider(&fingerprint))
        .await
        .unwrap();
    assert!(!second.settled);
    assert_eq!(second.outcome, DecisionOutcome::Stale);
    assert_eq!(
        durable(&harness.fixture, &root, "session.guardrail.decided.1").len(),
        1
    );
}

#[tokio::test]
async fn auto_reconsideration_never_overrides_an_explicit_guardrail_rejection() {
    let harness = Harness::new();
    let root = harness.fixture.session_with(
        "ses_root",
        None,
        ["manual", "manual", "manual"],
        false,
        None,
    );
    let fake = Fake::new(vec![grades(0.95, 0.02, 0.02)]);
    let service = guardrails(&harness, &fake);

    let first = service.assert(review_input(&root)).unwrap();
    let rejected = first.request.unwrap();
    service
        .reply(&root, &rejected.id, guardrail::Reply::Reject)
        .unwrap();
    assert!(settled(first.wait.unwrap()).await.is_err());

    harness
        .fixture
        .session_with("ses_root", None, ["manual", "auto", "manual"], false, None);
    let second = service.assert(review_input(&root)).unwrap();
    assert_eq!(second.effect, Effect::Ask);
    let again = second.request.unwrap();
    let fingerprint = service
        .request_snapshot(&root, &again.id)
        .unwrap()
        .unwrap()
        .fingerprint;
    let result = service
        .reconsider(&root, &again.id, reconsider(&fingerprint))
        .await
        .unwrap();
    assert!(!result.settled);
    assert_eq!(result.outcome, DecisionOutcome::Escalated);
    assert_eq!(
        result.reason.as_ref().and_then(|reason| reason.as_str()),
        Some("explicit-rejected")
    );
    assert!(
        service
            .request_snapshot(&root, &again.id)
            .unwrap()
            .is_some()
    );
    assert!(fake.seen.lock().unwrap().is_empty());
    assert_eq!(fake.replies.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn pending_requests_concatenate_by_kind_before_truncating() {
    let harness = Harness::new();
    let fixture = &harness.fixture;
    fixture.rules.lock().unwrap().push(rule("read", "*", "ask"));
    let master = fixture.session("ses_master", None, 0, false, None);
    let member = fixture.session("ses_member", None, 0, false, None);
    let client = fixture.store.client();
    let projects = coordination::Service::new(client.clone(), Feed::attach(&client));
    let group = projects
        .create(c::CreateInput {
            name: "Synthetic".into(),
            master_session_id: master.clone(),
            member_session_ids: vec![member.clone()],
        })
        .await
        .unwrap();

    let permissions = fixture.permissions();
    let forms = Forms::new(fixture.authority(), fixture.publisher());
    let question = form::Info::decode(
        &parse_json(
            r#"{"id":"frm_older","sessionID":"ses_member","title":"Choose","fields":[{"key":"flag","type":"boolean","default":true}]}"#,
        )
        .unwrap(),
    )
    .unwrap();
    let _waiting_form = forms.ask(question).unwrap();
    let waiting = tokio::spawn({
        let permissions = permissions.clone();
        let mut request = request(&member, "per_newer");
        request.action = "read".into();
        async move { permissions.assert(request, None).await }
    });
    until(|| !permissions.list().is_empty()).await;

    let services = Services {
        permissions: permissions.clone(),
        forms,
        guardrails: Guardrails::new(
            fixture.authority(),
            permissions,
            settings(),
            fixture.publisher(),
        ),
        lease: Arc::new(()),
        is_current: Arc::new(|| true),
    };
    let decisions = CoordinationDecisions::new(Options {
        coordination: projects,
        settings: Arc::new(|| Box::pin(async { Err(coordination::Error::refused("unused")) })),
        services: Arc::new(move |_| {
            let services = services.clone();
            Box::pin(async move { Ok(Some(services)) })
        }),
        now: None,
    });
    let pending = |limit| PendingInput {
        group_id: group.id.clone(),
        coordinator_session_id: master.clone(),
        target_session_id: member.clone(),
        descendant_session_ids: vec![],
        limit,
    };
    let all = decisions.pending(pending(None)).await.unwrap();
    assert_eq!(
        all.iter().map(|item| item.summary.kind).collect::<Vec<_>>(),
        [c::RequestKind::Permission, c::RequestKind::Question],
        "permissions precede questions regardless of creation order"
    );
    let one = decisions.pending(pending(Some(1))).await.unwrap();
    assert_eq!(
        one.iter().map(|item| item.summary.kind).collect::<Vec<_>>(),
        [c::RequestKind::Permission]
    );
    waiting.abort();
}
