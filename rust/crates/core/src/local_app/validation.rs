use super::failure;
use ycoding_schema::{
    DomainDecode, DomainEncode, LosslessString,
    local_app::{Category, Failure, Method, Register, Route, RouteMatch, Scope},
};

pub(super) fn scope(scope: &Scope) -> Result<(), Failure> {
    Scope::decode(&scope.encode())
        .map(|_| ())
        .map_err(|_| failure(Category::Forbidden))
}

pub(super) fn registration(input: &Register, owner: &Scope) -> Result<(), Failure> {
    scope(owner).map_err(|_| failure(Category::InvalidRegistration))?;
    Register::decode(&input.encode()).map_err(|_| failure(Category::InvalidRegistration))?;
    if input.session_id != owner.session_id {
        return Err(failure(Category::InvalidRegistration));
    }
    for route in &input.routes {
        let raw = text(&route.path, Category::InvalidRegistration)?;
        if raw.contains(['?', '*']) {
            return Err(failure(Category::InvalidRegistration));
        }
        path(raw, Category::InvalidRegistration)?;
    }
    let entry = path(
        text(&input.entry_path, Category::InvalidRegistration)?,
        Category::InvalidRegistration,
    )?;
    if !allows(&input.routes, &entry, Method::Get)? {
        return Err(failure(Category::InvalidRegistration));
    }
    Ok(())
}

pub(super) fn text(value: &LosslessString, category: Category) -> Result<&str, Failure> {
    value.as_str().ok_or_else(|| failure(category))
}

pub(super) fn path(value: &str, category: Category) -> Result<String, Failure> {
    if value.len() > 4096
        || !value.starts_with('/')
        || value.starts_with("//")
        || value
            .bytes()
            .any(|byte| byte <= 32 || byte == 127 || matches!(byte, b'\\' | b'#'))
    {
        return Err(failure(category));
    }
    for (index, byte) in value.bytes().enumerate() {
        if byte == b'%' && escape(value.as_bytes(), index).is_none() {
            return Err(failure(category));
        }
    }
    let (raw_path, query) = value.split_once('?').unwrap_or((value, ""));
    let mut decoded = raw_path.to_owned();
    let mut decoded_query = query.to_owned();
    for _ in 0..16 {
        if decoded.split('/').any(|part| matches!(part, "." | ".."))
            || decoded
                .chars()
                .any(|ch| ch <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&ch) || ch == '\\')
            || decoded_query
                .chars()
                .any(|ch| ch <= '\u{1f}' || ch == '\u{7f}' || ch == '\\')
            || decoded.bytes().enumerate().any(|(index, byte)| {
                byte == b'%'
                    && escape(decoded.as_bytes(), index)
                        .is_some_and(|value| matches!(value, b'/' | b'\\' | b'?' | b'#'))
            })
        {
            return Err(failure(category));
        }
        let next = decode_path(&decoded).ok_or_else(|| failure(category))?;
        let next_query = decode_query(&decoded_query);
        if next == decoded && next_query == decoded_query {
            return Ok(decoded);
        }
        decoded = next;
        decoded_query = next_query;
    }
    Err(failure(category))
}

pub(super) fn allows(routes: &[Route], requested: &str, method: Method) -> Result<bool, Failure> {
    for route in routes {
        let registered = path(
            text(&route.path, Category::InvalidRegistration)?,
            Category::InvalidRegistration,
        )?;
        if route.methods.contains(&method)
            && (requested == registered
                || (route.match_kind == RouteMatch::Prefix
                    && requested.starts_with(&if registered.ends_with('/') {
                        registered.clone()
                    } else {
                        format!("{registered}/")
                    })))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn preview(value: &str) -> Result<(), Failure> {
    let origin = url::Url::parse(value).map_err(|_| failure(Category::Forbidden))?;
    if origin.origin().ascii_serialization() != value
        || !origin.username().is_empty()
        || origin.password().is_some()
        || (origin.scheme() != "https"
            && !(origin.scheme() == "http"
                && matches!(origin.host_str(), Some("127.0.0.1" | "[::1]"))))
    {
        return Err(failure(Category::Forbidden));
    }
    Ok(())
}

fn escape(bytes: &[u8], index: usize) -> Option<u8> {
    Some(
        (bytes.get(index + 1).copied().and_then(hex)? << 4)
            | bytes.get(index + 2).copied().and_then(hex)?,
    )
}
fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
fn decode_path(value: &str) -> Option<String> {
    let mut output = Vec::with_capacity(value.len());
    let mut index = 0;
    while index < value.len() {
        if value.as_bytes()[index] == b'%'
            && let Some(byte) = escape(value.as_bytes(), index)
        {
            output.push(byte);
            index += 3;
            continue;
        }
        output.push(value.as_bytes()[index]);
        index += 1;
    }
    String::from_utf8(output).ok()
}
fn decode_query(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    while index < value.len() {
        if value.as_bytes()[index] == b'%'
            && let Some(byte) = escape(value.as_bytes(), index)
        {
            output.push(char::from(byte));
            index += 3;
            continue;
        }
        let Some(ch) = value[index..].chars().next() else {
            break;
        };
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}
