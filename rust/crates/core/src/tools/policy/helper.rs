use crate::{
    regexp::{Budget, RegExp},
    resources::config::Configuration,
};
use std::collections::BTreeMap;
use ycoding_schema::{DecodeError, DomainDecode, JsonValue, LosslessString, ObjectEncoder, model};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Role {
    Title,
    Goal,
    Decision,
    Compaction,
    Prediction,
    Prompt,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum CompactionScope {
    Main,
    Subagent,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TitleMode {
    Local,
    Model,
    Off,
}
#[derive(Clone, Debug, PartialEq)]
pub enum ModelSelection {
    Session,
    Model(model::Ref),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub title_mode: TitleMode,
    pub models: BTreeMap<Role, ModelSelection>,
    pub compaction_scopes: BTreeMap<CompactionScope, ModelSelection>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            title_mode: TitleMode::Local,
            models: BTreeMap::new(),
            compaction_scopes: BTreeMap::new(),
        }
    }
}

impl Settings {
    pub fn from_configuration(config: &Configuration) -> Result<Self, DecodeError> {
        let Some(JsonValue::Object(efficiency)) = config.latest("efficiency") else {
            return Ok(Self::default());
        };
        let title_mode = match efficiency.get(&"title".into()) {
            Some(JsonValue::String(value)) if value.as_str() == Some("model") => TitleMode::Model,
            Some(JsonValue::String(value)) if value.as_str() == Some("off") => TitleMode::Off,
            _ => TitleMode::Local,
        };
        let Some(JsonValue::Object(helpers)) = efficiency.get(&"helper_models".into()) else {
            return Ok(Self {
                title_mode,
                ..Self::default()
            });
        };
        let models = [
            (Role::Title, "title"),
            (Role::Goal, "goal"),
            (Role::Decision, "decision"),
            (Role::Prediction, "prediction"),
            (Role::Prompt, "prompt"),
        ]
        .into_iter()
        .filter_map(|(role, key)| {
            helpers
                .get(&key.into())
                .map(|value| selection(value).map(|selection| (role, selection)))
        })
        .collect::<Result<_, _>>()?;
        let compaction_scopes =
            if let Some(JsonValue::Object(scopes)) = helpers.get(&"compaction".into()) {
                [
                    (CompactionScope::Main, "main"),
                    (CompactionScope::Subagent, "subagent"),
                ]
                .into_iter()
                .filter_map(|(scope, key)| {
                    scopes
                        .get(&key.into())
                        .map(|value| selection(value).map(|selection| (scope, selection)))
                })
                .collect::<Result<_, _>>()?
            } else {
                BTreeMap::new()
            };
        Ok(Self {
            title_mode,
            models,
            compaction_scopes,
        })
    }
    pub fn select<'a>(
        &'a self,
        role: Role,
        scope: CompactionScope,
        agent: Option<&'a model::Ref>,
        session: Option<&'a model::Ref>,
    ) -> Option<&'a model::Ref> {
        if role == Role::Compaction {
            if let Some(ModelSelection::Model(selected)) = self.compaction_scopes.get(&scope) {
                return Some(selected);
            }
            return agent.or(session);
        }
        select_helper_model(agent, self.models.get(&role), session)
    }
    pub fn resolve<T, E>(
        &self,
        role: Role,
        scope: CompactionScope,
        agent: Option<&model::Ref>,
        session: Option<&model::Ref>,
        resolve: impl FnOnce(Option<&model::Ref>) -> Result<T, E>,
    ) -> Option<T> {
        resolve(self.select(role, scope, agent, session)).ok()
    }
}

fn selection(value: &JsonValue) -> Result<ModelSelection, DecodeError> {
    if value == &JsonValue::String("session".into()) {
        return Ok(ModelSelection::Session);
    }
    let path = ycoding_schema::JsonPath::default();
    let object = ycoding_schema::ObjectDecoder::new(value, &path)?;
    let reference = ObjectEncoder::new()
        .field("providerID", &object.field::<LosslessString>("providerID")?)
        .field("id", &object.field::<LosslessString>("model")?)
        .optional("variant", &object.optional::<LosslessString>("variant")?)
        .optional("profile", &object.optional::<LosslessString>("profile")?)
        .finish();
    model::Ref::decode(&reference).map(ModelSelection::Model)
}

pub fn select_helper_model<'a>(
    agent: Option<&'a model::Ref>,
    role: Option<&'a ModelSelection>,
    session: Option<&'a model::Ref>,
) -> Option<&'a model::Ref> {
    agent
        .or(match role {
            Some(ModelSelection::Model(reference)) => Some(reference),
            _ => session,
        })
        .or(session)
}

pub fn local_title(input: &LosslessString) -> LosslessString {
    let mut units = input.code_units().collect::<Vec<_>>();
    for (pattern, replacement) in [
        (r"\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)", ""),
        (r"(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]", ""),
        (
            r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]",
            " ",
        ),
    ] {
        units = RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "g")
            .expect("static helper pattern")
            .replace(
                &units,
                &replacement.encode_utf16().collect::<Vec<_>>(),
                &mut Budget::unlimited(),
            )
            .expect("unlimited static helper pattern");
    }
    let collapse = |input: &[u16]| {
        let mut output = vec![];
        for unit in input {
            if crate::process::guardrails::is_whitespace(*unit) {
                if !output.is_empty() && output.last() != Some(&32) {
                    output.push(32);
                }
                continue;
            }
            output.push(*unit);
        }
        if output.last() == Some(&32) {
            output.pop();
        }
        output
    };
    let first = units
        .split(|unit| *unit == 10)
        .map(collapse)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    let normalized = RegExp::new(
        &r"^(?:(?:#{1,6}|>|[-*+])\s+|\d+[.)]\s+)"
            .encode_utf16()
            .collect::<Vec<_>>(),
        "",
    )
    .expect("static helper pattern")
    .replace(&first, &[], &mut Budget::unlimited())
    .expect("unlimited static helper pattern");
    let normalized = collapse(&normalized);
    if normalized.is_empty() {
        return "New session".into();
    }
    let mut characters = vec![];
    let mut index = 0;
    while index < normalized.len() {
        let length = if (0xd800..=0xdbff).contains(&normalized[index])
            && normalized
                .get(index + 1)
                .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
        {
            2
        } else {
            1
        };
        characters.push(&normalized[index..index + length]);
        index += length;
    }
    if characters.len() <= 50 {
        return LosslessString::from_utf16(normalized);
    }
    LosslessString::from_utf16(
        characters[..47]
            .iter()
            .flat_map(|part| part.iter().copied())
            .chain([46, 46, 46])
            .collect(),
    )
}
