use chrono::{DateTime, NaiveDate, Utc};
use std::collections::{BTreeMap, BTreeSet};
use yaml_rust2::{
    Yaml, YamlLoader,
    parser::{Event, Parser},
};

pub const VERSION: &str = "0.3";
const YAML_BUDGET: usize = 8 * 1024 * 1024;
const YAML_DEPTH: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Error,
    Warning,
    Info,
    Advice,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub level: Level,
    pub code: &'static str,
    pub message: String,
    pub line: Option<usize>,
}
pub fn diagnostic(
    level: Level,
    code: &'static str,
    message: impl Into<String>,
    line: Option<usize>,
) -> Diagnostic {
    Diagnostic {
        level,
        code,
        message: message.into(),
        line,
    }
}

pub enum Split<'a> {
    Absent,
    Unterminated,
    Block {
        yaml: &'a str,
        body: &'a str,
        body_line: usize,
    },
}
fn delimiter(line: &str) -> bool {
    line.trim_end_matches(['\r', '\n']) == "---"
}
pub fn split(text: &str) -> Split<'_> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.split_inclusive('\n');
    if !lines.next().is_some_and(delimiter) {
        return Split::Absent;
    }
    let start = text.find('\n').map_or(text.len(), |at| at + 1);
    let mut offset = start;
    for (line_number, line) in (2..).zip(lines) {
        if delimiter(line) {
            return Split::Block {
                yaml: &text[start..offset],
                body: &text[offset + line.len()..],
                body_line: line_number + 1,
            };
        }
        offset += line.len();
    }
    Split::Unterminated
}

#[derive(Debug, PartialEq, Eq)]
pub enum YamlFailure {
    Invalid,
    Duplicate { key: String, line: usize },
    NotMapping,
    TooLarge,
}
pub fn mapping(block: &str) -> Result<Yaml, YamlFailure> {
    let mut parser = Parser::new_from_str(block);
    let mut anchors = BTreeMap::new();
    let mut stack: Vec<(usize, usize)> = Vec::new();
    let mut frames: Vec<Option<(bool, BTreeSet<String>)>> = Vec::new();
    let mut allocation = 0usize;
    loop {
        let (event, marker) = parser.next_token().map_err(|_| YamlFailure::Invalid)?;
        let (anchor, size, allocated) = match event {
            Event::StreamEnd => break,
            Event::Scalar(value, _, anchor, _) => {
                if let Some(Some((expecting_key, keys))) = frames.last_mut() {
                    if *expecting_key && !keys.insert(value.to_string()) {
                        return Err(YamlFailure::Duplicate {
                            key: value.to_string(),
                            line: marker.line() + 1,
                        });
                    }
                    *expecting_key = !*expecting_key;
                }
                (anchor, value.len() + 64, value.len() + 64)
            }
            Event::SequenceStart(anchor, _) | Event::MappingStart(anchor, _) => {
                if stack.len() >= YAML_DEPTH {
                    return Err(YamlFailure::TooLarge);
                }
                let mapping = matches!(event, Event::MappingStart(..));
                frames.push(mapping.then(|| (true, BTreeSet::new())));
                stack.push((anchor, 64));
                continue;
            }
            Event::SequenceEnd | Event::MappingEnd => {
                frames.pop();
                if let Some(Some((expecting_key, _))) = frames.last_mut() {
                    *expecting_key = !*expecting_key;
                }
                let (anchor, size) = stack.pop().ok_or(YamlFailure::Invalid)?;
                (anchor, size, 64)
            }
            Event::Alias(id) => {
                if let Some(Some((expecting_key, _))) = frames.last_mut() {
                    *expecting_key = !*expecting_key;
                }
                let size = *anchors.get(&id).ok_or(YamlFailure::Invalid)?;
                (0, size, size)
            }
            _ => continue,
        };
        allocation = allocation.saturating_add(allocated);
        if anchor != 0 {
            anchors.insert(anchor, size);
            allocation = allocation.saturating_add(size);
        }
        if allocation > YAML_BUDGET {
            return Err(YamlFailure::TooLarge);
        }
        if let Some((_, parent)) = stack.last_mut() {
            *parent = parent.saturating_add(size);
        }
    }
    let mut documents = YamlLoader::load_from_str(block).map_err(|_| YamlFailure::Invalid)?;
    match documents.len() {
        0 => Ok(Yaml::Hash(Default::default())),
        1 => {
            let document = documents.remove(0);
            match document {
                Yaml::Hash(_) => Ok(document),
                Yaml::Null => Ok(Yaml::Hash(Default::default())),
                _ => Err(YamlFailure::NotMapping),
            }
        }
        _ => Err(YamlFailure::Invalid),
    }
}

pub fn blank(value: &Yaml) -> bool {
    match value {
        Yaml::BadValue | Yaml::Null => true,
        Yaml::String(text) => text.is_empty(),
        Yaml::Array(items) => items.is_empty(),
        _ => false,
    }
}
pub fn items(value: &Yaml) -> Vec<&Yaml> {
    if blank(value) {
        return Vec::new();
    }
    match value {
        Yaml::Array(items) => items.iter().collect(),
        item => vec![item],
    }
}
pub fn scalar(value: &Yaml) -> Option<String> {
    match value {
        Yaml::String(text) => Some(text.clone()),
        Yaml::Integer(number) => Some(number.to_string()),
        Yaml::Real(text) => Some(text.clone()),
        Yaml::Boolean(flag) => Some(flag.to_string()),
        _ => None,
    }
}
fn text(value: &Yaml) -> Option<&str> {
    value.as_str().filter(|text| !text.trim().is_empty())
}
fn field<'a>(value: &'a Yaml, key: &str) -> &'a Yaml {
    match value {
        Yaml::Hash(map) => map
            .get(&Yaml::String(key.into()))
            .unwrap_or(&Yaml::BadValue),
        _ => &Yaml::BadValue,
    }
}

fn parse_date_time(text: &str) -> Option<DateTime<Utc>> {
    let bytes = text.as_bytes();
    let digit = |at: usize| bytes.get(at).is_some_and(u8::is_ascii_digit);
    let shape = bytes.len() >= 20
        && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]
            .into_iter()
            .all(digit)
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && matches!(bytes[10], b'T' | b't')
        && bytes[13] == b':'
        && bytes[16] == b':';
    if !shape {
        return None;
    }
    let mut at = 19;
    if bytes.get(at) == Some(&b'.') {
        let start = at + 1;
        at = start;
        while digit(at) {
            at += 1;
        }
        if at == start {
            return None;
        }
    }
    let zone = &text[at..];
    let valid_zone = matches!(zone, "Z" | "z")
        || (zone.len() == 6
            && matches!(zone.as_bytes()[0], b'+' | b'-')
            && zone.as_bytes()[3] == b':'
            && zone[1..3].bytes().all(|b| b.is_ascii_digit())
            && zone[4..6].bytes().all(|b| b.is_ascii_digit()));
    if !valid_zone || &text[17..19] == "60" {
        return None;
    }
    let normalized = format!("{}T{}{}", &text[..10], &text[11..at], zone.to_uppercase());
    DateTime::parse_from_rfc3339(&normalized)
        .ok()
        .map(|moment| moment.with_timezone(&Utc))
}
pub fn parse_timestamp(text: &str) -> Option<DateTime<Utc>> {
    if text.len() == 10
        && let Ok(day) = NaiveDate::parse_from_str(text, "%Y-%m-%d")
        && text.bytes().filter(|b| *b == b'-').count() == 2
    {
        return day.and_hms_opt(0, 0, 0).map(|moment| moment.and_utc());
    }
    parse_date_time(text)
}
pub fn is_date_only(text: &str) -> bool {
    text.len() == 10 && parse_timestamp(text).is_some()
}
fn timestamp_value(value: &Yaml) -> Option<DateTime<Utc>> {
    value.as_str().and_then(parse_timestamp)
}

pub fn is_actor(value: &str) -> bool {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return false;
    }
    if let Some((producer, version)) = value.split_once('/')
        && !producer.is_empty()
        && !producer.contains(':')
        && !version.is_empty()
    {
        return true;
    }
    value.split_once(':').is_some_and(|(scheme, id)| {
        !id.is_empty()
            && scheme
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    })
}
pub fn is_human(actor: &str) -> bool {
    actor.starts_with("human:")
}
pub fn claims_human(actor: &str) -> bool {
    actor.trim().to_lowercase().starts_with("human:")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trust {
    Unverified,
    MachineConfirmed,
    HumanReviewed,
}
impl Trust {
    pub fn name(self) -> &'static str {
        match self {
            Self::Unverified => "unverified",
            Self::MachineConfirmed => "machine-confirmed",
            Self::HumanReviewed => "human-reviewed",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Stable,
    Draft,
    Deprecated,
    Unknown(String),
}
impl Status {
    pub fn name(&self) -> &str {
        match self {
            Self::Stable => "stable",
            Self::Draft => "draft",
            Self::Deprecated => "deprecated",
            Self::Unknown(raw) => raw,
        }
    }
    pub fn current(&self) -> bool {
        matches!(self, Self::Stable | Self::Draft)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Deadline {
    Absent,
    At(DateTime<Utc>),
    Malformed(String),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub id: Option<String>,
    pub resource: String,
    pub title: Option<String>,
    pub author: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verification {
    pub by: String,
    pub at: DateTime<Utc>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Generated {
    pub by: String,
    pub at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Meta {
    pub type_: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub resource: Option<String>,
    pub tags: Vec<String>,
    pub sources: Vec<Source>,
    pub generated: Option<Generated>,
    pub legacy_timestamp: Option<DateTime<Utc>>,
    pub verified: Vec<Verification>,
    pub status: Status,
    pub superseded_by: Option<String>,
    pub stale_after: Deadline,
    pub runtime: Option<String>,
    pub attester: Option<String>,
}
impl Meta {
    pub fn content_time(&self) -> Option<DateTime<Utc>> {
        self.generated
            .as_ref()
            .and_then(|generated| generated.at)
            .or(self.legacy_timestamp)
    }
    pub fn current_verifications(&self) -> Vec<&Verification> {
        let content = self.content_time();
        self.verified
            .iter()
            .filter(|event| content.is_none_or(|content| event.at >= content))
            .collect()
    }
    pub fn trust(&self) -> Trust {
        let current = self.current_verifications();
        if current.is_empty() {
            Trust::Unverified
        } else if current.iter().any(|event| is_human(&event.by)) {
            Trust::HumanReviewed
        } else {
            Trust::MachineConfirmed
        }
    }
    pub fn verification_older_than_content(&self) -> bool {
        !self.verified.is_empty() && self.current_verifications().is_empty()
    }
    pub fn stale(&self, now: DateTime<Utc>) -> bool {
        match &self.stale_after {
            Deadline::Absent => false,
            Deadline::At(deadline) => now >= *deadline,
            Deadline::Malformed(_) => true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Doc {
    pub yaml: Yaml,
    pub body: String,
    pub body_line: usize,
    pub meta: Meta,
    pub diagnostics: Vec<Diagnostic>,
}
pub enum Parsed {
    NotConcept(Diagnostic),
    Unterminated(Diagnostic),
    Invalid(Diagnostic),
    Concept(Box<Doc>),
}

pub fn parse(content: &str) -> Parsed {
    let (block, body, body_line) = match split(content) {
        Split::Absent => {
            return Parsed::NotConcept(diagnostic(
                Level::Warning,
                "W120",
                "not a concept: the file has no frontmatter (section 3.2)",
                Some(1),
            ));
        }
        Split::Unterminated => {
            return Parsed::Unterminated(diagnostic(
                Level::Error,
                "E002",
                "frontmatter does not parse as a YAML mapping: the closing --- line is missing (section 4)",
                Some(1),
            ));
        }
        Split::Block {
            yaml,
            body,
            body_line,
        } => (yaml, body, body_line),
    };
    let yaml = match mapping(block) {
        Ok(yaml) => yaml,
        Err(YamlFailure::Duplicate { key, line }) => {
            return Parsed::Invalid(diagnostic(
                Level::Error,
                "E007",
                format!("frontmatter repeats the key {key:?}; keys must be unique (section 4)"),
                Some(line + 1),
            ));
        }
        Err(YamlFailure::TooLarge) => {
            return Parsed::Invalid(diagnostic(
                Level::Error,
                "E002",
                "frontmatter exceeds the YAML size or depth limit (section 4)",
                Some(1),
            ));
        }
        Err(_) => {
            return Parsed::Invalid(diagnostic(
                Level::Error,
                "E002",
                "frontmatter does not parse as a YAML mapping (section 4)",
                Some(1),
            ));
        }
    };
    let Some(type_) = field(&yaml, "type").as_str().map(str::trim) else {
        return Parsed::NotConcept(diagnostic(
            Level::Warning,
            "W120",
            "not a concept: the frontmatter has no non-empty type (section 3.2)",
            Some(1),
        ));
    };
    if type_.is_empty() {
        return Parsed::NotConcept(diagnostic(
            Level::Warning,
            "W120",
            "not a concept: the frontmatter has no non-empty type (section 3.2)",
            Some(1),
        ));
    }
    let (meta, diagnostics) = extract(&yaml, type_, body);
    Parsed::Concept(Box::new(Doc {
        yaml,
        body: body.into(),
        body_line,
        meta,
        diagnostics,
    }))
}

fn extract(yaml: &Yaml, type_: &str, body: &str) -> (Meta, Vec<Diagnostic>) {
    let mut found = Vec::new();
    let mut warn = |code: &'static str, message: String| {
        found.push(diagnostic(Level::Warning, code, message, Some(1)));
    };
    let string_field = |key: &str, warn: &mut dyn FnMut(&'static str, String)| {
        let value = field(yaml, key);
        if blank(value) {
            return None;
        }
        if !matches!(value, Yaml::String(_)) {
            warn(
                "W117",
                format!("quote {key}: it parses as a non-string value, not a string (section 4)"),
            );
        }
        scalar(value)
    };
    let title = string_field("title", &mut warn);
    let description = string_field("description", &mut warn);
    let raw_status = string_field("status", &mut warn);
    let resource = scalar(field(yaml, "resource")).filter(|text| !text.is_empty());
    let tags_value = field(yaml, "tags");
    if !blank(tags_value) && !matches!(tags_value, Yaml::Array(_) | Yaml::String(_)) {
        warn(
            "W110",
            "write tags as a YAML list of strings (section 4.1)".into(),
        );
    } else if matches!(tags_value, Yaml::String(text) if text.contains(',')) {
        warn(
            "W110",
            "write tags as a YAML list (sections 4.1 and 11.2); a scalar value is one tag".into(),
        );
    }
    let tags = items(tags_value)
        .into_iter()
        .filter_map(scalar)
        .filter(|tag| !tag.trim().is_empty())
        .collect::<Vec<_>>();

    let mut sources = Vec::new();
    let mut ids = BTreeSet::new();
    let shared_window = !blank(field(yaml, "usage_window"));
    if shared_window {
        window(field(yaml, "usage_window"), "usage_window", &mut warn);
    }
    for (index, entry) in items(field(yaml, "sources")).into_iter().enumerate() {
        let name = format!("sources[{index}]");
        let Some(resource) = text(field(entry, "resource")) else {
            warn(
                "W106",
                format!("{name} needs a resource; consumers ignore it (section 5.1)"),
            );
            continue;
        };
        let id = scalar(field(entry, "id")).filter(|id| !id.is_empty());
        if let Some(id) = &id
            && !ids.insert(id.clone())
        {
            warn(
                "W107",
                format!("{name}.id {id:?} is not unique (section 5.1)"),
            );
        }
        let author = scalar(field(entry, "author")).filter(|text| !text.is_empty());
        if let Some(author) = &author
            && !is_actor(author)
        {
            warn(
                "W103",
                format!(
                    "{name}.author is an actor: <producer>/<version> or <scheme>:<id> (section 7)"
                ),
            );
        }
        let modified = field(entry, "last_modified");
        if !blank(modified) && timestamp_value(modified).is_none() {
            warn(
                "W101",
                format!("{name}.last_modified is not an RFC 3339 timestamp (section 5)"),
            );
        }
        let entry_window = !blank(field(entry, "usage_window"));
        if entry_window {
            window(
                field(entry, "usage_window"),
                &format!("{name}.usage_window"),
                &mut warn,
            );
        }
        if !blank(field(entry, "usage_count")) && !shared_window && !entry_window {
            warn(
                "W109",
                format!(
                    "{name}.usage_count needs a usage_window that gives its period (section 5.1)"
                ),
            );
        }
        sources.push(Source {
            id,
            resource: resource.into(),
            title: scalar(field(entry, "title")).filter(|text| !text.is_empty()),
            author,
        });
    }

    let generated_value = field(yaml, "generated");
    let mut generated = None;
    if !blank(generated_value) {
        match text(field(generated_value, "by")) {
            Some(by) if matches!(generated_value, Yaml::Hash(_)) => {
                if !is_actor(by) {
                    warn(
                        "W103",
                        "generated.by is an actor: <producer>/<version> or <scheme>:<id> (section 7)".into(),
                    );
                }
                let at_value = field(generated_value, "at");
                let at = timestamp_value(at_value);
                if !blank(at_value) && at.is_none() {
                    warn(
                        "W101",
                        "generated.at is not an RFC 3339 timestamp (section 5)".into(),
                    );
                }
                if at_value.as_str().is_some_and(is_date_only) {
                    warn(
                        "W122",
                        "write generated.at as a date-time, because consumers compare it with verified[].at (section 5)".into(),
                    );
                }
                generated = Some(Generated { by: by.into(), at });
            }
            _ => warn(
                "W102",
                "generated is a mapping with a by field (section 5.2)".into(),
            ),
        }
    }
    let legacy_timestamp = field(yaml, "timestamp").as_str().and_then(parse_timestamp);

    let mut verified = Vec::new();
    for (index, event) in items(field(yaml, "verified")).into_iter().enumerate() {
        let name = format!("verified[{index}]");
        let by = text(field(event, "by"));
        let at_value = field(event, "at");
        if by.is_none() || blank(at_value) {
            warn(
                "W104",
                format!("{name} needs by and at; consumers ignore it (section 5.2)"),
            );
            continue;
        }
        let by = by.unwrap_or_default();
        if !is_actor(by) {
            warn(
                "W103",
                format!("{name}.by is an actor: <producer>/<version> or <scheme>:<id> (section 7)"),
            );
        }
        let Some(at) = timestamp_value(at_value) else {
            warn(
                "W101",
                format!("{name}.at is not an RFC 3339 timestamp (section 5)"),
            );
            continue;
        };
        if at_value.as_str().is_some_and(is_date_only) {
            warn(
                "W122",
                format!(
                    "write {name}.at as a date-time, because consumers compare it with generated.at (section 5)"
                ),
            );
        }
        verified.push(Verification { by: by.into(), at });
    }

    let status = match raw_status.as_deref() {
        None => Status::Stable,
        Some("stable") => Status::Stable,
        Some("draft") => Status::Draft,
        Some("deprecated") => Status::Deprecated,
        Some(other) => {
            warn(
                "W105",
                "status is draft, stable, or deprecated; consumers treat other values as not current (section 5.4)".into(),
            );
            Status::Unknown(other.into())
        }
    };
    let superseded_by = scalar(field(yaml, "superseded_by")).filter(|text| !text.is_empty());
    if superseded_by.is_some() && status != Status::Deprecated {
        warn(
            "W123",
            "superseded_by has a meaning only with status: deprecated (section 5.4)".into(),
        );
    }
    let stale_value = field(yaml, "stale_after");
    let stale_after = if blank(stale_value) {
        Deadline::Absent
    } else {
        match timestamp_value(stale_value) {
            Some(deadline) => Deadline::At(deadline),
            None => {
                warn(
                    "W101",
                    "stale_after does not parse, so consumers never treat the concept as fresh (section 5.5)".into(),
                );
                Deadline::Malformed(scalar(stale_value).unwrap_or_default())
            }
        }
    };
    let runtime = text(field(yaml, "runtime")).map(Into::into);
    let attester = text(field(field(yaml, "attester"), "resource")).map(Into::into);

    if type_ == "Attested Computation" {
        attested(yaml, body, runtime.is_some(), &mut warn);
    }
    let unknown = match yaml {
        Yaml::Hash(map) => map
            .keys()
            .filter_map(Yaml::as_str)
            .filter(|key| !KNOWN.contains(key) && !key.starts_with("x-"))
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    if !unknown.is_empty() {
        found.push(diagnostic(
            Level::Info,
            "I203",
            format!(
                "extension keys without the x- prefix: {} (section 4.1)",
                unknown.join(", ")
            ),
            Some(1),
        ));
    }
    if verified.is_empty() || generated.is_none() {
    } else if verified.iter().all(|event| {
        generated
            .as_ref()
            .and_then(|g| g.at)
            .is_some_and(|at| event.at < at)
    }) {
        found.push(diagnostic(
            Level::Info,
            "I204",
            "no verification is current: each verified event is older than generated.at, so consumers read the concept as unverified (section 5.3)",
            Some(1),
        ));
    }
    if type_ == "Attested Computation" && attester.is_none() {
        found.push(diagnostic(
            Level::Info,
            "I205",
            "without an attester, consumers cannot show values from this computation as attested (section 10.2)",
            Some(1),
        ));
    }
    let meta = Meta {
        type_: type_.into(),
        title,
        description,
        resource,
        tags,
        sources,
        generated,
        legacy_timestamp,
        verified,
        status,
        superseded_by,
        stale_after,
        runtime,
        attester,
    };
    (meta, found)
}

const KNOWN: [&str; 18] = [
    "type",
    "title",
    "description",
    "resource",
    "tags",
    "sources",
    "usage_window",
    "generated",
    "verified",
    "status",
    "superseded_by",
    "stale_after",
    "runtime",
    "parameters",
    "computation",
    "executor",
    "attester",
    "timestamp",
];

fn window(value: &Yaml, name: &str, warn: &mut dyn FnMut(&'static str, String)) {
    let (from, to) = (field(value, "from"), field(value, "to"));
    if !matches!(value, Yaml::Hash(_)) || blank(from) || blank(to) {
        warn(
            "W101",
            format!("{name} is a {{ from, to }} mapping of timestamps (section 5.1)"),
        );
        return;
    }
    for (label, bound) in [("from", from), ("to", to)] {
        if timestamp_value(bound).is_none() {
            warn(
                "W101",
                format!("{name}.{label} is not an RFC 3339 timestamp (section 5)"),
            );
        }
    }
}

fn attested(
    yaml: &Yaml,
    body: &str,
    has_runtime: bool,
    warn: &mut dyn FnMut(&'static str, String),
) {
    if !has_runtime {
        warn(
            "W111",
            "an Attested Computation needs runtime (section 10.2)".into(),
        );
    }
    let fences = computation_fences(body);
    if !blank(field(yaml, "computation")) {
        if fences > 0 {
            warn(
                "W112",
                "with a computation field, do not also put a fenced block in the Computation section (section 10.3)".into(),
            );
        }
    } else if fences == 0 {
        warn(
            "W112",
            "no computation: no computation field and no fenced block in a Computation section, so the concept is not attestable (section 10.3)".into(),
        );
    } else if fences > 1 {
        warn(
            "W126",
            format!(
                "put exactly one fenced block in the Computation section; consumers use the first of {fences} (section 10.3)"
            ),
        );
    }
    for (index, parameter) in items(field(yaml, "parameters")).into_iter().enumerate() {
        if text(field(parameter, "name")).is_none() || text(field(parameter, "type")).is_none() {
            warn(
                "W113",
                format!("parameters[{index}] needs name and type (section 10.2)"),
            );
        }
    }
    for key in ["executor", "attester"] {
        let value = field(yaml, key);
        if blank(value) {
            continue;
        }
        if text(field(value, "resource")).is_none() {
            warn(
                "W114",
                format!("{key} is a mapping with a resource field (section 10.2)"),
            );
            continue;
        }
        if key == "executor" && !matches!(field(value, "receipt"), Yaml::Array(_)) {
            warn(
                "W114",
                "executor.receipt lists the fields that a run returns (section 10.2)".into(),
            );
        }
    }
}

fn fence_marker(line: &str) -> Option<&'static str> {
    let stripped = line.trim_start();
    if stripped.starts_with("```") {
        Some("```")
    } else if stripped.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}
fn heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_end();
    let level = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = trimmed[level..].strip_prefix([' ', '\t'])?;
    Some((
        level,
        rest.trim().trim_end_matches('#').trim().to_lowercase(),
    ))
}
pub fn computation_fences(body: &str) -> usize {
    let mut level = None;
    let mut count = 0;
    let mut fence = None;
    for line in body.lines() {
        if let Some(open) = fence {
            if line.trim_start().starts_with(open) {
                fence = None;
            }
            continue;
        }
        if let Some(marker) = fence_marker(line) {
            fence = Some(marker);
            if level.is_some() {
                count += 1;
            }
            continue;
        }
        if let Some((depth, name)) = heading(line) {
            if level.is_some_and(|level| depth <= level) {
                break;
            }
            if level.is_none() && name == "computation" {
                level = Some(depth);
            }
        }
    }
    count
}

pub fn prose_lines(body: &str) -> Vec<(usize, String)> {
    let mut fence = None;
    let mut lines = Vec::new();
    for (offset, line) in body.lines().enumerate() {
        if let Some(open) = fence {
            if line.trim_start().starts_with(open) {
                fence = None;
            }
            continue;
        }
        if let Some(marker) = fence_marker(line) {
            fence = Some(marker);
            continue;
        }
        if line.starts_with("    ") || line.starts_with('\t') {
            continue;
        }
        lines.push((offset, strip_inline_code(line)));
    }
    lines
}
fn strip_inline_code(line: &str) -> String {
    let mut result = String::new();
    let mut rest = line;
    while let Some(start) = rest.find('`') {
        result.push_str(&rest[..start]);
        match rest[start + 1..].find('`') {
            Some(end) => rest = &rest[start + end + 2..],
            None => {
                result.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    result.push_str(rest);
    result
}
pub fn footnote_labels(line: &str) -> Vec<String> {
    let mut labels = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find("[^") {
        let after = &rest[start + 2..];
        match after.find(']') {
            Some(end) if end > 0 && !after[..end].contains(char::is_whitespace) => {
                labels.push(after[..end].to_owned());
                rest = &after[end + 1..];
            }
            _ => rest = after,
        }
    }
    labels
}

#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    External,
    Outside,
    Local(String),
}
fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let pair = (bytes[at] == b'%' && at + 2 < bytes.len())
            .then(|| text.get(at + 1..at + 3))
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match pair {
            Some(byte) => {
                decoded.push(byte);
                at += 3;
            }
            None => {
                decoded.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}
fn has_scheme(target: &str) -> bool {
    target.split_once(':').is_some_and(|(scheme, _)| {
        scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    })
}
pub fn resolve(from: &str, target: &str) -> Target {
    if has_scheme(target) || target.starts_with("//") {
        return Target::External;
    }
    let path = target.split(['#', '?']).next().unwrap_or("");
    if path.is_empty() {
        return Target::Local(from.into());
    }
    let decoded = decode(path);
    let mut parts: Vec<&str> = if decoded.starts_with('/') {
        Vec::new()
    } else {
        let mut parts = from.split('/').collect::<Vec<_>>();
        parts.pop();
        parts
    };
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Target::Outside;
                }
            }
            part => parts.push(part),
        }
    }
    Target::Local(parts.join("/"))
}

pub struct View<'a> {
    pub paths: &'a BTreeSet<String>,
    pub legacy_root_fallback: bool,
}
impl View<'_> {
    pub fn concept_for(&self, from: &str, target: &str, field: bool) -> Option<String> {
        let Target::Local(path) = resolve(from, target) else {
            return None;
        };
        let direct = path
            .strip_suffix(".md")
            .filter(|_| self.paths.contains(&path));
        if let Some(id) = direct {
            return Some(id.into());
        }
        if field
            && self.legacy_root_fallback
            && !target.starts_with('/')
            && let Target::Local(path) = resolve(from, &format!("/{target}"))
        {
            return path
                .strip_suffix(".md")
                .filter(|_| self.paths.contains(&path))
                .map(Into::into);
        }
        None
    }
    fn lookup(&self, from: &str, target: &str, field: bool) -> Lookup {
        match resolve(from, target) {
            Target::External => Lookup::External,
            Target::Outside => Lookup::Missing,
            Target::Local(path) if self.paths.contains(&path) => Lookup::Found,
            Target::Local(_) if field && self.legacy_root_fallback && !target.starts_with('/') => {
                match resolve(from, &format!("/{target}")) {
                    Target::Local(path) if self.paths.contains(&path) => Lookup::Fallback,
                    _ => Lookup::Missing,
                }
            }
            Target::Local(_) => Lookup::Missing,
        }
    }
}
enum Lookup {
    External,
    Found,
    Fallback,
    Missing,
}

pub struct Relations {
    pub diagnostics: Vec<Diagnostic>,
    pub edges: BTreeSet<String>,
    pub replacement: Option<String>,
}

pub fn relations(path: &str, doc: &Doc, links: &[String], view: &View<'_>) -> Relations {
    let mut diagnostics = Vec::new();
    let mut edges = BTreeSet::new();
    let source_ids = doc
        .meta
        .sources
        .iter()
        .filter_map(|source| source.id.as_deref())
        .collect::<BTreeSet<_>>();
    let mut reported = BTreeSet::new();
    for (offset, line) in prose_lines(&doc.body) {
        for label in footnote_labels(&line) {
            if !source_ids.contains(label.as_str()) && reported.insert(label.clone()) {
                diagnostics.push(diagnostic(
                    Level::Warning,
                    "W108",
                    format!("footnote [^{label}] has no sources entry with that id (section 5.1)"),
                    Some(doc.body_line + offset),
                ));
            }
        }
    }
    let mut field_target = |name: String, value: &str, diagnostics: &mut Vec<Diagnostic>| match view
        .lookup(path, value, true)
    {
        Lookup::External => {}
        Lookup::Found => {
            if let Some(id) = view.concept_for(path, value, true) {
                edges.insert(id);
            }
        }
        Lookup::Fallback => {
            if let Some(id) = view.concept_for(path, value, true) {
                edges.insert(id);
            }
            diagnostics.push(diagnostic(
                    Level::Warning,
                    "W119",
                    format!("{name} {value:?} resolves only from the bundle root, through the v0.2 fallback; write it as /{value} (section 6.2)"),
                    Some(1),
                ));
        }
        Lookup::Missing => diagnostics.push(diagnostic(
            Level::Warning,
            "W116",
            format!("{name} {value:?} does not resolve to a file in the bundle (section 6.2)"),
            Some(1),
        )),
    };
    if let Some(resource) = &doc.meta.resource {
        field_target("resource".into(), resource, &mut diagnostics);
    }
    if let Some(target) = &doc.meta.superseded_by {
        field_target("superseded_by".into(), target, &mut diagnostics);
    }
    for (index, source) in doc.meta.sources.iter().enumerate() {
        if !source.resource.chars().any(char::is_whitespace) {
            field_target(
                format!("sources[{index}].resource"),
                &source.resource,
                &mut diagnostics,
            );
        }
    }
    if let Some(value) = text(field(&doc.yaml, "computation")) {
        field_target("computation".into(), value, &mut diagnostics);
    }
    for key in ["executor", "attester"] {
        if let Some(value) = text(field(field(&doc.yaml, key), "resource")) {
            field_target(format!("{key}.resource"), value, &mut diagnostics);
        }
    }
    for target in links {
        if target.starts_with('#') {
            continue;
        }
        match view.lookup(path, target, false) {
            Lookup::External | Lookup::Fallback => {}
            Lookup::Found => {
                if let Some(id) = view.concept_for(path, target, false) {
                    edges.insert(id);
                }
            }
            Lookup::Missing => diagnostics.push(diagnostic(
                Level::Warning,
                "W115",
                format!("link target {target:?} is not in the bundle (section 6.1)"),
                None,
            )),
        }
    }
    edges.remove(path.strip_suffix(".md").unwrap_or(path));
    let replacement = doc
        .meta
        .superseded_by
        .as_deref()
        .filter(|_| doc.meta.status == Status::Deprecated)
        .and_then(|target| view.concept_for(path, target, true));
    Relations {
        diagnostics,
        edges,
        replacement,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signals {
    pub status: String,
    pub current: bool,
    pub draft: bool,
    pub trust: Trust,
    pub stale: bool,
    pub stale_after: Option<String>,
    pub malformed_stale_after: bool,
    pub generated_at: Option<DateTime<Utc>>,
    pub superseded_by: Option<String>,
    pub replacement: Option<String>,
    pub verification_older_than_content: bool,
    pub conflicts_with: Vec<String>,
    pub attestable: bool,
}
pub fn signals(doc: &Doc, replacement: Option<String>, now: DateTime<Utc>) -> Signals {
    let meta = &doc.meta;
    Signals {
        status: meta.status.name().into(),
        current: meta.status.current(),
        draft: meta.status == Status::Draft,
        trust: meta.trust(),
        stale: meta.stale(now),
        stale_after: match &meta.stale_after {
            Deadline::Absent => None,
            Deadline::At(_) => scalar(field(&doc.yaml, "stale_after")),
            Deadline::Malformed(raw) => Some(raw.clone()),
        },
        malformed_stale_after: matches!(meta.stale_after, Deadline::Malformed(_)),
        generated_at: meta.content_time(),
        superseded_by: meta.superseded_by.clone(),
        replacement,
        verification_older_than_content: meta.verification_older_than_content(),
        conflicts_with: Vec::new(),
        attestable: meta.type_ == "Attested Computation"
            && meta.runtime.is_some()
            && meta.attester.is_some(),
    }
}

pub fn conflicts(entries: &[(String, &Meta)]) -> BTreeMap<String, Vec<String>> {
    let mut groups: BTreeMap<(String, String), Vec<&str>> = BTreeMap::new();
    for (id, meta) in entries {
        if !meta.status.current() {
            continue;
        }
        let Some(title) = meta.title.as_deref().map(normalize) else {
            continue;
        };
        groups
            .entry((meta.type_.to_lowercase(), title))
            .or_default()
            .push(id);
    }
    let mut result = BTreeMap::new();
    for ids in groups.values().filter(|ids| ids.len() > 1) {
        for id in ids {
            result.insert(
                (*id).to_owned(),
                ids.iter()
                    .filter(|other| *other != id)
                    .map(|other| (*other).to_owned())
                    .collect(),
            );
        }
    }
    result
}
pub fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn root_index(content: &str) -> (Vec<Diagnostic>, Option<String>, Option<String>) {
    let mut found = Vec::new();
    let (block, _) = match split(content) {
        Split::Block { yaml, body, .. } => (yaml, body),
        Split::Absent => {
            found.push(diagnostic(
                Level::Warning,
                "W125",
                "give the root index.md frontmatter with okf_version: \"0.3\" (section 8.1)",
                Some(1),
            ));
            return (found, None, None);
        }
        Split::Unterminated => {
            found.push(diagnostic(
                Level::Error,
                "E002",
                "frontmatter does not parse as a YAML mapping: the closing --- line is missing (section 4)",
                Some(1),
            ));
            return (found, None, None);
        }
    };
    let yaml = match mapping(block) {
        Ok(yaml) => yaml,
        Err(YamlFailure::Duplicate { key, line }) => {
            found.push(diagnostic(
                Level::Error,
                "E007",
                format!("frontmatter repeats the key {key:?}; keys must be unique (section 4)"),
                Some(line + 1),
            ));
            return (found, None, None);
        }
        Err(_) => {
            found.push(diagnostic(
                Level::Error,
                "E002",
                "frontmatter does not parse as a YAML mapping (section 4)",
                Some(1),
            ));
            return (found, None, None);
        }
    };
    let version = field(&yaml, "okf_version");
    if blank(version) {
        found.push(diagnostic(
            Level::Warning,
            "W125",
            "add okf_version: \"0.3\" to the root index.md (section 8.1)",
            Some(1),
        ));
    } else if !matches!(version, Yaml::String(_)) {
        found.push(diagnostic(
            Level::Warning,
            "W117",
            "quote okf_version as a string, for example \"0.3\" (section 8.1)",
            Some(1),
        ));
    }
    let license = scalar(field(&yaml, "license"));
    (found, scalar(version), license)
}

pub fn validate_log(content: &str) -> Vec<Diagnostic> {
    let mut found = Vec::new();
    if matches!(split(content), Split::Block { .. }) || content.starts_with("---\n") {
        found.push(diagnostic(
            Level::Error,
            "E006",
            "log.md has no frontmatter (section 9)",
            Some(1),
        ));
    }
    let mut dates: Vec<(usize, String)> = Vec::new();
    for (number, line) in content.lines().enumerate() {
        if let Some(heading) = line.strip_prefix("## ") {
            let heading = heading.trim();
            if heading.len() == 10 && parse_timestamp(heading).is_some() {
                dates.push((number + 1, heading.into()));
            } else {
                found.push(diagnostic(
                    Level::Error,
                    "E005",
                    format!(
                        "a log.md date heading must be YYYY-MM-DD (section 9); found {heading:?}"
                    ),
                    Some(number + 1),
                ));
            }
        }
    }
    for pair in dates.windows(2) {
        if pair[1].1 > pair[0].1 {
            found.push(diagnostic(
                Level::Warning,
                "W118",
                format!(
                    "log.md puts the newest date first (section 9); {} follows {}",
                    pair[1].1, pair[0].1
                ),
                Some(pair[1].0),
            ));
        }
    }
    found
}
pub fn validate_nested_index(content: &str) -> Vec<Diagnostic> {
    if content
        .strip_prefix('\u{feff}')
        .unwrap_or(content)
        .starts_with("---")
        && matches!(split(content), Split::Block { .. } | Split::Unterminated)
    {
        vec![diagnostic(
            Level::Error,
            "E004",
            "an index.md below the bundle root has no frontmatter (section 8)",
            Some(1),
        )]
    } else {
        Vec::new()
    }
}
