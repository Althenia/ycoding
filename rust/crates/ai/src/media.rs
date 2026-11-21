use crate::{
    Error,
    llm::{Media, MediaData},
};
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub fn encode(bytes: &[u8]) -> String {
    let mut text = String::new();
    for chunk in bytes.chunks(3) {
        let bits = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        text.push(B64[((bits >> 18) & 63) as usize] as char);
        text.push(B64[((bits >> 12) & 63) as usize] as char);
        text.push(if chunk.len() > 1 {
            B64[((bits >> 6) & 63) as usize] as char
        } else {
            '='
        });
        text.push(if chunk.len() > 2 {
            B64[(bits & 63) as usize] as char
        } else {
            '='
        });
    }
    text
}
pub fn decode(base64: &str) -> Result<Vec<u8>, ()> {
    if !base64.len().is_multiple_of(4) {
        return Err(());
    }
    let mut decoded = Vec::with_capacity(base64.len() / 4 * 3);
    for (index, chunk) in base64.as_bytes().chunks(4).enumerate() {
        let padding = usize::from(chunk[3] == b'=') + usize::from(chunk[2] == b'=');
        if padding > 0 && index + 1 != base64.len() / 4 || chunk[2] == b'=' && chunk[3] != b'=' {
            return Err(());
        }
        let values = chunk
            .iter()
            .enumerate()
            .map(|(index, value)| {
                if *value == b'=' && index >= 2 {
                    Ok(0)
                } else {
                    B64.iter()
                        .position(|ch| ch == value)
                        .map(|value| value as u32)
                        .ok_or(())
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        let bits = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
        decoded.push((bits >> 16) as u8);
        if padding < 2 {
            decoded.push((bits >> 8) as u8);
        }
        if padding == 0 {
            decoded.push(bits as u8);
        }
    }
    Ok(decoded)
}
pub fn validate(route: &str, part: &Media) -> Result<(String, String), Error> {
    let mime = part.mime.as_str().unwrap_or("").to_lowercase();
    if !["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&mime.as_str()) {
        return Err(Error::invalid(format!(
            "{route} does not support media type {}",
            part.mime.as_str().unwrap_or("")
        )));
    }
    let base64 = match &part.data {
        MediaData::Bytes(bytes) => {
            if bytes.len() > 20 * 1024 * 1024 {
                return Err(Error::invalid(format!(
                    "{route} media exceeds the 20971520 byte decoded limit"
                )));
            }
            encode(bytes)
        }
        MediaData::Encoded(value) => {
            let value = value.as_str().ok_or_else(|| {
                Error::invalid(format!("{route} media must contain valid base64"))
            })?;
            if let Some(data) = value.strip_prefix("data:") {
                let (kind, body) = data.split_once(";base64,").ok_or_else(|| {
                    Error::invalid(format!("{route} media data URL must contain valid base64"))
                })?;
                if kind.to_lowercase() != mime {
                    return Err(Error::invalid(format!(
                        "{route} media type {} does not match data URL type {kind}",
                        part.mime.as_str().unwrap_or("")
                    )));
                }
                body.to_owned()
            } else {
                value.to_owned()
            }
        }
    };
    if base64.len() > 28 * 1024 * 1024 {
        return Err(Error::invalid(format!(
            "{route} media exceeds the 29360128 byte encoded limit"
        )));
    }
    if base64.is_empty() {
        return Err(Error::invalid(format!(
            "{route} media must contain valid base64"
        )));
    }
    let decoded = decode(&base64)
        .map_err(|_| Error::invalid(format!("{route} media must contain valid base64")))?;
    if decoded.len() > 20 * 1024 * 1024 {
        return Err(Error::invalid(format!(
            "{route} media exceeds the 20971520 byte decoded limit"
        )));
    }
    if encode(&decoded) != base64 {
        return Err(Error::invalid(format!(
            "{route} media must contain canonical base64"
        )));
    }
    Ok((mime, base64))
}
pub fn notice(part: &Media, error: &Error) -> String {
    format!(
        "File {} ({}) omitted: {}",
        part.filename
            .as_ref()
            .and_then(ycoding_schema::LosslessString::as_str)
            .unwrap_or("(unnamed)"),
        part.mime.as_str().unwrap_or(""),
        error.message
    )
}
