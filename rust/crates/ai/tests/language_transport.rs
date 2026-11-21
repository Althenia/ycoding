use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;
use ycoding_ai::{
    Error,
    llm::{self, Event, Request},
    route::{
        Executor, LanguageAttempt, LanguageFuture, LanguageParts, ProcessInput, Route, Transport,
    },
};
use ycoding_schema::{JsonValue, parse_json};

struct Language {
    input: Mutex<Vec<ProcessInput>>,
    parts: Mutex<Option<LanguageParts>>,
}

impl LanguageAttempt for Language {
    fn attempt(&self, input: ProcessInput) -> LanguageFuture<'_> {
        Box::pin(async move {
            self.input.lock().unwrap().push(input);
            self.parts
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| Error::output("synthetic startup failure"))
        })
    }
}

fn fixture() -> (
    mpsc::Sender<Result<JsonValue, Error>>,
    Arc<Language>,
    Request,
) {
    let (send, parts) = mpsc::channel(2);
    let language = Arc::new(Language {
        input: Mutex::new(Vec::new()),
        parts: Mutex::new(Some(parts)),
    });
    let mut route = Route::openai_chat();
    route.transport = Transport::Language(language.clone());
    let mut request = Request::new(route.model("fixture-model"));
    request.messages.push(llm::Message::user("Hello"));
    request.model.defaults.provider_options =
        Some(parse_json(r#"{"fixture":{"selected":true}}"#).unwrap());
    request.caller = Some(llm::Caller {
        session_id: "ses_language".into(),
        agent: "build".into(),
        message_id: "msg_language".into(),
    });
    (send, language, request)
}

fn part(text: &str) -> Result<JsonValue, Error> {
    Ok(parse_json(text).unwrap())
}

#[tokio::test]
async fn language_transport_delivers_parts_before_the_producer_finishes() {
    let (send, language, request) = fixture();
    send.send(part(
        r#"{"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#,
    ))
    .await
    .unwrap();
    let mut stream = Executor::new(Executor::http_client().unwrap())
        .stream(&request)
        .await
        .unwrap();
    let text = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match stream.next().await.unwrap() {
                Some(Event::TextDelta(delta)) => break delta.text,
                Some(_) => {}
                None => panic!("stream ended before its first text part"),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(text.as_str(), Some("Hello"));
    {
        let input = language.input.lock().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0].model.as_str(), Some("fixture-model"));
        assert_eq!(input[0].options, request.model.defaults.provider_options);
        assert_eq!(input[0].caller, request.caller);
        let JsonValue::Object(body) = &input[0].body else {
            panic!("lowered request object")
        };
        assert_eq!(
            body.get(&"model".into()),
            Some(&JsonValue::String("fixture-model".into()))
        );
        assert_eq!(
            body.get(&"messages".into()),
            Some(&parse_json(r#"[{"role":"user","content":"Hello"}]"#).unwrap())
        );
    }
    send.send(part(r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}"#)).await.unwrap();
    drop(send);
    let mut finished = 0;
    while let Some(event) = stream.next().await.unwrap() {
        if let Event::Finish(finish) = event {
            finished += 1;
            let usage = finish.usage.unwrap();
            assert_eq!(usage.input_tokens, Some(7.0));
            assert_eq!(usage.output_tokens, Some(3.0));
            assert_eq!(usage.total_tokens, Some(10.0));
        }
    }
    assert_eq!(finished, 1);
}

#[tokio::test]
async fn dropping_the_language_stream_closes_its_owned_receiver() {
    let (send, _, request) = fixture();
    let stream = Executor::new(Executor::http_client().unwrap())
        .stream(&request)
        .await
        .unwrap();
    assert!(!send.is_closed());
    drop(stream);
    tokio::time::timeout(Duration::from_secs(5), send.closed())
        .await
        .unwrap();
}

#[tokio::test]
async fn language_startup_failure_does_not_create_a_successful_stream() {
    let (_, language, request) = fixture();
    language.parts.lock().unwrap().take();
    let result = Executor::new(Executor::http_client().unwrap())
        .stream(&request)
        .await;
    let Err(error) = result else {
        panic!("startup failure created a stream")
    };
    assert_eq!(error.message, "synthetic startup failure");
    assert_eq!(language.input.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn language_failure_after_visible_output_remains_an_error() {
    let (send, _, request) = fixture();
    send.send(part(
        r#"{"choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}]}"#,
    ))
    .await
    .unwrap();
    send.send(Err(Error::output("synthetic stream failure")))
        .await
        .unwrap();
    let mut stream = Executor::new(Executor::http_client().unwrap())
        .stream(&request)
        .await
        .unwrap();
    let mut visible = false;
    loop {
        match stream.next().await {
            Ok(Some(Event::TextDelta(delta))) => {
                assert_eq!(delta.text.as_str(), Some("Partial"));
                visible = true;
            }
            Ok(Some(Event::Finish(_))) => panic!("failed stream completed successfully"),
            Ok(Some(_)) => {}
            Ok(None) => panic!("failed stream ended without its error"),
            Err(error) => {
                assert!(visible);
                assert_eq!(error.message, "synthetic stream failure");
                break;
            }
        }
    }
    assert!(send.is_closed());
}
