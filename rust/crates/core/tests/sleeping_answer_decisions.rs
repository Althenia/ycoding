#[path = "guardrail_service_decisions_support/mod.rs"]
mod support;

pub use support::Fixture;

use std::{sync::Arc, time::Duration};
use support::{Fake, Harness, refusal, response};
use ycoding_core::{
    process::guardrails::decision::{EvaluateFuture, Evaluator},
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
        (
            choice("q0", "Unlisted custom answer", 0.99),
            Reason::InvalidOutput,
        ),
        (choice("q0", "B", 0.79), Reason::LowConfidence),
        (refusal("q0"), Reason::Refused),
        (Err(decision::Error::ProviderFailed), Reason::ProviderFailed),
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
        (
            choice("f0", "Unlisted custom answer", 0.99),
            Reason::InvalidOutput,
        ),
        (choice("f0", "B", 0.79), Reason::LowConfidence),
        (refusal("f0"), Reason::Refused),
        (Err(decision::Error::ProviderFailed), Reason::ProviderFailed),
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
    assert_eq!(items[0].deferral.reason, Reason::InvalidOutput);
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

async fn sleeping_harness() -> (Harness, SessionId) {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    harness.autonomy.set_auto_answer(&root, true).await.unwrap();
    harness.autonomy.set_sleep(&root, true).await.unwrap();
    (harness, root)
}

fn assert_reason(harness: &Harness, session: &SessionId, expected: &str) {
    let items = harness.reviews.list(session).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].session_id, *session);
    assert_eq!(
        items[0].deferral.reason.encode(),
        JsonValue::String(expected.into())
    );
}

#[tokio::test]
async fn question_and_form_deferrals_preserve_every_typed_helper_failure() {
    for (error, expected) in [
        (decision::Error::Unavailable, "unavailable"),
        (decision::Error::InvalidRequest, "invalid-request"),
        (decision::Error::ProviderFailed, "provider-failed"),
        (decision::Error::Timeout, "timeout"),
        (decision::Error::InputTooLarge, "input-too-large"),
        (decision::Error::InvalidOutput, "invalid-output"),
        (decision::Error::Refused, "refused"),
        (decision::Error::TruncatedOutput, "truncated-output"),
        (decision::Error::UnsupportedOutput, "unsupported-output"),
        (decision::Error::Cancelled, "error"),
    ] {
        for is_form in [false, true] {
            let (harness, root) = sleeping_harness().await;
            let fake = Fake::new(vec![Err(error)]);
            if is_form {
                let service = forms(&harness, &fake);
                assert!(matches!(
                    form_result(service.ask(form(&root, FIELDS)).unwrap()).await,
                    form::State::Deferred { .. }
                ));
                assert!(service.list(None).is_empty());
                unreplied(&harness, "form.replied");
            } else {
                let service = questions(&harness, &fake);
                assert!(matches!(
                    question_result(service.ask(question(&root, OPTIONS)).unwrap()).await,
                    Err(questions::Error::Deferred { .. })
                ));
                assert!(service.list().is_empty());
                unreplied(&harness, "question.replied");
            }
            assert_reason(&harness, &root, expected);
            let seen = fake.seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].session_id, root);
            assert!(seen[0].input_id.is_none());
            assert!(fake.replies.lock().unwrap().is_empty());
            assert!(harness.autonomy.get(&root).unwrap().is_asleep());
        }
    }
}

fn malformed_outputs(name: &str) -> Vec<Result<JsonValue, decision::Error>> {
    let answer = format!(
        r#"{{"name":"{name}","type":"choice","answer":null,"choice":"B","score":null,"confidence":0.9}}"#
    );
    let mut outputs = vec![
        Ok(JsonValue::Null),
        Ok(parse_json(r#"{"response":null}"#).unwrap()),
        Ok(parse_json(r#"{"response":{"answers":null}}"#).unwrap()),
        Ok(parse_json(r#"{"response":{"answers":[]}}"#).unwrap()),
        Ok(parse_json(&format!(
            r#"{{"response":{{"answers":[{answer},{answer}]}}}}"#
        ))
        .unwrap()),
        choice("other_question", "B", 0.9),
        choice(name, "Unlisted", 0.79),
        response(&answer.replace(r#""type":"choice""#, r#""type":"score""#)),
        response(&answer.replace(",\"confidence\":0.9", "")),
        response(&answer.replace(r#""confidence":0.9"#, r#""confidence":"0.9""#)),
        response(&answer.replace(r#""confidence":0.9"#, r#""confidence":-0.1"#)),
        response(&answer.replace(r#""confidence":0.9"#, r#""confidence":1.1"#)),
        response(&answer.replace("\"choice\":\"B\",", "")),
        response(&format!(
            r#"{{"name":"{name}","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0.2}}"#
        )),
    ];
    for confidence in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut output = response(&answer).unwrap();
        let JsonValue::Object(root) = &mut output else {
            panic!()
        };
        let JsonValue::Object(mut response_fields) = root.get(&"response".into()).unwrap().clone()
        else {
            panic!()
        };
        let JsonValue::Array(mut answers) = response_fields.get(&"answers".into()).unwrap().clone()
        else {
            panic!()
        };
        let JsonValue::Object(answer) = &mut answers[0] else {
            panic!()
        };
        answer.insert("confidence".into(), JsonValue::Number(confidence));
        response_fields.insert("answers".into(), JsonValue::Array(answers));
        root.insert("response".into(), JsonValue::Object(response_fields));
        outputs.push(Ok(output));
    }
    outputs
}

#[tokio::test]
async fn malformed_question_and_form_outputs_are_invalid_not_low_confidence() {
    for is_form in [false, true] {
        for reply in malformed_outputs(if is_form { "f0" } else { "q0" }) {
            let (harness, root) = sleeping_harness().await;
            let fake = Fake::new(vec![reply]);
            if is_form {
                assert!(matches!(
                    form_result(forms(&harness, &fake).ask(form(&root, FIELDS)).unwrap()).await,
                    form::State::Deferred { .. }
                ));
                unreplied(&harness, "form.replied");
            } else {
                assert!(matches!(
                    question_result(
                        questions(&harness, &fake)
                            .ask(question(&root, OPTIONS))
                            .unwrap()
                    )
                    .await,
                    Err(questions::Error::Deferred { .. })
                ));
                unreplied(&harness, "question.replied");
            }
            assert_reason(&harness, &root, "invalid-output");
            assert_eq!(fake.seen.lock().unwrap().len(), 1);
        }
    }
}

#[tokio::test]
async fn missing_question_and_form_helpers_defer_as_unavailable() {
    for is_form in [false, true] {
        let (harness, root) = sleeping_harness().await;
        if is_form {
            let service = Forms::new(harness.fixture.authority(), harness.publish.clone())
                .with_reviews(harness.review_policy());
            assert!(matches!(
                form_result(service.ask(form(&root, FIELDS)).unwrap()).await,
                form::State::Deferred { .. }
            ));
            unreplied(&harness, "form.replied");
        } else {
            let service = Questions::new(harness.fixture.authority(), harness.publish.clone())
                .with_reviews(harness.review_policy());
            assert!(matches!(
                question_result(service.ask(question(&root, OPTIONS)).unwrap()).await,
                Err(questions::Error::Deferred { .. })
            ));
            unreplied(&harness, "question.replied");
        }
        assert_reason(&harness, &root, "unavailable");
    }
}

#[tokio::test]
async fn ambiguous_redaction_and_oversized_option_evidence_never_call_helpers() {
    for is_form in [false, true] {
        for oversized in [false, true] {
            let (harness, root) = sleeping_harness().await;
            let fake = Fake::new(vec![]);
            if is_form {
                let mut request = form(
                    &root,
                    if oversized {
                        FIELDS
                    } else {
                        r#"[{"key":"plan","type":"string","required":true,"options":[{"value":"token=synthetic-alpha","label":"First"},{"value":"token=synthetic-beta","label":"Second"}]}]"#
                    },
                );
                if oversized {
                    request.title = "x".repeat(1_048_577).into();
                }
                assert!(matches!(
                    form_result(forms(&harness, &fake).ask(request).unwrap()).await,
                    form::State::Deferred { .. }
                ));
                unreplied(&harness, "form.replied");
            } else {
                let mut request = question(
                    &root,
                    if oversized {
                        OPTIONS
                    } else {
                        r#"[{"label":"token=synthetic-alpha","description":"First"},{"label":"token=synthetic-beta","description":"Second"}]"#
                    },
                );
                if oversized {
                    request.questions[0].question = "x".repeat(1_048_577).into();
                }
                assert!(matches!(
                    question_result(questions(&harness, &fake).ask(request).unwrap()).await,
                    Err(questions::Error::Deferred { .. })
                ));
                unreplied(&harness, "question.replied");
            }
            assert_reason(
                &harness,
                &root,
                if oversized {
                    "input-too-large"
                } else {
                    "invalid-request"
                },
            );
            assert!(fake.seen.lock().unwrap().is_empty());
        }
    }
}

#[tokio::test]
async fn redacted_choices_map_back_to_original_question_labels_and_form_values() {
    for is_form in [false, true] {
        let (harness, root) = sleeping_harness().await;
        let fake = Fake::new(vec![choice(
            if is_form { "f0" } else { "q0" },
            "token=[redacted]",
            0.8,
        )]);
        if is_form {
            let request = form(
                &root,
                r#"[{"key":"plan","type":"string","required":true,"options":[{"value":"token=synthetic-alpha","label":"First"},{"value":"Public","label":"Second"}]}]"#,
            );
            let form::State::Answered(answer) =
                form_result(forms(&harness, &fake).ask(request.clone()).unwrap()).await
            else {
                panic!("listed Form value must apply")
            };
            forms::validate_answer(&request, &answer).unwrap();
            assert_eq!(
                answer.encode(),
                parse_json(r#"{"plan":"token=synthetic-alpha"}"#).unwrap()
            );
        } else {
            let request = question(
                &root,
                r#"[{"label":"token=synthetic-alpha","description":"First"},{"label":"Public","description":"Second"}]"#,
            );
            assert_eq!(
                question_result(questions(&harness, &fake).ask(request).unwrap())
                    .await
                    .unwrap(),
                vec![vec![LosslessString::from("token=synthetic-alpha")]]
            );
        }
        assert!(harness.reviews.list(&root).unwrap().is_empty());
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(!stringify_json(&seen[0].input).contains("synthetic-alpha"));
        assert!(stringify_json(&seen[0].input).contains("[redacted]"));
    }
}

#[tokio::test]
async fn too_many_automatic_questions_are_invalid_before_evaluation() {
    for is_form in [false, true] {
        let (harness, root) = sleeping_harness().await;
        let fake = Fake::new(vec![]);
        if is_form {
            let fields = (0..33).map(|index| serde_json::json!({"key":format!("value_{index}"),"type":"boolean","required":true})).collect::<Vec<_>>();
            let request = form(&root, &serde_json::to_string(&fields).unwrap());
            assert!(matches!(
                form_result(forms(&harness, &fake).ask(request).unwrap()).await,
                form::State::Deferred { .. }
            ));
            unreplied(&harness, "form.replied");
        } else {
            let mut request = question(&root, OPTIONS);
            request.questions[0].multiple = Some(true);
            request.questions[0].options = (0..33)
                .map(|index| question::Option {
                    label: format!("Plan {index}").into(),
                    description: "Synthetic plan".into(),
                })
                .collect();
            assert!(matches!(
                question_result(questions(&harness, &fake).ask(request).unwrap()).await,
                Err(questions::Error::Deferred { .. })
            ));
            unreplied(&harness, "question.replied");
        }
        assert_reason(&harness, &root, "invalid-request");
        assert!(fake.seen.lock().unwrap().is_empty());
    }
}

#[derive(Default)]
struct HoldingEvaluator {
    entered: tokio::sync::Notify,
    exited: tokio::sync::Notify,
}

struct PendingEvaluation<'a> {
    exited: &'a tokio::sync::Notify,
    cancellation: &'a ycoding_core::tools::code_mode::Cancellation,
}

impl Drop for PendingEvaluation<'_> {
    fn drop(&mut self) {
        assert!(self.cancellation.is_cancelled());
        self.exited.notify_one();
    }
}

impl Evaluator for HoldingEvaluator {
    fn evaluate<'a>(
        &'a self,
        _: JsonValue,
        invocation: decision::Invocation<'a>,
    ) -> EvaluateFuture<'a> {
        Box::pin(async move {
            let _pending = PendingEvaluation {
                exited: &self.exited,
                cancellation: invocation.cancellation,
            };
            self.entered.notify_one();
            invocation.cancellation.cancelled().await;
            Err(decision::Error::Cancelled)
        })
    }
}

#[tokio::test]
async fn cancelling_pending_question_and_form_decisions_never_creates_a_review_or_answer() {
    for is_form in [false, true] {
        let (harness, root) = sleeping_harness().await;
        let evaluator = Arc::new(HoldingEvaluator::default());
        if is_form {
            let service = Forms::new(harness.fixture.authority(), harness.publish.clone())
                .with_reviews(harness.review_policy())
                .with_decision(evaluator.clone());
            let request = form(&root, FIELDS);
            let wait = service.ask(request.clone()).unwrap();
            tokio::time::timeout(Duration::from_secs(5), evaluator.entered.notified())
                .await
                .unwrap();
            service.cancel(&request.id).unwrap();
            assert_eq!(form_result(wait).await, form::State::Cancelled);
            assert!(!service.has_pending());
            unreplied(&harness, "form.replied");
        } else {
            let service = Questions::new(harness.fixture.authority(), harness.publish.clone())
                .with_reviews(harness.review_policy())
                .with_decision(evaluator.clone());
            let request = question(&root, OPTIONS);
            let Admission::Pending(wait) = service.ask(request.clone()).unwrap() else {
                panic!("decision must be pending")
            };
            tokio::time::timeout(Duration::from_secs(5), evaluator.entered.notified())
                .await
                .unwrap();
            service.cancel(&request.id);
            let _: tokio::sync::oneshot::error::RecvError =
                tokio::time::timeout(Duration::from_secs(5), wait)
                    .await
                    .expect("question cancellation must settle")
                    .expect_err(
                        "cancelled decision must close without delivering a question result",
                    );
            assert!(!service.has_pending());
            unreplied(&harness, "question.replied");
        }
        tokio::time::timeout(Duration::from_secs(5), evaluator.exited.notified())
            .await
            .unwrap();
        assert!(harness.reviews.list(&root).unwrap().is_empty());
        assert!(harness.autonomy.get(&root).unwrap().is_asleep());
    }
}
