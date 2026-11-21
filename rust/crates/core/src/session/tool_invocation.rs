use std::collections::{BTreeMap, BTreeSet};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, ObjectEncoder,
    tool_invocation::Settled,
};

pub(crate) fn merge_structured(previous: &JsonObject, next: &JsonObject) -> JsonObject {
    let mut held = BTreeMap::new();
    let mut order = Vec::new();
    if let Some(JsonValue::Array(calls)) = previous.get(&"toolCalls".into()) {
        for call in calls {
            if let Ok(settled) = Settled::decode(call) {
                if !held.contains_key(&settled.id) {
                    order.push(settled.id.clone());
                }
                held.insert(settled.id, call.clone());
            }
        }
    }
    let mut seen = BTreeSet::new();
    let mut calls = match next.get(&"toolCalls".into()) {
        Some(JsonValue::Array(calls)) => calls.clone(),
        _ => Vec::new(),
    };
    for call in &mut calls {
        if let JsonValue::Object(object) = call
            && let Some(JsonValue::String(id)) = object.get(&"id".into())
        {
            seen.insert(id.clone());
            if let Some(settled) = held.get(id) {
                *call = settled.clone();
            }
        }
    }
    for id in order {
        if !seen.contains(&id) {
            calls.push(held.remove(&id).expect("held invocation exists"));
        }
    }
    let mut ordered = calls
        .iter()
        .filter_map(|call| {
            Settled::decode(call)
                .ok()
                .map(|settled| (settled.index.get(), call.clone()))
        })
        .collect::<Vec<_>>();
    ordered.sort_by_key(|(index, _)| *index);
    let mut ordered = ordered.into_iter();
    for call in &mut calls {
        if Settled::decode(call).is_ok() {
            *call = ordered.next().expect("settled invocation exists").1;
        }
    }
    let mut result = next.clone();
    result.insert("toolCalls".into(), JsonValue::Array(calls));
    result
}

pub(crate) fn settle(structured: &JsonObject, invocation: &Settled) -> JsonObject {
    let mut next = structured.clone();
    let mut calls = match next.get(&"toolCalls".into()) {
        Some(JsonValue::Array(calls)) => calls.clone(),
        _ => Vec::new(),
    };
    let mut found = false;
    for call in &mut calls {
        if let JsonValue::Object(object) = call
            && object.get(&"id".into()) == Some(&JsonValue::String(invocation.id.clone()))
        {
            *call = invocation.encode();
            found = true;
        }
    }
    if !found {
        calls.push(invocation.encode());
    }
    next.insert("toolCalls".into(), JsonValue::Array(calls));
    merge_structured(&JsonObject::new(), &next)
}

pub(crate) fn list(part: &JsonValue) -> Vec<JsonValue> {
    let JsonValue::Object(part) = part else {
        return Vec::new();
    };
    if part.get(&"type".into()) != Some(&JsonValue::String("tool".into())) {
        return Vec::new();
    }
    let Some(JsonValue::String(name)) = part.get(&"name".into()) else {
        return Vec::new();
    };
    let Some(JsonValue::Object(state)) = part.get(&"state".into()) else {
        return Vec::new();
    };
    if name.as_str() != Some("execute") {
        return vec![JsonValue::Object(part.clone())];
    }
    if !matches!(part.get(&"id".into()), Some(JsonValue::String(_))) {
        return Vec::new();
    }
    let Some(JsonValue::Object(structured)) = state.get(&"structured".into()) else {
        return Vec::new();
    };
    let Some(JsonValue::Array(calls)) = structured.get(&"toolCalls".into()) else {
        return Vec::new();
    };
    calls
        .iter()
        .filter_map(|call| {
            let JsonValue::Object(call) = call else {
                return None;
            };
            let (
                Some(JsonValue::String(id)),
                Some(JsonValue::String(name)),
                Some(JsonValue::String(status)),
            ) = (
                call.get(&"id".into()),
                call.get(&"name".into()),
                call.get(&"status".into()),
            )
            else {
                return None;
            };
            Some(
                ObjectEncoder::new()
                    .field("type", &LosslessString::from("tool"))
                    .field("id", id)
                    .field("name", name)
                    .field(
                        "state",
                        &ObjectEncoder::new()
                            .field("status", status)
                            .optional("input", &call.get(&"input".into()).cloned())
                            .optional("structured", &call.get(&"structured".into()).cloned())
                            .finish(),
                    )
                    .finish(),
            )
        })
        .collect()
}
