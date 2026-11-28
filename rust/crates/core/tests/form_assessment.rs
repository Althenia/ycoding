#[path = "guardrail_service_decisions_support/autonomy.rs"]
mod autonomy_support;
#[path = "guardrail_service_decisions_support/mod.rs"]
mod support;

pub use support::Fixture;

#[path = "decision_support/mod.rs"]
mod modes;

use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use support::{Harness, response};
use tokio::sync::Notify;
use ycoding_core::{
    coordination::{
        decisions::{Gate, Reconsider, Source},
        runtime::DecisionOutcome,
    },
    process::guardrails::decision::{EvaluateFuture, Evaluator},
    resources::decision::{self, Invocation},
    session::autonomy::DecisionMode,
    tools::policy::{
        Wait,
        forms::{Automatic, Error as FormsError, Forms},
        questions::{Admission as QuestionAdmission, Questions},
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, form, parse_json, permission, question,
    session_id::SessionId, stringify_json,
};
use ycoding_store::{
    KeyPart,
    session::{Document, SessionTable},
    tuple_key,
};

const BOUND: Duration = Duration::from_secs(5);
const OPTIONS: &str = r#"[{"value":"SQLite","label":"SQLite","description":"Local"},{"value":"Postgres","label":"Postgres"},{"value":"Backups","label":"Backups"}]"#;

type Reply = Box<dyn Fn(&JsonValue) -> Result<JsonValue, decision::Error> + Send + Sync>;

struct Seen {
    input: JsonValue,
    key: Option<String>,
}

struct Scripted {
    script: Mutex<VecDeque<Reply>>,
    seen: Mutex<Vec<Seen>>,
    hold: AtomicBool,
    entered: Notify,
    release: Notify,
    exited: Notify,
}

impl Scripted {
    fn new(script: Vec<Reply>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into()),
            seen: Mutex::default(),
            hold: AtomicBool::new(false),
            entered: Notify::new(),
            release: Notify::new(),
            exited: Notify::new(),
        })
    }
    fn held(script: Vec<Reply>) -> Arc<Self> {
        let evaluator = Self::new(script);
        evaluator.hold.store(true, Ordering::SeqCst);
        evaluator
    }
    fn calls(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
    fn keys(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|seen| seen.key.clone().expect("every form call carries a key"))
            .collect()
    }
}

struct Exited<'a>(&'a Notify);

impl Drop for Exited<'_> {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

impl Evaluator for Scripted {
    fn evaluate<'a>(&'a self, input: JsonValue, invocation: Invocation<'a>) -> EvaluateFuture<'a> {
        self.seen.lock().unwrap().push(Seen {
            input: input.clone(),
            key: invocation.invocation_key.map(str::to_owned),
        });
        let reply = self
            .script
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected helper call");
        let hold = self.hold.load(Ordering::SeqCst);
        Box::pin(async move {
            let _exit = Exited(&self.exited);
            if hold {
                self.entered.notify_one();
                tokio::select! {
                    _ = self.release.notified() => {}
                    _ = invocation.cancellation.cancelled() => {
                        return Err(decision::Error::Cancelled);
                    }
                }
            }
            reply(&input)
        })
    }
}

fn first_question(input: &JsonValue) -> (String, Vec<JsonValue>) {
    let JsonValue::Object(input) = input else {
        panic!("helper input is an object")
    };
    let Some(JsonValue::Object(request)) = input.get(&"request".into()) else {
        panic!("helper input carries a request")
    };
    let Some(JsonValue::Array(questions)) = request.get(&"questions".into()) else {
        panic!("request carries questions")
    };
    let JsonValue::Object(question) = &questions[0] else {
        panic!("question is an object")
    };
    let Some(JsonValue::String(name)) = question.get(&"name".into()) else {
        panic!("question is named")
    };
    let Some(JsonValue::Array(choices)) = question.get(&"choices".into()) else {
        return (name.to_utf8().unwrap(), vec![]);
    };
    let values = choices
        .iter()
        .map(|choice| match choice {
            JsonValue::Object(choice) => choice.get(&"value".into()).unwrap().clone(),
            _ => panic!("choice is an object"),
        })
        .collect();
    (name.to_utf8().unwrap(), values)
}

fn grade_reply(
    scores: &'static [f64],
    evidence: &'static str,
    tweak: fn(&mut Vec<String>),
) -> Reply {
    Box::new(move |input| {
        let (name, choices) = first_question(input);
        let mut grades = choices
            .iter()
            .zip(scores)
            .map(|(choice, score)| {
                format!(
                    r#"{{"choice":{},"confidence":{score},"evidence":"{evidence}"}}"#,
                    stringify_json(choice)
                )
            })
            .collect::<Vec<_>>();
        tweak(&mut grades);
        response(&format!(
            r#"{{"name":"{name}","type":"choice","answer":null,"choice":null,"score":null,"confidence":0,"grades":[{}]}}"#,
            grades.join(",")
        ))
    })
}

fn graded(scores: &'static [f64]) -> Reply {
    grade_reply(scores, "Grounded in the stated workload.", |_| {})
}

fn set_reply(text: &'static str, confidence: f64) -> Reply {
    Box::new(move |_| {
        response(&format!(
            r#"{{"name":"compatible_set","type":"text","answer":null,"choice":null,"score":null,"confidence":{confidence},"text":{}}}"#,
            stringify_json(&JsonValue::String(text.into()))
        ))
    })
}

fn failing(error: decision::Error) -> Reply {
    Box::new(move |_| Err(error))
}

fn refusing() -> Reply {
    Box::new(|input| {
        let (name, _) = first_question(input);
        response(&format!(
            r#"{{"name":"{name}","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}}"#
        ))
    })
}

fn single(key: &str) -> String {
    format!(r#"{{"key":"{key}","type":"string","options":{OPTIONS},"custom":false}}"#)
}

fn multiple(key: &str) -> String {
    format!(r#"{{"key":"{key}","type":"multiselect","options":{OPTIONS}}}"#)
}

fn question_form(session: &SessionId, id: &str, fields: &[String], metadata: &str) -> form::Info {
    form::Info::decode(
        &parse_json(&format!(
            r#"{{"id":"{id}","sessionID":{},"title":"Choose storage","metadata":{{"kind":"question"{metadata}}},"fields":[{}]}}"#,
            stringify_json(&session.encode()),
            fields.join(",")
        ))
        .unwrap(),
    )
    .unwrap()
}

fn native_question(session: &SessionId, id: &str) -> question::Request {
    question::Request::decode(&parse_json(&format!(
        r#"{{"id":"{id}","sessionID":{},"questions":[{{"header":"Database","question":"Which database?","multiple":true,"custom":false,"options":[{{"label":"SQLite","description":"Local"}},{{"label":"Postgres","description":"Remote"}},{{"label":"Backups","description":"Retained copies"}}]}}]}}"#,
        stringify_json(&session.encode()),
    )).unwrap()).unwrap()
}

fn answer(text: &str) -> form::Answer {
    form::Answer::decode(&parse_json(text).unwrap()).unwrap()
}

fn service(harness: &Harness, evaluator: &Arc<Scripted>) -> Forms {
    Forms::new(harness.fixture.authority(), harness.publish.clone())
        .with_reviews(harness.review_policy())
        .with_decision(evaluator.clone())
}

async fn session(mode: DecisionMode) -> (Harness, SessionId) {
    let harness = Harness::new();
    let root = harness.fixture.session("ses_root", None, 0, false, None);
    modes::answers(&harness.autonomy(), &root, mode).await;
    (harness, root)
}

fn kinds(harness: &Harness) -> Vec<&'static str> {
    harness
        .fixture
        .events
        .lock()
        .unwrap()
        .iter()
        .map(|event| event.type_)
        .filter(|kind| kind.starts_with("form."))
        .collect()
}

fn data(harness: &Harness, kind: &str) -> Vec<JsonValue> {
    harness
        .fixture
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.type_ == kind)
        .map(|event| event.data.clone())
        .collect()
}

async fn until(harness: &Harness, kind: &str, count: usize) {
    tokio::time::timeout(BOUND, async {
        while data(harness, kind).len() < count {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{kind} was not published {count} time(s)"));
}

async fn settle(wait: Wait<form::State>) -> form::State {
    tokio::time::timeout(BOUND, wait)
        .await
        .expect("form did not settle")
        .expect("form sender dropped")
}

async fn quiesce(evaluator: &Scripted) {
    tokio::time::timeout(BOUND, evaluator.exited.notified())
        .await
        .expect("helper call did not finish");
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

fn assessed(harness: &Harness) -> Vec<form::Assessment> {
    data(harness, "form.assessed")
        .iter()
        .map(|data| {
            let event = form::AssessedData::decode(data).expect("form.assessed decodes");
            assert_eq!(
                form::Assessment::decode(&event.assessment.encode()).unwrap(),
                event.assessment
            );
            event.assessment
        })
        .collect()
}

fn created(harness: &Harness) -> form::Info {
    form::CreatedData::decode(&data(harness, "form.created")[0])
        .unwrap()
        .form
}

fn assessment_of(forms: &Forms, id: &form::Id) -> form::Assessment {
    forms.get(id).unwrap().assessment.expect("assessment")
}

fn text(value: &LosslessString) -> String {
    value.to_utf8().unwrap()
}

fn scores(grades: &Option<Vec<form::OptionGrade>>) -> Vec<f64> {
    grades
        .as_ref()
        .expect("grades")
        .iter()
        .map(|grade| grade.confidence.get())
        .collect()
}

fn recommendation(field: &form::FieldAssessment) -> Vec<String> {
    field
        .recommendation
        .as_ref()
        .expect("recommendation")
        .iter()
        .map(text)
        .collect()
}

#[tokio::test]
async fn manual_and_auto_assess_nothing_and_never_call_the_helper() {
    for (mode, expected) in [
        (
            modes::yolo(false),
            "Manual answers require your decision; no model assessment.",
        ),
        (
            modes::auto(true),
            "Auto uses only explicit defaults or a unique Recommended option; no model assessment.",
        ),
    ] {
        let (harness, root) = session(mode).await;
        let evaluator = Scripted::new(vec![]);
        let forms = service(&harness, &evaluator);
        let info = question_form(&root, "frm_mode", &[single("q0")], "");
        let wait = forms.ask(info.clone()).unwrap();
        let shown = created(&harness).assessment.expect("assessment");
        assert_eq!(text(&shown.source_session_id), text(root.as_lossless()));
        assert_eq!(shown.fields.len(), 1);
        assert_eq!(
            shown.fields[0].status,
            form::FieldAssessmentStatus::NotAssessed
        );
        assert_eq!(text(&shown.fields[0].reason), expected);
        assert!(shown.fields[0].grades.is_none() && shown.fields[0].recommendation.is_none());
        assert_eq!(forms.state(&info.id).unwrap(), form::State::Pending);
        forms
            .reply(&info.id, answer(r#"{"q0":"Postgres"}"#))
            .unwrap();
        assert!(matches!(settle(wait).await, form::State::Answered(_)));
        assert!(!forms.answered_automatically(&info.id).unwrap());
        assert_eq!(assessment_of(&forms, &info.id), shown);
        assert_eq!(kinds(&harness), ["form.created", "form.replied"]);
        assert_eq!(evaluator.calls(), 0);
    }
}

#[tokio::test]
async fn auto_answers_a_unique_recommended_option_without_assessing_or_calling_the_helper() {
    let (harness, root) = session(modes::auto(true)).await;
    let evaluator = Scripted::new(vec![]);
    let forms = service(&harness, &evaluator);
    let field = r#"{"key":"q0","type":"string","options":[{"value":"SQLite","label":"SQLite (Recommended)"},{"value":"Postgres","label":"Postgres"}],"custom":false}"#.to_owned();
    let info = question_form(&root, "frm_recommended", &[field], "");
    let wait = forms.ask(info.clone()).unwrap();
    let state = settle(wait).await;
    assert_eq!(state, form::State::Answered(answer(r#"{"q0":"SQLite"}"#)));
    assert!(forms.answered_automatically(&info.id).unwrap());
    let field = &assessment_of(&forms, &info.id).fields[0];
    assert_eq!(field.status, form::FieldAssessmentStatus::NotAssessed);
    assert_eq!(kinds(&harness), ["form.created", "form.replied"]);
    assert_eq!(evaluator.calls(), 0);
}

#[tokio::test]
async fn auto_answers_a_request_marked_require_explicit_decision() {
    let (harness, root) = session(modes::auto(true)).await;
    let evaluator = Scripted::new(vec![]);
    let forms = service(&harness, &evaluator);
    let field = r#"{"key":"q0","type":"string","options":[{"value":"SQLite","label":"SQLite (Recommended)"},{"value":"Postgres","label":"Postgres"}],"custom":false}"#.to_owned();
    let info = question_form(
        &root,
        "frm_explicit",
        &[field],
        r#","requireExplicitDecision":true"#,
    );
    let wait = forms.ask(info.clone()).unwrap();
    let state = settle(wait).await;
    assert_eq!(state, form::State::Answered(answer(r#"{"q0":"SQLite"}"#)));
    assert!(forms.answered_automatically(&info.id).unwrap());
    assert_eq!(kinds(&harness), ["form.created", "form.replied"]);
    assert_eq!(evaluator.calls(), 0);
}

#[tokio::test]
async fn yolo_publishes_pending_then_exact_per_option_grades_and_answers_the_unique_best_option() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::new(vec![graded(&[0.96, 0.93, 0.92])]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_yolo", &[single("q0")], "");
    let wait = forms.ask(info.clone()).unwrap();
    let state = settle(wait).await;
    assert_eq!(state, form::State::Answered(answer(r#"{"q0":"SQLite"}"#)));
    assert!(forms.answered_automatically(&info.id).unwrap());
    assert_eq!(
        kinds(&harness),
        ["form.created", "form.assessed", "form.replied"]
    );
    let initial = created(&harness).assessment.unwrap();
    assert_eq!(initial.mode, form::AssessmentMode::Yolo);
    assert_eq!(
        initial.fields[0].status,
        form::FieldAssessmentStatus::Pending
    );
    let events = assessed(&harness);
    assert_eq!(events.len(), 1);
    let field = &events[0].fields[0];
    assert_eq!(events[0].mode, form::AssessmentMode::Yolo);
    assert_eq!(text(&events[0].source_session_id), text(root.as_lossless()));
    assert_eq!(field.status, form::FieldAssessmentStatus::Assessed);
    assert_eq!(recommendation(field), ["SQLite"]);
    assert_eq!(field.confidence.unwrap().get(), 0.96);
    let grades = field.grades.as_ref().unwrap();
    assert_eq!(
        grades
            .iter()
            .map(|grade| text(&grade.choice))
            .collect::<Vec<_>>(),
        ["SQLite", "Postgres", "Backups"]
    );
    assert_eq!(scores(&field.grades), [0.96, 0.93, 0.92]);
    assert!(
        grades
            .iter()
            .all(|grade| text(&grade.evidence) == "Grounded in the stated workload.")
    );
    assert_eq!(assessment_of(&forms, &info.id), events[0]);
    let seen = evaluator.seen.lock().unwrap();
    let (name, _) = first_question(&seen[0].input);
    assert_eq!(name, "f0");
    let sent = stringify_json(&seen[0].input);
    assert!(sent.contains(r#""grade":true"#));
    assert!(!sent.contains("Answers evaluator is assessing"));
}

#[tokio::test]
async fn a_grade_at_the_exact_threshold_qualifies() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::new(vec![graded(&[0.8, 0.79, 0.1])]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_threshold", &[single("q0")], "");
    let state = settle(forms.ask(info.clone()).unwrap()).await;
    assert_eq!(state, form::State::Answered(answer(r#"{"q0":"SQLite"}"#)));
}

#[tokio::test]
async fn grade_evidence_and_helper_requests_are_redacted_and_choices_restore_exactly() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::new(vec![grade_reply(
        &[0.96, 0.7],
        "Bearer evidence-secret-value supports it.",
        |_| {},
    )]);
    let forms = service(&harness, &evaluator);
    let field = r#"{"key":"q0","type":"string","options":[{"value":"TOKEN=form-choice-secret","label":"Secret"},{"value":"safe","label":"Safe"}],"custom":false}"#;
    let info = question_form(&root, "frm_redacted", &[field.into()], "");
    let state = settle(forms.ask(info.clone()).unwrap()).await;
    assert_eq!(
        state,
        form::State::Answered(answer(r#"{"q0":"TOKEN=form-choice-secret"}"#))
    );
    let sent = stringify_json(&evaluator.seen.lock().unwrap()[0].input);
    assert!(!sent.contains("form-choice-secret"));
    let events = assessed(&harness);
    let grades = events[0].fields[0].grades.as_ref().unwrap();
    assert_eq!(text(&grades[0].choice), "TOKEN=form-choice-secret");
    for grade in grades {
        let evidence = text(&grade.evidence);
        assert!(!evidence.contains("evidence-secret-value"), "{evidence}");
        assert!(!evidence.trim().is_empty() && evidence.encode_utf16().count() <= 500);
    }
}

#[tokio::test]
async fn inconclusive_and_failed_assessments_use_a_valid_fallback_and_keep_the_assessment_reason() {
    type Case = (
        &'static str,
        Reply,
        form::FieldAssessmentStatus,
        &'static str,
    );
    let cases: Vec<Case> = vec![
        (
            "low",
            graded(&[0.79, 0.5, 0.1]),
            form::FieldAssessmentStatus::Assessed,
            "0.8 confidence threshold",
        ),
        (
            "tie",
            graded(&[0.95, 0.95, 0.95]),
            form::FieldAssessmentStatus::Assessed,
            "Several options share the highest confidence",
        ),
        (
            "missing",
            grade_reply(&[0.96, 0.5, 0.1], "e", |grades| {
                grades.remove(0);
            }),
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "duplicate",
            grade_reply(&[0.96, 0.5, 0.1], "e", |grades| {
                let first = grades[0].clone();
                grades[1] = first;
            }),
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "unlisted",
            grade_reply(&[0.96, 0.5, 0.1], "e", |grades| {
                grades.push(r#"{"choice":"Fabricated","confidence":0.99,"evidence":"e"}"#.into());
            }),
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "blank-evidence",
            grade_reply(&[0.96, 0.5, 0.1], "   ", |_| {}),
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "oversized-evidence",
            grade_reply(&[0.96, 0.5, 0.1], "e", |grades| {
                grades[0] = format!(
                    r#"{{"choice":"SQLite","confidence":0.96,"evidence":"{}"}}"#,
                    "e".repeat(501)
                );
            }),
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "out-of-range",
            grade_reply(&[1.5, 0.5, 0.1], "e", |_| {}),
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "refused",
            refusing(),
            form::FieldAssessmentStatus::Unavailable,
            "refused",
        ),
        (
            "provider",
            failing(decision::Error::ProviderFailed),
            form::FieldAssessmentStatus::Unavailable,
            "provider request failed",
        ),
        (
            "timeout",
            failing(decision::Error::Timeout),
            form::FieldAssessmentStatus::Unavailable,
            "timed out",
        ),
    ];
    for (name, reply, status, reason) in cases {
        let (harness, root) = session(modes::yolo(true)).await;
        let evaluator = Scripted::new(vec![reply]);
        let forms = service(&harness, &evaluator);
        let info = question_form(&root, "frm_fault", &[single("q0")], "");
        let wait = forms.ask(info.clone()).unwrap();
        until(&harness, "form.assessed", 1).await;
        let events = assessed(&harness);
        let field = &events[0].fields[0];
        assert_eq!(field.status, status, "{name}");
        assert!(
            text(&field.reason).contains(reason),
            "{name}: {}",
            text(&field.reason)
        );
        assert!(
            field.recommendation.is_none() && field.confidence.is_none(),
            "{name}"
        );
        assert_eq!(
            settle(wait).await,
            form::State::Answered(answer(r#"{"q0":"SQLite"}"#)),
            "{name}"
        );
        assert_eq!(assessment_of(&forms, &info.id), events[0], "{name}");
        assert_eq!(
            forms.reply(&info.id, answer(r#"{"q0":"Postgres"}"#)),
            Err(FormsError::AlreadySettled)
        );
        assert!(forms.answered_automatically(&info.id).unwrap(), "{name}");
        assert_eq!(
            kinds(&harness),
            ["form.created", "form.assessed", "form.replied"],
            "{name}"
        );
    }
}

#[tokio::test]
async fn a_multiselect_recommends_one_compatible_set_not_every_high_option() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::new(vec![
        graded(&[0.96, 0.7, 0.95]),
        set_reply(
            r#"{"recommendation":["SQLite","Backups"],"compatible":true,"reason":"One engine plus its backup."}"#,
            0.9,
        ),
    ]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_set", &[multiple("q0")], "");
    let state = settle(forms.ask(info.clone()).unwrap()).await;
    assert_eq!(
        state,
        form::State::Answered(answer(r#"{"q0":["SQLite","Backups"]}"#))
    );
    let events = assessed(&harness);
    let field = &events[0].fields[0];
    assert_eq!(recommendation(field), ["SQLite", "Backups"]);
    assert_eq!(field.confidence.unwrap().get(), 0.9);
    assert_eq!(text(&field.reason), "One engine plus its backup.");
    assert_eq!(scores(&field.grades), [0.96, 0.7, 0.95]);
    let keys = evaluator.keys();
    assert_eq!(keys[1], format!("{}:compatible-set", keys[0]));
    let seen = evaluator.seen.lock().unwrap();
    let (name, _) = first_question(&seen[1].input);
    assert_eq!(name, "compatible_set");
    assert!(stringify_json(&seen[1].input).contains("Grounded in the stated workload."));
}

#[tokio::test]
async fn an_invalid_or_incompatible_set_uses_one_valid_fallback_option() {
    type Case = (
        &'static str,
        &'static str,
        f64,
        form::FieldAssessmentStatus,
        &'static str,
    );
    let cases: [Case; 8] = [
        (
            "incompatible",
            r#"{"recommendation":["SQLite","Postgres"],"compatible":false,"reason":"Alternatives."}"#,
            0.95,
            form::FieldAssessmentStatus::Assessed,
            "could not establish a compatible set",
        ),
        (
            "fabricated",
            r#"{"recommendation":["Fabricated"],"compatible":true,"reason":"Invented."}"#,
            0.95,
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "duplicate",
            r#"{"recommendation":["SQLite","SQLite"],"compatible":true,"reason":"Twice."}"#,
            0.95,
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "unqualified",
            r#"{"recommendation":["Backups"],"compatible":true,"reason":"Below threshold."}"#,
            0.95,
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "extra-property",
            r#"{"recommendation":["SQLite"],"compatible":true,"reason":"Extra.","other":1}"#,
            0.95,
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "blank-reason",
            r#"{"recommendation":["SQLite"],"compatible":true,"reason":"  "}"#,
            0.95,
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "not-json",
            "SQLite and Backups",
            0.95,
            form::FieldAssessmentStatus::Unavailable,
            "failed validation",
        ),
        (
            "low-selection-confidence",
            r#"{"recommendation":["SQLite"],"compatible":true,"reason":"Unsure."}"#,
            0.79,
            form::FieldAssessmentStatus::Unavailable,
            "0.8 confidence threshold",
        ),
    ];
    for (name, set, confidence, status, reason) in cases {
        let (harness, root) = session(modes::yolo(true)).await;
        let evaluator = Scripted::new(vec![graded(&[0.96, 0.9, 0.5]), set_reply(set, confidence)]);
        let forms = service(&harness, &evaluator);
        let info = question_form(&root, "frm_set_fault", &[multiple("q0")], "");
        let wait = forms.ask(info.clone()).unwrap();
        until(&harness, "form.assessed", 1).await;
        let field = &assessed(&harness)[0].fields[0];
        assert_eq!(field.status, status, "{name}");
        assert!(
            text(&field.reason).contains(reason),
            "{name}: {}",
            text(&field.reason)
        );
        assert!(field.recommendation.is_none(), "{name}");
        assert_eq!(scores(&field.grades), [0.96, 0.9, 0.5], "{name}");
        assert_eq!(
            settle(wait).await,
            form::State::Answered(answer(r#"{"q0":["SQLite"]}"#)),
            "{name}"
        );
        assert!(forms.answered_automatically(&info.id).unwrap(), "{name}");
    }
}

#[tokio::test]
async fn every_active_field_is_graded_and_inactive_conditional_fields_are_not() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::new(vec![
        graded(&[0.79, 0.5, 0.1]),
        graded(&[0.96, 0.7, 0.6]),
        graded(&[0.5, 0.96, 0.1]),
    ]);
    let forms = service(&harness, &evaluator);
    let conditional = format!(
        r#"{{"key":"q2","type":"string","options":{OPTIONS},"custom":false,"when":[{{"key":"q0","op":"eq","value":"SQLite"}}]}}"#
    );
    let inactive = format!(
        r#"{{"key":"q3","type":"string","options":{OPTIONS},"custom":false,"when":[{{"key":"q0","op":"eq","value":"Postgres"}}]}}"#
    );
    let info = question_form(
        &root,
        "frm_conditional",
        &[single("q0"), single("q1"), conditional, inactive],
        "",
    );
    let wait = forms.ask(info.clone()).unwrap();
    until(&harness, "form.assessed", 1).await;
    let fields = assessed(&harness)[0].fields.clone();
    assert_eq!(
        fields
            .iter()
            .map(|field| text(&field.key))
            .collect::<Vec<_>>(),
        ["q0", "q1", "q2", "q3"]
    );
    assert_eq!(fields[0].status, form::FieldAssessmentStatus::Assessed);
    assert!(fields[0].recommendation.is_none());
    assert_eq!(recommendation(&fields[1]), ["SQLite"]);
    assert_eq!(fields[2].status, form::FieldAssessmentStatus::Assessed);
    assert_eq!(recommendation(&fields[2]), ["Postgres"]);
    assert_eq!(fields[3].status, form::FieldAssessmentStatus::NotAssessed);
    assert_eq!(text(&fields[3].reason), "Conditional field is inactive.");
    let names = evaluator
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|seen| first_question(&seen.input).0)
        .collect::<Vec<_>>();
    assert_eq!(names, ["f0", "f1", "f2"]);
    assert_eq!(
        settle(wait).await,
        form::State::Answered(answer(r#"{"q0":"SQLite","q1":"SQLite","q2":"Postgres"}"#))
    );
    assert_eq!(
        forms.settlement(&info.id).unwrap().automatic,
        Some(Automatic {
            via: "yolo",
            confidence: None
        })
    );
    assert_eq!(assessment_of(&forms, &info.id).fields, fields);
}

#[tokio::test]
async fn answer_reconciliation_requires_a_valid_authority_snapshot_before_dispatch() {
    for kind in ["question", "form"] {
        let (harness, root) = session(DecisionMode::Manual).await;
        let evaluator = Scripted::new(vec![]);
        let remove = Arc::new(AtomicBool::new(false));
        let mut authority = harness.fixture.authority();
        let agents = authority.agents.clone();
        let client = harness.fixture.store.client();
        let removed = root.as_lossless().clone();
        let remove_on_lookup = remove.clone();
        authority.agents = Arc::new(move |selected| {
            let resolved = agents(selected);
            if remove_on_lookup.swap(false, Ordering::SeqCst) {
                let removed = removed.clone();
                client
                    .submit(move |tx| {
                        tx.delete::<SessionTable>(&tuple_key(&[KeyPart::String(&removed)]))?;
                        Ok(())
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
            }
            resolved
        });
        let questions = Questions::new(authority.clone(), harness.fixture.publisher())
            .with_decision(evaluator.clone());
        let forms =
            Forms::new(authority, harness.fixture.publisher()).with_decision(evaluator.clone());
        if kind == "question" {
            let request = native_question(&root, "que_missing_authority");
            let QuestionAdmission::Pending(wait) = questions.ask(request.clone()).unwrap() else {
                panic!("manual question must wait")
            };
            modes::answers(&harness.autonomy(), &root, DecisionMode::Yolo).await;
            remove.store(true, Ordering::SeqCst);
            assert!(questions.reconcile_autonomy(&root).await.is_err());
            assert_eq!(questions.list().len(), 1);
            assert!(data(&harness, "question.replied").is_empty());
            questions.cancel(&request.id);
            assert!(
                tokio::time::timeout(BOUND, wait)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
        } else {
            let info = question_form(&root, "frm_missing_authority", &[single("q0")], "");
            let wait = forms.ask(info.clone()).unwrap();
            modes::answers(&harness.autonomy(), &root, DecisionMode::Yolo).await;
            remove.store(true, Ordering::SeqCst);
            assert!(forms.reconcile_autonomy(&root).await.is_err());
            assert_eq!(forms.state(&info.id).unwrap(), form::State::Pending);
            assert!(data(&harness, "form.replied").is_empty());
            assert!(!forms.answered_automatically(&info.id).unwrap());
            forms.cancel(&info.id).unwrap();
            assert_eq!(settle(wait).await, form::State::Cancelled);
        }
        assert_eq!(evaluator.calls(), 0);
    }
}

#[tokio::test]
async fn question_reconciliation_preserves_authority_revision_and_native_settlement_winners() {
    for change in ["mode", "revision", "lookup", "human", "cancel"] {
        let (harness, root) = session(DecisionMode::Manual).await;
        let evaluator = Scripted::held(vec![if change == "revision" {
            graded(&[0.1, 0.96, 0.1])
        } else {
            graded(&[0.96, 0.5, 0.1])
        }]);
        let questions = Questions::new(harness.fixture.authority(), harness.fixture.publisher())
            .with_decision(evaluator.clone());
        let request = native_question(&root, "que_reconciliation_race");
        let QuestionAdmission::Pending(wait) = questions.ask(request.clone()).unwrap() else {
            panic!("manual question must wait")
        };
        modes::answers(&harness.autonomy(), &root, DecisionMode::Yolo).await;
        let service = questions.clone();
        let owner = root.clone();
        let task = tokio::spawn(async move { service.reconcile_autonomy(&owner).await });
        tokio::time::timeout(BOUND, evaluator.entered.notified())
            .await
            .unwrap();
        match change {
            "mode" | "revision" => {
                modes::answers(&harness.autonomy(), &root, DecisionMode::Manual).await;
                if change == "revision" {
                    modes::answers(&harness.autonomy(), &root, DecisionMode::Yolo).await;
                }
            }
            "lookup" => {
                let removed = root.as_lossless().clone();
                harness
                    .fixture
                    .store
                    .submit(move |tx| {
                        tx.delete::<SessionTable>(&tuple_key(&[KeyPart::String(&removed)]))?;
                        Ok(())
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
            }
            "human" => questions
                .reply(&request.id, vec![vec!["Postgres".into()]])
                .unwrap(),
            "cancel" => questions.cancel(&request.id),
            _ => unreachable!(),
        }
        evaluator.release.notify_one();
        let result = tokio::time::timeout(BOUND, task).await.unwrap().unwrap();
        assert_eq!(result.is_err(), change == "lookup", "{change}");
        assert_eq!(evaluator.calls(), 1);
        if change == "revision" {
            assert_eq!(data(&harness, "question.replied").len(), 1);
            assert!(questions.list().is_empty());
            assert_eq!(
                tokio::time::timeout(BOUND, wait)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap(),
                vec![vec![LosslessString::from("SQLite")]]
            );
        } else if change == "human" {
            assert_eq!(data(&harness, "question.replied").len(), 1);
            assert_eq!(
                tokio::time::timeout(BOUND, wait)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap(),
                vec![vec![LosslessString::from("Postgres")]]
            );
        } else {
            assert!(data(&harness, "question.replied").is_empty(), "{change}");
            assert_eq!(
                questions.list().len(),
                if change == "cancel" { 0 } else { 1 }
            );
            questions.cancel(&request.id);
            assert!(
                tokio::time::timeout(BOUND, wait)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
        }
    }
}

#[tokio::test]
async fn held_yolo_form_and_question_answers_use_fresh_fallbacks_after_defer_changes() {
    for (native_question_service, deferred) in [(false, false), (false, true), (true, false)] {
        let (harness, root) = session(DecisionMode::Yolo).await;
        if deferred {
            harness.autonomy().set_defer(&root, true).await.unwrap();
        }
        let evaluator = Scripted::held(vec![graded(&[0.1, 0.96, 0.1])]);
        if native_question_service {
            let questions =
                Questions::new(harness.fixture.authority(), harness.fixture.publisher())
                    .with_decision(evaluator.clone());
            let request = native_question(&root, "que_defer_fallback");
            let QuestionAdmission::Pending(wait) = questions.ask(request).unwrap() else {
                panic!("evaluation must be held")
            };
            tokio::time::timeout(BOUND, evaluator.entered.notified())
                .await
                .unwrap();
            harness.autonomy().set_defer(&root, true).await.unwrap();
            evaluator.release.notify_one();
            assert_eq!(
                tokio::time::timeout(BOUND, wait)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap(),
                vec![vec![LosslessString::from("SQLite")]]
            );
            assert!(questions.list().is_empty());
            assert!(data(&harness, "question.asked").is_empty());
            assert_eq!(data(&harness, "question.replied").len(), 1);
        } else {
            let forms = Forms::new(harness.fixture.authority(), harness.fixture.publisher())
                .with_decision(evaluator.clone());
            let info = question_form(&root, "frm_defer_fallback", &[single("q0")], "");
            let wait = forms.ask(info.clone()).unwrap();
            tokio::time::timeout(BOUND, evaluator.entered.notified())
                .await
                .unwrap();
            harness
                .autonomy()
                .set_defer(&root, !deferred)
                .await
                .unwrap();
            evaluator.release.notify_one();
            assert!(
                matches!(tokio::time::timeout(BOUND, wait).await.unwrap().unwrap(), form::State::Answered(answer) if answer.encode() == parse_json(r#"{"q0":"SQLite"}"#).unwrap())
            );
            let settled = forms.settlement(&info.id).unwrap();
            assert_eq!(
                settled.automatic,
                Some(Automatic {
                    via: "yolo",
                    confidence: None
                })
            );
            assert!(settled.source.is_none());
            let assessment = settled.assessment.unwrap();
            assert_eq!(assessment.mode, form::AssessmentMode::Yolo);
            assert!(!assessment.fields.is_empty());
            assert!(assessment.fields.iter().all(|field| field.status
                == form::FieldAssessmentStatus::NotAssessed
                && text(&field.reason).contains("revoked")
                && field.confidence.is_none()
                && field.grades.is_none()
                && field.recommendation.is_none()));
            assert!(forms.list(None).is_empty());
            assert_eq!(data(&harness, "form.replied").len(), 1);
        }
        assert_eq!(evaluator.calls(), 1);
    }
}

#[tokio::test]
async fn form_reconciliation_preserves_yolo_assessment_and_automatic_provenance() {
    for revoked in [false, true] {
        let (harness, root) = session(DecisionMode::Manual).await;
        let evaluator = Scripted::held(vec![graded(&[0.96, 0.5, 0.1])]);
        let forms = service(&harness, &evaluator);
        let info = question_form(&root, "frm_reconciliation", &[single("q0")], "");
        let wait = forms.ask(info.clone()).unwrap();
        modes::answers(&harness.autonomy(), &root, DecisionMode::Yolo).await;
        let service = forms.clone();
        let owner = root.clone();
        let task = tokio::spawn(async move { service.reconcile_autonomy(&owner).await });
        tokio::time::timeout(BOUND, evaluator.entered.notified())
            .await
            .unwrap();
        if revoked {
            modes::answers(&harness.autonomy(), &root, DecisionMode::Manual).await;
        }
        evaluator.release.notify_one();
        tokio::time::timeout(BOUND, task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let settlement = forms.settlement(&info.id).unwrap();
        let assessment = settlement.assessment.unwrap();
        assert_eq!(assessment.mode, form::AssessmentMode::Yolo);
        assert_eq!(assessment.source_session_id, *root.as_lossless());
        if revoked {
            assert!(settlement.automatic.is_none());
            assert!(data(&harness, "form.replied").is_empty());
            assert_eq!(forms.state(&info.id).unwrap(), form::State::Pending);
            assert_eq!(
                assessment.fields[0].status,
                form::FieldAssessmentStatus::Unavailable
            );
            forms.cancel(&info.id).unwrap();
            assert_eq!(settle(wait).await, form::State::Cancelled);
        } else {
            let automatic = settlement.automatic.unwrap();
            assert_eq!(automatic.via, "yolo");
            assert_eq!(automatic.confidence, Some(0.96));
            assert!(settlement.source.is_none());
            assert_eq!(
                assessment.fields[0].status,
                form::FieldAssessmentStatus::Assessed
            );
            assert_eq!(
                settle(wait).await,
                form::State::Answered(answer(r#"{"q0":"SQLite"}"#))
            );
        }
    }
}

#[tokio::test]
async fn a_human_answer_during_grading_wins_and_closes_pending_fields() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::held(vec![graded(&[0.96, 0.5, 0.1])]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_human_wins", &[single("q0")], "");
    let wait = forms.ask(info.clone()).unwrap();
    tokio::time::timeout(BOUND, evaluator.entered.notified())
        .await
        .unwrap();
    forms
        .reply(&info.id, answer(r#"{"q0":"Postgres"}"#))
        .unwrap();
    assert!(matches!(settle(wait).await, form::State::Answered(_)));
    evaluator.release.notify_one();
    quiesce(&evaluator).await;
    assert!(!forms.answered_automatically(&info.id).unwrap());
    assert_eq!(kinds(&harness), ["form.created", "form.replied"]);
    let field = &assessment_of(&forms, &info.id).fields[0];
    assert_eq!(field.status, form::FieldAssessmentStatus::NotAssessed);
    assert_eq!(text(&field.reason), "Answered before assessment settled.");
}

#[tokio::test]
async fn cancelling_during_grading_applies_nothing_and_closes_pending_fields() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::held(vec![graded(&[0.96, 0.5, 0.1])]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_cancelled", &[single("q0")], "");
    let wait = forms.ask(info.clone()).unwrap();
    tokio::time::timeout(BOUND, evaluator.entered.notified())
        .await
        .unwrap();
    forms.cancel(&info.id).unwrap();
    assert_eq!(settle(wait).await, form::State::Cancelled);
    quiesce(&evaluator).await;
    assert_eq!(kinds(&harness), ["form.created", "form.cancelled"]);
    let field = &assessment_of(&forms, &info.id).fields[0];
    assert_eq!(field.status, form::FieldAssessmentStatus::NotAssessed);
    assert_eq!(
        text(&field.reason),
        "Request closed before assessment settled."
    );
}

#[tokio::test]
async fn a_mode_change_during_grading_withdraws_the_assessment_and_leaves_the_form_pending() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::held(vec![graded(&[0.96, 0.5, 0.1])]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_mode_change", &[single("q0")], "");
    let wait = forms.ask(info.clone()).unwrap();
    tokio::time::timeout(BOUND, evaluator.entered.notified())
        .await
        .unwrap();
    modes::answers(&harness.autonomy(), &root, modes::yolo(false)).await;
    evaluator.release.notify_one();
    until(&harness, "form.assessed", 1).await;
    let field = &assessed(&harness)[0].fields[0];
    assert_eq!(field.status, form::FieldAssessmentStatus::Unavailable);
    assert_eq!(
        text(&field.reason),
        "Answers mode changed; assessment not applied."
    );
    assert!(field.recommendation.is_none() && field.confidence.is_none());
    assert!(field.grades.is_none());
    assert_eq!(forms.state(&info.id).unwrap(), form::State::Pending);
    forms
        .reply(&info.id, answer(r#"{"q0":"Postgres"}"#))
        .unwrap();
    assert!(matches!(settle(wait).await, form::State::Answered(_)));
    assert!(!forms.answered_automatically(&info.id).unwrap());
    assert_eq!(
        kinds(&harness),
        ["form.created", "form.assessed", "form.replied"]
    );
}

#[tokio::test]
async fn a_changed_decision_context_during_grading_withdraws_the_assessment() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::held(vec![graded(&[0.96, 0.5, 0.1])]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_context", &[single("q0")], "");
    let _wait = forms.ask(info.clone()).unwrap();
    tokio::time::timeout(BOUND, evaluator.entered.notified())
        .await
        .unwrap();
    let mut row = harness
        .fixture
        .store
        .client()
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(root.as_lossless())]))
        .unwrap()
        .unwrap();
    row.permission = Some(
        Document::from_domain(&vec![permission::Rule {
            action: "read".into(),
            resource: "*".into(),
            effect: permission::Effect("deny".into()),
        }])
        .unwrap(),
    );
    harness
        .fixture
        .store
        .submit(move |tx| {
            tx.put::<SessionTable>(&row)?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    evaluator.release.notify_one();
    until(&harness, "form.assessed", 1).await;
    let field = &assessed(&harness)[0].fields[0];
    assert_eq!(field.status, form::FieldAssessmentStatus::Unavailable);
    assert_eq!(
        text(&field.reason),
        "Authority changed; assessment not applied."
    );
    assert!(field.grades.is_none());
    assert_eq!(forms.state(&info.id).unwrap(), form::State::Pending);
    assert_eq!(kinds(&harness), ["form.created", "form.assessed"]);
}

#[tokio::test]
async fn a_sleeping_assessment_is_invisible_until_it_settles_and_then_carries_final_evidence() {
    let (harness, root) = session(modes::yolo(true)).await;
    harness.autonomy().set_defer(&root, true).await.unwrap();
    let evaluator = Scripted::held(vec![graded(&[0.96, 0.5, 0.1])]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_sleeping", &[single("q0")], "");
    let wait = forms.ask(info.clone()).unwrap();
    tokio::time::timeout(BOUND, evaluator.entered.notified())
        .await
        .unwrap();
    assert!(forms.list(None).is_empty());
    assert!(kinds(&harness).is_empty());
    evaluator.release.notify_one();
    assert_eq!(
        settle(wait).await,
        form::State::Answered(answer(r#"{"q0":"SQLite"}"#))
    );
    assert_eq!(kinds(&harness), ["form.created", "form.replied"]);
    let field = &created(&harness).assessment.unwrap().fields[0];
    assert_eq!(field.status, form::FieldAssessmentStatus::Assessed);
    assert_eq!(recommendation(field), ["SQLite"]);
    assert!(assessed(&harness).is_empty());
}

#[tokio::test]
async fn a_deferred_inconclusive_assessment_answers_with_a_valid_fallback_and_final_evidence() {
    let (harness, root) = session(modes::yolo(true)).await;
    harness.autonomy().set_defer(&root, true).await.unwrap();
    let evaluator = Scripted::new(vec![graded(&[0.7, 0.5, 0.1])]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_sleeping_low", &[single("q0")], "");
    let state = settle(forms.ask(info.clone()).unwrap()).await;
    assert_eq!(state, form::State::Answered(answer(r#"{"q0":"SQLite"}"#)));
    let field = &assessment_of(&forms, &info.id).fields[0];
    assert_eq!(field.status, form::FieldAssessmentStatus::Assessed);
    assert!(field.recommendation.is_none());
    assert_eq!(kinds(&harness), ["form.created", "form.replied"]);
}

fn source() -> Source {
    Source {
        coordinator_session_id: SessionId::new("ses_native_coordinator").unwrap(),
        group_id: Some("cgrp_native".into()),
        rationale: "Evaluate the assigned storage choice.".into(),
    }
}

fn reconsider(
    fingerprint: &LosslessString,
    answer: Option<form::Answer>,
    confidence: Option<f64>,
) -> Reconsider<form::Info> {
    Reconsider {
        fingerprint: fingerprint.clone(),
        source: source(),
        decision: None,
        answer,
        confidence,
        gate: Gate {
            validate: Arc::new(|_| Box::pin(async { true })),
            current: Arc::new(|| true),
        },
    }
}

#[tokio::test]
async fn native_coordination_settles_a_yolo_fallback_once_with_coordinator_attribution() {
    let (harness, root) = session(modes::yolo(false)).await;
    let evaluator = Scripted::new(vec![graded(&[0.75, 0.6, 0.5])]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_reconsider", &[single("q0")], "");
    let wait = forms.ask(info.clone()).unwrap();
    modes::answers(&harness.autonomy(), &root, modes::yolo(true)).await;
    let fingerprint = forms.snapshot(&info.id).unwrap().fingerprint;

    let stale = forms
        .reconsider(&info.id, reconsider(&"stale".into(), None, None))
        .await
        .unwrap();
    assert!(matches!(stale.outcome, DecisionOutcome::Stale) && !stale.settled);
    assert_eq!(evaluator.calls(), 0);
    let settled = forms
        .reconsider(&info.id, reconsider(&fingerprint, None, None))
        .await
        .unwrap();
    assert!(matches!(settled.outcome, DecisionOutcome::Allowed) && settled.settled);
    assert_eq!(settled.via, Some("yolo"));
    assert_eq!(settled.confidence, None);
    assert!(settled.source.is_some());
    assert_eq!(
        settle(wait).await,
        form::State::Answered(answer(r#"{"q0":"SQLite"}"#))
    );
    assert_eq!(
        kinds(&harness),
        ["form.created", "form.assessed", "form.replied"]
    );
    let replied = &data(&harness, "form.replied")[0];
    let JsonValue::Object(replied) = replied else {
        panic!("event data is an object")
    };
    let Some(JsonValue::Object(attribution)) = replied.get(&"source".into()) else {
        panic!("replied carries the coordinator source")
    };
    assert_eq!(
        attribution.get(&"kind".into()),
        Some(&JsonValue::String("coordinator".into()))
    );
    assert_eq!(
        attribution.get(&"via".into()),
        Some(&JsonValue::String("yolo".into()))
    );
    assert!(attribution.get(&"confidence".into()).is_none());
    let keys = evaluator.keys();
    assert_eq!(keys.len(), 1);
    assert_eq!(
        scores(&assessment_of(&forms, &info.id).fields[0].grades),
        [0.75, 0.6, 0.5]
    );
    let repeated = forms
        .reconsider(&info.id, reconsider(&fingerprint, None, None))
        .await
        .unwrap();
    assert!(matches!(repeated.outcome, DecisionOutcome::Stale));
    assert_eq!(evaluator.calls(), 1);
}

#[tokio::test]
async fn native_coordination_never_assesses_manual_or_coordinator_supplied_answers() {
    let (harness, root) = session(modes::yolo(false)).await;
    let evaluator = Scripted::new(vec![]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_manual", &[single("q0")], "");
    let _wait = forms.ask(info.clone()).unwrap();
    let fingerprint = forms.snapshot(&info.id).unwrap().fingerprint;
    let manual = forms
        .reconsider(&info.id, reconsider(&fingerprint, None, None))
        .await
        .unwrap();
    assert_eq!(text(manual.reason.as_ref().unwrap()), "answer-required");
    assert_eq!(evaluator.calls(), 0);

    let (harness, root) = session(modes::yolo(false)).await;
    let evaluator = Scripted::new(vec![]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_supplied", &[single("q0")], "");
    let wait = forms.ask(info.clone()).unwrap();
    let before = assessment_of(&forms, &info.id);
    let fingerprint = forms.snapshot(&info.id).unwrap().fingerprint;
    let supplied = forms
        .reconsider(
            &info.id,
            reconsider(
                &fingerprint,
                Some(answer(r#"{"q0":"Postgres"}"#)),
                Some(0.95),
            ),
        )
        .await
        .unwrap();
    assert!(matches!(supplied.outcome, DecisionOutcome::Allowed));
    assert_eq!(supplied.via, Some("coordination"));
    assert_eq!(supplied.confidence, Some(0.95));
    assert_eq!(evaluator.calls(), 0);
    assert!(matches!(settle(wait).await, form::State::Answered(_)));
    assert_eq!(assessment_of(&forms, &info.id), before);
}

#[tokio::test]
async fn forms_without_option_fields_or_question_metadata_carry_no_assessment() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::new(vec![Box::new(|_| {
        response(
            r#"{"name":"f0","type":"predicate","answer":true,"choice":null,"score":null,"confidence":0.95}"#,
        )
    })]);
    let forms = service(&harness, &evaluator);
    let info = form::Info::decode(
        &parse_json(&format!(
            r#"{{"id":"frm_plain","sessionID":{},"title":"Confirm","fields":[{{"key":"ok","type":"boolean","required":true}}]}}"#,
            stringify_json(&root.encode())
        ))
        .unwrap(),
    )
    .unwrap();
    let state = settle(forms.ask(info.clone()).unwrap()).await;
    assert_eq!(state, form::State::Answered(answer(r#"{"ok":true}"#)));
    assert!(forms.get(&info.id).unwrap().assessment.is_none());
    assert_eq!(kinds(&harness), ["form.created", "form.replied"]);
    assert_eq!(evaluator.calls(), 1);
}

#[tokio::test]
async fn a_client_supplied_assessment_is_discarded_at_creation() {
    let (harness, root) = session(modes::yolo(false)).await;
    let evaluator = Scripted::new(vec![]);
    let forms = service(&harness, &evaluator);
    let mut info = question_form(&root, "frm_forged", &[single("q0")], "");
    info.assessment = Some(form::Assessment {
        mode: form::AssessmentMode::Yolo,
        source_session_id: "forged".into(),
        fields: vec![],
    });
    let created = forms.create(info.clone()).unwrap();
    assert!(created.assessment.is_none());
    assert!(forms.get(&info.id).unwrap().assessment.is_none());
}

fn text_reply(name: &'static str, text: &'static str, confidence: f64) -> String {
    format!(
        r#"{{"name":"{name}","type":"text","answer":null,"choice":null,"score":null,"confidence":{confidence},"text":{}}}"#,
        stringify_json(&JsonValue::String(text.into()))
    )
}

fn plain_form(session: &SessionId, id: &str, fields: &str) -> form::Info {
    form::Info::decode(
        &parse_json(&format!(
            r#"{{"id":"{id}","sessionID":{},"title":"Confirm","fields":[{fields}]}}"#,
            stringify_json(&session.encode())
        ))
        .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn a_boolean_answer_settles_with_the_helper_confidence_and_yolo_attribution() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::new(vec![Box::new(|_| {
        response(
            r#"{"name":"f0","type":"predicate","answer":true,"choice":null,"score":null,"confidence":0.95}"#,
        )
    })]);
    let forms = service(&harness, &evaluator);
    let info = plain_form(
        &root,
        "frm_bool",
        r#"{"key":"ok","type":"boolean","required":true}"#,
    );
    let state = settle(forms.ask(info.clone()).unwrap()).await;
    assert_eq!(state, form::State::Answered(answer(r#"{"ok":true}"#)));
    let sent = stringify_json(&evaluator.seen.lock().unwrap()[0].input);
    assert!(sent.contains("Never refuse or defer; provide an answer without requesting input"));
    assert!(
        sent.contains("Do not claim synthetic values are observed facts or explicit authorization")
    );
    let settlement = forms.settlement(&info.id).unwrap();
    assert_eq!(
        settlement.automatic,
        Some(Automatic {
            via: "yolo",
            confidence: Some(0.95)
        })
    );
    assert!(settlement.assessment.is_none() && settlement.source.is_none());
}

#[tokio::test]
async fn free_text_and_boolean_answers_settle_with_the_lowest_helper_confidence() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::new(vec![Box::new(|_| {
        response(&format!(
            r#"{{"name":"f0","type":"predicate","answer":true,"choice":null,"score":null,"confidence":0.95}},{}"#,
            text_reply("f1", "Ship it", 0.85)
        ))
    })]);
    let forms = service(&harness, &evaluator);
    let info = plain_form(
        &root,
        "frm_mixed",
        r#"{"key":"ok","type":"boolean","required":true},{"key":"note","type":"string","required":true}"#,
    );
    let state = settle(forms.ask(info.clone()).unwrap()).await;
    assert_eq!(
        state,
        form::State::Answered(answer(r#"{"ok":true,"note":"Ship it"}"#))
    );
    assert_eq!(evaluator.calls(), 1);
    assert_eq!(
        forms.settlement(&info.id).unwrap().automatic,
        Some(Automatic {
            via: "yolo",
            confidence: Some(0.85)
        })
    );
}

#[tokio::test]
async fn an_option_form_with_a_free_text_field_settles_with_the_lowest_confidence_across_both() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::new(vec![
        graded(&[0.96, 0.9, 0.5]),
        Box::new(|_| response(&text_reply("f1", "Because", 0.82))),
    ]);
    let forms = service(&harness, &evaluator);
    let info = question_form(
        &root,
        "frm_option_text",
        &[
            single("q0"),
            r#"{"key":"q1","type":"string","required":true}"#.into(),
        ],
        "",
    );
    let state = settle(forms.ask(info.clone()).unwrap()).await;
    assert_eq!(
        state,
        form::State::Answered(answer(r#"{"q0":"SQLite","q1":"Because"}"#))
    );
    let settlement = forms.settlement(&info.id).unwrap();
    assert_eq!(
        settlement.automatic,
        Some(Automatic {
            via: "yolo",
            confidence: Some(0.82)
        })
    );
    assert_eq!(settlement.assessment.unwrap().fields.len(), 1);
}

#[tokio::test]
async fn a_refused_free_text_field_uses_progression_text_without_inventing_confidence() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::new(vec![refusing()]);
    let forms = service(&harness, &evaluator);
    let info = plain_form(
        &root,
        "frm_refused",
        r#"{"key":"note","type":"string","required":true}"#,
    );
    let wait = forms.ask(info.clone()).unwrap();
    let form::State::Answered(answer) = settle(wait).await else {
        panic!("expected a validated fallback answer")
    };
    assert!(
        matches!(answer.0.get(&"note".into()), Some(JsonValue::String(value)) if value.to_utf8().is_ok_and(|value| !value.trim().is_empty()))
    );
    let settlement = forms.settlement(&info.id).unwrap();
    let automatic = settlement.automatic.unwrap();
    assert_eq!(automatic.via, "yolo");
    assert!(automatic.confidence.is_none());
}

#[tokio::test]
async fn a_deferred_yolo_form_without_an_evaluator_uses_a_valid_fallback_and_records_unavailability()
 {
    let (harness, root) = session(modes::yolo(true)).await;
    harness.autonomy().set_defer(&root, true).await.unwrap();
    let forms = Forms::new(harness.fixture.authority(), harness.publish.clone())
        .with_reviews(harness.review_policy());
    let info = question_form(&root, "frm_early_defer", &[single("q0")], "");
    let state = settle(forms.ask(info.clone()).unwrap()).await;
    assert_eq!(state, form::State::Answered(answer(r#"{"q0":"SQLite"}"#)));
    let assessment = forms.settlement(&info.id).unwrap().assessment.unwrap();
    assert_eq!(assessment.mode, form::AssessmentMode::Yolo);
    assert_eq!(
        assessment.fields[0].status,
        form::FieldAssessmentStatus::Unavailable
    );
    assert!(forms.list(None).is_empty());
    assert_eq!(kinds(&harness), ["form.created", "form.replied"]);
    assert_eq!(forms.ask(info).err(), Some(FormsError::AlreadyExists));
    assert_eq!(kinds(&harness), ["form.created", "form.replied"]);
}

#[tokio::test]
async fn a_coordinator_settlement_is_stored_with_its_source() {
    let (harness, root) = session(modes::yolo(true)).await;
    let evaluator = Scripted::held(vec![graded(&[0.96, 0.9, 0.5])]);
    let forms = service(&harness, &evaluator);
    let info = question_form(&root, "frm_sourced", &[single("q0")], "");
    let wait = forms.ask(info.clone()).unwrap();
    tokio::time::timeout(BOUND, evaluator.entered.notified())
        .await
        .unwrap();
    let fingerprint = forms.snapshot(&info.id).unwrap().fingerprint;
    let settled = forms
        .reconsider(
            &info.id,
            reconsider(
                &fingerprint,
                Some(answer(r#"{"q0":"Postgres"}"#)),
                Some(0.9),
            ),
        )
        .await
        .unwrap();
    assert!(settled.settled);
    evaluator.release.notify_one();
    assert_eq!(
        settle(wait).await,
        form::State::Answered(answer(r#"{"q0":"Postgres"}"#))
    );
    let settlement = forms.settlement(&info.id).unwrap();
    assert!(settlement.automatic.is_none());
    assert_eq!(settlement.source, settled.source);
    let missing = form::Id::decode(&JsonValue::String("frm_missing".into())).unwrap();
    assert_eq!(forms.settlement(&missing).err(), Some(FormsError::NotFound));
}
