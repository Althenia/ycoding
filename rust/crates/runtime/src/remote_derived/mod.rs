mod auth;
pub(crate) mod captured;
mod catalog;
mod session;
pub(crate) mod target;

use crate::dispatch::{Dispatcher, RegistrationError};

pub(crate) fn register(dispatcher: &mut Dispatcher) -> Result<(), RegistrationError> {
    auth::register(dispatcher)?;
    dispatcher.handle("workspace.list", target::list)?;
    dispatcher.handle("catalog.get", catalog::get)?;
    dispatcher.handle("session.status", session::status)?;
    dispatcher.handle("session.capturedChanges.list", captured::list)?;
    dispatcher.handle("session.family.activity", session::activity)?;
    dispatcher.handle("session.side-chat.create", session::side_create)?;
    dispatcher.handle("session.side-chat.list", session::side_list)?;
    dispatcher.handle("session.team.economics", session::economics)?;
    dispatcher.handle("session.team.shell.list", session::shell_list)?;
    dispatcher.handle("session.team.shell.kill", session::shell_kill)?;
    Ok(())
}
