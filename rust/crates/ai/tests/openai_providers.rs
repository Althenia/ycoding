use std::collections::BTreeMap;
use ycoding_ai::{
    auth::{Auth, Credential},
    cache::Policy,
    llm::{Defaults, Message, Request},
    providers::{
        self, Api, AzureAuth, AzureConfig, AzureEndpoint, CloudflareEndpoint, Config, GatewayAuth,
        OpenAIConfig, OpenRouterConfig, Profile, Transport,
    },
};
use ycoding_schema::{parse_json, provider, stringify_json};

fn config() -> Config {
    Config::new(Auth::bearer(Credential::value("fixture-key")))
}
fn prepare(model: ycoding_ai::llm::Model) -> ycoding_ai::route::Prepared {
    let mut request = Request::new(model);
    request.messages = vec![Message::user("hello")];
    request.model.route.prepare(&request).unwrap()
}

#[test]
fn native_openai_and_compatible_defaults_are_distinct() {
    for transport in [Transport::Http, Transport::WebSocket] {
        let prepared = prepare(providers::openai(
            "gpt-5.6",
            OpenAIConfig {
                common: config(),
                organization: Some("fixture-org".into()),
                project: Some("fixture-project".into()),
                transport,
            },
        ));
        let body = stringify_json(&prepared.body);
        assert!(body.contains(r#""store":true"#));
        assert!(body.contains("reasoning.encrypted_content"));
        assert!(body.contains(r#""context":"all_turns""#));
        assert!(body.contains("context_management"));
        assert!(body.contains(r#""verbosity":"low""#));
        assert_eq!(prepared.headers["openai-organization"], "fixture-org");
        assert_eq!(prepared.headers["openai-project"], "fixture-project");
        assert_eq!(prepared.headers["authorization"], "Bearer fixture-key");
    }
    let mut common = config();
    common.base_url = Some("https://fixture.invalid/v1/".into());
    common.defaults.provider_options = Some(
        parse_json(
            r#"{"openai":{"promptCacheOptions":{"mode":"explicit"},"promptCacheRetention":"24h"}}"#,
        )
        .unwrap(),
    );
    for api in [Api::Chat, Api::Responses] {
        let model = providers::compatible(
            "gpt-5.6",
            provider::Id("fixture".into()),
            common.clone(),
            api,
        )
        .unwrap();
        assert_eq!(model.provider.0.as_str(), Some("fixture"));
        let prepared = prepare(model);
        let body = stringify_json(&prepared.body);
        assert!(!body.contains("prompt_cache_options"));
        assert!(!body.contains("prompt_cache_retention"));
        assert!(!body.contains("context_management"));
        assert!(!body.contains("prompt_cache_breakpoint"));
    }
}

#[test]
fn compatible_profiles_preserve_provider_and_endpoint() {
    for profile in [
        Profile::Baseten,
        Profile::Cerebras,
        Profile::Deepinfra,
        Profile::Deepseek,
        Profile::Fireworks,
        Profile::Groq,
        Profile::Meta,
        Profile::Openrouter,
        Profile::Togetherai,
        Profile::Xai,
    ] {
        let prepared =
            prepare(providers::compatible_profile("fixture-model", profile, config()).unwrap());
        let (provider, url) = profile.identity();
        assert_eq!(prepared.url.as_str(), format!("{url}/chat/completions"));
        assert_eq!(prepared.route, "openai-compatible-chat");
        assert_eq!(prepared.protocol, "openai-chat");
        assert_eq!(prepared.headers["authorization"], "Bearer fixture-key");
        assert!(stringify_json(&prepared.body).contains("fixture-model"));
        assert!(!provider.is_empty());
    }
}

#[test]
fn azure_query_auth_and_key_only_cache_contract() {
    for api in [Api::Chat, Api::Responses] {
        let mut defaults = Defaults::default();
        defaults
            .http
            .headers
            .insert("authorization".into(), "wrong-provider-token".into());
        defaults.provider_options=Some(parse_json(r#"{"openai":{"promptCacheOptions":{"mode":"explicit"},"promptCacheRetention":"24h","promptCacheKey":"namespace"}}"#).unwrap());
        let prepared = prepare(providers::azure(
            "gpt-5.6",
            AzureConfig {
                endpoint: AzureEndpoint::Resource(" fixture-resource ".into()),
                auth: AzureAuth::Key(Credential::value("fixture-azure")),
                api_version: Some("2026-01-01".into()),
                query: BTreeMap::from([("custom".into(), "a b".into())]),
                defaults,
            },
            api,
        ));
        assert!(
            prepared
                .url
                .as_str()
                .starts_with("https://fixture-resource.openai.azure.com/openai/v1/")
        );
        assert_eq!(prepared.headers["api-key"], "fixture-azure");
        assert!(!prepared.headers.contains_key("authorization"));
        assert!(
            prepared
                .url
                .query()
                .unwrap()
                .contains("api-version=2026-01-01")
        );
        let body = stringify_json(&prepared.body);
        assert!(body.contains("prompt_cache_key"));
        assert!(!body.contains("prompt_cache_options"));
        assert!(!body.contains("context_management"));
        assert!(!body.contains("prompt_cache_breakpoint"));
    }
}

#[test]
fn copilot_selection_and_cache_are_deployment_specific() {
    for (id, responses) in [
        ("gpt-5.6", true),
        ("gpt-6", true),
        ("gpt-5-mini", false),
        ("claude-opus-5", false),
        ("GPT-5.6", false),
    ] {
        assert_eq!(
            providers::copilot_uses_responses(&id.into(), None),
            responses
        );
    }
    let mut common = config();
    common.base_url = Some("https://fixture.invalid/copilot".into());
    common.defaults.provider_options=Some(parse_json(r#"{"openai":{"promptCacheOptions":{"mode":"explicit"},"promptCacheRetention":"24h","promptCacheKey":"namespace"}}"#).unwrap());
    for api in [Api::Chat, Api::Responses] {
        let model = providers::github_copilot("gpt-5.6", common.clone(), Some(api)).unwrap();
        let mut request = Request::new(model);
        request.messages = vec![
            Message::user("before"),
            Message::system("trusted"),
            Message::assistant(Vec::new()),
        ];
        let prepared = request.model.route.prepare(&request).unwrap();
        let body = stringify_json(&prepared.body);
        assert!(body.contains(r#""role":"system""#));
        assert!(!body.contains("system-update"));
        assert!(!body.contains("prompt_cache_options"));
        assert!(!body.contains("context_management"));
        assert!(body.contains("prompt_cache_key"));
    }
}

#[test]
fn cloudflare_encodes_account_and_supports_dual_auth() {
    let prepared = prepare(
        providers::cloudflare_gateway(
            "openai/fixture",
            CloudflareEndpoint::Gateway {
                account: "a/b".into(),
                gateway: Some("  ".into()),
            },
            GatewayAuth::Both {
                gateway: Credential::value("gateway-fixture"),
                upstream: Credential::value("upstream-fixture"),
            },
            Defaults::default(),
        )
        .unwrap(),
    );
    assert_eq!(
        prepared.url.as_str(),
        "https://gateway.ai.cloudflare.com/v1/a%2Fb/default/compat/chat/completions"
    );
    assert_eq!(
        prepared.headers["cf-aig-authorization"],
        "Bearer gateway-fixture"
    );
    assert_eq!(prepared.headers["authorization"], "Bearer upstream-fixture");
    assert!(prepared.headers["cf-aig-authorization"].is_sensitive());
    let prepared = prepare(
        providers::cloudflare_workers(
            "meta/fixture",
            CloudflareEndpoint::Workers {
                account: "a b".into(),
            },
            Auth::bearer(Credential::value("fixture")),
            Defaults::default(),
        )
        .unwrap(),
    );
    assert_eq!(
        prepared.url.as_str(),
        "https://api.cloudflare.com/client/v4/accounts/a%20b/ai/v1/chat/completions"
    );
}

#[test]
fn openrouter_is_stateless_and_coordinates_cache_and_reasoning() {
    let mut common = config();
    common.defaults.provider_options=Some(parse_json(r#"{"openai":{"promptCacheOptions":{"mode":"implicit","ttl":"30m"}},"openrouter":{"reasoning":{"summary":"detailed"},"usage":true,"prompt_cache_key":"key","session_id":"session"}}"#).unwrap());
    let model = providers::openrouter(
        "openai/gpt-5.6",
        OpenRouterConfig {
            common: common.clone(),
            reasoning: Some(parse_json(r#"{"effort":"high"}"#).unwrap()),
        },
    );
    let mut request = Request::new(model);
    request.messages = vec![Message::user("fixed")];
    let body = stringify_json(&request.model.route.prepare(&request).unwrap().body);
    assert!(!body.contains("\"store\""));
    assert!(!body.contains("previous_response_id"));
    assert!(!body.contains("prompt_cache_options"));
    assert!(body.contains("reasoning.encrypted_content"));
    assert!(body.contains(r#""effort":"high""#));
    assert!(body.contains(r#""summary":"detailed""#));
    assert!(body.contains("\"session_id\":\"session\""));
    let mut suffix = Message::user("volatile");
    suffix.volatile = true;
    request.messages.push(suffix);
    let body = stringify_json(&request.model.route.prepare(&request).unwrap().body);
    assert!(body.contains(r#""prompt_cache_options":{"mode":"explicit","ttl":"30m"}"#));
    request.provider_options = Some(parse_json(r#"{"openai":{"store":true}}"#).unwrap());
    assert!(request.model.route.prepare(&request).is_err());
    request.provider_options =
        Some(parse_json(r#"{"openai":{"previous_response_id":"resp"}}"#).unwrap());
    assert!(request.model.route.prepare(&request).is_err());
    let model = providers::openrouter(
        "~anthropic/claude-sonnet-4.6",
        OpenRouterConfig {
            common,
            reasoning: None,
        },
    );
    let mut request = Request::new(model);
    request.cache = Policy::Explicit {
        tools: true,
        system: true,
        messages: None,
        ttl_seconds: Some(3600.0),
    };
    let body = stringify_json(&request.model.route.prepare(&request).unwrap().body);
    assert!(body.contains(r#""cache_control":{"type":"ephemeral","ttl":"1h"}"#));
}
