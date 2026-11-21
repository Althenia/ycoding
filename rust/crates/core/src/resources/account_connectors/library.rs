use super::library_reservations::Operation;
use super::{BoxFuture, Failure, LosslessString, Prepared, Value, object, text};
use crate::cca::value::{JsonObject, parse_json, stringify_json};
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use std::{sync::Arc, time::Duration};
use url::Url;

pub(super) const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const ORIGIN: &str = "https://chatgpt.com";

pub(super) type Exchange = Arc<
    dyn Fn(reqwest::Request) -> BoxFuture<'static, Result<reqwest::Response, ()>> + Send + Sync,
>;

pub(super) struct Transport {
    client: reqwest::Client,
    exchange: Exchange,
}

impl Transport {
    pub(super) fn new() -> Result<Self, Failure> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .https_only(true)
            .timeout(Duration::from_millis(120_000))
            .build()
            .map_err(|_| Failure::Invalid)?;
        let http = client.clone();
        let exchange: Exchange = Arc::new(move |request| {
            let http = http.clone();
            Box::pin(async move { http.execute(request).await.map_err(|_| ()) })
        });
        Ok(Self { client, exchange })
    }

    #[cfg(test)]
    pub(super) fn with_exchange(exchange: Exchange) -> Self {
        let mut transport = Self::new().unwrap();
        transport.exchange = exchange;
        transport
    }

    async fn send(
        &self,
        operation: &Operation<'_>,
        request: reqwest::Request,
    ) -> Result<reqwest::Response, Failure> {
        operation.check().await?;
        let response = operation
            .io(async {
                operation.dispatch();
                (self.exchange)(request).await
            })
            .await?;
        if !response.status().is_success() {
            return Err(Failure::Rejected(response.status().as_u16()));
        }
        Ok(response)
    }

    async fn native(
        &self,
        operation: &Operation<'_>,
        route: &str,
        body: Vec<u8>,
        mime: &str,
    ) -> Result<reqwest::Response, Failure> {
        if !native_route("POST", route) {
            return Err(Failure::Invalid);
        }
        let prepared = operation.current().await?;
        let request = self
            .client
            .post(format!("{ORIGIN}/backend-api{route}"))
            .headers(native_headers(&prepared, mime)?)
            .body(body)
            .build()
            .map_err(|_| Failure::Invalid)?;
        self.send(operation, request).await
    }

    pub(super) async fn create(
        &self,
        operation: &Operation<'_>,
        name: &LosslessString,
        mime: &LosslessString,
        bytes: usize,
    ) -> Result<Created, Failure> {
        let response = self
            .native(
                operation,
                "/files",
                stringify_json(&create_body(name, mime, bytes)).into_bytes(),
                "application/json",
            )
            .await?;
        let bytes = read_body(operation, response).await?;
        let value = parse_json(&String::from_utf8_lossy(&bytes)).map_err(|_| Failure::Uncertain)?;
        let Value::Object(value) = value else {
            return Err(Failure::Uncertain);
        };
        let id = string(&value, "file_id")?;
        if !identifier(&id) {
            return Err(Failure::Uncertain);
        }
        let url = string(&value, "upload_url")?
            .to_utf8()
            .map_err(|_| Failure::Uncertain)?;
        let headers = match value.get(&"upload_headers".into()) {
            None | Some(Value::Null) => JsonObject::new(),
            Some(Value::Object(headers))
                if headers
                    .iter()
                    .all(|(_, value)| matches!(value, Value::String(_))) =>
            {
                headers.clone()
            }
            _ => return Err(Failure::Uncertain),
        };
        operation.check().await?;
        Ok(Created { id, url, headers })
    }

    pub(super) async fn transfer(
        &self,
        operation: &Operation<'_>,
        created: &Created,
        name: &LosslessString,
        mime: &LosslessString,
        bytes: Vec<u8>,
    ) -> Result<(), Failure> {
        operation.check().await?;
        let headers = upload_headers(created, mime)?;
        let response = match native_file_route(&created.url) {
            Some(route) if route.starts_with("/estuary/upload_content_bytes") => {
                let base = Url::parse(ORIGIN).map_err(|_| Failure::Invalid)?;
                let parsed = base.join(&created.url).map_err(|_| Failure::Invalid)?;
                let target = parsed
                    .query_pairs()
                    .find(|(name, _)| name == "upload_url")
                    .map(|(_, value)| value.into_owned())
                    .filter(|value| !value.is_empty())
                    .ok_or(Failure::Invalid)?;
                signed_destination(&target)?;
                let (body, content_type) = multipart(name, mime, &bytes, &target)?;
                self.native(operation, &route, body, &content_type).await?
            }
            _ => {
                let target = signed_destination(&created.url)?;
                let request = self
                    .client
                    .put(target)
                    .headers(headers)
                    .body(bytes)
                    .build()
                    .map_err(|_| Failure::Invalid)?;
                self.send(operation, request).await?
            }
        };
        drop(response);
        operation.check().await
    }

    pub(super) async fn finalize(
        &self,
        operation: &Operation<'_>,
        id: &LosslessString,
        name: &LosslessString,
        mime: &LosslessString,
    ) -> Result<Value, Failure> {
        let response = self
            .native(
                operation,
                "/files/process_upload_stream",
                stringify_json(&finalize_body(id, name, mime)).into_bytes(),
                "application/json",
            )
            .await?;
        let bytes = read_body(operation, response).await?;
        let reply = completion(&bytes, id, name)?;
        operation.check().await?;
        Ok(reply)
    }
}

pub(super) struct Created {
    pub id: LosslessString,
    url: String,
    headers: JsonObject,
}

fn native_headers(prepared: &Prepared, mime: &str) -> Result<HeaderMap, Failure> {
    let mut headers = HeaderMap::new();
    let mut authorization = HeaderValue::from_str(&format!("Bearer {}", prepared.access))
        .map_err(|_| Failure::Invalid)?;
    authorization.set_sensitive(true);
    let mut account = HeaderValue::from_str(&prepared.account).map_err(|_| Failure::Invalid)?;
    account.set_sensitive(true);
    headers.insert("authorization", authorization);
    headers.insert("chatgpt-account-id", account);
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(mime).map_err(|_| Failure::Invalid)?,
    );
    for (name, value) in ycoding_ai::openai_codex::headers() {
        headers.insert(
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| Failure::Invalid)?,
            HeaderValue::from_str(&value).map_err(|_| Failure::Invalid)?,
        );
    }
    Ok(headers)
}

pub(super) fn native_route(method: &str, route: &str) -> bool {
    method == "POST"
        && (matches!(route, "/files" | "/files/process_upload_stream")
            || (route.split_once('?').map_or(route, |(path, _)| path)
                == "/estuary/upload_content_bytes"
                && !route.contains('#')))
}

pub(super) fn signed_destination(value: &str) -> Result<Url, Failure> {
    let url = Url::parse(value).map_err(|_| Failure::Invalid)?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !url.host_str().is_some_and(|host| {
            [
                ".blob.core.windows.net",
                ".s3.amazonaws.com",
                ".oaiusercontent.com",
            ]
            .iter()
            .any(|suffix| host.ends_with(suffix))
        })
    {
        return Err(Failure::Invalid);
    }
    Ok(url)
}

pub(super) fn native_file_route(value: &str) -> Option<String> {
    let base = Url::parse(ORIGIN).ok()?;
    let url = base.join(value).ok()?;
    if url.origin() != base.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let path = url
        .path()
        .strip_prefix("/backend-api")
        .filter(|path| path.starts_with('/'))
        .unwrap_or(url.path());
    if !matches!(
        path,
        "/estuary/upload_content_bytes" | "/estuary/content" | "/files/library/content_download"
    ) {
        return None;
    }
    Some(format!(
        "{path}{}",
        url.query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    ))
}

fn upload_headers(created: &Created, mime: &LosslessString) -> Result<HeaderMap, Failure> {
    let mime = mime.as_str().ok_or(Failure::Invalid)?;
    let base = Url::parse(ORIGIN).map_err(|_| Failure::Invalid)?;
    let aws = base.join(&created.url).is_ok_and(|url| {
        url.query_pairs()
            .any(|(key, _)| key.eq_ignore_ascii_case("x-amz-algorithm"))
    });
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(mime).map_err(|_| Failure::Invalid)?,
    );
    if !aws {
        headers.insert("x-ms-blob-type", HeaderValue::from_static("BlockBlob"));
        headers.insert("x-ms-version", HeaderValue::from_static("2020-04-08"));
        headers.insert(
            "x-ms-blob-content-type",
            HeaderValue::from_str(mime).map_err(|_| Failure::Invalid)?,
        );
    }
    for (name, value) in created.headers.iter() {
        let name = name.as_str().ok_or(Failure::Invalid)?.to_ascii_lowercase();
        let allowed = name == "content-type"
            || ["x-ms-", "x-amz-"].iter().any(|prefix| {
                name.strip_prefix(prefix).is_some_and(|suffix| {
                    !suffix.is_empty()
                        && suffix.bytes().all(|byte| {
                            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                        })
                })
            });
        if !allowed {
            return Err(Failure::Invalid);
        }
        let Value::String(value) = value else {
            return Err(Failure::Invalid);
        };
        headers.insert(
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| Failure::Invalid)?,
            HeaderValue::from_str(value.as_str().ok_or(Failure::Invalid)?)
                .map_err(|_| Failure::Invalid)?,
        );
    }
    Ok(headers)
}

fn multipart(
    name: &LosslessString,
    mime: &LosslessString,
    bytes: &[u8],
    target: &str,
) -> Result<(Vec<u8>, String), Failure> {
    let name = name.as_str().ok_or(Failure::Invalid)?.replace('"', "%22");
    let mime = mime.as_str().ok_or(Failure::Invalid)?;
    let mut boundary = format!("----ycoding-{}", crate::cca::encoding::uuid_v4());
    while bytes
        .windows(boundary.len())
        .any(|part| part == boundary.as_bytes())
        || target.contains(&boundary)
    {
        boundary = format!("----ycoding-{}", crate::cca::encoding::uuid_v4());
    }
    let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"upload_url\"\r\n\r\n{target}\r\n--{boundary}--\r\n").as_bytes());
    Ok((body, format!("multipart/form-data; boundary={boundary}")))
}

pub(super) fn create_body(name: &LosslessString, mime: &LosslessString, bytes: usize) -> Value {
    object([
        ("entry_surface", text("codex_library_upload")),
        ("file_name", Value::String(name.clone())),
        ("file_size", Value::Number(bytes as f64)),
        ("client_resolved_mime_type", Value::String(mime.clone())),
        ("mime_resolution_source", text("declared_mime")),
        ("mime_type", Value::String(mime.clone())),
        ("reset_rate_limits", Value::Bool(false)),
        ("supports_direct_azure_multipart", Value::Bool(false)),
        (
            "timezone_offset_min",
            Value::Number((-chrono::Local::now().offset().local_minus_utc() / 60) as f64),
        ),
        ("upload_source", text("codex_library_upload")),
        ("use_case", text("my_files")),
        ("store_in_library", Value::Bool(true)),
        ("library_persistence_mode", text("opportunistic")),
    ])
}

pub(super) fn finalize_body(
    id: &LosslessString,
    name: &LosslessString,
    mime: &LosslessString,
) -> Value {
    object([
        ("entry_surface", text("codex_library_upload")),
        ("file_id", Value::String(id.clone())),
        ("file_name", Value::String(name.clone())),
        ("index_for_retrieval", Value::Bool(true)),
        ("library_persistence_mode", text("opportunistic")),
        (
            "metadata",
            object([("store_in_library", Value::Bool(true))]),
        ),
        ("mime_type", Value::String(mime.clone())),
        ("upload_source", text("codex_library_upload")),
        ("use_case", text("my_files")),
    ])
}

async fn read_body(
    operation: &Operation<'_>,
    mut response: reqwest::Response,
) -> Result<Vec<u8>, Failure> {
    if response
        .content_length()
        .is_some_and(|length| length > RESPONSE_LIMIT as u64)
    {
        return Err(Failure::Uncertain);
    }
    let mut bytes = Vec::new();
    loop {
        let next = operation
            .io(async { response.chunk().await.map_err(|_| ()) })
            .await?;
        let Some(chunk) = next else {
            break;
        };
        if chunk.len() > RESPONSE_LIMIT - bytes.len() {
            return Err(Failure::Uncertain);
        }
        bytes.extend_from_slice(&chunk);
    }
    operation.check().await?;
    Ok(bytes)
}

fn string(object: &JsonObject, name: &str) -> Result<LosslessString, Failure> {
    match object.get(&name.into()) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(Failure::Uncertain),
    }
}

fn identifier(value: &LosslessString) -> bool {
    !matches!(value.as_str(), Some("." | ".."))
        && (1..=512).contains(&value.code_units().count())
        && value.code_units().all(|unit| {
            unit <= 0x7f
                && ((unit as u8).is_ascii_alphanumeric() || b"._:~-".contains(&(unit as u8)))
        })
}

pub(super) fn completion(
    bytes: &[u8],
    file_id: &LosslessString,
    name: &LosslessString,
) -> Result<Value, Failure> {
    if bytes.len() > RESPONSE_LIMIT {
        return Err(Failure::Uncertain);
    }
    let source = String::from_utf8_lossy(bytes);
    let mut completed = false;
    let mut ready = None;
    for line in source.split('\n').filter(|line| !line.trim().is_empty()) {
        let Value::Object(event) = parse_json(line).map_err(|_| Failure::Uncertain)? else {
            return Err(Failure::Uncertain);
        };
        let kind = string(&event, "event")?;
        if kind.as_str().is_some_and(|kind| {
            ["error", "failed", "cancelled"]
                .iter()
                .any(|suffix| kind.ends_with(suffix))
        }) {
            return Err(Failure::Uncertain);
        }
        let own = match event.get(&"file_id".into()) {
            None => false,
            Some(Value::String(id)) => id == file_id,
            _ => return Err(Failure::Uncertain),
        };
        let extra = match event.get(&"extra".into()) {
            None | Some(Value::Null) => None,
            Some(Value::Object(extra)) => Some(extra),
            _ => return Err(Failure::Uncertain),
        };
        let mut library_id = None;
        let mut library_name = None;
        if let Some(extra) = extra {
            if let Some(value) = extra.get(&"metadata_object_id".into()) {
                let Value::String(value) = value else {
                    return Err(Failure::Uncertain);
                };
                if !identifier(value) {
                    return Err(Failure::Uncertain);
                }
                library_id = Some(value.clone());
            }
            if let Some(value) = extra.get(&"library_file_name".into()) {
                let Value::String(value) = value else {
                    return Err(Failure::Uncertain);
                };
                library_name = Some(value.clone());
            }
            if let Some(value) = extra.get(&"library_persistence_result".into()) {
                let Value::String(value) = value else {
                    return Err(Failure::Uncertain);
                };
                if own && value == &LosslessString::from("temporary") {
                    return Err(Failure::Uncertain);
                }
            }
        }
        if own {
            completed |= kind == LosslessString::from("file.processing.completed");
            if ready.is_none()
                && let Some(id) = library_id
            {
                ready = Some((id, library_name.unwrap_or_else(|| name.clone())));
            }
        }
    }
    let (library_id, name) = ready.filter(|_| completed).ok_or(Failure::Uncertain)?;
    Ok(object([(
        "results",
        Value::Array(vec![object([
            ("operation", text("create_library_file")),
            ("status", text("succeeded")),
            ("file_id", Value::String(file_id.clone())),
            ("library_file_id", Value::String(library_id)),
            ("file_name", Value::String(name)),
        ])]),
    )]))
}
