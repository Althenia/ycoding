use super::read_body;
use crate::dots::native;
use std::{sync::Arc, time::Duration};
use ycoding_schema::{JsonValue, ObjectEncoder, parse_json, stringify_json};

pub const URL: &str = "https://codex-cloud-environments.chatgpt.com/api";
pub const DEADLINE_MS: u64 = 10_000;
pub const VALIDATION_DEADLINE_MS: u64 = 10_000;
pub const EXEC_SERVER_VERSION: &str = "0.165.0-alpha.1.2";
pub const EXEC_SERVER_ORIGINATOR: &str = "codex_cli_rs";
pub const SECURITY_PROFILE: &str = "noise_hybrid_ik_v1";
pub const MAX_AUTHORIZATION_BYTES: usize = 4096;
const STREAM_HEADER: &str = "x-codex-noise-stream-id";

pub type Refresh = Arc<
    dyn Fn(String) -> native::NativeFuture<'static, Option<Arc<native::ResolvedCredential>>>
        + Send
        + Sync,
>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Http { status: u16, code: Option<String> },
    Failed(&'static str),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Registered {
    pub environment_id: String,
    pub executor_registration_id: String,
    pub url: String,
    pub security_profile: String,
}

pub fn retryable(error: &Error) -> bool {
    matches!(
        error,
        Error::Http { status: 503, code: Some(code) } if code == "registration_conflict"
    ) || matches!(
        error,
        Error::Http { status: 502, code: Some(code) } if code == "authentication_service_unavailable"
    )
}

pub fn retry_delay_ms(attempt: u32, random: f64) -> u64 {
    let base = (500u64 << attempt.min(4)).min(5_000);
    base + (random * ((base / 2 + 1) as f64)).floor() as u64
}

pub fn encode_component(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

pub fn canonical_uuid(value: &str) -> Option<String> {
    let inner = if let Some(rest) = value.strip_prefix("urn:uuid:") {
        rest
    } else if value.starts_with('{') && value.ends_with('}') && value.len() >= 2 {
        &value[1..value.len() - 1]
    } else {
        value
    };
    let hyphenated = {
        let groups = inner.split('-').collect::<Vec<_>>();
        groups.len() == 5
            && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, size)| {
                group.len() == size && group.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    };
    let hex = if hyphenated {
        inner.replace('-', "")
    } else if inner == value
        && value.len() == 32
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        value.to_owned()
    } else {
        return None;
    };
    let hex = hex.to_ascii_lowercase();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

pub fn rendezvous_url(text: &str) -> Option<String> {
    let parsed = url::Url::parse(text).ok()?;
    if parsed.scheme() != "wss" || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    (host == "chatgpt.com" || host.ends_with(".chatgpt.com")).then(|| parsed.to_string())
}

#[cfg(unix)]
fn uname() -> Option<(String, String)> {
    let mut name = unsafe { std::mem::zeroed::<libc::utsname>() };
    if unsafe { libc::uname(&mut name) } != 0 {
        return None;
    }
    let text = |field: &[libc::c_char]| {
        String::from_utf8_lossy(
            &field
                .iter()
                .take_while(|unit| **unit != 0)
                .flat_map(|unit| unit.to_ne_bytes())
                .collect::<Vec<_>>(),
        )
        .into_owned()
    };
    Some((text(&name.release), text(&name.machine)))
}

#[cfg(any(windows, test))]
const WINDOWS_ARCHITECTURE_AMD64: u16 = 9;
#[cfg(any(windows, test))]
const WINDOWS_ARCHITECTURE_ARM64: u16 = 12;

#[cfg(any(windows, test))]
fn windows_uname(
    major: u32,
    minor: u32,
    build: u32,
    architecture: u16,
) -> Option<(String, String)> {
    let machine = match architecture {
        WINDOWS_ARCHITECTURE_AMD64 => "x86_64",
        WINDOWS_ARCHITECTURE_ARM64 => "arm64",
        _ => return None,
    };
    Some((format!("{major}.{minor}.{build}"), machine.to_owned()))
}

#[cfg(windows)]
fn uname() -> Option<(String, String)> {
    use windows_sys::{
        Wdk::System::SystemServices::RtlGetVersion,
        Win32::System::SystemInformation::{GetNativeSystemInfo, OSVERSIONINFOW, SYSTEM_INFO},
    };
    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..OSVERSIONINFOW::default()
    };
    if unsafe { RtlGetVersion(&mut version) } < 0 {
        return None;
    }
    let mut system = SYSTEM_INFO::default();
    unsafe { GetNativeSystemInfo(&mut system) };
    let architecture = unsafe { system.Anonymous.Anonymous.wProcessorArchitecture };
    windows_uname(
        version.dwMajorVersion,
        version.dwMinorVersion,
        version.dwBuildNumber,
        architecture,
    )
}

#[cfg(not(any(unix, windows)))]
fn uname() -> Option<(String, String)> {
    None
}

fn mac_product_version() -> String {
    let plist = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist")
        .unwrap_or_default();
    plist
        .split_once("<key>ProductVersion</key>")
        .and_then(|(_, rest)| rest.trim_start().strip_prefix("<string>"))
        .and_then(|rest| rest.split_once("</string>"))
        .map(|(version, _)| version.trim().to_owned())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "Unknown".into())
}

fn format_user_agent(system: &str, machine: &str) -> String {
    format!("{EXEC_SERVER_ORIGINATOR}/{EXEC_SERVER_VERSION} ({system}; {machine}) unknown")
}

pub fn user_agent() -> &'static str {
    static AGENT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| {
        let (release, machine) = uname().unwrap_or_default();
        let system = if cfg!(target_os = "macos") {
            format!("Mac OS {}", mac_product_version())
        } else if cfg!(windows) {
            format!("Windows {release}")
        } else {
            format!("Linux {release}")
        };
        format_user_agent(&system, &machine)
    })
}

fn error_code(text: &str) -> Option<String> {
    let Ok(JsonValue::Object(body)) = parse_json(text) else {
        return None;
    };
    let code = |value: Option<&JsonValue>| match value {
        Some(JsonValue::Object(object)) => match object.get(&"code".into()) {
            Some(JsonValue::String(code)) => code.to_utf8().ok(),
            _ => None,
        },
        _ => None,
    };
    match body.get(&"error".into()) {
        Some(JsonValue::Null) | None => code(body.get(&"detail".into())),
        value => code(value),
    }
}

async fn post(
    url: &str,
    credential: &mut Arc<native::ResolvedCredential>,
    refresh: Option<&Refresh>,
    body: &str,
    stream_id: Option<String>,
    deadline_ms: u64,
) -> Result<(u16, String), Error> {
    let work = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::Failed("request failed"))?;
        let mut retried = false;
        loop {
            let mut builder = client
                .post(url)
                .bearer_auth(&credential.access_token)
                .header("chatgpt-account-id", &credential.account_id)
                .header("originator", EXEC_SERVER_ORIGINATOR)
                .header(reqwest::header::USER_AGENT, user_agent())
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.to_owned());
            if let Some(stream_id) = &stream_id {
                builder = builder.header(STREAM_HEADER, stream_id);
            }
            let mut response = builder
                .send()
                .await
                .map_err(|_| Error::Failed("request failed"))?;
            if response.status().is_redirection() {
                return Err(Error::Failed("request failed"));
            }
            if response.status().as_u16() == 401
                && !retried
                && let Some(refresh) = refresh
                && let Ok(Some(next)) = refresh(credential.access_token.clone()).await
                && next.access_token != credential.access_token
            {
                *credential = next;
                retried = true;
                continue;
            }
            let status = response.status().as_u16();
            let text = read_body(&mut response)
                .await
                .map_err(|_| Error::Failed("response unreadable"))?;
            return Ok::<(u16, String), Error>((status, text));
        }
    };
    tokio::time::timeout(Duration::from_millis(deadline_ms), work)
        .await
        .map_err(|_| Error::Failed("timed out or was aborted"))?
}

fn endpoint(base: &str, environment_id: &str, action: &str) -> String {
    let base = if base.ends_with('/') {
        base.to_owned()
    } else {
        format!("{base}/")
    };
    format!(
        "{base}cloud/environment/{}/{action}",
        encode_component(environment_id)
    )
}

pub async fn register(
    environment_id: &str,
    credential: &mut Arc<native::ResolvedCredential>,
    refresh: Option<&Refresh>,
    executor_public_key: JsonValue,
) -> Result<Registered, Error> {
    register_at(
        URL,
        environment_id,
        credential,
        refresh,
        executor_public_key,
    )
    .await
}

async fn register_at(
    base: &str,
    environment_id: &str,
    credential: &mut Arc<native::ResolvedCredential>,
    refresh: Option<&Refresh>,
    executor_public_key: JsonValue,
) -> Result<Registered, Error> {
    let environment_id = environment_id.trim();
    if environment_id.is_empty() {
        return Err(Error::Failed("environment id is required"));
    }
    let body = stringify_json(
        &ObjectEncoder::new()
            .field("security_profile", SECURITY_PROFILE)
            .field("executor_public_key", &executor_public_key)
            .finish(),
    );
    let (status, text) = post(
        &endpoint(base, environment_id, "register"),
        credential,
        refresh,
        &body,
        None,
        DEADLINE_MS,
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(Error::Http {
            status,
            code: error_code(&text),
        });
    }
    let Ok(JsonValue::Object(record)) = parse_json(&text) else {
        return Err(Error::Failed("registration returned an invalid payload"));
    };
    let string = |name: &str| match record.get(&name.into()) {
        Some(JsonValue::String(value)) => value.to_utf8().ok(),
        _ => None,
    };
    if string("environment_id").as_deref() != Some(environment_id) {
        return Err(Error::Failed(
            "registry returned a different environment id",
        ));
    }
    if string("security_profile").as_deref() != Some(SECURITY_PROFILE) {
        return Err(Error::Failed(
            "registry returned unsupported security profile",
        ));
    }
    let registration_id = string("executor_registration_id")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or(Error::Failed(
            "registry returned invalid executor_registration_id",
        ))?;
    let url = string("url")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or(Error::Failed("registry returned incomplete connection url"))?;
    Ok(Registered {
        environment_id: environment_id.to_owned(),
        executor_registration_id: registration_id,
        url,
        security_profile: SECURITY_PROFILE.to_owned(),
    })
}

pub async fn validate(
    environment_id: &str,
    credential: &mut Arc<native::ResolvedCredential>,
    refresh: Option<&Refresh>,
    executor_registration_id: &str,
    harness_public_key: JsonValue,
    authorization: &str,
    stream_id: &str,
) -> Result<(), Error> {
    validate_at(
        URL,
        environment_id,
        credential,
        refresh,
        executor_registration_id,
        harness_public_key,
        authorization,
        stream_id,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn validate_at(
    base: &str,
    environment_id: &str,
    credential: &mut Arc<native::ResolvedCredential>,
    refresh: Option<&Refresh>,
    executor_registration_id: &str,
    harness_public_key: JsonValue,
    authorization: &str,
    stream_id: &str,
) -> Result<(), Error> {
    if authorization.is_empty() || authorization.len() > MAX_AUTHORIZATION_BYTES {
        return Err(Error::Failed("harness key authorization length is invalid"));
    }
    let body = stringify_json(
        &ObjectEncoder::new()
            .field("executor_registration_id", executor_registration_id)
            .field("harness_public_key", &harness_public_key)
            .field("harness_key_authorization", authorization)
            .finish(),
    );
    let (status, text) = post(
        &endpoint(base, environment_id.trim(), "validate"),
        credential,
        refresh,
        &body,
        canonical_uuid(stream_id),
        VALIDATION_DEADLINE_MS,
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(Error::Http { status, code: None });
    }
    match parse_json(&text) {
        Ok(JsonValue::Object(record))
            if record.get(&"valid".into()) == Some(&JsonValue::Bool(true)) =>
        {
            Ok(())
        }
        Ok(JsonValue::Object(_)) => Err(Error::Failed("registry rejected harness key")),
        _ => Err(Error::Failed(
            "harness key validation returned unparseable JSON",
        )),
    }
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
