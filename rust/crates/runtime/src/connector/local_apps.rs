use super::mcp::json::{base64, domain, unbase64, value};
use crate::{Dispatcher, Failure, Invocation, RegistrationError};
use prost::{Message, Name};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, PoisonError},
};
use ycoding_core::{
    local_app::{self, Service, Sessions},
    mcp_events::{Authorization, Cancellation},
    ycoding_schema::{
        DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, ObjectEncoder,
        local_app::{Category, Method, Register, Registration, Scope},
        mcp_events::{Principal, RequestContext},
        session, stringify_json,
    },
    ycoding_store::{Client, KeyPart, session::SessionTable, tuple_key},
};
use ycoding_protocol::{decode_strict, domain_json, v5};

pub const PREVIEW_URI: &str = "ui://ycoding/local-http-app/v1.html";
const HTML: &str = include_str!("mcp/local-http-app/index.html");
const POLICY: &str = "<script id=\"preview-policy\" type=\"application/json\">[]</script>";
const MIME: &str = "text/html;profile=mcp-app";

pub struct Output {
    pub value: JsonValue,
    pub metadata: Option<JsonValue>,
}
pub struct Capability {
    pub url: String,
    pub origin: String,
    pub expires_at: i64,
}
pub type PreviewFuture<'a> = Pin<Box<dyn Future<Output = Result<Capability, Failure>> + Send + 'a>>;
pub trait Preview: Send + Sync {
    fn origins(&self) -> Vec<String>;
    fn issue(
        &self,
        registration: Registration,
        scope: Scope,
        cancellation: Cancellation,
    ) -> PreviewFuture<'_>;
}
pub struct Dependencies {
    pub registry: Arc<Service>,
    pub authorization: Arc<dyn Authorization>,
    pub preview: Option<Arc<dyn Preview>>,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
#[derive(Clone)]
struct Lease {
    registration: Registration,
    scope: Scope,
    expires_at: Option<i64>,
    revoked: bool,
}
struct State {
    leases: BTreeMap<LosslessString, Lease>,
    closed: bool,
    cancellation: Cancellation,
}
pub struct Facade {
    deps: Dependencies,
    state: Mutex<State>,
}
struct Current {
    registration: Option<Registration>,
    view: JsonValue,
}
struct Cancel(Cancellation);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
struct Admission {
    registry: Arc<Service>,
    registration: Registration,
    scope: Scope,
    committed: bool,
}
impl Drop for Admission {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.registry.revoke(&self.registration.id, &self.scope);
        }
    }
}

impl Facade {
    pub fn new(deps: Dependencies) -> Self {
        Self {
            deps,
            state: Mutex::new(State {
                leases: BTreeMap::new(),
                closed: false,
                cancellation: Cancellation::default(),
            }),
        }
    }

    pub async fn execute(
        &self,
        operation: &str,
        raw: JsonValue,
        context: Option<RequestContext>,
        cancellation: Cancellation,
    ) -> Result<Output, Failure> {
        let context = context.ok_or_else(unavailable)?;
        validate_context(&context)?;
        let top = object(
            &raw,
            if operation == "local.app.list" {
                &["sessionID"]
            } else {
                &["sessionID", "input"]
            },
        )?;
        let session = session::Id::decode(required(top, "sessionID")?).map_err(|_| invalid())?;
        let input = if operation == "local.app.list" {
            JsonValue::Null
        } else {
            required(top, "input")?.clone()
        };
        let lifecycle = {
            let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if state.closed {
                return Err(unavailable());
            }
            state.cancellation.clone()
        };
        let work = Cancel(Cancellation::default());
        tokio::select! {
            biased;
            _ = lifecycle.cancelled() => Err(unavailable()),
            _ = cancellation.cancelled() => Err(cancelled(operation)),
            result = self.execute_inner(operation, input, session, context, work.0.clone()) => result,
        }
    }

    async fn fresh(
        &self,
        context: &RequestContext,
        session: &session::Id,
        prior: Option<&Scope>,
        cancellation: Cancellation,
    ) -> Result<Scope, Failure> {
        let grant = self
            .deps
            .authorization
            .resolve(context.clone(), cancellation.clone())
            .await
            .map_err(|_| unavailable())?;
        if cancellation.is_cancelled()
            || grant.expires_at <= (self.deps.clock)()
            || !identifier(&grant.grant_id)
        {
            return Err(unavailable());
        }
        let scope = Scope {
            principal: Principal {
                owner_id: context.principal.owner_id.clone(),
                device_id: context.principal.device_id.clone(),
                client_id: context.principal.client_id.clone(),
                grant_id: grant.grant_id,
                epoch: context.epoch.clone(),
            },
            session_id: session.clone(),
        };
        if prior.is_some_and(|prior| prior != &scope) {
            return Err(unavailable());
        }
        Ok(scope)
    }

    async fn execute_inner(
        &self,
        operation: &str,
        input: JsonValue,
        session: session::Id,
        context: RequestContext,
        cancellation: Cancellation,
    ) -> Result<Output, Failure> {
        if !matches!(
            operation,
            "local.app.register"
                | "local.app.list"
                | "local.app.revoke"
                | "local.app.open"
                | "local.app.status"
                | "local.app.http"
        ) {
            return Err(invalid());
        }
        let scope = self
            .fresh(&context, &session, None, cancellation.clone())
            .await?;
        if operation == "local.app.register" {
            let mut fields =
                object(&input, &["host", "port", "entryPath", "routes", "ttlMs"])?.clone();
            fields.insert("sessionID".into(), session.encode());
            let input = Register::decode(&JsonValue::Object(fields)).map_err(|_| invalid())?;
            let registration = self
                .deps
                .registry
                .register(input, scope.clone(), cancellation.clone())
                .await
                .map_err(engine)?;
            let mut admission = Admission {
                registry: self.deps.registry.clone(),
                registration,
                scope: scope.clone(),
                committed: false,
            };
            self.fresh(&context, &session, Some(&scope), cancellation.clone())
                .await?;
            if cancellation.is_cancelled()
                || !self
                    .deps
                    .registry
                    .list(&scope)
                    .map_err(engine)?
                    .iter()
                    .any(|app| app.id == admission.registration.id)
            {
                return Err(unavailable());
            }
            self.remember(&admission.registration, &scope)?;
            admission.committed = true;
            return Ok(public(admission.registration.encode()));
        }
        if operation == "local.app.list" {
            let apps = self.deps.registry.list(&scope).map_err(engine)?;
            return Ok(public(JsonValue::Array(
                apps.iter().map(DomainEncode::encode).collect(),
            )));
        }
        let fields = object(
            &input,
            match operation {
                "local.app.open" => &["id", "generation"],
                "local.app.http" => &["id", "generation", "method", "path", "headers", "body"],
                _ => &["id"],
            },
        )?;
        let id = opaque(required(fields, "id")?, "app_")?;
        let generation = if matches!(operation, "local.app.open" | "local.app.http") {
            Some(opaque(required(fields, "generation")?, "generation_")?)
        } else {
            None
        };
        let current = self.inspect(&id, &scope)?;
        if operation == "local.app.status" {
            return Ok(public(current.view));
        }
        let Some(registration) = current.registration else {
            if operation == "local.app.open" {
                return Ok(public(current.view));
            }
            return Err(unavailable());
        };
        if operation == "local.app.revoke" {
            self.remember(&registration, &scope)?;
            self.deps.registry.revoke(&id, &scope).map_err(engine)?;
            let expiry = {
                let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                let lease = state.leases.get_mut(&id).ok_or_else(unavailable)?;
                lease.revoked = true;
                lease.expires_at.unwrap_or(registration.expires_at)
            };
            return Ok(public(view(&id, &session, Some(expiry), Some("revoked"))));
        }
        let generation = generation.ok_or_else(invalid)?;
        if generation != registration.generation {
            return Err(unavailable());
        }
        if operation == "local.app.open" {
            let Some(preview) = &self.deps.preview else {
                return Ok(public(view(
                    &id,
                    &session,
                    Some(registration.expires_at),
                    Some("preview_unconfigured"),
                )));
            };
            let origins = self.origins()?;
            if origins.is_empty() {
                return Ok(public(view(
                    &id,
                    &session,
                    Some(registration.expires_at),
                    Some("preview_unconfigured"),
                )));
            }
            let capability = preview
                .issue(registration.clone(), scope.clone(), cancellation.clone())
                .await
                .map_err(|_| unavailable())?;
            self.fresh(&context, &session, Some(&scope), cancellation.clone())
                .await?;
            let latest = self.inspect(&id, &scope)?;
            let Some(latest) = latest.registration else {
                return Ok(public(latest.view));
            };
            validate_capability(&capability, &origins, &latest, (self.deps.clock)())?;
            if cancellation.is_cancelled() || latest.generation != generation {
                return Err(unavailable());
            }
            self.remember(&latest, &scope)?;
            self.deps
                .registry
                .publish(&id, &generation, &scope, Some(&capability.origin))
                .map_err(engine)?;
            {
                let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                if state.closed {
                    return Err(unavailable());
                }
                state
                    .leases
                    .get_mut(&id)
                    .ok_or_else(unavailable)?
                    .expires_at = Some(capability.expires_at);
            }
            return Ok(Output {
                value: view(&id, &session, Some(capability.expires_at), None),
                metadata: Some(
                    ObjectEncoder::new()
                        .field(
                            "localApp",
                            &ObjectEncoder::new()
                                .field("url", capability.url.as_str())
                                .field("origin", capability.origin.as_str())
                                .finish(),
                        )
                        .finish(),
                ),
            });
        }
        let method = Method::decode(required(fields, "method")?).map_err(|_| invalid())?;
        let path = domain_text(required(fields, "path")?, 4096)?;
        let headers = headers(fields.get(&"headers".into()))?;
        let body = fields
            .get(&"body".into())
            .map(|value| {
                let JsonValue::String(encoded) = value else {
                    return Err(invalid());
                };
                let encoded = encoded.as_str().ok_or_else(invalid)?;
                if encoded.len() > 87_384 {
                    return Err(too_large());
                }
                let bytes = unbase64(encoded).ok_or_else(invalid)?;
                if bytes.len() > 65_536 {
                    return Err(too_large());
                }
                if base64(&bytes) != encoded {
                    return Err(invalid());
                }
                Ok(bytes)
            })
            .transpose()?;
        self.remember(&registration, &scope)?;
        self.deps
            .registry
            .publish(&id, &generation, &scope, None)
            .map_err(engine)?;
        let response = self
            .deps
            .registry
            .dispatch(
                local_app::Request {
                    id: id.clone(),
                    generation,
                    scope: scope.clone(),
                    method,
                    path,
                    headers,
                    body,
                },
                cancellation.clone(),
            )
            .await
            .map_err(|error| {
                if error.category == Category::UpstreamUnavailable {
                    return cancelled(operation);
                }
                engine(error)
            })?;
        self.fresh(&context, &session, Some(&scope), cancellation.clone())
            .await?;
        if cancellation.is_cancelled() || self.inspect(&id, &scope)?.registration.is_none() {
            return Err(unavailable());
        }
        if response.body.len() > 1_048_576 {
            return Err(too_large());
        }
        let mut headers = JsonObject::new();
        for (key, value) in response.headers {
            headers.insert(key.into(), JsonValue::String(value.into()));
        }
        let response = ObjectEncoder::new()
            .field("status", &JsonValue::Number(f64::from(response.status)))
            .field("headers", &JsonValue::Object(headers))
            .field("body", base64(&response.body).as_str())
            .finish();
        if stringify_json(&response).len() > 2 * 1024 * 1024 {
            return Err(too_large());
        }
        Ok(public(response))
    }

    fn remember(&self, registration: &Registration, scope: &Scope) -> Result<(), Failure> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.closed {
            return Err(unavailable());
        }
        if let Some(existing) = state.leases.get(&registration.id) {
            return if &existing.scope == scope {
                Ok(())
            } else {
                Err(unavailable())
            };
        }
        if state.leases.len() >= 64 {
            let expired = state
                .leases
                .iter()
                .find(|(_, lease)| {
                    lease.revoked
                        || lease.expires_at.unwrap_or(lease.registration.expires_at)
                            <= (self.deps.clock)()
                })
                .map(|(id, _)| id.clone())
                .ok_or(Failure::Connector {
                    code: 9,
                    message: "Local app capacity is exhausted",
                })?;
            state.leases.remove(&expired);
        }
        state.leases.insert(
            registration.id.clone(),
            Lease {
                registration: registration.clone(),
                scope: scope.clone(),
                expires_at: None,
                revoked: false,
            },
        );
        Ok(())
    }

    fn inspect(&self, id: &LosslessString, scope: &Scope) -> Result<Current, Failure> {
        let lease = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .leases
            .get(id)
            .cloned();
        if lease.as_ref().is_some_and(|lease| &lease.scope != scope) {
            return Ok(Current {
                registration: None,
                view: view(id, &scope.session_id, None, Some("access_unavailable")),
            });
        }
        let registration = self
            .deps
            .registry
            .list(scope)
            .map_err(engine)?
            .into_iter()
            .find(|app| &app.id == id);
        let expiry = lease
            .as_ref()
            .map(|lease| lease.expires_at.unwrap_or(lease.registration.expires_at))
            .or_else(|| registration.as_ref().map(|app| app.expires_at));
        let reason = if lease.as_ref().is_some_and(|lease| lease.revoked) {
            Some("revoked")
        } else if expiry.is_some_and(|expiry| expiry <= (self.deps.clock)()) {
            Some("expired")
        } else if registration.is_none() {
            Some(if lease.is_some() {
                "revoked"
            } else {
                "not_registered"
            })
        } else if self.deps.preview.is_none() {
            Some("preview_unconfigured")
        } else if lease.as_ref().and_then(|lease| lease.expires_at).is_none() {
            Some("access_unavailable")
        } else {
            None
        };
        Ok(Current {
            registration,
            view: view(id, &scope.session_id, expiry, reason),
        })
    }

    fn origins(&self) -> Result<Vec<String>, Failure> {
        let origins = self
            .deps
            .preview
            .as_ref()
            .map(|preview| preview.origins())
            .unwrap_or_default();
        if origins.len() > 64 || !origins.iter().all(|origin| approved_origin(origin)) {
            return Err(unavailable());
        }
        Ok(origins)
    }

    pub fn resources(&self) -> JsonValue {
        let resources = if self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .closed
        {
            Vec::new()
        } else {
            vec![
                ObjectEncoder::new()
                    .field("uri", PREVIEW_URI)
                    .field("name", "Local HTTP app")
                    .field("mimeType", MIME)
                    .finish(),
            ]
        };
        ObjectEncoder::new()
            .field("resources", &JsonValue::Array(resources))
            .finish()
    }

    pub fn resource(&self, uri: &str) -> Option<JsonValue> {
        if uri != PREVIEW_URI
            || self
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .closed
        {
            return None;
        }
        let origins = self.origins().ok()?;
        if HTML.matches(POLICY).count() != 1 {
            return None;
        }
        let policy = stringify_json(&JsonValue::Array(
            origins
                .iter()
                .map(|origin| JsonValue::String(origin.as_str().into()))
                .collect(),
        ))
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
        let html = HTML.replace(
            POLICY,
            &format!("<script id=\"preview-policy\" type=\"application/json\">{policy}</script>"),
        );
        let csp = ObjectEncoder::new()
            .field(
                "frameDomains",
                &JsonValue::Array(
                    origins
                        .iter()
                        .map(|origin| JsonValue::String(origin.as_str().into()))
                        .collect(),
                ),
            )
            .field("connectDomains", &JsonValue::Array(Vec::new()))
            .field("resourceDomains", &JsonValue::Array(Vec::new()))
            .finish();
        Some(
            ObjectEncoder::new()
                .field(
                    "contents",
                    &JsonValue::Array(vec![
                        ObjectEncoder::new()
                            .field("uri", PREVIEW_URI)
                            .field("mimeType", MIME)
                            .field("text", html.as_str())
                            .field(
                                "_meta",
                                &ObjectEncoder::new()
                                    .field(
                                        "ui",
                                        &ObjectEncoder::new()
                                            .field("prefersBorder", &true)
                                            .field("csp", &csp)
                                            .finish(),
                                    )
                                    .finish(),
                            )
                            .finish(),
                    ]),
                )
                .finish(),
        )
    }

    pub async fn clear(&self) {
        {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.cancellation.cancel();
            state.cancellation = Cancellation::default();
            for lease in state.leases.values_mut() {
                lease.revoked = true;
            }
        }
        self.deps.registry.clear().await;
    }

    pub fn close(&self) -> impl Future<Output = ()> + Send + '_ {
        {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.closed = true;
            state.cancellation.cancel();
            for lease in state.leases.values_mut() {
                lease.revoked = true;
            }
        }
        self.deps.registry.close()
    }
}

pub(crate) struct BackendSessions {
    pub store: Client,
}
impl Sessions for BackendSessions {
    fn verify(
        &self,
        session: session::Id,
        cancellation: Cancellation,
    ) -> local_app::ResultFuture<'_, bool> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Ok(false);
            }
            let found = self
                .store
                .snapshot()
                .and_then(|snapshot| {
                    snapshot
                        .get::<SessionTable>(&tuple_key(&[KeyPart::String(session.as_lossless())]))
                })
                .map_err(|_| ycoding_core::ycoding_schema::local_app::Failure {
                    category: Category::InvalidRegistration,
                })?
                .is_some();
            Ok(found && !cancellation.is_cancelled())
        })
    }
}

pub fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    install::<v5::LocalAppRegisterRequest, v5::LocalAppRegisterResult>(
        dispatcher,
        "local.app.register",
    )?;
    install::<v5::LocalAppListRequest, v5::LocalAppListResult>(dispatcher, "local.app.list")?;
    install::<v5::LocalAppRevokeRequest, v5::LocalAppRevokeResult>(dispatcher, "local.app.revoke")?;
    install::<v5::LocalAppOpenRequest, v5::LocalAppOpenResult>(dispatcher, "local.app.open")?;
    install::<v5::LocalAppStatusRequest, v5::LocalAppStatusResult>(dispatcher, "local.app.status")?;
    install::<v5::LocalAppHttpRequest, v5::LocalAppHttpResult>(dispatcher, "local.app.http")
}

fn install<Q, R>(
    dispatcher: &mut Dispatcher,
    operation: &'static str,
) -> Result<(), RegistrationError>
where
    Q: Message + Name + Default + 'static,
    R: Message + Name + Default + 'static,
{
    dispatcher.handle::<Q, R, _, _>(operation, move |invocation, request| async move {
        handle::<Q, R>(operation, invocation, request).await
    })
}

async fn handle<Q: Message + Name, R: Message + Name + Default>(
    operation: &str,
    invocation: Invocation,
    request: Q,
) -> Result<R, Failure> {
    let (facade, context, cancellation) = invocation
        .mcp
        .as_ref()
        .and_then(|access| access.local_apps())
        .ok_or_else(unavailable)?;
    let Some(v5::scope::Target::Session(session)) = &invocation.scope.target else {
        return Err(invalid());
    };
    let decoded = value(
        &domain_json::decode(&Q::full_name(), &request.encode_to_vec()).map_err(|_| invalid())?,
    );
    let mut input = ObjectEncoder::new().field("sessionID", session.as_str());
    if operation != "local.app.list" {
        input = input.field(
            "input",
            required(object(&decoded, &["payload"])?, "payload")?,
        );
    }
    let output = facade
        .execute(operation, input.finish(), Some(context), cancellation)
        .await?;
    let mut result = ObjectEncoder::new().field("data", &output.value);
    if let Some(metadata) = output.metadata {
        result = result.field("metadata", &metadata);
    }
    let bytes = domain_json::encode(&R::full_name(), &domain(&result.finish()), 2 * 1024 * 1024)
        .map_err(|_| unavailable())?;
    decode_strict::<R>(&bytes).map_err(|_| unavailable())
}

fn public(value: JsonValue) -> Output {
    Output {
        value,
        metadata: None,
    }
}
fn invalid() -> Failure {
    Failure::Connector {
        code: 1,
        message: "Invalid local app parameters",
    }
}
fn unavailable() -> Failure {
    Failure::Connector {
        code: 12,
        message: "Local app access is unavailable",
    }
}
fn too_large() -> Failure {
    Failure::Connector {
        code: 2,
        message: "Local app exchange exceeds its body bound",
    }
}
fn cancelled(operation: &str) -> Failure {
    if operation == "local.app.http" {
        return Failure::Connector {
            code: 11,
            message: "Local app request did not settle; inspect the app state before retrying",
        };
    }
    unavailable()
}
fn engine(error: ycoding_core::ycoding_schema::local_app::Failure) -> Failure {
    match error.category {
        Category::InvalidRegistration => invalid(),
        Category::TooLarge => too_large(),
        Category::Busy => Failure::Connector {
            code: 9,
            message: "Local app capacity is exhausted",
        },
        Category::NotFound | Category::Expired => Failure::Connector {
            code: 7,
            message: "Local app registration is unavailable",
        },
        Category::Forbidden => unavailable(),
        Category::UnsupportedStream => Failure::Connector {
            code: 1,
            message: "Local app streaming and upgrades are unsupported",
        },
        Category::RedirectRejected => Failure::Connector {
            code: 12,
            message: "Local app redirect is outside its registered routes",
        },
        Category::UpstreamUnavailable => Failure::Connector {
            code: 10,
            message: "Local app upstream is unavailable",
        },
    }
}
fn object<'a>(value: &'a JsonValue, keys: &[&str]) -> Result<&'a JsonObject, Failure> {
    let JsonValue::Object(value) = value else {
        return Err(invalid());
    };
    if value
        .iter()
        .any(|(key, _)| !keys.iter().any(|known| key.as_str() == Some(*known)))
    {
        return Err(invalid());
    }
    Ok(value)
}
fn required<'a>(object: &'a JsonObject, key: &str) -> Result<&'a JsonValue, Failure> {
    object.get(&key.into()).ok_or_else(invalid)
}
fn domain_text(value: &JsonValue, maximum: usize) -> Result<LosslessString, Failure> {
    let JsonValue::String(value) = value else {
        return Err(invalid());
    };
    if value.is_empty() || value.len() > maximum || value.as_str().is_none() {
        return Err(invalid());
    }
    Ok(value.clone())
}
fn opaque(value: &JsonValue, prefix: &str) -> Result<LosslessString, Failure> {
    let value = domain_text(value, prefix.len() + 32)?;
    if !value
        .as_str()
        .and_then(|value| value.strip_prefix(prefix))
        .is_some_and(|value| {
            value.len() == 32
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
    {
        return Err(invalid());
    }
    Ok(value)
}
fn identifier(value: &LosslessString) -> bool {
    value.as_str().is_some_and(|value| {
        !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}
fn validate_context(context: &RequestContext) -> Result<(), Failure> {
    if !identifier(&context.request_id)
        || !identifier(&context.epoch)
        || !identifier(&context.principal.owner_id)
        || !identifier(&context.principal.device_id)
        || context.principal.client_id.is_empty()
        || context.principal.client_id.len() > 2048
        || context
            .principal
            .client_id
            .as_str()
            .is_none_or(|value| value.contains(['\r', '\n', '\0']))
    {
        return Err(unavailable());
    }
    Ok(())
}
fn headers(value: Option<&JsonValue>) -> Result<BTreeMap<String, String>, Failure> {
    let Some(JsonValue::Object(value)) = value else {
        return if value.is_none() {
            Ok(BTreeMap::new())
        } else {
            Err(invalid())
        };
    };
    if value.len() > 64 {
        return Err(invalid());
    }
    value
        .iter()
        .map(|(key, value)| {
            let key = key
                .as_str()
                .filter(|key| {
                    !key.is_empty()
                        && key.len() <= 128
                        && key.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&byte)
                        })
                })
                .ok_or_else(invalid)?;
            let JsonValue::String(value) = value else {
                return Err(invalid());
            };
            let value = value
                .as_str()
                .filter(|value| {
                    value.encode_utf16().count() <= 8192 && !value.contains(['\r', '\n', '\0'])
                })
                .ok_or_else(invalid)?;
            Ok((key.to_owned(), value.to_owned()))
        })
        .collect()
}
fn approved_origin(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    !origin.contains('*')
        && url.origin().ascii_serialization() == origin
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && (url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
                && url.port().is_some()))
}
fn validate_capability(
    capability: &Capability,
    origins: &[String],
    registration: &Registration,
    now: i64,
) -> Result<(), Failure> {
    let url = url::Url::parse(&capability.url).map_err(|_| unavailable())?;
    let query = url.query_pairs().collect::<Vec<_>>();
    if capability.expires_at <= now
        || capability.expires_at > registration.expires_at
        || capability.url.len() > 8192
        || !origins.contains(&capability.origin)
        || !approved_origin(&capability.origin)
        || !capability
            .url
            .starts_with(&format!("{}/_ycoding/bootstrap?", capability.origin))
        || url.origin().ascii_serialization() != capability.origin
        || url.path() != "/_ycoding/bootstrap"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || query.len() != 1
        || query[0].0 != "ticket"
        || query[0].1.is_empty()
        || query[0].1.len() > 2048
        || !query[0]
            .1
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(unavailable());
    }
    Ok(())
}
fn view(
    id: &LosslessString,
    session: &session::Id,
    expiry: Option<i64>,
    reason: Option<&str>,
) -> JsonValue {
    let expiry = expiry.and_then(iso);
    let reason = if expiry.is_none() && reason.is_none() {
        Some("access_unavailable")
    } else {
        reason
    };
    let status = match reason {
        None => "ready",
        Some("expired") => "expired",
        Some("revoked") => "revoked",
        _ => "unavailable",
    };
    let mut view = ObjectEncoder::new()
        .field("kind", "local-http-app")
        .field("version", &JsonValue::Number(1.0))
        .field("appID", id)
        .field("sessionID", session)
        .field(
            "expiresAt",
            &expiry
                .map(|value| JsonValue::String(value.into()))
                .unwrap_or(JsonValue::Null),
        )
        .field("status", status);
    if let Some(reason) = reason {
        view = view.field("reason", reason);
    }
    view.finish()
}
fn iso(milliseconds: i64) -> Option<String> {
    if !(0..=8_640_000_000_000_000).contains(&milliseconds) {
        return None;
    }
    let days = milliseconds / 86_400_000 + 719_468;
    let era = days / 146_097;
    let day = days - era * 146_097;
    let year = (day - day / 1460 + day / 36_524 - day / 146_096) / 365;
    let ordinal = day - (365 * year + year / 4 - year / 100);
    let month = (5 * ordinal + 2) / 153;
    let date = ordinal - (153 * month + 2) / 5 + 1;
    let month = month + if month < 10 { 3 } else { -9 };
    let year = year + era * 400 + i64::from(month <= 2);
    let year = if year <= 9999 {
        format!("{year:04}")
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year}-{month:02}-{date:02}T{:02}:{:02}:{:02}.{:03}Z",
        milliseconds / 3_600_000 % 24,
        milliseconds / 60_000 % 60,
        milliseconds / 1000 % 60,
        milliseconds % 1000
    ))
}

pub(crate) fn tool_schema(operation: &str) -> JsonValue {
    let id = r#"{"type":"string","minLength":1,"maxLength":36,"pattern":"^app_[a-f0-9]{32}$"}"#;
    let generation =
        r#"{"type":"string","minLength":1,"maxLength":43,"pattern":"^generation_[a-f0-9]{32}$"}"#;
    let input = match operation {
        "local.app.register" => r#"{"type":"object","properties":{"host":{"enum":["127.0.0.1","[::1]"]},"port":{"type":"integer","minimum":1,"maximum":65535},"entryPath":{"type":"string","minLength":1,"maxLength":4096},"routes":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096},"match":{"enum":["exact","prefix"]},"methods":{"type":"array","items":{"enum":["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"]},"minItems":1,"maxItems":7}},"required":["path","match","methods"],"additionalProperties":false}},"ttlMs":{"type":"integer","minimum":1,"maximum":3600000}},"required":["host","port","entryPath","routes"],"additionalProperties":false}"#.to_owned(),
        "local.app.list" => String::new(),
        "local.app.revoke" | "local.app.status" => format!(r#"{{"type":"object","properties":{{"id":{id}}},"required":["id"],"additionalProperties":false}}"#),
        "local.app.open" => format!(r#"{{"type":"object","properties":{{"id":{id},"generation":{generation}}},"required":["id","generation"],"additionalProperties":false}}"#),
        "local.app.http" => format!(r#"{{"type":"object","properties":{{"id":{id},"generation":{generation},"method":{{"enum":["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"]}},"path":{{"type":"string","minLength":1,"maxLength":4096}},"headers":{{"type":"object","maxProperties":64,"propertyNames":{{"type":"string","minLength":1,"maxLength":128,"pattern":"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$"}},"additionalProperties":{{"type":"string","maxLength":8192}}}},"body":{{"type":"string","maxLength":87384,"pattern":"^(?:[A-Za-z0-9+/]{{4}})*(?:[A-Za-z0-9+/]{{2}}==|[A-Za-z0-9+/]{{3}}=)?$"}}}},"required":["id","generation","method","path"],"additionalProperties":false}}"#),
        _ => return JsonValue::Null,
    };
    let session = r#""sessionID":{"type":"string","minLength":1,"maxLength":128,"pattern":"^ses[A-Za-z0-9_-]+$"}"#;
    let schema = if operation == "local.app.list" {
        format!(
            r#"{{"type":"object","properties":{{{session}}},"required":["sessionID"],"additionalProperties":false}}"#
        )
    } else {
        format!(
            r#"{{"type":"object","properties":{{{session},"input":{input}}},"required":["sessionID","input"],"additionalProperties":false}}"#
        )
    };
    ycoding_core::ycoding_schema::parse_json(&schema).expect("static local app tool schema")
}
