use super::{auth::integration, credential, cursor, model};
use std::sync::Arc;
use ycoding_ai::llm;
pub use ycoding_ai::route::Executor;
use ycoding_schema::{LosslessString, connection};

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    Selection(String),
    Unavailable {
        message: String,
        service: Option<LosslessString>,
    },
}

pub struct Input {
    pub prompt: LosslessString,
    pub model: Option<ycoding_schema::model::Ref>,
}

pub struct Service {
    pub models: Arc<model::Resolver>,
    pub credentials: credential::Service,
    pub integrations: integration::Registry,
    pub executor: Arc<Executor>,
    pub cursor: Option<Arc<cursor::route::Host>>,
}

impl Service {
    pub async fn text(&self, input: Input) -> Result<LosslessString, Error> {
        let unavailable = |message: &str| Error::Unavailable {
            message: message.into(),
            service: None,
        };
        let saved = self
            .credentials
            .all()
            .map_err(|_| unavailable("Generation credentials are unavailable"))?;
        let catalog = self.models.catalog();
        let selection = input
            .model
            .clone()
            .or_else(|| catalog.default_selection(&saved));
        let selected = match &selection {
            Some(selection) => catalog.get(&selection.provider_id, &selection.id, None, &saved),
            None => catalog
                .default_model(&saved)
                .filter(supported)
                .or_else(|| catalog.available(&saved).into_iter().find(supported)),
        }
        .ok_or_else(|| {
            Error::Selection(selection.as_ref().map_or_else(
                || "No model specified and no supported model is available".into(),
                |selection| {
                    format!(
                        "Model unavailable: {}/{}",
                        display(&selection.provider_id.0),
                        display(&selection.id)
                    )
                },
            ))
        })?;
        if !catalog.provider_permitted(&selected.provider_id) {
            return Err(Error::Selection(format!(
                "Model unavailable: {}/{}",
                display(&selected.provider_id.0),
                display(&selected.id)
            )));
        }
        let integration = catalog
            .provider(&selected.provider_id)
            .and_then(|provider| provider.integration_id.as_ref())
            .map(|id| id.as_lossless())
            .unwrap_or(&selected.provider_id.0);
        let matching = selection
            .as_ref()
            .and_then(|s| s.profile.as_ref())
            .map(|profile| {
                saved
                    .iter()
                    .filter(|credential| {
                        credential.integration_id() == integration
                            && credential.label() == &profile.0
                    })
                    .collect::<Vec<_>>()
            });
        let profile_error = || {
            Error::Selection(format!(
                "Profile unavailable for {}: {}",
                display(&selected.provider_id.0),
                selection
                    .as_ref()
                    .and_then(|s| s.profile.as_ref())
                    .map_or(String::new(), |profile| display(&profile.0))
            ))
        };
        if matching
            .as_ref()
            .is_some_and(|matching| matching.len() != 1)
        {
            return Err(profile_error());
        }
        let connection = match &matching {
            Some(matching) => Some(connection::Info::Credential(connection::CredentialInfo {
                id: ycoding_schema::credential::Id(matching[0].id().clone()),
                label: matching[0].label().clone(),
                active: matching[0].active(),
            })),
            None => self
                .integrations
                .active(integration)
                .map_err(|_| unavailable("Generation credentials are unavailable"))?,
        };
        let snapshot = match connection {
            Some(connection) => Some(
                self.integrations
                    .snapshot(connection, chrono::Utc::now().timestamp_millis())
                    .await
                    .map_err(|_| unavailable("Generation credentials are unavailable"))?,
            ),
            None => None,
        };
        if snapshot.as_ref().is_some_and(|snapshot| {
            matches!(snapshot.connection, connection::Info::Credential(_))
                && snapshot.credential.is_none()
        }) {
            return Err(unavailable("Selected generation credential is unavailable"));
        }
        if let Some(matching) = matching
            && snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.credential.as_ref())
                .is_none_or(|credential| {
                    credential.account_generation() != matching[0].account_generation()
                })
        {
            return Err(profile_error());
        }
        let contextual = catalog
            .for_connection(
                &selected,
                snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.credential.as_ref()),
            )
            .ok_or_else(|| {
                Error::Selection(format!(
                    "Model unavailable: {}/{}",
                    display(&selected.provider_id.0),
                    display(&selected.id)
                ))
            })?;
        let contextual = model::with_variant(
            contextual,
            selection
                .as_ref()
                .and_then(|selection| selection.variant.as_ref()),
        )
        .map_err(|_| {
            Error::Selection(format!(
                "Variant unavailable for {}/{}: {}",
                display(&selected.provider_id.0),
                display(&selected.id),
                selection
                    .as_ref()
                    .and_then(|s| s.variant.as_ref())
                    .map_or(String::new(), display)
            ))
        })?;
        let secret = snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.value.as_ref())
            .map(|secret| secret.domain())
            .transpose()
            .map_err(|_| unavailable("Generation credentials are unavailable"))?;
        let loaded = self
            .integrations
            .selected_model(
                &contextual,
                secret.as_ref(),
                snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.credential.as_ref()),
                self.cursor.as_deref(),
            )
            .await;
        let model = loaded.map_err(|error| {
            let message = if error == model::Error::UnsupportedPackage {
                format!(
                    "Unsupported package for {}/{}: {}",
                    display(&selected.provider_id.0),
                    display(&selected.id),
                    contextual
                        .package
                        .as_ref()
                        .map_or("unknown".into(), display)
                )
            } else {
                error.to_string()
            };
            if input.model.is_some() {
                return Error::Selection(message);
            }
            Error::Unavailable {
                message,
                service: Some(selected.provider_id.0.clone()),
            }
        })?;
        let mut request = llm::Request::new(model);
        request.messages.push(llm::Message::user(input.prompt));
        let response = self
            .executor
            .generate(&request)
            .await
            .map_err(|_| Error::Unavailable {
                message: "Text generation failed".into(),
                service: Some(selected.provider_id.0),
            })?;
        Ok(LosslessString::from_utf16(
            response
                .message
                .content
                .iter()
                .flat_map(|part| match part {
                    llm::Part::Text(text) => text.text.code_units().collect::<Vec<_>>(),
                    _ => Vec::new(),
                })
                .collect::<Vec<_>>(),
        ))
    }
}

fn supported(info: &ycoding_schema::model::Info) -> bool {
    info.package
        .as_ref()
        .is_some_and(|package| !package.is_empty())
}

fn display(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}
