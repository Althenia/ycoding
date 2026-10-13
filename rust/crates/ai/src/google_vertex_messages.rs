use crate::{
    Error,
    anthropic::AnthropicMessages,
    google_vertex_shared::{self, Config},
    json,
    llm::Request,
    route::{Endpoint, Protocol, Route, StreamParser},
};
use std::sync::Arc;
use ycoding_schema::{JsonValue, provider};

pub fn route(config: Config) -> Result<Route, Error> {
    let auth = google_vertex_shared::auth(&config, Some("Messages"))?;
    let location = config.location.as_deref().unwrap_or("global");
    let base_url = match &config.base_url {
        Some(base_url) => {
            google_vertex_shared::expand_template(base_url, config.project.as_deref(), location)
        }
        None => format!(
            "https://{}/v1/projects/{}/locations/{location}/publishers/anthropic/models",
            google_vertex_shared::host(location),
            google_vertex_shared::require_project(&config)?
        ),
    };
    let mut route = Route::anthropic();
    route.id = "google-vertex-messages".into();
    route.provider = provider::Id("google-vertex-anthropic".into());
    route.protocol = Arc::new(VertexMessages);
    route.endpoint = Endpoint {
        dynamic_path: Some(Arc::new(|request, _| {
            format!(
                "/{}:streamRawPredict",
                request.model.id.as_str().unwrap_or("").trim()
            )
        })),
        ..Endpoint::new(base_url, "")
    };
    route.headers.clear();
    route.auth = auth;
    route.defaults = config.defaults;
    Ok(route)
}
struct VertexMessages;
impl Protocol for VertexMessages {
    fn id(&self) -> &'static str {
        "anthropic-messages"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        let mut body = json::remove(&AnthropicMessages.lower(request)?, &["model"]);
        json::set(&mut body, "anthropic_version", json::s("vertex-2023-10-16"));
        Ok(body)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        Box::new(AnthropicMessages::parser(request))
    }
}
