use super::okf::{Diagnostic, Level, diagnostic, parse_timestamp};
use crate::regexp::{Budget, RegExp};
use serde_json::{Map, Number, Value};
use std::sync::LazyLock;
use yaml_rust2::Yaml;

pub const PINNED_COMMIT: &str = "527e81aff55992be21507e97004286789126f88c";
pub const SCHEMA_TEXT: &str = include_str!("okf-v0.3-content.derived.schema.json");

const LABEL: &str = "content schema derived from the OKF v0.3 SPEC.md at 527e81a, not official";
const ANNOTATIONS: [&str; 3] = ["x-okf-severity", "x-okf-spec", "x-okf-expect"];
const KEYWORDS: [&str; 22] = [
    "$schema",
    "$id",
    "$ref",
    "$defs",
    "title",
    "description",
    "type",
    "required",
    "properties",
    "items",
    "enum",
    "const",
    "pattern",
    "minimum",
    "allOf",
    "if",
    "then",
    "additionalProperties",
    "x-okf-derived-from",
    "x-okf-severity-keyword",
    "x-okf-format",
    "x-okf-list",
];
const ANNOTATION_KEYWORDS: [&str; 3] = ["x-okf-severity", "x-okf-spec", "x-okf-expect"];

static SCHEMA: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(SCHEMA_TEXT).unwrap_or(Value::Null));
static NULL: Value = Value::Null;

pub fn unsupported_keywords() -> Vec<String> {
    fn walk(node: &Value, in_properties: bool, found: &mut Vec<String>) {
        match node {
            Value::Object(map) => {
                for (key, child) in map {
                    if key == "x-okf-derived-from" {
                        continue;
                    }
                    let known = in_properties
                        || KEYWORDS.contains(&key.as_str())
                        || ANNOTATION_KEYWORDS.contains(&key.as_str());
                    if !known && !found.contains(key) {
                        found.push(key.clone());
                    }
                    let names_properties = matches!(key.as_str(), "properties" | "$defs");
                    walk(child, names_properties, found);
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, false, found)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    walk(&SCHEMA, false, &mut found);
    found
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Violation {
    path: String,
    message: String,
    severity: String,
    spec: String,
}

#[derive(Clone, Default)]
struct Context {
    severity: Option<String>,
    spec: Option<String>,
    expect: Option<String>,
}
impl Context {
    fn inherit(&self, node: &Map<String, Value>) -> Self {
        let pick = |key: &str, current: &Option<String>| {
            node.get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| current.clone())
        };
        Self {
            severity: pick(ANNOTATIONS[0], &self.severity),
            spec: pick(ANNOTATIONS[1], &self.spec),
            expect: pick(ANNOTATIONS[2], &self.expect),
        }
    }
    fn without_expectation(&self) -> Self {
        Self {
            expect: None,
            ..self.clone()
        }
    }
    fn violation(&self, path: &str, message: String) -> Violation {
        Violation {
            path: path.into(),
            message,
            severity: self.severity.clone().unwrap_or_else(|| "error".into()),
            spec: self.spec.clone().unwrap_or_default(),
        }
    }
    fn expected(&self, fallback: &str) -> String {
        self.expect.clone().unwrap_or_else(|| fallback.into())
    }
}

fn blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}
fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
fn matches_type(expected: &str, value: &Value) -> bool {
    let actual = json_type(value);
    actual == expected || (expected == "number" && actual == "integer")
}
fn search(text: &str, pattern: &str) -> bool {
    let units = text.encode_utf16().collect::<Vec<_>>();
    RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "")
        .ok()
        .and_then(|mut regex| regex.exec(&units, &mut Budget::unlimited()).ok().flatten())
        .is_some()
}
fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.into()
    } else {
        format!("{path}.{key}")
    }
}

fn resolve(root: &Value, node: &Value) -> Value {
    let Value::Object(map) = node else {
        return node.clone();
    };
    let Some(Value::String(reference)) = map.get("$ref") else {
        return node.clone();
    };
    let mut target = root;
    for part in reference.trim_start_matches("#/").split('/') {
        target = target.get(part).unwrap_or(&NULL);
    }
    let mut merged = match resolve(root, target) {
        Value::Object(base) => base,
        _ => Map::new(),
    };
    for (key, value) in map {
        if key != "$ref" {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

fn normalize(root: &Value, node: &Value, value: &Value) -> Value {
    let node = resolve(root, node);
    if let (Value::Object(map), Some(Value::Object(properties))) = (value, node.get("properties")) {
        let mut result = Map::new();
        for (key, item) in map {
            if blank(item) {
                continue;
            }
            let item = match properties.get(key) {
                Some(child) => normalize(root, child, item),
                None => item.clone(),
            };
            result.insert(key.clone(), item);
        }
        return Value::Object(result);
    }
    if node.get("x-okf-list").and_then(Value::as_bool) == Some(true) {
        let items = match value {
            Value::Array(items) => items.clone(),
            other => vec![other.clone()],
        };
        let element = node.get("items");
        return Value::Array(
            items
                .iter()
                .map(|item| match element {
                    Some(element) => normalize(root, element, item),
                    None => item.clone(),
                })
                .collect(),
        );
    }
    value.clone()
}

fn check(
    root: &Value,
    node: &Value,
    value: &Value,
    path: &str,
    inherited: &Context,
) -> Vec<Violation> {
    let node = resolve(root, node);
    let Value::Object(map) = &node else {
        return Vec::new();
    };
    let context = inherited.inherit(map);
    let mut found = Vec::new();
    if let Some(Value::Array(branches)) = map.get("allOf") {
        for branch in branches {
            found.extend(check(root, branch, value, path, &context));
        }
    }
    if let (Some(condition), Some(then)) = (map.get("if"), map.get("then"))
        && check(root, condition, value, path, &context).is_empty()
    {
        found.extend(check(root, then, value, path, &context));
    }
    if let Some(Value::String(expected)) = map.get("type")
        && !matches_type(expected, value)
    {
        found.push(context.violation(
            path,
            format!(
                "must be {}",
                context.expected(&format!("of type {expected}"))
            ),
        ));
        return found;
    }
    if let Some(Value::Array(allowed)) = map.get("enum")
        && !allowed.contains(value)
    {
        found.push(context.violation(
            path,
            format!("must be {}", context.expected("one of the allowed values")),
        ));
    }
    if let Some(constant) = map.get("const")
        && constant != value
    {
        found.push(context.violation(
            path,
            format!("must be {}", context.expected("the required constant")),
        ));
    }
    if let Value::String(text) = value {
        if let Some(Value::String(pattern)) = map.get("pattern")
            && !search(text, pattern)
        {
            found.push(context.violation(
                path,
                format!("must be {}", context.expected("in the required form")),
            ));
        }
        if map.get("x-okf-format").and_then(Value::as_str) == Some("okf-timestamp")
            && parse_timestamp(text).is_none()
        {
            found.push(context.violation(
                path,
                format!("must be {}", context.expected("in the required format")),
            ));
        }
    }
    if let (Value::Number(number), Some(minimum)) =
        (value, map.get("minimum").and_then(Value::as_f64))
        && number.as_f64().is_some_and(|actual| actual < minimum)
    {
        found.push(context.violation(
            path,
            format!(
                "must be {}",
                context.expected(&format!("at least {minimum}"))
            ),
        ));
    }
    if let (Value::Array(items), Some(element)) = (value, map.get("items")) {
        for (index, item) in items.iter().enumerate() {
            found.extend(check(
                root,
                element,
                item,
                &format!("{path}[{index}]"),
                &context,
            ));
        }
    }
    if let Value::Object(object) = value {
        if let Some(Value::Array(required)) = map.get("required") {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    found.push(context.violation(&join(path, key), "is required".into()));
                }
            }
        }
        if let Some(Value::Object(properties)) = map.get("properties") {
            for (key, child) in properties {
                if let Some(item) = object.get(key) {
                    found.extend(check(
                        root,
                        child,
                        item,
                        &join(path, key),
                        &context.without_expectation(),
                    ));
                }
            }
        }
    }
    found
}

fn to_json(value: &Yaml) -> Value {
    match value {
        Yaml::Hash(map) => Value::Object(
            map.iter()
                .map(|(key, item)| {
                    let name = match key {
                        Yaml::String(text) => text.clone(),
                        Yaml::Integer(number) => number.to_string(),
                        Yaml::Real(text) => text.clone(),
                        Yaml::Boolean(flag) => flag.to_string(),
                        _ => String::new(),
                    };
                    (name, to_json(item))
                })
                .collect(),
        ),
        Yaml::Array(items) => Value::Array(items.iter().map(to_json).collect()),
        Yaml::String(text) => Value::String(text.clone()),
        Yaml::Integer(number) => Value::Number(Number::from(*number)),
        Yaml::Real(text) => text
            .parse::<f64>()
            .ok()
            .and_then(Number::from_f64)
            .map_or_else(|| Value::String(text.clone()), Value::Number),
        Yaml::Boolean(flag) => Value::Bool(*flag),
        _ => Value::Null,
    }
}

fn diagnostics(definition: &str, yaml: &Yaml) -> Vec<Diagnostic> {
    let root = &*SCHEMA;
    let Some(node) = root.get("$defs").and_then(|defs| defs.get(definition)) else {
        return Vec::new();
    };
    let normal = normalize(root, node, &to_json(yaml));
    check(root, node, &normal, "", &Context::default())
        .into_iter()
        .map(|violation| {
            let subject = if violation.path.is_empty() {
                "frontmatter"
            } else {
                &violation.path
            };
            let (level, code) = if violation.severity == "error" {
                (Level::Error, "S100")
            } else {
                (Level::Warning, "S101")
            };
            diagnostic(
                level,
                code,
                format!(
                    "{subject} {} ({}; {LABEL})",
                    violation.message,
                    violation.spec.trim_start_matches('§')
                ),
                Some(1),
            )
        })
        .collect()
}

pub fn concept(yaml: &Yaml) -> Vec<Diagnostic> {
    diagnostics("concept", yaml)
}
pub fn bundle_index(yaml: &Yaml) -> Vec<Diagnostic> {
    diagnostics("bundleIndex", yaml)
}
