use crate::dispatch::Failure;
use crate::{convert, form, guardrail, message, permission, pty, question, shell};
use prost::{Message, Name};
use ycoding_core::event_feed::{Data, Ephemeral};
use ycoding_core::ycoding_schema::{DomainEncode, LosslessString, session_status_event};
use ycoding_protocol::v5;

type R<T> = Result<T, Failure>;

pub(crate) fn record(event: &Ephemeral, epoch: &LosslessString) -> R<v5::EventRecord> {
    use v5::public_event::Kind;
    macro_rules! envelope {
        ($variant:ident, $wire:ident, $data:expr) => {{
            let mut wire = v5::$wire {
                id: convert::wire(&event.id),
                created: event.created as f64,
                metadata: None,
                source_epoch: Some(convert::wire(epoch)),
                r#type: 1,
                location: event.location.as_ref().map(|location| v5::LocationRef {
                    directory: convert::wire(location.directory.as_lossless()),
                    workspace_id: location
                        .workspace_id
                        .as_ref()
                        .map(|id| convert::wire(id.as_lossless())),
                }),
                data: $data,
            };
            if let Some(metadata) = &event.metadata {
                let entries = &mut wire.metadata.insert(Default::default()).entries;
                for (key, value) in metadata.iter() {
                    entries.push(Default::default());
                    let entry = entries.last_mut().ok_or_else(unrepresentable)?;
                    entry.key = convert::wire(key);
                    entry.value = convert::json_to_value(value);
                }
            }
            Kind::$variant(wire)
        }};
    }
    let kind = match &event.data {
        Data::ModelsDevRefreshed(_) => envelope!(
            ModelsDevRefreshed,
            PublicEventModelsDevRefreshed,
            Default::default()
        ),
        Data::IntegrationUpdated(_) => envelope!(
            IntegrationUpdated,
            PublicEventIntegrationUpdated,
            Default::default()
        ),
        Data::IntegrationConnectionUpdated(data) => envelope!(
            IntegrationConnectionUpdated,
            PublicEventIntegrationConnectionUpdated,
            v5::PublicEventIntegrationConnectionUpdatedData {
                integration_id: convert::wire(data.integration_id.as_lossless())
            }
        ),
        Data::CatalogUpdated(_) => envelope!(
            CatalogUpdated,
            PublicEventCatalogUpdated,
            Default::default()
        ),
        Data::AgentUpdated(_) => {
            envelope!(AgentUpdated, PublicEventAgentUpdated, Default::default())
        }
        Data::SessionUsageUpdated(data) => envelope!(
            SessionUsageUpdated,
            PublicEventSessionUsageUpdated,
            v5::PublicEventSessionUsageUpdatedData {
                session_id: convert::wire(data.session_id.as_lossless()),
                cost: data.cost.get(),
                tokens: tokens(&data.tokens)?,
            }
        ),
        Data::SessionPredictionUpdated(data) => envelope!(
            SessionPredictionUpdated,
            PublicEventSessionPredictionUpdated,
            v5::PublicEventSessionPredictionUpdatedData {
                session_id: convert::wire(data.session_id.as_lossless()),
                source_message_id: convert::wire(data.source_message_id.as_lossless()),
                text: convert::wire(&data.text),
            }
        ),
        Data::SessionDiagnosticsUpdated(data) => envelope!(
            SessionDiagnosticsUpdated,
            PublicEventSessionDiagnosticsUpdated,
            v5::PublicEventSessionDiagnosticsUpdatedData {
                session_id: convert::wire(data.session_id.as_lossless()),
                diagnostics: convert::cache_diagnostics(&data.diagnostics)
                    .map_err(|_| unrepresentable())?,
            }
        ),
        Data::SessionTextDelta(data) => envelope!(
            SessionTextDelta,
            PublicEventSessionTextDelta,
            v5::PublicEventSessionTextDeltaData {
                session_id: convert::wire(data.session_id.as_lossless()),
                assistant_message_id: convert::wire(data.assistant_message_id.as_lossless()),
                ordinal: data.ordinal.get() as u64,
                delta: convert::wire(&data.delta),
            }
        ),
        Data::SessionReasoningDelta(data) => envelope!(
            SessionReasoningDelta,
            PublicEventSessionReasoningDelta,
            v5::PublicEventSessionReasoningDeltaData {
                session_id: convert::wire(data.session_id.as_lossless()),
                assistant_message_id: convert::wire(data.assistant_message_id.as_lossless()),
                ordinal: data.ordinal.get() as u64,
                delta: convert::wire(&data.delta),
            }
        ),
        Data::SessionToolInputDelta(data) => envelope!(
            SessionToolInputDelta,
            PublicEventSessionToolInputDelta,
            v5::PublicEventSessionToolInputDeltaData {
                session_id: convert::wire(data.session_id.as_lossless()),
                assistant_message_id: convert::wire(data.assistant_message_id.as_lossless()),
                call_id: convert::wire(&data.call_id),
                delta: convert::wire(&data.delta),
            }
        ),
        Data::SessionToolProgress(data) => envelope!(
            SessionToolProgress,
            PublicEventSessionToolProgress,
            v5::PublicEventSessionToolProgressData {
                session_id: convert::wire(data.session_id.as_lossless()),
                assistant_message_id: convert::wire(data.assistant_message_id.as_lossless()),
                call_id: convert::wire(&data.call_id),
                structured: v5::PublicEventSessionToolProgressDataStructured {
                    entries: data
                        .structured
                        .iter()
                        .map(
                            |(key, value)| v5::PublicEventSessionToolProgressDataStructuredEntry {
                                key: convert::wire(key),
                                value: convert::json_to_value(value)
                            }
                        )
                        .collect(),
                },
                content: v5::PublicEventSessionToolProgressDataContent {
                    items: message::tool_contents(message::J(&data.content.encode()))
                        .map_err(|_| unrepresentable())?,
                },
            }
        ),
        Data::SessionCompactionDelta(data) => envelope!(
            SessionCompactionDelta,
            PublicEventSessionCompactionDelta,
            v5::PublicEventSessionCompactionDeltaData {
                session_id: convert::wire(data.session_id.as_lossless()),
                text: convert::wire(&data.text)
            }
        ),
        Data::FilesystemChanged(data) => envelope!(
            FilesystemChanged,
            PublicEventFilesystemChanged,
            v5::PublicEventFilesystemChangedData {
                file: convert::wire(&data.file),
                event: match data.event {
                    ycoding_core::ycoding_schema::filesystem::ChangedKind::Add => 1,
                    ycoding_core::ycoding_schema::filesystem::ChangedKind::Change => 2,
                    ycoding_core::ycoding_schema::filesystem::ChangedKind::Unlink => 3,
                },
            }
        ),
        Data::ReferenceUpdated(_) => envelope!(
            ReferenceUpdated,
            PublicEventReferenceUpdated,
            Default::default()
        ),
        Data::PermissionAsked(data) => {
            let data = permission::wire(data)?;
            envelope!(
                PermissionAsked,
                PublicEventPermissionAsked,
                v5::PublicEventPermissionAskedData {
                    id: data.id,
                    session_id: data.session_id,
                    action: data.action,
                    resources: v5::PublicEventPermissionAskedDataResources {
                        items: data.resources.items
                    },
                    save: data
                        .save
                        .map(|data| v5::PublicEventPermissionAskedDataSave { items: data.items }),
                    source: data.source,
                    metadata: data.metadata.map(|data| {
                        v5::PublicEventPermissionAskedDataMetadata {
                            entries: data
                                .entries
                                .into_iter()
                                .map(|entry| v5::PublicEventPermissionAskedDataMetadataEntry {
                                    key: entry.key,
                                    value: entry.value,
                                })
                                .collect(),
                        }
                    }),
                }
            )
        }
        Data::PermissionReplied(data) => envelope!(
            PermissionReplied,
            PublicEventPermissionReplied,
            v5::PublicEventPermissionRepliedData {
                session_id: convert::wire(data.session_id.as_lossless()),
                request_id: convert::wire(data.request_id.as_lossless()),
                reply: enumeration(
                    &data.reply.encode(),
                    &[("once", 1), ("always", 2), ("reject", 3)]
                )?,
            }
        ),
        Data::PermissionDeferred(data) => envelope!(
            PermissionDeferred,
            PublicEventPermissionDeferred,
            v5::PublicEventPermissionDeferredData {
                session_id: convert::wire(data.session_id.as_lossless()),
                request_id: convert::identity(&data.request_id)?,
                item_id: convert::wire(data.item_id.as_lossless()),
            }
        ),
        Data::GuardrailAsked(data) => {
            let data = guardrail::wire(data)?;
            envelope!(
                GuardrailAsked,
                PublicEventGuardrailAsked,
                v5::PublicEventGuardrailAskedData {
                    id: data.id,
                    root_session_id: data.root_session_id,
                    session_id: data.session_id,
                    action: data.action,
                    resources: v5::PublicEventGuardrailAskedDataResources {
                        items: data.resources.items
                    },
                    rule_i_ds: v5::PublicEventGuardrailAskedDataRuleIDs {
                        items: data.rule_i_ds.items
                    },
                    reason: data.reason,
                    standard: data.standard,
                    hard_review: data.hard_review,
                    risk: data.risk,
                    metadata: data
                        .metadata
                        .map(|data| v5::PublicEventGuardrailAskedDataMetadata {
                            entries: data
                                .entries
                                .into_iter()
                                .map(|entry| v5::PublicEventGuardrailAskedDataMetadataEntry {
                                    key: entry.key,
                                    value: entry.value
                                })
                                .collect()
                        }),
                    escalation: data.escalation,
                }
            )
        }
        Data::GuardrailReplied(data) => envelope!(
            GuardrailReplied,
            PublicEventGuardrailReplied,
            v5::PublicEventGuardrailRepliedData {
                root_session_id: convert::wire(data.root_session_id.as_lossless()),
                session_id: convert::wire(data.session_id.as_lossless()),
                request_id: crate::message::J(&data.request_id.encode())
                    .text()
                    .map_err(|_| unrepresentable())?,
                reply: convert::guardrail_reply(data.reply),
                decided_by: data.decided_by.map(|decided_by| match decided_by {
                    ycoding_core::ycoding_schema::guardrail::DecidedBy::DecisionModel => 1,
                }),
                choice: data.choice.map(convert::decision_choice),
                confidence: data.confidence.map(|confidence| confidence.get()),
                grades: data.grades.as_ref().map(|grades| {
                    v5::PublicEventGuardrailRepliedDataGrades {
                        items: convert::grades(grades),
                    }
                }),
            }
        ),
        Data::GuardrailDecided(data) => envelope!(
            GuardrailDecided,
            PublicEventGuardrailDecided,
            v5::PublicEventGuardrailDecidedData {
                root_session_id: convert::wire(data.root_session_id.as_lossless()),
                session_id: convert::wire(data.session_id.as_lossless()),
                action: convert::wire(&data.action),
                rule_i_ds: v5::PublicEventGuardrailDecidedDataRuleIDs {
                    items: data.rule_ids.iter().map(convert::wire).collect()
                },
                decision: enumeration(
                    &data.decision.encode(),
                    &[("allow", 1), ("ask", 2), ("deny", 3), ("cap_exceeded", 4)]
                )?,
            }
        ),
        Data::GuardrailDeferred(data) => envelope!(
            GuardrailDeferred,
            PublicEventGuardrailDeferred,
            v5::PublicEventGuardrailDeferredData {
                root_session_id: convert::wire(data.root_session_id.as_lossless()),
                session_id: convert::wire(data.session_id.as_lossless()),
                request_id: convert::identity(&data.request_id)?,
                item_id: convert::wire(data.item_id.as_lossless()),
            }
        ),
        Data::PluginAdded(data) => envelope!(
            PluginAdded,
            PublicEventPluginAdded,
            v5::PublicEventPluginAddedData {
                id: convert::wire(&data.id)
            }
        ),
        Data::PluginUpdated(_) => {
            envelope!(PluginUpdated, PublicEventPluginUpdated, Default::default())
        }
        Data::ProjectDirectoriesUpdated(data) => envelope!(
            ProjectDirectoriesUpdated,
            PublicEventProjectDirectoriesUpdated,
            v5::PublicEventProjectDirectoriesUpdatedData {
                project_id: convert::wire(data.project_id.as_lossless())
            }
        ),
        Data::CommandUpdated(_) => envelope!(
            CommandUpdated,
            PublicEventCommandUpdated,
            Default::default()
        ),
        Data::ConfigUpdated(_) => {
            envelope!(ConfigUpdated, PublicEventConfigUpdated, Default::default())
        }
        Data::SkillUpdated(_) => {
            envelope!(SkillUpdated, PublicEventSkillUpdated, Default::default())
        }
        Data::PtyCreated(data) => envelope!(
            PtyCreated,
            PublicEventPtyCreated,
            v5::PublicEventPtyCreatedData {
                info: pty::info(&data.info)?
            }
        ),
        Data::PtyUpdated(data) => envelope!(
            PtyUpdated,
            PublicEventPtyUpdated,
            v5::PublicEventPtyUpdatedData {
                info: pty::info(&data.info)?
            }
        ),
        Data::PtyExited(data) => envelope!(
            PtyExited,
            PublicEventPtyExited,
            v5::PublicEventPtyExitedData {
                id: convert::identity(&data.id)?,
                exit_code: data.exit_code.get() as u64,
                reason: enumeration(
                    &data.reason.encode(),
                    &[("exit", 1), ("timeout", 2), ("terminated", 3)]
                )?
            }
        ),
        Data::PtyDeleted(data) => envelope!(
            PtyDeleted,
            PublicEventPtyDeleted,
            v5::PublicEventPtyDeletedData {
                id: convert::identity(&data.id)?
            }
        ),
        Data::ShellCreated(data) => envelope!(
            ShellCreated,
            PublicEventShellCreated,
            v5::PublicEventShellCreatedData {
                info: shell::info(&data.info)?
            }
        ),
        Data::ShellExited(data) => envelope!(
            ShellExited,
            PublicEventShellExited,
            v5::PublicEventShellExitedData {
                id: convert::identity(&data.id)?,
                exit: data.exit.map(|exit| exit.get()),
                status: enumeration(
                    &data.status.encode(),
                    &[
                        ("running", 1),
                        ("exited", 2),
                        ("timeout", 3),
                        ("memory-limit", 4),
                        ("killed", 5)
                    ]
                )?
            }
        ),
        Data::ShellDeleted(data) => envelope!(
            ShellDeleted,
            PublicEventShellDeleted,
            v5::PublicEventShellDeletedData {
                id: convert::identity(&data.id)?
            }
        ),
        Data::QuestionAsked(data) => {
            let data = question::wire(data)?;
            envelope!(
                QuestionAsked,
                PublicEventQuestionAsked,
                v5::PublicEventQuestionAskedData {
                    id: data.id,
                    session_id: data.session_id,
                    questions: v5::PublicEventQuestionAskedDataQuestions {
                        items: data.questions.items
                    },
                    tool: data.tool
                }
            )
        }
        Data::QuestionReplied(data) => envelope!(
            QuestionReplied,
            PublicEventQuestionReplied,
            v5::PublicEventQuestionRepliedData {
                session_id: convert::wire(data.session_id.as_lossless()),
                request_id: convert::identity(&data.request_id)?,
                answers: v5::PublicEventQuestionRepliedDataAnswers {
                    items: data
                        .answers
                        .iter()
                        .map(|answers| v5::QuestionAnswer {
                            items: answers.iter().map(convert::wire).collect()
                        })
                        .collect()
                },
            }
        ),
        Data::QuestionRejected(data) => envelope!(
            QuestionRejected,
            PublicEventQuestionRejected,
            v5::PublicEventQuestionRejectedData {
                session_id: convert::wire(data.session_id.as_lossless()),
                request_id: convert::identity(&data.request_id)?
            }
        ),
        Data::QuestionTimedOut(data) => envelope!(
            QuestionTimedOut,
            PublicEventQuestionTimedOut,
            v5::PublicEventQuestionTimedOutData {
                session_id: convert::wire(data.session_id.as_lossless()),
                request_id: convert::identity(&data.request_id)?
            }
        ),
        Data::QuestionDeferred(data) => envelope!(
            QuestionDeferred,
            PublicEventQuestionDeferred,
            v5::PublicEventQuestionDeferredData {
                session_id: convert::wire(data.session_id.as_lossless()),
                request_id: convert::identity(&data.request_id)?,
                item_id: convert::wire(data.item_id.as_lossless()),
            }
        ),
        Data::FormCreated(data) => envelope!(
            FormCreated,
            PublicEventFormCreated,
            v5::PublicEventFormCreatedData {
                form: form::info_wire(&data.form)?
            }
        ),
        Data::FormReplied(data) => envelope!(
            FormReplied,
            PublicEventFormReplied,
            v5::PublicEventFormRepliedData {
                id: convert::identity(&data.id)?,
                session_id: convert::wire(&data.session_id),
                answer: v5::FormAnswer {
                    entries: data
                        .answer
                        .0
                        .iter()
                        .map(|(key, value)| Ok(v5::FormAnswerEntry {
                            key: convert::wire(key),
                            value: form::value_wire(value)?
                        }))
                        .collect::<R<_>>()?
                },
            }
        ),
        Data::FormCancelled(data) => envelope!(
            FormCancelled,
            PublicEventFormCancelled,
            v5::PublicEventFormCancelledData {
                id: convert::identity(&data.id)?,
                session_id: convert::wire(&data.session_id)
            }
        ),
        Data::FormTimedOut(data) => envelope!(
            FormTimedOut,
            PublicEventFormTimedOut,
            v5::PublicEventFormTimedOutData {
                id: convert::identity(&data.id)?,
                session_id: convert::wire(&data.session_id)
            }
        ),
        Data::FormDeferred(data) => envelope!(
            FormDeferred,
            PublicEventFormDeferred,
            v5::PublicEventFormDeferredData {
                id: convert::identity(&data.id)?,
                session_id: convert::wire(&data.session_id),
                item_id: convert::wire(data.item_id.as_lossless()),
            }
        ),
        Data::TodoUpdated(data) => envelope!(
            TodoUpdated,
            PublicEventTodoUpdated,
            v5::PublicEventTodoUpdatedData {
                session_id: convert::wire(data.session_id.as_lossless()),
                todos: v5::PublicEventTodoUpdatedDataTodos {
                    items: data
                        .todos
                        .iter()
                        .map(|todo| Ok(v5::SessionTodoInfo {
                            content: convert::wire(&todo.content),
                            status: enumeration(
                                &todo.status.encode(),
                                &[
                                    ("pending", 1),
                                    ("in_progress", 2),
                                    ("completed", 3),
                                    ("cancelled", 4)
                                ]
                            )?,
                            priority: enumeration(
                                &todo.priority.encode(),
                                &[("high", 1), ("medium", 2), ("low", 3)]
                            )?,
                        }))
                        .collect::<R<_>>()?
                },
            }
        ),
        Data::SessionStatus(data) => envelope!(
            SessionStatus,
            PublicEventSessionStatus,
            v5::PublicEventSessionStatusData {
                session_id: convert::wire(data.session_id.as_lossless()),
                status: status(&data.status)?
            }
        ),
        Data::SessionIdle(data) => envelope!(
            SessionIdle,
            PublicEventSessionIdle,
            v5::PublicEventSessionIdleData {
                session_id: convert::wire(data.session_id.as_lossless())
            }
        ),
        Data::TuiPromptAppend(data) => envelope!(
            TuiPromptAppend,
            PublicEventTuiPromptAppend,
            v5::PublicEventTuiPromptAppendData {
                text: convert::wire(&data.text)
            }
        ),
        Data::TuiCommandExecute(data) => envelope!(
            TuiCommandExecute,
            PublicEventTuiCommandExecute,
            v5::PublicEventTuiCommandExecuteData {
                command: tui_command(&data.command)
            }
        ),
        Data::TuiToastShow(data) => envelope!(
            TuiToastShow,
            PublicEventTuiToastShow,
            v5::PublicEventTuiToastShowData {
                title: data.title.as_ref().map(convert::wire),
                message: convert::wire(&data.message),
                variant: enumeration(
                    &data.variant.encode(),
                    &[("info", 1), ("success", 2), ("warning", 3), ("error", 4)]
                )?,
                duration: data.duration.get() as u64
            }
        ),
        Data::TuiSessionSelect(data) => envelope!(
            TuiSessionSelect,
            PublicEventTuiSessionSelect,
            v5::PublicEventTuiSessionSelectData {
                session_id: convert::wire(data.session_id.as_lossless())
            }
        ),
        Data::InstallationUpdated(data) => envelope!(
            InstallationUpdated,
            PublicEventInstallationUpdated,
            v5::PublicEventInstallationUpdatedData {
                version: convert::wire(&data.version)
            }
        ),
        Data::InstallationUpdateAvailable(data) => envelope!(
            InstallationUpdateAvailable,
            PublicEventInstallationUpdateAvailable,
            v5::PublicEventInstallationUpdateAvailableData {
                version: convert::wire(&data.version)
            }
        ),
        Data::VcsBranchUpdated(data) => envelope!(
            VcsBranchUpdated,
            PublicEventVcsBranchUpdated,
            v5::PublicEventVcsBranchUpdatedData {
                branch: data.branch.as_ref().map(convert::wire)
            }
        ),
        Data::McpStatusChanged(data) => envelope!(
            McpStatusChanged,
            PublicEventMcpStatusChanged,
            v5::PublicEventMcpStatusChangedData {
                server: convert::wire(&data.server)
            }
        ),
        Data::McpResourcesChanged(data) => envelope!(
            McpResourcesChanged,
            PublicEventMcpResourcesChanged,
            v5::PublicEventMcpResourcesChangedData {
                server: convert::wire(&data.server)
            }
        ),
    };
    Ok(v5::EventRecord {
        event_id: event.id.to_utf8().map_err(|_| unrepresentable())?,
        created_ms: event.created,
        durable: None,
        event: v5::TypedPayload {
            type_name: v5::PublicEvent::full_name(),
            payload: v5::PublicEvent { kind: Some(kind) }.encode_to_vec(),
        },
    })
}

fn enumeration(value: &ycoding_core::ycoding_schema::JsonValue, table: &[(&str, i32)]) -> R<i32> {
    let ycoding_core::ycoding_schema::JsonValue::String(name) = value else {
        return Err(unrepresentable());
    };
    table
        .iter()
        .find(|(value, _)| name.as_str() == Some(*value))
        .map(|(_, tag)| *tag)
        .ok_or_else(unrepresentable)
}

fn tokens(tokens: &ycoding_core::ycoding_schema::token_usage::Info) -> R<v5::TokenUsageInfo> {
    message::tokens(message::J(&tokens.encode())).map_err(|_| unrepresentable())
}

fn status(status: &session_status_event::Info) -> R<v5::SessionStatus> {
    use v5::session_status::Kind;
    Ok(v5::SessionStatus {
        kind: Some(match status {
            session_status_event::Info::Idle => Kind::Value1(v5::SessionStatusValue1 { r#type: 1 }),
            session_status_event::Info::Retry(data) => Kind::Value2(v5::SessionStatusValue2 {
                r#type: 1,
                attempt: data.attempt.get() as u64,
                message: convert::wire(&data.message),
                next: data.next.get() as u64,
                action: data
                    .action
                    .as_ref()
                    .map(|action| v5::SessionStatusValue2Action {
                        reason: convert::wire(&action.reason),
                        provider: convert::wire(&action.provider),
                        title: convert::wire(&action.title),
                        message: convert::wire(&action.message),
                        label: convert::wire(&action.label),
                        link: action.link.as_ref().map(convert::wire),
                    }),
            }),
            session_status_event::Info::Busy => Kind::Value3(v5::SessionStatusValue3 { r#type: 1 }),
        }),
    })
}

fn unrepresentable() -> Failure {
    Failure::Invalid("Unrepresentable public ephemeral event".into())
}

fn tui_command(command: &LosslessString) -> v5::PublicEventTuiCommandExecuteDataCommand {
    use v5::public_event_tui_command_execute_data_command::Kind;
    let known = [
        "session.list",
        "session.new",
        "session.share",
        "session.interrupt",
        "session.background",
        "session.compact",
        "session.page.up",
        "session.page.down",
        "session.line.up",
        "session.line.down",
        "session.half.page.up",
        "session.half.page.down",
        "session.first",
        "session.last",
        "prompt.clear",
        "prompt.submit",
        "agent.cycle",
    ];
    v5::PublicEventTuiCommandExecuteDataCommand {
        kind: Some(
            known
                .iter()
                .position(|known| command.as_str() == Some(*known))
                .map_or_else(
                    || Kind::Value2(convert::wire(command)),
                    |index| Kind::Value1(index as i32 + 1),
                ),
        ),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn usage_wire_tool_progress_is_live_only() {
        let data = Data::decode("session.tool.progress", &ycoding_core::ycoding_schema::parse_json(r#"{"sessionID":"ses_one","assistantMessageID":"msg_one","callID":"call_one","structured":{"stage":"working"},"content":[{"type":"text","text":"Still working"}]}"#).unwrap()).unwrap();
        let event = record(
            &Ephemeral {
                id: "evt_progress".into(),
                created: 42,
                session: data.session().unwrap(),
                location: None,
                metadata: None,
                data,
            },
            &"epoch".into(),
        )
        .unwrap();
        assert!(event.durable.is_none());
        let payload = v5::PublicEvent::decode(event.event.payload.as_slice()).unwrap();
        let Some(v5::public_event::Kind::SessionToolProgress(progress)) = payload.kind else {
            panic!("missing live progress")
        };
        assert_eq!(progress.data.structured.entries.len(), 1);
        assert_eq!(progress.data.content.items.len(), 1);
    }
    use super::*;
    use ycoding_core::ycoding_schema::{
        JsonObject, JsonValue, ObjectDecoder, location, parse_json,
    };

    #[test]
    fn all_ephemeral_variants_match_ts_schema_validated_wire_bytes() {
        let fixture =
            parse_json(include_str!("../tests/ephemeral_events/expectations.json")).unwrap();
        let path = Default::default();
        let fixture = ObjectDecoder::new(&fixture, &path).unwrap();
        let variants = fixture.field::<Vec<LosslessString>>("variants").unwrap();
        assert_eq!(variants.len(), 57);
        let cases = fixture.field::<Vec<JsonValue>>("cases").unwrap();
        assert_eq!(cases.len(), 131);
        for case in cases {
            let case = ObjectDecoder::new(&case, &path).unwrap();
            let name = case.field::<LosslessString>("name").unwrap();
            let event = case.field::<JsonValue>("event").unwrap();
            let event = ObjectDecoder::new(&event, &path).unwrap();
            let kind = case.field::<LosslessString>("type").unwrap();
            let data = Data::decode(
                kind.as_str().unwrap(),
                &event.field::<JsonValue>("data").unwrap(),
            )
            .unwrap();
            let input = Ephemeral {
                id: event.field("id").unwrap(),
                created: 42,
                session: data.session().unwrap(),
                data,
                location: event.optional::<location::Ref>("location").unwrap(),
                metadata: event.optional::<JsonObject>("metadata").unwrap(),
            };
            let record = record(&input, &"source-epoch-test".into())
                .unwrap_or_else(|error| panic!("{name:?}: {error:?}"));
            assert!(record.durable.is_none());
            assert_eq!(record.event_id, input.id.as_str().unwrap());
            let expected = case.field::<LosslessString>("hex").unwrap();
            let bytes = expected
                .as_str()
                .unwrap()
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(record.event.payload, bytes, "{name:?}");
            let decoded = v5::PublicEvent::decode(record.event.payload.as_slice()).unwrap();
            assert!(decoded.kind.is_some(), "{name:?}");
        }
    }

    #[test]
    fn typed_policy_boundary_rejects_unknown_and_malformed_public_events() {
        assert!(Data::decode("future", &JsonValue::Null).is_err());
        assert!(
            Data::decode(
                "session.status",
                &parse_json(r#"{"sessionID":"global","status":{"type":"busy"}}"#).unwrap()
            )
            .is_err()
        );
        assert!(
            Data::decode(
                "session.status",
                &parse_json(r#"{"sessionID":"ses_prompt","status":{"type":"future"}}"#).unwrap()
            )
            .is_err()
        );
        assert!(
            Data::decode(
                "permission.replied",
                &parse_json(
                    r#"{"sessionID":"ses_prompt","requestID":"per_fixture","reply":"future"}"#
                )
                .unwrap()
            )
            .is_err()
        );
        let data = Data::decode("config.updated", &parse_json("{}").unwrap()).unwrap();
        let input = Ephemeral {
            id: LosslessString::from_utf16(vec![0xd800]),
            created: 42,
            session: None,
            location: None,
            metadata: None,
            data,
        };
        assert!(record(&input, &"source-epoch-test".into()).is_err());
    }
}
