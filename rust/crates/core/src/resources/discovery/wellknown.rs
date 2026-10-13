use std::{collections::BTreeMap, fmt};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, domain, parse_json,
    stringify_json,
};
use ycoding_store::{resources, session::Document};
pub const SOURCES_KEY: &str = "wellknown:sources";
#[derive(Clone, Debug, PartialEq)]
pub struct Auth {
    pub command: Vec<LosslessString>,
    pub env: LosslessString,
}
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteConfig {
    pub url: LosslessString,
    pub headers: Option<JsonObject>,
}
#[derive(Clone, PartialEq)]
pub struct Manifest {
    pub auth: Option<Auth>,
    pub config: Option<JsonValue>,
    pub remote_config: Option<RemoteConfig>,
}
#[derive(Clone, PartialEq)]
pub struct Entry {
    pub origin: String,
    pub integration_id: String,
    pub manifest: Manifest,
}
impl fmt::Debug for Entry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WellKnown.Entry([redacted])")
    }
}
#[derive(Debug)]
pub enum Error {
    Http,
    InvalidManifest,
    MissingAuth,
    UnsupportedExecutable(String),
    Store(ycoding_store::Error),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http => f.write_str("Failed to load wellknown configuration"),
            Self::InvalidManifest => f.write_str("Invalid wellknown manifest or configuration"),
            Self::MissingAuth => f.write_str("No authentication method found"),
            Self::UnsupportedExecutable(message) => f.write_str(message),
            Self::Store(_) => f.write_str("Wellknown source storage operation failed"),
        }
    }
}
impl std::error::Error for Error {}
impl From<ycoding_store::Error> for Error {
    fn from(e: ycoding_store::Error) -> Self {
        Self::Store(e)
    }
}
pub struct Service {
    entries: Vec<Entry>,
    store: ycoding_store::Client,
    http: reqwest::Client,
    env: BTreeMap<String, String>,
    revision: u64,
}
impl Service {
    pub fn new(store: ycoding_store::Client, env: BTreeMap<String, String>) -> Result<Self, Error> {
        Ok(Self {
            entries: Vec::new(),
            store,
            http: reqwest::Client::builder()
                .retry(reqwest::retry::never())
                .build()
                .map_err(|_| Error::Http)?,
            env,
            revision: 0,
        })
    }
    pub async fn inspect(&self, origin: &str) -> Result<Entry, Error> {
        let origin = origin.trim_end_matches('/');
        let url = format!("{origin}/.well-known/ycoding");
        let value = self
            .fetch(
                self.http
                    .get(url)
                    .header(reqwest::header::ACCEPT, "application/json"),
            )
            .await?;
        let object = object(&value)?;
        let auth = object
            .get(&"auth".into())
            .map(|v| {
                let o = self::object(v)?;
                Ok::<_, Error>(Auth {
                    command: Vec::<LosslessString>::decode(required(o, "command")?)
                        .map_err(|_| Error::InvalidManifest)?,
                    env: LosslessString::decode(required(o, "env")?)
                        .map_err(|_| Error::InvalidManifest)?,
                })
            })
            .transpose()?;
        let config = object
            .get(&"config".into())
            .map(|v| {
                if *v == JsonValue::Null {
                    Ok(JsonValue::Null)
                } else {
                    config(v)
                }
            })
            .transpose()?;
        let remote_config = object
            .get(&"remote_config".into())
            .map(|v| {
                let o = self::object(v)?;
                let headers = o
                    .get(&"headers".into())
                    .map(self::object)
                    .transpose()?
                    .map(|o| {
                        o.iter()
                            .map(|(k, v)| {
                                Ok((
                                    k.clone(),
                                    LosslessString::decode(v)
                                        .map_err(|_| Error::InvalidManifest)?
                                        .encode(),
                                ))
                            })
                            .collect::<Result<Vec<_>, Error>>()
                            .map(|entries| {
                                let mut headers = JsonObject::new();
                                for (k, v) in entries {
                                    headers.insert(k, v);
                                }
                                headers
                            })
                    })
                    .transpose()?;
                Ok::<_, Error>(RemoteConfig {
                    url: LosslessString::decode(required(o, "url")?)
                        .map_err(|_| Error::InvalidManifest)?,
                    headers,
                })
            })
            .transpose()?;
        Ok(Entry {
            origin: origin.into(),
            integration_id: origin.into(),
            manifest: Manifest {
                auth,
                config,
                remote_config,
            },
        })
    }
    pub async fn resolve(
        &self,
        entry: &Entry,
        variables: &BTreeMap<String, String>,
    ) -> Result<Vec<JsonValue>, Error> {
        let mut configs = entry
            .manifest
            .config
            .iter()
            .filter(|v| **v != JsonValue::Null)
            .cloned()
            .collect::<Vec<_>>();
        if let Some(remote) = &entry.manifest.remote_config {
            let substitute = |value: &LosslessString| {
                substitute(
                    &String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>()),
                    variables,
                    &self.env,
                )
            };
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                reqwest::header::ACCEPT,
                reqwest::header::HeaderValue::from_static("application/json"),
            );
            if let Some(configured) = &remote.headers {
                for (key, value) in configured.iter() {
                    let value =
                        LosslessString::decode(value).map_err(|_| Error::InvalidManifest)?;
                    let bytes = substitute(&value)
                        .encode_utf16()
                        .map(u8::try_from)
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|_| Error::Http)?;
                    let start = bytes
                        .iter()
                        .position(|b| !b" \t".contains(b))
                        .unwrap_or(bytes.len());
                    let end = bytes
                        .iter()
                        .rposition(|b| !b" \t".contains(b))
                        .map_or(start, |i| i + 1);
                    headers.insert(
                        reqwest::header::HeaderName::from_bytes(text(key)?.as_bytes())
                            .map_err(|_| Error::Http)?,
                        reqwest::header::HeaderValue::from_bytes(&bytes[start..end])
                            .map_err(|_| Error::Http)?,
                    );
                }
            }
            let request = self.http.get(substitute(&remote.url)).headers(headers);
            let remote = self.fetch(request).await?;
            let remote = config(&remote)?;
            let nested = object(&remote)?
                .get(&"config".into())
                .and_then(|v| config(v).ok());
            configs.push(nested.unwrap_or(remote));
        }
        for config in &configs {
            let decoded =
                super::super::config::decode_document(&stringify_json(config), &entry.origin);
            if decoded.info.is_none()
                && let Some(diagnostic) = decoded
                    .diagnostics
                    .iter()
                    .find(|d| d.reason.0 == "removed-keys".into() && d.fail_closed == Some(true))
            {
                return Err(Error::UnsupportedExecutable(
                    diagnostic
                        .message
                        .to_utf8()
                        .map_err(|_| Error::InvalidManifest)?,
                ));
            }
        }
        Ok(configs)
    }
    pub async fn entries(&mut self) -> Result<Vec<Entry>, Error> {
        let mut entries = Vec::new();
        for origin in self.origins()? {
            let entry = match self.entries.iter().find(|e| e.origin == origin) {
                Some(e) => e.clone(),
                None => self.inspect(&origin).await?,
            };
            entries.push(entry);
        }
        self.entries = unique(&entries);
        Ok(entries)
    }
    pub fn snapshot(&self) -> &[Entry] {
        &self.entries
    }
    pub async fn refresh(&mut self) -> Result<bool, Error> {
        let origins = self.origins()?;
        if origins.is_empty() {
            return Ok(false);
        }
        let mut entries = Vec::new();
        for origin in origins {
            entries.push(self.inspect(&origin).await?);
        }
        let entries = unique(&entries);
        if entries.len() == self.entries.len()
            && entries.iter().all(|next| {
                self.entries
                    .iter()
                    .find(|old| old.origin == next.origin)
                    .is_some_and(|old| same_manifest(&old.manifest, &next.manifest))
            })
        {
            return Ok(false);
        }
        self.entries = entries;
        self.revision += 1;
        Ok(true)
    }
    pub async fn add(&mut self, origin: &str, now: i64) -> Result<Entry, Error> {
        let origin = origin.trim_end_matches('/');
        let entry = self.inspect(origin).await?;
        if entry.manifest.auth.is_none() {
            return Err(Error::MissingAuth);
        }
        let mut origins = self.origins()?;
        if !origins.iter().any(|item| item == origin) {
            origins.push(origin.into());
        }
        self.persist(origins, now).await?;
        if let Some(current) = self.entries.iter_mut().find(|e| e.origin == origin) {
            *current = entry.clone();
        } else {
            self.entries.push(entry.clone());
        }
        self.revision += 1;
        Ok(entry)
    }
    pub async fn remove(&mut self, origin: &str, now: i64) -> Result<(), Error> {
        let origin = origin.trim_end_matches('/');
        let origins = self
            .origins()?
            .into_iter()
            .filter(|s| s != origin)
            .collect();
        self.persist(origins, now).await?;
        self.entries.retain(|e| e.origin != origin);
        self.revision += 1;
        Ok(())
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    fn origins(&self) -> Result<Vec<String>, Error> {
        let value = resources::get_kv(&self.store.snapshot()?, &SOURCES_KEY.into())?;
        let Some(value) = value else {
            return Ok(Vec::new());
        };
        let Ok(origins) = Vec::<LosslessString>::decode(value.value()) else {
            return Ok(Vec::new());
        };
        origins.iter().map(text).collect()
    }
    async fn persist(&self, origins: Vec<String>, now: i64) -> Result<(), Error> {
        let value = Document::<domain::Json>::new(
            origins
                .iter()
                .map(|s| LosslessString::from(s.as_str()))
                .collect::<Vec<_>>()
                .encode(),
        )?;
        self.store
            .submit(move |tx| resources::set_kv(tx, &SOURCES_KEY.into(), &value, now))?
            .await?;
        Ok(())
    }
    async fn fetch(&self, request: reqwest::RequestBuilder) -> Result<JsonValue, Error> {
        let bytes = request
            .send()
            .await
            .map_err(|_| Error::Http)?
            .error_for_status()
            .map_err(|_| Error::Http)?
            .bytes()
            .await
            .map_err(|_| Error::Http)?;
        let text = String::from_utf8_lossy(&bytes);
        parse_json(text.strip_prefix('\u{feff}').unwrap_or(&text))
            .map_err(|_| Error::InvalidManifest)
    }
}

fn object(value: &JsonValue) -> Result<&ycoding_schema::JsonObject, Error> {
    match value {
        JsonValue::Object(o) => Ok(o),
        _ => Err(Error::InvalidManifest),
    }
}
fn required<'a>(o: &'a ycoding_schema::JsonObject, key: &str) -> Result<&'a JsonValue, Error> {
    o.get(&key.into()).ok_or(Error::InvalidManifest)
}
fn text(value: &LosslessString) -> Result<String, Error> {
    value.to_utf8().map_err(|_| Error::InvalidManifest)
}
fn config(value: &JsonValue) -> Result<JsonValue, Error> {
    object(value)?;
    domain::Json::decode(value).map_err(|_| Error::InvalidManifest)?;
    Ok(value.clone())
}
fn unique(entries: &[Entry]) -> Vec<Entry> {
    entries.iter().fold(Vec::new(), |mut entries, entry| {
        if let Some(current) = entries
            .iter_mut()
            .find(|e: &&mut Entry| e.origin == entry.origin)
        {
            *current = entry.clone();
        } else {
            entries.push(entry.clone());
        }
        entries
    })
}
fn substitute(
    value: &str,
    variables: &BTreeMap<String, String>,
    env: &BTreeMap<String, String>,
) -> String {
    let mut output = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.find("{env:") {
        output.push_str(&remaining[..start]);
        let token = &remaining[start + 5..];
        let Some(end) = token.find('}') else {
            output.push_str(&remaining[start..]);
            return output;
        };
        if end == 0 {
            output.push_str("{env:}");
            remaining = &token[1..];
            continue;
        }
        output.push_str(
            variables
                .get(&token[..end])
                .or_else(|| env.get(&token[..end]))
                .map_or("", String::as_str),
        );
        remaining = &token[end + 1..];
    }
    output.push_str(remaining);
    output
}
fn same_manifest(a: &Manifest, b: &Manifest) -> bool {
    a.auth == b.auth
        && match (&a.remote_config, &b.remote_config) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                a.url == b.url
                    && match (&a.headers, &b.headers) {
                        (None, None) => true,
                        (Some(a), Some(b)) => {
                            same_json(&JsonValue::Object(a.clone()), &JsonValue::Object(b.clone()))
                        }
                        _ => false,
                    }
            }
            _ => false,
        }
        && match (&a.config, &b.config) {
            (None, None) => true,
            (Some(a), Some(b)) => same_json(a, b),
            _ => false,
        }
}
fn same_json(a: &JsonValue, b: &JsonValue) -> bool {
    match (a, b) {
        (JsonValue::Number(a), JsonValue::Number(b)) => a.to_bits() == b.to_bits(),
        (JsonValue::Array(a), JsonValue::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_json(a, b))
        }
        (JsonValue::Object(a), JsonValue::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|b| same_json(value, b)))
        }
        _ => a == b,
    }
}
