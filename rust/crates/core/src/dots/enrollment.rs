pub mod cca_headers;
pub mod registry;

use super::{access, native};
use std::sync::Arc;
use ycoding_schema::LosslessString;

pub const RESPONSE_BYTES: usize = 153_600;
pub const DEADLINE_MS: u64 = 10_000;
pub const EXECUTOR_URL: &str = "https://chatgpt.com/backend-api/flora/cca/executor";
pub const EXECUTOR_DEADLINE_MS: u64 = 15_000;
const LATEST_INSTANT_MS: i64 = 8_640_000_000_000_000;

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Phase {
    Enroll,
    Refresh,
}

pub struct Request {
    pub phase: Phase,
    pub credential: Arc<native::ResolvedCredential>,
    pub installation_id: String,
    pub server_name: String,
    pub server_id: Option<String>,
}

pub struct Response {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: String,
}

#[cfg(unix)]
pub fn machine_name() -> Option<String> {
    let mut buffer = [0_u8; 256];
    if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } != 0 {
        return None;
    }
    let end = buffer.iter().position(|byte| *byte == 0)?;
    std::str::from_utf8(&buffer[..end])
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

#[cfg(not(unix))]
pub fn machine_name() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

pub struct ExecutorRequest {
    pub credential: Arc<native::ResolvedCredential>,
    pub body: String,
}

pub struct ExecutorResponse {
    pub status: u16,
    pub challenged: bool,
    pub body: String,
}

pub type Post = Arc<dyn Fn(Request) -> native::NativeFuture<'static, Response> + Send + Sync>;
pub type ExecutorPost =
    Arc<dyn Fn(ExecutorRequest) -> native::NativeFuture<'static, ExecutorResponse> + Send + Sync>;

pub fn instant_iso(milliseconds: i64) -> Option<String> {
    let instant = chrono::DateTime::from_timestamp_millis(milliseconds)?;
    if !(0..=9999).contains(&chrono::Datelike::year(&instant)) {
        return None;
    }
    Some(instant.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

pub fn parse_instant(text: &str) -> Option<i64> {
    let milliseconds = chrono::DateTime::parse_from_rfc3339(text)
        .or_else(|_| chrono::DateTime::parse_from_rfc2822(text))
        .map(|instant| instant.timestamp_millis())
        .ok()
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc().timestamp_millis())
        })?;
    (milliseconds.abs() <= LATEST_INSTANT_MS).then_some(milliseconds)
}

pub fn post_executor(request: ExecutorRequest) -> native::NativeFuture<'static, ExecutorResponse> {
    Box::pin(post_executor_at(request, EXECUTOR_URL))
}

pub fn post(request: Request) -> native::NativeFuture<'static, Response> {
    Box::pin(async move {
        let url = match request.phase {
            Phase::Enroll => "https://chatgpt.com/backend-api/wham/remote/control/server/enroll",
            Phase::Refresh => "https://chatgpt.com/backend-api/wham/remote/control/server/refresh",
        };
        post_at(request, url).await
    })
}

async fn post_at(request: Request, url: &str) -> Result<Response, access::Error> {
    use ycoding_ai::openai_codex;
    use ycoding_schema::{ObjectEncoder, stringify_json};
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_millis(DEADLINE_MS))
        .build()
        .map_err(|_| access::Error::Unavailable)?;
    let platform = match openai_codex::runtime_platform() {
        "darwin" => "macos",
        platform => platform,
    };
    let body = ObjectEncoder::new()
        .field("name", request.server_name.as_str())
        .field("os", platform)
        .field("arch", openai_codex::runtime_arch())
        .field("app_server_version", openai_codex::CATALOG_CLIENT_VERSION)
        .field("installation_id", request.installation_id.as_str())
        .optional(
            "server_id",
            &request.server_id.as_deref().map(LosslessString::from),
        )
        .finish();
    let mut builder = client
        .post(url)
        .bearer_auth(&request.credential.access_token)
        .header("chatgpt-account-id", &request.credential.account_id)
        .header("x-codex-installation-id", &request.installation_id)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(stringify_json(&body));
    for (name, value) in openai_codex::headers() {
        builder = builder.header(name, value);
    }
    let mut response = builder
        .send()
        .await
        .map_err(|_| access::Error::Unavailable)?;
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = read_body(&mut response).await?;
    Ok(Response {
        status,
        retry_after,
        body,
    })
}

async fn read_body(response: &mut reqwest::Response) -> Result<String, access::Error> {
    if response
        .content_length()
        .is_some_and(|length| length > RESPONSE_BYTES as u64)
    {
        return Err(access::Error::Unavailable);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| access::Error::Unavailable)?
    {
        if chunk.len() > RESPONSE_BYTES - bytes.len() {
            return Err(access::Error::Unavailable);
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| access::Error::Unavailable)
}

async fn post_executor_at(
    request: ExecutorRequest,
    url: &str,
) -> Result<ExecutorResponse, access::Error> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_millis(EXECUTOR_DEADLINE_MS))
        .build()
        .map_err(|_| access::Error::Unavailable)?;
    let mut builder = client
        .post(url)
        .bearer_auth(&request.credential.access_token)
        .header("chatgpt-account-id", &request.credential.account_id)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(request.body);
    for (name, value) in cca_headers::headers() {
        builder = builder.header(name, value);
    }
    let mut response = builder
        .send()
        .await
        .map_err(|_| access::Error::Unavailable)?;
    if response.status().is_redirection() {
        return Err(access::Error::Unavailable);
    }
    let status = response.status().as_u16();
    let challenged = response
        .headers()
        .get("cf-mitigated")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("challenge"));
    let body = read_body(&mut response).await?;
    Ok(ExecutorResponse {
        status,
        challenged,
        body,
    })
}

#[cfg(test)]
#[path = "enrollment_tests.rs"]
mod integration_tests;
