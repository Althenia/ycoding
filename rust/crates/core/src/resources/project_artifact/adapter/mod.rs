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
pub fn render(input: &project_artifact::Definition) -> LosslessString {
    let (name, description, body, extra) = match input {
        project_artifact::Definition::Skill(value) => (
            &value.name,
            &value.description,
            value.content.as_lossless(),
            String::new(),
        ),
        project_artifact::Definition::Command(value) => (
            &value.name,
            &value.description,
            value.template.as_lossless(),
            "subtask: false\n".into(),
        ),
        project_artifact::Definition::Agent(value) => (
            &value.name,
            &value.description,
            value.system.as_lossless(),
            format!(
                "mode: subagent\n{}\n",
                render_permissions(&value.permissions)
            ),
        ),
        project_artifact::Definition::Plugin(value) => return value.draft.as_lossless().clone(),
    };
    discovery::join(
        &[
            format!(
                "---\nname: {}\ndescription: {}\n{extra}---\n",
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
            value.insert("content".into(), JsonValue::String(markdown.content.into()));
        }
        Some("command") => {
            value.insert(
                "template".into(),
                JsonValue::String(markdown.content.into()),
            );
            value.insert("subtask".into(), JsonValue::Bool(false));
        }
        _ => {
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
