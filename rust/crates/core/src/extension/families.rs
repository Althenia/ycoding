use super::{Error, Extension, FamilyGrant, SessionHost, supervisor::Shared, v5, wire};
use crate::{
    process::guardrails::Reservation,
    resources::{
        agent,
        auth::integration::{Authorization, OAuthImplementation, Registration},
        catalog, command,
        mcp::client::{Content, ToolResult},
        reference, skill,
    },
    session::execution::Execution,
    tools::{
        context::Context,
        materialization::{AfterEvent, BeforeEvent, HookRegistration},
        registry::{Failure, Registry},
    },
};
use std::{
    collections::BTreeSet,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, atomic::Ordering},
};
use tokio::sync::watch;
use ycoding_ai::llm::{ToolOutput, ToolResultValue};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder,
    credential, integration, parse_json, session, session_message, session_pending, stringify_json,
};
use ycoding_store::resources::Secret;
static PATH: std::sync::LazyLock<JsonPath> = std::sync::LazyLock::new(JsonPath::default);

pub(super) fn scope(stage: v5::TransformStage) -> &'static str {
    match stage {
        v5::TransformStage::Agents => "agents",
        v5::TransformStage::Commands => "commands",
        v5::TransformStage::References => "references",
        v5::TransformStage::Skills => "skills",
        v5::TransformStage::Catalog => "catalog",
        v5::TransformStage::SessionContext => "session.context",
        v5::TransformStage::ToolBefore => "tool.execute.before",
        v5::TransformStage::ToolAfter => "tool.execute.after",
        v5::TransformStage::ToolDefinitions => "tools",
        v5::TransformStage::Integrations => "integrations",
    }
}
pub(super) fn stage_family(stage: v5::TransformStage) -> v5::CapabilityFamily {
    if matches!(
        stage,
        v5::TransformStage::SessionContext
            | v5::TransformStage::ToolBefore
            | v5::TransformStage::ToolAfter
    ) {
        return v5::CapabilityFamily::Hooks;
    }
    v5::CapabilityFamily::Transforms
}
pub(super) fn valid_scope(family: v5::CapabilityFamily, name: &str) -> bool {
    match family {
        v5::CapabilityFamily::Tools => false,
        v5::CapabilityFamily::Hooks => [
            "session.context",
            "tool.execute.before",
            "tool.execute.after",
        ]
        .contains(&name),
        v5::CapabilityFamily::Transforms => [
            "agents",
            "commands",
            "references",
            "skills",
            "catalog",
            "tools",
        ]
        .contains(&name),
        v5::CapabilityFamily::Registrations => {
            ["agents", "commands", "skills", "catalog"].contains(&name)
        }
        v5::CapabilityFamily::Mcp | v5::CapabilityFamily::Auth => true,
        v5::CapabilityFamily::Providers => {
            name.starts_with("aisdk:") && name.len() <= 256 && !name.chars().any(char::is_control)
        }
        v5::CapabilityFamily::Session => [
            "create",
            "get",
            "prompt",
            "generate",
            "command",
            "synthetic",
            "interrupt",
        ]
        .contains(&name),
        v5::CapabilityFamily::Events => {
            name == "*"
                || (ycoding_schema::event_manifest::ALL.contains(&name)
                    && !name.starts_with("credential")
                    && !name.starts_with("auth"))
        }
    }
}
static TRUSTED: std::sync::LazyLock<FamilyGrant> = std::sync::LazyLock::new(|| FamilyGrant {
    family: v5::CapabilityFamily::Hooks,
    scopes: vec![],
    action: "plugin".into(),
    resources: vec!["*".into()],
});
pub(super) fn grant<'a>(
    shared: &'a Shared,
    family: v5::CapabilityFamily,
    scope: &str,
) -> Result<&'a FamilyGrant, Error> {
    if shared.trusted {
        return (family != v5::CapabilityFamily::Providers
            && (valid_scope(family, scope)
                || (shared.parent
                    && family == v5::CapabilityFamily::Transforms
                    && scope == "integrations")))
            .then_some(&*TRUSTED)
            .ok_or(Error::Unauthorized);
    }
    shared
        .families
        .iter()
        .find(|grant| {
            grant.family == family
                && grant.scopes.iter().any(|allowed| {
                    allowed == scope || (family == v5::CapabilityFamily::Events && allowed == "*")
                })
        })
        .ok_or(Error::Unauthorized)
}
pub(super) async fn host_operation(
    shared: &Shared,
    context: Option<&Context>,
    operation: v5::host_call::Operation,
    cancelled: watch::Receiver<bool>,
) -> v5::host_reply::Outcome {
    let failed = |code: v5::FailureCode| {
        v5::host_reply::Outcome::Failure(v5::Failure {
            code: code as i32,
            message: None,
        })
    };
    let missing = match &operation {
        v5::host_call::Operation::ProviderGet(get) => {
            Some(format!("Provider not found: {}", get.id))
        }
        _ => None,
    };
    let value = match operation_value(shared, context, operation, cancelled).await {
        Ok(value) => value,
        Err(v5::FailureCode::Rejected) if missing.is_some() => {
            return v5::host_reply::Outcome::Failure(v5::Failure {
                code: v5::FailureCode::Rejected as i32,
                message: missing.map(|message| wire::text(&message.as_str().into())),
            });
        }
        Err(code) => return failed(code),
    };
    if wire::check_value(&value).is_err() {
        return failed(v5::FailureCode::ExecutionFailed);
    }
    let value = wire::value(&value);
    if prost::Message::encoded_len(&value) >= wire::FRAME_BYTES - 1024 {
        return failed(v5::FailureCode::ExecutionFailed);
    }
    v5::host_reply::Outcome::Value(value)
}
async fn operation_value(
    shared: &Shared,
    context: Option<&Context>,
    operation: v5::host_call::Operation,
    cancelled: watch::Receiver<bool>,
) -> Result<JsonValue, v5::FailureCode> {
    let mcp = || shared.host.mcp.as_ref().ok_or(v5::FailureCode::Rejected);
    let mcp_family = v5::CapabilityFamily::Mcp;
    match operation {
        v5::host_call::Operation::Servers(_) => {
            let service = mcp()?;
            let mut servers = Vec::new();
            for server in service.servers().map_err(|_| execution())? {
                if authorize(shared, context, mcp_family, &server.name)
                    .await
                    .is_ok()
                {
                    servers.push(
                        ObjectEncoder::new()
                            .field("name", server.name.as_str())
                            .field("status", &server.status)
                            .finish(),
                    );
                }
            }
            Ok(JsonValue::Array(servers))
        }
        v5::host_call::Operation::Tools(_) => {
            let service = mcp()?;
            let mut tools = Vec::new();
            for tool in service.tools().await.map_err(|_| execution())? {
                if authorize(shared, context, mcp_family, &tool.server)
                    .await
                    .is_ok()
                {
                    tools.push(
                        ObjectEncoder::new()
                            .field("server", tool.server.as_str())
                            .optional("codemode", &tool.codemode)
                            .field("definition", &json(&tool.definition)?)
                            .finish(),
                    );
                }
            }
            Ok(JsonValue::Array(tools))
        }
        v5::host_call::Operation::ReadResource(read) => {
            let service = mcp()?;
            let _reservation = authorize(shared, context, mcp_family, &read.server).await?;
            let resource = service
                .read_resource(&read.server, &read.uri, Some(cancelled))
                .await
                .map_err(|_| execution())?;
            resource.as_ref().map_or(Ok(JsonValue::Null), json)
        }
        v5::host_call::Operation::CallTool(call) => {
            let service = mcp()?;
            let _reservation = authorize(shared, context, mcp_family, &call.server).await?;
            let args = wire::read_value(call.args).map_err(|_| v5::FailureCode::Rejected)?;
            let args = serde_json::from_str(&stringify_json(&args))
                .map_err(|_| v5::FailureCode::Rejected)?;
            let result = service
                .call_tool(&call.server, &call.name, args, Some(cancelled))
                .await
                .map_err(|_| execution())?;
            tool_result(&result)
        }
        v5::host_call::Operation::SessionGet(get) => {
            let (_, _reservation) = session_scope(shared, context, "get").await?;
            Ok(super::session::accessible(shared, &get.session)?.1.encode())
        }
        v5::host_call::Operation::SessionPrompt(prompt) => {
            let (_, _reservation) = session_scope(shared, context, "prompt").await?;
            let (session_id, _) = super::session::accessible(shared, &prompt.session)?;
            let input = wire::read_value(prompt.input)
                .ok()
                .and_then(|value| session_pending::Message::decode(&value).ok())
                .filter(|input| matches!(input, session_pending::Message::User(_)))
                .ok_or(v5::FailureCode::Rejected)?;
            let admitted = Execution::global()
                .ok_or(v5::FailureCode::Rejected)?
                .prompt_plugin(
                    crate::session::pending::Request {
                        id: session_message::Id::new(prompt.message)
                            .map_err(|_| v5::FailureCode::Rejected)?,
                        session_id,
                        input,
                        event_id: crate::session::projector::random_event_id()
                            .map_err(|_| execution())?,
                        created: chrono::Utc::now().timestamp_millis(),
                    },
                    prompt.resume,
                    &shared
                        .services()
                        .map_err(|_| v5::FailureCode::Rejected)?
                        .runner,
                )
                .await
                .map_err(|error| match error {
                    SessionError::Store(error)
                        if matches!(
                            &*error,
                            ycoding_store::Error::Domain {
                                kind: "input_identity",
                                ..
                            }
                        ) =>
                    {
                        v5::FailureCode::Rejected
                    }
                    _ => execution(),
                })?;
            Ok(ObjectEncoder::new()
                .field("id", &admitted.id)
                .field("seq", &(admitted.admitted_seq as f64))
                .finish())
        }
        v5::host_call::Operation::SessionInterrupt(interrupt) => {
            let (_, _reservation) = session_scope(shared, context, "interrupt").await?;
            let (session_id, _) = super::session::accessible(shared, &interrupt.session)?;
            Execution::global()
                .ok_or(v5::FailureCode::Rejected)?
                .interrupt(&session_id)
                .await
                .map_err(|_| execution())?;
            Ok(JsonValue::Null)
        }
        v5::host_call::Operation::SessionCreate(input) => {
            super::session::create(shared, context, input).await
        }
        v5::host_call::Operation::SessionGenerate(input) => {
            super::session::generate(shared, context, input, cancelled).await
        }
        v5::host_call::Operation::SessionCommand(input) => {
            super::session::command(shared, context, input).await
        }
        v5::host_call::Operation::SessionSynthetic(input) => {
            super::session::synthetic(shared, context, input).await
        }
        operation => domain_read(shared, operation).await,
    }
}
async fn domain_read(
    shared: &Shared,
    operation: v5::host_call::Operation,
) -> Result<JsonValue, v5::FailureCode> {
    use v5::host_call::Operation;
    let (services, reads, current) = read_services(shared)?;
    let wrapped = |data: JsonValue| {
        ObjectEncoder::new()
            .field("location", &reads.location)
            .field("data", &data)
            .finish()
    };
    let array = |items: Vec<JsonValue>| JsonValue::Array(items);
    match operation {
        Operation::AgentsList(input) => {
            if input.directory.is_none() && input.workspace.is_none() {
                return Ok(wrapped(array(
                    services
                        .runner
                        .agents()
                        .list()
                        .into_iter()
                        .map(DomainEncode::encode)
                        .collect(),
                )));
            }
            let directory = match input.directory {
                Some(text) => {
                    let value = wire::read_text(text).map_err(|_| v5::FailureCode::Rejected)?;
                    ycoding_schema::schema::AbsolutePath::decode(&JsonValue::String(value))
                        .map_err(|_| v5::FailureCode::Rejected)?
                }
                None => current.directory.clone(),
            };
            let workspace_id = match input.workspace {
                Some(text) => {
                    let value = wire::read_text(text).map_err(|_| v5::FailureCode::Rejected)?;
                    Some(
                        ycoding_schema::workspace_id::WorkspaceId::decode(&JsonValue::String(
                            value,
                        ))
                        .map_err(|_| v5::FailureCode::Rejected)?,
                    )
                }
                None => current.workspace_id.clone(),
            };
            let candidate = ycoding_schema::location::Ref {
                directory,
                workspace_id,
            };
            if candidate == current {
                return Ok(wrapped(array(
                    services
                        .runner
                        .agents()
                        .list()
                        .into_iter()
                        .map(DomainEncode::encode)
                        .collect(),
                )));
            }
            let (location, agents) = tokio::task::spawn_blocking({
                let agents_at = reads.agents_at.clone();
                move || agents_at(&candidate)
            })
            .await
            .map_err(|_| execution())?
            .map_err(|_| v5::FailureCode::Rejected)?;
            Ok(ObjectEncoder::new()
                .field("location", &location)
                .field("data", &array(agents))
                .finish())
        }
        Operation::AgentGet(get) => {
            let id: ycoding_schema::agent::Id = get.id.as_str().into();
            Ok(services
                .runner
                .agents()
                .get(&id)
                .map_or(JsonValue::Null, DomainEncode::encode))
        }
        Operation::CommandsList(_) => Ok(wrapped(array(
            services
                .commands
                .snapshot()
                .list()
                .iter()
                .map(DomainEncode::encode)
                .collect(),
        ))),
        Operation::ReferencesList(_) => Ok(wrapped(array(
            reads
                .references
                .snapshot()
                .list()
                .iter()
                .map(DomainEncode::encode)
                .collect(),
        ))),
        Operation::SkillsList(_) => {
            let skills = reads
                .skills
                .lock()
                .await
                .list()
                .await
                .map_err(|_| execution())?;
            Ok(wrapped(array(
                skills.iter().map(DomainEncode::encode).collect(),
            )))
        }
        Operation::ProvidersList(_) => {
            let saved = saved(&reads)?;
            Ok(wrapped(array(
                services
                    .runner
                    .models()
                    .catalog()
                    .available_providers(&saved)
                    .into_iter()
                    .map(DomainEncode::encode)
                    .collect(),
            )))
        }
        Operation::ProviderGet(get) => {
            let id = ycoding_schema::provider::Id(get.id.as_str().into());
            let catalog = services.runner.models().catalog();
            let provider = catalog
                .provider(&id)
                .filter(|_| catalog.provider_permitted(&id))
                .cloned()
                .ok_or(v5::FailureCode::Rejected)?;
            Ok(wrapped(provider.encode()))
        }
        Operation::ModelsList(_) => {
            let saved = saved(&reads)?;
            Ok(wrapped(array(
                services
                    .runner
                    .models()
                    .catalog()
                    .available(&saved)
                    .into_iter()
                    .map(|model| model.encode())
                    .collect(),
            )))
        }
        Operation::ModelGet(get) => {
            let saved = saved(&reads)?;
            Ok(services
                .runner
                .models()
                .catalog()
                .get(
                    &ycoding_schema::provider::Id(get.provider.as_str().into()),
                    &get.model.as_str().into(),
                    None,
                    &saved,
                )
                .map_or(JsonValue::Null, |model| model.encode()))
        }
        Operation::ModelDefault(_) => {
            let saved = saved(&reads)?;
            let catalog = services.runner.models().catalog();
            let data = catalog
                .default_model(&saved)
                .zip(catalog.default_selection(&saved))
                .map(|(model, selection)| {
                    let JsonValue::Object(mut object) = model.encode() else {
                        return model.encode();
                    };
                    object.insert("selection".into(), selection.encode());
                    JsonValue::Object(object)
                });
            Ok(ObjectEncoder::new()
                .field("location", &reads.location)
                .optional("data", &data)
                .finish())
        }
        Operation::PluginsList(_) => Ok(wrapped(array(
            reads
                .activation
                .declared_plugins()
                .await
                .into_iter()
                .map(|plugin| plugin.encode())
                .collect(),
        ))),
        Operation::AgentReload(_)
        | Operation::CommandReload(_)
        | Operation::ReferenceReload(_)
        | Operation::SkillReload(_)
        | Operation::CatalogReload(_) => {
            let stage = match operation {
                Operation::AgentReload(_) => v5::TransformStage::Agents,
                Operation::CommandReload(_) => v5::TransformStage::Commands,
                Operation::ReferenceReload(_) => v5::TransformStage::References,
                Operation::SkillReload(_) => v5::TransformStage::Skills,
                Operation::CatalogReload(_) => v5::TransformStage::Catalog,
                _ => return Err(v5::FailureCode::Rejected),
            };
            if shared.parent && shared.setup_pending() {
                reads
                    .reload
                    .enqueue(stage)
                    .map_err(|_| v5::FailureCode::ExecutionFailed)?;
            } else {
                reads
                    .reload
                    .request(stage)
                    .await
                    .map_err(|_| v5::FailureCode::ExecutionFailed)?;
            }
            Ok(JsonValue::Null)
        }
        Operation::IntegrationsList(_) => {
            let items = integration_registry(shared)?
                .list_by(|first, second| {
                    crate::platform::filesystem::collation::compare(
                        &first.code_units().collect::<Vec<_>>(),
                        &second.code_units().collect::<Vec<_>>(),
                    )
                })
                .map_err(|_| execution())?;
            Ok(wrapped(array(
                items.iter().map(DomainEncode::encode).collect(),
            )))
        }
        Operation::IntegrationGet(get) => {
            let info = integration_registry(shared)?
                .get(&get.id.as_str().into())
                .map_err(|_| execution())?;
            Ok(wrapped(info.map_or(JsonValue::Null, |info| info.encode())))
        }
        Operation::IntegrationActive(get) => {
            let active = integration_registry(shared)?
                .active(&get.id.as_str().into())
                .map_err(|_| execution())?;
            Ok(active.map_or(JsonValue::Null, |connection| connection.encode()))
        }
        Operation::IntegrationReload(_) if shared.parent => {
            reads
                .activation
                .reload_integrations()
                .await
                .map_err(|_| execution())?;
            integration_registry(shared)?
                .reload()
                .map_err(|_| execution())?;
            Ok(JsonValue::Null)
        }
        Operation::IntegrationConnectKey(input) if shared.parent => {
            integration_registry(shared)?
                .login_key(
                    input.integration.into(),
                    input
                        .label
                        .map(wire::read_text)
                        .transpose()
                        .map_err(|_| v5::FailureCode::Rejected)?,
                    wire::read_text(input.key).map_err(|_| v5::FailureCode::Rejected)?,
                    chrono::Utc::now().timestamp_millis(),
                )
                .await
                .map_err(|_| execution())?;
            Ok(JsonValue::Null)
        }
        Operation::IntegrationOauthConnect(input) if shared.parent => {
            let inputs = input
                .inputs
                .map(wire::read_value)
                .transpose()
                .map_err(|_| v5::FailureCode::Rejected)?
                .unwrap_or(JsonValue::Object(Default::default()));
            let inputs =
                integration::Inputs::decode(&inputs).map_err(|_| v5::FailureCode::Rejected)?;
            let value = integration_registry(shared)?
                .connect(
                    input.integration.into(),
                    input.method.into(),
                    inputs,
                    input
                        .label
                        .map(wire::read_text)
                        .transpose()
                        .map_err(|_| v5::FailureCode::Rejected)?,
                    chrono::Utc::now().timestamp_millis(),
                )
                .await
                .map_err(|_| execution())?;
            Ok(wrapped(value.encode()))
        }
        Operation::IntegrationOauthStatus(input) if shared.parent => {
            let value = integration_registry(shared)?
                .status(
                    &input.integration.into(),
                    &integration::AttemptId(input.attempt.into()),
                )
                .map_err(|_| execution())?;
            Ok(wrapped(value.encode()))
        }
        Operation::IntegrationOauthComplete(input) if shared.parent => {
            let code = input
                .code
                .map(wire::read_text)
                .transpose()
                .map_err(|_| v5::FailureCode::Rejected)?
                .map(|code| code.to_utf8())
                .transpose()
                .map_err(|_| v5::FailureCode::Rejected)?;
            integration_registry(shared)?
                .complete(
                    &input.integration.into(),
                    &integration::AttemptId(input.attempt.into()),
                    code.as_deref(),
                    chrono::Utc::now().timestamp_millis(),
                )
                .await
                .map_err(|_| execution())?;
            Ok(JsonValue::Null)
        }
        Operation::IntegrationOauthCancel(input) if shared.parent => {
            integration_registry(shared)?
                .cancel(
                    &input.integration.into(),
                    &integration::AttemptId(input.attempt.into()),
                )
                .await
                .map_err(|_| execution())?;
            Ok(JsonValue::Null)
        }
        Operation::IntegrationCommandConnect(input) if shared.parent => {
            let value = integration_registry(shared)?
                .connect_command(
                    input.integration.into(),
                    input.method.into(),
                    input
                        .label
                        .map(wire::read_text)
                        .transpose()
                        .map_err(|_| v5::FailureCode::Rejected)?,
                    chrono::Utc::now().timestamp_millis(),
                )
                .await
                .map_err(|_| execution())?;
            Ok(wrapped(value.encode()))
        }
        Operation::IntegrationCommandStatus(input) if shared.parent => {
            let value = integration_registry(shared)?
                .command_status(
                    &input.integration.into(),
                    &integration::AttemptId(input.attempt.into()),
                )
                .map_err(|_| execution())?;
            Ok(wrapped(value.encode()))
        }
        Operation::IntegrationCommandCancel(input) if shared.parent => {
            integration_registry(shared)?
                .cancel_command(
                    &input.integration.into(),
                    &integration::AttemptId(input.attempt.into()),
                )
                .await
                .map_err(|_| execution())?;
            Ok(JsonValue::Null)
        }
        Operation::IntegrationConnectionResolve(input) if shared.parent => {
            let connection = ycoding_schema::connection::Info::decode(
                &wire::read_value(input.connection).map_err(|_| v5::FailureCode::Rejected)?,
            )
            .map_err(|_| v5::FailureCode::Rejected)?;
            let snapshot = integration_registry(shared)?
                .snapshot(connection, chrono::Utc::now().timestamp_millis())
                .await
                .map_err(|_| execution())?;
            Ok(snapshot
                .value
                .map_or(JsonValue::Null, |value| value.value().clone()))
        }
        _ => Err(v5::FailureCode::Rejected),
    }
}
fn integration_registry(
    shared: &Shared,
) -> Result<&crate::resources::auth::integration::Registry, v5::FailureCode> {
    shared
        .host
        .integrations
        .as_ref()
        .ok_or(v5::FailureCode::Rejected)
}
fn read_services(
    shared: &Shared,
) -> Result<
    (
        super::supervisor::SessionServices,
        super::supervisor::Reads,
        ycoding_schema::location::Ref,
    ),
    v5::FailureCode,
> {
    if !shared.trusted {
        return Err(v5::FailureCode::Rejected);
    }
    let host = shared
        .host
        .sessions
        .as_ref()
        .ok_or(v5::FailureCode::Rejected)?;
    let services = shared.services().map_err(|_| v5::FailureCode::Rejected)?;
    if services.runner.location() != &host.location {
        return Err(v5::FailureCode::Rejected);
    }
    let reads = services.reads.clone().ok_or(v5::FailureCode::Rejected)?;
    Ok((services, reads, host.location.clone()))
}
fn saved(
    reads: &super::supervisor::Reads,
) -> Result<Vec<crate::resources::credential::Info>, v5::FailureCode> {
    reads.credentials.all().map_err(|_| execution())
}
pub(super) async fn session_scope<'a>(
    shared: &'a Shared,
    context: Option<&Context>,
    scope: &str,
) -> Result<(&'a SessionHost, Option<Reservation>), v5::FailureCode> {
    let host = shared
        .host
        .sessions
        .as_ref()
        .ok_or(v5::FailureCode::Rejected)?;
    let reservation = authorize(shared, context, v5::CapabilityFamily::Session, scope).await?;
    Ok((host, reservation))
}
pub(super) fn owned_session(
    host: &SessionHost,
    id: &str,
) -> Result<(session::Id, session::Info), v5::FailureCode> {
    let id = session::Id::new(id).map_err(|_| v5::FailureCode::Rejected)?;
    let info = host
        .store
        .get(&id)
        .map_err(|_| execution())?
        .filter(|info| info.location == host.location)
        .ok_or(v5::FailureCode::Rejected)?;
    Ok((id, info))
}
fn execution() -> v5::FailureCode {
    v5::FailureCode::ExecutionFailed
}
// Configured plugins are authorized by configuration trust (main's plugin model); generic
// process extensions keep the calling Session's permission and guardrail checks.
async fn authorize(
    shared: &Shared,
    context: Option<&Context>,
    family: v5::CapabilityFamily,
    scope: &str,
) -> Result<Option<Reservation>, v5::FailureCode> {
    let grant = grant(shared, family, scope).map_err(|_| v5::FailureCode::Rejected)?;
    if shared.trusted {
        return Ok(None);
    }
    let context = context.ok_or(v5::FailureCode::Rejected)?;
    let resources = || {
        grant
            .resources
            .iter()
            .map(|resource| resource.as_str().into())
            .collect::<Vec<_>>()
    };
    shared
        .policy
        .assert(context, &grant.action, resources(), vec![], None)
        .await
        .map_err(|_| v5::FailureCode::Rejected)?;
    shared
        .policy
        .reserve(context, &grant.action, resources(), None)
        .await
        .map(Some)
        .map_err(|_| v5::FailureCode::Rejected)
}
fn json(value: &serde_json::Value) -> Result<JsonValue, v5::FailureCode> {
    parse_json(&value.to_string()).map_err(|_| execution())
}
fn tool_result(result: &ToolResult) -> Result<JsonValue, v5::FailureCode> {
    let content = result
        .content
        .iter()
        .map(|content| match content {
            Content::Text(text) => ObjectEncoder::new()
                .field("type", "text")
                .field("text", text.as_str())
                .finish(),
            Content::Media { data, mime_type } => ObjectEncoder::new()
                .field("type", "media")
                .field("data", data.as_str())
                .field("mimeType", mime_type.as_str())
                .finish(),
        })
        .collect::<Vec<_>>();
    let structured = result.structured.as_ref().map(json).transpose()?;
    Ok(ObjectEncoder::new()
        .field("isError", &result.is_error)
        .field("content", &content)
        .optional("structured", &structured)
        .finish())
}
type CredentialError = crate::resources::credential::Error;
type SessionError = crate::session::run_coordinator::Error;
type AuthFuture<T> = Pin<Box<dyn Future<Output = Result<T, CredentialError>> + Send>>;
type Labels = Arc<Mutex<Vec<(Secret, LosslessString)>>>;
type Labeller = Arc<dyn Fn(&Secret) -> Option<LosslessString> + Send + Sync>;

pub(super) fn install_auth(
    shared: &Arc<Shared>,
    registrations: &[v5::OAuthRegistration],
) -> Result<Option<Registration>, Error> {
    let Some(integrations) = shared
        .host
        .integrations
        .as_ref()
        .filter(|_| !registrations.is_empty())
    else {
        return Ok(None);
    };
    let implementations = registrations
        .iter()
        .map(|registration| implementation(shared, registration))
        .collect::<Result<Vec<_>, _>>()?;
    integrations
        .transform(move |draft| {
            implementations
                .iter()
                .for_each(|implementation| draft.oauth(implementation.clone()))
        })
        .map(Some)
        .map_err(|_| Error::Stopped)
}
fn oauth_method(registration: &v5::OAuthRegistration) -> Result<integration::OAuthMethod, Error> {
    integration::OAuthMethod::decode(&wire::read_value(registration.method.clone())?)
        .map_err(|_| Error::Schema)
}
fn implementation(
    shared: &Arc<Shared>,
    registration: &v5::OAuthRegistration,
) -> Result<OAuthImplementation, Error> {
    let method = oauth_method(registration)?;
    let labels = Labels::default();
    let flow = Flow {
        shared: shared.clone(),
        integration: registration.integration.clone(),
        method: method
            .id
            .as_lossless()
            .to_utf8()
            .map_err(|_| Error::Schema)?,
        label: registration.label,
        implementation: registration.implementation,
        _implementation_owner: registration
            .implementation
            .filter(|_| shared.parent)
            .map(|id| {
                Arc::new(ImplementationOwner {
                    shared: shared.clone(),
                    id,
                })
            }),
        labels: labels.clone(),
    };
    Ok(OAuthImplementation {
        integration: registration.integration.as_str().into(),
        method,
        authorize: authorizer(flow.clone()),
        refresh: registration.refresh.then(|| refresher(flow.clone())),
        label: registration.label.then(|| labeller(labels)),
    })
}
pub(super) fn replace_integration_draft(
    shared: &Arc<Shared>,
    registry: &crate::resources::auth::integration::Registry,
    registration: &crate::resources::auth::integration::Registration,
    value: &JsonValue,
    oauth: &[v5::OAuthRegistration],
) -> Result<(), Error> {
    let decoder = ObjectDecoder::new(value, &PATH).map_err(|_| Error::Schema)?;
    let items: Vec<JsonValue> = decoder.field("items").map_err(|_| Error::Schema)?;
    let mut entries = Vec::new();
    for value in items {
        let object = ObjectDecoder::new(&value, &PATH).map_err(|_| Error::Schema)?;
        let reference = integration::Ref::decode(&value).map_err(|_| Error::Schema)?;
        let methods: Vec<integration::Method> = object
            .optional("methods")
            .map_err(|_| Error::Schema)?
            .unwrap_or_default();
        entries.push((reference, methods));
    }
    let oauth = oauth
        .iter()
        .map(|value| implementation(shared, value))
        .collect::<Result<Vec<_>, _>>()?;
    registry
        .replace(registration, move |draft| {
            let removed = draft
                .references()
                .into_iter()
                .filter(|reference| !entries.iter().any(|(next, _)| next.id == reference.id))
                .map(|reference| reference.id.as_lossless().clone())
                .collect::<Vec<_>>();
            for id in removed {
                draft.remove(&id);
            }
            for (reference, methods) in &entries {
                let id = reference.id.as_lossless();
                draft.update(id.clone(), |entry| entry.name = reference.name.clone());
                let removed = draft
                    .methods(id)
                    .iter()
                    .filter(|method| !methods.contains(method))
                    .cloned()
                    .collect::<Vec<_>>();
                for method in removed {
                    draft.remove_method(id, &method);
                }
                for method in methods {
                    draft.method(id.clone(), method.clone());
                }
            }
            for implementation in &oauth {
                draft.oauth(implementation.clone());
            }
        })
        .map_err(|_| Error::Stopped)
}
fn authorizer(
    flow: Flow,
) -> Arc<dyn Fn(integration::Inputs) -> AuthFuture<Authorization> + Send + Sync> {
    Arc::new(move |inputs| -> AuthFuture<Authorization> {
        let flow = flow.clone();
        Box::pin(async move { flow.authorize(inputs).await })
    })
}
fn refresher(flow: Flow) -> Arc<dyn Fn(credential::OAuth) -> AuthFuture<Secret> + Send + Sync> {
    Arc::new(move |stored| -> AuthFuture<Secret> {
        let flow = flow.clone();
        Box::pin(async move { flow.refresh(stored).await })
    })
}
fn labeller(labels: Labels) -> Labeller {
    Arc::new(move |secret: &Secret| {
        let mut labels = labels.lock().ok()?;
        let index = labels
            .iter()
            .position(|(candidate, _)| candidate == secret)?;
        Some(labels.remove(index).1)
    })
}
fn coder(
    flow: Flow,
    authorization: u64,
) -> Arc<dyn Fn(String) -> AuthFuture<Secret> + Send + Sync> {
    Arc::new(move |code| -> AuthFuture<Secret> {
        let flow = flow.clone();
        Box::pin(async move { flow.callback(authorization, Some(code)).await })
    })
}
fn submitter(
    flow: Flow,
    authorization: u64,
) -> Arc<dyn Fn(String) -> AuthFuture<()> + Send + Sync> {
    Arc::new(move |code| -> AuthFuture<()> {
        let flow = flow.clone();
        Box::pin(async move { flow.submit(authorization, code).await })
    })
}
#[derive(Clone)]
struct Flow {
    shared: Arc<Shared>,
    integration: String,
    method: String,
    label: bool,
    labels: Labels,
    implementation: Option<u64>,
    _implementation_owner: Option<Arc<ImplementationOwner>>,
}
struct ImplementationOwner {
    shared: Arc<Shared>,
    id: u64,
}
impl Drop for ImplementationOwner {
    fn drop(&mut self) {
        self.shared.release(self.id);
    }
}
impl Flow {
    async fn authorize(
        self,
        inputs: integration::Inputs,
    ) -> Result<Authorization, CredentialError> {
        let inputs = JsonValue::Object(inputs.0);
        wire::check_value(&inputs).map_err(auth_error)?;
        let (authorization, outcome) = self
            .shared
            .auth(v5::auth_request::Operation::Authorize(v5::AuthAuthorize {
                integration: self.integration.clone(),
                method: self.method.clone(),
                inputs: wire::value(&inputs),
                implementation: self.implementation,
            }))
            .await
            .map_err(auth_error)?;
        let v5::auth_reply::Outcome::Authorization(received) = outcome else {
            return Err(rejection(&outcome));
        };
        let text = |value| {
            wire::read_text(value)
                .map_err(auth_error)?
                .to_utf8()
                .map_err(|_| CredentialError::Rejected)
        };
        let url = text(received.url)?;
        let instructions = text(received.instructions)?;
        match v5::AuthMode::try_from(received.mode).map_err(|_| CredentialError::Rejected)? {
            v5::AuthMode::Code => Ok(Authorization::code(
                url,
                instructions,
                coder(self, authorization),
            )),
            v5::AuthMode::Auto => {
                let submit = received
                    .manual_code
                    .then(|| submitter(self.clone(), authorization));
                let expires_at = received
                    .expires_at
                    .filter(|expires| expires.is_finite())
                    .map(|expires| expires as i64);
                Ok(Authorization::automatic(
                    url,
                    instructions,
                    Box::pin(async move { self.callback(authorization, None).await }),
                    submit,
                    expires_at,
                ))
            }
        }
    }
    async fn callback(
        self,
        authorization: u64,
        code: Option<String>,
    ) -> Result<Secret, CredentialError> {
        let (_, outcome) = self
            .shared
            .auth(v5::auth_request::Operation::Callback(v5::AuthCallback {
                authorization,
                code: code.map(|code| wire::text(&LosslessString::from(code))),
            }))
            .await
            .map_err(auth_error)?;
        let secret = self.credential(outcome)?;
        if self.label {
            self.record_label(&secret).await;
        }
        Ok(secret)
    }
    async fn submit(self, authorization: u64, code: String) -> Result<(), CredentialError> {
        let (_, outcome) = self
            .shared
            .auth(v5::auth_request::Operation::Submit(v5::AuthSubmit {
                authorization,
                code: wire::text(&LosslessString::from(code)),
            }))
            .await
            .map_err(auth_error)?;
        match outcome {
            v5::auth_reply::Outcome::Done(_) => Ok(()),
            other => Err(rejection(&other)),
        }
    }
    async fn refresh(self, stored: credential::OAuth) -> Result<Secret, CredentialError> {
        let value = credential::Value::OAuth(stored).encode();
        wire::check_value(&value).map_err(auth_error)?;
        let (_, outcome) = self
            .shared
            .auth(v5::auth_request::Operation::Refresh(v5::AuthRefresh {
                integration: self.integration.clone(),
                method: self.method.clone(),
                credential: wire::value(&value),
                implementation: self.implementation,
            }))
            .await
            .map_err(auth_error)?;
        self.credential(outcome)
    }
    fn credential(&self, outcome: v5::auth_reply::Outcome) -> Result<Secret, CredentialError> {
        let v5::auth_reply::Outcome::Credential(value) = outcome else {
            return Err(rejection(&outcome));
        };
        let secret = wire::read_value(value)
            .ok()
            .and_then(|value| Secret::new(value).ok())
            .ok_or(CredentialError::Rejected)?;
        match secret.domain() {
            Ok(credential::Value::OAuth(oauth))
                if oauth.method_id.as_lossless().as_str() == Some(self.method.as_str()) =>
            {
                Ok(secret)
            }
            _ => Err(CredentialError::Rejected),
        }
    }
    async fn record_label(&self, secret: &Secret) {
        let Ok((_, v5::auth_reply::Outcome::Label(label))) = self
            .shared
            .auth(v5::auth_request::Operation::Label(v5::AuthLabel {
                integration: self.integration.clone(),
                method: self.method.clone(),
                credential: wire::value(secret.value()),
                implementation: self.implementation,
            }))
            .await
        else {
            return;
        };
        let Ok(label) = wire::read_text(label) else {
            return;
        };
        let Ok(mut labels) = self.labels.lock() else {
            return;
        };
        if labels.len() >= 8 {
            labels.remove(0);
        }
        labels.push((secret.clone(), label));
    }
}
fn auth_error(error: Error) -> CredentialError {
    match error {
        Error::Stopped => CredentialError::Closed,
        Error::Capacity => CredentialError::Rejected,
        _ => CredentialError::UnknownOutcome,
    }
}
fn rejection(outcome: &v5::auth_reply::Outcome) -> CredentialError {
    match outcome {
        v5::auth_reply::Outcome::Failure(failure)
            if failure.code == v5::FailureCode::UnknownOutcome as i32 =>
        {
            CredentialError::UnknownOutcome
        }
        _ => CredentialError::Rejected,
    }
}
pub(super) fn subscribe(shared: &Shared, subscription: v5::Subscription) -> Result<(), Error> {
    if subscription.id == 0
        || subscription.families.is_empty()
        || subscription.families.len() > wire::MAX_EVENT_FAMILIES
    {
        return Err(Error::Unauthorized);
    }
    for family in &subscription.families {
        grant(shared, v5::CapabilityFamily::Events, family)?;
    }
    let mut subscriptions = shared
        .subscriptions
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if subscriptions.len() >= wire::MAX_SUBSCRIPTIONS
        || subscriptions.contains_key(&subscription.id)
        || subscription.families.iter().collect::<BTreeSet<_>>().len()
            != subscription.families.len()
    {
        return Err(Error::Capacity);
    }
    subscriptions.insert(subscription.id, subscription.families);
    Ok(())
}
pub(super) fn unsubscribe(shared: &Shared, subscription: u64) -> Result<(), Error> {
    shared
        .subscriptions
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&subscription)
        .map(|_| ())
        .ok_or(Error::Protocol)
}
pub(super) fn event_matches(families: &[String], family: &str) -> bool {
    families.iter().any(|item| {
        item == family || (item == "*" && ycoding_schema::event_manifest::SERVER.contains(&family))
    })
}
pub(super) fn validate_batch(shared: &Shared, batch: &v5::RegisterTools) -> Result<(), Error> {
    let mut ids = BTreeSet::new();
    for registration in &batch.transforms {
        let stage =
            v5::TransformStage::try_from(registration.stage).map_err(|_| Error::Protocol)?;
        if registration.id.is_empty()
            || registration.id.len() > 128
            || !ids.insert(&registration.id)
        {
            return Err(Error::Protocol);
        }
        grant(shared, stage_family(stage), scope(stage))?;
    }
    let mut names = BTreeSet::new();
    for registration in &batch.domains {
        let stage =
            v5::TransformStage::try_from(registration.domain).map_err(|_| Error::Protocol)?;
        grant(shared, v5::CapabilityFamily::Registrations, scope(stage))?;
        if !names.insert((registration.domain, &registration.key)) {
            return Err(Error::Protocol);
        }
        validate_record(
            stage,
            &registration.key,
            &wire::read_value(registration.value.clone())?,
        )?;
    }
    let mut methods = BTreeSet::new();
    for registration in &batch.oauth {
        grant(
            shared,
            v5::CapabilityFamily::Auth,
            &registration.integration,
        )?;
        shared
            .host
            .integrations
            .as_ref()
            .ok_or(Error::Unauthorized)?;
        let method = oauth_method(registration)?;
        if !methods.insert((
            registration.integration.as_str(),
            method.id.as_lossless().clone(),
        )) {
            return Err(Error::Protocol);
        }
    }
    for subscription in &batch.subscriptions {
        subscribe(shared, subscription.clone())?;
    }
    Ok(())
}
pub(super) fn install_hooks(
    shared: &Arc<Shared>,
    declarations: &[v5::TransformRegistration],
    order: u32,
    registry: &Registry,
) -> Vec<HookRegistration> {
    declarations
        .iter()
        .filter_map(|registration| {
            let shared = shared.clone();
            let registration = registration.clone();
            match v5::TransformStage::try_from(registration.stage).ok()? {
                v5::TransformStage::ToolBefore => Some(registry.hooks.before_ordered(
                    order.saturating_add(1),
                    Arc::new(move |mut event: BeforeEvent| {
                        let shared = shared.clone();
                        let registration = registration.clone();
                        Box::pin(async move {
                            let draft = ObjectEncoder::new()
                                .field("tool", event.tool.as_str())
                                .field("input", &event.input)
                                .finish();
                            let response = shared
                                .transform(&registration, Some(&event.context), 0, draft)
                                .await
                                .map_err(super::supervisor::failure)?;
                            let decoder = ObjectDecoder::new(&response, &PATH)
                                .map_err(|_| Failure::message(Error::Schema.to_string()))?;
                            if decoder
                                .field::<ycoding_schema::LosslessString>("tool")
                                .map_err(|_| Failure::message(Error::Schema.to_string()))?
                                .as_str()
                                != Some(event.tool.as_str())
                            {
                                return Err(Failure::message(Error::Unauthorized.to_string()));
                            }
                            event.input = decoder
                                .field("input")
                                .map_err(|_| Failure::message(Error::Schema.to_string()))?;
                            Ok(event)
                        })
                    }),
                )),
                v5::TransformStage::ToolAfter => Some(registry.hooks.after_ordered(
                    order.saturating_add(1),
                    Arc::new(move |mut event: AfterEvent| {
                        let shared = shared.clone();
                        let registration = registration.clone();
                        Box::pin(async move {
                            let draft = ObjectEncoder::new()
                                .field("tool", event.tool.as_str())
                                .field("input", &event.input)
                                .field("result", &result_value(&event.result))
                                .optional("output", &event.output.as_ref().map(output_value))
                                .finish();
                            let response = shared
                                .transform(&registration, Some(&event.context), 0, draft)
                                .await
                                .map_err(super::supervisor::failure)?;
                            let decoder = ObjectDecoder::new(&response, &PATH)
                                .map_err(|_| Failure::message(Error::Schema.to_string()))?;
                            if decoder
                                .field::<ycoding_schema::LosslessString>("tool")
                                .map_err(|_| Failure::message(Error::Schema.to_string()))?
                                .as_str()
                                != Some(event.tool.as_str())
                                || decoder
                                    .field::<JsonValue>("input")
                                    .map_err(|_| Failure::message(Error::Schema.to_string()))?
                                    != event.input
                            {
                                return Err(Failure::message(Error::Unauthorized.to_string()));
                            }
                            event.result = read_result(
                                decoder
                                    .field("result")
                                    .map_err(|_| Failure::message(Error::Schema.to_string()))?,
                            )
                            .map_err(super::supervisor::failure)?;
                            event.output = decoder
                                .optional::<JsonValue>("output")
                                .map_err(|_| Failure::message(Error::Schema.to_string()))?
                                .map(read_output)
                                .transpose()
                                .map_err(super::supervisor::failure)?;
                            Ok(event)
                        })
                    }),
                )),
                _ => None,
            }
        })
        .collect()
}
pub(super) fn output_value(output: &ToolOutput) -> JsonValue {
    ObjectEncoder::new()
        .field("structured", &output.structured)
        .field("content", &output.content)
        .finish()
}
pub(super) fn read_output(value: JsonValue) -> Result<ToolOutput, Error> {
    let decoder = ObjectDecoder::new(&value, &PATH).map_err(|_| Error::Schema)?;
    Ok(ToolOutput {
        structured: decoder.field("structured").map_err(|_| Error::Schema)?,
        content: decoder.field("content").map_err(|_| Error::Schema)?,
    })
}
pub(super) fn result_value(result: &ToolResultValue) -> JsonValue {
    ObjectEncoder::new()
        .field(
            "type",
            match result {
                ToolResultValue::Json(_) => "json",
                ToolResultValue::Text(_) => "text",
                ToolResultValue::Error(_) => "error",
                ToolResultValue::Content(_) => "content",
            },
        )
        .field("value", &result.to_json())
        .finish()
}
pub(super) fn read_result(value: JsonValue) -> Result<ToolResultValue, Error> {
    let decoder = ObjectDecoder::new(&value, &PATH).map_err(|_| Error::Schema)?;
    let value = decoder.field("value").map_err(|_| Error::Schema)?;
    Ok(
        match decoder
            .tag("type", &["json", "text", "error", "content"])
            .map_err(|_| Error::Schema)?
            .as_str()
        {
            Some("json") => ToolResultValue::Json(value),
            Some("text") => ToolResultValue::Text(value),
            Some("error") => ToolResultValue::Error(value),
            Some("content") => {
                ToolResultValue::Content(Vec::decode(&value).map_err(|_| Error::Schema)?)
            }
            _ => return Err(Error::Schema),
        },
    )
}

#[derive(Clone)]
pub struct Resources {
    pub agents: agent::Service,
    pub commands: command::Service,
    pub references: reference::Service,
    pub skills: skill::Service,
    pub catalog: catalog::Catalog,
}
impl Resources {
    pub async fn materialize(
        &self,
        extensions: &[&Extension],
        context: Option<&Context>,
    ) -> Result<Self, Error> {
        self.materialize_filtered(extensions, context, None, true)
            .await
    }
    pub async fn materialize_stage(
        &self,
        stage: v5::TransformStage,
        extensions: &[&Extension],
        context: Option<&Context>,
    ) -> Result<Self, Error> {
        if !matches!(
            stage,
            v5::TransformStage::Agents
                | v5::TransformStage::Commands
                | v5::TransformStage::References
                | v5::TransformStage::Skills
                | v5::TransformStage::Catalog
        ) {
            return Err(Error::Unauthorized);
        }
        self.materialize_filtered(extensions, context, Some(stage), false)
            .await
    }
    async fn materialize_filtered(
        &self,
        extensions: &[&Extension],
        context: Option<&Context>,
        requested: Option<v5::TransformStage>,
        emit: bool,
    ) -> Result<Self, Error> {
        let mut output = self.clone();
        output.agents.event_source = Default::default();
        output.commands.event_source = Default::default();
        output.references.event_source = Default::default();
        output.skills.event_source = Default::default();
        output.catalog.event_source = Default::default();
        let mut touched = BTreeSet::new();
        let mut extensions = extensions.to_vec();
        extensions.sort_by_key(|extension| extension.order);
        for extension in extensions {
            if !extension.shared.accepting.load(Ordering::Acquire) {
                continue;
            }
            for registration in &extension.domains() {
                let stage = v5::TransformStage::try_from(registration.domain)
                    .map_err(|_| Error::Protocol)?;
                if requested.is_some_and(|requested| requested != stage) {
                    continue;
                }
                let grant = grant(
                    &extension.shared,
                    v5::CapabilityFamily::Registrations,
                    scope(stage),
                )?;
                if !extension.shared.trusted {
                    extension
                        .shared
                        .policy
                        .assert(
                            context.ok_or(Error::Permission)?,
                            &grant.action,
                            grant
                                .resources
                                .iter()
                                .map(|resource| resource.as_str().into())
                                .collect(),
                            vec![],
                            None,
                        )
                        .await
                        .map_err(|_| Error::Permission)?;
                }
                output.register(
                    stage,
                    &registration.key,
                    wire::read_value(registration.value.clone())?,
                )?;
                touched.insert(stage as i32);
            }
            for registration in &extension.declarations() {
                let stage = v5::TransformStage::try_from(registration.stage)
                    .map_err(|_| Error::Protocol)?;
                if requested.is_some_and(|requested| requested != stage) {
                    continue;
                }
                if matches!(
                    stage,
                    v5::TransformStage::SessionContext
                        | v5::TransformStage::ToolBefore
                        | v5::TransformStage::ToolAfter
                        | v5::TransformStage::ToolDefinitions
                        | v5::TransformStage::Integrations
                ) {
                    continue;
                }
                let draft = output.draft(stage)?;
                let transformed = extension
                    .shared
                    .transform(registration, context, 0, draft)
                    .await?;
                output.install(stage, transformed)?;
                touched.insert(stage as i32);
            }
            if !extension.shared.accepting.load(Ordering::Acquire) {
                return Err(Error::Stopped);
            }
        }
        output.agents.event_source = self.agents.event_source.clone();
        output.commands.event_source = self.commands.event_source.clone();
        output.references.event_source = self.references.event_source.clone();
        output.skills.event_source = self.skills.event_source.clone();
        output.catalog.event_source = self.catalog.event_source.clone();
        for stage in touched.into_iter().filter(|_| emit) {
            use crate::event_feed::Data;
            let (source, data) =
                match v5::TransformStage::try_from(stage).map_err(|_| Error::Protocol)? {
                    v5::TransformStage::Agents => (
                        &output.agents.event_source,
                        Data::AgentUpdated(Box::new(ycoding_schema::agent::Empty)),
                    ),
                    v5::TransformStage::Commands => (
                        &output.commands.event_source,
                        Data::CommandUpdated(Box::new(ycoding_schema::command::Empty)),
                    ),
                    v5::TransformStage::References => (
                        &output.references.event_source,
                        Data::ReferenceUpdated(Box::new(ycoding_schema::models_dev::Empty)),
                    ),
                    v5::TransformStage::Skills => (
                        &output.skills.event_source,
                        Data::SkillUpdated(Box::new(ycoding_schema::models_dev::Empty)),
                    ),
                    v5::TransformStage::Catalog => (
                        &output.catalog.event_source,
                        Data::CatalogUpdated(Box::new(ycoding_schema::catalog::Empty)),
                    ),
                    _ => return Err(Error::Unauthorized),
                };
            source.emit(data).map_err(|_| Error::ExecutionFailed)?;
        }
        Ok(output)
    }
    fn register(
        &mut self,
        stage: v5::TransformStage,
        key: &str,
        value: JsonValue,
    ) -> Result<(), Error> {
        validate_record(stage, key, &value)?;
        match stage {
            v5::TransformStage::Agents => {
                let value =
                    ycoding_schema::agent::Info::decode(&value).map_err(|_| Error::Schema)?;
                self.agents
                    .update(value.id.clone(), |current| *current = value);
            }
            v5::TransformStage::Commands => {
                let value =
                    ycoding_schema::command::Info::decode(&value).map_err(|_| Error::Schema)?;
                self.commands
                    .update(value.name.clone(), |current| *current = value);
            }
            v5::TransformStage::References => {
                let value =
                    ycoding_schema::reference::Info::decode(&value).map_err(|_| Error::Schema)?;
                let mut values = self
                    .references
                    .list()
                    .iter()
                    .filter(|entry| entry.name != value.name)
                    .cloned()
                    .collect::<Vec<_>>();
                values.push(value);
                self.references
                    .replace(values)
                    .map_err(|_| Error::ExecutionFailed)?;
            }
            v5::TransformStage::Skills => self
                .skills
                .source(ycoding_schema::skill::Source::decode(&value).map_err(|_| Error::Schema)?),
            v5::TransformStage::Catalog => {
                let record = provider_record(&value)?;
                self.catalog
                    .providers
                    .retain(|entry| entry.provider.id != record.provider.id);
                self.catalog.providers.push(record);
            }
            _ => return Err(Error::Unauthorized),
        }
        Ok(())
    }
    fn draft(&self, stage: v5::TransformStage) -> Result<JsonValue, Error> {
        Ok(match stage {
            v5::TransformStage::Agents => ObjectEncoder::new()
                .field(
                    "items",
                    &self
                        .agents
                        .list()
                        .into_iter()
                        .map(DomainEncode::encode)
                        .collect::<Vec<_>>(),
                )
                .optional("default", &self.agents.default_id().cloned())
                .finish(),
            v5::TransformStage::Commands => ObjectEncoder::new()
                .field("items", &self.commands.list().to_vec())
                .finish(),
            v5::TransformStage::References => ObjectEncoder::new()
                .field("items", &self.references.list().to_vec())
                .finish(),
            v5::TransformStage::Skills => ObjectEncoder::new()
                .field("items", &self.skills.sources().to_vec())
                .finish(),
            v5::TransformStage::Catalog => ObjectEncoder::new()
                .field(
                    "items",
                    &self
                        .catalog
                        .providers
                        .iter()
                        .map(|record| {
                            ObjectEncoder::new()
                                .field("provider", &record.provider)
                                .field("models", &record.models)
                                .field("environment", &record.environment)
                                .finish()
                        })
                        .collect::<Vec<_>>(),
                )
                .optional("default", &self.catalog.configured_default().cloned())
                .finish(),
            _ => return Err(Error::Unauthorized),
        })
    }
    fn install(&mut self, stage: v5::TransformStage, draft: JsonValue) -> Result<(), Error> {
        let decoder = ObjectDecoder::new(&draft, &PATH).map_err(|_| Error::Schema)?;
        let items: Vec<JsonValue> = decoder.field("items").map_err(|_| Error::Schema)?;
        if items.len() > 256 {
            return Err(Error::Capacity);
        }
        match stage {
            v5::TransformStage::Agents => {
                let agents = items
                    .iter()
                    .map(ycoding_schema::agent::Info::decode)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| Error::Schema)?;
                unique(agents.iter().map(|agent| agent.id.clone()))?;
                let mut service = agent::Service::new(agents);
                service.set_default(decoder.optional("default").map_err(|_| Error::Schema)?);
                self.agents = service;
            }
            v5::TransformStage::Commands => {
                let commands = items
                    .iter()
                    .map(ycoding_schema::command::Info::decode)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| Error::Schema)?;
                unique(commands.iter().map(|command| command.name.clone()))?;
                let mut service = command::Service::default();
                for command in commands {
                    service.update(command.name.clone(), |current| *current = command);
                }
                self.commands = service;
            }
            v5::TransformStage::References => {
                let references = items
                    .iter()
                    .map(ycoding_schema::reference::Info::decode)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| Error::Schema)?;
                unique(references.iter().map(|reference| reference.name.clone()))?;
                self.references
                    .replace(references)
                    .map_err(|_| Error::ExecutionFailed)?;
            }
            v5::TransformStage::Skills => {
                let sources = items
                    .iter()
                    .map(ycoding_schema::skill::Source::decode)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| Error::Schema)?;
                if self
                    .skills
                    .sources()
                    .iter()
                    .any(|source| !sources.iter().any(|entry| entry.equals(source)))
                {
                    return Err(Error::Unauthorized);
                }
                for source in sources {
                    self.skills.source(source);
                }
            }
            v5::TransformStage::Catalog => {
                let records = items
                    .iter()
                    .map(provider_record)
                    .collect::<Result<Vec<_>, _>>()?;
                unique(records.iter().map(|record| record.provider.id.0.clone()))?;
                self.catalog.providers = records;
                self.catalog
                    .set_default(decoder.optional("default").map_err(|_| Error::Schema)?);
            }
            _ => return Err(Error::Unauthorized),
        }
        Ok(())
    }
}
fn unique(values: impl Iterator<Item = ycoding_schema::LosslessString>) -> Result<(), Error> {
    let mut seen = BTreeSet::new();
    for value in values {
        if !seen.insert(value) {
            return Err(Error::Schema);
        }
    }
    Ok(())
}
fn provider_record(value: &JsonValue) -> Result<catalog::ProviderRecord, Error> {
    let decoder = ObjectDecoder::new(value, &PATH).map_err(|_| Error::Schema)?;
    let provider: ycoding_schema::provider::Info =
        decoder.field("provider").map_err(|_| Error::Schema)?;
    if provider.id.is_retired()
        || provider
            .integration_id
            .as_ref()
            .and_then(|id| id.as_lossless().as_str())
            .is_some_and(ycoding_schema::provider::is_retired)
    {
        return Err(Error::Unauthorized);
    }
    let models: Vec<ycoding_schema::model::Info> =
        decoder.field("models").map_err(|_| Error::Schema)?;
    if models.iter().any(|model| model.provider_id != provider.id) {
        return Err(Error::Schema);
    }
    unique(models.iter().map(|model| model.id.clone()))?;
    Ok(catalog::ProviderRecord {
        provider,
        models,
        environment: decoder.field("environment").map_err(|_| Error::Schema)?,
    })
}
fn validate_record(stage: v5::TransformStage, key: &str, value: &JsonValue) -> Result<(), Error> {
    let matches = match stage {
        v5::TransformStage::Agents => {
            ycoding_schema::agent::Info::decode(value).map(|value| value.id.as_str() == Some(key))
        }
        v5::TransformStage::Commands => ycoding_schema::command::Info::decode(value)
            .map(|value| value.name.as_str() == Some(key)),
        v5::TransformStage::References => ycoding_schema::reference::Info::decode(value)
            .map(|value| value.name.as_str() == Some(key)),
        v5::TransformStage::Skills => {
            ycoding_schema::skill::Source::decode(value).map(|value| match value {
                ycoding_schema::skill::Source::Embedded(source) => {
                    source.skill.name.as_str() == Some(key)
                }
                ycoding_schema::skill::Source::Directory(source) => {
                    source.path.as_lossless().as_str() == Some(key)
                }
                ycoding_schema::skill::Source::Url(source) => source.url.as_str() == Some(key),
            })
        }
        v5::TransformStage::Catalog => {
            return if provider_record(value)?.provider.id.0.as_str() == Some(key) {
                Ok(())
            } else {
                Err(Error::Unauthorized)
            };
        }
        _ => return Err(Error::Unauthorized),
    }
    .map_err(|_| Error::Schema)?;
    if !matches {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::{event_matches, valid_scope};
    use crate::extension::v5;

    #[test]
    fn server_wildcard_scope_is_a_valid_event_scope() {
        assert!(valid_scope(v5::CapabilityFamily::Events, "*"));
        assert!(valid_scope(v5::CapabilityFamily::Events, "config.updated"));
        assert!(!valid_scope(
            v5::CapabilityFamily::Events,
            "credential.changed"
        ));
        assert!(!valid_scope(v5::CapabilityFamily::Events, "unknown.event"));
    }

    #[test]
    fn server_wildcard_matches_only_server_event_families() {
        let wildcard = vec!["*".to_owned()];
        assert!(event_matches(&wildcard, "config.updated"));
        assert!(event_matches(&wildcard, "session.created"));
        assert!(!event_matches(&wildcard, "session.compacted"));
        assert!(!event_matches(&wildcard, "lsp.updated"));
        assert!(!event_matches(&wildcard, "credential.changed"));
    }

    #[test]
    fn explicit_event_families_match_only_themselves() {
        let families = vec!["agent.updated".to_owned()];
        assert!(event_matches(&families, "agent.updated"));
        assert!(!event_matches(&families, "config.updated"));
    }
}
