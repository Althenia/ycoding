use super::{DesktopState, Host, Lease, control_lines, executable, shutdown};
use std::io;
use tauri::{Emitter, Manager};

pub(super) fn start(app: &tauri::App) -> Result<Host, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| "Native resources are unavailable.")?;
    executable(&resources)?;
    let canonical = resources
        .canonicalize()
        .map_err(|_| "Native resources are unavailable.".to_owned())?;
    let control = control_lines(&canonical)?;
    let emitter = app.handle().clone();
    let ending = app.handle().clone();
    Host::attach(
        move |channel, data| emitter.emit(channel, data).is_ok(),
        io::stdout(),
        io::stdin(),
        Lease::Inherited,
        Some(control),
        Some(Box::new(move || {
            if ending.try_state::<DesktopState>().is_some() {
                shutdown(&ending);
            } else {
                std::process::exit(1);
            }
        })),
    )
}
