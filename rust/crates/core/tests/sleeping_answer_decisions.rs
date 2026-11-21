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

pub use support::Fixture;

#[path = "decision_support/mod.rs"]
mod modes;

use evaluator_support::Fake;
use refusal_support::refusal;
use std::{sync::Arc, time::Duration};
use support::{Harness, response};
use ycoding_core::{
    process::guardrails::decision::{EvaluateFuture, Evaluator},
    resources::decision,
    tools::policy::{
        Wait,
        forms::{self, Forms},
        questions::{self, Admission, Questions},
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, form, parse_json, question,
    session_id::SessionId,
    session_review::{Payload, Reason},
    stringify_json,
};

const OPTIONS: &str =
    r#"[{"label":"A","description":"First plan"},{"label":"B","description":"Second plan"}]"#;
const FIELDS: &str = r#"[{"key":"plan","type":"string","required":true,"options":[{"value":"A","label":"First plan"},{"value":"B","label":"Second plan"}]}]"#;

fn question(session: &SessionId, options: &str) -> question::Request {
    question::Request::decode(&parse_json(&format!(
        r#"{{"id":"que_synthetic","sessionID":{},"questions":[{{"header":"Plan","question":"Choose a plan","options":{options},"custom":false}}]}}"#,
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
    let wait = match admission {
        Admission::Answered(answers) => return Ok(answers),
        Admission::Pending(wait) => wait,
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
async fn sleeping_questions_call_the_evaluator_only_under_yolo_not_rule_flags_auto_answer_or_goal()
{
    for (rules, goal, auto_answer, yolo) in [
        (2, true, true, false),
        (0, false, false, true),
        (2, true, false, true),
        (0, false, false, false),
    ] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, rules, goal, None);
        let mode = if yolo {
            modes::yolo(true)
        } else {
            modes::auto(auto_answer)
        };
        modes::answers(&harness.autonomy(), &root, mode).await;
        harness.autonomy().set_defer(&root, true).await.unwrap();
        let fake = Fake::new(if yolo {
            vec![choice("q0", "B", 0.8)]
        } else {
            vec![]
        });
        let service = questions(&harness, &fake);
        let result = question_result(service.ask(question(&root, OPTIONS)).unwrap()).await;
        if yolo {
            assert_eq!(result.unwrap(), vec![vec![LosslessString::from("B")]]);
            let replied =
                question::RepliedData::decode(&harness.event("question.replied").await).unwrap();
            assert_eq!(replied.session_id, root);
            assert_eq!(replied.answers, vec![vec![LosslessString::from("B")]]);
            assert!(harness.reviews.list(&root).unwrap().is_empty());
            let seen = fake.seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].1, root);
            assert!(seen[0].2.is_none());
            assert!(stringify_json(&seen[0].0).contains("Second plan"));
        } else {
            let Err(questions::Error::Deferred { item_id }) = result else {
                panic!("disabled answers must defer")
            };
            let items = harness.reviews.list(&root).unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].session_id, root);
            assert_eq!(items[0].deferral.item_id, item_id);
            assert_eq!(items[0].deferral.reason, Reason::Disabled);
            assert!(fake.seen.lock().unwrap().is_empty());
            unreplied(&harness, "question.replied");
        }
        assert!(fake.replies.lock().unwrap().is_empty());
        assert!(service.list().is_empty());
        assert!(harness.autonomy().get(&root).unwrap().is_deferred());
    }
}

#[tokio::test]
async fn sleeping_forms_call_the_evaluator_only_under_yolo_and_apply_only_an_eligible_answer() {
    for (rules, goal, auto_answer, yolo) in [
        (2, true, true, false),
        (0, false, false, true),
        (2, true, false, true),
        (0, false, false, false),
    ] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, rules, goal, None);
        let mode = if yolo {
            modes::yolo(true)
        } else {
            modes::auto(auto_answer)
        };
        modes::answers(&harness.autonomy(), &root, mode).await;
        harness.autonomy().set_defer(&root, true).await.unwrap();
        let fake = Fake::new(if yolo {
            vec![choice("f0", "B", 0.8)]
        } else {
            vec![]
        });
        let service = forms(&harness, &fake);
        let request = form(&root, FIELDS);
        let state = form_result(service.ask(request.clone()).unwrap()).await;
        if yolo {
            let form::State::Answered(answer) = state else {
                panic!("eligible form answer must apply")
            };
            assert_eq!(answer.encode(), parse_json(r#"{"plan":"B"}"#).unwrap());
            forms::validate_answer(&request, &answer).unwrap();
            let replied = form::RepliedData::decode(&harness.event("form.replied").await).unwrap();
            assert_eq!(replied.answer, answer);
            assert_eq!(replied.session_id, root.as_lossless().clone());
            assert!(harness.reviews.list(&root).unwrap().is_empty());
            let seen = fake.seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].1, root);
            assert!(seen[0].2.is_none());
        } else {
            let form::State::Deferred { item_id } = state else {
                panic!("disabled answers must defer")
            };
            let items = harness.reviews.list(&root).unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].session_id, root);
            assert_eq!(items[0].deferral.item_id, item_id);
            assert_eq!(items[0].deferral.reason, Reason::Disabled);
            assert!(matches!(items[0].deferral.payload, Payload::Form(_)));
            assert!(fake.seen.lock().unwrap().is_empty());
            unreplied(&harness, "form.replied");
        }
        assert!(service.list(None).is_empty());
        assert!(fake.replies.lock().unwrap().is_empty());
        assert!(harness.autonomy().get(&root).unwrap().is_deferred());
    }
}

#[tokio::test]
async fn an_unsettled_custom_question_falls_back_to_a_bounded_custom_answer() {
    let (harness, root) = sleeping_harness().await;
    let fake = Fake::new(vec![
        choice("q0", "B", 0.5),
        response(
            r#"{"name":"q0","type":"text","answer":null,"choice":null,"score":null,"confidence":0.9,"text":"Plan C"}"#,
        ),
    ]);
    let mut request = question(&root, OPTIONS);
    request.questions[0].custom = Some(true);
    assert_eq!(
        question_result(questions(&harness, &fake).ask(request).unwrap())
            .await
            .unwrap(),
        vec![vec![LosslessString::from("Plan C")]]
    );
    assert_eq!(fake.seen.lock().unwrap().len(), 2);
    assert!(harness.reviews.list(&root).unwrap().is_empty());
}

#[tokio::test]
async fn sleeping_free_text_questions_and_required_free_text_forms_never_call_the_helper() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 2, true, None);
    modes::answers(&harness.autonomy(), &root, modes::auto(true)).await;
    harness.autonomy().set_defer(&root, true).await.unwrap();
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
                    r#"[{"key":"text","type":"string","required":true}]"#
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
async fn unlisted_low_confidence_refused_and_failed_question_answers_use_a_listed_fallback() {
    for reply in [
        choice("q0", "Unlisted custom answer", 0.99),
        choice("q0", "B", 0.79),
        refusal("q0"),
        Err(decision::Error::ProviderFailed),
    ] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, 2, true, None);
        modes::answers(&harness.autonomy(), &root, modes::yolo(true)).await;
        harness.autonomy().set_defer(&root, true).await.unwrap();
        let fake = Fake::new(vec![reply]);
        let service = questions(&harness, &fake);
        assert_eq!(
            question_result(service.ask(question(&root, OPTIONS)).unwrap())
                .await
                .unwrap(),
            vec![vec![LosslessString::from("A")]]
        );
        assert!(harness.reviews.list(&root).unwrap().is_empty());
        assert_eq!(fake.seen.lock().unwrap().len(), 1);
        assert!(service.list().is_empty());
        let replied =
            question::RepliedData::decode(&harness.event("question.replied").await).unwrap();
        assert_eq!(replied.answers, vec![vec![LosslessString::from("A")]]);
    }
}

#[tokio::test]
async fn unlisted_low_confidence_refused_and_failed_form_answers_use_a_valid_default() {
    for reply in [
        choice("f0", "Unlisted custom answer", 0.99),
        choice("f0", "B", 0.79),
        refusal("f0"),
        Err(decision::Error::ProviderFailed),
    ] {
        let harness = Harness::new();
        let root = harness.fixture.session("ses_root", None, 2, true, None);
        modes::answers(&harness.autonomy(), &root, modes::yolo(true)).await;
        harness.autonomy().set_defer(&root, true).await.unwrap();
        let fake = Fake::new(vec![reply]);
        let service = forms(&harness, &fake);
        let request = form(
            &root,
            r#"[{"key":"plan","type":"string","required":true,"default":"A","options":[{"value":"A","label":"First plan"},{"value":"B","label":"Second plan"}]}]"#,
        );
        let form::State::Answered(answer) =
            form_result(service.ask(request.clone()).unwrap()).await
        else {
            panic!("unsettled form must use its valid default")
        };
        forms::validate_answer(&request, &answer).unwrap();
        assert_eq!(answer.encode(), parse_json(r#"{"plan":"A"}"#).unwrap());
        assert!(harness.reviews.list(&root).unwrap().is_empty());
        assert_eq!(fake.seen.lock().unwrap().len(), 1);
        assert!(service.list(None).is_empty());
        let replied = form::RepliedData::decode(&harness.event("form.replied").await).unwrap();
        assert_eq!(replied.answer, answer);
    }
}

#[tokio::test]
async fn a_confident_listed_form_value_still_passes_through_the_live_validator() {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    modes::answers(&harness.autonomy(), &root, modes::yolo(true)).await;
    harness.autonomy().set_defer(&root, true).await.unwrap();
    let fake = Fake::new(vec![choice("f0", "x", 0.99)]);
    let service = forms(&harness, &fake);
    let request = form(
        &root,
        r#"[{"key":"plan","type":"string","required":true,"minLength":3,"options":[{"value":"x","label":"Too short"},{"value":"valid","label":"Valid plan"}]}]"#,
    );
    let invalid = form::Answer::decode(&parse_json(r#"{"plan":"x"}"#).unwrap()).unwrap();
    assert!(forms::validate_answer(&request, &invalid).is_err());
    let form::State::Answered(answer) = form_result(service.ask(request.clone()).unwrap()).await
    else {
        panic!("invalid listed value must use a valid fallback")
    };
    forms::validate_answer(&request, &answer).unwrap();
    assert_eq!(answer.encode(), parse_json(r#"{"plan":"valid"}"#).unwrap());
    assert!(harness.reviews.list(&root).unwrap().is_empty());
    let replied = form::RepliedData::decode(&harness.event("form.replied").await).unwrap();
    assert_eq!(replied.answer, answer);
    assert_eq!(fake.seen.lock().unwrap().len(), 1);
    assert!(harness.autonomy().get(&root).unwrap().is_deferred());
}

async fn sleeping_harness() -> (Harness, SessionId) {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    modes::answers(&harness.autonomy(), &root, modes::yolo(true)).await;
    harness.autonomy().set_defer(&root, true).await.unwrap();
    (harness, root)
}

#[tokio::test]
async fn question_and_form_fallbacks_settle_after_every_typed_helper_failure() {
    for error in [
        decision::Error::Unavailable,
        decision::Error::InvalidRequest,
        decision::Error::ProviderFailed,
        decision::Error::Timeout,
        decision::Error::InputTooLarge,
        decision::Error::InvalidOutput,
        decision::Error::Refused,
        decision::Error::TruncatedOutput,
        decision::Error::UnsupportedOutput,
        decision::Error::Cancelled,
    ] {
        for is_form in [false, true] {
            let (harness, root) = sleeping_harness().await;
            let fake = Fake::new(vec![Err(error)]);
            if is_form {
                let service = forms(&harness, &fake);
                let request = form(&root, FIELDS);
                let form::State::Answered(answer) =
                    form_result(service.ask(request.clone()).unwrap()).await
                else {
                    panic!("helper failure must use a valid fallback")
                };
                forms::validate_answer(&request, &answer).unwrap();
                assert_eq!(answer.encode(), parse_json(r#"{"plan":"A"}"#).unwrap());
                assert!(service.list(None).is_empty());
                let replied =
                    form::RepliedData::decode(&harness.event("form.replied").await).unwrap();
                assert_eq!(replied.answer, answer);
            } else {
                let service = questions(&harness, &fake);
                assert_eq!(
                    question_result(service.ask(question(&root, OPTIONS)).unwrap())
                        .await
                        .unwrap(),
                    vec![vec![LosslessString::from("A")]]
                );
                assert!(service.list().is_empty());
                let replied =
                    question::RepliedData::decode(&harness.event("question.replied").await)
                        .unwrap();
                assert_eq!(replied.answers, vec![vec![LosslessString::from("A")]]);
            }
            assert!(harness.reviews.list(&root).unwrap().is_empty());
            let seen = fake.seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].1, root);
            assert!(seen[0].2.is_none());
            assert!(fake.replies.lock().unwrap().is_empty());
            assert!(harness.autonomy().get(&root).unwrap().is_deferred());
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
async fn malformed_question_and_form_outputs_use_valid_native_fallbacks() {
    for is_form in [false, true] {
        for reply in malformed_outputs(if is_form { "f0" } else { "q0" }) {
            let (harness, root) = sleeping_harness().await;
            let fake = Fake::new(vec![reply]);
            if is_form {
                let request = form(&root, FIELDS);
                let form::State::Answered(answer) =
                    form_result(forms(&harness, &fake).ask(request.clone()).unwrap()).await
                else {
                    panic!("malformed output must use a valid fallback")
                };
                forms::validate_answer(&request, &answer).unwrap();
                assert_eq!(answer.encode(), parse_json(r#"{"plan":"A"}"#).unwrap());
                let replied =
                    form::RepliedData::decode(&harness.event("form.replied").await).unwrap();
                assert_eq!(replied.answer, answer);
            } else {
                assert_eq!(
                    question_result(
                        questions(&harness, &fake)
                            .ask(question(&root, OPTIONS))
                            .unwrap()
                    )
                    .await
                    .unwrap(),
                    vec![vec![LosslessString::from("A")]]
                );
                let replied =
                    question::RepliedData::decode(&harness.event("question.replied").await)
                        .unwrap();
                assert_eq!(replied.answers, vec![vec![LosslessString::from("A")]]);
            }
            assert!(harness.reviews.list(&root).unwrap().is_empty());
            assert_eq!(fake.seen.lock().unwrap().len(), 1);
        }
    }
}

#[tokio::test]
async fn missing_question_and_form_helpers_use_valid_native_fallbacks() {
    for is_form in [false, true] {
        let (harness, root) = sleeping_harness().await;
        if is_form {
            let service = Forms::new(harness.fixture.authority(), harness.publish.clone())
                .with_reviews(harness.review_policy());
            let request = form(&root, FIELDS);
            let form::State::Answered(answer) =
                form_result(service.ask(request.clone()).unwrap()).await
            else {
                panic!("missing helper must use a valid fallback")
            };
            forms::validate_answer(&request, &answer).unwrap();
            assert_eq!(answer.encode(), parse_json(r#"{"plan":"A"}"#).unwrap());
            let replied = form::RepliedData::decode(&harness.event("form.replied").await).unwrap();
            assert_eq!(replied.answer, answer);
            assert!(service.list(None).is_empty());
        } else {
            let service = Questions::new(harness.fixture.authority(), harness.publish.clone())
                .with_reviews(harness.review_policy());
            assert_eq!(
                question_result(service.ask(question(&root, OPTIONS)).unwrap())
                    .await
                    .unwrap(),
                vec![vec![LosslessString::from("A")]]
            );
            unreplied(&harness, "question.replied");
            unreplied(&harness, "question.asked");
            assert!(service.list().is_empty());
        }
        assert!(harness.reviews.list(&root).unwrap().is_empty());
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
                let form::State::Answered(answer) =
                    form_result(forms(&harness, &fake).ask(request.clone()).unwrap()).await
                else {
                    panic!("unassessable evidence must use a valid fallback")
                };
                forms::validate_answer(&request, &answer).unwrap();
                assert_eq!(
                    answer.encode(),
                    parse_json(if oversized {
                        r#"{"plan":"A"}"#
                    } else {
                        r#"{"plan":"token=synthetic-alpha"}"#
                    })
                    .unwrap()
                );
                let replied =
                    form::RepliedData::decode(&harness.event("form.replied").await).unwrap();
                assert_eq!(replied.answer, answer);
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
                let expected = vec![vec![LosslessString::from(if oversized {
                    "A"
                } else {
                    "token=synthetic-alpha"
                })]];
                assert_eq!(
                    question_result(questions(&harness, &fake).ask(request).unwrap())
                        .await
                        .unwrap(),
                    expected
                );
                let replied =
                    question::RepliedData::decode(&harness.event("question.replied").await)
                        .unwrap();
                assert_eq!(replied.answers, expected);
            }
            assert!(harness.reviews.list(&root).unwrap().is_empty());
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
        assert!(!stringify_json(&seen[0].0).contains("synthetic-alpha"));
        assert!(stringify_json(&seen[0].0).contains("[redacted]"));
    }
}

#[tokio::test]
async fn duplicate_question_labels_defer_without_dispatching_an_ambiguous_request() {
    let (harness, root) = sleeping_harness().await;
    let fake = Fake::new(vec![]);
    let service = questions(&harness, &fake);
    let request = question(
        &root,
        r#"[{"label":"A","description":"First"},{"label":"A","description":"Second"}]"#,
    );
    let Err(questions::Error::Deferred { item_id }) =
        question_result(service.ask(request.clone()).unwrap()).await
    else {
        panic!("duplicate option IDs cannot identify an answer")
    };
    let items = harness.reviews.list(&root).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].deferral.item_id, item_id);
    assert_eq!(items[0].deferral.reason, Reason::InvalidRequest);
    let Payload::Question(payload) = &items[0].deferral.payload else {
        panic!("question payload")
    };
    assert_eq!(payload.questions, request.questions);
    assert!(fake.seen.lock().unwrap().is_empty());
    assert!(service.list().is_empty());
    unreplied(&harness, "question.replied");
}

#[tokio::test]
async fn oversized_helper_batches_use_valid_fallbacks_before_evaluation() {
    for is_form in [false, true] {
        let (harness, root) = sleeping_harness().await;
        let fake = Fake::new(vec![]);
        if is_form {
            let fields = (0..33).map(|index| serde_json::json!({"key":format!("value_{index}"),"type":"boolean","required":true})).collect::<Vec<_>>();
            let request = form(&root, &serde_json::to_string(&fields).unwrap());
            let form::State::Answered(answer) =
                form_result(forms(&harness, &fake).ask(request.clone()).unwrap()).await
            else {
                panic!("oversized batch must use a valid fallback")
            };
            forms::validate_answer(&request, &answer).unwrap();
            assert_eq!(answer.0.len(), 33);
            assert!(
                answer
                    .0
                    .iter()
                    .all(|(_, value)| value == &JsonValue::Bool(true))
            );
            let replied = form::RepliedData::decode(&harness.event("form.replied").await).unwrap();
            assert_eq!(replied.answer, answer);
        } else {
            let mut request = question(&root, OPTIONS);
            request.questions = (0..33).map(|_| request.questions[0].clone()).collect();
            let expected = vec![vec![LosslessString::from("A")]; 33];
            assert_eq!(
                question_result(questions(&harness, &fake).ask(request).unwrap())
                    .await
                    .unwrap(),
                expected
            );
            let replied =
                question::RepliedData::decode(&harness.event("question.replied").await).unwrap();
            assert_eq!(replied.answers, expected);
        }
        assert!(harness.reviews.list(&root).unwrap().is_empty());
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
        assert!(harness.autonomy().get(&root).unwrap().is_deferred());
    }
}
