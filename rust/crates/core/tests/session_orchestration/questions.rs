use super::*;
use ycoding_core::{
    process::guardrails::decision::{EvaluateFuture, Evaluator},
    resources::decision::{self, Invocation},
    session::review::{
        self, ChildAnswer, Delivery, DeliveryError, DeliveryFuture, RecoveryResolution,
    },
    tools::policy::Reviews,
};
use ycoding_schema::{
    ObjectEncoder, domain,
    session_orchestration::Report,
    session_review::{Kind, Origin, Payload, Reason, SubagentQuestionPayload},
    stringify_json,
};

#[derive(Default)]
struct NoDelivery;
impl Delivery for NoDelivery {
    fn wake(&self, _: &session::Id) {}
    fn answer_child<'a>(&'a self, _: ChildAnswer) -> DeliveryFuture<'a> {
        Box::pin(async { Err(DeliveryError::Conflict("unexpected review delivery".into())) })
    }
    fn resolve_recovery<'a>(&'a self, _: RecoveryResolution) -> DeliveryFuture<'a> {
        Box::pin(async {
            Err(DeliveryError::Conflict(
                "unexpected recovery delivery".into(),
            ))
        })
    }
}

struct Choice {
    response: JsonValue,
    seen: Mutex<Vec<JsonValue>>,
    disable: Option<Autonomy>,
    restore: bool,
}
impl Evaluator for Choice {
    fn evaluate<'a>(&'a self, input: JsonValue, invocation: Invocation<'a>) -> EvaluateFuture<'a> {
        Box::pin(async move {
            self.seen.lock().unwrap().push(input);
            if let Some(autonomy) = &self.disable {
                modes::answers(autonomy, invocation.session_id, modes::yolo(false)).await;
                if self.restore {
                    modes::answers(autonomy, invocation.session_id, modes::yolo(true)).await;
                }
            }
            Ok(self.response.clone())
        })
    }
}

fn choice(response: &str) -> Arc<Choice> {
    Arc::new(Choice {
        response: parse_json(response).unwrap(),
        seen: Mutex::new(Vec::new()),
        disable: None,
        restore: false,
    })
}

struct SeenQuestion {
    input: JsonValue,
    session: session::Id,
    input_id: Option<session_message::Id>,
    anchor: Option<JsonValue>,
}

struct TypedOutcome {
    response: Result<JsonValue, decision::Error>,
    seen: Mutex<Vec<SeenQuestion>>,
}

impl Evaluator for TypedOutcome {
    fn evaluate<'a>(&'a self, input: JsonValue, invocation: Invocation<'a>) -> EvaluateFuture<'a> {
        self.seen.lock().unwrap().push(SeenQuestion {
            input,
            session: invocation.session_id.clone(),
            input_id: invocation.input_id.cloned(),
            anchor: invocation.attribution.anchor().map(DomainEncode::encode),
        });
        Box::pin(async move { self.response.clone() })
    }
}

fn typed_outcome(response: Result<JsonValue, decision::Error>) -> Arc<TypedOutcome> {
    Arc::new(TypedOutcome {
        response,
        seen: Mutex::new(vec![]),
    })
}

fn helper_response(answer: &str) -> JsonValue {
    parse_json(&format!(r#"{{"provider":"agent","response":{{"model":{{"providerID":"local","id":"judge"}},"semantics":"model-estimate","version":1,"answers":[{answer}]}}}}"#)).unwrap()
}

fn assert_child_reason(
    harness: &Harness,
    reviews: &review::Service,
    child: &session::Id,
    expected: &str,
) {
    let items = reviews.list(child).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].session_id, *child);
    assert_eq!(
        items[0].deferral.reason.encode(),
        JsonValue::String(expected.into())
    );
    assert!(items[0].deferral.choice.is_none());
    assert!(items[0].deferral.confidence.is_none());
    assert_eq!(
        harness.service.get(&id("ses_one"), child).unwrap().state,
        State::Waiting
    );
    assert_eq!(harness.sessions.pending_list(child).unwrap().len(), 1);
}

#[tokio::test]
async fn yolo_child_typed_failures_use_valid_fallbacks_and_preserve_usage_attribution() {
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
        let mut harness = harness();
        let reviews = reviews(&mut harness);
        let evaluator = typed_outcome(Err(error));
        let selected = evaluator.clone();
        harness.service = harness
            .service
            .with_question_policy(Arc::new(move |_| Some(selected.clone())));
        let child = launched(&harness, "typed-failure").await;
        sleep(&harness, &child, true).await;
        let anchor = parse_json(r#"{"sessionID":"ses_one","inputID":"msg_parent"}"#).unwrap();
        let attribution =
            Attribution::Anchored(ycoding_schema::usage_anchor::Ref::decode(&anchor).unwrap());
        let asked = harness
            .service
            .question_attributed(
                &child,
                "Which cache?",
                Some(
                    domain::Json::decode(&parse_json(r#"{"options":["Redis","Memory"]}"#).unwrap())
                        .unwrap(),
                ),
                &attribution,
            )
            .await
            .unwrap();
        assert!(asked.auto_answered, "{expected}");
        assert_eq!(asked.question.deferred, None);
        assert!(reviews.list(&child).unwrap().is_empty());
        let pending = harness.sessions.pending_list(&child).unwrap();
        assert!(stringify_json(&pending.last().unwrap().data).contains("Redis"));
        assert_eq!(
            harness.service.get(&id("ses_one"), &child).unwrap().state,
            State::Running
        );
        let seen = evaluator.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].session, child);
        assert!(seen[0].input_id.is_none());
        assert_eq!(seen[0].anchor.as_ref(), Some(&anchor));
        assert!(stringify_json(&seen[0].input).contains("subagent_question"));
    }
}

#[tokio::test]
async fn malformed_yolo_child_outputs_never_become_answers_and_use_a_valid_fallback() {
    let answer = r#"{"name":"subagent_question","type":"choice","answer":null,"choice":"Redis","score":null,"confidence":0.9}"#;
    let mut responses = vec![
        JsonValue::Null,
        parse_json(r#"{"response":null}"#).unwrap(),
        parse_json(r#"{"response":{"answers":[]}}"#).unwrap(),
        helper_response(&format!("{answer},{answer}")),
        helper_response(&answer.replace("subagent_question", "other_question")),
        helper_response(&answer.replace(r#""type":"choice""#, r#""type":"predicate""#)),
        helper_response(&answer.replace("Redis", "Unlisted").replace("0.9", "0.7")),
        helper_response(&answer.replace(",\"confidence\":0.9", "")),
        helper_response(&answer.replace("0.9", "-0.1")),
        helper_response(&answer.replace("0.9", "1.1")),
        helper_response(&answer.replace("0.9", "\"0.9\"")),
        helper_response(&answer.replace("\"choice\":\"Redis\",", "")),
        helper_response(
            r#"{"name":"subagent_question","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0.2}"#,
        ),
    ];
    for confidence in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut output = helper_response(answer);
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
        responses.push(output);
    }
    for response in responses {
        let mut harness = harness();
        let reviews = reviews(&mut harness);
        let evaluator = typed_outcome(Ok(response));
        let selected = evaluator.clone();
        harness.service = harness
            .service
            .with_question_policy(Arc::new(move |_| Some(selected.clone())));
        let child = launched(&harness, "malformed-answer").await;
        sleep(&harness, &child, true).await;
        let asked = harness
            .service
            .question(
                &child,
                "Which cache?",
                Some(
                    domain::Json::decode(&parse_json(r#"{"options":["Redis","Memory"]}"#).unwrap())
                        .unwrap(),
                ),
            )
            .await
            .unwrap();
        assert!(asked.auto_answered);
        assert!(reviews.list(&child).unwrap().is_empty());
        let pending = harness.sessions.pending_list(&child).unwrap();
        assert!(stringify_json(&pending.last().unwrap().data).contains("Redis"));
        assert_eq!(evaluator.seen.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn unavailable_and_unassessable_child_options_use_a_local_fallback_without_dispatch() {
    for (case, expected) in [
        (0, "unavailable"),
        (1, "invalid-request"),
        (2, "invalid-request"),
    ] {
        let mut harness = harness();
        let reviews = reviews(&mut harness);
        let evaluator = typed_outcome(Ok(helper_response(
            r#"{"name":"subagent_question","type":"choice","answer":null,"choice":"Redis","score":null,"confidence":1}"#,
        )));
        let selected = evaluator.clone();
        harness.service = harness.service.with_question_policy(Arc::new(move |_| {
            if case == 0 {
                None
            } else {
                Some(selected.clone())
            }
        }));
        let child = launched(&harness, "invalid-request").await;
        sleep(&harness, &child, true).await;
        let options = match case {
            1 => vec![
                "token=synthetic-alpha".to_owned(),
                "token=synthetic-beta".to_owned(),
            ],
            2 => (0..256).map(|index| format!("Plan {index}")).collect(),
            _ => vec!["Redis".to_owned()],
        };
        let first = options[0].clone();
        let data = serde_json::json!({"options":options}).to_string();
        let asked = harness
            .service
            .question(
                &child,
                "Which cache?",
                Some(domain::Json::decode(&parse_json(&data).unwrap()).unwrap()),
            )
            .await
            .unwrap();
        assert!(asked.auto_answered, "{expected}");
        assert!(reviews.list(&child).unwrap().is_empty());
        let pending = harness.sessions.pending_list(&child).unwrap();
        assert!(stringify_json(&pending.last().unwrap().data).contains(&first));
        assert!(evaluator.seen.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn child_question_admission_preserves_valid_data_and_rejects_excess_before_evaluation() {
    for bytes in [8192, 8193, 1_048_593] {
        let mut harness = harness();
        let reviews = reviews(&mut harness);
        let evaluator = typed_outcome(Ok(helper_response(
            r#"{"name":"subagent_question","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}"#,
        )));
        let selected = evaluator.clone();
        harness.service = harness
            .service
            .with_question_policy(Arc::new(move |_| Some(selected.clone())));
        let child = launched(&harness, "question-data-boundary").await;
        sleep(&harness, &child, true).await;
        let text = "q".repeat(8192);
        let data = serde_json::json!({"options":["x".repeat(bytes - 16)]}).to_string();
        assert_eq!(data.len(), bytes);
        let raw = domain::Json::decode(&parse_json(&data).unwrap()).unwrap();
        let report = Report::decode(
            &ObjectEncoder::new()
                .field("action", "question")
                .field("text", text.as_str())
                .field("data", &raw)
                .finish(),
        );
        let result = harness
            .service
            .question(&child, &text, Some(raw.clone()))
            .await;
        if bytes > 8192 {
            assert!(report.is_err());
            let Err(Error::InvalidRequest(message)) = result else {
                panic!("oversized question must be rejected")
            };
            assert!(message.contains("8192"));
            assert!(evaluator.seen.lock().unwrap().is_empty());
            assert!(reviews.list(&child).unwrap().is_empty());
            let task = harness.service.get(&id("ses_one"), &child).unwrap();
            assert_eq!(task.state, State::Running);
            assert!(task.question.is_none());
            continue;
        }
        assert!(report.is_ok());
        let asked = result.unwrap();
        assert!(asked.auto_answered);
        assert_eq!(asked.question.text.as_str(), Some(text.as_str()));
        assert_eq!(asked.question.data, Some(raw));
        assert!(reviews.list(&child).unwrap().is_empty());
        let task = harness.service.get(&id("ses_one"), &child).unwrap();
        assert_eq!(task.state, State::Running);
        assert!(task.question.is_none());
        let seen = evaluator.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(stringify_json(&seen[0].input).len() < 1_048_576);
        let pending = harness.sessions.pending_list(&child).unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[1].type_.as_str(), Some("synthetic"));
        let answer =
            ycoding_schema::session_pending::SyntheticData::decode(&pending[1].data).unwrap();
        let answered = answer
            .text
            .as_str()
            .unwrap()
            .strip_prefix("Parent answer:\n")
            .unwrap();
        assert_eq!(
            parse_json(answered).unwrap(),
            ObjectEncoder::new()
                .field("questionID", &asked.question.id)
                .field("text", "x".repeat(bytes - 16).as_str())
                .finish()
        );
    }
}

#[tokio::test]
async fn yolo_child_refusal_falls_back_while_manual_and_auto_free_text_keep_review() {
    for (case, expected) in [(0, "refused"), (1, "disabled"), (2, "free_text")] {
        let mut harness = harness();
        let reviews = reviews(&mut harness);
        let evaluator = typed_outcome(Ok(helper_response(
            r#"{"name":"subagent_question","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}"#,
        )));
        let selected = evaluator.clone();
        harness.service = harness
            .service
            .with_question_policy(Arc::new(move |_| Some(selected.clone())));
        let child = launched(&harness, "refusal-gates").await;
        sleep_with(&harness, &child, case == 0, case == 2).await;
        let data = (case != 2).then(|| {
            domain::Json::decode(&parse_json(r#"{"options":["Redis"]}"#).unwrap()).unwrap()
        });
        let asked = harness
            .service
            .question(&child, "Which cache?", data)
            .await
            .unwrap();
        if case == 0 {
            assert!(asked.auto_answered);
            assert!(reviews.list(&child).unwrap().is_empty());
        } else {
            assert!(!asked.auto_answered);
            assert_child_reason(&harness, &reviews, &child, expected);
        }
        assert_eq!(evaluator.seen.lock().unwrap().len(), usize::from(case == 0));
    }
}

#[tokio::test]
async fn a_redacted_child_choice_admits_only_the_original_eligible_label() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let evaluator = typed_outcome(Ok(helper_response(
        r#"{"name":"subagent_question","type":"choice","answer":null,"choice":"token=[redacted]","score":null,"confidence":0.8}"#,
    )));
    let selected = evaluator.clone();
    harness.service = harness
        .service
        .with_question_policy(Arc::new(move |_| Some(selected.clone())));
    let child = launched(&harness, "redacted-choice").await;
    sleep(&harness, &child, true).await;
    let asked = harness
        .service
        .question(
            &child,
            "Which cache?",
            Some(
                domain::Json::decode(
                    &parse_json(r#"{"options":["token=synthetic-alpha","Public"]}"#).unwrap(),
                )
                .unwrap(),
            ),
        )
        .await
        .unwrap();
    assert!(asked.auto_answered);
    assert!(reviews.list(&child).unwrap().is_empty());
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Running
    );
    let pending = harness.sessions.pending_list(&child).unwrap();
    assert_eq!(pending.len(), 2);
    assert!(stringify_json(&pending.last().unwrap().data).contains("token=synthetic-alpha"));
    let seen = evaluator.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert!(!stringify_json(&seen[0].input).contains("synthetic-alpha"));
}

fn reviews(harness: &mut Harness) -> review::Service {
    let reviews = review::Service::new(harness.sessions.clone(), Arc::new(NoDelivery));
    harness.service = harness.service.clone().with_reviews(Reviews {
        service: reviews.clone(),
        limit: 16,
    });
    reviews
}

async fn sleep(harness: &Harness, child: &session::Id, yolo: bool) {
    sleep_with(harness, child, yolo, false).await;
}

async fn sleep_with(harness: &Harness, child: &session::Id, yolo: bool, auto_answer: bool) {
    let autonomy = Autonomy::new(harness.store.client());
    let mode = if yolo {
        modes::yolo(true)
    } else {
        modes::auto(auto_answer)
    };
    modes::answers(&autonomy, child, mode).await;
    autonomy.set_defer(&id("ses_one"), true).await.unwrap();
}

#[tokio::test]
async fn an_unanswered_question_stays_waiting_until_its_matching_answer() {
    let harness = harness();
    let child = launched(&harness, "waiting").await;
    let asked = harness
        .service
        .question(&child, "Which cache?", None)
        .await
        .unwrap();
    let task = harness.service.get(&id("ses_one"), &child).unwrap();
    assert_eq!(task.state, State::Waiting);
    assert_eq!(task.question.unwrap().id, asked.question.id);
    assert_eq!(harness.sessions.pending_list(&child).unwrap().len(), 1);
    harness
        .service
        .answer(
            &id("ses_one"),
            &child,
            &asked.question.id,
            Some("Redis"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Running
    );
    let pending = harness.sessions.pending_list(&child).unwrap();
    assert_eq!(pending.len(), 2);
    let payload = stringify_json(&pending[1].data);
    assert!(payload.contains("Redis"), "{payload}");
    assert!(!payload.contains("own best judgment"), "{payload}");
    assert!(matches!(
        harness
            .service
            .answer(
                &id("ses_one"),
                &child,
                &asked.question.id,
                Some("late"),
                None
            )
            .await,
        Err(Error::QuestionNotFound { .. })
    ));
}

#[tokio::test]
async fn pending_child_yolo_reconciliation_is_session_owned_and_settles_once() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let child = launched(&harness, "reconcile-child").await;
    let other = launched(&harness, "unrelated-child").await;
    let asked = harness
        .service
        .question(
            &child,
            "Which cache?",
            Some(
                domain::Json::decode(&parse_json(r#"{"options":["Redis","Memory"]}"#).unwrap())
                    .unwrap(),
            ),
        )
        .await
        .unwrap();
    assert!(!asked.auto_answered);
    let before = harness.sessions.pending_list(&child).unwrap().len();
    let autonomy = Autonomy::new(harness.store.client());
    modes::answers(&autonomy, &child, modes::yolo(true)).await;
    assert!(!harness.service.reconcile_autonomy(&other).await.unwrap());
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Waiting
    );
    assert!(harness.service.reconcile_autonomy(&child).await.unwrap());
    assert!(!harness.service.reconcile_autonomy(&child).await.unwrap());
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Running
    );
    let pending = harness.sessions.pending_list(&child).unwrap();
    assert_eq!(pending.len(), before + 1);
    assert!(stringify_json(&pending.last().unwrap().data).contains("Redis"));
    assert!(reviews.list(&child).unwrap().is_empty());
}

#[tokio::test]
async fn review_owned_questions_stay_waiting_and_reject_parent_answers() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let child = launched(&harness, "held").await;
    let asked = harness
        .service
        .question(&child, "Which?", None)
        .await
        .unwrap();
    reviews
        .open(review::OpenInput {
            session_id: child.clone(),
            kind: Kind::SubagentQuestion,
            reason: Reason::DeferEntry,
            choice: None,
            confidence: None,
            grades: None,
            origin: Origin::Question {
                question_id: asked.question.id.clone(),
            },
            payload: Payload::SubagentQuestion(SubagentQuestionPayload {
                text: "Which?".into(),
                data: None,
            }),
            limit: 16,
            conversion: true,
            created: 10,
        })
        .await
        .unwrap();
    assert!(matches!(
        harness
            .service
            .answer(
                &id("ses_one"),
                &child,
                &asked.question.id,
                Some("parent"),
                None
            )
            .await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Waiting
    );
    assert_eq!(harness.sessions.pending_list(&child).unwrap().len(), 1);
}

#[tokio::test]
async fn sleeping_options_use_a_bounded_decision_and_the_selected_label() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let evaluator = choice(
        r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","answer":null,"choice":"Redis","score":null,"confidence":0.9}]}}"#,
    );
    let selected = evaluator.clone();
    harness.service = harness
        .service
        .with_question_policy(Arc::new(move |_| Some(selected.clone())));
    let child = launched(&harness, "sleep-choice").await;
    sleep(&harness, &child, true).await;
    let asked = harness
        .service
        .question(
            &child,
            "Which cache?",
            Some(
                domain::Json::decode(
                    &parse_json(
                        r#"{"options":[{"label":"Redis","value":"redis-id"},"Memory",false]}"#,
                    )
                    .unwrap(),
                )
                .unwrap(),
            ),
        )
        .await
        .unwrap();
    assert!(asked.auto_answered);
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Running
    );
    assert!(reviews.list(&child).unwrap().is_empty());
    assert_eq!(evaluator.seen.lock().unwrap().len(), 1);
    let pending = harness.sessions.pending_list(&child).unwrap();
    assert!(ycoding_schema::stringify_json(&pending.last().unwrap().data).contains("Redis"));
}

#[tokio::test]
async fn yolo_child_low_confidence_uses_a_valid_option_and_keeps_the_task_running() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let evaluator = choice(
        r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","answer":null,"choice":"Redis","score":null,"confidence":0.7}]}}"#,
    );
    harness.service = harness
        .service
        .with_question_policy(Arc::new(move |_| Some(evaluator.clone())));
    let child = launched(&harness, "sleep-low").await;
    sleep(&harness, &child, true).await;
    let asked = harness
        .service
        .question(
            &child,
            "Which cache?",
            Some(
                domain::Json::decode(&parse_json(r#"{"options":["Redis","Memory"]}"#).unwrap())
                    .unwrap(),
            ),
        )
        .await
        .unwrap();
    assert!(asked.auto_answered);
    assert_eq!(asked.question.deferred, None);
    assert!(reviews.list(&child).unwrap().is_empty());
    let pending = harness.sessions.pending_list(&child).unwrap();
    assert!(stringify_json(&pending.last().unwrap().data).contains("Redis"));
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Running
    );
}

#[tokio::test]
async fn a_child_question_uses_a_fresh_valid_fallback_when_yolo_is_restored_during_evaluation() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let evaluator = Arc::new(Choice {
        response: parse_json(r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","answer":null,"choice":"Redis","score":null,"confidence":1}]}}"#).unwrap(),
        seen: Mutex::new(Vec::new()), disable: Some(Autonomy::new(harness.store.client())), restore: true,
    });
    let selected = evaluator.clone();
    harness.service = harness
        .service
        .with_question_policy(Arc::new(move |_| Some(selected.clone())));
    let child = launched(&harness, "restored-yolo").await;
    sleep(&harness, &child, true).await;
    let asked = harness
        .service
        .question(
            &child,
            "Which cache?",
            Some(
                domain::Json::decode(&parse_json(r#"{"options":["Memory","Redis"]}"#).unwrap())
                    .unwrap(),
            ),
        )
        .await
        .unwrap();
    assert!(asked.auto_answered);
    assert_eq!(asked.question.deferred, None);
    assert_eq!(evaluator.seen.lock().unwrap().len(), 1);
    assert!(reviews.list(&child).unwrap().is_empty());
    let pending = harness.sessions.pending_list(&child).unwrap();
    let admitted = stringify_json(&pending.last().unwrap().data);
    assert!(admitted.contains("Memory"));
    assert!(admitted.contains("yolo"));
    assert!(admitted.contains("automatic"));
    assert!(!admitted.contains("confidence"));
}

#[tokio::test]
async fn disabling_yolo_during_a_sleep_decision_defers_the_question() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let evaluator = Arc::new(Choice {
        response: parse_json(r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","answer":null,"choice":"Redis","score":null,"confidence":1}]}}"#).unwrap(),
        seen: Mutex::new(Vec::new()), disable: Some(Autonomy::new(harness.store.client())), restore: false,
    });
    harness.service = harness
        .service
        .with_question_policy(Arc::new(move |_| Some(evaluator.clone())));
    let child = launched(&harness, "sleep-disabled").await;
    sleep(&harness, &child, true).await;
    let asked = harness
        .service
        .question(
            &child,
            "Which?",
            Some(domain::Json::decode(&parse_json(r#"{"options":["Redis"]}"#).unwrap()).unwrap()),
        )
        .await
        .unwrap();
    assert!(!asked.auto_answered);
    assert_eq!(
        reviews.list(&child).unwrap()[0].deferral.reason,
        Reason::Disabled
    );
    assert_eq!(harness.sessions.pending_list(&child).unwrap().len(), 1);
}

#[tokio::test]
async fn stale_reconciliation_preserves_waiting_questions_of_any_age_and_owner() {
    let harness = harness();
    let current = launched(&harness, "waiting-current").await;
    let dead = launched(&harness, "waiting-dead").await;
    let live = launched(&harness, "waiting-live").await;
    for (index, child) in [&current, &dead, &live].into_iter().enumerate() {
        raw_change(&harness, child, &format!("evt_waiting_{index}"), &format!(r#"{{"type":"question_asked","question":{{"id":"qst_waiting_{index}","text":"Which?","time":1}}}}"#)).await.unwrap();
    }
    set_owner(&harness, &dead, Some(2_000_000_000), Some("dead")).await;
    set_owner(&harness, &live, Some(2_000_000_001), Some("live")).await;
    assert_eq!(
        harness
            .service
            .reconcile_stale_with_processes(|| async {
                Ok(vec![ledger::Process {
                    pid: 2_000_000_001,
                    pgid: 2_000_000_001,
                    started: "live".into(),
                }])
            })
            .await
            .unwrap(),
        0
    );
    for child in [&current, &dead, &live] {
        assert_eq!(
            harness.service.get(&id("ses_one"), child).unwrap().state,
            State::Waiting
        );
        assert_eq!(harness.sessions.pending_list(child).unwrap().len(), 1);
    }
    assert!(restart_events(&harness).is_empty());
    harness
        .service
        .answer(
            &id("ses_one"),
            &dead,
            &QuestionId("qst_waiting_1".into()),
            Some("Redis"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        harness.service.get(&id("ses_one"), &dead).unwrap().state,
        State::Running
    );
}

#[tokio::test]
async fn restart_recovery_questions_are_never_automatically_closed() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let child = launched(&harness, "recovery-question").await;
    let asked = harness
        .service
        .question(&child, "Continue interrupted tools?", None)
        .await
        .unwrap();
    reviews.open(review::OpenInput {
        session_id: child.clone(), kind: Kind::Recovery, reason: Reason::Restart,
        choice: None, confidence: None, grades: None,
        origin: Origin::Question { question_id: asked.question.id.clone() },
        payload: Payload::decode(&parse_json(r#"{"type":"recovery","tools":[{"messageID":"msg_parent","callID":"call_interrupted","name":"shell"}]}"#).unwrap()).unwrap(),
        limit: 16, conversion: true, created: 10,
    }).await.unwrap();
    assert_eq!(
        harness
            .service
            .reconcile_stale_with_processes(|| async { Ok(vec![]) })
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Waiting
    );
    assert_eq!(harness.sessions.pending_list(&child).unwrap().len(), 1);
}

#[tokio::test]
async fn manual_and_auto_keep_unanswered_child_reviews_while_yolo_falls_back() {
    for (index, enabled, data, response, reason, evaluated) in [
        (
            0,
            false,
            r#"{"options":["Redis"]}"#,
            r#"{"response":{"answers":[]}}"#,
            Reason::Disabled,
            false,
        ),
        (
            1,
            false,
            r#"{"options":[]}"#,
            r#"{"response":{"answers":[]}}"#,
            Reason::FreeText,
            false,
        ),
        (
            2,
            true,
            r#"{"options":["Redis"]}"#,
            r#"{"response":{"answers":[{"name":"subagent_question","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}]}}"#,
            Reason::Refused,
            true,
        ),
        (
            3,
            true,
            r#"{"options":["Redis"]}"#,
            r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","answer":null,"choice":"not-listed","score":null,"confidence":1}]}}"#,
            Reason::InvalidOutput,
            true,
        ),
    ] {
        let mut harness = harness();
        let reviews = reviews(&mut harness);
        let evaluator = choice(response);
        let selected = evaluator.clone();
        harness.service = harness
            .service
            .with_question_policy(Arc::new(move |_| Some(selected.clone())));
        let child = launched(&harness, &format!("unanswered-{index}")).await;
        sleep_with(&harness, &child, enabled, index == 1).await;
        let asked = harness
            .service
            .question(
                &child,
                "Which?",
                Some(domain::Json::decode(&parse_json(data).unwrap()).unwrap()),
            )
            .await
            .unwrap();
        if enabled {
            assert!(asked.auto_answered);
            assert!(reviews.list(&child).unwrap().is_empty());
            let pending = harness.sessions.pending_list(&child).unwrap();
            assert!(stringify_json(&pending.last().unwrap().data).contains("Redis"));
        } else {
            assert!(!asked.auto_answered);
            assert_eq!(reviews.list(&child).unwrap()[0].deferral.reason, reason);
        }
        assert_eq!(!evaluator.seen.lock().unwrap().is_empty(), evaluated);
    }
}

#[tokio::test]
async fn a_sleeping_yolo_child_free_text_question_admits_a_bounded_evaluator_answer() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let evaluator = choice(
        r#"{"response":{"answers":[{"name":"subagent_question","type":"text","answer":null,"choice":null,"score":null,"confidence":0.9,"text":"Use Redis"}]}}"#,
    );
    let selected = evaluator.clone();
    harness.service = harness
        .service
        .with_question_policy(Arc::new(move |_| Some(selected.clone())));
    let child = launched(&harness, "sleep-text").await;
    sleep(&harness, &child, true).await;
    let asked = harness
        .service
        .question(&child, "Which cache?", None)
        .await
        .unwrap();
    assert!(asked.auto_answered);
    assert!(reviews.list(&child).unwrap().is_empty());
    assert_eq!(evaluator.seen.lock().unwrap().len(), 1);
    let pending = harness.sessions.pending_list(&child).unwrap();
    assert!(stringify_json(&pending.last().unwrap().data).contains("Use Redis"));
}
