use super::{
    Client, Error,
    integration::{Authorization, Draft, OAuthImplementation},
    now,
};
use serde_json::{Value, json};
use std::{fmt, sync::Arc, time::Duration};
use ycoding_schema::{
    DomainEncode, JsonObject, JsonValue, credential, integration,
    integration_id::IntegrationMethodId,
};
use ycoding_store::resources::Secret;

pub const SCOPES: &str = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";

#[derive(Clone, PartialEq)]
pub struct OAuthClient {
    id: String,
    secret: String,
}
impl fmt::Debug for OAuthClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AntigravityOAuthClient([redacted])")
    }
}
impl OAuthClient {
    pub fn new(id: &str, secret: Option<&str>) -> Option<Self> {
        let secret = secret.filter(|secret| !secret.is_empty())?;
        (!id.is_empty()).then(|| Self {
            id: id.into(),
            secret: secret.into(),
        })
    }
    pub fn embedded() -> Option<Self> {
        Self::new(
            option_env!("YCODING_ANTIGRAVITY_CLIENT_ID")?,
            option_env!("YCODING_ANTIGRAVITY_CLIENT_SECRET"),
        )
    }
    pub(super) fn id(&self) -> &str {
        &self.id
    }
    pub(super) fn form<'a>(&'a self, extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
        let mut pairs = vec![
            ("client_id", self.id.as_str()),
            ("client_secret", self.secret.as_str()),
        ];
        pairs.extend_from_slice(extra);
        pairs
    }
}

pub fn register(draft: &mut Draft, client: Client) {
    draft.update("antigravity".into(), |reference| {
        reference.name = "Antigravity".into()
    });
    let authorize_client = client.clone();
    let refresh_client = client;
    draft.oauth(OAuthImplementation {
        integration: "antigravity".into(),
        method: integration::OAuthMethod {
            id: IntegrationMethodId::new("google").expect("static method"),
            label: "Google account (Antigravity subscription)".into(),
            prompts: None,
            remote: None,
        },
        authorize: Arc::new(move |_| {
            let client = authorize_client.clone();
            Box::pin(async move {
                let mut attempt = client.start_browser("antigravity", "google", None).await?;
                Ok(Authorization::automatic(
                    attempt.url().into(),
                    "Complete Google sign-in in your browser. This window will close automatically.".into(),
                    Box::pin(async move {
                        let secret = attempt.wait().await?;
                        Ok(with_project(secret).await)
                    }),
                    None,
                    None,
                ))
            })
        }),
        refresh: Some(Arc::new(move |value| {
            let client = refresh_client.clone();
            Box::pin(async move { client.refresh_antigravity(value, now()?).await })
        })),
        label: None,
    });
}

async fn with_project(secret: Secret) -> Secret {
    let Ok(credential::Value::OAuth(mut value)) = secret.domain() else {
        return secret;
    };
    let Some(access) = value.access.as_str().map(str::to_owned) else {
        return secret;
    };
    let project = tokio::time::timeout(
        Duration::from_secs(60),
        discover_project(ycoding_ai::antigravity::BASE_URL, &access),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .flatten();
    let Some(project) = project else {
        return secret;
    };
    let mut metadata = value.metadata.take().unwrap_or_else(JsonObject::new);
    metadata.insert("projectID".into(), JsonValue::String(project.into()));
    value.metadata = Some(metadata);
    Secret::new(credential::Value::OAuth(value).encode()).unwrap_or(secret)
}

async fn api_post(
    http: &reqwest::Client,
    base_url: &str,
    access: &str,
    action: &str,
    body: Value,
    onboard: bool,
) -> Result<Value, Error> {
    let agent = ycoding_ai::antigravity::user_agent();
    let request = http
        .post(format!(
            "{}/v1internal:{action}",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(access)
        .header("Accept", "application/json")
        .header(
            "User-Agent",
            if onboard {
                format!("{agent} google-api-nodejs-client/10.3.0")
            } else {
                agent
            },
        )
        .header("Content-Type", "application/json")
        .body(body.to_string());
    let response = request.send().await.map_err(|_| Error::UnknownOutcome)?;
    if !response.status().is_success() {
        return Err(Error::Rejected);
    }
    let bytes = response.bytes().await.map_err(|_| Error::UnknownOutcome)?;
    serde_json::from_slice(&bytes).map_err(|_| Error::UnknownOutcome)
}
fn project_id(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(project)) if !project.is_empty() => Some(project.clone()),
        Some(value) => value
            .get("id")
            .and_then(Value::as_str)
            .filter(|project| !project.is_empty())
            .map(str::to_owned),
        None => None,
    }
}
pub async fn discover_project(base_url: &str, access: &str) -> Result<Option<String>, Error> {
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| Error::Rejected)?;
    let loaded = api_post(
        &http,
        base_url,
        access,
        "loadCodeAssist",
        json!({"metadata":{"ideType":"ANTIGRAVITY"}}),
        false,
    )
    .await?;
    if let Some(project) = project_id(loaded.get("cloudaicompanionProject")) {
        return Ok(Some(project));
    }
    let tiers = loaded
        .get("allowedTiers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tier = tiers
        .iter()
        .find(|tier| tier.get("isDefault") == Some(&Value::Bool(true)))
        .or_else(|| tiers.first())
        .and_then(|tier| tier.get("id"))
        .and_then(Value::as_str)
        .or_else(|| {
            loaded
                .get("currentTier")
                .and_then(|tier| tier.get("id"))
                .and_then(Value::as_str)
        })
        .unwrap_or("free-tier");
    for attempt in 0..15 {
        let onboarded = api_post(
            &http,
            base_url,
            access,
            "onboardUser",
            json!({"tier_id":tier,"metadata":{"ide_type":"ANTIGRAVITY","ide_version":ycoding_ai::antigravity::CLIENT_VERSION,"ide_name":"antigravity"}}),
            true,
        )
        .await?;
        if onboarded.get("done") == Some(&Value::Bool(true)) {
            return Ok(project_id(
                onboarded
                    .get("response")
                    .and_then(|response| response.get("cloudaicompanionProject")),
            ));
        }
        if attempt + 1 < 15 {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
    Ok(None)
}
