use crate::resources::discovery::join;
use std::cmp::Ordering;
use ycoding_schema::{LosslessString, reference::Info};
pub const KEY: &str = "core/reference-guidance";
pub const REMOVED: &str =
    "Project reference guidance is no longer available. Do not use previously listed references.";
#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    pub name: LosslessString,
    pub path: LosslessString,
    pub description: Option<LosslessString>,
}
pub fn summaries_by(
    references: &[Info],
    mut compare: impl FnMut(&LosslessString, &LosslessString) -> Ordering,
) -> Vec<Summary> {
    let mut result = references
        .iter()
        .filter(|r| r.description.is_some())
        .map(|r| Summary {
            name: r.name.clone(),
            path: r.path.as_lossless().clone(),
            description: r.description.clone(),
        })
        .collect::<Vec<_>>();
    result.sort_by(|a, b| compare(&a.name, &b.name));
    result
}
pub fn render(references: &[Summary]) -> LosslessString {
    let mut parts = vec![
        "Project references provide additional directories that can be accessed when relevant."
            .into(),
        "<available_references>".into(),
    ];
    parts.extend(entries(references));
    parts.push("</available_references>".into());
    join(&parts, "\n")
}
pub fn changed(previous: &[Summary], current: &[Summary]) -> LosslessString {
    let added = current
        .iter()
        .filter(|r| !previous.iter().any(|p| p.name == r.name))
        .cloned()
        .collect::<Vec<_>>();
    let removed = previous
        .iter()
        .filter(|r| !current.iter().any(|p| p.name == r.name))
        .map(|r| r.name.clone())
        .collect::<Vec<_>>();
    let changed = current.iter().any(|r| {
        previous
            .iter()
            .find(|p| p.name == r.name)
            .is_some_and(|p| p.path != r.path || p.description != r.description)
    });
    if changed || (added.is_empty() && removed.is_empty()) {
        return join(&["The available project references have changed. This list supersedes the previous reference list.".into(),render(current)],"\n");
    }
    let mut parts = Vec::new();
    if !added.is_empty() {
        parts.push(
            "New project references are available in addition to those previously listed:".into(),
        );
        parts.extend(entries(&added));
    }
    if !removed.is_empty() {
        parts.push(join(
            &[
                "The following project references are no longer available and must not be used: "
                    .into(),
                join(&removed, ", "),
                ".".into(),
            ],
            "",
        ));
    }
    join(&parts, "\n")
}
fn entries(references: &[Summary]) -> Vec<LosslessString> {
    references
        .iter()
        .flat_map(|r| {
            let mut parts = vec![
                "  <reference>".into(),
                tag("name", &r.name),
                tag("path", &r.path),
            ];
            if let Some(description) = &r.description {
                parts.push(tag("description", description));
            }
            parts.push("  </reference>".into());
            parts
        })
        .collect()
}
fn tag(name: &str, value: &LosslessString) -> LosslessString {
    join(
        &[
            format!("    <{name}>").into(),
            value.clone(),
            format!("</{name}>").into(),
        ],
        "",
    )
}
