use super::{run_coordinator::Error, runner::error, store};
use crate::resources::{config, credential, model};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use ycoding_ai::llm;
use ycoding_schema::{location, session, session_event, session_scope::Scope};

pub struct State {
    pub snapshot: config::standalone::Snapshot,
    pub location: location::Ref,
    pub store: store::Service,
    pub models: Arc<model::Resolver>,
    pub credentials: credential::Service,
    closed: AtomicBool,
}

pub struct Selected {
    pub resolved: model::Resolved,
    pub connection: credential::Info,
    pub binding: session_event::ProfileBinding,
}

impl State {
    pub fn new(
        snapshot: config::standalone::Snapshot,
        location: location::Ref,
        store: store::Service,
        models: Arc<model::Resolver>,
        credentials: credential::Service,
    ) -> Self {
        Self {
            snapshot,
            location,
            store,
            models,
            credentials,
            closed: AtomicBool::new(false),
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    pub fn assert_current(&self) -> Result<(), Error> {
        if self.closed.load(Ordering::Acquire) {
            return Err(error("scope.unavailable", "Standalone runner is closed"));
        }
        self.snapshot.assert_current().map_err(|_| {
            error(
                "scope.unavailable",
                "Standalone configuration is unavailable or changed",
            )
        })
    }

    pub fn session(&self, id: &session::Id) -> Result<session::Info, Error> {
        self.assert_current()?;
        let session = self
            .store
            .get(id)?
            .ok_or_else(|| error("not_found", "Session not found"))?;
        if session.scope != Scope::Standalone || session.location != self.location {
            return Err(error(
                "scope.unavailable",
                "Session is unavailable in standalone scope",
            ));
        }
        if session
            .model
            .as_ref()
            .and_then(|model| model.profile.as_ref())
            .is_none()
        {
            return Err(error(
                "model.profile",
                "Standalone execution requires an explicit model and profile",
            ));
        }
        Ok(session)
    }

    pub fn select(
        &self,
        selection: &ycoding_schema::model::Ref,
        saved_binding: Option<&session_event::ProfileBinding>,
    ) -> Result<Selected, Error> {
        self.assert_current()?;
        let profile = selection.profile.as_ref().ok_or_else(|| {
            error(
                "model.profile",
                "Standalone execution requires an explicit profile",
            )
        })?;
        if saved_binding.is_some_and(|binding| {
            binding.provider_id != selection.provider_id || binding.profile != *profile
        }) {
            return Err(error(
                "model.profile",
                "Selected profile no longer matches the saved binding",
            ));
        }
        let catalog = self.models.catalog();
        let provider = catalog
            .provider(&selection.provider_id)
            .ok_or_else(|| error("model.unavailable", "Selected provider is unavailable"))?;
        let integration = provider
            .integration_id
            .as_ref()
            .map(|id| id.as_lossless())
            .unwrap_or(&provider.id.0);
        let binding = match saved_binding {
            Some(binding) => credential::Binding::from_domain(binding.clone()),
            None => self
                .credentials
                .bind(
                    selection.provider_id.0.clone(),
                    integration.clone(),
                    profile.0.clone(),
                )
                .map_err(|_| error("model.profile", "Selected profile is unavailable"))?,
        };
        let connection = self
            .credentials
            .resolve_selection(&selection.provider_id.0, integration, &profile.0, &binding)
            .map_err(|_| error("model.profile", "Selected profile is unavailable"))?;
        let saved = self
            .credentials
            .all()
            .map_err(|_| error("provider.auth", "Credentials could not be read"))?;
        let resolved = model::resolve_catalog(&catalog, selection, &saved, Some(&connection))
            .map_err(|_| {
                error(
                    "model.unavailable",
                    "Selected standalone model is unavailable",
                )
            })?;
        let binding = binding
            .domain()
            .map_err(|_| error("model.profile", "Selected profile binding is invalid"))?;
        Ok(Selected {
            resolved,
            connection,
            binding,
        })
    }

    pub fn model(self: &Arc<Self>, selected: &Selected) -> Result<llm::Model, Error> {
        let secret = selected
            .connection
            .secret()
            .domain()
            .map_err(|_| error("model.profile", "Selected profile is invalid"))?;
        let state = self.clone();
        let connection = selected.connection.clone();
        let guard = Arc::new(move || {
            state.assert_current().map_err(|_| {
                ycoding_ai::Error::invalid("Standalone configuration is unavailable or changed")
            })?;
            state
                .credentials
                .current_account(&connection)
                .map_err(|_| ycoding_ai::Error::invalid("Selected profile is no longer current"))?;
            Ok(())
        });
        let mut model = model::standalone::resolve(
            &selected.resolved.info,
            &secret,
            selected
                .connection
                .integration_id()
                .as_str()
                .unwrap_or_default(),
            guard,
        )
        .map_err(|_| {
            error(
                "model.unavailable",
                "Provider route is unavailable in standalone scope",
            )
        })?;
        model.supports_temperature &= selected.resolved.supports_temperature;
        Ok(model)
    }
}

pub(crate) fn check_history(
    messages: &[ycoding_schema::session_message::Info],
) -> Result<(), Error> {
    use ycoding_schema::{
        llm::ToolContent,
        session_message::{AssistantContent, Info, ToolState},
    };
    for message in messages {
        let attached = match message {
            Info::User(user) => user.files.as_ref().is_some_and(|files| !files.is_empty()),
            Info::Assistant(assistant) => assistant.content.iter().any(|part| {
                let AssistantContent::Tool(tool) = part else { return false; };
                let ToolState::Completed(state) = &tool.state else { return false; };
                state.content.iter().any(|content| matches!(content, ToolContent::File(file) if super::generate::provider_image(&file.mime)))
            }),
            _ => false,
        };
        if attached {
            return Err(error(
                "scope.unavailable",
                "Attachments are unavailable in standalone scope",
            ));
        }
    }
    Ok(())
}
