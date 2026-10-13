pub mod admission;
pub mod boundary;
pub mod bridge;
pub mod capture;
pub mod cdp;
pub mod chrome;
#[cfg(unix)]
pub mod chrome_executor;
#[cfg(unix)]
mod chrome_page;
#[cfg(unix)]
mod chrome_process;
#[cfg(unix)]
mod chrome_target;
pub mod extension;
pub mod isolated;
pub mod protocol;
pub mod service;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub message: String,
    pub cancelled: bool,
}

impl Error {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            cancelled: false,
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Error {}
