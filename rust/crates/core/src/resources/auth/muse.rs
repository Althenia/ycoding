use super::{
    Client, DeviceFlow, Error, drive_device,
    integration::{Authorization, Draft, OAuthImplementation},
    now,
};
use std::sync::Arc;
use ycoding_schema::{integration, integration_id::IntegrationMethodId};

pub const CLIENT_ID: &str = "1031625952748946";

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
