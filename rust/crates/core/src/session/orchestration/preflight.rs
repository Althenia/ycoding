use super::service::{Error, Prepared};
use crate::{
    process::guardrails::{Guardrails, Input, Reservation},
    resources::{agent, credential, model},
    session::store,
    tools::policy::permissions::Permissions,
};
use std::sync::Arc;
use ycoding_schema::{LosslessString, permission, session, session_event::ProfileBinding};

pub struct Request {
    pub agent: ycoding_schema::agent::Id,
    pub model: Option<ycoding_schema::model::Ref>,
    pub caller: Option<ycoding_schema::agent::Id>,
}

pub struct ToolCall {
    pub agent: LosslessString,
    pub message_id: LosslessString,
    pub call_id: LosslessString,
}

#[derive(Clone)]
pub struct Preflight {
    sessions: store::Service,
    agents: Arc<agent::Service>,
    models: Arc<model::Resolver>,
    credentials: credential::Service,
}

impl Preflight {
    pub fn new(
        sessions: store::Service,
        agents: Arc<agent::Service>,
        models: Arc<model::Resolver>,
        credentials: credential::Service,
    ) -> Self {
        Self {
            sessions,
            agents,
            models,
            credentials,
        }
    }

    pub fn prepare(&self, parent_id: &session::Id, request: &Request) -> Result<Prepared, Error> {
        let parent = self
            .sessions
            .get(parent_id)?
            .ok_or_else(|| Error::SessionNotFound(parent_id.clone()))?;
        let target = self
            .agents
            .resolve(Some(&request.agent))
            .ok_or_else(|| invalid(format!("Unknown agent: {}", text(&request.agent))))?;
        if target.mode.as_str() == Some("primary") {
            return Err(invalid(format!(
                "Agent {} cannot run as a subagent",
                text(&request.agent)
            )));
        }
        let caller = self
            .agents
            .resolve(request.caller.as_ref().or(parent.agent.as_ref()))
            .ok_or_else(|| invalid("Parent agent is unavailable".into()))?;
        let rebind = request
            .model
            .as_ref()
            .or(target.model.as_ref())
            .is_some_and(|selected| selected.profile.is_some());
        let (selection, binding) = self.select(
            &parent,
            request.model.as_ref().or(target.model.as_ref()),
            rebind,
        )?;
        Ok(Prepared {
            agent: target.id.clone(),
            caller_permissions: caller.permissions.clone(),
            model: selection,
            profile_binding: binding,
        })
    }

    fn select(
        &self,
        parent: &session::Info,
        explicit: Option<&ycoding_schema::model::Ref>,
        rebind: bool,
    ) -> Result<(ycoding_schema::model::Ref, Option<ProfileBinding>), Error> {
        let saved = self
            .credentials
            .all()
            .map_err(|_| invalid("Credentials could not be read".into()))?;
        let selection = explicit
            .or(parent.model.as_ref())
            .cloned()
            .or_else(|| self.models.catalog().default_selection(&saved))
            .ok_or_else(|| {
                invalid(format!(
                    "No model is available for session {}",
                    text(parent.id.as_lossless())
                ))
            })?;
        let catalog = self.models.catalog();
        let provider = catalog
            .provider(&selection.provider_id)
            .ok_or_else(|| invalid("Selected provider is unavailable".into()))?;
        let integration = provider
            .integration_id
            .as_ref()
            .map(|id| id.as_lossless())
            .unwrap_or(&provider.id.0);
        let unavailable =
            || invalid("Selected profile is unavailable; select the profile again".into());
        let saved_binding = if rebind {
            None
        } else {
            self.sessions.profile_binding(&parent.id)?
        };
        let binding = selection
            .profile
            .as_ref()
            .map(|profile| {
                match saved_binding.as_ref().filter(|binding| {
                    binding.provider_id == selection.provider_id && binding.profile == *profile
                }) {
                    Some(binding) => Ok(credential::Binding::from_domain(binding.clone())),
                    None => self.credentials.bind(
                        selection.provider_id.0.clone(),
                        integration.clone(),
                        profile.0.clone(),
                    ),
                }
            })
            .transpose()
            .map_err(|_| unavailable())?;
        let connection = match (&binding, &selection.profile) {
            (Some(binding), Some(profile)) => Some(
                self.credentials
                    .resolve_selection(&selection.provider_id.0, integration, &profile.0, binding)
                    .map_err(|_| unavailable())?,
            ),
            _ => self
                .credentials
                .active(integration)
                .map_err(|_| invalid("Provider account is unavailable".into()))?,
        };
        self.models
            .resolve(&selection, &saved, connection.as_ref())
            .map_err(|error| invalid(error.to_string()))?;
        let binding = binding
            .map(|binding| binding.domain())
            .transpose()
            .map_err(|_| invalid("Selected profile binding is invalid".into()))?;
        Ok((selection, binding))
    }
}

pub async fn authorize(
    permissions: &Permissions,
    parent_id: &session::Id,
    target: &ycoding_schema::agent::Id,
    call: &ToolCall,
) -> Result<(), Error> {
    let request = permission::Request {
        id: permission::Id::new(
            crate::platform::identifier("per_")
                .map_err(|error| invalid(format!("Permission identifier unavailable: {error}")))?,
        )
        .map_err(|error| invalid(error.to_string()))?,
        session_id: parent_id.clone(),
        action: "subagent".into(),
        resources: vec![target.clone()],
        save: Some(vec![target.clone()]),
        metadata: None,
        source: Some(permission::Source {
            message_id: call.message_id.clone(),
            call_id: call.call_id.clone(),
        }),
    };
    permissions
        .assert(request, Some(call.agent.clone()))
        .await
        .map_err(|error| invalid(format!("Subagent denied: {} ({error:?})", text(target))))
}

pub async fn reserve(
    guardrails: &Guardrails,
    parent_id: &session::Id,
    target: &ycoding_schema::agent::Id,
    description: &str,
    call: &ToolCall,
) -> Result<Reservation, Error> {
    let rejected =
        |error: crate::process::guardrails::Error| {
            invalid(error.capacity_message().unwrap_or_else(|| {
                format!("Session guardrail rejected subagent: {}", text(target))
            }))
        };
    let mut metadata = ycoding_schema::JsonObject::new();
    metadata.insert(
        "description".into(),
        ycoding_schema::JsonValue::String(description.into()),
    );
    let admission = guardrails
        .assert(Input {
            session_id: parent_id.clone(),
            action: "subagent".into(),
            resources: vec![target.clone()],
            metadata: Some(metadata),
            skip_review: false,
            holder: Some(call.call_id.clone()),
            defer_shell: false,
            source: ycoding_schema::DomainDecode::decode(
                &ycoding_schema::ObjectEncoder::new()
                    .field("messageID", &call.message_id)
                    .field("callID", &call.call_id)
                    .finish(),
            )
            .ok(),
        })
        .map_err(rejected)?;
    if let Some(wait) = admission.wait {
        return wait
            .await
            .map_err(|_| invalid("Subagent guardrail wait was cancelled".into()))?
            .map_err(rejected);
    }
    admission
        .reservation
        .ok_or_else(|| invalid("Guardrail admission has no reservation".into()))
}

fn invalid(message: String) -> Error {
    Error::InvalidRequest(message)
}

fn text(value: &LosslessString) -> &str {
    value.as_str().unwrap_or_default()
}
