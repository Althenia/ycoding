#[path = "guardrail_service_decisions_support/mod.rs"]
mod support;

use std::{ops::Bound, sync::Arc, time::Duration};
use support::{Fake, Harness, refusal, response};
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

fn predicate(answer: bool, confidence: f64) -> Result<JsonValue, decision::Error> {
    response(&format!(
        r#"{{"name":"guardrail_match","type":"predicate","answer":{answer},"choice":null,"score":null,"confidence":{confidence}}}"#
    ))
}

fn grades(
    always: Option<f64>,
    approve: f64,
    reject: f64,
    escalate: f64,
) -> Result<JsonValue, decision::Error> {
    let mut entries = vec![
        ("approve", approve),
        ("reject", reject),
        ("escalate", escalate),
    ];
    if let Some(confidence) = always {
        entries.insert(0, ("approve_all", confidence));
    }
    let entries = entries.into_iter().map(|(choice, confidence)| format!(r#"{{"choice":"{choice}","confidence":{confidence},"evidence":"Reviewed {COMMAND}; TOKEN=synthetic-secret bounded synthetic evidence"}}"#)).collect::<Vec<_>>().join(",");
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
async fn disabled_reviews_wait_for_humans_and_awake_yolo_two_never_calls_the_helper() {
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
async fn sleeping_yolo_two_with_disabled_reviews_defers_without_a_helper_or_escalation() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 2, true, None);
    harness.autonomy.set_sleep(&root, true).await.unwrap();
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
                harness.autonomy.set_sleep(&root, true).await.unwrap();
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
async fn a_dismissed_standard_rule_reclassifies_remaining_rules_without_approving_them() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    let child = harness
        .fixture
        .session("ses_child", Some("ses_root"), 0, false, None);
    let fake = Fake::new(vec![
        predicate(false, 0.9),
        predicate(true, 0.99),
        refusal("guardrail"),
    ]);
    let service = service(&harness, &fake, settings());
    let request = input(
        &child,
        "TOKEN=synthetic-secret git reset --hard && touch /outside/private-target",
    );
    let admission = service.assert(request.clone()).unwrap();
    let asked = guardrail::Request::decode(&harness.event("guardrail.asked").await).unwrap();
    assert_eq!(
        asked.rule_ids,
        vec![LosslessString::from("standard.review.outside-repo")]
    );
    assert_eq!(asked.hard_review, None);
    assert_eq!(service.for_session(&root).unwrap().len(), 1);
    assert_eq!(fake.seen.lock().unwrap().len(), 3);
    let events = durable(&harness, &root, "session.guardrail.dismissed.1");
    assert_eq!(events.len(), 1);
    assert_eq!(
        field(&events[0], "ruleID"),
        &JsonValue::String("standard.review.git-destructive".into())
    );
    assert_eq!(field(&events[0], "confidence"), &JsonValue::Number(0.9));
    assert_eq!(field(&events[0], "sessionID"), &root.encode());
    assert_eq!(field(&events[0], "reviewSessionID"), &child.encode());
    assert_eq!(
        field(&events[0], "source"),
        &request.source.unwrap().encode()
    );
    private_provenance(&events);
    assert!(durable(&harness, &child, "session.guardrail.dismissed.1").is_empty());
    assert!(durable(&harness, &child, "session.guardrail.decided.1").is_empty());
    service
        .reply(&root, &asked.id, guardrail::Reply::Reject)
        .unwrap();
    assert!(matches!(
        settled(admission.wait.unwrap()).await,
        Err(guardrails::Error::Declined)
    ));
}

#[tokio::test]
async fn the_hard_review_switch_blocks_grading_but_not_verification_or_human_review() {
    for asleep in [false, true] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, 2, true, None);
        if asleep {
            harness.autonomy.set_sleep(&root, true).await.unwrap();
        }
        let fake = Fake::new(vec![predicate(true, 0.99)]);
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
        assert_eq!(fake.seen.lock().unwrap().len(), 1);
        assert!(durable(&harness, &root, "session.guardrail.decided.1").is_empty());
        assert!(durable(&harness, &root, "session.guardrail.approved.1").is_empty());
    }
}

#[tokio::test]
async fn a_qualified_grade_settles_once_with_redacted_canonical_durable_provenance() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    let child = harness
        .fixture
        .session("ses_child", Some("ses_root"), 0, false, None);
    let fake = Fake::new(vec![
        predicate(true, 0.99),
        grades(Some(0.1), 0.8, 0.1, 0.1),
        predicate(true, 0.99),
        grades(Some(0.1), 0.8, 0.1, 0.1),
    ]);
    let service = service(&harness, &fake, settings());
    let request = input(&child, COMMAND);
    for count in 1..=2 {
        let admission = service.assert(request.clone()).unwrap();
        settled(admission.wait.unwrap()).await.unwrap().release();
        let replied =
            guardrail::RepliedData::decode(&harness.event("guardrail.replied").await).unwrap();
        assert_eq!(replied.reply, guardrail::Reply::Once);
        assert_eq!(
            replied.decided_by,
            Some(guardrail::DecidedBy::DecisionModel)
        );
        assert_eq!(replied.choice, Some(guardrail::DecisionChoice::Approve));
        assert_eq!(replied.confidence.unwrap().get(), 0.8);
        assert_eq!(replied.grades.as_ref().unwrap().len(), 4);
        assert!(matches!(
            service.reply(&root, &replied.request_id, guardrail::Reply::Once),
            Err(guardrails::Error::NotFound)
        ));
        assert_eq!(fake.seen.lock().unwrap().len(), count * 2);
        let events = durable(&harness, &root, "session.guardrail.decided.1");
        assert_eq!(events.len(), count);
        private_provenance(&events);
        for event in &events {
            assert_eq!(
                field(event, "source"),
                &request.source.as_ref().unwrap().encode()
            );
            assert_eq!(field(event, "sessionID"), &root.encode());
            assert_eq!(field(event, "reviewSessionID"), &child.encode());
        }
    }
    assert!(fake.replies.lock().unwrap().is_empty());
    for seen in fake.seen.lock().unwrap().iter() {
        assert_eq!(seen.session_id, child);
        assert_eq!(
            seen.input_id.as_ref(),
            Some(&request.source.as_ref().unwrap().message_id)
        );
        assert!(!stringify_json(&seen.input).contains("synthetic-secret"));
    }
    let decisions = service.status(&root).unwrap().decisions.unwrap();
    assert_eq!(decisions.len(), 2);
    assert!(
        decisions
            .iter()
            .all(|decision| decision.session_id == child && decision.source == request.source)
    );
    assert!(service.for_session(&root).unwrap().is_empty());
    assert!(durable(&harness, &child, "session.guardrail.decided.1").is_empty());
    assert!(durable(&harness, &root, "session.guardrail.approved.1").is_empty());
}

#[tokio::test]
async fn unsettled_grading_hands_off_awake_and_defers_asleep_without_inventing_approval() {
    for asleep in [false, true] {
        for (reply, reason, has_grades) in [
            (grades(Some(0.1), 0.9, 0.85, 0.1), Reason::Escalated, true),
            (
                grades(Some(0.1), 0.7, 0.1, 0.1),
                Reason::LowConfidence,
                true,
            ),
            (refusal("guardrail"), Reason::Refused, false),
            (Err(decision::Error::ProviderFailed), Reason::Error, false),
        ] {
            let harness = Harness::new();
            let root = harness.fixture.session("ses_root", None, 0, false, None);
            if asleep {
                harness.autonomy.set_sleep(&root, true).await.unwrap();
            }
            let fake = Fake::new(vec![predicate(true, 0.99), reply]);
            let service = service(&harness, &fake, settings());
            let admission = service.assert(input(&root, COMMAND)).unwrap();
            if asleep {
                assert!(matches!(
                    settled(admission.wait.unwrap()).await,
                    Err(guardrails::Error::Deferred { .. })
                ));
                let items = harness.reviews.list(&root).unwrap();
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].deferral.reason, reason);
                assert_eq!(items[0].deferral.grades.is_some(), has_grades);
                assert!(!stringify_json(&items[0].encode()).contains("synthetic-secret"));
                assert!(service.for_session(&root).unwrap().is_empty());
                assert!(durable(&harness, &root, "session.guardrail.escalated.1").is_empty());
            } else {
                let asked =
                    guardrail::Request::decode(&harness.event("guardrail.asked").await).unwrap();
                assert_eq!(
                    asked.escalation.as_ref().unwrap().grades.is_some(),
                    has_grades
                );
                let events = durable(&harness, &root, "session.guardrail.escalated.1");
                assert_eq!(events.len(), 1);
                private_provenance(&events);
                assert!(harness.reviews.list(&root).unwrap().is_empty());
                service
                    .reply(&root, &asked.id, guardrail::Reply::Once)
                    .unwrap();
                settled(admission.wait.unwrap()).await.unwrap().release();
                let replied =
                    guardrail::RepliedData::decode(&harness.event("guardrail.replied").await)
                        .unwrap();
                assert!(replied.decided_by.is_none());
            }
            assert_eq!(fake.seen.lock().unwrap().len(), 2);
            assert!(durable(&harness, &root, "session.guardrail.decided.1").is_empty());
        }
    }
}

#[tokio::test]
async fn custom_hard_reviews_skip_verification_and_never_offer_always_to_the_grader() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 2, true, None);
    let fake = Fake::new(vec![grades(None, 0.95, 0.1, 0.1)]);
    let mut config = settings();
    custom(
        &mut config,
        guardrail::RuleDecision::HardReview,
        "shell",
        "*",
    );
    let service = service(&harness, &fake, config);
    let admission = service.assert(input(&root, COMMAND)).unwrap();
    settled(admission.wait.unwrap()).await.unwrap().release();
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let JsonValue::Array(questions) = field(field(&seen[0].input, "request"), "questions") else {
        panic!("questions")
    };
    let JsonValue::Array(choices) = field(&questions[0], "choices") else {
        panic!("choices")
    };
    assert_eq!(
        choices
            .iter()
            .map(|choice| field(choice, "value").clone())
            .collect::<Vec<_>>(),
        vec![
            JsonValue::String("approve".into()),
            JsonValue::String("reject".into()),
            JsonValue::String("escalate".into())
        ]
    );
    assert!(durable(&harness, &root, "session.guardrail.approved.1").is_empty());
}

#[tokio::test]
async fn helper_approval_does_not_change_permission_asks_or_explicit_denies() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    let fake = Fake::new(vec![
        predicate(true, 0.99),
        grades(Some(0.1), 0.85, 0.1, 0.1),
    ]);
    let service = service(&harness, &fake, settings());
    let admission = service.assert(input(&root, COMMAND)).unwrap();
    let reservation = settled(admission.wait.unwrap()).await.unwrap();
    let permissions = harness.fixture.permissions();
    let request = |id: &str| permission::Request {
        id: permission::Id::new(id).unwrap(),
        session_id: root.clone(),
        action: "shell".into(),
        resources: vec![COMMAND.into()],
        save: None,
        metadata: None,
        source: None,
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
    assert_eq!(fake.seen.lock().unwrap().len(), 2);
    reservation.release();
}

#[tokio::test]
async fn graded_approval_waits_for_shell_capacity_and_cannot_exceed_subagent_capacity() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    let fake = Fake::new(vec![
        predicate(true, 0.99),
        grades(Some(0.1), 0.85, 0.1, 0.1),
        grades(None, 0.85, 0.1, 0.1),
    ]);
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
    harness.event("guardrail.replied").await;
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
    let admission = service.assert(subagent("reviewed")).unwrap();
    assert!(matches!(
        settled(admission.wait.unwrap()).await,
        Err(guardrails::Error::CapExceeded {
            counter: "subagents",
            current: 1,
            limit: 1,
            ..
        })
    ));
    running.release();
    assert_eq!(fake.seen.lock().unwrap().len(), 3);
}
