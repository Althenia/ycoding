use crate::platform::process::{
    Command, KillOptions,
    tree::{Group, Owned},
};
use std::{
    fs::File,
    io::{self, Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    process::Stdio,
    sync::Arc,
};
use tokio::io::unix::AsyncFd;

pub struct Terminal(AsyncFd<File>);
pub struct Native {
    pub pid: u32,
    pub terminal: Arc<Terminal>,
    child: Owned,
    group: Group,
}

pub async fn spawn(command: Command, cols: u16, rows: u16) -> io::Result<Native> {
    let system = command.system.clone();
    let mut master = -1;
    let mut slave = -1;
    let mut size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let master = unsafe { File::from_raw_fd(master) };
    let slave = unsafe { File::from_raw_fd(slave) };
    for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    if unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let terminal = Arc::new(Terminal(AsyncFd::new(master)?));
    let mut cmd = tokio::process::Command::new(&command.program);
    if !command.extend_env {
        cmd.env_clear();
    }
    cmd.args(command.args).envs(command.env);
    if let Some(cwd) = command.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = Owned::new(cmd.spawn()?, true);
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("PTY spawn returned no process ID"))?;
    let group = Group::new(system, pid, true).await;
    Ok(Native {
        pid,
        child,
        group,
        terminal,
    })
}
impl Terminal {
    pub async fn read(&self, bytes: &mut [u8]) -> io::Result<usize> {
        loop {
            let mut ready = self.0.readable().await?;
            match ready.try_io(|file| {
                let mut file = file.get_ref();
                file.read(bytes)
            }) {
                Ok(Err(error)) if error.raw_os_error() == Some(libc::EIO) => return Ok(0),
                Ok(result) => return result,
                Err(_) => continue,
            }
        }
    }
    pub async fn write(&self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let mut ready = self.0.writable().await?;
            match ready.try_io(|file| {
                let mut file = file.get_ref();
                file.write(bytes)
            }) {
                Ok(result) => {
                    let count = result?;
                    if count == 0 {
                        return Err(io::ErrorKind::WriteZero.into());
                    }
                    bytes = &bytes[count..];
                }
                Err(_) => continue,
            }
        }
        Ok(())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        if unsafe { libc::ioctl(self.0.get_ref().as_raw_fd(), libc::TIOCSWINSZ as _, &size) } == -1
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
impl Native {
    pub async fn finish(&mut self) -> io::Result<()> {
        Ok(())
    }
    pub async fn wait(&mut self) -> io::Result<i32> {
        use std::os::unix::process::ExitStatusExt;
        let status = self.child.wait().await?;
        Ok(status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)))
    }
    pub async fn kill(&mut self) -> io::Result<i32> {
        use std::os::unix::process::ExitStatusExt;
        self.group
            .stop(KillOptions {
                force_kill_after: Some(std::time::Duration::from_secs(3)),
                ..Default::default()
            })
            .await?;
        let status = self.child.wait().await?;
        Ok(status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)))
    }
}
