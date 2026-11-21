use crate::resources::discovery::join;
use std::cmp::Ordering;
use ycoding_schema::{LosslessString, skill::Info};
pub const KEY: &str = "core/skill-guidance";
pub const REMOVED: &str =
    "Skill guidance is no longer available. Do not use any previously listed skill.";
#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    pub id: LosslessString,
    pub name: LosslessString,
    pub description: LosslessString,
    pub server: Option<LosslessString>,
}
pub fn summaries_by(
    skills: &[&Info],
    mut compare: impl FnMut(&LosslessString, &LosslessString) -> Ordering,
) -> Vec<Summary> {
    let mut result = skills
        .iter()
        .filter(|s| s.autoinvoke != Some(false))
        .filter_map(|s| {
            s.description.as_ref().map(|d| Summary {
                id: s.id.clone(),
                name: s.name.clone(),
                description: d.clone(),
                server: None,
            })
        })
        .collect::<Vec<_>>();
    result.sort_by(|a, b| compare(&a.id, &b.id));
    result
}
pub fn render(skills: &[Summary]) -> LosslessString {
    let mut parts = vec![
        "Skills provide specialized instructions and workflows for specific tasks.".into(),
        "Use the skill tool to load a skill when a task matches its description.".into(),
    ];
    if skills.is_empty() {
        parts.push("No skills are currently available.".into());
        return join(&parts, "\n");
    }
    parts.push("<available_skills>".into());
    parts.extend(entries(skills));
    parts.push("</available_skills>".into());
    join(&parts, "\n")
}
pub fn changed(previous: &[Summary], current: &[Summary]) -> LosslessString {
    let added = current
        .iter()
        .filter(|s| !previous.iter().any(|p| p.id == s.id))
        .cloned()
        .collect::<Vec<_>>();
    let removed = previous
        .iter()
        .filter(|s| !current.iter().any(|p| p.id == s.id))
        .map(|s| s.id.clone())
        .collect::<Vec<_>>();
    let changed = current.iter().any(|s| {
        previous
            .iter()
            .find(|p| p.id == s.id)
            .is_some_and(|p| p.name != s.name || p.description != s.description)
    });
    if changed || (added.is_empty() && removed.is_empty()) {
        return join(&["The available skills have changed. This list supersedes the previous available skills list.".into(),render(current)],"\n");
    }
    let mut parts = Vec::new();
    if !added.is_empty() {
        parts.push("New skills are available in addition to those previously listed:".into());
        parts.extend(entries(&added));
    }
    if !removed.is_empty() {
        parts.push(join(
            &[
                "The following skill IDs are no longer available and must not be used: ".into(),
                join(&removed, ", "),
                ".".into(),
            ],
            "",
        ));
    }
    join(&parts, "\n")
}
fn entries(skills: &[Summary]) -> Vec<LosslessString> {
    skills
        .iter()
        .flat_map(|s| {
            vec![
                "  <skill>".into(),
                tag("id", &s.id),
                tag("name", &s.name),
                tag("description", &s.description),
            ]
            .into_iter()
            .chain(s.server.as_ref().map(|server| tag("origin", server)))
            .chain(["  </skill>".into()])
        })
        .collect()
}
fn tag(name: &str, value: &LosslessString) -> LosslessString {
    let value = LosslessString::from_utf16(
        value
            .code_units()
            .flat_map(|u| match u {
                38 => "&amp;".encode_utf16().collect::<Vec<_>>(),
                60 => "&lt;".encode_utf16().collect(),
                62 => "&gt;".encode_utf16().collect(),
                34 => "&quot;".encode_utf16().collect(),
                39 => "&apos;".encode_utf16().collect(),
                _ => vec![u],
            })
            .collect(),
    );
    join(
        &[
            format!("    <{name}>").into(),
            value,
            format!("</{name}>").into(),
        ],
        "",
    )
}
