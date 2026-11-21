use super::{
    SessionHost, SessionServices,
    families::{owned_session, session_scope},
    supervisor::Shared,
    v5, wire,
};
use crate::{
    session::{
        execution::Execution,
        orchestration::inherit_permission_ceiling,
        pending, projector, run_coordinator,
        runner::{CommandInput, IngressError},
    },
    tools::context::Context,
};
use tokio::sync::watch;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, model, permission,
    session, session_message, session_pending,
};
use ycoding_store::session::{NewEvent, Pending};

pub(super) fn accessible(
    shared: &Shared,
    value: &str,
) -> Result<(session::Id, session::Info), v5::FailureCode> {
    let host = shared.host.sessions.as_ref().ok_or(rejected())?;
    if !shared.parent {
        return owned_session(host, value);
    }
    let id = session::Id::new(value).map_err(|_| rejected())?;
    let info = host
        .store
        .get(&id)
        .map_err(|_| execution())?
        .ok_or(rejected())?;
    Ok((id, info))
}

pub(super) async fn create(
    shared: &Shared,
    context: Option<&Context>,
    input: v5::SessionCreate,
) -> Result<JsonValue, v5::FailureCode> {
    let (host, _reservation) = session_scope(shared, context, "create").await?;
    let caller = context
        .map(|context| {
            owned_session(
                host,
                context
                    .session_id
                    .as_lossless()
                    .as_str()
                    .ok_or(v5::FailureCode::Rejected)?,
            )
            .map(|(_, info)| info)
        })
        .transpose()?;
    let event_id = projector::random_event_id().map_err(|_| execution())?;
    let id = match input.session {
        Some(id) => session::Id::new(id).map_err(|_| rejected())?,
        None => session::Id::new(crate::platform::identifier("ses_").map_err(|_| execution())?)
            .map_err(|_| execution())?,
    };
    if host.store.get(&id).map_err(|_| execution())?.is_some() {
        return Ok(
            accessible(shared, id.as_lossless().as_str().ok_or(rejected())?)?
                .1
                .encode(),
        );
    }
    let parent = input
        .parent
        .as_deref()
        .map(|id| accessible(shared, id).map(|(_, info)| info))
        .transpose()?;
    let agent = input
        .agent
        .map(wire::read_text)
        .transpose()
        .map_err(|_| rejected())?;
    if agent.as_ref().and_then(LosslessString::as_str) == Some("decision") {
        return Err(rejected());
    }
    let model =
        model(input.model)?.or_else(|| parent.as_ref().and_then(|parent| parent.model.clone()));
    if !shared.parent && model.as_ref().is_some_and(|model| model.profile.is_some()) {
        return Err(rejected());
    }
    let requested = input
        .permission_ceiling
        .map(|value| {
            wire::read_value(value)
                .ok()
                .and_then(|value| permission::Ruleset::decode(&value).ok())
                .ok_or(rejected())
        })
        .transpose()?;
    let ceiling = inherit_permission_ceiling(
        caller
            .as_ref()
            .and_then(|caller| caller.permission_ceiling.as_ref()),
        parent
            .as_ref()
            .and_then(|parent| parent.permission_ceiling.as_ref()),
    );
    let ceiling = inherit_permission_ceiling(Some(&ceiling), requested.as_ref());
    let title = input
        .title
        .map(wire::read_text)
        .transpose()
        .map_err(|_| rejected())?
        .unwrap_or_else(|| {
            format!(
                "New session - {}",
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            )
            .into()
        });
    let now = chrono::Utc::now().timestamp_millis();
    let placement = parent.as_ref().or(caller.as_ref());
    let location = match input.location {
        Some(value) if shared.parent => {
            ycoding_schema::location::Ref::decode(&wire::read_value(value).map_err(|_| rejected())?)
                .map_err(|_| rejected())?
        }
        Some(_) => return Err(rejected()),
        None => placement.map_or_else(
            || host.location.clone(),
            |placement| placement.location.clone(),
        ),
    };
    if !shared.parent && placement.is_none() {
        return Err(rejected());
    }
    let parent_services = if shared.parent {
        Some(
            shared
                .services_at(&location)
                .await
                .map_err(|_| rejected())?,
        )
    } else {
        None
    };
    let project_id = match placement.filter(|placement| placement.location == location) {
        Some(placement) => placement.project_id.clone(),
        None => parent_services
            .as_ref()
            .and_then(|services| services.reads.as_ref())
            .ok_or(rejected())?
            .location
            .project
            .id
            .clone(),
    };
    let event = NewEvent {
        id: event_id.as_lossless().clone(),
        aggregate_id: id.as_lossless().clone(),
        created: now,
        type_: "session.created.2".into(),
        data: ObjectEncoder::new()
            .field("sessionID", &id)
            .field("projectID", &project_id)
            .field("location", &location)
            .optional("parentID", &parent.as_ref().map(|parent| parent.id.clone()))
            .optional("agent", &agent)
            .optional("model", &model)
            .optional(
                "permissionCeiling",
                &(!ceiling.is_empty()).then_some(ceiling),
            )
            .field("title", &title)
            .optional(
                "subpath",
                &placement.and_then(|placement| placement.subpath.clone()),
            )
            .field("created", &(now as f64))
            .finish(),
    };
    let inherited_binding = parent
        .as_ref()
        .map(|parent| host.store.profile_binding(&parent.id))
        .transpose()
        .map_err(|_| execution())?
        .flatten();
    let created = match parent_services {
        Some(services) => services
            .runner
            .create(event, inherited_binding.as_ref())
            .await
            .map_err(|_| execution())?,
        None => host.store.create(event).await.map_err(|_| execution())?,
    };
    if created.location != location {
        return Err(rejected());
    }
    Ok(created.encode())
}

pub(super) async fn generate(
    shared: &Shared,
    context: Option<&Context>,
    input: v5::SessionGenerate,
    mut cancelled: watch::Receiver<bool>,
) -> Result<JsonValue, v5::FailureCode> {
    let (host, _reservation) = session_scope(shared, context, "generate").await?;
    let (id, info) = accessible(shared, &input.session)?;
    let services = if shared.parent {
        shared
            .services_at(&info.location)
            .await
            .map_err(|_| rejected())?
    } else {
        services(shared, host)?
    };
    let prompt = wire::read_text(input.prompt).map_err(|_| rejected())?;
    let cancellation = context
        .map(|context| context.cancellation.clone())
        .unwrap_or_default();
    if *cancelled.borrow() {
        return Err(rejected());
    }
    let text = tokio::select! { biased;
        _ = cancelled.changed() => return Err(rejected()),
        text = services.generate.generate(&id, prompt, &cancellation) => text.map_err(|_| execution())?,
    };
    Ok(ObjectEncoder::new().field("text", &text).finish())
}

pub(super) async fn command(
    shared: &Shared,
    context: Option<&Context>,
    input: v5::SessionCommand,
) -> Result<JsonValue, v5::FailureCode> {
    let (host, _reservation) = session_scope(shared, context, "command").await?;
    let (id, info) = accessible(shared, &input.session)?;
    let services = if shared.parent {
        shared
            .services_at(&info.location)
            .await
            .map_err(|_| rejected())?
    } else {
        services(shared, host)?
    };
    let request = request(id, input.message, input.input, false)?;
    let name = wire::read_text(input.command).map_err(|_| rejected())?;
    let arguments = wire::read_text(input.arguments).map_err(|_| rejected())?;
    let agent = input
        .agent
        .map(wire::read_text)
        .transpose()
        .map_err(|_| rejected())?;
    let commands = services.commands.snapshot();
    let admitted = services
        .runner
        .command_from(
            Execution::global().ok_or(rejected())?,
            &commands,
            shared.host.mcp.as_deref(),
            &services.configuration,
            CommandInput {
                request,
                name: &name,
                arguments: &arguments,
                agent,
                model: model(input.model)?,
                resume: input.resume,
            },
            crate::session::autonomy::Origin::Plugin,
        )
        .await
        .map_err(|error| match error {
            IngressError::Execution(error) => admission_error(error),
            IngressError::CommandNotFound(_)
            | IngressError::CommandEvaluation { .. }
            | IngressError::Invalid(_) => rejected(),
            _ => execution(),
        })?;
    Ok(admission(admitted))
}

pub(super) async fn synthetic(
    shared: &Shared,
    context: Option<&Context>,
    input: v5::SessionSynthetic,
) -> Result<JsonValue, v5::FailureCode> {
    let (_, _reservation) = session_scope(shared, context, "synthetic").await?;
    let (id, _) = accessible(shared, &input.session)?;
    let admitted = Execution::global()
        .ok_or(rejected())?
        .prompt_with_origin(
            request(id, input.message, input.input, true)?,
            input.resume,
            crate::session::autonomy::Origin::Plugin,
        )
        .await
        .map_err(admission_error)?;
    Ok(admission(admitted))
}

fn services(shared: &Shared, host: &SessionHost) -> Result<SessionServices, v5::FailureCode> {
    let services = shared.services().map_err(|_| rejected())?;
    if services.runner.location() != &host.location || services.generate.location != host.location {
        return Err(rejected());
    }
    Ok(services)
}
fn model(value: Option<v5::Value>) -> Result<Option<model::Ref>, v5::FailureCode> {
    value
        .map(|value| {
            let value = wire::read_value(value).map_err(|_| rejected())?;
            fields(&value, &["providerID", "id", "variant", "profile"])?;
            model::Ref::decode(&value).map_err(|_| rejected())
        })
        .transpose()
}
fn request(
    id: session::Id,
    message: String,
    input: v5::Value,
    synthetic: bool,
) -> Result<pending::Request, v5::FailureCode> {
    let value = wire::read_value(input).map_err(|_| rejected())?;
    let object = fields(&value, &["type", "data", "delivery"])?;
    fields(
        object.get(&"data".into()).ok_or(rejected())?,
        if synthetic {
            &["text", "description", "metadata"]
        } else {
            &["text", "files", "agents", "metadata"]
        },
    )?;
    let input = session_pending::Message::decode(&value).map_err(|_| rejected())?;
    if !matches!(
        (&input, synthetic),
        (session_pending::Message::Synthetic(_), true) | (session_pending::Message::User(_), false)
    ) {
        return Err(rejected());
    }
    Ok(pending::Request {
        id: session_message::Id::new(message).map_err(|_| rejected())?,
        session_id: id,
        input,
        event_id: projector::random_event_id().map_err(|_| execution())?,
        created: chrono::Utc::now().timestamp_millis(),
    })
}
fn fields<'a>(
    value: &'a JsonValue,
    allowed: &[&str],
) -> Result<&'a ycoding_schema::JsonObject, v5::FailureCode> {
    let JsonValue::Object(object) = value else {
        return Err(rejected());
    };
    if object
        .iter()
        .any(|(key, _)| !key.as_str().is_some_and(|key| allowed.contains(&key)))
    {
        return Err(rejected());
    }
    Ok(object)
}
fn admission(admitted: Pending) -> JsonValue {
    ObjectEncoder::new()
        .field("id", &admitted.id)
        .field("seq", &(admitted.admitted_seq as f64))
        .finish()
}
fn admission_error(error: run_coordinator::Error) -> v5::FailureCode {
    match error {
        run_coordinator::Error::Store(error)
            if matches!(
                &*error,
                ycoding_store::Error::Domain {
                    kind: "input_identity",
                    ..
                }
            ) =>
        {
            rejected()
        }
        _ => execution(),
    }
}
fn rejected() -> v5::FailureCode {
    v5::FailureCode::Rejected
}
fn execution() -> v5::FailureCode {
    v5::FailureCode::ExecutionFailed
}
