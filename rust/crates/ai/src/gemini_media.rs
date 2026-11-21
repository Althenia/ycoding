use crate::{
    Error,
    json::{self, s},
    llm::{Media, MediaData},
};
use ycoding_schema::{JsonValue, LosslessString};

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn validate(part: &Media) -> Result<(String, String), Error> {
    let mime = part.mime.as_str().unwrap_or("").to_lowercase();
    if ![
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "video/mp4",
        "video/webm",
        "video/quicktime",
        "audio/wav",
        "audio/mp3",
        "audio/aiff",
        "audio/aac",
        "audio/ogg",
        "audio/flac",
    ]
    .contains(&mime.as_str())
    {
        return Err(Error::invalid(format!(
            "Gemini does not support media type {}",
            part.mime.as_str().unwrap_or("")
        )));
    }
    let base64 = match &part.data {
        MediaData::Bytes(bytes) => {
            if bytes.len() > 20 * 1024 * 1024 {
                return Err(Error::invalid(
                    "Gemini media exceeds the 20971520 byte decoded limit",
                ));
            }
            crate::media::encode(bytes)
        }
        MediaData::Encoded(text) => {
            let text = text
                .as_str()
                .ok_or_else(|| Error::invalid("Gemini media must contain valid base64"))?;
            if let Some(data) = text.strip_prefix("data:") {
                let (kind, body) = data
                    .split_once(";base64,")
                    .filter(|(kind, body)| {
                        !kind.is_empty()
                            && !kind.contains([';', ','])
                            && body
                                .trim_end_matches('=')
                                .bytes()
                                .all(|byte| B64.contains(&byte))
                            && body.bytes().rev().take_while(|byte| *byte == b'=').count() <= 2
                    })
                    .ok_or_else(|| {
                        Error::invalid("Gemini media data URL must contain valid base64")
                    })?;
                if kind.to_lowercase() != mime {
                    return Err(Error::invalid(format!(
                        "Gemini media type {} does not match data URL type {kind}",
                        part.mime.as_str().unwrap_or("")
                    )));
                }
                body.to_owned()
            } else {
                text.to_owned()
            }
        }
    };
    if base64.len() > 28 * 1024 * 1024 {
        return Err(Error::invalid(
            "Gemini media exceeds the 29360128 byte encoded limit",
        ));
    }
    if base64.is_empty() || base64.len() % 4 != 0 {
        return Err(Error::invalid("Gemini media must contain valid base64"));
    }
    let padding = base64
        .bytes()
        .rev()
        .take_while(|byte| *byte == b'=')
        .count();
    let data = &base64.as_bytes()[..base64.len() - padding];
    if padding > 2 || !data.iter().all(|byte| B64.contains(byte)) {
        return Err(Error::invalid("Gemini media must contain valid base64"));
    }
    if base64.len() / 4 * 3 - padding > 20 * 1024 * 1024 {
        return Err(Error::invalid(
            "Gemini media exceeds the 20971520 byte decoded limit",
        ));
    }
    if padding > 0
        && B64
            .iter()
            .position(|byte| Some(byte) == data.last())
            .is_some_and(|bits| bits & if padding == 2 { 15 } else { 3 } != 0)
    {
        return Err(Error::invalid("Gemini media must contain canonical base64"));
    }
    Ok((mime, base64))
}
pub(crate) fn lower(part: &Media) -> JsonValue {
    match validate(part) {
        Ok((mime, data)) => json::object([(
            "inlineData",
            json::object([("mimeType", s(mime)), ("data", s(data))]),
        )]),
        Err(error) => {
            let mut notice: LosslessString = "File ".into();
            json::concat(
                &mut notice,
                part.filename.as_ref().unwrap_or(&"(unnamed)".into()),
            );
            json::concat(&mut notice, &" (".into());
            json::concat(&mut notice, &part.mime);
            json::concat(&mut notice, &format!(") omitted: {}", error.message).into());
            tracing::warn!(
                "Gemini: {}",
                notice.as_str().unwrap_or("Invalid media omitted")
            );
            json::object([("text", s(notice))])
        }
    }
}
