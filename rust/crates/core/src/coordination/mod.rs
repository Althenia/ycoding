pub mod authority;
pub mod decision_context;
pub mod decisions;
mod error;
pub mod instructions;
pub mod runtime;
mod service;

pub use error::Error;
pub use service::{Access, Group, OwnerInput, Role, Scope, Service, can_act};

#[derive(Clone, Debug)]
pub struct Admission {
    pub group_id: ycoding_schema::coordination::GroupId,
    pub master_session_id: ycoding_schema::session::Id,
    pub sender_session_id: ycoding_schema::session::Id,
    pub message_id: ycoding_schema::session_message::Id,
    pub model: Option<ycoding_schema::model::Ref>,
}
