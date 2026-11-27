use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
    services::Core,
};
use std::sync::Arc;
use ycoding_core::{
    resources::config::Configuration,
    session::autonomy::{DecisionMode, Defaults, DefaultsChange, Refusal},
    ycoding_schema::session,
};
use ycoding_protocol::v5;

fn configuration(core: &Core) -> Result<Arc<Configuration>, Failure> {
    core.global_configuration
        .clone()
        .ok_or_else(|| Failure::Unavailable("Autonomy defaults are unavailable".into()))
}

fn wire_mode(mode: DecisionMode) -> i32 {
    match mode {
        DecisionMode::Manual => 1,
        DecisionMode::Yolo => 2,
        DecisionMode::Auto => 3,
    }
}

fn view(defaults: &Defaults) -> v5::AutonomyDefaultsInfo {
    let accepted = defaults.yolo_accepted_at;
    v5::AutonomyDefaultsInfo {
        permissions: wire_mode(defaults.permissions),
        guardrails: wire_mode(defaults.guardrails),
        answers: wire_mode(defaults.answers),
        yolo_accepted_at: (accepted.permissions.is_some()
            || accepted.guardrails.is_some()
            || accepted.answers.is_some())
        .then_some(v5::AutonomyDefaultsYoloAcceptedAt {
            permissions: accepted.permissions,
            guardrails: accepted.guardrails,
            answers: accepted.answers,
        }),
    }
}

async fn read(core: &Core) -> Result<Defaults, Failure> {
    let configuration = configuration(core)?;
    tokio::task::spawn_blocking(move || configuration.autonomy_defaults())
        .await
        .map_err(|_| Failure::Unavailable("Autonomy defaults are unavailable".into()))?
        .map_err(|_| Failure::Unavailable("Global configuration is unavailable".into()))
}

pub async fn get(
    invocation: Invocation,
    _: v5::AutonomyDefaultsGetRequest,
) -> Result<v5::AutonomyDefaultsGetResult, Failure> {
    let defaults = read(invocation.core()?).await?;
    Ok(v5::AutonomyDefaultsGetResult {
        data: view(&defaults),
    })
}

pub async fn set(
    invocation: Invocation,
    request: v5::AutonomyDefaultsSetRequest,
) -> Result<v5::AutonomyDefaultsSetResult, Failure> {
    let payload = request.payload;
    let mode = |value: Option<i32>| value.map(convert::decision_mode).transpose();
    let change = DefaultsChange {
        permissions: mode(payload.permissions)?,
        guardrails: mode(payload.guardrails)?,
        answers: mode(payload.answers)?,
        accept_yolo: payload.accept_yolo == Some(true),
    };
    let configuration = configuration(invocation.core()?)?;
    let now = u64::try_from(ids::now_millis()).unwrap_or_default();
    let written =
        tokio::task::spawn_blocking(move || configuration.write_autonomy_defaults(change, now))
            .await
            .map_err(|_| Failure::Unavailable("Autonomy defaults are unavailable".into()))?
            .map_err(Failure::ConfigurationWrite)?;
    match written {
        Ok(defaults) => Ok(v5::AutonomyDefaultsSetResult {
            data: view(&defaults),
        }),
        Err(Refusal::NoCategory) => Err(Failure::InvalidField {
            message: "Select at least one autonomy category".into(),
            field: "permissions",
        }),
        Err(Refusal::RiskNotAccepted) => Err(Failure::InvalidField {
            message: "Saving a YOLO default requires explicit risk acceptance".into(),
            field: "acceptYolo",
        }),
    }
}

pub(crate) async fn apply_to_new_root(core: &Core, id: &session::Id) {
    let Ok(defaults) = read(core).await else {
        return;
    };
    let Some(change) = defaults.initial_decisions() else {
        return;
    };
    if core.autonomy.set_decisions(id, change).await.is_err() {
        tracing::warn!("Autonomy defaults could not be applied to a new Session");
    }
}
