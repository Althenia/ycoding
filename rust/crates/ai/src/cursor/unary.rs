use super::{errors, headers, provider, transport};
use crate::{
    Error,
    auth::{Auth, Input},
    json,
    route::Executor,
};
use std::{
    collections::BTreeMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use ycoding_schema::JsonValue;

pub struct Options {
    pub base_url: String,
    pub timeout_ms: u64,
    pub telemetry_enabled: bool,
    pub headers: BTreeMap<String, String>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            base_url: "https://api2.cursor.sh".into(),
            timeout_ms: 5000,
            telemetry_enabled: false,
            headers: BTreeMap::new(),
        }
    }
}

pub async fn available_models(
    executor: &Executor,
    auth: &Auth,
    identity: &headers::Identity,
    options: &Options,
) -> Result<JsonValue, Error> {
    request(executor, auth, identity, options, "AvailableModels", "CURSOR_AVAILABLE_MODELS_TIMEOUT", r#"{"includeLongContextModels":true,"useModelParameters":true,"useCloudAgentEffortModes":true}"#).await
}

pub async fn agent_url(
    executor: &Executor,
    auth: &Auth,
    identity: &headers::Identity,
    options: &Options,
) -> Result<transport::Endpoint, Error> {
    let body = format!("{{\"telem_enabled\":{}}}", options.telemetry_enabled);
    let response = request(
        executor,
        auth,
        identity,
        options,
        "GetServerConfig",
        "CURSOR_AGENT_URL_TIMEOUT",
        &body,
    )
    .await?;
    let config = json::get(&response, "agentUrlConfig");
    let origin = config
        .and_then(|config| json::get(config, "agentnUrl"))
        .and_then(json::string)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            config
                .and_then(|config| json::get(config, "agentUrl"))
                .and_then(json::string)
        })
        .ok_or_else(|| {
            errors::protocol("GetServerConfig response missing agentUrlConfig.agentnUrl")
        })?;
    transport::Endpoint::agent(
        &origin.to_utf8().map_err(|_| {
            errors::protocol("GetServerConfig returned an invalid Cursor agent URL")
        })?,
    )
    .map_err(|_| errors::protocol("GetServerConfig returned an invalid Cursor agent URL"))
}

async fn request(
    executor: &Executor,
    auth: &Auth,
    identity: &headers::Identity,
    options: &Options,
    operation: &str,
    timeout_code: &str,
    body: &str,
) -> Result<JsonValue, Error> {
    if options.timeout_ms == 0 || options.timeout_ms > 2_147_483_647 {
        let mut error = errors::protocol(
            "Cursor unary timeout must be positive integer milliseconds within int32",
        );
        error.code = Some("CURSOR_INVALID_TIMEOUT".into());
        return Err(error);
    }
    let run = async {
        let base = reqwest::Url::parse(&options.base_url)
            .map_err(|_| Error::invalid("Cursor API base URL is invalid"))?;
        let url = reqwest::Url::parse(&format!(
            "{}/aiserver.v1.AiService/{operation}",
            base.origin().ascii_serialization()
        ))
        .map_err(|_| Error::invalid("Cursor unary URL is invalid"))?;
        let id = provider::uuid()?
            .to_utf8()
            .map_err(|_| Error::invalid("Cursor request identity is invalid"))?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::invalid("Cursor request clock precedes Unix epoch"))?
            .as_millis() as u64;
        let empty = BTreeMap::new();
        let mut headers = headers::base(
            identity,
            &id,
            now,
            if operation == "AvailableModels" {
                &options.headers
            } else {
                &empty
            },
        )?;
        headers.insert(
            "content-type",
            http::HeaderValue::from_static("application/json"),
        );
        headers.insert("accept", http::HeaderValue::from_static("application/json"));
        let headers = auth.apply(Input {
            method: "POST",
            url: url.as_str(),
            body,
            headers,
        })?;
        let response = executor
            .execute_http(
                &url,
                &headers,
                reqwest::Method::POST,
                body.as_bytes().to_vec(),
            )
            .await
            .map_err(|error| {
                if let Some(status) = error.status {
                    let classified = errors::http(status);
                    return Error {
                        reason: classified.reason,
                        authentication_kind: classified.authentication_kind,
                        provider_metadata: classified.provider_metadata,
                        ..error
                    };
                }
                errors::diagnostic(error, "transport", true, true)
            })?;
        if !response.status().is_success() {
            return Err(errors::http(response.status().as_u16()));
        }
        let bytes = response.bytes().await.map_err(|_| {
            errors::diagnostic(
                Error::transport(format!("{operation} response read failed"), "read"),
                "transport",
                true,
                true,
            )
        })?;
        ycoding_schema::parse_json(
            std::str::from_utf8(&bytes)
                .map_err(|_| errors::protocol("Cursor unary returned malformed JSON"))?,
        )
        .map_err(|_| errors::protocol("Cursor unary returned malformed JSON"))
    };
    tokio::time::timeout(Duration::from_millis(options.timeout_ms), run)
        .await
        .map_err(|_| {
            errors::diagnostic(
                Error {
                    code: Some(timeout_code.into()),
                    ..Error::transport(
                        format!("{operation} timed out after {}ms", options.timeout_ms),
                        "timeout",
                    )
                },
                "transport",
                true,
                true,
            )
        })?
}
