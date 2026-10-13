use super::{read::Read, read_filesystem};
use crate::{
    platform::filesystem,
    tools::{
        context::{Context, consumers::ActiveSkill, policy::LeafPolicy},
        registry::Failure,
    },
};
use std::{fs, path::Path};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, mcp_skill, skill,
};

pub struct Output {
    pub name: skill::Name,
    pub directory: String,
    pub output: LosslessString,
    pub already_active: Option<bool>,
    pub conflicts: Option<skill::Conflicts>,
    pub entry: Option<mcp_skill::Entry>,
}
impl DomainEncode for Output {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .field("directory", self.directory.as_str())
            .field("output", &self.output)
            .optional("alreadyActive", &self.already_active)
            .optional("conflicts", &self.conflicts)
            .optional("entry", &self.entry)
            .finish()
    }
}
pub async fn load_local(
    info: &skill::Info,
    policy: &LeafPolicy,
    context: Context,
    artifact_source: Option<&crate::resources::project_artifact::source::Service>,
) -> Result<Output, Failure> {
    policy
        .assert(
            &context,
            "skill",
            vec![info.id.clone()],
            vec![info.id.clone()],
            None,
        )
        .await
        .map_err(|error| match error {
            Failure::Cancelled | Failure::Defect(_) => error,
            _ => Failure::message(format!("Unable to load skill {}", text(&info.id))),
        })?;
    let location = info
        .location
        .as_lossless()
        .as_str()
        .ok_or_else(|| Failure::message(format!("Unable to load skill {}", text(&info.id))))?;
    let directory = Path::new(location)
        .parent()
        .ok_or_else(|| Failure::message(format!("Unable to load skill {}", text(&info.id))))?;
    let mut files = if Path::new(location)
        .file_name()
        .is_some_and(|name| name == "SKILL.md")
    {
        filesystem::util::scan(
            "**/*",
            &filesystem::util::ScanOptions {
                cwd: directory.into(),
                absolute: true,
                dot: true,
                symlink: true,
                ..Default::default()
            },
        )
        .map_err(|_| Failure::message(format!("Unable to load skill {}", text(&info.id))))?
        .into_iter()
        .filter(|file| {
            Path::new(file)
                .file_name()
                .is_none_or(|name| name != "SKILL.md")
        })
        .collect::<Vec<_>>()
    } else {
        vec![]
    };
    files.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    files.truncate(10);
    if let Some(source) = artifact_source {
        use crate::resources::project_artifact::source::{ActivationInput, ActivationSource};
        if source
            .activate(ActivationInput {
                kind: ycoding_schema::project_artifact::Kind::decode(&JsonValue::String(
                    "skill".into(),
                ))
                .expect("fixed kind"),
                id: info.id.clone(),
                session_id: context.session_id.clone(),
                agent_id: Some(context.agent.clone()),
                source: ActivationSource::SkillTool {
                    message_id: context.message_id.as_lossless().clone(),
                    call_id: Some(context.call_id.clone()),
                },
            })
            .is_err()
        {
            source.record_activation_failure();
        }
    }
    Ok(Output {
        name: info.name.clone(),
        directory: directory.to_string_lossy().into_owned(),
        output: to_model_output(info, &files),
        already_active: None,
        conflicts: info.conflicts.clone(),
        entry: None,
    })
}
pub fn to_model_output(info: &skill::Info, files: &[String]) -> LosslessString {
    let directory = Path::new(info.location.as_lossless().as_str().unwrap_or(""))
        .parent()
        .unwrap_or(Path::new("."))
        .to_string_lossy();
    let name = escape_xml(&info.name);
    let body = trim(&info.content);
    LosslessString::from_utf16(format!("<skill_content name=\"{name}\">\n# Skill: {name}\n\n").encode_utf16().chain(body.code_units()).chain(format!("\n\nBase directory for this skill: {}\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory. Read supporting files with the skill tool's resource input.\nNote: file list is sampled.\n\n<skill_files>\n{}</skill_files>\n</skill_content>", escape_xml(&directory.as_ref().into()), files.iter().map(|file| format!("<file>{}</file>\n", escape_xml(&file.as_str().into()))).collect::<String>()).encode_utf16()).collect())
}
pub async fn read_local_resource(
    info: &skill::Info,
    active: &ActiveSkill,
    reference: &str,
    reader: &Read,
    context: Context,
) -> Result<Output, Failure> {
    if active.id != info.id {
        return Err(Failure::message(format!(
            "Unable to load skill {}",
            text(&info.id)
        )));
    }
    let result = async {
        let location = info
            .location
            .as_lossless()
            .as_str()
            .ok_or_else(|| Failure::message("Skill path is not Unicode"))?;
        let base = Path::new(location)
            .parent()
            .ok_or_else(|| Failure::message("Skill has no directory"))?;
        let target = filesystem::normalize(&base.join(reference));
        if !filesystem::contains(base, &target) {
            return Err(Failure::message("Skill resource escapes its directory"));
        }
        let real_base =
            fs::canonicalize(base).map_err(|error| Failure::message(error.to_string()))?;
        let real = fs::canonicalize(target).map_err(|error| Failure::message(error.to_string()))?;
        if !filesystem::contains(&real_base, &real) {
            return Err(Failure::message("Skill resource escapes its directory"));
        }
        let (target, directory) = reader
            .authorize(
                real.to_str()
                    .ok_or_else(|| Failure::message("Skill resource is not Unicode"))?,
                &context,
            )
            .await?;
        if directory {
            return Err(Failure::message("Skill resource is not a file"));
        }
        let output = read_filesystem::read(
            &target.mutation.canonical,
            &target.mutation.resource,
            Default::default(),
        )
        .map_err(|error| Failure::message(error.to_string()))?;
        let JsonValue::Object(output) = output else {
            return Err(Failure::Defect("Resource output is not an object".into()));
        };
        let uri = match output.get(&"uri".into()) {
            Some(JsonValue::String(uri)) => uri.clone(),
            _ => url::Url::from_file_path(real).unwrap().as_str().into(),
        };
        let mime = match output.get(&"mime".into()) {
            Some(JsonValue::String(mime)) => mime.clone(),
            _ => return Err(Failure::Defect("Resource output has no MIME".into())),
        };
        let content = match output.get(&"content".into()) {
            Some(JsonValue::String(content)) => content.clone(),
            _ => return Err(Failure::Defect("Resource output has no content".into())),
        };
        let encoded = output.get(&"encoding".into()) == Some(&JsonValue::String("base64".into()));
        Ok(Output {
            name: active.name.clone(),
            directory: String::new(),
            output: LosslessString::from_utf16(
                format!(
                    "<skill_resource uri=\"{}\" mime_type=\"{}\"{}>\n",
                    escape_xml(&uri),
                    escape_xml(&mime),
                    if encoded { " encoding=\"base64\"" } else { "" }
                )
                .encode_utf16()
                .chain(content.code_units())
                .chain("\n</skill_resource>".encode_utf16())
                .collect(),
            ),
            already_active: Some(true),
            conflicts: None,
            entry: None,
        })
    }
    .await;
    result.map_err(|error| match error {
        Failure::Cancelled | Failure::Defect(_) => error,
        _ => Failure::message(format!(
            "Unable to read {reference} for skill {}",
            text(&info.id)
        )),
    })
}
fn text(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}
fn escape_xml(value: &LosslessString) -> String {
    text(value)
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn trim(value: &LosslessString) -> LosslessString {
    let units = value.code_units().collect::<Vec<_>>();
    let whitespace = |unit: &u16| {
        char::from_u32(u32::from(*unit)).is_some_and(crate::resources::discovery::whitespace)
    };
    let start = units.iter().take_while(|unit| whitespace(unit)).count();
    let end = units.len()
        - units[start..]
            .iter()
            .rev()
            .take_while(|unit| whitespace(unit))
            .count();
    LosslessString::from_utf16(units[start..end].to_vec())
}
