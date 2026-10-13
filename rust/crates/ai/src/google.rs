use crate::{
    auth::{Auth, Credential},
    framing::Framing,
    gemini::Gemini,
    llm::Defaults,
    route::{Endpoint, Route, Transport},
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::provider;

#[derive(Clone, Default)]
pub struct Config {
    pub api_key: Option<Credential>,
    pub auth: Option<Auth>,
    pub base_url: Option<String>,
    pub defaults: Defaults,
}
pub fn route(config: Config) -> Route {
    Route {
        id: "gemini".into(),
        provider: provider::Id("google".into()),
        provider_metadata_key: Some("google".into()),
        protocol: Arc::new(Gemini),
        endpoint: Endpoint {
            dynamic_path: Some(Arc::new(|request, _| {
                format!(
                    "/models/{}:streamGenerateContent?alt=sse",
                    request.model.id.as_str().unwrap_or("")
                )
            })),
            ..Endpoint::new(
                config
                    .base_url
                    .unwrap_or_else(|| crate::gemini::DEFAULT_BASE_URL.into()),
                "",
            )
        },
        auth: config.auth.unwrap_or_else(|| {
            Auth::header(
                "x-goog-api-key",
                config.api_key.unwrap_or_else(|| Credential::value("")),
            )
        }),
        transport: Transport::Http(Framing::Sse),
        headers: BTreeMap::new(),
        defaults: config.defaults,
    }
}
