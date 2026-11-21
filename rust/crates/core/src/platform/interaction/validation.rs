use super::{Error, text};
use serde_json::Value;
use std::{collections::HashMap, sync::LazyLock};
use url::Url;

pub fn valid(name: &str, value: &Value) -> bool {
    static CONTRACTS: LazyLock<HashMap<String, jsonschema::Validator>> = LazyLock::new(|| {
        let Value::Object(contracts) = serde_json::from_str(include_str!("contract.json"))
            .expect("Interaction contracts parse")
        else {
            unreachable!()
        };
        contracts
            .into_iter()
            .map(|(name, schema)| (name, compile(&schema)))
            .collect()
    });
    CONTRACTS.get(name).is_some_and(|v| v.is_valid(value))
}
pub(super) fn compile(schema: &Value) -> jsonschema::Validator {
    jsonschema::options()
        .offline()
        .with_keyword("pattern", |_, value, _| {
            let pattern = value
                .as_str()
                .ok_or_else(|| jsonschema::ValidationError::custom("pattern must be a string"))?;
            Ok(Box::new(Pattern(
                crate::regexp::RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "u")
                    .map_err(|e| jsonschema::ValidationError::custom(e.to_string()))?,
            )))
        })
        .with_format("regex", |s| {
            crate::regexp::RegExp::new(&s.encode_utf16().collect::<Vec<_>>(), "").is_ok()
        })
        .build(schema)
        .expect("Interaction contract compiles")
}
struct Pattern(crate::regexp::RegExp);
impl<'i> jsonschema::Keyword<'i> for Pattern {
    fn validate(&self, value: &'i Value) -> Result<(), jsonschema::ValidationError<'i>> {
        if self.is_valid(value) {
            Ok(())
        } else {
            Err(jsonschema::ValidationError::custom(
                "Interaction pattern mismatch",
            ))
        }
    }
    fn is_valid(&self, value: &Value) -> bool {
        value.as_str().is_none_or(|s| {
            self.0
                .clone()
                .test(
                    &s.encode_utf16().collect::<Vec<_>>(),
                    &mut crate::regexp::Budget::unlimited(),
                )
                .unwrap_or(false)
        })
    }
}
pub fn uuid() -> Result<String, Error> {
    let mut bytes = super::super::random::<16>().map_err(|_| Error("unavailable"))?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let h = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}
pub(super) fn id(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(c)
            }
        })
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
}
pub(super) fn proof(value: &Value) -> bool {
    value.as_object().is_some_and(|o| o.len() == 4)
        && ["candidateID", "targetID"]
            .iter()
            .all(|k| value[*k].as_str().is_some_and(id))
        && value["sessionID"]
            .as_str()
            .is_some_and(|s| ycoding_schema::session_id::SessionId::new(s).is_ok())
        && value["authorization"]
            .as_str()
            .is_some_and(|a| !a.is_empty() && a.chars().count() <= 256)
}
pub(super) fn pause_reason(reason: &str) -> bool {
    matches!(
        reason,
        "foreground_required"
            | "file_chooser"
            | "dialog"
            | "captcha"
            | "sensitive"
            | "user_takeover"
    )
}
pub(super) fn allows_target(platform: &str, target: &Value) -> bool {
    if !valid("Target", target) {
        return false;
    }
    if target["kind"] == "macos-window" {
        let bundle = text(target, "bundleID").to_ascii_lowercase();
        return platform == "macos"
            && ![
                "com.google.chrome",
                "org.chromium.chromium",
                "app.ycoding.computer-use",
            ]
            .iter()
            .any(|p| bundle == *p || bundle.starts_with(&format!("{p}.")))
            && super::super::computer::policy::evaluate(&bundle, &[]).decision
                == super::super::computer::policy::Decision::Allowed;
    }
    platform == "chrome"
        && Url::parse(text(target, "origin"))
            .is_ok_and(|u| u.origin().ascii_serialization() == text(target, "origin"))
        && Url::parse(&format!(
            "{}{}",
            text(target, "origin"),
            text(target, "pathname")
        ))
        .is_ok_and(|u| u.path() == text(target, "pathname"))
}
pub(super) fn matches_target(selection: &Value, target: &Value) -> bool {
    if selection["platform"] == "macos" {
        return target["kind"] == "macos-window";
    }
    if selection["url"].is_null() {
        return target["kind"] == "chrome-tab";
    }
    target["kind"]
        == if selection["mode"] == "owned" {
            "chrome-owned"
        } else {
            "chrome-isolated"
        }
        && selection["url"] == target["url"]
        && Url::parse(text(target, "url")).is_ok_and(|u| {
            u.origin().ascii_serialization() == text(target, "origin")
                && u.path() == text(target, "pathname")
        })
}
pub(super) fn target_label(target: &Value) -> &'static str {
    match text(target, "kind") {
        "chrome-tab" => "Selected Chrome tab",
        "chrome-owned" => "Background Chrome tab",
        "chrome-isolated" => "Temporary isolated Chrome",
        _ => "Selected macOS window",
    }
}
pub(super) fn frame(value: &Value) -> bool {
    if !valid("Frame", value) {
        return false;
    }
    let Some(bytes) = crate::meeting::pcm::decode_base64(text(value, "base64")) else {
        return false;
    };
    if bytes.len() > 160 * 1024 {
        return false;
    }
    let dimensions = if value["mimeType"] == "image/png" {
        if bytes.len() < 33 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR"
        {
            return false;
        }
        let width = u32::from_be_bytes(bytes[16..20].try_into().expect("PNG width"));
        let height = u32::from_be_bytes(bytes[20..24].try_into().expect("PNG height"));
        Some((width, height))
    } else {
        if bytes.len() < 4 || !bytes.starts_with(&[255, 216]) {
            return false;
        }
        let mut cursor = 2;
        let mut size = None;
        while cursor + 4 <= bytes.len() {
            if bytes[cursor] != 255 {
                break;
            }
            let mark = bytes[cursor + 1];
            cursor += 2;
            if mark == 217 || mark == 218 {
                break;
            }
            if mark == 0 || mark == 255 {
                continue;
            }
            let length = usize::from(u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]));
            if length < 2 || cursor + length > bytes.len() {
                break;
            }
            if matches!(mark,192..=195|197..=199|201..=203|205..=207) && length >= 7 {
                size = Some((
                    u32::from(u16::from_be_bytes([bytes[cursor + 5], bytes[cursor + 6]])),
                    u32::from(u16::from_be_bytes([bytes[cursor + 3], bytes[cursor + 4]])),
                ));
                break;
            }
            cursor += length;
        }
        size
    };
    dimensions.is_some_and(|(w, h)| {
        value["width"].as_u64() == Some(u64::from(w))
            && value["height"].as_u64() == Some(u64::from(h))
    })
}
pub(super) fn redact(text: &str) -> String {
    static PATTERNS: LazyLock<Vec<(crate::regexp::RegExp, &'static str)>> = LazyLock::new(|| {
        [
        (r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)","g","[redacted]"),
        (r"\bBearer\s+[A-Za-z0-9._~+/-]+=*","gi","[redacted]"),
        (r"\b(?<!\beyJ[A-Za-z0-9_-]*?)eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*","g","[redacted]"),
        (r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}","g","[redacted]"),
        (r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})","g","[redacted]"),
        (r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b","g","[redacted]"),
        (r"\bAIza[0-9A-Za-z_-]{30,}","g","[redacted]"),
        (r"\bxox[abposr]-[A-Za-z0-9-]{10,}","g","[redacted]"),
        (r"(?=[A-Za-z0-9_])(?<![A-Za-z0-9_]-*)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])(?=([A-Za-z0-9_-]{31,}[A-Za-z0-9_]))\1","g","[redacted]"),
        (r"\b(pass(?:word|wd)?|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|auth)(\s*[:=]\s*)(?!\[redacted\])[^\s&#,;]+","gi","$1$2[redacted]"),
        (r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}","g","[redacted]"),
        (r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)","g","[redacted]"),
        (r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)","g","[redacted]"),
        (r"(?<!\w)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?!\d)","g","[redacted]"),
    ].into_iter().map(|(p,f,r)|(crate::regexp::RegExp::new(&p.encode_utf16().collect::<Vec<_>>(),f).expect("redaction pattern"),r)).collect()
    });
    PATTERNS
        .iter()
        .fold(text.to_owned(), |text, (pattern, replacement)| {
            let output = pattern
                .clone()
                .replace(
                    &text.encode_utf16().collect::<Vec<_>>(),
                    &replacement.encode_utf16().collect::<Vec<_>>(),
                    &mut crate::regexp::Budget::unlimited(),
                )
                .expect("redaction completes");
            String::from_utf16_lossy(&output)
        })
}
