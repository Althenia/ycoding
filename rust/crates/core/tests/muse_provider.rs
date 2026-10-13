#[path = "support/muse.rs"]
mod fixture;
#[path = "support/muse_inference.rs"]
mod inference_fixture;
use fixture::{Fixture, header, row, secret, store};
use inference_fixture::{json, model};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_ai::{
    llm::{self, Request},
    muse::Runtime,
    route::Executor,
};
use ycoding_core::resources::{
    auth::{self, Client, DeviceFlow, Poll, Status},
    catalog::Catalog,
    muse,
};
use ycoding_schema::{DomainEncode, credential, integration, parse_json, provider};

fn oauth(expires: i64, access: &str) -> ycoding_schema::credential::Value {
    use ycoding_schema::DomainDecode;
    ycoding_schema::credential::Value::decode(&ycoding_schema::parse_json(&format!(r#"{{"type":"oauth","methodID":"device","access":"{access}","refresh":"","expires":{expires}}}"#)).unwrap()).unwrap()
}

fn device(interval: serde_json::Value, complete: bool, expires: i64) -> String {
    let mut value = serde_json::json!({"device_code":"device-fixture","user_code":"CODE","verification_uri":"https://auth.meta.com/device","expires_in":expires,"interval":interval});
    if complete {
        value["verification_uri_complete"] = "https://auth.meta.com/device?code=CODE".into();
    }
    value.to_string()
}

#[tokio::test]
async fn device_form_immediate_poll_optional_tokens_expiry() {
    let fixture = Fixture::new(vec![(200, device(2.into(), true, 600)), (200, r#"{"access_token":"account-token","refresh_token":"optional-refresh","expires_in":60}"#.into())]).await;
    let mut attempt = Client::new(&fixture.base, "fixture")
        .unwrap()
        .start_device(DeviceFlow::Muse, 0)
        .await
        .unwrap();
    assert_eq!(attempt.url(), "https://auth.meta.com/device?code=CODE");
    assert_eq!(attempt.instructions(), "Enter code: CODE");
    let Poll::Complete(secret) = attempt.poll(0).await.unwrap() else {
        panic!()
    };
    let credential::Value::OAuth(value) = secret.domain().unwrap() else {
        panic!()
    };
    assert_eq!(value.access, "account-token".into());
    assert_eq!(value.refresh, "optional-refresh".into());
    assert_eq!(value.expires.get(), 60000);
    let requests = fixture.finish().await;
    assert!(requests[0].starts_with("POST /oidc/device/authorization/ "));
    assert!(requests[1].starts_with("POST /oidc/device/token/ "));
    for r in &requests {
        assert_eq!(header(r, "accept"), Some("application/json"));
        assert_eq!(
            header(r, "content-type"),
            Some("application/x-www-form-urlencoded")
        );
    }
    assert_eq!(
        requests[0].split_once("\r\n\r\n").unwrap().1,
        "client_id=1031625952748946"
    );
    let form: BTreeMap<_, _> =
        url::form_urlencoded::parse(requests[1].split_once("\r\n\r\n").unwrap().1.as_bytes())
            .into_owned()
            .collect();
    assert_eq!(
        form["grant_type"],
        "urn:ietf:params:oauth:grant-type:device_code"
    );
    assert_eq!(form["device_code"], "device-fixture");
    assert_eq!(form["client_id"], "1031625952748946");
}

#[tokio::test]
async fn device_pending_slow_down_default_interval_and_unknown_expiry() {
    for interval in [
        serde_json::json!(0),
        serde_json::json!("invalid"),
        serde_json::Value::Null,
    ] {
        let fixture = Fixture::new(vec![
            (200, device(interval, false, 600)),
            (400, r#"{"error":"authorization_pending"}"#.into()),
            (400, r#"{"error":"slow_down"}"#.into()),
            (200, r#"{"access_token":"account-token"}"#.into()),
        ])
        .await;
        let mut attempt = Client::new(&fixture.base, "fixture")
            .unwrap()
            .start_device(DeviceFlow::Muse, 0)
            .await
            .unwrap();
        assert_eq!(attempt.url(), "https://auth.meta.com/device");
        assert_eq!(attempt.poll(0).await.unwrap(), Poll::WaitUntil(5000));
        assert_eq!(attempt.poll(4999).await.unwrap(), Poll::WaitUntil(5000));
        assert_eq!(attempt.poll(5000).await.unwrap(), Poll::WaitUntil(15000));
        assert_eq!(attempt.poll(14999).await.unwrap(), Poll::WaitUntil(15000));
        let Poll::Complete(secret) = attempt.poll(15000).await.unwrap() else {
            panic!()
        };
        let credential::Value::OAuth(value) = secret.domain().unwrap() else {
            panic!()
        };
        assert_eq!(value.refresh, "".into());
        assert_eq!(value.expires.get(), 0);
        assert_eq!(fixture.finish().await.len(), 4);
    }
}

#[tokio::test]
async fn device_terminal_errors_and_local_deadline() {
    for (error, status) in [
        (Some("access_denied"), Status::Denied),
        (Some("expired_token"), Status::Expired),
        (Some("invalid_grant"), Status::Failed),
        (None, Status::Failed),
    ] {
        let fixture = Fixture::new(vec![
            (200, device(2.into(), false, 600)),
            (
                400,
                serde_json::json!({"error":error,"error_description":"private@example.invalid"})
                    .to_string(),
            ),
        ])
        .await;
        let mut attempt = Client::new(&fixture.base, "fixture")
            .unwrap()
            .start_device(DeviceFlow::Muse, 0)
            .await
            .unwrap();
        let failure = attempt.poll(0).await.unwrap_err();
        assert_eq!(attempt.status(), status);
        assert!(!format!("{failure:?} {failure}").contains("private"));
        fixture.finish().await;
    }
    let fixture = Fixture::new(vec![
        (200, device(2.into(), false, 1)),
        (400, r#"{"error":"authorization_pending"}"#.into()),
    ])
    .await;
    let mut attempt = Client::new(&fixture.base, "fixture")
        .unwrap()
        .start_device(DeviceFlow::Muse, 0)
        .await
        .unwrap();
    assert_eq!(attempt.poll(0).await.unwrap(), Poll::WaitUntil(1000));
    assert!(attempt.poll(2000).await.is_err());
    assert_eq!(attempt.status(), Status::Expired);
    assert_eq!(fixture.finish().await.len(), 2);
}

#[tokio::test]
async fn registers_subscription_key_env_without_network_or_models() {
    let (_store, credentials) = store();
    let registry = auth::integration::Registry::new(credentials.clone(), BTreeMap::new());
    let registration = registry
        .transform(|draft| auth::muse::builtin(draft, "fixture").unwrap())
        .unwrap();
    let integration = registry.get(&"muse".into()).unwrap().unwrap();
    assert_eq!(integration.name, "Muse (Meta)".into());
    assert!(
        matches!(&integration.methods[0], integration::Method::OAuth(v) if v.id.as_lossless() == &"device".into() && v.remote == Some(true))
    );
    assert!(
        matches!(&integration.methods[1], integration::Method::Key(v) if v.label == Some("Meta Model API key".into()))
    );
    assert!(
        matches!(&integration.methods[2], integration::Method::Env(v) if v.names == vec![ycoding_schema::LosslessString::from("META_API_KEY")])
    );
    let mut catalog = Catalog::default();
    let mut service = muse::Service::new(Runtime::new("http://127.0.0.1:1/key".into()).unwrap());
    assert!(
        service
            .reconcile(&mut catalog, &credentials, &BTreeMap::new(), 0)
            .await
            .unwrap()
    );
    let provider = catalog.provider(&provider::Id("muse".into())).unwrap();
    assert_eq!(provider.name, "Muse (Meta)".into());
    assert_eq!(provider.package, "aisdk:@ai-sdk/openai".into());
    assert!(catalog.providers[0].models.is_empty());
    assert!(
        !service
            .reconcile(&mut catalog, &credentials, &BTreeMap::new(), 0)
            .await
            .unwrap()
    );
    drop(registration);
    registry.shutdown().await.unwrap();
}

#[test]
fn catalog_metadata_limits_filter_defaults_variants_and_privacy() {
    let valid = row("muse-wonder-1.0");
    let mut rows = vec![valid.clone()];
    for (key, value) in [
        ("limit", serde_json::Value::Null),
        ("limit", serde_json::json!({"context":1.5,"output":128000})),
        (
            "limit",
            serde_json::json!({"context":1007997,"output":"128000"}),
        ),
        ("is_hidden", true.into()),
        ("tool_call", false.into()),
        (
            "modalities",
            serde_json::json!({"input":["text"],"output":["image"]}),
        ),
    ] {
        let mut row = valid.clone();
        row["metadata"]["muse-code"][key] = value;
        rows.push(row);
    }
    let mut fallback = row("fallback");
    let metadata = fallback["metadata"]["muse-code"].as_object_mut().unwrap();
    for key in ["name", "variants", "options"] {
        metadata.remove(key);
    }
    rows.push(fallback);
    let loaded = muse::models(
        &parse_json(&serde_json::json!({"data":rows}).to_string()).unwrap(),
        "https://api.meta.ai/v1",
    )
    .unwrap();
    assert_eq!(loaded.skipped, 6);
    assert_eq!(loaded.models.len(), 2);
    let first = &loaded.models[0];
    assert_eq!(first.name, "Muse Wonder".into());
    assert_eq!(first.family, Some("muse-wonder".into()));
    assert_eq!(first.time.released.get(), 1788307200000.0);
    assert_eq!(
        (first.limit.context.get(), first.limit.output.get()),
        (1007997, 128000)
    );
    assert_eq!(
        first.capabilities.input,
        vec![ycoding_schema::LosslessString::from("text"), "image".into()]
    );
    assert!(first.capabilities.tools);
    assert_eq!(
        first.capabilities.output,
        vec![ycoding_schema::LosslessString::from("text")]
    );
    assert!(first.cost.is_empty());
    let settings = first.settings.as_ref().unwrap().encode();
    let settings: serde_json::Value =
        serde_json::from_str(&ycoding_schema::stringify_json(&settings)).unwrap();
    assert_eq!(settings["store"], false);
    assert_eq!(settings["reasoningEffort"], "high");
    assert_eq!(settings["reasoningSummary"], "auto");
    assert_eq!(
        settings["include"],
        serde_json::json!(["reasoning.encrypted_content"])
    );
    assert!(settings.get("temperature").is_none());
    assert!(settings.get("top_p").is_none());
    let efforts: Vec<_> = first
        .variants
        .iter()
        .map(|v| {
            (
                v.id.as_str().unwrap(),
                v.settings
                    .as_ref()
                    .unwrap()
                    .0
                    .get(&"reasoningEffort".into())
                    .unwrap()
                    .clone(),
            )
        })
        .collect();
    assert_eq!(efforts.len(), 6);
    for id in ["minimal", "low", "medium", "high", "xhigh", "max"] {
        assert!(efforts.contains(&(id, serde_value(id))));
    }
    assert_eq!(loaded.models[1].name, "fallback".into());
    assert!(loaded.models[1].variants.is_empty());
    assert!(
        loaded.models[1]
            .settings
            .as_ref()
            .unwrap()
            .0
            .get(&"reasoningEffort".into())
            .is_none()
    );
}
fn serde_value(v: &str) -> ycoding_schema::JsonValue {
    ycoding_schema::JsonValue::String(v.into())
}

#[tokio::test]
async fn mint_request_discovery_and_private_malformed_errors() {
    let fixture = Fixture::new(vec![(200, r#"{"api_key":"minted-key","base_url":"{{base}}/v1","require_payment":false,"is_subs_active":true,"action_url":null,"user_email":"private@example.invalid"}"#.into()), (200, serde_json::json!({"data":[row("muse-wonder-1.0")]}).to_string())]).await;
    let runtime = Runtime::new(format!("{}/muse-code/key", fixture.base)).unwrap();
    let connection = ycoding_ai::muse::Connection::oauth(
        runtime,
        "cred:1".into(),
        "meta-access".into(),
        0,
        "profile".into(),
    );
    let key = connection.key_for(0).await.unwrap();
    let discovered = muse::models(&connection.discover(0).await.unwrap(), &key.base_url).unwrap();
    assert_eq!(discovered.models.len(), 1);
    let requests = fixture.finish().await;
    assert!(requests[0].starts_with("POST /muse-code/key "));
    assert_eq!(
        header(&requests[0], "authorization"),
        Some("Bearer meta-access")
    );
    assert_eq!(header(&requests[0], "x-api-version"), Some("1.0.0"));
    assert_eq!(json(&requests[0]), serde_json::json!({"onboard":false}));
    assert!(requests[1].starts_with("GET /muse-code/models "));
    assert_eq!(
        header(&requests[1], "authorization"),
        Some("Bearer minted-key")
    );
    assert_eq!(header(&requests[1], "x-client-id"), Some("tbh:exec"));
    let fixture = Fixture::new(vec![(200, r#"{"api_key":123,"base_url":"https://api.meta.ai/v1","user_full_name":"Synthetic account","user_email":"private@example.invalid"}"#.into())]).await;
    let connection = ycoding_ai::muse::Connection::oauth(
        Runtime::new(format!("{}/key", fixture.base)).unwrap(),
        "id".into(),
        "account".into(),
        0,
        "profile".into(),
    );
    let failure = connection.key_for(0).await.unwrap_err();
    assert!(failure.message.contains("invalid response"));
    assert!(!format!("{failure:?}").contains("Synthetic"));
    assert!(!format!("{failure:?}").contains("private"));
    fixture.finish().await;
}

#[tokio::test]
async fn mint_payment_missing_fields_rejected_and_expired_no_refresh() {
    for fields in [
        serde_json::json!({"require_payment":true}),
        serde_json::json!({"is_subs_active":false}),
        serde_json::json!({}),
        serde_json::json!({"api_key":"key"}),
        serde_json::json!({"base_url":"https://api.meta.ai/v1"}),
    ] {
        let payment =
            fields.get("require_payment").is_some() || fields.get("is_subs_active").is_some();
        let body = if payment {
            let mut body = serde_json::json!({"api_key":"key","base_url":"https://api.meta.ai/v1","action_url":"https://meta.ai/subscribe"});
            body.as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            body
        } else {
            fields
        };
        let fixture = Fixture::new(vec![(200, body.to_string())]).await;
        let connection = ycoding_ai::muse::Connection::oauth(
            Runtime::new(format!("{}/key", fixture.base)).unwrap(),
            "id".into(),
            "account".into(),
            0,
            "profile".into(),
        );
        let failure = connection.key_for(0).await.unwrap_err();
        assert!(failure.message.contains(if payment {
            "subscription/payment setup is required"
        } else {
            "missing api_key or base_url"
        }));
        if payment {
            assert!(failure.message.contains("https://meta.ai/subscribe"));
        }
        fixture.finish().await;
    }
    for status in [401, 403] {
        let fixture = Fixture::new(vec![(status, "{}".into())]).await;
        let runtime = Runtime::new(format!("{}/key", fixture.base)).unwrap();
        let connection = ycoding_ai::muse::Connection::oauth(
            runtime.clone(),
            "id".into(),
            "account".into(),
            0,
            "profile".into(),
        );
        assert!(
            connection
                .key_for(2)
                .await
                .unwrap_err()
                .message
                .contains("/connect")
        );
        let expired = ycoding_ai::muse::Connection::oauth(
            runtime,
            "expired".into(),
            "account".into(),
            1,
            "profile".into(),
        );
        assert!(
            expired
                .key_for(2)
                .await
                .unwrap_err()
                .message
                .contains("log in again")
        );
        assert_eq!(fixture.finish().await.len(), 1);
    }
}

#[tokio::test]
async fn catalog_environment_and_profile_inventories_reconciliation_retention() {
    let first_body = serde_json::json!({"data":[row("first-model")]}).to_string();
    let second_body = serde_json::json!({"data":[row("second-model")]}).to_string();
    let fixture = Fixture::new(vec![
        (200, first_body.clone()),
        (200, first_body.clone()),
        (200, second_body.clone()),
        (500, "{}".into()),
        (500, "{}".into()),
    ])
    .await;
    let (_store, credentials) = store();
    let mut catalog = Catalog::default();
    let mut service = muse::Service::new(Runtime::new("http://127.0.0.1:1/key".into()).unwrap())
        .with_base_url(format!("{}/v1", fixture.base));
    let env = BTreeMap::from([("META_API_KEY".into(), "environment-key".into())]);
    service
        .reconcile(&mut catalog, &credentials, &env, 0)
        .await
        .unwrap();
    assert_eq!(catalog.providers[0].models[0].id, "first-model".into());
    let first = credentials
        .create(
            "first".into(),
            "muse".into(),
            Some("First".into()),
            secret(r#"{"type":"key","key":"first"}"#),
            1,
        )
        .await
        .unwrap();
    let second = credentials
        .create(
            "second".into(),
            "muse".into(),
            Some("Second".into()),
            secret(r#"{"type":"key","key":"second"}"#),
            2,
        )
        .await
        .unwrap();
    service
        .reconcile(&mut catalog, &credentials, &env, 2)
        .await
        .unwrap();
    let first_model = muse::models(&parse_json(&first_body).unwrap(), "https://api.meta.ai/v1")
        .unwrap()
        .models
        .remove(0);
    let second_model = muse::models(&parse_json(&second_body).unwrap(), "https://api.meta.ai/v1")
        .unwrap()
        .models
        .remove(0);
    assert!(catalog.for_connection(&first_model, Some(&first)).is_some());
    assert!(
        catalog
            .for_connection(&first_model, Some(&second))
            .is_none()
    );
    assert!(
        catalog
            .for_connection(&second_model, Some(&second))
            .is_some()
    );
    credentials
        .update(first.id().clone(), Some("Renamed".into()), None, 3)
        .await
        .unwrap();
    service
        .refresh(&mut catalog, &credentials, &env, 3)
        .await
        .unwrap();
    assert!(service.source().is_none());
    assert!(catalog.for_connection(&first_model, Some(&first)).is_some());
    let requests = fixture.finish().await;
    assert_eq!(
        requests
            .iter()
            .map(|r| header(r, "authorization").unwrap())
            .collect::<Vec<_>>(),
        [
            "Bearer environment-key",
            "Bearer first",
            "Bearer second",
            "Bearer first",
            "Bearer second"
        ]
    );
}

#[tokio::test]
async fn responses_catalog_wire_full_reasoning_replay_and_bounded_remint() {
    for failure in ["never", "once", "always"] {
        let mut responses = vec![(
            200,
            r#"{"api_key":"minted-1","base_url":"{{base}}/v1"}"#.into(),
        )];
        if failure != "never" {
            responses.extend([
                (401, "{}".into()),
                (
                    200,
                    r#"{"api_key":"minted-2","base_url":"{{base}}/v1"}"#.into(),
                ),
            ]);
        }
        responses.push(if failure == "always" {
            (401, "{}".into())
        } else {
            (200, inference_fixture::inference())
        });
        if failure != "always" {
            responses.push((200, inference_fixture::inference()));
        }
        let fixture = Fixture::new(responses).await;
        let (_store, credentials) = store();
        let saved = credentials
            .create(
                "cred".into(),
                "muse".into(),
                None,
                ycoding_store::resources::Secret::new(oauth(0, "account").encode()).unwrap(),
                1,
            )
            .await
            .unwrap();
        let runtime = Runtime::new(format!("{}/muse-code/key", fixture.base)).unwrap();
        let info = ycoding_core::resources::model::with_variant(
            model("https://api.meta.ai/v1"),
            Some(&"low".into()),
        )
        .unwrap();
        let model =
            muse::from_catalog_model(&info, Some(&oauth(0, "account")), Some(&saved), runtime)
                .unwrap();
        assert_eq!(model.route.provider_metadata_key.as_deref(), Some("openai"));
        let mut request = Request::new(model);
        request.messages = vec![llm::Message::user("Hello")];
        request.provider_options =
            Some(parse_json(r#"{"openai":{"promptCacheKey":"session-cache"}}"#).unwrap());
        let executor = Executor::new(Executor::http_client().unwrap());
        let result = executor.generate(&request).await;
        if failure == "always" {
            assert!(
                result
                    .as_ref()
                    .unwrap_err()
                    .message
                    .contains("log in again")
            );
        }
        if failure != "always" {
            let result = result.unwrap();
            assert_eq!(result.text().as_str(), Some("Hello こんにちは"));
            assert_eq!(result.reasoning().as_str(), Some("Thought"));
            assert!(result.message.content.iter().any(|p| matches!(p, llm::Part::Reasoning(p) if p.text == "Thought".into() && p.provider_metadata.is_some())));
            request
                .messages
                .extend([result.message, llm::Message::user("Continue")]);
            executor.generate(&request).await.unwrap();
        }
        let requests = fixture.finish().await;
        let inference: Vec<_> = requests
            .iter()
            .filter(|r| r.starts_with("POST /v1/responses "))
            .collect();
        assert_eq!(inference.len(), if failure == "once" { 3 } else { 2 });
        assert_eq!(
            requests
                .iter()
                .filter(|r| r.starts_with("POST /muse-code/key "))
                .count(),
            if failure == "never" { 1 } else { 2 }
        );
        let session = header(inference[0], "x-tbh-session-id").unwrap();
        assert_eq!(session.len(), 36);
        assert_eq!(session.as_bytes()[14], b'4');
        for request in &inference {
            assert_eq!(header(request, "x-client-id"), Some("tbh:exec"));
            assert_eq!(header(request, "x-tbh-session-id"), Some(session));
            assert_eq!(
                header(request, "x-meta-ai-gateway-session-id"),
                Some(session)
            );
            let body = json(request);
            assert_eq!(body["store"], false);
            assert_eq!(
                body["reasoning"],
                serde_json::json!({"effort":"low","summary":"auto"})
            );
            assert_eq!(
                body["include"],
                serde_json::json!(["reasoning.encrypted_content"])
            );
            assert_eq!(body["prompt_cache_key"], "session-cache");
            assert!(body.get("previous_response_id").is_none());
        }
        assert_eq!(
            header(inference[0], "authorization"),
            Some("Bearer minted-1")
        );
        assert_eq!(
            header(inference.last().unwrap(), "authorization"),
            Some(if failure == "never" {
                "Bearer minted-1"
            } else {
                "Bearer minted-2"
            })
        );
        if failure != "always" {
            assert!(
                json(inference.last().unwrap())["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v["type"] == "reasoning"
                        && v["encrypted_content"] == "encrypted-fixture")
            );
        }
    }
}

#[tokio::test]
async fn lazy_mint_shared_concurrent_models_and_credential_generation() {
    let fixture = Fixture::new(vec![
        (
            200,
            r#"{"api_key":"key-1","base_url":"{{base}}/v1"}"#.into(),
        ),
        (200, inference_fixture::inference()),
        (200, inference_fixture::inference()),
        (
            200,
            r#"{"api_key":"key-2","base_url":"{{base}}/v1"}"#.into(),
        ),
        (200, inference_fixture::inference()),
    ])
    .await;
    let (_store, credentials) = store();
    let saved = credentials
        .create(
            "cred".into(),
            "muse".into(),
            None,
            ycoding_store::resources::Secret::new(oauth(0, "account").encode()).unwrap(),
            1,
        )
        .await
        .unwrap();
    let runtime = Runtime::new(format!("{}/key", fixture.base)).unwrap();
    let first = muse::from_catalog_model(
        &model("https://api.meta.ai/v1"),
        Some(&oauth(0, "account")),
        Some(&saved),
        runtime.clone(),
    )
    .unwrap();
    let mut info = model("https://api.meta.ai/v1");
    info.id = "alias".into();
    info.model_id = "alias".into();
    let second = muse::from_catalog_model(
        &info,
        Some(&oauth(0, "account")),
        Some(&saved),
        runtime.clone(),
    )
    .unwrap();
    let executor = Arc::new(Executor::new(Executor::http_client().unwrap()));
    let first = Request::new(first);
    let second = Request::new(second);
    let (a, b) = tokio::join!(executor.generate(&first), executor.generate(&second));
    a.unwrap();
    b.unwrap();
    credentials
        .update(
            saved.id().clone(),
            None,
            Some(
                ycoding_store::resources::Secret::new(oauth(0, "replacement-access").encode())
                    .unwrap(),
            ),
            2,
        )
        .await
        .unwrap();
    let updated = credentials.get(saved.id()).unwrap().unwrap();
    let third = muse::from_catalog_model(
        &info,
        Some(&oauth(0, "replacement-access")),
        Some(&updated),
        runtime,
    )
    .unwrap();
    executor.generate(&Request::new(third)).await.unwrap();
    let requests = fixture.finish().await;
    assert_eq!(requests.len(), 5);
    assert_eq!(
        header(&requests[0], "authorization"),
        Some("Bearer account")
    );
    assert_eq!(
        header(&requests[3], "authorization"),
        Some("Bearer replacement-access")
    );
}
