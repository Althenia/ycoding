use ycoding_schema::LosslessString;

mod callback;
pub mod client;
pub mod configuration;
mod http;
pub mod instructions;
pub mod oauth;
mod output_schema;
mod service;
pub mod skills;
mod stdio;
mod transport;
mod validation;
pub use service::{Event, ServerInfo, Service, Tool};

pub fn namespace(server: &LosslessString) -> LosslessString {
    LosslessString::from_utf16(
        server
            .code_units()
            .map(|unit| match unit {
                45 | 48..=57 | 65..=90 | 95 | 97..=122 => unit,
                _ => 95,
            })
            .collect(),
    )
}

pub fn tool_name(server: &LosslessString, tool: &LosslessString) -> LosslessString {
    super::discovery::join(&[namespace(server), namespace(tool)], "_")
}

pub fn backgroundable(name: &str) -> bool {
    name.split(['_', '-']).any(|part| {
        [
            "shell", "bash", "exec", "execute", "command", "cmd", "terminal", "run", "spawn",
            "process",
        ]
        .iter()
        .any(|word| part.eq_ignore_ascii_case(word))
    })
}
