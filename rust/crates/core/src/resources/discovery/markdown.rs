use std::{
    collections::BTreeMap,
    fmt,
    sync::{Mutex, OnceLock},
};
use yaml_rust2::{
    parser::{Event, EventReceiver, Parser, Tag},
    scanner::TScalarStyle,
};
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(LosslessString),
    Array(Vec<Value>),
    Object(Vec<(LosslessString, Value)>),
    Timestamp(String),
    Binary(Vec<u8>),
    Cycle,
    Merge,
}
#[derive(Clone)]
pub struct Markdown {
    pub data: Value,
    pub content: String,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    Invalid(String),
    UnsupportedExecutable,
    UnsupportedTimestampKey,
    NonJson,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self { Self::Invalid(s) => f.write_str(s), Self::UnsupportedExecutable => f.write_str("This executable JS/TS/npm plugin and provider configuration is not supported. Remove this declaration before loading this configuration."), Self::UnsupportedTimestampKey=>f.write_str("Unquoted timestamp mapping keys require host-local Date.toString time-zone labels, which this native parser does not supply"), Self::NonJson => f.write_str("Frontmatter value is not JSON") }
    }
}
impl std::error::Error for Error {}
impl Value {
    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(o) => o
                .iter()
                .find(|(k, _)| k == &LosslessString::from(key))
                .map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn json(&self) -> Result<JsonValue, Error> {
        Ok(match self {
            Self::Null => JsonValue::Null,
            Self::Bool(v) => JsonValue::Bool(*v),
            Self::Number(v) if v.is_finite() => JsonValue::Number(*v),
            Self::String(v) => JsonValue::String(v.clone()),
            Self::Merge => JsonValue::String("<<".into()),
            Self::Array(v) => JsonValue::Array(v.iter().map(Self::json).collect::<Result<_, _>>()?),
            Self::Object(o) => {
                let mut result = JsonObject::new();
                for (k, v) in o {
                    result.insert(k.clone(), v.json()?);
                }
                JsonValue::Object(result)
            }
            _ => return Err(Error::NonJson),
        })
    }
    pub fn fields(&self, keys: &[&str]) -> Result<JsonObject, Error> {
        let mut object = JsonObject::new();
        for key in keys {
            if let Some(v) = self.get(key) {
                object.insert((*key).into(), v.json()?);
            }
        }
        Ok(object)
    }
    pub fn snapshot(&self) -> JsonValue {
        match self {
            Self::Timestamp(v) => tagged("date", JsonValue::String(v.as_str().into())),
            Self::Binary(v) => tagged(
                "binary",
                JsonValue::Array(v.iter().map(|v| JsonValue::Number(f64::from(*v))).collect()),
            ),
            Self::Number(v) if !v.is_finite() || (*v == 0.0 && v.is_sign_negative()) => tagged(
                "number",
                JsonValue::String(
                    if v.is_nan() {
                        "NaN"
                    } else if *v == f64::INFINITY {
                        "Infinity"
                    } else if *v == f64::NEG_INFINITY {
                        "-Infinity"
                    } else {
                        "-0"
                    }
                    .into(),
                ),
            ),
            Self::Array(v) => JsonValue::Array(v.iter().map(Self::snapshot).collect()),
            Self::Object(o) => {
                let mut result = JsonObject::new();
                for (k, v) in o {
                    result.insert(k.clone(), v.snapshot());
                }
                JsonValue::Object(result)
            }
            Self::Cycle => {
                let mut o = JsonObject::new();
                o.insert("$type".into(), JsonValue::String("cycle".into()));
                JsonValue::Object(o)
            }
            _ => self.json().expect("JSON scalar"),
        }
    }
}
fn tagged(kind: &str, value: JsonValue) -> JsonValue {
    let mut o = JsonObject::new();
    o.insert("$type".into(), JsonValue::String(kind.into()));
    o.insert("value".into(), value);
    JsonValue::Object(o)
}

pub fn parse(content: &str) -> Result<Markdown, Error> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE
        .get_or_init(|| Mutex::new(Cache::default()))
        .lock()
        .map_err(|_| Error::Invalid("Frontmatter cache lock was poisoned".into()))?
        .parse(content)
}
#[derive(Default)]
pub struct Cache {
    values: BTreeMap<String, Markdown>,
}
impl Cache {
    pub fn parse(&mut self, content: &str) -> Result<Markdown, Error> {
        match self.matter(content) {
            Ok(markdown) => Ok(markdown),
            Err(Error::UnsupportedExecutable) => Err(Error::UnsupportedExecutable),
            Err(error @ Error::UnsupportedTimestampKey) => {
                self.values
                    .remove(content.strip_prefix('\u{feff}').unwrap_or(content));
                Err(error)
            }
            Err(_) => self.matter(&sanitize(content)),
        }
    }
    fn matter(&mut self, content: &str) -> Result<Markdown, Error> {
        let content = content.strip_prefix('\u{feff}').unwrap_or(content);
        if let Some(rest) = content.strip_prefix("---").filter(|s| !s.starts_with('-')) {
            let language = super::trim(rest.split('\n').next().unwrap_or(""));
            if ["javascript", "js", "typescript", "ts"].contains(&language) {
                return Err(Error::UnsupportedExecutable);
            }
        }
        if let Some(value) = self.values.get(content) {
            return Ok(value.clone());
        }
        self.values.insert(
            content.into(),
            Markdown {
                data: Value::Object(Vec::new()),
                content: content.into(),
            },
        );
        let parsed = parse_once(content)?;
        self.values.insert(content.into(), parsed.clone());
        Ok(parsed)
    }
}
fn parse_once(content: &str) -> Result<Markdown, Error> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let Some(rest) = content.strip_prefix("---").filter(|s| !s.starts_with('-')) else {
        return Ok(Markdown {
            data: Value::Object(Vec::new()),
            content: content.into(),
        });
    };
    let first_line = rest.split('\n').next().unwrap_or("").trim_end_matches('\r');
    let language = super::trim(first_line);
    let rest = &rest[first_line.len()..];
    if ["javascript", "js", "typescript", "ts"].contains(&language) {
        return Err(Error::UnsupportedExecutable);
    }
    let closing = rest.find("\n---");
    let (block, body) = match closing {
        Some(index) => {
            let body = &rest[index + 4..];
            (
                rest[..index].to_string(),
                body.strip_prefix('\r')
                    .unwrap_or(body)
                    .strip_prefix('\n')
                    .unwrap_or(body.strip_prefix('\r').unwrap_or(body))
                    .to_string(),
            )
        }
        None => (rest.to_string(), String::new()),
    };
    let empty = block.lines().all(|line| {
        let line = super::trim(line);
        line.is_empty() || line.starts_with('#')
    });
    if empty {
        return Ok(Markdown {
            data: Value::Object(Vec::new()),
            content: body,
        });
    }
    let data = match language {
        "" | "yaml" => yaml(&block)?,
        "json" => from_json(
            &ycoding_schema::parse_json(&block).map_err(|e| Error::Invalid(e.to_string()))?,
        ),
        _ => {
            return Err(Error::Invalid(format!(
                "Frontmatter engine is not registered for {language}"
            )));
        }
    };
    Ok(Markdown {
        data,
        content: body,
    })
}
fn from_json(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(v) => Value::Bool(*v),
        JsonValue::Number(v) => Value::Number(*v),
        JsonValue::String(v) => Value::String(v.clone()),
        JsonValue::Array(v) => Value::Array(v.iter().map(from_json).collect()),
        JsonValue::Object(o) => {
            Value::Object(o.iter().map(|(k, v)| (k.clone(), from_json(v))).collect())
        }
    }
}
pub fn sanitize(content: &str) -> String {
    let Some(rest) = content
        .strip_prefix("---\r\n")
        .or_else(|| content.strip_prefix("---\n"))
    else {
        return content.into();
    };
    let Some(end) = rest.find("\n---") else {
        return content.into();
    };
    let block = rest[..end].trim_end_matches('\r');
    let lines = block
        .split('\n')
        .flat_map(|line| {
            let line = line.trim_end_matches('\r');
            let trimmed = super::trim(line);
            if trimmed.is_empty()
                || trimmed.starts_with('#')
                || line.chars().next().is_some_and(super::whitespace)
            {
                return vec![line.to_string()];
            }
            let Some((key, value)) = line.split_once(':') else {
                return vec![line.into()];
            };
            let key = key.trim_end_matches(super::whitespace);
            let valid = key
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
                && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
            let value = super::trim(value);
            if !valid
                || value.is_empty()
                || value == ">"
                || value == "|"
                || value.starts_with(['\'', '"'])
                || !value.contains(':')
            {
                return vec![line.into()];
            }
            vec![format!("{key}: |-"), format!("  {value}")]
        })
        .collect::<Vec<_>>()
        .join("\n");
    content.replacen(block, &lines, 1)
}
#[derive(Default)]
struct Events(Vec<Event>);
impl EventReceiver for Events {
    fn on_event(&mut self, event: Event) {
        self.0.push(event);
    }
}
fn yaml(text: &str) -> Result<Value, Error> {
    let (text, surrogates) = escaped_surrogates(text)?;
    let mut events = Events::default();
    Parser::new_from_str(&text)
        .load(&mut events, true)
        .map_err(|e| Error::Invalid(e.to_string()))?;
    if events
        .0
        .iter()
        .filter(|e| **e == Event::DocumentStart)
        .count()
        > 1
    {
        return Err(Error::Invalid("Expected a single YAML document".into()));
    }
    let mut position = events
        .0
        .iter()
        .position(|e| !matches!(e, Event::StreamStart | Event::DocumentStart))
        .unwrap_or(0);
    if matches!(events.0.get(position), Some(Event::DocumentEnd)) {
        return Ok(Value::Null);
    }
    node(&events.0, &mut position, &mut BTreeMap::new(), &surrogates)
}
fn node(
    events: &[Event],
    position: &mut usize,
    anchors: &mut BTreeMap<usize, Value>,
    surrogates: &BTreeMap<char, u16>,
) -> Result<Value, Error> {
    let event = events
        .get(*position)
        .ok_or_else(|| Error::Invalid("Unexpected YAML end".into()))?;
    *position += 1;
    let (value, anchor) = match event {
        Event::Scalar(text, style, anchor, tag) => {
            let value = scalar(text, *style, tag.as_ref())?;
            let value = match value {
                Value::String(s) => Value::String(LosslessString::from_utf16(
                    s.as_str()
                        .expect("scanner emits Unicode scalars")
                        .chars()
                        .flat_map(|c| match surrogates.get(&c) {
                            Some(u) => vec![*u],
                            None => c.encode_utf16(&mut [0; 2]).to_vec(),
                        })
                        .collect(),
                )),
                value => value,
            };
            (value, *anchor)
        }
        Event::Alias(id) => (anchors.get(id).cloned().unwrap_or(Value::Cycle), 0),
        Event::SequenceStart(anchor, tag) => {
            let mut values = Vec::new();
            while !matches!(events.get(*position), Some(Event::SequenceEnd)) {
                values.push(node(events, position, anchors, surrogates)?);
            }
            *position += 1;
            let value = match tag.as_ref().map(tag_name).transpose()?.as_deref() {
                None | Some("seq") => Value::Array(values),
                Some("omap") | Some("pairs") => {
                    let pairs = tag.as_ref().is_some_and(|t| t.suffix == "pairs");
                    let mut keys = Vec::new();
                    let mut output = Vec::new();
                    for value in values {
                        let Value::Object(o) = &value else {
                            return Err(Error::Invalid("Invalid YAML ordered mapping".into()));
                        };
                        if o.len() != 1 || (!pairs && keys.contains(&o[0].0)) {
                            return Err(Error::Invalid("Invalid YAML ordered mapping".into()));
                        }
                        keys.push(o[0].0.clone());
                        output.push(if pairs {
                            Value::Array(vec![Value::String(o[0].0.clone()), o[0].1.clone()])
                        } else {
                            value
                        });
                    }
                    Value::Array(output)
                }
                _ => return Err(Error::Invalid("Invalid YAML sequence tag".into())),
            };
            (value, *anchor)
        }
        Event::MappingStart(anchor, tag) => {
            let mut output = Vec::new();
            let mut explicit = Vec::new();
            while !matches!(events.get(*position), Some(Event::MappingEnd)) {
                let key = node(events, position, anchors, surrogates)?;
                let value = node(events, position, anchors, surrogates)?;
                if key == Value::Merge {
                    merge(&mut output, &value)?;
                    continue;
                }
                let key = key_string(&key)?;
                if explicit.contains(&key) {
                    return Err(Error::Invalid("Duplicated mapping key".into()));
                }
                explicit.push(key.clone());
                insert(&mut output, key, value);
            }
            *position += 1;
            match tag.as_ref().map(tag_name).transpose()?.as_deref() {
                None | Some("map") => {}
                Some("set") if output.iter().all(|(_, v)| *v == Value::Null) => {}
                _ => return Err(Error::Invalid("Invalid YAML mapping tag".into())),
            }
            (Value::Object(output), *anchor)
        }
        _ => return Err(Error::Invalid("Unexpected YAML event".into())),
    };
    if anchor != 0 {
        anchors.insert(anchor, value.clone());
    }
    Ok(value)
}
fn tag_name(tag: &Tag) -> Result<String, Error> {
    if tag.handle == "tag:yaml.org,2002:" {
        return Ok(tag.suffix.clone());
    }
    if tag.handle == "!" && tag.suffix.is_empty() {
        return Ok("str".into());
    }
    Err(Error::Invalid("Unknown YAML tag".into()))
}
fn insert(output: &mut Vec<(LosslessString, Value)>, key: LosslessString, value: Value) {
    if let Some((_, current)) = output.iter_mut().find(|(k, _)| k == &key) {
        *current = value;
        return;
    }
    output.push((key, value));
}
fn merge(output: &mut Vec<(LosslessString, Value)>, value: &Value) -> Result<(), Error> {
    if let Value::Array(items) = value {
        for value in items {
            merge(output, value)?;
        }
        return Ok(());
    }
    let Value::Object(o) = value else {
        return Err(Error::Invalid("Cannot merge a non-mapping value".into()));
    };
    for (k, v) in o {
        if !output.iter().any(|(key, _)| key == k) {
            output.push((k.clone(), v.clone()));
        }
    }
    Ok(())
}
fn key_string(value: &Value) -> Result<LosslessString, Error> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Null => Ok("null".into()),
        Value::Bool(v) => Ok(v.to_string().as_str().into()),
        Value::Number(v) => Ok(if v.is_nan() {
            "NaN".into()
        } else if *v == f64::INFINITY {
            "Infinity".into()
        } else if *v == f64::NEG_INFINITY {
            "-Infinity".into()
        } else if *v == 0.0 {
            "0".into()
        } else {
            ycoding_schema::stringify_json(&JsonValue::Number(*v)).into()
        }),
        Value::Object(_) => Ok("[object Object]".into()),
        Value::Array(v) => Ok(super::join(
            &v.iter()
                .map(|v| {
                    if *v == Value::Null {
                        Ok("".into())
                    } else {
                        key_string(v)
                    }
                })
                .collect::<Result<Vec<_>, _>>()?,
            ",",
        )),
        Value::Timestamp(_) => Err(Error::UnsupportedTimestampKey),
        _ => Err(Error::Invalid("Unsupported YAML mapping key".into())),
    }
}

fn escaped_surrogates(text: &str) -> Result<(String, BTreeMap<char, u16>), Error> {
    let mut used = text
        .chars()
        .map(u32::from)
        .collect::<std::collections::BTreeSet<_>>();
    let bytes = text.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b != b'\\' {
            continue;
        }
        let length = match bytes.get(i + 1) {
            Some(b'u') => 4,
            Some(b'U') => 8,
            _ => continue,
        };
        if let Some(value) = text
            .get(i + 2..i + 2 + length)
            .and_then(|s| u32::from_str_radix(s, 16).ok())
        {
            used.insert(value);
        }
    }
    let mut result = String::new();
    let mut replacements = BTreeMap::new();
    let mut quote = None;
    let mut comment = false;
    let mut previous = '\n';
    let mut position = 0;
    while position < text.len() {
        let c = text[position..]
            .chars()
            .next()
            .expect("position is a character boundary");
        if comment {
            if c == '\n' {
                comment = false;
            }
            result.push(c);
            previous = c;
            position += c.len_utf8();
            continue;
        }
        if quote == Some('"') && c == '\\' {
            let next = text.as_bytes().get(position + 1).copied();
            let length = match next {
                Some(b'u') => 4,
                Some(b'U') => 8,
                _ => 0,
            };
            if length > 0
                && let Some(value) = text
                    .get(position + 2..position + 2 + length)
                    .and_then(|s| u32::from_str_radix(s, 16).ok())
                    .filter(|v| (0xd800..=0xdfff).contains(v))
            {
                let marker = (0xf0000..=0xffffd)
                    .find(|c| !used.contains(c))
                    .ok_or_else(|| {
                        Error::Invalid("YAML surrogate representation exhausted".into())
                    })?;
                used.insert(marker);
                let marker = char::from_u32(marker).expect("private use scalar");
                replacements.insert(marker, value as u16);
                result.push(marker);
                position += length + 2;
                previous = marker;
                continue;
            }
            result.push(c);
            position += 1;
            if let Some(next) = text[position..].chars().next() {
                result.push(next);
                position += next.len_utf8();
                previous = next;
            }
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                if q == '\'' && text[position + c.len_utf8()..].starts_with('\'') {
                    result.push(c);
                    result.push(c);
                    position += 2;
                    previous = c;
                    continue;
                }
                quote = None;
            }
        } else if c == '#' && previous.is_whitespace() {
            comment = true;
        } else if matches!(c, '\'' | '"')
            && (previous.is_whitespace() || ":,[]{}?-".contains(previous))
        {
            quote = Some(c);
        }
        result.push(c);
        previous = c;
        position += c.len_utf8();
    }
    Ok((result, replacements))
}

fn scalar(text: &str, style: TScalarStyle, tag: Option<&Tag>) -> Result<Value, Error> {
    let tag = tag.map(tag_name).transpose()?;
    if tag.as_deref() == Some("str") || (tag.is_none() && style != TScalarStyle::Plain) {
        return Ok(Value::String(text.into()));
    }
    let null = text.is_empty() || ["~", "null", "Null", "NULL"].contains(&text);
    let boolean = match text {
        "true" | "True" | "TRUE" => Some(true),
        "false" | "False" | "FALSE" => Some(false),
        _ => None,
    };
    match tag.as_deref() {
        Some("null") if null => return Ok(Value::Null),
        Some("bool") if boolean.is_some() => return Ok(Value::Bool(boolean.expect("checked"))),
        Some("int") => {
            return integer(text)
                .map(Value::Number)
                .ok_or_else(|| Error::Invalid("Invalid YAML integer".into()));
        }
        Some("float") => {
            return float(text)
                .map(Value::Number)
                .ok_or_else(|| Error::Invalid("Invalid YAML float".into()));
        }
        Some("timestamp") => {
            return timestamp(text)
                .map(Value::Timestamp)
                .ok_or_else(|| Error::Invalid("Invalid YAML timestamp".into()));
        }
        Some("binary") => return binary(text).map(Value::Binary),
        Some("merge") if text == "<<" => return Ok(Value::Merge),
        Some(_) => return Err(Error::Invalid("Unknown or invalid YAML scalar tag".into())),
        None => {}
    }
    if null {
        return Ok(Value::Null);
    }
    if let Some(v) = boolean {
        return Ok(Value::Bool(v));
    }
    if let Some(v) = integer(text) {
        return Ok(Value::Number(v));
    }
    if let Some(v) = float(text) {
        return Ok(Value::Number(v));
    }
    if let Some(v) = timestamp(text) {
        return Ok(Value::Timestamp(v));
    }
    if text == "<<" {
        return Ok(Value::Merge);
    }
    Ok(Value::String(text.into()))
}
fn integer(text: &str) -> Option<f64> {
    let sign = if text.starts_with('-') { -1.0 } else { 1.0 };
    let text = text.strip_prefix(['-', '+']).unwrap_or(text);
    if text == "0" {
        return Some(0.0);
    }
    if text.is_empty() || text.starts_with('_') || text.ends_with('_') {
        return None;
    }
    let (base, digits) = if let Some(text) = text.strip_prefix("0b") {
        (2, text)
    } else if let Some(text) = text.strip_prefix("0x") {
        (16, text)
    } else if let Some(text) = text.strip_prefix('0') {
        (8, text)
    } else {
        (10, text)
    };
    let digits = digits.replace('_', "");
    if base == 10 && digits.contains(':') {
        let mut parts = text.split(':');
        let first = parts.next()?;
        if first.is_empty() || !first.bytes().all(|b| b.is_ascii_digit() || b == b'_') {
            return None;
        }
        let mut value = first.replace('_', "").parse::<f64>().ok()?;
        for part in parts {
            if part.is_empty()
                || part.len() > 2
                || !part.bytes().all(|b| b.is_ascii_digit())
                || part.parse::<u8>().ok()? >= 60
            {
                return None;
            }
            value = value * 60.0 + part.parse::<f64>().ok()?;
        }
        return Some(sign * value);
    }
    if digits.is_empty() {
        return None;
    }
    let value = digits.chars().try_fold(0.0, |value, c| {
        c.to_digit(base)
            .map(|digit| value * f64::from(base) + f64::from(digit))
    })?;
    Some(sign * value)
}
fn matches(pattern: &str, text: &str) -> bool {
    let mut regex = crate::regexp::RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "")
        .expect("fixed YAML scalar pattern");
    regex
        .test(
            &text.encode_utf16().collect::<Vec<_>>(),
            &mut crate::regexp::Budget::unlimited(),
        )
        .expect("unlimited fixed pattern")
}
fn float(text: &str) -> Option<f64> {
    if !matches(
        r"^(?:[-+]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$",
        text,
    ) || text.ends_with('_')
    {
        return None;
    }
    let text = text.replace('_', "").to_lowercase();
    let sign = if text.starts_with('-') { -1.0 } else { 1.0 };
    let text = text.strip_prefix(['-', '+']).unwrap_or(&text);
    if text == ".inf" {
        return Some(sign * f64::INFINITY);
    }
    if text == ".nan" {
        return Some(f64::NAN);
    }
    if text.contains(':') {
        return text
            .split(':')
            .try_fold(0.0, |value, p| {
                p.parse::<f64>().ok().map(|p| value * 60.0 + p)
            })
            .map(|v| sign * v);
    }
    text.parse::<f64>().ok().map(|v| sign * v)
}
fn timestamp(text: &str) -> Option<String> {
    use chrono::{Datelike, Timelike};
    if !matches(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$", text)
        && !matches(
            r"^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?$",
            text,
        )
    {
        return None;
    }
    let (date, time) = text.split_once(['T', 't', ' ', '\t']).unwrap_or((text, ""));
    let mut parts = date.split('-').map(|p| p.parse::<u32>().ok());
    let year = parts.next()??;
    let year = if year < 100 { year + 1900 } else { year };
    let month = parts.next()??;
    let day = parts.next()??;
    let months = i64::from(year) * 12 + i64::from(month) - 1;
    let date = chrono::NaiveDate::from_ymd_opt(
        months.div_euclid(12) as i32,
        (months.rem_euclid(12) + 1) as u32,
        1,
    )?
    .checked_add_signed(chrono::Duration::days(i64::from(day) - 1))?;
    let time = time.trim_matches([' ', '\t']);
    let (time, zone) = match time.find(['Z', '+', '-']) {
        Some(i) => (&time[..i], &time[i..]),
        None => (time, ""),
    };
    let mut parts = time.trim_end_matches([' ', '\t']).split(':');
    let hour = parts
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<i64>().ok())
        .unwrap_or(Some(0))?;
    let minute = parts
        .next()
        .map(|s| s.parse::<i64>().ok())
        .unwrap_or(Some(0))?;
    let second = parts.next().unwrap_or("0");
    let (second, fraction) = second.split_once('.').unwrap_or((second, ""));
    let millis = fraction
        .chars()
        .take(3)
        .chain(std::iter::repeat('0'))
        .take(3)
        .collect::<String>()
        .parse::<i64>()
        .ok()?;
    let zone = if zone.is_empty() || zone == "Z" {
        0
    } else {
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let mut parts = zone[1..].split(':');
        sign * (parts.next()?.parse::<i64>().ok()? * 60
            + parts.next().unwrap_or("0").parse::<i64>().ok()?)
    };
    let timestamp = date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis()
        + ((hour * 60 + minute - zone) * 60 + second.parse::<i64>().ok()?) * 1000
        + millis;
    let date = chrono::DateTime::from_timestamp_millis(timestamp)?;
    let year = if (0..=9999).contains(&date.year()) {
        format!("{:04}", date.year())
    } else {
        format!("{:+07}", date.year())
    };
    Some(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second(),
        date.timestamp_subsec_millis()
    ))
}
fn binary(text: &str) -> Result<Vec<u8>, Error> {
    let text = text
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n'))
        .collect::<String>();
    if text.len() % 4 != 0
        || !text.chars().all(|c| {
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".contains(c)
        })
    {
        return Err(Error::Invalid("Invalid YAML binary".into()));
    }
    let text = text.replace('=', "");
    if text.is_empty() {
        return Ok(vec![0, 0, 0]);
    }
    let mut output = Vec::new();
    let mut bits = 0u32;
    let mut count = 0;
    for c in text.chars().filter(|c| !matches!(c, '\r' | '\n')) {
        let digit = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            .find(c)
            .ok_or_else(|| Error::Invalid("Invalid YAML binary".into()))?;
        bits = (bits << 6) | digit as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            output.push((bits >> count) as u8);
        }
    }
    Ok(output)
}
