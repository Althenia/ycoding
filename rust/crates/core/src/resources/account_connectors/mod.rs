use crate::{
    cca::{
        error::{AuthorizationDenied, BoxFuture, ExecutorError},
        library::{LibraryFactory, LibraryOpenInput, LibraryProcess},
        value::{JsonObject, LosslessString, Value},
    },
    dots::native::executor_scope::LibraryScope,
    resources::{attachment_store, auth, config},
};
use std::{sync::Arc, time::Duration};
use ycoding_schema::{DomainEncode, connection, credential};

mod library;
mod library_reservations;
pub mod skills_read;

#[cfg(test)]
mod producer_tests;
#[cfg(test)]
mod reservation_tests;
#[cfg(test)]
mod skills_read_tests;
#[cfg(test)]
mod transport_tests;

pub struct LibraryInput {
    pub scope: LibraryScope,
    pub configuration: Arc<config::Configuration>,
    pub integration: auth::integration::Registry,
    pub attachments: Arc<attachment_store::Store>,
}

enum Failure {
    Invalid,
    Retired,
    Expired,
    Uncertain,
    Rejected(u16),
    InvalidFinalization,
    Denied(AuthorizationDenied),
    Cleanup,
}

impl std::fmt::Debug for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PrivateLibraryFailure")
    }
}

fn unavailable() -> ExecutorError {
    ExecutorError::new(-32603, "Private Library scope is unavailable")
}

fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    let mut object = JsonObject::new();
    for (key, value) in fields {
        object.insert(key.into(), value);
    }
    Value::Object(object)
}

fn text(value: &str) -> Value {
    Value::String(value.into())
}

struct Prepared {
    access: String,
    account: String,
}

struct Context {
    input: LibraryInput,
    settings: Value,
    identity: Value,
    transport: library::Transport,
}

impl Context {
    fn settings(input: &LibraryInput) -> Result<Value, Failure> {
        let configuration = input
            .configuration
            .snapshot()
            .map_err(|_| Failure::Retired)?;
        let settings = configuration.chatgpt_connector().ok_or(Failure::Retired)?;
        if !settings.enabled
            || settings.profile.as_ref().is_some_and(|profile| {
                profile != &LosslessString::from(input.scope.principal.profile.as_str())
            })
        {
            return Err(Failure::Retired);
        }
        let mut value = JsonObject::new();
        value.insert("enabled".into(), Value::Bool(settings.enabled));
        if let Some(profile) = settings.profile {
            value.insert("profile".into(), Value::String(profile));
        }
        if let Some(connectors) = settings.connectors {
            value.insert("connectors".into(), Value::Object(connectors));
        }
        Ok(Value::Object(value))
    }

    async fn fence(&self) -> Result<(), Failure> {
        if Self::settings(&self.input)? != self.settings {
            return Err(Failure::Retired);
        }
        let scope = (self.input.scope.current)().await;
        if Self::settings(&self.input)? != self.settings {
            return Err(Failure::Retired);
        }
        scope.map_err(|_| Failure::Retired)
    }

    fn connection(&self) -> Result<connection::Info, Failure> {
        let principal = &self.input.scope.principal;
        let integration = self
            .input
            .integration
            .get(&"openai".into())
            .map_err(|_| Failure::Retired)?
            .ok_or(Failure::Retired)?;
        integration
            .connections
            .into_iter()
            .find(|connection| {
                matches!(connection, connection::Info::Credential(value)
                if value.id.0 == LosslessString::from(principal.credential_id.as_str())
                    && value.label == LosslessString::from(principal.profile.as_str()))
            })
            .ok_or(Failure::Retired)
    }

    async fn current(&self) -> Result<Prepared, Failure> {
        self.fence().await?;
        let selected = self.connection()?;
        let snapshot = self
            .input
            .integration
            .snapshot(selected.clone(), chrono::Utc::now().timestamp_millis())
            .await;
        self.fence().await?;
        let snapshot = snapshot.map_err(|_| Failure::Retired)?;
        if self.connection()? != selected {
            return Err(Failure::Retired);
        }
        let principal = &self.input.scope.principal;
        let stored = snapshot.credential.ok_or(Failure::Retired)?;
        if stored.id() != &LosslessString::from(principal.credential_id.as_str())
            || stored.integration_id() != &LosslessString::from("openai")
            || stored.label() != &LosslessString::from(principal.profile.as_str())
            || stored.account_generation() != principal.account_generation
        {
            return Err(Failure::Retired);
        }
        let secret = snapshot.value.ok_or(Failure::Retired)?;
        let credential::Value::OAuth(value) = secret.domain().map_err(|_| Failure::Retired)? else {
            return Err(Failure::Retired);
        };
        if !matches!(
            value.method_id.as_lossless().as_str(),
            Some("chatgpt-browser" | "chatgpt-headless")
        ) {
            return Err(Failure::Retired);
        }
        let account = match value
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&"accountID".into()))
        {
            Some(Value::String(account))
                if account == &LosslessString::from(principal.account_id.as_str())
                    && !account.is_empty() =>
            {
                account.to_utf8().map_err(|_| Failure::Retired)?
            }
            _ => return Err(Failure::Retired),
        };
        let access = value.access.to_utf8().map_err(|_| Failure::Retired)?;
        if access.is_empty() {
            return Err(Failure::Retired);
        }
        Ok(Prepared { access, account })
    }
}

struct Factory {
    context: Arc<Context>,
}

impl Factory {
    async fn new(
        input: LibraryInput,
        transport: library::Transport,
    ) -> Result<Self, ExecutorError> {
        let settings = Context::settings(&input).map_err(|_| unavailable())?;
        let principal = &input.scope.principal;
        let identity = object([
            ("sessionID", input.scope.session_id.encode()),
            ("profile", text(&principal.profile)),
            ("credentialID", text(&principal.credential_id)),
            ("accountID", text(&principal.account_id)),
            (
                "accountGeneration",
                text(&principal.account_generation.to_string()),
            ),
            (
                "accessRevision",
                text(&principal.access_revision.to_string()),
            ),
        ]);
        let context = Arc::new(Context {
            input,
            settings,
            identity,
            transport,
        });
        context.current().await.map_err(|_| unavailable())?;
        Ok(Self { context })
    }

    async fn open_with_lifetime(
        &self,
        input: LibraryOpenInput,
        lifetime: Duration,
    ) -> Result<Arc<dyn LibraryProcess>, ExecutorError> {
        self.context.current().await.map_err(|_| unavailable())?;
        if input.process_id.is_empty()
            || !crate::cca::policy::is_absolute(&input.cwd)
            || !self
                .context
                .input
                .scope
                .roots
                .iter()
                .any(|root| crate::cca::policy::within(&input.cwd, root))
        {
            return Err(unavailable());
        }
        library_reservations::open(self.context.clone(), input, lifetime)
    }
}

impl LibraryFactory for Factory {
    fn open(
        &self,
        input: LibraryOpenInput,
    ) -> BoxFuture<'_, Result<Arc<dyn LibraryProcess>, ExecutorError>> {
        Box::pin(self.open_with_lifetime(input, Duration::from_millis(300_000)))
    }
}

pub async fn library_factory(
    input: LibraryInput,
) -> Result<Arc<dyn LibraryFactory>, ExecutorError> {
    let factory =
        Factory::new(input, library::Transport::new().map_err(|_| unavailable())?).await?;
    Ok(Arc::new(factory))
}
