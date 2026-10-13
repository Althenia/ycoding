use super::Error;
use crate::{
    regexp::{Budget, RegExp},
    resources::discovery::{markdown, trim, whitespace},
};
use ring::digest;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Warning {
    pub id: String,
    pub code: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub id: String,
    pub type_: ycoding_schema::LosslessString,
    pub title: Option<ycoding_schema::LosslessString>,
    pub description: Option<ycoding_schema::LosslessString>,
    pub tags: Option<Vec<ycoding_schema::LosslessString>>,
    pub digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Concept {
    pub summary: Summary,
    pub content: String,
    pub body: String,
    pub links: Vec<String>,
}

pub fn sha256(bytes: impl AsRef<[u8]>) -> String {
    digest::digest(&digest::SHA256, bytes.as_ref())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub fn require_id(id: &str) -> Result<(), Error> {
    if id.is_empty()
        || id.split('/').any(|part| {
            matches!(part, "index" | "log" | "trash")
                || part.is_empty()
                || !part.as_bytes()[0].is_ascii_lowercase() && !part.as_bytes()[0].is_ascii_digit()
                || !part.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-')
                })
        })
    {
        return Err(Error::UnsafePath);
    }
    Ok(())
}
pub fn parse(id: &str, content: &str) -> Result<Concept, Error> {
    require_id(id)?;
    let text = content.strip_prefix('\u{feff}').unwrap_or(content);
    if !text.starts_with("---\n") && !text.starts_with("---\r\n") {
        return Err(Error::InvalidConcept);
    }
    let mut cache = markdown::Cache::default();
    let parsed = cache.parse(text).map_err(|_| Error::InvalidConcept)?;
    if cache
        .parse(text)
        .map_err(|_| Error::InvalidConcept)?
        .content
        != parsed.content
    {
        return Err(Error::InvalidConcept);
    }
    let type_ = string(parsed.data.get("type"))?.ok_or(Error::InvalidConcept)?;
    if trim(&text_value(&type_)).is_empty() {
        return Err(Error::InvalidConcept);
    }
    let tags = match parsed.data.get("tags") {
        None => None,
        Some(markdown::Value::Array(tags)) => Some(
            tags.iter()
                .map(|value| string(Some(value))?.ok_or(Error::InvalidConcept))
                .collect::<Result<_, _>>()?,
        ),
        Some(_) => return Err(Error::InvalidConcept),
    };
    let mut declared = BTreeSet::new();
    if let Some(sources) = parsed.data.get("sources") {
        let markdown::Value::Array(sources) = sources else {
            return Err(Error::InvalidConcept);
        };
        for source in sources {
            if !matches!(source, markdown::Value::Object(_))
                || string(source.get("resource"))?.is_none_or(|s| trim(&text_value(&s)).is_empty())
            {
                return Err(Error::InvalidConcept);
            }
            if let Some(id) = string(source.get("id"))? {
                let id = id.as_str().ok_or(Error::InvalidConcept)?;
                if id.is_empty()
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                    || !declared.insert(id.to_owned())
                {
                    return Err(Error::InvalidConcept);
                }
            }
        }
    }
    let (links, unresolved) = markdown_links(&parsed.content)?;
    for reference in matches(&unresolved, r"\[\^([A-Za-z0-9_-]+)\]", "g")? {
        if !declared.contains(&reference[1]) {
            return Err(Error::InvalidConcept);
        }
    }
    Ok(Concept {
        summary: Summary {
            id: id.into(),
            type_,
            title: string(parsed.data.get("title"))?,
            description: string(parsed.data.get("description"))?,
            tags,
            digest: sha256(content),
        },
        content: content.into(),
        body: parsed.content,
        links,
    })
}
fn string(
    value: Option<&markdown::Value>,
) -> Result<Option<ycoding_schema::LosslessString>, Error> {
    match value {
        None => Ok(None),
        Some(markdown::Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(Error::InvalidConcept),
    }
}
pub fn words(value: &str) -> Result<BTreeSet<String>, Error> {
    Ok(matches(&value.to_lowercase(), r"[\p{L}\p{N}_]+", "gu")?
        .into_iter()
        .map(|capture| capture[0].clone())
        .collect())
}
pub(crate) fn text_value(value: &ycoding_schema::LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}
fn matches(text: &str, pattern: &str, flags: &str) -> Result<Vec<Vec<String>>, Error> {
    let mut regex = RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), flags)
        .map_err(|_| Error::Unavailable)?;
    let input = text.encode_utf16().collect::<Vec<_>>();
    let mut result = Vec::new();
    while let Some(found) = regex
        .exec(&input, &mut Budget::unlimited())
        .map_err(|_| Error::Unavailable)?
    {
        result.push(
            found
                .captures
                .into_iter()
                .map(|capture| String::from_utf16_lossy(&capture.unwrap_or_default()))
                .collect(),
        );
    }
    Ok(result)
}
fn markdown_links(body: &str) -> Result<(Vec<String>, String), Error> {
    let mut definitions = BTreeMap::new();
    let mut text = String::new();
    let mut fence: Option<(char, usize)> = None;
    let mut html: Option<Option<String>> = None;
    for line in body.split_inclusive('\n') {
        let stripped = line.trim_start_matches(' ');
        let indent = line.len() - stripped.len();
        let lower = stripped.to_ascii_lowercase();
        if let Some(closing) = &html {
            if closing
                .as_ref()
                .is_some_and(|closing| lower.contains(closing))
                || closing.is_none() && trim(line).is_empty()
            {
                html = None;
            }
            text.push('\n');
            continue;
        }
        if indent <= 3
            && let Some(tag) = lower
                .strip_prefix('<')
                .and_then(|text| text.strip_prefix('/').or(Some(text)))
                .map(|text| {
                    text.split(|ch: char| !ch.is_ascii_alphanumeric())
                        .next()
                        .unwrap_or("")
                })
        {
            if matches!(tag, "script" | "pre" | "style" | "textarea") {
                let closing = format!("</{tag}>");
                if !lower.contains(&closing) {
                    html = Some(Some(closing));
                }
                text.push('\n');
                continue;
            }
            if [
                "address",
                "article",
                "aside",
                "base",
                "basefont",
                "blockquote",
                "body",
                "caption",
                "center",
                "col",
                "colgroup",
                "dd",
                "details",
                "dialog",
                "dir",
                "div",
                "dl",
                "dt",
                "fieldset",
                "figcaption",
                "figure",
                "footer",
                "form",
                "frame",
                "frameset",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "head",
                "header",
                "hr",
                "html",
                "iframe",
                "legend",
                "li",
                "link",
                "main",
                "menu",
                "menuitem",
                "nav",
                "noframes",
                "ol",
                "optgroup",
                "option",
                "p",
                "param",
                "search",
                "section",
                "summary",
                "table",
                "tbody",
                "td",
                "tfoot",
                "th",
                "thead",
                "title",
                "tr",
                "track",
                "ul",
            ]
            .contains(&tag)
            {
                html = Some(None);
                text.push('\n');
                continue;
            }
        }
        if indent <= 3 && (stripped.starts_with("```") || stripped.starts_with("~~~")) {
            let marker = stripped.chars().next().ok_or(Error::InvalidConcept)?;
            let count = stripped.chars().take_while(|c| *c == marker).count();
            match fence {
                None => fence = Some((marker, count)),
                Some((current, size)) if marker == current && count >= size => fence = None,
                _ => {}
            }
            text.push('\n');
            continue;
        }
        if fence.is_some() || line.starts_with("    ") || line.starts_with('\t') {
            text.push('\n');
            continue;
        }
        if indent <= 3 {
            let found = matches(stripped, r"^\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))", "g")?;
            if let Some(value) = found.first() {
                definitions.entry(label(&value[1])).or_insert_with(|| {
                    if value[2].is_empty() {
                        value[3].clone()
                    } else {
                        value[2].clone()
                    }
                });
                text.push('\n');
                continue;
            }
        }
        text.push_str(line);
    }
    let mut plain = String::new();
    let mut links = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            let size = text[i + 1..]
                .chars()
                .next()
                .ok_or(Error::InvalidConcept)?
                .len_utf8();
            plain.push('\n');
            i += 1 + size;
            continue;
        }
        if bytes[i] == b'`' {
            let count = bytes[i..].iter().take_while(|b| **b == b'`').count();
            let marker = "`".repeat(count);
            if let Some(end) = text[i + count..].find(&marker) {
                i += count + end + count;
                continue;
            }
        }
        if bytes[i] == b'['
            && let Some(end) = closing_bracket(&text, i)
        {
            let name = &text[i + 1..end];
            let next = end + 1;
            let destination = if bytes.get(next) == Some(&b'(') {
                inline_destination(&text[next + 1..]).map(|(href, len)| (href, next + 1 + len))
            } else if bytes.get(next) == Some(&b'[') {
                text[next + 1..].find(']').and_then(|close| {
                    let key = &text[next + 1..next + 1 + close];
                    definitions
                        .get(&label(if key.is_empty() { name } else { key }))
                        .cloned()
                        .map(|href| (href, next + close + 2))
                })
            } else {
                definitions
                    .get(&label(name))
                    .cloned()
                    .map(|href| (href, next))
            };
            if let Some((href, next)) = destination {
                if i == 0 || bytes[i - 1] != b'!' {
                    links.push(href);
                }
                i = next;
                continue;
            }
        }
        if bytes[i] == b'<'
            && let Some(end) = text[i + 1..].find('>')
        {
            let href = &text[i + 1..i + 1 + end];
            if href.contains(":") && !href.chars().any(whitespace) {
                links.push(href.into());
                i += end + 2;
                continue;
            }
            if href.contains('@') && !href.chars().any(whitespace) {
                links.push(format!("mailto:{href}"));
                i += end + 2;
                continue;
            }
        }
        if text[i..].starts_with("https://")
            || text[i..].starts_with("http://")
            || text[i..].starts_with("www.")
        {
            let end = text[i..]
                .find(|ch: char| whitespace(ch) || ch == '<')
                .unwrap_or(text.len() - i);
            let href = text[i..i + end].trim_end_matches(['.', ',', ':', ';', '!', '?']);
            links.push(if href.starts_with("www.") {
                format!("http://{href}")
            } else {
                href.into()
            });
            i += href.len();
            continue;
        }
        let ch = text[i..].chars().next().ok_or(Error::InvalidConcept)?;
        plain.push(ch);
        i += ch.len_utf8();
    }
    Ok((links, plain))
}
fn label(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn closing_bracket(text: &str, start: usize) -> Option<usize> {
    let mut depth = 0;
    let mut escaped = false;
    for (i, ch) in text[start + 1..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '[' {
            depth += 1;
        }
        if ch == ']' {
            if depth == 0 {
                return Some(start + 1 + i);
            }
            depth -= 1;
        }
    }
    None
}
fn inline_destination(text: &str) -> Option<(String, usize)> {
    let text = text.trim_start();
    let mut depth = 0;
    let mut escaped = false;
    for (i, ch) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '(' {
            depth += 1;
        }
        if ch == ')' {
            if depth > 0 {
                depth -= 1;
                continue;
            }
            let value = text[..i].trim();
            let href = if let Some(value) = value.strip_prefix('<') {
                value.split_once('>')?.0
            } else {
                value.split_whitespace().next().unwrap_or("")
            };
            let mut unescaped = String::new();
            let mut chars = href.chars().peekable();
            while let Some(ch) = chars.next() {
                if ch == '\\' && chars.peek().is_some_and(char::is_ascii_punctuation) {
                    unescaped.push(chars.next()?);
                    continue;
                }
                unescaped.push(ch);
            }
            return Some((unescaped, i + 1));
        }
    }
    None
}
