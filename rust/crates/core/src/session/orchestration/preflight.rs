use super::service::{Error, Prepared};
use crate::{
    process::guardrails::{Guardrails, Input, Reservation},
    resources::{agent, attachment_store, credential, domain_state::DomainState, model},
    session::{
        compaction_policy, model_switch,
        prompt_cache::{canonical_json, sha256},
        runner::messages,
        store,
    },
    tools::policy::permissions::Permissions,
};
use std::sync::Arc;
use ycoding_schema::{
    DomainEncode, LosslessString, ObjectEncoder, permission, session,
    session_event::ProfileBinding, session_message,
};

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
    agents: DomainState<agent::Service>,
    models: Arc<model::Resolver>,
    credentials: credential::Service,
}

impl Preflight {
    pub fn new(
        sessions: store::Service,
        agents: DomainState<agent::Service>,
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

    pub fn model_switch(
        &self,
        compaction: compaction_policy::Resolved,
        attachments: Arc<attachment_store::Store>,
    ) -> ModelSwitch {
        ModelSwitch::new(
            self.sessions.clone(),
            self.models.clone(),
            self.credentials.clone(),
            compaction,
            attachments,
        )
    }

    pub fn prepare(&self, parent_id: &session::Id, request: &Request) -> Result<Prepared, Error> {
        let agents = self.agents.snapshot();
        let parent = self
            .sessions
            .get(parent_id)?
            .ok_or_else(|| Error::SessionNotFound(parent_id.clone()))?;
        let target = agents
            .resolve(Some(&request.agent))
            .ok_or_else(|| invalid(format!("Unknown agent: {}", text(&request.agent))))?;
        if target.mode.as_str() == Some("primary") {
            return Err(invalid(format!(
                "Agent {} cannot run as a subagent",
                text(&request.agent)
            )));
        }
        let caller = agents
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
        escalation: None,
        coordination_escalation: None,
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
    let rejected = |error: crate::process::guardrails::Error| {
        invalid(
            error
                .review_message()
                .or_else(|| error.capacity_message())
                .unwrap_or_else(|| {
                    format!("Session guardrail rejected subagent: {}", text(target))
                }),
        )
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

#[derive(Clone)]
pub struct ModelSwitch {
    sessions: store::Service,
    models: Arc<model::Resolver>,
    credentials: credential::Service,
    compaction: compaction_policy::Resolved,
    attachments: Arc<attachment_store::Store>,
}

pub struct ResolvedSwitch {
    pub binding: Option<ProfileBinding>,
    pub digest: LosslessString,
    pub budget: i64,
}

impl ModelSwitch {
    pub fn new(
        sessions: store::Service,
        models: Arc<model::Resolver>,
        credentials: credential::Service,
        compaction: compaction_policy::Resolved,
        attachments: Arc<attachment_store::Store>,
    ) -> Self {
        Self {
            sessions,
            models,
            credentials,
            compaction,
            attachments,
        }
    }

    pub fn resolve(
        &self,
        target: &ycoding_schema::model::Ref,
        saved_binding: Option<&ProfileBinding>,
    ) -> Result<ResolvedSwitch, Error> {
        let saved = self
            .credentials
            .all()
            .map_err(|error| switch_credential_error(error, target))?;
        let catalog = self.models.catalog();
        let provider = catalog.provider(&target.provider_id).ok_or_else(|| {
            Error::ModelResolution(format!(
                "Model unavailable: {}/{}",
                text(&target.provider_id.0),
                text(&target.id)
            ))
        })?;
        let integration = provider
            .integration_id
            .as_ref()
            .map(|id| id.as_lossless())
            .unwrap_or(&provider.id.0);
        let profile_unavailable = |target: &ycoding_schema::model::Ref| Error::ProfileUnavailable {
            provider_id: target.provider_id.0.clone(),
            profile: target
                .profile
                .as_ref()
                .map_or_else(LosslessString::default, |profile| profile.0.clone()),
        };
        let binding = target
            .profile
            .as_ref()
            .map(|profile| {
                match saved_binding.filter(|binding| {
                    binding.provider_id == target.provider_id && binding.profile == *profile
                }) {
                    Some(binding) => Ok(credential::Binding::from_domain(binding.clone())),
                    None => self.credentials.bind(
                        target.provider_id.0.clone(),
                        integration.clone(),
                        profile.0.clone(),
                    ),
                }
            })
            .transpose()
            .map_err(|_| profile_unavailable(target))?;
        let connection = match (&binding, &target.profile) {
            (Some(binding), Some(profile)) => Some(
                self.credentials
                    .resolve_selection(&target.provider_id.0, integration, &profile.0, binding)
                    .map_err(|_| profile_unavailable(target))?,
            ),
            _ => self
                .credentials
                .active(integration)
                .map_err(|error| switch_credential_error(error, target))?,
        };
        let resolved = self
            .models
            .resolve(target, &saved, connection.as_ref())
            .map_err(|error| match error {
                model::Error::ProfileUnavailable => profile_unavailable(target),
                model::Error::ModelUnavailable => Error::ModelResolution(format!(
                    "Model unavailable: {}/{}",
                    text(&target.provider_id.0),
                    text(&target.id)
                )),
                model::Error::VariantUnavailable => Error::ModelResolution(format!(
                    "Variant unavailable for {}/{}: {}",
                    text(&target.provider_id.0),
                    text(&target.id),
                    target.variant.as_ref().map_or("", |variant| text(variant))
                )),
                other => Error::ModelResolution(other.to_string()),
            })?;
        let binding = binding
            .map(|binding| binding.domain())
            .transpose()
            .map_err(|_| profile_unavailable(target))?;
        let digest = sha256(&canonical_json(
            &ObjectEncoder::new()
                .field("provider", &resolved.info.provider_id)
                .field("model", &resolved.info.id)
                .field("apiModel", &resolved.info.model_id)
                .optional("variant", &target.variant)
                .optional(
                    "credential",
                    &connection.as_ref().map(|info| info.id().clone()),
                )
                .optional(
                    "generation",
                    &connection.as_ref().map(|info| info.generation() as f64),
                )
                .optional(
                    "accountGeneration",
                    &connection
                        .as_ref()
                        .map(|info| info.account_generation() as f64),
                )
                .optional("binding", &binding.as_ref().map(|binding| binding.encode()))
                .finish(),
        ));
        Ok(ResolvedSwitch {
            binding,
            digest: digest.into(),
            budget: resolved.info.limit.context.get()
                - self.compaction.context_safety_margin_tokens,
        })
    }

    pub fn context_tokens(
        &self,
        session: &session::Info,
        target: &ycoding_schema::model::Ref,
    ) -> Result<i64, Error> {
        let history = self
            .sessions
            .model_history(&session.id)?
            .into_iter()
            .map(|entry| match entry.message {
                session_message::Info::User(mut user) => {
                    user.files = None;
                    session_message::Info::User(user)
                }
                message => message,
            })
            .collect::<Vec<_>>();
        let lowered = messages::convert(
            &history,
            &self.attachments,
            &messages::Replay {
                model: target.clone(),
                metadata_key: String::new(),
                accounts: Default::default(),
                states: Default::default(),
                cache_shared_context: false,
            },
            None,
        );
        Ok(model_switch::estimate(&lowered))
    }
}

fn switch_credential_error(error: credential::Error, target: &ycoding_schema::model::Ref) -> Error {
    match error {
        credential::Error::ProfileUnavailable => Error::ProfileUnavailable {
            provider_id: target.provider_id.0.clone(),
            profile: target
                .profile
                .as_ref()
                .map_or_else(LosslessString::default, |profile| profile.0.clone()),
        },
        credential::Error::Rejected | credential::Error::CodeRequired => {
            Error::Authorization(error.to_string())
        }
        other => Error::ModelResolution(other.to_string()),
    }
}

fn text(value: &LosslessString) -> &str {
    value.as_str().unwrap_or_default()
}
