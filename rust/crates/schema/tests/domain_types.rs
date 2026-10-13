use serde::Deserialize;
use ycoding_schema::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    Nullable, ObjectDecoder, ObjectEncoder, Presence, agent, browser, catalog, command, config,
    connection, credential, domain, durable_event_manifest, event, event_log, event_manifest,
    file_diff, filesystem, form, guardrail, identifier, installation_event, instruction,
    instruction_entry, integration, integration_id, isolated_browser, keep_awake, llm, location,
    lsp_event, mcp, mcp_event, mcp_skill, model, models_dev, money, parse_json, permission,
    permission_saved, plugin, project, project_artifact, project_copy, project_directories,
    project_id, prompt, prompt_input, provider, provider_request, provider_usage, pty, pty_ticket,
    question, reference, remote, schema, server_event, session, session_cache_diagnostics,
    session_captured_changes, session_compaction, session_compaction_event, session_delivery,
    session_error, session_event, session_id, session_message, session_message_id,
    session_orchestration, session_pending, session_revert, session_skill_status,
    session_status_event, session_todo, session_work_completion, shell, skill, snapshot,
    source_epoch, stringify_json, telemetry, token_usage, tui_event, vcs, vcs_event, workspace,
    workspace_event, workspace_id, worktree_event,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    name: String,
    input: String,
    output: Option<String>,
    negative_zeros: Vec<String>,
}

fn negative_zeros(value: &JsonValue) -> Vec<String> {
    let mut result = Vec::new();
    let mut pending = vec![(value, JsonPath::default())];
    while let Some((value, path)) = pending.pop() {
        match value {
            JsonValue::Number(number) if *number == 0.0 && number.is_sign_negative() => {
                result.push(path.to_string())
            }
            JsonValue::Array(values) => pending.extend(
                values
                    .iter()
                    .enumerate()
                    .rev()
                    .map(|(index, value)| (value, path.index(index))),
            ),
            JsonValue::Object(object) => pending.extend(
                object
                    .iter()
                    .rev()
                    .map(|(key, value)| (value, path.key(key.clone()))),
            ),
            _ => {}
        }
    }
    result
}

fn round_trip<T: DomainDecode + DomainEncode>(value: &JsonValue) -> Result<JsonValue, DecodeError> {
    T::decode(value).map(|value| value.encode())
}

struct PresenceRecord {
    required: LosslessString,
    optional: Option<LosslessString>,
    clear: Presence<LosslessString>,
    open: Option<JsonValue>,
}
impl DomainDecode for PresenceRecord {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            required: object.field("required")?,
            optional: object.optional("optional")?,
            clear: object.presence("clear")?,
            open: object.optional("open")?,
        })
    }
}
impl DomainEncode for PresenceRecord {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("required", &self.required)
            .optional("optional", &self.optional)
            .presence("clear", &self.clear)
            .optional("open", &self.open)
            .finish()
    }
}

struct DurableData {
    text: LosslessString,
    clear: Presence<LosslessString>,
}
impl DomainDecode for DurableData {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            text: object.field("text")?,
            clear: object.presence("clear")?,
        })
    }
}
impl DomainEncode for DurableData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("text", &self.text)
            .presence("clear", &self.clear)
            .finish()
    }
}
struct EphemeralData {
    text: LosslessString,
}
impl DomainDecode for EphemeralData {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        Ok(Self {
            text: ObjectDecoder::new(value, path)?.field("text")?,
        })
    }
}
impl DomainEncode for EphemeralData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new().field("text", &self.text).finish()
    }
}
struct Changed;
impl event::EventType for Changed {
    const TYPE: &'static str = "fixture.changed";
    type Data = DurableData;
}
impl event::DurableEventType for Changed {
    const VERSION: i64 = 2;
    const AGGREGATE: &'static str = "fixture";
}
struct Ping;
impl event::EventType for Ping {
    const TYPE: &'static str = "fixture.ping";
    type Data = EphemeralData;
}

enum Tagged {
    Text(LosslessString),
    Count(schema::NonNegativeInt),
}
impl DomainDecode for Tagged {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        match object.tag("type", &["text", "count"])?.as_str() {
            Some("text") => Ok(Self::Text(object.field("text")?)),
            Some("count") => Ok(Self::Count(object.field("count")?)),
            _ => unreachable!("validated tag"),
        }
    }
}
impl DomainEncode for Tagged {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Text(text) => ObjectEncoder::new()
                .field("type", &LosslessString::from("text"))
                .field("text", text)
                .finish(),
            Self::Count(count) => ObjectEncoder::new()
                .field("type", &LosslessString::from("count"))
                .field("count", count)
                .finish(),
        }
    }
}

#[test]
fn effect_domain_goldens() {
    let goldens: Vec<Golden> =
        serde_json::from_str(include_str!("fixtures/domain-types.json")).unwrap();
    assert!(!goldens.is_empty());
    for golden in goldens {
        let input = parse_json(&golden.input).unwrap();
        let result = match golden.name.as_str() {
            "SessionEvent.All" => round_trip::<session_event::Event>(&input),
            "SessionEvent.Durable" => round_trip::<session_event::DurableEvent>(&input),
            "SessionEvent.PublicDurable" => round_trip::<session_event::PublicDurableEvent>(&input),
            "SessionEvent.ProfileBinding" => round_trip::<session_event::ProfileBinding>(&input),
            "SessionEvent.Source" => round_trip::<session_event::Source>(&input),
            "SessionEvent.ArtifactProvenance" => {
                round_trip::<session_message::ArtifactProvenance>(&input)
            }
            "Session.CacheMechanism" => round_trip::<session_cache_diagnostics::Mechanism>(&input),
            "Session.ProviderCacheDiagnostics" => {
                round_trip::<session_cache_diagnostics::ProviderCache>(&input)
            }
            "Session.ID" => round_trip::<session::Id>(&input),
            "Session.Info" => round_trip::<session::Info>(&input),
            "Session.ListAnchor" => round_trip::<session::ListAnchor>(&input),
            "Session.ModelSwitchBlocked" => round_trip::<session::ModelSwitchBlocked>(&input),
            "ProjectArtifact.ID" => round_trip::<project_artifact::Id>(&input),
            "ProjectArtifact.ScopeID" => round_trip::<project_artifact::ScopeId>(&input),
            "ProjectArtifact.VersionID" => round_trip::<project_artifact::VersionId>(&input),
            "ProjectArtifact.DeletionID" => round_trip::<project_artifact::DeletionId>(&input),
            "ProjectArtifact.ActivationID" => round_trip::<project_artifact::ActivationId>(&input),
            "ProjectArtifact.ObservationID" => {
                round_trip::<project_artifact::ObservationId>(&input)
            }
            "ProjectArtifact.Revision" => round_trip::<project_artifact::Revision>(&input),
            "ProjectArtifact.TimestampMillis" => {
                round_trip::<project_artifact::TimestampMillis>(&input)
            }
            "ProjectArtifact.Digest" => round_trip::<project_artifact::Digest>(&input),
            "ProjectArtifact.StorageID" => round_trip::<project_artifact::StorageId>(&input),
            "ProjectArtifact.DisplayName" => round_trip::<project_artifact::DisplayName>(&input),
            "ProjectArtifact.Description" => round_trip::<project_artifact::Description>(&input),
            "ProjectArtifact.SkillContent" => round_trip::<project_artifact::SkillContent>(&input),
            "ProjectArtifact.CommandTemplate" => {
                round_trip::<project_artifact::CommandTemplate>(&input)
            }
            "ProjectArtifact.AgentSystem" => round_trip::<project_artifact::AgentSystem>(&input),
            "ProjectArtifact.PluginDraft" => round_trip::<project_artifact::PluginDraft>(&input),
            "ProjectArtifact.ContentRelpath" => {
                round_trip::<project_artifact::ContentRelpath>(&input)
            }
            "ProjectArtifact.ConfirmationToken" => {
                round_trip::<project_artifact::ConfirmationToken>(&input)
            }
            "ProjectArtifact.RenderedContent" => {
                round_trip::<project_artifact::RenderedContent>(&input)
            }
            "ProjectArtifact.ProjectScope" => round_trip::<project_artifact::ProjectScope>(&input),
            "ProjectArtifact.GlobalScope" => round_trip::<project_artifact::GlobalScope>(&input),
            "ProjectArtifact.Scope" => round_trip::<project_artifact::Scope>(&input),
            "ProjectArtifact.ProjectScopeSelector" => {
                round_trip::<project_artifact::ProjectScopeSelector>(&input)
            }
            "ProjectArtifact.GlobalScopeSelector" => {
                round_trip::<project_artifact::GlobalScopeSelector>(&input)
            }
            "ProjectArtifact.ScopeSelector" => {
                round_trip::<project_artifact::ScopeSelector>(&input)
            }
            "ProjectArtifact.Provenance" => round_trip::<project_artifact::Provenance>(&input),
            "ProjectArtifact.Version" => round_trip::<project_artifact::Version>(&input),
            "ProjectArtifact.Artifact" => round_trip::<project_artifact::Artifact>(&input),
            "ProjectArtifact.ArtifactSummary" => {
                round_trip::<project_artifact::ArtifactSummary>(&input)
            }
            "ProjectArtifact.CollisionDiagnostic" => {
                round_trip::<project_artifact::CollisionDiagnostic>(&input)
            }
            "ProjectArtifact.ArtifactDetails" => {
                round_trip::<project_artifact::ArtifactDetails>(&input)
            }
            "ProjectArtifact.Metrics" => round_trip::<project_artifact::Metrics>(&input),
            "ProjectArtifact.Trash" => round_trip::<project_artifact::Trash>(&input),
            "ProjectArtifact.Activation" => round_trip::<project_artifact::Activation>(&input),
            "ProjectArtifact.Observation" => round_trip::<project_artifact::Observation>(&input),
            "ProjectArtifact.Feedback" => round_trip::<project_artifact::Feedback>(&input),
            "ProjectArtifact.AutomaticWrite" => {
                round_trip::<project_artifact::AutomaticWrite>(&input)
            }
            "ProjectArtifact.CreateRequest" => {
                round_trip::<project_artifact::CreateRequest>(&input)
            }
            "ProjectArtifact.UpdateRequest" => {
                round_trip::<project_artifact::UpdateRequest>(&input)
            }
            "ProjectArtifact.DeleteRequest" => {
                round_trip::<project_artifact::DeleteRequest>(&input)
            }
            "ProjectArtifact.RestoreRequest" => {
                round_trip::<project_artifact::RestoreRequest>(&input)
            }
            "ProjectArtifact.ListRequest" => round_trip::<project_artifact::ListRequest>(&input),
            "ProjectArtifact.PromotionPreviewRequest" => {
                round_trip::<project_artifact::PromotionPreviewRequest>(&input)
            }
            "ProjectArtifact.PromotionConfirmRequest" => {
                round_trip::<project_artifact::PromotionConfirmRequest>(&input)
            }
            "ProjectArtifact.PromotionPreview" => {
                round_trip::<project_artifact::PromotionPreview>(&input)
            }
            "ProjectArtifact.ValidationError" => {
                round_trip::<project_artifact::ValidationError>(&input)
            }
            "ProjectArtifact.UnsupportedKindError" => {
                round_trip::<project_artifact::UnsupportedKindError>(&input)
            }
            "ProjectArtifact.SkillDefinition" => round_trip::<project_artifact::Definition>(&input),
            "ProjectArtifact.CommandDefinition" => {
                round_trip::<project_artifact::Definition>(&input)
            }
            "ProjectArtifact.AgentDefinition" => round_trip::<project_artifact::Definition>(&input),
            "ProjectArtifact.PluginDefinition" => {
                round_trip::<project_artifact::Definition>(&input)
            }
            "ProjectArtifact.Definition" => round_trip::<project_artifact::Definition>(&input),
            "ProjectArtifact.ArtifactKey" => round_trip::<project_artifact::ArtifactKey>(&input),
            "ProjectArtifact.ProjectArtifactKey" => {
                round_trip::<project_artifact::ProjectArtifactKey>(&input)
            }
            "ProjectArtifact.ArtifactIdentity" => {
                round_trip::<project_artifact::ArtifactIdentity>(&input)
            }
            "ProjectArtifact.ArtifactVersionIdentity" => {
                round_trip::<project_artifact::ArtifactVersionIdentity>(&input)
            }
            "ProjectArtifact.Kind" => round_trip::<project_artifact::Kind>(&input),
            "ProjectArtifact.Stage" => round_trip::<project_artifact::Stage>(&input),
            "ProjectArtifact.Source" => round_trip::<project_artifact::Source>(&input),
            "ProjectArtifact.VersionState" => round_trip::<project_artifact::VersionState>(&input),
            "ProjectArtifact.ActivationSource" => {
                round_trip::<project_artifact::ActivationSource>(&input)
            }
            "ProjectArtifact.TerminalOutcome" => {
                round_trip::<project_artifact::TerminalOutcome>(&input)
            }
            "ProjectArtifact.GoalStatus" => round_trip::<project_artifact::GoalStatus>(&input),
            "ProjectArtifact.FeedbackAction" => {
                round_trip::<project_artifact::FeedbackAction>(&input)
            }
            "ProjectArtifact.FeedbackActor" => {
                round_trip::<project_artifact::FeedbackActor>(&input)
            }
            "ProjectArtifact.AutomaticWriteOperation" => {
                round_trip::<project_artifact::AutomaticWriteOperation>(&input)
            }
            "ProjectArtifact.AutomaticWriteResult" => {
                round_trip::<project_artifact::AutomaticWriteResult>(&input)
            }
            "ProjectArtifact.ErrorCode" => round_trip::<project_artifact::ErrorCode>(&input),
            "ProjectArtifact.Confidence" => round_trip::<project_artifact::Confidence>(&input),
            "SessionEvent.session.created" => round_trip::<session_event::Created>(&input),
            "SessionEvent.session.agent.selected" => {
                round_trip::<session_event::AgentSelected>(&input)
            }
            "SessionEvent.session.model.selected" => {
                round_trip::<session_event::ModelSelected>(&input)
            }
            "SessionEvent.session.profile.bound" => {
                round_trip::<session_event::ProfileBound>(&input)
            }
            "SessionEvent.session.guardrail.approved" => {
                round_trip::<session_event::GuardrailApproved>(&input)
            }
            "SessionEvent.session.daybreak.set" => round_trip::<session_event::DaybreakSet>(&input),
            "SessionEvent.session.project-artifacts-ended" => {
                round_trip::<session_event::ProjectArtifactsEnded>(&input)
            }
            "SessionEvent.session.moved" => round_trip::<session_event::Moved>(&input),
            "SessionEvent.session.renamed" => round_trip::<session_event::Renamed>(&input),
            "SessionEvent.session.usage.recorded" => {
                round_trip::<session_event::UsageRecorded>(&input)
            }
            "SessionEvent.session.provider.request.recorded" => {
                round_trip::<session_event::ProviderRequestRecorded>(&input)
            }
            "SessionEvent.session.usage.updated" => {
                round_trip::<session_event::UsageUpdated>(&input)
            }
            "SessionEvent.session.prediction.updated" => {
                round_trip::<session_event::PredictionUpdated>(&input)
            }
            "SessionEvent.session.diagnostics.updated" => {
                round_trip::<session_event::DiagnosticsUpdated>(&input)
            }
            "SessionEvent.session.deleted" => round_trip::<session_event::Deleted>(&input),
            "SessionEvent.session.archived" => round_trip::<session_event::Archived>(&input),
            "SessionEvent.session.unarchived" => round_trip::<session_event::Unarchived>(&input),
            "SessionEvent.session.pinned" => round_trip::<session_event::Pinned>(&input),
            "SessionEvent.session.unpinned" => round_trip::<session_event::Unpinned>(&input),
            "SessionEvent.session.forked" => round_trip::<session_event::Forked>(&input),
            "SessionEvent.session.input.promoted" => {
                round_trip::<session_event::InputPromoted>(&input)
            }
            "SessionEvent.session.input.admitted" => {
                round_trip::<session_event::InputAdmitted>(&input)
            }
            "SessionEvent.session.input.consumed" => {
                round_trip::<session_event::InputConsumed>(&input)
            }
            "SessionEvent.session.execution.started" => {
                round_trip::<session_event::ExecutionStarted>(&input)
            }
            "SessionEvent.session.execution.succeeded" => {
                round_trip::<session_event::ExecutionSucceeded>(&input)
            }
            "SessionEvent.session.execution.failed" => {
                round_trip::<session_event::ExecutionFailed>(&input)
            }
            "SessionEvent.session.execution.interrupted" => {
                round_trip::<session_event::ExecutionInterrupted>(&input)
            }
            "SessionEvent.session.work.completed" => {
                round_trip::<session_event::WorkCompleted>(&input)
            }
            "SessionEvent.session.instructions.updated" => {
                round_trip::<session_event::InstructionsUpdated>(&input)
            }
            "SessionEvent.session.context.observed" => {
                round_trip::<session_event::ContextObserved>(&input)
            }
            "SessionEvent.session.task.updated" => round_trip::<session_event::TaskUpdated>(&input),
            "SessionEvent.session.synthetic" => round_trip::<session_event::Synthetic>(&input),
            "SessionEvent.session.skill.activated" => {
                round_trip::<session_event::SkillActivated>(&input)
            }
            "SessionEvent.session.skill.deactivated" => {
                round_trip::<session_event::SkillDeactivated>(&input)
            }
            "SessionEvent.session.shell.started" => {
                round_trip::<session_event::ShellStarted>(&input)
            }
            "SessionEvent.session.shell.ended" => round_trip::<session_event::ShellEnded>(&input),
            "SessionEvent.session.step.started" => round_trip::<session_event::StepStarted>(&input),
            "SessionEvent.session.step.ended" => round_trip::<session_event::StepEnded>(&input),
            "SessionEvent.session.step.failed" => round_trip::<session_event::StepFailed>(&input),
            "SessionEvent.session.text.started" => round_trip::<session_event::TextStarted>(&input),
            "SessionEvent.session.text.delta" => round_trip::<session_event::TextDelta>(&input),
            "SessionEvent.session.text.ended" => round_trip::<session_event::TextEnded>(&input),
            "SessionEvent.session.reasoning.started" => {
                round_trip::<session_event::ReasoningStarted>(&input)
            }
            "SessionEvent.session.reasoning.delta" => {
                round_trip::<session_event::ReasoningDelta>(&input)
            }
            "SessionEvent.session.reasoning.ended" => {
                round_trip::<session_event::ReasoningEnded>(&input)
            }
            "SessionEvent.session.tool.input.started" => {
                round_trip::<session_event::ToolInputStarted>(&input)
            }
            "SessionEvent.session.tool.input.delta" => {
                round_trip::<session_event::ToolInputDelta>(&input)
            }
            "SessionEvent.session.tool.input.ended" => {
                round_trip::<session_event::ToolInputEnded>(&input)
            }
            "SessionEvent.session.tool.called" => round_trip::<session_event::ToolCalled>(&input),
            "SessionEvent.session.tool.progress" => {
                round_trip::<session_event::ToolProgress>(&input)
            }
            "SessionEvent.session.tool.success" => round_trip::<session_event::ToolSuccess>(&input),
            "SessionEvent.session.tool.failed" => round_trip::<session_event::ToolFailed>(&input),
            "SessionEvent.session.file-change.recorded" => {
                round_trip::<session_event::FileChangeRecorded>(&input)
            }
            "SessionEvent.session.retry.scheduled" => {
                round_trip::<session_event::RetryScheduled>(&input)
            }
            "SessionEvent.session.compaction.admitted" => {
                round_trip::<session_event::CompactionAdmitted>(&input)
            }
            "SessionEvent.session.compaction.started" => {
                round_trip::<session_event::CompactionStarted>(&input)
            }
            "SessionEvent.session.compaction.delta" => {
                round_trip::<session_event::CompactionDelta>(&input)
            }
            "SessionEvent.session.compaction.ended" => {
                round_trip::<session_event::CompactionEnded>(&input)
            }
            "SessionEvent.session.compaction.failed" => {
                round_trip::<session_event::CompactionFailed>(&input)
            }
            "SessionEvent.session.revert.staged" => {
                round_trip::<session_event::RevertStaged>(&input)
            }
            "SessionEvent.session.revert.cleared" => {
                round_trip::<session_event::RevertCleared>(&input)
            }
            "SessionEvent.session.revert.committed" => {
                round_trip::<session_event::RevertCommitted>(&input)
            }
            "Event.IntegrationUpdated" => {
                round_trip::<event::EphemeralPayload<integration::Updated>>(&input)
            }
            "Event.IntegrationConnectionUpdated" => {
                round_trip::<event::EphemeralPayload<integration::ConnectionUpdated>>(&input)
            }
            "Event.PermissionAsked" => {
                round_trip::<event::EphemeralPayload<permission::Asked>>(&input)
            }
            "Event.PermissionReplied" => {
                round_trip::<event::EphemeralPayload<permission::Replied>>(&input)
            }
            "Event.ModelsDevRefreshed" => {
                round_trip::<event::EphemeralPayload<models_dev::Refreshed>>(&input)
            }
            "Event.CatalogUpdated" => {
                round_trip::<event::EphemeralPayload<catalog::Updated>>(&input)
            }
            "Event.ConfigUpdated" => round_trip::<event::EphemeralPayload<config::Updated>>(&input),
            "Event.AgentUpdated" => round_trip::<event::EphemeralPayload<agent::Updated>>(&input),
            "Event.CommandUpdated" => {
                round_trip::<event::EphemeralPayload<command::Updated>>(&input)
            }
            "Model.ProfileName" => round_trip::<model::ProfileName>(&input),
            "Model.Daybreak" => round_trip::<model::Daybreak>(&input),
            "Model.API" => round_trip::<model::Api>(&input),
            "Permission.ID" => round_trip::<permission::Id>(&input),
            "Permission.Reply" => round_trip::<permission::Reply>(&input),
            "Permission.Effect" => round_trip::<permission::Effect>(&input),
            "Permission.Source" => round_trip::<permission::Source>(&input),
            "PermissionSaved.ID" => round_trip::<permission_saved::Id>(&input),
            "Agent.ID" | "Agent.Name" => round_trip::<LosslessString>(&input),
            "Agent.Color" => round_trip::<agent::Color>(&input),
            "ProviderRequest.ID" => round_trip::<provider_request::Id>(&input),
            "ProviderRequest.Source" => round_trip::<provider_request::Source>(&input),
            "ProviderRequest.Record" => round_trip::<provider_request::Record>(&input),
            "ProviderRequest.ModelSpend" => round_trip::<provider_request::ModelSpend>(&input),
            "ProviderRequest.Continuation" => round_trip::<provider_request::Continuation>(&input),
            "ProviderRequest.Invalidation" => round_trip::<provider_request::Invalidation>(&input),
            "ProviderRequest.CostProvenance" => {
                round_trip::<provider_request::CostProvenance>(&input)
            }
            "ProviderRequest.ReportGroup" => round_trip::<provider_request::ReportGroup>(&input),
            "ProviderRequest.ReportSort" => round_trip::<provider_request::ReportSort>(&input),
            "ProviderRequest.ReportOrder" => round_trip::<provider_request::ReportOrder>(&input),
            "Model.Ref" => round_trip::<model::Ref>(&input),
            "Model.Capabilities" => round_trip::<model::Capabilities>(&input),
            "Model.Cost" => round_trip::<model::Cost>(&input),
            "Model.Variant" => round_trip::<model::Variant>(&input),
            "Model.Profile" => round_trip::<model::Profile>(&input),
            "Model.Info" => round_trip::<model::Info>(&input),
            "Model.Default" => round_trip::<model::Default>(&input),
            "Permission.Request" => round_trip::<permission::Request>(&input),
            "Permission.Rule" => round_trip::<permission::Rule>(&input),
            "PermissionSaved.Info" => round_trip::<permission_saved::Info>(&input),
            "Agent.Info" => round_trip::<agent::Info>(&input),
            "Command.Info" => round_trip::<command::Info>(&input),
            "ProviderRequest.ReportInput" => round_trip::<provider_request::ReportInput>(&input),
            "ProviderRequest.Timing" => round_trip::<provider_request::Timing>(&input),
            "ProviderRequest.Speed" => round_trip::<provider_request::Speed>(&input),
            "ProviderRequest.ReportMetrics" => {
                round_trip::<provider_request::ReportMetrics>(&input)
            }
            "ProviderRequest.Summary" => round_trip::<provider_request::Summary>(&input),
            "ProviderRequest.ReportRow" => round_trip::<provider_request::ReportRow>(&input),
            "ProviderRequest.Report" => round_trip::<provider_request::Report>(&input),
            "Session.CacheDiagnostics" => round_trip::<session_cache_diagnostics::Info>(&input),
            "Session.ProviderCache" => {
                round_trip::<session_cache_diagnostics::ProviderCache>(&input)
            }
            "Session.GenerationSpeed" => {
                round_trip::<session_cache_diagnostics::GenerationSpeed>(&input)
            }
            "Session.GenerationSpeedHistory" => {
                round_trip::<session_cache_diagnostics::GenerationSpeedHistory>(&input)
            }
            "Provider.ID" => round_trip::<provider::Id>(&input),
            "Provider.Info" => round_trip::<provider::Info>(&input),
            "Provider.IntegrationRef" => round_trip::<provider::IntegrationRef>(&input),
            "Provider.Request" => round_trip::<provider::Request>(&input),
            "Provider.Settings" => round_trip::<provider::Settings>(&input),
            "Connection.Info" => round_trip::<connection::Info>(&input),
            "Connection.CredentialInfo" => round_trip::<connection::CredentialInfo>(&input),
            "Connection.EnvInfo" => round_trip::<connection::EnvInfo>(&input),
            "Credential.ID" => round_trip::<credential::Id>(&input),
            "Credential.OAuth" => round_trip::<credential::OAuth>(&input),
            "Credential.Key" => round_trip::<credential::Key>(&input),
            "Credential.Value" => round_trip::<credential::Value>(&input),
            "Integration.Method" => round_trip::<integration::Method>(&input),
            "Integration.Info" => round_trip::<integration::Info>(&input),
            "Integration.AttemptID" => round_trip::<integration::AttemptId>(&input),
            "Integration.When" => round_trip::<integration::When>(&input),
            "Integration.Inputs" => round_trip::<integration::Inputs>(&input),
            "Integration.TextPrompt" => round_trip::<integration::TextPrompt>(&input),
            "Integration.SelectPrompt" => round_trip::<integration::SelectPrompt>(&input),
            "Integration.Prompt" => round_trip::<integration::Prompt>(&input),
            "Integration.OAuthMethod" => round_trip::<integration::OAuthMethod>(&input),
            "Integration.CommandMethod" => round_trip::<integration::CommandMethod>(&input),
            "Integration.KeyMethod" => round_trip::<integration::KeyMethod>(&input),
            "Integration.EnvMethod" => round_trip::<integration::EnvMethod>(&input),
            "Integration.Ref" => round_trip::<integration::Ref>(&input),
            "Integration.Attempt" => round_trip::<integration::Attempt>(&input),
            "Integration.AttemptStatus" => round_trip::<integration::AttemptStatus>(&input),
            "Integration.CommandAttempt" => round_trip::<integration::CommandAttempt>(&input),
            "Integration.CommandAttemptStatus" => {
                round_trip::<integration::CommandAttemptStatus>(&input)
            }
            "ProviderUsage.Window" => round_trip::<provider_usage::Window>(&input),
            "ProviderUsage.Status" => round_trip::<provider_usage::Status>(&input),
            "ProviderUsage.Source" => round_trip::<provider_usage::Source>(&input),
            "ProviderUsage.Stability" => round_trip::<provider_usage::Stability>(&input),
            "ProviderUsage.Unit" => round_trip::<provider_usage::Unit>(&input),
            "ProviderUsage.Snapshot" => round_trip::<provider_usage::Snapshot>(&input),
            "ProviderUsage.Observation" => round_trip::<provider_usage::Observation>(&input),
            "Config.Diagnostic" => round_trip::<config::Diagnostic>(&input),
            "Config.DiagnosticReason" => round_trip::<config::DiagnosticReason>(&input),
            "LLM.ToolContent" => round_trip::<llm::ToolContent>(&input),
            "LLM.FinishReason" => round_trip::<llm::FinishReason>(&input),
            "LLM.ProviderMetadata" => round_trip::<llm::ProviderMetadata>(&input),
            "LLM.ToolTextContent" => round_trip::<llm::ToolTextContent>(&input),
            "LLM.ToolFileContent" => round_trip::<llm::ToolFileContent>(&input),
            "Prompt.Prompt" => round_trip::<prompt::Prompt>(&input),
            "PromptInput.Prompt" => round_trip::<prompt_input::Prompt>(&input),
            "PromptInput.FileAttachment" => round_trip::<prompt_input::FileAttachment>(&input),
            "Prompt.Base64" => round_trip::<prompt::Base64>(&input),
            "Prompt.AttachmentDigest" => round_trip::<prompt::AttachmentDigest>(&input),
            "Prompt.Mention" => round_trip::<prompt::Mention>(&input),
            "Prompt.ManagedAttachmentContent" => {
                round_trip::<prompt::ManagedAttachmentContent>(&input)
            }
            "Prompt.FileAttachment" => round_trip::<prompt::FileAttachment>(&input),
            "Prompt.AgentAttachment" => round_trip::<prompt::AgentAttachment>(&input),
            "Schema.PositiveInt" => round_trip::<schema::PositiveInt>(&input),
            "Schema.NonNegativeInt" => round_trip::<schema::NonNegativeInt>(&input),
            "Schema.RelativePath" => round_trip::<schema::RelativePath>(&input),
            "Schema.AbsolutePath" => round_trip::<schema::AbsolutePath>(&input),
            "Schema.DateTimeUtcFromMillis" => round_trip::<schema::DateTimeUtcFromMillis>(&input),
            "Money.USD" => round_trip::<money::Usd>(&input),
            "Money.USDPerMillionTokens" => round_trip::<money::UsdPerMillionTokens>(&input),
            "SessionID" => round_trip::<session_id::SessionId>(&input),
            "ProjectID" => round_trip::<project_id::ProjectId>(&input),
            "WorkspaceID" => round_trip::<workspace_id::WorkspaceId>(&input),
            "SessionMessageID.ID" => round_trip::<session_message_id::Id>(&input),
            "IntegrationID" => round_trip::<integration_id::IntegrationId>(&input),
            "IntegrationMethodID" => round_trip::<integration_id::IntegrationMethodId>(&input),
            "Snapshot.ID" => round_trip::<snapshot::Id>(&input),
            "Event.ID" => round_trip::<event::Id>(&input),
            "Event.Seq" => round_trip::<event::Seq>(&input),
            "Event.Version" => round_trip::<event::Version>(&input),
            "SourceEpoch" => round_trip::<source_epoch::SourceEpoch>(&input),
            "TokenUsage.Info" => round_trip::<token_usage::Info>(&input),
            "Location.Ref" => round_trip::<location::Ref>(&input),
            "Location.Info" => round_trip::<location::Info>(&input),
            "Location.Response" => round_trip::<location::Response<JsonValue>>(&input),
            "Event.Durable" => round_trip::<event::DurablePayload<Changed>>(&input),
            "Event.Ephemeral" => round_trip::<event::EphemeralPayload<Ping>>(&input),
            "Contract.Presence" => round_trip::<PresenceRecord>(&input),
            "Contract.BoundedString" => {
                domain::bounded_string(&input, 1, 2, &JsonPath::default()).map(|text| text.encode())
            }
            "Contract.IntegerRange" => {
                domain::integer_range(&input, -2, 2, &JsonPath::default()).map(JsonValue::Number)
            }
            "Contract.Literal" => {
                domain::literal_enum(&input, &["normal", "goal"], &JsonPath::default())
                    .map(|text| text.encode())
            }
            "Contract.Tagged" => round_trip::<Tagged>(&input),
            "Contract.Open" => round_trip::<JsonValue>(&input),
            "Contract.Json" => round_trip::<domain::Json>(&input),
            "Contract.NumberRange" => {
                domain::number_range(&input, -1.0, 1.0, &JsonPath::default()).map(JsonValue::Number)
            }
            "Contract.Nullable" => round_trip::<Nullable<LosslessString>>(&input),
            "Contract.Metadata" => round_trip::<ycoding_schema::JsonObject>(&input),
            "Contract.NumericLiteral" => domain::literal(
                &input,
                &[
                    JsonValue::Number(0.0),
                    JsonValue::Number(1.0),
                    JsonValue::Number(2.0),
                ],
                &JsonPath::default(),
            ),
            "Contract.Finite" => round_trip::<schema::Finite>(&input),
            "SessionDelivery.Delivery" => round_trip::<session_delivery::Delivery>(&input),
            "SessionError.Error" => round_trip::<session_error::Error>(&input),
            "Remote.State" => round_trip::<remote::State>(&input),
            "Remote.Status" => round_trip::<remote::Status>(&input),
            "KeepAwake.State" => round_trip::<keep_awake::State>(&input),
            "KeepAwake.Status" => round_trip::<keep_awake::Status>(&input),
            "FileDiff.Info" => round_trip::<file_diff::Info>(&input),
            "FileDiff.LegacyInfo" => round_trip::<file_diff::LegacyInfo>(&input),
            "Vcs.Mode" => round_trip::<vcs::Mode>(&input),
            "Vcs.FileStatus" => round_trip::<vcs::FileStatus>(&input),
            "Vcs.Branch" => round_trip::<vcs::Branch>(&input),
            "Instruction.Key" => round_trip::<instruction::Key>(&input),
            "Instruction.Hash" => round_trip::<instruction::Hash>(&input),
            "Instruction.Values" => round_trip::<instruction::Values>(&input),
            "Instruction.Removed" => round_trip::<instruction::Removed>(&input),
            "Instruction.Delta" => round_trip::<instruction::Delta>(&input),
            "InstructionEntry.Key" => round_trip::<instruction_entry::Key>(&input),
            "InstructionEntry.Info" => round_trip::<instruction_entry::Info>(&input),
            "InstructionEntry.ValueTooLargeError" => {
                round_trip::<instruction_entry::ValueTooLargeError>(&input)
            }
            "EventLog.Synced" => round_trip::<event_log::Synced>(&input),
            "Workspace.ID" => round_trip::<workspace::Id>(&input),
            "WorkspaceEvent.ConnectionStatus" => {
                round_trip::<workspace_event::ConnectionStatus>(&input)
            }
            "WorkspaceEvent.Ready" => {
                round_trip::<event::EphemeralPayload<workspace_event::Ready>>(&input)
            }
            "WorkspaceEvent.Failed" => {
                round_trip::<event::EphemeralPayload<workspace_event::Failed>>(&input)
            }
            "WorkspaceEvent.Status" => {
                round_trip::<event::EphemeralPayload<workspace_event::Status>>(&input)
            }
            "WorktreeEvent.Ready" => {
                round_trip::<event::EphemeralPayload<worktree_event::Ready>>(&input)
            }
            "WorktreeEvent.Failed" => {
                round_trip::<event::EphemeralPayload<worktree_event::Failed>>(&input)
            }
            "ServerEvent.Connected" => {
                round_trip::<event::EphemeralPayload<server_event::Connected>>(&input)
            }
            "ServerEvent.Disposed" => {
                round_trip::<event::EphemeralPayload<server_event::Disposed>>(&input)
            }
            "LspEvent.Updated" => round_trip::<event::EphemeralPayload<lsp_event::Updated>>(&input),
            "InstallationEvent.Updated" => {
                round_trip::<event::EphemeralPayload<installation_event::Updated>>(&input)
            }
            "InstallationEvent.UpdateAvailable" => {
                round_trip::<event::EphemeralPayload<installation_event::UpdateAvailable>>(&input)
            }
            "VcsEvent.BranchUpdated" => {
                round_trip::<event::EphemeralPayload<vcs_event::BranchUpdated>>(&input)
            }
            "SessionMessage.Info" => round_trip::<session_message::Info>(&input),
            "SessionMessage.AgentSelected" => round_trip::<session_message::AgentSelected>(&input),
            "SessionMessage.ModelSelected" => round_trip::<session_message::ModelSelected>(&input),
            "SessionMessage.User" => round_trip::<session_message::User>(&input),
            "SessionMessage.Synthetic" => round_trip::<session_message::Synthetic>(&input),
            "SessionMessage.System" => round_trip::<session_message::System>(&input),
            "SessionMessage.Skill" => round_trip::<session_message::Skill>(&input),
            "SessionMessage.Shell" => round_trip::<session_message::Shell>(&input),
            "SessionMessage.Assistant" => round_trip::<session_message::Assistant>(&input),
            "SessionMessage.AssistantContent" => {
                round_trip::<session_message::AssistantContent>(&input)
            }
            "SessionMessage.ToolState" => round_trip::<session_message::ToolState>(&input),
            "SessionMessage.Compaction" => round_trip::<session_message::Compaction>(&input),
            "SessionMessage.ArtifactProvenance" => {
                round_trip::<session_message::ArtifactProvenance>(&input)
            }
            "SessionMessage.ProviderState" => round_trip::<session_message::ProviderState>(&input),
            "SessionMessage.AssistantRetry" => {
                round_trip::<session_message::AssistantRetry>(&input)
            }
            "SessionOrchestration.State" => round_trip::<session_orchestration::State>(&input),
            "SessionOrchestration.TerminalState" => {
                round_trip::<session_orchestration::TerminalState>(&input)
            }
            "SessionOrchestration.QuestionID" => {
                round_trip::<session_orchestration::QuestionId>(&input)
            }
            "SessionOrchestration.Progress" => {
                round_trip::<session_orchestration::Progress>(&input)
            }
            "SessionOrchestration.Question" => {
                round_trip::<session_orchestration::Question>(&input)
            }
            "SessionOrchestration.Answer" => round_trip::<session_orchestration::Answer>(&input),
            "SessionOrchestration.ListAnchor" => {
                round_trip::<session_orchestration::ListAnchor>(&input)
            }
            "SessionOrchestration.Notification" => {
                round_trip::<session_orchestration::Notification>(&input)
            }
            "SessionRevert.Revert" => round_trip::<session_revert::Revert>(&input),
            "SessionPending.UserData" => round_trip::<session_pending::UserData>(&input),
            "SessionPending.SyntheticData" => round_trip::<session_pending::SyntheticData>(&input),
            "SessionPending.Message" => round_trip::<session_pending::Message>(&input),
            "SessionPending.User" => round_trip::<session_pending::User>(&input),
            "SessionPending.Synthetic" => round_trip::<session_pending::Synthetic>(&input),
            "SessionPending.Info" => round_trip::<session_pending::Info>(&input),
            "SessionPending.LegacyInfo" => round_trip::<session_pending::LegacyInfo>(&input),
            "SessionOrchestration.Task" => round_trip::<session_orchestration::Task>(&input),
            "SessionOrchestration.Control" => round_trip::<session_orchestration::Control>(&input),
            "SessionOrchestration.Report" => round_trip::<session_orchestration::Report>(&input),
            "SessionOrchestration.Change" => round_trip::<session_orchestration::Change>(&input),
            "SessionOrchestration.Page" => round_trip::<session_orchestration::Page>(&input),
            "SessionOrchestration.TeamView" => {
                round_trip::<session_orchestration::TeamView>(&input)
            }
            "SessionSkillStatus.State" => round_trip::<session_skill_status::State>(&input),
            "SessionSkillStatus.Conflict" => round_trip::<session_skill_status::Conflict>(&input),
            "SessionSkillStatus.Info" => round_trip::<session_skill_status::Info>(&input),
            "SessionWorkCompletion.Receipt" => {
                round_trip::<session_work_completion::Receipt>(&input)
            }
            "SessionWorkCompletion.Page" => round_trip::<session_work_completion::Page>(&input),
            "SessionTodo.Status" => round_trip::<session_todo::Status>(&input),
            "SessionTodo.Priority" => round_trip::<session_todo::Priority>(&input),
            "SessionTodo.Info" => round_trip::<session_todo::Info>(&input),
            "SessionTodo.Event.Updated" => {
                round_trip::<event::EphemeralPayload<session_todo::Updated>>(&input)
            }
            "SessionStatusEvent.Info" => round_trip::<session_status_event::Info>(&input),
            "SessionStatusEvent.Status" => {
                round_trip::<event::EphemeralPayload<session_status_event::Status>>(&input)
            }
            "SessionStatusEvent.Idle" => {
                round_trip::<event::EphemeralPayload<session_status_event::Idle>>(&input)
            }
            "SessionCompactionEvent.Compacted" => {
                round_trip::<event::EphemeralPayload<session_compaction_event::Compacted>>(&input)
            }
            "TuiEvent.PromptAppend" => {
                round_trip::<event::EphemeralPayload<tui_event::PromptAppend>>(&input)
            }
            "TuiEvent.CommandExecute" => {
                round_trip::<event::EphemeralPayload<tui_event::CommandExecute>>(&input)
            }
            "TuiEvent.ToastShow" => {
                round_trip::<event::EphemeralPayload<tui_event::ToastShow>>(&input)
            }
            "TuiEvent.SessionSelect" => {
                round_trip::<event::EphemeralPayload<tui_event::SessionSelect>>(&input)
            }
            "Skill.ID" => round_trip::<skill::Id>(&input),
            "Skill.Name" => round_trip::<skill::Name>(&input),
            "Skill.Conflicts" => round_trip::<skill::Conflicts>(&input),
            "Skill.DirectorySource" => round_trip::<skill::DirectorySource>(&input),
            "Skill.UrlSource" => round_trip::<skill::UrlSource>(&input),
            "Skill.Info" => round_trip::<skill::Info>(&input),
            "Skill.EmbeddedSource" => round_trip::<skill::EmbeddedSource>(&input),
            "Skill.Source" => round_trip::<skill::Source>(&input),
            "Reference.LocalSource" => round_trip::<reference::LocalSource>(&input),
            "Reference.GitSource" => round_trip::<reference::GitSource>(&input),
            "Reference.Source" => round_trip::<reference::Source>(&input),
            "Reference.Info" => round_trip::<reference::Info>(&input),
            "Plugin.ID" => round_trip::<plugin::Id>(&input),
            "Plugin.Info" => round_trip::<plugin::Info>(&input),
            "Plugin.Event.Added" => round_trip::<event::EphemeralPayload<plugin::Added>>(&input),
            "Plugin.Event.Updated" => {
                round_trip::<event::EphemeralPayload<plugin::Updated>>(&input)
            }
            "Project.ID" => round_trip::<project::Id>(&input),
            "Project.Vcs" => round_trip::<project::Vcs>(&input),
            "Project.Current" => round_trip::<project::Current>(&input),
            "Project.Directory" => round_trip::<project::Directory>(&input),
            "Project.DirectoriesInput" => round_trip::<project::DirectoriesInput>(&input),
            "Project.Directories" => round_trip::<project::Directories>(&input),
            "Project.InventoryEntry" => round_trip::<project::InventoryEntry>(&input),
            "Project.InventoryAnchor" => round_trip::<project::InventoryAnchor>(&input),
            "Project.Icon" => round_trip::<project::Icon>(&input),
            "Project.Commands" => round_trip::<project::Commands>(&input),
            "Project.Time" => round_trip::<project::Time>(&input),
            "Project.Info" => round_trip::<project::Info>(&input),
            "Project.Event.Updated" => {
                round_trip::<event::EphemeralPayload<project::Updated>>(&input)
            }
            "ProjectDirectories.Event.Updated" => {
                round_trip::<event::EphemeralPayload<project_directories::Updated>>(&input)
            }
            "ProjectCopy.StrategyID" => round_trip::<project_copy::StrategyId>(&input),
            "ProjectCopy.CreateInput" => round_trip::<project_copy::CreateInput>(&input),
            "ProjectCopy.RemoveInput" => round_trip::<project_copy::RemoveInput>(&input),
            "ProjectCopy.Copy" => round_trip::<project_copy::Copy>(&input),
            "SessionCompaction.ID" => round_trip::<session_compaction::Id>(&input),
            "SessionCompaction.Trigger" => round_trip::<session_compaction::Trigger>(&input),
            "SessionCompaction.FailureCode" => {
                round_trip::<session_compaction::FailureCode>(&input)
            }
            "SessionCompaction.Boundary" => round_trip::<session_compaction::Boundary>(&input),
            "SessionCompaction.Metrics" => round_trip::<session_compaction::Metrics>(&input),
            "SessionCompaction.Pressure" => round_trip::<session_compaction::Pressure>(&input),
            "SessionCompaction.Admission" => round_trip::<session_compaction::Admission>(&input),
            "SessionCompaction.Result" => round_trip::<session_compaction::Result>(&input),
            "SessionCompaction.HistoryJob" => round_trip::<session_compaction::HistoryJob>(&input),
            "SessionCompaction.History" => round_trip::<session_compaction::History>(&input),
            "SessionCapturedChanges.Input" => round_trip::<session_captured_changes::Input>(&input),
            "SessionCapturedChanges.Page" => round_trip::<session_captured_changes::Page>(&input),
            "Telemetry.NoticeVersion" => round_trip::<telemetry::NoticeVersion>(&input),
            "Telemetry.Consent" => round_trip::<telemetry::Consent>(&input),
            "Telemetry.ConsentState" => round_trip::<telemetry::ConsentState>(&input),
            "Telemetry.ConsentInput" => round_trip::<telemetry::ConsentInput>(&input),
            "Telemetry.TelemetryDisabled" => round_trip::<telemetry::TelemetryDisabled>(&input),
            "Telemetry.Operation" => round_trip::<telemetry::Operation>(&input),
            "Telemetry.RequestSample" => round_trip::<telemetry::RequestSample>(&input),
            "Telemetry.LongTaskSample" => round_trip::<telemetry::LongTaskSample>(&input),
            "Telemetry.ClientSample" => round_trip::<telemetry::ClientSample>(&input),
            "Telemetry.Sample" => round_trip::<telemetry::Sample>(&input),
            "Telemetry.Batch" => round_trip::<telemetry::Batch>(&input),
            "Telemetry.Page" => round_trip::<telemetry::Page>(&input),
            "FileSystem.Entry" => round_trip::<filesystem::Entry>(&input),
            "FileSystem.Submatch" => round_trip::<filesystem::Submatch>(&input),
            "FileSystem.Match" => round_trip::<filesystem::Match>(&input),
            "FileSystem.FindInput" => round_trip::<filesystem::FindInput>(&input),
            "FileSystem.Event.Changed" => {
                round_trip::<event::EphemeralPayload<filesystem::Changed>>(&input)
            }
            "Form.ID" => round_trip::<form::Id>(&input),
            "Form.Metadata" => round_trip::<form::Metadata>(&input),
            "Form.Option" => round_trip::<form::Option>(&input),
            "Form.When" => round_trip::<form::When>(&input),
            "Form.StringField" => round_trip::<form::StringField>(&input),
            "Form.NumberField" => round_trip::<form::NumberField>(&input),
            "Form.IntegerField" => round_trip::<form::IntegerField>(&input),
            "Form.BooleanField" => round_trip::<form::BooleanField>(&input),
            "Form.MultiselectField" => round_trip::<form::MultiselectField>(&input),
            "Form.ExternalField" => round_trip::<form::ExternalField>(&input),
            "Form.Field" => round_trip::<form::Field>(&input),
            "Form.Fields" => round_trip::<form::Fields>(&input),
            "Form.Info" => round_trip::<form::Info>(&input),
            "Form.Value" => round_trip::<form::Value>(&input),
            "Form.Answer" => round_trip::<form::Answer>(&input),
            "Form.State" => round_trip::<form::State>(&input),
            "Form.Reply" => round_trip::<form::Reply>(&input),
            "Form.Event.Created" => round_trip::<event::EphemeralPayload<form::Created>>(&input),
            "Form.Event.Replied" => round_trip::<event::EphemeralPayload<form::Replied>>(&input),
            "Form.Event.Cancelled" => {
                round_trip::<event::EphemeralPayload<form::Cancelled>>(&input)
            }
            "Question.ID" => round_trip::<question::Id>(&input),
            "Question.Option" => round_trip::<question::Option>(&input),
            "Question.Info" => round_trip::<question::Info>(&input),
            "Question.Prompt" => round_trip::<question::Prompt>(&input),
            "Question.Tool" => round_trip::<question::Tool>(&input),
            "Question.Request" => round_trip::<question::Request>(&input),
            "Question.Answer" => round_trip::<question::Answer>(&input),
            "Question.Reply" => round_trip::<question::Reply>(&input),
            "Question.Event.Asked" => {
                round_trip::<event::EphemeralPayload<question::Asked>>(&input)
            }
            "Question.Event.Replied" => {
                round_trip::<event::EphemeralPayload<question::Replied>>(&input)
            }
            "Question.Event.Rejected" => {
                round_trip::<event::EphemeralPayload<question::Rejected>>(&input)
            }
            "Guardrail.RequestID" => round_trip::<guardrail::RequestId>(&input),
            "Guardrail.RuleSource" => round_trip::<guardrail::RuleSource>(&input),
            "Guardrail.RuleDecision" => round_trip::<guardrail::RuleDecision>(&input),
            "Guardrail.Decision" => round_trip::<guardrail::Decision>(&input),
            "Guardrail.Rule" => round_trip::<guardrail::Rule>(&input),
            "Guardrail.Ruleset" => round_trip::<guardrail::Ruleset>(&input),
            "Guardrail.Risk" => round_trip::<guardrail::Risk>(&input),
            "Guardrail.Request" => round_trip::<guardrail::Request>(&input),
            "Guardrail.Reply" => round_trip::<guardrail::Reply>(&input),
            "Guardrail.Counter" => round_trip::<guardrail::Counter>(&input),
            "Guardrail.Status" => round_trip::<guardrail::Status>(&input),
            "Guardrail.Event.Asked" => {
                round_trip::<event::EphemeralPayload<guardrail::Asked>>(&input)
            }
            "Guardrail.Event.Replied" => {
                round_trip::<event::EphemeralPayload<guardrail::Replied>>(&input)
            }
            "Guardrail.Event.Decided" => {
                round_trip::<event::EphemeralPayload<guardrail::Decided>>(&input)
            }
            "Shell.ID" => round_trip::<shell::Id>(&input),
            "Shell.Status" => round_trip::<shell::Status>(&input),
            "Shell.MemoryLimitMb" => round_trip::<shell::MemoryLimitMb>(&input),
            "Shell.Time" => round_trip::<shell::Time>(&input),
            "Shell.Metadata" => round_trip::<shell::Metadata>(&input),
            "Shell.Info" => round_trip::<shell::Info>(&input),
            "Shell.Event.Created" => round_trip::<event::EphemeralPayload<shell::Created>>(&input),
            "Shell.Event.Exited" => round_trip::<event::EphemeralPayload<shell::Exited>>(&input),
            "Shell.Event.Deleted" => round_trip::<event::EphemeralPayload<shell::Deleted>>(&input),
            "Shell.CreateInput" => round_trip::<shell::CreateInput>(&input),
            "Shell.OutputInput" => round_trip::<shell::OutputInput>(&input),
            "Shell.Output" => round_trip::<shell::Output>(&input),
            "Pty.ID" => round_trip::<pty::Id>(&input),
            "Pty.Generation" => round_trip::<pty::Generation>(&input),
            "Pty.Offset" => round_trip::<pty::Offset>(&input),
            "Pty.Size" => round_trip::<pty::Size>(&input),
            "Pty.Actor" => round_trip::<pty::Actor>(&input),
            "Pty.ControlOwner" => round_trip::<pty::ControlOwner>(&input),
            "Pty.Access" => round_trip::<pty::Access>(&input),
            "Pty.Info" => round_trip::<pty::Info>(&input),
            "Pty.Event.Created" => round_trip::<event::EphemeralPayload<pty::Created>>(&input),
            "Pty.Event.Updated" => round_trip::<event::EphemeralPayload<pty::Updated>>(&input),
            "Pty.Event.Exited" => round_trip::<event::EphemeralPayload<pty::Exited>>(&input),
            "Pty.Event.Deleted" => round_trip::<event::EphemeralPayload<pty::Deleted>>(&input),
            "Pty.CreateInput" => round_trip::<pty::CreateInput>(&input),
            "Pty.UpdateInput" => round_trip::<pty::UpdateInput>(&input),
            "Pty.OwnerInput" => round_trip::<pty::OwnerInput>(&input),
            "Pty.ControlInput" => round_trip::<pty::ControlInput>(&input),
            "Pty.ConnectInput" => round_trip::<pty::ConnectInput>(&input),
            "PtyTicket.ConnectToken" => round_trip::<pty_ticket::ConnectToken>(&input),
            "Mcp.TimeoutConfig" => round_trip::<mcp::TimeoutConfig>(&input),
            "Mcp.LocalConfig" => round_trip::<mcp::LocalConfig>(&input),
            "Mcp.OAuthConfig" => round_trip::<mcp::OAuthConfig>(&input),
            "Mcp.RemoteConfig" => round_trip::<mcp::RemoteConfig>(&input),
            "Mcp.ServerConfig" => round_trip::<mcp::ServerConfig>(&input),
            "Mcp.Status" => round_trip::<mcp::Status>(&input),
            "Mcp.Server" => round_trip::<mcp::Server>(&input),
            "Mcp.Resource" => round_trip::<mcp::Resource>(&input),
            "Mcp.ResourceTemplate" => round_trip::<mcp::ResourceTemplate>(&input),
            "Mcp.ResourceCatalog" => round_trip::<mcp::ResourceCatalog>(&input),
            "Mcp.ResourceContentPart" => round_trip::<mcp::ResourceContentPart>(&input),
            "Mcp.ResourceContent" => round_trip::<mcp::ResourceContent>(&input),
            "McpSkill.Digest" => round_trip::<mcp_skill::Digest>(&input),
            "McpSkill.ResourceEntry" => round_trip::<mcp_skill::ResourceEntry>(&input),
            "McpSkill.Entry" => round_trip::<mcp_skill::Entry>(&input),
            "McpSkill.Capability" => round_trip::<mcp_skill::Capability>(&input),
            "McpSkill.File" => round_trip::<mcp_skill::File>(&input),
            "McpSkill.Reason" => round_trip::<mcp_skill::Reason>(&input),
            "McpEvent.ToolsChanged" => {
                round_trip::<event::EphemeralPayload<mcp_event::ToolsChanged>>(&input)
            }
            "McpEvent.ResourcesChanged" => {
                round_trip::<event::EphemeralPayload<mcp_event::ResourcesChanged>>(&input)
            }
            "McpEvent.BrowserOpenFailed" => {
                round_trip::<event::EphemeralPayload<mcp_event::BrowserOpenFailed>>(&input)
            }
            "McpEvent.StatusChanged" => {
                round_trip::<event::EphemeralPayload<mcp_event::StatusChanged>>(&input)
            }
            "Browser.TabID" => round_trip::<browser::TabId>(&input),
            "Browser.Generation" => round_trip::<browser::Generation>(&input),
            "Browser.DocumentGeneration" => round_trip::<browser::DocumentGeneration>(&input),
            "Browser.ObservationRevision" => round_trip::<browser::ObservationRevision>(&input),
            "Browser.CallID" => round_trip::<browser::CallId>(&input),
            "Browser.Page" => round_trip::<browser::Page>(&input),
            "Browser.TabStatus" => round_trip::<browser::TabStatus>(&input),
            "Browser.PauseReason" => round_trip::<browser::PauseReason>(&input),
            "Browser.Tab" => round_trip::<browser::Tab>(&input),
            "Browser.BridgeState" => round_trip::<browser::BridgeState>(&input),
            "Browser.Status" => round_trip::<browser::Status>(&input),
            "Browser.Pairing" => round_trip::<browser::Pairing>(&input),
            "Browser.Element" => round_trip::<browser::Element>(&input),
            "Browser.Observation" => round_trip::<browser::Observation>(&input),
            "Browser.Navigate" => round_trip::<browser::Navigate>(&input),
            "Browser.Click" => round_trip::<browser::Click>(&input),
            "Browser.Type" => round_trip::<browser::Type>(&input),
            "Browser.Scroll" => round_trip::<browser::Scroll>(&input),
            "Browser.Capture" => round_trip::<browser::Capture>(&input),
            "Browser.Group" => round_trip::<browser::Group>(&input),
            "Browser.Ungroup" => round_trip::<browser::Ungroup>(&input),
            "Browser.Action" => round_trip::<browser::Action>(&input),
            "Browser.ActionInput" => round_trip::<browser::ActionInput>(&input),
            "Browser.ObserveInput" => round_trip::<browser::ObserveInput>(&input),
            "Browser.OpenInput" => round_trip::<browser::OpenInput>(&input),
            "Browser.CloseInput" => round_trip::<browser::CloseInput>(&input),
            "Browser.ReleaseInput" => round_trip::<browser::ReleaseInput>(&input),
            "Browser.CaptureOutput" => round_trip::<browser::CaptureOutput>(&input),
            "Browser.ActionResult" => round_trip::<browser::ActionResult>(&input),
            "Browser.ControlInput" => round_trip::<browser::ControlInput>(&input),
            "IsolatedBrowser.InstanceID" => round_trip::<isolated_browser::InstanceId>(&input),
            "IsolatedBrowser.State" => round_trip::<isolated_browser::State>(&input),
            "IsolatedBrowser.Status" => round_trip::<isolated_browser::Status>(&input),
            "IsolatedBrowser.StartInput" => round_trip::<isolated_browser::StartInput>(&input),
            "IsolatedBrowser.StartPayload" => round_trip::<isolated_browser::StartPayload>(&input),
            "IsolatedBrowser.ObserveInput" => round_trip::<isolated_browser::ObserveInput>(&input),
            "IsolatedBrowser.ActionInput" => round_trip::<isolated_browser::ActionInput>(&input),
            "IsolatedBrowser.Observation" => round_trip::<isolated_browser::Observation>(&input),
            "IsolatedBrowser.ActionResult" => round_trip::<isolated_browser::ActionResult>(&input),
            "IsolatedBrowser.ControlInput" => round_trip::<browser::ControlInput>(&input),
            name => panic!("unregistered golden type {name}"),
        };
        assert_eq!(
            result.as_ref().ok().map(negative_zeros).unwrap_or_default(),
            golden.negative_zeros,
            "{}: {} negative zero",
            golden.name,
            golden.input
        );
        assert_eq!(
            result.ok().map(|value| stringify_json(&value)),
            golden.output,
            "{}: {}",
            golden.name,
            golden.input
        );
    }
}

#[derive(Deserialize)]
struct IdentifierGolden {
    timestamp: String,
    descending: bool,
    entropy: [u8; 14],
    output: String,
}
#[derive(Deserialize)]
struct InvalidIdentifierGolden {
    timestamp: String,
    entropy: [u8; 14],
    output: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryGolden {
    indices: Vec<usize>,
    latest: Option<String>,
    durable_map: Option<String>,
}
#[derive(Deserialize)]
struct VersionGolden {
    input: String,
    output: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestGolden {
    all: Vec<String>,
    server: Vec<String>,
    durable: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupportGoldens {
    identifiers: Vec<IdentifierGolden>,
    invalid_identifiers: Vec<InvalidIdentifierGolden>,
    inventories: Vec<InventoryGolden>,
    versions: Vec<VersionGolden>,
    event_manifests: ManifestGolden,
}

#[test]
fn effect_support_goldens() {
    let goldens: SupportGoldens =
        serde_json::from_str(include_str!("fixtures/domain-support.json")).unwrap();
    let mut generator = identifier::Generator::default();
    for golden in goldens.identifiers {
        let JsonValue::Number(timestamp) = parse_json(&golden.timestamp).unwrap() else {
            panic!()
        };
        assert_eq!(
            generator
                .create(golden.descending, timestamp, golden.entropy)
                .unwrap(),
            LosslessString::from(golden.output)
        );
    }
    for golden in goldens.invalid_identifiers {
        let JsonValue::Number(timestamp) = parse_json(&golden.timestamp).unwrap() else {
            panic!()
        };
        assert_eq!(
            generator
                .create(false, timestamp, golden.entropy)
                .ok()
                .map(|value| stringify_json(&value.encode())),
            golden.output
        );
    }
    let definitions = [
        event::Definition {
            event_type: "a".into(),
            durability: event::Durability::Durable {
                version: event::Version::new(1).unwrap(),
                aggregate: "a".into(),
            },
        },
        event::Definition {
            event_type: "b".into(),
            durability: event::Durability::Ephemeral,
        },
        event::Definition {
            event_type: "a".into(),
            durability: event::Durability::Durable {
                version: event::Version::new(2).unwrap(),
                aggregate: "a".into(),
            },
        },
    ];
    for golden in goldens.inventories {
        let inventory: Vec<_> = golden
            .indices
            .iter()
            .map(|index| &definitions[*index])
            .collect();
        let latest = event::latest(&inventory).map(|entries| {
            JsonValue::Array(
                entries
                    .into_iter()
                    .map(|(key, definition)| {
                        JsonValue::Array(vec![
                            key.encode(),
                            match definition.durability {
                                event::Durability::Durable { version, .. } => version.encode(),
                                event::Durability::Ephemeral => JsonValue::Null,
                            },
                        ])
                    })
                    .collect(),
            )
        });
        let durable_map = event::durable_map(&inventory).map(|entries| {
            JsonValue::Array(entries.into_iter().map(|(key, _)| key.encode()).collect())
        });
        assert_eq!(
            latest.ok().map(|value| stringify_json(&value)),
            golden.latest
        );
        assert_eq!(
            durable_map.ok().map(|value| stringify_json(&value)),
            golden.durable_map
        );
    }
    assert_eq!(
        event_manifest::definitions()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        goldens.event_manifests.all
    );
    assert_eq!(
        event_manifest::server_definitions()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        goldens.event_manifests.server
    );
    assert_eq!(
        durable_event_manifest::definitions()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        goldens.event_manifests.durable
    );
    for golden in goldens.versions {
        let JsonValue::Number(number) = parse_json(&golden.input).unwrap() else {
            panic!()
        };
        assert_eq!(
            stringify_json(
                &event::versioned_type(&LosslessString::from_utf16(vec![97, 0xd800]), number)
                    .encode()
            ),
            golden.output
        );
    }
}

#[test]
fn errors_retain_nested_lossless_paths() {
    let error = token_usage::Info::decode(
        &parse_json(r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0}}"#).unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.kind, DecodeErrorKind::Missing);
    assert_eq!(error.path.to_string(), "$[\"cache\"][\"write\"]");
    let error = Vec::<schema::Finite>::decode(&parse_json("[1,null]").unwrap()).unwrap_err();
    assert_eq!(error.path.to_string(), "$[1]");
    assert_eq!(error.kind, DecodeErrorKind::Expected("number"));
    let path = JsonPath::default().key(LosslessString::from_utf16(vec![0xd800]));
    assert_eq!(path.to_string(), "$[\"\\ud800\"]");
}

#[test]
fn constructors_and_event_version_encoding() {
    assert_eq!(
        project_id::ProjectId::global().as_lossless(),
        &LosslessString::from("global")
    );
    assert_eq!(money::Usd::zero().get(), 0.0);
    assert_eq!(money::UsdPerMillionTokens::zero().get(), 0.0);
    let event_id =
        event::Id::new(LosslessString::from_utf16(vec![101, 118, 116, 95, 0xd800])).unwrap();
    assert_eq!(
        stringify_json(&session_message_id::Id::from_event(&event_id).encode()),
        r#""msg_\ud800""#
    );
    let mut payload = event::DurablePayload::<Changed>::decode(&parse_json(r#"{"id":"evt_","created":0,"type":"fixture.changed","durable":{"aggregateID":"x","seq":0,"version":2},"data":{"text":""}}"#).unwrap()).unwrap();
    payload.durable.version = event::Version::new(3).unwrap();
    assert!(stringify_json(&payload.encode()).contains("\"version\":2"));
    assert!(schema::PositiveInt::new(0).is_err());
    assert!(schema::NonNegativeInt::new(-1).is_err());
    assert!(schema::Int::new(i64::MAX).is_err());
    assert!(money::Usd::new(f64::NAN).is_err());
}

#[test]
fn event_definition_inventory_rules() {
    let v2 = event::Definition::durable::<Changed>().unwrap();
    let v1 = event::Definition {
        event_type: "fixture.changed".into(),
        durability: event::Durability::Durable {
            version: event::Version::new(1).unwrap(),
            aggregate: "fixture".into(),
        },
    };
    let ping = event::Definition::ephemeral::<Ping>();
    let latest = event::latest(&[&v1, &ping, &v2, &v1, &v2]).unwrap();
    assert_eq!(
        latest
            .iter()
            .map(|(key, _)| key.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["fixture.changed", "fixture.ping"]
    );
    assert!(std::ptr::eq(latest[0].1, &v2));
    assert_eq!(
        event::durable_map(&[&v1, &ping, &v2])
            .unwrap()
            .iter()
            .map(|(key, _)| key.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["fixture.changed.1", "fixture.changed.2"]
    );
    assert!(event::durable_map(&[&v2, &v2]).is_err());
    assert!(event::latest(&[&v2, &v2.clone()]).is_err());
    let same_type_ephemeral = event::Definition {
        event_type: "fixture.changed".into(),
        durability: event::Durability::Ephemeral,
    };
    assert!(event::latest(&[&v2, &same_type_ephemeral]).is_err());
}

#[test]
fn ported_event_definition_helpers_preserve_event_types() {
    assert_eq!(
        integration::definitions().map(|definition| definition.event_type),
        [
            LosslessString::from("integration.updated"),
            LosslessString::from("integration.connection.updated")
        ]
    );
    assert_eq!(
        permission::definitions().map(|definition| definition.event_type),
        [
            LosslessString::from("permission.asked"),
            LosslessString::from("permission.replied")
        ]
    );
    assert_eq!(
        catalog::definition().event_type,
        LosslessString::from("catalog.updated")
    );
    assert_eq!(
        models_dev::definitions()[0].event_type,
        LosslessString::from("models-dev.refreshed")
    );
    assert_eq!(
        config::definition().event_type,
        LosslessString::from("config.updated")
    );
    assert_eq!(
        agent::definition().event_type,
        LosslessString::from("agent.updated")
    );
    assert_eq!(
        command::definition().event_type,
        LosslessString::from("command.updated")
    );
}
