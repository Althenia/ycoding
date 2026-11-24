use std::{
    fs::{self, OpenOptions},
    io::{self, ErrorKind, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

pub(super) const FILE: &str = "keep-awake-manual.json";

pub(super) fn read(path: &Path) -> io::Result<bool> {
    match fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| io::Error::new(ErrorKind::InvalidData, e))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub(super) fn write(path: &Path, enabled: bool) -> io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let (temporary, mut file) = loop {
        let temporary = path.with_file_name(format!(
            ".{FILE}.{}.{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        match options.open(&temporary) {
            Ok(file) => break (temporary, file),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    let written = file
        .write_all(if enabled { b"true\n" } else { b"false\n" })
        .and_then(|()| file.sync_all());
    drop(file);
    let result = written.and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
