use super::{
    Client, DeviceFlow, Error, Preparation, claude, cursor,
    integration::{Authorization, Draft, OAuthImplementation},
    muse, now, opencode,
};
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{DomainDecode, JsonValue, integration, integration_id::IntegrationMethodId};

impl Preparation {
    pub fn register(
        &self,
        draft: &mut Draft,
        environment: &BTreeMap<String, String>,
        claude: Option<&claude::Store>,
    ) -> Result<(), Error> {
        for (provider, methods) in [
            (
                "openai",
                vec![
                    ("chatgpt-browser", "ChatGPT Pro/Plus (browser)", false),
                    ("chatgpt-headless", "ChatGPT Pro/Plus (headless)", true),
                ],
            ),
            (
                "xai",
                vec![
                    ("browser", "xAI Grok OAuth (SuperGrok Subscription)", false),
                    ("device", "xAI Grok OAuth (Headless / Remote / VPS)", true),
                ],
            ),
            (
                "github-copilot",
                vec![("device", "Login with GitHub Copilot", true)],
            ),
        ] {
            let client = self
                .clients
                .get(provider)
                .cloned()
                .map(Ok)
                .unwrap_or_else(|| Client::provider(provider, env!("CARGO_PKG_VERSION")))?;
            for (method, label, remote) in methods {
                let login = client.clone();
                let refresh = client.clone();
                let provider = provider.to_owned();
                let refreshing = provider.clone();
                let method = method.to_owned();
                let refreshing_method = method.clone();
                let prompts = if provider == "github-copilot" {
                    integration::OAuthMethod::decode(&ycoding_schema::parse_json(r#"{"type":"oauth","id":"device","label":"Login with GitHub Copilot","remote":true,"prompts":[{"type":"select","key":"deploymentType","message":"Select GitHub deployment type","options":[{"label":"GitHub.com","value":"github.com","hint":"Public"},{"label":"GitHub Enterprise","value":"enterprise","hint":"Data residency or self-hosted"}]},{"type":"text","key":"enterpriseUrl","message":"Enter your GitHub Enterprise URL or domain","placeholder":"company.ghe.com or https://company.ghe.com","when":{"key":"deploymentType","op":"eq","value":"enterprise"}}]}"#).map_err(|_|Error::InvalidCredential)?).map_err(|_|Error::InvalidCredential)?.prompts
                } else {
                    None
                };
                draft.oauth(OAuthImplementation {
                    integration: provider.clone().into(),
                    method: integration::OAuthMethod {
                        id: IntegrationMethodId::new(method.clone())
                            .map_err(|_| Error::InvalidCredential)?,
                        label: label.into(),
                        prompts,
                        remote: remote.then_some(true),
                    },
                    authorize: Arc::new(move |inputs| {
                        let login = login.clone();
                        let provider = provider.clone();
                        let method = method.clone();
                        Box::pin(async move {
                            if matches!(method.as_str(), "browser" | "chatgpt-browser") {
                                let mut attempt =
                                    login.start_browser(&provider, &method, None).await?;
                                return Ok(Authorization::automatic(
                                    attempt.url().into(),
                                    "Complete authorization in your browser.".into(),
                                    Box::pin(async move { attempt.wait().await }),
                                    None,
                                    None,
                                ));
                            }
                            let enterprise = if provider == "github-copilot"
                                && inputs.0.get(&"deploymentType".into())
                                    == Some(&JsonValue::String("enterprise".into()))
                            {
                                Some(
                                    inputs
                                        .0
                                        .get(&"enterpriseUrl".into())
                                        .and_then(|value| {
                                            if let JsonValue::String(value) = value {
                                                value.as_str().map(str::to_owned)
                                            } else {
                                                None
                                            }
                                        })
                                        .filter(|value| !value.is_empty())
                                        .ok_or(Error::Rejected)?,
                                )
                            } else {
                                None
                            };
                            let flow = match provider.as_str() {
                                "openai" => DeviceFlow::Openai,
                                "xai" => DeviceFlow::Xai,
                                _ => DeviceFlow::Copilot { enterprise },
                            };
                            let mut attempt = login.start_device(flow, now()?).await?;
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
                    refresh: if refreshing == "github-copilot" {
                        None
                    } else {
                        Some(Arc::new(move |value| {
                            let refresh = refresh.clone();
                            let provider = refreshing.clone();
                            let method = refreshing_method.clone();
                            Box::pin(async move {
                                let mut value = value;
                                value.method_id = IntegrationMethodId::new(method)
                                    .map_err(|_| Error::InvalidCredential)?;
                                refresh.refresh(&provider, value, now()?).await
                            })
                        }))
                    },
                    label: None,
                });
            }
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
        draft.oauth(
            opencode::Console::new(
                self.clients
                    .get("opencode")
                    .cloned()
                    .map(Ok)
                    .unwrap_or_else(|| {
                        Client::new("https://console.opencode.ai", env!("CARGO_PKG_VERSION"))
                    })?,
            )
            .implementation(),
        );
        if let Some(claude) = claude {
            draft.oauth(claude.implementation(vec!["claude".into()], environment.clone()));
        }
        for (id, name) in [
            ("anthropic", "ANTHROPIC_API_KEY"),
            ("openai", "OPENAI_API_KEY"),
            ("xai", "XAI_API_KEY"),
            ("opencode", "OPENCODE_API_KEY"),
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
