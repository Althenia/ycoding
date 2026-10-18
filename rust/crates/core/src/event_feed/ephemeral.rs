use ycoding_schema::{
    DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder,
    agent, catalog, command, config, filesystem, form, guardrail, installation_event, integration,
    mcp_event, models_dev, permission, plugin, project_directories, pty, question, session,
    session_cache_diagnostics, session_message, session_status_event, session_todo, shell,
    tui_event, vcs_event,
};

macro_rules! data {
    ($name:ident { $($field:ident: $type:ty => $key:literal),* $(,)? }) => {
        #[derive(Clone, Debug, PartialEq)]
        pub struct $name { $(pub $field: $type),* }
        impl DomainDecode for $name {
            fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, ycoding_schema::DecodeError> {
                let object = ObjectDecoder::new(value, path)?;
                Ok(Self { $($field: object.field($key)?),* })
            }
        }
        impl DomainEncode for $name {
            fn encode(&self) -> JsonValue { ObjectEncoder::new()$(.field($key, &self.$field))*.finish() }
        }
    };
}

data!(Usage {
    session_id: session::Id => "sessionID",
    cost: ycoding_schema::money::Usd => "cost",
    tokens: ycoding_schema::token_usage::Info => "tokens",
});
data!(Prediction {
    session_id: session::Id => "sessionID",
    source_message_id: session_message::Id => "sourceMessageID",
    text: LosslessString => "text",
});
data!(Diagnostics {
    session_id: session::Id => "sessionID",
    diagnostics: session_cache_diagnostics::Info => "diagnostics",
});
data!(Fragment {
    session_id: session::Id => "sessionID",
    assistant_message_id: session_message::Id => "assistantMessageID",
    ordinal: ycoding_schema::schema::NonNegativeInt => "ordinal",
    delta: LosslessString => "delta",
});
data!(ToolFragment {
    session_id: session::Id => "sessionID",
    assistant_message_id: session_message::Id => "assistantMessageID",
    call_id: LosslessString => "callID",
    delta: LosslessString => "delta",
});
data!(ToolProgress {
    session_id: session::Id => "sessionID",
    assistant_message_id: session_message::Id => "assistantMessageID",
    call_id: LosslessString => "callID",
    structured: ycoding_schema::JsonObject => "structured",
    content: Vec<ycoding_schema::llm::ToolContent> => "content",
});
data!(CompactionFragment {
    session_id: session::Id => "sessionID",
    text: LosslessString => "text",
});

macro_rules! events {
    ($($variant:ident($data:ty) => $name:literal),* $(,)?) => {
        #[derive(Clone, Debug, PartialEq)]
        pub enum Data { $($variant(Box<$data>)),* }
        impl Data {
            pub fn name(&self) -> &'static str { match self { $(Self::$variant(_) => $name),* } }
            pub fn decode(name: &str, value: &JsonValue) -> Result<Self, String> {
                match name {
                    $($name => <$data>::decode(value).map(|data| Self::$variant(Box::new(data))).map_err(|error| error.to_string())),*,
                    _ => Err(format!("Unknown public ephemeral event: {name}")),
                }
            }
        }
        impl DomainEncode for Data {
            fn encode(&self) -> JsonValue { match self { $(Self::$variant(data) => data.encode()),* } }
        }
    };
}

events! {
    ModelsDevRefreshed(models_dev::Empty) => "models-dev.refreshed",
    IntegrationUpdated(integration::Empty) => "integration.updated",
    IntegrationConnectionUpdated(integration::ConnectionUpdatedData) => "integration.connection.updated",
    CatalogUpdated(catalog::Empty) => "catalog.updated",
    AgentUpdated(agent::Empty) => "agent.updated",
    SessionUsageUpdated(Usage) => "session.usage.updated",
    SessionPredictionUpdated(Prediction) => "session.prediction.updated",
    SessionDiagnosticsUpdated(Diagnostics) => "session.diagnostics.updated",
    SessionTextDelta(Fragment) => "session.text.delta",
    SessionReasoningDelta(Fragment) => "session.reasoning.delta",
    SessionToolInputDelta(ToolFragment) => "session.tool.input.delta",
    SessionToolProgress(ToolProgress) => "session.tool.progress",
    SessionCompactionDelta(CompactionFragment) => "session.compaction.delta",
    FilesystemChanged(filesystem::ChangedData) => "filesystem.changed",
    ReferenceUpdated(models_dev::Empty) => "reference.updated",
    PermissionAsked(permission::Request) => "permission.asked",
    PermissionReplied(permission::RepliedData) => "permission.replied",
    PermissionDeferred(permission::DeferredData) => "permission.deferred",
    GuardrailAsked(guardrail::Request) => "guardrail.asked",
    GuardrailReplied(guardrail::RepliedData) => "guardrail.replied",
    GuardrailDecided(guardrail::DecidedData) => "guardrail.decided",
    GuardrailDeferred(guardrail::DeferredData) => "guardrail.deferred",
    PluginAdded(plugin::AddedData) => "plugin.added",
    PluginUpdated(models_dev::Empty) => "plugin.updated",
    ProjectDirectoriesUpdated(project_directories::UpdatedData) => "project.directories.updated",
    CommandUpdated(command::Empty) => "command.updated",
    ConfigUpdated(config::Empty) => "config.updated",
    SkillUpdated(models_dev::Empty) => "skill.updated",
    PtyCreated(pty::InfoData) => "pty.created",
    PtyUpdated(pty::InfoData) => "pty.updated",
    PtyExited(pty::ExitedData) => "pty.exited",
    PtyDeleted(pty::DeletedData) => "pty.deleted",
    ShellCreated(shell::CreatedData) => "shell.created",
    ShellExited(shell::ExitedData) => "shell.exited",
    ShellDeleted(shell::DeletedData) => "shell.deleted",
    QuestionAsked(question::Request) => "question.asked",
    QuestionReplied(question::RepliedData) => "question.replied",
    QuestionRejected(question::RejectedData) => "question.rejected",
    QuestionTimedOut(question::TimedOutData) => "question.timed_out",
    QuestionDeferred(question::DeferredData) => "question.deferred",
    FormCreated(form::CreatedData) => "form.created",
    FormReplied(form::RepliedData) => "form.replied",
    FormCancelled(form::CancelledData) => "form.cancelled",
    FormTimedOut(form::TimedOutData) => "form.timed_out",
    FormDeferred(form::DeferredData) => "form.deferred",
    TodoUpdated(session_todo::UpdatedData) => "todo.updated",
    SessionStatus(session_status_event::StatusData) => "session.status",
    SessionIdle(session_status_event::IdleData) => "session.idle",
    TuiPromptAppend(tui_event::PromptAppendData) => "tui.prompt.append",
    TuiCommandExecute(tui_event::CommandExecuteData) => "tui.command.execute",
    TuiToastShow(tui_event::ToastShowData) => "tui.toast.show",
    TuiSessionSelect(tui_event::SessionSelectData) => "tui.session.select",
    InstallationUpdated(installation_event::VersionData) => "installation.updated",
    InstallationUpdateAvailable(installation_event::VersionData) => "installation.update-available",
    VcsBranchUpdated(vcs_event::BranchUpdatedData) => "vcs.branch.updated",
    McpStatusChanged(mcp_event::ServerData) => "mcp.status.changed",
    McpResourcesChanged(mcp_event::ServerData) => "mcp.resources.changed",
}

impl Data {
    pub fn session(&self) -> Result<Option<session::Id>, String> {
        let id = match self {
            Self::SessionUsageUpdated(data) => Some(&data.session_id),
            Self::SessionPredictionUpdated(data) => Some(&data.session_id),
            Self::SessionDiagnosticsUpdated(data) => Some(&data.session_id),
            Self::SessionTextDelta(data) | Self::SessionReasoningDelta(data) => {
                Some(&data.session_id)
            }
            Self::SessionToolInputDelta(data) => Some(&data.session_id),
            Self::SessionToolProgress(data) => Some(&data.session_id),
            Self::SessionCompactionDelta(data) => Some(&data.session_id),
            Self::PermissionAsked(data) => Some(&data.session_id),
            Self::PermissionReplied(data) => Some(&data.session_id),
            Self::PermissionDeferred(data) => Some(&data.session_id),
            Self::GuardrailAsked(data) => Some(&data.session_id),
            Self::GuardrailReplied(data) => Some(&data.session_id),
            Self::GuardrailDecided(data) => Some(&data.session_id),
            Self::GuardrailDeferred(data) => Some(&data.session_id),
            Self::QuestionAsked(data) => Some(&data.session_id),
            Self::QuestionReplied(data) => Some(&data.session_id),
            Self::QuestionRejected(data) => Some(&data.session_id),
            Self::QuestionTimedOut(data) => Some(&data.session_id),
            Self::QuestionDeferred(data) => Some(&data.session_id),
            Self::TodoUpdated(data) => Some(&data.session_id),
            Self::SessionStatus(data) => Some(&data.session_id),
            Self::SessionIdle(data) => Some(&data.session_id),
            Self::TuiSessionSelect(data) => Some(&data.session_id),
            Self::PtyCreated(data) | Self::PtyUpdated(data) => Some(&data.info.session_id),
            Self::FormCreated(data) => return form_session(&data.form.session_id),
            Self::FormReplied(data) => return form_session(&data.session_id),
            Self::FormCancelled(data) => return form_session(&data.session_id),
            Self::FormTimedOut(data) => return form_session(&data.session_id),
            Self::FormDeferred(data) => return form_session(&data.session_id),
            _ => None,
        };
        Ok(id.cloned())
    }
}

fn form_session(id: &LosslessString) -> Result<Option<session::Id>, String> {
    if id.as_str() == Some("global") {
        return Ok(None);
    }
    session::Id::new(id.clone())
        .map(Some)
        .map_err(|error| error.to_string())
}
