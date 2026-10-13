mod spec;

use super::{Cancellation, ToolDescription, ToolFailure, ToolFuture, ToolHost};
use std::{future::Future, pin::Pin, sync::Arc};
use ycoding_schema::{JsonObject, JsonValue, LosslessString, parse_json, stringify_json};

pub struct Options {
    pub base_url: Option<String>,
    pub namespace: Option<LosslessString>,
    pub headers: JsonObject,
    pub auth: Option<Arc<dyn AuthResolver>>,
    pub client: reqwest::Client,
}

#[derive(Clone, Debug)]
pub struct Operation {
    pub operation_id: Option<String>,
    pub method: String,
    pub path: String,
    pub summary: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone)]
pub enum Credential {
    Bearer(String),
    Basic { username: String, password: String },
    ApiKey(String),
    Header { name: String, value: String },
}

pub struct AuthContext {
    pub name: String,
    pub definition: JsonValue,
    pub scopes: Vec<String>,
    pub operation: Operation,
}

pub type AuthFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<Credential>, ToolFailure>> + Send + 'a>>;

pub trait AuthResolver: Send + Sync {
    fn resolve(&self, context: AuthContext) -> AuthFuture<'_>;
}

#[derive(Debug)]
pub struct Skipped {
    pub method: String,
    pub path: String,
    pub reason: String,
}

pub struct Generation {
    pub host: Host,
    pub skipped: Vec<Skipped>,
}

pub struct Host {
    options: Options,
    plans: Vec<Plan>,
}

struct Plan {
    description: ToolDescription,
    operation: Operation,
    url: String,
    fields: Vec<Field>,
    body: Option<Body>,
    security: Vec<SecurityRequirement>,
    schemes: JsonObject,
}

type SecurityRequirement = Vec<(String, Vec<String>)>;

struct Field {
    input_name: String,
    name: String,
    location: &'static str,
    required: bool,
    schema: JsonValue,
    style: String,
    explode: bool,
}

struct Body {
    required: bool,
    object: bool,
    media_type: String,
}

impl Host {
    pub fn from_spec(document: &JsonValue, options: Options) -> Generation {
        let (plans, skipped) = spec::plans(document, &options);
        Generation {
            host: Self { options, plans },
            skipped,
        }
    }

    async fn execute(
        &self,
        plan: &Plan,
        input: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        let input = input.unwrap_or(JsonValue::Null);
        let mut address = plan.url.clone();
        for field in plan.fields.iter().filter(|field| field.location == "path") {
            let value = get(&input, &field.input_name).ok_or_else(|| {
                safe(format!(
                    "Missing required path parameter '{}'.",
                    field.input_name
                ))
            })?;
            let rendered = simple(field, value, true)?;
            if rendered.is_empty() || rendered == "." || rendered == ".." {
                return Err(safe(format!(
                    "Invalid path parameter '{}'.",
                    field.input_name
                )));
            }
            address = address.replace(&format!("{{{}}}", field.name), &rendered);
        }
        if let Some(start) = address.find('{')
            && let Some(end) = address[start..].find('}')
        {
            return Err(safe(format!(
                "Unresolved path parameter {}.",
                &address[start..=start + end]
            )));
        }
        for field in plan
            .fields
            .iter()
            .filter(|field| field.required && field.location != "path")
        {
            if get(&input, &field.input_name).is_none() {
                let label = if field.location == "body" {
                    "body field".into()
                } else {
                    format!("{} parameter", field.location)
                };
                return Err(safe(format!(
                    "Missing required {label} '{}'.",
                    field.input_name
                )));
            }
        }
        let mut url = url::Url::parse(&address).map_err(|_| {
            safe(format!(
                "{} {} failed: transport error",
                plan.operation.method, plan.operation.path
            ))
        })?;
        for field in plan.fields.iter().filter(|field| field.location == "query") {
            if let Some(value) = get(&input, &field.input_name) {
                for (key, value) in query(field, value)? {
                    url.query_pairs_mut().append_pair(&key, &value);
                }
            }
        }
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in self.options.headers.iter() {
            let Some(name) = name.as_str() else {
                return Err(safe("Invalid HTTP header."));
            };
            let Some(value) = text(Some(value)) else {
                return Err(safe("Invalid HTTP header."));
            };
            set_header(&mut headers, name, value)?;
        }
        for field in plan
            .fields
            .iter()
            .filter(|field| field.location == "header")
        {
            if let Some(value) = get(&input, &field.input_name) {
                set_header(&mut headers, &field.name, &simple(field, value, false)?)?;
            }
        }
        let body = if let Some(body) = &plan.body {
            let value = if body.object {
                let mut fields = JsonObject::new();
                for field in plan.fields.iter().filter(|field| field.location == "body") {
                    if let Some(value) = get(&input, &field.input_name) {
                        fields.insert(field.name.clone().into(), value.clone());
                    }
                }
                (body.required || !fields.is_empty()).then_some(JsonValue::Object(fields))
            } else {
                plan.fields
                    .iter()
                    .find(|field| field.location == "body")
                    .and_then(|field| get(&input, &field.input_name))
                    .cloned()
            };
            if value.is_some() {
                set_header(&mut headers, "content-type", &body.media_type)?;
            }
            value.map(|value| stringify_json(&value))
        } else {
            None
        };
        let (auth_headers, auth_query) = self.authorize(plan).await?;
        for (name, value) in auth_headers {
            set_header(&mut headers, &name, &value)?;
        }
        for (name, value) in auth_query {
            let previous = url
                .query_pairs()
                .filter(|(key, _)| key != &name)
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect::<Vec<_>>();
            url.set_query(None);
            url.query_pairs_mut()
                .extend_pairs(previous)
                .append_pair(&name, &value);
        }
        let method = reqwest::Method::from_bytes(plan.operation.method.as_bytes())
            .map_err(|_| safe("Invalid HTTP method."))?;
        let request = self.options.client.request(method, url).headers(headers);
        let request = match body {
            Some(body) => request.body(body),
            None => request,
        };
        let mut response = request.send().await.map_err(|_| {
            safe(format!(
                "{} {} failed: transport error",
                plan.operation.method, plan.operation.path
            ))
        })?;
        let status = response.status().as_u16();
        let json = response
            .headers()
            .get("content-type")
            .and_then(|header| header.to_str().ok())
            .is_some_and(json_media);
        let limit = 50 * 1024 * 1024;
        if response
            .content_length()
            .is_some_and(|size| size > limit as u64)
        {
            return Err(safe(format!(
                "{} {} response exceeds 50 MiB.",
                plan.operation.method, plan.operation.path
            )));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            safe(format!(
                "{} {} failed while reading the response body.",
                plan.operation.method, plan.operation.path
            ))
        })? {
            if bytes.len() + chunk.len() > limit {
                return Err(safe(format!(
                    "{} {} response exceeds 50 MiB.",
                    plan.operation.method, plan.operation.path
                )));
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&bytes);
        let decoded = if text.is_empty() {
            Some(JsonValue::Null)
        } else if json {
            parse_json(&text).ok()
        } else {
            None
        };
        let value = decoded
            .clone()
            .unwrap_or_else(|| JsonValue::String(text.as_ref().into()));
        if !(200..300).contains(&status) {
            let rendered = match value {
                JsonValue::String(value) => value.to_utf8().unwrap_or_else(|_| {
                    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
                }),
                value => stringify_json(&value),
            };
            let summary = if rendered.is_empty() || rendered == "null" {
                "no response body".into()
            } else if rendered.encode_utf16().count() > 1024 {
                format!(
                    "{}...",
                    String::from_utf16_lossy(
                        &rendered.encode_utf16().take(1024).collect::<Vec<_>>()
                    )
                )
            } else {
                rendered
            };
            return Err(safe(format!(
                "{} {} failed with HTTP {status}: {summary}",
                plan.operation.method, plan.operation.path
            )));
        }
        if json && decoded.is_none() {
            return Err(safe(format!(
                "{} {} returned malformed JSON.",
                plan.operation.method, plan.operation.path
            )));
        }
        Ok(Some(value))
    }

    async fn authorize(
        &self,
        plan: &Plan,
    ) -> Result<(Vec<(String, String)>, Vec<(String, String)>), ToolFailure> {
        if plan.security.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let mut unavailable = Vec::new();
        for requirement in &plan.security {
            let mut credentials = Vec::new();
            let mut complete = true;
            for (name, scopes) in requirement {
                let definition = plan.schemes.get(&name.as_str().into());
                let value = match (&self.options.auth, definition) {
                    (Some(auth), Some(definition)) => {
                        auth.resolve(AuthContext {
                            name: name.clone(),
                            scopes: scopes.clone(),
                            definition: definition.clone(),
                            operation: plan.operation.clone(),
                        })
                        .await?
                    }
                    _ => None,
                };
                let Some(value) = value else {
                    if !unavailable.contains(name) {
                        unavailable.push(name.clone());
                    }
                    complete = false;
                    break;
                };
                credentials.push((name, definition.unwrap(), value));
            }
            if !complete {
                continue;
            }
            let mut headers = Vec::new();
            let mut query = Vec::new();
            for (name, definition, value) in credentials {
                let (carrier, key, value) = match value {
                    Credential::Bearer(token) => {
                        ("header", "authorization".into(), format!("Bearer {token}"))
                    }
                    Credential::Basic { username, password } => {
                        let request = self
                            .options
                            .client
                            .get("http://localhost")
                            .basic_auth(username, Some(password))
                            .build()
                            .map_err(|_| safe("Invalid authentication credential."))?;
                        let value = request
                            .headers()
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .ok_or_else(|| safe("Invalid authentication credential."))?
                            .to_owned();
                        ("header", "authorization".into(), value)
                    }
                    Credential::Header { name, value } => ("header", name.to_lowercase(), value),
                    Credential::ApiKey(value) => {
                        if text(get(definition, "type")) != Some("apiKey") {
                            return Err(safe(format!(
                                "Security scheme '{name}' is not an apiKey scheme; resolve a bearer, basic, or header credential for it."
                            )));
                        }
                        let carrier = text(get(definition, "in")).unwrap_or_default();
                        if carrier == "cookie" {
                            return Err(safe(format!(
                                "Cookie authentication '{name}' is not supported."
                            )));
                        }
                        let key = text(get(definition, "name")).unwrap_or_default();
                        (
                            carrier,
                            if carrier == "header" {
                                key.to_lowercase()
                            } else {
                                key.to_owned()
                            },
                            value,
                        )
                    }
                };
                let target: &mut Vec<(String, String)> = if carrier == "header" {
                    &mut headers
                } else {
                    &mut query
                };
                if target.iter().any(|(name, _)| name == &key) {
                    return Err(safe(format!(
                        "Authentication resolves multiple credentials for {carrier} '{key}'."
                    )));
                }
                target.push((key, value));
            }
            return Ok((headers, query));
        }
        Err(safe(format!(
            "{} {} requires authentication; no credential available for: {}.",
            plan.operation.method,
            plan.operation.path,
            unavailable.join(", ")
        )))
    }
}

impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        super::stdlib::discovery::catalog(
            self.plans
                .iter()
                .map(|plan| plan.description.clone())
                .collect(),
        )
    }
    fn decode_input(
        &self,
        _: &LosslessString,
        input: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(input)
    }
    fn invoke(
        &self,
        path: LosslessString,
        input: Option<JsonValue>,
        cancellation: Cancellation,
    ) -> ToolFuture<'_> {
        Box::pin(async move {
            let plan = self
                .plans
                .iter()
                .find(|plan| plan.description.path == path)
                .ok_or(ToolFailure::Internal)?;
            tokio::select! { biased; _ = cancellation.cancelled() => Err(ToolFailure::Cancelled), result = self.execute(plan, input) => result }
        })
    }
    fn decode_output(
        &self,
        _: &LosslessString,
        output: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(output)
    }
}

fn safe(message: impl Into<String>) -> ToolFailure {
    ToolFailure::Safe(message.into())
}
fn get<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(value) => value.get(&name.into()),
        _ => None,
    }
}
fn text(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(value)) => value.as_str(),
        _ => None,
    }
}
fn object(value: Option<&JsonValue>) -> Option<&JsonObject> {
    match value {
        Some(JsonValue::Object(value)) => Some(value),
        _ => None,
    }
}
fn array(value: Option<&JsonValue>) -> &[JsonValue] {
    match value {
        Some(JsonValue::Array(value)) => value,
        _ => &[],
    }
}
fn json_media(media: &str) -> bool {
    let media = media
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    media == "application/json" || media.ends_with("+json")
}
fn set_header(
    headers: &mut reqwest::header::HeaderMap,
    name: &str,
    value: &str,
) -> Result<(), ToolFailure> {
    let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| safe("Invalid HTTP header."))?;
    let value =
        reqwest::header::HeaderValue::from_str(value).map_err(|_| safe("Invalid HTTP header."))?;
    headers.insert(name, value);
    Ok(())
}
fn scalar(field: &Field, value: &JsonValue) -> Result<String, ToolFailure> {
    match value {
        JsonValue::String(value) => value.to_utf8().map_err(|_| {
            safe(format!(
                "Parameter '{}' contains an unencodable string.",
                field.input_name
            ))
        }),
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => Ok(stringify_json(value)),
        _ => Err(safe(format!(
            "Parameter '{}' contains an unsupported nested value.",
            field.input_name
        ))),
    }
}
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
fn simple(field: &Field, value: &JsonValue, path: bool) -> Result<String, ToolFailure> {
    let render = |value: &JsonValue| {
        scalar(field, value).map(|value| if path { encode(&value) } else { value })
    };
    match value {
        JsonValue::Array(values) => values
            .iter()
            .map(render)
            .collect::<Result<Vec<_>, _>>()
            .map(|values| values.join(",")),
        JsonValue::Object(values) => values
            .iter()
            .map(|(name, value)| {
                let name = name
                    .to_utf8()
                    .map_err(|_| safe("Invalid parameter name."))?;
                let name = if path { encode(&name) } else { name };
                let value = render(value)?;
                Ok(if field.explode {
                    format!("{name}={value}")
                } else {
                    format!("{name},{value}")
                })
            })
            .collect::<Result<Vec<_>, ToolFailure>>()
            .map(|values| values.join(",")),
        _ => render(value),
    }
}
fn query(field: &Field, value: &JsonValue) -> Result<Vec<(String, String)>, ToolFailure> {
    if field.style == "deepObject" {
        let JsonValue::Object(values) = value else {
            return Err(safe(format!(
                "Deep-object parameter '{}' must be an object.",
                field.input_name
            )));
        };
        return values
            .iter()
            .map(|(name, value)| {
                if matches!(value, JsonValue::Array(_) | JsonValue::Object(_)) {
                    return Err(safe(format!(
                        "Deep-object parameter '{}' contains an unsupported nested value.",
                        field.input_name
                    )));
                }
                Ok((
                    format!(
                        "{}[{}]",
                        field.name,
                        name.to_utf8()
                            .map_err(|_| safe("Invalid parameter name."))?
                    ),
                    scalar(field, value)?,
                ))
            })
            .collect();
    }
    if field.explode {
        if let JsonValue::Array(values) = value {
            return values
                .iter()
                .map(|value| Ok((field.name.clone(), scalar(field, value)?)))
                .collect();
        }
        if let JsonValue::Object(values) = value {
            return values
                .iter()
                .map(|(name, value)| {
                    if matches!(value, JsonValue::Array(_) | JsonValue::Object(_)) {
                        return Err(safe(format!(
                            "Query parameter '{}' contains an unsupported nested value.",
                            field.input_name
                        )));
                    }
                    Ok((
                        name.to_utf8()
                            .map_err(|_| safe("Invalid parameter name."))?,
                        scalar(field, value)?,
                    ))
                })
                .collect();
        }
    }
    Ok(vec![(field.name.clone(), simple(field, value, false)?)])
}
