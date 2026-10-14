use ycoding_ai::{
    auth::{Auth, Credential},
    cache::Policy,
    llm::{Message, Request},
    providers::{self, Api, Config, OpenAIConfig, OpenRouterConfig, Profile, Transport},
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
        for field in [
            r#""store":true"#,
            "reasoning.encrypted_content",
            r#""context":"all_turns""#,
            "context_management",
            r#""verbosity":"low""#,
        ] {
            assert!(body.contains(field));
        }
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
        let body = stringify_json(&prepare(model).body);
        for field in [
            "prompt_cache_options",
            "prompt_cache_retention",
            "context_management",
            "prompt_cache_breakpoint",
        ] {
            assert!(!body.contains(field));
        }
    }
}

#[test]
fn kept_compatible_profiles_preserve_provider_and_endpoint() {
    for profile in [Profile::Meta, Profile::Openrouter] {
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
fn openrouter_is_stateless_and_coordinates_cache_and_reasoning() {
    let mut common = config();
    common.defaults.provider_options=Some(parse_json(r#"{"openai":{"promptCacheOptions":{"mode":"implicit","ttl":"30m"}},"openrouter":{"reasoning":{"summary":"detailed"},"usage":true,"prompt_cache_key":"key","session_id":"session"}}"#).unwrap());
    let mut request = Request::new(providers::openrouter(
        "openai/gpt-5.6",
        OpenRouterConfig {
            common: common.clone(),
            reasoning: Some(parse_json(r#"{"effort":"high"}"#).unwrap()),
        },
    ));
    request.messages = vec![Message::user("fixed")];
    let body = stringify_json(&request.model.route.prepare(&request).unwrap().body);
    for field in ["\"store\"", "previous_response_id", "prompt_cache_options"] {
        assert!(!body.contains(field));
    }
    for field in [
        "reasoning.encrypted_content",
        r#""effort":"high""#,
        r#""summary":"detailed""#,
        r#""session_id":"session""#,
    ] {
        assert!(body.contains(field));
    }
    let mut suffix = Message::user("volatile");
    suffix.volatile = true;
    request.messages.push(suffix);
    assert!(
        stringify_json(&request.model.route.prepare(&request).unwrap().body)
            .contains(r#""prompt_cache_options":{"mode":"explicit","ttl":"30m"}"#)
    );
    for options in [
        r#"{"openai":{"store":true}}"#,
        r#"{"openai":{"previous_response_id":"resp"}}"#,
    ] {
        request.provider_options = Some(parse_json(options).unwrap());
        assert!(request.model.route.prepare(&request).is_err());
    }
    let mut request = Request::new(providers::openrouter(
        "~anthropic/claude-sonnet-4.6",
        OpenRouterConfig {
            common,
            reasoning: None,
        },
    ));
    request.cache = Policy::Explicit {
        tools: true,
        system: true,
        messages: None,
        ttl_seconds: Some(3600.0),
    };
    assert!(
        stringify_json(&request.model.route.prepare(&request).unwrap().body)
            .contains(r#""cache_control":{"type":"ephemeral","ttl":"1h"}"#)
    );
}
