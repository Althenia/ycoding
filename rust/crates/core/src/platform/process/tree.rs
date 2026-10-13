#[cfg(unix)]
use std::time::Duration;
use std::{io, process::ExitStatus};

#[cfg(unix)]
fn signal(pid: u32, signal: i32, detached: bool) -> io::Result<()> {
    if unsafe { libc::kill(if detached { -(pid as i32) } else { pid as i32 }, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(error)
}

pub(crate) async fn terminate(
    child: &mut tokio::process::Child,
    pid: u32,
    options: super::KillOptions,
    detached: bool,
) -> io::Result<ExitStatus> {
    #[cfg(unix)]
    {
        if let Some(status) = child.try_wait()?
            && (!detached || !group_alive(pid).await?)
        {
            return Ok(status);
        }
        signal(
            pid,
            if options.signal == super::KillSignal::Kill {
                libc::SIGKILL
            } else {
                libc::SIGTERM
            },
            detached,
        )?;
        let status = match options.force_kill_after {
            Some(grace) => match tokio::time::timeout(grace, child.wait()).await {
                Ok(status) => status?,
                Err(_) => {
                    signal(pid, libc::SIGKILL, detached)?;
                    child.wait().await?
                }
            },
            None => child.wait().await?,
        };
        if !detached {
            return Ok(status);
        }
        if group_alive(pid).await? {
            signal(pid, libc::SIGKILL, true)?;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            if !group_alive(pid).await? {
                return Ok(status);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(io::Error::other(
                    "Process group remained alive after SIGKILL",
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    #[cfg(windows)]
    {
        let _ = (options, detached);
        let status = tokio::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .status()
            .await?;
        if !status.success() && child.try_wait()?.is_none() {
            return Err(io::Error::other(
                "taskkill failed to terminate process tree",
            ));
        }
        child.wait().await
    }
}

pub(crate) fn send(pid: u32, requested: super::KillSignal, detached: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        signal(
            pid,
            if requested == super::KillSignal::Kill {
                libc::SIGKILL
            } else {
                libc::SIGTERM
            },
            detached,
        )
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = (requested, detached);
        let status = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string()])
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other("taskkill failed to signal process"))
        }
    }
}

pub(crate) fn force(pid: u32, detached: bool) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(
                if detached { -(pid as i32) } else { pid as i32 },
                libc::SIGKILL,
            );
        }
    }
    #[cfg(windows)]
    {
        let _ = detached;
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess},
        };
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !handle.is_null() {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
}

#[cfg(unix)]
async fn snapshot() -> io::Result<String> {
    use tokio::io::AsyncReadExt;
    let mut child = tokio::process::Command::new("ps")
        .args(["-axo", "pid=,pgid=,rss=,stat=,lstart="])
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing ps output"))?
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 4 * 1024 * 1024 {
        child.kill().await?;
        return Err(io::Error::other("Process listing exceeded its byte limit"));
    }
    if !child.wait().await?.success() {
        return Err(io::Error::other("Process listing failed"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub async fn identity(pid: u32) -> io::Result<Option<String>> {
    #[cfg(unix)]
    {
        Ok(snapshot().await?.lines().find_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            (fields.len() >= 5 && fields[0].parse::<u32>() == Ok(pid))
                .then(|| fields[4..].join(" "))
        }))
    }
    #[cfg(windows)]
    {
        let _ = pid;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "POSIX process identity is unavailable on Windows",
        ))
    }
}

pub async fn process_group_memory(pid: u32) -> io::Result<Option<(String, u64)>> {
    #[cfg(unix)]
    {
        let snapshot = snapshot().await?;
        let processes: Vec<_> = snapshot
            .lines()
            .filter_map(|line| {
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.len() < 5 {
                    return None;
                }
                Some((
                    fields[0].parse::<u32>().ok()?,
                    fields[1].parse::<u32>().ok()?,
                    fields[2].parse::<u64>().ok()?,
                    fields[4..].join(" "),
                ))
            })
            .collect();
        Ok(processes
            .iter()
            .find(|process| process.0 == pid && process.1 == pid)
            .map(|root| {
                (
                    root.3.clone(),
                    processes
                        .iter()
                        .filter(|process| process.1 == pid)
                        .map(|process| process.2)
                        .sum(),
                )
            }))
    }
    #[cfg(windows)]
    {
        let _ = pid;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Shell process-tree memory limits are unavailable on Windows",
        ))
    }
}

#[cfg(unix)]
async fn group_alive(pid: u32) -> io::Result<bool> {
    Ok(snapshot().await?.lines().any(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        fields.len() >= 4 && fields[1].parse::<u32>() == Ok(pid) && !fields[3].starts_with('Z')
    }))
}

pub fn is_alive(pid: u32) -> io::Result<bool> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()?;
        Ok(output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .any(|state| !state.starts_with('Z')))
    }
    #[cfg(windows)]
    {
        let _ = pid;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "POSIX process observation is unavailable on Windows",
        ))
    }
}
