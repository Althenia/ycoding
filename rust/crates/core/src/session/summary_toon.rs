use super::js_pattern::Pattern;
use std::sync::LazyLock;

const ROOT: &str = "conversation_memory";
const REQUIRED_FIELDS: [&str; 18] = [
    "version",
    "through_sequence",
    "objective",
    "in_progress",
    "pending",
    "blocked",
    "decision",
    "skill",
    "requirements",
    "acceptance_criteria",
    "current_state",
    "facts",
    "preferences",
    "constraints",
    "completed",
    "unresolved",
    "important_identifiers",
    "continuation",
];

static KEY_LINE: LazyLock<Pattern> =
    LazyLock::new(|| Pattern::new(r#"^\s*(?:"(?:\\.|[^"\\])*"|[^\s":]+)\s*:"#, ""));
static TABLE_HEADER: LazyLock<Pattern> =
    LazyLock::new(|| Pattern::new(r"\[(\d+|\*)\]\s*\{[^}]*\}\s*:\s*$", ""));
static ROW_LINE: LazyLock<Pattern> = LazyLock::new(|| {
    Pattern::new(
        r#"^\s+(?:"(?:\\.|[^"\\])*"|[^",]+)(?:\s*,\s*(?:"(?:\\.|[^"\\])*"|[^",]+))*\s*$"#,
        "",
    )
});
static DASH_LINE: LazyLock<Pattern> = LazyLock::new(|| Pattern::new(r"^\s*-\s*", ""));
static FENCE_LINE: LazyLock<Pattern> = LazyLock::new(|| Pattern::new(r"^\s*```", ""));
static NUMERIC_LIKE: LazyLock<Pattern> =
    LazyLock::new(|| Pattern::new(r"^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$", "i"));
static NUMERIC_LITERAL: LazyLock<Pattern> =
    LazyLock::new(|| Pattern::new(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$", "i"));
static OBJECTIVE: LazyLock<Pattern> = LazyLock::new(|| Pattern::new(r"^objective\s*:", "i"));
static ACTIVE_SKILL: LazyLock<Pattern> = LazyLock::new(|| Pattern::new(r"\bactive skill\b", "i"));
static CRITERIA: LazyLock<Pattern> =
    LazyLock::new(|| Pattern::new(r"\baccept(?:ance)?[ _-]?criteria\b", "i"));
static REQUIREMENT: LazyLock<Pattern> = LazyLock::new(|| Pattern::new(r"\brequirement\b", "i"));
static DECISION: LazyLock<Pattern> =
    LazyLock::new(|| Pattern::new(r"\b(?:accepted|rejected|superseded) decision\b", "i"));
static REJECTED: LazyLock<Pattern> = LazyLock::new(|| Pattern::new(r"\brejected decision\b", "i"));
static SUPERSEDED: LazyLock<Pattern> =
    LazyLock::new(|| Pattern::new(r"\bsuperseded decision\b", "i"));
static BLOCKER: LazyLock<Pattern> = LazyLock::new(|| Pattern::new(r"\bblocker\b", "i"));
static PENDING: LazyLock<Pattern> =
    LazyLock::new(|| Pattern::new(r"\b(?:pending|todo|next action)\b", "i"));
static PROGRESS: LazyLock<Pattern> = LazyLock::new(|| {
    Pattern::new(
        r"\b(?:progress|in[_ -]?progress|completed|validation)\b",
        "i",
    )
});

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Confidence {
    Confirmed,
    Likely,
    Uncertain,
}

impl Confidence {
    fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Likely => "likely",
            Self::Uncertain => "uncertain",
        }
    }
    fn parse(value: &str) -> Option<Self> {
        match value {
            "confirmed" => Some(Self::Confirmed),
            "likely" => Some(Self::Likely),
            "uncertain" => Some(Self::Uncertain),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionStatus {
    Accepted,
    Rejected,
    Superseded,
}

impl DecisionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Superseded => "superseded",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "accepted" => Some(Self::Accepted),
            "rejected" => Some(Self::Rejected),
            "superseded" => Some(Self::Superseded),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fact {
    pub text: String,
    pub confidence: Confidence,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub text: String,
    pub status: DecisionStatus,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Memory {
    pub through_sequence: i64,
    pub objective: String,
    pub in_progress: Vec<String>,
    pub pending: Vec<String>,
    pub blocked: Vec<String>,
    pub decision: Vec<Decision>,
    pub skill: Vec<String>,
    pub requirements: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub current_state: String,
    pub facts: Vec<Fact>,
    pub preferences: Vec<String>,
    pub constraints: Vec<String>,
    pub completed: Vec<String>,
    pub unresolved: Vec<String>,
    pub important_identifiers: Vec<String>,
    pub continuation: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseError {
    InvalidToon(String),
    WrongRoot(String),
    MissingField(Vec<String>),
    UnsupportedVersion(String),
    SequenceMismatch { expected: String, actual: String },
    InvalidElement(String),
    EmptySummary,
    CodeFence,
    Prose(usize),
}

pub struct ParseOptions {
    pub through_sequence: i64,
}

pub fn encode(memory: &Memory) -> String {
    let mut lines = vec![format!("{ROOT}:"), "  version: 2".to_string()];
    lines.push(format!("  through_sequence: {}", memory.through_sequence));
    lines.push(format!("  objective: {}", string(&memory.objective)));
    lines.extend(list("in_progress", &memory.in_progress));
    lines.extend(list("pending", &memory.pending));
    lines.extend(list("blocked", &memory.blocked));
    lines.extend(table(
        "decision",
        "text,status",
        memory
            .decision
            .iter()
            .map(|decision| format!("{},{}", string(&decision.text), decision.status.as_str()))
            .collect(),
    ));
    lines.extend(list("skill", &memory.skill));
    lines.extend(list("requirements", &memory.requirements));
    lines.extend(list("acceptance_criteria", &memory.acceptance_criteria));
    lines.push(format!(
        "  current_state: {}",
        string(&memory.current_state)
    ));
    lines.extend(table(
        "facts",
        "text,confidence",
        memory
            .facts
            .iter()
            .map(|fact| format!("{},{}", string(&fact.text), fact.confidence.as_str()))
            .collect(),
    ));
    lines.extend(list("preferences", &memory.preferences));
    lines.extend(list("constraints", &memory.constraints));
    lines.extend(list("completed", &memory.completed));
    lines.extend(list("unresolved", &memory.unresolved));
    lines.extend(list("important_identifiers", &memory.important_identifiers));
    lines.push(format!("  continuation: {}", string(&memory.continuation)));
    lines.join("\n")
}

pub fn parse(input: &str, options: &ParseOptions) -> Result<Memory, ParseError> {
    if fenced(input) {
        return Err(ParseError::CodeFence);
    }
    if let Some(line) = prose_line(input) {
        return Err(ParseError::Prose(line));
    }
    let body = root_body(decode(input).map_err(ParseError::InvalidToon)?)?;
    let field = |name: &str| body.iter().find(|(key, _)| key == name).map(|(_, v)| v);
    let Some(version) = field("version") else {
        return Err(ParseError::MissingField(vec!["version".into()]));
    };
    if !matches!(version, Value::Number(number) if *number == 2.0) {
        return Err(ParseError::UnsupportedVersion(version.display()));
    }
    let Some(through) = field("through_sequence") else {
        return Err(ParseError::MissingField(vec!["through_sequence".into()]));
    };
    if !matches!(through, Value::Number(number) if *number == options.through_sequence as f64) {
        return Err(ParseError::SequenceMismatch {
            expected: options.through_sequence.to_string(),
            actual: through.display(),
        });
    }
    let missing = REQUIRED_FIELDS
        .iter()
        .filter(|name| field(name).is_none())
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(ParseError::MissingField(missing));
    }
    let required = |name: &str| field(name).expect("required field was checked");
    let memory = Memory {
        through_sequence: options.through_sequence,
        objective: text_field(required("objective"), "objective")?,
        in_progress: text_list(required("in_progress"), "in_progress")?,
        pending: text_list(required("pending"), "pending")?,
        blocked: text_list(required("blocked"), "blocked")?,
        decision: decisions(required("decision"))?,
        skill: text_list(required("skill"), "skill")?,
        requirements: text_list(required("requirements"), "requirements")?,
        acceptance_criteria: text_list(required("acceptance_criteria"), "acceptance_criteria")?,
        current_state: text_field(required("current_state"), "current_state")?,
        facts: facts(required("facts"))?,
        preferences: text_list(required("preferences"), "preferences")?,
        constraints: text_list(required("constraints"), "constraints")?,
        completed: text_list(required("completed"), "completed")?,
        unresolved: text_list(required("unresolved"), "unresolved")?,
        important_identifiers: text_list(
            required("important_identifiers"),
            "important_identifiers",
        )?,
        continuation: text_field(required("continuation"), "continuation")?,
    };
    if is_empty(&memory) {
        return Err(ParseError::EmptySummary);
    }
    Ok(memory)
}

pub type Supersedes<'a> = &'a dyn Fn(&str, &str) -> bool;

pub fn retain_required_texts(
    memory: Memory,
    texts: &[String],
    supersedes: Option<Supersedes<'_>>,
) -> Memory {
    let mut seen = Vec::<&String>::new();
    texts
        .iter()
        .filter(|text| {
            let fresh = !text.trim().is_empty() && !seen.contains(text);
            seen.push(text);
            fresh
        })
        .fold(memory, |result, text| {
            let mut current = match supersedes {
                Some(supersedes) => without_superseded(result, text, supersedes),
                None => result,
            };
            if memory_texts(&current)
                .iter()
                .any(|value| value.contains(text.as_str()))
            {
                return current;
            }
            if OBJECTIVE.is_match(text) {
                current.objective = text.clone();
            } else if ACTIVE_SKILL.is_match(text) {
                current.skill.push(text.clone());
            } else if CRITERIA.is_match(text) {
                current.acceptance_criteria.push(text.clone());
            } else if REQUIREMENT.is_match(text) {
                current.requirements.push(text.clone());
            } else if DECISION.is_match(text) {
                let status = if REJECTED.is_match(text) {
                    DecisionStatus::Rejected
                } else if SUPERSEDED.is_match(text) {
                    DecisionStatus::Superseded
                } else {
                    DecisionStatus::Accepted
                };
                current.decision.push(Decision {
                    text: text.clone(),
                    status,
                });
            } else if BLOCKER.is_match(text) {
                current.blocked.push(text.clone());
            } else if PENDING.is_match(text) {
                current.pending.push(text.clone());
            } else if PROGRESS.is_match(text) {
                current.in_progress.push(text.clone());
            } else {
                current.facts.push(Fact {
                    text: text.clone(),
                    confidence: Confidence::Confirmed,
                });
            }
            current
        })
}

fn without_superseded(
    mut memory: Memory,
    incoming: &str,
    supersedes: &dyn Fn(&str, &str) -> bool,
) -> Memory {
    let kept = |values: &mut Vec<String>| values.retain(|value| !supersedes(value, incoming));
    let scalar = |value: &mut String| {
        if supersedes(value, incoming) {
            value.clear();
        }
    };
    scalar(&mut memory.objective);
    kept(&mut memory.requirements);
    kept(&mut memory.acceptance_criteria);
    kept(&mut memory.in_progress);
    scalar(&mut memory.current_state);
    kept(&mut memory.preferences);
    kept(&mut memory.constraints);
    kept(&mut memory.completed);
    kept(&mut memory.pending);
    kept(&mut memory.blocked);
    kept(&mut memory.skill);
    kept(&mut memory.unresolved);
    kept(&mut memory.important_identifiers);
    memory
        .decision
        .retain(|decision| !supersedes(&decision.text, incoming));
    memory
        .facts
        .retain(|fact| !supersedes(&fact.text, incoming));
    scalar(&mut memory.continuation);
    memory
}

fn memory_texts(memory: &Memory) -> Vec<&str> {
    let mut texts = vec![memory.objective.as_str()];
    texts.extend(memory.requirements.iter().map(String::as_str));
    texts.extend(memory.acceptance_criteria.iter().map(String::as_str));
    texts.extend(memory.in_progress.iter().map(String::as_str));
    texts.push(&memory.current_state);
    texts.push(&memory.continuation);
    texts.extend(memory.facts.iter().map(|fact| fact.text.as_str()));
    texts.extend(
        memory
            .decision
            .iter()
            .map(|decision| decision.text.as_str()),
    );
    texts.extend(memory.preferences.iter().map(String::as_str));
    texts.extend(memory.constraints.iter().map(String::as_str));
    texts.extend(memory.completed.iter().map(String::as_str));
    texts.extend(memory.pending.iter().map(String::as_str));
    texts.extend(memory.blocked.iter().map(String::as_str));
    texts.extend(memory.skill.iter().map(String::as_str));
    texts.extend(memory.unresolved.iter().map(String::as_str));
    texts.extend(memory.important_identifiers.iter().map(String::as_str));
    texts
}

fn is_empty(memory: &Memory) -> bool {
    [
        &memory.objective,
        &memory.current_state,
        &memory.continuation,
    ]
    .iter()
    .all(|value| value.trim().is_empty())
        && memory.requirements.is_empty()
        && memory.acceptance_criteria.is_empty()
        && memory.in_progress.is_empty()
        && memory.facts.is_empty()
        && memory.decision.is_empty()
        && memory.preferences.is_empty()
        && memory.constraints.is_empty()
        && memory.completed.is_empty()
        && memory.pending.is_empty()
        && memory.blocked.is_empty()
        && memory.skill.is_empty()
        && memory.unresolved.is_empty()
        && memory.important_identifiers.is_empty()
}

fn list(name: &str, values: &[String]) -> Vec<String> {
    if values.is_empty() {
        return vec![format!("  {name}: []")];
    }
    vec![format!(
        "  {name}[{}]: {}",
        values.len(),
        values
            .iter()
            .map(|value| string(value))
            .collect::<Vec<_>>()
            .join(",")
    )]
}

fn table(name: &str, fields: &str, rows: Vec<String>) -> Vec<String> {
    if rows.is_empty() {
        return vec![format!("  {name}: []")];
    }
    std::iter::once(format!("  {name}[{}]{{{fields}}}:", rows.len()))
        .chain(rows.into_iter().map(|row| format!("    {row}")))
        .collect()
}

fn string(value: &str) -> String {
    if safe_unquoted(value) {
        return value.to_string();
    }
    format!("\"{}\"", escape(value))
}

fn safe_unquoted(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with([' ', '\t'])
        && !value.ends_with([' ', '\t'])
        && !matches!(value, "true" | "false" | "null")
        && !NUMERIC_LIKE.is_match(value)
        && !value.contains([':', '"', '\\', '[', ']', '{', '}', ','])
        && !value.chars().any(|ch| ch <= '\u{1f}')
        && !value.starts_with(['-', '#'])
}

fn escape(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            '\\' => "\\\\".to_string(),
            '"' => "\\\"".to_string(),
            '\n' => "\\n".to_string(),
            '\r' => "\\r".to_string(),
            '\t' => "\\t".to_string(),
            ch if ch <= '\u{1f}' => format!("\\u{:04x}", ch as u32),
            ch => ch.to_string(),
        })
        .collect()
}

fn unescape(value: &str) -> Result<String, String> {
    let mut output = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            output.push(ch);
            continue;
        }
        match chars.next() {
            None => return Err("Invalid escape sequence: backslash at end of string".into()),
            Some('n') => output.push('\n'),
            Some('t') => output.push('\t'),
            Some('r') => output.push('\r'),
            Some('\\') => output.push('\\'),
            Some('"') => output.push('"'),
            Some('u') => {
                let hex = chars.by_ref().take(4).collect::<String>();
                let code = u32::from_str_radix(&hex, 16)
                    .ok()
                    .filter(|_| hex.len() == 4)
                    .ok_or_else(|| {
                        format!("Invalid escape sequence: \\u must be followed by 4 hex digits, got \"{hex}\"")
                    })?;
                output.push(char::from_u32(code).ok_or_else(|| {
                    format!("Invalid escape sequence: \\u{hex} is a lone surrogate")
                })?);
            }
            Some(other) => return Err(format!("Invalid escape sequence: \\{other}")),
        }
    }
    Ok(output)
}

#[derive(Clone, Debug)]
enum Value {
    Text(String),
    Number(f64),
    Bool(bool),
    Null,
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

impl Value {
    fn display(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Number(number) if number.fract() == 0.0 && number.abs() < 1e15 => {
                (*number as i64).to_string()
            }
            Self::Number(number) => number.to_string(),
            Self::Bool(value) => value.to_string(),
            Self::Null => "null".into(),
            Self::Array(_) => "[object Array]".into(),
            Self::Object(_) => "[object Object]".into(),
        }
    }
}

struct Line {
    depth: usize,
    content: String,
    number: usize,
}

fn lines(input: &str) -> Result<Vec<Line>, String> {
    let mut parsed = Vec::new();
    for (index, raw) in input.trim_start_matches('\u{feff}').split('\n').enumerate() {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let leading = raw.len() - raw.trim_start_matches([' ', '\t']).len();
        let indent = &raw[..leading];
        let content = raw[leading..].trim_end_matches(' ');
        if !indent.contains('\t') && content.starts_with('#') {
            continue;
        }
        if content.is_empty() {
            continue;
        }
        if indent.contains('\t') {
            return Err(format!(
                "Tabs are not allowed in indentation in strict mode (line {})",
                index + 1
            ));
        }
        if leading % 2 != 0 {
            return Err(format!(
                "Indentation must be exact multiple of 2, but found {leading} spaces (line {})",
                index + 1
            ));
        }
        parsed.push(Line {
            depth: leading / 2,
            content: content.to_string(),
            number: index + 1,
        });
    }
    Ok(parsed)
}

fn decode(input: &str) -> Result<Value, String> {
    let lines = lines(input)?;
    let Some(first) = lines.first() else {
        return Ok(Value::Object(Vec::new()));
    };
    if first.depth != 0 || find_unquoted(&first.content, ':', 0).is_none() {
        return Ok(Value::Text(first.content.clone()));
    }
    if first.content.starts_with('[') {
        return Ok(Value::Array(Vec::new()));
    }
    let mut position = 0;
    let entries = object(&lines, &mut position, 0, None)?;
    if let Some(extra) = lines.get(position) {
        return Err(format!(
            "Unexpected content at line {}: {}",
            extra.number, extra.content
        ));
    }
    Ok(Value::Object(entries))
}

fn object(
    lines: &[Line],
    position: &mut usize,
    depth: usize,
    first: Option<&str>,
) -> Result<Vec<(String, Value)>, String> {
    let mut entries = Vec::<(String, Value)>::new();
    let mut inline = first.map(str::to_string);
    loop {
        let (content, number) = match inline.take() {
            Some(content) => (content, lines[*position - 1].number),
            None => {
                let Some(line) = lines.get(*position) else {
                    return Ok(entries);
                };
                if line.depth < depth {
                    return Ok(entries);
                }
                if line.depth > depth {
                    return Err(format!(
                        "Unexpected indentation at line {} (expected depth {depth})",
                        line.number
                    ));
                }
                if line.content.starts_with("- ") || line.content == "-" {
                    return Ok(entries);
                }
                *position += 1;
                (line.content.clone(), line.number)
            }
        };
        let (key, value) = entry(lines, position, depth, &content, number)?;
        if entries.iter().any(|(existing, _)| *existing == key) {
            return Err(format!("Duplicate key \"{key}\" at line {number}"));
        }
        entries.push((key, value));
    }
}

fn entry(
    lines: &[Line],
    position: &mut usize,
    depth: usize,
    content: &str,
    number: usize,
) -> Result<(String, Value), String> {
    let (key, rest) = key_token(content)?;
    if let Some(header) = rest.strip_prefix('[') {
        let value = array(lines, position, depth, header, number)?;
        return Ok((key, value));
    }
    let Some(after) = rest.strip_prefix(':') else {
        return Err(format!("Missing colon after key at line {number}"));
    };
    let after = after.trim_matches(' ');
    if after.is_empty() {
        let body = object(lines, position, depth + 1, None)?;
        return Ok((key, Value::Object(body)));
    }
    if after == "[]" {
        return Ok((key, Value::Array(Vec::new())));
    }
    Ok((key, primitive(after)?))
}

fn key_token(content: &str) -> Result<(String, &str), String> {
    if let Some(quoted) = content.strip_prefix('"') {
        let close = closing_quote(quoted).ok_or("Unterminated quoted key")?;
        let key = unescape(&quoted[..close])?;
        return Ok((key, &quoted[close + 1..]));
    }
    let end = content
        .find([':', '['])
        .ok_or_else(|| "Missing colon after key".to_string())?;
    Ok((
        content[..end].trim_matches(' ').to_string(),
        &content[end..],
    ))
}

fn array(
    lines: &[Line],
    position: &mut usize,
    depth: usize,
    header: &str,
    number: usize,
) -> Result<Value, String> {
    let close = header
        .find(']')
        .ok_or_else(|| format!("Missing closing bracket at line {number}"))?;
    let length = header[..close].parse::<usize>().map_err(|_| {
        format!(
            "Invalid array length \"{}\" at line {number}",
            &header[..close]
        )
    })?;
    let after = &header[close + 1..];
    if let Some(fields_and_rest) = after.strip_prefix('{') {
        let end = fields_and_rest
            .find('}')
            .ok_or_else(|| format!("Unterminated field list at line {number}"))?;
        let fields = delimited(&fields_and_rest[..end])
            .into_iter()
            .map(|field| match primitive(&field)? {
                Value::Text(name) => Ok(name),
                _ => Err(format!("Invalid field name at line {number}")),
            })
            .collect::<Result<Vec<_>, String>>()?;
        if fields_and_rest[end + 1..] != *":" {
            return Err(format!(
                "Unexpected content after field list at line {number}"
            ));
        }
        let mut rows = Vec::new();
        while let Some(line) = lines.get(*position)
            && line.depth == depth + 1
            && !line.content.starts_with("- ")
        {
            *position += 1;
            let cells = delimited(&line.content)
                .iter()
                .map(|cell| primitive(cell))
                .collect::<Result<Vec<_>, _>>()?;
            if cells.len() != fields.len() {
                return Err(format!(
                    "Expected {} tabular row values, but got {} at line {}",
                    fields.len(),
                    cells.len(),
                    line.number
                ));
            }
            rows.push(Value::Object(fields.iter().cloned().zip(cells).collect()));
        }
        if rows.len() != length {
            return Err(format!(
                "Expected {length} tabular rows, but got {}",
                rows.len()
            ));
        }
        return Ok(Value::Array(rows));
    }
    let Some(inline) = after.strip_prefix(':') else {
        return Err(format!("Missing colon after array header at line {number}"));
    };
    let inline = inline.trim_matches(' ');
    if !inline.is_empty() {
        let values = delimited(inline)
            .iter()
            .map(|cell| primitive(cell))
            .collect::<Result<Vec<_>, _>>()?;
        if values.len() != length {
            return Err(format!(
                "Expected {length} inline array items, but got {}",
                values.len()
            ));
        }
        return Ok(Value::Array(values));
    }
    let mut items = Vec::new();
    while let Some(line) = lines.get(*position)
        && line.depth == depth + 1
        && (line.content.starts_with("- ") || line.content == "-")
    {
        *position += 1;
        let item = line
            .content
            .strip_prefix('-')
            .unwrap_or_default()
            .trim_start_matches(' ');
        if item.is_empty() {
            items.push(Value::Object(Vec::new()));
        } else if find_unquoted(item, ':', 0).is_some() {
            let body = object(lines, position, depth + 2, Some(item))?;
            items.push(Value::Object(body));
        } else {
            items.push(primitive(item)?);
        }
    }
    if items.len() != length {
        return Err(format!(
            "Expected {length} list-form items, but got {}",
            items.len()
        ));
    }
    Ok(Value::Array(items))
}

fn delimited(input: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                quoted = !quoted;
                current.push(ch);
            }
            '\\' if quoted => {
                current.push(ch);
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            ',' if !quoted => values.push(std::mem::take(&mut current)),
            ch => current.push(ch),
        }
    }
    values.push(current);
    values
}

fn primitive(token: &str) -> Result<Value, String> {
    let token = token.trim_matches(' ');
    if token.is_empty() {
        return Ok(Value::Text(String::new()));
    }
    if let Some(quoted) = token.strip_prefix('"') {
        let close = closing_quote(quoted).ok_or("Unterminated string: missing closing quote")?;
        if close != quoted.len() - 1 {
            return Err("Unexpected characters after closing quote".into());
        }
        return Ok(Value::Text(unescape(&quoted[..close])?));
    }
    match token {
        "true" => return Ok(Value::Bool(true)),
        "false" => return Ok(Value::Bool(false)),
        "null" => return Ok(Value::Null),
        _ => {}
    }
    if NUMERIC_LITERAL.is_match(token)
        && let Ok(number) = token.parse::<f64>()
        && number.is_finite()
    {
        return Ok(Value::Number(if number == 0.0 { 0.0 } else { number }));
    }
    Ok(Value::Text(token.to_string()))
}

fn closing_quote(content: &str) -> Option<usize> {
    let mut escaped = false;
    for (index, ch) in content.char_indices() {
        match ch {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => return Some(index),
            _ => {}
        }
    }
    None
}

fn find_unquoted(content: &str, target: char, start: usize) -> Option<usize> {
    let mut quoted = false;
    let mut escaped = false;
    for (index, ch) in content.char_indices().filter(|(index, _)| *index >= start) {
        match ch {
            _ if escaped => escaped = false,
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            ch if ch == target && !quoted => return Some(index),
            _ => {}
        }
    }
    None
}

fn root_body(value: Value) -> Result<Vec<(String, Value)>, ParseError> {
    let Value::Object(entries) = value else {
        return Err(ParseError::WrongRoot("not an object document".into()));
    };
    let [(name, body)] = entries.as_slice() else {
        return Err(ParseError::WrongRoot(if entries.is_empty() {
            "an empty document".into()
        } else {
            format!("a document with {} root keys", entries.len())
        }));
    };
    if name != ROOT {
        return Err(ParseError::WrongRoot(format!(
            "a document rooted at \"{name}\""
        )));
    }
    match body {
        Value::Object(body) => Ok(body.clone()),
        _ => Ok(Vec::new()),
    }
}

fn text_field(value: &Value, name: &str) -> Result<String, ParseError> {
    match value {
        Value::Text(text) => Ok(text.clone()),
        _ => Err(ParseError::InvalidElement(format!(
            "{name} must be a string"
        ))),
    }
}

fn text_list(value: &Value, name: &str) -> Result<Vec<String>, ParseError> {
    let Value::Array(items) = value else {
        return Err(ParseError::InvalidElement(format!(
            "{name} must be an array of strings"
        )));
    };
    items.iter().map(|item| text_field(item, name)).collect()
}

fn rows<'a>(value: &'a Value, name: &str) -> Result<Vec<&'a [(String, Value)]>, ParseError> {
    let Value::Array(items) = value else {
        return Err(ParseError::InvalidElement(format!(
            "{name} must be an array of objects"
        )));
    };
    items
        .iter()
        .map(|item| match item {
            Value::Object(fields) => Ok(fields.as_slice()),
            _ => Err(ParseError::InvalidElement(format!(
                "{name} must be an array of objects"
            ))),
        })
        .collect()
}

fn row_text(row: &[(String, Value)], key: &str, name: &str) -> Result<String, ParseError> {
    let value = row
        .iter()
        .find(|(field, _)| field == key)
        .map(|(_, value)| value)
        .ok_or_else(|| ParseError::InvalidElement(format!("{name}.{key} is required")))?;
    text_field(value, &format!("{name}.{key}"))
}

fn decisions(value: &Value) -> Result<Vec<Decision>, ParseError> {
    rows(value, "decision")?
        .into_iter()
        .map(|row| {
            let status = row_text(row, "status", "decision")?;
            Ok(Decision {
                text: row_text(row, "text", "decision")?,
                status: DecisionStatus::parse(&status).ok_or_else(|| {
                    ParseError::InvalidElement(format!("decision.status {status} is not allowed"))
                })?,
            })
        })
        .collect()
}

fn facts(value: &Value) -> Result<Vec<Fact>, ParseError> {
    rows(value, "facts")?
        .into_iter()
        .map(|row| {
            let confidence = row_text(row, "confidence", "facts")?;
            Ok(Fact {
                text: row_text(row, "text", "facts")?,
                confidence: Confidence::parse(&confidence).ok_or_else(|| {
                    ParseError::InvalidElement(format!(
                        "facts.confidence {confidence} is not allowed"
                    ))
                })?,
            })
        })
        .collect()
}

fn fenced(input: &str) -> bool {
    let lines = input
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    lines.len() >= 2 && FENCE_LINE.is_match(lines[0]) && FENCE_LINE.is_match(lines[lines.len() - 1])
}

fn prose_line(input: &str) -> Option<usize> {
    let mut first = true;
    let mut in_table = false;
    for (index, line) in input.split('\n').enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if first {
            first = false;
            if !KEY_LINE.is_match(line) {
                return Some(index + 1);
            }
            in_table = TABLE_HEADER.is_match(line);
            continue;
        }
        if !line.starts_with(char::is_whitespace) {
            return Some(index + 1);
        }
        if in_table && ROW_LINE.is_match(line) {
            continue;
        }
        in_table = TABLE_HEADER.is_match(line);
        if KEY_LINE.is_match(line) || DASH_LINE.is_match(line) {
            continue;
        }
        return Some(index + 1);
    }
    None
}
