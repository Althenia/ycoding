use crate::resources::{agent, command, discovery, skill};
use std::{
    fmt,
    path::{Path, PathBuf},
};
use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, permission,
    project_artifact, provider,
};

#[derive(Debug)]
pub enum Error {
    Decode(DecodeError),
    Markdown(discovery::markdown::Error),
    Discovery(discovery::Error),
    UnsupportedPlugin,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode(error) => error.fmt(f),
            Self::Markdown(error) => error.fmt(f),
            Self::Discovery(error) => error.fmt(f),
            Self::UnsupportedPlugin => {
                f.write_str("Plugin Project Artifacts are unsupported in Phase 1")
            }
        }
    }
}
impl std::error::Error for Error {}

pub struct Adapter {
    pub kind: project_artifact::Kind,
    pub phase: &'static str,
}
pub struct VersionIndex {
    pub scope_id: project_artifact::ScopeId,
    pub version_id: project_artifact::VersionId,
    pub id: project_artifact::Id,
    pub content_path: PathBuf,
    pub definition: project_artifact::Definition,
}
#[derive(Default)]
pub struct RuntimeDraft<'a> {
    pub skill: Option<&'a mut skill::Service>,
    pub command: Option<&'a mut command::Service>,
    pub agent: Option<&'a mut agent::Service>,
}

pub fn list() -> [Adapter; 4] {
    ["skill", "command", "agent", "plugin"].map(|kind| Adapter {
        kind: project_artifact::Kind::decode(&JsonValue::String(kind.into()))
            .expect("fixed adapter kind"),
        phase: if kind == "plugin" {
            "unsupported"
        } else {
            "enabled"
        },
    })
}
pub fn get(kind: &project_artifact::Kind) -> Adapter {
    Adapter {
        kind: kind.clone(),
        phase: if kind.as_lossless().as_str() == Some("plugin") {
            "unsupported"
        } else {
            "enabled"
        },
    }
}
pub fn kind(definition: &project_artifact::Definition) -> project_artifact::Kind {
    project_artifact::Kind::decode(&JsonValue::String(
        match definition {
            project_artifact::Definition::Skill(_) => "skill",
            project_artifact::Definition::Command(_) => "command",
            project_artifact::Definition::Agent(_) => "agent",
            project_artifact::Definition::Plugin(_) => "plugin",
        }
        .into(),
    ))
    .expect("fixed definition kind")
}
pub fn decode(
    kind: &project_artifact::Kind,
    input: &JsonValue,
) -> Result<project_artifact::Definition, Error> {
    let definition = project_artifact::Definition::decode(input).map_err(Error::Decode)?;
    if &self::kind(&definition) == kind {
        return Ok(definition);
    }
    Err(Error::Decode(ycoding_schema::JsonPath::default().error(
        ycoding_schema::DecodeErrorKind::Expected("matching adapter kind"),
    )))
}
pub fn render(id: &project_artifact::Id, input: &project_artifact::Definition) -> LosslessString {
    let (name, description, tags, body, extra) = match input {
        project_artifact::Definition::Skill(value) => {
            return discovery::join(
                &[
                    format!(
                        "---\nname: {}\ndescription: {}\nmetadata:\n{}---\n",
                        ycoding_schema::stringify_json(&id.encode()),
                        ycoding_schema::stringify_json(&value.description.encode()),
                        skill_metadata(value)
                    )
                    .into(),
                    value.content.as_lossless().clone(),
                ],
                "",
            );
        }
        project_artifact::Definition::Command(value) => (
            &value.name,
            &value.description,
            value.tags.as_slice(),
            value.template.as_lossless(),
            "subtask: false\n".into(),
        ),
        project_artifact::Definition::Agent(value) => (
            &value.name,
            &value.description,
            value.tags.as_slice(),
            value.system.as_lossless(),
            format!(
                "mode: subagent\n{}\n",
                render_permissions(&value.permissions)
            ),
        ),
        project_artifact::Definition::Plugin(value) => return value.draft.as_lossless().clone(),
    };
    let tags = if tags.is_empty() {
        String::new()
    } else {
        format!(
            "tags: {}\n",
            ycoding_schema::stringify_json(&tags.to_vec().encode())
        )
    };
    discovery::join(
        &[
            format!(
                "---\nname: {}\ndescription: {}\n{tags}{extra}---\n",
                ycoding_schema::stringify_json(&name.encode()),
                ycoding_schema::stringify_json(&description.encode())
            )
            .into(),
            body.clone(),
        ],
        "",
    )
}
pub fn parse(
    kind: &project_artifact::Kind,
    content: &str,
) -> Result<project_artifact::Definition, Error> {
    if kind.as_lossless().as_str() == Some("plugin") {
        return decode(
            kind,
            &ObjectEncoder::new()
                .field("kind", kind)
                .field("name", &LosslessString::from("Plugin draft"))
                .field(
                    "description",
                    &LosslessString::from("Quarantined plugin draft"),
                )
                .field("draft", &LosslessString::from(content))
                .finish(),
        );
    }
    let markdown = discovery::markdown::parse(content).map_err(Error::Markdown)?;
    let mut value = markdown
        .data
        .fields(&["name", "description"])
        .map_err(Error::Markdown)?;
    value.insert("kind".into(), kind.encode());
    match kind.as_lossless().as_str() {
        Some("skill") => {
            if let Some(display) = markdown
                .data
                .get("metadata")
                .and_then(|metadata| metadata.get("display-name"))
            {
                value.insert("name".into(), display.json().map_err(Error::Markdown)?);
            }
            if let Some(tags) = markdown
                .data
                .get("metadata")
                .and_then(|metadata| metadata.get("tags"))
                .and_then(|tags| tags.json().ok())
            {
                value.insert("tags".into(), split_tags(&tags));
            }
            if let Some(activation) = parse_activation(&markdown.data)? {
                value.insert("activation".into(), activation);
            }
            value.insert("content".into(), JsonValue::String(markdown.content.into()));
        }
        Some("command") => {
            insert_tags(&mut value, &markdown.data)?;
            value.insert(
                "template".into(),
                JsonValue::String(markdown.content.into()),
            );
            value.insert("subtask".into(), JsonValue::Bool(false));
        }
        _ => {
            insert_tags(&mut value, &markdown.data)?;
            value.insert("system".into(), JsonValue::String(markdown.content.into()));
            value.insert("mode".into(), JsonValue::String("subagent".into()));
            value.insert(
                "permissions".into(),
                markdown
                    .data
                    .get("permissions")
                    .map(|value| value.json())
                    .transpose()
                    .map_err(Error::Markdown)?
                    .unwrap_or(JsonValue::Array(Vec::new())),
            );
        }
    }
    decode(kind, &JsonValue::Object(value))
}
pub fn project_path(kind: &project_artifact::Kind, root: &Path, id: &str) -> PathBuf {
    match kind.as_lossless().as_str() {
        Some("skill") => root.join("active/skills").join(id).join("SKILL.md"),
        Some("command") => root.join("active/commands").join(format!("{id}.md")),
        Some("agent") => root.join("active/agents").join(format!("{id}.md")),
        _ => root
            .join("disabled/plugins")
            .join(id)
            .join(format!("{id}.ts")),
    }
}
pub fn global_path(kind: &project_artifact::Kind, home: &Path, config: &Path, id: &str) -> PathBuf {
    match kind.as_lossless().as_str() {
        Some("skill") => home.join(".agents/skills").join(id).join("SKILL.md"),
        Some("command") => config.join("commands").join(format!("{id}.md")),
        Some("agent") => config.join("agents").join(format!("{id}.md")),
        _ => config.join("plugins").join(format!("{id}.ts")),
    }
}
pub fn activate(version: &VersionIndex, draft: RuntimeDraft<'_>) -> Result<(), Error> {
    match &version.definition {
        project_artifact::Definition::Plugin(_) => return Err(Error::UnsupportedPlugin),
        project_artifact::Definition::Skill(_) => {
            if let Some(service) = draft.skill {
                let path = version
                    .content_path
                    .parent()
                    .and_then(Path::parent)
                    .ok_or_else(|| {
                        Error::Discovery(discovery::Error::InvalidPath(
                            version.content_path.clone(),
                        ))
                    })?;
                service.source(ycoding_schema::skill::Source::Directory(
                    ycoding_schema::skill::DirectorySource {
                        path: discovery::absolute_path(path).map_err(Error::Discovery)?,
                    },
                ));
            }
        }
        project_artifact::Definition::Command(value) => {
            if let Some(service) = draft.command {
                let location =
                    discovery::absolute_path(&version.content_path).map_err(Error::Discovery)?;
                service.update(version.id.as_lossless().clone(), |command| {
                    command.template = value.template.as_lossless().clone();
                    command.description = Some(value.description.as_lossless().clone());
                    command.subtask = Some(false);
                    command.locations = Some(vec![location]);
                    command.agent = None;
                    command.model = None;
                });
            }
        }
        project_artifact::Definition::Agent(value) => {
            if let Some(service) = draft.agent {
                let location =
                    discovery::absolute_path(&version.content_path).map_err(Error::Discovery)?;
                service.update(version.id.as_lossless().clone(), |agent| {
                    agent.name = value.name.as_lossless().clone();
                    agent.description = Some(value.description.as_lossless().clone());
                    agent.system = Some(value.system.as_lossless().clone());
                    agent.mode = "subagent".into();
                    agent.hidden = false;
                    agent.model = None;
                    agent.request = provider::Request {
                        settings: provider::Settings::default(),
                        headers: ycoding_schema::JsonObject::new(),
                        body: provider::Settings::default(),
                    };
                    agent.permissions = managed_defaults()
                        .into_iter()
                        .chain(value.permissions.iter().cloned())
                        .collect();
                    agent.locations = Some(vec![location]);
                });
            }
        }
    }
    Ok(())
}
pub fn managed_defaults() -> permission::Ruleset {
    [
        ("*", "deny"),
        ("read", "allow"),
        ("glob", "allow"),
        ("grep", "allow"),
        ("webfetch", "allow"),
        ("websearch", "allow"),
        ("edit", "ask"),
        ("write", "ask"),
        ("patch", "ask"),
        ("shell", "ask"),
        ("question", "allow"),
        ("subagent", "deny"),
    ]
    .map(|(action, effect)| permission::Rule {
        action: action.into(),
        resource: "*".into(),
        effect: permission::Effect(effect.into()),
    })
    .into()
}

#[derive(Clone)]
pub struct Existing<'a> {
    pub scope: &'a str,
    pub scope_id: Option<&'a str>,
    pub version_id: &'a str,
}
#[derive(Debug, PartialEq)]
pub struct Collision {
    pub diagnostic_type: &'static str,
    pub allowed: bool,
}
pub fn collision(existing: &[Existing<'_>], shadow: Option<(&str, &str)>) -> Option<Collision> {
    if existing.is_empty() {
        return None;
    }
    if existing.len() == 1
        && shadow.is_some_and(|(scope, version)| {
            existing[0].scope == "global"
                && existing[0].scope_id == Some(scope)
                && existing[0].version_id == version
        })
    {
        return Some(Collision {
            diagnostic_type: "project-over-global-shadow",
            allowed: true,
        });
    }
    Some(Collision {
        diagnostic_type: if existing.iter().any(|item| item.scope == "global") {
            "cross-scope"
        } else {
            "existing-source"
        },
        allowed: false,
    })
}

fn skill_metadata(value: &project_artifact::SkillDefinition) -> String {
    let mut lines = vec![format!(
        "  display-name: {}\n",
        ycoding_schema::stringify_json(&value.name.encode())
    )];
    if !value.tags.is_empty() {
        lines.push(format!(
            "  tags: {}\n",
            ycoding_schema::stringify_json(&JsonValue::String(
                value
                    .tags
                    .iter()
                    .filter_map(|tag| tag.as_lossless().as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
                    .as_str()
                    .into()
            ))
        ));
    }
    if let Some(JsonValue::Object(fields)) = value.activation.as_ref().map(DomainEncode::encode) {
        lines.push("  activation: \"auto\"\n".into());
        lines.extend(fields.iter().filter_map(|(key, value)| {
            Some(format!(
                "  {}: {}\n",
                key.as_str()?,
                ycoding_schema::stringify_json(value)
            ))
        }));
    }
    lines.concat()
}

fn split_tags(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::String(text) => JsonValue::Array(
            text.as_str()
                .map(|text| {
                    text.split(',')
                        .map(|tag| JsonValue::String(tag.trim().into()))
                        .collect()
                })
                .unwrap_or_default(),
        ),
        other => other.clone(),
    }
}

fn insert_tags(
    value: &mut ycoding_schema::JsonObject,
    data: &discovery::markdown::Value,
) -> Result<(), Error> {
    if let Some(tags) = data.get("tags") {
        value.insert("tags".into(), tags.json().map_err(Error::Markdown)?);
    }
    Ok(())
}

fn parse_activation(data: &discovery::markdown::Value) -> Result<Option<JsonValue>, Error> {
    let Some(metadata) = data.get("metadata") else {
        return Ok(None);
    };
    if !matches!(
        metadata.get("activation").map(|value| value.json()),
        Some(Ok(JsonValue::String(mode))) if mode.as_str() == Some("auto")
    ) {
        return Ok(None);
    }
    let mut fields = ycoding_schema::JsonObject::new();
    for key in ["version", "keywords", "events", "commands", "paths"] {
        if let Some(value) = metadata.get(key) {
            fields.insert(key.into(), value.json().map_err(Error::Markdown)?);
        }
    }
    let value = JsonValue::Object(fields);
    Ok(project_artifact::SkillActivation::decode(&value)
        .is_ok()
        .then_some(value))
}

fn render_permissions(rules: &permission::Ruleset) -> String {
    if rules.is_empty() {
        return "permissions: []".into();
    }
    std::iter::once("permissions:".to_string())
        .chain(rules.iter().flat_map(|rule| {
            [
                format!(
                    "  - action: {}",
                    ycoding_schema::stringify_json(&rule.action.encode())
                ),
                format!(
                    "    resource: {}",
                    ycoding_schema::stringify_json(&rule.resource.encode())
                ),
                format!(
                    "    effect: {}",
                    rule.effect.0.as_str().expect("validated permission effect")
                ),
            ]
        }))
        .collect::<Vec<_>>()
        .join("\n")
}
