use super::{
    native::definition,
    session_action::{decode, invalid, output},
};
use crate::{
    coordination::{
        Error,
        runtime::{self, Runtime},
    },
    tools::{
        context::Context,
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::sync::{Arc, OnceLock};
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, stringify_json,
};

pub const NAME: &str = "project";
pub struct Project {
    pub runtime: Arc<OnceLock<Runtime>>,
}
impl Tool for Project {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("project.tool.json"))
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, value: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let operation = input(&value)?;
            if context.cancellation.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            let runtime = self
                .runtime
                .get()
                .ok_or_else(|| Failure::Defect("Project runtime is not bound".into()))?;
            let caller = &context.session_id;
            let value = match operation {
                Input::List => flatten(
                    "list",
                    runtime.roster(caller).await.map_err(failure)?.encode(),
                )?,
                Input::Inspect(input) => ObjectEncoder::new()
                    .field("action", "inspect")
                    .field(
                        "request",
                        &runtime.inspect(caller, input).await.map_err(failure)?,
                    )
                    .finish(),
                Input::Send(input) => flatten(
                    "send",
                    runtime.send(caller, input).await.map_err(failure)?.encode(),
                )?,
                Input::Answer(input) => ObjectEncoder::new()
                    .field("action", "answer")
                    .field(
                        "result",
                        &runtime.answer(caller, input).await.map_err(failure)?,
                    )
                    .finish(),
                Input::Escalate(input) => {
                    let result = runtime.escalate(caller, input).await.map_err(failure)?;
                    let mut value = flatten("escalate", result.encode())?;
                    if result.decision.to == Some(runtime::EscalationTarget::Client) {
                        let title = runtime
                            .roster(caller)
                            .await
                            .map_err(failure)?
                            .members
                            .into_iter()
                            .find(|member| member.session_id == result.session_id)
                            .map(|member| member.title);
                        if let JsonValue::Object(fields) = &mut value {
                            fields.insert(
                                "guidance".into(),
                                guidance(
                                    &result.session_id,
                                    result.request_session_id.as_ref(),
                                    title.as_ref(),
                                )
                                .as_str()
                                .encode(),
                            );
                        }
                    }
                    value
                }
                Input::Interrupt(input) => flatten(
                    "interrupt",
                    runtime
                        .interrupt(caller, input)
                        .await
                        .map_err(failure)?
                        .encode(),
                )?,
                Input::Assign(input) => flatten(
                    "assign",
                    runtime
                        .assign(caller, input)
                        .await
                        .map_err(failure)?
                        .encode(),
                )?,
                Input::Release(input) => flatten(
                    "release",
                    runtime
                        .release(caller, input)
                        .await
                        .map_err(failure)?
                        .encode(),
                )?,
                Input::Remove(input) => flatten(
                    "remove",
                    runtime
                        .remove(caller, input, None)
                        .await
                        .map_err(failure)?
                        .encode(),
                )?,
                Input::Attach(input) => {
                    let creator = runtime
                        .creator()
                        .ok_or_else(|| Failure::Defect("Project creator is not bound".into()))?;
                    let authorize = creator
                        .attach_location(
                            runtime::CreateContext {
                                session_id: caller.clone(),
                                agent: context.agent.clone(),
                                message_id: context.message_id.clone(),
                                call_id: context.call_id.clone(),
                            },
                            input.session_id.clone(),
                        )
                        .await
                        .map_err(failure)?;
                    flatten(
                        "attach",
                        runtime
                            .attach(caller, input, authorize, None)
                            .await
                            .map_err(failure)?
                            .encode(),
                    )?
                }
                Input::Member(input) => flatten(
                    "model",
                    runtime
                        .member(caller, input)
                        .await
                        .map_err(failure)?
                        .encode(),
                )?,
                Input::Model(input) => flatten(
                    "model",
                    runtime
                        .set_model(caller, input)
                        .await
                        .map_err(failure)?
                        .encode(),
                )?,
                Input::Create(input) => {
                    let creator = runtime
                        .creator()
                        .ok_or_else(|| Failure::Defect("Project creator is not bound".into()))?;
                    if matches!(&input.target, runtime::CreateTarget::Worktree { .. })
                        && !creator
                            .worktree_allowed(caller.clone())
                            .await
                            .map_err(failure)?
                    {
                        return Err(Failure::message(
                            "Project member creation requires the worktree tool capability",
                        ));
                    }
                    let rules = creator
                        .agent_permissions(caller.clone(), context.agent.clone())
                        .await
                        .map_err(failure)?
                        .ok_or_else(|| Failure::message("The calling agent is unavailable"))?;
                    let agent_permissions = crate::session::orchestration::effective_denies(&rules);
                    let create_context = runtime::CreateContext {
                        session_id: caller.clone(),
                        agent: context.agent.clone(),
                        message_id: context.message_id.clone(),
                        call_id: context.call_id.clone(),
                    };
                    let provider = match &input.target {
                        runtime::CreateTarget::Worktree { repository, .. } => {
                            let repository = repository.clone();
                            Some(runtime::CreateProvider::Worktree(Box::new(move |name| {
                                Box::pin(async move {
                                    creator
                                        .create_worktree(create_context, name, repository)
                                        .await
                                })
                                    as runtime::Future<'static, runtime::CreatedWorktree>
                            })))
                        }
                        runtime::CreateTarget::Directory { .. } => {
                            Some(runtime::CreateProvider::Directory(
                                creator.directory(create_context).await.map_err(failure)?,
                            ))
                        }
                        runtime::CreateTarget::Project { .. } => None,
                    };
                    let identity = [
                        caller.as_lossless(),
                        context.message_id.as_lossless(),
                        &context.call_id,
                    ]
                    .map(|value| String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>()))
                    .join("\0");
                    let digest = crate::session::prompt_cache::sha256(&identity);
                    let id =
                        ycoding_schema::session::Id::new(format!("ses_project_{}", &digest[..24]))
                            .map_err(invalid)?;
                    flatten(
                        "create",
                        runtime
                            .create(
                                caller,
                                runtime::CreateInput {
                                    id,
                                    target: input.target,
                                    agent_permissions,
                                    owner_session_id: input.owner_session_id,
                                    title: input.title,
                                    prompt: input.prompt,
                                    model: input.model,
                                },
                                provider,
                            )
                            .await
                            .map_err(failure)?
                            .encode(),
                    )?
                }
            };
            let text = stringify_json(&value);
            Ok(output(value, text))
        })
    }
}
enum Input {
    List,
    Inspect(runtime::InspectInput),
    Send(runtime::SendInput),
    Answer(runtime::AnswerInput),
    Escalate(runtime::EscalateInput),
    Interrupt(runtime::InterruptInput),
    Assign(runtime::AssignInput),
    Release(runtime::ReleaseInput),
    Remove(runtime::MemberInput),
    Attach(runtime::AttachInput),
    Member(runtime::MemberInput),
    Model(runtime::ModelInput),
    Create(Create),
}
struct Create {
    target: runtime::CreateTarget,
    owner_session_id: Option<ycoding_schema::session::Id>,
    title: Option<LosslessString>,
    prompt: Option<LosslessString>,
    model: Option<ycoding_schema::model::Ref>,
}
fn input(value: &JsonValue) -> Result<Input, Failure> {
    let object = decode(value)?;
    let action = object
        .tag(
            "action",
            &[
                "list",
                "inspect",
                "send",
                "answer",
                "escalate",
                "interrupt",
                "assign",
                "release",
                "remove",
                "attach",
                "model",
                "create",
            ],
        )
        .map_err(invalid)?;
    let action = action
        .as_str()
        .ok_or_else(|| Failure::message("Invalid project operation"))?;
    let allowed: &[&str] = match action {
        "list" => &["action"],
        "inspect" => &["action", "sessionID", "requestID"],
        "send" => &[
            "action",
            "sessionID",
            "text",
            "delivery",
            "messageID",
            "model",
        ],
        "answer" => &[
            "action",
            "sessionID",
            "requestID",
            "kind",
            "fingerprint",
            "rationale",
            "confidence",
            "answer",
            "decision",
        ],
        "escalate" => &[
            "action",
            "sessionID",
            "requestID",
            "kind",
            "fingerprint",
            "reason",
        ],
        "interrupt" => &["action", "sessionID"],
        "assign" => &["action", "sessionID", "ownerSessionID"],
        "release" => &["action", "sessionID", "reason"],
        "remove" => &["action", "sessionID"],
        "attach" => &["action", "sessionID", "ownerSessionID"],
        "model" => &["action", "sessionID", "expectedModel", "model"],
        "create" => &[
            "action",
            "directory",
            "name",
            "repository",
            "projectID",
            "ownerSessionID",
            "title",
            "prompt",
            "model",
        ],
        _ => return Err(Failure::message("Invalid project operation")),
    };
    if let JsonValue::Object(fields) = value
        && fields
            .iter()
            .any(|(key, _)| !key.as_str().is_some_and(|key| allowed.contains(&key)))
    {
        return Err(Failure::message("Invalid project operation: unknown field"));
    }
    let target = || object.field("sessionID").map_err(invalid);
    match action {
        "list" => Ok(Input::List),
        "inspect" => Ok(Input::Inspect(runtime::InspectInput {
            session_id: target()?,
            request_id: bounded(&object, "requestID", 1, 256)?,
        })),
        "send" => Ok(Input::Send(runtime::SendInput {
            session_id: target()?,
            text: bounded(&object, "text", 1, 32000)?,
            delivery: object.optional("delivery").map_err(invalid)?,
            message_id: object.optional("messageID").map_err(invalid)?,
            model: object.optional("model").map_err(invalid)?,
        })),
        "answer" => {
            let confidence: Option<f64> = object.optional("confidence").map_err(invalid)?;
            if confidence.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
                return Err(Failure::message("Invalid project confidence"));
            }
            let decision = object
                .optional::<LosslessString>("decision")
                .map_err(invalid)?
                .map(|value| match value.as_str() {
                    Some("approve") => Ok(runtime::Decision::Approve),
                    Some("decline") => Ok(runtime::Decision::Decline),
                    _ => Err(Failure::message("Invalid project decision")),
                })
                .transpose()?;
            Ok(Input::Answer(runtime::AnswerInput {
                session_id: target()?,
                request_id: bounded(&object, "requestID", 1, 256)?,
                kind: object.field("kind").map_err(invalid)?,
                fingerprint: bounded(&object, "fingerprint", 1, 256)?,
                rationale: reason(&object, "rationale")?,
                confidence,
                answer: object.optional("answer").map_err(invalid)?,
                decision,
            }))
        }
        "escalate" => Ok(Input::Escalate(runtime::EscalateInput {
            session_id: target()?,
            request_id: bounded(&object, "requestID", 1, 256)?,
            kind: object.field("kind").map_err(invalid)?,
            fingerprint: bounded(&object, "fingerprint", 1, 256)?,
            reason: reason(&object, "reason")?,
        })),
        "interrupt" => Ok(Input::Interrupt(runtime::InterruptInput {
            session_id: target()?,
        })),
        "assign" => Ok(Input::Assign(runtime::AssignInput {
            session_id: target()?,
            owner_session_id: object.field("ownerSessionID").map_err(invalid)?,
        })),
        "release" => Ok(Input::Release(runtime::ReleaseInput {
            session_id: target()?,
            reason: object.field("reason").map_err(invalid)?,
        })),
        "remove" => Ok(Input::Remove(runtime::MemberInput {
            session_id: target()?,
        })),
        "attach" => Ok(Input::Attach(runtime::AttachInput {
            session_id: target()?,
            owner_session_id: object.optional("ownerSessionID").map_err(invalid)?,
        })),
        "model" => {
            let model = object.optional("model").map_err(invalid)?;
            let expected_model = object.optional("expectedModel").map_err(invalid)?;
            match (model, expected_model) {
                (None, None) => Ok(Input::Member(runtime::MemberInput {
                    session_id: target()?,
                })),
                (Some(model), Some(expected_model)) => Ok(Input::Model(runtime::ModelInput {
                    session_id: target()?,
                    expected_model,
                    model,
                })),
                _ => Err(Failure::message(
                    "Project model updates require model and expectedModel",
                )),
            }
        }
        "create" => {
            let title: Option<LosslessString> = object.optional("title").map_err(invalid)?;
            if title.as_ref().is_some_and(|value| {
                value.len() > 120
                    || !value.code_units().any(|unit| {
                        !matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
                    })
            }) {
                return Err(Failure::message("Invalid project title length"));
            }
            let prompt: Option<LosslessString> = object.optional("prompt").map_err(invalid)?;
            if prompt
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 32000)
            {
                return Err(Failure::message("Invalid project prompt length"));
            }
            let repository: Option<LosslessString> =
                object.optional("repository").map_err(invalid)?;
            if repository.as_ref().is_some_and(|value| {
                value.is_empty()
                    || value.len() > 4096
                    || !value
                        .to_utf8()
                        .is_ok_and(|path| std::path::Path::new(&path).is_absolute())
            }) {
                return Err(Failure::message("Invalid project repository"));
            }
            let name: Option<LosslessString> = object.optional("name").map_err(invalid)?;
            let project_id = object.optional("projectID").map_err(invalid)?;
            let directory: Option<LosslessString> =
                object.optional("directory").map_err(invalid)?;
            if directory
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 4096)
            {
                return Err(Failure::message("Invalid project directory"));
            }
            let target = match (directory, name, project_id) {
                (Some(directory), None, None) if repository.is_none() => {
                    runtime::CreateTarget::Directory { directory }
                }
                (None, Some(name), None) => {
                    if !name.as_str().is_some_and(|name| {
                        !name.is_empty()
                            && name.len() <= 63
                            && name.as_bytes()[0].is_ascii_alphanumeric()
                            && name.bytes().all(|byte| {
                                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                            })
                    }) {
                        return Err(Failure::message("Invalid project worktree name"));
                    }
                    runtime::CreateTarget::Worktree { name, repository }
                }
                (None, None, Some(project_id)) if repository.is_none() => {
                    runtime::CreateTarget::Project { project_id }
                }
                _ => {
                    return Err(Failure::message(
                        "Project creation requires exactly one of directory, projectID, or name with optional repository",
                    ));
                }
            };
            Ok(Input::Create(Create {
                target,
                owner_session_id: object.optional("ownerSessionID").map_err(invalid)?,
                title,
                prompt,
                model: object.optional("model").map_err(invalid)?,
            }))
        }
        _ => Err(Failure::message("Invalid project operation")),
    }
}
fn bounded(
    object: &ObjectDecoder<'_>,
    key: &str,
    min: usize,
    max: usize,
) -> Result<LosslessString, Failure> {
    let value: LosslessString = object.field(key).map_err(invalid)?;
    if !(min..=max).contains(&value.len()) {
        return Err(Failure::message(format!("Invalid project {key} length")));
    }
    Ok(value)
}
fn reason(object: &ObjectDecoder<'_>, key: &str) -> Result<LosslessString, Failure> {
    let value = bounded(object, key, 1, 500)?;
    if !value.code_units().any(|unit|!matches!(unit,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)){return Err(Failure::message(format!("Project {key} must include non-whitespace text")));}
    Ok(value)
}
fn guidance(
    member: &ycoding_schema::session::Id,
    requesting: Option<&ycoding_schema::session::Id>,
    title: Option<&LosslessString>,
) -> String {
    let text =
        |value: &LosslessString| String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>());
    let named = title.map_or_else(String::new, |title| format!(" ({})", text(title)));
    match requesting {
        None => format!(
            "The request stays open as the member's prompt. The user answers it in member Session {}{named}; messages or answers relayed through the Master cannot settle it, so do not wait on a reply to a message sent to that member.",
            text(member.as_lossless())
        ),
        Some(requesting) => format!(
            "The request stays open as the prompt of Session {}, a descendant of member Session {}{named}. The user answers it in Session {}; messages or answers relayed through the Master cannot settle it, so do not wait on a reply to a message sent to that member.",
            text(requesting.as_lossless()),
            text(member.as_lossless()),
            text(requesting.as_lossless())
        ),
    }
}
fn flatten(action: &str, value: JsonValue) -> Result<JsonValue, Failure> {
    let JsonValue::Object(mut fields) = value else {
        return Err(Failure::Defect("Project result must be an object".into()));
    };
    fields.insert("action".into(), action.encode());
    Ok(JsonValue::Object(fields))
}
fn failure(error: Error) -> Failure {
    match error {
        Error::Execution(crate::session::run_coordinator::Error::Interrupted(_)) => {
            Failure::Cancelled
        }
        error if error.reason().is_some() => Failure::message(error.to_string()),
        error => Failure::Defect(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ycoding_schema::parse_json;
    #[test]
    fn every_action_decodes_and_unknown_fields_never_reach_runtime() {
        for text in [
            r#"{"action":"list"}"#,
            r#"{"action":"inspect","sessionID":"ses_member","requestID":"r"}"#,
            r#"{"action":"send","sessionID":"ses_member","text":"work","delivery":"queue"}"#,
            r#"{"action":"answer","sessionID":"ses_member","requestID":"r","kind":"permission","fingerprint":"f","rationale":"checked","decision":"decline","confidence":0.9}"#,
            r#"{"action":"escalate","sessionID":"ses_member","requestID":"r","kind":"question","fingerprint":"f","reason":"client decision"}"#,
            r#"{"action":"interrupt","sessionID":"ses_member"}"#,
            r#"{"action":"assign","sessionID":"ses_member","ownerSessionID":"ses_supervisor"}"#,
            r#"{"action":"release","sessionID":"ses_member","reason":"completed"}"#,
            r#"{"action":"remove","sessionID":"ses_member"}"#,
            r#"{"action":"attach","sessionID":"ses_root"}"#,
            r#"{"action":"attach","sessionID":"ses_root","ownerSessionID":"ses_supervisor"}"#,
            r#"{"action":"create","name":"lane-a","ownerSessionID":"ses_supervisor","title":"Lane","prompt":"work"}"#,
            r#"{"action":"create","name":"lane-a","repository":"/workspace/repository"}"#,
            r#"{"action":"create","projectID":"repository-project"}"#,
            r#"{"action":"create","directory":"/synthetic/folder","ownerSessionID":"ses_owner","title":"New member","prompt":"Inspect the folder"}"#,
            r#"{"action":"create","directory":"~"}"#,
            r#"{"action":"create","directory":"~/new folder"}"#,
        ] {
            assert!(input(&parse_json(text).unwrap()).is_ok(), "{text}");
        }
        for text in [
            r#"{"action":"create","directory":"/synthetic/folder","projectID":"repository-project"}"#,
            r#"{"action":"create","directory":"/synthetic/folder","name":"lane-a"}"#,
            r#"{"action":"create","directory":"/synthetic/folder","repository":"/synthetic/repository"}"#,
            r#"{"action":"create","directory":""}"#,
            r#"{"action":"create","projectID":"repository-project","repository":"/synthetic/repository"}"#,
        ] {
            assert!(input(&parse_json(text).unwrap()).is_err(), "{text}");
        }
        for text in [
            r#"{"action":"list","ownerSessionID":"ses_other"}"#,
            r#"{"action":"send","sessionID":"ses_member","text":""}"#,
            r#"{"action":"answer","sessionID":"ses_member","requestID":"r","kind":"permission","fingerprint":"f","rationale":"  "}"#,
            r#"{"action":"answer","sessionID":"ses_member","requestID":"r","kind":"permission","fingerprint":"f","rationale":"checked","confidence":1.01}"#,
            r#"{"action":"release","sessionID":"ses_member","reason":"idle"}"#,
            r#"{"action":"attach"}"#,
            r#"{"action":"attach","sessionID":"ses_root","reason":"completed"}"#,
            r#"{"action":"create","name":"lane-a","sessionID":"ses_member"}"#,
            r#"{"action":"create","name":"","prompt":"work"}"#,
            r#"{"action":"create","name":"lane-a","repository":"workspace/repository"}"#,
            r#"{"action":"create","name":"lane-a","repository":""}"#,
        ] {
            assert!(input(&parse_json(text).unwrap()).is_err(), "{text}");
        }
    }
}
