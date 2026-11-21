use crate::{
    Error,
    auth::{Auth, Credential},
    json,
    llm::{Defaults, Model, Request},
    openai_chat::OpenAIChat,
    provider_error::{Failure, classify},
    providers::Api,
    route::{Protocol, Route, StreamParser},
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{JsonValue, provider};

pub struct Config {
    pub instance_url: String,
    pub api_key: Credential,
    pub ai_gateway_url: String,
    pub ai_gateway_headers: BTreeMap<String, String>,
    pub feature_flags: BTreeMap<String, bool>,
    pub defaults: Defaults,
}
impl Config {
    pub fn new(api_key: Credential) -> Self {
        Self {
            instance_url: "https://gitlab.com".into(),
            api_key,
            ai_gateway_url: "https://cloud.gitlab.com".into(),
            ai_gateway_headers: BTreeMap::from([(
                "anthropic-beta".into(),
                "context-1m-2025-08-07".into(),
            )]),
            feature_flags: BTreeMap::from([
                ("DuoAgentPlatformNext".into(), true),
                ("duo_agent_platform_agentic_chat".into(), true),
                ("duo_agent_platform".into(), true),
            ]),
            defaults: Defaults::default(),
        }
    }
}
pub async fn model(client: &reqwest::Client, id: &str, config: Config) -> Result<Model, Error> {
    let (wire_id, api) = mapping(id).ok_or_else(|| Error::invalid("Unsupported GitLab model: workflow transport requires the Duo Workflow Service adapter"))?;
    let headers = Auth::bearer(config.api_key).apply(crate::auth::Input {
        method: "POST",
        url: "",
        body: "",
        headers: reqwest::header::HeaderMap::new(),
    })?;
    let flags = config
        .feature_flags
        .into_iter()
        .map(|(name, value)| (name, JsonValue::Bool(value)));
    let response = client
        .post(format!(
            "{}/api/v4/ai/third_party_agents/direct_access",
            config.instance_url.trim_end_matches('/')
        ))
        .headers(headers)
        .header("content-type", "application/json")
        .body(ycoding_schema::stringify_json(&json::object([(
            "feature_flags",
            json::object(flags),
        )])))
        .send()
        .await
        .map_err(|_| Error::output("GitLab token exchange transport failed"))?;
    if !response.status().is_success() {
        return Err(classify(Failure {
            message: "GitLab token exchange failed".into(),
            status: Some(response.status().as_u16()),
            ..Default::default()
        }));
    }
    let body = response
        .text()
        .await
        .map_err(|_| Error::output("GitLab token exchange body failed"))?;
    let body = ycoding_schema::parse_json(&body)
        .map_err(|_| Error::output("Invalid GitLab direct access JSON"))?;
    let token = json::get(&body, "token")
        .and_then(json::text)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::output("Missing GitLab direct access token"))?;
    let mut route = match api {
        None => Route::anthropic(),
        Some(Api::Chat) => Route::openai_chat(),
        Some(Api::Responses) => Route::openai_responses(),
    };
    route.endpoint.base_url = format!(
        "{}/ai/v1/proxy/{}",
        config.ai_gateway_url.trim_end_matches('/'),
        if api.is_none() {
            "anthropic"
        } else {
            "openai/v1"
        }
    );
    route.auth = Auth::Remove("x-api-key".into()).and_then(Auth::bearer(Credential::value(token)));
    if let Some(JsonValue::Object(headers)) = json::get(&body, "headers") {
        for (name, value) in headers.iter() {
            if let (Some(name), Some(value)) = (name.as_str(), json::text(value))
                && !name.eq_ignore_ascii_case("x-api-key")
                && !name.eq_ignore_ascii_case("authorization")
            {
                route.headers.insert(name.into(), value.into());
            }
        }
    }
    route.headers.extend(config.ai_gateway_headers);
    route.provider = provider::Id("gitlab".into());
    route.id = "gitlab-agentic".into();
    route.defaults = config.defaults;
    route.defaults.generation.max_tokens.get_or_insert(8192.0);
    if api == Some(Api::Chat) {
        route.protocol = Arc::new(GitLabChat);
    }
    Ok(route.model(wire_id))
}
struct GitLabChat;
impl Protocol for GitLabChat {
    fn id(&self) -> &'static str {
        "gitlab-openai-chat"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        let mut body = OpenAIChat.lower(request)?;
        body = json::remove(&body, &["max_tokens"]);
        json::set(
            &mut body,
            "max_completion_tokens",
            JsonValue::Number(request.generation.max_tokens.unwrap_or(8192.0)),
        );
        if request.tool_choice == Some(crate::llm::ToolChoice::None) {
            body = json::remove(&body, &["tools", "tool_choice"]);
        }
        Ok(body)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        OpenAIChat.parser(request)
    }
}
fn mapping(id: &str) -> Option<(&'static str, Option<Api>)> {
    Some(match id {
        "duo-chat-fable-5" => ("claude-fable-5", None),
        "duo-chat-opus-4-8" => ("claude-opus-4-8", None),
        "duo-chat-opus-4-7" => ("claude-opus-4-7", None),
        "duo-chat-opus-4-6" => ("claude-opus-4-6", None),
        "duo-chat-sonnet-5" => ("claude-sonnet-5", None),
        "duo-chat-sonnet-4-6" => ("claude-sonnet-4-6", None),
        "duo-chat-opus-4-5" => ("claude-opus-4-5-20251101", None),
        "duo-chat-sonnet-4-5" => ("claude-sonnet-4-5-20250929", None),
        "duo-chat-haiku-4-5" => ("claude-haiku-4-5-20251001", None),
        "duo-chat-gpt-5-1" => ("gpt-5.1-2025-11-13", Some(Api::Chat)),
        "duo-chat-gpt-5-2" => ("gpt-5.2-2025-12-11", Some(Api::Chat)),
        "duo-chat-gpt-5-4" => ("gpt-5.4-2026-03-05", Some(Api::Chat)),
        "duo-chat-gpt-5-5" => ("gpt-5.5-2026-04-23", Some(Api::Chat)),
        "duo-chat-gpt-5-mini" => ("gpt-5-mini-2025-08-07", Some(Api::Chat)),
        "duo-chat-gpt-5-4-mini" => ("gpt-5.4-mini", Some(Api::Chat)),
        "duo-chat-gpt-5-4-nano" => ("gpt-5.4-nano", Some(Api::Chat)),
        "duo-chat-gpt-5-6-sol" => ("gpt-5.6-sol", Some(Api::Responses)),
        "duo-chat-gpt-5-6-terra" => ("gpt-5.6-terra", Some(Api::Responses)),
        "duo-chat-gpt-5-6-luna" => ("gpt-5.6-luna", Some(Api::Responses)),
        "duo-chat-gpt-5-codex" => ("gpt-5-codex", Some(Api::Responses)),
        "duo-chat-gpt-5-2-codex" => ("gpt-5.2-codex", Some(Api::Responses)),
        "duo-chat-gpt-5-3-codex" => ("gpt-5.3-codex", Some(Api::Responses)),
        _ => return None,
    })
}
