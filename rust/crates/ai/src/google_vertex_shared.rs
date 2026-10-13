use crate::{
    Error,
    auth::{Auth, Credential, Secret},
    json,
    llm::Defaults,
    provider_error::{AuthenticationKind, Reason},
    providers::Api,
    route::Route,
};
use std::collections::BTreeMap;
use ycoding_schema::provider;

#[derive(Clone, Default)]
pub struct Config {
    pub api_key: Option<Secret>,
    pub access_token: Option<Credential>,
    pub auth: Option<Auth>,
    pub base_url: Option<String>,
    pub project: Option<String>,
    pub location: Option<String>,
    pub defaults: Defaults,
}
pub fn project(value: Option<&str>, environment: &BTreeMap<String, String>) -> Option<String> {
    value.map(String::from).or_else(|| {
        [
            "GOOGLE_VERTEX_PROJECT",
            "GOOGLE_CLOUD_PROJECT",
            "GCP_PROJECT",
            "GCLOUD_PROJECT",
        ]
        .iter()
        .find_map(|key| environment.get(*key).cloned())
    })
}
pub fn location(
    value: Option<&str>,
    environment: &BTreeMap<String, String>,
    fallback: &str,
) -> String {
    value
        .map(String::from)
        .or_else(|| {
            [
                "GOOGLE_VERTEX_LOCATION",
                "GOOGLE_CLOUD_LOCATION",
                "VERTEX_LOCATION",
            ]
            .iter()
            .find_map(|key| environment.get(*key).cloned())
        })
        .unwrap_or_else(|| fallback.into())
}
pub fn host(location: &str) -> String {
    match location {
        "global" => "aiplatform.googleapis.com".into(),
        "eu" | "us" => format!("aiplatform.{location}.rep.googleapis.com"),
        _ => format!("{location}-aiplatform.googleapis.com"),
    }
}
pub(crate) fn require_project(config: &Config) -> Result<&str, Error> {
    config
        .project
        .as_deref()
        .filter(|project| !project.is_empty())
        .ok_or_else(|| {
            Error::invalid("Google Vertex requires a project when baseURL is not configured")
        })
}
pub(crate) fn auth(config: &Config, api: Option<&str>) -> Result<Auth, Error> {
    if let Some(api) = api
        && config.api_key.is_some()
    {
        return Err(Error::invalid(format!(
            "Google Vertex {api} does not support API keys"
        )));
    }
    if config.api_key.is_some() && (config.access_token.is_some() || config.auth.is_some()) {
        return Err(Error::invalid(
            "Google Vertex apiKey cannot be combined with accessToken or auth",
        ));
    }
    if config.access_token.is_some() && config.auth.is_some() {
        return Err(Error::invalid(
            "Google Vertex accessToken cannot be combined with auth",
        ));
    }
    if let Some(auth) = &config.auth {
        return Ok(auth.clone());
    }
    if let Some(token) = &config.access_token {
        return Ok(Auth::bearer(token.clone()));
    }
    if let Some(key) = &config.api_key {
        return Ok(Auth::header(
            "x-goog-api-key",
            Credential::resolved(None, key.clone()),
        ));
    }
    Err(Error {
        authentication_kind: Some(AuthenticationKind::Missing),
        ..Error::new(
            Reason::Authentication,
            "Missing resolved Google Application Default Credentials",
        )
    })
}

pub(crate) fn openai_route(config: Config, api: Api) -> Result<Route, Error> {
    let label = match api {
        Api::Chat => "Chat",
        Api::Responses => "Responses",
    };
    let auth = auth(&config, Some(label))?;
    let location = config.location.as_deref().unwrap_or("global");
    let base_url = match &config.base_url {
        Some(base_url) => base_url.clone(),
        None => format!(
            "https://aiplatform.googleapis.com/v1/projects/{}/locations/{location}/endpoints/openapi",
            require_project(&config)?
        ),
    };
    let mut route = match api {
        Api::Chat => Route::openai_chat(),
        Api::Responses => Route::openai_responses(),
    };
    route.id = match api {
        Api::Chat => "google-vertex-chat",
        Api::Responses => "google-vertex-responses",
    }
    .into();
    route.provider = provider::Id("google-vertex".into());
    route.endpoint.base_url = base_url;
    route.auth = auth;
    let provider_options = route
        .defaults
        .provider_options
        .as_ref()
        .map(|defaults| {
            json::merge(
                defaults,
                config
                    .defaults
                    .provider_options
                    .as_ref()
                    .unwrap_or(&json::empty()),
            )
        })
        .or(config.defaults.provider_options.clone());
    route.defaults = config.defaults;
    route.defaults.provider_options = provider_options;
    Ok(route)
}
