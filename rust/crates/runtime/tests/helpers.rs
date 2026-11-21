mod support;

use prost::{Message, Name};
use std::time::Duration;
use support::*;
use tokio::time::timeout;
use ycoding_core::{
    event_feed::{Payload, Scope},
    ycoding_schema::{JsonValue, session},
};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn prediction_request(session: &str, hint: Option<&str>) -> Vec<u8> {
    v5::SessionPredictionRequest {
        params: v5::SessionPredictionRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionPredictionRequestPayload {
            memory: v5::SessionPredictionRequestPayloadMemory { items: vec![] },
            hint: hint.map(text),
        },
    }
    .encode_to_vec()
}

fn prompt_request(
    session: &str,
    mode: v5::SessionPromptGenerateRequestPayloadMode,
    intent: &str,
) -> Vec<u8> {
    v5::SessionPromptGenerateRequest {
        params: v5::SessionPromptGenerateRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionPromptGenerateRequestPayload {
            mode: mode as i32,
            intent: text(intent),
            memory: v5::SessionPromptGenerateRequestPayloadMemory { items: vec![] },
        },
    }
    .encode_to_vec()
}

fn suggestion(result: &v5::SessionPredictionResult) -> Option<String> {
    match result.data.data.kind.as_ref().unwrap() {
        v5::session_prediction_response_data::Kind::Value1(suggested) => {
            Some(units(&suggested.text))
        }
        v5::session_prediction_response_data::Kind::Value2(_) => None,
    }
}

fn draft(result: &v5::SessionPromptGenerateResult) -> Option<String> {
    match result.data.data.kind.as_ref().unwrap() {
        v5::session_prompt_generate_response_data::Kind::Value1(generated) => {
            Some(units(&generated.text))
        }
        v5::session_prompt_generate_response_data::Kind::Value2(_) => None,
    }
}

async fn predict(client: &mut Client, session: &str, hint: Option<&str>) -> Option<String> {
    suggestion(&success(
        client
            .call(
                "session.prediction",
                session_scope(session),
                prediction_request(session, hint),
            )
            .await,
    ))
}

async fn generate(client: &mut Client, session: &str, intent: &str) -> Option<String> {
    draft(&success(
        client
            .call(
                "session.promptGenerate",
                session_scope(session),
                prompt_request(
                    session,
                    v5::SessionPromptGenerateRequestPayloadMode::SessionPromptgenerateRequestPayloadModeSteer,
                    intent,
                ),
            )
            .await,
    ))
}

fn watch(id: &str) -> ycoding_core::event_feed::Subscriber {
    world()
        .core
        .events
        .subscribe(Scope::Session(session::Id::new(id).unwrap()), None, || {})
        .unwrap()
}

fn published_predictions(subscriber: &ycoding_core::event_feed::Subscriber) -> Vec<JsonValue> {
    std::iter::from_fn(|| subscriber.next().unwrap())
        .filter_map(|item| match &item.payload {
            Payload::Ephemeral(event) if event.data.name() == "session.prediction.updated" => Some(
                ycoding_core::ycoding_schema::DomainEncode::encode(&event.data),
            ),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prediction_returns_the_suggestion_and_publishes_the_ephemeral_event() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let global = v5::Scope {
            target: Some(v5::scope::Target::Global(v5::Empty {})),
        };
        let mut subscriptions = Vec::new();
        for scope in [global.clone(), session_scope("ses_predict_hint")] {
            let request = client
                .send(
                    "event.subscribe",
                    global.clone(),
                    v5::EventSubscribeRequest {
                        scope: scope.clone(),
                    }
                    .encode_to_vec(),
                )
                .await;
            subscriptions.push(client.subscribe_events(&request, scope).await);
        }
        let events = watch("ses_predict_hint");
        let script = script("ses_predict_hint");
        script.reply(Some("Run the focused tests"));
        assert_eq!(
            predict(&mut client, "ses_predict_hint", Some("tests"))
                .await
                .as_deref(),
            Some("Run the focused tests")
        );
        let requests = script.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "prediction");
        assert!(requests[0].1.contains(r#""hint":"tests""#));
        let published = published_predictions(&events);
        assert_eq!(published.len(), 1);
        assert!(
            ycoding_core::ycoding_schema::stringify_json(&published[0])
                .contains("Run the focused tests")
        );
        let received = |client: &Client, subscription: &String| {
            client
                .batches
                .iter()
                .filter(|batch| &batch.subscription_id == subscription)
                .flat_map(|batch| &batch.events)
                .filter(|record| record.durable.is_none())
                .find_map(|record| {
                    let Some(v5::public_event::Kind::SessionPredictionUpdated(event)) =
                        v5::PublicEvent::decode(record.event.payload.as_slice())
                            .unwrap()
                            .kind
                    else {
                        return None;
                    };
                    (subscription != &subscriptions[0]
                        || units(&event.data.session_id) == "ses_predict_hint")
                        .then_some(event)
                })
        };
        while subscriptions
            .iter()
            .any(|subscription| received(&client, subscription).is_none())
        {
            client.step().await;
        }
        for subscription in &subscriptions {
            let event = received(&client, subscription).unwrap();
            assert_eq!(units(&event.data.text), "Run the focused tests");
            assert_eq!(units(&event.data.session_id), "ses_predict_hint");
            assert_eq!(
                units(&event.data.source_message_id),
                "msg_ses_predict_hint_assistant"
            );
            assert_eq!(units(&event.location.unwrap().directory), "/project");
        }
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prediction_answers_unavailable_without_an_event_for_rejected_ineligible_and_unwired_sessions()
 {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let events = [
            "ses_predict_text",
            "ses_predict_child",
            "ses_rich",
            "ses_predict_unwired",
        ]
        .map(watch);

        let rejected = script("ses_predict_text");
        rejected.reply(None);
        assert_eq!(predict(&mut client, "ses_predict_text", None).await, None);
        assert_eq!(rejected.requests().len(), 1);

        let child = script("ses_predict_child");
        child.reply(Some("Run the focused tests"));
        assert_eq!(predict(&mut client, "ses_predict_child", None).await, None);
        assert!(child.requests().is_empty());

        let errored = script("ses_rich");
        errored.reply(Some("Run the focused tests"));
        assert_eq!(predict(&mut client, "ses_rich", None).await, None);
        assert!(errored.requests().is_empty());

        let unwired = script("ses_predict_unwired");
        unwired.reply(Some("Run the focused tests"));
        assert_eq!(
            predict(&mut client, "ses_predict_unwired", None).await,
            None
        );
        assert!(unwired.requests().is_empty());

        assert!(
            events
                .iter()
                .all(|events| published_predictions(events).is_empty())
        );
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_prediction_request_cancels_the_first_which_answers_unavailable() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut first = Client::open(server.address(), &[]).await.unwrap();
        let mut second = Client::open(server.address(), &[]).await.unwrap();
        let script = script("ses_predict_cancel");
        script.reply(Some("Run the focused tests"));
        let gate = script.hold();
        let (first, second) =
            tokio::join!(predict(&mut first, "ses_predict_cancel", None), async {
                script.started().await;
                let (second, ()) =
                    tokio::join!(predict(&mut second, "ses_predict_cancel", None), async {
                        script.started().await;
                        gate.notify_one();
                    });
                second
            });
        assert_eq!(first, None);
        assert_eq!(second.as_deref(), Some("Run the focused tests"));
        assert_eq!(script.interrupted(), 1);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prompt_generation_returns_the_draft_and_publishes_nothing() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let events = watch("ses_prompt_text");
        let script = script("ses_prompt_text");
        script.reply(Some("Fix the build and verify it."));
        assert_eq!(
            generate(&mut client, "ses_prompt_text", "Cover the regression")
                .await
                .as_deref(),
            Some("Fix the build and verify it.")
        );
        let requests = script.requests();
        assert_eq!(requests[0].0, "prompt");
        assert!(requests[0].1.contains(r#""mode":"steer""#));
        assert!(requests[0].1.contains("Cover the regression"));
        assert!(published_predictions(&events).is_empty());

        script.reply(None);
        assert_eq!(
            generate(&mut client, "ses_prompt_text", "Cover the regression").await,
            None
        );
        let unwired = self::script("ses_prompt_unwired");
        unwired.reply(Some("Fix the build and verify it."));
        assert_eq!(
            generate(&mut client, "ses_prompt_unwired", "Cover the regression").await,
            None
        );
        assert!(unwired.requests().is_empty());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_prompt_request_cancels_the_first_which_answers_unavailable() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut first = Client::open(server.address(), &[]).await.unwrap();
        let mut second = Client::open(server.address(), &[]).await.unwrap();
        let script = script("ses_prompt_cancel");
        script.reply(Some("Fix the build and verify it."));
        let gate = script.hold();
        let (first, second) =
            tokio::join!(generate(&mut first, "ses_prompt_cancel", "First"), async {
                script.started().await;
                let (second, ()) = tokio::join!(
                    generate(&mut second, "ses_prompt_cancel", "Second"),
                    async {
                        script.started().await;
                        gate.notify_one();
                    }
                );
                second
            });
        assert_eq!(first, None);
        assert_eq!(second.as_deref(), Some("Fix the build and verify it."));
        assert_eq!(script.interrupted(), 1);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blank_intent_is_an_invalid_request_that_never_reaches_the_helper() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let script = script("ses_prompt_text");
        script.reply(Some("Fix the build and verify it."));
        let before = script.requests().len();
        let payload = rejected(
            client
                .call(
                    "session.promptGenerate",
                    session_scope("ses_prompt_text"),
                    prompt_request(
                        "ses_prompt_text",
                        v5::SessionPromptGenerateRequestPayloadMode::SessionPromptgenerateRequestPayloadModeGoal,
                        "   ",
                    ),
                )
                .await,
        );
        assert_eq!(payload.type_name, v5::InvalidRequestError::full_name());
        assert_eq!(script.requests().len(), before);
        server.shutdown().await.unwrap();
    })
    .await;
}
