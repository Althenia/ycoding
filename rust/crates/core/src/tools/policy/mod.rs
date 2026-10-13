pub mod ceiling;
pub mod forms;
pub mod helper;
pub mod permissions;
pub mod questions;
pub(crate) mod state;
pub use state::{Authority, Error, Event, Publisher, SessionAuthority, Wait};

use ycoding_schema::{LosslessString, permission};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Effect {
    Allow,
    Ask,
    Deny,
}

impl Effect {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }
}

pub fn wildcard(input: &LosslessString, pattern: &LosslessString) -> bool {
    let normalize = |value: &LosslessString| {
        value
            .code_units()
            .map(|unit| if unit == 92 { 47 } else { unit })
            .collect::<Vec<_>>()
    };
    let pattern = normalize(pattern);
    let optional = pattern.ends_with(&[32, 42]);
    let pattern = if optional {
        &pattern[..pattern.len() - 2]
    } else {
        &pattern
    };
    let mut source = vec![94];
    for unit in pattern {
        match unit {
            42 => source.extend([46, 42]),
            63 => source.push(46),
            46 | 43 | 94 | 36 | 123 | 125 | 40 | 41 | 124 | 91 | 93 | 92 => {
                source.extend([92, *unit])
            }
            _ => source.push(*unit),
        }
    }
    if optional {
        source.extend("( .*)?".encode_utf16());
    }
    source.push(36);
    crate::regexp::RegExp::new(&source, if cfg!(windows) { "si" } else { "s" })
        .expect("escaped wildcard pattern")
        .test(&normalize(input), &mut crate::regexp::Budget::unlimited())
        .expect("unlimited escaped wildcard pattern")
}

pub fn evaluate(
    action: &LosslessString,
    resource: &LosslessString,
    rules: &[permission::Rule],
) -> permission::Rule {
    rules
        .iter()
        .rev()
        .find(|rule| wildcard(action, &rule.action) && wildcard(resource, &rule.resource))
        .cloned()
        .unwrap_or_else(|| permission::Rule {
            action: action.clone(),
            resource: "*".into(),
            effect: permission::Effect("ask".into()),
        })
}

pub fn decision(
    action: &LosslessString,
    resources: &[LosslessString],
    configured: &[permission::Rule],
    remembered: &[permission::Rule],
) -> Effect {
    if resources
        .iter()
        .any(|resource| evaluate(action, resource, configured).effect.0.as_str() == Some("deny"))
    {
        return Effect::Deny;
    }
    let rules = [configured, remembered].concat();
    let effects = resources
        .iter()
        .map(|resource| evaluate(action, resource, &rules).effect.0)
        .collect::<Vec<_>>();
    if effects.iter().any(|effect| effect.as_str() == Some("deny")) {
        return Effect::Deny;
    }
    if effects.iter().any(|effect| effect.as_str() == Some("ask")) {
        return Effect::Ask;
    }
    Effect::Allow
}

pub fn expand_permissions(
    rules: &[permission::Rule],
    home: &LosslessString,
) -> permission::Ruleset {
    rules
        .iter()
        .map(|rule| {
            let path_action = matches!(
                rule.action.as_str(),
                Some("read" | "edit" | "external_directory")
            );
            let units = rule.resource.code_units().collect::<Vec<_>>();
            let tail = if units == [126] || units == "$HOME".encode_utf16().collect::<Vec<_>>() {
                Some(&[][..])
            } else if units.starts_with(&[126, 47]) {
                Some(&units[1..])
            } else if units.starts_with(&"$HOME/".encode_utf16().collect::<Vec<_>>())
                || units.starts_with(&"$HOME\\".encode_utf16().collect::<Vec<_>>())
            {
                Some(&units[5..])
            } else {
                None
            };
            permission::Rule {
                resource: if path_action {
                    tail.map_or_else(
                        || rule.resource.clone(),
                        |tail| {
                            LosslessString::from_utf16(
                                home.code_units().chain(tail.iter().copied()).collect(),
                            )
                        },
                    )
                } else {
                    rule.resource.clone()
                },
                ..rule.clone()
            }
        })
        .collect()
}

#[derive(Clone, Debug, Default)]
pub struct Policy {
    statements: Vec<Statement>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyEffect {
    Allow,
    Deny,
}

#[derive(Clone, Debug)]
pub struct Statement {
    pub action: LosslessString,
    pub resource: LosslessString,
    pub effect: PolicyEffect,
}

impl Policy {
    pub fn load(&mut self, statements: Vec<Statement>) {
        self.statements = statements;
    }
    pub fn has_statements(&self) -> bool {
        !self.statements.is_empty()
    }
    pub fn evaluate(
        &self,
        action: &LosslessString,
        resource: &LosslessString,
        fallback: PolicyEffect,
    ) -> PolicyEffect {
        self.statements
            .iter()
            .rev()
            .find(|rule| wildcard(action, &rule.action) && wildcard(resource, &rule.resource))
            .map_or(fallback, |rule| rule.effect)
    }
}
