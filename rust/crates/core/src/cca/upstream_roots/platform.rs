use super::RootError;
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Platform {
    MacOs,
    Windows,
    Unix,
}

pub(crate) struct CompiledOpenSslDefaults {
    pub(crate) file_env: String,
    pub(crate) directory_env: String,
    pub(crate) file: PathBuf,
    pub(crate) directory: PathBuf,
}

impl CompiledOpenSslDefaults {
    pub(crate) fn node_26_4_bundled_linux_build() -> Self {
        Self {
            file_env: "SSL_CERT_FILE".into(),
            directory_env: "SSL_CERT_DIR".into(),
            file: "/etc/ssl/cert.pem".into(),
            directory: "/etc/ssl/certs".into(),
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum SystemPlan {
    MacOs,
    Windows,
    OpenSsl { file: PathBuf, directory: PathBuf },
}

pub(crate) fn system_plan(
    platform: Platform,
    defaults: Option<&CompiledOpenSslDefaults>,
    captured_environment: &BTreeMap<String, String>,
) -> Result<SystemPlan, RootError> {
    match platform {
        Platform::MacOs => Ok(SystemPlan::MacOs),
        Platform::Windows => Ok(SystemPlan::Windows),
        Platform::Unix => {
            let defaults = defaults.ok_or(RootError::RequiredOpenSslDefaults)?;
            Ok(SystemPlan::OpenSsl {
                file: captured_environment
                    .get(&defaults.file_env)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| defaults.file.clone()),
                directory: captured_environment
                    .get(&defaults.directory_env)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| defaults.directory.clone()),
            })
        }
    }
}

pub(crate) trait OpenSslSystemSource {
    fn load_file(&mut self, file: &std::path::Path) -> Result<Vec<String>, RootError>;
    fn scan_regular_files(&mut self, directory: &std::path::Path) -> Vec<PathBuf>;
}

pub(crate) fn collect_openssl(
    file: &std::path::Path,
    directory: &std::path::Path,
    source: &mut impl OpenSslSystemSource,
) -> Result<Vec<String>, RootError> {
    let mut roots = Vec::new();
    if !file.as_os_str().is_empty() {
        roots.extend(source.load_file(file)?);
    }
    if !directory.as_os_str().is_empty() {
        for file in source.scan_regular_files(directory) {
            roots.extend(source.load_file(&file)?);
        }
    }
    Ok(roots)
}

#[cfg(unix)]
pub(crate) struct FileSystemOpenSslSource;

#[cfg(unix)]
impl OpenSslSystemSource for FileSystemOpenSslSource {
    fn load_file(&mut self, file: &std::path::Path) -> Result<Vec<String>, RootError> {
        let Ok(bytes) = std::fs::read(file) else {
            return Ok(Vec::new());
        };
        read_openssl_pem(&String::from_utf8_lossy(&bytes))
    }

    fn scan_regular_files(&mut self, directory: &std::path::Path) -> Vec<PathBuf> {
        use std::os::unix::ffi::OsStrExt;
        let Ok(entries) = std::fs::read_dir(directory) else {
            return Vec::new();
        };
        let Ok(mut entries) = entries.collect::<Result<Vec<_>, _>>() else {
            return Vec::new();
        };
        entries.sort_by(|left, right| {
            left.file_name()
                .as_bytes()
                .cmp(right.file_name().as_bytes())
        });
        entries
            .into_iter()
            .map(|entry| entry.path())
            .filter(|path| std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()))
            .collect()
    }
}

pub(super) fn read_openssl_pem(mut text: &str) -> Result<Vec<String>, RootError> {
    let mut certificates = Vec::new();
    while let Some(start) = text.find("-----BEGIN ") {
        text = &text[start..];
        let Some(label_end) = text[11..].find("-----") else {
            break;
        };
        let label = &text[11..11 + label_end];
        let end_marker = format!("-----END {label}-----");
        let Some(end) = text.find(&end_marker) else {
            break;
        };
        let block = &text[..end + end_marker.len()];
        text = &text[end + end_marker.len()..];
        if label != "CERTIFICATE" && label != "X509 CERTIFICATE" {
            continue;
        }
        let Ok((_, der)) = super::decode_pem_detect(block.as_bytes()) else {
            break;
        };
        let Some(pem) = super::certificate::decode_system_der(&der)? else {
            break;
        };
        certificates.push(pem);
    }
    Ok(certificates)
}

pub(crate) fn collect_current_system(plan: &SystemPlan) -> Result<Vec<String>, RootError> {
    match plan {
        #[cfg(target_os = "macos")]
        SystemPlan::MacOs => super::macos::collect_native(),
        #[cfg(windows)]
        SystemPlan::Windows => super::windows::collect(),
        #[cfg(unix)]
        SystemPlan::OpenSsl { file, directory } => {
            collect_openssl(file, directory, &mut FileSystemOpenSslSource)
        }
        _ => Err(RootError::RequiredSystemSource(
            "collection plan does not match this target".into(),
        )),
    }
}
