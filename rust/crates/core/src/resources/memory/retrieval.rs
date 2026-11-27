use super::{
    Scope, experience,
    format::Concept,
    okf::{self, Deadline, Status, Trust},
};
use crate::resources::recall::document::{
    Document, Fields, Kind, Lifecycle, Scope as DocumentScope, Source, Status as DocumentStatus,
    Trust as DocumentTrust,
};
use std::collections::BTreeSet;

pub(super) fn scope(scope: Scope) -> DocumentScope {
    match scope {
        Scope::Repository => DocumentScope::Workspace,
        Scope::Knowledge => DocumentScope::Knowledge,
    }
}

fn status(status: &Status) -> DocumentStatus {
    match status {
        Status::Stable => DocumentStatus::Active,
        Status::Draft => DocumentStatus::Draft,
        Status::Deprecated => DocumentStatus::Deprecated,
        Status::Unknown(raw) if raw.eq_ignore_ascii_case("archived") => DocumentStatus::Archived,
        Status::Unknown(_) => DocumentStatus::Unknown,
    }
}

fn strings(concept: &Concept, key: &str) -> Vec<String> {
    okf::items(&concept.doc.yaml[key])
        .into_iter()
        .filter_map(okf::scalar)
        .filter(|text| !text.trim().is_empty())
        .collect()
}

fn bundle_id(target: &str) -> String {
    target
        .trim_start_matches('/')
        .trim_end_matches(".md")
        .to_owned()
}

pub(super) fn project(
    concept: &Concept,
    scope: Scope,
    outgoing: Option<&BTreeSet<String>>,
) -> Document {
    let summary = &concept.summary;
    let meta = &summary.meta;
    let signals = &summary.signals;
    let mut identifiers = meta.resource.iter().cloned().collect::<Vec<_>>();
    for source in &meta.sources {
        identifiers.extend(source.id.iter().cloned());
        identifiers.push(source.resource.clone());
    }
    identifiers.extend(strings(concept, "identifiers"));
    let mut keywords = strings(concept, "keywords");
    if experience::is(&meta.type_) {
        keywords.extend(strings(concept, experience::CUE));
        identifiers.extend(strings(concept, experience::HARNESS_CHANGE));
    }
    let mut relationships = outgoing
        .into_iter()
        .flatten()
        .cloned()
        .collect::<BTreeSet<_>>();
    relationships.extend(signals.replacement.iter().cloned());
    let stale_after = match &meta.stale_after {
        Deadline::Absent => None,
        Deadline::At(deadline) => Some(deadline.timestamp() - 1),
        Deadline::Malformed(_) => Some(i64::MIN),
    };
    Document {
        id: summary.id.clone(),
        kind: Kind::Concept,
        scope: self::scope(scope),
        source: Source {
            path: format!("{}.md", summary.id),
            revision: meta
                .content_time()
                .map_or_else(|| summary.digest.clone(), |at| at.to_rfc3339()),
            content_hash: summary.digest.clone(),
        },
        fields: Fields {
            doc_type: meta.type_.clone(),
            title: meta.title.clone().unwrap_or_else(|| summary.id.clone()),
            description: meta.description.clone().unwrap_or_default(),
            body: concept.body.clone(),
            tags: meta.tags.clone(),
            keywords,
            identifiers,
            relationships: relationships.into_iter().collect(),
        },
        lifecycle: Lifecycle {
            status: status(&meta.status),
            trust: if signals.trust == Trust::Unverified {
                DocumentTrust::Unverified
            } else {
                DocumentTrust::Verified
            },
            stale_after,
            superseded_by: signals
                .replacement
                .clone()
                .or_else(|| meta.superseded_by.as_deref().map(bundle_id)),
            activation: None,
        },
    }
}
