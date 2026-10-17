#[path = "guardrail_service_decisions_support/mod.rs"]
mod support;

pub use support::Fixture;

use std::{sync::Arc, time::Duration};
use support::{Fake, Harness, refusal, response};
use ycoding_core::{
    resources::decision,
    session::review,
    tools::policy::{
        Wait,
        forms::{self, Forms},
        questions::{self, Admission, Questions},
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, form, parse_json, question,
    session_id::SessionId,
    session_review::{Decision, Payload, Reason},
    stringify_json,
};

const OPTIONS: &str =
    r#"[{"label":"A","description":"First plan"},{"label":"B","description":"Second plan"}]"#;
const FIELDS: &str = r#"[{"key":"plan","type":"string","required":true,"options":[{"value":"A","label":"First plan"},{"value":"B","label":"Second plan"}]}]"#;

fn question(session: &SessionId, options: &str) -> question::Request {
    question::Request::decode(&parse_json(&format!(
        r#"{{"id":"que_synthetic","sessionID":{},"questions":[{{"header":"Plan","question":"Choose a plan","options":{options},"custom":true}}]}}"#,
        stringify_json(&session.encode())
    )).unwrap()).unwrap()
}

fn form(session: &SessionId, fields: &str) -> form::Info {
    form::Info::decode(
        &parse_json(&format!(
            r#"{{"id":"frm_synthetic","sessionID":{},"title":"Choose a plan","fields":{fields}}}"#,
            stringify_json(&session.encode())
        ))
        .unwrap(),
    )
    .unwrap()
}

fn choice(name: &str, value: &str, confidence: f64) -> Result<JsonValue, decision::Error> {
    response(&format!(
        r#"{{"name":"{name}","type":"choice","answer":null,"choice":"{value}","score":null,"confidence":{confidence}}}"#
    ))
}

fn questions(harness: &Harness, fake: &Arc<Fake>) -> Questions {
    Questions::new(harness.fixture.authority(), harness.publish.clone())
        .with_reviews(harness.review_policy())
        .with_decision(fake.clone())
}

fn forms(harness: &Harness, fake: &Arc<Fake>) -> Forms {
    Forms::new(harness.fixture.authority(), harness.publish.clone())
        .with_reviews(harness.review_policy())
        .with_decision(fake.clone())
}

async fn question_result(admission: Admission) -> Result<Vec<question::Answer>, questions::Error> {
    let Admission::Pending(wait) = admission else {
        panic!("sleeping answer must settle through the decision/review boundary")
    };
    tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .expect("question did not settle")
        .expect("question sender dropped")
}

async fn form_result(wait: Wait<form::State>) -> form::State {
    tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .expect("form did not settle")
        .expect("form sender dropped")
}

fn unreplied(harness: &Harness, kind: &str) {
    assert!(
        harness
            .fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .all(|event| event.type_ != kind)
    );
}

#[tokio::test]
async fn sleeping_questions_use_the_owning_sessions_toggle_not_parent_yolo_or_goal() {
    for (yolo, goal, parent_enabled, child_enabled) in [
        (2, true, true, false),
        (0, false, false, true),
        (2, true, false, true),
        (0, false, false, false),
    ] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, yolo, goal, None);
        let child = harness
            .fixture
            .session("ses_child", Some("ses_root"), yolo, goal, None);
        harness
            .autonomy
            .set_auto_answer(&root, parent_enabled)
            .await
            .unwrap();
        harness
            .autonomy
            .set_auto_answer(&child, child_enabled)
            .await
            .unwrap();
        harness.autonomy.set_sleep(&root, true).await.unwrap();
        let fake = Fake::new(if child_enabled {
            vec![choice("q0", "B", 0.8)]
        } else {
            vec![]
        });
        let service = questions(&harness, &fake);
        let result = question_result(service.ask(question(&child, OPTIONS)).unwrap()).await;
        if child_enabled {
            assert_eq!(result.unwrap(), vec![vec![LosslessString::from("B")]]);
            let replied =
                question::RepliedData::decode(&harness.event("question.replied").await).unwrap();
            assert_eq!(replied.session_id, child);
            assert_eq!(replied.answers, vec![vec![LosslessString::from("B")]]);
            assert!(harness.reviews.list(&root).unwrap().is_empty());
            let seen = fake.seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].session_id, child);
            assert!(seen[0].input_id.is_none());
            assert!(stringify_json(&seen[0].input).contains("Second plan"));
        } else {
            let Err(questions::Error::Deferred { item_id }) = result else {
                panic!("disabled answers must defer")
            };
            let items = harness.reviews.list(&root).unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].session_id, child);
            assert_eq!(items[0].deferral.item_id, item_id);
            assert_eq!(items[0].deferral.reason, Reason::Disabled);
            assert!(fake.seen.lock().unwrap().is_empty());
            unreplied(&harness, "question.replied");
        }
        assert!(fake.replies.lock().unwrap().is_empty());
        assert!(service.list().is_empty());
        assert!(harness.autonomy.get(&root).unwrap().is_asleep());
    }
}

#[tokio::test]
async fn sleeping_forms_use_the_owning_sessions_toggle_and_apply_only_an_eligible_answer() {
    for (yolo, goal, parent_enabled, child_enabled) in [
        (2, true, true, false),
        (0, false, false, true),
        (2, true, false, true),
        (0, false, false, false),
    ] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, yolo, goal, None);
        let child = harness
            .fixture
            .session("ses_child", Some("ses_root"), yolo, goal, None);
        harness
            .autonomy
            .set_auto_answer(&root, parent_enabled)
            .await
            .unwrap();
        harness
            .autonomy
            .set_auto_answer(&child, child_enabled)
            .await
            .unwrap();
        harness.autonomy.set_sleep(&root, true).await.unwrap();
        let fake = Fake::new(if child_enabled {
            vec![choice("f0", "B", 0.8)]
        } else {
            vec![]
        });
        let service = forms(&harness, &fake);
        let request = form(&child, FIELDS);
        let state = form_result(service.ask(request.clone()).unwrap()).await;
        if child_enabled {
            let form::State::Answered(answer) = state else {
                panic!("eligible form answer must apply")
            };
            assert_eq!(answer.encode(), parse_json(r#"{"plan":"B"}"#).unwrap());
            forms::validate_answer(&request, &answer).unwrap();
            let replied = form::RepliedData::decode(&harness.event("form.replied").await).unwrap();
            assert_eq!(replied.answer, answer);
            assert_eq!(replied.session_id, child.as_lossless().clone());
            assert!(harness.reviews.list(&root).unwrap().is_empty());
            let seen = fake.seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].session_id, child);
            assert!(seen[0].input_id.is_none());
        } else {
            let form::State::Deferred { item_id } = state else {
                panic!("disabled answers must defer")
            };
            let items = harness.reviews.list(&root).unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].session_id, child);
            assert_eq!(items[0].deferral.item_id, item_id);
            assert_eq!(items[0].deferral.reason, Reason::Disabled);
            assert!(matches!(items[0].deferral.payload, Payload::Form(_)));
            assert!(fake.seen.lock().unwrap().is_empty());
            unreplied(&harness, "form.replied");
        }
        assert!(service.list(None).is_empty());
        assert!(fake.replies.lock().unwrap().is_empty());
        assert!(harness.autonomy.get(&root).unwrap().is_asleep());
    }
}

#[tokio::test]
async fn sleeping_free_text_questions_and_required_free_text_forms_never_call_the_helper() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 2, true, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    harness.autonomy.set_sleep(&root, true).await.unwrap();
    let fake = Fake::new(vec![]);
    let questions = questions(&harness, &fake);
    assert!(matches!(
        question_result(questions.ask(question(&root, "[]")).unwrap()).await,
        Err(questions::Error::Deferred { .. })
    ));
    let forms = forms(&harness, &fake);
    assert!(matches!(
        form_result(
            forms
                .ask(form(
                    &root,
                    r#"[{"key":"text","type":"string","required":true,"default":"Suggested text"}]"#
                ))
                .unwrap()
        )
        .await,
        form::State::Deferred { .. }
    ));
    let items = harness.reviews.list(&root).unwrap();
    assert_eq!(items.len(), 2);
    assert!(
        items
            .iter()
            .all(|item| item.deferral.reason == Reason::FreeText)
    );
    assert!(fake.seen.lock().unwrap().is_empty());
    unreplied(&harness, "question.replied");
    unreplied(&harness, "form.replied");
}

#[tokio::test]
async fn unlisted_low_confidence_refused_and_failed_question_answers_defer_without_defaults() {
    for (reply, reason) in [
        (choice("q0", "Unlisted custom answer", 0.99), Reason::Error),
        (choice("q0", "B", 0.79), Reason::LowConfidence),
        (refusal("q0"), Reason::Refused),
        (Err(decision::Error::ProviderFailed), Reason::Error),
    ] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, 2, true, None);
        harness.autonomy.set_auto_answer(&root, true).await.unwrap();
        harness.autonomy.set_sleep(&root, true).await.unwrap();
        let fake = Fake::new(vec![reply]);
        let service = questions(&harness, &fake);
        let Err(questions::Error::Deferred { item_id }) =
            question_result(service.ask(question(&root, OPTIONS)).unwrap()).await
        else {
            panic!("unsettled question must defer")
        };
        let items = harness.reviews.list(&root).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].deferral.item_id, item_id);
        assert_eq!(items[0].deferral.reason, reason);
        let Payload::Question(payload) = &items[0].deferral.payload else {
            panic!("question payload")
        };
        assert_eq!(payload.questions, question(&root, OPTIONS).questions);
        assert_eq!(fake.seen.lock().unwrap().len(), 1);
        assert!(service.list().is_empty());
        unreplied(&harness, "question.replied");
    }
}

#[tokio::test]
async fn unlisted_low_confidence_refused_and_failed_form_answers_defer_without_defaults() {
    for (reply, reason) in [
        (choice("f0", "Unlisted custom answer", 0.99), Reason::Error),
        (choice("f0", "B", 0.79), Reason::LowConfidence),
        (refusal("f0"), Reason::Refused),
        (Err(decision::Error::ProviderFailed), Reason::Error),
    ] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, 2, true, None);
        harness.autonomy.set_auto_answer(&root, true).await.unwrap();
        harness.autonomy.set_sleep(&root, true).await.unwrap();
        let fake = Fake::new(vec![reply]);
        let service = forms(&harness, &fake);
        let request = form(
            &root,
            r#"[{"key":"plan","type":"string","required":true,"default":"A","custom":true,"options":[{"value":"A","label":"First plan"},{"value":"B","label":"Second plan"}]}]"#,
        );
        let form::State::Deferred { item_id } =
            form_result(service.ask(request.clone()).unwrap()).await
        else {
            panic!("unsettled form must defer")
        };
        let items = harness.reviews.list(&root).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].deferral.item_id, item_id);
        assert_eq!(items[0].deferral.reason, reason);
        let Payload::Form(payload) = &items[0].deferral.payload else {
            panic!("form payload")
        };
        assert_eq!(payload.fields, request.fields.0);
        assert_eq!(fake.seen.lock().unwrap().len(), 1);
        assert!(service.list(None).is_empty());
        unreplied(&harness, "form.replied");
    }
}

#[tokio::test]
async fn a_confident_listed_form_value_still_passes_through_the_live_validator() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    harness.autonomy.set_sleep(&root, true).await.unwrap();
    let fake = Fake::new(vec![choice("f0", "x", 0.99)]);
    let service = forms(&harness, &fake);
    let request = form(
        &root,
        r#"[{"key":"plan","type":"string","required":true,"minLength":3,"options":[{"value":"x","label":"Too short"},{"value":"valid","label":"Valid plan"}]}]"#,
    );
    let invalid = form::Answer::decode(&parse_json(r#"{"plan":"x"}"#).unwrap()).unwrap();
    assert!(forms::validate_answer(&request, &invalid).is_err());
    let form::State::Deferred { item_id } = form_result(service.ask(request).unwrap()).await else {
        panic!("invalid listed value must defer")
    };
    let items = harness.reviews.list(&root).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].deferral.item_id, item_id);
    assert_eq!(items[0].deferral.reason, Reason::Error);
    unreplied(&harness, "form.replied");
    let decision = |answer: &str| review::DecideInput {
        session_id: root.clone(),
        item_id: item_id.clone(),
        now: 20,
        decision: Decision::decode(
            &parse_json(&format!(
                r#"{{"kind":"question","answers":{{"plan":"{answer}"}}}}"#
            ))
            .unwrap(),
        )
        .unwrap(),
    };
    assert!(matches!(
        harness.reviews.decide(decision("x")).await,
        Err(review::Error::InvalidDecision { .. })
    ));
    assert_eq!(harness.reviews.list(&root).unwrap().len(), 1);
    harness.reviews.decide(decision("valid")).await.unwrap();
    assert!(harness.reviews.list(&root).unwrap().is_empty());
    assert_eq!(fake.seen.lock().unwrap().len(), 1);
    assert!(harness.autonomy.get(&root).unwrap().is_asleep());
}
