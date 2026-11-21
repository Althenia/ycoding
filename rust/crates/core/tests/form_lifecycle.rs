include!("policy_fixture.rs");
#[path = "decision_support/mod.rs"]
mod modes;

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use ycoding_core::tools::policy::{
    forms::{Error, Forms},
    questions,
};
use ycoding_schema::{DomainDecode, JsonValue, form, parse_json, question};

fn form(id: &str, session: &str, fields: &str) -> form::Info {
    form::Info::decode(&parse_json(&format!("{{\"id\":\"{id}\",\"sessionID\":\"{session}\",\"title\":\"Choose\",\"fields\":{fields}}}")).unwrap()).unwrap()
}

#[tokio::test]
async fn global_forms_need_no_session_and_remain_location_owned() {
    let fixture = Fixture::default();
    let service = Forms::new(fixture.authority(), fixture.publisher());
    let other = Forms::new(fixture.authority(), fixture.publisher());
    let input = form(
        "frm_global_reply",
        "global",
        r#"[{"key":"name","type":"string","required":true}]"#,
    );
    let wait = service.ask(input.clone()).unwrap();
    assert_eq!(service.get(&input.id).unwrap(), input);
    assert_eq!(service.state(&input.id).unwrap(), form::State::Pending);
    assert_eq!(service.list(None), vec![input.clone()]);
    assert_eq!(service.list(Some(&"global".into())), vec![input.clone()]);
    assert!(service.list(Some(&"ses_other".into())).is_empty());
    assert!(other.list(None).is_empty());
    assert_eq!(other.get(&input.id), Err(Error::NotFound));
    assert_eq!(other.state(&input.id), Err(Error::NotFound));
    let answer = form::Answer::decode(&parse_json(r#"{"name":"Ava"}"#).unwrap()).unwrap();
    assert_eq!(other.reply(&input.id, answer.clone()), Err(Error::NotFound));
    assert_eq!(other.cancel(&input.id), Err(Error::NotFound));
    assert_eq!(service.state(&input.id).unwrap(), form::State::Pending);
    service.reply(&input.id, answer.clone()).unwrap();
    assert_eq!(wait.await.unwrap(), form::State::Answered(answer.clone()));
    assert!(!service.answered_automatically(&input.id).unwrap());
    assert_eq!(
        service.state(&input.id).unwrap(),
        form::State::Answered(answer)
    );
    assert!(service.list(None).is_empty());

    let cancelled = form(
        "frm_global_cancel",
        "global",
        r#"[{"key":"setup","type":"external","url":"https://example.test/setup"}]"#,
    );
    let wait = service.ask(cancelled.clone()).unwrap();
    service.cancel(&cancelled.id).unwrap();
    assert_eq!(wait.await.unwrap(), form::State::Cancelled);
    assert_eq!(
        service.state(&cancelled.id).unwrap(),
        form::State::Cancelled
    );
    assert!(service.list(None).is_empty());
    assert_eq!(service.cancel(&cancelled.id), Err(Error::AlreadySettled));
    let events = fixture.events.lock().unwrap();
    assert_eq!(
        events.iter().map(|event| event.type_).collect::<Vec<_>>(),
        [
            "form.created",
            "form.replied",
            "form.created",
            "form.cancelled"
        ]
    );
    assert_eq!(
        events[1].data,
        parse_json(r#"{"id":"frm_global_reply","sessionID":"global","answer":{"name":"Ava"}}"#)
            .unwrap()
    );
    assert_eq!(
        events[3].data,
        parse_json(r#"{"id":"frm_global_cancel","sessionID":"global"}"#).unwrap()
    );
}

#[tokio::test]
async fn form_answer_cancel_retention_and_publication_failure() {
    let fixture = Fixture::default();
    let now = Arc::new(AtomicU64::new(1));
    let clock = now.clone();
    let service = Forms::with_clock(
        fixture.authority(),
        fixture.publisher(),
        Arc::new(move || clock.load(Ordering::Relaxed)),
    );
    let input = form(
        "frm_name",
        "global",
        r#"[{"key":"name","type":"string","required":true,"minLength":2}]"#,
    );
    let admission = service.ask(input.clone()).unwrap();
    assert!(matches!(
        service.create(input.clone()),
        Err(Error::AlreadyExists)
    ));
    assert!(
        service
            .reply(
                &input.id,
                form::Answer::decode(&parse_json(r#"{"name":"x"}"#).unwrap()).unwrap()
            )
            .is_err()
    );
    assert_eq!(service.state(&input.id).unwrap(), form::State::Pending);
    let answer = form::Answer::decode(&parse_json(r#"{"name":"Ava"}"#).unwrap()).unwrap();
    service.reply(&input.id, answer.clone()).unwrap();
    assert_eq!(admission.await.unwrap(), form::State::Answered(answer));
    assert!(matches!(
        service.cancel(&input.id),
        Err(Error::AlreadySettled)
    ));
    assert!(service.list(None).is_empty());
    now.store(600_000, Ordering::Relaxed);
    assert!(service.get(&input.id).is_ok());
    now.store(600_001, Ordering::Relaxed);
    assert!(matches!(service.state(&input.id), Err(Error::NotFound)));
    let wait = service.ask(input.clone()).unwrap();
    drop(wait);
    assert_eq!(service.state(&input.id).unwrap(), form::State::Cancelled);
    let fail = Forms::new(
        fixture.authority(),
        Arc::new(|_| Err("publish failed".into())),
    );
    assert!(matches!(fail.create(input.clone()), Err(Error::Publish(_))));
    assert!(matches!(fail.get(&input.id), Err(Error::NotFound)));
}

#[test]
fn conditional_fields_validate_earlier_types_options_and_cascading_inactivity() {
    let fixture = Fixture::default();
    let service = Forms::new(fixture.authority(), fixture.publisher());
    for fields in [
        r#"[{"key":"x","type":"string","when":[{"key":"later","op":"eq","value":"yes"}]},{"key":"later","type":"string"}]"#,
        r#"[{"key":"a","type":"boolean"},{"key":"b","type":"string","when":[{"key":"a","op":"eq","value":"yes"}]}]"#,
        r#"[{"key":"a","type":"string","options":[{"value":"yes","label":"Yes"}]},{"key":"b","type":"string","when":[{"key":"a","op":"eq","value":"no"}]}]"#,
        r#"[{"key":"a","type":"boolean"},{"key":"a","type":"boolean"}]"#,
    ] {
        assert!(matches!(
            service.create(form("frm_bad", "global", fields)),
            Err(Error::InvalidForm(_))
        ));
    }
    let input = form(
        "frm_dependent",
        "global",
        r#"[{"key":"a","type":"boolean"},{"key":"b","type":"string","when":[{"key":"a","op":"eq","value":true}]},{"key":"c","type":"string","required":true,"when":[{"key":"b","op":"neq","value":"no"}]},{"key":"ack","type":"external","url":"https://example.com"}]"#,
    );
    service.create(input.clone()).unwrap();
    for answer in [
        r#"{"a":false,"b":"yes","ack":true}"#,
        r#"{"a":true,"b":"yes","ack":true}"#,
        r#"{"a":false,"c":"yes","ack":true}"#,
        r#"{"a":false}"#,
        r#"{"a":false,"ack":true,"unknown":1}"#,
    ] {
        assert!(
            service
                .reply(
                    &input.id,
                    form::Answer::decode(&parse_json(answer).unwrap()).unwrap()
                )
                .is_err(),
            "{answer}"
        );
    }
    service
        .reply(
            &input.id,
            form::Answer::decode(&parse_json(r#"{"a":false,"ack":true}"#).unwrap()).unwrap(),
        )
        .unwrap();
}

async fn enable_auto_answer(fixture: &Fixture, session: &str) {
    modes::answers(
        &ycoding_core::session::autonomy::Service::new(fixture.store.client()),
        &ycoding_schema::session::Id::new(session).unwrap(),
        modes::auto(true),
    )
    .await;
}

#[tokio::test]
async fn autonomous_forms_use_valid_defaults_and_leave_impossible_fields_pending() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 2, false, None);
    enable_auto_answer(&fixture, "ses_root").await;
    let service = Forms::new(fixture.authority(), fixture.publisher());
    let input = form(
        "frm_auto",
        root.as_lossless().as_str().unwrap(),
        r#"[{"key":"ack","type":"external","url":"https://example.com"},{"key":"flag","type":"boolean"},{"key":"count","type":"integer","minimum":2.3,"default":3},{"key":"items","type":"multiselect","required":true,"options":[{"value":"first","label":"First (Recommended)"},{"value":"second","label":"Second"}]},{"key":"name","type":"string","required":true,"minLength":10,"default":"Continuexx"}]"#,
    );
    let wait = service.ask(input.clone()).unwrap();
    assert!(service.answered_automatically(&input.id).unwrap());
    let form::State::Answered(answer) = wait.await.unwrap() else {
        panic!("expected automatic answer");
    };
    assert_eq!(answer.0.get(&"ack".into()), Some(&JsonValue::Bool(true)));
    assert_eq!(answer.0.get(&"count".into()), Some(&JsonValue::Number(3.0)));
    assert_eq!(
        answer.0.get(&"items".into()),
        Some(&JsonValue::Array(vec![JsonValue::String("first".into())]))
    );
    assert_eq!(
        answer.0.get(&"name".into()),
        Some(&JsonValue::String("Continuexx".into()))
    );
    assert_eq!(answer.0.get(&"flag".into()), None);
    for (id, fields) in [
        (
            "frm_impossible",
            r#"[{"key":"name","type":"string","required":true,"pattern":"^specific$"}]"#,
        ),
        (
            "frm_invalid_default",
            r#"[{"key":"name","type":"string","required":true,"minLength":10,"default":"short"}]"#,
        ),
        (
            "frm_unmarked_option",
            r#"[{"key":"items","type":"multiselect","required":true,"options":[{"value":"first","label":"First"}]}]"#,
        ),
        (
            "frm_missing_value",
            r#"[{"key":"count","type":"integer","required":true,"minimum":2.3}]"#,
        ),
    ] {
        let input = form(id, "ses_root", fields);
        let wait = service.ask(input.clone()).unwrap();
        assert_eq!(
            service.state(&input.id).unwrap(),
            form::State::Pending,
            "{id}"
        );
        assert!(!service.answered_automatically(&input.id).unwrap(), "{id}");
        drop(wait);
        assert_eq!(
            service.state(&input.id).unwrap(),
            form::State::Cancelled,
            "{id}"
        );
    }
}

#[tokio::test]
async fn yolo_without_an_evaluator_fills_valid_options_patterns_numbers_and_optional_fields() {
    let fixture = Fixture::default();
    fixture.session_with("ses_yolo", None, ["manual", "manual", "yolo"], false, None);
    let service = Forms::new(fixture.authority(), fixture.publisher());
    let input = form(
        "frm_yolo_fallback",
        "ses_yolo",
        r#"[{"key":"name","type":"string","required":true,"pattern":"^[A-Z]{3}-\\d{2}$"},{"key":"flag","type":"boolean"},{"key":"count","type":"integer","minimum":2.3},{"key":"choice","type":"string","options":[{"value":"first","label":"First"},{"value":"marked","label":"Second (Recommended)"}]},{"key":"items","type":"multiselect","options":[{"value":"first","label":"First"},{"value":"second","label":"Second"}]}]"#,
    );
    let form::State::Answered(answer) = service.ask(input.clone()).unwrap().await.unwrap() else {
        panic!("expected automatic fallback")
    };
    assert_eq!(
        answer.0.get(&"name".into()),
        Some(&JsonValue::String("AAA-00".into()))
    );
    assert_eq!(answer.0.get(&"flag".into()), Some(&JsonValue::Bool(true)));
    assert_eq!(answer.0.get(&"count".into()), Some(&JsonValue::Number(3.0)));
    assert_eq!(
        answer.0.get(&"choice".into()),
        Some(&JsonValue::String("marked".into()))
    );
    assert_eq!(
        answer.0.get(&"items".into()),
        Some(&JsonValue::Array(vec![JsonValue::String("first".into())]))
    );
    assert!(service.answered_automatically(&input.id).unwrap());
    assert!(service.list(None).is_empty());
}

#[tokio::test]
async fn question_answers_are_owned_by_location_and_interruption_cleans_pending() {
    let fixture = Fixture::default();
    fixture.session("ses_root", None, 0, false, None);
    let request=question::Request::decode(&parse_json(r#"{"id":"que_test","sessionID":"ses_root","questions":[{"question":"Which?","header":"Choice","options":[]}]}"#).unwrap()).unwrap();
    let service = questions::Questions::new(fixture.authority(), fixture.publisher());
    let separate = questions::Questions::new(fixture.authority(), fixture.publisher());
    let questions::Admission::Pending(wait) = service.ask(request.clone()).unwrap() else {
        panic!("expected pending");
    };
    assert!(matches!(
        separate.reply(&request.id, vec![]),
        Err(questions::Error::NotFound)
    ));
    service
        .reply(&request.id, vec![vec!["chosen".into()]])
        .unwrap();
    assert_eq!(
        wait.await.unwrap().unwrap(),
        vec![vec![ycoding_schema::LosslessString::from("chosen")]]
    );
    let questions::Admission::Pending(wait) = service.ask(request.clone()).unwrap() else {
        panic!("expected pending");
    };
    drop(wait);
    assert!(service.list().is_empty());
    fixture.session("ses_root", None, 0, true, None);
    let questions::Admission::Pending(wait) = service.ask(request.clone()).unwrap() else {
        panic!("an active goal grants no automatic answer");
    };
    drop(wait);
    enable_auto_answer(&fixture, "ses_root").await;
    let questions::Admission::Pending(wait) = service.ask(request).unwrap() else {
        panic!("the Session toggle invents no answer for a question without a recommended option");
    };
    drop(wait);
    let recommended = question::Request::decode(&parse_json(r#"{"id":"que_recommended","sessionID":"ses_root","questions":[{"question":"Which?","header":"Choice","options":[{"label":"Keep (Recommended)","description":"Keep the current choice"},{"label":"Change","description":"Choose another"}]}]}"#).unwrap()).unwrap();
    let questions::Admission::Answered(answers) = service.ask(recommended).unwrap() else {
        panic!("expected the recommended option from the Session toggle");
    };
    assert_eq!(
        answers,
        vec![vec![ycoding_schema::LosslessString::from(
            "Keep (Recommended)"
        )]]
    );
}

#[test]
fn form_error_messages_preserve_utf16_field_keys() {
    let input = form(
        "frm_lossless",
        "global",
        r#"[{"key":"\ud800😀","type":"string","required":true}]"#,
    );
    let message: ycoding_schema::LosslessString =
        ycoding_core::tools::policy::forms::validate_answer(
            &input,
            &form::Answer(ycoding_schema::JsonObject::new()),
        )
        .unwrap_err();
    assert_eq!(
        message,
        ycoding_schema::LosslessString::from_utf16(
            "Missing required form field: "
                .encode_utf16()
                .chain([0xd800, 0xd83d, 0xde00])
                .collect()
        )
    );
}

#[tokio::test]
async fn enclosing_timeouts_cancel_forms_and_remove_questions() {
    let fixture = Fixture::default();
    fixture.session("ses_timeout", None, 0, false, None);
    let service = Forms::new(fixture.authority(), fixture.publisher());
    let input = form(
        "frm_timeout",
        "ses_timeout",
        r#"[{"key":"name","type":"string","required":true}]"#,
    );
    assert!(
        tokio::time::timeout(
            std::time::Duration::ZERO,
            service.ask(input.clone()).unwrap()
        )
        .await
        .is_err()
    );
    assert_eq!(service.state(&input.id).unwrap(), form::State::Cancelled);
    let questions = questions::Questions::new(fixture.authority(), fixture.publisher());
    let request=question::Request::decode(&parse_json(r#"{"id":"que_timeout","sessionID":"ses_timeout","questions":[],"tool":{"messageID":"msg_timeout","callID":"call_timeout"}}"#).unwrap()).unwrap();
    let questions::Admission::Pending(wait) = questions.ask(request).unwrap() else {
        panic!("expected pending");
    };
    assert!(
        tokio::time::timeout(std::time::Duration::ZERO, wait)
            .await
            .is_err()
    );
    assert!(questions.list().is_empty());
}

#[tokio::test]
async fn unanswered_forms_and_questions_stay_pending_until_explicit_settlement() {
    let fixture = Fixture::default();
    let session = fixture.session("ses_waiting", None, 0, false, None);
    let forms = Forms::new(fixture.authority(), fixture.publisher());
    let input = form(
        "frm_waiting",
        "ses_waiting",
        r#"[{"key":"name","type":"string","required":true}]"#,
    );
    let mut wait = Box::pin(forms.ask(input.clone()).unwrap());
    let questions = questions::Questions::new(fixture.authority(), fixture.publisher());
    let request = question::Request::decode(&parse_json(r#"{"id":"que_waiting","sessionID":"ses_waiting","questions":[{"question":"Choose","header":"Choice","options":[{"label":"A","description":"A"}]}]}"#).unwrap()).unwrap();
    let questions::Admission::Pending(question_wait) = questions.ask(request.clone()).unwrap()
    else {
        panic!("manual question must wait");
    };
    let mut question_wait = Box::pin(question_wait);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut wait)
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut question_wait)
            .await
            .is_err()
    );
    assert_eq!(forms.state(&input.id).unwrap(), form::State::Pending);
    assert_eq!(forms.list(Some(session.as_lossless())).len(), 1);
    assert_eq!(questions.list().len(), 1);
    let answer = form::Answer::decode(&parse_json(r#"{"name":"human"}"#).unwrap()).unwrap();
    forms.reply(&input.id, answer.clone()).unwrap();
    assert_eq!(wait.await.unwrap(), form::State::Answered(answer));
    questions.reject(&request.id).unwrap();
    assert!(matches!(
        question_wait.await.unwrap(),
        Err(questions::Error::Rejected)
    ));
    assert!(matches!(
        questions.reply(&request.id, vec![vec!["A".into()]]),
        Err(questions::Error::NotFound)
    ));
    assert!(
        !fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.type_ == "form.timed_out" || e.type_ == "question.timed_out")
    );
}

#[tokio::test]
async fn a_human_reply_settles_a_global_form_without_late_events() {
    let fixture = Fixture::default();
    let forms = Forms::new(fixture.authority(), fixture.publisher());
    let input = form(
        "frm_no_timeout",
        "global",
        r#"[{"key":"name","type":"string"}]"#,
    );
    let mut wait = Box::pin(forms.ask(input.clone()).unwrap());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut wait)
            .await
            .is_err()
    );
    let answer = form::Answer::decode(&parse_json(r#"{"name":"human"}"#).unwrap()).unwrap();
    forms.reply(&input.id, answer.clone()).unwrap();
    assert_eq!(wait.await.unwrap(), form::State::Answered(answer));
    assert!(!forms.answered_automatically(&input.id).unwrap());
    assert!(
        !fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.type_ == "form.timed_out")
    );
}
