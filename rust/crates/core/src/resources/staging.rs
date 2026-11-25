use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub(crate) const IMPORTS: &str = ".imports";
pub(crate) const CATALOG: &str = ".catalog-writes";

pub(crate) struct Stage {
    pub path: PathBuf,
    pub file: fs::File,
}

impl Stage {
    pub fn create(parent: &Path, name: &str) -> io::Result<Self> {
        let directory = parent.join(name);
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&directory) {
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            other => other?,
        }
        let metadata = fs::symlink_metadata(&directory)?;
        if !metadata.is_dir()
            || fs::canonicalize(&directory)? != fs::canonicalize(parent)?.join(name)
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        #[cfg(unix)]
        if !unix::private(&metadata) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        loop {
            let path = directory.join(format!(
                "stage-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match options.open(&path) {
                Ok(file) => {
                    let stage = Self { path, file };
                    #[cfg(unix)]
                    stage.file.lock()?;
                    return Ok(stage);
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
    }
}

#[cfg(all(unix, test))]
#[test]
fn active_writers_survive_and_abandoned_entries_drain_across_bounded_passes() {
    use std::time::{Duration, SystemTime};
    let root = std::env::temp_dir().join(format!(
        "ycoding-stage-test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let stage = Stage::create(&root, CATALOG).unwrap();
    let now = SystemTime::now() + Duration::from_secs(8 * 86400);
    let mut paths = Vec::new();
    for _ in 0..70 {
        paths.push(Stage::create(&root, CATALOG).unwrap().path);
    }
    let mut sweep = Sweep::default();
    assert_eq!(sweep.run(&root, &root, now), 0);
    let count = paths.iter().filter(|p| p.exists()).count();
    assert!(count >= 6 && count < 70);
    assert_eq!(sweep.run(&root, &root, now), 0);
    assert!(paths.iter().all(|p| !p.exists()));
    assert!(stage.path.exists());
    drop(stage.file);
    assert_eq!(sweep.run(&root, &root, now), 0);
    assert!(!stage.path.exists());
    fs::remove_dir(root.join(CATALOG)).unwrap();
    fs::remove_dir(root).unwrap();
}

#[cfg(unix)]
pub use unix::Sweep;
#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        ffi::{CStr, CString},
        os::{
            fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
        ptr::NonNull,
        time::{Duration, SystemTime},
    };
    const FLAGS: i32 = libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
    const DIR: i32 = FLAGS | libc::O_DIRECTORY;
    const LIMIT: usize = 64;
    const AGE: Duration = Duration::from_secs(7 * 86400);
    pub(super) fn private(meta: &fs::Metadata) -> bool {
        meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0
    }
    fn same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
        (a.dev(), a.ino()) == (b.dev(), b.ino())
    }
    fn open_at(dir: RawFd, name: &CStr, flags: i32) -> io::Result<fs::File> {
        let fd = unsafe { libc::openat(dir, name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }
    fn directory(root: &Path, parts: &[&str]) -> io::Result<fs::File> {
        let mut dir = fs::OpenOptions::new()
            .read(true)
            .custom_flags(DIR)
            .open(root)?;
        let mut expected = fs::canonicalize(root)?;
        let mut path = root.to_path_buf();
        for part in parts {
            let parent = dir.metadata()?;
            if parent.uid() != unsafe { libc::geteuid() } || parent.mode() & 0o022 != 0 {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            dir = open_at(dir.as_raw_fd(), &CString::new(*part)?, DIR)?;
            path.push(part);
            expected.push(part);
        }
        if fs::canonicalize(&path)? != expected
            || !same(&dir.metadata()?, &fs::symlink_metadata(path)?)
            || !private(&dir.metadata()?)
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(dir)
    }
    struct Entries(NonNull<libc::DIR>);
    unsafe impl Send for Entries {}
    impl Drop for Entries {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0.as_ptr());
            }
        }
    }
    impl Entries {
        fn new(dir: fs::File) -> io::Result<Self> {
            let fd = dir.into_raw_fd();
            match NonNull::new(unsafe { libc::fdopendir(fd) }) {
                Some(dir) => Ok(Self(dir)),
                None => {
                    let err = io::Error::last_os_error();
                    drop(unsafe { fs::File::from_raw_fd(fd) });
                    Err(err)
                }
            }
        }
        fn next(&mut self) -> Option<&CStr> {
            let ptr = unsafe { libc::readdir(self.0.as_ptr()) };
            if ptr.is_null() {
                return None;
            }
            Some(unsafe { CStr::from_ptr((*ptr).d_name.as_ptr()) })
        }
        fn fd(&self) -> RawFd {
            unsafe { libc::dirfd(self.0.as_ptr()) }
        }
    }
    fn owned_name(name: &CStr) -> bool {
        let Some((pid, seq)) = name
            .to_str()
            .ok()
            .and_then(|n| n.strip_prefix("stage-"))
            .and_then(|n| n.split_once('-'))
        else {
            return false;
        };
        pid.parse::<u32>()
            .is_ok_and(|n| n != 0 && n.to_string() == pid)
            && seq.parse::<u64>().is_ok_and(|n| n.to_string() == seq)
    }
    fn eligible(meta: &fs::Metadata, cutoff: SystemTime) -> bool {
        meta.is_file()
            && meta.nlink() == 1
            && private(meta)
            && meta.modified().is_ok_and(|time| time < cutoff)
    }
    fn reap(
        root: &Path,
        parts: &[&str],
        dir: RawFd,
        name: &CStr,
        cutoff: SystemTime,
    ) -> io::Result<()> {
        let file = open_at(dir, name, FLAGS)?;
        if !eligible(&file.metadata()?, cutoff) {
            return Ok(());
        }
        match file.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => return Ok(()),
            Err(fs::TryLockError::Error(e)) => return Err(e),
        }
        let live = directory(root, parts)?;
        let current = open_at(live.as_raw_fd(), name, FLAGS)?;
        let meta = current.metadata()?;
        if !same(&meta, &file.metadata()?) || !eligible(&meta, cutoff) {
            return Ok(());
        }
        if unsafe { libc::unlinkat(live.as_raw_fd(), name.as_ptr(), 0) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[derive(Default)]
    pub struct Sweep {
        cache: Option<Entries>,
        imports: Option<Entries>,
        shard: u8,
    }
    fn batch(
        cursor: &mut Option<Entries>,
        root: &Path,
        parts: &[&str],
        cutoff: SystemTime,
        budget: &mut usize,
        errors: &mut usize,
    ) -> bool {
        if cursor.is_none() {
            match directory(root, parts).and_then(Entries::new) {
                Ok(entries) => *cursor = Some(entries),
                Err(e) => {
                    if e.kind() != io::ErrorKind::NotFound {
                        *errors += 1;
                    }
                    return true;
                }
            }
        }
        let entries = cursor.as_mut().unwrap();
        let fd = entries.fd();
        while *budget > 0 {
            let Some(name) = entries.next() else {
                *cursor = None;
                return true;
            };
            *budget -= 1;
            if owned_name(name) && reap(root, parts, fd, name, cutoff).is_err() {
                *errors += 1;
            }
        }
        false
    }
    impl Sweep {
        pub fn run(&mut self, cache: &Path, data: &Path, now: SystemTime) -> usize {
            let Some(cutoff) = now.checked_sub(AGE) else {
                return 0;
            };
            let mut errors = 0;
            let mut budget = LIMIT;
            batch(
                &mut self.cache,
                cache,
                &[CATALOG],
                cutoff,
                &mut budget,
                &mut errors,
            );
            let mut budget = LIMIT;
            for _ in 0..256 {
                let shard = format!("{:02x}", self.shard);
                if !batch(
                    &mut self.imports,
                    data,
                    &["attachments", "sha256", &shard, IMPORTS],
                    cutoff,
                    &mut budget,
                    &mut errors,
                ) {
                    break;
                }
                self.shard = self.shard.wrapping_add(1);
                if budget == 0 {
                    break;
                }
            }
            errors
        }
    }
}
