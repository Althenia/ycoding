use super::{catalog, target};
use crate::{
    Environment, convert,
    dispatch::{Dispatcher, Failure, Invocation, RegistrationError},
    ids,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};
use ycoding_core::{
    resources::{auth::integration::Registry, credential::Error},
    ycoding_schema::{JsonObject, JsonValue, LosslessString, connection, integration, location},
};
use ycoding_protocol::v5;

#[derive(Clone)]
struct Entry {
    environment: Weak<Environment>,
    target: v5::ConnectorAuthTarget,
    location: location::Ref,
    project: LosslessString,
    integration: LosslessString,
    command: bool,
    native: Option<integration::AttemptId>,
    expires: f64,
}
type Attempts = Arc<Mutex<BTreeMap<(String, String), Entry>>>;

pub fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    let attempts: Attempts = Arc::new(Mutex::new(BTreeMap::new()));
    let state = attempts.clone();
    dispatcher.handle("provider.auth.list", move |invocation, request| {
        let state = state.clone();
        async move {
            prune(&state)?;
            list(invocation, request).await
        }
    })?;
    let state = attempts.clone();
    dispatcher.handle("provider.auth.key", move |invocation, request| {
        let state = state.clone();
        async move {
            prune(&state)?;
            key(invocation, request).await
        }
    })?;
    let state = attempts.clone();
    dispatcher.handle("provider.auth.begin", move |invocation, request| {
        let state = state.clone();
        async move { begin(invocation, request, state).await }
    })?;
    let state = attempts.clone();
    dispatcher.handle("provider.auth.status", move |invocation, request| {
        let state = state.clone();
        async move { status(invocation, request, state).await }
    })?;
    let state = attempts.clone();
    dispatcher.handle("provider.auth.complete", move |invocation, request| {
        let state = state.clone();
        async move { complete(invocation, request, state).await }
    })?;
    dispatcher.handle("provider.auth.cancel", move |invocation, request| {
        let state = attempts.clone();
        async move { cancel(invocation, request, state).await }
    })?;
    Ok(())
}

fn prune(attempts: &Attempts) -> Result<(), Failure> {
    attempts
        .lock()
        .map_err(|_| target::error(10, "Authentication ownership unavailable"))?
        .retain(|_, entry| {
            entry.expires > ids::now_millis() as f64 && entry.environment.strong_count() > 0
        });
    Ok(())
}

fn text(value: &v5::LosslessString, maximum: usize) -> Result<LosslessString, Failure> {
    let value = convert::domain(value)?;
    let valid = nonblank(&value)
        && value.code_units().count() <= maximum
        && !value.code_units().any(|unit| matches!(unit, 0 | 10 | 13));
    if !valid {
        return Err(target::error(1, "Invalid authentication field"));
    }
    Ok(value)
}

fn nonblank(value: &LosslessString) -> bool {
    value.code_units().any(|unit| !matches!(unit, 0x9..=0xd | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff))
}

fn registry(invocation: &Invocation, location: &location::Info) -> Result<Registry, Failure> {
    Ok(invocation
        .core()?
        .integrations
        .as_ref()
        .ok_or_else(|| target::error(10, "Location integration services are not composed"))?(
        location,
    )
    .map_err(|_| target::error(10, "Location integration services unavailable"))?
    .registry)
}

async fn offered(
    invocation: &Invocation,
    location: &location::Info,
) -> Result<
    (
        Registry,
        Vec<integration::Info>,
        Vec<ycoding_core::ycoding_schema::provider::IntegrationRef>,
    ),
    Failure,
> {
    let catalogs = catalog::services(invocation, location).await?;
    let providers = catalogs.models.catalog().integrations();
    let registry = registry(invocation, location)?;
    let integrations = registry
        .list_by(|a, b| {
            ycoding_core::platform::filesystem::collation::compare(
                &a.code_units().collect::<Vec<_>>(),
                &b.code_units().collect::<Vec<_>>(),
            )
        })
        .map_err(|_| target::error(10, "Integration registry unavailable"))?
        .into_iter()
        .filter(|integration| {
            providers
                .iter()
                .any(|provider| provider.integration_id == integration.id)
        })
        .collect();
    Ok((registry, integrations, providers))
}

async fn list(
    invocation: Invocation,
    request: v5::ProviderAuthListRequest,
) -> Result<v5::ProviderAuthListResult, Failure> {
    let location = target::auth(&invocation, &request.payload.target)?;
    let (_, integrations, providers) = offered(&invocation, &location.info).await?;
    let items = integrations
        .iter()
        .map(|integration| {
            Ok(v5::ConnectorAuthInfo {
                id: convert::wire(integration.id.as_lossless()),
                name: convert::wire(&integration.name),
                providers: v5::ConnectorAuthInfoProviders {
                    items: providers
                        .iter()
                        .filter(|provider| provider.integration_id == integration.id)
                        .map(|provider| convert::wire(&provider.provider_id.0))
                        .collect(),
                },
                profiles: v5::ConnectorAuthInfoProfiles {
                    items: integration
                        .connections
                        .iter()
                        .filter_map(|connection| match connection {
                            connection::Info::Credential(info) => {
                                Some(v5::ConnectorAuthInfoProfilesItem {
                                    name: convert::wire(&info.label),
                                    active: info.active,
                                })
                            }
                            _ => None,
                        })
                        .collect(),
                },
                methods: v5::ConnectorAuthInfoMethods {
                    items: integration
                        .methods
                        .iter()
                        .filter(|method| !matches!(method, integration::Method::Env(_)))
                        .map(method)
                        .collect::<Result<_, _>>()?,
                },
            })
        })
        .collect::<Result<_, Failure>>()?;
    Ok(v5::ProviderAuthListResult {
        data: v5::ProviderAuthListResultData { items },
    })
}

fn method(method: &integration::Method) -> Result<v5::ConnectorAuthInfoMethodsItem, Failure> {
    Ok(match method {
        integration::Method::Key(key) => v5::ConnectorAuthInfoMethodsItem { r#type: 1, id: None, label: key.label.as_ref().map(convert::wire).unwrap_or_else(|| convert::text("API key")), available: true, reason: None, prompts: None },
        integration::Method::Command(command) => v5::ConnectorAuthInfoMethodsItem { r#type: 3, id: Some(convert::wire(command.id.as_lossless())), label: convert::wire(&command.label), available: true, reason: None, prompts: None },
        integration::Method::OAuth(oauth) => v5::ConnectorAuthInfoMethodsItem { r#type: 2, id: Some(convert::wire(oauth.id.as_lossless())), label: convert::wire(&oauth.label), available: oauth.remote == Some(true), reason: (oauth.remote != Some(true)).then(|| convert::text("This sign-in requires a browser on the backend machine. Use /connect there or choose a remote-capable method.")), prompts: oauth.prompts.as_ref().map(|prompts| Ok(v5::ConnectorAuthInfoMethodsItemPrompts { items: prompts.iter().map(prompt).collect::<Result<_, Failure>>()? })).transpose()? },
        integration::Method::Env(_) => return Err(target::error(15, "Environment methods cannot be offered remotely")),
    })
}

fn when_op(when: &integration::When) -> Result<i32, Failure> {
    match when.op.as_str() {
        Some("eq") => Ok(1),
        Some("neq") => Ok(2),
        _ => Err(target::error(
            10,
            "Authentication prompt is unrepresentable",
        )),
    }
}

fn prompt(prompt: &integration::Prompt) -> Result<v5::ConnectorAuthPrompt, Failure> {
    Ok(v5::ConnectorAuthPrompt {
        kind: Some(match prompt {
            integration::Prompt::Text(prompt) => {
                v5::connector_auth_prompt::Kind::Value1(v5::ConnectorAuthPromptValue1 {
                    r#type: 1,
                    key: convert::wire(&prompt.key),
                    message: convert::wire(&prompt.message),
                    placeholder: prompt.placeholder.as_ref().map(convert::wire),
                    when: prompt
                        .when
                        .as_ref()
                        .map(|when| {
                            Ok(v5::ConnectorAuthPromptValue1When {
                                key: convert::wire(&when.key),
                                op: when_op(when)?,
                                value: convert::wire(&when.value),
                            })
                        })
                        .transpose()?,
                })
            }
            integration::Prompt::Select(prompt) => {
                v5::connector_auth_prompt::Kind::Value2(v5::ConnectorAuthPromptValue2 {
                    r#type: 1,
                    key: convert::wire(&prompt.key),
                    message: convert::wire(&prompt.message),
                    options: v5::ConnectorAuthPromptValue2Options {
                        items: prompt
                            .options
                            .iter()
                            .map(|option| v5::ConnectorAuthPromptValue2OptionsItem {
                                label: convert::wire(&option.label),
                                value: convert::wire(&option.value),
                                hint: option.hint.as_ref().map(convert::wire),
                            })
                            .collect(),
                    },
                    when: prompt
                        .when
                        .as_ref()
                        .map(|when| {
                            Ok(v5::ConnectorAuthPromptValue2When {
                                key: convert::wire(&when.key),
                                op: when_op(when)?,
                                value: convert::wire(&when.value),
                            })
                        })
                        .transpose()?,
                })
            }
        }),
    })
}

fn authorization(error: Error) -> Failure {
    match error {
        Error::UnknownOutcome => target::error(11, "Authentication outcome is unknown"),
        _ => target::error(1, "Provider authentication could not complete"),
    }
}

async fn key(
    invocation: Invocation,
    request: v5::ProviderAuthKeyRequest,
) -> Result<v5::ProviderAuthKeyResult, Failure> {
    let payload = request.payload;
    let id = text(&payload.integration_id, 128)?;
    let key = text(&payload.key, 8192)?;
    let label = text(&payload.label, 128)?;
    let location = target::auth(&invocation, &payload.target)?;
    let (registry, integrations, _) = offered(&invocation, &location.info).await?;
    if !integrations.iter().any(|integration| {
        integration.id.as_lossless() == &id
            && integration
                .methods
                .iter()
                .any(|method| matches!(method, integration::Method::Key(_)))
    }) {
        return Err(target::error(1, "API-key sign-in is unavailable"));
    }
    registry
        .login_key(id, Some(label), key, ids::now_millis())
        .await
        .map_err(authorization)?;
    Ok(v5::ProviderAuthKeyResult {
        data: v5::ProviderAuthKeyResultData { status: 1 },
    })
}

fn inputs(
    input: &v5::ProviderAuthBeginRequestPayloadInputs,
    prompts: &[integration::Prompt],
) -> Result<integration::Inputs, Failure> {
    if input.entries.len() > 32 {
        return Err(target::error(1, "Too many authentication inputs"));
    }
    let mut result = JsonObject::new();
    for entry in &input.entries {
        let key = text(&entry.key, 128)?;
        let value = convert::domain(&entry.value)?;
        if value.code_units().count() > 2048
            || !prompts.iter().any(|prompt| match prompt {
                integration::Prompt::Text(prompt) => prompt.key == key,
                integration::Prompt::Select(prompt) => prompt.key == key,
            })
            || result.insert(key, JsonValue::String(value)).is_some()
        {
            return Err(target::error(
                1,
                "Unknown or duplicate authentication input",
            ));
        }
    }
    for prompt in prompts {
        let (key, when) = match prompt {
            integration::Prompt::Text(prompt) => (&prompt.key, &prompt.when),
            integration::Prompt::Select(prompt) => (&prompt.key, &prompt.when),
        };
        let visible = match when {
            None => true,
            Some(when) => {
                let equal = result.get(&when.key) == Some(&JsonValue::String(when.value.clone()));
                if when_op(when)? == 1 { equal } else { !equal }
            }
        };
        if !visible {
            continue;
        }
        let Some(JsonValue::String(value)) = result.get(key) else {
            return Err(target::error(1, "Complete the authentication fields"));
        };
        if !nonblank(value)
            || matches!(prompt, integration::Prompt::Select(prompt) if !prompt.options.iter().any(|option| option.value == *value))
        {
            return Err(target::error(1, "Complete the authentication fields"));
        }
    }
    Ok(integration::Inputs(result))
}

fn time(time: &integration::AttemptTime) -> Result<v5::ConnectorAuthTime, Failure> {
    if !time.created.is_finite() || !time.expires.is_finite() {
        return Err(target::error(1, "Authentication time is unreadable"));
    }
    Ok(v5::ConnectorAuthTime {
        created: time.created,
        expires: time.expires,
    })
}

fn safe_url(value: &LosslessString) -> bool {
    if value.code_units().count() > 8192 {
        return false;
    }
    let Ok(url) = url::Url::parse(&convert::readable(value)) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && host != "localhost"
        && !host.ends_with(".localhost")
        && !host.starts_with("127.")
        && host != "[::1]"
        && !host.starts_with("[::ffff:7f")
}

async fn begin(
    invocation: Invocation,
    request: v5::ProviderAuthBeginRequest,
    attempts: Attempts,
) -> Result<v5::ProviderAuthBeginResult, Failure> {
    prune(&attempts)?;
    let payload = request.payload;
    let id = text(&payload.integration_id, 128)?;
    let method_id = text(&payload.method_id, 128)?;
    let label = text(&payload.label, 128)?;
    let location = target::auth(&invocation, &payload.target)?;
    let (registry, integrations, _) = offered(&invocation, &location.info).await?;
    let method = integrations
        .iter()
        .find(|integration| integration.id.as_lossless() == &id)
        .and_then(|integration| {
            integration.methods.iter().find(|method| match method {
                integration::Method::OAuth(method) => method.id.as_lossless() == &method_id,
                integration::Method::Command(method) => method.id.as_lossless() == &method_id,
                _ => false,
            })
        })
        .ok_or_else(|| target::error(1, "Authentication method unavailable"))?;
    let command = matches!(method, integration::Method::Command(_));
    let prompts = match method {
        integration::Method::OAuth(method) if method.remote == Some(true) => {
            method.prompts.as_deref().unwrap_or(&[])
        }
        integration::Method::Command(_) => &[],
        _ => {
            return Err(target::error(
                1,
                "Authentication requires sign-in on the machine",
            ));
        }
    };
    let inputs = inputs(&payload.inputs, prompts)?;
    let reservation = (
        invocation.connection_id.clone(),
        format!(
            "pending_{}",
            convert::readable(
                ids::event_id()
                    .map_err(|_| target::error(15, "Reservation ID unavailable"))?
                    .as_lossless()
            )
        ),
    );
    let entry = Entry {
        environment: Arc::downgrade(&invocation.environment),
        target: payload.target.clone(),
        location: target::reference(&location.info),
        project: location.info.project.id.as_lossless().clone(),
        integration: id.clone(),
        command,
        native: None,
        expires: ids::now_millis() as f64 + 600_000.0,
    };
    {
        let mut state = attempts
            .lock()
            .map_err(|_| target::error(10, "Authentication ownership unavailable"))?;
        if state
            .keys()
            .filter(|(owner, _)| owner == &invocation.connection_id)
            .count()
            >= 32
        {
            return Err(target::error(1, "Too many pending authentication attempts"));
        }
        state.insert(reservation.clone(), entry.clone());
    }
    let outcome = begin_attempt(&registry, id, method_id, inputs, label, command).await;
    let mut state = attempts
        .lock()
        .map_err(|_| target::error(10, "Authentication ownership unavailable"))?;
    match outcome {
        Ok(mut data) => {
            let native = integration::AttemptId(convert::domain(&data.attempt_id)?);
            let capability = format!(
                "con_{}",
                ycoding_core::session::prompt_cache::sha256(&reservation.1)
            );
            data.attempt_id = convert::text(&capability);
            state.remove(&reservation);
            state.insert(
                (
                    invocation.connection_id,
                    convert::readable(&convert::domain(&data.attempt_id)?),
                ),
                Entry {
                    native: Some(native),
                    expires: data.time.expires,
                    ..entry
                },
            );
            Ok(v5::ProviderAuthBeginResult { data })
        }
        Err(failure) => {
            if !matches!(failure, Failure::Connector { code: 11, .. }) {
                state.remove(&reservation);
            }
            Err(failure)
        }
    }
}

async fn begin_attempt(
    registry: &Registry,
    id: LosslessString,
    method: LosslessString,
    inputs: integration::Inputs,
    label: LosslessString,
    command: bool,
) -> Result<v5::ConnectorAuthAttempt, Failure> {
    if command {
        let attempt = registry
            .connect_command(id, method, Some(label), ids::now_millis())
            .await
            .map_err(authorization)?;
        return Ok(v5::ConnectorAuthAttempt {
            attempt_id: convert::wire(&attempt.attempt_id.0),
            r#type: 2,
            time: time(&attempt.time)?,
            url: None,
            instructions: None,
            mode: None,
            manual_code: None,
        });
    }
    let attempt = registry
        .connect(id.clone(), method, inputs, Some(label), ids::now_millis())
        .await
        .map_err(authorization)?;
    if !safe_url(&attempt.url) || attempt.instructions.code_units().count() > 2048 {
        registry
            .cancel(&id, &attempt.attempt_id)
            .await
            .map_err(authorization)?;
        return Err(target::error(
            1,
            "Provider authorization link cannot safely be opened remotely",
        ));
    }
    Ok(v5::ConnectorAuthAttempt {
        attempt_id: convert::wire(&attempt.attempt_id.0),
        r#type: 1,
        time: time(&attempt.time)?,
        url: Some(convert::wire(&attempt.url)),
        instructions: Some(convert::wire(&attempt.instructions)),
        mode: Some(match attempt.mode.as_str() {
            Some("auto") => 1,
            Some("code") => 2,
            _ => return Err(target::error(1, "Authentication mode is unreadable")),
        }),
        manual_code: attempt.manual_code,
    })
}

fn bound(
    invocation: &Invocation,
    target: &v5::ConnectorAuthTarget,
    integration: &v5::LosslessString,
    id: &v5::LosslessString,
    attempts: &Attempts,
) -> Result<(Registry, Entry, integration::AttemptId), Failure> {
    prune(attempts)?;
    let integration = text(integration, 128)?;
    let id = text(id, 128)?;
    let scalar = id
        .as_str()
        .ok_or_else(|| target::error(1, "Invalid authentication attempt"))?;
    if !scalar.strip_prefix("con_").is_some_and(|tail| {
        !tail.is_empty()
            && tail
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
    }) {
        return Err(target::error(1, "Invalid authentication attempt"));
    }
    let location = target::auth(invocation, target)?;
    let entry = attempts
        .lock()
        .map_err(|_| target::error(10, "Authentication ownership unavailable"))?
        .get(&(invocation.connection_id.clone(), scalar.into()))
        .filter(|entry| {
            entry
                .environment
                .upgrade()
                .is_some_and(|environment| Arc::ptr_eq(&environment, &invocation.environment))
                && entry.target == *target
                && entry.integration == integration
                && entry.location == target::reference(&location.info)
                && &entry.project == location.info.project.id.as_lossless()
        })
        .cloned()
        .ok_or_else(|| {
            target::error(
                1,
                "Authentication attempt is unavailable at its initiating Location",
            )
        })?;
    let native = entry
        .native
        .clone()
        .ok_or_else(|| target::error(1, "Authentication has not begun"))?;
    Ok((registry(invocation, &location.info)?, entry, native))
}

async fn status(
    invocation: Invocation,
    request: v5::ProviderAuthStatusRequest,
    attempts: Attempts,
) -> Result<v5::ProviderAuthStatusResult, Failure> {
    let payload = request.payload;
    let (registry, entry, id) = bound(
        &invocation,
        &payload.target,
        &payload.integration_id,
        &payload.attempt_id,
        &attempts,
    )?;
    let (status, timing) = if entry.command {
        match registry
            .command_status(&entry.integration, &id)
            .map_err(authorization)?
        {
            integration::CommandAttemptStatus::Pending { time, .. } => (1, time),
            integration::CommandAttemptStatus::Complete(time) => (2, time),
            integration::CommandAttemptStatus::Failed { time, .. } => (3, time),
            integration::CommandAttemptStatus::Expired(time) => (4, time),
        }
    } else {
        match registry
            .status(&entry.integration, &id)
            .map_err(authorization)?
        {
            integration::AttemptStatus::Pending(time) => (1, time),
            integration::AttemptStatus::Complete(time) => (2, time),
            integration::AttemptStatus::Failed { time, .. } => (3, time),
            integration::AttemptStatus::Expired(time) => (4, time),
        }
    };
    Ok(v5::ProviderAuthStatusResult {
        data: v5::ProviderAuthStatusResultData {
            status,
            time: time(&timing)?,
            message: (status == 3)
                .then(|| convert::text("Authentication failed. Try connecting again.")),
        },
    })
}

async fn complete(
    invocation: Invocation,
    request: v5::ProviderAuthCompleteRequest,
    attempts: Attempts,
) -> Result<v5::ProviderAuthCompleteResult, Failure> {
    let payload = request.payload;
    let code = text(&payload.code, 2048)?;
    let (registry, entry, id) = bound(
        &invocation,
        &payload.target,
        &payload.integration_id,
        &payload.attempt_id,
        &attempts,
    )?;
    if entry.command {
        return Err(target::error(
            1,
            "This attempt does not accept an authorization code",
        ));
    }
    registry
        .complete(
            &entry.integration,
            &id,
            Some(
                &code
                    .to_utf8()
                    .map_err(|_| target::error(1, "Invalid authorization code"))?,
            ),
            ids::now_millis(),
        )
        .await
        .map_err(authorization)?;
    Ok(v5::ProviderAuthCompleteResult {
        data: v5::ProviderAuthCompleteResultData { status: 1 },
    })
}

async fn cancel(
    invocation: Invocation,
    request: v5::ProviderAuthCancelRequest,
    attempts: Attempts,
) -> Result<v5::ProviderAuthCancelResult, Failure> {
    let payload = request.payload;
    let (registry, entry, id) = bound(
        &invocation,
        &payload.target,
        &payload.integration_id,
        &payload.attempt_id,
        &attempts,
    )?;
    if entry.command {
        registry
            .cancel_command(&entry.integration, &id)
            .await
            .map_err(authorization)?;
    } else {
        registry
            .cancel(&entry.integration, &id)
            .await
            .map_err(authorization)?;
    }
    attempts
        .lock()
        .map_err(|_| target::error(10, "Authentication ownership unavailable"))?
        .remove(&(
            invocation.connection_id,
            convert::readable(&convert::domain(&payload.attempt_id)?),
        ));
    Ok(v5::ProviderAuthCancelResult {
        data: v5::ProviderAuthCancelResultData { status: 1 },
    })
}
