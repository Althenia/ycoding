use crate::platform::process::Command;
use std::{
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    sync::{
        Arc,
        atomic::{AtomicIsize, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use windows_sys::Win32::{
    Foundation::{HANDLE, WAIT_OBJECT_0},
    System::{
        Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole},
        Pipes::CreatePipe,
        Threading::{
            CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
            EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, InitializeProcThreadAttributeList,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTUPINFOEXW,
            UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

struct Console(AtomicIsize);
impl Drop for Console {
    fn drop(&mut self) {
        let handle = self.0.swap(0, Ordering::AcqRel);
        if handle != 0 {
            unsafe {
                ClosePseudoConsole(handle);
            }
        }
    }
}
pub struct Terminal {
    console: Console,
    input: tokio::sync::Mutex<tokio::fs::File>,
    output: tokio::sync::Mutex<tokio::fs::File>,
}
pub struct Native {
    pub pid: u32,
    pub terminal: Arc<Terminal>,
    process: OwnedHandle,
    close: Option<tokio::task::JoinHandle<()>>,
    closed: bool,
}

fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let mut read = std::ptr::null_mut();
    let mut write = std::ptr::null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe {
        (
            OwnedHandle::from_raw_handle(read),
            OwnedHandle::from_raw_handle(write),
        )
    })
}
fn wide(text: &str) -> io::Result<Vec<u16>> {
    if text.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Native process argument contains NUL",
        ));
    }
    Ok(text.encode_utf16().chain([0]).collect())
}
fn quote(text: &str) -> String {
    let mut output = String::from("\"");
    let mut slashes = 0;
    for character in text.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        if character == '"' {
            output.push_str(&"\\".repeat(slashes * 2 + 1));
            output.push('"');
            slashes = 0;
            continue;
        }
        output.push_str(&"\\".repeat(slashes));
        slashes = 0;
        output.push(character);
    }
    output.push_str(&"\\".repeat(slashes * 2));
    output.push('"');
    output
}

pub fn spawn(command: Command, cols: u16, rows: u16) -> io::Result<Native> {
    let (read, input) = pipe()?;
    let (output, write) = pipe()?;
    let mut console = 0;
    let result = unsafe {
        CreatePseudoConsole(
            COORD {
                X: cols as i16,
                Y: rows as i16,
            },
            read.as_raw_handle(),
            write.as_raw_handle(),
            0,
            &mut console,
        )
    };
    if result < 0 {
        return Err(io::Error::other(format!(
            "CreatePseudoConsole failed: {result}"
        )));
    }
    let console = Console(AtomicIsize::new(console));
    drop(read);
    drop(write);
    let mut bytes = 0;
    unsafe {
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut bytes);
    }
    let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
    let list = storage.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut bytes) } == 0 {
        return Err(io::Error::last_os_error());
    }
    struct Attributes(windows_sys::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST);
    impl Drop for Attributes {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.0);
            }
        }
    }
    let attributes = Attributes(list);
    if unsafe {
        UpdateProcThreadAttribute(
            attributes.0,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            console.0.load(Ordering::Acquire) as *const std::ffi::c_void,
            std::mem::size_of::<HPCON>(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attributes.0;
    let mut process = PROCESS_INFORMATION::default();
    let mut line = wide(
        &std::iter::once(command.program.as_str())
            .chain(command.args.iter().map(String::as_str))
            .map(quote)
            .collect::<Vec<_>>()
            .join(" "),
    )?;
    let mut environment: std::collections::BTreeMap<String, (String, String)> =
        if command.extend_env {
            std::env::vars()
                .map(|(key, value)| (key.to_uppercase(), (key, value)))
                .collect()
        } else {
            Default::default()
        };
    for (key, value) in command.env {
        if key.contains(['\0', '=']) || value.contains('\0') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid native process environment",
            ));
        }
        environment.insert(key.to_uppercase(), (key, value));
    }
    let mut environment: Vec<u16> = environment
        .values()
        .flat_map(|(key, value)| {
            format!("{key}={value}")
                .encode_utf16()
                .chain([0])
                .collect::<Vec<_>>()
        })
        .collect();
    if environment.is_empty() {
        environment.push(0);
    }
    environment.push(0);
    let cwd = command
        .cwd
        .map(|cwd| cwd.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>());
    if unsafe {
        CreateProcessW(
            std::ptr::null(),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            environment.as_ptr().cast(),
            cwd.as_ref().map_or(std::ptr::null(), |cwd| cwd.as_ptr()),
            &startup.StartupInfo,
            &mut process,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let process_handle = unsafe { OwnedHandle::from_raw_handle(process.hProcess) };
    drop(unsafe { OwnedHandle::from_raw_handle(process.hThread) });
    Ok(Native {
        pid: process.dwProcessId,
        process: process_handle,
        close: None,
        closed: false,
        terminal: Arc::new(Terminal {
            console,
            input: tokio::sync::Mutex::new(tokio::fs::File::from_std(std::fs::File::from(input))),
            output: tokio::sync::Mutex::new(tokio::fs::File::from_std(std::fs::File::from(output))),
        }),
    })
}
impl Terminal {
    fn begin_close(&self) -> Option<tokio::task::JoinHandle<()>> {
        let handle = self.console.0.swap(0, Ordering::AcqRel);
        if handle == 0 {
            return None;
        }
        Some(tokio::task::spawn_blocking(move || unsafe {
            ClosePseudoConsole(handle);
        }))
    }
    pub async fn read(&self, bytes: &mut [u8]) -> io::Result<usize> {
        match self.output.lock().await.read(bytes).await {
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(0),
            result => result,
        }
    }
    pub async fn write(&self, bytes: &[u8]) -> io::Result<()> {
        self.input.lock().await.write_all(bytes).await
    }
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let result = unsafe {
            ResizePseudoConsole(
                self.console.0.load(Ordering::Acquire),
                COORD {
                    X: cols as i16,
                    Y: rows as i16,
                },
            )
        };
        if result < 0 {
            return Err(io::Error::other(format!(
                "ResizePseudoConsole failed: {result}"
            )));
        }
        Ok(())
    }
}
impl Native {
    pub async fn finish(&mut self) -> io::Result<()> {
        if let Some(close) = self.close.as_mut() {
            close.await.map_err(io::Error::other)?;
            self.close = None;
        }
        Ok(())
    }
    fn exited(&self) -> io::Result<Option<i32>> {
        let result = unsafe { WaitForSingleObject(self.process.as_raw_handle() as HANDLE, 0) };
        if result == windows_sys::Win32::Foundation::WAIT_FAILED {
            return Err(io::Error::last_os_error());
        }
        if result != WAIT_OBJECT_0 {
            return Ok(None);
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(self.process.as_raw_handle() as HANDLE, &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(code as i32))
    }
    pub async fn wait(&mut self) -> io::Result<i32> {
        loop {
            if let Some(code) = self.exited()? {
                if !self.closed {
                    self.close = self.terminal.begin_close();
                    self.closed = true;
                }
                return Ok(code);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    pub async fn kill(&mut self) -> io::Result<i32> {
        if self.exited()?.is_some() {
            return self.wait().await;
        }
        let status = tokio::process::Command::new("taskkill")
            .args(["/pid", &self.pid.to_string(), "/T", "/F"])
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .status()
            .await?;
        if !status.success() && self.exited()?.is_none() {
            return Err(io::Error::other("taskkill failed to terminate PTY tree"));
        }
        self.wait().await
    }
}
impl Drop for Native {
    fn drop(&mut self) {
        if self.exited().is_ok_and(|exit| exit.is_none()) {
            crate::platform::process::tree::force(self.pid, false);
        }
    }
}
