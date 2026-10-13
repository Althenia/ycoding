use super::{
    protobuf::{self, Field},
    wire::Exec,
};
use crate::{
    Error, json,
    llm::{ToolDefinition, ToolResult, ToolResultValue},
};
use ycoding_schema::JsonValue;

pub(crate) struct Native {
    pub exec: Exec,
    pub name: String,
    pub input: JsonValue,
    pub local_error: Option<&'static str>,
}
pub(crate) fn decode_write_bytes(bytes: &[u8], hint: Option<&str>) -> Option<String> {
    let label = hint
        .unwrap_or("")
        .trim_matches(|ch| matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
        .to_lowercase()
        .replace(['_', ' '], "-");
    let known = encoding_rs::Encoding::for_label(label.as_bytes())
        .filter(|encoding| *encoding != encoding_rs::REPLACEMENT);
    let wide = known.is_some()
        && ["utf16", "utf-16", "utf32", "utf-32"]
            .iter()
            .any(|prefix| label.starts_with(prefix));
    if !wide && bytes.contains(&0) {
        return None;
    }
    let text = known
        .unwrap_or(encoding_rs::UTF_8)
        .decode_without_bom_handling_and_without_replacement(bytes)?;
    Some(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
}

pub(crate) fn native(exec: Exec, tools: &[ToolDefinition]) -> Result<Option<Native>, Error> {
    if ![3, 47, 48].contains(&exec.variant) {
        return Ok(None);
    }
    let fields = protobuf::fields(&exec.args)?;
    let path = text(&fields, 1)?.unwrap_or_default();
    if exec.variant == 3 {
        let bytes = fields
            .iter()
            .rev()
            .find(|field| field.number == 5)
            .map(|field| field.bytes())
            .transpose()?
            .filter(|bytes| !bytes.is_empty());
        let content = if let Some(bytes) = bytes {
            let hint = text(&fields, 6)?;
            let Some(content) = decode_write_bytes(bytes, hint.as_deref()) else {
                return Ok(None);
            };
            Some(content)
        } else {
            text(&fields, 2)?
        };
        let mut raw = json::object([("path", json::s(path))]);
        if let Some(content) = content {
            json::set(&mut raw, "content", json::s(content));
        }
        let (name, input) = map("write", &raw, tools)?;
        return Ok(Some(Native {
            exec,
            name,
            input,
            local_error: None,
        }));
    }
    if exec.variant == 48 {
        let raw = json::object([
            ("path", json::s(path)),
            ("content", json::s(text(&fields, 2)?.unwrap_or_default())),
        ]);
        let (name, input) = map("write", &raw, tools)?;
        return Ok(Some(Native {
            exec,
            name,
            input,
            local_error: None,
        }));
    }
    let edits = fields
        .iter()
        .filter(|field| field.number == 2)
        .collect::<Vec<_>>();
    let edit = if edits.len() == 1 {
        protobuf::fields(edits[0].bytes()?)?
    } else {
        Vec::new()
    };
    let old = text(&edit, 1)?;
    let new = text(&edit, 2)?;
    let valid =
        !path.is_empty() && old.as_ref().is_some_and(|old| !old.is_empty()) && new.is_some();
    let mut raw = json::object([("path", json::s(path))]);
    if let Some(old) = old {
        json::set(&mut raw, "oldString", json::s(old));
    }
    if let Some(new) = new {
        json::set(&mut raw, "newString", json::s(new));
    }
    let (name, input) = map("edit", &raw, tools)?;
    Ok(Some(Native {
        exec,
        name,
        input,
        local_error: (!valid).then_some(
            "Cursor Pi edit cannot be represented safely: expected one non-empty replacement.",
        ),
    }))
}
impl Native {
    pub fn result(&self, result: &ToolResult, elapsed_ms: u64) -> Result<Vec<u8>, Error> {
        let output = result
            .result
            .to_text()
            .to_utf8()
            .map_err(|_| Error::output("Cursor native tool result is not Unicode text"))?;
        let error = matches!(result.result, ToolResultValue::Error(_));
        self.output(&output, error, elapsed_ms)
    }
    pub fn output(&self, output: &str, error: bool, elapsed_ms: u64) -> Result<Vec<u8>, Error> {
        if self.exec.variant == 3 {
            let fields = protobuf::fields(&self.exec.args)?;
            let mut value = Vec::new();
            let path = text(&fields, 1)?.unwrap_or_default();
            let path = if path.is_empty() && !error {
                path_tag(output).unwrap_or_default().to_owned()
            } else {
                path
            };
            protobuf::write_string(&mut value, 1, &path.into())?;
            if error {
                protobuf::write_string(&mut value, 2, &output.into())?;
            }
            if !error {
                protobuf::write_varint(
                    &mut value,
                    2,
                    if output.is_empty() {
                        0
                    } else {
                        output.bytes().filter(|byte| *byte == b'\n').count() as u64 + 1
                    },
                )?;
                protobuf::write_varint(&mut value, 3, output.encode_utf16().count() as u64)?;
            }
            let mut result = Vec::new();
            protobuf::write_bytes(&mut result, if error { 5 } else { 1 }, &value)?;
            return self.exec.result(3, &result, Some(elapsed_ms));
        }
        let output = if !error && self.exec.variant == 48 && output.is_empty() {
            "Wrote file successfully."
        } else {
            output
        };
        let mut value = Vec::new();
        protobuf::write_string(&mut value, 1, &output.into())?;
        let mut result = Vec::new();
        protobuf::write_bytes(&mut result, if error { 2 } else { 1 }, &value)?;
        self.exec
            .result(self.exec.variant + 1, &result, Some(elapsed_ms))
    }
}

pub(crate) fn map(
    name: &str,
    input: &JsonValue,
    tools: &[ToolDefinition],
) -> Result<(String, JsonValue), Error> {
    let JsonValue::Object(fields) = input else {
        return Err(Error::output(
            "Cursor host tool arguments must be an object",
        ));
    };
    let cleaned = json::object(
        fields
            .iter()
            .filter(|(key, value)| {
                let internal = [
                    "tool_call_id",
                    "toolCallId",
                    "exec_id",
                    "span",
                    "sandbox_policy",
                    "requested_sandbox_policy",
                    "smart_mode_approval",
                    "smart_mode_approval_only",
                    "skip_approval",
                    "parsing_result",
                    "classifier_result",
                    "hook_approval_requirement",
                    "conversation_id",
                    "simple_commands",
                    "has_input_redirect",
                    "has_output_redirect",
                    "is_background",
                    "timeout_behavior",
                    "hard_timeout",
                    "close_stdin",
                    "output_notification",
                    "file_output_threshold_bytes",
                    "return_file_content_after_write",
                    "ignore",
                ];
                let empty = [
                    "content",
                    "file_text",
                    "fileText",
                    "stream_content",
                    "input",
                    "oldString",
                    "old_string",
                    "newString",
                    "new_string",
                ];
                !matches!(value, JsonValue::Null)
                    && !internal.iter().any(|item| key.as_str() == Some(item))
                    && !(json::string(value).is_some_and(|value| value.is_empty())
                        && !empty.iter().any(|item| key.as_str() == Some(item)))
            })
            .cloned(),
    );
    let file_key = tools
        .iter()
        .filter(|tool| matches!(tool.name.as_str(), Some("read" | "write" | "edit")))
        .find_map(|tool| {
            let props = json::get(&tool.input_schema, "properties")?;
            if json::get(props, "path").is_some() && json::get(props, "filePath").is_none() {
                return Some("path");
            }
            json::get(props, "filePath").map(|_| "filePath")
        })
        .unwrap_or(
            if tools.iter().any(|tool| tool.name.as_str() == Some("shell"))
                && !tools.iter().any(|tool| tool.name.as_str() == Some("bash"))
            {
                "path"
            } else {
                "filePath"
            },
        );
    let mut args = json::empty();
    let path = ["filePath", "path", "file_path"]
        .into_iter()
        .find_map(|key| json::get(&cleaned, key).and_then(json::string))
        .filter(|value| !value.is_empty());
    match name {
        "read" => {
            if let Some(path) = path {
                json::set(&mut args, file_key, json::s(path.clone()));
            }
            for key in ["offset", "limit"] {
                if let Some(value) = json::get(&cleaned, key)
                    .and_then(json::number)
                    .filter(|value| *value > 0.0)
                {
                    json::set(&mut args, key, JsonValue::Number(value));
                }
            }
        }
        "write" => {
            if let Some(path) = path {
                json::set(&mut args, file_key, json::s(path.clone()));
            }
            if let Some(content) = ["content", "file_text", "fileText", "contents", "text"]
                .into_iter()
                .find_map(|key| json::get(&cleaned, key).and_then(json::string))
            {
                json::set(&mut args, "content", json::s(content.clone()));
            }
            if ["file_bytes", "fileBytes"].into_iter().any(|key| {
                json::get(&cleaned, key)
                    .and_then(json::array)
                    .is_some_and(|bytes| !bytes.is_empty())
            }) {
                return Err(Error::output(
                    "Cursor binary MCP writes require the host byte-preserving write boundary",
                ));
            }
        }
        "edit" => {
            if let Some(input) = json::get(&cleaned, "input").and_then(json::string) {
                return Ok((
                    name.into(),
                    json::object([("input", json::s(input.clone()))]),
                ));
            }
            if let Some(path) = path {
                json::set(&mut args, file_key, json::s(path.clone()));
            }
            for (target, names) in [
                ("oldString", ["oldString", "old_string"]),
                ("newString", ["newString", "new_string"]),
            ] {
                if let Some(value) = names
                    .into_iter()
                    .find_map(|key| json::get(&cleaned, key).and_then(json::string))
                {
                    json::set(&mut args, target, json::s(value.clone()));
                }
            }
            if let Some(value) = json::get(&cleaned, "replaceAll").and_then(json::boolean) {
                json::set(&mut args, "replaceAll", JsonValue::Bool(value));
            }
        }
        "shell" | "bash" => {
            for (target, names) in [
                ("command", ["command", "command"]),
                ("workdir", ["workdir", "working_directory"]),
            ] {
                if let Some(value) = names
                    .into_iter()
                    .find_map(|key| json::get(&cleaned, key).and_then(json::string))
                {
                    json::set(&mut args, target, json::s(value.clone()));
                }
            }
            if let Some(value) = json::get(&cleaned, "timeout").and_then(json::number) {
                json::set(&mut args, "timeout", JsonValue::Number(value));
            }
            let shell = if tools.iter().any(|tool| tool.name.as_str() == Some("shell"))
                && !tools.iter().any(|tool| tool.name.as_str() == Some("bash"))
            {
                "shell"
            } else {
                "bash"
            };
            return Ok((shell.into(), args));
        }
        "grep" => {
            let pattern = json::get(&cleaned, "pattern")
                .and_then(json::string)
                .filter(|value| !value.is_empty());
            let include = json::get(&cleaned, "include")
                .or_else(|| json::get(&cleaned, "glob"))
                .and_then(json::string);
            if let Some(path) = json::get(&cleaned, "path") {
                json::set(&mut args, "path", path.clone());
            }
            if let Some(pattern) = pattern {
                json::set(&mut args, "pattern", json::s(pattern.clone()));
                if let Some(include) = include {
                    json::set(&mut args, "include", json::s(include.clone()));
                }
            }
            if pattern.is_none() {
                json::set(
                    &mut args,
                    "pattern",
                    json::s(include.cloned().unwrap_or_else(|| "**/*".into())),
                );
                return Ok(("glob".into(), args));
            }
        }
        "glob" => {
            for (target, names) in [
                ("pattern", ["pattern", "glob_pattern", "globPattern"]),
                ("path", ["path", "target_directory", "targetDirectory"]),
            ] {
                if let Some(value) = names
                    .into_iter()
                    .find_map(|key| json::get(&cleaned, key).and_then(json::string))
                {
                    json::set(&mut args, target, json::s(value.clone()));
                }
            }
        }
        _ => return Ok((name.into(), cleaned)),
    }
    Ok((name.into(), args))
}
fn path_tag(output: &str) -> Option<&str> {
    output.match_indices("<path>").find_map(|(start, tag)| {
        let rest = &output[start + tag.len()..];
        let end = rest.find('<')?;
        (end > 0 && rest[end..].starts_with("</path>")).then_some(&rest[..end])
    })
}
fn text(fields: &[Field<'_>], number: u32) -> Result<Option<String>, Error> {
    fields
        .iter()
        .rev()
        .find(|field| field.number == number)
        .map(|field| field.text())
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::decode_write_bytes;

    #[test]
    fn cursor_encoding_labels_trim_exact_ecmascript_whitespace_not_unicode_white_space() {
        for ch in [
            '\u{9}', '\u{a}', '\u{b}', '\u{c}', '\u{d}', ' ', '\u{a0}', '\u{1680}', '\u{2000}',
            '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
        ] {
            assert_eq!(
                decode_write_bytes(&[65, 0], Some(&format!("{ch}UTF_16LE{ch}"))),
                Some("A".into()),
                "{ch:?}"
            );
        }
        for ch in ['\u{85}', '\u{180e}', '\u{200b}'] {
            assert_eq!(
                decode_write_bytes(&[65, 0], Some(&format!("{ch}UTF_16LE{ch}"))),
                None,
                "{ch:?}"
            );
        }
    }

    #[test]
    fn cursor_write_bytes_match_fatal_text_decoder_labels_nuls_sequences_and_boms() {
        for (bytes, hint, expected) in [
            (vec![65, 0, 66, 0], Some(" UTF_16LE "), Some("AB")),
            (vec![0, 65, 0, 66], Some("utf-16be"), Some("AB")),
            (vec![0xff, 0xfe, 65, 0], Some("utf-16le"), Some("A")),
            (vec![0xef, 0xbb, 0xbf, 65], None, Some("A")),
            (vec![0xe9], Some("ISO_8859_1"), Some("é")),
            (vec![0x82, 0xa0], Some("shift_jis"), Some("あ")),
            (vec![65], Some("unknown-label"), Some("A")),
            (vec![0xff], Some("unknown-label"), None),
            (vec![65, 0], Some("latin1"), None),
            (vec![0, 65], Some("unicodefffe"), None),
            (vec![0, 0xd8], Some("utf-16le"), None),
            (vec![0x82], Some("shift_jis"), None),
            (vec![0xc0, 0xaf], None, None),
            (vec![65], Some("replacement"), Some("A")),
            (vec![65], Some("x-user-defined"), Some("A")),
            (vec![0xff], Some("x-user-defined"), Some("\u{f7ff}")),
        ] {
            assert_eq!(
                decode_write_bytes(&bytes, hint).as_deref(),
                expected,
                "{bytes:?} {hint:?}"
            );
        }
    }
}
