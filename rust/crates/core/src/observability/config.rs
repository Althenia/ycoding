use super::Options;
use std::{collections::BTreeMap, path::PathBuf};
use tracing::Level;

pub(super) fn file(options: &Options) -> PathBuf {
    options.log_directory.join(if options.local {
        format!(
            "ycoding-{}.log",
            options
                .channel
                .chars()
                .flat_map(|ch| {
                    if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                        return vec![ch];
                    }
                    vec!['-'; ch.len_utf16()]
                })
                .collect::<String>()
        )
    } else {
        "ycoding.log".into()
    })
}

pub(super) fn minimum(value: Option<&str>) -> Level {
    match value.map(str::to_uppercase).as_deref() {
        Some("DEBUG") => Level::DEBUG,
        Some("WARN") => Level::WARN,
        Some("ERROR") => Level::ERROR,
        _ => Level::INFO,
    }
}

pub(super) fn headers(value: Option<&String>) -> BTreeMap<String, String> {
    value
        .filter(|v| !v.is_empty())
        .map(|value| {
            value
                .split(',')
                .map(|entry| {
                    let (key, value) = entry.split_once('=').unwrap_or((entry, ""));
                    (key.into(), value.into())
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn resource_attributes(value: Option<&String>) -> BTreeMap<String, String> {
    value
        .filter(|v| !v.is_empty())
        .and_then(|value| {
            value
                .split(',')
                .map(|entry| {
                    let (key, value) = entry.split_once('=')?;
                    if key.is_empty() {
                        return None;
                    }
                    Some((decode(key)?, decode(value)?))
                })
                .collect::<Option<BTreeMap<_, _>>>()
        })
        .unwrap_or_default()
}

fn decode(value: &str) -> Option<String> {
    let mut decoded = Vec::new();
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        if byte != b'%' {
            decoded.push(byte);
            continue;
        }
        let high = (bytes.next()? as char).to_digit(16)?;
        let low = (bytes.next()? as char).to_digit(16)?;
        decoded.push((high * 16 + low) as u8);
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::{decode, headers, resource_attributes};
    use std::collections::BTreeMap;

    #[test]
    fn resource_decode_is_strict_and_keeps_literal_plus() {
        let value = "a=hello+world,b=%F0%9F%92%A1,c=x%3Dy,d=x%2Cy,a=last".into();
        assert_eq!(
            resource_attributes(Some(&value)),
            BTreeMap::from([
                ("a".into(), "last".into()),
                ("b".into(), "💡".into()),
                ("c".into(), "x=y".into()),
                ("d".into(), "x,y".into())
            ])
        );
        for invalid in [
            "a=b,broken",
            "a=b,=value",
            "a=b,x=%",
            "a=b,x=%XY",
            "a=b,x=%FF",
        ] {
            assert!(resource_attributes(Some(&invalid.into())).is_empty());
        }
        assert_eq!(decode("a+b"), Some("a+b".into()));
    }

    #[test]
    fn headers_keep_equals_and_do_not_decode_or_trim() {
        assert_eq!(
            headers(Some(&"a=b=c,a=last, space=%2C,empty".into())),
            BTreeMap::from([
                ("a".into(), "last".into()),
                (" space".into(), "%2C".into()),
                ("empty".into(), "".into())
            ])
        );
        assert!(headers(None).is_empty());
    }
}
