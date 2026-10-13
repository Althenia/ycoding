mod activation;
pub mod capabilities;
pub mod context;
mod families;
pub mod provider;
mod schema;
mod supervisor;
pub use activation::Activation;
pub use families::Resources;
pub mod wire;
pub mod v5 {
    include!(concat!(env!("OUT_DIR"), "/ycoding.extension.v5.rs"));
}
pub use supervisor::{
    Configuration, Extension, FamilyGrant, Host, Launch, Options, SessionHost, ToolGrant,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    ObsoleteConfiguration,
    InvalidConfiguration,
    Permission,
    ApprovalUnavailable,
    Spawn,
    Protocol,
    Negotiation,
    Unauthorized,
    Schema,
    Stopped,
    Cancelled,
    Timeout,
    UnknownOutcome,
    Rejected,
    ExecutionFailed,
    Capacity,
}
impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ObsoleteConfiguration => "Executable plugins/npm configuration is unsupported; configure an explicit trusted process extension with executable, identity, and host grants",
            Self::InvalidConfiguration => "Invalid process-extension configuration",
            Self::Permission => "Process-extension authority rejected",
            Self::ApprovalUnavailable => "Process-extension launch requires approval, which no Session can give while its Location starts",
            Self::Spawn => "Process-extension launch failed",
            Self::Protocol => "Invalid process-extension channel frame",
            Self::Negotiation => "Process extension requires exact revision 5 and the assigned identity/generation",
            Self::Unauthorized => "Process-extension registration is outside host grants",
            Self::Schema => "Process-extension schema or value is invalid or unsupported",
            Self::Stopped => "Process-extension generation is closed",
            Self::Cancelled => "Process-extension call cancelled after cleanup",
            Self::Timeout => "Process-extension deadline exceeded; effects are not rolled back",
            Self::UnknownOutcome => "Process-extension call outcome is unknown; automatic replay is prohibited",
            Self::Rejected => "Process extension rejected the tool call",
            Self::ExecutionFailed => "Process-extension tool execution failed",
            Self::Capacity => "Process-extension capacity exhausted",
        })
    }
}
impl std::error::Error for Error {}
