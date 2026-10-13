mod array;
mod collections;
pub(crate) mod date;
pub(crate) mod discovery;
mod number;
pub(crate) mod string;
pub(crate) mod url;

use super::DiagnosticKind;
use super::evaluator::Vm;
use super::program::Position;
use super::values::{Fault, Heap, Value, concat, identical, truthy, type_of};
use ycoding_schema::{LosslessString, parse_json, stringify_json};

pub(crate) fn array_method(name: &str) -> bool {
    [
        "map",
        "filter",
        "flatMap",
        "forEach",
        "find",
        "findIndex",
        "findLast",
        "findLastIndex",
        "some",
        "every",
        "includes",
        "indexOf",
        "lastIndexOf",
        "reduce",
        "reduceRight",
        "sort",
        "toSorted",
        "reverse",
        "toReversed",
        "at",
        "slice",
        "concat",
        "flat",
        "with",
        "join",
        "push",
        "pop",
        "shift",
        "unshift",
        "splice",
        "fill",
        "copyWithin",
        "keys",
        "values",
        "entries",
        "toSpliced",
    ]
    .contains(&name)
}
pub(crate) fn string_method(name: &str) -> bool {
    [
        "toLowerCase",
        "toUpperCase",
        "normalize",
        "trim",
        "trimStart",
        "trimEnd",
        "includes",
        "startsWith",
        "endsWith",
        "indexOf",
        "lastIndexOf",
        "slice",
        "substring",
        "at",
        "charAt",
        "charCodeAt",
        "codePointAt",
        "split",
        "concat",
        "repeat",
        "padStart",
        "padEnd",
        "replace",
        "replaceAll",
        "match",
        "matchAll",
        "search",
        "localeCompare",
        "toString",
    ]
    .contains(&name)
}

pub(crate) fn static_member(namespace: &str, name: &str) -> Result<Value, Fault> {
    let value = match (namespace, name) {
        ("Math", "PI") => Some(std::f64::consts::PI),
        ("Math", "E") => Some(std::f64::consts::E),
        ("Math", "LN2") => Some(std::f64::consts::LN_2),
        ("Math", "LN10") => Some(std::f64::consts::LN_10),
        ("Math", "LOG2E") => Some(std::f64::consts::LOG2_E),
        ("Math", "LOG10E") => Some(std::f64::consts::LOG10_E),
        ("Math", "SQRT2") => Some(std::f64::consts::SQRT_2),
        ("Math", "SQRT1_2") => Some(std::f64::consts::FRAC_1_SQRT_2),
        ("Number", "MAX_SAFE_INTEGER") => Some(9_007_199_254_740_991.0),
        ("Number", "MIN_SAFE_INTEGER") => Some(-9_007_199_254_740_991.0),
        ("Number", "MAX_VALUE") => Some(f64::MAX),
        ("Number", "MIN_VALUE") => Some(f64::from_bits(1)),
        ("Number", "EPSILON") => Some(f64::EPSILON),
        ("Number", "NaN") => Some(f64::NAN),
        ("Number", "POSITIVE_INFINITY") => Some(f64::INFINITY),
        ("Number", "NEGATIVE_INFINITY") => Some(f64::NEG_INFINITY),
        _ => None,
    };
    if let Some(value) = value {
        return Ok(Value::Number(value));
    }
    let known = match namespace {
        "Math" => number::math_method(name),
        "Number" => [
            "isInteger",
            "isFinite",
            "isNaN",
            "isSafeInteger",
            "parseInt",
            "parseFloat",
        ]
        .contains(&name),
        "Object" => [
            "keys",
            "values",
            "entries",
            "hasOwn",
            "is",
            "assign",
            "fromEntries",
            "groupBy",
        ]
        .contains(&name),
        "Array" => ["isArray", "of", "from"].contains(&name),
        "String" => ["fromCharCode", "fromCodePoint"].contains(&name),
        "JSON" => ["parse", "stringify"].contains(&name),
        "console" => ["log", "info", "debug", "warn", "error", "dir", "table"].contains(&name),
        "Date" => ["now", "parse", "UTC"].contains(&name),
        "RegExp" => name == "escape",
        "Map" => name == "groupBy",
        "URL" => ["parse", "canParse"].contains(&name),
        "Promise" => ["all", "allSettled", "race", "any", "resolve", "reject"].contains(&name),
        _ => false,
    };
    if known {
        return Ok(Value::Intrinsic(
            Box::new(Value::Namespace(namespace.into())),
            name.into(),
        ));
    }
    if namespace == "Promise" {
        return Err(Fault::data(format!(
            "Promise.{name} is not available in CodeMode. Available: Promise.all, Promise.allSettled, Promise.race, Promise.any, Promise.resolve, and Promise.reject; consume promises with await."
        )));
    }
    Ok(Value::Undefined)
}

pub(crate) async fn namespace(
    vm: &Vm,
    name: &str,
    args: Vec<Value>,
    construct: bool,
    location: &Position,
) -> Result<Value, Fault> {
    let first = args.first().cloned().unwrap_or(Value::Undefined);
    if construct
        && matches!(
            name,
            "Number"
                | "String"
                | "Boolean"
                | "isFinite"
                | "isNaN"
                | "parseInt"
                | "parseFloat"
                | "encodeURI"
                | "encodeURIComponent"
                | "decodeURI"
                | "decodeURIComponent"
                | "search"
        )
    {
        return Err(Fault {
            kind: DiagnosticKind::UnsupportedSyntax,
            ..Fault::error(
                "SyntaxError",
                "Syntax 'NewExpression' is not supported in CodeMode.",
                location,
            )
        });
    }
    match name {
        "Number" => Ok(Value::Number(if args.is_empty() {
            0.0
        } else {
            vm.state().number(&first)?
        })),
        "String" => Ok(Value::String(if args.is_empty() {
            "".into()
        } else {
            vm.state().text(&first)?
        })),
        "Boolean" => Ok(Value::Boolean(truthy(&first))),
        "isFinite" => Ok(Value::Boolean(vm.state().number(&first)?.is_finite())),
        "isNaN" => Ok(Value::Boolean(vm.state().number(&first)?.is_nan())),
        "parseInt" | "parseFloat" => number::parse(vm, name, &args, location),
        "Object" => match first {
            Value::Null | Value::Undefined => Ok(vm.state().object(Vec::new())),
            value
                if matches!(
                    value,
                    Value::Array(_)
                        | Value::Object(_)
                        | Value::Date(_)
                        | Value::Map(_)
                        | Value::Set(_)
                        | Value::Url(_)
                        | Value::Params(_)
                        | Value::RegExp(_)
                        | Value::Promise(_)
                        | Value::Function(_)
                        | Value::Tool(_)
                        | Value::Intrinsic(_, _)
                        | Value::Resolver(_, _)
                        | Value::Namespace(_)
                ) =>
            {
                Ok(value)
            }
            _ => Err(Fault::error(
                "TypeError",
                "Object() primitive wrapper objects are not supported in CodeMode.",
                location,
            )),
        },
        "Array" => array::construct(vm, args, location),
        "Error" | "TypeError" | "RangeError" | "SyntaxError" | "ReferenceError" | "EvalError"
        | "URIError" => {
            let text = if matches!(first, Value::Undefined) {
                "".into()
            } else {
                vm.state().text(&first)?
            };
            Ok(vm.state().error(
                name,
                &String::from_utf16_lossy(&text.code_units().collect::<Vec<_>>()),
                None,
            ))
        }
        "AggregateError" => {
            let errors = vm.iterable(&first, location)?;
            let message = match args.get(1) {
                Some(value) if !matches!(value, Value::Undefined) => vm.state().text(value)?,
                _ => "".into(),
            };
            Ok(vm.state().error(
                name,
                &String::from_utf16_lossy(&message.code_units().collect::<Vec<_>>()),
                Some(errors),
            ))
        }
        "Date" => date::construct(vm, args, construct, location).await,
        "RegExp" => {
            let (pattern, flags) = match &first {
                Value::RegExp(id) => {
                    let state = vm.state();
                    let Heap::RegExp { pattern, .. } = &state.heap[*id] else {
                        return Err(Fault::data("Invalid RegExp."));
                    };
                    (
                        LosslessString::from_utf16(pattern.source().to_vec()),
                        pattern.flags().to_owned(),
                    )
                }
                Value::Undefined => ("".into(), String::new()),
                _ => (vm.state().text(&first)?, String::new()),
            };
            let flags = match args.get(1) {
                None | Some(Value::Undefined) => flags,
                Some(Value::String(value)) => value
                    .to_utf8()
                    .map_err(|_| Fault::error("SyntaxError", "Invalid RegExp flags.", location))?,
                _ => {
                    return Err(Fault::error(
                        "SyntaxError",
                        "RegExp flags must be a string of flag characters.",
                        location,
                    ));
                }
            };
            let pattern = super::regexp::compile(vm, &pattern, &flags, location)?;
            Ok(Value::RegExp(vm.state().allocate(Heap::RegExp {
                pattern,
                last_index: Value::Number(0.0),
            })))
        }
        "Map" | "Set" | "URL" | "URLSearchParams" | "Promise" if !construct => Err(Fault::error(
            "TypeError",
            format!("Constructor {name} requires 'new'."),
            location,
        )),
        "Map" | "Set" => collections::construct(vm, name, first, location),
        "URL" => url::construct(vm, args, location),
        "URLSearchParams" => url::construct_params(vm, first, location),
        "Promise" => {
            if !matches!(first, Value::Function(_)) {
                return Err(Fault::error(
                    "TypeError",
                    "new Promise(...) expects an executor function.",
                    location,
                ));
            }
            let id = {
                let mut state = vm.state();
                let id = state.promises.len();
                state.promises.push(super::values::Promise::default());
                id
            };
            if let Err(fault) = vm
                .call(
                    first,
                    vec![Value::Resolver(id, false), Value::Resolver(id, true)],
                    false,
                    location,
                )
                .await
            {
                if fault.fatal {
                    return Err(fault);
                }
                vm.resolve(id, Err(fault));
            }
            Ok(Value::Promise(id))
        }
        "search" => discovery::search(vm, args, location),
        "encodeURI" | "encodeURIComponent" | "decodeURI" | "decodeURIComponent" => {
            string::uri(vm, name, first, location)
        }
        _ => Err(Fault::error(
            "TypeError",
            format!("{name} is not a callable constructor."),
            location,
        )),
    }
}

pub(crate) async fn method(
    vm: &Vm,
    receiver: Value,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    match receiver {
        Value::Array(id) => array::method(vm, id, name, args, location).await,
        Value::String(value) => string::method(vm, value, name, args, location).await,
        Value::Number(value) => number::method(vm, value, name, args, location),
        Value::Map(id) => collections::map(vm, id, name, args, location).await,
        Value::Set(id) => collections::set(vm, id, name, args, location).await,
        Value::Date(id) => date::method(vm, id, name, args, location).await,
        Value::Url(id) => url::method(vm, id, name, location),
        Value::Params(id) => url::params_method(vm, id, name, args, location).await,
        Value::RegExp(id) => super::regexp::method(vm, id, name, args, location),
        Value::Promise(id) => promise_reaction(vm, id, name, args, location),
        Value::Namespace(namespace) => match namespace.as_str() {
            "Math" => number::math(vm, name, args, location),
            "Number" => number::static_method(vm, name, args, location),
            "String" => string::static_method(vm, name, args, location),
            "Array" => array::static_method(vm, name, args, location).await,
            "Object" => object(vm, name, args, location).await,
            "Map" if name == "groupBy" => collections::group_by(vm, args, false, location).await,
            "Date" => date::static_method(vm, name, args, location),
            "URL" => url::static_method(vm, name, args, location),
            "Promise" => promise_static(vm, name, args, location),
            "console" => console(vm, name, args, location),
            "RegExp" => super::regexp::escape(args, location),
            "JSON" => match name {
                "parse" => {
                    if args.get(1).is_some_and(callable) {
                        return Err(Fault::error(
                            "TypeError",
                            "JSON.parse revivers are not supported in CodeMode.",
                            location,
                        ));
                    }
                    let Some(Value::String(text)) = args.first() else {
                        return Err(Fault::error(
                            "Error",
                            "JSON.parse expects a string.",
                            location,
                        ));
                    };
                    let text = text.to_utf8().map_err(|_| {
                        Fault::error("SyntaxError", "Invalid JSON input.", location)
                    })?;
                    let value = parse_json(&text).map_err(|error| {
                        Fault::error("SyntaxError", error.to_string(), location)
                    })?;
                    let value = vm.state().decode_json(value);
                    vm.state().json(&value, false)?;
                    Ok(value)
                }
                "stringify" => {
                    if args.get(1).is_some_and(callable) {
                        return Err(Fault::error(
                            "TypeError",
                            "JSON.stringify replacers are not supported in CodeMode.",
                            location,
                        ));
                    }
                    let value = vm
                        .state()
                        .json(args.first().unwrap_or(&Value::Undefined), true)?;
                    match value {
                        None => Ok(Value::Undefined),
                        Some(value) => {
                            let spacing = match args.get(2) {
                                Some(Value::Number(value)) => {
                                    " ".repeat(value.trunc().clamp(0.0, 10.0) as usize)
                                }
                                Some(Value::String(value)) => String::from_utf16_lossy(
                                    &value.code_units().take(10).collect::<Vec<_>>(),
                                ),
                                _ => String::new(),
                            };
                            Ok(Value::String(
                                if spacing.is_empty() {
                                    stringify_json(&value)
                                } else {
                                    pretty_json(&value, &spacing, 0)
                                }
                                .into(),
                            ))
                        }
                    }
                }
                _ => Err(Fault::error("TypeError", "Unknown JSON method.", location)),
            },
            _ => Err(Fault::error(
                "TypeError",
                format!("{namespace}.{name} is not available in CodeMode."),
                location,
            )),
        },
        _ => Err(Fault::error(
            "TypeError",
            "Unsupported method receiver.",
            location,
        )),
    }
}

async fn object(
    vm: &Vm,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let first = args.first().cloned().unwrap_or(Value::Undefined);
    if name == "groupBy" {
        return collections::group_by(vm, args, true, location).await;
    }
    if name == "is" {
        let right = args.get(1).unwrap_or(&Value::Undefined);
        vm.state().json(&first, false)?;
        vm.state().json(right, false)?;
        return Ok(Value::Boolean(match (&first, right) {
            (Value::Number(a), Value::Number(b)) => {
                (a.is_nan() && b.is_nan())
                    || (a == b && (a != &0.0 || a.is_sign_negative() == b.is_sign_negative()))
            }
            _ => identical(&first, right, false),
        }));
    }
    if name == "assign" {
        if !matches!(first, Value::Object(_)) {
            return Err(Fault::error(
                "TypeError",
                "Object.assign expects a data object target.",
                location,
            ));
        }
        for source in args.iter().skip(1) {
            if matches!(
                source,
                Value::Null
                    | Value::Undefined
                    | Value::Date(_)
                    | Value::Map(_)
                    | Value::Set(_)
                    | Value::Url(_)
                    | Value::Params(_)
                    | Value::RegExp(_)
            ) {
                continue;
            }
            if !matches!(source, Value::Object(_)) {
                return Err(Fault::error(
                    "TypeError",
                    "Object.assign expects data objects.",
                    location,
                ));
            }
            for key in vm.keys(source, location)? {
                let value = vm.get(source, &key, location)?;
                vm.set(&first, key, value, location)?;
            }
        }
        return Ok(first);
    }
    if name == "fromEntries" {
        let items = vm.iterable(&first, location)?;
        let result = vm.state().object(Vec::new());
        for item in items {
            if !matches!(item, Value::Array(_) | Value::Object(_)) {
                return Err(Fault::error(
                    "TypeError",
                    "Object.fromEntries expects [key, value] entry objects.",
                    location,
                ));
            }
            let key = vm.get(&item, &"0".into(), location)?;
            let value = vm.get(&item, &"1".into(), location)?;
            vm.state().json(&key, false)?;
            vm.state().json(&value, false)?;
            let key = vm.state().text(&key)?;
            vm.set(&result, key, value, location)?;
        }
        return Ok(result);
    }
    if matches!(first, Value::Tool(_)) && matches!(name, "values" | "entries") {
        return Err(Fault::data(format!(
            "Object.{name}(...) cannot read tool references: they are not plain data. Use Object.keys(tools) for names, or search({{ query }}) for signatures."
        )));
    }
    let keys = match &first {
        Value::Object(_) | Value::Array(_) | Value::Tool(_) => vm.keys(&first, location)?,
        Value::Date(_)
        | Value::Map(_)
        | Value::Set(_)
        | Value::Url(_)
        | Value::Params(_)
        | Value::RegExp(_) => Vec::new(),
        Value::Promise(_) => {
            return Err(Fault::data_at(
                format!(
                    "Object.{name} received an un-awaited Promise; await it before inspecting the result."
                ),
                location,
            ));
        }
        _ => {
            return Err(Fault::data_at(
                format!("Object.{name} expects a data object or array."),
                location,
            ));
        }
    };
    if name == "hasOwn" {
        let key = vm.state().text(args.get(1).unwrap_or(&Value::Undefined))?;
        return Ok(Value::Boolean(keys.contains(&key)));
    }
    let values = keys
        .into_iter()
        .map(|key| match name {
            "keys" => Ok(Value::String(key)),
            "values" => vm.get(&first, &key, location),
            "entries" => {
                let value = vm.get(&first, &key, location)?;
                Ok(vm.state().array(vec![Value::String(key), value]))
            }
            _ => Err(Fault::error(
                "TypeError",
                "Unknown Object method.",
                location,
            )),
        })
        .collect::<Result<_, _>>()?;
    Ok(vm.state().array(values))
}

fn promise_static(
    vm: &Vm,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let first = args.first().cloned().unwrap_or(Value::Undefined);
    if name == "resolve" {
        return Ok(if matches!(first, Value::Promise(_)) {
            first
        } else {
            vm.spawn(Box::pin(async move { Ok(first) }))
        });
    }
    if name == "reject" {
        let fault = vm.thrown(first, location);
        return Ok(vm.spawn(Box::pin(async move { Err(fault) })));
    }
    let items = match vm.iterable(&first, location) {
        Ok(items) => items,
        Err(_) => {
            let fault = Fault::error(
                "TypeError",
                format!("Promise.{name} expects an array of promises or plain values."),
                location,
            );
            return Ok(vm.spawn(Box::pin(async move { Err(fault) })));
        }
    };
    for value in &items {
        vm.observe(value)
    }
    let admitted = vm.state().settlement;
    let vm = vm.clone();
    let name = name.to_owned();
    let location = location.clone();
    let handle = vm.clone();
    Ok(handle.spawn(Box::pin(async move {
        let result=std::future::poll_fn(|cx|{
            if vm.work_cancel.is_cancelled(){return std::task::Poll::Ready(Err(vm.interrupted(&location)))}
            let mut state=vm.state();let mut outcomes=Vec::new();
            for(index,item)in items.iter().enumerate(){match item {Value::Promise(id)=>{let promise=&mut state.promises[*id];if promise.result.is_none()&&!promise.waiters.iter().any(|waker|waker.will_wake(cx.waker())){promise.waiters.push(cx.waker().clone());}outcomes.push((promise.result.clone(),promise.settled_order.map(|order|order+1).unwrap_or(usize::MAX).max(admitted),index));},value=>outcomes.push((Some(Ok(value.clone())),admitted,index))}}
            match name.as_str(){
                "all"=>{if let Some((Some(Err(fault)),_,_))=outcomes.iter().filter(|(outcome,_,_)|matches!(outcome,Some(Err(_)))).min_by_key(|(_,order,index)|(*order,*index)){return std::task::Poll::Ready(Err(fault.clone()))}
                    if outcomes.iter().all(|(outcome,_,_)|outcome.is_some()){let values=outcomes.into_iter().filter_map(|(value,_,_)|value).collect::<Result<Vec<_>,_>>();return std::task::Poll::Ready(values.map(|values|state.array(values)))}},
                "allSettled"=>{if outcomes.iter().all(|(outcome,_,_)|outcome.is_some()){let values=outcomes.into_iter().filter_map(|(value,_,_)|value).map(|result|match result {Ok(value)=>state.object(vec![("status".into(),Value::String("fulfilled".into())),("value".into(),value)]),Err(fault)=>{let reason=state.caught(&fault);state.object(vec![("status".into(),Value::String("rejected".into())),("reason".into(),reason)])}}).collect();return std::task::Poll::Ready(Ok(state.array(values)))}},
                "race"=>{if items.is_empty(){return std::task::Poll::Ready(Err(Fault::error("Error","Promise.race([]) would never settle; provide at least one promise or value.",&location)))}
                    if let Some((Some(result),_,_))=outcomes.iter().filter(|(outcome,_,_)|outcome.is_some()).min_by_key(|(_,order,index)|(*order,*index)){return std::task::Poll::Ready(result.clone())}},
                "any"=>{if let Some((Some(Ok(value)),_,_))=outcomes.iter().filter(|(outcome,_,_)|matches!(outcome,Some(Ok(_)))).min_by_key(|(_,order,index)|(*order,*index)){return std::task::Poll::Ready(Ok(value.clone()))}
                    if outcomes.iter().all(|(outcome,_,_)|outcome.is_some()){let reasons=outcomes.iter().filter_map(|(outcome,_,_)|match outcome {Some(Err(fault))=>Some(state.caught(fault)),_=>None}).collect();let value=state.error("AggregateError","All promises were rejected",Some(reasons));drop(state);return std::task::Poll::Ready(Err(vm.thrown(value,&location))) }},
                _=>return std::task::Poll::Ready(Err(Fault::error("TypeError","Unknown Promise static.",&location))),
            }
            std::task::Poll::Pending
        }).await;
        if result.as_ref().err().is_some_and(|fault|fault.fatal){return result}
        super::promises::turn().await;
        if vm.work_cancel.is_cancelled() {
            return Err(vm.interrupted(&location));
        }
        result
    })))
}

fn promise_reaction(
    vm: &Vm,
    id: usize,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let method = format!("Promise.prototype.{name}");
    let handler = |value: Option<&Value>| -> Result<Option<Value>, Fault> {
        let Some(value) = value else { return Ok(None) };
        if matches!(value, Value::Tool(_))
            || matches!(value,Value::Intrinsic(receiver,_)if matches!(receiver.as_ref(),Value::Namespace(name)if name=="Promise"))
        {
            return Err(Fault::error(
                "TypeError",
                format!(
                    "{method} cannot use this callable as a handler; wrap it in an arrow function."
                ),
                location,
            ));
        }
        Ok(if type_of(value) == "function" {
            Some(value.clone())
        } else {
            None
        })
    };
    let first = handler(args.first())?;
    let second = handler(args.get(1))?;
    vm.observe(&Value::Promise(id));
    let vm = vm.clone();
    let name = name.to_owned();
    let location = location.clone();
    let handle = vm.clone();
    Ok(handle.spawn(Box::pin(async move {
        let result = vm.await_value(Value::Promise(id)).await;
        if result.as_ref().err().is_some_and(|fault| fault.fatal) {
            return result;
        }
        if name == "finally" {
            if let Some(handler) = first {
                let value = vm.callback(handler, Vec::new(), &method, &location).await?;
                vm.adopt(value).await?;
            }
            return result;
        }
        let handler = if result.is_ok() {
            if name == "then" { first } else { None }
        } else {
            if name == "then" { second } else { first }
        };
        if let Some(handler) = handler {
            let argument = match result {
                Ok(value) => value,
                Err(fault) => vm.state().caught(&fault),
            };
            let value = vm
                .callback(handler, vec![argument], &method, &location)
                .await?;
            return Ok(value);
        }
        result
    })))
}

fn console(vm: &Vm, name: &str, args: Vec<Value>, location: &Position) -> Result<Value, Fault> {
    let args = if name == "dir" {
        args.into_iter().take(1).collect::<Vec<_>>()
    } else {
        args
    };
    let line = if name == "table" {
        console_table(vm, &args, location)?
    } else {
        let prefix = match name {
            "warn" => "[warn] ",
            "error" => "[error] ",
            "debug" => "[debug] ",
            _ => "",
        };
        concat(&[
            prefix.into(),
            joined(
                &args
                    .iter()
                    .map(|value| console_value(vm, value, true, 0, &mut Vec::new()))
                    .collect::<Result<Vec<_>, _>>()?,
                " ",
            ),
        ])
    };
    vm.state().logs.push(line);
    Ok(Value::Undefined)
}

fn console_value(
    vm: &Vm,
    value: &Value,
    root: bool,
    depth: usize,
    seen: &mut Vec<usize>,
) -> Result<LosslessString, Fault> {
    if depth > 32 {
        return Ok("...".into());
    }
    match value {
        Value::Undefined if root => Ok("undefined".into()),
        Value::Undefined | Value::Null => Ok("null".into()),
        Value::String(text) if root => Ok(text.clone()),
        Value::String(text) => {
            Ok(stringify_json(&ycoding_schema::JsonValue::String(text.clone())).into())
        }
        Value::Number(number) => Ok(super::values::number_string(*number).into()),
        Value::Boolean(value) => Ok(value.to_string().into()),
        Value::Promise(_) => Ok("[Promise (await it to get its value)]".into()),
        Value::Date(_) | Value::RegExp(_) | Value::Url(_) | Value::Params(_) => {
            vm.state().text(value)
        }
        Value::Object(id) | Value::Array(id) | Value::Map(id) | Value::Set(id) => {
            if seen.contains(id) {
                return Ok("[Circular]".into());
            }
            seen.push(*id);
            let heap = vm.state().heap[*id].clone();
            let text = match heap {
                Heap::Object { fields, .. } => concat(&[
                    "{".into(),
                    joined(
                        &fields
                            .iter()
                            .map(|(key, value)| {
                                console_value(vm, value, false, depth + 1, seen).map(|value| {
                                    concat(&[
                                        stringify_json(&ycoding_schema::JsonValue::String(
                                            key.clone(),
                                        ))
                                        .into(),
                                        ":".into(),
                                        value,
                                    ])
                                })
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                        ",",
                    ),
                    "}".into(),
                ]),
                Heap::Array { length, items, .. } => concat(&[
                    "[".into(),
                    joined(
                        &(0..length)
                            .map(|index| match items.get(&index) {
                                Some(value) => console_value(vm, value, false, depth + 1, seen),
                                None => Ok(LosslessString::default()),
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                        ",",
                    ),
                    "]".into(),
                ]),
                Heap::Map(entries) => {
                    let size = entries.len();
                    let values = entries
                        .into_iter()
                        .map(|(key, value)| vm.state().array(vec![key, value]))
                        .collect();
                    let value = vm.state().array(values);
                    concat(&[
                        format!("Map({size}) ").into(),
                        console_value(vm, &value, false, depth + 1, seen)?,
                    ])
                }
                Heap::Set { items, .. } => {
                    let size = items.len();
                    let value = vm
                        .state()
                        .array(items.into_iter().map(|(_, value)| value).collect());
                    concat(&[
                        format!("Set({size}) ").into(),
                        console_value(vm, &value, false, depth + 1, seen)?,
                    ])
                }
                _ => return Err(Fault::data("Invalid console value.")),
            };
            seen.pop();
            Ok(text)
        }
        _ => Ok("[CodeMode reference]".into()),
    }
}

fn joined(values: &[LosslessString], separator: &str) -> LosslessString {
    LosslessString::from_utf16(
        values
            .iter()
            .enumerate()
            .flat_map(|(index, value)| {
                if index == 0 {
                    value.code_units().collect::<Vec<_>>()
                } else {
                    separator
                        .encode_utf16()
                        .chain(value.code_units())
                        .collect::<Vec<_>>()
                }
            })
            .collect(),
    )
}

fn console_table(vm: &Vm, args: &[Value], location: &Position) -> Result<LosslessString, Fault> {
    let first = args.first().cloned().unwrap_or(Value::Undefined);
    if matches!(first, Value::Undefined) {
        return Ok("undefined".into());
    }
    let columns = match args.get(1) {
        Some(Value::Array(_)) => Some(
            vm.iterable(args.get(1).expect("Console table columns"), location)?
                .iter()
                .map(|value| vm.state().text(value))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        _ => None,
    };
    let rows = if matches!(first, Value::Array(_) | Value::Object(_)) {
        vm.keys(&first, location)?
            .into_iter()
            .map(|key| vm.get(&first, &key, location).map(|value| (key, value)))
            .collect::<Result<Vec<_>, _>>()?
    } else {
        vec![("0".into(), first)]
    };
    let mut keys = columns.clone().unwrap_or_default();
    if columns.is_none() {
        for (_, row) in &rows {
            if matches!(row, Value::Object(_)) {
                for key in vm.keys(row, location)? {
                    if !keys.contains(&key) {
                        keys.push(key)
                    }
                }
            } else if !keys.contains(&"Value".into()) {
                keys.push("Value".into());
            }
        }
    }
    let mut header = vec!["(index)".into()];
    header.extend(keys.iter().cloned());
    let mut lines = vec![joined(&header, "\t")];
    for (index, row) in rows {
        let cells = keys
            .iter()
            .map(|key| {
                let value = if matches!(row, Value::Object(_)) {
                    vm.get(&row, key, location)?
                } else if key.as_str() == Some("Value") {
                    row.clone()
                } else {
                    Value::Undefined
                };
                if matches!(value, Value::Undefined) {
                    Ok(LosslessString::default())
                } else {
                    console_value(vm, &value, true, 0, &mut Vec::new())
                }
            })
            .collect::<Result<Vec<_>, Fault>>()?;
        lines.push(concat(&[index, "\t".into(), joined(&cells, "\t")]));
    }
    Ok(joined(&lines, "\n"))
}

fn pretty_json(value: &ycoding_schema::JsonValue, spacing: &str, depth: usize) -> String {
    let child = spacing.repeat(depth + 1);
    let end = spacing.repeat(depth);
    match value {
        ycoding_schema::JsonValue::Array(values) if !values.is_empty() => format!(
            "[\n{child}{}\n{end}]",
            values
                .iter()
                .map(|value| pretty_json(value, spacing, depth + 1))
                .collect::<Vec<_>>()
                .join(&format!(",\n{child}"))
        ),
        ycoding_schema::JsonValue::Object(values) if !values.is_empty() => format!(
            "{{\n{child}{}\n{end}}}",
            values
                .iter()
                .map(|(key, value)| format!(
                    "{}: {}",
                    stringify_json(&ycoding_schema::JsonValue::String(key.clone())),
                    pretty_json(value, spacing, depth + 1)
                ))
                .collect::<Vec<_>>()
                .join(&format!(",\n{child}"))
        ),
        _ => stringify_json(value),
    }
}

fn callable(value: &Value) -> bool {
    type_of(value) == "function"
}
