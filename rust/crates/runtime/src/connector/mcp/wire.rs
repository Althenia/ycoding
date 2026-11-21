use super::{
    Context, NESTING_DEPTH, REQUEST_BYTES, Request, Response, VERSION, arguments_of, call, catalog,
    json::{Unparsed, extend, get, object, parse, string, text, unbase64},
};
use ycoding_core::ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, mcp_events, stringify_json,
};

const PROTOCOL: &str = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
const CLIENT: &str = "io.modelcontextprotocol/clientInfo";
const SERVER: &str = "io.modelcontextprotocol/serverInfo";
const NAME: &str = "ycoding-remote";
const SERVER_VERSION: &str = "1.0.0";

struct Rejection {
    status: u16,
    code: i32,
    message: String,
    data: Option<JsonValue>,
}

enum Route<'a> {
    Request {
        revision: Option<String>,
        message: &'a JsonValue,
    },
    Notification {
        revision: Option<String>,
    },
    Legacy(Legacy),
}

enum Legacy {
    Batch,
    Response,
    Notification,
    Unversioned(Option<String>),
}

#[derive(Default)]
struct Headers {
    content_type: Option<String>,
    version: Option<String>,
    method: Option<String>,
    name: Option<String>,
}

pub(super) async fn handle(cx: &Context, request: Request) -> Response {
    let headers = Headers::of(&request);
    if !headers.content_type.as_deref().is_some_and(json_content) {
        return failure(
            415,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
            None,
            JsonValue::Null,
        );
    }
    let Ok(body) = request.body.to_utf8() else {
        return failure(
            400,
            -32700,
            "Parse error: the request body could not be read",
            None,
            JsonValue::Null,
        );
    };
    if body.len() > REQUEST_BYTES {
        return failure(
            413,
            -32000,
            &format!("Payload Too Large: Request body must not exceed {REQUEST_BYTES} bytes"),
            None,
            JsonValue::Null,
        );
    }
    let message = match parse(&body) {
        Ok(message) => message,
        Err(Unparsed::Nesting) => {
            return failure(
                400,
                -32600,
                &format!(
                    "Bad Request: the request body nests JSON deeper than {NESTING_DEPTH} levels"
                ),
                None,
                JsonValue::Null,
            );
        }
        Err(Unparsed::Invalid) => {
            return failure(
                400,
                -32700,
                "Parse error: the request body is not valid JSON",
                None,
                JsonValue::Null,
            );
        }
    };
    let id = echoable(&message);
    match classify(&headers, &message) {
        Err(rejection) => reject(rejection, id),
        Ok(Route::Legacy(reason)) => match strict(reason) {
            Some(rejection) => reject(rejection, id),
            None => accepted(),
        },
        Ok(Route::Notification { revision }) => match supported(revision.as_deref()) {
            Some(rejection) => reject(rejection, id),
            None => accepted(),
        },
        Ok(Route::Request { revision, message }) => {
            if let Some(rejection) = supported(revision.as_deref()) {
                return reject(rejection, id);
            }
            if let Some(rejection) = standard(&headers, message, revision.as_deref()) {
                return reject(rejection, id);
            }
            serve(cx, message, id).await
        }
    }
}

impl Headers {
    fn of(request: &Request) -> Self {
        let mut headers = Self::default();
        for (name, value) in &request.headers {
            let value = value.to_utf8().ok().map(|value| {
                value
                    .trim_matches(|character| character == ' ' || character == '\t')
                    .to_owned()
            });
            match name.to_ascii_lowercase().as_str() {
                "content-type" => headers.content_type = value,
                "mcp-protocol-version" => headers.version = value,
                "mcp-method" => headers.method = value,
                "mcp-name" => headers.name = value,
                _ => {}
            }
        }
        headers
    }
}

fn json_content(value: &str) -> bool {
    let media = value.split(';').next().unwrap_or("").trim();
    media.eq_ignore_ascii_case("application/json")
}

fn echoable(message: &JsonValue) -> JsonValue {
    if get(message, "method").and_then(text).is_none() {
        return JsonValue::Null;
    }
    match get(message, "id") {
        Some(id @ (JsonValue::String(_) | JsonValue::Number(_))) => id.clone(),
        _ => JsonValue::Null,
    }
}

fn classify<'a>(headers: &Headers, message: &'a JsonValue) -> Result<Route<'a>, Rejection> {
    if let JsonValue::Array(items) = message {
        if items.is_empty() {
            return Err(invalid_request("Bad Request: empty JSON-RPC batch"));
        }
        for item in items {
            if claims(get(item, "params")) {
                return Err(invalid_request(
                    "Bad Request: JSON-RPC batches may not contain requests for protocol revision 2026-07-28 or later",
                ));
            }
            if !(is_request(item) || is_notification(item) || is_response(item)) {
                return Err(invalid_request(
                    "Bad Request: JSON-RPC batch contains an invalid message",
                ));
            }
        }
        return Ok(Route::Legacy(Legacy::Batch));
    }
    if is_response(message) {
        return Ok(Route::Legacy(Legacy::Response));
    }
    if is_request(message) {
        return request_route(headers, message);
    }
    if is_notification(message) {
        return notification_route(headers, message);
    }
    Err(invalid_request(
        "Bad Request: the request body is not a valid JSON-RPC message",
    ))
}

fn request_route<'a>(headers: &Headers, message: &'a JsonValue) -> Result<Route<'a>, Rejection> {
    let params = get(message, "params");
    let method = get(message, "method").and_then(text).unwrap_or("");
    let modern_header = headers.version.as_deref().is_some_and(modern);
    if method == "initialize" && !valid_modern_claim(params) {
        if modern_header {
            return Err(mismatch(
                headers.version.as_deref().unwrap_or(""),
                "an initialize request (legacy handshake) was sent with a modern MCP-Protocol-Version header",
            ));
        }
        return Ok(Route::Legacy(Legacy::Unversioned(
            params
                .and_then(|params| get(params, "protocolVersion"))
                .and_then(text)
                .map(str::to_owned),
        )));
    }
    if let Some(meta) = claimed(params) {
        if let Some((key, problem)) = envelope(meta).into_iter().next() {
            return Err(Rejection {
                status: 400,
                code: -32602,
                message: format!(
                    "Invalid _meta envelope for protocol revision 2026-07-28: {key}: {problem}"
                ),
                data: Some(object([(
                    "envelope",
                    object([("key", string(&key)), ("problem", string(&problem))]),
                )])),
            });
        }
        let claimed = get(meta, PROTOCOL).and_then(text).map(str::to_owned);
        if let (Some(header), Some(claimed)) = (&headers.version, &claimed)
            && header != claimed
        {
            return Err(mismatch(
                header,
                &format!(
                    "the body envelope names protocol version {claimed} but the MCP-Protocol-Version header names {header}"
                ),
            ));
        }
        if let Some(header) = &headers.method
            && header != method
        {
            return Err(mismatch(
                header,
                &format!("the body names method {method} but the Mcp-Method header names {header}"),
            ));
        }
        return Ok(Route::Request {
            revision: claimed,
            message,
        });
    }
    if modern_header {
        let missing = match meta(params) {
            None => vec!["_meta".to_owned()],
            Some(meta) => {
                let missing = envelope(meta)
                    .into_iter()
                    .filter(|(_, problem)| problem == "missing")
                    .map(|(key, _)| key)
                    .collect::<Vec<_>>();
                if missing.is_empty() {
                    vec![PROTOCOL.to_owned()]
                } else {
                    missing
                }
            }
        };
        return Err(Rejection {
            status: 400,
            code: -32602,
            message: format!(
                "Invalid params: the MCP-Protocol-Version header names protocol revision {}, but the request is missing the required per-request envelope key(s): {}",
                headers.version.as_deref().unwrap_or(""),
                missing.join(", ")
            ),
            data: Some(object([(
                "envelope",
                object([(
                    "missing",
                    JsonValue::Array(missing.iter().map(|key| string(key)).collect()),
                )]),
            )])),
        });
    }
    Ok(Route::Legacy(Legacy::Unversioned(headers.version.clone())))
}

fn notification_route<'a>(
    headers: &Headers,
    message: &'a JsonValue,
) -> Result<Route<'a>, Rejection> {
    let params = get(message, "params");
    let method = get(message, "method").and_then(text).unwrap_or("");
    let method_mismatch = |header: &str| {
        mismatch(
            header,
            &format!(
                "the notification body names method {method} but the Mcp-Method header names {header}"
            ),
        )
    };
    if claims(params) {
        let Some(claimed) = meta(params)
            .and_then(|meta| get(meta, PROTOCOL))
            .and_then(text)
        else {
            return Err(Rejection {
                status: 400,
                code: -32602,
                message: format!(
                    "Invalid _meta envelope for protocol revision 2026-07-28: {PROTOCOL}: expected a protocol version string"
                ),
                data: Some(object([(
                    "envelope",
                    object([
                        ("key", string(PROTOCOL)),
                        ("problem", string("expected a protocol version string")),
                    ]),
                )])),
            });
        };
        if let Some(header) = &headers.version
            && header != claimed
        {
            return Err(mismatch(
                header,
                &format!(
                    "the notification envelope names protocol version {claimed} but the MCP-Protocol-Version header names {header}"
                ),
            ));
        }
        if modern(claimed)
            && let Some(header) = &headers.method
            && header != method
        {
            return Err(method_mismatch(header));
        }
        return Ok(Route::Notification {
            revision: Some(claimed.to_owned()),
        });
    }
    if let Some(header) = headers.version.as_deref().filter(|header| modern(header)) {
        if let Some(method_header) = &headers.method
            && method_header != method
        {
            return Err(method_mismatch(method_header));
        }
        return Ok(Route::Notification {
            revision: Some(header.to_owned()),
        });
    }
    Ok(Route::Legacy(Legacy::Notification))
}

fn supported(revision: Option<&str>) -> Option<Rejection> {
    if revision == Some(VERSION) {
        return None;
    }
    Some(unsupported(Some(revision.unwrap_or("unknown"))))
}

fn standard(headers: &Headers, message: &JsonValue, revision: Option<&str>) -> Option<Rejection> {
    let method = get(message, "method").and_then(text).unwrap_or("");
    if headers.version.is_none() {
        return Some(mismatch(
            "(missing)",
            &match revision {
                Some(claimed) => format!(
                    "the body envelope names protocol version {claimed} but the required MCP-Protocol-Version header is absent"
                ),
                None => "the body carries a modern per-request envelope but the required MCP-Protocol-Version header is absent".to_owned(),
            },
        ));
    }
    if headers.method.is_none() {
        return Some(mismatch(
            "(missing)",
            &format!("the body names method {method} but the required Mcp-Method header is absent"),
        ));
    }
    let field = match method {
        "tools/call" | "prompts/get" => "name",
        "resources/read" => "uri",
        "tasks/get" | "tasks/update" | "tasks/cancel" => "taskId",
        _ => return None,
    };
    let body = get(message, "params")
        .and_then(|params| get(params, field))
        .and_then(text);
    let Some(header) = &headers.name else {
        return body.map(|body| {
            mismatch(
                "(missing)",
                &format!("the body carries params.{field}=\"{body}\" but the required Mcp-Name header is absent"),
            )
        });
    };
    let Some(decoded) = decode_name(header) else {
        return Some(mismatch(
            header,
            "the Mcp-Name header carries an invalid Base64 sentinel value",
        ));
    };
    let body = body?;
    (decoded != body).then(|| {
        mismatch(
            header,
            &format!(
                "the body carries params.{field}=\"{body}\" but the Mcp-Name header names \"{decoded}\""
            ),
        )
    })
}

fn decode_name(value: &str) -> Option<String> {
    let Some(encoded) = value
        .strip_prefix("=?base64?")
        .and_then(|rest| rest.strip_suffix("?="))
    else {
        return Some(value.to_owned());
    };
    String::from_utf8(unbase64(encoded)?).ok()
}

async fn serve(cx: &Context, message: &JsonValue, id: JsonValue) -> Response {
    let method = get(message, "method").and_then(text).unwrap_or("");
    if method.starts_with("resources/") && !cx.authorized() {
        return super::unavailable();
    }
    let params = get(message, "params");
    let events = if method == "server/discover" || method.starts_with("events/") {
        match cx
            .trusted_context
            .as_ref()
            .and_then(|context| cx.access.events(context))
        {
            Some(service) if service.status().await => Some(service),
            _ => None,
        }
    } else {
        None
    };
    match method {
        "server/discover" => {
            let capabilities = object([
                ("tools", JsonValue::Object(Default::default())),
                ("resources", JsonValue::Object(Default::default())),
            ]);
            let capabilities = if events.is_some() {
                extend(
                    capabilities,
                    vec![("events", JsonValue::Object(Default::default()))],
                )
            } else {
                capabilities
            };
            success(
                id,
                method,
                object([
                    ("supportedVersions", JsonValue::Array(vec![string(VERSION)])),
                    ("capabilities", capabilities),
                ]),
                false,
            )
        }
        "events/list" | "events/subscribe" | "events/unsubscribe" => {
            let Some(service) = events else {
                return failure(404, -32601, "Method not found", None, id);
            };
            let Some(context) = cx.trusted_context.clone() else {
                return failure(404, -32601, "Method not found", None, id);
            };
            let params = match params {
                Some(JsonValue::Object(params)) => params.clone(),
                None => Default::default(),
                _ => return in_band(id, -32602, "Invalid MCP Events parameters"),
            };
            let mut stripped = ycoding_core::ycoding_schema::JsonObject::new();
            for (key, value) in params
                .iter()
                .filter(|(key, _)| key.as_str() != Some("_meta"))
            {
                stripped.insert(key.clone(), value.clone());
            }
            let value = JsonValue::Object(stripped);
            if method == "events/list" {
                let JsonValue::Object(params) = &value else {
                    return in_band(id, -32602, "Invalid MCP Events parameters");
                };
                if params.iter().any(|(key, _)| key.as_str() != Some("cursor"))
                    || params.get(&"cursor".into()).is_some_and(|cursor| {
                        !matches!(cursor, JsonValue::Null)
                            && !matches!(cursor,JsonValue::String(value) if value.len()<=1024)
                    })
                {
                    return in_band(id, -32602, "Invalid MCP Events parameters");
                }
                return success(id, method, service.list().encode(), false);
            }
            let cancellation = cx.access.event_cancellation();
            let authority = cx.access.authority_cancellation();
            let run = async {
                if method == "events/subscribe" {
                    let input =
                        mcp_events::Subscribe::decode(&value).map_err(|_| mcp_events::Failure {
                            category: mcp_events::FailureCategory::InvalidParams,
                            reason: mcp_events::FailureReason::InvalidArguments,
                        })?;
                    service
                        .subscribe(context, input, cancellation.clone())
                        .await
                        .map(|result| result.encode())
                } else {
                    let input = mcp_events::Unsubscribe::decode(&value).map_err(|_| {
                        mcp_events::Failure {
                            category: mcp_events::FailureCategory::InvalidParams,
                            reason: mcp_events::FailureReason::InvalidArguments,
                        }
                    })?;
                    service
                        .unsubscribe(context, input, cancellation.clone())
                        .await
                        .map(|_| JsonValue::Object(Default::default()))
                }
            };
            let result = tokio::select! {biased;_=authority.cancelled()=>{cancellation.cancel();return super::unavailable();},result=run=>result};
            match result {
                Ok(result) => success(id, method, result, false),
                Err(error) => failure(
                    200,
                    match error.category {
                        mcp_events::FailureCategory::CallbackEndpoint => -32015,
                        mcp_events::FailureCategory::InvalidParams => -32602,
                        mcp_events::FailureCategory::Unauthorized => -32001,
                        mcp_events::FailureCategory::Unavailable => -32603,
                    },
                    "MCP event request failed",
                    Some(object([("reason", string(error.reason.as_str()))])),
                    id,
                ),
            }
        }
        "tools/list" => success(id, method, object([("tools", catalog::listing())]), false),
        "resources/templates/list" => success(
            id,
            method,
            object([("resourceTemplates", JsonValue::Array(vec![]))]),
            false,
        ),
        "resources/list" => match cx.access.list() {
            Ok(result) => success(id, method, result, false),
            Err(_) => super::unavailable(),
        },
        "resources/read" => {
            let Some(uri) = params.and_then(|params| get(params, "uri")).and_then(text) else {
                return in_band(id, -32602, "Invalid params for resources/read");
            };
            match cx.access.read(uri) {
                Ok(Some(result)) => success(id, method, result, false),
                Ok(None) => failure(
                    200,
                    -32602,
                    "Resource unavailable",
                    Some(object([("uri", string(uri))])),
                    id,
                ),
                Err(_) => super::unavailable(),
            }
        }
        "tools/call" => {
            let name = params.and_then(|params| get(params, "name")).and_then(text);
            let arguments = params.and_then(|params| get(params, "arguments"));
            let (Some(name), true) = (
                name,
                arguments.is_none_or(|arguments| matches!(arguments, JsonValue::Object(_))),
            ) else {
                return in_band(id, -32602, "Invalid params for tools/call");
            };
            let Some(spec) = catalog::spec(name) else {
                return in_band(id, -32602, &format!("Unknown tool: {name}"));
            };
            let (result, unknown) = call::run(cx, spec, &arguments_of(arguments)).await;
            success(id, method, result, unknown)
        }
        _ => failure(404, -32601, "Method not found", None, id),
    }
}

fn success(id: JsonValue, method: &str, result: JsonValue, unknown: bool) -> Response {
    let mut stamp = vec![("resultType", string("complete"))];
    if matches!(
        method,
        "tools/list"
            | "server/discover"
            | "resources/list"
            | "resources/templates/list"
            | "resources/read"
    ) {
        stamp.push(("ttlMs", JsonValue::Number(0.0)));
        stamp.push(("cacheScope", string("private")));
    }
    stamp.push((
        "_meta",
        extend(
            get(&result, "_meta")
                .filter(|value| matches!(value, JsonValue::Object(_)))
                .cloned()
                .unwrap_or_else(|| object([])),
            vec![(
                SERVER,
                object([("name", string(NAME)), ("version", string(SERVER_VERSION))]),
            )],
        ),
    ));
    Response {
        status: 200,
        content_type: "application/json",
        body: stringify_json(&object([
            ("jsonrpc", string("2.0")),
            ("id", id),
            ("result", extend(result, stamp)),
        ])),
        unknown,
    }
}

fn in_band(id: JsonValue, code: i32, message: &str) -> Response {
    failure(200, code, message, None, id)
}

fn accepted() -> Response {
    Response {
        status: 202,
        content_type: "application/json",
        body: String::new(),
        unknown: false,
    }
}

fn reject(rejection: Rejection, id: JsonValue) -> Response {
    failure(
        rejection.status,
        rejection.code,
        &rejection.message,
        rejection.data,
        id,
    )
}

fn failure(
    status: u16,
    code: i32,
    message: &str,
    data: Option<JsonValue>,
    id: JsonValue,
) -> Response {
    let error = match data {
        Some(data) => object([
            ("code", JsonValue::Number(f64::from(code))),
            ("message", string(message)),
            ("data", data),
        ]),
        None => object([
            ("code", JsonValue::Number(f64::from(code))),
            ("message", string(message)),
        ]),
    };
    Response {
        status,
        content_type: "application/json",
        body: stringify_json(&object([
            ("jsonrpc", string("2.0")),
            ("error", error),
            ("id", id),
        ])),
        unknown: false,
    }
}

fn strict(reason: Legacy) -> Option<Rejection> {
    match reason {
        Legacy::Batch => Some(invalid_request(
            "Bad Request: JSON-RPC batches are not supported by this endpoint",
        )),
        Legacy::Response => Some(invalid_request(
            "Bad Request: JSON-RPC responses cannot be posted to this endpoint",
        )),
        Legacy::Unversioned(requested) => Some(unsupported(requested.as_deref())),
        Legacy::Notification => None,
    }
}

fn unsupported(requested: Option<&str>) -> Rejection {
    let supported = ("supported", JsonValue::Array(vec![string(VERSION)]));
    match requested {
        Some(requested) => Rejection {
            status: 400,
            code: -32022,
            message: format!("Unsupported protocol version: {requested}"),
            data: Some(object([supported, ("requested", string(requested))])),
        },
        None => Rejection {
            status: 400,
            code: -32022,
            message: "Unsupported protocol version: the request did not name a protocol version"
                .to_owned(),
            data: Some(object([supported])),
        },
    }
}

fn invalid_request(message: &str) -> Rejection {
    Rejection {
        status: 400,
        code: -32600,
        message: message.to_owned(),
        data: None,
    }
}

fn mismatch(header: &str, body: &str) -> Rejection {
    Rejection {
        status: 400,
        code: -32020,
        message: format!("Bad Request: the request headers and body disagree: {body}"),
        data: Some(object([(
            "mismatch",
            object([("header", string(header)), ("body", string(body))]),
        )])),
    }
}

fn modern(version: &str) -> bool {
    version >= VERSION
}

fn meta(params: Option<&JsonValue>) -> Option<&JsonValue> {
    params
        .and_then(|params| get(params, "_meta"))
        .filter(|meta| matches!(meta, JsonValue::Object(_)))
}

fn claims(params: Option<&JsonValue>) -> bool {
    claimed(params).is_some()
}

fn claimed(params: Option<&JsonValue>) -> Option<&JsonValue> {
    meta(params).filter(|meta| get(meta, PROTOCOL).is_some())
}

fn valid_modern_claim(params: Option<&JsonValue>) -> bool {
    claims(params)
        && meta(params).is_some_and(|meta| {
            get(meta, PROTOCOL).and_then(text).is_some_and(modern) && envelope(meta).is_empty()
        })
}

fn envelope(meta: &JsonValue) -> Vec<(String, String)> {
    let mut issues = [PROTOCOL, CAPABILITIES]
        .into_iter()
        .filter(|key| get(meta, key).is_none())
        .map(|key| (key.to_owned(), "missing".to_owned()))
        .collect::<Vec<_>>();
    let expected = |key: &str, kind: &str, valid: bool| {
        (!valid).then(|| (key.to_owned(), format!("Invalid input: expected {kind}")))
    };
    if let Some(value) = get(meta, PROTOCOL) {
        issues.extend(expected(
            PROTOCOL,
            "string",
            matches!(value, JsonValue::String(_)),
        ));
    }
    if let Some(value) = get(meta, CAPABILITIES) {
        issues.extend(expected(
            CAPABILITIES,
            "object",
            matches!(value, JsonValue::Object(_)),
        ));
    }
    if let Some(value) = get(meta, CLIENT) {
        let valid = matches!(value, JsonValue::Object(_))
            && get(value, "name").and_then(text).is_some()
            && get(value, "version").and_then(text).is_some();
        issues.extend(expected(CLIENT, "object", valid));
    }
    issues
}

fn version_field(message: &JsonValue) -> bool {
    get(message, "jsonrpc").and_then(text) == Some("2.0")
}

fn request_id(value: Option<&JsonValue>) -> bool {
    match value {
        Some(JsonValue::String(_)) => true,
        Some(JsonValue::Number(number)) => number.fract() == 0.0,
        _ => false,
    }
}

fn params_shape(message: &JsonValue) -> bool {
    get(message, "params").is_none_or(|params| matches!(params, JsonValue::Object(_)))
}

fn is_request(message: &JsonValue) -> bool {
    version_field(message)
        && get(message, "method").and_then(text).is_some()
        && request_id(get(message, "id"))
        && params_shape(message)
}

fn is_notification(message: &JsonValue) -> bool {
    version_field(message)
        && get(message, "method").and_then(text).is_some()
        && get(message, "id").is_none()
        && params_shape(message)
}

fn is_response(message: &JsonValue) -> bool {
    version_field(message)
        && get(message, "method").is_none()
        && (request_id(get(message, "id"))
            && matches!(get(message, "result"), Some(JsonValue::Object(_)))
            || matches!(get(message, "error"), Some(JsonValue::Object(_))))
}
