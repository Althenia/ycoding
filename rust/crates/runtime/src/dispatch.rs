use crate::{convert, locations::LocationServices, services::Environment};
use prost::{Message, Name};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, atomic::AtomicBool},
};
use ycoding_core::ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, session,
};
use ycoding_protocol::{Asset, AssetMetadata, decode_compatible, decode_strict, limits, v5};

pub type Boxed<T> = Pin<Box<dyn Future<Output = T> + Send>>;
type Authorizer = Arc<dyn Fn(&Environment, &v5::Request) -> Result<(), Failure> + Send + Sync>;
type Handler = Arc<dyn Fn(Invocation, Vec<u8>) -> Boxed<Result<Body, Failure>> + Send + Sync>;
type InvocationObserver = Box<dyn Fn(&v5::Request) + Send + Sync>;

pub struct Invocation {
    pub environment: Arc<Environment>,
    pub connection_id: String,
    pub scope: v5::Scope,
    pub request_id: String,
    pub remote: bool,
    pub mcp: Option<crate::connector::mcp::Access>,
    pub cancelled: Arc<AtomicBool>,
}

impl Invocation {
    pub fn core(&self) -> Result<&crate::services::Core, Failure> {
        self.environment
            .services
            .core
            .as_ref()
            .ok_or_else(|| Failure::Unavailable("Core is not ready".into()))
    }

    pub fn location(
        &self,
        requested: Option<&v5::LocationQueryLocation>,
    ) -> Result<Arc<LocationServices>, Failure> {
        if self.remote {
            return self.remote_location(requested);
        }
        let core = self.core()?;
        let (directory, workspace) = self.location_key(requested)?;
        core.locations.location(&directory, workspace.as_ref())
    }

    pub fn location_key(
        &self,
        requested: Option<&v5::LocationQueryLocation>,
    ) -> Result<(LosslessString, Option<LosslessString>), Failure> {
        if self.remote {
            let location = self.remote_location(requested)?;
            return Ok((
                location.info.directory.as_lossless().clone(),
                location
                    .info
                    .workspace_id
                    .as_ref()
                    .map(|id| id.as_lossless().clone()),
            ));
        }
        let Some(v5::scope::Target::Location(scoped)) = &self.scope.target else {
            return Err(Failure::Invalid("request has no Location scope".into()));
        };
        let directory = convert::domain(scoped)?;
        if let Some(requested) = requested.and_then(|requested| requested.directory.as_ref())
            && convert::domain(requested)? != directory
        {
            return Err(Failure::Invalid(
                "Location scope and request parameter disagree".into(),
            ));
        }
        let workspace = requested
            .and_then(|requested| requested.workspace.as_ref())
            .map(convert::domain)
            .transpose()?;
        Ok((directory, workspace))
    }

    pub(crate) fn location_info(
        &self,
        requested: Option<&v5::LocationQueryLocation>,
    ) -> Result<ycoding_core::ycoding_schema::location::Info, Failure> {
        let core = self.core()?;
        let (directory, workspace) = if self.remote {
            if requested.is_some_and(|query| query.directory.is_some() || query.workspace.is_some())
            {
                return Err(Failure::Forbidden(
                    "Remote input cannot select a Location".into(),
                ));
            }
            let reference = crate::remote_derived::target::recorded_location(core, &self.scope)?;
            (
                reference.directory.as_lossless().clone(),
                reference.workspace_id.map(|id| id.as_lossless().clone()),
            )
        } else {
            self.location_key(requested)?
        };
        core.locations.info(&directory, workspace.as_ref())
    }

    pub(crate) fn usage_location(
        &self,
        requested: Option<&v5::LocationQueryLocation>,
        refresh: bool,
    ) -> Result<Option<Arc<LocationServices>>, Failure> {
        let core = self.core()?;
        let load = |directory: &LosslessString, workspace: Option<&LosslessString>| {
            core.locations
                .prepare_usage_location(directory, workspace, refresh)
        };
        if !self.remote && !matches!(&self.scope.target, Some(v5::scope::Target::Machine(_))) {
            let (directory, workspace) = self.location_key(requested)?;
            return load(&directory, workspace.as_ref());
        }
        if self.remote
            && requested.is_some_and(|query| query.directory.is_some() || query.workspace.is_some())
        {
            return Err(Failure::Forbidden(
                "Remote input cannot select a Location".into(),
            ));
        }
        match &self.scope.target {
            Some(v5::scope::Target::Session(id)) => {
                let id = self.session(&convert::text(id))?;
                crate::remote_derived::target::prepare_session_usage(core, &id, refresh)
            }
            Some(v5::scope::Target::Form(owner)) => {
                let id = self.form_session(&convert::text(owner))?;
                crate::remote_derived::target::prepare_session_usage(core, &id, refresh)
            }
            Some(v5::scope::Target::Workspace(id)) => {
                crate::remote_derived::target::prepare_workspace_usage(
                    core,
                    &id.as_str().into(),
                    refresh,
                )
            }
            Some(v5::scope::Target::Machine(_)) => {
                let (directory, workspace) = if let Some(location) = &core.platform_default_location
                {
                    (
                        location.directory.as_lossless().clone(),
                        location
                            .workspace_id
                            .as_ref()
                            .map(|id| id.as_lossless().clone()),
                    )
                } else {
                    let directory = std::env::current_dir().map_err(|_| {
                        Failure::Unavailable("Default machine placement unavailable".into())
                    })?;
                    let directory = directory.to_str().ok_or_else(|| {
                        Failure::Unavailable("Default machine placement unavailable".into())
                    })?;
                    (directory.into(), None)
                };
                if let Some(requested) = requested {
                    let requested_directory = requested
                        .directory
                        .as_ref()
                        .map(convert::domain)
                        .transpose()?;
                    let requested_workspace = requested
                        .workspace
                        .as_ref()
                        .map(convert::domain)
                        .transpose()?;
                    if requested_directory
                        .as_ref()
                        .is_some_and(|value| value != &directory)
                        || requested_workspace
                            .as_ref()
                            .is_some_and(|value| Some(value) != workspace.as_ref())
                    {
                        return Err(Failure::Invalid(
                            "Machine placement and request parameter disagree".into(),
                        ));
                    }
                }
                load(&directory, workspace.as_ref())
            }
            _ => Err(Failure::Forbidden(
                "Remote placement requires a backend scope".into(),
            )),
        }
    }

    fn remote_location(
        &self,
        requested: Option<&v5::LocationQueryLocation>,
    ) -> Result<Arc<LocationServices>, Failure> {
        if requested.is_some_and(|query| query.directory.is_some() || query.workspace.is_some()) {
            return Err(Failure::Forbidden(
                "Remote input cannot select a Location".into(),
            ));
        }
        let core = self.core()?;
        match &self.scope.target {
            Some(v5::scope::Target::Session(id)) => {
                let id = self.session(&convert::text(id))?;
                Ok(crate::remote_derived::target::verify(core, &id)?.1)
            }
            Some(v5::scope::Target::Form(owner)) => {
                let id = self.form_session(&convert::text(owner))?;
                Ok(crate::remote_derived::target::verify(core, &id)?.1)
            }
            Some(v5::scope::Target::Workspace(id)) => {
                crate::remote_derived::target::workspace(core, &id.as_str().into())
            }
            Some(v5::scope::Target::Machine(_)) => {
                let directory = std::env::current_dir().map_err(|_| {
                    Failure::Unavailable("Default machine placement unavailable".into())
                })?;
                let directory = directory.to_str().ok_or_else(|| {
                    Failure::Unavailable("Default machine placement unavailable".into())
                })?;
                core.locations.location(&directory.into(), None)
            }
            _ => Err(Failure::Forbidden(
                "Remote placement requires a backend scope".into(),
            )),
        }
    }

    pub fn form_session(&self, id: &v5::LosslessString) -> Result<session::Id, Failure> {
        let id = convert::domain(id)?;
        let Some(v5::scope::Target::Form(scoped)) = &self.scope.target else {
            return Err(Failure::Invalid("request has no Form scope".into()));
        };
        if id != LosslessString::from(scoped.as_str()) {
            return Err(Failure::Invalid(
                "Form scope and request parameter disagree".into(),
            ));
        }
        session::Id::decode(&JsonValue::String(id)).map_err(|_| {
            Failure::Invalid("Form scope must name a Session known to the backend".into())
        })
    }

    pub fn session(&self, id: &v5::LosslessString) -> Result<session::Id, Failure> {
        let id = convert::domain(id)?;
        let Some(v5::scope::Target::Session(scoped)) = &self.scope.target else {
            return Err(Failure::Invalid("request has no Session scope".into()));
        };
        if id != LosslessString::from(scoped.as_str()) {
            return Err(Failure::Invalid(
                "Session scope and request parameter disagree".into(),
            ));
        }
        session::Id::decode(&JsonValue::String(id))
            .map_err(|_| Failure::Invalid("invalid Session ID".into()))
    }
}

pub enum Settled {
    Result(v5::Result),
    Bulk(Bulk),
    Asset { metadata: v5::Result, bulk: Bulk },
}

pub struct Bulk {
    pub request_id: String,
    pub operation_id: u32,
    pub type_name: String,
    pub body: Vec<u8>,
    pub content_kind: v5::ContentKind,
}

enum Body {
    Inline(Vec<u8>),
    Bulk(Vec<u8>),
    Asset(v5::AssetMetadataResult, Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    Coordination {
        message: String,
        reason: &'static str,
    },
    CommandNotFound(ycoding_core::ycoding_schema::LosslessString),
    CommandEvaluation {
        command: ycoding_core::ycoding_schema::LosslessString,
        message: String,
    },
    SkillNotFound(ycoding_core::ycoding_schema::LosslessString),
    SkillConflictNotFound,
    ModelSwitchBlocked(Box<ycoding_core::ycoding_schema::session::ModelSwitchBlocked>),
    ShellNotFound(String),
    PtyNotFound(String),
    PtyConflict(String),
    PtyResourceLimit(String),
    ProjectCopy {
        message: String,
        force_required: bool,
    },
    IntegrationAuthorization,
    ConfigurationWrite(ycoding_core::resources::config::WriteError),
    ConfigurationPartial {
        target: ycoding_core::resources::config::Target,
        registration: bool,
    },
    FrontendPackage(ycoding_core::resources::frontend_package::Error),
    IntegrationCodeRequired,
    WellKnownDiscovery(String),
    McpServerNotFound(ycoding_core::ycoding_schema::LosslessString),
    ProviderNotFound(ycoding_core::ycoding_schema::LosslessString),
    GenerationUnavailable {
        message: String,
        service: Option<ycoding_core::ycoding_schema::LosslessString>,
    },
    TelemetryDisabled,
    RemoteEnrollment(v5::TypedPayload),
    Connector {
        code: i32,
        message: &'static str,
    },
    Invalid(String),
    DotsConversation {
        message: String,
        rejection: Option<Box<ycoding_core::ycoding_schema::dots::Rejection>>,
    },
    InvalidRequest {
        message: String,
        kind: &'static str,
    },
    InvalidField {
        message: String,
        field: &'static str,
    },
    Unauthorized(String),
    Forbidden(String),
    SessionNotFound(String),
    SessionBusy(String),
    QuestionNotFound(String),
    PermissionNotFound(String),
    GuardrailRequestNotFound(String),
    FormNotFound(String),
    ReviewItemNotFound(String),
    FormAlreadySettled(String),
    FormInvalidAnswer {
        id: String,
        message: String,
    },
    MessageNotFound {
        session: String,
        message: String,
    },
    MessageDelete {
        session: LosslessString,
        message: LosslessString,
        reason: Option<v5::MessageDeleteRefusedErrorReason>,
        diagnostic: &'static str,
    },
    PendingInputNotFound {
        session: ycoding_core::ycoding_schema::LosslessString,
        message: ycoding_core::ycoding_schema::LosslessString,
    },
    PendingInputInvalid(ycoding_core::ycoding_schema::LosslessString),
    HistoryPruned {
        session: ycoding_core::ycoding_schema::LosslessString,
        message: ycoding_core::ycoding_schema::LosslessString,
    },
    AttachmentNotFound,
    AttachmentTooLarge,
    InvalidCursor(String),
    Conflict(String),
    SessionPlacementConflict(String),
    GoalStaleCalculation(String),
    InstructionEntryValueTooLarge {
        actual_bytes: i64,
        max_bytes: i64,
        message: ycoding_core::ycoding_schema::LosslessString,
    },
    Unavailable(String),
    Unknown {
        message: String,
        reference: String,
    },
    ServiceUnavailable {
        service: &'static str,
        message: String,
    },
}

#[derive(Debug, PartialEq)]
pub enum RegistrationError {
    UnknownOperation(String),
    TypeMismatch(String),
    Duplicate(String),
}

struct Entry {
    descriptor: v5::OperationDescriptor,
    authorize: Authorizer,
    handler: Option<Handler>,
}

pub struct Dispatcher {
    entries: BTreeMap<u32, Entry>,
    local_invocations: Option<InvocationObserver>,
}

impl Dispatcher {
    pub fn new(descriptors: Vec<v5::OperationDescriptor>) -> Self {
        Self {
            entries: descriptors
                .into_iter()
                .map(|descriptor| {
                    let operation = descriptor.diagnostic_name.clone();
                    (
                        descriptor.operation_id,
                        Entry {
                            descriptor,
                            authorize: Arc::new(move |environment, request| {
                                session_exists(environment, request, &operation)
                            }),
                            handler: None,
                        },
                    )
                })
                .collect(),
            local_invocations: None,
        }
    }

    pub fn observe_local_invocations(
        &mut self,
        observer: impl Fn(&v5::Request) + Send + Sync + 'static,
    ) {
        self.local_invocations = Some(Box::new(observer));
    }

    pub fn descriptors(&self) -> Vec<v5::OperationDescriptor> {
        self.entries
            .values()
            .map(|entry| entry.descriptor.clone())
            .collect()
    }

    pub fn descriptor(&self, operation_id: u32) -> Option<&v5::OperationDescriptor> {
        self.entries
            .get(&operation_id)
            .map(|entry| &entry.descriptor)
    }

    pub fn operation_id(&self, name: &str) -> Option<u32> {
        self.entries
            .values()
            .find(|entry| entry.descriptor.diagnostic_name == name)
            .map(|entry| entry.descriptor.operation_id)
    }

    pub fn wired(&self) -> Vec<&str> {
        self.entries
            .values()
            .filter(|entry| entry.handler.is_some())
            .map(|entry| entry.descriptor.diagnostic_name.as_str())
            .collect()
    }

    pub fn unwired(&self) -> Vec<&str> {
        self.entries
            .values()
            .filter(|entry| entry.handler.is_none())
            .map(|entry| entry.descriptor.diagnostic_name.as_str())
            .collect()
    }

    pub fn authorize<F>(&mut self, name: &str, authorizer: F) -> Result<(), RegistrationError>
    where
        F: Fn(&Environment, &v5::Request) -> Result<(), Failure> + Send + Sync + 'static,
    {
        self.entry(name)?.authorize = Arc::new(authorizer);
        Ok(())
    }

    pub fn handle<Q, R, F, Fut>(&mut self, name: &str, handler: F) -> Result<(), RegistrationError>
    where
        Q: Message + Name + Default + 'static,
        R: Message + Name + 'static,
        F: Fn(Invocation, Q) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<R, Failure>> + Send + 'static,
    {
        let entry = self.entry(name)?;
        if entry.descriptor.request_type != Q::full_name()
            || entry.descriptor.result_type != R::full_name()
        {
            return Err(RegistrationError::TypeMismatch(name.into()));
        }
        if entry.handler.is_some() {
            return Err(RegistrationError::Duplicate(name.into()));
        }
        let handler = Arc::new(handler);
        entry.handler = Some(Arc::new(move |invocation, payload| {
            let handler = handler.clone();
            Box::pin(async move {
                let decode = if invocation.remote && invocation.mcp.is_none() {
                    decode_compatible::<Q>
                } else {
                    decode_strict::<Q>
                };
                let query = decode(&payload)
                    .map_err(|_| Failure::Invalid("malformed request payload".into()))?;
                handler(invocation, query)
                    .await
                    .map(|result| Body::Inline(result.encode_to_vec()))
            })
        }));
        Ok(())
    }

    pub fn handle_asset<Q, R, F, Fut>(
        &mut self,
        name: &str,
        handler: F,
    ) -> Result<(), RegistrationError>
    where
        Q: Message + Name + Default + 'static,
        R: AssetMetadata + 'static,
        F: Fn(Invocation, Q) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Asset<R>, Failure>> + Send + 'static,
    {
        let entry = self.entry(name)?;
        if entry.descriptor.request_type != Q::full_name()
            || entry.descriptor.result_type != R::full_name()
            || entry.descriptor.streaming != v5::Streaming::AssetBulk as i32
        {
            return Err(RegistrationError::TypeMismatch(name.into()));
        }
        if entry.handler.is_some() {
            return Err(RegistrationError::Duplicate(name.into()));
        }
        let handler = Arc::new(handler);
        entry.handler = Some(Arc::new(move |invocation, payload| {
            let handler = handler.clone();
            Box::pin(async move {
                let decode = if invocation.remote && invocation.mcp.is_none() {
                    decode_compatible::<Q>
                } else {
                    decode_strict::<Q>
                };
                let query = decode(&payload)
                    .map_err(|_| Failure::Invalid("malformed request payload".into()))?;
                let asset = handler(invocation, query).await?;
                let (metadata, bytes) = asset
                    .into_wire()
                    .map_err(|error| Failure::Invalid(error.to_string()))?;
                Ok(Body::Asset(metadata, bytes))
            })
        }));
        Ok(())
    }

    pub async fn invoke(
        &self,
        environment: Arc<Environment>,
        connection_id: String,
        request: v5::Request,
    ) -> Option<Settled> {
        let entry = self.entries.get(&request.operation_id)?;
        if !entry
            .descriptor
            .roles
            .contains(&(v5::PeerRole::LocalClient as i32))
        {
            return None;
        }
        if let Some(observer) = &self.local_invocations {
            observer(&request);
        }
        let request_id = request.request_id.clone();
        let admission_log = PromptAdmissionLog::for_request(entry, &request);
        let outcome = run(
            entry,
            environment,
            connection_id,
            request,
            false,
            None,
            Arc::new(AtomicBool::new(false)),
        )
        .await;
        if let Some(log) = admission_log {
            log.record(&request_id, &outcome);
        }
        Some(settle(&entry.descriptor, request_id, outcome))
    }

    pub async fn invoke_remote(
        &self,
        environment: Arc<Environment>,
        connection_id: String,
        peer: &crate::connector::Peer,
        request: v5::Request,
    ) -> Option<Settled> {
        self.dispatch_remote(environment, connection_id, peer, request, None)
            .await
    }

    pub(crate) async fn dispatch_mcp(
        &self,
        environment: Arc<Environment>,
        connection_id: String,
        peer: &crate::connector::Peer,
        request: v5::Request,
        access: crate::connector::mcp::Access,
    ) -> Option<Settled> {
        self.dispatch_remote(environment, connection_id, peer, request, Some(access))
            .await
    }

    async fn dispatch_remote(
        &self,
        environment: Arc<Environment>,
        connection_id: String,
        peer: &crate::connector::Peer,
        request: v5::Request,
        mcp: Option<crate::connector::mcp::Access>,
    ) -> Option<Settled> {
        let entry = self.entries.get(&request.operation_id)?;
        if !entry
            .descriptor
            .roles
            .contains(&(v5::PeerRole::Relay as i32))
            || !entry
                .descriptor
                .roles
                .contains(&(v5::PeerRole::RemoteClient as i32))
        {
            return None;
        }
        let request_id = request.request_id.clone();
        let admission_log = PromptAdmissionLog::for_request(entry, &request);
        let authorized = if peer.authorized()
            && mcp
                .as_ref()
                .is_none_or(|access| access.authorized(&connection_id, peer))
        {
            let validate = if mcp.is_none() {
                ycoding_protocol::validate_compatible
            } else {
                ycoding_protocol::validate_binary
            };
            validate(&entry.descriptor.request_type, &request.payload)
                .map_err(|_| Failure::Invalid("Invalid remote payload".into()))
                .and_then(|_| {
                    crate::connector::operations::authorize(
                        &environment,
                        &entry.descriptor,
                        &request,
                    )
                })
        } else {
            Err(Failure::Unauthorized(
                "Remote peer is no longer authenticated".into(),
            ))
        };
        let outcome = match authorized {
            Ok(())
                if entry.descriptor.streaming == v5::Streaming::Events as i32
                    && !matches!(
                        entry.descriptor.diagnostic_name.as_str(),
                        "event.subscribe" | "session.log"
                    ) =>
            {
                Err(Failure::Unavailable(
                    "Canonical remote stream binding is not ready".into(),
                ))
            }
            Ok(()) => {
                let cancelled = mcp.as_ref().map_or_else(
                    || Arc::new(AtomicBool::new(false)),
                    |access| access.cancellation(),
                );
                run(
                    entry,
                    environment,
                    connection_id,
                    request,
                    true,
                    mcp,
                    cancelled,
                )
                .await
            }
            Err(error) => Err(error),
        };
        if let Some(log) = admission_log {
            log.record(&request_id, &outcome);
        }
        Some(settle(&entry.descriptor, request_id, outcome))
    }

    fn entry(&mut self, name: &str) -> Result<&mut Entry, RegistrationError> {
        self.entries
            .values_mut()
            .find(|entry| entry.descriptor.diagnostic_name == name)
            .ok_or_else(|| RegistrationError::UnknownOperation(name.into()))
    }
}

struct PromptAdmissionLog {
    session_ref: Option<String>,
}

impl PromptAdmissionLog {
    fn for_request(entry: &Entry, request: &v5::Request) -> Option<Self> {
        use ycoding_core::session::prompt_cache::sha256;

        (entry.descriptor.diagnostic_name == "session.prompt"
            && tracing::enabled!(tracing::Level::INFO))
        .then(|| Self {
            session_ref: match &request.scope.target {
                Some(v5::scope::Target::Session(id)) => Some(sha256(id)),
                _ => None,
            },
        })
    }

    fn record(self, request_id: &str, result: &Result<Body, Failure>) {
        use ycoding_core::session::prompt_cache::sha256;

        let (outcome, reason, input_ref) = match result {
            Ok(body) => {
                let pending = match body {
                    Body::Inline(bytes) | Body::Bulk(bytes) => {
                        v5::SessionPromptResult::decode(bytes.as_slice()).ok()
                    }
                    Body::Asset(..) => None,
                };
                let outcome = if pending.as_ref().is_some_and(|result| {
                    result.data.delivery
                        == v5::SessionPendingUserDelivery::SessionpendingUserDeliveryQueue as i32
                }) {
                    "queued"
                } else {
                    "accepted"
                };
                let input_ref = pending
                    .and_then(|result| convert::domain(&result.data.id).ok())
                    .and_then(|id| id.to_utf8().ok().map(|id| sha256(&id)));
                (outcome, "admitted", input_ref)
            }
            Err(error) => (
                "rejected",
                match error {
                    Failure::InvalidField { field: "files", .. } => "attachment_invalid",
                    Failure::Invalid(_)
                    | Failure::InvalidField { .. }
                    | Failure::InvalidRequest { .. } => "invalid_request",
                    Failure::SessionNotFound(_) => "session_not_found",
                    Failure::Unauthorized(_) => "unauthorized",
                    Failure::Connector { code: 6, .. } => "subagent_read_only",
                    Failure::Forbidden(_) | Failure::Connector { .. } => "forbidden",
                    Failure::Conflict(_) | Failure::SessionBusy(_) => "conflict",
                    Failure::Unavailable(_) | Failure::ServiceUnavailable { .. } => "unavailable",
                    _ => "rejected",
                },
                None,
            ),
        };
        tracing::info!(
            parent: None,
            outcome,
            reason,
            request_ref = sha256(request_id).as_str(),
            session_ref = self.session_ref.as_deref(),
            input_ref = input_ref.as_deref(),
            "prompt admission"
        );
    }
}

async fn run(
    entry: &Entry,
    environment: Arc<Environment>,
    connection_id: String,
    request: v5::Request,
    remote: bool,
    mcp: Option<crate::connector::mcp::Access>,
    cancelled: Arc<AtomicBool>,
) -> Result<Body, Failure> {
    (entry.authorize)(&environment, &request)?;
    let handler = entry.handler.as_ref().ok_or_else(|| {
        Failure::Unavailable(format!(
            "{} has no Core service wired to the local bridge",
            entry.descriptor.diagnostic_name
        ))
    })?;
    let body = handler(
        Invocation {
            environment,
            connection_id,
            scope: request.scope,
            request_id: request.request_id,
            remote,
            mcp,
            cancelled,
        },
        request.payload,
    )
    .await?;
    let body = match body {
        Body::Inline(body) | Body::Bulk(body) => body,
        Body::Asset(metadata, bytes) => return Ok(Body::Asset(metadata, bytes)),
    };
    if body.len() as u64 <= limits::INLINE_BODY_BYTES {
        return Ok(Body::Inline(body));
    }
    if entry.descriptor.streaming == v5::Streaming::TypedBulk as i32
        && body.len() as u64 <= limits::BULK_MESSAGE_BYTES
    {
        return Ok(Body::Bulk(body));
    }
    Err(Failure::Unavailable(
        "result exceeds the typed message bound".into(),
    ))
}

fn settle(
    descriptor: &v5::OperationDescriptor,
    request_id: String,
    outcome: Result<Body, Failure>,
) -> Settled {
    let outcome = match outcome {
        Ok(Body::Asset(metadata, body)) => {
            return Settled::Asset {
                metadata: v5::Result {
                    request_id: request_id.clone(),
                    operation_id: descriptor.operation_id,
                    settlement: descriptor.settlement,
                    outcome: Some(v5::result::Outcome::AssetMetadata(metadata)),
                },
                bulk: Bulk {
                    request_id,
                    operation_id: descriptor.operation_id,
                    type_name: descriptor.result_type.clone(),
                    body,
                    content_kind: v5::ContentKind::Asset,
                },
            };
        }
        Ok(Body::Bulk(body)) => {
            return Settled::Bulk(Bulk {
                request_id,
                operation_id: descriptor.operation_id,
                type_name: descriptor.result_type.clone(),
                body,
                content_kind: v5::ContentKind::TypedMessage,
            });
        }
        Ok(Body::Inline(payload)) => v5::result::Outcome::Success(v5::TypedPayload {
            type_name: descriptor.result_type.clone(),
            payload,
        }),
        Err(failure) => v5::result::Outcome::Error(failure.payload(descriptor)),
    };
    Settled::Result(v5::Result {
        request_id,
        operation_id: descriptor.operation_id,
        settlement: descriptor.settlement,
        outcome: Some(outcome),
    })
}

fn session_exists(
    environment: &Environment,
    request: &v5::Request,
    operation: &str,
) -> Result<(), Failure> {
    let Some(v5::scope::Target::Session(id)) = &request.scope.target else {
        return Ok(());
    };
    let Some(core) = &environment.services.core else {
        return Err(Failure::Unavailable("Core is not ready".into()));
    };
    let session = session::Id::decode(&JsonValue::String(LosslessString::from(id.as_str())))
        .map_err(|_| Failure::Invalid("invalid Session ID".into()))?;
    match core.sessions.get(&session) {
        Ok(Some(session))
            if session.scope == ycoding_core::ycoding_schema::session_scope::Scope::Standalone
                && !matches!(
                    operation,
                    "session.get"
                        | "session.permission.create"
                        | "session.permission.list"
                        | "session.permission.get"
                        | "session.permission.reply"
                        | "session.permission.reject"
                ) =>
        {
            Err(Failure::Invalid(
                "Standalone Session operation is unavailable".into(),
            ))
        }
        Ok(Some(info)) => {
            if operation.starts_with("session.")
                && !storage_read(operation)
                && !matches!(
                    operation,
                    "session.archive"
                        | "session.usage"
                        | "session.usageReport"
                        | "session.promptCosts"
                        | "session.taskCosts"
                )
                && info.scope != ycoding_core::ycoding_schema::session_scope::Scope::Standalone
            {
                core.locations.session(&session)?;
            }
            Ok(())
        }
        Ok(None) => Err(Failure::SessionNotFound(id.clone())),
        Err(_) => Err(Failure::Unavailable("Session store unavailable".into())),
    }
}

pub(crate) fn storage_read(operation: &str) -> bool {
    matches!(
        operation,
        "session.get"
            | "session.snapshot"
            | "session.compaction.list"
            | "session.diagnostics"
            | "session.attachment.read"
            | "session.context"
            | "session.fileChange.list"
            | "session.message"
            | "session.messages"
            | "session.log"
            | "session.capturedInputs"
            | "session.review.list"
            | "session.subagent.list"
            | "session.pending.list"
            | "session.todo.list"
            | "session.instructions.entry.list"
    )
}

impl Failure {
    fn payload(self, descriptor: &v5::OperationDescriptor) -> v5::TypedPayload {
        if descriptor
            .error_types
            .contains(&v5::ConnectorError::full_name())
        {
            let (code, message) = match self {
                Failure::Connector { code, message } => (code, message),
                Failure::Unauthorized(_) => (14, "Remote authentication required"),
                Failure::Forbidden(_) => (12, "Remote operation forbidden"),
                Failure::SessionNotFound(_) => (5, "Session is not available on this backend"),
                Failure::Unavailable(_) => (10, "Required backend service unavailable"),
                Failure::MessageNotFound { .. }
                | Failure::PendingInputNotFound { .. }
                | Failure::FormNotFound(_)
                | Failure::ReviewItemNotFound(_)
                | Failure::QuestionNotFound(_)
                | Failure::PermissionNotFound(_)
                | Failure::GuardrailRequestNotFound(_) => (7, "Requested record not found"),
                _ => (1, "Invalid remote request"),
            };
            return encoded(v5::ConnectorError {
                code,
                message: convert::text(message),
            });
        }
        let declared = |name: String| descriptor.error_types.contains(&name);
        match self {
            Failure::ConfigurationWrite(error) => encoded(v5::ConfigurationWriteError {
                tag: 1,
                code: match error {
                    ycoding_core::resources::config::WriteError::InvalidConfig => 1,
                    ycoding_core::resources::config::WriteError::ScopeNotAllowed => 2,
                    ycoding_core::resources::config::WriteError::ProviderCollision => 3,
                    ycoding_core::resources::config::WriteError::WriteFailed => 4,
                },
            }),
            Failure::ConfigurationPartial {
                target,
                registration,
            } => encoded(v5::ConfigurationPartialFailure {
                tag: 1,
                target: crate::config_ops::target(&target),
                stage: if registration { 2 } else { 1 },
            }),
            Failure::FrontendPackage(error) => encoded(v5::FrontendPackageError {
                tag: 1,
                code: match error {
                    ycoding_core::resources::frontend_package::Error::InvalidPackage => 1,
                    ycoding_core::resources::frontend_package::Error::PermissionDenied => 2,
                    ycoding_core::resources::frontend_package::Error::InstallFailed => 3,
                    ycoding_core::resources::frontend_package::Error::EntrypointMissing => 4,
                    ycoding_core::resources::frontend_package::Error::IntegrityFailed => 5,
                },
            }),
            Failure::CommandNotFound(command) if declared(v5::CommandNotFoundError::full_name()) => {
                encoded(v5::CommandNotFoundError {
                    tag: 1,
                    command: convert::wire(&command),
                    message: convert::text("Command not found"),
                })
            }
            Failure::CommandEvaluation { command, message }
                if declared(v5::CommandEvaluationError::full_name()) =>
            {
                encoded(v5::CommandEvaluationError {
                    tag: 1,
                    command: convert::wire(&command),
                    message: convert::text(&message),
                })
            }
            Failure::SkillNotFound(skill) if declared(v5::SkillNotFoundError::full_name()) => {
                encoded(v5::SkillNotFoundError {
                    tag: 1,
                    skill: convert::wire(&skill),
                    message: convert::text("Skill not found"),
                })
            }
            Failure::SkillConflictNotFound
                if declared(v5::SkillConflictNotFoundError::full_name()) =>
            {
                encoded(v5::SkillConflictNotFoundError {
                    tag: 1,
                    message: convert::text("Active skill conflict not found"),
                })
            }
            Failure::ModelSwitchBlocked(blocked)
                if declared(v5::ModelSwitchBlockedError::full_name()) =>
            {
                encoded(v5::ModelSwitchBlockedError {
                    tag: 1,
                    status: 1,
                    current_model: convert::model_ref(
                        &ycoding_core::ycoding_schema::DomainEncode::encode(&blocked.current_model),
                    )
                    .expect("typed model"),
                    target_model: convert::model_ref(
                        &ycoding_core::ycoding_schema::DomainEncode::encode(&blocked.target_model),
                    )
                    .expect("typed model"),
                    current_context_tokens: blocked.current_context_tokens.get() as u64,
                    target_safe_input_tokens: blocked.target_safe_input_tokens.get() as u64,
                    required_reduction_tokens: blocked.required_reduction_tokens.get() as u64,
                    maximum_safe_summary_boundary: blocked
                        .maximum_safe_summary_boundary
                        .as_ref()
                        .map(|id| convert::wire(id.as_lossless())),
                    reason: 1,
                })
            }
            Failure::CommandNotFound(_)
            | Failure::SkillNotFound(_)
            | Failure::SkillConflictNotFound => invalid("Resource not found", "not_found"),
            Failure::CommandEvaluation { message, .. } => invalid(&message, "evaluation"),
            Failure::ModelSwitchBlocked(_) => {
                invalid("Model switch context window exceeded", "model-switch")
            }
            Failure::ShellNotFound(id) if declared(v5::ShellNotFoundError::full_name()) => {
                encoded(v5::ShellNotFoundError {
                    tag: 1,
                    id: convert::text(&id),
                    message: convert::text(&format!("Shell command not found: {id}")),
                })
            }
            Failure::PtyNotFound(id) if declared(v5::PtyNotFoundError::full_name()) => {
                encoded(v5::PtyNotFoundError {
                    tag: 1,
                    pty_id: convert::text(&id),
                    message: convert::text(&format!("PTY session not found: {id}")),
                })
            }
            Failure::PtyConflict(id) if declared(v5::PtyConflictError::full_name()) => {
                encoded(v5::PtyConflictError {
                    tag: 1,
                    pty_id: convert::text(&id),
                    message: convert::text("PTY control generation or writer fence is stale"),
                })
            }
            Failure::PtyResourceLimit(resource)
                if declared(v5::PtyResourceLimitError::full_name()) =>
            {
                encoded(v5::PtyResourceLimitError {
                    tag: 1,
                    message: convert::text(&format!("PTY {resource} limit reached")),
                    resource: convert::text(&resource),
                })
            }
            Failure::ProjectCopy {
                message,
                force_required,
            } if declared(v5::ProjectCopyError::full_name()) => encoded(v5::ProjectCopyError {
                name: 1,
                data: v5::ProjectCopyErrorData {
                    message: convert::text(&message),
                    force_required: force_required.then_some(true),
                },
            }),
            Failure::ShellNotFound(_) | Failure::PtyNotFound(_) => {
                invalid("Platform session not found", "not_found")
            }
            Failure::PtyConflict(_) => invalid("PTY fence is stale", "conflict"),
            Failure::PtyResourceLimit(_) => invalid("PTY resource limit reached", "unavailable"),
            Failure::ProjectCopy { message, .. } => invalid(&message, "invalid"),
            Failure::IntegrationAuthorization => {
                invalid("Authentication failed", "integration_authorization")
            }
            Failure::IntegrationCodeRequired => invalid(
                "Authorization code is required",
                "integration_code_required",
            ),
            Failure::WellKnownDiscovery(message) => invalid(&message, "well_known_discovery"),
            Failure::McpServerNotFound(server)
                if declared(v5::McpServerNotFoundError::full_name()) =>
            {
                encoded(v5::McpServerNotFoundError {
                    tag: 1,
                    server: convert::wire(&server),
                    message: convert::text(&format!(
                        "MCP server not found: {}",
                        convert::readable(&server)
                    )),
                })
            }
            Failure::McpServerNotFound(_) => invalid("MCP server not found", "not_found"),
            Failure::ProviderNotFound(id) if declared(v5::ProviderNotFoundError::full_name()) => {
                encoded(v5::ProviderNotFoundError {
                    tag: 1,
                    provider_id: convert::wire(&id),
                    message: convert::text(&format!(
                        "Provider not found: {}",
                        convert::readable(&id)
                    )),
                })
            }
            Failure::ProviderNotFound(_) => invalid("Provider not found", "not_found"),
            Failure::GenerationUnavailable { message, service }
                if declared(v5::ServiceUnavailableError::full_name()) =>
            {
                encoded(v5::ServiceUnavailableError {
                    tag: 1,
                    message: convert::text(&message),
                    service: service.as_ref().map(convert::wire),
                })
            }
            Failure::GenerationUnavailable { message, .. } => invalid(&message, "unavailable"),
            Failure::TelemetryDisabled if declared(v5::TelemetryDisabled::full_name()) => {
                encoded(v5::TelemetryDisabled { tag: 1 })
            }
            Failure::TelemetryDisabled => invalid("Telemetry disabled", "disabled"),
            Failure::RemoteEnrollment(payload) => payload,
            Failure::Connector { code, message } => invalid(
                message,
                if code == 6 {
                    "subagent_read_only"
                } else {
                    "forbidden"
                },
            ),
            Failure::Unauthorized(message) => encoded(v5::UnauthorizedError {
                tag: 1,
                message: convert::text(&message),
            }),
            Failure::SessionNotFound(id) if declared(v5::SessionNotFoundError::full_name()) => {
                encoded(v5::SessionNotFoundError {
                    tag: 1,
                    session_id: convert::text(&id),
                    message: convert::text(&format!("Session not found: {id}")),
                })
            }
            Failure::SessionNotFound(_) => invalid("Session not found", "not_found"),
            Failure::SessionBusy(id) if declared(v5::SessionBusyError::full_name()) => {
                encoded(v5::SessionBusyError {
                    tag: 1,
                    session_id: convert::text(&id),
                    message: convert::text(&format!("Session is busy: {id}")),
                })
            }
            Failure::SessionBusy(_) => invalid("Session is busy", "conflict"),
            Failure::Forbidden(message) if declared(v5::ForbiddenError::full_name()) => {
                encoded(v5::ForbiddenError {
                    tag: 1,
                    message: convert::text(&message),
                })
            }
            Failure::Forbidden(message) => invalid(&message, "forbidden"),
            Failure::QuestionNotFound(id) if declared(v5::QuestionNotFoundError::full_name()) => {
                encoded(v5::QuestionNotFoundError {
                    tag: 1,
                    message: convert::text(&format!("Question not found: {id}")),
                    request_id: convert::text(&id),
                })
            }
            Failure::QuestionNotFound(_) => invalid("Question not found", "not_found"),
            Failure::PermissionNotFound(id)
                if declared(v5::PermissionNotFoundError::full_name()) =>
            {
                encoded(v5::PermissionNotFoundError {
                    tag: 1,
                    message: convert::text(&format!("Permission request not found: {id}")),
                    request_id: convert::text(&id),
                })
            }
            Failure::PermissionNotFound(_) => invalid("Permission request not found", "not_found"),
            Failure::GuardrailRequestNotFound(id)
                if declared(v5::GuardrailRequestNotFoundError::full_name()) =>
            {
                encoded(v5::GuardrailRequestNotFoundError {
                    tag: 1,
                    message: convert::text(&format!("Guardrail request not found: {id}")),
                    request_id: convert::text(&id),
                })
            }
            Failure::GuardrailRequestNotFound(_) => {
                invalid("Guardrail request not found", "not_found")
            }
            Failure::FormNotFound(id) if declared(v5::FormNotFoundError::full_name()) => {
                encoded(v5::FormNotFoundError {
                    tag: 1,
                    message: convert::text(&format!("Form not found: {id}")),
                    id: convert::text(&id),
                })
            }
            Failure::FormNotFound(_) => invalid("Form not found", "not_found"),
            Failure::ReviewItemNotFound(id)
                if declared(v5::ReviewItemNotFoundError::full_name()) =>
            {
                encoded(v5::ReviewItemNotFoundError {
                    tag: 1,
                    item_id: convert::text(&id),
                    message: convert::text(&format!("Review item not found: {id}")),
                })
            }
            Failure::ReviewItemNotFound(_) => invalid("Review item not found", "not_found"),
            Failure::FormAlreadySettled(id)
                if declared(v5::FormAlreadySettledError::full_name()) =>
            {
                encoded(v5::FormAlreadySettledError {
                    tag: 1,
                    message: convert::text(&format!("Form already settled: {id}")),
                    id: convert::text(&id),
                })
            }
            Failure::FormAlreadySettled(_) => invalid("Form already settled", "conflict"),
            Failure::FormInvalidAnswer { id, message }
                if declared(v5::FormInvalidAnswerError::full_name()) =>
            {
                encoded(v5::FormInvalidAnswerError {
                    tag: 1,
                    id: convert::text(&id),
                    message: convert::text(&message),
                })
            }
            Failure::FormInvalidAnswer { message, .. } => invalid(&message, "invalid_answer"),
            Failure::InvalidField { message, field } => encoded(v5::InvalidRequestError {
                tag: 1,
                message: convert::text(&message),
                kind: None,
                field: Some(convert::text(field)),
                rejection: None,
            }),
            Failure::MessageNotFound { session, message }
                if declared(v5::MessageNotFoundError::full_name()) =>
            {
                encoded(v5::MessageNotFoundError {
                    tag: 1,
                    session_id: convert::text(&session),
                    message_id: convert::text(&message),
                    message: convert::text("Message not found"),
                })
            }
            Failure::MessageNotFound { .. } => invalid("Message not found", "not_found"),
            Failure::MessageDelete {
                session,
                message,
                reason,
                diagnostic,
            } => match reason {
                Some(reason) => encoded(v5::MessageDeleteRefusedError {
                    tag: 1,
                    session_id: convert::wire(&session),
                    message_id: convert::wire(&message),
                    reason: reason as i32,
                    message: convert::text(diagnostic),
                }),
                None => encoded(v5::MessageNotFoundError {
                    tag: 1,
                    session_id: convert::wire(&session),
                    message_id: convert::wire(&message),
                    message: convert::text(diagnostic),
                }),
            },
            Failure::PendingInputNotFound { session, message }
                if declared(v5::PendingInputNotFoundError::full_name()) =>
            {
                let diagnostic = ycoding_core::ycoding_schema::LosslessString::from_utf16(
                    "Pending input not found: "
                        .encode_utf16()
                        .chain(message.code_units())
                        .collect::<Vec<_>>(),
                );
                encoded(v5::PendingInputNotFoundError {
                    tag: 1,
                    session_id: convert::wire(&session),
                    message_id: convert::wire(&message),
                    message: convert::wire(&diagnostic),
                })
            }
            Failure::PendingInputNotFound { .. } => invalid("Pending input not found", "not_found"),
            Failure::PendingInputInvalid(message) => {
                let diagnostic = ycoding_core::ycoding_schema::LosslessString::from_utf16(
                    "Only user input can be changed while pending: "
                        .encode_utf16()
                        .chain(message.code_units())
                        .collect::<Vec<_>>(),
                );
                encoded(v5::InvalidRequestError {
                    tag: 1,
                    message: convert::wire(&diagnostic),
                    kind: Some(convert::text("pending_input_not_user")),
                    field: Some(convert::text("messageID")),
                    rejection: None,
                })
            }
            Failure::HistoryPruned { session, message }
                if declared(v5::HistoryPrunedError::full_name()) =>
            {
                let diagnostic = ycoding_core::ycoding_schema::LosslessString::from_utf16(
                    "Message "
                        .encode_utf16()
                        .chain(message.code_units())
                        .chain(" is not in the retained history of session ".encode_utf16())
                        .chain(session.code_units())
                        .chain(
                            "; history through the compaction checkpoint was removed"
                                .encode_utf16(),
                        )
                        .collect(),
                );
                encoded(v5::HistoryPrunedError {
                    tag: 1,
                    session_id: convert::wire(&session),
                    message_id: convert::wire(&message),
                    message: convert::wire(&diagnostic),
                })
            }
            Failure::HistoryPruned { .. } => {
                invalid("Session history was pruned", "history_pruned")
            }
            Failure::AttachmentNotFound if declared(v5::AttachmentNotFoundError::full_name()) => {
                encoded(v5::AttachmentNotFoundError {
                    tag: 1,
                    message: convert::text("Attachment not found in this Session"),
                })
            }
            Failure::AttachmentNotFound => invalid("Attachment not found", "not_found"),
            Failure::AttachmentTooLarge if declared(v5::AttachmentTooLargeError::full_name()) => {
                encoded(v5::AttachmentTooLargeError {
                    tag: 1,
                    message: convert::text("Attachment exceeds the read size limit"),
                })
            }
            Failure::AttachmentTooLarge => invalid("Attachment is too large", "too_large"),
            Failure::InvalidCursor(message) if declared(v5::InvalidCursorError::full_name()) => {
                encoded(v5::InvalidCursorError {
                    tag: 1,
                    message: convert::text(&message),
                })
            }
            Failure::InvalidCursor(message) => invalid(&message, "invalid_cursor"),
            Failure::Conflict(message) if declared(v5::ConflictError::full_name()) => {
                encoded(v5::ConflictError {
                    tag: 1,
                    message: convert::text(&message),
                    resource: None,
                })
            }
            Failure::Conflict(message) => invalid(&message, "conflict"),
            Failure::SessionPlacementConflict(resource)
                if declared(v5::ConflictError::full_name()) =>
            {
                encoded(v5::ConflictError {
                    tag: 1,
                    message: convert::text("Session ID belongs to a different placement"),
                    resource: Some(convert::text(&resource)),
                })
            }
            Failure::SessionPlacementConflict(_) => {
                invalid("Session ID belongs to a different placement", "conflict")
            }
            Failure::Coordination { message, reason }
                if declared(v5::CoordinationError::full_name()) =>
            {
                encoded(v5::CoordinationError {
                    tag: 1,
                    reason: convert::text(reason),
                    message: convert::text(&message),
                })
            }
            Failure::Coordination { message, .. } => invalid(&message, "coordination"),
            Failure::GoalStaleCalculation(resource) if declared(v5::ConflictError::full_name()) => {
                encoded(v5::ConflictError {
                    tag: 1,
                    message: convert::text(
                        "Goal changed while calculation was running. Review the current goal before retrying.",
                    ),
                    resource: Some(convert::text(&resource)),
                })
            }
            Failure::GoalStaleCalculation(_) => {
                invalid("Goal changed while calculation was running", "conflict")
            }
            Failure::InstructionEntryValueTooLarge {
                actual_bytes,
                max_bytes,
                message,
            } if declared(v5::InstructionEntryValueTooLargeError::full_name()) => {
                encoded(v5::InstructionEntryValueTooLargeError {
                    tag: 1,
                    actual_bytes,
                    max_bytes,
                    message: convert::wire(&message),
                })
            }
            Failure::InstructionEntryValueTooLarge { .. } => {
                invalid("Instruction entry value is too large", "too_large")
            }
            Failure::Invalid(message) => encoded(v5::InvalidRequestError {
                tag: 1,
                message: convert::text(&message),
                kind: None,
                field: None,
                rejection: None,
            }),
            Failure::DotsConversation { message, rejection } => {
                let rejection = rejection
                    .map(|rejection| {
                        let bytes = ycoding_protocol::domain_json::encode(
                            &v5::DotsRejection::full_name(),
                            &convert::json_domain(&rejection.encode()),
                            limits::INLINE_BODY_BYTES as usize,
                        )
                        .map_err(|_| ())?;
                        v5::DotsRejection::decode(bytes.as_slice()).map_err(|_| ())
                    })
                    .transpose();
                match rejection {
                    Ok(rejection) => encoded(v5::InvalidRequestError {
                        tag: 1,
                        message: convert::text(&message),
                        kind: None,
                        field: None,
                        rejection,
                    }),
                    Err(()) => Failure::Unavailable(
                        "Dots conversation rejection cannot be represented".into(),
                    )
                    .payload(descriptor),
                }
            }
            Failure::InvalidRequest { message, kind } => invalid(&message, kind),
            Failure::ServiceUnavailable { service, message }
                if declared(v5::ServiceUnavailableError::full_name()) =>
            {
                encoded(v5::ServiceUnavailableError {
                    tag: 1,
                    message: convert::text(&message),
                    service: Some(convert::text(service)),
                })
            }
            Failure::ServiceUnavailable { message, .. } => {
                Failure::Unavailable(message).payload(descriptor)
            }
            Failure::Unknown { message, reference } if declared(v5::UnknownError::full_name()) => {
                encoded(v5::UnknownError {
                    tag: 1,
                    message: convert::text(&message),
                    r#ref: Some(convert::text(&reference)),
                })
            }
            Failure::Unknown { message, .. } => Failure::Unavailable(message).payload(descriptor),
            Failure::Unavailable(message) if declared(v5::ServiceUnavailableError::full_name()) => {
                encoded(v5::ServiceUnavailableError {
                    tag: 1,
                    message: convert::text(&message),
                    service: None,
                })
            }
            Failure::Unavailable(message) if declared(v5::UnknownError::full_name()) => {
                encoded(v5::UnknownError {
                    tag: 1,
                    message: convert::text(&message),
                    r#ref: None,
                })
            }
            Failure::Unavailable(message) => invalid(&message, "unavailable"),
        }
    }
}

fn invalid(message: &str, kind: &str) -> v5::TypedPayload {
    encoded(v5::InvalidRequestError {
        tag: 1,
        message: convert::text(message),
        kind: Some(convert::text(kind)),
        field: None,
        rejection: None,
    })
}

fn encoded<T: Message + Name>(error: T) -> v5::TypedPayload {
    v5::TypedPayload {
        type_name: T::full_name(),
        payload: error.encode_to_vec(),
    }
}

#[cfg(test)]
mod reserved_context_tests {
    use super::*;
    use std::collections::BTreeSet;
    use ycoding_protocol::domain_json;

    const CONTEXT: &str = "ycoding.v5.McpEvents_RequestContext";

    fn wire(request: &str, epoch: &str) -> v5::McpEventsRequestContext {
        v5::McpEventsRequestContext {
            request_id: convert::text(request),
            principal: v5::McpEventsRequestContextPrincipal {
                owner_id: convert::text("owner-a"),
                device_id: convert::text("device-a"),
                client_id: convert::text("client-a"),
            },
            epoch: convert::text(epoch),
        }
    }

    fn varint(mut value: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let low = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                bytes.push(low);
                return bytes;
            }
            bytes.push(low | 0x80);
        }
    }

    fn prompt(reserved: Option<&v5::McpEventsRequestContext>) -> Vec<u8> {
        let params = Message::encode_to_vec(&v5::SessionPromptRequestParams {
            session_id: convert::text("ses_gate"),
        });
        let mut payload = Message::encode_to_vec(&v5::SessionPromptRequestPayload {
            id: Some(convert::text("msg_gate")),
            text: convert::text("hello"),
            files: None,
            agents: None,
            metadata: None,
            delivery: None,
            resume: None,
        });
        if let Some(context) = reserved {
            let context = Message::encode_to_vec(context);
            payload.push(0x42);
            payload.extend(varint(context.len()));
            payload.extend(context);
        }
        let mut frame = vec![0x0a];
        frame.extend(varint(params.len()));
        frame.extend(params);
        frame.push(0x12);
        frame.extend(varint(payload.len()));
        frame.extend(payload);
        frame
    }

    fn valid(payload: &[u8]) -> bool {
        let dispatcher = Dispatcher::new(ycoding_protocol::OPERATIONS.clone());
        let entry = dispatcher
            .entries
            .values()
            .find(|entry| entry.descriptor.diagnostic_name == "session.prompt")
            .unwrap();
        ycoding_protocol::validate_binary(&entry.descriptor.request_type, payload).is_ok()
    }

    fn reaches_context(name: &str, seen: &mut BTreeSet<String>) -> bool {
        if name == CONTEXT {
            return true;
        }
        if !seen.insert(name.to_owned()) {
            return false;
        }
        domain_json::message(name).is_some_and(|message| {
            message
                .fields
                .iter()
                .filter(|field| field.kind == 11)
                .any(|field| reaches_context(field.target, seen))
        })
    }

    #[test]
    fn the_reserved_prompt_field_rejects_any_supplied_context_and_the_context_free_prompt_passes() {
        assert!(valid(&prompt(None)));
        let long = wire(&format!("relay-frame-7-{}", "x".repeat(130)), "epoch-gate");
        assert!(Message::encode_to_vec(&long).len() > 127);
        for forged in [
            wire("relay-frame-7", "epoch-gate"),
            wire("relay-frame-8", "epoch-other"),
            long,
        ] {
            assert!(!valid(&prompt(Some(&forged))));
        }
    }

    #[test]
    fn no_request_message_can_carry_a_relay_request_context() {
        for descriptor in ycoding_protocol::OPERATIONS.iter() {
            assert!(
                !reaches_context(&descriptor.request_type, &mut BTreeSet::new()),
                "{}",
                descriptor.diagnostic_name
            );
        }
    }
}
