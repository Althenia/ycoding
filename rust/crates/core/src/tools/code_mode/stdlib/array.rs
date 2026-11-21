use super::super::evaluator::Vm;
use super::super::program::Position;
use super::super::values::{Fault, Heap, Value, identical, truthy};
use std::collections::BTreeMap;

pub(crate) fn construct(vm: &Vm, args: Vec<Value>, location: &Position) -> Result<Value, Fault> {
    if args.len() == 1
        && let Value::Number(length) = args[0]
    {
        if !length.is_finite() || length < 0.0 || length.fract() != 0.0 || length > u32::MAX as f64
        {
            return Err(Fault::error("RangeError", "Invalid array length", location));
        }
        return Ok(Value::Array(vm.state().allocate(Heap::Array {
            length: length as u32,
            items: BTreeMap::new(),
            fields: Vec::new(),
        })));
    }
    Ok(vm.state().array(args))
}

pub(crate) async fn static_method(
    vm: &Vm,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let source = args.first().cloned().unwrap_or(Value::Undefined);
    match name {
        "isArray" => Ok(Value::Boolean(matches!(source, Value::Array(_)))),
        "of" => Ok(vm.state().array(args)),
        "from" => {
            let items = if matches!(source, Value::Object(_)) {
                let length = vm.get(&source, &"length".into(), location)?;
                let Value::Number(length) = length else {
                    return Err(Fault::error(
                        "TypeError",
                        "Array.from expects an iterable collection or array-like data object.",
                        location,
                    ));
                };
                let length = length.trunc().max(0.0);
                if length > u32::MAX as f64 {
                    return Err(Fault::error("RangeError", "Invalid array length", location));
                }
                (0..length as u32)
                    .map(|index| vm.get(&source, &index.to_string().into(), location))
                    .collect::<Result<Vec<_>, _>>()?
            } else if matches!(source, Value::Promise(_)) {
                return Err(Fault::data_at(
                    "Array.from received an un-awaited Promise; await it before creating the array.",
                    location,
                ));
            } else if !matches!(
                source,
                Value::Array(_)
                    | Value::String(_)
                    | Value::Map(_)
                    | Value::Set(_)
                    | Value::Params(_)
            ) {
                return Err(Fault::data_at(
                    "Array.from expects an array, string, Map, Set, or array-like value.",
                    location,
                ));
            } else {
                vm.iterable(&source, location)?
            };
            let mapper = args
                .get(1)
                .cloned()
                .filter(|value| !matches!(value, Value::Undefined));
            let mut values = Vec::new();
            for (index, value) in items.into_iter().enumerate() {
                vm.checkpoint(location)?;
                values.push(match &mapper {
                    Some(mapper) => {
                        vm.callback(
                            mapper.clone(),
                            vec![value, Value::Number(index as f64)],
                            "Array.from",
                            location,
                        )
                        .await?
                    }
                    None => value,
                });
            }
            Ok(vm.state().array(values))
        }
        _ => Err(Fault::error(
            "TypeError",
            format!("Array.{name} is not available in CodeMode."),
            location,
        )),
    }
}

fn snapshot(vm: &Vm, id: usize) -> Result<(u32, BTreeMap<u32, Value>), Fault> {
    let state = vm.state();
    let Heap::Array { length, items, .. } = &state.heap[id] else {
        return Err(Fault::data("Invalid array."));
    };
    Ok((*length, items.clone()))
}
fn item(vm: &Vm, id: usize, index: u32) -> Option<Value> {
    let state = vm.state();
    let Heap::Array { items, .. } = &state.heap[id] else {
        return None;
    };
    items.get(&index).cloned()
}
fn length(vm: &Vm, id: usize) -> u32 {
    let state = vm.state();
    match state.heap[id] {
        Heap::Array { length, .. } => length,
        _ => 0,
    }
}
fn numeric(vm: &Vm, args: &[Value], index: usize, default: f64) -> Result<f64, Fault> {
    match args.get(index) {
        None | Some(Value::Undefined) => Ok(default),
        Some(value) => vm.state().number(value),
    }
}
fn relative(value: f64, length: u32) -> u32 {
    let value = if value.is_nan() { 0.0 } else { value.trunc() };
    if value < 0.0 {
        (length as f64 + value).clamp(0.0, length as f64) as u32
    } else {
        value.min(length as f64) as u32
    }
}
fn sparse(vm: &Vm, length: u32, items: BTreeMap<u32, Value>) -> Value {
    Value::Array(vm.state().allocate(Heap::Array {
        length,
        items,
        fields: Vec::new(),
    }))
}

pub(crate) async fn method(
    vm: &Vm,
    id: usize,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let receiver = Value::Array(id);
    let size = length(vm, id);
    match name {
        "map" | "filter" | "flatMap" | "forEach" | "find" | "findIndex" | "findLast"
        | "findLastIndex" | "some" | "every" => {
            let callback = args.first().cloned().unwrap_or(Value::Undefined);
            let mut mapped = BTreeMap::new();
            let mut dense = Vec::new();
            let indices = if name == "findLast" || name == "findLastIndex" {
                (0..size).rev().collect::<Vec<_>>()
            } else {
                (0..size).collect()
            };
            for index in indices {
                vm.checkpoint(location)?;
                let value = item(vm, id, index);
                if value.is_none()
                    && !["find", "findIndex", "findLast", "findLastIndex"].contains(&name)
                {
                    continue;
                }
                let value = value.unwrap_or(Value::Undefined);
                let result = vm
                    .callback(
                        callback.clone(),
                        vec![value.clone(), Value::Number(index as f64), receiver.clone()],
                        &format!("Array.{name}"),
                        location,
                    )
                    .await?;
                match name {
                    "map" => {
                        mapped.insert(index, result);
                    }
                    "filter" => {
                        if truthy(&result) {
                            dense.push(value)
                        }
                    }
                    "flatMap" => {
                        if let Value::Array(child) = result {
                            let (_, items) = snapshot(vm, child)?;
                            dense.extend(items.into_values());
                        } else {
                            dense.push(result)
                        }
                    }
                    "forEach" => {}
                    "find" | "findLast" => {
                        if truthy(&result) {
                            return Ok(value);
                        }
                    }
                    "findIndex" | "findLastIndex" => {
                        if truthy(&result) {
                            return Ok(Value::Number(index as f64));
                        }
                    }
                    "some" => {
                        if truthy(&result) {
                            return Ok(Value::Boolean(true));
                        }
                    }
                    "every" if !truthy(&result) => return Ok(Value::Boolean(false)),
                    _ => {}
                }
            }
            Ok(match name {
                "map" => sparse(vm, size, mapped),
                "filter" | "flatMap" => vm.state().array(dense),
                "some" => Value::Boolean(false),
                "every" => Value::Boolean(true),
                "findIndex" | "findLastIndex" => Value::Number(-1.0),
                _ => Value::Undefined,
            })
        }
        "reduce" | "reduceRight" => {
            let callback = args.first().cloned().unwrap_or(Value::Undefined);
            let indices = if name == "reduceRight" {
                (0..size).rev().collect::<Vec<_>>()
            } else {
                (0..size).collect()
            };
            let mut accumulator = args.get(1).cloned();
            for index in indices {
                vm.checkpoint(location)?;
                let Some(value) = item(vm, id, index) else {
                    continue;
                };
                accumulator = Some(match accumulator {
                    None => value,
                    Some(accumulator) => {
                        vm.callback(
                            callback.clone(),
                            vec![
                                accumulator,
                                value,
                                Value::Number(index as f64),
                                receiver.clone(),
                            ],
                            &format!("Array.{name}"),
                            location,
                        )
                        .await?
                    }
                });
            }
            accumulator.ok_or_else(|| {
                Fault::error(
                    "TypeError",
                    "Reduce of empty array with no initial value",
                    location,
                )
            })
        }
        "includes" | "indexOf" | "lastIndexOf" => {
            let target = args.first().cloned().unwrap_or(Value::Undefined);
            let from = numeric(
                vm,
                &args,
                1,
                if name == "lastIndexOf" {
                    size as f64 - 1.0
                } else {
                    0.0
                },
            )?;
            let from = if from.is_nan() { 0.0 } else { from.trunc() };
            if name == "lastIndexOf" {
                let start = if from < 0.0 {
                    size as f64 + from
                } else {
                    from.min(size as f64 - 1.0)
                };
                if start >= 0.0 {
                    for index in (0..=(start as u32).min(size.saturating_sub(1))).rev() {
                        if let Some(value) = item(vm, id, index)
                            && identical(&value, &target, false)
                        {
                            return Ok(Value::Number(index as f64));
                        }
                    }
                }
                return Ok(Value::Number(-1.0));
            }
            let start = if from < 0.0 {
                (size as f64 + from).max(0.0)
            } else {
                from
            };
            if start < size as f64 {
                for index in start as u32..size {
                    let value = item(vm, id, index);
                    if (name == "includes" || value.is_some())
                        && identical(
                            &value.unwrap_or(Value::Undefined),
                            &target,
                            name == "includes",
                        )
                    {
                        return Ok(if name == "includes" {
                            Value::Boolean(true)
                        } else {
                            Value::Number(index as f64)
                        });
                    }
                }
            }
            Ok(if name == "includes" {
                Value::Boolean(false)
            } else {
                Value::Number(-1.0)
            })
        }
        "at" => {
            let index = numeric(vm, &args, 0, 0.0)?;
            let index = if index.is_nan() { 0.0 } else { index.trunc() };
            let index = if index < 0.0 {
                size as f64 + index
            } else {
                index
            };
            Ok(if index >= 0.0 && index < size as f64 {
                item(vm, id, index as u32).unwrap_or(Value::Undefined)
            } else {
                Value::Undefined
            })
        }
        "slice" => {
            let start = relative(numeric(vm, &args, 0, 0.0)?, size);
            let end = relative(numeric(vm, &args, 1, size as f64)?, size).max(start);
            let (_, items) = snapshot(vm, id)?;
            Ok(sparse(
                vm,
                end - start,
                items
                    .range(start..end)
                    .map(|(index, value)| (*index - start, value.clone()))
                    .collect(),
            ))
        }
        "concat" => {
            let mut values = vec![receiver];
            values.extend(args);
            let mut items = BTreeMap::new();
            let mut size = 0u32;
            for value in values {
                if let Value::Array(id) = value {
                    let (length, array) = snapshot(vm, id)?;
                    let end = size.checked_add(length).ok_or_else(|| {
                        Fault::error("RangeError", "Invalid array length", location)
                    })?;
                    items.extend(
                        array
                            .into_iter()
                            .map(|(index, value)| (index + size, value)),
                    );
                    size = end;
                } else {
                    items.insert(size, value);
                    size = size.checked_add(1).ok_or_else(|| {
                        Fault::error("RangeError", "Invalid array length", location)
                    })?;
                }
            }
            Ok(sparse(vm, size, items))
        }
        "flat" => {
            let depth = numeric(vm, &args, 0, 1.0)?.trunc().max(0.0);
            let (_, items) = snapshot(vm, id)?;
            let mut pending = items
                .into_values()
                .rev()
                .map(|value| (value, depth))
                .collect::<Vec<_>>();
            let mut output = Vec::new();
            while let Some((value, depth)) = pending.pop() {
                vm.checkpoint(location)?;
                if depth > 0.0
                    && let Value::Array(id) = value
                {
                    let (_, items) = snapshot(vm, id)?;
                    pending.extend(items.into_values().rev().map(|value| (value, depth - 1.0)));
                } else {
                    output.push(value)
                }
            }
            Ok(vm.state().array(output))
        }
        "join" => {
            let separator = match args.first() {
                None | Some(Value::Undefined) => ",".into(),
                Some(value) => vm.state().text(value)?,
            };
            let mut text = Vec::new();
            for index in 0..size {
                if index > 0 {
                    text.extend(separator.code_units());
                }
                let value = item(vm, id, index).unwrap_or(Value::Undefined);
                if !matches!(value, Value::Undefined | Value::Null) {
                    text.extend(vm.state().text(&value)?.code_units());
                }
            }
            Ok(Value::String(ycoding_schema::LosslessString::from_utf16(
                text,
            )))
        }
        "keys" | "values" | "entries" => {
            let values = (0..size)
                .map(|index| match name {
                    "keys" => Value::Number(index as f64),
                    "values" => item(vm, id, index).unwrap_or(Value::Undefined),
                    _ => {
                        let value = item(vm, id, index).unwrap_or(Value::Undefined);
                        vm.state().array(vec![Value::Number(index as f64), value])
                    }
                })
                .collect();
            Ok(vm.state().array(values))
        }
        "reverse" | "toReversed" => {
            let (_, items) = snapshot(vm, id)?;
            if name == "toReversed" {
                return Ok(vm.state().array(
                    (0..size)
                        .rev()
                        .map(|index| items.get(&index).cloned().unwrap_or(Value::Undefined))
                        .collect(),
                ));
            }
            let mut state = vm.state();
            let Heap::Array { items: target, .. } = &mut state.heap[id] else {
                return Err(Fault::data("Invalid array."));
            };
            *target = items
                .into_iter()
                .map(|(index, value)| (size - 1 - index, value))
                .collect();
            Ok(Value::Array(id))
        }
        "with" => {
            let index = numeric(vm, &args, 0, 0.0)?;
            let index = if index.is_nan() { 0.0 } else { index.trunc() };
            let index = if index < 0.0 {
                size as f64 + index
            } else {
                index
            };
            if index < 0.0 || index >= size as f64 {
                return Err(Fault::error("RangeError", "Invalid index", location));
            }
            let mut items = vm.iterable(&receiver, location)?;
            items[index as usize] = args.get(1).cloned().unwrap_or(Value::Undefined);
            Ok(vm.state().array(items))
        }
        "push" | "unshift" => {
            let count = u32::try_from(args.len())
                .map_err(|_| Fault::error("RangeError", "Invalid array length", location))?;
            let end = size
                .checked_add(count)
                .ok_or_else(|| Fault::error("RangeError", "Invalid array length", location))?;
            for value in &args {
                vm.reject_cycle(id, value, location)?;
            }
            let mut state = vm.state();
            let Heap::Array { length, items, .. } = &mut state.heap[id] else {
                return Err(Fault::data("Invalid array."));
            };
            if name == "unshift" {
                *items = std::mem::take(items)
                    .into_iter()
                    .map(|(index, value)| (index + count, value))
                    .collect();
            }
            let start = if name == "push" { size } else { 0 };
            items.extend(
                args.into_iter()
                    .enumerate()
                    .map(|(index, value)| (start + index as u32, value)),
            );
            *length = end;
            Ok(Value::Number(end as f64))
        }
        "pop" | "shift" => {
            if size == 0 {
                return Ok(Value::Undefined);
            }
            let mut state = vm.state();
            let Heap::Array { length, items, .. } = &mut state.heap[id] else {
                return Err(Fault::data("Invalid array."));
            };
            let value = items
                .remove(&if name == "pop" { size - 1 } else { 0 })
                .unwrap_or(Value::Undefined);
            if name == "shift" {
                *items = std::mem::take(items)
                    .into_iter()
                    .map(|(index, value)| (index - 1, value))
                    .collect();
            }
            *length -= 1;
            Ok(value)
        }
        "fill" => {
            let value = args.first().cloned().unwrap_or(Value::Undefined);
            let start = relative(numeric(vm, &args, 1, 0.0)?, size);
            let end = relative(numeric(vm, &args, 2, size as f64)?, size);
            vm.reject_cycle(id, &value, location)?;
            let mut state = vm.state();
            let Heap::Array { items, .. } = &mut state.heap[id] else {
                return Err(Fault::data("Invalid array."));
            };
            for index in start..end {
                items.insert(index, value.clone());
            }
            Ok(receiver)
        }
        "copyWithin" => {
            let target = relative(numeric(vm, &args, 0, 0.0)?, size);
            let start = relative(numeric(vm, &args, 1, 0.0)?, size);
            let end = relative(numeric(vm, &args, 2, size as f64)?, size);
            let count = end.saturating_sub(start).min(size - target);
            let (_, source) = snapshot(vm, id)?;
            let mut state = vm.state();
            let Heap::Array { items, .. } = &mut state.heap[id] else {
                return Err(Fault::data("Invalid array."));
            };
            for offset in 0..count {
                match source.get(&(start + offset)) {
                    Some(value) => {
                        items.insert(target + offset, value.clone());
                    }
                    None => {
                        items.remove(&(target + offset));
                    }
                }
            }
            Ok(receiver)
        }
        "splice" | "toSpliced" => {
            let start = relative(numeric(vm, &args, 0, 0.0)?, size);
            let remove = if args.is_empty() {
                0
            } else if args.len() == 1 {
                size - start
            } else {
                numeric(vm, &args, 1, 0.0)?
                    .trunc()
                    .clamp(0.0, (size - start) as f64) as u32
            };
            let insert = args.into_iter().skip(2).collect::<Vec<_>>();
            let new_size = (size - remove)
                .checked_add(insert.len() as u32)
                .ok_or_else(|| Fault::error("RangeError", "Invalid array length", location))?;
            if name == "splice" {
                for value in &insert {
                    vm.reject_cycle(id, value, location)?;
                }
            }
            let (_, source) = snapshot(vm, id)?;
            let removed = source
                .range(start..start + remove)
                .map(|(index, value)| (*index - start, value.clone()))
                .collect();
            let mut items = BTreeMap::new();
            for index in 0..new_size {
                let value = if index < start {
                    source.get(&index).cloned()
                } else if index < start + insert.len() as u32 {
                    Some(insert[(index - start) as usize].clone())
                } else {
                    source.get(&(index - insert.len() as u32 + remove)).cloned()
                };
                if let Some(value) = value {
                    items.insert(index, value);
                } else if name == "toSpliced" {
                    items.insert(index, Value::Undefined);
                }
            }
            if name == "toSpliced" {
                return Ok(sparse(vm, new_size, items));
            }
            let mut state = vm.state();
            let Heap::Array {
                length,
                items: target,
                ..
            } = &mut state.heap[id]
            else {
                return Err(Fault::data("Invalid array."));
            };
            *length = new_size;
            *target = items;
            drop(state);
            Ok(sparse(vm, remove, removed))
        }
        "sort" | "toSorted" => {
            let (_, items) = snapshot(vm, id)?;
            let mut values = items.into_values().collect::<Vec<_>>();
            let count = values.len();
            let comparator = args
                .first()
                .cloned()
                .filter(|value| !matches!(value, Value::Undefined));
            let callback_name = format!("Array.{name}");
            if let Some(comparator) = &comparator {
                vm.validate_callback(comparator, &callback_name, location)?;
            }
            let mut width = 1;
            while width < count {
                let mut output = Vec::with_capacity(count);
                let mut start = 0;
                while start < count {
                    let middle = (start + width).min(count);
                    let end = (middle + width).min(count);
                    let mut left = start;
                    let mut right = middle;
                    while left < middle && right < end {
                        vm.checkpoint(location)?;
                        let a = &values[left];
                        let b = &values[right];
                        let ordered = if matches!(b, Value::Undefined) {
                            true
                        } else if matches!(a, Value::Undefined) {
                            false
                        } else if let Some(comparator) = &comparator {
                            let value = vm
                                .callback(
                                    comparator.clone(),
                                    vec![a.clone(), b.clone()],
                                    &callback_name,
                                    location,
                                )
                                .await?;
                            let number = vm.state().number(&value)?;
                            number.is_nan() || number <= 0.0
                        } else {
                            let state = vm.state();
                            state.text(a)? <= state.text(b)?
                        };
                        if ordered {
                            output.push(values[left].clone());
                            left += 1;
                        } else {
                            output.push(values[right].clone());
                            right += 1;
                        }
                    }
                    output.extend_from_slice(&values[left..middle]);
                    output.extend_from_slice(&values[right..end]);
                    start = end;
                }
                values = output;
                width *= 2;
            }
            if name == "toSorted" {
                values.resize(size as usize, Value::Undefined);
                return Ok(vm.state().array(values));
            }
            let mut state = vm.state();
            let Heap::Array { length, items, .. } = &mut state.heap[id] else {
                return Err(Fault::data("Invalid array."));
            };
            items.retain(|index, _| *index < count as u32 || *index >= size);
            *length = (*length).max(count as u32);
            items.extend(
                values
                    .into_iter()
                    .enumerate()
                    .map(|(index, value)| (index as u32, value)),
            );
            Ok(receiver)
        }
        _ => Err(Fault::error(
            "TypeError",
            format!("Array method '{name}' is not available in CodeMode."),
            location,
        )),
    }
}
