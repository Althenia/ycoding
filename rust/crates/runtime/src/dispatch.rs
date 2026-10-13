use crate::{convert, locations::LocationServices, services::Environment};
use prost::{Message, Name};
use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};
use ycoding_core::ycoding_schema::{DomainDecode, JsonValue, LosslessString, session};
use ycoding_protocol::{decode_strict, limits, v5};

pub type Boxed<T> = Pin<Box<dyn Future<Output = T> + Send>>;
type Authorizer = Arc<dyn Fn(&Environment, &v5::Request) -> Result<(), Failure> + Send + Sync>;
type Handler = Arc<dyn Fn(Invocation, Vec<u8>) -> Boxed<Result<Vec<u8>, Failure>> + Send + Sync>;

pub struct Invocation {
    pub environment: Arc<Environment>,
    pub connection_id: String,
    pub scope: v5::Scope,
    pub request_id: String,
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
        let core = self.core()?;
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
        core.locations.location(&directory, workspace.as_ref())
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
}

pub struct Bulk {
    pub request_id: String,
    pub operation_id: u32,
    pub type_name: String,
    pub body: Vec<u8>,
}

enum Body {
    Inline(Vec<u8>),
    Bulk(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    TelemetryDisabled,
    Artifact(ycoding_core::ycoding_schema::project_artifact::ErrorCode),
    Connector {
        code: i32,
        message: &'static str,
    },
    Invalid(String),
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
    FormAlreadySettled(String),
    FormInvalidAnswer {
        id: String,
        message: String,
    },
    MessageNotFound {
        session: String,
        message: String,
    },
    InvalidCursor(String),
    Conflict(String),
    InstructionEntryValueTooLarge {
        actual_bytes: i64,
        max_bytes: i64,
        message: ycoding_core::ycoding_schema::LosslessString,
    },
    Unavailable(String),
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
}

impl Dispatcher {
    pub fn new(descriptors: Vec<v5::OperationDescriptor>) -> Self {
        Self {
            entries: descriptors
                .into_iter()
                .map(|descriptor| {
                    (
                        descriptor.operation_id,
                        Entry {
                            descriptor,
                            authorize: Arc::new(session_exists),
                            handler: None,
                        },
                    )
                })
                .collect(),
        }
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
                let query = decode_strict::<Q>(&payload)
                    .map_err(|_| Failure::Invalid("malformed request payload".into()))?;
                handler(invocation, query)
                    .await
                    .map(|result| result.encode_to_vec())
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
        let request_id = request.request_id.clone();
        let outcome = run(entry, environment, connection_id, request).await;
        Some(settle(&entry.descriptor, request_id, outcome))
    }

    pub async fn invoke_remote(
        &self,
        environment: Arc<Environment>,
        connection_id: String,
        peer: &crate::connector::Peer,
        request: v5::Request,
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
        let authorized = if peer.authorized() {
            ycoding_protocol::validate_binary(&entry.descriptor.request_type, &request.payload)
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
            Ok(()) if entry.descriptor.streaming == v5::Streaming::Events as i32 => Err(
                Failure::Unavailable("Canonical remote stream binding is not ready".into()),
            ),
            Ok(()) => run(entry, environment, connection_id, request).await,
            Err(error) => Err(error),
        };
        Some(settle(&entry.descriptor, request_id, outcome))
    }

    fn entry(&mut self, name: &str) -> Result<&mut Entry, RegistrationError> {
        self.entries
            .values_mut()
            .find(|entry| entry.descriptor.diagnostic_name == name)
            .ok_or_else(|| RegistrationError::UnknownOperation(name.into()))
    }
}

async fn run(
    entry: &Entry,
    environment: Arc<Environment>,
    connection_id: String,
    request: v5::Request,
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
        },
        request.payload,
    )
    .await?;
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
        Ok(Body::Bulk(body)) => {
            return Settled::Bulk(Bulk {
                request_id,
                operation_id: descriptor.operation_id,
                type_name: descriptor.result_type.clone(),
                body,
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

fn session_exists(environment: &Environment, request: &v5::Request) -> Result<(), Failure> {
    let Some(v5::scope::Target::Session(id)) = &request.scope.target else {
        return Ok(());
    };
    let Some(core) = &environment.services.core else {
        return Err(Failure::Unavailable("Core is not ready".into()));
    };
    let session = session::Id::decode(&JsonValue::String(LosslessString::from(id.as_str())))
        .map_err(|_| Failure::Invalid("invalid Session ID".into()))?;
    match core.sessions.get(&session) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(Failure::SessionNotFound(id.clone())),
        Err(_) => Err(Failure::Unavailable("Session store unavailable".into())),
    }
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
                | Failure::FormNotFound(_)
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
            Failure::TelemetryDisabled if declared(v5::TelemetryDisabled::full_name()) => {
                encoded(v5::TelemetryDisabled { tag: 1 })
            }
            Failure::TelemetryDisabled => invalid("Telemetry disabled", "disabled"),
            Failure::Artifact(code) => crate::artifact::error_payload(&code),
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
                    message: convert::text("Session not found"),
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
            }),
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
    })
}

fn encoded<T: Message + Name>(error: T) -> v5::TypedPayload {
    v5::TypedPayload {
        type_name: T::full_name(),
        payload: error.encode_to_vec(),
    }
}
