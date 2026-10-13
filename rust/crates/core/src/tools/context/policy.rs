use super::Context;
use crate::{
    process::guardrails::{self, Guardrails, Input, Reservation},
    tools::{
        policy::permissions::{self, Permissions},
        registry::Failure,
    },
};
use ycoding_schema::{JsonObject, LosslessString, permission};

#[derive(Clone)]
pub struct LeafPolicy {
    pub permissions: Permissions,
    pub guardrails: Guardrails,
}

impl LeafPolicy {
    pub async fn assert(
        &self,
        context: &Context,
        action: &str,
        resources: Vec<LosslessString>,
        save: Vec<LosslessString>,
        metadata: Option<JsonObject>,
    ) -> Result<(), Failure> {
        self.assert_with(context, action, resources, save, metadata)
            .await?
            .map_err(|error| Failure::message(format!("Permission rejected: {error:?}")))
    }
    pub async fn assert_with(
        &self,
        context: &Context,
        action: &str,
        resources: Vec<LosslessString>,
        save: Vec<LosslessString>,
        metadata: Option<JsonObject>,
    ) -> Result<Result<(), permissions::Error>, Failure> {
        let request = permission::Request {
            id: permission::Id::new(
                crate::platform::identifier("per_")
                    .map_err(|error| Failure::Defect(error.to_string()))?,
            )
            .map_err(|error| Failure::Defect(error.to_string()))?,
            session_id: context.session_id.clone(),
            action: action.into(),
            resources,
            save: Some(save),
            metadata,
            source: Some(permission::Source {
                message_id: context.message_id.as_lossless().clone(),
                call_id: context.call_id.clone(),
            }),
        };
        tokio::select! {
            result = self.permissions.assert(request, Some(context.agent.clone())) => Ok(result),
            _ = context.cancellation.cancelled() => Err(Failure::Cancelled),
        }
    }
    pub async fn reserve(
        &self,
        context: &Context,
        action: &str,
        resources: Vec<LosslessString>,
        metadata: Option<JsonObject>,
    ) -> Result<Reservation, Failure> {
        self.reserve_with(context, action, resources, metadata, false)
            .await
    }
    pub async fn reserve_with(
        &self,
        context: &Context,
        action: &str,
        resources: Vec<LosslessString>,
        metadata: Option<JsonObject>,
        skip_review: bool,
    ) -> Result<Reservation, Failure> {
        self.admit(context, action, resources, metadata, skip_review)
            .await?
            .map_err(|error| Failure::message(format!("Session guardrail rejected: {error:?}")))
    }
    pub async fn admit(
        &self,
        context: &Context,
        action: &str,
        resources: Vec<LosslessString>,
        metadata: Option<JsonObject>,
        skip_review: bool,
    ) -> Result<Result<Reservation, guardrails::Error>, Failure> {
        let admission = match self.guardrails.assert(Input {
            session_id: context.session_id.clone(),
            action: action.into(),
            resources,
            metadata,
            skip_review,
            holder: Some(context.call_id.clone()),
        }) {
            Ok(admission) => admission,
            Err(error) => return Ok(Err(error)),
        };
        if let Some(wait) = admission.wait {
            return tokio::select! {
                result = wait => result.map_err(|_| Failure::Cancelled),
                _ = context.cancellation.cancelled() => Err(Failure::Cancelled),
            };
        }
        admission
            .reservation
            .map(Ok)
            .ok_or_else(|| Failure::Defect("Guardrail admission has no reservation".into()))
    }
}
