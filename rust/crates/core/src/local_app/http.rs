use super::{
    App, Body, Cancellation, Incoming, Outgoing, Response, ResultFuture, Transport, failure,
    validation,
};
use flate2::write::GzDecoder;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::{
    collections::BTreeMap,
    io::{self, Write},
};
use ycoding_schema::local_app::{Category, Failure, Method};

const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const REQUEST_HEADERS: [&str; 7] = [
    "accept",
    "accept-language",
    "content-type",
    "if-none-match",
    "if-modified-since",
    "range",
    "if-range",
];
const RESPONSE_HEADERS: [&str; 16] = [
    "content-type",
    "cache-control",
    "etag",
    "last-modified",
    "expires",
    "vary",
    "accept-ranges",
    "content-range",
    "content-language",
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
    "permissions-policy",
    "content-disposition",
];

pub struct HttpTransport {
    client: reqwest::Client,
}
impl HttpTransport {
    pub fn new() -> Result<Self, Failure> {
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .no_gzip()
                .no_brotli()
                .no_deflate()
                .no_zstd()
                .build()
                .map_err(|_| failure(Category::UpstreamUnavailable))?,
        })
    }
}
struct HttpBody(reqwest::Response);
impl Body for HttpBody {
    fn next(&mut self) -> ResultFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move {
            self.0
                .chunk()
                .await
                .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
                .map_err(|_| failure(Category::UpstreamUnavailable))
        })
    }
}
impl Transport for HttpTransport {
    fn send(&self, request: Outgoing, cancellation: Cancellation) -> ResultFuture<'_, Incoming> {
        Box::pin(async move {
            let literal = request
                .url
                .strip_prefix("http://127.0.0.1:")
                .or_else(|| request.url.strip_prefix("http://[::1]:"))
                .ok_or_else(|| failure(Category::UpstreamUnavailable))?;
            let port = literal
                .split('/')
                .next()
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|port| *port != 0)
                .ok_or_else(|| failure(Category::UpstreamUnavailable))?;
            let url = url::Url::parse(&request.url)
                .map_err(|_| failure(Category::UpstreamUnavailable))?;
            if !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
                || url.port_or_known_default() != Some(port)
            {
                return Err(failure(Category::UpstreamUnavailable));
            }
            let mut pending = self
                .client
                .request(
                    reqwest::Method::from_bytes(request.method.as_str().as_bytes())
                        .map_err(|_| failure(Category::UpstreamUnavailable))?,
                    url,
                )
                .headers(headers(&request.headers, Category::Forbidden)?);
            if let Some(body) = request.body {
                pending = pending.body(body);
            }
            let response = tokio::select! {biased;_=cancellation.cancelled()=>return Err(failure(Category::UpstreamUnavailable)),response=pending.send()=>response.map_err(|_|failure(Category::UpstreamUnavailable))?};
            let mut output = BTreeMap::new();
            for name in response.headers().keys() {
                if !RESPONSE_HEADERS.contains(&name.as_str())
                    && !matches!(
                        name.as_str(),
                        "content-length" | "content-encoding" | "location"
                    )
                {
                    continue;
                }
                let values = response
                    .headers()
                    .get_all(name)
                    .iter()
                    .map(header_text)
                    .collect::<Vec<_>>();
                output.insert(name.as_str().to_owned(), values.join(", "));
            }
            Ok(Incoming {
                status: response.status().as_u16(),
                headers: output,
                body: Box::new(HttpBody(response)),
            })
        })
    }
}

fn headers(input: &BTreeMap<String, String>, category: Category) -> Result<HeaderMap, Failure> {
    let mut headers = HeaderMap::new();
    for (key, value) in input {
        headers.insert(
            HeaderName::from_bytes(key.as_bytes()).map_err(|_| failure(category))?,
            HeaderValue::from_bytes(
                &value
                    .chars()
                    .map(|value| u8::try_from(u32::from(value)).map_err(|_| failure(category)))
                    .collect::<Result<Vec<_>, _>>()?,
            )
            .map_err(|_| failure(category))?,
        );
    }
    Ok(headers)
}
pub(super) fn request_headers(
    input: &BTreeMap<String, String>,
    app: &App,
) -> Result<BTreeMap<String, String>, Failure> {
    let input = headers(input, Category::Forbidden)?;
    if input.contains_key("upgrade")
        || input
            .get("connection")
            .map(header_text)
            .is_some_and(|value| {
                value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
            })
    {
        return Err(failure(Category::UnsupportedStream));
    }
    let mut output = BTreeMap::from([("accept-encoding".to_owned(), "identity".to_owned())]);
    for name in REQUEST_HEADERS {
        if let Some(value) = input.get(name) {
            output.insert(name.to_owned(), header_text(value));
        }
    }
    let Some(preview) = &app.preview else {
        return Ok(output);
    };
    if input.get("origin").map(header_text).as_deref() == Some(preview.as_str()) {
        output.insert("origin".into(), app.origin.clone());
    }
    if let Some(referer) = input.get("referer").map(header_text)
        && let Some(path) = referer.strip_prefix(&format!("{preview}/"))
    {
        let path = format!("/{path}");
        if validation::path(&path, Category::Forbidden).is_ok()
            && url::Url::parse(&referer)
                .is_ok_and(|url| url.origin().ascii_serialization() == *preview)
        {
            output.insert("referer".into(), format!("{}{path}", app.origin));
        }
    }
    Ok(output)
}

pub(super) async fn consume(
    mut response: Incoming,
    app: &App,
    path: &str,
    method: Method,
) -> Result<Response, Failure> {
    if !(200..=599).contains(&response.status) && response.status != 101 {
        return Err(failure(Category::UpstreamUnavailable));
    }
    let normalized = headers(&response.headers, Category::UpstreamUnavailable)?;
    if response.status == 101
        || normalized
            .get("content-type")
            .map(header_text)
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("text/event-stream")
            })
    {
        return Err(failure(Category::UnsupportedStream));
    }
    if normalized
        .get("content-length")
        .map(header_text)
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > MAX_RESPONSE as u64)
    {
        return Err(failure(Category::TooLarge));
    }
    let mut output = BTreeMap::new();
    for name in RESPONSE_HEADERS {
        if let Some(value) = normalized.get(name) {
            let value = header_text(value);
            if name == "content-disposition" && !disposition(&value) {
                continue;
            }
            output.insert(name.to_owned(), value);
        }
    }
    if method == Method::Head
        && !matches!(response.status, 204 | 205)
        && !normalized.contains_key("content-encoding")
        && let Some(length) = normalized.get("content-length").map(header_text)
        && canonical_length(&length)
    {
        output.insert("content-length".into(), length.to_owned());
    }
    if let Some(location) = normalized.get("location") {
        output.insert(
            "location".into(),
            redirect(&header_text(location), app, path, method, response.status)?,
        );
    }
    if method == Method::Head || matches!(response.status, 204 | 304) {
        return Ok(Response {
            status: response.status,
            headers: output,
            body: Vec::new(),
        });
    }
    let encoding = normalized
        .get("content-encoding")
        .map(header_text)
        .unwrap_or_else(|| "identity".to_owned())
        .trim()
        .to_ascii_lowercase();
    let body = if encoding == "gzip" || encoding == "x-gzip" {
        let mut decoder = GzDecoder::new(Limited::default());
        while let Some(chunk) = response.body.next().await? {
            if decoder.write_all(&chunk).is_err() {
                return Err(failure(if decoder.get_ref().overflow {
                    Category::TooLarge
                } else {
                    Category::UpstreamUnavailable
                }));
            }
        }
        if decoder.try_finish().is_err() {
            return Err(failure(if decoder.get_ref().overflow {
                Category::TooLarge
            } else {
                Category::UpstreamUnavailable
            }));
        }
        decoder
            .finish()
            .map_err(|_| failure(Category::UpstreamUnavailable))?
            .bytes
    } else if encoding == "identity" || encoding.is_empty() {
        let mut bytes = Vec::new();
        while let Some(chunk) = response.body.next().await? {
            if chunk.len() > MAX_RESPONSE.saturating_sub(bytes.len()) {
                return Err(failure(Category::TooLarge));
            }
            bytes.extend_from_slice(&chunk);
        }
        bytes
    } else {
        return Err(failure(Category::UpstreamUnavailable));
    };
    output.insert("content-length".into(), body.len().to_string());
    Ok(Response {
        status: response.status,
        headers: output,
        body,
    })
}

#[derive(Default)]
struct Limited {
    bytes: Vec<u8>,
    overflow: bool,
}
fn header_text(value: &HeaderValue) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| char::from(*byte))
        .collect()
}
impl Write for Limited {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_RESPONSE.saturating_sub(self.bytes.len()) {
            self.overflow = true;
            return Err(io::ErrorKind::FileTooLarge.into());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn canonical_length(value: &str) -> bool {
    (value == "0" || !value.starts_with('0'))
        && !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value
            .parse::<u64>()
            .is_ok_and(|value| value <= 9_007_199_254_740_991)
}
fn disposition(value: &str) -> bool {
    if value.len() > 1024 {
        return false;
    }
    if matches!(value.to_ascii_lowercase().as_str(), "inline" | "attachment") {
        return true;
    }
    let Some((kind, file)) = value.split_once(';') else {
        return false;
    };
    if !matches!(kind.to_ascii_lowercase().as_str(), "inline" | "attachment") {
        return false;
    }
    let file = file.trim_start();
    if file.len() < 11
        || !file
            .get(..9)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("filename="))
    {
        return false;
    }
    let Some(name) = file[9..]
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    else {
        return false;
    };
    !name
        .bytes()
        .any(|byte| byte < 32 || byte == 127 || matches!(byte, b'"' | b'/' | b'\\'))
}

fn redirect(
    location: &str,
    app: &App,
    requested: &str,
    method: Method,
    status: u16,
) -> Result<String, Failure> {
    let category = Category::RedirectRejected;
    if location.is_empty()
        || location.starts_with("//")
        || location
            .bytes()
            .any(|byte| byte <= 32 || byte == 127 || matches!(byte, b'\\' | b'#'))
    {
        return Err(failure(category));
    }
    let absolute = location.split_once(':').is_some_and(|(scheme, _)| {
        scheme
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            && scheme
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
    });
    if absolute
        && location != app.origin
        && !location.starts_with(&format!("{}/", app.origin))
        && !location.starts_with(&format!("{}?", app.origin))
    {
        return Err(failure(category));
    }
    let suffix = if absolute {
        &location[app.origin.len()..]
    } else {
        location
    };
    let candidate = if absolute {
        if suffix.starts_with('/') {
            suffix.to_owned()
        } else {
            format!("/{suffix}")
        }
    } else if location.starts_with('/') {
        location.to_owned()
    } else {
        format!(
            "{}/{}",
            requested
                .split('?')
                .next()
                .unwrap_or("")
                .rsplit_once('/')
                .map(|(directory, _)| directory)
                .unwrap_or(""),
            location
        )
    };
    validation::path(&candidate, category)?;
    let origin = url::Url::parse(&app.origin).map_err(|_| failure(category))?;
    let base =
        url::Url::parse(&format!("{}{requested}", app.origin)).map_err(|_| failure(category))?;
    let destination = base.join(location).map_err(|_| failure(category))?;
    if destination.origin() != origin.origin()
        || !destination.username().is_empty()
        || destination.password().is_some()
        || destination.fragment().is_some()
    {
        return Err(failure(category));
    }
    let path = format!(
        "{}{}",
        destination.path(),
        destination
            .query()
            .map(|value| format!("?{value}"))
            .unwrap_or_default()
    );
    let decoded = validation::path(&path, category)?;
    let effective = if (status == 303 && method != Method::Head)
        || (matches!(status, 301 | 302) && method == Method::Post)
    {
        Method::Get
    } else {
        method
    };
    if !validation::allows(&app.metadata.routes, &decoded, effective)? {
        return Err(failure(category));
    }
    Ok(path)
}
