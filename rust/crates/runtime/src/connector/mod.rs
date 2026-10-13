mod credentials;
mod lifecycle;
pub(crate) mod operations;
mod transport;

pub use credentials::{Credential, Credentials, Enrolled, Peer};
pub use lifecycle::{Control, Intent, Preference, PreferenceFile, State, Status};
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
