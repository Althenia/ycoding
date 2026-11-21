use std::fmt;
use ycoding_core::ycoding_schema::LosslessString;

pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
pub const PERMISSION_DENIED: i64 = -32001;
pub const NOT_FOUND: i64 = -32004;
pub const SESSION_ALREADY_ATTACHED: i64 = -32010;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: LosslessString,
}

pub fn echo(prefix: &str, value: &LosslessString, suffix: &str) -> LosslessString {
    let mut units: Vec<u16> = prefix.encode_utf16().collect();
    units.extend(value.code_units());
    units.extend(suffix.encode_utf16());
    LosslessString::from_utf16(units)
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<LosslessString>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_params(message: impl Into<LosslessString>) -> Self {
        Self::new(INVALID_PARAMS, message)
    }

    pub fn unknown_session(session_id: &LosslessString) -> Self {
        Self::new(INVALID_REQUEST, echo("unknown session id ", session_id, ""))
    }

    pub fn not_supported(method: &str) -> Self {
        Self::new(METHOD_NOT_FOUND, format!("Method not supported: {method}"))
    }
}

fn lossy_text(value: &LosslessString) -> String {
    char::decode_utf16(value.code_units())
        .map(|unit| unit.unwrap_or('\u{fffd}'))
        .collect()
}

impl fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", lossy_text(&self.message), self.code)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HandlerError {
    Rpc(RpcError),
    Executor { code: i64, message: LosslessString },
    Internal,
}

impl From<RpcError> for HandlerError {
    fn from(error: RpcError) -> Self {
        Self::Rpc(error)
    }
}

pub fn fixed_message(code: i64) -> Option<&'static str> {
    Some(match code {
        INVALID_REQUEST => "Invalid Request",
        METHOD_NOT_FOUND => "Method not found",
        INVALID_PARAMS => "Invalid params",
        INTERNAL_ERROR => "Internal error",
        PERMISSION_DENIED => "Permission denied",
        NOT_FOUND => "Not found",
        SESSION_ALREADY_ATTACHED => "Session already attached",
        _ => return None,
    })
}

impl HandlerError {
    pub fn wire(&self) -> (i64, LosslessString) {
        match self {
            Self::Rpc(error) => (error.code, error.message.clone()),
            Self::Executor { code, message } => match fixed_message(*code) {
                Some(fixed) if message.is_empty() => (*code, LosslessString::from(fixed)),
                Some(_) => (*code, message.clone()),
                None => (INTERNAL_ERROR, LosslessString::from("Internal error")),
            },
            Self::Internal => (INTERNAL_ERROR, LosslessString::from("Internal error")),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SendFailed;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CallError {
    Closed,
    TimedOut { method: String },
    Cancelled { method: String },
    Remote(RpcError),
}

impl fmt::Display for CallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => formatter.write_str("Connection closed"),
            Self::TimedOut { method } => write!(formatter, "executor request {method} timed out"),
            Self::Cancelled { method } => {
                write!(formatter, "executor request {method} was cancelled")
            }
            Self::Remote(error) => formatter.write_str(&lossy_text(&error.message)),
        }
    }
}
