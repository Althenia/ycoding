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
            ycoding_schema::event_manifest::ALL.contains(&name)
                && !name.starts_with("credential")
                && !name.starts_with("auth")
        }
    }
}
pub(super) fn grant<'a>(
    shared: &'a Shared,
    family: v5::CapabilityFamily,
    scope: &str,
) -> Result<&'a FamilyGrant, Error> {
    shared
        .families
        .iter()
        .find(|grant| grant.family == family && grant.scopes.iter().any(|allowed| allowed == scope))
        .ok_or(Error::Unauthorized)
}
pub(super) async fn host_operation(
    shared: &Shared,
    context: &Context,
    operation: v5::host_call::Operation,
    cancelled: watch::Receiver<bool>,
) -> v5::host_reply::Outcome {
    let failed =
        |code: v5::FailureCode| v5::host_reply::Outcome::Failure(v5::Failure { code: code as i32 });
    let value = match operation_value(shared, context, operation, cancelled).await {
        Ok(value) => value,
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
    context: &Context,
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
            let (host, _reservation) = session_scope(shared, context, "get").await?;
            Ok(owned_session(host, &get.session)?.1.encode())
        }
        v5::host_call::Operation::SessionPrompt(prompt) => {
            let (host, _reservation) = session_scope(shared, context, "prompt").await?;
            let (session_id, _) = owned_session(host, &prompt.session)?;
            let input = wire::read_value(prompt.input)
                .ok()
                .and_then(|value| session_pending::Message::decode(&value).ok())
                .filter(|input| matches!(input, session_pending::Message::User(_)))
                .ok_or(v5::FailureCode::Rejected)?;
            let admitted = Execution::global()
                .ok_or(v5::FailureCode::Rejected)?
                .prompt_with_origin(
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
                    crate::session::autonomy::Origin::Plugin,
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
            let (host, _reservation) = session_scope(shared, context, "interrupt").await?;
            let (session_id, _) = owned_session(host, &interrupt.session)?;
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
    }
}
pub(super) async fn session_scope<'a>(
    shared: &'a Shared,
    context: &Context,
    scope: &str,
) -> Result<(&'a SessionHost, Reservation), v5::FailureCode> {
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
async fn authorize(
    shared: &Shared,
    context: &Context,
    family: v5::CapabilityFamily,
    scope: &str,
) -> Result<Reservation, v5::FailureCode> {
    let grant = grant(shared, family, scope).map_err(|_| v5::FailureCode::Rejected)?;
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
                                .transform(&registration, &event.context, 0, draft)
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
                                .transform(&registration, &event.context, 0, draft)
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
        context: &Context,
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
            for registration in &extension.domains {
                let stage = v5::TransformStage::try_from(registration.domain)
                    .map_err(|_| Error::Protocol)?;
                let grant = grant(
                    &extension.shared,
                    v5::CapabilityFamily::Registrations,
                    scope(stage),
                )?;
                extension
                    .shared
                    .policy
                    .assert(
                        context,
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
                output.register(
                    stage,
                    &registration.key,
                    wire::read_value(registration.value.clone())?,
                )?;
                touched.insert(stage as i32);
            }
            for registration in &extension.declarations {
                let stage = v5::TransformStage::try_from(registration.stage)
                    .map_err(|_| Error::Protocol)?;
                if matches!(
                    stage,
                    v5::TransformStage::SessionContext
                        | v5::TransformStage::ToolBefore
                        | v5::TransformStage::ToolAfter
                        | v5::TransformStage::ToolDefinitions
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
        for stage in touched {
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
