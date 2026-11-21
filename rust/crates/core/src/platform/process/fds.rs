use super::FdDirection;
use std::{
    collections::BTreeMap,
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::net::UnixStream,
};

pub struct Prepared {
    pub child: Vec<(i32, OwnedFd)>,
    pub parent: BTreeMap<u32, (FdDirection, tokio::net::UnixStream)>,
}

pub fn prepare(fds: &BTreeMap<u32, FdDirection>) -> io::Result<Prepared> {
    let max = fds.keys().copied().max().unwrap_or(2);
    let minimum = i32::try_from(
        max.checked_add(1)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid additional FD"))?,
    )
    .map_err(io::Error::other)?;
    if fds.keys().any(|fd| *fd < 3) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Additional FDs start at three",
        ));
    }
    let mut child = Vec::new();
    let mut parent = BTreeMap::new();
    for fd in 3..=max {
        let source: OwnedFd = if let Some(direction) = fds.get(&fd) {
            let (read, write) = UnixStream::pair()?;
            read.set_nonblocking(true)?;
            parent.insert(fd, (*direction, tokio::net::UnixStream::from_std(read)?));
            write.into()
        } else {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open("/dev/null")?
                .into()
        };
        let raw = unsafe { libc::fcntl(source.as_raw_fd(), libc::F_DUPFD_CLOEXEC, minimum) };
        if raw == -1 {
            return Err(io::Error::last_os_error());
        }
        child.push((fd as i32, unsafe { OwnedFd::from_raw_fd(raw) }));
    }
    Ok(Prepared { child, parent })
}
