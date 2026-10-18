use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_core::{
    process::guardrails::decision::{EvaluateFuture, Evaluator},
    resources::decision::Invocation,
    session::review::{
        self, ChildAnswer, Delivery, DeliveryError, DeliveryFuture, RecoveryResolution,
    },
    tools::policy::Reviews,
};
use ycoding_schema::{
    domain,
    session_review::{Kind, Origin, Payload, Reason, SubagentQuestionPayload},
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
        r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","choice":"Redis","confidence":0.9}]}}"#,
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
        r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","choice":"Redis","confidence":0.7}]}}"#,
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
        response: parse_json(r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","choice":"Redis","confidence":1}]}}"#).unwrap(),
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
            r#"{"response":{"answers":[{"name":"subagent_question","type":"refusal","confidence":0}]}}"#,
            Reason::Refused,
            true,
        ),
        (
            3,
            true,
            r#"{"options":["Redis"]}"#,
            r#"{"response":{"answers":[{"name":"subagent_question","type":"choice","choice":"not-listed","confidence":1}]}}"#,
            Reason::Error,
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
