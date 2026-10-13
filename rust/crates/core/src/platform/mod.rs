pub mod browser;
pub mod computer;
pub mod diff;
pub mod filesystem;
pub mod git;
pub mod keep_awake;
pub mod patch;
pub mod process;
pub mod project_copy;
pub mod pty;
pub mod sandbox;
pub mod shell;
pub mod worktree;

pub(crate) fn random<const N: usize>() -> std::io::Result<[u8; N]> {
    let mut bytes = [0; N];
    #[cfg(unix)]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{
            BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
        };
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                N as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            return Err(std::io::Error::other(format!(
                "System entropy failed: {status}"
            )));
        }
    }
    Ok(bytes)
}

pub(crate) fn identifier(prefix: &str) -> std::io::Result<String> {
    static GENERATOR: std::sync::LazyLock<std::sync::Mutex<ycoding_schema::identifier::Generator>> =
        std::sync::LazyLock::new(|| {
            std::sync::Mutex::new(ycoding_schema::identifier::Generator::default())
        });
    let mut generator = GENERATOR
        .lock()
        .map_err(|_| std::io::Error::other("Identifier generator lock poisoned"))?;
    let generated = generator
        .ascending(now(), random()?)
        .map_err(std::io::Error::other)?;
    Ok(format!(
        "{prefix}{}",
        generated.to_utf8().map_err(std::io::Error::other)?
    ))
}

pub(crate) fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}
