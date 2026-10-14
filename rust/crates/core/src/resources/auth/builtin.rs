use super::{
    Client, DeviceFlow, Error, Preparation, claude, cursor,
    integration::{Authorization, Draft, OAuthImplementation},
    muse, now,
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{integration, integration_id::IntegrationMethodId};

impl Preparation {
    pub fn register(
        &self,
        draft: &mut Draft,
        environment: &BTreeMap<String, String>,
        claude: Option<&claude::Store>,
    ) -> Result<(), Error> {
        let client = self
            .clients
            .get("openai")
            .cloned()
            .map(Ok)
            .unwrap_or_else(|| Client::provider("openai", env!("CARGO_PKG_VERSION")))?;
        for (method, label, remote) in [
            ("chatgpt-browser", "ChatGPT Pro/Plus (browser)", false),
            ("chatgpt-headless", "ChatGPT Pro/Plus (headless)", true),
        ] {
            let login = client.clone();
            let refresh = client.clone();
            draft.oauth(OAuthImplementation {
                integration: "openai".into(),
                method: integration::OAuthMethod {
                    id: IntegrationMethodId::new(method).map_err(|_| Error::InvalidCredential)?,
                    label: label.into(),
                    prompts: None,
                    remote: remote.then_some(true),
                },
                authorize: Arc::new(move |_| {
                    let login = login.clone();
                    Box::pin(async move {
                        if method == "chatgpt-browser" {
                            let mut attempt = login.start_browser("openai", method, None).await?;
                            return Ok(Authorization::automatic(
                                attempt.url().into(),
                                "Complete authorization in your browser.".into(),
                                Box::pin(async move { attempt.wait().await }),
                                None,
                                None,
                            ));
                        }
                        let mut attempt = login.start_device(DeviceFlow::Openai, now()?).await?;
                        let expires = attempt.expires_at();
                        Ok(Authorization::automatic(
                            attempt.url().into(),
                            attempt.instructions().into(),
                            Box::pin(async move { super::drive_device(&mut attempt).await }),
                            None,
                            Some(expires),
                        ))
                    })
                }),
                refresh: Some(Arc::new(move |value| {
                    let refresh = refresh.clone();
                    Box::pin(async move {
                        let mut value = value;
                        value.method_id = IntegrationMethodId::new(method)
                            .map_err(|_| Error::InvalidCredential)?;
                        refresh.refresh("openai", value, now()?).await
                    })
                })),
                label: None,
            });
        }
        cursor::register(
            draft,
            self.clients
                .get("cursor")
                .cloned()
                .map(Ok)
                .unwrap_or_else(|| Client::provider("cursor", env!("CARGO_PKG_VERSION")))?,
            "https://cursor.com".into(),
        );
        muse::register(
            draft,
            self.clients
                .get("muse")
                .cloned()
                .map(Ok)
                .unwrap_or_else(|| Client::provider("muse", env!("CARGO_PKG_VERSION")))?,
        );
        if let Some(claude) = claude {
            draft.oauth(claude.implementation(vec!["claude".into()], environment.clone()));
        }
        for (id, name) in [
            ("anthropic", "ANTHROPIC_API_KEY"),
            ("openai", "OPENAI_API_KEY"),
        ] {
            draft.method(
                id.into(),
                integration::Method::Key(integration::KeyMethod {
                    label: Some("API key".into()),
                }),
            );
            draft.method(
                id.into(),
                integration::Method::Env(integration::EnvMethod {
                    names: vec![name.into()],
                }),
            );
        }
        Ok(())
    }
}
