use super::super::DiagnosticKind;
use super::super::evaluator::Vm;
use super::super::program::Position;
use super::super::runtime::ToolDescription;
use super::super::values::{Fault, Value};
use ycoding_schema::{JsonValue, LosslessString, stringify_json};

const SEARCH_SIGNATURE: &str = "search(input: {\n  query?: string,\n  namespace?: string,\n  limit?: number,\n  offset?: number,\n}): {\n  items: Array<{\n      path: string,\n      description: string,\n      signature: string,\n    }>,\n  remaining: number,\n  next: {\n      offset: number,\n    } | null,\n}";

pub(crate) fn segments(path: &LosslessString) -> Vec<LosslessString> {
    path.code_units()
        .collect::<Vec<_>>()
        .split(|unit| *unit == u16::from(b'.'))
        .map(|part| LosslessString::from_utf16(part.to_vec()))
        .collect()
}

pub(crate) fn joined(path: &[LosslessString]) -> LosslessString {
    LosslessString::from_utf16(
        path.iter()
            .enumerate()
            .flat_map(|(index, part)| {
                std::iter::once(u16::from(b'.'))
                    .take(usize::from(index > 0))
                    .chain(part.code_units())
            })
            .collect(),
    )
}

pub(crate) fn display(path: &LosslessString) -> String {
    path.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| stringify_json(&JsonValue::String(path.clone())))
}

pub(crate) fn expression(path: &LosslessString) -> String {
    format!(
        "tools{}",
        segments(path)
            .into_iter()
            .map(|segment| {
                let identifier = segment.as_str().is_some_and(|segment| {
                    let mut chars = segment.chars();
                    chars.next().is_some_and(|first| {
                        first.is_ascii_alphabetic() || first == '_' || first == '$'
                    }) && chars.all(|character| {
                        character.is_ascii_alphanumeric() || character == '_' || character == '$'
                    })
                });
                if identifier {
                    format!(
                        ".{}",
                        segment.as_str().expect("An identifier segment is UTF-8")
                    )
                } else {
                    format!("[{}]", stringify_json(&JsonValue::String(segment)))
                }
            })
            .collect::<String>()
    )
}

pub(crate) fn catalog(tools: Vec<ToolDescription>) -> Vec<ToolDescription> {
    let mut entries: Vec<ToolDescription> = Vec::new();
    for tool in tools {
        if let Some(entry) = entries.iter_mut().find(|entry| entry.path == tool.path) {
            *entry = tool
        } else {
            entries.push(tool)
        }
    }
    fn append(
        entries: &[ToolDescription],
        prefix: &[LosslessString],
        output: &mut Vec<ToolDescription>,
    ) {
        if let Some(tool) = entries.iter().find(|tool| segments(&tool.path) == prefix) {
            output.push(tool.clone());
        }
        let mut children = Vec::new();
        for tool in entries {
            let path = segments(&tool.path);
            if path.starts_with(prefix)
                && let Some(child) = path.get(prefix.len())
                && !children.contains(child)
            {
                children.push(child.clone());
            }
        }
        for child in children {
            let mut path = prefix.to_vec();
            path.push(child);
            append(entries, &path, output);
        }
    }
    let mut output = Vec::new();
    append(&entries, &[], &mut output);
    output
}

fn tokenize(query: &str) -> Vec<Vec<String>> {
    let mut separated = String::new();
    let mut previous = None;
    for character in query.chars() {
        if character.is_ascii_uppercase()
            && previous.is_some_and(|previous: char| {
                previous.is_ascii_lowercase() || previous.is_ascii_digit()
            })
        {
            separated.push(' ');
        }
        separated.push(character);
        previous = Some(character);
    }
    separated
        .to_ascii_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(|term| {
            let mut forms = vec![term.to_owned()];
            if term.ends_with("es") && term.len() > 3 {
                forms.push(term[..term.len() - 2].into())
            }
            if term.ends_with('s') && term.len() > 2 {
                forms.push(term[..term.len() - 1].into())
            }
            forms
        })
        .collect()
}

pub(crate) fn search(vm: &Vm, args: Vec<Value>, location: &Position) -> Result<Value, Fault> {
    let invalid = |message: &str| Fault {
        kind: DiagnosticKind::InvalidToolInput,
        ..Fault::error(
            "Error",
            format!("Invalid input for tool 'search': {message}"),
            location,
        )
    };
    if args.len() != 1 {
        return Err(Fault {
            kind: DiagnosticKind::InvalidToolInput,
            ..Fault::error(
                "Error",
                "Tool 'search' expects exactly one input object.",
                location,
            )
        });
    }
    if !matches!(args[0], Value::Object(_)) {
        return Err(invalid("Expected an object"));
    }
    vm.state().json(&args[0], true)?;
    let string = |name: &str| -> Result<Option<LosslessString>, Fault> {
        match vm.get(&args[0], &name.into(), location)? {
            Value::Undefined => Ok(None),
            Value::String(value) => Ok(Some(value)),
            _ => Err(invalid("Expected a string")),
        }
    };
    let integer = |name: &str, minimum: f64, default: usize| -> Result<usize, Fault> {
        match vm.get(&args[0], &name.into(), location)? {
            Value::Undefined => Ok(default),
            Value::Number(value)
                if value.is_finite()
                    && value.fract() == 0.0
                    && value >= minimum
                    && value <= 9_007_199_254_740_991.0 =>
            {
                Ok(value as usize)
            }
            _ => Err(invalid("Expected a valid integer")),
        }
    };
    let query = string("query")?.unwrap_or_else(|| "".into());
    let namespace = string("namespace")?;
    let limit = integer("limit", 1.0, 10)?;
    let offset = integer("offset", 0.0, 0)?;
    let index = {
        let mut state = vm.state();
        if vm
            .limits
            .max_tool_calls
            .is_some_and(|limit| state.calls.len() as u64 >= limit)
        {
            return Err(Fault {
                kind: DiagnosticKind::ToolCallLimitExceeded,
                ..Fault::error(
                    "Error",
                    format!(
                        "Execution exceeded its tool-call limit of {}.",
                        vm.limits.max_tool_calls.unwrap_or_default()
                    ),
                    location,
                )
            });
        }
        state.calls.push("search".into());
        state.calls.len() - 1
    };
    let tools = catalog(vm.host.catalog())
        .into_iter()
        .filter(|tool| {
            namespace
                .as_ref()
                .is_none_or(|namespace| segments(&tool.path).first() == Some(namespace))
        })
        .collect::<Vec<_>>();
    let units = query.code_units().collect::<Vec<_>>();
    let whitespace =
        |unit: &u16| char::from_u32(*unit as u32).is_some_and(super::string::whitespace);
    let start = units.iter().take_while(|unit| whitespace(unit)).count();
    let end = units.len()
        - units
            .iter()
            .rev()
            .take_while(|unit| whitespace(unit))
            .count();
    let trimmed = LosslessString::from_utf16(units[start..end.max(start)].to_vec());
    let units = trimmed.code_units().collect::<Vec<_>>();
    let path = LosslessString::from_utf16(
        units
            .strip_prefix(&[116, 111, 111, 108, 115, 46])
            .unwrap_or(&units)
            .to_vec(),
    );
    let exact = tools
        .iter()
        .find(|tool| {
            !path.is_empty()
                && (tool.path == path || LosslessString::from(expression(&tool.path)) == trimmed)
        })
        .cloned();
    let terms = tokenize(&String::from_utf16_lossy(
        &query.code_units().collect::<Vec<_>>(),
    ));
    let ranked = if let Some(exact) = exact {
        vec![exact]
    } else {
        let mut ranked = tools
            .into_iter()
            .map(|tool| {
                let path = String::from_utf16_lossy(&tool.path.code_units().collect::<Vec<_>>())
                    .to_lowercase();
                let description = tool.description.to_lowercase();
                let search_text = format!(
                    "{}\n{}\n{}",
                    path,
                    description,
                    tool.input_properties
                        .iter()
                        .map(|(name, description)| format!(
                            "{}\n{}",
                            String::from_utf16_lossy(&name.code_units().collect::<Vec<_>>()),
                            description.as_deref().unwrap_or_default()
                        ))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
                .to_lowercase();
                let score = terms
                    .iter()
                    .map(|forms| {
                        usize::from(
                            forms
                                .iter()
                                .any(|form| path == *form || path.ends_with(&format!(".{form}"))),
                        ) * 20
                            + usize::from(forms.iter().any(|form| path.contains(form))) * 8
                            + usize::from(forms.iter().any(|form| description.contains(form))) * 4
                            + usize::from(forms.iter().any(|form| search_text.contains(form))) * 2
                    })
                    .sum::<usize>();
                (tool, score)
            })
            .filter(|(_, score)| terms.is_empty() || *score > 0)
            .collect::<Vec<_>>();
        ranked.sort_by(|(left, a), (right, b)| {
            b.cmp(a).then_with(|| {
                (vm.collator)(
                    &left.path.code_units().collect::<Vec<_>>(),
                    &right.path.code_units().collect::<Vec<_>>(),
                )
            })
        });
        ranked.into_iter().map(|(tool, _)| tool).collect()
    };
    let total = ranked.len();
    let selected = ranked
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let remaining = total.saturating_sub(offset).saturating_sub(selected.len());
    let next = if remaining > 0 {
        vm.state().object(vec![(
            "offset".into(),
            Value::Number((offset + selected.len()) as f64),
        )])
    } else {
        Value::Null
    };
    let items = selected
        .into_iter()
        .map(|tool| {
            vm.state().object(vec![
                ("path".into(), Value::String(expression(&tool.path).into())),
                ("description".into(), Value::String(tool.description.into())),
                ("signature".into(), Value::String(tool.signature.into())),
            ])
        })
        .collect();
    let items = vm.state().array(items);
    let result = vm.state().object(vec![
        ("items".into(), items),
        ("remaining".into(), Value::Number(remaining as f64)),
        ("next".into(), next),
    ]);
    let mut input = ycoding_schema::JsonObject::new();
    for key in ["query", "namespace", "limit", "offset"] {
        let value = vm.get(&args[0], &key.into(), location)?;
        if let Some(value) = vm.state().json(&value, true)? {
            input.insert(key.into(), value);
        }
    }
    let call = super::super::ToolCallStarted {
        index,
        name: "search".into(),
        input: Some(JsonValue::Object(input)),
    };
    let vm = vm.clone();
    Ok(vm.clone().spawn(Box::pin(async move {
        vm.host.on_tool_call_start(call.clone()).await;
        let started = std::time::Instant::now();
        vm.host
            .on_tool_call_end(super::super::ToolCallEnded {
                call,
                duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                outcome: super::super::ToolCallOutcome::Success,
            })
            .await;
        Ok(result)
    })))
}

fn line(tool: &ToolDescription) -> String {
    let description = tool
        .description
        .split('\n')
        .next()
        .unwrap_or_default()
        .trim_matches(super::string::whitespace);
    let units = description.encode_utf16().collect::<Vec<_>>();
    let description = if units.len() > 120 {
        format!("{}...", String::from_utf16_lossy(&units[..119]))
    } else {
        description.to_owned()
    };
    if description.is_empty() {
        format!("  - {}", tool.signature)
    } else {
        format!("  - {} // {description}", tool.signature)
    }
}
fn cost(tool: &ToolDescription) -> usize {
    (line(tool).encode_utf16().count() + 2) / 4
}

pub(crate) fn instructions(
    tools: Vec<ToolDescription>,
    budget: usize,
    collator: &super::super::runtime::Collation,
) -> String {
    let tools = catalog(tools);
    let mut groups: Vec<(LosslessString, Vec<ToolDescription>)> = Vec::new();
    for tool in &tools {
        let namespace = segments(&tool.path)
            .into_iter()
            .next()
            .expect("A canonical path has a segment");
        if let Some((_, group)) = groups.iter_mut().find(|(name, _)| name == &namespace) {
            group.push(tool.clone())
        } else {
            groups.push((namespace, vec![tool.clone()]));
        }
    }
    groups.sort_by(|(a, _), (b, _)| {
        collator(
            &a.code_units().collect::<Vec<_>>(),
            &b.code_units().collect::<Vec<_>>(),
        )
    });
    let mut queues = groups
        .iter()
        .map(|(_, group)| {
            let mut group = group.clone();
            group.sort_by(|a, b| {
                cost(a).cmp(&cost(b)).then_with(|| {
                    collator(
                        &a.path.code_units().collect::<Vec<_>>(),
                        &b.path.code_units().collect::<Vec<_>>(),
                    )
                })
            });
            std::collections::VecDeque::from(group)
        })
        .collect::<Vec<_>>();
    let mut selected = Vec::new();
    let mut used = 0;
    loop {
        let mut active = false;
        for queue in &mut queues {
            if let Some(tool) = queue.front() {
                let cost = cost(tool);
                if cost > budget.saturating_sub(used) {
                    queue.clear();
                    continue;
                }
                used += cost;
                selected.push(
                    queue
                        .pop_front()
                        .expect("An inspected catalog queue is nonempty")
                        .path,
                );
                active |= !queue.is_empty();
            }
        }
        if !active {
            break;
        }
    }
    let complete = selected.len() == tools.len();
    let empty = tools.is_empty();
    let mut lines = vec![if empty {
        "This is a restricted JavaScript language for calling tools, not a general-purpose runtime."
            .into()
    } else if complete {
        "This is a restricted JavaScript language for calling tools, not a general-purpose runtime. Inside the confined interpreter, `tools` contains the Code Mode tools listed below; surrounding agent tools are not available.".into()
    } else {
        "This is a restricted JavaScript language for calling tools, not a general-purpose runtime. Inside the confined interpreter, `tools` contains the Code Mode tools listed or searchable below; surrounding agent tools are not available.".into()
    }];
    if !empty {
        lines.extend(["Do not infer or normalize tool names; use only exact signatures shown below or returned by search.","","## Workflow",""] .map(str::to_owned));
        if complete {
            lines.extend(["1. Pick a tool from the list under `## Available tools` - each line is the exact call signature; use it as-is rather than guessing segments.","2. Call it using the exact signature shown: `const result = await tools.<namespace>.<tool>(input)`; bracket notation and quotes are part of the path.","3. Return only the fields you need from structured results; narrow unknown results before reading fields, and avoid returning large raw payloads."].map(str::to_owned))
        } else {
            lines.extend(["1. If needed, discover tools with the built-in search function: `return search({ query: \"<intent + key nouns>\" })`.","2. In the next execution, copy a returned path exactly, call it, and return only the needed fields."].map(str::to_owned))
        }
        lines.extend(["", "## Rules", ""].map(str::to_owned));
        lines.push(if complete{"- Only Code Mode tools listed here are available; surrounding agent tools are not implicitly exposed."}else{"- Only Code Mode tools listed here or returned by the built-in `search` function are available; surrounding agent tools are not implicitly exposed."}.into());
        lines.extend(["- Filter, aggregate, and transform collections in code - never return them raw or call a tool per item across messages.","- A result typed `Promise<unknown>` may be structured data or text. Before reading fields, check that it is a non-null object and not an array; otherwise handle the returned text or primitive directly.","- Run independent calls in parallel: `await Promise.all(items.map((item) => tools.<namespace>.<tool>(item)))`, or use `tools.<namespace>[\"tool-name\"](item)` when the listed signature uses bracket notation.","- Execution ends when the program returns; pending promises are interrupted, so await every call whose completion matters.","- `Object.keys(tools)` lists namespaces; `Object.keys(tools.<namespace>)` lists its tools; `for...in` works on both."].map(str::to_owned));
        if !complete {
            lines.extend(["- Browse one namespace: `search({ query: \"\", namespace: \"<name>\" })`.","- If search returns `next`, repeat the same search with `offset: next.offset`."].map(str::to_owned))
        }
    }
    lines.extend(["","## Language","","Use common JavaScript data operations, functions, control flow, selected standard-library methods, and awaited tool calls. Built-ins include Date, RegExp, Map, Set, URL, URLSearchParams, and URI encoding helpers.","Modules/imports, classes, generators, timers, fetch, eval, prototype access, and unlisted methods are unavailable. Use Code Mode tools for external operations. Use await with try/catch.","Prefer explicit `return`; otherwise only the final top-level expression becomes the result.","Dates and URLs serialize to strings at data boundaries; Map/Set/RegExp/URLSearchParams serialize to `{}`.",""].map(str::to_owned));
    if empty {
        lines.extend(
            [
                "## Available tools",
                "",
                "No tools are currently available.",
            ]
            .map(str::to_owned),
        );
        return lines.join("\n");
    }
    lines.push(if complete{"## Available tools (COMPLETE list - every tool is shown below with its full call signature)".into()}else{format!("## Available tools (PARTIAL - {} of {} shown; find the rest with search(...))",selected.len(),tools.len())});
    lines.push(String::new());
    for (namespace, group) in groups {
        let count = group.len();
        let shown = group
            .iter()
            .filter(|tool| selected.contains(&tool.path))
            .count();
        let label = format!(
            "{count} tool{}{}",
            if count == 1 { "" } else { "s" },
            if shown == count {
                String::new()
            } else if shown == 0 {
                ", none shown".into()
            } else {
                format!(", {shown} shown")
            }
        );
        lines.push(format!("- {} ({label})", display(&namespace)));
        for tool in group {
            if selected.contains(&tool.path) {
                lines.push(line(&tool))
            }
        }
    }
    if !complete {
        lines.extend([
            String::new(),
            "Search returns complete callable signatures:".into(),
            format!("- {SEARCH_SIGNATURE}"),
        ]);
    }
    lines.join("\n")
}
