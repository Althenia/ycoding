mod credentials;
mod lifecycle;
pub mod mcp;
pub mod mcp_events_authorization;
pub(crate) mod operations;
mod quota;
mod transport;

pub use credentials::{Credential, Credentials, Enrolled, Peer};
pub use lifecycle::{Control, Intent, Preference, PreferenceFile, State, Status};
pub use operations::register;
pub use transport::{Connector, Settings};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Setup,
    NotEnrolled,
    EnrollmentStore,
    Unauthorized,
    Forbidden,
    Preference,
    Transport,
    Connection(ConnectionFailure),
    Incompatible,
    Conflict,
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionFailure {
    Credentials,
    CredentialRenewal,
    UpgradeTimedOut,
    UpgradeRefused(u16),
    Tls,
    Open,
    Read(std::io::ErrorKind),
    Write,
    Closed {
        code: Option<u16>,
        established: bool,
    },
    EndedWithoutClose {
        established: bool,
    },
}

impl From<ConnectionFailure> for Error {
    fn from(failure: ConnectionFailure) -> Self {
        Self::Connection(failure)
    }
}
