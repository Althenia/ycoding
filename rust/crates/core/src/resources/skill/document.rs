use crate::resources::recall::document::{
    Activation, Document, Fields, Kind, Lifecycle, Scope, Source, Status, Trust,
};
use ring::digest;
use std::path::Path;
use ycoding_schema::{DomainEncode, JsonObject, JsonValue, LosslessString, skill::Info};

pub struct Origin {
    pub scope: Scope,
    pub revision: Option<String>,
    pub content_hash: Option<String>,
    pub trust: Trust,
}

pub fn location_origin(
    info: &Info,
    project: Option<&Path>,
    roots: &crate::resources::config::Roots,
) -> Origin {
    Origin {
        scope: match super::scope(info, project, roots) {
            Some(super::Scope::Project) => Scope::Project,
            Some(super::Scope::Global) => Scope::Knowledge,
            None => Scope::Workspace,
        },
        revision: None,
        content_hash: None,
        trust: Trust::Unverified,
    }
}

pub(super) fn build(
    info: &Info,
    metadata: Option<&JsonObject>,
    hash: Option<&str>,
    origin: Origin,
) -> Document {
    let content_hash = origin
        .content_hash
        .or_else(|| hash.map(str::to_owned))
        .unwrap_or_else(|| sha256_hex(&text(&info.content)));
    let list = |key: &str| -> Vec<String> {
        let mut items: Vec<String> = Vec::new();
        if let Some(JsonValue::String(value)) = metadata.and_then(|m| m.get(&key.into())) {
            for item in text(value).split(',').map(str::trim) {
                if !item.is_empty() && !items.iter().any(|seen| seen == item) {
                    items.push(item.to_owned());
                }
            }
        }
        items
    };
    let merged = |keys: &[&str]| -> Vec<String> {
        let mut items: Vec<String> = Vec::new();
        for item in keys.iter().flat_map(|key| list(key)) {
            if !items.contains(&item) {
                items.push(item);
            }
        }
        items
    };
    let note = |key: &str, label: &str| -> Option<String> {
        match metadata.and_then(|m| m.get(&key.into())) {
            Some(JsonValue::String(value)) => Some(format!("{label}: {}", text(value).trim())),
            _ => None,
        }
    };
    let body = [
        note("purpose", "Purpose"),
        note("applicability", "Applicability"),
        note("prerequisites", "Prerequisites"),
    ]
    .into_iter()
    .flatten()
    .chain(std::iter::once(text(&info.content)))
    .collect::<Vec<_>>()
    .join("\n\n");
    let mut relationships = info.conflicts.as_ref().map_or_else(Vec::new, |conflicts| {
        conflicts
            .skills
            .iter()
            .map(|id| format!("skill:{}", text(id)))
            .chain(
                conflicts
                    .instructions
                    .iter()
                    .filter_map(|key| match key.encode() {
                        JsonValue::String(key) => Some(format!("instruction:{}", text(&key))),
                        _ => None,
                    }),
            )
            .collect()
    });
    relationships.extend(
        list("related")
            .into_iter()
            .map(|item| format!("related:{item}")),
    );
    let mut identifiers = vec![text(&info.id)];
    identifiers.extend(list("capabilities"));
    Document {
        id: text(&info.id),
        kind: Kind::Skill,
        scope: origin.scope,
        source: Source {
            path: text(info.location.as_lossless()),
            revision: origin.revision.unwrap_or_else(|| content_hash.clone()),
            content_hash,
        },
        fields: Fields {
            doc_type: Kind::Skill.as_str().into(),
            title: text(&info.name),
            description: info.description.as_ref().map(text).unwrap_or_default(),
            body,
            tags: list("tags"),
            keywords: merged(&["keywords", "triggers"]),
            identifiers,
            relationships,
        },
        lifecycle: Lifecycle {
            status: Status::Active,
            trust: origin.trust,
            stale_after: None,
            superseded_by: None,
            activation: info.autoinvoke.map(|auto| {
                if auto {
                    Activation::Auto
                } else {
                    Activation::Manual
                }
            }),
        },
    }
}

fn text(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}

pub(super) fn sha256_hex(content: &str) -> String {
    digest::digest(&digest::SHA256, content.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
