use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
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
}
impl Evaluator for Choice {
    fn evaluate<'a>(&'a self, input: JsonValue, invocation: Invocation<'a>) -> EvaluateFuture<'a> {
        Box::pin(async move {
            self.seen.lock().unwrap().push(input);
            if let Some(autonomy) = &self.disable {
                autonomy
                    .set_auto_answer(invocation.session_id, false)
                    .await
                    .unwrap();
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
    assert_eq!(harness.recorder.woken().len(), 1);
}

#[tokio::test]
async fn sleeping_child_deferrals_preserve_typed_failures_and_usage_attribution() {
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
        harness.service = harness.service.with_question_policy(
            Arc::new(|_| None),
            Arc::new(move |_| Some(selected.clone())),
        );
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
        assert!(!asked.auto_answered);
        assert_eq!(asked.question.deferred, Some(true));
        assert_child_reason(&harness, &reviews, &child, expected);
        let items = reviews.list(&child).unwrap();
        assert!(
            matches!(&items[0].deferral.origin, Origin::Question { question_id } if *question_id == asked.question.id)
        );
        let Payload::SubagentQuestion(payload) = &items[0].deferral.payload else {
            panic!("child question payload")
        };
        assert_eq!(payload.text.as_str(), Some("Which cache?"));
        let seen = evaluator.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].session, child);
        assert!(seen[0].input_id.is_none());
        assert_eq!(seen[0].anchor.as_ref(), Some(&anchor));
        assert!(stringify_json(&seen[0].input).contains("subagent_question"));
    }
}

#[tokio::test]
async fn malformed_sleeping_child_outputs_are_invalid_not_low_confidence_or_refusal() {
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
        harness.service = harness.service.with_question_policy(
            Arc::new(|_| None),
            Arc::new(move |_| Some(selected.clone())),
        );
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
        assert!(!asked.auto_answered);
        assert_child_reason(&harness, &reviews, &child, "invalid-output");
        assert_eq!(evaluator.seen.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn unavailable_and_ambiguous_child_requests_defer_before_evaluation() {
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
        harness.service = harness.service.with_question_policy(
            Arc::new(|_| None),
            Arc::new(move |_| {
                if case == 0 {
                    None
                } else {
                    Some(selected.clone())
                }
            }),
        );
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
        assert!(!asked.auto_answered);
        assert_child_reason(&harness, &reviews, &child, expected);
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
        harness.service = harness.service.with_question_policy(
            Arc::new(|_| None),
            Arc::new(move |_| Some(selected.clone())),
        );
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
        assert!(!asked.auto_answered);
        assert_eq!(asked.question.text.as_str(), Some(text.as_str()));
        assert_eq!(asked.question.data, Some(raw));
        assert_child_reason(&harness, &reviews, &child, "refused");
        let seen = evaluator.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(stringify_json(&seen[0].input).len() < 1_048_576);
        let items = reviews.list(&child).unwrap();
        let Payload::SubagentQuestion(payload) = &items[0].deferral.payload else {
            panic!("subagent review")
        };
        assert_eq!(payload.text, asked.question.text);
        assert_eq!(payload.data, asked.question.data);
    }
}

#[tokio::test]
async fn sleeping_child_refusal_is_distinct_and_disabled_or_free_text_never_calls_helpers() {
    for (case, expected) in [(0, "refused"), (1, "disabled"), (2, "free_text")] {
        let mut harness = harness();
        let reviews = reviews(&mut harness);
        let evaluator = typed_outcome(Ok(helper_response(
            r#"{"name":"subagent_question","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}"#,
        )));
        let selected = evaluator.clone();
        harness.service = harness.service.with_question_policy(
            Arc::new(|_| None),
            Arc::new(move |_| Some(selected.clone())),
        );
        let child = launched(&harness, "refusal-gates").await;
        sleep(&harness, &child, case != 1).await;
        let data = (case != 2).then(|| {
            domain::Json::decode(&parse_json(r#"{"options":["Redis"]}"#).unwrap()).unwrap()
        });
        let asked = harness
            .service
            .question(&child, "Which cache?", data)
            .await
            .unwrap();
        assert!(!asked.auto_answered);
        assert_child_reason(&harness, &reviews, &child, expected);
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
    harness.service = harness.service.with_question_policy(
        Arc::new(|_| None),
        Arc::new(move |_| Some(selected.clone())),
    );
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

async fn sleep(harness: &Harness, child: &session::Id, enabled: bool) {
    let autonomy = Autonomy::new(harness.store.client());
    autonomy.set_auto_answer(child, enabled).await.unwrap();
    autonomy.set_sleep(&id("ses_one"), true).await.unwrap();
}

#[tokio::test]
async fn a_question_timeout_closes_once_and_admits_fresh_guidance() {
    let harness = harness();
    let child = launched(&harness, "timeout").await;
    let asked = harness
        .service
        .question(&child, "Which cache?", None)
        .await
        .unwrap();
    assert!(
        harness
            .service
            .expire_question(&child, &asked.question.id, 300)
            .await
            .unwrap()
    );
    assert!(
        !harness
            .service
            .expire_question(&child, &asked.question.id, 300)
            .await
            .unwrap()
    );
    let task = harness.service.get(&id("ses_one"), &child).unwrap();
    assert_eq!(task.state, State::Running);
    assert!(task.question.is_none());
    let pending = harness.sessions.pending_list(&child).unwrap();
    assert_eq!(pending.len(), 2);
    let payload = ycoding_schema::stringify_json(&pending[1].data);
    assert!(payload.contains("No parent answer arrived within 300 seconds"));
    assert!(
        payload.contains("\\\"kind\\\":\\\"timeout\\\"")
            || payload.contains("\"kind\":\"timeout\""),
        "{payload}"
    );
    assert_eq!(harness.recorder.woken().len(), 2);
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
async fn disabled_timers_can_be_rearmed_from_durable_question_age_and_current_config() {
    let mut harness = harness();
    let seconds = Arc::new(AtomicU64::new(0));
    let current = seconds.clone();
    harness.service = harness.service.with_question_policy(
        Arc::new(move |_| Some(JsonValue::Number(current.load(Ordering::SeqCst) as f64))),
        Arc::new(|_| None),
    );
    let child = launched(&harness, "rearm").await;
    raw_change(
        &harness,
        &child,
        "evt_old_question",
        r#"{"type":"question_asked","question":{"id":"qst_old","text":"Which?","time":1}}"#,
    )
    .await
    .unwrap();
    assert_eq!(
        harness
            .service
            .rearm_waiting_questions_with_processes(|| async { Ok(vec![]) })
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Waiting
    );
    seconds.store(1, Ordering::SeqCst);
    assert_eq!(
        harness
            .service
            .rearm_waiting_questions_with_processes(|| async { Ok(vec![]) })
            .await
            .unwrap(),
        1
    );
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if harness.service.get(&id("ses_one"), &child).unwrap().state == State::Running {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(harness.sessions.pending_list(&child).unwrap().len(), 2);
}

#[tokio::test]
async fn review_owned_questions_never_timeout_or_rearm() {
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
            reason: Reason::SleepEntry,
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
    assert!(
        !harness
            .service
            .expire_question(&child, &asked.question.id, 300)
            .await
            .unwrap()
    );
    assert_eq!(
        harness
            .service
            .rearm_waiting_questions_with_processes(|| async { Ok(vec![]) })
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
async fn sleeping_options_use_a_bounded_decision_and_the_selected_label() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let evaluator = choice(
        r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","answer":null,"choice":"Redis","score":null,"confidence":0.9}]}}"#,
    );
    let selected = evaluator.clone();
    harness.service = harness.service.with_question_policy(
        Arc::new(|_| None),
        Arc::new(move |_| Some(selected.clone())),
    );
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
async fn sleeping_low_confidence_preserves_review_provenance_and_stays_waiting() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let evaluator = choice(
        r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","answer":null,"choice":"Redis","score":null,"confidence":0.7}]}}"#,
    );
    harness.service = harness.service.with_question_policy(
        Arc::new(|_| None),
        Arc::new(move |_| Some(evaluator.clone())),
    );
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
    assert!(!asked.auto_answered);
    assert_eq!(asked.question.deferred, Some(true));
    let items = reviews.list(&child).unwrap();
    assert_eq!(items[0].deferral.reason, Reason::LowConfidence);
    assert_eq!(
        items[0].deferral.choice.as_ref().unwrap().as_str(),
        Some("Redis")
    );
    assert_eq!(items[0].deferral.confidence.unwrap().get(), 0.7);
    assert!(
        !harness
            .service
            .expire_question(&child, &asked.question.id, 300)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn disabling_auto_answer_during_a_sleep_decision_defers_the_question() {
    let mut harness = harness();
    let reviews = reviews(&mut harness);
    let evaluator = Arc::new(Choice {
        response: parse_json(r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","answer":null,"choice":"Redis","score":null,"confidence":1}]}}"#).unwrap(),
        seen: Mutex::new(Vec::new()), disable: Some(Autonomy::new(harness.store.client())),
    });
    harness.service = harness.service.with_question_policy(
        Arc::new(|_| None),
        Arc::new(move |_| Some(evaluator.clone())),
    );
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
async fn stale_reconciliation_preserves_waiting_questions_and_only_rearms_current_or_dead_owners() {
    let mut harness = harness();
    harness.service = harness.service.with_question_policy(
        Arc::new(|_| Some(JsonValue::Number(1.0))),
        Arc::new(|_| None),
    );
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
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if [&current, &dead].into_iter().all(|child| {
                harness.service.get(&id("ses_one"), child).unwrap().state == State::Running
            }) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        harness.service.get(&id("ses_one"), &live).unwrap().state,
        State::Waiting
    );
    assert_eq!(harness.sessions.pending_list(&live).unwrap().len(), 1);
    assert!(restart_events(&harness).is_empty());
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
    assert!(
        !harness
            .service
            .expire_question(&child, &asked.question.id, 300)
            .await
            .unwrap()
    );
    assert_eq!(
        harness
            .service
            .rearm_waiting_questions_with_processes(|| async { Ok(vec![]) })
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Waiting
    );
}

#[tokio::test]
async fn free_text_disabled_refusal_and_invalid_choices_stay_in_review() {
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
            true,
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
        harness.service = harness.service.with_question_policy(
            Arc::new(|_| None),
            Arc::new(move |_| Some(selected.clone())),
        );
        let child = launched(&harness, &format!("unanswered-{index}")).await;
        sleep(&harness, &child, enabled).await;
        let asked = harness
            .service
            .question(
                &child,
                "Which?",
                Some(domain::Json::decode(&parse_json(data).unwrap()).unwrap()),
            )
            .await
            .unwrap();
        assert!(!asked.auto_answered);
        assert_eq!(reviews.list(&child).unwrap()[0].deferral.reason, reason);
        assert_eq!(!evaluator.seen.lock().unwrap().is_empty(), evaluated);
    }
}

#[tokio::test]
async fn dropping_the_question_service_disarms_its_timers() {
    let harness = harness();
    let child = launched(&harness, "dropped-timer").await;
    let service = Service::new(harness.sessions.clone(), harness.recorder.clone())
        .with_question_policy(
            Arc::new(|_| Some(JsonValue::Number(1.0))),
            Arc::new(|_| None),
        );
    service.question(&child, "Which?", None).await.unwrap();
    drop(service);
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert_eq!(
        harness.service.get(&id("ses_one"), &child).unwrap().state,
        State::Waiting
    );
    assert_eq!(harness.sessions.pending_list(&child).unwrap().len(), 1);
}
