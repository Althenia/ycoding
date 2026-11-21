#[path = "guardrail_service_decisions_support/autonomy.rs"]
mod autonomy_support;
#[path = "guardrail_service_decisions_support/fake.rs"]
mod evaluator_support;
#[path = "guardrail_service_decisions_support/refusal.rs"]
mod refusal_support;
mod support {
    include!("guardrail_service_decisions_support/mod.rs");
    include!("guardrail_service_decisions_support/events.rs");
}

use evaluator_support::Fake;
use refusal_support::refusal;
use std::{ops::Bound, sync::Arc, time::Duration};
use support::{Harness, response};
use ycoding_core::{
    process::guardrails::{self, CustomLayer, Guardrails, Input, Limits, Paths, Settings},
    resources::decision,
    tools::policy::{Effect, Wait, permissions},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, guardrail, parse_json, permission,
    session_id::SessionId,
    session_review::{Payload, Reason},
    stringify_json,
};
use ycoding_store::{IndexOrder, IndexQuery, KeyPart, session::EventTable, tuple_key};

const COMMAND: &str = "TOKEN=synthetic-secret touch /outside/private-target";

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

fn service(harness: &Harness, fake: &Arc<Fake>, settings: Settings) -> Guardrails {
    Guardrails::new(
        harness.fixture.authority(),
        harness.fixture.permissions(),
        settings,
        harness.publish.clone(),
    )
    .with_reviews(harness.review_policy())
    .with_decision(fake.clone())
}

fn input(session: &SessionId, command: &str) -> Input {
    Input {
        session_id: session.clone(),
        action: "shell".into(),
        resources: vec![command.into()],
        metadata: None,
        skip_review: false,
        holder: None,
        source: Some(guardrail::Source {
            message_id: ycoding_schema::session_message::Id::new("msg_synthetic_source").unwrap(),
            call_id: "call_synthetic_source".into(),
        }),
    }
}

fn verdict(choice: &str, confidence: f64) -> Result<JsonValue, decision::Error> {
    response(&format!(
        r#"{{"name":"guardrail_match","type":"choice","answer":null,"choice":"{choice}","score":null,"confidence":{confidence}}}"#
    ))
}

fn grades(allow: f64, deny: f64, escalate: f64) -> Result<JsonValue, decision::Error> {
    let entries = [("allow", allow), ("deny", deny), ("escalate", escalate)]
        .into_iter()
        .map(|(choice, confidence)| format!(r#"{{"choice":"{choice}","confidence":{confidence},"evidence":"Reviewed {COMMAND}; TOKEN=synthetic-secret bounded synthetic evidence"}}"#))
        .collect::<Vec<_>>()
        .join(",");
    response(&format!(
        r#"{{"name":"guardrail","type":"choice","answer":null,"choice":null,"score":null,"confidence":0,"grades":[{entries}]}}"#
    ))
}

fn custom(config: &mut Settings, decision: guardrail::RuleDecision, action: &str, resource: &str) {
    let rule = guardrail::Rule::decode(&parse_json(&format!(
        r#"{{"id":"custom.boundary","source":"custom","decision":{},"actions":["{action}"],"resources":["{resource}"],"reason":"Synthetic policy","priority":0}}"#,
        stringify_json(&decision.encode())
    )).unwrap()).unwrap();
    config.custom = Arc::new(move || {
        vec![CustomLayer {
            rules: vec![rule.clone()],
            invalid_files: vec![],
        }]
    });
}

async fn settled(
    wait: Wait<Result<guardrails::Reservation, guardrails::Error>>,
) -> Result<guardrails::Reservation, guardrails::Error> {
    tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .expect("guardrail settlement timed out")
        .expect("guardrail sender dropped")
}

fn durable(harness: &Harness, session: &SessionId, kind: &str) -> Vec<JsonValue> {
    let prefix = tuple_key(&[
        KeyPart::String(session.as_lossless()),
        KeyPart::String(&kind.into()),
    ]);
    harness
        .fixture
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

fn field<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    let JsonValue::Object(object) = value else {
        panic!("expected object")
    };
    object
        .get(&key.into())
        .unwrap_or_else(|| panic!("missing {key}"))
}

fn private_provenance(events: &[JsonValue]) {
    for event in events {
        let text = stringify_json(event);
        for excluded in ["synthetic-secret", COMMAND, "/outside/private-target"] {
            assert!(
                !text.contains(excluded),
                "durable provenance leaked {excluded}"
            );
        }
    }
}

#[tokio::test]
async fn disabled_reviews_wait_for_humans_and_awake_auto_guardrail_never_calls_the_helper() {
    for (enabled, yolo) in [(false, 0), (false, 2), (true, 2)] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, yolo, true, None);
        let fake = Fake::new(vec![]);
        let service = service(
            &harness,
            &fake,
            Settings {
                decide_reviews: enabled,
                ..settings()
            },
        );
        let admission = service.assert(input(&root, COMMAND)).unwrap();
        if yolo == 2 {
            assert_eq!(admission.effect, Effect::Allow);
            admission.reservation.unwrap().release();
        } else {
            assert_eq!(admission.effect, Effect::Ask);
            let request = admission.request.unwrap();
            assert!(request.escalation.is_none());
            service
                .reply(&root, &request.id, guardrail::Reply::Once)
                .unwrap();
            settled(admission.wait.unwrap()).await.unwrap().release();
        }
        assert!(fake.seen.lock().unwrap().is_empty());
        assert!(harness.reviews.list(&root).unwrap().is_empty());
        assert!(durable(&harness, &root, "session.guardrail.escalated.1").is_empty());
    }
}

#[tokio::test]
async fn manual_and_auto_guardrails_never_call_the_helper_and_leave_unresolved_reviews_to_humans() {
    for mode in ["manual", "auto"] {
        let harness = Harness::new();
        let root =
            harness
                .fixture
                .session_with("ses_root", None, ["manual", mode, "manual"], false, None);
        let fake = Fake::new(vec![]);
        let service = service(&harness, &fake, settings());

        let ordinary = service.assert(input(&root, COMMAND)).unwrap();
        if mode == "auto" {
            assert_eq!(ordinary.effect, Effect::Allow, "{mode}");
            ordinary.reservation.unwrap().release();
        } else {
            assert_eq!(ordinary.effect, Effect::Ask, "{mode}");
            let request = ordinary.request.unwrap();
            assert!(request.escalation.is_none(), "{mode}");
            service
                .reply(&root, &request.id, guardrail::Reply::Once)
                .unwrap();
            settled(ordinary.wait.unwrap()).await.unwrap().release();
        }

        let hard = service.assert(input(&root, "git reset --hard")).unwrap();
        assert_eq!(hard.effect, Effect::Ask, "{mode}");
        let request = hard.request.unwrap();
        assert_eq!(request.hard_review, Some(true), "{mode}");
        assert!(request.escalation.is_none(), "{mode}");
        service
            .reply(&root, &request.id, guardrail::Reply::Reject)
            .unwrap();
        assert!(matches!(
            settled(hard.wait.unwrap()).await,
            Err(guardrails::Error::Declined)
        ));
        assert!(fake.seen.lock().unwrap().is_empty(), "{mode}");
        assert!(harness.reviews.list(&root).unwrap().is_empty(), "{mode}");
    }
}

#[tokio::test]
async fn sleeping_auto_guardrail_with_disabled_reviews_defers_without_a_helper_or_escalation() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 2, true, None);
    harness.autonomy().set_defer(&root, true).await.unwrap();
    let fake = Fake::new(vec![]);
    let service = service(
        &harness,
        &fake,
        Settings {
            decide_reviews: false,
            ..settings()
        },
    );
    let admission = service.assert(input(&root, COMMAND)).unwrap();
    assert!(matches!(
        settled(admission.wait.unwrap()).await,
        Err(guardrails::Error::Deferred { .. })
    ));
    let items = harness.reviews.list(&root).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].deferral.reason, Reason::Disabled);
    assert!(items[0].deferral.grades.is_none());
    assert!(service.for_session(&root).unwrap().is_empty());
    assert!(fake.seen.lock().unwrap().is_empty());
    assert!(durable(&harness, &root, "session.guardrail.escalated.1").is_empty());
}

#[tokio::test]
async fn catastrophic_and_custom_denies_never_reach_the_helper_even_with_skip_review() {
    for asleep in [false, true] {
        for custom_deny in [false, true] {
            let harness = Harness::new();
            let root = harness.fixture.session("ses_root", None, 2, true, None);
            if asleep {
                harness.autonomy().set_defer(&root, true).await.unwrap();
            }
            let fake = Fake::new(vec![]);
            let mut config = settings();
            if custom_deny {
                custom(&mut config, guardrail::RuleDecision::Deny, "shell", "*");
            }
            let service = service(&harness, &fake, config);
            let mut request = input(&root, if custom_deny { COMMAND } else { "rm -rf /" });
            request.skip_review = true;
            assert!(matches!(
                service.assert(request),
                Err(guardrails::Error::Blocked(_))
            ));
            assert!(fake.seen.lock().unwrap().is_empty());
            assert!(harness.reviews.list(&root).unwrap().is_empty());
        }
    }
}

#[tokio::test]
async fn yolo_admits_standard_and_custom_blockers_without_evaluator_dispatch() {
    let harness = Harness::new();
    let root =
        harness
            .fixture
            .session_with("ses_root", None, ["manual", "yolo", "manual"], false, None);
    let child = harness
        .fixture
        .session("ses_child", Some("ses_root"), 0, false, None);
    let fake = Fake::new(vec![refusal("guardrail")]);
    for decision in [
        guardrail::RuleDecision::Ask,
        guardrail::RuleDecision::Deny,
        guardrail::RuleDecision::HardReview,
    ] {
        let mut config = settings();
        config.enabled = false;
        config.decide_reviews = false;
        config.decide_hard_reviews = false;
        custom(&mut config, decision, "shell", "*");
        let service = service(&harness, &fake, config);
        for command in [
            COMMAND,
            "rm -rf /",
            "git reset --hard",
            "psql -c 'DROP TABLE users'",
        ] {
            let admission = service.assert(input(&child, command)).unwrap();
            assert_eq!(admission.effect, Effect::Allow, "{command}");
            assert!(admission.request.is_none());
            assert!(admission.wait.is_none());
            admission.reservation.unwrap().release();
            let event =
                guardrail::DecidedData::decode(&harness.event("guardrail.decided").await).unwrap();
            assert_eq!(event.root_session_id, root);
            assert_eq!(event.session_id, child);
            assert_eq!(event.decision, guardrail::Decision::Allow);
            assert!(event.rule_ids.is_empty());
        }
        assert!(service.for_session(&root).unwrap().is_empty());
    }
    assert!(fake.seen.lock().unwrap().is_empty());
    assert!(harness.reviews.list(&root).unwrap().is_empty());
    for kind in [
        "session.guardrail.dismissed.1",
        "session.guardrail.decided.1",
        "session.guardrail.escalated.1",
        "session.guardrail.approved.1",
    ] {
        assert!(durable(&harness, &root, kind).is_empty(), "{kind}");
    }
}

#[tokio::test]
async fn the_hard_review_switch_blocks_hard_model_assessment_but_not_human_review() {
    for asleep in [false, true] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, 2, true, None);
        if asleep {
            harness.autonomy().set_defer(&root, true).await.unwrap();
        }
        let fake = Fake::new(vec![]);
        let service = service(
            &harness,
            &fake,
            Settings {
                decide_hard_reviews: false,
                ..settings()
            },
        );
        let admission = service.assert(input(&root, "git reset --hard")).unwrap();
        if asleep {
            assert!(matches!(
                settled(admission.wait.unwrap()).await,
                Err(guardrails::Error::Deferred { .. })
            ));
            let items = harness.reviews.list(&root).unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].deferral.reason, Reason::Disabled);
            let Payload::Guardrail(payload) = &items[0].deferral.payload else {
                panic!("guardrail payload")
            };
            assert!(payload.hard_review);
        } else {
            let asked =
                guardrail::Request::decode(&harness.event("guardrail.asked").await).unwrap();
            assert_eq!(asked.hard_review, Some(true));
            assert!(asked.escalation.is_none());
            service
                .reply(&root, &asked.id, guardrail::Reply::Always)
                .unwrap();
            assert!(matches!(
                settled(admission.wait.unwrap()).await,
                Err(guardrails::Error::Declined)
            ));
        }
        assert!(fake.seen.lock().unwrap().is_empty());
        assert!(durable(&harness, &root, "session.guardrail.decided.1").is_empty());
        assert!(durable(&harness, &root, "session.guardrail.approved.1").is_empty());
    }
}

#[tokio::test]
async fn yolo_reconciles_a_pending_child_once_without_crossing_session_ownership() {
    let harness = Harness::new();
    let root = harness.fixture.session_with(
        "ses_root",
        None,
        ["manual", "manual", "manual"],
        false,
        None,
    );
    let child = harness
        .fixture
        .session("ses_child", Some("ses_root"), 0, false, None);
    let unrelated = harness
        .fixture
        .session("ses_unrelated", None, 0, false, None);
    let fake = Fake::new(vec![grades(0.8, 0.1, 0.1)]);
    let service = service(&harness, &fake, settings());
    let admission = service.assert(input(&child, "git reset --hard")).unwrap();
    let asked = admission.request.unwrap();
    assert!(matches!(
        service.reply(&unrelated, &asked.id, guardrail::Reply::Once),
        Err(guardrails::Error::NotFound)
    ));
    assert_eq!(service.reconcile_autonomy(&unrelated).unwrap(), 0);
    assert_eq!(service.for_session(&root).unwrap().len(), 1);
    harness
        .autonomy()
        .set_decisions(
            &root,
            ycoding_core::session::autonomy::DecisionChange::new(
                None,
                Some(ycoding_core::session::autonomy::DecisionMode::Yolo),
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(service.reconcile_autonomy(&child).unwrap(), 1);
    assert_eq!(service.reconcile_autonomy(&child).unwrap(), 0);
    settled(admission.wait.unwrap()).await.unwrap().release();
    let replied =
        guardrail::RepliedData::decode(&harness.event("guardrail.replied").await).unwrap();
    assert_eq!(replied.session_id, child);
    assert_eq!(replied.request_id, asked.id);
    assert_eq!(replied.reply, guardrail::Reply::Once);
    assert!(replied.decided_by.is_none());
    assert!(replied.choice.is_none());
    assert!(replied.grades.is_none());
    assert!(matches!(
        service.reply(&root, &asked.id, guardrail::Reply::Reject),
        Err(guardrails::Error::NotFound)
    ));
    assert!(fake.seen.lock().unwrap().is_empty());
    assert!(service.for_session(&root).unwrap().is_empty());
    let decided = durable(&harness, &root, "session.guardrail.decided.1");
    assert_eq!(decided.len(), 1);
    assert_eq!(field(&decided[0], "reviewSessionID"), &child.encode());
    assert_eq!(field(&decided[0], "requestID"), &asked.id.encode());
    assert_eq!(
        field(&decided[0], "reply"),
        &JsonValue::String("once".into())
    );
    assert_eq!(
        field(&decided[0], "authority"),
        &JsonValue::String("yolo".into())
    );
    for key in [
        "actor",
        "coordinatorSessionID",
        "choice",
        "confidence",
        "grades",
    ] {
        assert!(
            matches!(&decided[0], JsonValue::Object(object) if object.get(&key.into()).is_none()),
            "{key}"
        );
    }
    assert!(durable(&harness, &root, "session.guardrail.approved.1").is_empty());
}

#[tokio::test]
async fn yolo_ignores_unavailable_refused_and_conflicting_evaluator_results() {
    for asleep in [false, true] {
        for reply in [
            grades(0.9, 0.85, 0.1),
            grades(0.7, 0.1, 0.1),
            refusal("guardrail"),
            Err(decision::Error::ProviderFailed),
        ] {
            let harness = Harness::new();
            let root = harness.fixture.session_with(
                "ses_root",
                None,
                ["manual", "yolo", "manual"],
                false,
                None,
            );
            if asleep {
                harness.autonomy().set_defer(&root, true).await.unwrap();
            }
            let fake = Fake::new(vec![reply]);
            let service = service(&harness, &fake, settings());
            let admission = service.assert(input(&root, COMMAND)).unwrap();
            assert_eq!(admission.effect, Effect::Allow);
            assert!(admission.request.is_none());
            assert!(admission.wait.is_none());
            admission.reservation.unwrap().release();
            assert!(fake.seen.lock().unwrap().is_empty());
            assert_eq!(fake.replies.lock().unwrap().len(), 1);
            assert!(harness.reviews.list(&root).unwrap().is_empty());
            assert!(durable(&harness, &root, "session.guardrail.escalated.1").is_empty());
            assert!(durable(&harness, &root, "session.guardrail.decided.1").is_empty());
        }
    }
}

#[tokio::test]
async fn yolo_bypasses_invalid_custom_configuration_without_creating_approval_history() {
    let harness = Harness::new();
    let root =
        harness
            .fixture
            .session_with("ses_root", None, ["auto", "yolo", "manual"], true, None);
    let fake = Fake::new(vec![]);
    let mut config = settings();
    config.custom = Arc::new(|| {
        vec![CustomLayer {
            rules: vec![],
            invalid_files: vec!["/synthetic/invalid-rule.md".into()],
        }]
    });
    let service = service(&harness, &fake, config);
    let admission = service.assert(input(&root, COMMAND)).unwrap();
    assert_eq!(admission.effect, Effect::Allow);
    assert!(admission.request.is_none());
    admission.reservation.unwrap().release();
    assert!(fake.seen.lock().unwrap().is_empty());
    assert!(durable(&harness, &root, "session.guardrail.decided.1").is_empty());
    assert!(durable(&harness, &root, "session.guardrail.approved.1").is_empty());
}

#[tokio::test]
async fn guardrails_yolo_does_not_change_manual_permission_asks_or_denies() {
    let harness = Harness::new();
    let root =
        harness
            .fixture
            .session_with("ses_root", None, ["manual", "yolo", "manual"], false, None);
    let fake = Fake::new(vec![]);
    let service = service(&harness, &fake, settings());
    let admission = service.assert(input(&root, COMMAND)).unwrap();
    assert_eq!(admission.effect, Effect::Allow);
    let reservation = admission.reservation.unwrap();
    let permissions = harness.fixture.permissions();
    let request = |id: &str| permission::Request {
        id: permission::Id::new(id).unwrap(),
        session_id: root.clone(),
        action: "shell".into(),
        resources: vec![COMMAND.into()],
        save: None,
        metadata: None,
        source: None,
        escalation: None,
        coordination_escalation: None,
    };
    let pending = permissions.ask(request("per_ask"), None).unwrap();
    assert_eq!(pending.effect, Effect::Ask);
    drop(pending);
    harness
        .fixture
        .rules
        .lock()
        .unwrap()
        .push(permission::Rule {
            action: "shell".into(),
            resource: "*".into(),
            effect: permission::Effect("deny".into()),
        });
    assert!(matches!(
        permissions.assert(request("per_deny"), None).await,
        Err(permissions::Error::Blocked { .. })
    ));
    assert!(fake.seen.lock().unwrap().is_empty());
    reservation.release();
}

#[tokio::test]
async fn yolo_waits_for_shell_capacity_and_cannot_exceed_subagent_capacity() {
    let harness = Harness::new();
    let root =
        harness
            .fixture
            .session_with("ses_root", None, ["manual", "yolo", "manual"], false, None);
    let fake = Fake::new(vec![]);
    let mut config = settings();
    config.limits.shells = 1;
    config.limits.subagents = 1;
    custom(
        &mut config,
        guardrail::RuleDecision::Ask,
        "subagent",
        "reviewed",
    );
    let service = service(&harness, &fake, config);
    let running = service
        .assert(input(&root, "echo ready"))
        .unwrap()
        .reservation
        .unwrap();
    let admission = service.assert(input(&root, COMMAND)).unwrap();
    assert_eq!(admission.effect, Effect::Allow);
    assert!(admission.request.is_none());
    let mut wait = admission.wait.unwrap();
    assert!(
        std::future::poll_fn(|context| std::task::Poll::Ready(
            std::future::Future::poll(std::pin::Pin::new(&mut wait), context).is_pending()
        ))
        .await
    );
    running.release();
    settled(wait).await.unwrap().release();
    let subagent = |resource: &str| Input {
        action: "subagent".into(),
        ..input(&root, resource)
    };
    let running = service
        .assert(subagent("running"))
        .unwrap()
        .reservation
        .unwrap();
    assert!(matches!(
        service.assert(subagent("reviewed")),
        Err(guardrails::Error::CapExceeded {
            counter: "subagents",
            current: 1,
            limit: 1,
            ..
        })
    ));
    running.release();
    assert!(fake.seen.lock().unwrap().is_empty());
}

fn sql906_nonmatch_with_review_refusal() -> Result<JsonValue, decision::Error> {
    response(
        r#"{"name":"guardrail_match","type":"choice","answer":null,"choice":"allow","score":null,"confidence":1},{"name":"guardrail","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}"#,
    )
}

async fn sql906_protected_review(resources: &[&str], reason: &str, hard: bool) {
    let harness = Harness::new();
    let root = harness.fixture.session_with(
        "ses_root",
        None,
        ["manual", "manual", "manual"],
        false,
        None,
    );
    let fake = Fake::new(vec![
        sql906_nonmatch_with_review_refusal(),
        sql906_nonmatch_with_review_refusal(),
    ]);
    let service = service(&harness, &fake, settings());
    let mut request = input(&root, resources[0]);
    request.resources = resources
        .iter()
        .map(|resource| LosslessString::from(*resource))
        .collect();
    let admission = service.assert(request).unwrap();
    assert_eq!(admission.effect, Effect::Ask, "{resources:?}");
    let mut completion = Box::pin(settled(admission.wait.expect("review wait")));
    let asked = tokio::select! {
        event = harness.event("guardrail.asked") => guardrail::Request::decode(&event).unwrap(),
        _ = &mut completion => panic!("helper nonmatch settled protected review: {resources:?}"),
    };
    assert_eq!(asked.reason, LosslessString::from(reason), "{resources:?}");
    assert_eq!(asked.hard_review, hard.then_some(true), "{resources:?}");
    assert_eq!(
        asked.rule_ids,
        vec![LosslessString::from(if hard {
            "standard.review.database-destructive"
        } else {
            "standard.review.outside-repo"
        })],
        "{resources:?}"
    );
    assert!(
        fake.seen.lock().unwrap().is_empty(),
        "manual review must not dispatch a helper: {resources:?}"
    );
    assert!(durable(&harness, &root, "session.guardrail.dismissed.1").is_empty());
    assert!(durable(&harness, &root, "session.guardrail.decided.1").is_empty());
    service
        .reply(&root, &asked.id, guardrail::Reply::Reject)
        .unwrap();
    assert!(matches!(completion.await, Err(guardrails::Error::Declined)));
}

#[tokio::test]
async fn sql906_service_confirmed_execution_cannot_be_dismissed_after_inert_data() {
    for resources in [
        vec![
            r#"echo "DROP TABLE note" > notes.sql"#,
            r#"psql -c "DROP TABLE users""#,
        ],
        vec!["echo \"DROP TABLE note\" > notes.sql; psql -c \"DROP TABLE users\""],
    ] {
        sql906_protected_review(&resources, "Destructive database operation", true).await;
    }
}

#[tokio::test]
async fn sql906_service_uncertain_execution_cannot_be_dismissed_as_a_nonmatch() {
    for command in [
        r#"bun -e "const text = 'DROP TABLE users'; console.log(text)""#,
        r#"python -c "db.run('DROP TABLE users')""#,
        "python <<'CODE'\ndb.run('DROP TABLE users')\nCODE",
        r#"printf '%s' "$SQL" | psql"#,
        r#"printf '%s' "$SQL" | env psql"#,
        r#"psql -c '\copy items TO PROGRAM "some-program"'"#,
    ] {
        sql906_protected_review(
            &[command],
            "Possible destructive database operation; execution is unproven",
            true,
        )
        .await;
    }
}

#[tokio::test]
async fn sql906_service_unknown_import_skips_verifier_dismissal_across_resources() {
    for resources in [
        vec![r#"sqlite3 db.sqlite ".import --unknown value /outside/input.csv items""#],
        vec![
            "touch /outside/real",
            r#"sqlite3 db.sqlite ".import --unknown value file items""#,
        ],
        vec!["sqlite3 db.sqlite \".import --unknown value file items\"; touch /outside/real"],
    ] {
        sql906_protected_review(&resources, "SQLite import file target is unproven", false).await;
    }
}

#[tokio::test]
async fn sql906_service_unknown_import_survives_exempt_known_targets() {
    for resources in [
        vec![r#"sqlite3 db.sqlite ".import --unknown value /outside/input.csv items""#],
        vec![
            "touch /outside/real",
            r#"sqlite3 db.sqlite ".import --unknown value file items""#,
        ],
    ] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, 0, false, None);
        let fake = Fake::new(vec![]);
        let mut config = settings();
        config.global_roots = vec!["/outside".into()];
        let service = service(&harness, &fake, config);
        let mut request = input(&root, resources[0]);
        request.resources = resources
            .iter()
            .map(|resource| LosslessString::from(*resource))
            .collect();
        let result = service.evaluate(&request).unwrap();
        assert_eq!(result.effect, Effect::Ask, "{resources:?}");
        assert!(!result.hard_review, "{resources:?}");
        assert_eq!(
            result.reason,
            Some("SQLite import file target is unproven".into()),
            "{resources:?}"
        );
        assert!(fake.seen.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn sql906_service_manual_literal_carrier_requires_review_without_verification() {
    let harness = Harness::new();
    let root = harness.fixture.session_with(
        "ses_root",
        None,
        ["manual", "manual", "manual"],
        false,
        None,
    );
    let fake = Fake::new(vec![verdict("allow", 1.0)]);
    let service = service(&harness, &fake, settings());
    let admission = service
        .assert(input(&root, r#"echo "DROP TABLE note" > notes.sql"#))
        .unwrap();
    assert_eq!(admission.effect, Effect::Ask);
    let asked = admission.request.unwrap();
    assert_eq!(asked.hard_review, Some(true));
    assert_eq!(
        asked.rule_ids,
        vec![LosslessString::from("standard.review.database-destructive")]
    );
    service
        .reply(&root, &asked.id, guardrail::Reply::Once)
        .unwrap();
    settled(admission.wait.unwrap()).await.unwrap().release();
    assert!(fake.seen.lock().unwrap().is_empty());
    assert!(durable(&harness, &root, "session.guardrail.dismissed.1").is_empty());
    assert!(service.for_session(&root).unwrap().is_empty());
}

#[tokio::test]
async fn yolo_withdraws_deferred_guardrails_durably_without_replay_or_a_grant() {
    let harness = Harness::new();
    let root = harness.fixture.session_with(
        "ses_root",
        None,
        ["manual", "manual", "manual"],
        false,
        None,
    );
    harness.autonomy().set_defer(&root, true).await.unwrap();
    let fake = Fake::new(vec![]);
    let service = service(&harness, &fake, settings());
    let admission = service.assert(input(&root, "git reset --hard")).unwrap();
    assert!(matches!(
        settled(admission.wait.unwrap()).await,
        Err(guardrails::Error::Deferred { .. })
    ));
    let items = harness.reviews.list(&root).unwrap();
    assert_eq!(items.len(), 1);
    harness
        .autonomy()
        .set_decisions(
            &root,
            ycoding_core::session::autonomy::DecisionChange::new(
                None,
                Some(ycoding_core::session::autonomy::DecisionMode::Yolo),
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        harness.reviews.reconcile_autonomy(&root, 20).await.unwrap(),
        1
    );
    assert_eq!(
        harness.reviews.reconcile_autonomy(&root, 21).await.unwrap(),
        0
    );
    assert!(harness.reviews.list(&root).unwrap().is_empty());
    let withdrawn = durable(&harness, &root, "session.review.withdrawn.1");
    assert_eq!(withdrawn.len(), 1);
    assert_eq!(
        field(&withdrawn[0], "reason"),
        &JsonValue::String("autonomy".into())
    );
    assert_eq!(
        field(&withdrawn[0], "itemID"),
        &items[0].deferral.item_id.encode()
    );
    private_provenance(&withdrawn);
    let decision = ycoding_schema::session_review::Decision::decode(
        &parse_json(r#"{"kind":"guardrail","reply":"once"}"#).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        harness
            .reviews
            .decide(ycoding_core::session::review::DecideInput {
                session_id: root.clone(),
                item_id: items[0].deferral.item_id.clone(),
                decision,
                now: 22,
            })
            .await,
        Err(ycoding_core::session::review::Error::Conflict {
            reason: ycoding_core::session::review::Conflict::Withdrawn,
            ..
        })
    ));
    assert!(service.for_session(&root).unwrap().is_empty());
    assert!(fake.seen.lock().unwrap().is_empty());
    assert!(durable(&harness, &root, "session.guardrail.approved.1").is_empty());
    assert!(durable(&harness, &root, "session.review.consumed.1").is_empty());
}
