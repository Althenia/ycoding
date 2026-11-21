use crate::platform::{process, shell::select};
use crate::regexp::{Budget, RegExp};
use crate::resources::config::Configuration;
use std::path::Path;
use ycoding_schema::LosslessString;

pub fn arguments(template: &LosslessString, input: &LosslessString) -> LosslessString {
    let template = template.code_units().collect::<Vec<_>>();
    let input = input.code_units().collect::<Vec<_>>();
    let pattern = |source: &str, flags| {
        RegExp::new(&source.encode_utf16().collect::<Vec<_>>(), flags).expect("static pattern")
    };
    let args = parse_arguments(&input);
    let placeholders = pattern(r"\$(\d+)", "g")
        .match_all(&template, &mut Budget::unlimited())
        .expect("placeholder matching");
    let position = |matched: &crate::regexp::Match| {
        matched.captures[1]
            .as_ref()
            .and_then(|value| String::from_utf16(value).ok()?.parse::<usize>().ok())
    };
    let last = placeholders.iter().filter_map(position).max().unwrap_or(0);
    let mut expanded = Vec::new();
    let mut start = 0;
    for matched in &placeholders {
        expanded.extend_from_slice(&template[start..matched.index]);
        if let Some(index) = position(matched)
            .and_then(|position| position.checked_sub(1))
            .filter(|index| *index < args.len())
        {
            if index + 1 == last {
                for (offset, arg) in args[index..].iter().enumerate() {
                    if offset > 0 {
                        expanded.push(32);
                    }
                    expanded.extend(arg);
                }
            } else {
                expanded.extend(&args[index]);
            }
        }
        start = matched.index + matched.captures[0].as_ref().expect("whole match").len();
    }
    expanded.extend_from_slice(&template[start..]);
    let token = "$ARGUMENTS".encode_utf16().collect::<Vec<_>>();
    let contains = template.windows(token.len()).any(|window| window == token);
    let mut output = Vec::new();
    let mut index = 0;
    while index < expanded.len() {
        if expanded[index..].starts_with(&token) {
            output.extend(&input);
            index += token.len();
        } else {
            output.push(expanded[index]);
            index += 1;
        }
    }
    if placeholders.is_empty()
        && !contains
        && input
            .iter()
            .any(|unit| !crate::process::guardrails::is_whitespace(*unit))
    {
        output.extend([10, 10]);
        output.extend(input);
    }
    let start = output
        .iter()
        .take_while(|unit| crate::process::guardrails::is_whitespace(**unit))
        .count();
    let end = output.len()
        - output[start..]
            .iter()
            .rev()
            .take_while(|unit| crate::process::guardrails::is_whitespace(**unit))
            .count();
    LosslessString::from_utf16(output[start..end].to_vec())
}

fn parse_arguments(input: &[u16]) -> Vec<Vec<u16>> {
    RegExp::new(
        &r#"(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)"#
            .encode_utf16()
            .collect::<Vec<_>>(),
        "gi",
    )
    .expect("static argument pattern")
    .match_all(input, &mut Budget::unlimited())
    .expect("argument matching")
    .into_iter()
    .filter_map(|matched| matched.captures[0].clone())
    .map(|mut arg| {
        if arg.first().is_some_and(|unit| matches!(unit, 34 | 39)) {
            arg.remove(0);
        }
        if arg.last().is_some_and(|unit| matches!(unit, 34 | 39)) {
            arg.pop();
        }
        arg
    })
    .collect()
}

pub async fn evaluate_mcp(
    service: &crate::resources::mcp::Service,
    name: &LosslessString,
    input: &LosslessString,
) -> Result<Option<LosslessString>, String> {
    let sanitize = |name: &str| {
        name.encode_utf16()
            .map(|unit| {
                if unit <= 127 && ((unit as u8).is_ascii_alphanumeric() || unit == 95 || unit == 45)
                {
                    unit as u8 as char
                } else {
                    '_'
                }
            })
            .collect::<String>()
    };
    let prompts = service.prompts();
    let Some(prompt) = prompts.iter().find(|prompt| {
        prompt["server"]
            .as_str()
            .zip(prompt["name"].as_str())
            .is_some_and(|(server, prompt)| {
                name.as_str() == Some(format!("{}:{}", sanitize(server), sanitize(prompt)).as_str())
            })
    }) else {
        return Ok(None);
    };
    let server = prompt["server"]
        .as_str()
        .ok_or("MCP prompt has no server")?;
    let name = prompt["name"].as_str().ok_or("MCP prompt has no name")?;
    let arguments = parse_arguments(&input.code_units().collect::<Vec<_>>());
    let arguments = prompt["arguments"]
        .as_array()
        .map(|names| {
            names
                .iter()
                .enumerate()
                .filter_map(|(index, name)| {
                    name["name"].as_str().map(|name| {
                        (
                            name.to_owned(),
                            serde_json::Value::String(
                                arguments
                                    .get(index)
                                    .map(|argument| String::from_utf16_lossy(argument))
                                    .unwrap_or_default(),
                            ),
                        )
                    })
                })
                .collect::<serde_json::Map<_, _>>()
        })
        .unwrap_or_default();
    let response = service
        .prompt(server, name, serde_json::Value::Object(arguments), None)
        .await
        .map_err(|error| match error {
            crate::resources::mcp::client::Error::NotFound(_) => {
                format!("MCP server could not be found while evaluating prompt: {server}")
            }
            error => format!("MCP prompt could not be evaluated: {server}:{name}: {error:?}"),
        })?
        .ok_or_else(|| format!("MCP prompt could not be evaluated: {server}:{name}"))?;
    let text = response["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .map(|message| {
                    message["content"]
                        .as_str()
                        .or_else(|| {
                            (message["content"]["type"].as_str() == Some("text"))
                                .then(|| message["content"]["text"].as_str())
                                .flatten()
                        })
                        .unwrap_or("")
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    Ok(Some(text.trim().into()))
}

pub async fn evaluate(
    template: &LosslessString,
    input: &LosslessString,
    directory: &Path,
    config: &Configuration,
) -> Result<LosslessString, String> {
    let expanded = arguments(template, input);
    let units = expanded.code_units().collect::<Vec<_>>();
    let matches = RegExp::new(&"!`([^`]+)`".encode_utf16().collect::<Vec<_>>(), "g")
        .expect("static pattern")
        .match_all(&units, &mut Budget::unlimited())
        .expect("interpolation matching");
    if matches.is_empty() {
        return Ok(expanded);
    }
    let env = std::env::vars().collect();
    let shell = select::preferred(
        config.latest("shell").and_then(|value| {
            if let ycoding_schema::JsonValue::String(value) = value {
                value.as_str()
            } else {
                None
            }
        }),
        &env,
        &select::Options::default(),
    )
    .to_string_lossy()
    .into_owned();
    let mut output = Vec::new();
    let mut start = 0;
    for batch in matches.chunks(2) {
        let mut tasks = tokio::task::JoinSet::new();
        for (offset, matched) in batch.iter().enumerate() {
            let source = String::from_utf16(matched.captures[1].as_ref().expect("capture"))
                .map_err(|_| "Shell interpolation is not valid Unicode")?;
            let mut command = process::Command::new(shell.clone(), select::args(&shell, &source));
            command.cwd = Some(directory.into());
            command.stdin = process::Input::Ignore;
            tasks.spawn(async move {
                process::run(
                    command,
                    process::RunOptions {
                        combine_output: true,
                        ..Default::default()
                    },
                )
                .await
                .map(|result| {
                    (
                        offset,
                        result
                            .output
                            .unwrap_or_else(|| [result.stdout, result.stderr].concat()),
                    )
                })
                .map_err(|error| format!("Shell interpolation failed for {source:?}: {error}"))
            });
        }
        let mut outputs = vec![Vec::new(); batch.len()];
        while let Some(result) = tasks.join_next().await {
            let (index, bytes) = result.map_err(|error| error.to_string())??;
            outputs[index] = String::from_utf8_lossy(&bytes).encode_utf16().collect();
        }
        for (matched, bytes) in batch.iter().zip(outputs) {
            output.extend_from_slice(&units[start..matched.index]);
            output.extend(bytes);
            start = matched.index + matched.captures[0].as_ref().expect("whole match").len();
        }
    }
    output.extend_from_slice(&units[start..]);
    Ok(LosslessString::from_utf16(output))
}
