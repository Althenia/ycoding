include!("policy_fixture.rs");

use std::{sync::Arc, time::Duration};
use ycoding_core::{
    coordination::{
        decisions::{Appended, Gate, Reconsider, Source, append, routine_eligible},
        runtime::{Decision, DecisionOutcome},
    },
    tools::policy::permissions::Permissions,
};
use ycoding_schema::{
    JsonValue, LosslessString, coordination as c, parse_json, permission, project_id::ProjectId,
    session_id::SessionId,
};

const BOUND: Duration = Duration::from_secs(10);

#[test]
fn routine_eligibility_is_limited_to_reads_local_writes_and_simple_read_only_shell() {
    let shell =
        |command: &str| routine_eligible(c::RequestKind::Permission, "shell", &[command.into()]);
    assert!(routine_eligible(c::RequestKind::Question, "anything", &[]));
    assert!(routine_eligible(c::RequestKind::Permission, "read", &[]));
    assert!(routine_eligible(c::RequestKind::Review, "edit", &[]));
    assert!(!routine_eligible(
        c::RequestKind::Permission,
        "webhook",
        &[]
    ));
    assert!(!routine_eligible(c::RequestKind::Permission, "shell", &[]));
    assert!(shell("git status"));
    assert!(shell("/usr/bin/cat notes.md"));
    assert!(shell("find . -name '*.rs'"));
    for rejected in [
        "git push",
        "ls; rm x",
        "cat a | sh",
        "echo $(id)",
        "cat > out",
        "find . -delete",
        "find . -exec rm {} +",
        "rg --pre sh x",
        "curl example.invalid",
        "git commit",
    ] {
        assert!(!shell(rejected), "{rejected}");
    }
}

fn source(reason: &str) -> Source {
    Source {
        coordinator_session_id: SessionId::new("ses_coordinator").unwrap(),
        group_id: Some("cgrp_synthetic".into()),
        rationale: reason.into(),
    }
}

#[test]
fn escalation_chain_appends_dedupes_and_stops_at_the_cap() {
    let mut current = None;
    for index in 0..c::MAX_ESCALATION_REASONS {
        let appended = append(current.as_ref(), &source(&format!("reason {index}")));
        let Appended::Added(value) = appended else {
            panic!("reason {index} is added")
        };
        current = Some(value);
    }
    let again = append(current.as_ref(), &source("reason 0"));
    assert!(matches!(again, Appended::Unchanged(_)));
    let full = append(current.as_ref(), &source("one too many"));
    let Appended::Full(kept) = full else {
        panic!("chain is full")
    };
    assert_eq!(kept.reasons.len(), c::MAX_ESCALATION_REASONS);
}

fn gate(validate: bool, current: bool) -> Gate<permission::Request> {
    Gate {
        validate: Arc::new(move |_| Box::pin(async move { validate })),
        current: Arc::new(move || current),
    }
}

fn reconsider(
    fingerprint: &LosslessString,
    decision: Option<Decision>,
    gate: Gate<permission::Request>,
) -> Reconsider<permission::Request> {
    Reconsider {
        fingerprint: fingerprint.clone(),
        source: source("Synthetic coordinator reason"),
        decision,
        answer: None,
        confidence: None,
        gate,
    }
}

fn ask_rule() -> permission::Rule {
    permission::Rule {
        action: "read".into(),
        resource: "*".into(),
        effect: permission::Effect("ask".into()),
    }
}

fn request(session: &SessionId, metadata: Option<&str>) -> permission::Request {
    permission::Request {
        id: permission::Id::new("per_coordinated").unwrap(),
        session_id: session.clone(),
        action: "read".into(),
        resources: vec!["notes/plan.md".into()],
        save: None,
        metadata: metadata.map(|text| match parse_json(text).unwrap() {
            JsonValue::Object(object) => object,
            _ => panic!("metadata is an object"),
        }),
        source: None,
        escalation: None,
        coordination_escalation: None,
    }
}

struct Pending {
    _fixture: Fixture,
    permissions: Permissions,
    session: SessionId,
    id: permission::Id,
    waiting: tokio::task::JoinHandle<Result<(), ycoding_core::tools::policy::permissions::Error>>,
}

async fn pending(mode: &str, metadata: Option<&str>) -> Pending {
    let fixture = Fixture::default();
    fixture.rules.lock().unwrap().push(ask_rule());
    let session = fixture.session_with("ses_member", None, [mode, "manual", "manual"], false, None);
    let permissions = Permissions::new(
        fixture.authority(),
        ProjectId::new("project").unwrap(),
        fixture.publisher(),
    );
    let request = request(&session, metadata);
    let id = request.id.clone();
    let waiting = tokio::spawn({
        let permissions = permissions.clone();
        async move { permissions.assert(request, None).await }
    });
    tokio::time::timeout(BOUND, async {
        while permissions.list().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the ask becomes pending");
    Pending {
        _fixture: fixture,
        permissions,
        session,
        id,
        waiting,
    }
}

#[tokio::test]
async fn escalation_keeps_the_fingerprint_and_records_the_chain_once() {
    let pending = pending("manual", None).await;
    let before = pending.permissions.snapshot(&pending.id).unwrap();
    let request = ycoding_core::coordination::decisions::EscalateRequest {
        session_id: pending.session.clone(),
        fingerprint: before.fingerprint.clone(),
        source: source("Synthetic escalation"),
        handoff: false,
        current: Arc::new(|| true),
    };
    let first = pending
        .permissions
        .escalate(&pending.id, request.clone())
        .unwrap();
    assert_eq!(first.coordination_escalation.unwrap().reasons.len(), 1);
    let after = pending.permissions.snapshot(&pending.id).unwrap();
    assert_eq!(after.fingerprint, before.fingerprint);
    assert_eq!(
        after.request.coordination_escalation.unwrap().reasons.len(),
        1
    );
    let repeat = pending.permissions.escalate(&pending.id, request).unwrap();
    assert_eq!(repeat.coordination_escalation.unwrap().reasons.len(), 1);
    assert!(pending.permissions.snapshot(&pending.id).is_some());
}

#[tokio::test]
async fn escalation_with_a_changed_fingerprint_or_stale_location_is_stale() {
    let pending = pending("manual", None).await;
    let snapshot = pending.permissions.snapshot(&pending.id).unwrap();
    let request = |fingerprint: LosslessString, current: bool| {
        ycoding_core::coordination::decisions::EscalateRequest {
            session_id: pending.session.clone(),
            fingerprint,
            source: source("Synthetic escalation"),
            handoff: false,
            current: Arc::new(move || current),
        }
    };
    assert!(
        pending
            .permissions
            .escalate(&pending.id, request("other".into(), true))
            .unwrap()
            .stale
    );
    assert!(
        pending
            .permissions
            .escalate(&pending.id, request(snapshot.fingerprint.clone(), false))
            .unwrap()
            .stale
    );
    assert!(
        pending
            .permissions
            .snapshot(&pending.id)
            .unwrap()
            .request
            .coordination_escalation
            .is_none()
    );
}

#[tokio::test]
async fn manual_permissions_keep_native_reconsideration_pending_and_settle_a_coordinator_decline() {
    let pending = pending("manual", None).await;
    let fingerprint = pending
        .permissions
        .snapshot(&pending.id)
        .unwrap()
        .fingerprint;
    let native = pending
        .permissions
        .reconsider(
            &pending.id,
            reconsider(&fingerprint, None, gate(true, true)),
        )
        .await
        .unwrap();
    assert_eq!(native.outcome, DecisionOutcome::Escalated);
    assert!(!native.settled);
    assert!(pending.permissions.snapshot(&pending.id).is_some());
    let declined = pending
        .permissions
        .reconsider(
            &pending.id,
            reconsider(&fingerprint, Some(Decision::Decline), gate(true, true)),
        )
        .await
        .unwrap();
    assert_eq!(declined.outcome, DecisionOutcome::Denied);
    assert!(declined.settled);
    assert!(
        tokio::time::timeout(BOUND, pending.waiting)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
}

#[tokio::test]
async fn a_changed_fingerprint_is_stale_and_leaves_the_request_pending() {
    let pending = pending("manual", None).await;
    let result = pending
        .permissions
        .reconsider(
            &pending.id,
            reconsider(&"stale-fingerprint".into(), None, gate(true, true)),
        )
        .await
        .unwrap();
    assert_eq!(result.outcome, DecisionOutcome::Stale);
    assert!(pending.permissions.snapshot(&pending.id).is_some());
}

#[tokio::test]
async fn revoked_delegation_or_stale_location_escalates_without_settling() {
    let pending = pending("manual", None).await;
    let fingerprint = pending
        .permissions
        .snapshot(&pending.id)
        .unwrap()
        .fingerprint;
    for gate in [gate(false, true), gate(true, false)] {
        let result = pending
            .permissions
            .reconsider(
                &pending.id,
                reconsider(&fingerprint, Some(Decision::Decline), gate),
            )
            .await
            .unwrap();
        assert_eq!(result.outcome, DecisionOutcome::Escalated);
        assert_eq!(
            result.reason.as_ref().and_then(|reason| reason.as_str()),
            Some("delegation-invalid")
        );
    }
    assert!(pending.permissions.snapshot(&pending.id).is_some());
}

#[tokio::test]
async fn coordinator_approval_settles_a_request_marked_require_explicit_decision() {
    let pending = pending("manual", Some(r#"{"requireExplicitDecision":true}"#)).await;
    let fingerprint = pending
        .permissions
        .snapshot(&pending.id)
        .unwrap()
        .fingerprint;
    let result = pending
        .permissions
        .reconsider(
            &pending.id,
            reconsider(&fingerprint, Some(Decision::Approve), gate(true, true)),
        )
        .await
        .unwrap();
    assert_eq!(result.outcome, DecisionOutcome::Allowed, "{result:?}");
    assert!(result.settled);
    assert!(pending.permissions.snapshot(&pending.id).is_none());
    assert!(
        tokio::time::timeout(BOUND, pending.waiting)
            .await
            .unwrap()
            .unwrap()
            .is_ok()
    );
}
