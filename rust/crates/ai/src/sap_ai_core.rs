use crate::{
    Error,
    auth::{Auth, Credential, Secret},
    json::{self, get, s},
    llm::{Defaults, Event, Model, Request},
    openai_chat::OpenAIChat,
    provider_error::{Failure, classify},
    route::{Protocol, Route, StreamParser},
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{JsonValue, LosslessString, parse_json, provider};

pub struct Config {
    pub service_key: Option<Secret>,
    pub deployment_id: Option<String>,
    pub resource_group: Option<String>,
    pub environment: BTreeMap<String, String>,
    pub defaults: Defaults,
}
pub async fn model(
    client: &reqwest::Client,
    id: impl Into<LosslessString>,
    config: Config,
) -> Result<Model, Error> {
    let key = config
        .environment
        .get("AICORE_SERVICE_KEY")
        .map(|value| Secret::new(value.clone()))
        .or(config.service_key)
        .ok_or_else(|| Error::invalid("SAP AI Core requires a service key"))?;
    let key = parse_json(key.expose())
        .map_err(|_| Error::invalid("Invalid SAP AI Core service key JSON"))?;
    let field = |name| {
        get(&key, name).and_then(json::text).filter(|value| !value.is_empty()).ok_or_else(|| Error::invalid("SAP AI Core service key requires clientid, clientsecret, url and serviceurls.AI_API_URL"))
    };
    let url = field("url")?;
    let client_id = field("clientid")?;
    let client_secret = field("clientsecret")?;
    let api_url = get(&key, "serviceurls")
        .and_then(|value| get(value, "AI_API_URL"))
        .and_then(json::text)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::invalid("SAP AI Core service key is missing AI_API_URL"))?;
    let deployment = config
        .environment
        .get("AICORE_DEPLOYMENT_ID")
        .cloned()
        .or(config.deployment_id)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            Error::invalid("SAP AI Core requires an explicit orchestration deploymentId")
        })?;
    if deployment
        .bytes()
        .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'-' | b'_'))
    {
        return Err(Error::invalid("Invalid SAP AI Core deploymentId"));
    }
    let group = config
        .environment
        .get("AICORE_RESOURCE_GROUP")
        .cloned()
        .or(config.resource_group)
        .unwrap_or_else(|| "default".into());
    let response = client
        .post(format!("{}/oauth/token", url.trim_end_matches('/')))
        .basic_auth(client_id, Some(client_secret))
        .header("content-type", "application/x-www-form-urlencoded")
        .body("grant_type=client_credentials")
        .send()
        .await
        .map_err(|_| Error::output("SAP AI Core OAuth transport failed"))?;
    if !response.status().is_success() {
        return Err(classify(Failure {
            message: "SAP AI Core OAuth exchange failed".into(),
            status: Some(response.status().as_u16()),
            ..Default::default()
        }));
    }
    let body = response
        .text()
        .await
        .map_err(|_| Error::output("SAP AI Core OAuth response failed"))?;
    let body = parse_json(&body).map_err(|_| Error::output("Invalid SAP AI Core OAuth JSON"))?;
    let token = get(&body, "access_token")
        .and_then(json::text)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::output("Missing SAP AI Core OAuth access token"))?;
    let mut route = Route::openai_chat();
    route.id = "sap-ai-core-orchestration".into();
    route.provider = provider::Id("sap-ai-core".into());
    route.protocol = Arc::new(Orchestration);
    route.endpoint.base_url = format!(
        "{}/v2/inference/deployments/{deployment}",
        api_url.trim_end_matches('/')
    );
    route.endpoint.path = "/v2/completion".into();
    route.auth = Auth::bearer(Credential::value(token));
    route.headers.insert("AI-Resource-Group".into(), group);
    route.defaults = config.defaults;
    Ok(route.model(id))
}
struct Orchestration;
impl Protocol for Orchestration {
    fn id(&self) -> &'static str {
        "sap-orchestration-v2"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        let chat = OpenAIChat.lower(request)?;
        let mut prompt = json::object([(
            "template",
            get(&chat, "messages")
                .cloned()
                .unwrap_or_else(|| JsonValue::Array(Vec::new())),
        )]);
        for key in ["tools", "response_format"] {
            if let Some(value) = get(&chat, key) {
                json::set(&mut prompt, key, value.clone());
            }
        }
        let mut params = json::remove(
            &chat,
            &["model", "messages", "tools", "response_format", "stream"],
        );
        if let Some(value) = request.generation.top_k {
            json::set(&mut params, "top_k", JsonValue::Number(value));
        }
        let options = request
            .provider_options
            .as_ref()
            .and_then(|value| get(value, "sap-ai"));
        if let Some(values) = options.and_then(|value| get(value, "modelParams")) {
            params = json::merge(&params, values);
        }
        let mut model = json::object([("name", s(request.model.id.clone())), ("params", params)]);
        if let Some(version) = options.and_then(|value| get(value, "modelVersion")) {
            json::set(&mut model, "version", version.clone());
        }
        let mut modules = json::object([(
            "prompt_templating",
            json::object([("prompt", prompt), ("model", model)]),
        )]);
        for key in ["masking", "filtering", "grounding", "translation"] {
            if let Some(value) = options.and_then(|value| get(value, key)) {
                json::set(&mut modules, key, value.clone());
            }
        }
        Ok(json::object([(
            "config",
            json::object([
                ("modules", modules),
                ("stream", json::object([("enabled", JsonValue::Bool(true))])),
            ]),
        )]))
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Box::new(Parser {
            inner: OpenAIChat.parser(request),
        })
    }
}
struct Parser {
    inner: Box<dyn StreamParser>,
}
impl StreamParser for Parser {
    fn push(&mut self, event: &JsonValue) -> Result<Vec<Event>, Error> {
        if get(event, "error").is_some() {
            return Err(Error::output("SAP orchestration stream reported an error"));
        }
        if let Some(result) = get(event, "final_result") {
            return self.inner.push(result);
        }
        if get(event, "intermediate_results").is_some() || get(event, "request_id").is_some() {
            return Ok(Vec::new());
        }
        Err(Error::output("Invalid SAP orchestration stream envelope"))
    }
    fn finish(&mut self) -> Result<Vec<Event>, Error> {
        self.inner.finish()
    }
}
