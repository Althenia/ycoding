#![cfg(unix)]

use std::{
    fs::File,
    io::{Read, Write},
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, IntoRawFd, RawFd},
        unix::net::UnixStream,
    },
    process::Command,
    time::Duration,
};
use ycoding_core::extension::ParentOwner;

fn identity(fd: RawFd) -> (libc::dev_t, libc::ino_t, libc::mode_t, libc::dev_t) {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    assert_eq!(unsafe { libc::fstat(fd, stat.as_mut_ptr()) }, 0);
    let stat = unsafe { stat.assume_init() };
    (stat.st_dev, stat.st_ino, stat.st_mode, stat.st_rdev)
}

fn transfer_byte(writer: &mut UnixStream, reader: &mut UnixStream, byte: u8) {
    writer.write_all(&[byte]).unwrap();
    let mut received = [0];
    reader.read_exact(&mut received).unwrap();
    assert_eq!(received, [byte]);
}

#[test]
fn adopts_both_streams_sets_cloexec_and_reaps_unstarted_owner() {
    let (data, mut data_peer) = UnixStream::pair().unwrap();
    let (cleanup, mut cleanup_peer) = UnixStream::pair().unwrap();
    for peer in [&data_peer, &cleanup_peer] {
        peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    }
    let descriptors = [data.as_raw_fd(), cleanup.as_raw_fd()];
    let identities = descriptors.map(identity);
    for fd in descriptors {
        assert!(fd >= 3);
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert!(flags >= 0);
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) },
            0
        );
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
    }
    let data = data.into_raw_fd();
    let cleanup = cleanup.into_raw_fd();
    let owner = ParentOwner::inherit(Some(data as u32), Some(cleanup as u32))
        .unwrap()
        .unwrap();
    for fd in descriptors {
        let fd_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        let status_flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        assert!(fd_flags >= 0 && fd_flags & libc::FD_CLOEXEC != 0);
        assert!(status_flags >= 0 && status_flags & libc::O_NONBLOCK != 0);
    }
    let script = r#"
import errno, os, sys
for item in sys.argv[1:]:
    fd, dev, ino, mode, rdev = map(int, item.split(','))
    try:
        stat = os.fstat(fd)
    except OSError as error:
        if error.errno != errno.EBADF:
            raise
        continue
    assert (stat.st_dev, stat.st_ino, stat.st_mode, stat.st_rdev) != (dev, ino, mode, rdev)
"#;
    let mut child = Command::new("/usr/bin/python3");
    child.arg("-c").arg(script);
    for (fd, (dev, ino, mode, rdev)) in descriptors.into_iter().zip(identities) {
        child.arg(format!("{fd},{dev},{ino},{mode},{rdev}"));
    }
    let output = child.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    drop(owner);
    let mut byte = [0];
    assert_eq!(data_peer.read(&mut byte).unwrap(), 0);
    assert_eq!(cleanup_peer.read(&mut byte).unwrap(), 0);
}

#[test]
fn rejects_stdio_non_socket_and_distinct_duplicated_open_resources() {
    let (mut socket, mut peer) = UnixStream::pair().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let fd = socket.as_raw_fd();
    assert!(fd >= 3);
    for stdio in 0..=2 {
        assert!(ParentOwner::inherit(Some(stdio), Some(fd as u32)).is_err());
        assert!(ParentOwner::inherit(Some(fd as u32), Some(stdio)).is_err());
        transfer_byte(&mut socket, &mut peer, stdio as u8);
    }

    let mut file = File::open(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    assert!(file.as_raw_fd() >= 3);
    assert!(ParentOwner::inherit(Some(fd as u32), Some(file.as_raw_fd() as u32)).is_err());
    assert!(ParentOwner::inherit(Some(file.as_raw_fd() as u32), Some(fd as u32)).is_err());
    let mut byte = [0];
    assert_eq!(file.read(&mut byte).unwrap(), 1);
    transfer_byte(&mut socket, &mut peer, 3);

    let mut duplicate = socket.try_clone().unwrap();
    assert_ne!(fd, duplicate.as_raw_fd());
    assert!(ParentOwner::inherit(Some(fd as u32), Some(duplicate.as_raw_fd() as u32)).is_err());
    transfer_byte(&mut socket, &mut peer, 4);
    transfer_byte(&mut duplicate, &mut peer, 5);
}
