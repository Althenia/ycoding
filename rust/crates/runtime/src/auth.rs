use axum::http::{
    HeaderMap,
    header::{AUTHORIZATION, HOST, ORIGIN},
};

const USERNAME: &str = "ycoding";

#[derive(Clone)]
pub struct LocalAuth {
    password: Option<String>,
}

impl LocalAuth {
    pub fn disabled() -> Self {
        Self { password: None }
    }

    pub fn with_password(password: impl Into<String>) -> Self {
        let password = password.into();
        Self {
            password: (!password.is_empty()).then_some(password),
        }
    }

    pub fn required(&self) -> bool {
        self.password.is_some()
    }

    pub fn authorized(&self, headers: &HeaderMap) -> bool {
        let Some(expected) = &self.password else {
            return true;
        };
        let Some((username, password)) = credential(headers) else {
            return false;
        };
        let username_matches = constant_time_eq(username.as_bytes(), USERNAME.as_bytes());
        let password_matches = constant_time_eq(password.as_bytes(), expected.as_bytes());
        username_matches && password_matches
    }
}

fn credential(headers: &HeaderMap) -> Option<(String, String)> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, encoded) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let decoded = String::from_utf8(decode_base64(encoded.trim())?).ok()?;
    let (username, password) = decoded.split_once(':')?;
    Some((username.into(), password.into()))
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let trimmed = input.trim_end_matches('=');
    if input.len() - trimmed.len() > 2 || !input.len().is_multiple_of(4) {
        return None;
    }
    let mut output = Vec::with_capacity(trimmed.len() * 3 / 4);
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    for byte in trimmed.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    Some(output)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let length = left.len().max(right.len());
    let difference = (0..length).fold(left.len() ^ right.len(), |difference, index| {
        let left = left.get(index).copied().unwrap_or(0);
        let right = right.get(index).copied().unwrap_or(0);
        difference | usize::from(left ^ right)
    });
    difference == 0
}

pub fn origin_allowed(headers: &HeaderMap, cors: &[String]) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return !headers.contains_key(ORIGIN);
    };
    let host = headers.get(HOST).and_then(|value| value.to_str().ok());
    if host.is_some_and(|host| origin_host(origin) == Some(host)) {
        return true;
    }
    origin.starts_with("http://localhost:")
        || origin.starts_with("http://127.0.0.1:")
        || cors.iter().any(|allowed| allowed == origin)
}

fn origin_host(origin: &str) -> Option<&str> {
    let (_, rest) = origin.split_once("://")?;
    rest.split(['/', '?', '#']).next()
}
