#[path = "guardrail_service_decisions_support/mod.rs"]
mod support;

pub use support::{Fixture, Seen};

use std::{sync::Arc, time::Duration};
use support::{Fake, Harness, refusal};
use ycoding_core::{
    process::guardrails::{self, Guardrails, Input, Limits, Paths, Settings},
    session::{review, store::Service},
    tools::policy::Effect,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, LosslessString, ObjectEncoder, event, guardrail, parse_json,
    session_id::SessionId, session_message, session_review,
};
use ycoding_store::session::NewEvent;

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

fn guardrails(harness: &Harness) -> Guardrails {
    Guardrails::new(
        harness.fixture.authority(),
        harness.fixture.permissions(),
        settings(),
        harness.publish.clone(),
    )
    .with_reviews(harness.review_policy())
}

fn event(session: &SessionId, kind: &str, id: &str, time: i64, fields: &str) -> NewEvent {
    NewEvent {
        id: id.into(),
        aggregate_id: session.as_lossless().clone(),
        created: time,
        type_: format!("{kind}.1").into(),
        data: parse_json(&format!(
            r#"{{"sessionID":{}{fields}}}"#,
            ycoding_schema::stringify_json(&session.encode())
        ))
        .unwrap(),
    }
}

#[tokio::test]
async fn escalation_is_a_canonical_chronological_system_message_in_the_reviewed_session() {
    for (fields, summary) in [
        (
            r#", "choice":"escalate","confidence":0.95"#,
            "choice escalate · confidence 0.95",
        ),
        ("", "choice unreported · confidence unreported"),
    ] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, 0, false, None);
        let child = harness
            .fixture
            .session("ses_child", Some("ses_root"), 0, false, None);
        let service = Service::new(harness.fixture.store.client());
        service
            .publish(event(
                &child,
                "session.synthetic",
                "evt_before",
                10,
                r#", "text":"before""#,
            ))
            .await
            .unwrap();
        let escalation = service
            .publish(event(
                &child,
                "session.guardrail.escalated",
                "evt_escalated",
                20,
                &format!(
                    r#", "requestID":"grq_review","ruleIDs":["standard.review.outside"]{fields}"#
                ),
            ))
            .await
            .unwrap();
        service
            .publish(event(
                &child,
                "session.synthetic",
                "evt_after",
                30,
                r#", "text":"after""#,
            ))
            .await
            .unwrap();

        let rehydrated = Service::new(harness.fixture.store.client());
        let snapshot = rehydrated.snapshot(&child, 100, None).unwrap();
        assert_eq!(snapshot.messages.len(), 3);
        assert_eq!(snapshot.watermark, Some(2));
        assert!(
            matches!(&snapshot.messages[0], session_message::Info::Synthetic(message) if message.text.as_str() == Some("before"))
        );
        assert!(
            matches!(&snapshot.messages[2], session_message::Info::Synthetic(message) if message.text.as_str() == Some("after"))
        );
        let session_message::Info::System(message) = &snapshot.messages[1] else {
            panic!("escalation must be a trusted System observation")
        };
        assert_eq!(
            message.id,
            session_message::Id::from_event(&event::Id::new("evt_escalated").unwrap())
        );
        assert_eq!(message.time.created.epoch_millis(), 20);
        assert!(message.metadata.is_none());
        assert_eq!(
            message.text.as_str(),
            Some(format!("Decision model escalated this guardrail review · {summary}").as_str())
        );
        assert_eq!(
            rehydrated.message(&message.id).unwrap(),
            Some((child.clone(), snapshot.messages[1].clone()))
        );
        assert_eq!(rehydrated.transcript(&child).unwrap(), snapshot.messages);
        assert!(
            rehydrated
                .snapshot(&root, 100, None)
                .unwrap()
                .messages
                .is_empty()
        );
        let log = rehydrated.log(&child, Some(0), 1).unwrap();
        assert_eq!(log.events.len(), 1);
        assert_eq!(log.events[0].seq, 1);
        assert_eq!(log.events[0].event.0.id.as_lossless(), &escalation.id);
        assert!(rehydrated.log(&root, None, 100).unwrap().events.is_empty());
    }
}

#[tokio::test]
async fn non_message_provenance_stays_on_the_root_log_and_rehydrates_reviewed_session_status() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    let child = harness
        .fixture
        .session("ses_child", Some("ses_root"), 0, false, None);
    let sibling = harness
        .fixture
        .session("ses_sibling", Some("ses_root"), 0, false, None);
    let service = Service::new(harness.fixture.store.client());
    let source = guardrail::Source {
        message_id: session_message::Id::new("msg_source").unwrap(),
        call_id: "call_source".into(),
    };
    let dismissal = service
        .publish(NewEvent {
            id: "evt_dismissed".into(),
            aggregate_id: root.as_lossless().clone(),
            created: 10,
            type_: "session.guardrail.dismissed.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", &root)
                .field("reviewSessionID", &child)
                .field("ruleID", "standard.review.outside")
                .field("confidence", &0.95_f64)
                .field("source", &source)
                .finish(),
        })
        .await
        .unwrap();
    service
        .publish(NewEvent {
            id: "evt_decided".into(),
            aggregate_id: root.as_lossless().clone(),
            created: 20,
            type_: "session.guardrail.decided.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", &root)
                .field("reviewSessionID", &child)
                .field("requestID", "grq_review")
                .field("reply", &guardrail::Reply::Once)
                .field("choice", &guardrail::DecisionChoice::Approve)
                .field("confidence", &0.85_f64)
                .field("ruleIDs", &vec![LosslessString::from("custom.review")])
                .field("source", &source)
                .finish(),
        })
        .await
        .unwrap();

    let status = guardrails(&harness).status(&child).unwrap();
    assert_eq!(status.root_session_id, root);
    let dismissals = status.dismissals.unwrap();
    assert_eq!(dismissals.len(), 1);
    assert_eq!(dismissals[0].session_id, child);
    assert_eq!(dismissals[0].event_id, dismissal.id);
    assert_eq!(dismissals[0].source.as_ref(), Some(&source));
    let decisions = status.decisions.unwrap();
    assert_eq!(decisions.len(), 1);
    assert_eq!(decisions[0].session_id, child);
    assert_eq!(decisions[0].source.as_ref(), Some(&source));
    assert_eq!(decisions[0].reply, guardrail::Reply::Once);
    for session in [&root, &child, &sibling] {
        assert!(
            service
                .snapshot(session, 100, None)
                .unwrap()
                .messages
                .is_empty()
        );
        assert!(service.transcript(session).unwrap().is_empty());
    }
    let root_log = service.log(&root, None, 1).unwrap();
    assert_eq!(root_log.events.len(), 1);
    assert_eq!(root_log.events[0].seq, 0);
    assert_eq!(root_log.watermark, Some(1));
    let remaining = service.log(&root, Some(0), 1).unwrap();
    assert_eq!(remaining.events.len(), 1);
    assert_eq!(remaining.events[0].seq, 1);
    assert_eq!(
        remaining.events[0].event.0.event_type.as_str(),
        Some("session.guardrail.decided")
    );
    for session in [&child, &sibling] {
        let log = service.log(session, None, 100).unwrap();
        assert!(log.events.is_empty());
        assert!(log.watermark.is_none());
    }
}

#[tokio::test]
async fn a_matching_human_grant_bypasses_helpers_once_without_replaying_the_action() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    harness.autonomy.set_sleep(&root, true).await.unwrap();
    let fake = Fake::new(vec![
        refusal("guardrail_match"),
        refusal("guardrail"),
        refusal("guardrail_match"),
        refusal("guardrail"),
    ]);
    let service = guardrails(&harness).with_decision(fake.clone());
    let input = Input {
        session_id: root.clone(),
        action: "shell".into(),
        resources: vec!["git reset --hard".into()],
        metadata: None,
        skip_review: false,
        holder: None,
        source: Some(guardrail::Source {
            message_id: session_message::Id::new("msg_source").unwrap(),
            call_id: "call_source".into(),
        }),
    };
    let admission = service.assert(input.clone()).unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), admission.wait.unwrap())
            .await
            .unwrap()
            .unwrap(),
        Err(guardrails::Error::Deferred { .. })
    ));
    let item = harness.reviews.list(&root).unwrap().pop().unwrap();
    harness
        .reviews
        .decide(review::DecideInput {
            session_id: root.clone(),
            item_id: item.deferral.item_id,
            now: 30,
            decision: session_review::Decision::decode(
                &parse_json(r#"{"kind":"guardrail","reply":"once"}"#).unwrap(),
            )
            .unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(fake.seen.lock().unwrap().len(), 2);
    assert!(service.for_session(&root).unwrap().is_empty());
    let admission = service.assert(input.clone()).unwrap();
    assert_eq!(admission.effect, Effect::Allow);
    admission.reservation.unwrap().release();
    assert_eq!(fake.seen.lock().unwrap().len(), 2);
    assert!(
        Service::new(harness.fixture.store.client())
            .log(&root, None, 100)
            .unwrap()
            .events
            .iter()
            .all(|entry| entry.event.0.event_type.as_str() != Some("session.guardrail.escalated"))
    );

    harness.autonomy.set_sleep(&root, false).await.unwrap();
    let admission = service.assert(input).unwrap();
    let request = guardrail::Request::decode(&harness.event("guardrail.asked").await).unwrap();
    assert_eq!(fake.seen.lock().unwrap().len(), 4);
    service
        .reply(&root, &request.id, guardrail::Reply::Once)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), admission.wait.unwrap())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .release();
    assert!(fake.replies.lock().unwrap().is_empty());
}
