use super::super::evaluator::Vm;
use super::super::program::Position;
use super::super::values::{Fault, Heap, Value, identical, truthy, type_of};

fn normalize(value: Value) -> Value {
    match value {
        Value::Number(value) if value == 0.0 && value.is_sign_negative() => Value::Number(0.0),
        value => value,
    }
}

pub(crate) fn construct(
    vm: &Vm,
    name: &str,
    input: Value,
    location: &Position,
) -> Result<Value, Fault> {
    if name == "Map" {
        let id = vm.state().allocate(Heap::Map(Vec::new()));
        if matches!(input, Value::Undefined | Value::Null) {
            return Ok(Value::Map(id));
        }
        if !matches!(input, Value::Array(_) | Value::Map(_)) {
            return Err(Fault::error(
                "Error",
                "new Map(...) expects an array of [key, value] pairs, a Map, or no argument.",
                location,
            ));
        }
        for pair in vm.iterable(&input, location)? {
            if !matches!(pair, Value::Array(_)) {
                return Err(Fault::error(
                    "Error",
                    "new Map(...) expects [key, value] pairs.",
                    location,
                ));
            }
            let key = vm.get(&pair, &"0".into(), location)?;
            let value = vm.get(&pair, &"1".into(), location)?;
            map_put(vm, id, key, value)?;
        }
        return Ok(Value::Map(id));
    }
    let id = vm.state().allocate(Heap::Set {
        items: Vec::new(),
        next: 0,
    });
    if matches!(input, Value::Undefined | Value::Null) {
        return Ok(Value::Set(id));
    }
    if !matches!(input, Value::Array(_) | Value::Set(_) | Value::String(_)) {
        return Err(Fault::error(
            "Error",
            "new Set(...) expects an array, Set, string, or no argument.",
            location,
        ));
    }
    for value in vm.iterable(&input, location)? {
        set_add(vm, id, value)?;
    }
    Ok(Value::Set(id))
}

fn map_put(vm: &Vm, id: usize, key: Value, value: Value) -> Result<(), Fault> {
    let mut state = vm.state();
    let Heap::Map(entries) = &mut state.heap[id] else {
        return Err(Fault::data("Invalid Map."));
    };
    let key = normalize(key);
    if let Some((_, item)) = entries
        .iter_mut()
        .find(|(existing, _)| identical(existing, &key, true))
    {
        *item = value;
    } else {
        entries.push((key, value));
    }
    Ok(())
}
fn set_add(vm: &Vm, id: usize, value: Value) -> Result<(), Fault> {
    let mut state = vm.state();
    let Heap::Set { items, next } = &mut state.heap[id] else {
        return Err(Fault::data("Invalid Set."));
    };
    let value = normalize(value);
    if !items
        .iter()
        .any(|(_, existing)| identical(existing, &value, true))
    {
        let sequence = *next;
        *next = next
            .checked_add(1)
            .ok_or_else(|| Fault::data("Set insertion sequence exhausted."))?;
        items.push((sequence, value));
    }
    Ok(())
}
fn set_values(vm: &Vm, id: usize) -> Result<Vec<Value>, Fault> {
    let state = vm.state();
    let Heap::Set { items, .. } = &state.heap[id] else {
        return Err(Fault::data("Invalid Set."));
    };
    Ok(items.iter().map(|(_, value)| value.clone()).collect())
}
fn set_has(vm: &Vm, id: usize, value: &Value) -> Result<bool, Fault> {
    let state = vm.state();
    let Heap::Set { items, .. } = &state.heap[id] else {
        return Err(Fault::data("Invalid Set."));
    };
    Ok(items.iter().any(|(_, item)| identical(item, value, true)))
}
fn set_delete(vm: &Vm, id: usize, value: &Value) -> Result<bool, Fault> {
    let mut state = vm.state();
    let Heap::Set { items, .. } = &mut state.heap[id] else {
        return Err(Fault::data("Invalid Set."));
    };
    let previous = items.len();
    items.retain(|(_, item)| !identical(item, value, true));
    Ok(previous != items.len())
}
fn next_value(vm: &Vm, id: usize, next: usize) -> Option<(usize, Value)> {
    let state = vm.state();
    let Heap::Set { items, .. } = &state.heap[id] else {
        return None;
    };
    items
        .iter()
        .find(|(sequence, _)| *sequence >= next)
        .cloned()
}

pub(crate) async fn map(
    vm: &Vm,
    id: usize,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let key = args.first().cloned().unwrap_or(Value::Undefined);
    if name == "set" {
        map_put(
            vm,
            id,
            key,
            args.get(1).cloned().unwrap_or(Value::Undefined),
        )?;
        return Ok(Value::Map(id));
    }
    if name == "delete" || name == "clear" {
        let mut state = vm.state();
        let Heap::Map(entries) = &mut state.heap[id] else {
            return Err(Fault::data("Invalid Map."));
        };
        if name == "clear" {
            entries.clear();
            return Ok(Value::Undefined);
        }
        let size = entries.len();
        entries.retain(|(item, _)| !identical(item, &key, true));
        return Ok(Value::Boolean(size != entries.len()));
    }
    let entries = {
        let state = vm.state();
        let Heap::Map(entries) = &state.heap[id] else {
            return Err(Fault::data("Invalid Map."));
        };
        entries.clone()
    };
    match name {
        "get" => Ok(entries
            .iter()
            .find(|(item, _)| identical(item, &key, true))
            .map_or(Value::Undefined, |(_, value)| value.clone())),
        "has" => Ok(Value::Boolean(
            entries.iter().any(|(item, _)| identical(item, &key, true)),
        )),
        "keys" | "values" | "entries" => {
            let values = entries
                .into_iter()
                .map(|(key, value)| match name {
                    "keys" => key,
                    "values" => value,
                    _ => vm.state().array(vec![key, value]),
                })
                .collect();
            Ok(vm.state().array(values))
        }
        "forEach" => {
            let callback = args.first().cloned().unwrap_or(Value::Undefined);
            for (key, value) in entries {
                vm.callback(
                    callback.clone(),
                    vec![value, key, Value::Map(id)],
                    "Map.forEach",
                    location,
                )
                .await?;
            }
            Ok(Value::Undefined)
        }
        _ => Err(Fault::error(
            "TypeError",
            format!("Map method '{name}' is not available in CodeMode."),
            location,
        )),
    }
}

enum Record {
    Native(Value),
    Object { size: f64, has: Value, keys: Value },
}

impl Record {
    fn size(&self, vm: &Vm) -> Result<f64, Fault> {
        match self {
            Self::Object { size, .. } => Ok(*size),
            Self::Native(Value::Map(id)) => {
                let state = vm.state();
                let Heap::Map(entries) = &state.heap[*id] else {
                    return Err(Fault::data("Invalid Map."));
                };
                Ok(entries.len() as f64)
            }
            Self::Native(Value::Set(id)) => Ok(set_values(vm, *id)?.len() as f64),
            _ => Err(Fault::data("Invalid Set-like record.")),
        }
    }
    async fn has(&self, vm: &Vm, value: Value, location: &Position) -> Result<bool, Fault> {
        match self {
            Self::Native(Value::Set(id)) => set_has(vm, *id, &value),
            Self::Native(Value::Map(id)) => {
                let state = vm.state();
                let Heap::Map(entries) = &state.heap[*id] else {
                    return Err(Fault::data("Invalid Map."));
                };
                Ok(entries.iter().any(|(key, _)| identical(key, &value, true)))
            }
            Self::Object { has, .. } => Ok(truthy(
                &vm.call(has.clone(), vec![value], false, location).await?,
            )),
            _ => Err(Fault::data("Invalid Set-like record.")),
        }
    }
    async fn keys(&self, vm: &Vm, location: &Position) -> Result<Vec<Value>, Fault> {
        match self {
            Self::Native(Value::Set(id)) => set_values(vm, *id),
            Self::Native(Value::Map(id)) => {
                let state = vm.state();
                let Heap::Map(entries) = &state.heap[*id] else {
                    return Err(Fault::data("Invalid Map."));
                };
                Ok(entries.iter().map(|(key, _)| key.clone()).collect())
            }
            Self::Object { keys, .. } => {
                let value = vm.call(keys.clone(), Vec::new(), false, location).await?;
                if !matches!(value, Value::Array(_)) {
                    return Err(Fault::error(
                        "TypeError",
                        "Set operation expected 'keys' to return an iterator.",
                        location,
                    ));
                }
                vm.iterable(&value, location)
            }
            _ => Err(Fault::data("Invalid Set-like record.")),
        }
    }
}

async fn record(vm: &Vm, value: Value, name: &str, location: &Position) -> Result<Record, Fault> {
    if matches!(value, Value::Map(_) | Value::Set(_)) {
        return Ok(Record::Native(value));
    }
    if !matches!(value, Value::Object(_)) {
        return Err(Fault::error(
            "TypeError",
            format!("Set.{name} expects a Set-like object."),
            location,
        ));
    }
    let size = vm.get(&value, &"size".into(), location)?;
    let size = vm.numeric_argument(size, location).await?;
    if size.is_nan() {
        return Err(Fault::error(
            "TypeError",
            format!("Set.{name} received a Set-like object with an invalid size."),
            location,
        ));
    }
    let has = vm.get(&value, &"has".into(), location)?;
    let keys = vm.get(&value, &"keys".into(), location)?;
    if !supported(&has) || !supported(&keys) {
        return Err(Fault::error(
            "TypeError",
            format!("Set.{name} expects callable 'has' and 'keys' methods."),
            location,
        ));
    }
    Ok(Record::Object {
        size: size.trunc().max(0.0),
        has,
        keys,
    })
}

fn supported(value: &Value) -> bool {
    type_of(value) == "function"
        && !matches!(value, Value::Tool(_))
        && !matches!(value,Value::Intrinsic(receiver,_)if matches!(receiver.as_ref(),Value::Namespace(name)if name=="Promise"))
}

pub(crate) async fn set(
    vm: &Vm,
    id: usize,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let value = args.first().cloned().unwrap_or(Value::Undefined);
    match name {
        "has" => return Ok(Value::Boolean(set_has(vm, id, &value)?)),
        "add" => {
            set_add(vm, id, value)?;
            return Ok(Value::Set(id));
        }
        "delete" => return Ok(Value::Boolean(set_delete(vm, id, &value)?)),
        "clear" => {
            if let Heap::Set { items, .. } = &mut vm.state().heap[id] {
                items.clear();
            }
            return Ok(Value::Undefined);
        }
        "keys" | "values" | "entries" => {
            let values = set_values(vm, id)?
                .into_iter()
                .map(|value| {
                    if name == "entries" {
                        vm.state().array(vec![value.clone(), value])
                    } else {
                        value
                    }
                })
                .collect();
            return Ok(vm.state().array(values));
        }
        "forEach" => {
            for value in set_values(vm, id)? {
                vm.callback(
                    args.first().cloned().unwrap_or(Value::Undefined),
                    vec![value.clone(), value, Value::Set(id)],
                    "Set.forEach",
                    location,
                )
                .await?;
            }
            return Ok(Value::Undefined);
        }
        "union"
        | "intersection"
        | "difference"
        | "symmetricDifference"
        | "isSubsetOf"
        | "isSupersetOf"
        | "isDisjointFrom" => {}
        _ => {
            return Err(Fault::error(
                "TypeError",
                format!("Set method '{name}' is not available in CodeMode."),
                location,
            ));
        }
    }
    let other = record(vm, value, name, location).await?;
    let other_size = other.size(vm)?;
    let values = set_values(vm, id)?;
    let size = values.len() as f64;
    if name == "isSubsetOf" && size > other_size || name == "isSupersetOf" && size < other_size {
        return Ok(Value::Boolean(false));
    }
    if name == "isSubsetOf" || name == "isDisjointFrom" && size <= other_size {
        let mut next = 0;
        while let Some((sequence, value)) = next_value(vm, id, next) {
            vm.checkpoint(location)?;
            next = sequence + 1;
            let has = other.has(vm, value, location).await?;
            if name == "isSubsetOf" && !has || name == "isDisjointFrom" && has {
                return Ok(Value::Boolean(false));
            }
        }
        return Ok(Value::Boolean(true));
    }
    if name == "isSupersetOf" || name == "isDisjointFrom" {
        for value in other.keys(vm, location).await? {
            let has = set_has(vm, id, &value)?;
            if name == "isSupersetOf" && !has || name == "isDisjointFrom" && has {
                return Ok(Value::Boolean(false));
            }
        }
        return Ok(Value::Boolean(true));
    }
    let result_id = vm.state().allocate(Heap::Set {
        items: Vec::new(),
        next: 0,
    });
    if name == "union" || name == "difference" || name == "symmetricDifference" {
        for value in values.clone() {
            set_add(vm, result_id, value)?;
        }
    }
    if name == "union" {
        for value in other.keys(vm, location).await? {
            set_add(vm, result_id, value)?;
        }
        return Ok(Value::Set(result_id));
    }
    if name == "symmetricDifference" {
        for value in other.keys(vm, location).await? {
            if set_has(vm, id, &value)? {
                set_delete(vm, result_id, &value)?;
            } else {
                set_add(vm, result_id, value)?;
            }
        }
        return Ok(Value::Set(result_id));
    }
    if size <= other_size {
        if name == "intersection" {
            let mut next = 0;
            while let Some((sequence, value)) = next_value(vm, id, next) {
                next = sequence + 1;
                if other.has(vm, value.clone(), location).await? {
                    set_add(vm, result_id, value)?;
                }
            }
        } else {
            for value in values {
                if other.has(vm, value.clone(), location).await? {
                    set_delete(vm, result_id, &value)?;
                }
            }
        }
    } else {
        for value in other.keys(vm, location).await? {
            if name == "intersection" {
                if set_has(vm, id, &value)? {
                    set_add(vm, result_id, value)?;
                }
            } else {
                set_delete(vm, result_id, &value)?;
            }
        }
    }
    Ok(Value::Set(result_id))
}

pub(crate) async fn group_by(
    vm: &Vm,
    args: Vec<Value>,
    object: bool,
    location: &Position,
) -> Result<Value, Fault> {
    let source = args.first().cloned().unwrap_or(Value::Undefined);
    let values = vm.iterable(&source, location)?;
    let callback = args.get(1).cloned().unwrap_or(Value::Undefined);
    if type_of(&callback) != "function" {
        return Err(Fault::error(
            "TypeError",
            if object {
                "Object.groupBy expects a function callback."
            } else {
                "Map.groupBy expects a function callback."
            },
            location,
        ));
    }
    let result = if object {
        vm.state().object(Vec::new())
    } else {
        Value::Map(vm.state().allocate(Heap::Map(Vec::new())))
    };
    for (index, value) in values.into_iter().enumerate() {
        vm.checkpoint(location)?;
        let key = vm
            .callback(
                callback.clone(),
                vec![value.clone(), Value::Number(index as f64)],
                if object {
                    "Object.groupBy"
                } else {
                    "Map.groupBy"
                },
                location,
            )
            .await?;
        if object {
            let key = group_key(vm, key, location).await?;
            vm.require_key(&key, location)?;
            let group = vm.get(&result, &key, location)?;
            if let Value::Array(id) = group {
                super::array::method(vm, id, "push", vec![value], location).await?;
            } else {
                let group = vm.state().array(vec![value]);
                vm.set(&result, key, group, location)?;
            }
        } else {
            let Value::Map(id) = result else {
                unreachable!()
            };
            let group = map(vm, id, "get", vec![key.clone()], location).await?;
            if let Value::Array(group) = group {
                super::array::method(vm, group, "push", vec![value], location).await?;
            } else {
                let group = vm.state().array(vec![value]);
                map_put(vm, id, key, group)?;
            }
        }
    }
    Ok(result)
}

async fn group_key(
    vm: &Vm,
    value: Value,
    location: &Position,
) -> Result<ycoding_schema::LosslessString, Fault> {
    if !matches!(value, Value::Object(_)) {
        return vm.state().text(&value);
    }
    let string = vm.get(&value, &"toString".into(), location)?;
    if matches!(string, Value::Undefined) {
        return vm.state().text(&value);
    }
    if type_of(&string) == "function" {
        let value = vm.call(string, Vec::new(), false, location).await?;
        if matches!(
            value,
            Value::Undefined
                | Value::Null
                | Value::Boolean(_)
                | Value::Number(_)
                | Value::String(_)
        ) {
            return vm.state().text(&value);
        }
    }
    let number = vm.get(&value, &"valueOf".into(), location)?;
    if type_of(&number) == "function" {
        let value = vm.call(number, Vec::new(), false, location).await?;
        if matches!(
            value,
            Value::Undefined
                | Value::Null
                | Value::Boolean(_)
                | Value::Number(_)
                | Value::String(_)
        ) {
            return vm.state().text(&value);
        }
    }
    Err(Fault::error(
        "TypeError",
        "Cannot convert object to primitive value.",
        location,
    ))
}
