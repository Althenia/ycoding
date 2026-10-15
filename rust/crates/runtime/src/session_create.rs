use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
};
use std::path::Path;
use ycoding_core::ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, ObjectEncoder, location, model, schema::RelativePath,
    session,
};
use ycoding_core::ycoding_store::session::NewEvent;
use ycoding_protocol::v5;

const DECISION_AGENT: &str = "decision";

pub async fn create(
    invocation: Invocation,
    request: v5::SessionCreateRequest,
) -> Result<v5::SessionCreateResult, Failure> {
    let core = invocation.core()?;
    let payload = request.payload;
    let id = match &payload.id {
        Some(id) => convert::identifier::<session::Id>(id)?,
        None => ids::session_id()
            .map_err(|_| Failure::Unavailable("Session ID generation failed".into()))?,
    };
    if let Some(recorded) = core.sessions.get(&id).map_err(store)? {
        if invocation.remote {
            crate::remote_derived::target::verify(core, &id)?;
            let services = invocation.location(None)?;
            if recorded.parent_id.is_some()
                || recorded.project_id != services.info.project.id
                || recorded.location.directory != services.info.directory
                || recorded.location.workspace_id != services.info.workspace_id
            {
                return Err(Failure::Invalid(
                    "Session ID belongs to another workspace".into(),
                ));
            }
        }
        return result(&recorded);
    }
    let agent = payload.agent.as_ref().map(convert::domain).transpose()?;
    if agent.as_ref().and_then(LosslessString::as_str) == Some(DECISION_AGENT) {
        return Err(Failure::InvalidField {
            message:
                "The internal decision helper cannot be selected as a foreground Session agent."
                    .into(),
            field: "agent",
        });
    }
    let parent = payload
        .parent_id
        .as_ref()
        .map(|parent| {
            let parent = convert::identifier::<session::Id>(parent)?;
            core.sessions
                .get(&parent)
                .map_err(store)?
                .ok_or_else(|| Failure::SessionNotFound(convert::readable(parent.as_lossless())))
        })
        .transpose()?;
    let (project, location, subpath) = match &parent {
        Some(parent) => (
            parent.project_id.clone(),
            parent.location.clone(),
            parent.subpath.clone(),
        ),
        None => {
            let requested = payload
                .location
                .as_ref()
                .map(|location| v5::LocationQueryLocation {
                    directory: Some(location.directory.clone()),
                    workspace: location.workspace_id.clone(),
                });
            let services = invocation.location(requested.as_ref())?;
            core.locations.record(&services.info, false).await?;
            (
                services.info.project.id.clone(),
                location::Ref {
                    directory: services.info.directory.clone(),
                    workspace_id: services.info.workspace_id.clone(),
                },
                subpath(&services.info),
            )
        }
    };
    let model = payload
        .model
        .as_ref()
        .map(model_domain)
        .transpose()?
        .or_else(|| parent.as_ref().and_then(|parent| parent.model.clone()));
    let now = ids::now_millis();
    let event = NewEvent {
        id: ids::event_id()
            .map_err(|_| Failure::Unavailable("event ID generation failed".into()))?
            .as_lossless()
            .clone(),
        aggregate_id: id.as_lossless().clone(),
        created: now,
        type_: "session.created.2".into(),
        data: ObjectEncoder::new()
            .field("sessionID", &id)
            .field("projectID", &project)
            .field("location", &location)
            .optional("parentID", &parent.as_ref().map(|parent| parent.id.clone()))
            .optional("agent", &agent)
            .optional("model", &model)
            .field("title", format!("New session - {}", iso(now)).as_str())
            .optional("subpath", &subpath)
            .field("created", &(now as f64))
            .finish(),
    };
    let created = if model.as_ref().is_some_and(|model| model.profile.is_some()) {
        let services = core.locations.location(
            location.directory.as_lossless(),
            location.workspace_id.as_ref().map(|id| id.as_lossless()),
        )?;
        let (_, services) = core.session_services(&services)?;
        let inherited_binding = parent
            .as_ref()
            .filter(|_| payload.model.is_none())
            .map(|parent| core.sessions.profile_binding(&parent.id))
            .transpose()
            .map_err(store)?
            .flatten();
        services
            .runner
            .create(event, inherited_binding.as_ref())
            .await
            .map_err(create_failure)?
    } else {
        core.sessions.create(event).await.map_err(store)?
    };
    result(&created)
}

fn create_failure(error: ycoding_core::session::run_coordinator::Error) -> Failure {
    let field = match error {
        ycoding_core::session::run_coordinator::Error::Runner(error) => match error.r#type.as_str()
        {
            Some("model.profile") => {
                return Failure::InvalidField {
                    field: "model.profile",
                    message: "Selected model profile is unavailable. Reconnect or select the profile again.".into(),
                };
            }
            Some("model.variant") => "model.variant",
            _ => "model",
        },
        error => return store(error),
    };
    Failure::InvalidField {
        field,
        message: "Selected model credentials or configuration are unavailable. Reconnect the provider or select an available model.".into(),
    }
}

fn result(info: &session::Info) -> Result<v5::SessionCreateResult, Failure> {
    Ok(v5::SessionCreateResult {
        data: convert::session_info(info)
            .map_err(|_| Failure::Unavailable("stored Session is not representable".into()))?,
    })
}

fn model_domain(model: &v5::ModelRef) -> Result<model::Ref, Failure> {
    let mut object = ycoding_core::ycoding_schema::JsonObject::new();
    object.insert("id".into(), JsonValue::String(convert::domain(&model.id)?));
    object.insert(
        "providerID".into(),
        JsonValue::String(convert::domain(&model.provider_id)?),
    );
    if let Some(variant) = &model.variant {
        object.insert(
            "variant".into(),
            JsonValue::String(convert::domain(variant)?),
        );
    }
    if let Some(profile) = &model.profile {
        object.insert(
            "profile".into(),
            JsonValue::String(convert::domain(profile)?),
        );
    }
    model::Ref::decode(&JsonValue::Object(object)).map_err(|_| Failure::InvalidField {
        message: "The selected model is invalid".into(),
        field: "model",
    })
}

fn subpath(info: &location::Info) -> Option<RelativePath> {
    let relative = Path::new(&convert::readable(info.directory.as_lossless()))
        .strip_prefix(convert::readable(info.project.directory.as_lossless()))
        .ok()?
        .to_str()?
        .replace('\\', "/");
    RelativePath::new(relative)
        .ok()
        .filter(|path| !path.as_lossless().is_empty())
}

fn store(_: impl std::fmt::Debug) -> Failure {
    Failure::Unavailable("Session store unavailable".into())
}

pub(crate) fn iso(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let time = millis.rem_euclid(86_400_000);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3_600_000,
        time / 60_000 % 60,
        time / 1_000 % 60,
        time % 1_000
    )
}
