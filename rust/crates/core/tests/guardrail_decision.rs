use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use ycoding_core::{
    process::guardrails::{
        Evaluation,
        decision::{
            Adapter, EvaluateFuture, Evaluator, GRADE_INSTRUCTIONS, GRADE_TIMEOUT, Grading, Limits,
            Match, MatchEvidence, Redact, Review, ReviewPolicy, Skip, VERIFY_INSTRUCTIONS,
            VERIFY_TIMEOUT, Verification,
        },
    },
    resources::decision::{self, Invocation, judgment},
    session::{autonomy::State, usage_attribution::Attribution},
    tools::{code_mode::Cancellation, policy::Effect},
};
use ycoding_schema::{
    DomainEncode, JsonObject, JsonValue, LosslessString, guardrail, parse_json, session,
    session_message, session_review, stringify_json,
};

const SECRET: &str = "sk-SECRET";
const COMMAND: &str = "rm -rf ./build sk-SECRET";

#[path = "guardrail_helper_deadline/mod.rs"]
mod helper_deadline;

enum Reply {
    Value(JsonValue),
    Failure(decision::Error),
    Hang,
}

struct Seen {
    input: JsonValue,
    session_id: session::Id,
    input_id: Option<session_message::Id>,
    attribution: Attribution,
    purpose: Option<decision::Purpose>,
    authority: Option<guardrail::Authority>,
    key: Option<String>,
}

#[derive(Default)]
struct Fake {
    replies: Mutex<VecDeque<Reply>>,
    seen: Mutex<Vec<Seen>>,
    redacted: Mutex<Vec<JsonValue>>,
}

impl Fake {
    fn with(replies: Vec<Reply>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            seen: Mutex::default(),
            redacted: Mutex::default(),
        })
    }

    fn redactor_never_saw(&self, fixed: &[&str]) {
        for value in self.redacted.lock().unwrap().iter() {
            let text = stringify_json(value);
            for fixed in fixed {
                assert!(
                    !text.contains(fixed),
                    "fixed prompt text was redacted: {fixed}"
                );
            }
        }
    }

    fn calls(&self) -> usize {
        self.seen.lock().unwrap().len()
    }

    fn request(&self) -> JsonValue {
        let seen = self.seen.lock().unwrap();
        let JsonValue::Object(input) = &seen.last().unwrap().input else {
            panic!("decision input must be an object")
        };
        assert_eq!(input.len(), 2);
        assert_eq!(
            input.get(&"provider".into()),
            Some(&JsonValue::String("agent".into()))
        );
        input.get(&"request".into()).unwrap().clone()
    }
}

impl Evaluator for Fake {
    fn evaluate<'a>(&'a self, input: JsonValue, invocation: Invocation<'a>) -> EvaluateFuture<'a> {
        self.seen.lock().unwrap().push(Seen {
            input,
            session_id: invocation.session_id.clone(),
            input_id: invocation.input_id.cloned(),
            attribution: invocation.attribution.clone(),
            purpose: invocation.purpose,
            authority: invocation.authority,
            key: invocation.invocation_key.map(str::to_owned),
        });
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected helper call");
        Box::pin(async move {
            match reply {
                Reply::Value(value) => Ok(value),
                Reply::Failure(error) => Err(error),
                Reply::Hang => std::future::pending().await,
            }
        })
    }
}

fn scrub(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::String(text) => JsonValue::String(
            text.to_utf8()
                .unwrap()
                .replace(SECRET, "[redacted]")
                .as_str()
                .into(),
        ),
        JsonValue::Array(items) => JsonValue::Array(items.iter().map(scrub).collect()),
        JsonValue::Object(object) => {
            let mut scrubbed = JsonObject::new();
            for (key, item) in object.iter() {
                scrubbed.insert(key.clone(), scrub(item));
            }
            JsonValue::Object(scrubbed)
        }
        other => other.clone(),
    }
}

fn adapter(fake: &Arc<Fake>, policy: ReviewPolicy) -> Adapter {
    let log = fake.clone();
    let redact: Redact = Arc::new(move |value| {
        log.redacted.lock().unwrap().push(value.clone());
        scrub(value)
    });
    Adapter {
        evaluator: fake.clone(),
        redact,
        policy,
        limits: Limits {
            verify: Duration::from_millis(50),
            grade: Duration::from_millis(50),
        },
    }
}

const ENABLED: ReviewPolicy = ReviewPolicy {
    decide_reviews: true,
    decide_hard_reviews: true,
};

fn sid(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn evaluation(rule: &str, effect: Effect, standard: bool, hard_review: bool) -> Evaluation {
    Evaluation {
        effect,
        rule_ids: vec![rule.into()],
        reason: Some("Deletes files in the project".into()),
        standard,
        hard_review,
    }
}

fn ordinary() -> Evaluation {
    evaluation("standard.review.outside-repo", Effect::Ask, true, false)
}

fn hard() -> Evaluation {
    evaluation("standard.review.project-deletion", Effect::Ask, true, true)
}

fn evidence() -> MatchEvidence {
    MatchEvidence {
        matched_segment: COMMAND.into(),
        resolved_targets: vec!["/work/project/build".into()],
        workdir: "/work/project".into(),
        project: "/work/project".into(),
    }
}

fn resources() -> Vec<LosslessString> {
    vec![COMMAND.into()]
}

async fn verify(
    adapter: &Adapter,
    evaluation: &Evaluation,
    skip_review: bool,
    ordinary_auto: bool,
    evidence: Option<&MatchEvidence>,
    cancellation: &Cancellation,
) -> Verification {
    verify_in_mode(
        adapter,
        evaluation,
        skip_review,
        ordinary_auto,
        true,
        evidence,
        cancellation,
    )
    .await
}

async fn verify_in_mode(
    adapter: &Adapter,
    evaluation: &Evaluation,
    skip_review: bool,
    ordinary_auto: bool,
    yolo: bool,
    evidence: Option<&MatchEvidence>,
    cancellation: &Cancellation,
) -> Verification {
    let resources = resources();
    adapter
        .verify(
            &Match {
                action: "shell",
                resources: &resources,
                evaluation,
                skip_review,
                ordinary_auto,
                yolo,
                evidence,
                key: "msg_tool\0call_tool",
            },
            invocation(cancellation),
        )
        .await
}

fn invocation(cancellation: &Cancellation) -> Invocation<'_> {
    Invocation {
        session_id: Box::leak(Box::new(sid("ses_child"))),
        input_id: Some(Box::leak(Box::new(
            session_message::Id::new("msg_input").unwrap(),
        ))),
        cancellation,
        attribution: Attribution::Unanchored,
        purpose: None,
        authority: None,
        invocation_key: None,
    }
}

async fn grade(
    adapter: &Adapter,
    evaluation: &Evaluation,
    yolo: bool,
    skip_review: bool,
    ordinary_auto: bool,
    cancellation: &Cancellation,
) -> Grading {
    let resources = resources();
    adapter
        .grade(
            &Review {
                action: "shell",
                resources: &resources,
                evaluation,
                root_session_id: &sid("ses_root"),
                workdir: &"/work/project".into(),
                skip_review,
                ordinary_auto,
                yolo,
                key: "msg_tool\0call_tool",
            },
            invocation(cancellation),
        )
        .await
}

fn response(answer: &str) -> JsonValue {
    parse_json(&format!(
        r#"{{"provider":"agent","response":{{"model":{{"providerID":"local","id":"judge"}},"semantics":"model-estimate","version":1,"answers":[{answer}]}}}}"#
    ))
    .unwrap()
}

fn verdict(choice: &str, confidence: f64) -> Reply {
    Reply::Value(response(&format!(
        r#"{{"name":"guardrail_match","type":"choice","answer":null,"choice":"{choice}","score":null,"confidence":{confidence}}}"#
    )))
}

fn refusal(name: &str) -> Reply {
    Reply::Value(response(&format!(
        r#"{{"name":"{name}","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}}"#
    )))
}

fn graded(grades: &[(&str, f64, &str)]) -> Reply {
    let grades = grades
        .iter()
        .map(|(choice, confidence, evidence)| {
            format!(r#"{{"choice":"{choice}","confidence":{confidence},"evidence":"{evidence}"}}"#)
        })
        .collect::<Vec<_>>()
        .join(",");
    Reply::Value(response(&format!(
        r#"{{"name":"guardrail","type":"choice","answer":null,"choice":null,"score":null,"confidence":0,"grades":[{grades}]}}"#
    )))
}

fn grades(allow: f64, deny: f64, escalate: f64) -> Reply {
    graded(&[
        ("allow", allow, "Scoped build output"),
        ("deny", deny, "No reason to stop"),
        ("escalate", escalate, "Clear scope"),
    ])
}

fn confidence(value: f64) -> guardrail::Confidence {
    guardrail::Confidence::new(value).unwrap()
}

fn field<'a>(value: &'a JsonValue, path: &[&str]) -> &'a JsonValue {
    path.iter().fold(value, |value, key| {
        let JsonValue::Object(object) = value else {
            panic!("{key} parent is not an object")
        };
        object
            .get(&(*key).into())
            .unwrap_or_else(|| panic!("missing {key}"))
    })
}

fn settled(grading: &Grading) -> (guardrail::Reply, &guardrail::Escalation) {
    match grading {
        Grading::Settled { reply, provenance } => (*reply, provenance),
        other => panic!("expected a settled grade, got {other:?}"),
    }
}

fn escalated(grading: &Grading) -> (session_review::Reason, &guardrail::Escalation) {
    match grading {
        Grading::Escalated { reason, provenance } => (*reason, provenance),
        other => panic!("expected an escalation, got {other:?}"),
    }
}

fn choices(request: &JsonValue) -> JsonValue {
    let JsonValue::Array(questions) = field(request, &["questions"]) else {
        panic!("questions must be an array")
    };
    field(&questions[0], &["choices"]).clone()
}

const DISABLED: ReviewPolicy = ReviewPolicy {
    decide_reviews: false,
    decide_hard_reviews: true,
};

#[test]
fn published_deadlines_are_fifteen_seconds_for_verification_and_sixty_for_grading() {
    assert_eq!(VERIFY_TIMEOUT, Duration::from_secs(15));
    assert_eq!(GRADE_TIMEOUT, Duration::from_secs(60));
    assert_eq!(
        Limits::default(),
        Limits {
            verify: VERIFY_TIMEOUT,
            grade: GRADE_TIMEOUT,
        }
    );
}

#[tokio::test]
async fn verification_never_calls_the_helper_outside_an_enabled_standard_review() {
    let cancellation = Cancellation::default();
    let fake = Fake::with(vec![]);
    let disabled = adapter(&fake, DISABLED);
    let enabled = adapter(&fake, ENABLED);
    let no_hard = adapter(
        &fake,
        ReviewPolicy {
            decide_reviews: true,
            decide_hard_reviews: false,
        },
    );
    let evidence = evidence();
    for (label, adapter, evaluation, skip_review, ordinary_auto, evidence) in [
        (
            "disabled ordinary",
            &disabled,
            ordinary(),
            false,
            false,
            Some(&evidence),
        ),
        (
            "disabled hard",
            &disabled,
            hard(),
            false,
            false,
            Some(&evidence),
        ),
        (
            "hard assessment off",
            &no_hard,
            hard(),
            false,
            false,
            Some(&evidence),
        ),
        (
            "custom rule",
            &enabled,
            evaluation("custom.review.deploy", Effect::Ask, false, false),
            false,
            false,
            Some(&evidence),
        ),
        (
            "deny",
            &enabled,
            evaluation("standard.deny.catastrophic", Effect::Deny, true, false),
            false,
            false,
            Some(&evidence),
        ),
        (
            "allow",
            &enabled,
            evaluation("standard.review.outside-repo", Effect::Allow, true, false),
            false,
            false,
            Some(&evidence),
        ),
        (
            "non-review standard rule",
            &enabled,
            evaluation("standard.hard.history", Effect::Ask, true, true),
            false,
            false,
            Some(&evidence),
        ),
        (
            "skip review",
            &enabled,
            ordinary(),
            true,
            false,
            Some(&evidence),
        ),
        (
            "no classifier evidence",
            &enabled,
            ordinary(),
            false,
            false,
            None,
        ),
        (
            "auto-guardrail approved",
            &enabled,
            ordinary(),
            false,
            true,
            Some(&evidence),
        ),
    ] {
        assert_eq!(
            verify(
                adapter,
                &evaluation,
                skip_review,
                ordinary_auto,
                evidence,
                &cancellation
            )
            .await,
            Verification::Skipped,
            "{label}"
        );
    }
    assert_eq!(fake.calls(), 0);
}

#[tokio::test]
async fn hard_reviews_and_sleeping_ordinary_reviews_are_verified() {
    let cancellation = Cancellation::default();
    let fake = Fake::with(vec![verdict("deny", 0.99), verdict("deny", 0.99)]);
    let enabled = adapter(&fake, ENABLED);
    let evidence = evidence();
    assert_eq!(
        verify(
            &enabled,
            &hard(),
            false,
            true,
            Some(&evidence),
            &cancellation
        )
        .await,
        Verification::Kept
    );
    let asleep = State::read(Some(
        &parse_json(r#"{"mode":"normal","permissions":"auto","guardrails":"auto","answers":"manual","sleep":{}}"#).unwrap(),
    ))
    .effective();
    assert_eq!(
        verify(
            &enabled,
            &ordinary(),
            false,
            asleep.can_auto_guardrail(),
            Some(&evidence),
            &cancellation
        )
        .await,
        Verification::Kept
    );
    assert_eq!(fake.calls(), 2);
}

#[tokio::test]
async fn only_an_allow_at_ninety_percent_or_more_dismisses_a_rule() {
    let cancellation = Cancellation::default();
    let evidence = evidence();
    for (reply, expected) in [
        (
            verdict("allow", 0.9),
            Verification::Dismissed {
                rule_id: "standard.review.outside-repo".into(),
                confidence: confidence(0.9),
            },
        ),
        (verdict("allow", 0.89), Verification::Kept),
        (verdict("deny", 0.99), Verification::Kept),
        (verdict("escalate", 0.99), Verification::Kept),
        (refusal("guardrail_match"), Verification::Kept),
        (
            Reply::Failure(decision::Error::Unavailable),
            Verification::Kept,
        ),
        (Reply::Hang, Verification::Kept),
    ] {
        let fake = Fake::with(vec![reply]);
        assert_eq!(
            verify(
                &adapter(&fake, ENABLED),
                &ordinary(),
                false,
                false,
                Some(&evidence),
                &cancellation
            )
            .await,
            expected
        );
        assert_eq!(fake.calls(), 1);
    }
}

#[tokio::test]
async fn cancellation_ends_verification_and_grading_without_a_judgment() {
    let evidence = evidence();
    let cancellation = Cancellation::default();
    let fake = Fake::with(vec![Reply::Hang, Reply::Hang]);
    let mut slow = adapter(&fake, ENABLED);
    slow.limits = Limits {
        verify: Duration::from_secs(30),
        grade: Duration::from_secs(30),
    };
    let cancel = cancellation.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel.cancel();
    });
    assert_eq!(
        verify(
            &slow,
            &ordinary(),
            false,
            false,
            Some(&evidence),
            &cancellation
        )
        .await,
        Verification::Cancelled
    );
    canceller.await.unwrap();
    assert_eq!(
        grade(&slow, &ordinary(), true, false, false, &cancellation).await,
        Grading::Cancelled
    );
    let failed = Fake::with(vec![Reply::Failure(decision::Error::Cancelled)]);
    assert_eq!(
        grade(
            &adapter(&failed, ENABLED),
            &ordinary(),
            true,
            false,
            false,
            &Cancellation::default()
        )
        .await,
        Grading::Cancelled
    );
}

#[tokio::test]
async fn verification_sends_redacted_untrusted_evidence_as_a_strict_choice() {
    let cancellation = Cancellation::default();
    let fake = Fake::with(vec![verdict("deny", 0.99)]);
    let enabled = adapter(&fake, ENABLED);
    let evidence = evidence();
    verify(
        &enabled,
        &ordinary(),
        false,
        false,
        Some(&evidence),
        &cancellation,
    )
    .await;
    let request = fake.request();
    assert_eq!(
        field(&request, &["state", "matchedRule"]),
        &parse_json(
            r#"{"id":"standard.review.outside-repo","reason":"Deletes files in the project"}"#
        )
        .unwrap()
    );
    assert_eq!(
        field(&request, &["state", "untrustedEvidence"]),
        &parse_json(
            r#"{"action":"shell","resources":["rm -rf ./build [redacted]"],"classifier":{"matchedSegment":"rm -rf ./build [redacted]","resolvedTargets":["/work/project/build"]},"workdir":"/work/project","project":"/work/project"}"#
        )
        .unwrap()
    );
    let JsonValue::Array(questions) = field(&request, &["questions"]) else {
        panic!("questions must be an array")
    };
    assert_eq!(
        field(&questions[0], &["type"]),
        &JsonValue::String("choice".into())
    );
    assert_eq!(
        field(&questions[0], &["instructions"]),
        &JsonValue::String(VERIFY_INSTRUCTIONS.into())
    );
    let JsonValue::Array(offered) = choices(&request) else {
        panic!("choices must be an array")
    };
    assert_eq!(
        offered
            .iter()
            .map(|choice| field(choice, &["value"]).clone())
            .collect::<Vec<_>>(),
        ["allow", "deny", "escalate"]
            .map(|value| JsonValue::String(value.into()))
            .to_vec()
    );
    assert!(!stringify_json(&request).contains(SECRET));
    judgment::Request::decode(&request).expect("the decision service accepts the request");
    fake.redactor_never_saw(&[VERIFY_INSTRUCTIONS]);
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen[0].session_id, sid("ses_child"));
    assert_eq!(
        seen[0].input_id,
        Some(session_message::Id::new("msg_input").unwrap())
    );
    assert_eq!(seen[0].attribution, Attribution::Unanchored);
    assert_eq!(seen[0].purpose, Some(decision::Purpose::Guardrail));
    assert_eq!(seen[0].authority, Some(guardrail::Authority::Yolo));
    assert!(
        seen[0]
            .key
            .as_deref()
            .is_some_and(|key| key.starts_with("guardrail-match:"))
    );
}

#[tokio::test]
async fn grading_never_calls_the_helper_when_it_is_disabled_or_not_needed() {
    let cancellation = Cancellation::default();
    let fake = Fake::with(vec![]);
    let enabled = adapter(&fake, ENABLED);
    let disabled = adapter(&fake, DISABLED);
    let no_hard = adapter(
        &fake,
        ReviewPolicy {
            decide_reviews: true,
            decide_hard_reviews: false,
        },
    );
    for (label, adapter, evaluation, yolo, skip_review, ordinary_auto, expected) in [
        (
            "allow",
            &enabled,
            evaluation("standard.review.outside-repo", Effect::Allow, true, false),
            false,
            false,
            false,
            Skip::NotReviewed,
        ),
        (
            "skip review",
            &enabled,
            ordinary(),
            false,
            true,
            false,
            Skip::NotReviewed,
        ),
        (
            "auto-guardrail",
            &enabled,
            ordinary(),
            true,
            false,
            true,
            Skip::AutoApproved,
        ),
        (
            "disabled without YOLO",
            &disabled,
            ordinary(),
            false,
            false,
            false,
            Skip::Disabled,
        ),
        (
            "hard assessment off with YOLO",
            &no_hard,
            hard(),
            true,
            false,
            false,
            Skip::Disabled,
        ),
    ] {
        assert_eq!(
            grade(
                adapter,
                &evaluation,
                yolo,
                skip_review,
                ordinary_auto,
                &cancellation
            )
            .await,
            Grading::Skipped(expected),
            "{label}"
        );
    }
    assert_eq!(fake.calls(), 0);
}

#[tokio::test]
async fn qualifying_grades_settle_with_the_highest_confidence_choice_and_full_provenance() {
    let cancellation = Cancellation::default();
    let fake = Fake::with(vec![
        grades(0.85, 0.1, 0.1),
        grades(0.8, 0.0, 0.0),
        grades(0.1, 0.9, 0.1),
        grades(0.1, 0.8, 0.2),
    ]);
    let enabled = adapter(&fake, ENABLED);

    let allowed = grade(&enabled, &ordinary(), true, false, false, &cancellation).await;
    let (reply, provenance) = settled(&allowed);
    assert_eq!(reply, guardrail::Reply::Once);
    assert_eq!(provenance.authority, Some(guardrail::Authority::Yolo));
    assert_eq!(provenance.reason, None);
    assert_eq!(provenance.choice, Some(guardrail::DecisionChoice::Allow));
    assert_eq!(provenance.confidence, Some(confidence(0.85)));
    assert_eq!(provenance.grades.as_ref().unwrap().len(), 3);

    let threshold = grade(&enabled, &ordinary(), true, false, false, &cancellation).await;
    assert_eq!(settled(&threshold).0, guardrail::Reply::Once);

    let denied = grade(&enabled, &ordinary(), true, false, false, &cancellation).await;
    let (reply, provenance) = settled(&denied);
    assert_eq!(reply, guardrail::Reply::Reject);
    assert_eq!(provenance.choice, Some(guardrail::DecisionChoice::Deny));

    let hard_denied = grade(&enabled, &hard(), true, false, false, &cancellation).await;
    assert_eq!(settled(&hard_denied).0, guardrail::Reply::Reject);
    let seen = fake.seen.lock().unwrap();
    assert!(seen.iter().all(|seen| {
        seen.purpose == Some(decision::Purpose::Guardrail)
            && seen.authority == Some(guardrail::Authority::Yolo)
            && seen
                .key
                .as_deref()
                .is_some_and(|key| key.starts_with("guardrail:"))
    }));
}

#[tokio::test]
async fn a_hard_review_is_never_model_approved() {
    let fake = Fake::with(vec![grades(0.99, 0.1, 0.1)]);
    let grading = grade(
        &adapter(&fake, ENABLED),
        &hard(),
        true,
        false,
        false,
        &Cancellation::default(),
    )
    .await;
    let (reason, provenance) = escalated(&grading);
    assert_eq!(reason, session_review::Reason::Escalated);
    assert_eq!(provenance.choice, Some(guardrail::DecisionChoice::Allow));
    assert_eq!(
        provenance.reason,
        Some(guardrail::EscalationReason::Escalated)
    );
}

#[tokio::test]
async fn unqualified_tied_or_conflicting_grades_escalate_with_their_provenance() {
    for (reply, reason, choice) in [
        (
            grades(0.5, 0.3, 0.9),
            session_review::Reason::Escalated,
            guardrail::DecisionChoice::Escalate,
        ),
        (
            grades(0.9, 0.1, 0.9),
            session_review::Reason::Escalated,
            guardrail::DecisionChoice::Escalate,
        ),
        (
            grades(0.85, 0.82, 0.1),
            session_review::Reason::ConflictingGrades,
            guardrail::DecisionChoice::Allow,
        ),
        (
            grades(0.7, 0.6, 0.1),
            session_review::Reason::LowConfidence,
            guardrail::DecisionChoice::Allow,
        ),
        (
            grades(0.79, 0.0, 0.0),
            session_review::Reason::LowConfidence,
            guardrail::DecisionChoice::Allow,
        ),
    ] {
        let fake = Fake::with(vec![reply]);
        let grading = grade(
            &adapter(&fake, ENABLED),
            &ordinary(),
            true,
            false,
            false,
            &Cancellation::default(),
        )
        .await;
        let (actual, provenance) = escalated(&grading);
        assert_eq!(actual, reason);
        assert_eq!(provenance.choice, Some(choice), "{reason:?}");
        assert_eq!(provenance.authority, Some(guardrail::Authority::Yolo));
        assert_eq!(provenance.grades.as_ref().unwrap().len(), 3);
    }
}

#[tokio::test]
async fn refusal_invalid_grades_and_deadline_escalate_without_grades() {
    for (reply, reason) in [
        (refusal("guardrail"), session_review::Reason::Refused),
        (
            graded(&[("allow", 0.9, "Scoped"), ("deny", 0.1, "No")]),
            session_review::Reason::InvalidOutput,
        ),
        (
            graded(&[
                ("approve", 0.9, "Scoped"),
                ("deny", 0.1, "No"),
                ("escalate", 0.1, "Clear"),
            ]),
            session_review::Reason::InvalidOutput,
        ),
        (
            graded(&[
                ("allow", 1.0, "Scoped"),
                ("deny", 0.0, "No"),
                ("escalate", 0.0, "Clear"),
                ("approve", 0.0, "Extra"),
            ]),
            session_review::Reason::InvalidOutput,
        ),
        (Reply::Hang, session_review::Reason::Timeout),
    ] {
        let fake = Fake::with(vec![reply]);
        let grading = grade(
            &adapter(&fake, ENABLED),
            &ordinary(),
            true,
            false,
            false,
            &Cancellation::default(),
        )
        .await;
        let (actual, provenance) = escalated(&grading);
        assert_eq!(actual, reason);
        assert_eq!(provenance.choice, None);
        assert_eq!(provenance.confidence, None);
        assert_eq!(provenance.grades, None);
    }
}

#[tokio::test]
async fn yolo_grading_is_the_only_stage_and_does_not_depend_on_decide_reviews() {
    let cancellation = Cancellation::default();
    let fake = Fake::with(vec![grades(0.9, 0.1, 0.1)]);
    let settled_grade = grade(
        &adapter(&fake, ENABLED),
        &ordinary(),
        true,
        false,
        false,
        &cancellation,
    )
    .await;
    let (reply, provenance) = settled(&settled_grade);
    assert_eq!(reply, guardrail::Reply::Once);
    assert_eq!(provenance.authority, Some(guardrail::Authority::Yolo));
    assert_eq!(
        fake.seen
            .lock()
            .unwrap()
            .iter()
            .map(|seen| seen.authority)
            .collect::<Vec<_>>(),
        [Some(guardrail::Authority::Yolo)]
    );

    let unsettled = Fake::with(vec![grades(0.1, 0.1, 0.9)]);
    let escalation = grade(
        &adapter(&unsettled, ENABLED),
        &ordinary(),
        true,
        false,
        false,
        &cancellation,
    )
    .await;
    assert_eq!(
        escalated(&escalation).1.authority,
        Some(guardrail::Authority::Yolo)
    );
    assert_eq!(unsettled.calls(), 1);

    let alone = Fake::with(vec![grades(0.9, 0.1, 0.1)]);
    let disabled = grade(
        &adapter(&alone, DISABLED),
        &ordinary(),
        true,
        false,
        false,
        &cancellation,
    )
    .await;
    assert_eq!(
        settled(&disabled).1.authority,
        Some(guardrail::Authority::Yolo)
    );
    assert_eq!(alone.calls(), 1);

    let manual = Fake::with(vec![]);
    assert_eq!(
        grade(
            &adapter(&manual, ENABLED),
            &ordinary(),
            false,
            false,
            false,
            &cancellation
        )
        .await,
        Grading::Skipped(Skip::Disabled)
    );
    assert_eq!(manual.calls(), 0);
}

#[tokio::test]
async fn verification_never_calls_the_helper_unless_guardrails_are_yolo() {
    let fake = Fake::with(vec![]);
    assert_eq!(
        verify_in_mode(
            &adapter(&fake, ENABLED),
            &ordinary(),
            false,
            false,
            false,
            Some(&evidence()),
            &Cancellation::default()
        )
        .await,
        Verification::Skipped
    );
    assert_eq!(fake.calls(), 0);
}

#[tokio::test]
async fn grading_sends_strict_choices_and_redacted_state_and_bounds_redacted_evidence() {
    let cancellation = Cancellation::default();
    let long = format!("{}{SECRET}", "e".repeat(491));
    assert_eq!(long.encode_utf16().count(), 500);
    let quoted = format!("Runs {COMMAND}");
    let fake = Fake::with(vec![graded(&[
        ("allow", 0.85, &long),
        ("deny", 0.1, &quoted),
        ("escalate", 0.1, "Clear"),
    ])]);
    let grading = grade(
        &adapter(&fake, ENABLED),
        &ordinary(),
        true,
        false,
        false,
        &cancellation,
    )
    .await;
    let request = fake.request();
    let JsonValue::Array(questions) = field(&request, &["questions"]) else {
        panic!("questions must be an array")
    };
    assert_eq!(field(&questions[0], &["grade"]), &JsonValue::Bool(true));
    assert_eq!(
        field(&questions[0], &["instructions"]),
        &JsonValue::String(GRADE_INSTRUCTIONS.into())
    );
    let JsonValue::Array(offered) = choices(&request) else {
        panic!("choices must be an array")
    };
    assert_eq!(
        offered
            .iter()
            .map(|choice| field(choice, &["value"]).clone())
            .collect::<Vec<_>>(),
        ["allow", "deny", "escalate"]
            .map(|value| JsonValue::String(value.into()))
            .to_vec()
    );
    assert_eq!(
        field(&request, &["state", "hardReview"]),
        &JsonValue::Bool(false)
    );
    assert!(!stringify_json(&request).contains(SECRET));
    judgment::Request::decode(&request).expect("the decision service accepts the request");
    fake.redactor_never_saw(&[GRADE_INSTRUCTIONS]);
    let grades = settled(&grading).1.grades.clone().unwrap();
    for grade in grades {
        let evidence = grade.evidence.to_utf8().unwrap();
        assert!(!evidence.contains(SECRET));
        assert!(!evidence.contains(COMMAND));
        assert!(grade.evidence.code_units().count() <= 500);
    }
}

#[tokio::test]
async fn decision_failure_causes_reach_reviews_and_provenance_without_invented_judgments() {
    for (error, reason) in [
        (decision::Error::Unavailable, "unavailable"),
        (decision::Error::InvalidRequest, "invalid-request"),
        (decision::Error::ProviderFailed, "provider-failed"),
        (decision::Error::Timeout, "timeout"),
        (decision::Error::InputTooLarge, "input-too-large"),
        (decision::Error::InvalidOutput, "invalid-output"),
        (decision::Error::Refused, "refused"),
        (decision::Error::TruncatedOutput, "truncated-output"),
        (decision::Error::UnsupportedOutput, "unsupported-output"),
    ] {
        let fake = Fake::with(vec![Reply::Failure(error)]);
        let grading = grade(
            &adapter(&fake, ENABLED),
            &ordinary(),
            true,
            false,
            false,
            &Cancellation::default(),
        )
        .await;
        let (actual, provenance) = escalated(&grading);
        assert_eq!(
            actual.encode(),
            JsonValue::String(reason.into()),
            "{reason}"
        );
        assert_eq!(
            provenance.encode(),
            parse_json(&format!(r#"{{"authority":"yolo","reason":"{reason}"}}"#)).unwrap(),
            "{reason}"
        );
        assert_eq!(fake.calls(), 1);
    }
}

#[test]
fn the_released_decision_service_is_an_evaluator() {
    fn evaluator<T: Evaluator>() {}
    evaluator::<decision::Service>();
}
