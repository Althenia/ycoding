use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::PathBuf;
use ycoding_schema::keep_awake::LidState;

pub(super) struct Controller {
    file: Option<PathBuf>,
    owner: Option<File>,
    native: Box<dyn FnMut(bool) -> LidState + Send>,
    pub state: LidState,
}

impl Controller {
    pub fn unsupported() -> Self {
        Self {
            file: None,
            owner: None,
            native: Box::new(|_| LidState::Unsupported),
            state: LidState::Unsupported,
        }
    }
    pub fn new(file: PathBuf, native: Box<dyn FnMut(bool) -> LidState + Send>) -> Self {
        Self {
            file: Some(file),
            owner: None,
            native,
            state: LidState::Off,
        }
    }
    fn armed(&self) -> bool {
        self.file
            .as_ref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|value| serde_json::from_slice::<serde_json::Value>(&value).ok())
            .is_some_and(|value| {
                value.get("armed").and_then(serde_json::Value::as_bool) == Some(true)
            })
    }
    fn write(&self, armed: bool) -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(self.file.as_ref().expect("configured lid marker"))?;
        file.write_all(if armed {
            br#"{"armed":true}"#
        } else {
            br#"{"armed":false}"#
        })?;
        file.sync_all()
    }
    pub fn apply(&mut self, enabled: bool) {
        let Some(file) = &self.file else { return };
        if self.owner.is_none() {
            if !enabled && !self.armed() {
                self.state = LidState::Off;
                return;
            }
            let opened = file
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|_| {
                    let mut options = OpenOptions::new();
                    options.read(true).write(true).create(true).truncate(false);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    options.open(file.with_extension("lock"))
                });
            let owner = match opened {
                Ok(owner) => owner,
                Err(_) => {
                    self.state = LidState::Error;
                    return;
                }
            };
            match owner.try_lock() {
                Ok(()) => self.owner = Some(owner),
                Err(std::fs::TryLockError::WouldBlock) => {
                    self.state = LidState::Held;
                    return;
                }
                Err(std::fs::TryLockError::Error(error)) => {
                    self.state = if error.kind() == ErrorKind::Unsupported {
                        LidState::Unsupported
                    } else {
                        LidState::Error
                    };
                    return;
                }
            }
        }
        let previously_armed = self.armed();
        if enabled && self.write(true).is_err() {
            self.state = LidState::Error;
            self.owner = None;
            return;
        }
        self.state = (self.native)(enabled);
        if !enabled || self.state == LidState::Unsupported {
            if (self.state == LidState::Off
                || (enabled && self.state == LidState::Unsupported && !previously_armed))
                && self.write(false).is_err()
            {
                self.state = LidState::Error;
            }
            self.owner = None;
        }
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        if self.owner.is_some() {
            self.apply(false);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) fn native() -> Box<dyn FnMut(bool) -> LidState + Send> {
    Box::new(|_| LidState::Unsupported)
}

#[cfg(target_os = "macos")]
pub(super) fn native() -> Box<dyn FnMut(bool) -> LidState + Send> {
    let mut connection: Option<Native> = None;
    Box::new(move |enabled| {
        if connection.is_none() {
            connection = Native::open();
        }
        let Some(active) = connection.as_ref() else {
            return LidState::Error;
        };
        let scalar = u64::from(enabled);
        let code = unsafe {
            IOConnectCallScalarMethod(
                active.connect,
                12,
                &scalar,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if !enabled {
            connection = None;
        }
        if code != 0 {
            return LidState::Error;
        }
        if enabled { LidState::On } else { LidState::Off }
    })
}

#[cfg(target_os = "macos")]
struct Native {
    service: u32,
    connect: u32,
}

#[cfg(target_os = "macos")]
impl Native {
    fn open() -> Option<Self> {
        let service = unsafe {
            IOServiceGetMatchingService(0, IOServiceMatching(c"IOPMrootDomain".as_ptr()))
        };
        if service == 0 {
            return None;
        }
        let mut connect = 0;
        let code = unsafe { IOServiceOpen(service, mach_task_self_, 0, &mut connect) };
        if code != 0 || connect == 0 {
            unsafe {
                IOObjectRelease(service);
            }
            return None;
        }
        Some(Self { service, connect })
    }
}

#[cfg(target_os = "macos")]
impl Drop for Native {
    fn drop(&mut self) {
        unsafe {
            IOServiceClose(self.connect);
            IOObjectRelease(self.service);
        }
    }
}

#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    static mach_task_self_: u32;
    fn IOServiceMatching(name: *const libc::c_char) -> *mut libc::c_void;
    fn IOServiceGetMatchingService(port: u32, matching: *mut libc::c_void) -> u32;
    fn IOServiceOpen(service: u32, task: u32, kind: u32, connect: *mut u32) -> i32;
    fn IOConnectCallScalarMethod(
        connect: u32,
        selector: u32,
        input: *const u64,
        input_count: u32,
        output: *mut u64,
        output_count: *mut u32,
    ) -> i32;
    fn IOServiceClose(connect: u32) -> i32;
    fn IOObjectRelease(service: u32) -> i32;
}
