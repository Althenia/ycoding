use rustls::RootCertStore;
use std::{collections::BTreeMap, sync::OnceLock};

mod bundled;
mod certificate;
pub(crate) mod macos;
pub(crate) mod platform;
pub(crate) mod windows;

#[cfg(test)]
mod tests;

pub(crate) const CCA_CUSTOM_CA_ENV_KEYS: [&str; 11] = [
    "CODEX_CA_CERTIFICATE",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "GIT_SSL_CAINFO",
    "CARGO_HTTP_CAINFO",
    "PIP_CERT",
    "BUNDLE_SSL_CA_CERT",
    "npm_config_cafile",
    "NPM_CONFIG_CAFILE",
];

const MAX_STARTUP_CA_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum RootError {
    #[error("required system certificate source unavailable: {0}")]
    RequiredSystemSource(String),
    #[error("the packaging reference's compiled OpenSSL defaults are required")]
    RequiredOpenSslDefaults,
    #[error("native certificate encoding requires an unsupported representation: {0}")]
    NativeCertificate(String),
    #[error("invalid X509 certificate: {0}")]
    InvalidCertificate(String),
    #[error("upstream certificate {index} PEM decode failed: {message}")]
    Pem { index: usize, message: String },
    #[error("upstream certificate {index} is not a CERTIFICATE PEM block")]
    PemLabel { index: usize },
    #[error("upstream certificate {index} trust-anchor extraction failed: {message}")]
    RootStore { index: usize, message: String },
}

pub(crate) struct UpstreamRoots {
    root_store: RootCertStore,
    ordered_pem: Vec<String>,
}

impl UpstreamRoots {
    #[cfg(test)]
    pub(crate) fn root_store(&self) -> &RootCertStore {
        &self.root_store
    }

    #[cfg(test)]
    pub(crate) fn ordered_pem(&self) -> &[String] {
        &self.ordered_pem
    }

    pub(crate) fn into_parts(self) -> (RootCertStore, Vec<String>) {
        (self.root_store, self.ordered_pem)
    }
}

pub(crate) struct StartupCaFile {
    pub(crate) is_file: bool,
    pub(crate) byte_length: u64,
    pub(crate) text: String,
}

pub(crate) fn read_startup_ca_file(path: &str) -> Option<StartupCaFile> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_STARTUP_CA_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(StartupCaFile {
        is_file: true,
        byte_length: metadata.len(),
        text: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

pub(crate) struct StartupCaSnapshot {
    values: Vec<(&'static str, String)>,
    certificates: OnceLock<Vec<String>>,
}

impl StartupCaSnapshot {
    pub(crate) fn capture(environment: &BTreeMap<String, String>) -> Self {
        Self {
            values: CCA_CUSTOM_CA_ENV_KEYS
                .into_iter()
                .filter_map(|key| {
                    environment
                        .get(key)
                        .filter(|value| !value.is_empty())
                        .map(|value| (key, value.clone()))
                })
                .collect(),
            certificates: OnceLock::new(),
        }
    }

    pub(crate) fn values(&self) -> &[(&'static str, String)] {
        &self.values
    }

    fn certificates(
        &self,
        read: impl Fn(&str) -> Option<StartupCaFile>,
        is_managed: impl Fn(&str) -> bool,
    ) -> &[String] {
        self.certificates.get_or_init(|| {
            let mut seen = std::collections::BTreeSet::new();
            let mut certificates = Vec::new();
            for (_, path) in &self.values {
                if is_managed(path) || !seen.insert(path) {
                    continue;
                }
                let Some(file) = read(path) else { continue };
                if file.is_file && file.byte_length <= MAX_STARTUP_CA_FILE_BYTES {
                    certificates.extend(pem_certificates(&file.text).map(str::to_owned));
                }
            }
            certificates
        })
    }
}

pub(crate) fn decode_pem_detect(pem: &[u8]) -> Result<(&str, Vec<u8>), pem_rfc7468::Error> {
    let mut decoder = pem_rfc7468::Decoder::new_detect_wrap(pem)?;
    let type_label = decoder.type_label();
    let mut buf = Vec::new();
    decoder.decode_to_end(&mut buf)?;
    Ok((type_label, buf))
}

pub(crate) struct RequiredRootProvider {
    system: OnceLock<Result<Vec<String>, RootError>>,
}

impl RequiredRootProvider {
    pub(crate) const fn new() -> Self {
        Self {
            system: OnceLock::new(),
        }
    }

    fn system_certificates(
        &self,
        collect: impl FnOnce() -> Result<Vec<String>, RootError>,
    ) -> Result<&[String], RootError> {
        self.system
            .get_or_init(collect)
            .as_ref()
            .map(Vec::as_slice)
            .map_err(Clone::clone)
    }

    pub(crate) fn load(
        &self,
        collect_system: impl FnOnce() -> Result<Vec<String>, RootError>,
        startup: &StartupCaSnapshot,
        read: impl Fn(&str) -> Option<StartupCaFile>,
        is_managed: impl Fn(&str) -> bool,
        generated_ca_pem: &str,
    ) -> Result<UpstreamRoots, RootError> {
        let system = self.system_certificates(collect_system)?;
        let startup = startup.certificates(read, is_managed);
        let ordered_pem = ordered_union(system, startup, generated_ca_pem);
        let mut root_store = RootCertStore::empty();
        for (index, pem) in ordered_pem.iter().enumerate() {
            let (label, der) =
                decode_pem_detect(pem.as_bytes()).map_err(|error| RootError::Pem {
                    index,
                    message: error.to_string(),
                })?;
            if label != "CERTIFICATE" {
                return Err(RootError::PemLabel { index });
            }
            let anchor = certificate::trust_anchor(&der).map_err(|error| RootError::RootStore {
                index,
                message: error.to_string(),
            })?;
            root_store.roots.push(anchor);
        }
        Ok(UpstreamRoots {
            root_store,
            ordered_pem,
        })
    }
}

fn normalize_pem(pem: &str) -> String {
    let pem = pem.trim_matches(|character: char| {
        matches!(
            character,
            '\t' | '\n' | '\u{000b}' | '\u{000c}' | '\r' | ' '
        ) || matches!(
            character,
            '\u{00a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    });
    format!("{}\n", pem.replace("\r\n", "\n"))
}

fn pem_certificates(mut text: &str) -> impl Iterator<Item = &str> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    std::iter::from_fn(move || {
        let start = text.find(BEGIN)?;
        let body = start + BEGIN.len();
        let first = text[body..].chars().next()?.len_utf8();
        let end = body + first + text[body + first..].find(END)? + END.len();
        let certificate = &text[start..end];
        text = &text[end..];
        Some(certificate)
    })
}

fn ordered_union(system: &[String], startup: &[String], generated_ca_pem: &str) -> Vec<String> {
    let generated_ca_pem = normalize_pem(generated_ca_pem);
    let mut seen = std::collections::BTreeSet::new();
    system
        .iter()
        .map(String::as_str)
        .chain(bundled::NODE_26_4_ROOTS)
        .chain(startup.iter().map(String::as_str))
        .map(normalize_pem)
        .filter(|pem| pem != &generated_ca_pem && seen.insert(pem.clone()))
        .collect()
}
