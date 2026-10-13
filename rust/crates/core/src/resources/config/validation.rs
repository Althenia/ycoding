use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue, LosslessString, ObjectEncoder,
    PathSegment, agent, config::Diagnostic, config::DiagnosticReason, domain, mcp, model,
    permission, provider, schema, shell, stringify_json,
};

#[derive(Clone, Copy)]
enum Shape {
    String,
    Nonempty,
    Nonblank,
    Bool,
    False,
    True,
    Int(f64, f64),
    Finite,
    Json,
    Unknown,
    Enum(&'static [&'static str]),
    Array(&'static Shape),
    Record(&'static Shape),
    Object(&'static [Field]),
    Union(&'static [Shape]),
    Selection,
    Color,
    MemoryLimit,
    Advisory,
    McpServer,
    McpTimeout,
}

struct Field {
    name: &'static str,
    shape: Shape,
    required: bool,
}

const fn optional(name: &'static str, shape: Shape) -> Field {
    Field {
        name,
        shape,
        required: false,
    }
}

const fn required(name: &'static str, shape: Shape) -> Field {
    Field {
        name,
        shape,
        required: true,
    }
}

const POSITIVE: Shape = Shape::Int(1.0, 9_007_199_254_740_991.0);
const NONNEGATIVE: Shape = Shape::Int(0.0, 9_007_199_254_740_991.0);
const INTEGER: Shape = Shape::Int(-9_007_199_254_740_991.0, 9_007_199_254_740_991.0);
const STRINGS: Shape = Shape::Array(&Shape::String);
const HEADERS: Shape = Shape::Record(&Shape::String);
const JSON_RECORD: Shape = Shape::Record(&Shape::Json);
const REQUEST: Shape =
    Shape::Object(&[optional("headers", HEADERS), optional("body", JSON_RECORD)]);
const RULE: Shape = Shape::Object(&[
    required("action", Shape::String),
    required("effect", Shape::Enum(&["allow", "deny", "ask"])),
    required("resource", Shape::String),
]);
const GUARDRAILS: Shape = Shape::Object(&[
    optional("enabled", Shape::Bool),
    optional("max_concurrent_shells", POSITIVE),
    optional("shell_wait_seconds", POSITIVE),
    optional("max_concurrent_subagents", POSITIVE),
    optional("max_pending_reviews", POSITIVE),
]);
const TIMEOUT: Shape = Shape::Object(&[
    optional("startup", POSITIVE),
    optional("catalog", POSITIVE),
    optional("execution", POSITIVE),
]);
const OAUTH: Shape = Shape::Union(&[
    Shape::False,
    Shape::Object(&[
        optional("client_id", Shape::String),
        optional("client_secret", Shape::String),
        optional("scope", Shape::String),
        optional("callback_port", Shape::Int(1.0, 65535.0)),
        optional("redirect_uri", Shape::String),
    ]),
]);
const MCP_SERVER: Shape = Shape::Union(&[
    Shape::Object(&[
        required("type", Shape::Enum(&["local"])),
        required("command", STRINGS),
        optional("cwd", Shape::String),
        optional("environment", HEADERS),
        optional("disabled", Shape::Bool),
        optional("codemode", Shape::Bool),
        optional("timeout", Shape::McpTimeout),
    ]),
    Shape::Object(&[
        required("type", Shape::Enum(&["remote"])),
        required("url", Shape::String),
        optional("headers", HEADERS),
        optional("oauth", OAUTH),
        optional("disabled", Shape::Bool),
        optional("codemode", Shape::Bool),
        optional("timeout", Shape::McpTimeout),
    ]),
]);
const MODEL_EXPLICIT: Shape = Shape::Object(&[
    required("providerID", Shape::Nonempty),
    required("model", Shape::Nonempty),
    optional("variant", Shape::Nonempty),
    optional("profile", Shape::Nonempty),
]);
const AGENT: Shape = Shape::Object(&[
    optional("model", Shape::Selection),
    optional("request", REQUEST),
    optional("system", Shape::String),
    optional("description", Shape::String),
    optional("mode", Shape::Enum(&["subagent", "primary", "all"])),
    optional("hidden", Shape::Bool),
    optional("color", Shape::Color),
    optional("steps", POSITIVE),
    optional("disabled", Shape::Bool),
    optional("permissions", Shape::Array(&RULE)),
]);
const COMMAND: Shape = Shape::Object(&[
    required("template", Shape::String),
    optional("description", Shape::String),
    optional("agent", Shape::String),
    optional("model", Shape::Selection),
    optional("subtask", Shape::Bool),
]);
const COST: Shape = Shape::Object(&[
    optional(
        "tier",
        Shape::Object(&[
            required("type", Shape::Enum(&["context"])),
            required("size", INTEGER),
        ]),
    ),
    required("input", Shape::Finite),
    required("output", Shape::Finite),
    optional(
        "cache",
        Shape::Object(&[
            optional("read", Shape::Finite),
            optional("write", Shape::Finite),
        ]),
    ),
]);
const PROVIDER_MODEL: Shape = Shape::Object(&[
    optional("modelID", Shape::String),
    optional("family", Shape::String),
    optional("name", Shape::String),
    optional("package", Shape::String),
    optional("settings", JSON_RECORD),
    optional("headers", HEADERS),
    optional("body", JSON_RECORD),
    optional(
        "capabilities",
        Shape::Object(&[
            optional("tools", Shape::Bool),
            optional("input", STRINGS),
            optional("output", STRINGS),
        ]),
    ),
    optional(
        "variants",
        Shape::Array(&Shape::Object(&[
            required("id", Shape::String),
            optional("settings", JSON_RECORD),
            optional("headers", HEADERS),
            optional("body", JSON_RECORD),
        ])),
    ),
    optional("cost", Shape::Union(&[COST, Shape::Array(&COST)])),
    optional("disabled", Shape::Bool),
    optional("api", Shape::Enum(&["chat", "responses"])),
    optional(
        "limit",
        Shape::Object(&[
            optional("context", INTEGER),
            optional("input", INTEGER),
            optional("output", INTEGER),
        ]),
    ),
]);
const PROVIDER: Shape = Shape::Object(&[
    optional("name", Shape::String),
    optional("env", STRINGS),
    optional("package", Shape::String),
    optional("settings", JSON_RECORD),
    optional("headers", HEADERS),
    optional("body", JSON_RECORD),
    optional(
        "catalog",
        Shape::Object(&[required("source", Shape::Enum(&["openai-models"]))]),
    ),
    optional("models", Shape::Record(&PROVIDER_MODEL)),
]);
const REFERENCE: Shape = Shape::Union(&[
    Shape::String,
    Shape::Object(&[
        required("repository", Shape::String),
        optional("branch", Shape::String),
        optional("description", Shape::String),
        optional("hidden", Shape::Bool),
    ]),
    Shape::Object(&[
        required("path", Shape::String),
        optional("description", Shape::String),
        optional("hidden", Shape::Bool),
    ]),
]);
const HELPER: Shape = Shape::Union(&[Shape::Enum(&["session"]), Shape::Selection]);
const ADVISORY: Shape = Shape::Union(&[
    Shape::False,
    Shape::Object(&[
        required("consider_percent", Shape::Int(1.0, 99.0)),
        required("strongly_advised_percent", Shape::Int(1.0, 99.0)),
    ]),
]);
const ROOT: Shape = Shape::Object(&[
    optional("extensions", Shape::Array(&Shape::Unknown)),
    optional("$schema", Shape::String),
    optional("shell", Shape::String),
    optional(
        "shell_sandbox",
        Shape::Enum(&["disabled", "optional", "required"]),
    ),
    optional("shell_memory_limit_mb", Shape::MemoryLimit),
    optional("model", Shape::Selection),
    optional("default_agent", Shape::String),
    optional(
        "autoupdate",
        Shape::Union(&[Shape::Bool, Shape::Enum(&["notify"])]),
    ),
    optional("share", Shape::Enum(&["manual", "auto", "disabled"])),
    optional(
        "enterprise",
        Shape::Object(&[optional("url", Shape::String)]),
    ),
    optional("username", Shape::String),
    optional("permissions", Shape::Array(&RULE)),
    optional("agents", Shape::Record(&AGENT)),
    optional("snapshots", Shape::Bool),
    optional("watcher", Shape::Object(&[optional("ignore", STRINGS)])),
    optional(
        "formatter",
        Shape::Union(&[
            Shape::Bool,
            Shape::Record(&Shape::Object(&[
                optional("disabled", Shape::Bool),
                optional("command", STRINGS),
                optional("environment", HEADERS),
                optional("extensions", STRINGS),
            ])),
        ]),
    ),
    optional(
        "lsp",
        Shape::Union(&[
            Shape::Bool,
            Shape::Record(&Shape::Union(&[
                Shape::Object(&[required("disabled", Shape::True)]),
                Shape::Object(&[
                    required("command", STRINGS),
                    optional("extensions", STRINGS),
                    optional("disabled", Shape::Bool),
                    optional("env", HEADERS),
                    optional("initialization", Shape::Record(&Shape::Unknown)),
                ]),
            ])),
        ]),
    ),
    optional(
        "attachments",
        Shape::Object(&[optional(
            "image",
            Shape::Object(&[
                optional("auto_resize", Shape::Bool),
                optional("max_width", POSITIVE),
                optional("max_height", POSITIVE),
                optional("max_base64_bytes", POSITIVE),
            ]),
        )]),
    ),
    optional(
        "tool_output",
        Shape::Object(&[
            optional("max_lines", POSITIVE),
            optional("max_bytes", POSITIVE),
        ]),
    ),
    optional(
        "mcp",
        Shape::Object(&[
            optional("timeout", Shape::McpTimeout),
            optional("servers", Shape::Record(&Shape::McpServer)),
        ]),
    ),
    optional(
        "compaction",
        Shape::Object(&[
            optional("keep_recent_messages", NONNEGATIVE),
            optional("reserved_output_tokens", NONNEGATIVE),
            optional("context_safety_margin_tokens", NONNEGATIVE),
            optional("timeout_seconds", NONNEGATIVE),
            optional("max_output_tokens", NONNEGATIVE),
            optional("max_manifest_bytes", NONNEGATIVE),
            optional("max_internal_passes", NONNEGATIVE),
            optional("advisory", Shape::Advisory),
        ]),
    ),
    optional(
        "session_retention",
        Shape::Object(&[optional("days", POSITIVE)]),
    ),
    optional(
        "memory",
        Shape::Object(&[
            optional("enabled", Shape::Bool),
            optional("path", Shape::Nonblank),
            optional("max_concept_bytes", POSITIVE),
            optional("max_bundle_bytes", POSITIVE),
            optional("max_concepts", POSITIVE),
        ]),
    ),
    optional(
        "prediction",
        Shape::Object(&[
            optional("enabled", Shape::Bool),
            optional("memory", Shape::Bool),
        ]),
    ),
    optional("guardrails", GUARDRAILS),
    optional("skills", STRINGS),
    optional("commands", Shape::Record(&COMMAND)),
    optional("instructions", STRINGS),
    optional("instruction_max_bytes", Shape::Int(1.0, 1_048_576.0)),
    optional("references", Shape::Record(&REFERENCE)),
    optional("providers", Shape::Record(&PROVIDER)),
    optional(
        "provider_usage",
        Shape::Object(&[optional(
            "codex_app_server",
            Shape::Object(&[
                required("command", Shape::Nonempty),
                optional("args", STRINGS),
                optional("cwd", Shape::String),
                optional("timeout_ms", Shape::Int(1.0, 30_000.0)),
            ]),
        )]),
    ),
    optional(
        "efficiency",
        Shape::Object(&[
            optional("title", Shape::Enum(&["local", "model", "off"])),
            optional(
                "helper_models",
                Shape::Object(&[
                    optional("title", HELPER),
                    optional("prediction", HELPER),
                    optional("prompt", HELPER),
                    optional("goal", HELPER),
                    optional("decision", HELPER),
                    optional(
                        "compaction",
                        Shape::Object(&[optional("main", HELPER), optional("subagent", HELPER)]),
                    ),
                ]),
            ),
            optional(
                "prompt_cache",
                Shape::Object(&[
                    optional("anthropic_ttl", Shape::Enum(&["adaptive", "5m", "1h"])),
                    optional(
                        "openai_mode",
                        Shape::Enum(&["auto", "implicit", "explicit"]),
                    ),
                    optional("openai_extended_retention", Shape::Bool),
                ]),
            ),
            optional(
                "openai_responses_continuation",
                Shape::Enum(&["auto", "on", "off"]),
            ),
            optional(
                "openai_responses_state",
                Shape::Enum(&["stored", "stateless"]),
            ),
        ]),
    ),
    optional(
        "image_analyzer",
        Shape::Object(&[
            optional("enabled", Shape::Bool),
            optional("model", Shape::String),
            optional("provider", Shape::String),
            optional("variant", Shape::String),
            optional("prompt", Shape::String),
            optional("template", Shape::String),
            optional("max_images", POSITIVE),
            optional("max_bytes", POSITIVE),
        ]),
    ),
    optional(
        "experimental",
        Shape::Object(&[
            optional("subagent_depth", NONNEGATIVE),
            optional(
                "policies",
                Shape::Array(&Shape::Object(&[
                    required("action", Shape::Enum(&["provider.use"])),
                    required("resource", Shape::String),
                    required("effect", Shape::Enum(&["allow", "deny"])),
                ])),
            ),
        ]),
    ),
]);

#[derive(Clone, Copy, PartialEq)]
enum IssueKind {
    Invalid,
    Missing,
    Unknown,
}

struct Issue {
    path: JsonPath,
    kind: IssueKind,
}

fn inspect(value: &JsonValue, shape: Shape, path: &JsonPath) -> Result<JsonValue, Vec<Issue>> {
    let invalid = || {
        vec![Issue {
            path: path.clone(),
            kind: IssueKind::Invalid,
        }]
    };
    match shape {
        Shape::Object(fields) => {
            let JsonValue::Object(object) = value else {
                return Err(invalid());
            };
            let mut output = JsonObject::new();
            let mut issues = Vec::new();
            for (key, value) in object.iter() {
                let field = fields
                    .iter()
                    .find(|field| key == &LosslessString::from(field.name));
                let Some(field) = field else {
                    issues.push(Issue {
                        path: path.key(key.clone()),
                        kind: IssueKind::Unknown,
                    });
                    continue;
                };
                match inspect(value, field.shape, &path.key(key.clone())) {
                    Ok(value) => {
                        output.insert(key.clone(), value);
                    }
                    Err(errors) => issues.extend(errors),
                }
            }
            for field in fields
                .iter()
                .filter(|field| field.required && object.get(&field.name.into()).is_none())
            {
                issues.push(Issue {
                    path: path.key(field.name),
                    kind: IssueKind::Missing,
                });
            }
            if issues.is_empty() {
                return Ok(JsonValue::Object(output));
            }
            Err(issues)
        }
        Shape::Record(entry) => {
            let JsonValue::Object(object) = value else {
                return Err(invalid());
            };
            let mut output = JsonObject::new();
            let mut issues = Vec::new();
            for (key, value) in object.iter() {
                match inspect(value, *entry, &path.key(key.clone())) {
                    Ok(value) => {
                        output.insert(key.clone(), value);
                    }
                    Err(errors) => issues.extend(errors),
                }
            }
            if issues.is_empty() {
                return Ok(JsonValue::Object(output));
            }
            Err(issues)
        }
        Shape::Array(entry) => {
            let JsonValue::Array(values) = value else {
                return Err(invalid());
            };
            let mut output = Vec::new();
            let mut issues = Vec::new();
            for (index, value) in values.iter().enumerate() {
                match inspect(value, *entry, &path.index(index)) {
                    Ok(value) => output.push(value),
                    Err(errors) => issues.extend(errors),
                }
            }
            if issues.is_empty() {
                return Ok(JsonValue::Array(output));
            }
            Err(issues)
        }
        Shape::Union(alternatives) => {
            let mut failures = Vec::new();
            for alternative in alternatives {
                match inspect(value, *alternative, path) {
                    Ok(value) => return Ok(value),
                    Err(issues) => failures.push(issues),
                }
            }
            Err(failures
                .into_iter()
                .find(|issues| {
                    !issues.is_empty()
                        && issues.iter().all(|issue| issue.kind == IssueKind::Unknown)
                })
                .unwrap_or_else(invalid))
        }
        Shape::Selection => match selection(value) {
            Some(selection) => {
                if matches!(value, JsonValue::Object(_)) {
                    inspect(value, MODEL_EXPLICIT, path)?;
                }
                Ok(ObjectEncoder::new()
                    .field("providerID", &selection.provider_id)
                    .field("model", &selection.id)
                    .optional("variant", &selection.variant)
                    .optional("profile", &selection.profile)
                    .finish())
            }
            None => Err(invalid()),
        },
        Shape::Advisory => {
            let output = inspect(value, ADVISORY, path)?;
            if let JsonValue::Object(object) = &output {
                let Some(JsonValue::Number(consider)) = object.get(&"consider_percent".into())
                else {
                    return Err(invalid());
                };
                let Some(JsonValue::Number(strong)) =
                    object.get(&"strongly_advised_percent".into())
                else {
                    return Err(invalid());
                };
                if consider >= strong {
                    return Err(invalid());
                }
            }
            Ok(output)
        }
        Shape::McpServer => {
            let output = inspect(value, MCP_SERVER, path)?;
            mcp::ServerConfig::decode_at(&output, path)
                .map(|config| config.encode())
                .map_err(|_| invalid())
        }
        Shape::McpTimeout => {
            let output = inspect(value, TIMEOUT, path)?;
            mcp::TimeoutConfig::decode_at(&output, path)
                .map(|config| config.encode())
                .map_err(|_| invalid())
        }
        _ => {
            let valid = match shape {
                Shape::String => LosslessString::decode(value).is_ok(),
                Shape::Nonempty => LosslessString::decode(value).is_ok_and(|text| !text.is_empty()),
                Shape::Nonblank => LosslessString::decode(value).is_ok_and(|text| {
                    text.code_units()
                        .any(|unit| !super::variable::is_js_whitespace(unit))
                }),
                Shape::Bool => bool::decode(value).is_ok(),
                Shape::False => matches!(value, JsonValue::Bool(false)),
                Shape::True => matches!(value, JsonValue::Bool(true)),
                Shape::Int(minimum, maximum) => {
                    schema::Int::decode(value).is_ok()
                        && matches!(value, JsonValue::Number(number) if *number >= minimum && *number <= maximum)
                }
                Shape::Finite => schema::Finite::decode(value).is_ok(),
                Shape::Json => domain::Json::decode(value).is_ok(),
                Shape::Unknown => true,
                Shape::Enum(allowed) => domain::literal_enum(value, allowed, path).is_ok(),
                Shape::Color => agent::Color::decode(value).is_ok(),
                Shape::MemoryLimit => shell::MemoryLimitMb::decode(value).is_ok(),
                _ => unreachable!(),
            };
            if valid {
                return Ok(value.clone());
            }
            Err(invalid())
        }
    }
}

fn selection(value: &JsonValue) -> Option<model::Ref> {
    if let JsonValue::Object(object) = value {
        let text = |key: &str| match object.get(&key.into()) {
            Some(JsonValue::String(text)) => Some(text.clone()),
            _ => None,
        };
        let provider = text("providerID")?;
        let id = text("model")?;
        let variant = match object.get(&"variant".into()) {
            Some(_) => Some(text("variant")?),
            None => None,
        };
        let profile = match object.get(&"profile".into()) {
            Some(_) => Some(text("profile")?),
            None => None,
        };
        if provider.is_empty()
            || provider.code_units().any(|unit| matches!(unit, 47 | 35))
            || id.is_empty()
            || id.code_units().any(|unit| unit == 35)
            || variant.as_ref().is_some_and(|variant| {
                variant.is_empty() || variant.code_units().any(|unit| unit == 35)
            })
            || profile.as_ref().is_some_and(LosslessString::is_empty)
        {
            return None;
        }
        return Some(model::Ref {
            provider_id: provider::Id(provider),
            id,
            variant,
            profile: profile.map(model::ProfileName),
        });
    }
    let JsonValue::String(text) = value else {
        return None;
    };
    let units = text.code_units().collect::<Vec<_>>();
    let slash = units.iter().position(|unit| *unit == 47)?;
    let before = &units[..slash];
    let after = &units[slash + 1..];
    let prefix = before.split(|unit| *unit == 35).collect::<Vec<_>>();
    let suffix = after.split(|unit| *unit == 35).collect::<Vec<_>>();
    if !(1..=2).contains(&prefix.len())
        || !(1..=2).contains(&suffix.len())
        || prefix.iter().chain(&suffix).any(|piece| piece.is_empty())
    {
        return None;
    }
    Some(model::Ref {
        provider_id: provider::Id(LosslessString::from_utf16(prefix.last()?.to_vec())),
        id: LosslessString::from_utf16(suffix[0].to_vec()),
        variant: suffix
            .get(1)
            .map(|units| LosslessString::from_utf16(units.to_vec())),
        profile: (prefix.len() == 2)
            .then(|| model::ProfileName(LosslessString::from_utf16(prefix[0].to_vec()))),
    })
}

pub(super) fn diagnostic(
    target: &str,
    path: Option<&JsonPath>,
    reason: &str,
    message: &str,
    fail_closed: bool,
) -> Diagnostic {
    Diagnostic {
        path: target.into(),
        reason: DiagnosticReason(reason.into()),
        json_path: path.map(|path| json_path(path).into()),
        fail_closed: fail_closed.then_some(true),
        message: message.into(),
    }
}

fn json_path(path: &JsonPath) -> String {
    let mut output = "$".to_owned();
    for segment in &path.0 {
        match segment {
            PathSegment::Index(index) => output.push_str(&format!("[{index}]")),
            PathSegment::Key(key) => {
                let identifier = key.as_str().is_some_and(|text| {
                    !text.is_empty()
                        && text.bytes().enumerate().all(|(index, byte)| {
                            byte.is_ascii_alphabetic()
                                || byte == b'_'
                                || byte == b'$'
                                || (index > 0 && byte.is_ascii_digit())
                        })
                });
                if identifier {
                    output.push('.');
                    output.push_str(key.as_str().unwrap_or_default());
                    continue;
                }
                output.push_str(&format!(
                    "[{}]",
                    stringify_json(&JsonValue::String(key.clone()))
                ));
            }
        }
    }
    output
}

pub(super) fn recover(mut input: JsonValue, target: &str) -> super::DecodedDocument {
    let mut diagnostics = Vec::new();
    if !matches!(input, JsonValue::Object(_)) {
        diagnostics.push(diagnostic(
            target,
            Some(&JsonPath::default()),
            "invalid-values",
            "Expected a configuration object",
            false,
        ));
        input = JsonValue::Object(JsonObject::new());
    }
    let obsolete = obsolete_paths(&input);
    if !obsolete.is_empty() {
        return super::DecodedDocument {
            info: None,
            diagnostics: obsolete.iter().map(|path| diagnostic(
                target, Some(path), "removed-keys",
                "This executable JS/TS/npm plugin and provider configuration is not supported. Remove this declaration before loading this configuration.",
                true,
            )).collect(),
        };
    }
    repair_security(&mut input, &JsonPath::default(), target, &mut diagnostics);
    loop {
        match inspect(&input, ROOT, &JsonPath::default()) {
            Ok(info) => {
                return super::DecodedDocument {
                    info: Some(info),
                    diagnostics,
                };
            }
            Err(issues) => {
                let issues = issues
                    .into_iter()
                    .map(|mut issue| {
                        if issue.kind == IssueKind::Missing {
                            issue.path.0.pop();
                        }
                        if issue.kind != IssueKind::Unknown {
                            let keys = issue
                                .path
                                .0
                                .iter()
                                .map(|segment| match segment {
                                    PathSegment::Key(key) => key.as_str(),
                                    _ => None,
                                })
                                .collect::<Vec<_>>();
                            let length = if keys.first() == Some(&Some("mcp"))
                                && keys.get(1) == Some(&Some("servers"))
                                && keys.len() > 2
                            {
                                3
                            } else if keys.first().is_some_and(|key| {
                                matches!(key, Some("providers" | "commands" | "references"))
                            }) && keys.len() > 1
                            {
                                2
                            } else {
                                keys.len()
                            };
                            issue.path.0.truncate(length);
                        }
                        issue
                    })
                    .collect::<Vec<_>>();
                let units = issues
                    .iter()
                    .enumerate()
                    .filter(|(index, issue)| {
                        !issues.iter().enumerate().any(|(other_index, other)| {
                            (other.path.0.len() < issue.path.0.len()
                                || (other.path.0.len() == issue.path.0.len()
                                    && other_index < *index))
                                && issue.path.0.starts_with(&other.path.0)
                        })
                    })
                    .map(|(_, issue)| issue)
                    .collect::<Vec<_>>();
                for unit in &units {
                    let (reason, message) = if unit.kind == IssueKind::Unknown {
                        ("removed-keys", "Removed or unknown configuration key")
                    } else {
                        (
                            "invalid-values",
                            "Value does not match the configuration schema",
                        )
                    };
                    diagnostics.push(diagnostic(target, Some(&unit.path), reason, message, false));
                }
                for unit in units.into_iter().rev() {
                    remove(&mut input, &unit.path.0);
                }
            }
        }
    }
}

fn obsolete_paths(input: &JsonValue) -> Vec<JsonPath> {
    let JsonValue::Object(object) = input else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for key in ["plugins", "plugin", "npm", "provider"] {
        if object.get(&key.into()).is_some() {
            paths.push(JsonPath::default().key(key));
        }
    }
    if let Some(JsonValue::Object(providers)) = object.get(&"providers".into()) {
        for (name, value) in providers.iter() {
            let path = JsonPath::default().key("providers").key(name.clone());
            obsolete_provider_paths(value, &path, true, &mut paths);
        }
    }
    paths
}

fn obsolete_provider_paths(
    value: &JsonValue,
    path: &JsonPath,
    provider: bool,
    paths: &mut Vec<JsonPath>,
) {
    match value {
        JsonValue::Object(object) => {
            for (key, value) in object.iter() {
                let path = path.key(key.clone());
                if matches!(key.as_str(), Some("npm" | "plugin"))
                    || (key.as_str() == Some("package")
                        && matches!(value, JsonValue::String(_))
                        && !(provider && super::is_native_endpoint_package(value)))
                {
                    paths.push(path);
                    continue;
                }
                obsolete_provider_paths(value, &path, false, paths);
            }
        }
        JsonValue::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                obsolete_provider_paths(value, &path.index(index), false, paths);
            }
        }
        _ => (),
    }
}

fn repair_security(
    input: &mut JsonValue,
    path: &JsonPath,
    target: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let JsonValue::Object(object) = input else {
        return;
    };
    if let Some(value) = object.get(&"permissions".into()) {
        let permission_path = path.key("permissions");
        let denied = |action: LosslessString| {
            permission::Rule {
                action,
                resource: "*".into(),
                effect: permission::Effect("deny".into()),
            }
            .encode()
        };
        let repaired = match value {
            JsonValue::Array(rules) => {
                let mut valid = Vec::new();
                let mut deny = Vec::new();
                for (index, rule) in rules.iter().enumerate() {
                    let errors = match inspect(rule, RULE, &permission_path.index(index)) {
                        Ok(_) => {
                            valid.push(rule.clone());
                            continue;
                        }
                        Err(errors) => errors,
                    };
                    let action = match rule {
                        JsonValue::Object(rule) => match rule.get(&"action".into()) {
                            Some(JsonValue::String(action))
                                if action
                                    .code_units()
                                    .any(|unit| !super::variable::is_js_whitespace(unit)) =>
                            {
                                Some(action.clone())
                            }
                            _ => None,
                        },
                        _ => None,
                    };
                    let message = if action.is_some() {
                        "Invalid permission rule; fails closed by denying its action on every resource"
                    } else {
                        "Invalid permission rule; fails closed by denying every action on every resource"
                    };
                    deny.push(denied(action.unwrap_or_else(|| "*".into())));
                    diagnostics.push(diagnostic(
                        target,
                        Some(&permission_path.index(index)),
                        if errors.iter().any(|issue| issue.kind == IssueKind::Unknown) {
                            "removed-keys"
                        } else {
                            "invalid-values"
                        },
                        message,
                        true,
                    ));
                }
                valid.extend(deny);
                JsonValue::Array(valid)
            }
            _ => {
                diagnostics.push(diagnostic(target, Some(&permission_path), "invalid-values", "Invalid permission ruleset; fails closed by denying every action on every resource", true));
                JsonValue::Array(vec![denied("*".into())])
            }
        };
        object.insert("permissions".into(), repaired);
    }
    if path.0.is_empty() {
        if let Some(JsonValue::Object(agents)) = object.get(&"agents".into()) {
            let mut repaired = JsonObject::new();
            for (name, value) in agents.iter() {
                let mut value = value.clone();
                repair_security(
                    &mut value,
                    &path.key("agents").key(name.clone()),
                    target,
                    diagnostics,
                );
                repaired.insert(name.clone(), value);
            }
            object.insert("agents".into(), JsonValue::Object(repaired));
        }
        if let Some(guardrails) = object.get(&"guardrails".into())
            && let Err(errors) = inspect(guardrails, GUARDRAILS, &path.key("guardrails"))
        {
            object.insert(
                "guardrails".into(),
                ObjectEncoder::new().field("enabled", &true).finish(),
            );
            diagnostics.push(diagnostic(
                target,
                Some(&path.key("guardrails")),
                if errors.iter().any(|issue| issue.kind == IssueKind::Unknown) {
                    "removed-keys"
                } else {
                    "invalid-values"
                },
                "Invalid guardrails value; fails closed with guardrails enabled and default limits",
                true,
            ));
        }
    }
}

fn remove(value: &mut JsonValue, path: &[PathSegment]) {
    let Some((first, rest)) = path.split_first() else {
        *value = JsonValue::Object(JsonObject::new());
        return;
    };
    match (value, first) {
        (JsonValue::Object(object), PathSegment::Key(key)) => {
            *object = object
                .iter()
                .filter_map(|(name, value)| {
                    if name != key {
                        return Some((name.clone(), value.clone()));
                    }
                    if rest.is_empty() {
                        return None;
                    }
                    let mut value = value.clone();
                    remove(&mut value, rest);
                    Some((name.clone(), value))
                })
                .fold(JsonObject::new(), |mut object, (key, value)| {
                    object.insert(key, value);
                    object
                });
        }
        (JsonValue::Array(values), PathSegment::Index(index)) => {
            if !rest.is_empty() {
                if let Some(value) = values.get_mut(*index) {
                    remove(value, rest);
                }
                return;
            }
            if *index < values.len() {
                values.remove(*index);
            }
        }
        _ => {}
    }
}
