use super::Entry;
use crate::tools::policy::wildcard;
use ycoding_schema::{JsonValue, LosslessString};

pub const BUILTIN_INSTRUCTIONS: &[&str] = &[
    "environment",
    "date",
    "subagent-reuse",
    "shell-memory",
    "project-artifact-authoring",
    "git-worktree",
    "git-attribution",
    "human-input",
    "decision-use",
    "task-completion",
    "memory",
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Selection {
    pub enabled: Option<bool>,
    pub allow: Option<Vec<LosslessString>>,
    pub deny: Option<Vec<LosslessString>>,
}

impl Selection {
    pub fn allows(&self, name: &LosslessString) -> bool {
        self.enabled != Some(false)
            && !self
                .deny
                .as_ref()
                .is_some_and(|patterns| patterns.iter().any(|pattern| wildcard(name, pattern)))
            && self
                .allow
                .as_ref()
                .is_none_or(|patterns| patterns.iter().any(|pattern| wildcard(name, pattern)))
    }

    fn merge(&mut self, value: &JsonValue) {
        merge_bool(&mut self.enabled, value, "enabled");
        merge_strings(&mut self.allow, value, "allow");
        merge_strings(&mut self.deny, value, "deny");
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Instructions {
    pub global: Option<bool>,
    pub project: Option<bool>,
    pub exclude: Option<Vec<LosslessString>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstructionSource {
    Global,
    Project,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WebsearchProvider {
    Exa,
    Parallel,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfigCapabilities {
    pub instructions: Instructions,
    pub builtin_instructions: Selection,
    pub skills: Selection,
    pub tools: Selection,
    pub mcp: Selection,
    pub plugins: Selection,
    pub project_artifacts: Option<bool>,
    pub home_roots: Option<bool>,
    pub websearch_provider: Option<WebsearchProvider>,
}

impl ConfigCapabilities {
    pub fn resolve(entries: &[Entry]) -> Self {
        let mut resolved = Self::default();
        for entry in entries {
            let Entry::Document { info, .. } = entry else {
                continue;
            };
            let Some(value) = field(info, "capabilities") else {
                continue;
            };
            if let Some(instructions) = field(value, "instructions") {
                merge_bool(&mut resolved.instructions.global, instructions, "global");
                merge_bool(&mut resolved.instructions.project, instructions, "project");
                merge_strings(&mut resolved.instructions.exclude, instructions, "exclude");
            }
            for (key, selection) in [
                ("builtin_instructions", &mut resolved.builtin_instructions),
                ("skills", &mut resolved.skills),
                ("tools", &mut resolved.tools),
                ("mcp", &mut resolved.mcp),
                ("plugins", &mut resolved.plugins),
            ] {
                if let Some(value) = field(value, key) {
                    selection.merge(value);
                }
            }
            merge_bool(&mut resolved.project_artifacts, value, "project_artifacts");
            merge_bool(&mut resolved.home_roots, value, "home_roots");
            if let Some(JsonValue::String(provider)) = field(value, "websearch_provider") {
                match provider.as_str() {
                    Some("exa") => resolved.websearch_provider = Some(WebsearchProvider::Exa),
                    Some("parallel") => {
                        resolved.websearch_provider = Some(WebsearchProvider::Parallel);
                    }
                    _ => {}
                }
            }
        }
        resolved
    }

    pub fn allows_tool(&self, name: &LosslessString) -> bool {
        if name.as_str() == Some("skill") && self.skills.enabled == Some(false) {
            return false;
        }
        if name.as_str() == Some("project_artifact") && self.project_artifacts == Some(false) {
            return false;
        }
        if name.as_str() == Some("execute") {
            return self.tools.enabled != Some(false)
                && !self.tools.deny.as_ref().is_some_and(|patterns| {
                    patterns.iter().any(|pattern| wildcard(name, pattern))
                });
        }
        self.tools.allows(name)
    }

    pub fn allows_instruction(&self, path: &LosslessString, source: InstructionSource) -> bool {
        let enabled = match source {
            InstructionSource::Global => self.instructions.global,
            InstructionSource::Project => self.instructions.project,
        };
        enabled != Some(false)
            && !self
                .instructions
                .exclude
                .as_ref()
                .is_some_and(|patterns| patterns.iter().any(|pattern| wildcard(path, pattern)))
    }
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    object.get(&key.into())
}

fn merge_bool(target: &mut Option<bool>, value: &JsonValue, key: &str) {
    if let Some(JsonValue::Bool(value)) = field(value, key) {
        *target = Some(*value);
    }
}

fn merge_strings(target: &mut Option<Vec<LosslessString>>, value: &JsonValue, key: &str) {
    if let Some(JsonValue::Array(values)) = field(value, key) {
        *target = Some(
            values
                .iter()
                .filter_map(|value| match value {
                    JsonValue::String(value) => Some(value.clone()),
                    _ => None,
                })
                .collect(),
        );
    }
}
