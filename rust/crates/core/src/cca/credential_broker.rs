use super::encoding::{base64_decode, base64_encode};
use crate::{
    platform::filesystem::collation,
    regexp::{Budget, RegExp},
};
use ring::rand::{SecureRandom, SystemRandom};
use std::{
    cmp::Ordering,
    net::{Ipv4Addr, Ipv6Addr},
    sync::{Arc, Mutex},
};
use url::Url;
use ycoding_schema::{JsonObject, JsonValue, LosslessString, stringify_json};

pub(crate) const CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY: &str =
    "CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE";
pub(crate) const CCA_BROKERED_CREDENTIALS_ENV_KEY: &str =
    "CODEX_NETWORK_PROXY_BROKERED_CREDENTIALS";
pub(crate) const CCA_CREDENTIAL_MASKING_PARTIAL_WARNING: &str = "Credential masking could not protect some environment credentials; continuing with those values unmasked.";
const MIN_EMBEDDED_CREDENTIAL_LENGTH: usize = 16;
const DUMMY_ALPHANUMERIC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const MAX_REGEX_BYTES: usize = 2048;
const MAX_REGEX_REPEAT: usize = 64;
const MAX_DUMMY_ATTEMPTS: usize = 64;
const MAX_DUMMY_VALUE_BYTES: usize = 2048;
const OPENAI_PREFIXES: &[&str] = &["sk-proj-", "sk-svcacct-", "sk-admin-", "sk-"];
const GITHUB_PREFIXES: &[&str] = &["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"];
const GITHUB_CLOUD_HOSTS: &[&str] = &["api.github.com", "github.com", "uploads.github.com"];
const GITHUB_CLOUD_SUFFIXES: &[&str] = &[".ghe.com"];
const BUILTIN_ENV_KEYS: &[&str] = &[
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
];

pub(crate) type Environment = Vec<(LosslessString, LosslessString)>;
pub(crate) type Header = (LosslessString, LosslessString);
pub(crate) type Providers = Vec<(LosslessString, CredentialProviderConfig)>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialAuthMethod {
    Bearer,
    Token,
    Basic,
    Header,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialProviderConfig {
    pub env: Vec<LosslessString>,
    pub patterns: Vec<LosslessString>,
    pub url_prefixes: Vec<LosslessString>,
    pub url_prefix_from_env: Option<LosslessString>,
    pub auth: Vec<CredentialAuthMethod>,
    pub header: Option<LosslessString>,
    pub prefix: Option<LosslessString>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct BrokeredProtocols {
    pub tls: bool,
    pub http: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CredentialBrokerKey {
    pub environment_id: Option<LosslessString>,
    pub conversation_id: Option<LosslessString>,
    pub providers: Providers,
}

pub(crate) struct MaskedEnvironment {
    pub env: Environment,
    pub unmasked_keys: Vec<LosslessString>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum CredentialBrokerError {
    #[error("{0}")]
    InvalidConfig(&'static str),
    #[error(transparent)]
    RegExp(#[from] crate::regexp::Error),
    #[error("system random source unavailable")]
    Random,
}

pub(crate) struct CredentialBrokerEntry {
    pub broker: CredentialBroker,
    pub ignored_providers: Vec<LosslessString>,
}

#[derive(Default)]
pub(crate) struct CredentialBrokerCache {
    entries: Vec<(CredentialBrokerKey, Arc<CredentialBrokerEntry>)>,
}

impl CredentialBrokerCache {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn broker_for(
        &mut self,
        key: &CredentialBrokerKey,
    ) -> Result<Arc<CredentialBrokerEntry>, CredentialBrokerError> {
        let mut key = key.clone();
        let mut providers: Providers = Vec::new();
        for (id, config) in key.providers {
            if let Some((_, existing)) = providers.iter_mut().find(|(name, _)| name == &id) {
                *existing = config;
            } else {
                providers.push((id, config));
            }
        }
        providers.sort_by(|(left, _), (right, _)| locale_compare(left, right));
        key.providers = providers;
        if let Some((_, entry)) = self.entries.iter().find(|(existing, _)| existing == &key) {
            return Ok(entry.clone());
        }
        let mut configured: Vec<Provider> = Vec::new();
        let mut ignored_providers = Vec::new();
        for (id, config) in &key.providers {
            match Provider::configured(id, config) {
                Ok(provider)
                    if !configured.iter().any(|existing| {
                        existing
                            .env_vars
                            .iter()
                            .any(|env| provider.env_vars.contains(env))
                    }) =>
                {
                    configured.push(provider)
                }
                _ => ignored_providers.push(id.clone()),
            }
        }
        let mut providers = vec![
            Provider::builtin(Builtin::Github, &["GH_TOKEN", "GITHUB_TOKEN"]),
            Provider::builtin(
                Builtin::GithubEnterprise,
                &["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
            ),
            Provider::builtin(Builtin::Openai, &["OPENAI_API_KEY"]),
        ];
        providers.extend(configured);
        let shaped = OPENAI_PREFIXES
            .iter()
            .map(|prefix| {
                format!(
                    "{}[A-Za-z0-9_-]{{{},}}",
                    prefix.replace('-', "\\-"),
                    51 - prefix.len()
                )
            })
            .chain(
                GITHUB_PREFIXES
                    .iter()
                    .map(|prefix| format!("{prefix}[A-Za-z0-9_]{{{},}}", 40 - prefix.len())),
            )
            .collect::<Vec<_>>()
            .join("|");
        let entry = Arc::new(CredentialBrokerEntry {
            broker: CredentialBroker {
                providers,
                records: Mutex::new(Vec::new()),
                shaped: RegExp::new(&shaped.encode_utf16().collect::<Vec<_>>(), "g")?,
            },
            ignored_providers,
        });
        self.entries.push((key, entry.clone()));
        Ok(entry)
    }
}

fn units(text: &LosslessString) -> Vec<u16> {
    text.code_units().collect()
}

fn concat(parts: &[&LosslessString]) -> LosslessString {
    LosslessString::from_utf16(parts.iter().flat_map(|part| part.code_units()).collect())
}

fn includes(text: &LosslessString, needle: &LosslessString) -> bool {
    let needle = units(needle);
    needle.is_empty() || units(text).windows(needle.len()).any(|part| part == needle)
}

fn ascii_lower(text: &LosslessString) -> LosslessString {
    LosslessString::from_utf16(
        text.code_units()
            .map(|unit| {
                if (65..=90).contains(&unit) {
                    unit + 32
                } else {
                    unit
                }
            })
            .collect(),
    )
}

fn js_whitespace(unit: u16) -> bool {
    matches!(unit, 9..=13 | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn trim(text: &LosslessString) -> LosslessString {
    let text = units(text);
    let start = text
        .iter()
        .position(|unit| !js_whitespace(*unit))
        .unwrap_or(text.len());
    let end = text
        .iter()
        .rposition(|unit| !js_whitespace(*unit))
        .map_or(start, |index| index + 1);
    LosslessString::from_utf16(text[start..end].to_vec())
}

fn utf8(text: &LosslessString) -> String {
    String::from_utf16_lossy(&units(text))
}

fn locale_compare(left: &LosslessString, right: &LosslessString) -> Ordering {
    collation::compare(&units(left), &units(right))
}

fn object_pairs(input: &[(LosslessString, LosslessString)]) -> Environment {
    let mut object = JsonObject::new();
    for (key, value) in input {
        object.insert(key.clone(), JsonValue::String(value.clone()));
    }
    object
        .iter()
        .map(|(key, value)| {
            let JsonValue::String(value) = value else {
                unreachable!()
            };
            (key.clone(), value.clone())
        })
        .collect()
}

fn get<'a>(
    input: &'a [(LosslessString, LosslessString)],
    key: &LosslessString,
) -> Option<&'a LosslessString> {
    input
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

fn set(input: &mut Environment, key: LosslessString, value: LosslessString) {
    if let Some((_, existing)) = input.iter_mut().find(|(name, _)| name == &key) {
        *existing = value;
    } else {
        input.push((key, value));
    }
}

fn random_int(upper: usize) -> Result<usize, CredentialBrokerError> {
    let upper = upper as u64;
    let limit = (1u64 << 32) / upper * upper;
    loop {
        let mut bytes = [0u8; 4];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| CredentialBrokerError::Random)?;
        let value = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as u64;
        if value < limit {
            return Ok((value % upper) as usize);
        }
    }
}

fn shaped_dummy(
    real: &LosslessString,
    prefix: &str,
    minimum: usize,
) -> Result<LosslessString, CredentialBrokerError> {
    let marker = format!("{prefix}masked");
    let target = real.len().max(minimum).max(marker.len() + 22);
    let mut output = marker.encode_utf16().collect::<Vec<_>>();
    while output.len() < target {
        output.push(DUMMY_ALPHANUMERIC[random_int(DUMMY_ALPHANUMERIC.len())?] as u16);
    }
    Ok(LosslessString::from_utf16(output))
}

fn header_valid(value: &LosslessString) -> bool {
    value
        .code_units()
        .all(|unit| unit == 9 || (0x20..=0x7e).contains(&unit))
}

fn get_header<'a>(headers: &'a [Header], name: &LosslessString) -> Option<&'a LosslessString> {
    let name = ascii_lower(name);
    headers
        .iter()
        .find(|(key, _)| ascii_lower(key) == name)
        .map(|(_, value)| value)
}

fn translate_standard_authorization(
    headers: &[Header],
    expected: &LosslessString,
    replacement: &LosslessString,
) -> Option<LosslessString> {
    let header = units(get_header(headers, &"authorization".into())?);
    let space = header.iter().position(|unit| *unit == 32)?;
    let scheme = LosslessString::from_utf16(header[..space].to_vec());
    let value = trim(&LosslessString::from_utf16(header[space + 1..].to_vec()));
    let lower = ascii_lower(&scheme);
    if lower == "basic".into() {
        let value = value.as_str()?;
        let unpadded = value.trim_end_matches('=');
        let mut padded = unpadded.to_owned();
        while !padded.len().is_multiple_of(4) {
            padded.push('=');
        }
        let decoded = base64_decode(&padded)?;
        if base64_encode(&decoded) != padded {
            return None;
        }
        let expected = utf8(expected).into_bytes();
        let replacement = utf8(replacement).into_bytes();
        let translated = if decoded == expected {
            replacement
        } else {
            let separator = decoded.iter().position(|byte| *byte == b':')?;
            let user = &decoded[..separator];
            let password = &decoded[separator + 1..];
            if user != expected && password != expected {
                return None;
            }
            let mut output = if user == expected {
                replacement.clone()
            } else {
                user.to_vec()
            };
            output.push(b':');
            output.extend(if password == expected {
                replacement
            } else {
                password.to_vec()
            });
            output
        };
        return Some(concat(&[
            &scheme,
            &" ".into(),
            &base64_encode(&translated).into(),
        ]));
    }
    if (lower == "bearer".into() || lower == "token".into()) && value == *expected {
        return Some(concat(&[&scheme, &" ".into(), replacement]));
    }
    None
}

fn normalize_host(host: &LosslessString) -> LosslessString {
    let trimmed = units(&trim(host));
    let host = if trimmed.first() == Some(&91) {
        match trimmed
            .iter()
            .position(|unit| *unit == 93)
            .filter(|index| *index > 0)
        {
            Some(end) => &trimmed[1..end],
            None => &trimmed,
        }
    } else {
        &trimmed
    };
    let mut host = units(&ascii_lower(&LosslessString::from_utf16(host.to_vec())));
    while host.last() == Some(&46) {
        host.pop();
    }
    LosslessString::from_utf16(host)
}

fn is_loopback(host: &LosslessString) -> bool {
    host == &"localhost".into()
        || host == &"::1".into()
        || host
            .as_str()
            .and_then(|host| host.parse::<Ipv4Addr>().ok())
            .is_some_and(|ip| ip.octets()[0] == 127)
}

fn trusted_base_url_host(value: Option<&LosslessString>) -> Option<LosslessString> {
    let value = value.filter(|value| !value.is_empty())?;
    let url = Url::parse(&utf8(value)).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some_and(|password| !password.is_empty())
    {
        return None;
    }
    Some(normalize_host(&url.host_str()?.into()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Destination {
    scheme: &'static str,
    host: LosslessString,
    wildcard: bool,
    port: u16,
    path_prefix: String,
}

fn parse_destination(input: &LosslessString) -> Result<Destination, CredentialBrokerError> {
    let value = utf8(&trim(input));
    let (explicit, authority) = match value.find("://") {
        Some(separator) => (
            Some(value[..separator].to_ascii_lowercase()),
            &value[separator + 3..],
        ),
        None => (None, value.as_str()),
    };
    let wildcard = authority.starts_with("*.");
    let authority = if wildcard {
        format!("wildcard.{}", &authority[2..])
    } else {
        authority.to_owned()
    };
    let error = || CredentialBrokerError::InvalidConfig("invalid credential destination");
    let url = Url::parse(&format!("https://{authority}")).map_err(|_| error())?;
    if !url.username().is_empty()
        || url.password().is_some_and(|password| !password.is_empty())
        || url.query().is_some()
        || url.fragment().is_some()
        || authority.contains(['?', '#'])
    {
        return Err(error());
    }
    let host = url.host_str().ok_or_else(error)?;
    let host = if wildcard {
        host.strip_prefix("wildcard.").ok_or_else(error)?
    } else {
        host
    };
    let host = normalize_host(&host.into());
    if host.is_empty() || includes(&host, &"*".into()) || includes(&host, &"/".into()) {
        return Err(error());
    }
    let loopback = !wildcard && is_loopback(&host);
    let scheme = match explicit.as_deref() {
        None => {
            if loopback {
                "http"
            } else {
                "https"
            }
        }
        Some("https") => "https",
        Some("http") if loopback => "http",
        _ => {
            return Err(CredentialBrokerError::InvalidConfig(
                "credential destination must use HTTPS unless it targets loopback over HTTP",
            ));
        }
    };
    let parsed = if scheme == "http" {
        Url::parse(&format!("http://{authority}")).map_err(|_| error())?
    } else {
        url
    };
    Ok(Destination {
        scheme,
        host,
        wildcard,
        port: parsed
            .port()
            .unwrap_or(if scheme == "https" { 443 } else { 80 }),
        path_prefix: parsed.path().to_owned(),
    })
}

fn destination_matches_host(destination: &Destination, host: &LosslessString, port: u16) -> bool {
    if destination.port != port {
        return false;
    }
    if !destination.wildcard {
        return destination.host == *host;
    }
    let host = units(host);
    let suffix = units(&destination.host);
    host.ends_with(&suffix)
        && host.len() > suffix.len()
        && host[host.len() - suffix.len() - 1] == 46
}

fn safe_authorization_path(raw_path: &LosslessString) -> bool {
    let path = units(raw_path);
    !path.contains(&92)
        && !path
            .split(|unit| *unit == 47)
            .any(|segment| segment == [46] || segment == [46, 46])
        && !units(&ascii_lower(raw_path))
            .windows(3)
            .any(|part| part == [37, 50, 101] || part == [37, 50, 102] || part == [37, 53, 99])
}

fn destination_matches_request(
    destination: &Destination,
    host: &LosslessString,
    url: &Url,
    raw_path: &LosslessString,
) -> bool {
    if url.scheme() != destination.scheme {
        return false;
    }
    let port = url.port().unwrap_or(if destination.scheme == "https" {
        443
    } else {
        80
    });
    if !destination_matches_host(destination, host, port) || !safe_authorization_path(raw_path) {
        return false;
    }
    let path = url.path();
    let prefix = &destination.path_prefix;
    prefix == "/"
        || path == prefix
        || path
            .strip_prefix(prefix.as_str())
            .is_some_and(|suffix| prefix.ends_with('/') || suffix.starts_with('/'))
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Binding {
    Hosts {
        hosts: Vec<LosslessString>,
        suffixes: Vec<LosslessString>,
    },
    Configured(Vec<Destination>),
}

impl Binding {
    fn matches_host(&self, host: &LosslessString) -> bool {
        match self {
            Self::Hosts { hosts, suffixes } => {
                hosts.contains(host)
                    || suffixes
                        .iter()
                        .any(|suffix| units(host).ends_with(&units(suffix)))
            }
            Self::Configured(_) => false,
        }
    }

    fn protocols(&self, host: &LosslessString, port: u16) -> BrokeredProtocols {
        match self {
            Self::Hosts { .. } => BrokeredProtocols {
                tls: self.matches_host(host),
                http: false,
            },
            Self::Configured(destinations) => BrokeredProtocols {
                tls: destinations.iter().any(|destination| {
                    destination.scheme == "https"
                        && destination_matches_host(destination, host, port)
                }),
                http: destinations.iter().any(|destination| {
                    destination.scheme == "http"
                        && destination_matches_host(destination, host, port)
                }),
            },
        }
    }

    fn matches_request(&self, host: &LosslessString, url: &Url, raw_path: &LosslessString) -> bool {
        match self {
            Self::Hosts { .. } => url.scheme() == "https" && self.matches_host(host),
            Self::Configured(destinations) => destinations
                .iter()
                .any(|destination| destination_matches_request(destination, host, url, raw_path)),
        }
    }
}

#[derive(Clone, Copy)]
enum Builtin {
    Github,
    GithubEnterprise,
    Openai,
}

struct Configured {
    config: CredentialProviderConfig,
    static_destinations: Vec<Destination>,
    patterns: Vec<CredentialPattern>,
    methods: Vec<CredentialAuthMethod>,
}

enum ProviderKind {
    Builtin(Builtin),
    Configured(Box<Configured>),
}

struct Provider {
    env_vars: Vec<LosslessString>,
    kind: ProviderKind,
}

fn valid_environment_key(key: &LosslessString) -> bool {
    let mut units = key.code_units();
    let first = |unit| matches!(unit, 65..=90 | 97..=122 | 95);
    units.next().is_some_and(first) && units.all(|unit| first(unit) || (48..=57).contains(&unit))
}

fn valid_header_name(name: &LosslessString) -> bool {
    !name.is_empty()
        && name.code_units().all(|unit| {
            matches!(unit, 48..=57 | 65..=90 | 97..=122)
                || b"!#$%&'*+.^_`|~-"
                    .iter()
                    .any(|byte| u16::from(*byte) == unit)
        })
}

fn github_cloud_host(host: &LosslessString) -> bool {
    GITHUB_CLOUD_HOSTS
        .iter()
        .any(|name| host == &LosslessString::from(*name))
        || GITHUB_CLOUD_SUFFIXES
            .iter()
            .any(|suffix| units(host).ends_with(&suffix.encode_utf16().collect::<Vec<_>>()))
}

fn github_host_hint(env: &Environment) -> Option<LosslessString> {
    let value = trim(get(env, &"GH_HOST".into())?);
    if value.is_empty()
        || value
            .code_units()
            .any(|unit| matches!(unit, 47 | 92 | 64 | 63 | 35 | 42))
    {
        return None;
    }
    let value = utf8(&value);
    let value = if value.parse::<Ipv6Addr>().is_ok() {
        format!("[{value}]")
    } else {
        value
    };
    let url = Url::parse(&format!("https://{value}")).ok()?;
    Some(normalize_host(&url.host_str()?.into()))
}

impl Provider {
    fn builtin(kind: Builtin, env: &[&str]) -> Self {
        Self {
            env_vars: env.iter().map(|name| (*name).into()).collect(),
            kind: ProviderKind::Builtin(kind),
        }
    }

    fn configured(
        id: &LosslessString,
        config: &CredentialProviderConfig,
    ) -> Result<Self, CredentialBrokerError> {
        let invalid = |message| CredentialBrokerError::InvalidConfig(message);
        if id.is_empty() {
            return Err(invalid("credential provider name must not be empty"));
        }
        if config.env.is_empty() {
            return Err(invalid("credential provider has no environment keys"));
        }
        if config.patterns.is_empty() {
            return Err(invalid("credential provider has no credential patterns"));
        }
        if config.url_prefixes.is_empty() && config.url_prefix_from_env.is_none() {
            return Err(invalid(
                "credential provider has no destination URL prefixes",
            ));
        }
        if !config.env.iter().all(valid_environment_key) {
            return Err(invalid(
                "credential provider has an invalid environment key",
            ));
        }
        if config.env.iter().any(|key| {
            BUILTIN_ENV_KEYS
                .iter()
                .any(|builtin| key == &LosslessString::from(*builtin))
        }) {
            return Err(invalid(
                "credential provider overlaps a built-in credential source",
            ));
        }
        if config
            .url_prefix_from_env
            .as_ref()
            .is_some_and(|key| !valid_environment_key(key) || config.env.contains(key))
        {
            return Err(invalid(
                "credential provider has an invalid host environment key",
            ));
        }
        let static_destinations = config
            .url_prefixes
            .iter()
            .map(parse_destination)
            .collect::<Result<Vec<_>, _>>()?;
        let methods = if config.auth.is_empty() {
            vec![CredentialAuthMethod::Bearer]
        } else {
            config.auth.clone()
        };
        if config
            .header
            .as_ref()
            .is_some_and(|header| !valid_header_name(header))
        {
            return Err(invalid("invalid header for credential provider"));
        }
        if methods.contains(&CredentialAuthMethod::Header) != config.header.is_some() {
            return Err(invalid(
                "credential provider requires a header name exactly when using header authentication",
            ));
        }
        if config.prefix.is_some() && config.header.is_none() {
            return Err(invalid(
                "credential provider requires header authentication to use a header prefix",
            ));
        }
        let patterns = config
            .patterns
            .iter()
            .map(CredentialPattern::compile)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            env_vars: config.env.clone(),
            kind: ProviderKind::Configured(Box::new(Configured {
                config: config.clone(),
                static_destinations,
                patterns,
                methods,
            })),
        })
    }

    fn binding(&self, env: &Environment) -> Option<Binding> {
        match &self.kind {
            ProviderKind::Builtin(Builtin::Github) => Some(Binding::Hosts {
                hosts: GITHUB_CLOUD_HOSTS
                    .iter()
                    .map(|host| (*host).into())
                    .collect(),
                suffixes: GITHUB_CLOUD_SUFFIXES
                    .iter()
                    .map(|suffix| (*suffix).into())
                    .collect(),
            }),
            ProviderKind::Builtin(Builtin::GithubEnterprise) => {
                let host = github_host_hint(env).filter(|host| !github_cloud_host(host))?;
                Some(Binding::Hosts {
                    hosts: vec![host],
                    suffixes: Vec::new(),
                })
            }
            ProviderKind::Builtin(Builtin::Openai) => {
                let mut hosts = vec!["api.openai.com".into()];
                if let Some(host) = trusted_base_url_host(get(env, &"OPENAI_BASE_URL".into()))
                    && !hosts.contains(&host)
                {
                    hosts.push(host);
                }
                Some(Binding::Hosts {
                    hosts,
                    suffixes: Vec::new(),
                })
            }
            ProviderKind::Configured(provider) => {
                let mut destinations = provider.static_destinations.clone();
                if let Some(value) = provider
                    .config
                    .url_prefix_from_env
                    .as_ref()
                    .and_then(|key| get(env, key))
                    && let Ok(destination) = parse_destination(value)
                    && !destination.wildcard
                    && !destinations.contains(&destination)
                {
                    destinations.push(destination);
                }
                (!destinations.is_empty()).then_some(Binding::Configured(destinations))
            }
        }
    }

    fn accepts(&self, value: &LosslessString) -> Result<bool, CredentialBrokerError> {
        match &self.kind {
            ProviderKind::Builtin(_) => Ok(header_valid(&concat(&[&"Bearer ".into(), value]))),
            ProviderKind::Configured(provider) => {
                for pattern in &provider.patterns {
                    if pattern.matches(value)? {
                        return Ok(provider
                            .methods
                            .iter()
                            .any(|method| provider.header_value(*method, value).is_some()));
                    }
                }
                Ok(false)
            }
        }
    }

    fn dummy(
        &self,
        real: &LosslessString,
    ) -> Result<Option<LosslessString>, CredentialBrokerError> {
        match &self.kind {
            ProviderKind::Builtin(kind) => {
                let (prefixes, fallback, minimum) = match kind {
                    Builtin::Openai => (OPENAI_PREFIXES, "sk-", 51),
                    _ => (GITHUB_PREFIXES, "ghp_", 40),
                };
                let real_units = units(real);
                let prefix = prefixes
                    .iter()
                    .find(|prefix| {
                        real_units.starts_with(&prefix.encode_utf16().collect::<Vec<_>>())
                    })
                    .copied()
                    .unwrap_or(fallback);
                Ok(Some(shaped_dummy(real, prefix, minimum)?))
            }
            ProviderKind::Configured(provider) => {
                for pattern in &provider.patterns {
                    if !pattern.matches(real)? {
                        continue;
                    }
                    for _ in 0..MAX_DUMMY_ATTEMPTS {
                        let candidate = pattern.generator.generate()?;
                        if pattern.valid_candidate(&candidate)?
                            && candidate != *real
                            && provider.usable(real, &candidate)
                        {
                            return Ok(Some(candidate));
                        }
                    }
                    return Ok(None);
                }
                Ok(None)
            }
        }
    }

    fn translate(
        &self,
        headers: &[Header],
        expected: &LosslessString,
        replacement: &LosslessString,
    ) -> Vec<Header> {
        match &self.kind {
            ProviderKind::Builtin(Builtin::Openai) => {
                let value = concat(&[&"Bearer ".into(), replacement]);
                if get_header(headers, &"authorization".into())
                    .is_some_and(|header| includes(header, expected))
                    && header_valid(&value)
                {
                    vec![("authorization".into(), value)]
                } else {
                    Vec::new()
                }
            }
            ProviderKind::Builtin(_) => {
                translate_standard_authorization(headers, expected, replacement)
                    .map(|value| vec![("authorization".into(), value)])
                    .unwrap_or_default()
            }
            ProviderKind::Configured(provider) => {
                provider.translate(headers, expected, replacement)
            }
        }
    }
}

impl Configured {
    fn header_value(
        &self,
        method: CredentialAuthMethod,
        value: &LosslessString,
    ) -> Option<LosslessString> {
        let rendered = match method {
            CredentialAuthMethod::Bearer => concat(&[&"Bearer ".into(), value]),
            CredentialAuthMethod::Token => concat(&[&"token ".into(), value]),
            CredentialAuthMethod::Basic => {
                format!("Basic {}", base64_encode(utf8(value).as_bytes())).into()
            }
            CredentialAuthMethod::Header => {
                concat(&[&self.config.prefix.clone().unwrap_or_default(), value])
            }
        };
        header_valid(&rendered).then_some(rendered)
    }

    fn translate(
        &self,
        headers: &[Header],
        expected: &LosslessString,
        replacement: &LosslessString,
    ) -> Vec<Header> {
        let mut translated: Vec<Header> = Vec::new();
        for method in &self.methods {
            if *method == CredentialAuthMethod::Header {
                if let Some(header) = &self.config.header {
                    let name = ascii_lower(header);
                    let prefix = self.config.prefix.clone().unwrap_or_default();
                    if get_header(headers, header) == Some(&concat(&[&prefix, expected]))
                        && !translated.iter().any(|(key, _)| key == &name)
                    {
                        let replaced = concat(&[&prefix, replacement]);
                        if header_valid(&replaced) {
                            translated.push((name, replaced));
                        }
                    }
                }
                continue;
            }
            let Some(authorization) = get_header(headers, &"authorization".into()) else {
                continue;
            };
            let authorization = units(authorization);
            let end = authorization
                .iter()
                .position(|unit| *unit == 32)
                .unwrap_or(authorization.len());
            let scheme = ascii_lower(&LosslessString::from_utf16(authorization[..end].to_vec()));
            let expected_scheme = match method {
                CredentialAuthMethod::Bearer => "bearer",
                CredentialAuthMethod::Token => "token",
                CredentialAuthMethod::Basic => "basic",
                CredentialAuthMethod::Header => unreachable!(),
            };
            if scheme != expected_scheme.into()
                || translated
                    .iter()
                    .any(|(name, _)| name == &LosslessString::from("authorization"))
            {
                continue;
            }
            if let Some(value) = translate_standard_authorization(headers, expected, replacement) {
                translated.push(("authorization".into(), value));
            }
        }
        translated
    }

    fn usable(&self, real: &LosslessString, dummy: &LosslessString) -> bool {
        self.methods.iter().all(|method| {
            if *method == CredentialAuthMethod::Basic
                && includes(real, &":".into()) != includes(dummy, &":".into())
            {
                return false;
            }
            let Some(real_header) = self.header_value(*method, real) else {
                return true;
            };
            let Some(dummy_header) = self.header_value(*method, dummy) else {
                return false;
            };
            if trim(&dummy_header) != dummy_header {
                return false;
            }
            let name = if *method == CredentialAuthMethod::Header {
                ascii_lower(
                    self.config
                        .header
                        .as_ref()
                        .expect("validated header authentication"),
                )
            } else {
                "authorization".into()
            };
            self.translate(&[(name.clone(), dummy_header)], dummy, real)
                .iter()
                .any(|(key, value)| key == &name && value == &real_header)
        })
    }
}

enum RegexNode {
    Literal(u16),
    Class(Vec<u16>),
    Sequence(Vec<RegexNode>),
    Alternation(Vec<RegexNode>),
    Repeat {
        node: Box<RegexNode>,
        min: usize,
        max: usize,
    },
}

impl RegexNode {
    fn generate(&self) -> Result<LosslessString, CredentialBrokerError> {
        let output = match self {
            Self::Literal(unit) => vec![*unit],
            Self::Class(chars) => vec![chars[random_int(chars.len())?]],
            Self::Sequence(items) => {
                let mut output = Vec::new();
                for item in items {
                    output.extend(units(&item.generate()?));
                }
                output
            }
            Self::Alternation(options) => units(&options[random_int(options.len())?].generate()?),
            Self::Repeat { node, min, max } => {
                let mut output = Vec::new();
                for _ in 0..*min + random_int(max - min + 1)? {
                    output.extend(units(&node.generate()?));
                }
                output
            }
        };
        Ok(LosslessString::from_utf16(output))
    }
}

struct RegexParser {
    pattern: Vec<u16>,
    position: usize,
}

fn unsupported_pattern() -> CredentialBrokerError {
    CredentialBrokerError::InvalidConfig("unsupported credential pattern syntax")
}

fn escape_set(unit: u16) -> Result<Option<Vec<u16>>, CredentialBrokerError> {
    match unit {
        100 => Ok(Some((48..=57).collect())),
        119 => Ok(Some(
            (32..=126)
                .filter(|unit| matches!(*unit, 48..=57 | 65..=90 | 97..=122 | 95))
                .collect(),
        )),
        68 | 87 | 115 | 83 | 98 | 66 | 112 | 80 | 107 | 117 | 120 | 99 | 48..=57 => {
            Err(unsupported_pattern())
        }
        _ => Ok(None),
    }
}

impl RegexParser {
    fn peek(&self) -> Option<u16> {
        self.pattern.get(self.position).copied()
    }

    fn take(&mut self) -> Result<u16, CredentialBrokerError> {
        let unit = self.peek().ok_or_else(unsupported_pattern)?;
        self.position += 1;
        Ok(unit)
    }

    fn parse(pattern: &LosslessString) -> Result<RegexNode, CredentialBrokerError> {
        let mut parser = Self {
            pattern: units(pattern),
            position: 0,
        };
        let node = parser.alternation()?;
        if parser.position != parser.pattern.len() {
            return Err(unsupported_pattern());
        }
        Ok(node)
    }

    fn class(&mut self) -> Result<RegexNode, CredentialBrokerError> {
        self.position += 1;
        let negated = self.peek() == Some(94);
        if negated {
            self.position += 1;
        }
        let mut members = Vec::new();
        let mut first = true;
        while self.position < self.pattern.len() && (self.peek() != Some(93) || first) {
            first = false;
            let mut character = self.take()?;
            if character == 91 {
                return Err(unsupported_pattern());
            }
            if character == 92 {
                let escaped = self.take()?;
                if let Some(set) = escape_set(escaped)? {
                    for unit in set {
                        if !members.contains(&unit) {
                            members.push(unit);
                        }
                    }
                    continue;
                }
                character = escaped;
            }
            if self.peek() == Some(45)
                && self
                    .pattern
                    .get(self.position + 1)
                    .is_some_and(|unit| *unit != 93)
            {
                self.position += 1;
                let mut end = self.take()?;
                if end == 92 {
                    end = self.take()?;
                }
                if end < character {
                    return Err(unsupported_pattern());
                }
                for unit in character..=end {
                    if !members.contains(&unit) {
                        members.push(unit);
                    }
                }
            } else if !members.contains(&character) {
                members.push(character);
            }
        }
        if self.take()? != 93 {
            return Err(unsupported_pattern());
        }
        let chars = if negated {
            (32..=126).filter(|unit| !members.contains(unit)).collect()
        } else {
            members
        };
        if chars.is_empty() {
            return Err(unsupported_pattern());
        }
        Ok(RegexNode::Class(chars))
    }

    fn atom(&mut self) -> Result<RegexNode, CredentialBrokerError> {
        match self.peek().ok_or_else(unsupported_pattern)? {
            40 => {
                self.position += 1;
                if self.pattern[self.position..].starts_with(&[63, 58]) {
                    self.position += 2;
                } else if self.peek() == Some(63) {
                    return Err(unsupported_pattern());
                }
                let inner = self.alternation()?;
                if self.take()? != 41 {
                    return Err(unsupported_pattern());
                }
                Ok(inner)
            }
            91 => self.class(),
            46 => {
                self.position += 1;
                Ok(RegexNode::Class((32..=126).collect()))
            }
            92 => {
                self.position += 1;
                let escaped = self.take()?;
                Ok(match escape_set(escaped)? {
                    Some(set) => RegexNode::Class(set),
                    None => RegexNode::Literal(escaped),
                })
            }
            42 | 43 | 63 | 123 | 41 | 124 => Err(unsupported_pattern()),
            _ => Ok(RegexNode::Literal(self.take()?)),
        }
    }

    fn number(&mut self) -> Option<usize> {
        let start = self.position;
        let mut number = 0usize;
        while let Some(unit @ 48..=57) = self.peek() {
            number = number
                .saturating_mul(10)
                .saturating_add((unit - 48) as usize);
            self.position += 1;
        }
        (self.position != start).then_some(number)
    }

    fn repeat(&mut self, node: RegexNode) -> Result<RegexNode, CredentialBrokerError> {
        let (min, max) = match self.peek() {
            Some(42) => {
                self.position += 1;
                (0, MAX_REGEX_REPEAT)
            }
            Some(43) => {
                self.position += 1;
                (1, MAX_REGEX_REPEAT)
            }
            Some(63) => {
                self.position += 1;
                (0, 1)
            }
            Some(123) => {
                self.position += 1;
                let min = self.number().ok_or_else(unsupported_pattern)?;
                let max = if self.peek() == Some(44) {
                    self.position += 1;
                    self.number().unwrap_or(min.max(MAX_REGEX_REPEAT))
                } else {
                    min
                };
                if self.take()? != 125 || max < min || min > MAX_REGEX_REPEAT {
                    return Err(unsupported_pattern());
                }
                (min, max.min(MAX_REGEX_REPEAT))
            }
            _ => return Ok(node),
        };
        if matches!(self.peek(), Some(63 | 43)) {
            return Err(unsupported_pattern());
        }
        Ok(RegexNode::Repeat {
            node: Box::new(node),
            min,
            max,
        })
    }

    fn sequence(&mut self) -> Result<RegexNode, CredentialBrokerError> {
        let mut items = Vec::new();
        while self.position < self.pattern.len() && !matches!(self.peek(), Some(124 | 41)) {
            if (self.peek() == Some(94) && self.position == 0)
                || (self.peek() == Some(36) && self.position == self.pattern.len() - 1)
            {
                self.position += 1;
                continue;
            }
            if matches!(self.peek(), Some(94 | 36)) {
                return Err(unsupported_pattern());
            }
            let atom = self.atom()?;
            items.push(self.repeat(atom)?);
        }
        Ok(RegexNode::Sequence(items))
    }

    fn alternation(&mut self) -> Result<RegexNode, CredentialBrokerError> {
        let mut options = vec![self.sequence()?];
        while self.peek() == Some(124) {
            self.position += 1;
            options.push(self.sequence()?);
        }
        Ok(if options.len() == 1 {
            options.pop().expect("one sequence")
        } else {
            RegexNode::Alternation(options)
        })
    }
}

struct CredentialPattern {
    full: RegExp,
    generator: RegexNode,
}

impl CredentialPattern {
    fn compile(pattern: &LosslessString) -> Result<Self, CredentialBrokerError> {
        if utf8(pattern).len() > MAX_REGEX_BYTES {
            return Err(CredentialBrokerError::InvalidConfig(
                "credential pattern exceeds 2048 bytes",
            ));
        }
        let full = RegExp::new(
            &units(&concat(&[&"^(?:".into(), pattern, &")$".into()])),
            "su",
        )?;
        let generator = RegexParser::parse(pattern)?;
        let pattern = Self { full, generator };
        if pattern.matches(&"".into())? {
            return Err(CredentialBrokerError::InvalidConfig(
                "credential pattern must not match an empty value",
            ));
        }
        for _ in 0..MAX_DUMMY_ATTEMPTS {
            if pattern.valid_candidate(&pattern.generator.generate()?)? {
                return Ok(pattern);
            }
        }
        Err(CredentialBrokerError::InvalidConfig(
            "credential pattern could not independently generate a matching dummy",
        ))
    }

    fn matches(&self, value: &LosslessString) -> Result<bool, CredentialBrokerError> {
        Ok(self
            .full
            .clone()
            .test(&units(value), &mut Budget::unlimited())?)
    }

    fn valid_candidate(&self, candidate: &LosslessString) -> Result<bool, CredentialBrokerError> {
        Ok(!candidate.is_empty()
            && utf8(candidate).len() <= MAX_DUMMY_VALUE_BYTES
            && !candidate.code_units().any(|unit| unit == 0)
            && self.matches(candidate)?)
    }
}

struct CredentialRecord {
    env_var: LosslessString,
    provider: usize,
    real: LosslessString,
    dummy: LosslessString,
    bindings: Vec<Binding>,
}

fn contains_real(record: &CredentialRecord, text: &LosslessString) -> bool {
    *text == record.real
        || (record.real.len() >= MIN_EMBEDDED_CREDENTIAL_LENGTH && includes(text, &record.real))
}

fn replace_all_longest_first(
    text: &LosslessString,
    mut pairs: Vec<(&LosslessString, &LosslessString)>,
) -> LosslessString {
    pairs.sort_by_key(|(left, _)| std::cmp::Reverse(left.len()));
    let mut output = units(text);
    for (from, to) in pairs {
        let from = units(from);
        if from.is_empty() {
            continue;
        }
        let to = units(to);
        let mut replaced = Vec::new();
        let mut position = 0;
        while position < output.len() {
            if output[position..].starts_with(&from) {
                replaced.extend_from_slice(&to);
                position += from.len();
            } else {
                replaced.push(output[position]);
                position += 1;
            }
        }
        output = replaced;
    }
    LosslessString::from_utf16(output)
}

fn mask_records(records: &[CredentialRecord], text: &LosslessString) -> LosslessString {
    replace_all_longest_first(
        text,
        records
            .iter()
            .filter(|record| contains_real(record, text))
            .map(|record| (&record.real, &record.dummy))
            .collect(),
    )
}

fn restore_records(records: &[CredentialRecord], text: &LosslessString) -> LosslessString {
    replace_all_longest_first(
        text,
        records
            .iter()
            .filter(|record| includes(text, &record.dummy))
            .map(|record| (&record.dummy, &record.real))
            .collect(),
    )
}

pub(crate) struct CredentialBroker {
    providers: Vec<Provider>,
    records: Mutex<Vec<CredentialRecord>>,
    shaped: RegExp,
}

impl CredentialBroker {
    pub(crate) fn mask_environment(
        &self,
        input: &[(LosslessString, LosslessString)],
    ) -> Result<MaskedEnvironment, CredentialBrokerError> {
        let mut records = self.records.lock().expect("credential broker records lock");
        let mut env = object_pairs(input);
        for (index, provider) in self.providers.iter().enumerate() {
            let Some(binding) = provider.binding(&env) else {
                continue;
            };
            for env_var in &provider.env_vars {
                let Some(raw) = get(&env, env_var) else {
                    continue;
                };
                let real = if matches!(&provider.kind, ProviderKind::Builtin(_)) {
                    trim(raw)
                } else {
                    raw.clone()
                };
                if real.is_empty()
                    || records.iter().any(|record| record.dummy == real)
                    || !provider.accepts(&real)?
                {
                    continue;
                }
                let existing = records.iter().position(|record| {
                    record.provider == index && record.env_var == *env_var && record.real == real
                });
                let record_index = match existing {
                    Some(position) => position,
                    None => {
                        let Some(dummy) = provider.dummy(&real)? else {
                            continue;
                        };
                        if records.iter().any(|record| record.dummy == dummy) {
                            continue;
                        }
                        records.push(CredentialRecord {
                            env_var: env_var.clone(),
                            provider: index,
                            real,
                            dummy,
                            bindings: Vec::new(),
                        });
                        records.len() - 1
                    }
                };
                let record = &mut records[record_index];
                if !record.bindings.contains(&binding) {
                    record.bindings.push(binding.clone());
                }
                set(&mut env, env_var.clone(), record.dummy.clone());
            }
        }
        for (key, value) in &mut env {
            if key == &LosslessString::from(CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY)
                || key == &LosslessString::from(CCA_BROKERED_CREDENTIALS_ENV_KEY)
            {
                continue;
            }
            *value = mask_records(&records, value);
        }
        let mut present = records
            .iter()
            .filter(|record| {
                env.iter().any(|(key, value)| {
                    key != &LosslessString::from(CCA_BROKERED_CREDENTIALS_ENV_KEY)
                        && includes(value, &record.dummy)
                })
            })
            .map(|record| (&record.env_var, &record.dummy))
            .collect::<Vec<_>>();
        present.sort_by(|(left_key, left_value), (right_key, right_value)| {
            if left_key == right_key {
                locale_compare(left_value, right_value)
            } else {
                locale_compare(left_key, right_key)
            }
        });
        let present = JsonValue::Array(
            present
                .into_iter()
                .map(|(key, value)| {
                    JsonValue::Array(vec![
                        JsonValue::String(key.clone()),
                        JsonValue::String(value.clone()),
                    ])
                })
                .collect(),
        );
        set(
            &mut env,
            CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY.into(),
            "1".into(),
        );
        set(
            &mut env,
            CCA_BROKERED_CREDENTIALS_ENV_KEY.into(),
            stringify_json(&present).into(),
        );
        let mut unmasked_keys = Vec::new();
        for (key, value) in &env {
            if key == &LosslessString::from(CCA_BROKERED_CREDENTIALS_ENV_KEY) {
                continue;
            }
            let matches = self
                .shaped
                .match_all(&units(value), &mut Budget::unlimited())?;
            let shaped_unmasked = matches
                .iter()
                .filter_map(|matched| matched.captures.first().and_then(Option::as_ref))
                .map(|matched| LosslessString::from_utf16(matched.clone()))
                .any(|matched| {
                    !records.iter().any(|record| {
                        includes(&record.dummy, &matched) || includes(&matched, &record.dummy)
                    })
                });
            if records
                .iter()
                .any(|record| contains_real(record, &trim(value)))
                || shaped_unmasked
            {
                unmasked_keys.push(key.clone());
            }
        }
        Ok(MaskedEnvironment { env, unmasked_keys })
    }

    pub(crate) fn restore_environment(
        &self,
        input: &[(LosslessString, LosslessString)],
    ) -> Environment {
        let records = self.records.lock().expect("credential broker records lock");
        object_pairs(input)
            .into_iter()
            .filter(|(key, _)| {
                key != &LosslessString::from(CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY)
                    && key != &LosslessString::from(CCA_BROKERED_CREDENTIALS_ENV_KEY)
                    && key != &LosslessString::from("__proto__")
            })
            .map(|(key, value)| (key, restore_records(&records, &value)))
            .collect()
    }

    pub(crate) fn brokered_keys(
        &self,
        input: &[(LosslessString, LosslessString)],
    ) -> Vec<LosslessString> {
        let records = self.records.lock().expect("credential broker records lock");
        let mut keys = object_pairs(input)
            .into_iter()
            .filter(|(key, value)| {
                key != &LosslessString::from(CCA_BROKERED_CREDENTIALS_ENV_KEY)
                    && records.iter().any(|record| includes(value, &record.dummy))
            })
            .map(|(key, _)| key)
            .collect::<Vec<_>>();
        keys.sort();
        keys
    }

    pub(crate) fn mask_text(&self, text: &LosslessString) -> LosslessString {
        mask_records(
            &self.records.lock().expect("credential broker records lock"),
            text,
        )
    }

    #[cfg(test)]
    pub(crate) fn restore_text(&self, text: &LosslessString) -> LosslessString {
        restore_records(
            &self.records.lock().expect("credential broker records lock"),
            text,
        )
    }

    pub(crate) fn interception(&self, input: &LosslessString, port: u16) -> BrokeredProtocols {
        let host = normalize_host(input);
        let records = self.records.lock().expect("credential broker records lock");
        let mut required = BrokeredProtocols::default();
        for binding in records.iter().flat_map(|record| &record.bindings) {
            let protocols = binding.protocols(&host, port);
            required.tls |= protocols.tls;
            required.http |= protocols.http;
        }
        required
    }

    pub(crate) fn restore_request_headers(
        &self,
        destination: &Url,
        raw_path: &LosslessString,
        headers: &[Header],
    ) -> Vec<Header> {
        let host = normalize_host(&destination.host_str().unwrap_or("").into());
        let records = self.records.lock().expect("credential broker records lock");
        let matching = records
            .iter()
            .filter(|record| {
                record
                    .bindings
                    .iter()
                    .any(|binding| binding.matches_request(&host, destination, raw_path))
            })
            .collect::<Vec<_>>();
        let mut selected: Vec<(LosslessString, &CredentialRecord, LosslessString)> = Vec::new();
        let mut ambiguous = Vec::new();
        for record in &matching {
            for candidate in matching.iter().filter(|candidate| {
                candidate.provider == record.provider && candidate.real == record.real
            }) {
                for (name, value) in self.providers[record.provider].translate(
                    headers,
                    &candidate.dummy,
                    &record.real,
                ) {
                    if ambiguous.contains(&name) {
                        continue;
                    }
                    if let Some(index) = selected.iter().position(|(key, _, _)| key == &name) {
                        let (_, existing, existing_value) = &selected[index];
                        if existing.provider != record.provider
                            || existing.real != record.real
                            || *existing_value != value
                        {
                            selected.remove(index);
                            ambiguous.push(name);
                        }
                    } else {
                        selected.push((name, record, value));
                    }
                }
            }
        }
        let mut restored = headers
            .iter()
            .filter(|(name, _)| !selected.iter().any(|(key, _, _)| *key == ascii_lower(name)))
            .cloned()
            .collect::<Vec<_>>();
        restored.extend(selected.into_iter().map(|(name, _, value)| (name, value)));
        restored
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(items: &[(&str, &str)]) -> Environment {
        items
            .iter()
            .map(|(key, value)| ((*key).into(), (*value).into()))
            .collect()
    }

    fn value(input: &Environment, key: &str) -> LosslessString {
        input
            .iter()
            .find(|(name, _)| name == &LosslessString::from(key))
            .unwrap()
            .1
            .clone()
    }

    fn config() -> CredentialProviderConfig {
        CredentialProviderConfig {
            env: vec!["VENDOR_TOKEN".into()],
            patterns: vec!["vendor_[a-z]{8}".into()],
            url_prefixes: vec!["https://vendor.example/api".into()],
            url_prefix_from_env: None,
            auth: vec![CredentialAuthMethod::Bearer],
            header: None,
            prefix: None,
        }
    }

    fn make_entry(providers: Providers) -> Arc<CredentialBrokerEntry> {
        CredentialBrokerCache::new()
            .broker_for(&CredentialBrokerKey {
                environment_id: None,
                conversation_id: None,
                providers,
            })
            .unwrap()
    }

    fn restored(
        broker: &CredentialBroker,
        url: &str,
        raw_path: &str,
        headers: &[Header],
    ) -> Vec<Header> {
        broker.restore_request_headers(&url::Url::parse(url).unwrap(), &raw_path.into(), headers)
    }

    #[test]
    fn builtins_mask_lengths_prefixes_metadata_and_round_trip() {
        let entry = make_entry(vec![]);
        let openai = format!("sk-proj-{}", "A1b2C3d4".repeat(8));
        let github = format!("ghp_{}", "Z9y8X7w6".repeat(5));
        let input = env(&[
            ("OPENAI_API_KEY", &openai),
            ("GH_TOKEN", &github),
            ("PLAIN", "untouched"),
        ]);
        let masked = entry.broker.mask_environment(&input).unwrap();
        let oa = value(&masked.env, "OPENAI_API_KEY");
        let gh = value(&masked.env, "GH_TOKEN");
        assert!(oa.as_str().unwrap().starts_with("sk-proj-masked"));
        assert!(gh.as_str().unwrap().starts_with("ghp_masked"));
        assert_eq!(oa.len(), openai.len());
        assert_eq!(gh.len(), github.len());
        assert_ne!(oa, openai.as_str().into());
        assert_eq!(
            value(&masked.env, CCA_CREDENTIAL_BROKER_ACTIVE_ENV_KEY),
            "1".into()
        );
        assert_eq!(
            value(&masked.env, CCA_BROKERED_CREDENTIALS_ENV_KEY),
            stringify_json(&JsonValue::Array(vec![
                JsonValue::Array(vec![
                    JsonValue::String("GH_TOKEN".into()),
                    JsonValue::String(gh)
                ]),
                JsonValue::Array(vec![
                    JsonValue::String("OPENAI_API_KEY".into()),
                    JsonValue::String(oa)
                ]),
            ]))
            .into()
        );
        assert!(masked.unmasked_keys.is_empty());
        assert_eq!(entry.broker.restore_environment(&masked.env), input);
    }

    #[test]
    fn custom_masks_and_reuses_dummy_and_accumulates_dynamic_bindings() {
        let mut provider = config();
        provider.url_prefix_from_env = Some("VENDOR_URL".into());
        let entry = make_entry(vec![("vendor".into(), provider)]);
        let first = entry
            .broker
            .mask_environment(&env(&[
                ("VENDOR_TOKEN", "vendor_abcdefgh"),
                ("VENDOR_URL", "https://first.example/v1"),
            ]))
            .unwrap();
        let second = entry
            .broker
            .mask_environment(&env(&[
                ("VENDOR_TOKEN", "vendor_abcdefgh"),
                ("VENDOR_URL", "https://second.example/v2"),
            ]))
            .unwrap();
        let dummy = value(&first.env, "VENDOR_TOKEN");
        assert_ne!(dummy, "vendor_abcdefgh".into());
        assert_eq!(dummy, value(&second.env, "VENDOR_TOKEN"));
        let text = dummy.as_str().unwrap();
        assert!(
            text.starts_with("vendor_")
                && text.len() == 15
                && text[7..].bytes().all(|byte| byte.is_ascii_lowercase())
        );
        for host in ["vendor.example", "first.example", "second.example"] {
            assert_eq!(
                entry.broker.interception(&host.into(), 443),
                BrokeredProtocols {
                    tls: true,
                    http: false
                }
            );
        }
        assert_eq!(
            entry.broker.mask_environment(&first.env).unwrap().env,
            first.env
        );
    }

    #[test]
    fn provider_precedence_is_locale_sorted_and_builtins_are_reserved() {
        let mut later = config();
        later.url_prefixes = vec!["https://later.example".into()];
        let mut builtin = config();
        builtin.env = vec!["OPENAI_API_KEY".into()];
        let entry = make_entry(vec![
            ("z".into(), later),
            ("a".into(), config()),
            ("reserved".into(), builtin),
        ]);
        assert_eq!(
            entry.ignored_providers,
            vec![LosslessString::from("reserved"), "z".into()]
        );
        entry
            .broker
            .mask_environment(&env(&[("VENDOR_TOKEN", "vendor_abcdefgh")]))
            .unwrap();
        assert!(entry.broker.interception(&"vendor.example".into(), 443).tls);
        assert!(!entry.broker.interception(&"later.example".into(), 443).tls);
    }

    #[test]
    fn invalid_configs_are_reported_without_disabling_builtins() {
        let mut configs = Vec::new();
        for (id, change) in [
            ("empty-env", 0),
            ("empty-pattern", 1),
            ("empty-destination", 2),
            ("bad-env", 3),
            ("bad-dynamic", 4),
            ("bad-header", 5),
            ("missing-header", 6),
            ("extra-header", 7),
            ("extra-prefix", 8),
        ] {
            let mut provider = config();
            match change {
                0 => provider.env.clear(),
                1 => provider.patterns.clear(),
                2 => provider.url_prefixes.clear(),
                3 => provider.env = vec!["INVALID-KEY".into()],
                4 => provider.url_prefix_from_env = Some("VENDOR_TOKEN".into()),
                5 => {
                    provider.auth = vec![CredentialAuthMethod::Header];
                    provider.header = Some("bad header".into());
                }
                6 => provider.auth = vec![CredentialAuthMethod::Header],
                7 => provider.header = Some("X-Vendor-Key".into()),
                _ => provider.prefix = Some("Key ".into()),
            }
            configs.push((id.into(), provider));
        }
        configs.push(("".into(), config()));
        let entry = make_entry(configs);
        assert_eq!(entry.ignored_providers.len(), 10);
        let masked = entry
            .broker
            .mask_environment(&env(&[
                ("GH_TOKEN", "synthetic"),
                ("VENDOR_TOKEN", "vendor_abcdefgh"),
            ]))
            .unwrap();
        assert_ne!(value(&masked.env, "GH_TOKEN"), "synthetic".into());
        assert_eq!(value(&masked.env, "VENDOR_TOKEN"), "vendor_abcdefgh".into());
    }

    #[test]
    fn configured_destinations_enforce_scheme_port_host_and_path_boundary() {
        let entry = make_entry(vec![("vendor".into(), config())]);
        let masked = entry
            .broker
            .mask_environment(&env(&[("VENDOR_TOKEN", "vendor_abcdefgh")]))
            .unwrap();
        let headers = vec![(
            "Authorization".into(),
            format!(
                "Bearer {}",
                value(&masked.env, "VENDOR_TOKEN").as_str().unwrap()
            )
            .into(),
        )];
        for (target, path, allow) in [
            ("https://vendor.example/api", "/api", true),
            (
                "https://VENDOR.EXAMPLE./api/items?q=1",
                "/api/items?q=1",
                true,
            ),
            ("https://vendor.example/apis", "/apis", false),
            ("https://vendor.example/", "/", false),
            ("http://vendor.example/api", "/api", false),
            ("https://vendor.example:8443/api", "/api", false),
            ("https://vendor.example.evil/api", "/api", false),
            ("https://evilvendor.example/api", "/api", false),
        ] {
            let actual = restored(&entry.broker, target, path, &headers);
            assert_eq!(actual != headers, allow, "{target}");
            if allow {
                assert_eq!(
                    actual,
                    vec![("authorization".into(), "Bearer vendor_abcdefgh".into())]
                );
            }
        }
        assert_eq!(
            entry.broker.interception(&"vendor.example".into(), 8443),
            BrokeredProtocols {
                tls: false,
                http: false
            }
        );
    }

    #[test]
    fn raw_path_blocks_encoded_and_literal_traversal() {
        let entry = make_entry(vec![("vendor".into(), config())]);
        let masked = entry
            .broker
            .mask_environment(&env(&[("VENDOR_TOKEN", "vendor_abcdefgh")]))
            .unwrap();
        let headers = vec![(
            "authorization".into(),
            format!(
                "Bearer {}",
                value(&masked.env, "VENDOR_TOKEN").as_str().unwrap()
            )
            .into(),
        )];
        for path in [
            "/api/../api",
            "/api/./items",
            "/api/%2e/items",
            "/api/%2Fitems",
            "/api/%5citems",
            "/api\\items",
            "/api?x=%2e",
        ] {
            assert_eq!(
                restored(&entry.broker, "https://vendor.example/api", path, &headers),
                headers,
                "{path}"
            );
        }
    }

    #[test]
    fn scoped_wildcards_and_loopback_http_interception() {
        let mut provider = config();
        provider.url_prefixes = vec![
            "https://*.vendor.example:8443/api/".into(),
            "127.0.0.1:8123/api".into(),
            "http://[::1]:8124/api".into(),
        ];
        let entry = make_entry(vec![("vendor".into(), provider)]);
        entry
            .broker
            .mask_environment(&env(&[("VENDOR_TOKEN", "vendor_abcdefgh")]))
            .unwrap();
        for (host, port, tls, http) in [
            ("a.vendor.example", 8443, true, false),
            ("a.b.vendor.example.", 8443, true, false),
            ("vendor.example", 8443, false, false),
            ("evilvendor.example", 8443, false, false),
            ("a.vendor.example", 443, false, false),
            ("127.0.0.1", 8123, false, true),
            ("[::1]", 8124, false, true),
        ] {
            assert_eq!(
                entry.broker.interception(&host.into(), port),
                BrokeredProtocols { tls, http }
            );
        }
    }

    #[test]
    fn invalid_destinations_and_unsafe_dynamic_values_are_not_admitted() {
        for target in [
            "http://vendor.example",
            "ftp://vendor.example",
            "https://user@vendor.example",
            "https://vendor.example?",
            "https://vendor.example#",
            "https://*vendor.example",
            "https://*.127.0.0.1",
            "https://vendor.example/path?x=1",
        ] {
            let mut provider = config();
            provider.url_prefixes = vec![target.into()];
            let entry = make_entry(vec![("vendor".into(), provider)]);
            assert_eq!(
                entry.ignored_providers,
                vec![LosslessString::from("vendor")],
                "{target}"
            );
        }
        let mut provider = config();
        provider.url_prefixes.clear();
        provider.url_prefix_from_env = Some("VENDOR_URL".into());
        let entry = make_entry(vec![("vendor".into(), provider)]);
        for target in [
            "https://*.vendor.example",
            "http://vendor.example",
            "not a url",
        ] {
            let masked = entry
                .broker
                .mask_environment(&env(&[
                    ("VENDOR_TOKEN", "vendor_abcdefgh"),
                    ("VENDOR_URL", target),
                ]))
                .unwrap();
            assert_eq!(value(&masked.env, "VENDOR_TOKEN"), "vendor_abcdefgh".into());
        }
    }

    #[test]
    fn builtins_have_distinct_cloud_enterprise_and_trusted_base_bindings() {
        let entry = make_entry(vec![]);
        entry
            .broker
            .mask_environment(&env(&[
                ("GH_TOKEN", "cloud"),
                ("GH_ENTERPRISE_TOKEN", "enterprise"),
                ("GH_HOST", "git.example:8443"),
                ("OPENAI_API_KEY", "openai"),
                ("OPENAI_BASE_URL", "https://base.example:9443/path"),
            ]))
            .unwrap();
        for host in [
            "api.github.com",
            "github.com",
            "uploads.github.com",
            "a.ghe.com",
            "git.example",
            "api.openai.com",
            "base.example",
        ] {
            assert!(entry.broker.interception(&host.into(), 1234).tls, "{host}");
        }
        for host in [
            "ghe.com",
            "evilgithub.com",
            "github.com.evil",
            "unrelated.example",
        ] {
            assert!(!entry.broker.interception(&host.into(), 443).tls, "{host}");
        }
        for (hint, base) in [
            ("github.com", "http://insecure.example"),
            ("user@git.example", "https://user:pass@base.example"),
            ("a.ghe.com", "invalid"),
        ] {
            let isolated = make_entry(vec![]);
            let masked = isolated
                .broker
                .mask_environment(&env(&[
                    ("GH_ENTERPRISE_TOKEN", "enterprise"),
                    ("GH_HOST", hint),
                    ("OPENAI_API_KEY", "openai"),
                    ("OPENAI_BASE_URL", base),
                ]))
                .unwrap();
            assert_eq!(
                value(&masked.env, "GH_ENTERPRISE_TOKEN"),
                "enterprise".into()
            );
            assert!(
                !isolated
                    .broker
                    .interception(&"base.example".into(), 443)
                    .tls
            );
        }
    }

    #[test]
    fn custom_bearer_token_and_basic_restore_only_matching_authorization() {
        for (method, scheme) in [
            (CredentialAuthMethod::Bearer, "bEaReR"),
            (CredentialAuthMethod::Token, "ToKeN"),
            (CredentialAuthMethod::Basic, "Basic"),
        ] {
            let mut provider = config();
            provider.auth = vec![method];
            let entry = make_entry(vec![("vendor".into(), provider)]);
            let masked = entry
                .broker
                .mask_environment(&env(&[("VENDOR_TOKEN", "vendor_abcdefgh")]))
                .unwrap();
            let dummy = value(&masked.env, "VENDOR_TOKEN");
            let encoded = if method == CredentialAuthMethod::Basic {
                base64_encode(dummy.as_str().unwrap().as_bytes())
            } else {
                dummy.as_str().unwrap().to_owned()
            };
            let expected = if method == CredentialAuthMethod::Basic {
                base64_encode(b"vendor_abcdefgh")
            } else {
                "vendor_abcdefgh".to_owned()
            };
            let headers = vec![
                ("X-Keep".into(), "one".into()),
                ("Authorization".into(), format!("{scheme} {encoded}").into()),
                ("X-Keep".into(), "two".into()),
                ("AUTHORIZATION".into(), "duplicate".into()),
            ];
            assert_eq!(
                restored(
                    &entry.broker,
                    "https://vendor.example/api/items",
                    "/api/items",
                    &headers
                ),
                vec![
                    ("X-Keep".into(), "one".into()),
                    ("X-Keep".into(), "two".into()),
                    (
                        "authorization".into(),
                        format!("{scheme} {expected}").into()
                    )
                ]
            );
            let wrong = vec![("authorization".into(), format!("Digest {encoded}").into())];
            assert_eq!(
                restored(&entry.broker, "https://vendor.example/api", "/api", &wrong),
                wrong
            );
        }
    }

    #[test]
    fn github_basic_handles_whole_username_password_and_canonical_base64() {
        let entry = make_entry(vec![]);
        let masked = entry
            .broker
            .mask_environment(&env(&[("GH_TOKEN", "synthetic-real")]))
            .unwrap();
        let dummy = value(&masked.env, "GH_TOKEN");
        for (plain, expected) in [
            (
                dummy.as_str().unwrap().to_owned(),
                "synthetic-real".to_owned(),
            ),
            (
                format!("{}:password", dummy.as_str().unwrap()),
                "synthetic-real:password".to_owned(),
            ),
            (
                format!("user:{}", dummy.as_str().unwrap()),
                "user:synthetic-real".to_owned(),
            ),
            (
                format!("{0}:{0}", dummy.as_str().unwrap()),
                "synthetic-real:synthetic-real".to_owned(),
            ),
        ] {
            let base = base64_encode(plain.as_bytes());
            for rendered in [
                base.clone(),
                base.trim_end_matches('=').to_owned(),
                format!("{base}==="),
            ] {
                let headers = vec![("authorization".into(), format!("Basic {rendered}").into())];
                assert_eq!(
                    restored(&entry.broker, "https://api.github.com/", "/", &headers),
                    vec![(
                        "authorization".into(),
                        format!("Basic {}", base64_encode(expected.as_bytes())).into()
                    )]
                );
            }
        }
        let invalid = vec![("authorization".into(), "Basic A!AA".into())];
        assert_eq!(
            restored(&entry.broker, "https://api.github.com/", "/", &invalid),
            invalid
        );
    }

    #[test]
    fn openai_uses_canonical_bearer_only_translation() {
        let entry = make_entry(vec![]);
        let masked = entry
            .broker
            .mask_environment(&env(&[("OPENAI_API_KEY", "openai-real")]))
            .unwrap();
        let dummy = value(&masked.env, "OPENAI_API_KEY");
        let headers = vec![(
            "Authorization".into(),
            format!("arbitrary prefix {} suffix", dummy.as_str().unwrap()).into(),
        )];
        assert_eq!(
            restored(
                &entry.broker,
                "https://api.openai.com/v1",
                "/../v1",
                &headers
            ),
            vec![("authorization".into(), "Bearer openai-real".into())]
        );
        assert_eq!(
            restored(&entry.broker, "http://api.openai.com/v1", "/v1", &headers),
            headers
        );
    }

    #[test]
    fn custom_header_restores_exact_prefix_only_on_loopback_path() {
        let mut provider = config();
        provider.url_prefixes = vec!["http://127.0.0.1:8123/api".into()];
        provider.auth = vec![CredentialAuthMethod::Header];
        provider.header = Some("X-Vendor-Key".into());
        provider.prefix = Some("Key ".into());
        let entry = make_entry(vec![("vendor".into(), provider)]);
        let masked = entry
            .broker
            .mask_environment(&env(&[("VENDOR_TOKEN", "vendor_abcdefgh")]))
            .unwrap();
        let dummy = value(&masked.env, "VENDOR_TOKEN");
        let headers = vec![
            (
                "X-Vendor-Key".into(),
                format!("Key {}", dummy.as_str().unwrap()).into(),
            ),
            (
                "Authorization".into(),
                format!("Bearer {}", dummy.as_str().unwrap()).into(),
            ),
        ];
        assert_eq!(
            restored(
                &entry.broker,
                "http://127.0.0.1:8123/api/items",
                "/api/items",
                &headers
            ),
            vec![
                headers[1].clone(),
                ("x-vendor-key".into(), "Key vendor_abcdefgh".into())
            ]
        );
        assert_eq!(
            restored(
                &entry.broker,
                "http://127.0.0.1:8123/other",
                "/other",
                &headers
            ),
            headers
        );
    }

    #[test]
    fn configured_detection_default_auth_and_multiple_header_methods() {
        let mut provider = config();
        provider.auth.clear();
        let entry = make_entry(vec![("vendor".into(), provider)]);
        let untouched = entry
            .broker
            .mask_environment(&env(&[("VENDOR_TOKEN", "not-a-credential")]))
            .unwrap();
        assert_eq!(
            value(&untouched.env, "VENDOR_TOKEN"),
            "not-a-credential".into()
        );
        assert!(!entry.broker.interception(&"vendor.example".into(), 443).tls);
        let masked = entry
            .broker
            .mask_environment(&env(&[("VENDOR_TOKEN", "vendor_abcdefgh")]))
            .unwrap();
        let headers = vec![(
            "authorization".into(),
            concat(&[&"Bearer ".into(), &value(&masked.env, "VENDOR_TOKEN")]),
        )];
        assert_eq!(
            restored(
                &entry.broker,
                "https://vendor.example/api",
                "/api",
                &headers
            ),
            vec![("authorization".into(), "Bearer vendor_abcdefgh".into())]
        );

        let mut provider = config();
        provider.auth = vec![
            CredentialAuthMethod::Token,
            CredentialAuthMethod::Header,
            CredentialAuthMethod::Token,
            CredentialAuthMethod::Header,
        ];
        provider.header = Some("X-Vendor-Key".into());
        provider.prefix = Some("Key ".into());
        let entry = make_entry(vec![("vendor".into(), provider)]);
        let masked = entry
            .broker
            .mask_environment(&env(&[("VENDOR_TOKEN", "vendor_abcdefgh")]))
            .unwrap();
        let dummy = value(&masked.env, "VENDOR_TOKEN");
        let headers = vec![
            ("Authorization".into(), concat(&[&"token ".into(), &dummy])),
            ("X-Vendor-Key".into(), concat(&[&"Key ".into(), &dummy])),
        ];
        assert_eq!(
            restored(
                &entry.broker,
                "https://vendor.example/api",
                "/api",
                &headers
            ),
            vec![
                ("authorization".into(), "token vendor_abcdefgh".into()),
                ("x-vendor-key".into(), "Key vendor_abcdefgh".into())
            ]
        );
        let wrong_prefix = vec![("X-Vendor-Key".into(), concat(&[&"key ".into(), &dummy]))];
        assert_eq!(
            restored(
                &entry.broker,
                "https://vendor.example/api",
                "/api",
                &wrong_prefix
            ),
            wrong_prefix
        );
    }

    #[test]
    fn supported_regex_shapes_generate_independent_matching_values() {
        for (pattern, real) in [
            ("vendor_[a-z]{8}", "vendor_abcdefgh"),
            ("^(?:cat|dog)_[A-Z0-9]{8}$", "cat_ABCDEFGH"),
            ("id_\\d{4}\\w{4}", "id_1234abcd"),
            ("id_[^0-9]{8}", "id_abcdefgh"),
            ("id_.{8}", "id_abcdefgh"),
            ("id_[a-z]+", "id_abcdefgh"),
            ("id_[a-z]*z", "id_abcdefghz"),
            ("id_x?[a-z]{8,}", "id_abcdefgh"),
            ("id_[a-z]{8,100}", "id_abcdefgh"),
        ] {
            let mut provider = config();
            provider.patterns = vec![pattern.into()];
            let entry = make_entry(vec![("vendor".into(), provider)]);
            assert!(entry.ignored_providers.is_empty(), "{pattern}");
            let masked = entry
                .broker
                .mask_environment(&env(&[("VENDOR_TOKEN", real)]))
                .unwrap();
            let dummy = value(&masked.env, "VENDOR_TOKEN");
            assert_ne!(dummy, real.into(), "{pattern}");
            let source = format!("^(?:{pattern})$")
                .encode_utf16()
                .collect::<Vec<_>>();
            assert!(
                RegExp::new(&source, "su")
                    .unwrap()
                    .test(
                        &dummy.code_units().collect::<Vec<_>>(),
                        &mut Budget::unlimited()
                    )
                    .unwrap()
            );
        }
    }

    #[test]
    fn unsupported_regex_shapes_never_gain_substitute_dummies() {
        for pattern in [
            "(?=x)x",
            "(?!x)y",
            "(?<=x)y",
            "(?<name>x)",
            "(x)\\1",
            "\\s+",
            "\\D+",
            "\\p{L}+",
            "\\x41",
            "\\u0041",
            "x+?",
            "x++",
            "x{65}",
            "x{2,1}",
            "a^b",
            "a$b",
            "[z-a]",
            "[a[b]",
            "",
            "x*",
            "\\n",
            "[\\t]",
        ] {
            let mut provider = config();
            provider.patterns = vec![pattern.into()];
            let entry = make_entry(vec![("vendor".into(), provider)]);
            assert_eq!(
                entry.ignored_providers,
                vec![LosslessString::from("vendor")],
                "{pattern}"
            );
        }
    }

    #[test]
    fn regex_bytes_repetition_and_candidate_exhaustion_boundaries() {
        for (pattern, ignored) in [
            ("a".repeat(2048), false),
            ("a".repeat(2049), true),
            ("é".repeat(1024), false),
            ("é".repeat(1025), true),
            ("[a-z]{64}".to_owned(), false),
            ("[a-z]{65}".to_owned(), true),
        ] {
            let mut provider = config();
            provider.patterns = vec![pattern.into()];
            let entry = make_entry(vec![("vendor".into(), provider)]);
            assert_eq!(!entry.ignored_providers.is_empty(), ignored);
        }
        let mut provider = config();
        provider.patterns = vec!["fixed".into()];
        let entry = make_entry(vec![("vendor".into(), provider)]);
        assert!(entry.ignored_providers.is_empty());
        assert_eq!(
            value(
                &entry
                    .broker
                    .mask_environment(&env(&[("VENDOR_TOKEN", "fixed")]))
                    .unwrap()
                    .env,
                "VENDOR_TOKEN"
            ),
            "fixed".into()
        );
    }

    #[test]
    fn configured_whitespace_and_basic_colon_shape_remain_unmasked_when_unusable() {
        let mut provider = config();
        provider.patterns = vec![" [a-z]{8} ".into()];
        let entry = make_entry(vec![("vendor".into(), provider)]);
        let masked = entry
            .broker
            .mask_environment(&env(&[("VENDOR_TOKEN", " abcdefgh ")]))
            .unwrap();
        assert_eq!(value(&masked.env, "VENDOR_TOKEN"), " abcdefgh ".into());
        let mut provider = config();
        provider.patterns = vec!["[a-z]{8}:[a-z]{8}".into()];
        provider.auth = vec![CredentialAuthMethod::Basic];
        let entry = make_entry(vec![("vendor".into(), provider)]);
        let masked = entry
            .broker
            .mask_environment(&env(&[("VENDOR_TOKEN", "abcdefgh:ijklmnop")]))
            .unwrap();
        assert_ne!(
            value(&masked.env, "VENDOR_TOKEN"),
            "abcdefgh:ijklmnop".into()
        );
    }

    #[test]
    fn environment_copies_unmasked_shapes_and_sorted_brokered_keys() {
        let entry = make_entry(vec![]);
        let real = format!("sk-{}", "x".repeat(60));
        let stray = format!("ghp_{}", "q".repeat(40));
        let masked = entry
            .broker
            .mask_environment(&env(&[
                ("OPENAI_API_KEY", &real),
                ("COPY", &format!("prefix {real}")),
                ("STRAY", &stray),
            ]))
            .unwrap();
        assert_eq!(
            value(&masked.env, "COPY"),
            format!(
                "prefix {}",
                value(&masked.env, "OPENAI_API_KEY").as_str().unwrap()
            )
            .into()
        );
        assert_eq!(masked.unmasked_keys, vec![LosslessString::from("STRAY")]);
        assert_eq!(
            entry.broker.brokered_keys(&masked.env),
            vec![LosslessString::from("COPY"), "OPENAI_API_KEY".into()]
        );
    }

    #[test]
    fn text_uses_utf16_embedded_threshold_and_longest_first_replacement() {
        let entry = make_entry(vec![]);
        let masked = entry
            .broker
            .mask_environment(&env(&[
                ("GH_TOKEN", "short"),
                ("GITHUB_TOKEN", "long-secret-123456"),
                ("OPENAI_API_KEY", "long-secret-123456-extension"),
            ]))
            .unwrap();
        assert_eq!(
            entry.broker.mask_text(&"short".into()),
            value(&masked.env, "GH_TOKEN")
        );
        assert_eq!(
            entry.broker.mask_text(&"prefix short".into()),
            "prefix short".into()
        );
        let text = "prefix long-secret-123456-extension suffix".into();
        let hidden = entry.broker.mask_text(&text);
        assert_eq!(
            hidden,
            format!(
                "prefix {} suffix",
                value(&masked.env, "OPENAI_API_KEY").as_str().unwrap()
            )
            .into()
        );
        assert_eq!(entry.broker.restore_text(&hidden), text);
    }

    #[test]
    fn environment_preserves_lone_units_integer_enumeration_and_replacement_order() {
        let entry = make_entry(vec![]);
        let lone = LosslessString::from_utf16(vec![0xd800]);
        let mut input = env(&[
            ("z", "first"),
            ("10", "ten"),
            ("2", "two"),
            ("z", "last"),
            ("GH_TOKEN", "token"),
        ]);
        input.push((lone.clone(), LosslessString::from_utf16(vec![0xdc00, 120])));
        let masked = entry.broker.mask_environment(&input).unwrap();
        assert_eq!(
            masked
                .env
                .iter()
                .take(3)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>(),
            vec![LosslessString::from("2"), "10".into(), "z".into()]
        );
        assert_eq!(value(&masked.env, "z"), "last".into());
        assert_eq!(
            masked.env.iter().find(|(key, _)| key == &lone).unwrap().1,
            LosslessString::from_utf16(vec![0xdc00, 120])
        );
        let restored = entry.broker.restore_environment(&masked.env);
        assert_eq!(restored.len(), 5);
        assert_eq!(value(&restored, "GH_TOKEN"), "token".into());
    }

    #[test]
    fn lossless_provider_identity_and_non_header_credentials_are_not_normalized() {
        let id = LosslessString::from_utf16(vec![0xd800]);
        let mut provider = config();
        provider.auth = vec![CredentialAuthMethod::Basic];
        provider.patterns = vec![LosslessString::from_utf16(vec![
            0xd800, 91, 97, 45, 122, 93, 123, 56, 125,
        ])];
        let entry = make_entry(vec![(id, provider)]);
        assert!(entry.ignored_providers.is_empty());
        let real = LosslessString::from_utf16(vec![0xd800, 97, 98, 99, 100, 101, 102, 103, 104]);
        let input = vec![("VENDOR_TOKEN".into(), real.clone())];
        let masked = entry.broker.mask_environment(&input).unwrap();
        assert_ne!(value(&masked.env, "VENDOR_TOKEN"), real);
        assert_eq!(entry.broker.restore_environment(&masked.env), input);
    }

    #[test]
    fn same_real_aliases_restore_and_openai_preserves_its_substring_translation() {
        let entry = make_entry(vec![]);
        let masked = entry
            .broker
            .mask_environment(&env(&[
                ("GH_TOKEN", "same-real"),
                ("GITHUB_TOKEN", "same-real"),
            ]))
            .unwrap();
        for key in ["GH_TOKEN", "GITHUB_TOKEN"] {
            let headers = vec![(
                "authorization".into(),
                format!("token {}", value(&masked.env, key).as_str().unwrap()).into(),
            )];
            assert_eq!(
                restored(&entry.broker, "https://github.com/", "/", &headers),
                vec![("authorization".into(), "token same-real".into())]
            );
        }
        let entry = make_entry(vec![]);
        let masked = entry
            .broker
            .mask_environment(&env(&[
                ("GH_TOKEN", "first-real"),
                ("OPENAI_API_KEY", "second-real"),
                ("OPENAI_BASE_URL", "https://github.com"),
            ]))
            .unwrap();
        let headers = vec![(
            "authorization".into(),
            format!(
                "Bearer {} {}",
                value(&masked.env, "GH_TOKEN").as_str().unwrap(),
                value(&masked.env, "OPENAI_API_KEY").as_str().unwrap()
            )
            .into(),
        )];
        assert_eq!(
            restored(&entry.broker, "https://github.com/", "/", &headers),
            vec![("authorization".into(), "Bearer second-real".into())]
        );
    }

    #[test]
    fn basic_utf8_equivalent_dummies_make_conflicting_authorization_ambiguous() {
        let mut first = config();
        first.env = vec!["FIRST_TOKEN".into()];
        first.auth = vec![CredentialAuthMethod::Basic];
        first.patterns = vec![LosslessString::from_utf16(vec![91, 92, 110, 0xd800, 93])];
        let mut second = first.clone();
        second.env = vec!["SECOND_TOKEN".into()];
        second.patterns = vec![LosslessString::from_utf16(vec![91, 92, 114, 0xd801, 93])];
        let entry = make_entry(vec![("first".into(), first), ("second".into(), second)]);
        let masked = entry
            .broker
            .mask_environment(&env(&[("FIRST_TOKEN", "\n"), ("SECOND_TOKEN", "\r")]))
            .unwrap();
        assert_eq!(
            value(&masked.env, "FIRST_TOKEN"),
            LosslessString::from_utf16(vec![0xd800])
        );
        assert_eq!(
            value(&masked.env, "SECOND_TOKEN"),
            LosslessString::from_utf16(vec![0xd801])
        );
        let headers = vec![
            ("Authorization".into(), "Basic 77+9".into()),
            ("X-Keep".into(), "untouched".into()),
        ];
        assert_eq!(
            restored(
                &entry.broker,
                "https://vendor.example/api",
                "/api",
                &headers
            ),
            headers
        );
    }

    #[test]
    fn deterministic_dummy_collision_keeps_second_distinct_real_unmasked() {
        let mut provider = config();
        provider.env = vec!["FIRST_TOKEN".into(), "SECOND_TOKEN".into()];
        provider.auth = vec![CredentialAuthMethod::Basic];
        provider.patterns = vec!["[\\n\\rn]".into()];
        let entry = make_entry(vec![("vendor".into(), provider)]);
        let masked = entry
            .broker
            .mask_environment(&env(&[("FIRST_TOKEN", "\n"), ("SECOND_TOKEN", "\r")]))
            .unwrap();
        assert_eq!(value(&masked.env, "FIRST_TOKEN"), "n".into());
        assert_eq!(value(&masked.env, "SECOND_TOKEN"), "\r".into());
        assert_eq!(
            entry.broker.brokered_keys(&masked.env),
            vec![LosslessString::from("FIRST_TOKEN")]
        );
    }

    #[test]
    fn regex_dummy_byte_limit_and_clipped_explicit_maximum_are_preserved() {
        for (pattern, ignored) in [
            ("([a-z]{64}){32}", false),
            ("([a-z]{64}){33}", true),
            ("\0", true),
        ] {
            let mut provider = config();
            provider.patterns = vec![pattern.into()];
            let entry = make_entry(vec![("vendor".into(), provider)]);
            assert_eq!(!entry.ignored_providers.is_empty(), ignored, "{pattern}");
        }
        let mut provider = config();
        provider.patterns = vec!["[a-z]{64,100}".into()];
        let entry = make_entry(vec![("vendor".into(), provider)]);
        let real = "a".repeat(100);
        let masked = entry
            .broker
            .mask_environment(&env(&[("VENDOR_TOKEN", &real)]))
            .unwrap();
        assert_eq!(value(&masked.env, "VENDOR_TOKEN").len(), 64);
    }

    #[test]
    fn embedded_threshold_counts_utf16_units_without_replacing_surrogates() {
        let mut provider = config();
        provider.auth = vec![CredentialAuthMethod::Basic];
        provider.patterns = vec![
            format!("{}[a-z]{{2}}", "😀".repeat(7)).into(),
            format!("{}[a-z]{{2}}", "😀".repeat(6)).into(),
        ];
        let entry = make_entry(vec![("vendor".into(), provider)]);
        let long: LosslessString = format!("{}ab", "😀".repeat(7)).into();
        let short: LosslessString = format!("{}ab", "😀".repeat(6)).into();
        let masked_long = entry
            .broker
            .mask_environment(&[("VENDOR_TOKEN".into(), long.clone())])
            .unwrap();
        let masked_short = entry
            .broker
            .mask_environment(&[("VENDOR_TOKEN".into(), short.clone())])
            .unwrap();
        let long_text = concat(&[&"prefix ".into(), &long]);
        let short_text = concat(&[&"prefix ".into(), &short]);
        assert_eq!(
            entry.broker.mask_text(&long_text),
            concat(&[&"prefix ".into(), &value(&masked_long.env, "VENDOR_TOKEN")])
        );
        assert_eq!(entry.broker.mask_text(&short_text), short_text);
        assert_eq!(
            entry.broker.mask_text(&short),
            value(&masked_short.env, "VENDOR_TOKEN")
        );
    }

    #[test]
    fn builtin_trim_and_proto_property_follow_javascript_object_behavior() {
        let entry = make_entry(vec![]);
        let input = env(&[
            ("GH_TOKEN", "\u{feff} secret \u{a0}"),
            ("__proto__", "own property"),
            ("PLAIN", "unchanged"),
        ]);
        let masked = entry.broker.mask_environment(&input).unwrap();
        assert_eq!(value(&masked.env, "__proto__"), "own property".into());
        let restored = entry.broker.restore_environment(&masked.env);
        assert_eq!(
            restored,
            env(&[("GH_TOKEN", "secret"), ("PLAIN", "unchanged")])
        );
    }

    #[test]
    fn cache_reuses_sorted_providers_and_separates_all_scope_dimensions() {
        let mut cache = CredentialBrokerCache::new();
        let key = CredentialBrokerKey {
            environment_id: Some("env-a".into()),
            conversation_id: Some("chat-a".into()),
            providers: vec![("vendor".into(), config())],
        };
        let first = cache.broker_for(&key).unwrap();
        assert!(Arc::ptr_eq(&first, &cache.broker_for(&key).unwrap()));
        for dimension in 0..3 {
            let mut different = key.clone();
            match dimension {
                0 => different.environment_id = Some("env-b".into()),
                1 => different.conversation_id = Some("chat-b".into()),
                _ => different.providers[0].1.url_prefixes = vec!["https://other.example".into()],
            }
            assert!(!Arc::ptr_eq(&first, &cache.broker_for(&different).unwrap()));
        }
        let mut multiple = key;
        let mut other = config();
        other.env = vec!["OTHER_TOKEN".into()];
        multiple.providers.push(("other".into(), other));
        let before = cache.broker_for(&multiple).unwrap();
        multiple.providers.reverse();
        assert!(Arc::ptr_eq(&before, &cache.broker_for(&multiple).unwrap()));
        let absent = CredentialBrokerKey {
            environment_id: None,
            conversation_id: None,
            providers: Vec::new(),
        };
        let mut empty = absent.clone();
        empty.environment_id = Some("".into());
        assert!(!Arc::ptr_eq(
            &cache.broker_for(&absent).unwrap(),
            &cache.broker_for(&empty).unwrap()
        ));
    }
}
