include!("policy_fixture.rs");

use std::{
    future::Future,
    ops::Bound,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};
use ycoding_core::{
    process::guardrails::{self, CustomLayer, Guardrails, Input, Limits, Paths, Settings},
    resources::decision::Invocation,
    session::{review, store},
    tools::policy::{
        Effect, Reviews,
        permissions::{self, Permissions},
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, ObjectEncoder, guardrail,
    parse_json, permission,
    session_id::SessionId,
    session_review::{self, Decision, Item, Origin, Payload, Reason},
};
use ycoding_store::{
    KeyPart,
    session::{PendingTable, SessionTable},
    tuple_key,
};

#[derive(Default)]
struct Delivery(Mutex<Vec<SessionId>>);

impl review::Delivery for Delivery {
    fn wake(&self, session: &SessionId) {
        self.0.lock().unwrap().push(session.clone());
    }

    fn answer_child<'a>(&'a self, _: review::ChildAnswer) -> review::DeliveryFuture<'a> {
        Box::pin(async { Err(review::DeliveryError::Conflict("no child".into())) })
    }

    fn resolve_recovery<'a>(&'a self, _: review::RecoveryResolution) -> review::DeliveryFuture<'a> {
        Box::pin(async { Err(review::DeliveryError::Conflict("no recovery".into())) })
    }
}

struct Harness {
    fixture: Fixture,
    reviews: review::Service,
    delivery: Arc<Delivery>,
    root: SessionId,
}

impl Harness {
    fn new(permission_mode: &str, guardrail_mode: &str) -> Self {
        let fixture = Fixture::default();
        let root = fixture.session_with(
            "ses_deferral",
            None,
            [permission_mode, guardrail_mode, "manual"],
            false,
            None,
        );
        fixture.rules.lock().unwrap().push(permission::Rule {
            action: "*".into(),
            resource: "*".into(),
            effect: permission::Effect("ask".into()),
        });
        let delivery = Arc::new(Delivery::default());
        let reviews = review::Service::new(
            store::Service::new(fixture.store.client()),
            delivery.clone(),
        );
        Self {
            fixture,
            reviews,
            delivery,
            root,
        }
    }

    fn policy(&self, limit: usize) -> Reviews {
        Reviews {
            service: self.reviews.clone(),
            limit,
        }
    }

    fn permissions(&self, limit: usize) -> Permissions {
        self.fixture
            .permissions()
            .with_reviews(self.policy(limit), "/workspace/project".into())
    }

    fn guardrails(&self, limit: usize, custom: Option<guardrail::RuleDecision>) -> Guardrails {
        let mut settings = Settings {
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
            decide_reviews: false,
            decide_hard_reviews: true,
        };
        if let Some(decision) = custom {
            let rule = guardrail::Rule::decode(
                &ObjectEncoder::new()
                    .field("id", "custom.deferral")
                    .field("source", "custom")
                    .field("decision", &decision)
                    .field("actions", &vec![LosslessString::from("shell")])
                    .field("resources", &vec![LosslessString::from("*")])
                    .field("reason", "Synthetic review")
                    .field("priority", &0.0)
                    .finish(),
            )
            .unwrap();
            settings.custom = Arc::new(move || {
                vec![CustomLayer {
                    rules: vec![rule.clone()],
                    invalid_files: vec![],
                }]
            });
        }
        Guardrails::new(
            self.fixture.authority(),
            self.fixture.permissions(),
            settings,
            self.fixture.publisher(),
        )
        .with_reviews(self.policy(limit))
    }

    fn items(&self) -> Vec<Item> {
        self.reviews.list(&self.root).unwrap()
    }

    fn emitted(&self, kind: &str) -> usize {
        self.fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.type_ == kind)
            .count()
    }

    async fn decide(&self, item: &Item, kind: &str, reply: &str) {
        self.reviews
            .decide(review::DecideInput {
                session_id: self.root.clone(),
                item_id: item.deferral.item_id.clone(),
                decision: Decision::decode(
                    &parse_json(&format!(r#"{{"kind":"{kind}","reply":"{reply}"}}"#)).unwrap(),
                )
                .unwrap(),
                now: 20,
            })
            .await
            .unwrap();
    }

    fn assert_no_delivery(&self) {
        assert!(self.delivery.0.lock().unwrap().is_empty());
        assert!(
            self.fixture
                .store
                .snapshot()
                .unwrap()
                .scan::<PendingTable>(Bound::Unbounded, Bound::Unbounded, 1)
                .unwrap()
                .is_empty()
        );
    }
}

fn metadata(extra: &str) -> JsonObject {
    let JsonValue::Object(object) = parse_json(&format!(
        r#"{{"cwd":"/workspace/project","workdir":"/workspace/project","argv":["write","file"],"transient":"{extra}"}}"#,
    )).unwrap() else { panic!("object") };
    object
}

fn request(session: &SessionId, id: &str, extra: &str) -> permission::Request {
    permission::Request {
        id: permission::Id::new(id).unwrap(),
        session_id: session.clone(),
        action: "edit".into(),
        resources: vec!["file".into()],
        save: Some(vec!["file".into()]),
        metadata: Some(metadata(extra)),
        source: None,
        escalation: None,
        coordination_escalation: None,
    }
}

fn input(session: &SessionId, command: &str, extra: &str) -> Input {
    Input {
        session_id: session.clone(),
        action: "shell".into(),
        resources: vec![command.into()],
        metadata: Some(metadata(extra)),
        skip_review: false,
        holder: Some("cca:synthetic".into()),
        source: None,
    }
}

fn permission_outcome(error: permissions::Error) -> review::DeferOutcome {
    let permissions::Error::DeferredReview(deferred) = error else {
        panic!("expected explicit permission deferral: {error:?}")
    };
    let permissions::DeferredReview {
        request_id,
        session_id,
        outcome,
        action,
        resources,
    } = *deferred;
    assert!(
        request_id
            .as_lossless()
            .as_str()
            .unwrap()
            .starts_with("per_")
    );
    assert_eq!(session_id.as_lossless().as_str(), Some("ses_deferral"));
    assert_eq!(action.as_str(), Some("edit"));
    assert_eq!(resources, vec![LosslessString::from("file")]);
    outcome
}

async fn guardrail_error(
    admission: Result<guardrails::Admission, guardrails::Error>,
) -> guardrails::Error {
    match admission {
        Err(error) => error,
        Ok(admission) => match admission.wait {
            Some(wait) => match wait.await.unwrap() {
                Err(error) => error,
                Ok(reservation) => {
                    reservation.release();
                    panic!("unexpected approval")
                }
            },
            None => {
                if let Some(reservation) = admission.reservation {
                    reservation.release();
                }
                panic!("unexpected approval")
            }
        },
    }
}

fn guardrail_outcome(error: guardrails::Error, hard: bool) -> review::DeferOutcome {
    let guardrails::Error::DeferredReview(deferred) = error else {
        panic!("expected explicit guardrail deferral: {error:?}")
    };
    let guardrails::DeferredReview {
        request_id,
        session_id,
        outcome,
        action,
        resources,
        rule_ids,
        hard_review,
    } = *deferred;
    assert!(
        matches!(request_id.encode(), JsonValue::String(value) if value.as_str().unwrap().starts_with("grq_"))
    );
    assert_eq!(session_id.as_lossless().as_str(), Some("ses_deferral"));
    assert_eq!(action.as_str(), Some("shell"));
    assert_eq!(resources.len(), 1);
    assert!(!rule_ids.is_empty());
    assert_eq!(hard_review, hard);
    outcome
}

fn opened(outcome: review::DeferOutcome, expected_opened: bool) -> session_review::Id {
    let review::DeferOutcome::Open { item_id, opened } = outcome else {
        panic!("expected open item: {outcome:?}")
    };
    assert_eq!(opened, expected_opened);
    item_id
}

struct Unassessed;

impl guardrails::decision::Evaluator for Unassessed {
    fn evaluate<'a>(
        &'a self,
        _: JsonValue,
        _: Invocation<'a>,
    ) -> guardrails::decision::EvaluateFuture<'a> {
        panic!("native admission must not evaluate a model")
    }
}

fn set_modes(h: &Harness, permissions: &str, guardrails: &str) {
    let root = h.root.clone();
    let autonomy = format!(
        r#"{{"mode":"normal","permissions":"{permissions}","guardrails":"{guardrails}","answers":"manual"}}"#
    );
    h.fixture
        .store
        .submit(move |tx| {
            let key = tuple_key(&[KeyPart::String(root.as_lossless())]);
            let mut row = tx.get::<SessionTable>(&key)?.unwrap();
            row.autonomy = Some(parse_json(&autonomy).unwrap());
            row.autonomy_revision += 1;
            tx.put::<SessionTable>(&row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[tokio::test]
async fn permission_explicit_deferral_reuses_filtered_fingerprint_without_a_human_waiter() {
    let h = Harness::new("manual", "manual");
    let service = h.permissions(1);
    let first = permission_outcome(
        service
            .assert_deferred(request(&h.root, "per_first", "one"), None)
            .await
            .unwrap_err(),
    );
    let id = opened(first, true);
    let next = permission_outcome(
        service
            .assert_deferred(request(&h.root, "per_next", "two"), None)
            .await
            .unwrap_err(),
    );
    assert_eq!(opened(next, false), id);
    let mut different = request(&h.root, "per_over_limit", "three");
    different.resources = vec!["other".into()];
    assert!(matches!(
        service.assert_deferred(different, None).await,
        Err(permissions::Error::DeferredReview(deferred))
            if matches!(deferred.outcome, review::DeferOutcome::Full)
    ));
    assert!(service.list().is_empty());
    assert_eq!(h.items().len(), 1);
    assert!(
        matches!(&h.items()[0].deferral.origin, Origin::Request { request_id, executor: true } if request_id.as_str() == Some("per_first"))
    );
    assert_eq!(h.items()[0].deferral.reason, Reason::Disabled);
    let Payload::Permission(payload) = &h.items()[0].deferral.payload else {
        panic!("permission payload")
    };
    let JsonValue::Object(expected) = parse_json(
        r#"{"cwd":"/workspace/project","workdir":"/workspace/project","argv":["write","file"]}"#,
    )
    .unwrap() else {
        panic!("metadata")
    };
    assert_eq!(
        payload.fingerprint,
        review::fingerprint(&review::FingerprintInput {
            action: "edit".into(),
            resources: vec!["file".into()],
            workdir: "/workspace/project".into(),
            rule_ids: vec![],
            hard_review: false,
            metadata: Some(expected),
        })
    );
    assert_eq!(h.emitted("permission.asked"), 0);
    assert_eq!(h.emitted("permission.cancelled"), 0);
    assert_eq!(h.emitted("permission.deferred"), 0);
    h.assert_no_delivery();
}

#[tokio::test]
async fn permission_fingerprint_keeps_execution_metadata_and_session_scope() {
    let h = Harness::new("manual", "manual");
    let service = h.permissions(16);
    let first = opened(
        permission_outcome(
            service
                .assert_deferred(request(&h.root, "per_first", "one"), None)
                .await
                .unwrap_err(),
        ),
        true,
    );
    let mut changed = request(&h.root, "per_changed", "one");
    changed.metadata.as_mut().unwrap().insert(
        "argv".into(),
        JsonValue::Array(vec![JsonValue::String("other".into())]),
    );
    let second = opened(
        permission_outcome(service.assert_deferred(changed, None).await.unwrap_err()),
        true,
    );
    assert_ne!(first, second);
    let child = h
        .fixture
        .session("ses_child", Some("ses_deferral"), 0, false, None);
    let error = service
        .assert_deferred(request(&child, "per_child", "one"), None)
        .await
        .unwrap_err();
    assert!(
        matches!(error, permissions::Error::DeferredReview(deferred) if deferred.session_id == child && matches!(deferred.outcome, review::DeferOutcome::Open { opened: true, .. }))
    );
    assert_eq!(h.items().len(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn simultaneous_executor_deferrals_reuse_one_family_capped_item() {
    let h = Harness::new("manual", "manual");
    let service = h.permissions(1);
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let spawn = |id: &str| {
        let service = service.clone();
        let barrier = barrier.clone();
        let request = request(&h.root, id, "one");
        tokio::spawn(async move {
            barrier.wait().await;
            service.assert_deferred(request, None).await
        })
    };
    let first = spawn("per_first");
    let second = spawn("per_second");
    let mut ids = vec![];
    let mut opened_count = 0;
    for task in [first, second] {
        let outcome = permission_outcome(task.await.unwrap().unwrap_err());
        let review::DeferOutcome::Open { item_id, opened } = outcome else {
            panic!("reuse must precede the full outcome")
        };
        ids.push(item_id);
        opened_count += usize::from(opened);
    }
    assert_eq!(ids[0], ids[1]);
    assert_eq!(opened_count, 1);
    assert_eq!(h.items().len(), 1);
    assert!(service.list().is_empty());
}

#[tokio::test]
async fn permission_rules_and_auto_settle_before_explicit_deferral() {
    for (mode, effect) in [("manual", "allow"), ("manual", "deny"), ("auto", "ask")] {
        let h = Harness::new(mode, "manual");
        h.fixture.rules.lock().unwrap()[0].effect = permission::Effect(effect.into());
        let service = h.permissions(0).with_decision(Arc::new(Unassessed), true);
        let result = service
            .assert_deferred(request(&h.root, "per_rule", "one"), None)
            .await;
        if effect == "deny" {
            assert!(matches!(result, Err(permissions::Error::Blocked { .. })));
        } else {
            result.unwrap();
        }
        assert!(h.items().is_empty());
        assert!(service.list().is_empty());
    }
}

#[tokio::test]
async fn permission_executor_decisions_are_one_shot_and_do_not_prompt_wake_or_reconcile() {
    let h = Harness::new("manual", "manual");
    let service = h.permissions(16);
    let id = opened(
        permission_outcome(
            service
                .assert_deferred(request(&h.root, "per_first", "one"), None)
                .await
                .unwrap_err(),
        ),
        true,
    );
    let item = h.items().remove(0);
    h.decide(&item, "permission", "once").await;
    h.assert_no_delivery();
    assert_eq!(h.reviews.reconcile(21).await.unwrap(), 0);
    service
        .assert_deferred(request(&h.root, "per_approved", "two"), None)
        .await
        .unwrap();
    let next = opened(
        permission_outcome(
            service
                .assert_deferred(request(&h.root, "per_again", "three"), None)
                .await
                .unwrap_err(),
        ),
        true,
    );
    assert_ne!(id, next);
    let item = h.items().remove(0);
    h.decide(&item, "permission", "reject").await;
    let rejected = permission_outcome(
        service
            .assert_deferred(request(&h.root, "per_rejected", "four"), None)
            .await
            .unwrap_err(),
    );
    assert_eq!(rejected, review::DeferOutcome::Rejected { item_id: next });
    assert!(h.items().is_empty());
    h.assert_no_delivery();
}

#[tokio::test]
async fn permission_explicit_full_and_unavailable_remain_typed() {
    let h = Harness::new("manual", "manual");
    assert_eq!(
        permission_outcome(
            h.permissions(0)
                .assert_deferred(request(&h.root, "per_full", "one"), None)
                .await
                .unwrap_err()
        ),
        review::DeferOutcome::Full
    );
    assert!(matches!(
        h.fixture
            .permissions()
            .assert_deferred(request(&h.root, "per_unavailable", "one"), None)
            .await,
        Err(permissions::Error::ReviewUnavailable)
    ));
    assert!(h.items().is_empty());
}

#[tokio::test]
async fn ordinary_permission_assert_keeps_pending_wait_and_cancellation() {
    let h = Harness::new("manual", "manual");
    let service = h.permissions(16);
    let mut waiting = Box::pin(service.assert(request(&h.root, "per_ordinary", "one"), None));
    let mut context = Context::from_waker(Waker::noop());
    assert!(matches!(waiting.as_mut().poll(&mut context), Poll::Pending));
    assert_eq!(service.list().len(), 1);
    assert_eq!(h.emitted("permission.asked"), 1);
    drop(waiting);
    assert!(service.list().is_empty());
    assert_eq!(h.emitted("permission.cancelled"), 1);
    assert!(h.items().is_empty());
}

#[tokio::test]
async fn permission_yolo_admits_deferred_ordinary_and_explicit_requests_without_assessment() {
    for assessor in [false, true] {
        let h = Harness::new("yolo", "manual");
        let service = if assessor {
            h.permissions(16).with_decision(Arc::new(Unassessed), true)
        } else {
            h.permissions(16)
        };
        service
            .assert_deferred(request(&h.root, "per_yolo", "one"), None)
            .await
            .unwrap();
        let mut explicit = request(&h.root, "per_explicit", "two");
        explicit
            .metadata
            .as_mut()
            .unwrap()
            .insert("requireExplicitDecision".into(), JsonValue::Bool(true));
        service.assert_deferred(explicit, None).await.unwrap();
        assert!(h.items().is_empty());
        assert!(service.list().is_empty());
        assert_eq!(h.emitted("permission.asked"), 0);
    }
}

#[tokio::test]
async fn guardrail_explicit_manual_ordinary_hard_and_custom_reviews_never_wait_for_clients() {
    for (command, custom, hard) in [
        ("touch /outside/file", None, false),
        ("git reset --hard", None, true),
        ("touch file", Some(guardrail::RuleDecision::Ask), false),
        (
            "touch file",
            Some(guardrail::RuleDecision::HardReview),
            true,
        ),
    ] {
        let h = Harness::new("manual", "manual");
        let service = h.guardrails(1, custom).with_decision(Arc::new(Unassessed));
        let first = guardrail_outcome(
            guardrail_error(service.assert_deferred(input(&h.root, command, "one"))).await,
            hard,
        );
        let id = opened(first, true);
        let next = guardrail_outcome(
            guardrail_error(service.assert_deferred(input(&h.root, command, "two"))).await,
            hard,
        );
        assert_eq!(opened(next, false), id);
        assert_eq!(h.items().len(), 1);
        assert!(matches!(
            h.items()[0].deferral.origin,
            Origin::Request { executor: true, .. }
        ));
        assert_eq!(h.emitted("guardrail.asked"), 0);
        assert_eq!(h.emitted("guardrail.cancelled"), 0);
        assert_eq!(h.emitted("guardrail.deferred"), 1);
        assert!(service.for_session(&h.root).unwrap().is_empty());
    }
}

#[tokio::test]
async fn guardrail_auto_only_approves_ordinary_standard_reviews_and_never_denies() {
    for (custom, command, approved) in [
        (None, "touch /outside/file", true),
        (None, "git reset --hard", false),
        (Some(guardrail::RuleDecision::Ask), "touch file", false),
        (
            Some(guardrail::RuleDecision::HardReview),
            "touch file",
            false,
        ),
    ] {
        let h = Harness::new("manual", "auto");
        let service = h.guardrails(16, custom).with_decision(Arc::new(Unassessed));
        if approved {
            service
                .assert_deferred(input(&h.root, command, "one"))
                .unwrap()
                .reservation
                .unwrap()
                .release();
        } else {
            assert!(matches!(
                guardrail_error(service.assert_deferred(input(&h.root, command, "one"))).await,
                guardrails::Error::DeferredReview(_)
            ));
        }
    }
    let h = Harness::new("auto", "auto");
    let service = h.guardrails(16, Some(guardrail::RuleDecision::Deny));
    assert!(matches!(
        service.assert_deferred(input(&h.root, "touch file", "one")),
        Err(guardrails::Error::Blocked(_))
    ));
    assert!(h.items().is_empty());
}

#[tokio::test]
async fn guardrail_yolo_admits_deferred_ordinary_hard_and_custom_reviews_without_assessment() {
    for (custom, command) in [
        (None, "touch /outside/file"),
        (None, "git reset --hard"),
        (Some(guardrail::RuleDecision::Ask), "touch file"),
        (Some(guardrail::RuleDecision::HardReview), "touch file"),
    ] {
        let h = Harness::new("manual", "yolo");
        let service = h.guardrails(16, custom).with_decision(Arc::new(Unassessed));
        let admission = service
            .assert_deferred(input(&h.root, command, "one"))
            .unwrap();
        assert_eq!(admission.effect, Effect::Allow, "{command}");
        assert!(admission.request.is_none() && admission.wait.is_none());
        admission.reservation.unwrap().release();
        assert!(h.items().is_empty());
        assert_eq!(h.emitted("guardrail.asked"), 0);
        assert_eq!(h.emitted("guardrail.deferred"), 0);
    }
}

#[tokio::test]
async fn guardrail_executor_grant_and_rejection_do_not_enqueue_or_replay_actions() {
    let h = Harness::new("manual", "manual");
    let service = h.guardrails(16, None);
    let command = "touch /outside/file";
    let first = opened(
        guardrail_outcome(
            guardrail_error(service.assert_deferred(input(&h.root, command, "one"))).await,
            false,
        ),
        true,
    );
    let item = h.items().remove(0);
    h.decide(&item, "guardrail", "once").await;
    h.assert_no_delivery();
    assert_eq!(h.reviews.reconcile(21).await.unwrap(), 0);
    service
        .assert_deferred(input(&h.root, command, "two"))
        .unwrap()
        .reservation
        .unwrap()
        .release();
    let next = opened(
        guardrail_outcome(
            guardrail_error(service.assert_deferred(input(&h.root, command, "three"))).await,
            false,
        ),
        true,
    );
    assert_ne!(first, next);
    let item = h.items().remove(0);
    h.decide(&item, "guardrail", "reject").await;
    assert_eq!(
        guardrail_outcome(
            guardrail_error(service.assert_deferred(input(&h.root, command, "four"))).await,
            false
        ),
        review::DeferOutcome::Rejected { item_id: next }
    );
    assert!(h.items().is_empty());
    h.assert_no_delivery();
}

#[tokio::test]
async fn guardrail_full_and_missing_review_service_do_not_approve() {
    let h = Harness::new("manual", "manual");
    assert_eq!(
        guardrail_outcome(
            guardrail_error(h.guardrails(0, None).assert_deferred(input(
                &h.root,
                "touch /outside/file",
                "one"
            )))
            .await,
            false
        ),
        review::DeferOutcome::Full
    );
    let unbound = Guardrails::new(
        h.fixture.authority(),
        h.fixture.permissions(),
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
            decide_reviews: false,
            decide_hard_reviews: true,
        },
        h.fixture.publisher(),
    );
    assert!(matches!(
        unbound.assert_deferred(input(&h.root, "touch /outside/file", "one")),
        Err(guardrails::Error::ReviewUnavailable)
    ));
    assert!(h.items().is_empty());
}

#[tokio::test]
async fn ordinary_guardrail_assert_keeps_pending_wait_and_cancellation() {
    let h = Harness::new("manual", "manual");
    let service = h.guardrails(16, None);
    let admission = service
        .assert(input(&h.root, "touch /outside/file", "one"))
        .unwrap();
    assert_eq!(admission.effect, Effect::Ask);
    assert_eq!(service.for_session(&h.root).unwrap().len(), 1);
    assert_eq!(h.emitted("guardrail.asked"), 1);
    drop(admission.wait.unwrap());
    assert!(service.for_session(&h.root).unwrap().is_empty());
    assert_eq!(h.emitted("guardrail.cancelled"), 0);
    assert!(h.items().is_empty());
}

#[tokio::test]
async fn permission_explicit_denies_precede_unconsumed_review_grants() {
    let h = Harness::new("manual", "manual");
    let service = h.permissions(16);
    opened(
        permission_outcome(
            service
                .assert_deferred(request(&h.root, "per_first", "one"), None)
                .await
                .unwrap_err(),
        ),
        true,
    );
    let item = h.items().remove(0);
    h.decide(&item, "permission", "once").await;
    h.fixture.rules.lock().unwrap()[0].effect = permission::Effect("deny".into());
    assert!(matches!(
        service
            .assert_deferred(request(&h.root, "per_denied", "two"), None)
            .await,
        Err(permissions::Error::Blocked { .. })
    ));
    let owner = tuple_key(&[KeyPart::String(h.root.as_lossless())]);
    assert!(
        h.fixture
            .store
            .snapshot()
            .unwrap()
            .get::<SessionTable>(&owner)
            .unwrap()
            .is_some()
    );
    assert_eq!(h.emitted("permission.asked"), 0);
}

#[tokio::test]
async fn explicit_permission_rejection_holds_auto_approval_after_yolo_admits_without_consuming_it()
{
    let h = Harness::new("manual", "manual");
    let service = h.permissions(16).with_decision(Arc::new(Unassessed), true);
    opened(
        permission_outcome(
            service
                .assert_deferred(request(&h.root, "per_first", "one"), None)
                .await
                .unwrap_err(),
        ),
        true,
    );
    let item = h.items().remove(0);
    h.decide(&item, "permission", "reject").await;
    set_modes(&h, "yolo", "manual");
    service
        .assert_deferred(request(&h.root, "per_yolo", "two"), None)
        .await
        .unwrap();
    set_modes(&h, "auto", "manual");
    assert_eq!(
        permission_outcome(
            service
                .assert_deferred(request(&h.root, "per_again", "two"), None)
                .await
                .unwrap_err()
        ),
        review::DeferOutcome::Rejected {
            item_id: item.deferral.item_id
        }
    );
    assert!(h.items().is_empty());
}

#[tokio::test]
async fn guardrail_explicit_rejection_holds_auto_approval_after_yolo_admits_without_consuming_it() {
    let h = Harness::new("manual", "manual");
    let service = h.guardrails(16, None).with_decision(Arc::new(Unassessed));
    opened(
        guardrail_outcome(
            guardrail_error(service.assert_deferred(input(&h.root, "touch /outside/file", "one")))
                .await,
            false,
        ),
        true,
    );
    let item = h.items().remove(0);
    h.decide(&item, "guardrail", "reject").await;
    set_modes(&h, "manual", "yolo");
    service
        .assert_deferred(input(&h.root, "touch /outside/file", "two"))
        .unwrap()
        .reservation
        .unwrap()
        .release();
    set_modes(&h, "manual", "auto");
    assert_eq!(
        guardrail_outcome(
            guardrail_error(service.assert_deferred(input(&h.root, "touch /outside/file", "two")))
                .await,
            false
        ),
        review::DeferOutcome::Rejected {
            item_id: item.deferral.item_id
        }
    );
    assert!(h.items().is_empty());
}

#[tokio::test]
async fn auto_permissions_admit_a_request_marked_require_explicit_decision() {
    let h = Harness::new("auto", "manual");
    let service = h.permissions(16).with_decision(Arc::new(Unassessed), true);
    let mut explicit = request(&h.root, "per_explicit", "one");
    explicit
        .metadata
        .as_mut()
        .unwrap()
        .insert("requireExplicitDecision".into(), JsonValue::Bool(true));
    service.assert_deferred(explicit, None).await.unwrap();
    assert!(h.items().is_empty());
    assert!(service.list().is_empty());
    assert_eq!(h.emitted("permission.asked"), 0);
}

#[tokio::test]
async fn withdrawn_executor_items_do_not_suppress_a_new_deferral() {
    let h = Harness::new("manual", "manual");
    let service = h.permissions(16);
    let first = opened(
        permission_outcome(
            service
                .assert_deferred(request(&h.root, "per_first", "one"), None)
                .await
                .unwrap_err(),
        ),
        true,
    );
    assert_eq!(
        h.reviews
            .withdraw(&h.root, review::WithdrawReason::TaskClosed, 21)
            .await
            .unwrap(),
        1
    );
    let second = opened(
        permission_outcome(
            service
                .assert_deferred(request(&h.root, "per_second", "two"), None)
                .await
                .unwrap_err(),
        ),
        true,
    );
    assert_ne!(first, second);
    assert_eq!(h.items().len(), 1);
}

#[tokio::test]
async fn closed_review_store_returns_store_error_instead_of_deferral_or_approval() {
    let h = Harness::new("manual", "manual");
    let session = h.root.clone();
    let reviews = h.reviews.clone();
    let service = h.permissions(16);
    h.fixture.store.shutdown().unwrap();
    let input = review::OpenInput {
        session_id: session.clone(),
        kind: session_review::Kind::Permission,
        reason: Reason::Disabled,
        choice: None,
        confidence: None,
        grades: None,
        origin: Origin::Request {
            request_id: "per_closed".into(),
            executor: true,
        },
        payload: Payload::Permission(session_review::PermissionPayload {
            action: "edit".into(),
            resources: vec!["file".into()],
            save: None,
            fingerprint: session_review::Fingerprint::decode(&JsonValue::String(
                "0".repeat(64).into(),
            ))
            .unwrap(),
            fingerprint_version: session_review::FingerprintVersion::V2,
            request_id: permission::Id::new("per_closed").unwrap(),
            coordination_escalation: None,
        }),
        limit: 16,
        conversion: false,
        created: 1,
    };
    assert!(matches!(
        reviews.defer_open_now(input),
        Err(review::Error::Store(ycoding_store::Error::Closed))
    ));
    assert!(matches!(
        service
            .assert_deferred(request(&session, "per_closed", "one"), None)
            .await,
        Err(permissions::Error::Authority(_))
    ));
}
