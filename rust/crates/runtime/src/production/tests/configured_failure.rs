use super::fixture_with;
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::mpsc;
use ycoding_core::session::{pending, run_coordinator::Coordinator};
use ycoding_core::ycoding_schema::{
    DomainDecode, JsonValue, event, parse_json, session, session_message, session_pending,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_compatible_routes_preserve_unknown_failures_and_selected_variants() {
    for package in [
        "@ai-sdk/openai-compatible",
        "aisdk:@ai-sdk/openai-compatible",
        "@ycoding-ai/ai/providers/openai-compatible",
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let (requests, mut received) = mpsc::unbounded_channel::<(JsonValue, Option<String>)>();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new()
                    .route(
                        "/v1/chat/completions",
                        post(
                            |State(requests): State<
                                mpsc::UnboundedSender<(JsonValue, Option<String>)>,
                            >,
                             headers: HeaderMap,
                             body: Bytes| async move {
                                requests
                                    .send((
                                        parse_json(std::str::from_utf8(&body).unwrap()).unwrap(),
                                        headers
                                            .get("x-fixture-variant")
                                            .map(|value| value.to_str().unwrap().to_owned()),
                                    ))
                                    .unwrap();
                                (
                                    StatusCode::IM_A_TEAPOT,
                                    [("content-type", "application/json")],
                                    r#"{"error":{"message":"Synthetic unclassified rejection"}}"#,
                                )
                            },
                        ),
                    )
                    .with_state(requests),
            )
            .await
            .unwrap();
        });
        let f = fixture_with(
            &format!(
                r#"{{"default_agent":"god","model":{{"providerID":"configured-route","model":"configured-model","variant":"careful"}},"efficiency":{{"title":"off"}},"model_fallbacks":{{"configured-route/configured-model":["openai/gpt-runtime"]}},"providers":{{"configured-route":{{"package":"{package}","settings":{{"baseURL":"{endpoint}","apiKey":"synthetic-config-key"}},"models":{{"configured-model":{{"limit":{{"context":128000,"output":1024}},"variants":[{{"id":"careful","headers":{{"x-fixture-variant":"careful"}}}}]}}}}}}}}}}"#
            ),
            "{}",
            BTreeMap::new(),
            false,
        );
        let locations = f.locations();
        let services = f.services(&locations);
        let composed = services.production.as_ref().unwrap();
        assert!(composed.configuration.diagnostics.is_empty());
        let selection = composed
            .models
            .catalog()
            .configured_default()
            .cloned()
            .unwrap();
        assert_eq!(selection.provider_id.0.as_str(), Some("configured-route"));
        assert_eq!(
            selection.variant.as_ref().unwrap().as_str(),
            Some("careful")
        );
        let id = session::Id::new("ses_one").unwrap();
        let event = event::Id::new("evt_configured_unknown").unwrap();
        f.sessions()
            .admit_input(pending::Request {
                id: session_message::Id::from_event(&event),
                session_id: id.clone(),
                input: session_pending::Message::decode(
                    &parse_json(
                        r#"{"type":"user","delivery":"steer","data":{"text":"Synthetic classification check"}}"#,
                    )
                    .unwrap(),
                )
                .unwrap(),
                event_id: event,
                created: crate::ids::now_millis(),
            })
            .await
            .unwrap();
        let coordinator = Coordinator::new(Arc::new(composed.runner.clone()));
        let result = tokio::time::timeout(Duration::from_secs(15), coordinator.run(&id)).await;
        let generated = tokio::time::timeout(
            Duration::from_secs(15),
            composed.session_generate.generate(
                &id,
                "Synthetic helper classification check".into(),
                &ycoding_core::tools::code_mode::Cancellation::default(),
            ),
        )
        .await;
        let transcript = f.sessions().transcript(&id).unwrap();
        coordinator.shutdown().await.unwrap();
        composed.activation.close().await;
        locations.close().unwrap();
        f.factory.globals.close().await.unwrap();
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
        assert!(
            matches!(result.unwrap(), Err(ycoding_core::session::run_coordinator::Error::Runner(ref error)) if error.r#type.as_str() == Some("provider.unknown")),
            "{package}"
        );
        assert!(
            matches!(generated.unwrap(), Err(ycoding_core::session::generate::Error::Provider(ref error)) if error.reason == ycoding_core::ycoding_ai::provider_error::Reason::UnknownProvider),
            "{package}"
        );
        let bodies = std::iter::from_fn(|| received.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(bodies.len(), 2, "{package}: retries or fallback requests");
        for (body, variant) in bodies {
            assert_eq!(variant.as_deref(), Some("careful"), "{package}");
            let JsonValue::Object(body) = body else {
                panic!("request is not an object")
            };
            assert_eq!(
                body.get(&"model".into()),
                Some(&JsonValue::String("configured-model".into())),
                "{package}"
            );
        }
        let assistants = transcript
            .iter()
            .filter_map(|message| match message {
                session_message::Info::Assistant(assistant) => Some(assistant),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(assistants.len(), 1, "{package}");
        assert_eq!(assistants[0].model, selection, "{package}");
        assert_eq!(
            assistants[0].error.as_ref().unwrap().r#type.as_str(),
            Some("provider.unknown"),
            "{package}"
        );
        assert!(composed.credentials.all().unwrap().is_empty());
    }
}
