use super::{Ceiling, Component, Edit, Error, Harness, Item, Op, Version, VersionId};
use crate::resources::memory::format::sha256;

pub fn canonical(mut harness: Harness) -> Harness {
    harness.items.retain(|_, items| !items.is_empty());
    for items in harness.items.values_mut() {
        items.sort_by(|a, b| a.key.cmp(&b.key));
    }
    harness
}

pub fn apply(harness: &Harness, edits: &[Edit]) -> Harness {
    let mut next = harness.clone();
    for edit in edits {
        let items = next.items.entry(edit.component).or_default();
        items.retain(|item| item.key != edit.key);
        if let Op::Set(content) = &edit.op {
            items.push(Item {
                key: edit.key.clone(),
                content: content.clone(),
            });
        }
    }
    canonical(next)
}

pub fn identify(parent: Option<&VersionId>, harness: &Harness) -> VersionId {
    let mut bytes = Vec::new();
    let mut field = |text: &str| {
        bytes.extend_from_slice(&(text.len() as u64).to_be_bytes());
        bytes.extend_from_slice(text.as_bytes());
    };
    field(parent.map_or("", |parent| parent.0.as_str()));
    for (component, items) in &canonical(harness.clone()).items {
        field(component.as_str());
        field(&items.len().to_string());
        for item in items {
            field(&item.key);
            field(&item.content);
        }
    }
    VersionId(format!("hv_{}", &sha256(&bytes)[..32]))
}

pub fn genesis() -> Version {
    let harness = Harness::default();
    Version {
        id: identify(None, &harness),
        parent: None,
        harness,
        edits: Vec::new(),
        created_at: 0,
        task: None,
    }
}

pub fn authorize(ceiling: &Ceiling, harness: &Harness, edit: &Edit) -> Result<(), Error> {
    if edit.key.trim().is_empty() || edit.key.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "edit key must be a single non-empty line".into(),
        ));
    }
    if edit.rationale.trim().is_empty() {
        return Err(Error::Invalid(format!(
            "edit {} has no rationale",
            edit.key
        )));
    }
    let exists = harness
        .items
        .get(&edit.component)
        .is_some_and(|items| items.iter().any(|item| item.key == edit.key));
    let named = match edit.component {
        Component::Skills => Some(&ceiling.skills),
        Component::Subagents => Some(&ceiling.agents),
        Component::Plugins => Some(&ceiling.plugins),
        Component::Scripts => Some(&ceiling.scripts),
        _ => None,
    };
    if named.is_some_and(|allowed| !allowed.contains(&edit.key)) {
        return Err(Error::Denied(format!(
            "{} {} is not authorized",
            edit.component.as_str(),
            edit.key
        )));
    }
    match &edit.op {
        Op::Set(content) => {
            if content.len() > ceiling.max_item_bytes {
                return Err(Error::Denied(format!(
                    "{} {} exceeds {} bytes",
                    edit.component.as_str(),
                    edit.key,
                    ceiling.max_item_bytes
                )));
            }
            if edit.component == Component::Guardrails && exists {
                return Err(Error::Denied(format!(
                    "guardrail {} cannot be replaced",
                    edit.key
                )));
            }
        }
        Op::Remove => {
            if edit.component == Component::Guardrails {
                return Err(Error::Denied(format!(
                    "guardrail {} cannot be removed",
                    edit.key
                )));
            }
            if !exists {
                return Err(Error::Invalid(format!(
                    "{} {} does not exist",
                    edit.component.as_str(),
                    edit.key
                )));
            }
        }
    }
    Ok(())
}

pub fn admit(ceiling: &Ceiling, harness: &Harness, edits: &[Edit]) -> Result<Harness, Error> {
    let mut current = harness.clone();
    for edit in edits {
        authorize(ceiling, &current, edit)?;
        current = apply(&current, std::slice::from_ref(edit));
    }
    let total: usize = current.items.values().map(Vec::len).sum();
    if total > ceiling.max_items {
        return Err(Error::Denied(format!(
            "{total} items exceed the limit of {}",
            ceiling.max_items
        )));
    }
    Ok(current)
}
