use crate::{
    Error,
    auth::{Auth, Credential},
    json::{self, get},
    llm::{Model, Request},
    openai_chat::OpenAIChat,
    providers::{self, Api, Config},
    route::{Protocol, StreamParser},
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{JsonValue, LosslessString, parse_json, provider};

pub fn model(
    id: impl Into<LosslessString>,
    mut config: Config,
    token: Option<Credential>,
    environment: &BTreeMap<String, String>,
) -> Result<Model, Error> {
    let token = ["SNOWFLAKE_CORTEX_TOKEN", "SNOWFLAKE_CORTEX_PAT"]
        .iter()
        .find_map(|name| environment.get(*name))
        .map(|token| Credential::value(token.clone()))
        .or(token);
    if let Some(token) = token {
        config.auth = Auth::bearer(token);
    }
    let mut model = providers::compatible(
        id,
        provider::Id("snowflake-cortex".into()),
        config,
        Api::Chat,
    )?;
    let route = Arc::make_mut(&mut model.route);
    route.id = "snowflake-cortex".into();
    route.protocol = Arc::new(Cortex);
    Ok(model)
}
pub fn conversation_complete(status: u16, body: &str) -> bool {
    if status != 400 {
        return false;
    }
    let Ok(value) = parse_json(body) else {
        return false;
    };
    let message = get(&value, "message")
        .filter(|value| crate::openai_shared::truthy(value))
        .or_else(|| get(&value, "error"));
    message.is_some_and(|value| {
        json::js_string(value)
            .as_str()
            .is_some_and(|text| text.to_lowercase().contains("conversation complete"))
    })
}
pub struct Cortex;
impl Protocol for Cortex {
    fn id(&self) -> &'static str {
        "snowflake-cortex"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        let body = OpenAIChat.lower(request)?;
        let max = get(&body, "max_tokens").cloned();
        let mut body = json::remove(&body, &["max_tokens"]);
        if let Some(max) = max {
            json::set(&mut body, "max_completion_tokens", max);
        }
        Ok(body)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        OpenAIChat.parser(request)
    }
}
