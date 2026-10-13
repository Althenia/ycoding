use crate::{
    Error,
    auth::{Auth, Input},
    media,
};
use reqwest::{
    Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub machine_id: String,
    pub mac_machine_id: Option<String>,
    pub client_version: String,
}
pub fn checksum(identity: &Identity, milliseconds: u64) -> String {
    let bucket = (milliseconds / 1_000_000) as u32;
    let mut bytes = [
        (bucket >> 8) as u8,
        bucket as u8,
        (bucket >> 24) as u8,
        (bucket >> 16) as u8,
        (bucket >> 8) as u8,
        bucket as u8,
    ];
    let mut prior = 165;
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = (*byte ^ prior).wrapping_add(index as u8);
        prior = *byte;
    }
    let prefix = media::encode(&bytes);
    let suffix = identity
        .mac_machine_id
        .as_ref()
        .filter(|value| !value.is_empty())
        .map(|value| format!("/{value}"))
        .unwrap_or_default();
    format!(
        "{}{suffix}",
        prefix.trim_end_matches('=').to_owned() + &identity.machine_id
    )
}
pub fn agent_origin(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    let url = Url::parse(
        &if lower.starts_with("http://") || lower.starts_with("https://") {
            raw.to_owned()
        } else {
            format!("https://{raw}")
        },
    )
    .ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?;
    let prefix = host.strip_suffix(".cursor.sh")?;
    if prefix.is_empty()
        || prefix.split('.').any(|label| {
            label.is_empty()
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return None;
    }
    Some(url.origin().ascii_serialization())
}
pub fn run(
    auth: &Auth,
    identity: &Identity,
    request_id: &str,
    milliseconds: u64,
    url: &str,
    extra: &BTreeMap<String, String>,
) -> Result<HeaderMap, Error> {
    let mut headers = base(identity, request_id, milliseconds, extra)?;
    for (key, value) in [
        ("content-type", "application/connect+proto"),
        ("connect-accept-encoding", "gzip,br"),
        ("x-cursor-streaming", "true"),
        ("user-agent", "connect-es/1.6.1"),
    ] {
        headers.insert(
            HeaderName::from_static(key),
            HeaderValue::from_static(value),
        );
    }
    auth.apply(Input {
        method: "POST",
        url,
        body: "",
        headers,
    })
}

pub(crate) fn base(
    identity: &Identity,
    request_id: &str,
    milliseconds: u64,
    extra: &BTreeMap<String, String>,
) -> Result<HeaderMap, Error> {
    let mut headers = HeaderMap::new();
    for (key, value) in [
        ("connect-protocol-version", "1"),
        ("x-cursor-client-type", "cli"),
        ("x-cursor-client-version", identity.client_version.as_str()),
        (
            "x-cursor-checksum",
            checksum(identity, milliseconds).as_str(),
        ),
        ("x-ghost-mode", "true"),
    ] {
        headers.insert(
            HeaderName::from_static(key),
            HeaderValue::from_str(value)
                .map_err(|_| Error::invalid("Cursor identity header is invalid"))?,
        );
    }
    for (key, value) in extra {
        headers.insert(
            HeaderName::from_bytes(key.as_bytes())
                .map_err(|_| Error::invalid("Cursor extra header name is invalid"))?,
            HeaderValue::from_str(value)
                .map_err(|_| Error::invalid("Cursor extra header value is invalid"))?,
        );
    }
    headers.insert(
        "x-request-id",
        HeaderValue::from_str(request_id)
            .map_err(|_| Error::invalid("Cursor request identity is invalid"))?,
    );
    Ok(headers)
}
