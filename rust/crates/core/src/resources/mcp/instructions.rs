use crate::{
    resources::discovery::{join, whitespace},
    tools::policy,
};
use std::cmp::Ordering;
use ycoding_schema::{DomainEncode, LosslessString, permission, stringify_json};

pub const KEY: &str = "core/mcp-guidance";
pub const MAX_SERVER_BYTES: usize = 2048;
pub const REMOVED: &str = "MCP server instructions are no longer available.";

#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    pub server: LosslessString,
    pub instructions: LosslessString,
}

pub fn summaries_by(
    servers: &[Summary],
    tools: &[(LosslessString, LosslessString)],
    permissions: Option<&[permission::Rule]>,
    compare: impl FnMut(&LosslessString, &LosslessString) -> Ordering,
) -> Vec<Summary> {
    summaries_with_capabilities_by(servers, tools, permissions, &Default::default(), compare)
}
pub fn summaries_with_capabilities_by(
    servers: &[Summary],
    tools: &[(LosslessString, LosslessString)],
    permissions: Option<&[permission::Rule]>,
    capabilities: &crate::resources::config::capabilities::ConfigCapabilities,
    mut compare: impl FnMut(&LosslessString, &LosslessString) -> Ordering,
) -> Vec<Summary> {
    let Some(permissions) = permissions else {
        return Vec::new();
    };
    if !capabilities.allows_tool(&"execute".into())
        || policy::evaluate(&"execute".into(), &"*".into(), permissions)
            .effect
            .0
            .as_str()
            == Some("deny")
    {
        return Vec::new();
    }
    let mut selected = servers
        .iter()
        .filter(|server| {
            tools.iter().any(|tool| {
                tool.0 == server.server
                    && capabilities.allows_tool(&super::tool_name(&tool.0, &tool.1))
                    && policy::evaluate(
                        &super::tool_name(&tool.0, &tool.1),
                        &"*".into(),
                        permissions,
                    )
                    .effect
                    .0
                    .as_str()
                        != Some("deny")
            })
        })
        .map(|server| Summary {
            server: server.server.clone(),
            instructions: normalize(&server.instructions),
        })
        .collect::<Vec<_>>();
    selected.sort_by(|a, b| compare(&a.server, &b.server));
    selected
}

pub fn normalize(value: &LosslessString) -> LosslessString {
    let mut units = Vec::new();
    let mut pending_cr = false;
    for unit in value.code_units() {
        if pending_cr && unit == 10 {
            pending_cr = false;
            continue;
        }
        pending_cr = unit == 13;
        if unit == 10 || unit == 13 {
            while units.last().is_some_and(|unit| matches!(unit, 32 | 9)) {
                units.pop();
            }
            units.push(10);
            continue;
        }
        units.push(unit);
    }
    trim_end(&mut units);
    let normalized = LosslessString::from_utf16(units);
    let characters = char::decode_utf16(normalized.code_units()).collect::<Vec<_>>();
    if characters
        .iter()
        .map(|character| {
            character
                .as_ref()
                .copied()
                .unwrap_or(char::REPLACEMENT_CHARACTER)
                .len_utf8()
        })
        .sum::<usize>()
        <= MAX_SERVER_BYTES
    {
        return normalized;
    }
    let marker = format!("\n[truncated to {MAX_SERVER_BYTES} UTF-8 bytes]");
    let mut prefix = Vec::new();
    let mut bytes = 0;
    for character in characters {
        let size = character
            .as_ref()
            .copied()
            .unwrap_or(char::REPLACEMENT_CHARACTER)
            .len_utf8();
        if bytes + size > MAX_SERVER_BYTES - marker.len() {
            break;
        }
        bytes += size;
        match character {
            Ok(character) => {
                let mut buffer = [0; 2];
                prefix.extend_from_slice(character.encode_utf16(&mut buffer));
            }
            Err(error) => prefix.push(error.unpaired_surrogate()),
        }
    }
    trim_end(&mut prefix);
    prefix.extend(marker.encode_utf16());
    LosslessString::from_utf16(prefix)
}

fn trim_end(units: &mut Vec<u16>) {
    while units
        .last()
        .is_some_and(|unit| char::from_u32(*unit as u32).is_some_and(whitespace))
    {
        units.pop();
    }
}

pub fn render(servers: &[Summary]) -> LosslessString {
    let mut parts = vec!["<mcp_instructions>".into()];
    parts.extend(entries(servers));
    parts.push("</mcp_instructions>".into());
    join(&parts, "\n")
}

pub fn changed(previous: &[Summary], current: &[Summary]) -> LosslessString {
    let added = current
        .iter()
        .filter(|entry| !previous.iter().any(|before| before.server == entry.server))
        .cloned()
        .collect::<Vec<_>>();
    let removed = previous
        .iter()
        .filter(|entry| !current.iter().any(|after| after.server == entry.server))
        .map(|entry| entry.server.clone())
        .collect::<Vec<_>>();
    if current.iter().any(|entry| {
        previous
            .iter()
            .find(|before| before.server == entry.server)
            .is_some_and(|before| before.instructions != entry.instructions)
    }) || (added.is_empty() && removed.is_empty())
    {
        return join(&["The available MCP server instructions have changed. This list supersedes the previous one.".into(),render(current)],"\n");
    }
    let mut parts = Vec::new();
    if !added.is_empty() {
        parts.push(
            "New MCP server instructions are available in addition to those previously listed:"
                .into(),
        );
        parts.extend(entries(&added));
    }
    if !removed.is_empty() {
        parts.push(join(
            &[
                "Instructions for the following MCP servers are no longer available: ".into(),
                join(&removed, ", "),
                ".".into(),
            ],
            "",
        ));
    }
    join(&parts, "\n")
}

fn entries(servers: &[Summary]) -> Vec<LosslessString> {
    servers
        .iter()
        .flat_map(|server| {
            let mut parts = vec![
                join(
                    &[
                        "  <server name=\"".into(),
                        server.server.clone(),
                        "\">".into(),
                    ],
                    "",
                ),
                format!(
                    "    Use tools from this server through `execute` under `tools[{}]`.",
                    stringify_json(&super::namespace(&server.server).encode())
                )
                .into(),
            ];
            let mut line = Vec::new();
            for unit in server.instructions.code_units() {
                if unit == 10 {
                    parts.push(join(
                        &[
                            "    ".into(),
                            LosslessString::from_utf16(std::mem::take(&mut line)),
                        ],
                        "",
                    ));
                    continue;
                }
                line.push(unit);
            }
            parts.push(join(&["    ".into(), LosslessString::from_utf16(line)], ""));
            parts.push("  </server>".into());
            parts
        })
        .collect()
}
