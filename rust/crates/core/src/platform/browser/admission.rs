use std::{collections::HashMap, sync::Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Selected,
    Isolated,
}

#[derive(Default)]
pub struct Admission {
    modes: Mutex<HashMap<String, Mode>>,
}

impl Admission {
    pub fn current(&self, session: &str) -> Option<Mode> {
        self.modes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session)
            .copied()
    }
    pub fn claim(&self, session: &str, mode: Mode) -> bool {
        let mut modes = self.modes.lock().unwrap_or_else(|e| e.into_inner());
        if modes.get(session).is_some_and(|current| *current != mode) {
            return false;
        }
        modes.insert(session.into(), mode);
        true
    }
    pub fn release(&self, session: &str, mode: Mode) {
        let mut modes = self.modes.lock().unwrap_or_else(|e| e.into_inner());
        if modes.get(session) == Some(&mode) {
            modes.remove(session);
        }
    }
}
