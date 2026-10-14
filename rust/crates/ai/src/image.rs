use crate::{
    Error,
    auth::{self, Auth},
    json::{self, get, s},
    llm::{HttpOptions, Usage},
    route::{Executor, apply_query, redact_http, request_headers},
};
use reqwest::{
    Method, Url,
    header::{HeaderMap, HeaderValue},
};
use std::{collections::BTreeMap, fmt};
use ycoding_schema::{JsonValue, LosslessString, model, provider, stringify_json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    OpenAI,
    Zai,
}
impl Kind {
    pub fn id(self) -> &'static str {
        match self {
            Self::OpenAI => "openai-images",
            Self::Zai => "zai-images",
        }
    }
    fn provider(self) -> &'static str {
        match self {
            Self::OpenAI => "openai",
            Self::Zai => "zai",
        }
    }
    fn base_url(self) -> &'static str {
        match self {
            Self::OpenAI => crate::openai_images::DEFAULT_BASE_URL,
            Self::Zai => crate::zai_images::DEFAULT_BASE_URL,
        }
    }
}
#[derive(Clone)]
pub struct Config {
    pub auth: Auth,
    pub base_url: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub http: HttpOptions,
}
impl Config {
    pub fn new(auth: Auth) -> Self {
        Self {
            auth,
            base_url: None,
            headers: BTreeMap::new(),
            http: HttpOptions::default(),
        }
    }
}
#[derive(Clone)]
pub struct Model {
    pub id: model::Id,
    pub provider: provider::Id,
    pub kind: Kind,
    pub config: Config,
}
impl Model {
    pub fn new(id: impl Into<LosslessString>, kind: Kind, config: Config) -> Self {
        Self {
            id: id.into(),
            provider: provider::Id(kind.provider().into()),
            kind,
            config,
        }
    }
    pub fn prepare(&self, request: &Request) -> Result<Prepared, Error> {
        let http = self.config.http.overlay(&request.http);
        for value in [
            &request.options,
            http.body.as_ref().unwrap_or(&json::empty()),
        ] {
            if !matches!(value, JsonValue::Object(_)) {
                return Err(Error::invalid(
                    "Image options and http.body must be JSON objects",
                ));
            }
        }
        let lowered = match self.kind {
            Kind::OpenAI => crate::openai_images::lower(request, &http)?,
            Kind::Zai => Body::json(
                "/images/generations",
                crate::zai_images::lower(request, &http)?,
            ),
        };
        let base_url = self
            .config
            .base_url
            .as_deref()
            .unwrap_or(self.kind.base_url());
        let base_url = base_url.strip_suffix('/').unwrap_or(base_url);
        let url = Url::parse(&format!("{base_url}{}", lowered.path))
            .map_err(|_| Error::invalid("Invalid provider endpoint URL"))?;
        let url = apply_query(url, http.query.iter());
        let mut headers = request_headers(self.config.headers.iter().chain(http.headers.iter()))?;
        if lowered.content_type.starts_with("multipart/") {
            headers.remove("content-type");
        }
        let mut headers = self.config.auth.apply(auth::Input {
            method: "POST",
            url: url.as_str(),
            body: &lowered.auth_body,
            headers,
        })?;
        headers.insert(
            "content-type",
            HeaderValue::from_str(&lowered.content_type)
                .map_err(|_| Error::invalid("Invalid image content type"))?,
        );
        Ok(Prepared {
            url,
            headers,
            body: lowered.bytes,
        })
    }
    pub fn parse(&self, request: &Request, payload: &JsonValue) -> Result<Response, Error> {
        match self.kind {
            Kind::OpenAI => crate::openai_images::parse(request, payload),
            Kind::Zai => crate::zai_images::parse(payload),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    Bytes {
        data: Vec<u8>,
        media_type: LosslessString,
    },
    Url(LosslessString),
    FileId(LosslessString),
    FileUri {
        uri: LosslessString,
        media_type: LosslessString,
    },
}
#[derive(Clone)]
pub struct Request {
    pub model: Model,
    pub prompt: LosslessString,
    pub images: Vec<Input>,
    pub mask: Option<Input>,
    pub options: JsonValue,
    pub http: HttpOptions,
}
impl Request {
    pub fn new(model: Model, prompt: impl Into<LosslessString>) -> Self {
        Self {
            model,
            prompt: prompt.into(),
            images: Vec::new(),
            mask: None,
            options: json::empty(),
            http: HttpOptions::default(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Data {
    Bytes(Vec<u8>),
    Url(LosslessString),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Generated {
    pub media_type: LosslessString,
    pub data: Data,
    pub provider_metadata: Option<JsonValue>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Response {
    pub images: Vec<Generated>,
    pub usage: Option<Usage>,
    pub provider_metadata: Option<JsonValue>,
}
impl Response {
    pub fn image(&self) -> Option<&Generated> {
        self.images.first()
    }
}
pub struct Prepared {
    pub url: Url,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}
pub(crate) struct Body {
    pub path: String,
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub auth_body: String,
}
impl Body {
    pub fn json(path: impl Into<String>, value: JsonValue) -> Self {
        let auth_body = stringify_json(&value);
        Self {
            path: path.into(),
            bytes: auth_body.as_bytes().to_vec(),
            content_type: "application/json".into(),
            auth_body,
        }
    }
}
impl fmt::Debug for Prepared {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ImagePrepared").finish_non_exhaustive()
    }
}
impl Executor {
    pub async fn generate_image(&self, request: &Request) -> Result<Response, Error> {
        let prepared = request.model.prepare(request)?;
        let response = self
            .execute_http(
                &prepared.url,
                &prepared.headers,
                Method::POST,
                prepared.body,
            )
            .await?;
        let name = match request.model.kind {
            Kind::OpenAI => "OpenAI",
            Kind::Zai => "Z.ai",
        };
        let text = response
            .text()
            .await
            .map_err(|_| Error::output(format!("Failed to read the {name} Images response")))?;
        let result = ycoding_schema::parse_json(&text)
            .map_err(|_| Error::output(format!("Failed to read the {name} Images response")))
            .and_then(|payload| request.model.parse(request, &payload));
        result.map_err(|mut error| {
            error.message = redact_http(&error.message, &prepared.url, &prepared.headers);
            if let Some(metadata) = &error.provider_metadata {
                error.provider_metadata = Some(Box::new(
                    match ycoding_schema::parse_json(&redact_http(
                        &stringify_json(metadata),
                        &prepared.url,
                        &prepared.headers,
                    )) {
                        Ok(value) => value,
                        Err(_) => {
                            return Error::output("Failed to redact image provider diagnostics");
                        }
                    },
                ));
            }
            error
        })
    }
}
pub(crate) fn native(options: &JsonValue, aliases: &[(&str, &str)], exclude: &[&str]) -> JsonValue {
    let mut value = json::empty();
    for (alias, key) in aliases {
        if let Some(field) = get(options, alias) {
            json::set(&mut value, *key, field.clone());
        }
    }
    if let JsonValue::Object(fields) = json::remove(
        options,
        &aliases
            .iter()
            .map(|(alias, _)| *alias)
            .chain(exclude.iter().copied())
            .collect::<Vec<_>>(),
    ) {
        for (key, field) in fields.iter() {
            json::set(&mut value, key.clone(), field.clone());
        }
    }
    value
}
pub(crate) fn body(
    request: &Request,
    http: &HttpOptions,
    options: JsonValue,
    references: JsonValue,
) -> JsonValue {
    let value = json::merge(
        &json::object([
            ("model", s(request.model.id.clone())),
            ("prompt", s(request.prompt.clone())),
        ]),
        &references,
    );
    json::merge(
        &json::merge(&value, &options),
        http.body.as_ref().unwrap_or(&json::empty()),
    )
}
pub(crate) fn metadata(key: &str, value: JsonValue) -> Option<JsonValue> {
    Some(json::object([(key, value)]))
}
pub(crate) fn data_url(input: &Input) -> Option<LosslessString> {
    let Input::Bytes { data, media_type } = input else {
        return None;
    };
    let mut value = "data:".into();
    json::concat(&mut value, media_type);
    json::concat(
        &mut value,
        &format!(";base64,{}", crate::media::encode(data)).into(),
    );
    Some(value)
}
pub(crate) fn decode_url(url: &LosslessString) -> Result<Option<(LosslessString, Vec<u8>)>, Error> {
    if !url.code_units().take(5).eq("data:".encode_utf16()) {
        return Ok(None);
    }
    let units = url.code_units().skip(5).collect::<Vec<_>>();
    let separator = units
        .windows(8)
        .position(|window| window == [59, 98, 97, 115, 101, 54, 52, 44])
        .filter(|index| *index > 0 && !units[..*index].iter().any(|unit| matches!(unit, 44 | 59)))
        .ok_or_else(|| {
            Error::invalid("Image data URLs must contain a MIME type and base64 data")
        })?;
    let mime = LosslessString::from_utf16(units[..separator].to_vec());
    let data = LosslessString::from_utf16(units[separator + 8..].to_vec());
    Ok(Some((
        mime,
        crate::media::decode(
            &data
                .as_str()
                .ok_or_else(|| Error::invalid("Image data URL contains invalid base64 data"))?
                .replace(['\r', '\n'], ""),
        )
        .map_err(|_| Error::invalid("Image data URL contains invalid base64 data"))?,
    )))
}
pub(crate) fn bytes(input: &Input) -> Result<Option<(LosslessString, Vec<u8>)>, Error> {
    match input {
        Input::Bytes { data, media_type } => Ok(Some((media_type.clone(), data.clone()))),
        Input::Url(url) => decode_url(url),
        _ => Ok(None),
    }
}
pub(crate) fn decoded(data: &LosslessString, message: String) -> Result<Vec<u8>, Error> {
    crate::media::decode(
        &data
            .as_str()
            .ok_or_else(|| Error::output(message.clone()))?
            .replace(['\r', '\n'], ""),
    )
    .map_err(|_| Error::output(message))
}
pub(crate) fn usv_string(value: &LosslessString) -> String {
    char::decode_utf16(value.code_units())
        .map(|ch| ch.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}
