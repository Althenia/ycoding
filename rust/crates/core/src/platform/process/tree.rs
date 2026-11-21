use super::{KillOptions, KillSignal};
use std::{future::Future, io, pin::Pin, process::ExitStatus, sync::Arc, time::Duration};

#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(3);
#[cfg(unix)]
const KILL_CONFIRMATION: Duration = Duration::from_secs(1);
#[cfg(unix)]
const MEMBERSHIP_POLL: Duration = Duration::from_millis(25);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub pid: u32,
    pub pgid: u32,
    pub started: String,
}

pub type Members<'a> = Pin<Box<dyn Future<Output = io::Result<Vec<Member>>> + Send + 'a>>;

pub trait GroupSystem: std::fmt::Debug + Send + Sync {
    fn read(&self) -> Members<'_>;
    fn signal(&self, target: i32, signal: KillSignal) -> io::Result<()>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NativeGroupSystem;

impl GroupSystem for NativeGroupSystem {
    fn read(&self) -> Members<'_> {
        Box::pin(read_members())
    }

    fn signal(&self, target: i32, signal: KillSignal) -> io::Result<()> {
        #[cfg(unix)]
        {
            let number = if signal == KillSignal::Kill {
                libc::SIGKILL
            } else {
                libc::SIGTERM
            };
            if unsafe { libc::kill(target, number) } == 0 {
                return Ok(());
            }
            Err(io::Error::last_os_error())
        }
        #[cfg(windows)]
        {
            let _ = (target, signal);
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "POSIX process signals are unavailable on Windows",
            ))
        }
    }
}

#[cfg(unix)]
async fn read_members() -> io::Result<Vec<Member>> {
    Ok(snapshot().await?.lines().filter_map(member).collect())
}

#[cfg(windows)]
async fn read_members() -> io::Result<Vec<Member>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "POSIX process groups are unavailable on Windows",
    ))
}

#[cfg(unix)]
fn member(line: &str) -> Option<Member> {
    let fields: Vec<_> = line.split_whitespace().collect();
    if fields.len() < 5 || fields[3].starts_with('Z') {
        return None;
    }
    Some(Member {
        pid: fields[0].parse().ok()?,
        pgid: fields[1].parse().ok()?,
        started: fields[4..].join(" "),
    })
}

#[cfg(unix)]
pub(crate) struct Group {
    system: Arc<dyn GroupSystem>,
    leader: u32,
    grouped: bool,
    original: Result<Option<String>, (io::ErrorKind, String)>,
    closed: bool,
}

#[cfg(unix)]
impl Group {
    pub(crate) async fn new(system: Arc<dyn GroupSystem>, leader: u32, grouped: bool) -> Self {
        let original = match system.read().await {
            Ok(members) => Ok(members
                .into_iter()
                .find(|member| member.pid == leader)
                .map(|member| member.started)),
            Err(error) => Err((error.kind(), error.to_string())),
        };
        Self {
            system,
            leader,
            grouped,
            original,
            closed: false,
        }
    }

    pub(crate) fn started(&self) -> Option<String> {
        self.original.as_ref().ok().cloned().flatten()
    }

    async fn members(&mut self) -> io::Result<Vec<Member>> {
        if self.closed {
            return Ok(Vec::new());
        }
        let snapshot = self.system.read().await?;
        let leader = self.leader;
        let grouped = self.grouped;
        let current: Vec<Member> = snapshot
            .iter()
            .filter(|member| {
                if grouped {
                    member.pgid == leader
                } else {
                    member.pid == leader
                }
            })
            .cloned()
            .collect();
        if current.is_empty() {
            self.closed = true;
            return Ok(current);
        }
        if let Err((kind, message)) = &self.original {
            return Err(io::Error::new(*kind, message.clone()));
        }
        let original = self.original.as_ref().ok().and_then(Option::as_ref);
        let replaced = snapshot
            .iter()
            .any(|member| member.pid == leader && Some(&member.started) != original);
        if replaced {
            self.closed = true;
            return Ok(Vec::new());
        }
        Ok(current)
    }

    pub(crate) async fn signal(&mut self, signal: KillSignal) -> io::Result<()> {
        if self.members().await?.is_empty() {
            return Ok(());
        }
        let leader = self.leader as i32;
        let target = if self.grouped { -leader } else { leader };
        match self.system.signal(target, signal) {
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(()),
            result => result,
        }
    }

    async fn gone(&mut self, within: Duration) -> io::Result<bool> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            if self.members().await?.is_empty() {
                return Ok(true);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Ok(false);
            }
            tokio::time::sleep(MEMBERSHIP_POLL.min(deadline - now)).await;
        }
    }

    async fn escalate(&mut self, options: KillOptions) -> io::Result<()> {
        self.signal(options.signal).await?;
        if self
            .gone(options.force_kill_after.unwrap_or(TERMINATE_GRACE))
            .await?
        {
            return Ok(());
        }
        self.signal(KillSignal::Kill).await?;
        if self.gone(KILL_CONFIRMATION).await? {
            return Ok(());
        }
        Err(io::Error::other(
            "Process group remained alive after SIGKILL",
        ))
    }

    pub(crate) async fn stop(&mut self, options: KillOptions) -> io::Result<()> {
        self.escalate(options).await
    }

    pub(crate) async fn terminate(
        &mut self,
        _child: &mut tokio::process::Child,
        options: KillOptions,
    ) -> io::Result<Option<ExitStatus>> {
        self.stop(options).await.map(|()| None)
    }

    pub(crate) async fn sweep(&mut self, grace: Duration) -> io::Result<()> {
        self.stop(KillOptions {
            signal: KillSignal::Term,
            force_kill_after: Some(grace),
        })
        .await
    }
}

#[cfg(windows)]
pub(crate) struct Group {
    pid: u32,
}

#[cfg(windows)]
impl Group {
    pub(crate) async fn new(_system: Arc<dyn GroupSystem>, leader: u32, _grouped: bool) -> Self {
        Self { pid: leader }
    }

    pub(crate) fn started(&self) -> Option<String> {
        None
    }

    pub(crate) async fn signal(&mut self, _signal: KillSignal) -> io::Result<()> {
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("taskkill")
            .args(["/pid", &self.pid.to_string()])
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other("taskkill failed to signal process"))
        }
    }

    pub(crate) async fn stop(&mut self, _options: KillOptions) -> io::Result<()> {
        let status = tokio::process::Command::new("taskkill")
            .args(["/pid", &self.pid.to_string(), "/T", "/F"])
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .status()
            .await?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(
                "taskkill failed to terminate process tree",
            ))
        }
    }

    pub(crate) async fn terminate(
        &mut self,
        child: &mut tokio::process::Child,
        options: KillOptions,
    ) -> io::Result<Option<ExitStatus>> {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        let stopped = self.stop(options).await;
        if stopped.is_err() && child.try_wait()?.is_none() {
            return stopped.map(|()| None);
        }
        child.wait().await.map(Some)
    }

    pub(crate) async fn sweep(&mut self, _grace: Duration) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) struct Owned {
    child: tokio::process::Child,
    grouped: bool,
    pub(crate) released: bool,
}

impl Owned {
    pub(crate) fn new(child: tokio::process::Child, grouped: bool) -> Self {
        Self {
            child,
            grouped,
            released: false,
        }
    }
}

impl std::ops::Deref for Owned {
    type Target = tokio::process::Child;

    fn deref(&self) -> &Self::Target {
        &self.child
    }
}

impl std::ops::DerefMut for Owned {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let Some(pid) = self.child.id() else {
            return;
        };
        #[cfg(unix)]
        {
            let leader = pid as i32;
            unsafe {
                libc::kill(if self.grouped { -leader } else { leader }, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            let _ = (pid, self.grouped);
            let _ = self.child.start_kill();
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

#[cfg(all(test, windows))]
mod windows_tests {
    use super::{Group, NativeGroupSystem};
    use crate::platform::process::KillOptions;
    use std::{process::Stdio, sync::Arc};

    #[tokio::test]
    async fn terminating_an_already_reaped_child_never_signals_the_stored_pid() {
        let mut exited = tokio::process::Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        exited.wait().await.unwrap();
        let mut decoy = tokio::process::Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut group = Group::new(
            Arc::new(NativeGroupSystem),
            decoy.id().expect("decoy is live"),
            false,
        )
        .await;
        let status = group
            .terminate(&mut exited, KillOptions::default())
            .await
            .unwrap()
            .expect("reaped child reports its status");
        let alive = decoy.try_wait().unwrap().is_none();
        decoy.start_kill().unwrap();
        decoy.wait().await.unwrap();
        assert_eq!(status.code(), Some(0));
        assert!(alive, "the stale-PID terminate signalled a live process");
    }
}
