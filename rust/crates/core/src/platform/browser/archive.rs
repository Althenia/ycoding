use super::bridge::Error;
use ring::rand::{SecureRandom, SystemRandom};
use std::{fs, io::Write, path::Path};
use ycoding_schema::{LosslessString, browser, schema::NonNegativeInt};

pub fn save(
    directory: Option<&Path>,
    title: &LosslessString,
    data: &LosslessString,
) -> Result<browser::SavedFile, Error> {
    let directory = directory
        .ok_or_else(|| Error::Unavailable("Browser export directory is not configured".into()))?;
    let data = data
        .to_utf8()
        .map_err(|_| Error::InvalidFrame("Chrome returned an invalid MHTML archive".into()))?;
    if data.len() > 8 * 1024 * 1024 {
        return Err(Error::InvalidFrame("Export exceeds the 8 MiB limit".into()));
    }
    let failure = || Error::Unavailable("Browser archive could not be saved privately".into());
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(failure());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(failure()),
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory).map_err(|_| failure())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|_| failure())?;
    }
    let title: String = title
        .to_utf8()
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(64)
        .collect();
    let mut random = [0; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| failure())?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let path = directory.join(format!(
        "{}-{suffix}.mhtml",
        if title.is_empty() { "page" } else { &title }
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&path).map_err(|_| failure())?;
    file.write_all(data.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| failure())?;
    Ok(browser::SavedFile {
        path: path.to_str().ok_or_else(failure)?.into(),
        bytes: NonNegativeInt::new(data.len() as i64)?,
    })
}
