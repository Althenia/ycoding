use super::{
    filesystem::{object, optional_number, string},
    http_body,
};
use crate::tools::{
    context::{Context, policy::LeafPolicy},
    registry::{Failure, Tool, ToolFuture},
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    JsonValue, LosslessString, ObjectEncoder,
    llm::{ToolContent, ToolTextContent},
    parse_json,
};

pub const NO_RESULTS: &str = "No search results found. Please try a different query.";
pub const EXA_URL: &str = "https://mcp.exa.ai/mcp";
pub const PARALLEL_URL: &str = "https://search.parallel.ai/mcp";
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Exa,
    Parallel,
}
impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exa => "exa",
            Self::Parallel => "parallel",
        }
    }
}
#[derive(Default)]
pub struct Config {
    pub provider: Option<Provider>,
    pub enable_exa: bool,
    pub enable_parallel: bool,
    pub exa_api_key: Option<String>,
    pub parallel_api_key: Option<String>,
}
impl Config {
    pub fn from_environment(environment: &BTreeMap<String, String>) -> Self {
        let flag = |key: &str| {
            environment
                .get(key)
                .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true"))
        };
        Self {
            provider: environment
                .get("YCODING_WEBSEARCH_PROVIDER")
                .and_then(|value| match value.as_str() {
                    "exa" => Some(Provider::Exa),
                    "parallel" => Some(Provider::Parallel),
                    _ => None,
                }),
            enable_exa: flag("YCODING_EXPERIMENTAL")
                || flag("YCODING_ENABLE_EXA")
                || flag("YCODING_EXPERIMENTAL_EXA"),
            enable_parallel: flag("YCODING_ENABLE_PARALLEL")
                || flag("YCODING_EXPERIMENTAL_PARALLEL"),
            exa_api_key: environment.get("EXA_API_KEY").cloned(),
            parallel_api_key: environment.get("PARALLEL_API_KEY").cloned(),
        }
    }
}
pub fn select_provider(session: &LosslessString, config: &Config) -> Provider {
    if let Some(provider) = config.provider {
        return provider;
    }
    if config.enable_parallel {
        return Provider::Parallel;
    }
    if config.enable_exa {
        return Provider::Exa;
    }
    let hash = if session.is_empty() {
        0
    } else {
        session.code_units().fold(0x811c9dc5u32, |hash, unit| {
            (hash ^ u32::from(unit)).wrapping_mul(0x01000193)
        })
    };
    if hash.is_multiple_of(2) {
        Provider::Exa
    } else {
        Provider::Parallel
    }
}
pub fn parse_response(body: &str) -> Result<Option<LosslessString>, Failure> {
    let trimmed = crate::resources::discovery::trim(body);
    if !trimmed.is_empty()
        && let Some(text) = payload(trimmed)?
    {
        return Ok(Some(text));
    }
    for line in body.split('\n') {
        if let Some(data) = line.strip_prefix("data: ")
            && let Some(text) = payload(data)?
        {
            return Ok(Some(text));
        }
    }
    Ok(None)
}
fn payload(payload: &str) -> Result<Option<LosslessString>, Failure> {
    let payload = crate::resources::discovery::trim(payload);
    if !payload.starts_with('{') {
        return Ok(None);
    }
    let payload = parse_json(payload).map_err(|_| Failure::message("Invalid MCP response"))?;
    let result = object(&payload)?
        .get(&"result".into())
        .ok_or_else(|| Failure::message("Invalid MCP response"))?;
    let content = object(result)?
        .get(&"content".into())
        .ok_or_else(|| Failure::message("Invalid MCP response"))?;
    let JsonValue::Array(content) = content else {
        return Err(Failure::message("Invalid MCP response"));
    };
    let content = content
        .iter()
        .map(|item| {
            let item = object(item)?;
            string(item, "type")?;
            string(item, "text")
        })
        .collect::<Result<Vec<_>, Failure>>()?;
    Ok(content.into_iter().find(|text| !text.is_empty()))
}

pub struct WebSearch {
    pub client: reqwest::Client,
    pub config: Config,
    pub policy: Arc<LeafPolicy>,
    pub exa_url: url::Url,
    pub parallel_url: url::Url,
    pub version: String,
    pub year: i32,
}
impl Tool for WebSearch {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition { name: name.into(), description: format!("Search the web using the session's local web search provider. Use this for current information beyond knowledge cutoff.\n\nThis is a provider-independent local tool backed by Exa or Parallel. Provider-hosted web search tools are separate and execute at the model provider.\n\nOptional controls support result count, live crawling ('fallback' or 'preferred'), search type ('auto', 'fast', or 'deep'), and maximum context characters.\n\nThe current year is {}. Use this year when searching for recent information or current events.", self.year).into(), input_schema: parse_json(r#"{"type":"object","properties":{"query":{"type":"string","description":"Websearch query"},"numResults":{"anyOf":[{"type":"integer","allOf":[{"exclusiveMinimum":0},{"maximum":20}]},{"type":"null"}],"description":"Number of search results to return (default: 8, maximum: 20)"},"livecrawl":{"anyOf":[{"type":"string","enum":["fallback","preferred"]},{"type":"null"}],"description":"Live crawl mode - 'fallback': use live crawling as backup if cached unavailable, 'preferred': prioritize live crawling (default: 'fallback')"},"type":{"anyOf":[{"type":"string","enum":["auto","fast","deep"]},{"type":"null"}],"description":"Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search"},"contextMaxCharacters":{"anyOf":[{"type":"integer","allOf":[{"exclusiveMinimum":0},{"maximum":50000}]},{"type":"null"}],"description":"Maximum characters for context string optimized for models (default: 10000, maximum: 50000)"}},"required":["query"],"additionalProperties":false}"#).unwrap(), output_schema: Some(parse_json(r#"{"type":"object","properties":{"provider":{"type":"string","enum":["exa","parallel"]},"text":{"type":"string"}},"required":["provider","text"],"additionalProperties":false}"#).unwrap()), cache: None, metadata: None, native: None }
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = object(&input)?;
            let query = string(input, "query")?;
            let num_results = optional_number(input, "numResults", 1.0, 20.0)?;
            let maximum = optional_number(input, "contextMaxCharacters", 1.0, 50_000.0)?;
            let mode = optional_enum(input, "type", &["auto", "fast", "deep"], "auto")?;
            let livecrawl =
                optional_enum(input, "livecrawl", &["fallback", "preferred"], "fallback")?;
            let provider = select_provider(context.session_id.as_lossless(), &self.config);
            let request = async {
                let mut metadata = ycoding_schema::JsonObject::new();
                for key in [
                    "query",
                    "numResults",
                    "livecrawl",
                    "type",
                    "contextMaxCharacters",
                ] {
                    if let Some(value) = input.get(&key.into()) {
                        metadata.insert(key.into(), value.clone());
                    }
                }
                metadata.insert(
                    "provider".into(),
                    JsonValue::String(provider.as_str().into()),
                );
                self.policy
                    .assert(
                        &context,
                        "websearch",
                        vec![query.clone()],
                        vec!["*".into()],
                        Some(metadata),
                    )
                    .await?;
                let mut endpoint = match provider {
                    Provider::Exa => self.exa_url.clone(),
                    Provider::Parallel => self.parallel_url.clone(),
                };
                let arguments = match provider {
                    Provider::Exa => {
                        if let Some(key) = &self.config.exa_api_key
                            && !key.is_empty()
                        {
                            endpoint.query_pairs_mut().append_pair("exaApiKey", key);
                        }
                        let mut arguments = ObjectEncoder::new()
                            .field("query", &query)
                            .field("type", mode)
                            .field("numResults", &num_results.unwrap_or(8.0))
                            .field("livecrawl", livecrawl);
                        if let Some(maximum) = maximum {
                            arguments = arguments.field("contextMaxCharacters", &maximum);
                        }
                        arguments.finish()
                    }
                    Provider::Parallel => ObjectEncoder::new()
                        .field("objective", &query)
                        .field("search_queries", &vec![query.clone()])
                        .field("session_id", &context.session_id)
                        .finish(),
                };
                let body = ObjectEncoder::new()
                    .field("jsonrpc", "2.0")
                    .field("id", &1.0)
                    .field("method", "tools/call")
                    .field(
                        "params",
                        &ObjectEncoder::new()
                            .field(
                                "name",
                                if provider == Provider::Exa {
                                    "web_search_exa"
                                } else {
                                    "web_search"
                                },
                            )
                            .field("arguments", &arguments)
                            .finish(),
                    )
                    .finish();
                let mut request = self
                    .client
                    .post(endpoint)
                    .header("Accept", "application/json, text/event-stream")
                    .header("Content-Type", "application/json")
                    .timeout(Duration::from_secs(25))
                    .body(ycoding_schema::stringify_json(&body));
                if provider == Provider::Parallel {
                    request = request.header("User-Agent", format!("ycoding/{}", self.version));
                    if let Some(key) = &self.config.parallel_api_key
                        && !key.is_empty()
                    {
                        request = request.bearer_auth(key);
                    }
                }
                let response = request
                    .send()
                    .await
                    .map_err(|_| Failure::message("Search transport failed"))?
                    .error_for_status()
                    .map_err(|_| Failure::message("Search response failed"))?;
                let bytes = http_body::collect(response, MAX_RESPONSE_BYTES)
                    .await
                    .map_err(|_| {
                        Failure::message("Search response exceeded its limit or failed")
                    })?;
                Ok::<_, Failure>(
                    parse_response(&String::from_utf8_lossy(&bytes))?
                        .unwrap_or_else(|| NO_RESULTS.into()),
                )
            };
            let text = tokio::select! { result = request => result.map_err(|error| match error { Failure::Cancelled | Failure::Defect(_) => error, _ => Failure::message(format!("Unable to search the web for {}", String::from_utf16_lossy(&query.code_units().collect::<Vec<_>>()))) })?, _ = context.cancellation.cancelled() => return Err(Failure::Cancelled) };
            Ok(ToolOutput {
                structured: ObjectEncoder::new()
                    .field("provider", provider.as_str())
                    .field("text", &text)
                    .finish(),
                content: vec![ToolContent::Text(ToolTextContent { text })],
            })
        })
    }
}
fn optional_enum<'a>(
    input: &'a ycoding_schema::JsonObject,
    key: &str,
    options: &[&str],
    default: &'a str,
) -> Result<&'a str, Failure> {
    match input.get(&key.into()) {
        None => Ok(default),
        Some(JsonValue::String(value))
            if value.as_str().is_some_and(|value| options.contains(&value)) =>
        {
            Ok(value.as_str().unwrap())
        }
        _ => Err(Failure::message(format!(
            "Invalid tool input: Invalid {key}"
        ))),
    }
}
