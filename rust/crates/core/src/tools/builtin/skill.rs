use super::{
    read::Read,
    read_filesystem,
    session_action::{decode, invalid},
};
use crate::{
    platform::filesystem,
    resources::{
        discovery::{markdown, trim as trim_text},
        mcp::skills as mcp_skills,
    },
    session::skill_status,
    tools::{
        context::{Context, consumers::ActiveSkill, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::{
    fs,
    path::Path,
    sync::{Arc, Weak},
};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder,
    llm::{ToolContent, ToolTextContent},
    mcp_skill, parse_json, session_message, session_skill_status, skill,
};

const FILE_LIMIT: usize = 10;
const DESCRIPTION: &str = "Load a specialized skill when the task at hand matches one of the available skills in the instructions.\n\nUse this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill.\n\nThe skill ID must match one of the available skills in the instructions.";
const INPUT_SCHEMA: &str = r#"{"type":"object","properties":{"id":{"type":"string","description":"The ID of the skill from the available skills list"},"resource":{"type":"string","description":"Supporting file path for an active skill. Relative paths resolve from its base directory; local skills also accept absolute paths inside that directory."}},"required":["id"],"additionalProperties":false}"#;
const OUTPUT_SCHEMA: &str = r#"{"type":"object","properties":{"name":{"type":"string"},"directory":{"type":"string"},"output":{"type":"string"},"alreadyActive":{"type":"boolean"},"conflicts":{"type":"object","properties":{"skills":{"type":"array","items":{"type":"string"}},"instructions":{"type":"array","items":{"type":"string"}}},"required":["skills","instructions"],"additionalProperties":false},"entry":{"type":"object","properties":{"server":{"type":"string"},"uri":{"type":"string"},"frontmatter":{"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"}},"required":["name","description"]},"resources":{"anyOf":[{"type":"array","items":{"type":"object","properties":{"uri":{"type":"string"},"digest":{"type":"string","pattern":"^sha256:[a-f0-9]{64}$"},"size":{"type":"integer","minimum":0}},"required":["uri","digest","size"],"additionalProperties":false}},{"const":"dynamic"}]}},"required":["server","uri","frontmatter","resources"],"additionalProperties":false}},"required":["name","directory","output"],"additionalProperties":false}"#;

pub struct SkillTool {
    pub skills: Arc<tokio::sync::Mutex<crate::resources::skill::Service>>,
    pub mcp: Weak<crate::resources::mcp::Service>,
    pub sessions: crate::session::store::Service,
    pub reader: Read,
    pub policy: Arc<LeafPolicy>,
    pub artifacts: Option<crate::resources::project_artifact::source::Service>,
}

impl Tool for SkillTool {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: DESCRIPTION.into(),
            input_schema: parse_json(INPUT_SCHEMA).expect("skill input schema parses"),
            output_schema: Some(parse_json(OUTPUT_SCHEMA).expect("skill output schema parses")),
            cache: None,
            metadata: None,
            native: None,
        }
    }
    fn permission(&self) -> Option<&str> {
        Some("skill")
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = decode(&input)?;
            let id: skill::Id = input.field("id").map_err(invalid)?;
            let resource: Option<LosslessString> = input.optional("resource").map_err(invalid)?;
            let output = self.run(id, resource, context).await?;
            Ok(ToolOutput {
                structured: output.encode(),
                content: vec![ToolContent::Text(ToolTextContent {
                    text: output.output,
                })],
            })
        })
    }
}

impl SkillTool {
    async fn run(
        &self,
        id: skill::Id,
        resource: Option<LosslessString>,
        context: Context,
    ) -> Result<Output, Failure> {
        if !self.skills.lock().await.allows(&id) {
            return Err(unable(&id));
        }
        let messages = self
            .sessions
            .transcript(&context.session_id)
            .map_err(|_| unable(&id))?;
        let active = skill_status::list(&messages, &[])
            .into_iter()
            .find(|status| status.id == id && status.state == session_skill_status::State::Active);
        let origin = id.as_str().and_then(mcp_skills::origin);
        if let Some(reference) = resource {
            let active = active.ok_or_else(|| unable(&id))?;
            if let Some((server, uri)) = origin {
                return self
                    .read_mcp_resource(&id, &reference, (&server, &uri), &messages, &context)
                    .await;
            }
            let local = self.local(&id).await?;
            let reference = reference
                .as_str()
                .ok_or_else(|| Failure::message("Skill resource is not Unicode"))?;
            return read_local_resource(
                &local,
                &ActiveSkill {
                    id,
                    name: active.name,
                    entry: None,
                },
                reference,
                &self.reader,
                context,
            )
            .await;
        }
        if let Some((server, uri)) = origin {
            return self
                .load_mcp(&id, (&server, &uri), &messages, &context)
                .await;
        }
        if let Some(active) = active {
            return Ok(already_active(&active.name));
        }
        let local = self.local(&id).await?;
        load_local(&local, &self.policy, context, self.artifacts.as_ref()).await
    }
    async fn local(&self, id: &skill::Id) -> Result<skill::Info, Failure> {
        self.skills
            .lock()
            .await
            .list()
            .await
            .map_err(|_| unable(id))?
            .into_iter()
            .find(|info| &info.id == id)
            .ok_or_else(|| unable(id))
    }
    async fn load_mcp(
        &self,
        id: &skill::Id,
        (server, uri): (&LosslessString, &LosslessString),
        messages: &[session_message::Info],
        context: &Context,
    ) -> Result<Output, Failure> {
        let mcp = self.mcp.upgrade().ok_or_else(|| unable(id))?;
        let entry = mcp
            .get_skill(&text(server), &text(uri))
            .await
            .map_err(|_| unable(id))?;
        if entry.resources == mcp_skill::Resources::Dynamic {
            return Err(unable(id));
        }
        let manifest = identity(&entry);
        if let Some(activation) = skill_status::mcp_activation(messages, id)
            && identity(&activation.entry) == manifest
        {
            return Ok(already_active(&activation.status.name));
        }
        self.assert_mcp(id, &entry, &manifest, context)
            .await
            .map_err(|error| settled(error, || unable(id)))?;
        let file = mcp
            .read_skill_resource(&text(&entry.server), &entry, &text(&entry.uri))
            .await
            .map_err(|_| unable(id))?;
        let body = match &file {
            mcp_skill::File::Text { text, .. } => text.as_str().map(str::to_owned),
            mcp_skill::File::Blob { blob, .. } => blob
                .as_str()
                .and_then(|blob| String::from_utf8(mcp_skills::decode_base64(blob)).ok()),
        }
        .ok_or_else(|| unable(id))?;
        let parsed = markdown::parse(&body).ok();
        let frontmatter = parsed
            .as_ref()
            .and_then(|parsed| parsed.data.json().ok())
            .unwrap_or(JsonValue::Null);
        mcp_skills::frontmatter(&entry, &frontmatter).map_err(|_| unable(id))?;
        let root = text(&entry.uri);
        let root = root.strip_suffix("/SKILL.md").unwrap_or(&root);
        let mut files = match &entry.resources {
            mcp_skill::Resources::Entries(resources) => resources
                .iter()
                .filter(|resource| resource.uri != entry.uri)
                .map(|resource| {
                    let uri = text(&resource.uri);
                    uri.strip_prefix(&format!("{root}/"))
                        .unwrap_or(&uri)
                        .to_owned()
                })
                .collect::<Vec<_>>(),
            mcp_skill::Resources::Dynamic => Vec::new(),
        };
        files.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        files.truncate(FILE_LIMIT);
        let server = xml(&text(&entry.server));
        let name = xml(&text(&entry.frontmatter.name));
        let lines = [
            format!("<skill_content name=\"{name}\" origin=\"{server}\">"),
            format!("# Skill: {name}"),
            String::new(),
            trim_text(parsed.as_ref().map_or("", |parsed| &parsed.content)).to_owned(),
            String::new(),
            format!("Base directory for this skill: {}", xml(root)),
            format!(
                "This skill is served over MCP by \"{server}\". Relative paths in this skill (e.g., scripts/, reference/) are relative to the base directory above and are read with the skill tool's resource input."
            ),
            "Note: file list is sampled.".into(),
            String::new(),
            "<skill_files>".into(),
        ];
        let lines = lines
            .into_iter()
            .chain(
                files
                    .iter()
                    .map(|file| format!("<file>{}</file>", xml(file))),
            )
            .chain(["</skill_files>".into(), "</skill_content>".into()])
            .collect::<Vec<_>>();
        Ok(Output {
            name: entry.frontmatter.name.clone(),
            directory: String::new(),
            output: lines.join("\n").into(),
            already_active: None,
            conflicts: None,
            entry: Some(entry),
        })
    }
    async fn read_mcp_resource(
        &self,
        id: &skill::Id,
        reference: &LosslessString,
        (server, uri): (&LosslessString, &LosslessString),
        messages: &[session_message::Info],
        context: &Context,
    ) -> Result<Output, Failure> {
        let reference = text(reference);
        let failure =
            || Failure::message(format!("Unable to read {reference} for skill {}", text(id)));
        let activation = skill_status::mcp_activation(messages, id)
            .filter(|activation| &activation.entry.server == server && &activation.entry.uri == uri)
            .ok_or_else(|| unable(id))?;
        let entry =
            mcp_skills::entry(server, &activation.entry.encode()).map_err(|_| unable(id))?;
        if entry.resources == mcp_skill::Resources::Dynamic {
            return Err(unable(id));
        }
        let resource = mcp_skills::resolve(&entry, &reference).ok_or_else(failure)?;
        let mcp = self.mcp.upgrade().ok_or_else(failure)?;
        self.assert_mcp(id, &entry, &identity(&entry), context)
            .await
            .map_err(|error| settled(error, failure))?;
        let file = mcp
            .read_skill_resource(&text(server), &entry, &resource)
            .await
            .map_err(|_| failure())?;
        Ok(Output {
            name: activation.status.name,
            directory: String::new(),
            output: render_resource(&file),
            already_active: Some(true),
            conflicts: None,
            entry: None,
        })
    }
    async fn assert_mcp(
        &self,
        id: &skill::Id,
        entry: &mcp_skill::Entry,
        identity: &str,
        context: &Context,
    ) -> Result<(), Failure> {
        let JsonValue::Object(metadata) = ObjectEncoder::new()
            .field("server", &entry.server)
            .field("uri", &entry.uri)
            .field("manifest", &entry.resources)
            .finish()
        else {
            return Err(Failure::Defect(
                "MCP skill metadata is not an object".into(),
            ));
        };
        let resources = vec![id.clone(), identity.into()];
        self.policy
            .assert(
                context,
                "skill",
                resources.clone(),
                resources,
                Some(metadata),
            )
            .await
    }
}

fn identity(entry: &mcp_skill::Entry) -> String {
    mcp_skills::identity_by(entry, |left, right| left.cmp(right))
}
fn unable(id: &skill::Id) -> Failure {
    Failure::message(format!("Unable to load skill {}", text(id)))
}
fn settled(error: Failure, otherwise: impl FnOnce() -> Failure) -> Failure {
    match error {
        Failure::Cancelled | Failure::Defect(_) => error,
        _ => otherwise(),
    }
}
fn already_active(name: &skill::Name) -> Output {
    Output {
        name: name.clone(),
        directory: String::new(),
        output: format!("Skill {} is already active for this session.", text(name)).into(),
        already_active: Some(true),
        conflicts: None,
        entry: None,
    }
}
fn render_resource(file: &mcp_skill::File) -> LosslessString {
    let (uri, mime_type, body, encoded) = match file {
        mcp_skill::File::Text {
            uri,
            mime_type,
            text,
            ..
        } => (uri, mime_type, text, false),
        mcp_skill::File::Blob {
            uri,
            mime_type,
            blob,
            ..
        } => (uri, mime_type, blob, true),
    };
    let mime = mime_type
        .as_ref()
        .map(|mime| format!(" mime_type=\"{}\"", xml(&text(mime))))
        .unwrap_or_default();
    let encoding = if encoded { " encoding=\"base64\"" } else { "" };
    format!(
        "<skill_resource uri=\"{}\"{mime}{encoding}>\n{}\n</skill_resource>",
        xml(&text(uri)),
        text(body)
    )
    .into()
}
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

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
