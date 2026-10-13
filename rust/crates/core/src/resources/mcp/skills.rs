use std::{cmp::Ordering, collections::BTreeSet};
use url::Url;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString,
    mcp_skill::{
        Capability, EXTENSION_ID, Entry, File, MAX_RESOURCES_PER_SKILL, MAX_TOTAL_BYTES_PER_SKILL,
        Reason, Resources,
    },
    parse_json, stringify_json,
};

pub fn digest(bytes: &[u8]) -> String {
    format!(
        "sha256:{}",
        ring::digest::digest(&ring::digest::SHA256, bytes)
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

pub fn capability(raw: &JsonValue) -> Option<Capability> {
    let JsonValue::Object(raw) = raw else {
        return None;
    };
    raw.get(&"resources".into())?;
    let JsonValue::Object(extensions) = raw.get(&"extensions".into())? else {
        return None;
    };
    Capability::decode(extensions.get(&EXTENSION_ID.into())?).ok()
}

pub fn entry(server: &LosslessString, raw: &JsonValue) -> Result<Entry, Reason> {
    let JsonValue::Object(raw) = raw else {
        return Err(Reason::DecodeError);
    };
    let mut stamped = raw.clone();
    stamped.insert("server".into(), server.encode());
    let entry = Entry::decode(&JsonValue::Object(stamped)).map_err(|_| Reason::DecodeError)?;
    let (root, name) = location(&entry.uri).ok_or(Reason::MalformedUri)?;
    if entry.frontmatter.name != name.into() {
        return Err(Reason::NameMismatch);
    }
    let Resources::Entries(resources) = &entry.resources else {
        return Ok(entry);
    };
    if resources.len() > MAX_RESOURCES_PER_SKILL {
        return Err(Reason::LimitResources);
    }
    if resources
        .iter()
        .map(|resource| resource.size.get() as f64)
        .sum::<f64>()
        > MAX_TOTAL_BYTES_PER_SKILL as f64
    {
        return Err(Reason::LimitBytes);
    }
    let mut seen = BTreeSet::new();
    for resource in resources {
        if !resource
            .uri
            .as_str()
            .is_some_and(|uri| contained(&root, uri))
        {
            return Err(Reason::ResourceOutsideSkill);
        }
        if !seen.insert(&resource.uri) {
            return Err(Reason::DuplicateResource);
        }
    }
    if !seen.contains(&entry.uri) {
        return Err(Reason::MissingSkillMd);
    }
    Ok(entry)
}

pub fn authorize_read(
    server: &LosslessString,
    held: &Entry,
    uri: &LosslessString,
) -> Result<(), Reason> {
    let verified = entry(&held.server, &held.encode())?;
    if &verified.server != server {
        return Err(Reason::OriginMismatch);
    }
    let Resources::Entries(resources) = &verified.resources else {
        return Err(Reason::Dynamic);
    };
    if !resources.iter().any(|resource| &resource.uri == uri) {
        return Err(Reason::UnlistedResource);
    }
    Ok(())
}

pub struct FileInput<'a> {
    pub entry: &'a Entry,
    pub uri: &'a LosslessString,
    pub size: usize,
    pub digest: String,
    pub mime_type: Option<&'a LosslessString>,
    pub text: Option<&'a LosslessString>,
    pub blob: Option<&'a LosslessString>,
}

pub fn file(input: &FileInput<'_>) -> Result<File, Reason> {
    let Resources::Entries(resources) = &input.entry.resources else {
        return Err(Reason::Dynamic);
    };
    let listed = resources
        .iter()
        .find(|resource| &resource.uri == input.uri)
        .ok_or(Reason::UnlistedResource)?;
    if input.size as f64 != listed.size.get() as f64 {
        return Err(Reason::SizeMismatch);
    }
    if listed.digest.encode() != JsonValue::String(input.digest.clone().into()) {
        return Err(Reason::DigestMismatch);
    }
    match (input.text, input.blob) {
        (Some(text), None) => Ok(File::Text {
            server: input.entry.server.clone(),
            uri: input.uri.clone(),
            size: listed.size,
            mime_type: input.mime_type.cloned(),
            text: text.clone(),
        }),
        (None, Some(blob)) => Ok(File::Blob {
            server: input.entry.server.clone(),
            uri: input.uri.clone(),
            size: listed.size,
            mime_type: input.mime_type.cloned(),
            blob: blob.clone(),
        }),
        _ => Err(Reason::DecodeError),
    }
}

pub fn frontmatter(entry: &Entry, actual: &JsonValue) -> Result<(), Reason> {
    if !matches!(actual, JsonValue::Object(_)) {
        return Err(Reason::FrontmatterMissing);
    }
    if canonical(actual) != canonical(&entry.frontmatter.encode()) {
        return Err(Reason::FrontmatterMismatch);
    }
    Ok(())
}

fn canonical(value: &JsonValue) -> String {
    match value {
        JsonValue::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        JsonValue::Object(object) => {
            let mut fields = object.iter().collect::<Vec<_>>();
            fields.sort_by(|a, b| a.0.cmp(&b.0));
            format!(
                "{{{}}}",
                fields
                    .iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        stringify_json(&key.encode()),
                        canonical(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        value => stringify_json(value),
    }
}

pub fn identity_by(
    entry: &Entry,
    mut compare: impl FnMut(&LosslessString, &LosslessString) -> Ordering,
) -> String {
    let mut resources = match &entry.resources {
        Resources::Dynamic => Vec::new(),
        Resources::Entries(resources) => resources.iter().collect::<Vec<_>>(),
    };
    resources.sort_by(|a, b| {
        compare(&a.uri, &b.uri)
            .then_with(|| {
                compare(
                    &LosslessString::decode(&a.digest.encode()).expect("digest string"),
                    &LosslessString::decode(&b.digest.encode()).expect("digest string"),
                )
            })
            .then_with(|| a.size.get().cmp(&b.size.get()))
    });
    let resources = resources
        .into_iter()
        .map(|resource| {
            let mut value = JsonObject::new();
            value.insert("uri".into(), resource.uri.encode());
            value.insert("digest".into(), resource.digest.encode());
            value.insert("size".into(), resource.size.encode());
            JsonValue::Object(value)
        })
        .collect();
    let mut value = JsonObject::new();
    value.insert("server".into(), entry.server.encode());
    value.insert("uri".into(), entry.uri.encode());
    value.insert("resources".into(), JsonValue::Array(resources));
    format!(
        "mcp-skill:{}",
        digest(stringify_json(&JsonValue::Object(value)).as_bytes())
    )
}

pub fn id(server: &LosslessString, uri: &LosslessString) -> String {
    format!(
        "mcp:{}",
        encode_base64(
            stringify_json(&JsonValue::Array(vec![server.encode(), uri.encode()])).as_bytes(),
            true
        )
    )
}

pub fn origin(value: &str) -> Option<(LosslessString, LosslessString)> {
    let raw = decode_base64(value.strip_prefix("mcp:")?);
    let JsonValue::Array(parts) = parse_json(&String::from_utf8_lossy(&raw)).ok()? else {
        return None;
    };
    let [JsonValue::String(server), JsonValue::String(uri)] = parts.as_slice() else {
        return None;
    };
    if id(server, uri) != value {
        return None;
    }
    Some((server.clone(), uri.clone()))
}

pub fn resolve(entry: &Entry, reference: &str) -> Option<String> {
    let (root, _) = location(&entry.uri)?;
    if reference.is_empty()
        || reference.contains(['\\', '\0', '?', '#'])
        || Url::parse(reference).is_ok()
    {
        return None;
    }
    let uri = Url::parse(&format!("{root}/"))
        .ok()?
        .join(reference)
        .ok()?
        .to_string();
    contained(&root, &uri).then_some(uri)
}

fn location(uri: &LosslessString) -> Option<(String, String)> {
    let uri = uri.as_str()?;
    let parsed = Url::parse(uri).ok()?;
    if parsed.query().is_some_and(|query| !query.is_empty())
        || parsed
            .fragment()
            .is_some_and(|fragment| !fragment.is_empty())
        || uri.contains(['\\', '\0'])
    {
        return None;
    }
    let root = uri.strip_suffix("/SKILL.md")?;
    if root.is_empty() {
        return None;
    }
    let mut path = parsed
        .path()
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if path.pop() != Some("SKILL.md") {
        return None;
    }
    let name = path.pop().or_else(|| parsed.host_str())?;
    if name.is_empty() || invalid_segment(name) {
        return None;
    }
    Some((root.into(), name.into()))
}

fn contained(root: &str, uri: &str) -> bool {
    let Ok(parsed) = Url::parse(uri) else {
        return false;
    };
    if parsed.query().is_some_and(|query| !query.is_empty())
        || parsed
            .fragment()
            .is_some_and(|fragment| !fragment.is_empty())
    {
        return false;
    }
    let Some(rest) = uri.strip_prefix(&format!("{root}/")) else {
        return false;
    };
    !rest.is_empty() && rest.split('/').all(|segment| !invalid_segment(segment))
}

fn invalid_segment(segment: &str) -> bool {
    if segment.is_empty() || segment.contains(['\\', '\0']) {
        return true;
    }
    let mut bytes = Vec::new();
    let mut input = segment.bytes();
    while let Some(byte) = input.next() {
        if byte != b'%' {
            bytes.push(byte);
            continue;
        }
        let Some(high) = input.next().and_then(|byte| (byte as char).to_digit(16)) else {
            return true;
        };
        let Some(low) = input.next().and_then(|byte| (byte as char).to_digit(16)) else {
            return true;
        };
        bytes.push((high * 16 + low) as u8);
    }
    String::from_utf8(bytes).map_or(true, |decoded| {
        decoded == "." || decoded == ".." || decoded.contains(['/', '\\', '\0'])
    })
}

pub(crate) fn encode_base64(bytes: &[u8], url: bool) -> String {
    let alphabet = if url {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    } else {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    };
    let mut output = String::new();
    for part in bytes.chunks(3) {
        let bits = ((part[0] as u32) << 16)
            | ((part.get(1).copied().unwrap_or(0) as u32) << 8)
            | (part.get(2).copied().unwrap_or(0) as u32);
        for shift in [18, 12, 6, 0].into_iter().take(part.len() + 1) {
            output.push(alphabet[((bits >> shift) & 63) as usize] as char);
        }
        if !url {
            for _ in part.len()..3 {
                output.push('=');
            }
        }
    }
    output
}

pub(crate) fn decode_base64(text: &str) -> Vec<u8> {
    let mut output = Vec::new();
    let mut bits = 0u32;
    let mut count = 0;
    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        };
        bits = (bits << 6) | (value as u32);
        count += 6;
        if count >= 8 {
            count -= 8;
            output.push((bits >> count) as u8);
        }
    }
    output
}
