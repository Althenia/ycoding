use super::{Error, MissingFile, ParseSource, Roots, roots};
use std::{collections::BTreeMap, path::Path};
use ycoding_schema::{JsonValue, stringify_json};

pub(super) fn substitute(
    text: &str,
    source: ParseSource<'_>,
    home: &Path,
    env: &BTreeMap<String, String>,
    missing: MissingFile,
    root: Option<&Roots>,
) -> Result<String, Error> {
    let mut substituted = String::new();
    let mut cursor = 0;
    while let Some(start) = text[cursor..].find("{env:").map(|index| cursor + index) {
        substituted.push_str(&text[cursor..start]);
        let Some(end) = text[start + 5..].find('}').map(|index| start + 5 + index) else {
            substituted.push_str(&text[start..]);
            cursor = text.len();
            break;
        };
        if end == start + 5 {
            substituted.push_str("{env:}");
            cursor = end + 1;
            continue;
        }
        substituted.push_str(
            env.get(&text[start + 5..end])
                .map(String::as_str)
                .unwrap_or_default(),
        );
        cursor = end + 1;
    }
    substituted.push_str(&text[cursor..]);
    let directory = match source {
        ParseSource::Path(path) => path.parent().unwrap_or_else(|| Path::new(".")),
        ParseSource::Virtual { directory, .. } => directory,
    };
    let mut output = String::new();
    cursor = 0;
    while let Some(start) = substituted[cursor..]
        .find("{file:")
        .map(|index| cursor + index)
    {
        output.push_str(&substituted[cursor..start]);
        let Some(end) = substituted[start + 6..]
            .find('}')
            .map(|index| start + 6 + index)
        else {
            output.push_str(&substituted[start..]);
            cursor = substituted.len();
            break;
        };
        let token = &substituted[start..=end];
        let line_start = substituted[..start]
            .rfind('\n')
            .map_or(0, |index| index + 1);
        if end == start + 6
            || substituted[line_start..start]
                .trim_start_matches(|character: char| {
                    character.len_utf16() == 1 && is_js_whitespace(character as u16)
                })
                .starts_with("//")
        {
            output.push_str(token);
            cursor = end + 1;
            continue;
        }
        let file = &substituted[start + 6..end];
        let expanded = file.strip_prefix("~/").map(|file| home.join(file));
        let file = expanded.as_deref().unwrap_or_else(|| Path::new(file));
        let path = roots::absolute(&if file.is_absolute() {
            file.to_owned()
        } else {
            directory.join(file)
        })?;
        if let Some(root) = root {
            root.check(&path)?;
        }
        let content = match super::read_text(&path) {
            Ok(content) => content,
            Err(_) if matches!(missing, MissingFile::Empty) => String::new(),
            Err(cause) => {
                let message = if cause.kind() == std::io::ErrorKind::NotFound {
                    format!(
                        "bad file reference: \"{token}\" {} does not exist",
                        path.display()
                    )
                } else {
                    format!("bad file reference: \"{token}\"")
                };
                return Err(Error {
                    path: match source {
                        ParseSource::Path(path) => Some(path.into()),
                        ParseSource::Virtual { .. } => None,
                    },
                    virtual_source: match source {
                        ParseSource::Virtual { source, .. } => Some(source.into()),
                        ParseSource::Path(_) => None,
                    },
                    message,
                    cause: Some(cause),
                });
            }
        };
        let content = content.trim_matches(|character: char| {
            character.len_utf16() == 1 && is_js_whitespace(character as u16)
        });
        let escaped = stringify_json(&JsonValue::String(content.into()));
        output.push_str(&escaped[1..escaped.len() - 1]);
        cursor = end + 1;
    }
    output.push_str(&substituted[cursor..]);
    Ok(output)
}

pub(super) fn is_js_whitespace(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
