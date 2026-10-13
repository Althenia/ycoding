use crate::{
    Error, google,
    google_vertex_shared::{self, Config},
    llm::Model,
};
use std::sync::Arc;
use ycoding_schema::{LosslessString, provider};

pub fn model(id: impl Into<LosslessString>, config: Config) -> Result<Model, Error> {
    let id = id.into();
    let id = id
        .as_str()
        .map(|id| LosslessString::from(id.trim()))
        .unwrap_or(id);
    let auth = google_vertex_shared::auth(&config, None)?;
    let endpoint_model = id.as_str().is_some_and(|id| id.starts_with("endpoints/"));
    if config.api_key.is_some() && endpoint_model {
        return Err(Error::invalid(
            "Google Vertex tuned models do not support Express Mode API keys",
        ));
    }
    let location = config.location.as_deref().unwrap_or("us-central1");
    let base_url = match &config.base_url {
        Some(base_url) => {
            google_vertex_shared::expand_template(base_url, config.project.as_deref(), location)
        }
        None if config
            .api_key
            .as_ref()
            .is_some_and(|key| !key.expose().is_empty()) =>
        {
            "https://aiplatform.googleapis.com/v1/publishers/google".into()
        }
        None => format!(
            "https://{}/v1beta1/projects/{}/locations/{location}{}",
            google_vertex_shared::host(location),
            google_vertex_shared::require_project(&config)?,
            if endpoint_model {
                ""
            } else {
                "/publishers/google"
            }
        ),
    };
    let mut route = google::route(google::Config {
        auth: Some(auth),
        base_url: Some(base_url),
        defaults: config.defaults,
        ..Default::default()
    });
    route.id = "google-vertex-gemini".into();
    route.provider = provider::Id("google-vertex".into());
    route.endpoint.dynamic_path = Some(Arc::new(|request, _| {
        let id = request.model.id.as_str().unwrap_or("");
        format!(
            "/{}:streamGenerateContent?alt=sse",
            if id.starts_with("endpoints/") {
                id.to_owned()
            } else {
                format!("models/{id}")
            }
        )
    }));
    Ok(route.model(id))
}
