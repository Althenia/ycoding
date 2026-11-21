use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};

pub use crate::meeting::pcm::{decode_base64 as base64_decode, encode_base64 as base64_encode};

pub fn hex(data: &[u8]) -> String {
    data.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, data).as_ref())
}

pub fn random_bytes(length: usize) -> Vec<u8> {
    let mut out = vec![0u8; length];
    SystemRandom::new()
        .fill(&mut out)
        .expect("system random source available");
    out
}

pub fn random_hex(length: usize) -> String {
    hex(&random_bytes(length))
}

pub fn uuid_v4() -> String {
    let mut bytes = random_bytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let text = hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &text[0..8],
        &text[8..12],
        &text[12..16],
        &text[16..20],
        &text[20..32]
    )
}

pub fn percent_decode(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_value(*bytes.get(index + 1)?)?;
            let low = hex_value(*bytes.get(index + 2)?)?;
            out.push(high * 16 + low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub fn percent_encode_component(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn ascii_lower(text: &str) -> String {
    text.chars()
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

pub fn utf8_error_text(bytes: &[u8]) -> Option<String> {
    let invalid = |index: usize, length: usize| {
        format!("invalid utf-8 sequence of {length} bytes from index {index}")
    };
    let incomplete = |index: usize| format!("incomplete utf-8 byte sequence from index {index}");
    let mut index = 0;
    while index < bytes.len() {
        let first = bytes[index];
        if first < 0x80 {
            index += 1;
            continue;
        }
        let width = match first {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return Some(invalid(index, 1)),
        };
        let Some(second) = bytes.get(index + 1).copied() else {
            return Some(incomplete(index));
        };
        let (low, high) = match first {
            0xe0 => (0xa0, 0xbf),
            0xed => (0x80, 0x9f),
            0xf0 => (0x90, 0xbf),
            0xf4 => (0x80, 0x8f),
            _ => (0x80, 0xbf),
        };
        if second < low || second > high {
            return Some(invalid(index, 1));
        }
        for offset in 2..width {
            let Some(byte) = bytes.get(index + offset).copied() else {
                return Some(incomplete(index));
            };
            if !(0x80..=0xbf).contains(&byte) {
                return Some(invalid(index, offset));
            }
        }
        index += width;
    }
    None
}
