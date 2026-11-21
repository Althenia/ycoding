#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Refused(String),
    #[error("Invalid Project input: {0}")]
    InvalidInput(#[from] ycoding_schema::DecodeError),
    #[error("{0}")]
    Store(#[from] ycoding_store::Error),
    #[error("{0}")]
    Execution(#[from] crate::session::run_coordinator::Error),
}

impl Error {
    pub fn refused(message: impl Into<String>) -> Self {
        Self::Refused(message.into())
    }
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            Self::Refused(_) => Some("CoordinationRuntime.RefusedError"),
            Self::InvalidInput(_) => Some("Coordination.InvalidInputError"),
            Self::Store(ycoding_store::Error::Domain { kind, .. })
                if kind.starts_with("Coordination.")
                    || *kind == "CoordinationRuntime.RefusedError" =>
            {
                Some(kind)
            }
            _ => None,
        }
    }
}

pub(super) fn not_found() -> ycoding_store::Error {
    domain("Coordination.NotFoundError", "Project does not exist")
}
pub(super) fn ineligible(message: &'static str) -> ycoding_store::Error {
    domain("Coordination.IneligibleSessionError", message)
}
pub(super) fn conflict() -> ycoding_store::Error {
    domain("Coordination.ConflictError", "Project revision changed")
}
pub(super) fn denied(message: &'static str) -> ycoding_store::Error {
    domain("CoordinationRuntime.RefusedError", message)
}
fn domain(kind: &'static str, message: &'static str) -> ycoding_store::Error {
    ycoding_store::Error::Domain { kind, message }
}
