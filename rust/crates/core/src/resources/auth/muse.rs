use super::{
    Client, DeviceFlow, Error, drive_device,
    integration::{Authorization, Draft, OAuthImplementation},
    now,
};
use std::{fmt, sync::Arc};
use ycoding_schema::{integration, integration_id::IntegrationMethodId};

pub const USER_AGENT: &str = "muse-code/launcher-3";

#[derive(Clone, PartialEq)]
pub struct OAuthClient {
    id: String,
    secret: Option<String>,
}
impl fmt::Debug for OAuthClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MuseOAuthClient([redacted])")
    }
}
impl OAuthClient {
    pub fn new(id: &str, secret: Option<&str>) -> Option<Self> {
        (!id.is_empty()).then(|| Self {
            id: id.into(),
            secret: secret
                .filter(|secret| !secret.is_empty())
                .map(str::to_owned),
        })
    }
    pub fn embedded() -> Option<Self> {
        Self::new(
            option_env!("YCODING_MUSE_CLIENT_ID")?,
            option_env!("YCODING_MUSE_CLIENT_SECRET"),
        )
    }
    pub(super) fn form<'a>(&'a self, extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
        let mut pairs = vec![("client_id", self.id.as_str())];
        if let Some(secret) = &self.secret {
            pairs.push(("client_secret", secret.as_str()));
        }
        pairs.extend_from_slice(extra);
        pairs
    }
}

pub fn register(draft: &mut Draft, client: Client) {
    draft.update("muse".into(), |reference| {
        reference.name = "Muse (Meta)".into()
    });
    draft.oauth(OAuthImplementation {
        integration: "muse".into(),
        method: integration::OAuthMethod {
            id: IntegrationMethodId::new("device").expect("static method"),
            label: "Meta Muse Code account".into(),
            prompts: None,
            remote: Some(true),
        },
        authorize: Arc::new(move |_| {
            let client = client.clone();
            Box::pin(async move {
                let mut attempt = client.start_device(DeviceFlow::Muse, now()?).await?;
                let expires = attempt.expires_at();
                Ok(Authorization::automatic(
                    attempt.url().into(),
                    attempt.instructions().into(),
                    Box::pin(async move { drive_device(&mut attempt).await }),
                    None,
                    Some(expires),
                ))
            })
        }),
        refresh: None,
        label: None,
    });
    draft.method(
        "muse".into(),
        integration::Method::Key(integration::KeyMethod {
            label: Some("Meta Model API key".into()),
        }),
    );
    draft.method(
        "muse".into(),
        integration::Method::Env(integration::EnvMethod {
            names: vec!["META_API_KEY".into()],
        }),
    );
}

pub fn builtin(draft: &mut Draft, version: &str) -> Result<(), Error> {
    register(draft, Client::provider("muse", version)?);
    Ok(())
}
