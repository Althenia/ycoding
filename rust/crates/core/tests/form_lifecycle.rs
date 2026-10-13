include!("policy_fixture.rs");
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

#[tokio::test]
async fn autonomous_forms_use_valid_defaults_and_leave_impossible_fields_pending() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 2, false, None);
    let service = Forms::new(fixture.authority(), fixture.publisher());
    let input = form(
        "frm_auto",
        root.as_lossless().as_str().unwrap(),
        r#"[{"key":"ack","type":"external","url":"https://example.com"},{"key":"flag","type":"boolean"},{"key":"count","type":"integer","minimum":2.3},{"key":"items","type":"multiselect","required":true,"options":[{"value":"first","label":"First"}]},{"key":"name","type":"string","required":true,"minLength":10}]"#,
    );
    let result = service.ask(input).unwrap().await.unwrap();
    let form::State::Answered(answer) = result else {
        panic!("expected automatic answer");
    };
    assert_eq!(answer.0.get(&"count".into()), Some(&JsonValue::Number(3.0)));
    assert_eq!(answer.0.get(&"ack".into()), Some(&JsonValue::Bool(true)));
    assert_eq!(
        answer.0.get(&"name".into()),
        Some(&JsonValue::String("Continuexx".into()))
    );
    let input = form(
        "frm_impossible",
        "ses_root",
        r#"[{"key":"name","type":"string","required":true,"pattern":"^specific$"}]"#,
    );
    let wait = service.ask(input.clone()).unwrap();
    assert_eq!(service.state(&input.id).unwrap(), form::State::Pending);
    drop(wait);
    assert_eq!(service.state(&input.id).unwrap(), form::State::Cancelled);
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
    let questions::Admission::Answered(answers) = service.ask(request).unwrap() else {
        panic!("expected automatic goal answer");
    };
    assert_eq!(
        answers,
        vec![vec![ycoding_schema::LosslessString::from(
            "Continue with the safest reasonable default."
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
