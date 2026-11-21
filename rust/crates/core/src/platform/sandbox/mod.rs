use super::process::Command;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Disabled,
    Optional,
    Required,
}
pub struct Selection {
    pub command: Command,
    pub warnings: Vec<String>,
}
impl Selection {
    pub fn prepare(command: Command, mode: Mode) -> std::io::Result<Self> {
        if mode == Mode::Required {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "No enforceable shell sandbox backend is available on this runtime.",
            ));
        }
        let warnings = if mode == Mode::Optional {
            vec!["No enforceable shell sandbox backend was available; command ran with host-user filesystem, process, and network authority.".into()]
        } else {
            Vec::new()
        };
        Ok(Self { command, warnings })
    }
}
