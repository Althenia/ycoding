use super::{
    Context, REQUEST_BYTES, RESULT_BYTES,
    catalog::{self, DIRECTORY, Rule, Scope, Spec},
    json::{base64, base64_len, domain, extend, get, object, string, text, value},
};
use crate::{Invocation, Settled, convert};
use prost::{Message, Name};
use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, session, stringify_json,
};
use ycoding_protocol::{
    domain_json::{self, Domain},
    v5,
};

static NEXT: AtomicU64 = AtomicU64::new(1);
const LOG_PAGE: usize = 128;

enum Problem {
    Invalid(String),
    Engine(&'static str, String),
    Declared(String, JsonValue),
    Unknown,
}

pub(super) async fn run(cx: &Context, spec: &Spec, arguments: &JsonValue) -> (JsonValue, bool) {
    let outcome = match execute(cx, spec, arguments).await {
        Ok(value)
            if matches!(
                spec.tool.operation,
                Some("artifact.demo.preview" | "artifact.demo.export")
            ) =>
        {
            cx.access
                .presentation(spec.tool.operation.unwrap(), value)
                .map_err(|_| {
                    Problem::Engine("agent_unavailable", "Demo resource unavailable".into())
                })
        }
        Ok(value)
            if spec
                .tool
                .operation
                .is_some_and(|name| name.starts_with("local.app.")) =>
        {
            local_app_result(value)
        }
        Ok(value) => complete(value),
        Err(problem) => Err(problem),
    };
    match outcome {
        Ok(result) => (result, false),
        Err(Problem::Invalid(message)) => (
            engine_failure(
                "invalid_arguments",
                &format!("Invalid arguments for {}: {message}", spec.tool.name),
            ),
            false,
        ),
        Err(Problem::Engine(code, message)) => (engine_failure(code, &message), false),
        Err(Problem::Declared(type_name, value)) => (declared_failure(&type_name, value), false),
        Err(Problem::Unknown) => (
            engine_failure(
                "outcome_unknown",
                "The local dispatch ended without a settled outcome. Inspect the Session's current state before retrying; the request was not replayed.",
            ),
            true,
        ),
    }
}

async fn execute(cx: &Context, spec: &Spec, arguments: &JsonValue) -> Result<JsonValue, Problem> {
    let arguments = top_level(spec, arguments)?;
    if !cx.authorized() {
        return Err(Problem::Engine(
            "unauthorized",
            "The remote connection is no longer authenticated; the request was not executed".into(),
        ));
    }
    if spec.tool.name == DIRECTORY {
        return directory(cx, get(arguments, "input")).await;
    }
    let descriptor = spec
        .descriptor
        .ok_or_else(|| Problem::Engine("internal_error", "The tool has no operation".into()))?;
    let session = get(arguments, "sessionID").and_then(text);
    let input = request_input(spec, get(arguments, "input"))?;
    let input = inject(spec, defaults(spec, input), session)?;
    if located(&descriptor.request_type, &input) {
        return Err(Problem::Invalid(
            "Relay MCP tools cannot select a Location".into(),
        ));
    }
    let payload = domain_json::encode(&descriptor.request_type, &input, REQUEST_BYTES)
        .map_err(|error| Problem::Invalid(error.0.into()))?;
    let target = match (spec.scope, session) {
        (Scope::Session | Scope::OptionalSession, Some(id)) => {
            v5::scope::Target::Session(id.to_owned())
        }
        (Scope::Form, Some(id)) => v5::scope::Target::Form(id.to_owned()),
        (Scope::Workspace, _) => v5::scope::Target::Workspace(
            get(arguments, "workspace")
                .and_then(text)
                .unwrap_or_default()
                .to_owned(),
        ),
        (Scope::Global, _) => v5::scope::Target::Global(v5::Empty {}),
        _ => v5::scope::Target::Machine(v5::Empty {}),
    };
    let request = v5::Request {
        request_id: format!("mcp-{}", NEXT.fetch_add(1, Ordering::Relaxed)),
        operation_id: descriptor.operation_id,
        scope: v5::Scope {
            target: Some(target),
        },
        payload,
    };
    let log = (descriptor.diagnostic_name == "session.log").then(|| request.payload.clone());
    let settled = dispatch(cx, spec, request).await?;
    let result = settled_value(settled)?;
    match log {
        Some(payload) => collect_log(cx, &payload),
        None => Ok(result),
    }
}

fn top_level<'a>(spec: &Spec, arguments: &'a JsonValue) -> Result<&'a JsonValue, Problem> {
    let JsonValue::Object(entries) = arguments else {
        return Err(Problem::Invalid("arguments must be an object".into()));
    };
    let properties = get(&spec.schema, "properties");
    for (key, _) in entries.iter() {
        if properties
            .and_then(|properties| get(properties, key.as_str().unwrap_or("")))
            .is_none()
        {
            return Err(Problem::Invalid(format!(
                "unknown argument {}",
                convert::readable(key)
            )));
        }
    }
    if let Some(JsonValue::Array(required)) = get(&spec.schema, "required") {
        for key in required.iter().filter_map(text) {
            if get(arguments, key).is_none() {
                return Err(Problem::Invalid(format!("missing argument {key}")));
            }
        }
    }
    if let Some(id) = get(arguments, "sessionID") {
        check(Rule::Session, id)
            .map_err(|message| Problem::Invalid(format!("sessionID {message}")))?;
    }
    if let Some(workspace) = get(arguments, "workspace") {
        let valid =
            text(workspace).is_some_and(|value| (1..=256).contains(&value.encode_utf16().count()));
        if !valid {
            return Err(Problem::Invalid(
                "workspace must be an advertised workspace ID".into(),
            ));
        }
    }
    Ok(arguments)
}

fn request_input(spec: &Spec, input: Option<&JsonValue>) -> Result<Domain, Problem> {
    if spec.tool.name == "session_goal_stop" {
        return Ok(object_domain([(
            "payload",
            object_domain([("goal", Domain::Null)]),
        )]));
    }
    let input = input.map(domain).unwrap_or(Domain::Object(vec![]));
    let Domain::Object(_) = &input else {
        return Err(Problem::Invalid("input must be an object".into()));
    };
    if spec.tool.operation.is_some_and(|operation| {
        operation.starts_with("local.app.") && operation != "local.app.list"
    }) {
        return Ok(object_domain([("payload", input)]));
    }
    if spec.tool.name == "session_goal_set" {
        let payload = field(&input, "payload")
            .ok_or_else(|| Problem::Invalid("missing input.payload".into()))?;
        let Domain::Object(entries) = payload else {
            return Err(Problem::Invalid("input.payload must be an object".into()));
        };
        if entries
            .iter()
            .any(|(key, _)| *key != units("goal") && *key != units("maxNoProgress"))
            || field(&input, "payload").is_none()
            || matches!(&input, Domain::Object(items) if items.len() != 1)
        {
            return Err(Problem::Invalid(
                "a goal accepts only payload.goal and payload.maxNoProgress".into(),
            ));
        }
        if !matches!(field(payload, "goal"), Some(Domain::Text(goal)) if !goal.is_empty()) {
            return Err(Problem::Invalid(
                "payload.goal must be nonempty text".into(),
            ));
        }
    }
    for (path, rule) in spec.rules {
        let value = path
            .split('.')
            .try_fold(&input, |value, key| field(value, key));
        match (rule, value) {
            (Rule::Required, None) => {
                return Err(Problem::Invalid(format!("missing input.{path}")));
            }
            (Rule::Absent, Some(_)) => {
                return Err(Problem::Invalid(format!("input.{path} is not accepted")));
            }
            (Rule::Required | Rule::Absent, _) | (_, None) => {}
            (rule, Some(value)) => check_domain(*rule, value)
                .map_err(|message| Problem::Invalid(format!("input.{path} {message}")))?,
        }
    }
    Ok(input)
}

fn defaults(spec: &Spec, input: Domain) -> Domain {
    let Domain::Object(mut entries) = input else {
        return input;
    };
    for name in catalog::defaulted(spec) {
        if !entries.iter().any(|(key, _)| *key == units(name)) {
            entries.push((units(name), Domain::Object(vec![])));
        }
    }
    Domain::Object(entries)
}

fn inject(spec: &Spec, input: Domain, session: Option<&str>) -> Result<Domain, Problem> {
    let Some(name) = catalog::injected(spec) else {
        return Ok(input);
    };
    let Some(session) = session else {
        return Ok(input);
    };
    let Domain::Object(mut entries) = input else {
        return Err(Problem::Invalid("input must be an object".into()));
    };
    let position = entries.iter().position(|(key, _)| *key == units("params"));
    let mut params = match position {
        Some(index) => match entries.remove(index).1 {
            Domain::Object(params) => params,
            _ => return Err(Problem::Invalid("input.params must be an object".into())),
        },
        None => vec![],
    };
    if params.iter().any(|(key, _)| *key == units(name)) {
        return Err(Problem::Invalid(format!(
            "input.params.{name} is supplied by the top-level sessionID"
        )));
    }
    params.push((units(name), Domain::Text(units(session))));
    entries.push((units("params"), Domain::Object(params)));
    Ok(Domain::Object(entries))
}

fn located(name: &str, value: &Domain) -> bool {
    if name == "ycoding.v5.LosslessString" || name == "ycoding.v5.Value" {
        return false;
    }
    let Some(message) = domain_json::message(name) else {
        return false;
    };
    if let [field] = message.fields
        && field.repeated
    {
        return match value {
            Domain::List(items) if field.kind == 11 => {
                items.iter().any(|item| located(field.target, item))
            }
            _ => false,
        };
    }
    if message.oneofs.len() == 1 && message.fields.iter().all(|field| field.oneof.is_some()) {
        return message
            .fields
            .iter()
            .any(|field| field.kind == 11 && located(field.target, value));
    }
    let Domain::Object(entries) = value else {
        return false;
    };
    entries.iter().any(|(key, item)| {
        let Some(field) = message
            .fields
            .iter()
            .find(|field| units(field.name) == *key)
        else {
            return false;
        };
        if field.name == "location" {
            return true;
        }
        field.kind == 11
            && match item {
                Domain::List(items) if field.repeated => {
                    items.iter().any(|item| located(field.target, item))
                }
                item => located(field.target, item),
            }
    })
}

async fn dispatch(cx: &Context, spec: &Spec, request: v5::Request) -> Result<Settled, Problem> {
    let dispatcher = cx.dispatcher.clone();
    let environment = cx.environment.clone();
    let connection = cx.connection_id.clone();
    let peer = cx.peer.clone();
    let access = cx.access.clone().with_context(cx.trusted_context.clone());
    let task = tokio::spawn(async move {
        dispatcher
            .dispatch_mcp(environment, connection, &peer, request, access)
            .await
    });
    struct ReadAbort(Option<tokio::task::AbortHandle>);
    impl Drop for ReadAbort {
        fn drop(&mut self) {
            if let Some(task) = &self.0 {
                task.abort();
            }
        }
    }
    let _read = ReadAbort((!spec.tool.mutation).then(|| task.abort_handle()));
    match task.await {
        Ok(Some(settled)) => Ok(settled),
        Ok(None) => Err(Problem::Engine(
            "unknown_operation",
            "The operation is not available on this machine. Update YCoding on this machine and reconnect Remote.".into(),
        )),
        Err(_) if spec.tool.mutation => Err(Problem::Unknown),
        Err(_) => Err(Problem::Engine(
            "internal_error",
            "The local read ended without a result".into(),
        )),
    }
}

fn settled_value(settled: Settled) -> Result<JsonValue, Problem> {
    match settled {
        Settled::Result(result) => match result.outcome {
            Some(v5::result::Outcome::Success(payload)) => {
                decoded(&payload.type_name, &payload.payload)
            }
            Some(v5::result::Outcome::Error(payload)) => {
                let value = decoded(&payload.type_name, &payload.payload)?;
                Err(Problem::Declared(payload.type_name, value))
            }
            _ => Err(Problem::Engine(
                "internal_error",
                "The local agent returned no typed result".into(),
            )),
        },
        Settled::Bulk(bulk) => decoded(&bulk.type_name, &bulk.body),
        Settled::Asset { metadata, bulk } => {
            let Some(v5::result::Outcome::AssetMetadata(asset)) = metadata.outcome else {
                return Err(Problem::Engine(
                    "internal_error",
                    "The local agent returned an asset without metadata".into(),
                ));
            };
            if base64_len(bulk.body.len()) > RESULT_BYTES {
                return Err(too_large(base64_len(bulk.body.len())));
            }
            let result = decoded(&asset.metadata.type_name, &asset.metadata.payload)?;
            Ok(extend(
                result,
                vec![("base64", string(&base64(&bulk.body)))],
            ))
        }
    }
}

fn decoded(type_name: &str, bytes: &[u8]) -> Result<JsonValue, Problem> {
    domain_json::decode(type_name, bytes)
        .map(|domain| value(&domain))
        .map_err(|error| {
            Problem::Engine(
                "internal_error",
                format!(
                    "The local agent returned an unreadable {type_name}: {}",
                    error.0
                ),
            )
        })
}

fn collect_log(cx: &Context, payload: &[u8]) -> Result<JsonValue, Problem> {
    let internal = |message: &str| Problem::Engine("internal_error", message.to_owned());
    let query = v5::SessionLogRequest::decode(payload)
        .map_err(|_| internal("The Session log request could not be read"))?;
    let id = convert::domain(&query.params.session_id)
        .ok()
        .and_then(|id| session::Id::decode(&JsonValue::String(id)).ok())
        .ok_or_else(|| internal("The Session log request named an invalid Session"))?;
    let core = cx
        .environment
        .services
        .core
        .as_ref()
        .ok_or_else(|| Problem::Engine("agent_unavailable", "Core is not ready".into()))?;
    let epoch = LosslessString::from(cx.environment.services.identity.source_epoch.as_str());
    let mut after = query.query.after.map(|after| after as i64);
    let mut items = Vec::new();
    let mut bytes = 0usize;
    loop {
        let page = core
            .sessions
            .log(&id, after, LOG_PAGE)
            .map_err(|_| internal("The Session log could not be read"))?;
        for entry in &page.events {
            after = Some(entry.seq);
            let versioned = format!(
                "{}.{}",
                entry.event.0.event_type.as_str().unwrap_or(""),
                entry.version
            );
            if crate::log::excluded(&versioned) {
                continue;
            }
            let record = crate::log::record(entry, &id, &epoch)
                .map_err(|_| internal("A Session log event is not representable"))?;
            items.push(log_item(&record.item, &mut bytes)?);
        }
        if page.events.len() < LOG_PAGE {
            items.push(log_item(
                &crate::log::synced(&id, page.watermark, &epoch),
                &mut bytes,
            )?);
            break;
        }
    }
    Ok(object([("items", JsonValue::Array(items))]))
}

fn log_item(item: &v5::SessionLogItem, bytes: &mut usize) -> Result<JsonValue, Problem> {
    let encoded = item.encode_to_vec();
    *bytes += encoded.len();
    if *bytes > RESULT_BYTES {
        return Err(too_large(*bytes));
    }
    decoded(&v5::SessionLogItem::full_name(), &encoded)
}

async fn directory(cx: &Context, input: Option<&JsonValue>) -> Result<JsonValue, Problem> {
    let input = input.map(domain).unwrap_or(Domain::Object(vec![]));
    let Domain::Object(entries) = &input else {
        return Err(Problem::Invalid("input must be an object".into()));
    };
    if let Some((key, _)) = entries.iter().find(|(key, _)| {
        !["id", "directory", "agent", "model"]
            .iter()
            .any(|name| units(name) == *key)
    }) {
        return Err(Problem::Invalid(format!(
            "unknown input field {}",
            String::from_utf16_lossy(key)
        )));
    }
    let id = field(&input, "id").ok_or_else(|| Problem::Invalid("missing input.id".into()))?;
    check_domain(Rule::Session, id)
        .map_err(|message| Problem::Invalid(format!("input.id {message}")))?;
    let Some(Domain::Text(id)) = field(&input, "id") else {
        return Err(Problem::Invalid("input.id must be text".into()));
    };
    let id =
        String::from_utf16(id).map_err(|_| Problem::Invalid("input.id must be text".into()))?;
    let Some(Domain::Text(directory)) = field(&input, "directory") else {
        return Err(Problem::Invalid("input.directory must be text".into()));
    };
    let directory = String::from_utf16(directory)
        .map_err(|_| Problem::Invalid("input.directory must be well-formed text".into()))?;
    let agent = match field(&input, "agent") {
        None => None,
        Some(Domain::Text(agent)) if (1..=128).contains(&agent.len()) => Some(
            String::from_utf16(agent)
                .map_err(|_| Problem::Invalid("input.agent must be well-formed text".into()))?,
        ),
        Some(_) => {
            return Err(Problem::Invalid(
                "input.agent must be 1–128 characters".into(),
            ));
        }
    };
    let model = field(&input, "model")
        .map(|model| {
            domain_json::encode("ycoding.v5.Model_Ref", model, REQUEST_BYTES)
                .ok()
                .and_then(|bytes| v5::ModelRef::decode(bytes.as_slice()).ok())
                .ok_or_else(|| Problem::Invalid("input.model is not a model reference".into()))
        })
        .transpose()?;
    if !Path::new(&directory).is_absolute() {
        return Err(Problem::Invalid(
            "input.directory must be an absolute path".into(),
        ));
    }
    let directory = home_descendant(&cx.home, Path::new(&directory))?;
    let core = cx
        .environment
        .services
        .core
        .as_ref()
        .ok_or_else(|| Problem::Engine("agent_unavailable", "Core is not ready".into()))?;
    let session_id = session::Id::decode(&JsonValue::String(id.as_str().into()))
        .map_err(|_| Problem::Invalid("input.id is not a Session ID".into()))?;
    if let Some(recorded) = core.sessions.get(&session_id).map_err(|_| {
        Problem::Engine(
            "agent_unavailable",
            "The Session store is unavailable".into(),
        )
    })? && (recorded.parent_id.is_some()
        || recorded.location.directory.as_lossless().as_str() != Some(directory.as_str())
        || recorded.location.workspace_id.is_some())
    {
        return Err(Problem::Engine(
            "invalid_message",
            "The Session ID belongs to another Location or Session family".into(),
        ));
    }
    let invocation = Invocation {
        environment: cx.environment.clone(),
        connection_id: cx.connection_id.clone(),
        scope: v5::Scope {
            target: Some(v5::scope::Target::Location(convert::text(&directory))),
        },
        request_id: format!("mcp-{}", NEXT.fetch_add(1, Ordering::Relaxed)),
        remote: false,
        mcp: None,
        cancelled: cx.access.cancellation(),
    };
    let created = crate::session_create::create(
        invocation,
        v5::SessionCreateRequest {
            payload: v5::SessionCreateRequestPayload {
                id: Some(convert::text(&id)),
                parent_id: None,
                agent: agent.as_deref().map(convert::text),
                model,
                location: None,
            },
        },
    )
    .await
    .map_err(|failure| {
        Problem::Engine(
            "invalid_message",
            format!("Session creation was refused: {failure:?}"),
        )
    })?;
    crate::remote_derived::target::verify(core, &session_id).map_err(|_| {
        Problem::Engine(
            "agent_unavailable",
            "The created Session's backend Location could not be verified".into(),
        )
    })?;
    decoded(
        &v5::SessionCreateResult::full_name(),
        &created.encode_to_vec(),
    )
}

fn home_descendant(home: &Path, directory: &Path) -> Result<String, Problem> {
    let home = std::fs::canonicalize(home).map_err(|_| {
        Problem::Engine("internal_error", "The home directory is unavailable".into())
    })?;
    let canonical = std::fs::canonicalize(directory)
        .ok()
        .filter(|path| path.is_dir())
        .ok_or_else(|| {
            Problem::Invalid("input.directory does not name an existing directory".into())
        })?;
    if canonical
        .strip_prefix(&home)
        .map_or(true, |relative| relative.as_os_str().is_empty())
    {
        return Err(Problem::Invalid(
            "input.directory must be strictly below the home directory".into(),
        ));
    }
    canonical
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| Problem::Invalid("input.directory must be well-formed text".into()))
}

fn local_app_result(value: JsonValue) -> Result<JsonValue, Problem> {
    let data = get(&value, "data").cloned().ok_or_else(|| {
        Problem::Engine(
            "internal_error",
            "Local application result is unavailable".into(),
        )
    })?;
    let result = complete(data)?;
    Ok(match get(&value, "metadata") {
        Some(metadata) => extend(result, vec![("_meta", metadata.clone())]),
        None => result,
    })
}

fn complete(value: JsonValue) -> Result<JsonValue, Problem> {
    let text = stringify_json(&value);
    let length = text.encode_utf16().count();
    if length > RESULT_BYTES {
        return Err(too_large(length));
    }
    Ok(object([
        (
            "content",
            JsonValue::Array(vec![object([
                ("type", string("text")),
                ("text", string(&text)),
            ])]),
        ),
        ("structuredContent", value),
    ]))
}

fn too_large(length: usize) -> Problem {
    Problem::Engine(
        "message_too_large",
        format!(
            "Result is {length} characters, above the {RESULT_BYTES} character limit. Narrow the request or page with a cursor, after, or limit."
        ),
    )
}

fn engine_failure(code: &str, message: &str) -> JsonValue {
    object([
        ("isError", JsonValue::Bool(true)),
        (
            "content",
            JsonValue::Array(vec![object([
                ("type", string("text")),
                ("text", string(&format!("{code}: {message}"))),
            ])]),
        ),
        (
            "structuredContent",
            object([(
                "error",
                object([("code", string(code)), ("message", string(message))]),
            )]),
        ),
    ])
}

fn declared_failure(type_name: &str, value: JsonValue) -> JsonValue {
    let summary = [
        get(&value, "code"),
        get(&value, "kind"),
        get(&value, "message"),
    ]
    .into_iter()
    .flatten()
    .filter_map(text)
    .collect::<Vec<_>>()
    .join(": ");
    let text_value = if summary.is_empty() {
        type_name.to_owned()
    } else {
        format!("{type_name}: {summary}")
    };
    object([
        ("isError", JsonValue::Bool(true)),
        (
            "content",
            JsonValue::Array(vec![object([
                ("type", string("text")),
                ("text", string(&text_value)),
            ])]),
        ),
        (
            "structuredContent",
            object([(
                "error",
                object([("type", string(type_name)), ("value", value)]),
            )]),
        ),
    ])
}

fn check(rule: Rule, value: &JsonValue) -> Result<(), String> {
    check_domain(rule, &domain(value))
}

fn check_domain(rule: Rule, value: &Domain) -> Result<(), String> {
    let Domain::Text(units) = value else {
        return Err("must be text".into());
    };
    let text = String::from_utf16(units).map_err(|_| "must be well-formed text".to_owned())?;
    let identifier = |prefix: &str, max: usize, punctuation: bool| {
        text.encode_utf16().count() <= max
            && text.strip_prefix(prefix).is_some_and(|rest| {
                !rest.is_empty()
                    && rest.chars().all(|character| {
                        character.is_ascii_alphanumeric()
                            || (punctuation && (character == '_' || character == '-'))
                    })
            })
    };
    let valid = match rule {
        Rule::Prefix(prefix, max) => identifier(prefix, max, true),
        Rule::Session => identifier("ses", 128, true),
        Rule::Shell => identifier("sh_", 128, false),
        Rule::Nonblank => text.chars().any(|character| !pattern_space(character)),
        Rule::Required | Rule::Absent => true,
    };
    if valid {
        return Ok(());
    }
    Err(match rule {
        Rule::Prefix(prefix, max) => {
            format!("must match ^{prefix}[A-Za-z0-9_-]+$ within {max} characters")
        }
        Rule::Session => "must match ^ses[A-Za-z0-9_-]+$".into(),
        Rule::Shell => "must match ^sh_[A-Za-z0-9]+$".into(),
        _ => "must contain a non-whitespace character".into(),
    })
}

fn pattern_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{000b}' | '\u{000c}' | '\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn field<'a>(value: &'a Domain, key: &str) -> Option<&'a Domain> {
    let Domain::Object(entries) = value else {
        return None;
    };
    let key = units(key);
    entries
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| value)
}

fn object_domain<const N: usize>(entries: [(&str, Domain); N]) -> Domain {
    Domain::Object(
        entries
            .into_iter()
            .map(|(key, value)| (units(key), value))
            .collect(),
    )
}

fn units(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}
