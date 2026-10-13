use ycoding_schema::{
    DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, instruction, mcp_skill,
    session_message::{self, AssistantContent, Compaction, ToolState},
    session_skill_status::{Conflict, Info, State},
    skill,
};

const SKILL_TOOL: &str = "skill";

#[derive(Clone, Debug, PartialEq)]
pub struct McpActivation {
    pub status: Info,
    pub entry: mcp_skill::Entry,
}

struct ToolActivation {
    id: skill::Id,
    name: skill::Name,
    output: LosslessString,
    already_active: bool,
    conflicts: Option<skill::Conflicts>,
    entry: Option<mcp_skill::Entry>,
}

pub fn list(
    messages: &[session_message::Info],
    instruction_keys: &[instruction::Key],
) -> Vec<Info> {
    let mut statuses = Vec::<Info>::new();
    for message in messages {
        fold(&mut statuses, message);
    }
    finish(statuses, instruction_keys)
}

pub(super) fn fold(statuses: &mut Vec<Info>, message: &session_message::Info) {
    match message {
        session_message::Info::Skill(skill) => {
            upsert(
                statuses,
                Info {
                    id: skill.skill.clone(),
                    name: skill.name.clone(),
                    activated_by: "reference".into(),
                    activation_message_id: skill.id.clone(),
                    content: skill.text.clone(),
                    conflicts: Vec::new(),
                    declarations: skill.conflicts.clone().unwrap_or_else(no_declarations),
                    state: State::Active,
                },
            );
            deactivate(statuses, skill.skill_deactivations.as_deref());
        }
        session_message::Info::Assistant(assistant) => {
            for activation in assistant.content.iter().filter_map(tool_activation) {
                if activation.already_active {
                    continue;
                }
                upsert(
                    statuses,
                    Info {
                        id: activation.id,
                        name: activation.name,
                        activated_by: "tool".into(),
                        activation_message_id: assistant.id.clone(),
                        content: activation.output,
                        conflicts: Vec::new(),
                        declarations: activation.conflicts.unwrap_or_else(no_declarations),
                        state: State::Active,
                    },
                );
            }
            deactivate(statuses, assistant.skill_deactivations.as_deref());
        }
        session_message::Info::AgentSelected(_) => deactivate_all(statuses, "agent_switched"),
        session_message::Info::Compaction(
            Compaction::Completed(_) | Compaction::CompletedV1(_),
        ) => deactivate_all(statuses, "compacted"),
        _ => {}
    }
}

pub(super) fn finish(statuses: Vec<Info>, instruction_keys: &[instruction::Key]) -> Vec<Info> {
    let conflicts = statuses
        .iter()
        .map(|status| conflicts_of(status, &statuses, instruction_keys))
        .collect::<Vec<_>>();
    statuses
        .into_iter()
        .zip(conflicts)
        .map(|(status, conflicts)| Info {
            conflicts,
            ..status
        })
        .collect()
}

pub fn mcp_activation(messages: &[session_message::Info], id: &skill::Id) -> Option<McpActivation> {
    let status = list(messages, &[])
        .into_iter()
        .find(|candidate| &candidate.id == id && candidate.state == State::Active)
        .filter(|status| status.activated_by.as_str() == Some("tool"))?;
    let session_message::Info::Assistant(assistant) = messages.iter().find(|message| {
        matches!(message, session_message::Info::Assistant(assistant) if assistant.id == status.activation_message_id)
    })?
    else {
        return None;
    };
    assistant
        .content
        .iter()
        .rev()
        .filter_map(tool_activation)
        .find(|activation| {
            &activation.id == id && !activation.already_active && activation.entry.is_some()
        })
        .and_then(|activation| activation.entry)
        .map(|entry| McpActivation { status, entry })
}

fn no_declarations() -> skill::Conflicts {
    skill::Conflicts {
        skills: Vec::new(),
        instructions: Vec::new(),
    }
}

fn upsert(statuses: &mut Vec<Info>, status: Info) {
    match statuses
        .iter_mut()
        .find(|existing| existing.id == status.id)
    {
        Some(existing) => *existing = status,
        None => statuses.push(status),
    }
}

fn deactivate(statuses: &mut [Info], deactivations: Option<&[session_message::SkillDeactivation]>) {
    for deactivation in deactivations.unwrap_or_default() {
        if let Some(status) = statuses
            .iter_mut()
            .find(|status| status.id == deactivation.skill)
        {
            status.state = State::Inactive {
                inactive_reason: deactivation.reason.clone(),
            };
        }
    }
}

fn deactivate_all(statuses: &mut [Info], reason: &str) {
    for status in statuses {
        status.state = State::Inactive {
            inactive_reason: reason.into(),
        };
    }
}

fn conflicts_of(
    status: &Info,
    statuses: &[Info],
    instruction_keys: &[instruction::Key],
) -> Vec<Conflict> {
    if status.state != State::Active {
        return Vec::new();
    }
    let active = |id: &skill::Id| {
        statuses
            .iter()
            .find(|candidate| &candidate.id == id && candidate.state == State::Active)
    };
    let mut related = status.declarations.skills.clone();
    for source in statuses
        .iter()
        .filter(|candidate| candidate.state == State::Active)
        .filter(|candidate| candidate.declarations.skills.contains(&status.id))
    {
        related.push(source.id.clone());
    }
    let mut seen = Vec::<&skill::Id>::new();
    let skills = related
        .iter()
        .filter(|id| {
            if seen.contains(id) {
                return false;
            }
            seen.push(id);
            true
        })
        .filter(|id| **id != status.id)
        .filter_map(|id| {
            active(id).map(|target| Conflict {
                r#type: "skill".into(),
                id: id.clone(),
                name: target.name.clone(),
            })
        });
    let instructions = status
        .declarations
        .instructions
        .iter()
        .filter(|key| instruction_keys.contains(key))
        .filter_map(|key| match key.encode() {
            JsonValue::String(text) => Some(Conflict {
                r#type: "instruction".into(),
                id: text.clone(),
                name: text,
            }),
            _ => None,
        });
    skills.chain(instructions).collect()
}

fn tool_activation(content: &AssistantContent) -> Option<ToolActivation> {
    let AssistantContent::Tool(tool) = content else {
        return None;
    };
    if tool.name.as_str() != Some(SKILL_TOOL) {
        return None;
    }
    let ToolState::Completed(state) = &tool.state else {
        return None;
    };
    let path = JsonPath::default();
    let input = JsonValue::Object(state.input.clone());
    let output = JsonValue::Object(state.structured.clone());
    let input = ObjectDecoder::new(&input, &path).ok()?;
    let output = ObjectDecoder::new(&output, &path).ok()?;
    let _directory: LosslessString = output.field("directory").ok()?;
    Some(ToolActivation {
        id: input.field("id").ok()?,
        name: output.field("name").ok()?,
        output: output.field("output").ok()?,
        already_active: output.optional("alreadyActive").ok()?.unwrap_or(false),
        conflicts: output.optional("conflicts").ok()?,
        entry: output.optional("entry").ok()?,
    })
}
