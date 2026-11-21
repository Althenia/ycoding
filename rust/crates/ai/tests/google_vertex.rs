use std::collections::BTreeMap;
use ycoding_ai::{
    auth::{Auth, Credential, Secret},
    google_vertex, google_vertex_messages,
    google_vertex_shared::{self, Config},
    llm::{Message, Request},
};
use ycoding_schema::{parse_json, stringify_json};

fn oauth(location: Option<&str>) -> Config {
    Config {
        access_token: Some(Credential::value("vertex-token")),
        project: Some("vertex-project".into()),
        location: location.map(String::from),
        ..Default::default()
    }
}
#[test]
fn vertex_gemini_global_regional_multiregion_and_tuned_endpoints() {
    for (location, host) in [
        (None, "us-central1-aiplatform.googleapis.com"),
        (Some("global"), "aiplatform.googleapis.com"),
        (Some("eu"), "aiplatform.eu.rep.googleapis.com"),
        (Some("us"), "aiplatform.us.rep.googleapis.com"),
        (
            Some("europe-west4"),
            "europe-west4-aiplatform.googleapis.com",
        ),
    ] {
        let model = google_vertex::model("gemini-3.5-flash", oauth(location)).unwrap();
        let prepared = model.route.prepare(&Request::new(model.clone())).unwrap();
        assert_eq!(
            prepared.url.as_str(),
            format!(
                "https://{host}/v1beta1/projects/vertex-project/locations/{}/publishers/google/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
                location.unwrap_or("us-central1")
            )
        );
        assert_eq!(prepared.headers["authorization"], "Bearer vertex-token");
        assert_eq!(model.route.id, "google-vertex-gemini");
        assert_eq!(model.route.protocol.id(), "gemini");
        assert_eq!(model.route.provider_metadata_key.as_deref(), Some("google"));
    }
    let model = google_vertex::model("endpoints/1234567890", oauth(None)).unwrap();
    let prepared = model.route.prepare(&Request::new(model.clone())).unwrap();
    assert_eq!(
        prepared.url.as_str(),
        "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/vertex-project/locations/us-central1/endpoints/1234567890:streamGenerateContent?alt=sse"
    );
}

#[test]
fn vertex_express_override_and_auth_conflicts() {
    let model = google_vertex::model(
        "gemini-3.5-flash",
        Config {
            api_key: Some(Secret::new("fixture")),
            ..Default::default()
        },
    )
    .unwrap();
    let prepared = model.route.prepare(&Request::new(model.clone())).unwrap();
    assert_eq!(
        prepared.url.as_str(),
        "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.5-flash:streamGenerateContent?alt=sse"
    );
    assert_eq!(prepared.headers["x-goog-api-key"], "fixture");
    assert!(!prepared.headers.contains_key("authorization"));
    assert!(
        google_vertex::model(
            "endpoints/123",
            Config {
                api_key: Some(Secret::new("fixture")),
                base_url: Some("https://vertex.test".into()),
                ..Default::default()
            }
        )
        .err()
        .unwrap()
        .message
        .contains("tuned models do not support Express Mode")
    );
    for config in [
        Config {
            api_key: Some(Secret::new("fixture")),
            ..oauth(None)
        },
        Config {
            api_key: Some(Secret::new("fixture")),
            auth: Some(Auth::None),
            ..Default::default()
        },
        Config {
            auth: Some(Auth::None),
            ..oauth(None)
        },
    ] {
        assert!(
            google_vertex::model("gemini", config)
                .err()
                .unwrap()
                .message
                .contains("cannot be combined")
        );
    }
    assert!(
        google_vertex::model(
            "gemini",
            Config {
                project: None,
                ..oauth(None)
            }
        )
        .err()
        .unwrap()
        .message
        .contains("requires a project")
    );
    let model = google_vertex::model(
        "gemini",
        Config {
            project: None,
            base_url: Some("https://proxy.test/v1/".into()),
            ..oauth(None)
        },
    )
    .unwrap();
    assert_eq!(
        model
            .route
            .prepare(&Request::new(model.clone()))
            .unwrap()
            .url
            .as_str(),
        "https://proxy.test/v1/models/gemini:streamGenerateContent?alt=sse"
    );
    let model = google_vertex::model(
        "gemini",
        Config {
            access_token: None,
            auth: Some(Auth::bearer(Credential::value("custom"))),
            ..oauth(None)
        },
    )
    .unwrap();
    assert_eq!(
        model
            .route
            .prepare(&Request::new(model.clone()))
            .unwrap()
            .headers["authorization"],
        "Bearer custom"
    );
    let model = google_vertex::model(
        "gemini",
        Config {
            api_key: Some(Secret::new("")),
            project: Some("vertex-project".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        model
            .route
            .endpoint
            .base_url
            .contains("/projects/vertex-project/")
    );
    let error = model
        .route
        .prepare(&Request::new(model.clone()))
        .unwrap_err();
    assert_eq!(
        error.reason,
        ycoding_ai::provider_error::Reason::Authentication
    );
}

#[test]
fn vertex_messages_reuses_anthropic_protocol_body_and_parser() {
    for (location, host) in [
        (None, "aiplatform.googleapis.com"),
        (Some("eu"), "aiplatform.eu.rep.googleapis.com"),
        (Some("us"), "aiplatform.us.rep.googleapis.com"),
        (Some("us-central1"), "us-central1-aiplatform.googleapis.com"),
    ] {
        let route = google_vertex_messages::route(oauth(location)).unwrap();
        let mut request = Request::new(route.model("claude-sonnet-4-6"));
        request.messages.push(Message::user("Say hello."));
        let prepared = route.prepare(&request).unwrap();
        assert_eq!(
            prepared.url.as_str(),
            format!(
                "https://{host}/v1/projects/vertex-project/locations/{}/publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict",
                location.unwrap_or("global")
            )
        );
        assert_eq!(route.id, "google-vertex-messages");
        assert_eq!(route.provider.0.as_str(), Some("google-vertex-anthropic"));
        assert_eq!(route.provider_metadata_key.as_deref(), Some("anthropic"));
        assert_eq!(route.protocol.id(), "anthropic-messages");
        assert_eq!(prepared.headers["authorization"], "Bearer vertex-token");
        assert!(!prepared.headers.contains_key("anthropic-version"));
        let mut native = request.clone();
        native.model.route = std::sync::Arc::new(ycoding_ai::route::Route::anthropic());
        let native = native.model.route.prepare(&native).unwrap().body;
        let mut expected: serde_json::Value =
            serde_json::from_str(&stringify_json(&native)).unwrap();
        expected.as_object_mut().unwrap().remove("model");
        expected["anthropic_version"] = "vertex-2023-10-16".into();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&prepared.encoded_body).unwrap(),
            expected
        );
        assert!(
            prepared
                .encoded_body
                .ends_with(r#","anthropic_version":"vertex-2023-10-16"}"#)
        );
        request.http.body = Some(parse_json(r#"{"anthropic_version":"wrong"}"#).unwrap());
        assert!(
            route
                .prepare(&request)
                .unwrap_err()
                .message
                .contains("protocol-owned")
        );
        let mut parser = route.protocol.parser(&request);
        let mut events=parser.push(&parse_json(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello."}}"#).unwrap()).unwrap();
        events.extend(parser.push(&parse_json(r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}"#).unwrap()).unwrap());
        events.extend(parser.finish().unwrap());
        assert_eq!(
            ycoding_ai::llm::Response::from_events(events)
                .unwrap()
                .text()
                .as_str(),
            Some("Hello.")
        );
    }
    assert!(
        google_vertex_messages::route(Config {
            api_key: Some(Secret::new("fixture")),
            ..oauth(None)
        })
        .err()
        .unwrap()
        .message
        .contains("Messages does not support API keys")
    );
    let route = google_vertex_messages::route(Config {
        base_url: Some("https://proxy.test/v1".into()),
        project: None,
        ..oauth(None)
    })
    .unwrap();
    assert_eq!(route.endpoint.base_url, "https://proxy.test/v1");
}

#[test]
fn explicit_environment_resolution_preserves_typescript_precedence() {
    let mut environment = BTreeMap::from([
        ("GOOGLE_VERTEX_PROJECT".into(), "vertex-project".into()),
        ("GOOGLE_CLOUD_PROJECT".into(), "cloud-project".into()),
        ("GCP_PROJECT".into(), "gcp-project".into()),
        ("GCLOUD_PROJECT".into(), "gcloud-project".into()),
        ("GOOGLE_VERTEX_LOCATION".into(), "vertex-location".into()),
        ("GOOGLE_CLOUD_LOCATION".into(), "cloud-location".into()),
        ("VERTEX_LOCATION".into(), "location".into()),
    ]);
    assert_eq!(
        google_vertex_shared::project(Some("explicit"), &environment).as_deref(),
        Some("explicit")
    );
    assert_eq!(
        google_vertex_shared::location(Some("explicit"), &environment, "global"),
        "explicit"
    );
    for (key, expected) in [
        ("GOOGLE_VERTEX_PROJECT", "vertex-project"),
        ("GOOGLE_CLOUD_PROJECT", "cloud-project"),
        ("GCP_PROJECT", "gcp-project"),
        ("GCLOUD_PROJECT", "gcloud-project"),
    ] {
        assert_eq!(
            google_vertex_shared::project(None, &environment).as_deref(),
            Some(expected)
        );
        environment.remove(key);
    }
    assert_eq!(google_vertex_shared::project(None, &environment), None);
    for (key, expected) in [
        ("GOOGLE_VERTEX_LOCATION", "vertex-location"),
        ("GOOGLE_CLOUD_LOCATION", "cloud-location"),
        ("VERTEX_LOCATION", "location"),
    ] {
        assert_eq!(
            google_vertex_shared::location(None, &environment, "global"),
            expected
        );
        environment.remove(key);
    }
    assert_eq!(
        google_vertex_shared::location(None, &environment, "global"),
        "global"
    );
    assert_eq!(
        google_vertex_shared::location(Some(""), &environment, "global"),
        ""
    );
}

#[test]
fn vertex_chat_and_responses_reuse_merged_openai_protocols() {
    for responses in [false, true] {
        let route = if responses {
            ycoding_ai::google_vertex_responses::route(oauth(Some("eu")))
        } else {
            ycoding_ai::google_vertex_chat::route(oauth(Some("eu")))
        }
        .unwrap();
        let id = if responses {
            "xai/grok-4.20-reasoning"
        } else {
            "deepseek-ai/deepseek-v3.2-maas"
        };
        let mut request = Request::new(route.model(id));
        request.messages.push(Message::user("Say hello."));
        let prepared = route.prepare(&request).unwrap();
        assert_eq!(
            prepared.url.as_str(),
            format!(
                "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/eu/endpoints/openapi/{}",
                if responses {
                    "responses"
                } else {
                    "chat/completions"
                }
            )
        );
        assert_eq!(prepared.headers["authorization"], "Bearer vertex-token");
        assert_eq!(
            route.id,
            if responses {
                "google-vertex-responses"
            } else {
                "google-vertex-chat"
            }
        );
        assert_eq!(route.provider.0.as_str(), Some("google-vertex"));
        assert_eq!(route.provider_metadata_key.as_deref(), Some("openai"));
        assert_eq!(
            route.protocol.id(),
            if responses {
                "openai-responses"
            } else {
                "openai-chat"
            }
        );
        let expected = if responses {
            r#"{"model":"xai/grok-4.20-reasoning","input":[{"role":"user","content":[{"type":"input_text","text":"Say hello."}]}],"store":false,"stream":true}"#
        } else {
            r#"{"model":"deepseek-ai/deepseek-v3.2-maas","messages":[{"role":"user","content":"Say hello."}],"stream":true,"stream_options":{"include_usage":true}}"#
        };
        assert_eq!(prepared.encoded_body, expected);
        let mut parser = route.protocol.parser(&request.resolved());
        let frames = if responses {
            vec![
                r#"{"type":"response.output_text.delta","item_id":"msg_1","delta":"Hello."}"#,
                r#"{"type":"response.completed","response":{"id":"resp_1"}}"#,
            ]
        } else {
            vec![
                r#"{"choices":[{"index":0,"delta":{"content":"Hello."},"finish_reason":null}]}"#,
                r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
            ]
        };
        let mut events = Vec::new();
        for frame in frames {
            events.extend(parser.push(&parse_json(frame).unwrap()).unwrap());
        }
        events.extend(parser.finish().unwrap());
        assert_eq!(
            ycoding_ai::llm::Response::from_events(events)
                .unwrap()
                .text()
                .as_str(),
            Some("Hello.")
        );
        let config = Config {
            api_key: Some(Secret::new("fixture")),
            ..oauth(None)
        };
        let error = if responses {
            ycoding_ai::google_vertex_responses::route(config)
        } else {
            ycoding_ai::google_vertex_chat::route(config)
        }
        .err()
        .unwrap();
        assert!(error.message.contains(if responses {
            "Responses does not support API keys"
        } else {
            "Chat does not support API keys"
        }));
        let config = Config {
            base_url: Some("https://proxy.test/v1".into()),
            project: None,
            ..oauth(None)
        };
        let route = if responses {
            ycoding_ai::google_vertex_responses::route(config)
        } else {
            ycoding_ai::google_vertex_chat::route(config)
        }
        .unwrap();
        assert_eq!(route.endpoint.base_url, "https://proxy.test/v1");
    }
}

#[test]
fn upstream_credential_owner_can_refresh_custom_auth_between_requests() {
    let credential = std::sync::Arc::new(std::sync::Mutex::new(Credential::value("first-token")));
    let current = credential.clone();
    let model = google_vertex::model(
        "gemini-2.5-flash",
        Config {
            project: Some("vertex-project".into()),
            auth: Some(Auth::custom(move |input| {
                Auth::bearer(current.lock().unwrap().clone()).apply(input)
            })),
            ..Default::default()
        },
    )
    .unwrap();
    let request = Request::new(model);
    assert_eq!(
        request.model.route.prepare(&request).unwrap().headers["authorization"],
        "Bearer first-token"
    );
    *credential.lock().unwrap() = Credential::value("second-token");
    assert_eq!(
        request.model.route.prepare(&request).unwrap().headers["authorization"],
        "Bearer second-token"
    );
    let error = google_vertex::model(
        "gemini",
        Config {
            project: Some("vertex-project".into()),
            ..Default::default()
        },
    )
    .err()
    .unwrap();
    assert_eq!(
        error.authentication_kind,
        Some(ycoding_ai::provider_error::AuthenticationKind::Missing)
    );
}
