use super::evaluator::Vm;
use super::program::{Position, blocked};
use super::values::{Fault, Heap, Value, put, type_of};
use crate::regexp::{Budget, Error, Match, RegExp, StringMatch};
use ycoding_schema::{JsonValue, LosslessString, stringify_json};

pub trait RegExpEngine: Send + Sync {
    fn compile(
        &self,
        pattern: &LosslessString,
        flags: &str,
        budget: &mut Budget<'_>,
    ) -> Result<RegExp, Error>;
}

pub struct NativeRegExpEngine;

impl RegExpEngine for NativeRegExpEngine {
    fn compile(
        &self,
        pattern: &LosslessString,
        flags: &str,
        budget: &mut Budget<'_>,
    ) -> Result<RegExp, Error> {
        RegExp::new_with_budget(&pattern.code_units().collect::<Vec<_>>(), flags, budget)
    }
}

fn operation<T>(
    vm: &Vm,
    location: &Position,
    run: impl FnOnce(&mut Budget<'_>) -> Result<T, Error>,
) -> Result<T, Fault> {
    vm.checkpoint(location)?;
    let cancelled = || vm.checkpoint(location).is_err();
    let mut budget = Budget {
        remaining: None,
        cancelled: Some(&cancelled),
    };
    run(&mut budget).map_err(|error| match error {
        Error::Cancelled => vm.checkpoint(location).err().unwrap_or_else(|| Fault {
            fatal: true,
            ..Fault::error("Error", error.to_string(), location)
        }),
        Error::StepLimit | Error::UnsupportedStringProperty(_) => Fault {
            fatal: true,
            ..Fault::error("Error", error.to_string(), location)
        },
        Error::Syntax(message) => Fault::error("SyntaxError", message, location),
        Error::RequiresGlobal => Fault::error("Error", "RegExp requires the global flag", location),
    })
}

pub(crate) fn compile(
    vm: &Vm,
    pattern: &LosslessString,
    flags: &str,
    location: &Position,
) -> Result<RegExp, Fault> {
    operation(vm, location, |budget| vm.regexp.compile(pattern, flags, budget)).map_err(|mut error| {
        if error.name == "SyntaxError" {
            error.message = if error.message.contains("flags") {
                format!("new RegExp(...) received invalid flags {flags:?} ({}). Valid flags are d, g, i, m, s, u, v, y; u and v are exclusive.", error.message)
            } else {
                format!("new RegExp(...) received {}, which is not a valid regular expression pattern ({}). To match special characters like ( ) [ ] {{ }} + * ? . literally, escape them with a backslash or test for them with String.includes instead.", stringify_json(&JsonValue::String(pattern.clone())), error.message)
            };
        }
        error
    })
}

fn load(
    vm: &Vm,
    value: &Value,
    flags: &str,
    method: &str,
    location: &Position,
) -> Result<(RegExp, Option<usize>), Fault> {
    if let Value::RegExp(id) = value {
        let state = vm.state();
        let Heap::RegExp {
            pattern,
            last_index,
        } = &state.heap[*id]
        else {
            return Err(Fault::data("Invalid RegExp."));
        };
        let mut pattern = pattern.clone();
        let reads_cursor = match method {
            "exec" | "test" => pattern.global() || pattern.sticky(),
            "matchAll" => pattern.global(),
            "match" | "replace" | "replaceAll" => pattern.sticky() && !pattern.global(),
            _ => false,
        };
        pattern.last_index = if reads_cursor {
            state
                .number(last_index)?
                .floor()
                .clamp(0.0, 9_007_199_254_740_991.0) as u64
        } else {
            0
        };
        return Ok((pattern, Some(*id)));
    }
    let pattern = match value {
        Value::Undefined => LosslessString::from(""),
        Value::String(value) => value.clone(),
        _ => {
            return Err(Fault::error(
                "Error",
                format!(
                    "String.{method} expects a regular expression or a string pattern, not {}.",
                    type_of(value)
                ),
                location,
            ));
        }
    };
    let pattern = compile(vm, &pattern, flags, location).map_err(|mut error| {
        if error.name == "SyntaxError" {
            error.message = error.message.replacen(
                "new RegExp(...) received",
                &format!("String.{method} received the string"),
                1,
            );
        }
        error
    })?;
    Ok((pattern, None))
}

fn store_cursor(vm: &Vm, id: Option<usize>, pattern: &RegExp) {
    if (pattern.global() || pattern.sticky())
        && let Some(id) = id
        && let Heap::RegExp { last_index, .. } = &mut vm.state().heap[id]
    {
        *last_index = Value::Number(pattern.last_index as f64);
    }
}

fn range_value(vm: &Vm, range: Option<(usize, usize)>) -> Value {
    range.map_or(Value::Undefined, |(start, end)| {
        vm.state()
            .array(vec![Value::Number(start as f64), Value::Number(end as f64)])
    })
}

fn groups_value(vm: &Vm, groups: crate::regexp::NamedGroups<Vec<u16>>) -> Value {
    let fields = groups
        .into_iter()
        .map(|(key, value)| {
            (
                LosslessString::from_utf16(key),
                value.map_or(Value::Undefined, |value| {
                    Value::String(LosslessString::from_utf16(value))
                }),
            )
        })
        .filter(|(key, _)| !blocked(key))
        .collect();
    vm.state().object(fields)
}

fn match_value(vm: &Vm, matched: Match) -> Value {
    let captures = matched
        .captures
        .into_iter()
        .map(|value| {
            value.map_or(Value::Undefined, |value| {
                Value::String(LosslessString::from_utf16(value))
            })
        })
        .collect();
    let value = vm.state().array(captures);
    let Value::Array(id) = value else {
        unreachable!()
    };
    let mut fields = vec![("index".into(), Value::Number(matched.index as f64))];
    if let Some(groups) = matched.groups {
        fields.push(("groups".into(), groups_value(vm, groups)));
    }
    if let Some(indices) = matched.indices {
        let values = indices
            .into_iter()
            .map(|range| range_value(vm, range))
            .collect();
        let indices = vm.state().array(values);
        let groups = matched.index_groups.map_or(Value::Undefined, |groups| {
            let fields = groups
                .into_iter()
                .map(|(key, range)| (LosslessString::from_utf16(key), range_value(vm, range)))
                .filter(|(key, _)| !blocked(key))
                .collect();
            vm.state().object(fields)
        });
        if let Value::Array(id) = indices
            && let Heap::Array { fields, .. } = &mut vm.state().heap[id]
        {
            put(fields, "groups".into(), groups);
        }
        fields.push(("indices".into(), indices));
    }
    if let Heap::Array { fields: target, .. } = &mut vm.state().heap[id] {
        *target = fields;
    }
    Value::Array(id)
}

pub(crate) fn method(
    vm: &Vm,
    id: usize,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    if name == "toString" {
        return Ok(Value::String(vm.state().text(&Value::RegExp(id))?));
    }
    let input = vm.state().text(args.first().unwrap_or(&Value::Undefined))?;
    let (mut pattern, _) = load(vm, &Value::RegExp(id), "", name, location)?;
    let input = input.code_units().collect::<Vec<_>>();
    let matched = operation(vm, location, |budget| pattern.exec(&input, budget));
    store_cursor(vm, Some(id), &pattern);
    let matched = matched?;
    Ok(if name == "test" {
        Value::Boolean(matched.is_some())
    } else {
        matched.map_or(Value::Null, |matched| match_value(vm, matched))
    })
}

pub(crate) fn string(
    vm: &Vm,
    input: LosslessString,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let (mut pattern, id) = load(
        vm,
        args.first().unwrap_or(&Value::Undefined),
        if name == "matchAll" { "g" } else { "" },
        name,
        location,
    )?;
    let input = input.code_units().collect::<Vec<_>>();
    if name == "search" {
        return Ok(Value::Number(
            operation(vm, location, |budget| pattern.search(&input, budget))?
                .map_or(-1.0, |index| index as f64),
        ));
    }
    if name == "matchAll" {
        if !pattern.global() {
            return Err(global_error(&pattern, name, location));
        }
        let matches = operation(vm, location, |budget| pattern.match_all(&input, budget))?;
        let values = matches
            .into_iter()
            .map(|matched| match_value(vm, matched))
            .collect();
        return Ok(vm.state().array(values));
    }
    let matched = operation(vm, location, |budget| pattern.string_match(&input, budget));
    store_cursor(vm, id, &pattern);
    Ok(match matched? {
        None => Value::Null,
        Some(StringMatch::Single(matched)) => match_value(vm, matched),
        Some(StringMatch::Global(matches)) => vm.state().array(
            matches
                .into_iter()
                .map(|value| Value::String(LosslessString::from_utf16(value)))
                .collect(),
        ),
    })
}

fn global_error(pattern: &RegExp, method: &str, location: &Position) -> Fault {
    let source = String::from_utf16_lossy(pattern.source());
    let alternative = if method == "matchAll" {
        "match for a single match"
    } else {
        "replace to replace only the first match"
    };
    Fault::error(
        "Error",
        format!(
            "String.{method} requires a regular expression with the global (g) flag: write /{source}/g, or use String.{alternative}."
        ),
        location,
    )
}

pub(crate) fn split(
    vm: &Vm,
    input: LosslessString,
    source: Value,
    limit: u32,
    location: &Position,
) -> Result<Value, Fault> {
    let (pattern, _) = load(vm, &source, "", "split", location)?;
    let input = input.code_units().collect::<Vec<_>>();
    let values = operation(vm, location, |budget| pattern.split(&input, limit, budget))?
        .into_iter()
        .map(|value| {
            value.map_or(Value::Undefined, |value| {
                Value::String(LosslessString::from_utf16(value))
            })
        })
        .collect();
    Ok(vm.state().array(values))
}

pub(crate) async fn replace(
    vm: &Vm,
    input: LosslessString,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let units = input.code_units().collect::<Vec<_>>();
    let matches = if let Some(Value::RegExp(id)) = args.first() {
        let (mut pattern, _) = load(vm, &Value::RegExp(*id), "", name, location)?;
        if name == "replaceAll" && !pattern.global() {
            return Err(global_error(&pattern, name, location));
        }
        let matches = operation(vm, location, |budget| {
            pattern.replacement_matches(&units, name == "replaceAll", budget)
        });
        store_cursor(vm, Some(*id), &pattern);
        matches?
    } else {
        let needle = vm
            .state()
            .text(args.first().unwrap_or(&Value::Undefined))?
            .code_units()
            .collect::<Vec<_>>();
        let mut matches = Vec::new();
        let mut at = 0;
        while at <= units.len() {
            vm.checkpoint(location)?;
            let found = if needle.is_empty() {
                Some(at)
            } else {
                units[at..]
                    .windows(needle.len())
                    .position(|window| window == needle)
                    .map(|offset| at + offset)
            };
            let Some(index) = found else {
                break;
            };
            matches.push(Match {
                captures: vec![Some(needle.clone())],
                index,
                groups: None,
                indices: None,
                index_groups: None,
            });
            if name == "replace" {
                break;
            }
            at = index + needle.len().max(1);
        }
        matches
    };
    let replacement = args.get(1).cloned().unwrap_or(Value::Undefined);
    if type_of(&replacement) != "function" {
        let template = vm
            .state()
            .text(&replacement)?
            .code_units()
            .collect::<Vec<_>>();
        return operation(vm, location, |budget| {
            crate::regexp::replace_matches(
                &units,
                &matches,
                |matched| crate::regexp::substitution(&units, matched, &template),
                budget,
            )
        })
        .map(|output| Value::String(LosslessString::from_utf16(output)));
    }
    let mut replacements = Vec::new();
    for matched in &matches {
        let mut arguments = matched
            .captures
            .iter()
            .map(|value| {
                value.as_ref().map_or(Value::Undefined, |value| {
                    Value::String(LosslessString::from_utf16(value.clone()))
                })
            })
            .collect::<Vec<_>>();
        arguments.push(Value::Number(matched.index as f64));
        arguments.push(Value::String(input.clone()));
        if let Some(groups) = &matched.groups {
            arguments.push(groups_value(vm, groups.clone()));
        }
        let value = vm
            .callback(
                replacement.clone(),
                arguments,
                &format!("String.{name}"),
                location,
            )
            .await?;
        replacements.push(vm.state().text(&value)?.code_units().collect::<Vec<_>>());
    }
    let mut replacements = replacements.into_iter();
    operation(vm, location, |budget| {
        crate::regexp::replace_matches(
            &units,
            &matches,
            |_| {
                replacements
                    .next()
                    .expect("Every replacement match was evaluated")
            },
            budget,
        )
    })
    .map(|output| Value::String(LosslessString::from_utf16(output)))
}

pub(crate) fn escape(args: Vec<Value>, location: &Position) -> Result<Value, Fault> {
    let Some(Value::String(text)) = args.first() else {
        return Err(Fault::error(
            "TypeError",
            "RegExp.escape expects a string.",
            location,
        ));
    };
    Ok(Value::String(LosslessString::from_utf16(
        crate::regexp::escape(&text.code_units().collect::<Vec<_>>()),
    )))
}
