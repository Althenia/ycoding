use super::super::evaluator::Vm;
use super::super::program::Position;
use super::super::values::{Fault, Heap, Value};
use ycoding_schema::LosslessString;

fn usv(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}
pub(crate) fn serialize_params(entries: &[(LosslessString, LosslessString)]) -> String {
    let mut output = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in entries {
        output.append_pair(&usv(key), &usv(value));
    }
    output.finish()
}
fn parse_params(text: &str) -> Vec<(LosslessString, LosslessString)> {
    url::form_urlencoded::parse(text.strip_prefix('?').unwrap_or(text).as_bytes())
        .map(|(key, value)| (key.into_owned().into(), value.into_owned().into()))
        .collect()
}

fn parsed(vm: &Vm, args: &[Value], location: &Position) -> Result<Option<url::Url>, Fault> {
    let input = args.first().ok_or_else(|| {
        Fault::error(
            "TypeError",
            "new URL(...) requires a URL string and an optional base URL.",
            location,
        )
    })?;
    let input = usv(&vm.state().text(input)?);
    let base = match args.get(1) {
        None | Some(Value::Undefined) => None,
        Some(value) => Some(usv(&vm.state().text(value)?)),
    };
    Ok(match base {
        Some(base) => url::Url::parse(&base)
            .ok()
            .and_then(|base| base.join(&input).ok()),
        None => url::Url::parse(&input).ok(),
    })
}

fn allocate(vm: &Vm, url: url::Url) -> Value {
    let mut state = vm.state();
    let params = state.allocate(Heap::Params {
        entries: parse_params(url.query().unwrap_or_default()),
        owner: None,
    });
    let id = state.allocate(Heap::Url { url, params });
    if let Heap::Params { owner, .. } = &mut state.heap[params] {
        *owner = Some(id);
    }
    Value::Url(id)
}

pub(crate) fn construct(vm: &Vm, args: Vec<Value>, location: &Position) -> Result<Value, Fault> {
    let url = parsed(vm, &args, location)?.ok_or_else(|| {
        Fault::error(
            "TypeError",
            "new URL(...) received an invalid URL or base URL.",
            location,
        )
    })?;
    Ok(allocate(vm, url))
}
pub(crate) fn static_method(
    vm: &Vm,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let url = parsed(vm, &args, location)?;
    match name {
        "canParse" => Ok(Value::Boolean(url.is_some())),
        "parse" => Ok(url.map_or(Value::Null, |url| allocate(vm, url))),
        _ => Err(Fault::error(
            "TypeError",
            format!("URL.{name} is not available in CodeMode."),
            location,
        )),
    }
}

pub(crate) fn construct_params(vm: &Vm, input: Value, location: &Position) -> Result<Value, Fault> {
    let entries = match input {
        Value::Undefined => Vec::new(),
        Value::Params(id) => {
            let state = vm.state();
            let Heap::Params { entries, .. } = &state.heap[id] else {
                return Err(Fault::data("Invalid URLSearchParams."));
            };
            entries.clone()
        }
        Value::String(text) => parse_params(&usv(&text)),
        Value::Null | Value::Boolean(_) | Value::Number(_) => {
            parse_params(&usv(&vm.state().text(&input)?))
        }
        Value::Array(_) | Value::Map(_) => {
            let mut entries = Vec::new();
            for item in vm.iterable(&input, location)? {
                let values = vm.iterable(&item, location)?;
                if values.len() != 2 {
                    return Err(Fault::error(
                        "TypeError",
                        "new URLSearchParams(...) expects an array of [name, value] pairs.",
                        location,
                    ));
                }
                let key = usv(&vm.state().text(&values[0])?).into();
                let value = usv(&vm.state().text(&values[1])?).into();
                entries.push((key, value));
            }
            entries
        }
        Value::Object(_) => vm
            .keys(&input, location)?
            .into_iter()
            .map(|key| {
                let value = vm.get(&input, &key, location)?;
                let value = usv(&vm.state().text(&value)?).into();
                Ok((usv(&key).into(), value))
            })
            .collect::<Result<_, Fault>>()?,
        Value::Date(_) | Value::Set(_) | Value::Url(_) | Value::RegExp(_) => Vec::new(),
        _ => {
            return Err(Fault::data(
                "new URLSearchParams(...) expects a query string, data object, array of pairs, or URLSearchParams.",
            ));
        }
    };
    Ok(Value::Params(vm.state().allocate(Heap::Params {
        entries,
        owner: None,
    })))
}

pub(crate) fn get(vm: &Vm, id: usize, name: &str, _: &Position) -> Result<Value, Fault> {
    let state = vm.state();
    let Heap::Url { url, params } = &state.heap[id] else {
        return Err(Fault::data("Invalid URL."));
    };
    let value = match name {
        "href" => url.as_str().to_owned(),
        "origin" => url.origin().ascii_serialization(),
        "protocol" => format!("{}:", url.scheme()),
        "username" => url.username().into(),
        "password" => url.password().unwrap_or_default().into(),
        "host" => format!(
            "{}{}",
            url.host_str().unwrap_or_default(),
            url.port().map_or(String::new(), |port| format!(":{port}"))
        ),
        "hostname" => url.host_str().unwrap_or_default().into(),
        "port" => url.port().map_or(String::new(), |port| port.to_string()),
        "pathname" => url.path().into(),
        "search" => url
            .query()
            .map_or(String::new(), |query| format!("?{query}")),
        "hash" => url
            .fragment()
            .filter(|value| !value.is_empty())
            .map_or(String::new(), |hash| format!("#{hash}")),
        "searchParams" => return Ok(Value::Params(*params)),
        "toString" | "toJSON" => {
            return Ok(Value::Intrinsic(Box::new(Value::Url(id)), name.into()));
        }
        _ => return Ok(Value::Undefined),
    };
    Ok(Value::String(value.into()))
}

pub(crate) fn set(
    vm: &Vm,
    id: usize,
    key: &LosslessString,
    value: Value,
    location: &Position,
) -> Result<(), Fault> {
    let value = usv(&vm.state().text(&value)?);
    let mut state = vm.state();
    let Heap::Url { url, params } = &mut state.heap[id] else {
        return Err(Fault::data("Invalid URL."));
    };
    let params = *params;
    match key.as_str().unwrap_or_default() {
        "href" => {
            *url = url::Url::parse(&value)
                .map_err(|_| Fault::error("TypeError", "Invalid URL", location))?
        }
        "protocol" => {
            let _ = url.set_scheme(value.trim_end_matches(':'));
        }
        "username" => {
            let _ = url.set_username(&value);
        }
        "password" => {
            let _ = url.set_password(Some(&value));
        }
        "hostname" => {
            let _ = url.set_host(Some(&value));
        }
        "port" => {
            if value.is_empty() {
                let _ = url.set_port(None);
            } else if let Ok(port) = value.parse() {
                let _ = url.set_port(Some(port));
            }
        }
        "host" => {
            if let Ok(parsed) = url::Url::parse(&format!("{}://{value}", url.scheme())) {
                let _ = url.set_host(parsed.host_str());
                let _ = url.set_port(parsed.port());
            }
        }
        "pathname" => url.set_path(&value),
        "search" => url.set_query(if value.is_empty() {
            None
        } else {
            Some(value.strip_prefix('?').unwrap_or(&value))
        }),
        "hash" => url.set_fragment(if value.is_empty() {
            None
        } else {
            Some(value.strip_prefix('#').unwrap_or(&value))
        }),
        _ => {
            return Err(Fault::error(
                "Error",
                format!(
                    "URL field '{}' is not writable in CodeMode.",
                    key.as_str().unwrap_or_default()
                ),
                location,
            ));
        }
    }
    let entries = parse_params(url.query().unwrap_or_default());
    if let Heap::Params {
        entries: target, ..
    } = &mut state.heap[params]
    {
        *target = entries;
    }
    Ok(())
}

pub(crate) fn method(vm: &Vm, id: usize, name: &str, location: &Position) -> Result<Value, Fault> {
    if ["toString", "toJSON"].contains(&name) {
        let state = vm.state();
        let Heap::Url { url, .. } = &state.heap[id] else {
            return Err(Fault::data("Invalid URL."));
        };
        return Ok(Value::String(url.as_str().into()));
    }
    Err(Fault::error(
        "TypeError",
        format!("URL method '{name}' is not available in CodeMode."),
        location,
    ))
}

fn update(vm: &Vm, id: usize, entries: Vec<(LosslessString, LosslessString)>) -> Result<(), Fault> {
    let query = serialize_params(&entries);
    let mut state = vm.state();
    let Heap::Params {
        entries: target,
        owner,
    } = &mut state.heap[id]
    else {
        return Err(Fault::data("Invalid URLSearchParams."));
    };
    let owner = *owner;
    *target = entries;
    if let Some(owner) = owner
        && let Heap::Url { url, .. } = &mut state.heap[owner]
    {
        url.set_query(if query.is_empty() { None } else { Some(&query) });
    }
    Ok(())
}

pub(crate) async fn params_method(
    vm: &Vm,
    id: usize,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let mut entries = {
        let state = vm.state();
        let Heap::Params { entries, .. } = &state.heap[id] else {
            return Err(Fault::data("Invalid URLSearchParams."));
        };
        entries.clone()
    };
    if name == "forEach" {
        let callback = args.first().cloned().unwrap_or(Value::Undefined);
        vm.validate_callback(&callback, "URLSearchParams.forEach", location)?;
        for (key, value) in entries {
            vm.callback(
                callback.clone(),
                vec![Value::String(value), Value::String(key), Value::Params(id)],
                "URLSearchParams.forEach",
                location,
            )
            .await?;
        }
        return Ok(Value::Undefined);
    }
    if name == "toString" {
        return Ok(Value::String(serialize_params(&entries).into()));
    }
    if ["keys", "values", "entries"].contains(&name) {
        let values = entries
            .into_iter()
            .map(|(key, value)| match name {
                "keys" => Value::String(key),
                "values" => Value::String(value),
                _ => vm
                    .state()
                    .array(vec![Value::String(key), Value::String(value)]),
            })
            .collect();
        return Ok(vm.state().array(values));
    }
    if name == "sort" {
        entries.sort_by(|(a, _), (b, _)| a.cmp(b));
        update(vm, id, entries)?;
        return Ok(Value::Undefined);
    }
    let required = if ["append", "set"].contains(&name) {
        2
    } else {
        1
    };
    if args.len() < required {
        return Err(Fault::error(
            "TypeError",
            format!("URLSearchParams.{name} requires {required} argument(s)."),
            location,
        ));
    }
    let key = LosslessString::from(usv(&vm.state().text(&args[0])?));
    let value = args
        .get(1)
        .filter(|value| !matches!(value, Value::Undefined))
        .map(|value| {
            vm.state()
                .text(value)
                .map(|value| LosslessString::from(usv(&value)))
        })
        .transpose()?;
    match name {
        "get" => {
            return Ok(entries
                .iter()
                .find(|(name, _)| name == &key)
                .map_or(Value::Null, |(_, value)| Value::String(value.clone())));
        }
        "getAll" => {
            let values = entries
                .iter()
                .filter(|(name, _)| name == &key)
                .map(|(_, value)| Value::String(value.clone()))
                .collect();
            return Ok(vm.state().array(values));
        }
        "has" => {
            return Ok(Value::Boolean(entries.iter().any(|(name, item)| {
                name == &key && value.as_ref().is_none_or(|value| item == value)
            })));
        }
        "append" => entries.push((
            key,
            vm.state()
                .text(&args[1])
                .map(|text| LosslessString::from(usv(&text)))?,
        )),
        "delete" => entries.retain(|(name, item)| {
            name != &key || value.as_ref().is_some_and(|value| item != value)
        }),
        "set" => {
            let value = LosslessString::from(usv(&vm.state().text(&args[1])?));
            if let Some(index) = entries.iter().position(|(name, _)| name == &key) {
                entries[index].1 = value;
                entries = entries
                    .into_iter()
                    .enumerate()
                    .filter(|(position, (name, _))| name != &key || *position == index)
                    .map(|(_, entry)| entry)
                    .collect();
            } else {
                entries.push((key, value));
            }
        }
        _ => {
            return Err(Fault::error(
                "TypeError",
                format!("URLSearchParams method '{name}' is not available in CodeMode."),
                location,
            ));
        }
    }
    update(vm, id, entries)?;
    Ok(Value::Undefined)
}
