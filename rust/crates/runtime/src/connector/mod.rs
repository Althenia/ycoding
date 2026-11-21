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
    Unauthorized,
    Forbidden,
    Preference,
    Transport,
    Incompatible,
    Conflict,
    Shutdown,
}
