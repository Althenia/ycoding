import type { YCodingClient } from "../../promise/index.js"
import type {
  AgentListInput,
  BrowserActionInput,
  BrowserCloseInput,
  BrowserControlInput,
  BrowserForgetInput,
  BrowserObserveInput,
  BrowserOpenInput,
  BrowserReleaseInput,
  BrowserStartInput,
  BrowserStatusInput,
  BrowserStopInput,
  BrowserTabsInput,
  CommandListInput,
  ConfigDiagnosticsInput,
  CredentialActivateInput,
  CredentialRemoveInput,
  CredentialUpdateInput,
  DebugLocationEvictInput,
  FileFindInput,
  FileListInput,
  FileReadInput,
  FormCancelInput,
  FormCreateInput,
  FormGetInput,
  FormListInput,
  FormReplyInput,
  FormRequestListInput,
  FormStateInput,
  GenerateTextInput,
  GuardrailRequestListInput,
  GuardrailRequestReplyInput,
  GuardrailStatusInput,
  HealthStopInput,
  IntegrationCommandCancelInput,
  IntegrationCommandConnectInput,
  IntegrationCommandStatusInput,
  IntegrationConnectKeyInput,
  IntegrationGetInput,
  IntegrationListInput,
  IntegrationOauthCancelInput,
  IntegrationOauthCompleteInput,
  IntegrationOauthConnectInput,
  IntegrationOauthStatusInput,
  IntegrationWellknownAddInput,
  IsolatedBrowserActionInput,
  IsolatedBrowserControlInput,
  IsolatedBrowserObserveInput,
  IsolatedBrowserStartInput,
  IsolatedBrowserStatusInput,
  IsolatedBrowserStopInput,
  IsolatedBrowserTabsInput,
  KeepAwakeSetInput,
  LocationGetInput,
  McpAddInput,
  McpConnectInput,
  McpDisconnectInput,
  McpListInput,
  McpRemoveInput,
  McpResourceCatalogInput,
  MessageCapturedInputsInput,
  MessageListInput,
  ModelDefaultInput,
  ModelListInput,
  PermissionCreateInput,
  PermissionGetInput,
  PermissionListInput,
  PermissionReplyInput,
  PermissionRequestListInput,
  PermissionSavedListInput,
  PermissionSavedRemoveInput,
  PluginListInput,
  ProjectArtifactArtifactCreateInput,
  ProjectArtifactArtifactDisableInput,
  ProjectArtifactArtifactEnableInput,
  ProjectArtifactArtifactForkConfirmInput,
  ProjectArtifactArtifactForkPreviewInput,
  ProjectArtifactArtifactGetInput,
  ProjectArtifactArtifactGlobalConfirmInput,
  ProjectArtifactArtifactListInput,
  ProjectArtifactArtifactMetricsInput,
  ProjectArtifactArtifactPromotionConfirmInput,
  ProjectArtifactArtifactPromotionPreviewInput,
  ProjectArtifactArtifactPurgeInput,
  ProjectArtifactArtifactRemoveInput,
  ProjectArtifactArtifactRestoreInput,
  ProjectArtifactArtifactRevertInput,
  ProjectArtifactArtifactShadowConfirmInput,
  ProjectArtifactArtifactShadowPreviewInput,
  ProjectArtifactArtifactUpdateInput,
  ProjectCopyCreateInput,
  ProjectCopyRefreshInput,
  ProjectCopyRemoveInput,
  ProjectCurrentInput,
  ProjectDirectoriesInput,
  ProjectForgetInput,
  ProjectInventoryInput,
  ProviderGetInput,
  ProviderIntegrationsInput,
  ProviderListInput,
  ProviderRefreshInput,
  ProviderUsageGetInput,
  ProviderUsageListInput,
  PtyConnectTokenInput,
  PtyControlInput,
  PtyCreateInput,
  PtyGetInput,
  PtyListInput,
  PtyRemoveInput,
  PtyUpdateInput,
  QuestionListInput,
  QuestionRejectInput,
  QuestionReplyInput,
  QuestionRequestListInput,
  ReferenceListInput,
  RemoteSetInput,
  ServerTelemetryAppendInput,
  ServerTelemetryConsentSetInput,
  ServerTelemetryListInput,
  SessionArchiveInput,
  SessionAttachmentReadInput,
  SessionAutonomyGetInput,
  SessionAutonomySetInput,
  SessionBackgroundInput,
  SessionCommandInput,
  SessionCompactInput,
  SessionCompactionListInput,
  SessionCompletionsInput,
  SessionContextInput,
  SessionCreateInput,
  SessionDaybreakSetInput,
  SessionDiagnosticsInput,
  SessionFileChangeListInput,
  SessionForkInput,
  SessionGenerateInput,
  SessionGetInput,
  SessionInstructionsEntryListInput,
  SessionInstructionsEntryPutInput,
  SessionInstructionsEntryRemoveInput,
  SessionInterruptInput,
  SessionListInput,
  SessionLogInput,
  SessionMessageInput,
  SessionMoveInput,
  SessionOutstandingInput,
  SessionPendingListInput,
  SessionPinInput,
  SessionPredictionInput,
  SessionPromptGenerateInput,
  SessionPromptInput,
  SessionRemoveInput,
  SessionRenameInput,
  SessionResolveSkillConflictInput,
  SessionRevertClearInput,
  SessionRevertCommitInput,
  SessionRevertStageInput,
  SessionShellInput,
  SessionSkillInput,
  SessionSkillsInput,
  SessionSnapshotInput,
  SessionSubagentAnswerInput,
  SessionSubagentCancelInput,
  SessionSubagentLaunchInput,
  SessionSubagentListInput,
  SessionSubagentMessageInput,
  SessionSubagentResumeInput,
  SessionSwitchAgentInput,
  SessionSwitchModelInput,
  SessionSyntheticInput,
  SessionTodoListInput,
  SessionTodoUpdateInput,
  SessionUnarchiveInput,
  SessionUnpinInput,
  SessionUsageInput,
  SessionUsageReportInput,
  SessionWaitInput,
  ShellCreateInput,
  ShellGetInput,
  ShellListInput,
  ShellOutputInput,
  ShellRemoveInput,
  ShellTimeoutInput,
  SkillListInput,
  UsageReportInput,
  VcsBranchInput,
  VcsDiffInput,
  VcsStatusInput,
} from "../../promise/generated/types.js"
import type { RequestOptions } from "../../promise/generated/client.js"
import type { LocalTransport } from "../socket.js"
type Client = YCodingClient
type StreamValue<T> = T extends AsyncIterable<infer A> ? A : never
export const methodCoverage = [
  {
    method: "health.get",
    operation: "health.get",
    operationID: 3016,
  },
  {
    method: "health.stop",
    operation: "health.stop",
    operationID: 3017,
  },
  {
    method: "server.get",
    operation: "server.get",
    operationID: 3039,
  },
  {
    method: "server.telemetry.append",
    operation: "telemetry.append",
    operationID: 3046,
  },
  {
    method: "server.telemetry.list",
    operation: "telemetry.list",
    operationID: 3049,
  },
  {
    method: "server.telemetry.consent.get",
    operation: "telemetry.consent.get",
    operationID: 3047,
  },
  {
    method: "server.telemetry.consent.set",
    operation: "telemetry.consent.set",
    operationID: 3048,
  },
  {
    method: "location.get",
    operation: "location.get",
    operationID: 2035,
  },
  {
    method: "agent.list",
    operation: "agent.list",
    operationID: 2000,
  },
  {
    method: "plugin.list",
    operation: "plugin.list",
    operationID: 2044,
  },
  {
    method: "session.list",
    operation: "session.list",
    operationID: 4038,
  },
  {
    method: "session.create",
    operation: "session.create",
    operationID: 4018,
  },
  {
    method: "session.active",
    operation: "session.active",
    operationID: 4008,
  },
  {
    method: "session.outstanding",
    operation: "session.outstanding",
    operationID: 4043,
  },
  {
    method: "session.completions",
    operation: "session.completions",
    operationID: 4016,
  },
  {
    method: "session.get",
    operation: "session.get",
    operationID: 4030,
  },
  {
    method: "session.snapshot",
    operation: "session.snapshot",
    operationID: 4063,
  },
  {
    method: "session.attachment.read",
    operation: "session.attachment.read",
    operationID: 4010,
  },
  {
    method: "session.diagnostics",
    operation: "session.diagnostics",
    operationID: 4020,
  },
  {
    method: "session.autonomy.get",
    operation: "session.autonomy.get",
    operationID: 4011,
  },
  {
    method: "session.autonomy.set",
    operation: "session.autonomy.set",
    operationID: 4012,
  },
  {
    method: "session.remove",
    operation: "session.remove",
    operationID: 4054,
  },
  {
    method: "session.archive",
    operation: "session.archive",
    operationID: 4009,
  },
  {
    method: "session.unarchive",
    operation: "session.unarchive",
    operationID: 4075,
  },
  {
    method: "session.pin",
    operation: "session.pin",
    operationID: 4049,
  },
  {
    method: "session.unpin",
    operation: "session.unpin",
    operationID: 4076,
  },
  {
    method: "session.subagent.list",
    operation: "session.subagent.list",
    operationID: 4067,
  },
  {
    method: "session.subagent.launch",
    operation: "session.subagent.launch",
    operationID: 4066,
  },
  {
    method: "session.subagent.message",
    operation: "session.subagent.message",
    operationID: 4068,
  },
  {
    method: "session.subagent.answer",
    operation: "session.subagent.answer",
    operationID: 4064,
  },
  {
    method: "session.subagent.cancel",
    operation: "session.subagent.cancel",
    operationID: 4065,
  },
  {
    method: "session.subagent.resume",
    operation: "session.subagent.resume",
    operationID: 4069,
  },
  {
    method: "session.todo.list",
    operation: "session.todo.list",
    operationID: 4073,
  },
  {
    method: "session.todo.update",
    operation: "session.todo.update",
    operationID: 4074,
  },
  {
    method: "session.fork",
    operation: "session.fork",
    operationID: 4022,
  },
  {
    method: "session.switchAgent",
    operation: "session.switchAgent",
    operationID: 4070,
  },
  {
    method: "session.switchModel",
    operation: "session.switchModel",
    operationID: 4071,
  },
  {
    method: "session.rename",
    operation: "session.rename",
    operationID: 4055,
  },
  {
    method: "session.daybreak.set",
    operation: "session.daybreak.set",
    operationID: 4019,
  },
  {
    method: "session.move",
    operation: "session.move",
    operationID: 4042,
  },
  {
    method: "session.prompt",
    operation: "session.prompt",
    operationID: 4050,
  },
  {
    method: "session.command",
    operation: "session.command",
    operationID: 4014,
  },
  {
    method: "session.skill",
    operation: "session.skill",
    operationID: 4061,
  },
  {
    method: "session.usage",
    operation: "session.usage",
    operationID: 4077,
  },
  {
    method: "session.usageReport",
    operation: "session.usageReport",
    operationID: 4078,
  },
  {
    method: "session.skills",
    operation: "session.skills",
    operationID: 4062,
  },
  {
    method: "session.resolveSkillConflict",
    operation: "session.resolveSkillConflict",
    operationID: 4056,
  },
  {
    method: "session.synthetic",
    operation: "session.synthetic",
    operationID: 4072,
  },
  {
    method: "session.shell",
    operation: "session.shell",
    operationID: 4060,
  },
  {
    method: "session.compact",
    operation: "session.compact",
    operationID: 4015,
  },
  {
    method: "session.compaction.list",
    operation: "session.compaction.list",
    operationID: 4081,
  },
  {
    method: "session.wait",
    operation: "session.wait",
    operationID: 4079,
  },
  {
    method: "session.revert.stage",
    operation: "session.revert.stage",
    operationID: 4059,
  },
  {
    method: "session.revert.clear",
    operation: "session.revert.clear",
    operationID: 4057,
  },
  {
    method: "session.revert.commit",
    operation: "session.revert.commit",
    operationID: 4058,
  },
  {
    method: "session.context",
    operation: "session.context",
    operationID: 4017,
  },
  {
    method: "session.file-change.list",
    operation: "session.fileChange.list",
    operationID: 4021,
  },
  {
    method: "session.pending.list",
    operation: "session.pending.list",
    operationID: 4044,
  },
  {
    method: "session.instructions.entry.list",
    operation: "session.instructions.entry.list",
    operationID: 4034,
  },
  {
    method: "session.instructions.entry.put",
    operation: "session.instructions.entry.put",
    operationID: 4035,
  },
  {
    method: "session.instructions.entry.remove",
    operation: "session.instructions.entry.remove",
    operationID: 4036,
  },
  {
    method: "session.generate",
    operation: "session.generate",
    operationID: 4029,
  },
  {
    method: "session.prediction",
    operation: "session.prediction",
    operationID: 4082,
  },
  {
    method: "session.promptGenerate",
    operation: "session.promptGenerate",
    operationID: 4083,
  },
  {
    method: "session.log",
    operation: "session.log",
    operationID: 4039,
  },
  {
    method: "session.interrupt",
    operation: "session.interrupt",
    operationID: 4037,
  },
  {
    method: "session.background",
    operation: "session.background",
    operationID: 4013,
  },
  {
    method: "session.message",
    operation: "session.message",
    operationID: 4040,
  },
  {
    method: "guardrail.status",
    operation: "session.guardrail.status",
    operationID: 4033,
  },
  {
    method: "guardrail.request.list",
    operation: "session.guardrail.request.list",
    operationID: 4031,
  },
  {
    method: "guardrail.request.reply",
    operation: "session.guardrail.request.reply",
    operationID: 4032,
  },
  {
    method: "message.list",
    operation: "session.messages",
    operationID: 4041,
  },
  {
    method: "message.capturedInputs",
    operation: "session.capturedInputs",
    operationID: 4080,
  },
  {
    method: "model.list",
    operation: "model.list",
    operationID: 2043,
  },
  {
    method: "model.default",
    operation: "model.default",
    operationID: 2042,
  },
  {
    method: "generate.text",
    operation: "generate.text",
    operationID: 4003,
  },
  {
    method: "provider.integrations",
    operation: "provider.integrations",
    operationID: 2051,
  },
  {
    method: "provider.list",
    operation: "provider.list",
    operationID: 2052,
  },
  {
    method: "provider.refresh",
    operation: "provider.refresh",
    operationID: 2053,
  },
  {
    method: "provider.get",
    operation: "provider.get",
    operationID: 2050,
  },
  {
    method: "providerUsage.list",
    operation: "providerUsage.list",
    operationID: 2055,
  },
  {
    method: "providerUsage.get",
    operation: "providerUsage.get",
    operationID: 2054,
  },
  {
    method: "integration.list",
    operation: "integration.list",
    operationID: 2029,
  },
  {
    method: "integration.get",
    operation: "integration.get",
    operationID: 2028,
  },
  {
    method: "integration.wellknown.add",
    operation: "integration.wellknown.add",
    operationID: 2034,
  },
  {
    method: "integration.connect.key",
    operation: "integration.connect.key",
    operationID: 2027,
  },
  {
    method: "integration.oauth.connect",
    operation: "integration.oauth.connect",
    operationID: 2032,
  },
  {
    method: "integration.oauth.status",
    operation: "integration.oauth.status",
    operationID: 2033,
  },
  {
    method: "integration.oauth.complete",
    operation: "integration.oauth.complete",
    operationID: 2031,
  },
  {
    method: "integration.oauth.cancel",
    operation: "integration.oauth.cancel",
    operationID: 2030,
  },
  {
    method: "integration.command.connect",
    operation: "integration.command.connect",
    operationID: 2025,
  },
  {
    method: "integration.command.status",
    operation: "integration.command.status",
    operationID: 2026,
  },
  {
    method: "integration.command.cancel",
    operation: "integration.command.cancel",
    operationID: 2024,
  },
  {
    method: "mcp.list",
    operation: "mcp.list",
    operationID: 2039,
  },
  {
    method: "mcp.add",
    operation: "mcp.add",
    operationID: 2036,
  },
  {
    method: "mcp.remove",
    operation: "mcp.remove",
    operationID: 2040,
  },
  {
    method: "mcp.connect",
    operation: "mcp.connect",
    operationID: 2037,
  },
  {
    method: "mcp.disconnect",
    operation: "mcp.disconnect",
    operationID: 2038,
  },
  {
    method: "mcp.resource.catalog",
    operation: "mcp.resource.catalog",
    operationID: 2041,
  },
  {
    method: "credential.update",
    operation: "credential.update",
    operationID: 2023,
  },
  {
    method: "credential.activate",
    operation: "credential.activate",
    operationID: 2021,
  },
  {
    method: "credential.remove",
    operation: "credential.remove",
    operationID: 2022,
  },
  {
    method: "project.list",
    operation: "project.list",
    operationID: 2049,
  },
  {
    method: "project.inventory",
    operation: "project.inventory",
    operationID: 2048,
  },
  {
    method: "project.current",
    operation: "project.current",
    operationID: 2045,
  },
  {
    method: "project.directories",
    operation: "project.directories",
    operationID: 2046,
  },
  {
    method: "project.forget",
    operation: "project.forget",
    operationID: 2047,
  },
  {
    method: "form.request.list",
    operation: "form.request.list",
    operationID: 4002,
  },
  {
    method: "form.list",
    operation: "session.form.list",
    operationID: 4026,
  },
  {
    method: "form.create",
    operation: "session.form.create",
    operationID: 4024,
  },
  {
    method: "form.get",
    operation: "session.form.get",
    operationID: 4025,
  },
  {
    method: "form.state",
    operation: "session.form.state",
    operationID: 4028,
  },
  {
    method: "form.reply",
    operation: "session.form.reply",
    operationID: 4027,
  },
  {
    method: "form.cancel",
    operation: "session.form.cancel",
    operationID: 4023,
  },
  {
    method: "permission.request.list",
    operation: "permission.request.list",
    operationID: 4004,
  },
  {
    method: "permission.saved.list",
    operation: "permission.saved.list",
    operationID: 4005,
  },
  {
    method: "permission.saved.remove",
    operation: "permission.saved.remove",
    operationID: 4006,
  },
  {
    method: "permission.create",
    operation: "session.permission.create",
    operationID: 4045,
  },
  {
    method: "permission.list",
    operation: "session.permission.list",
    operationID: 4047,
  },
  {
    method: "permission.get",
    operation: "session.permission.get",
    operationID: 4046,
  },
  {
    method: "permission.reply",
    operation: "session.permission.reply",
    operationID: 4048,
  },
  {
    method: "file.read",
    operation: "fs.read",
    operationID: 3015,
  },
  {
    method: "file.list",
    operation: "fs.list",
    operationID: 3014,
  },
  {
    method: "file.find",
    operation: "fs.find",
    operationID: 3013,
  },
  {
    method: "command.list",
    operation: "command.list",
    operationID: 2019,
  },
  {
    method: "skill.list",
    operation: "skill.list",
    operationID: 2057,
  },
  {
    method: "event.subscribe",
    operation: "event.subscribe",
    operationID: 4000,
  },
  {
    method: "pty.list",
    operation: "pty.list",
    operationID: 3034,
  },
  {
    method: "pty.create",
    operation: "pty.create",
    operationID: 3032,
  },
  {
    method: "pty.get",
    operation: "pty.get",
    operationID: 3033,
  },
  {
    method: "pty.update",
    operation: "pty.update",
    operationID: 3036,
  },
  {
    method: "pty.remove",
    operation: "pty.remove",
    operationID: 3035,
  },
  {
    method: "pty.control",
    operation: "pty.control",
    operationID: 3031,
  },
  {
    method: "pty.connect.token",
    operation: "pty.connectToken",
    operationID: 3030,
  },
  {
    method: "shell.list",
    operation: "shell.list",
    operationID: 3042,
  },
  {
    method: "shell.create",
    operation: "shell.create",
    operationID: 3040,
  },
  {
    method: "shell.get",
    operation: "shell.get",
    operationID: 3041,
  },
  {
    method: "shell.timeout",
    operation: "shell.timeout",
    operationID: 3045,
  },
  {
    method: "shell.output",
    operation: "shell.output",
    operationID: 3043,
  },
  {
    method: "shell.remove",
    operation: "shell.remove",
    operationID: 3044,
  },
  {
    method: "question.request.list",
    operation: "question.request.list",
    operationID: 4007,
  },
  {
    method: "question.list",
    operation: "session.question.list",
    operationID: 4051,
  },
  {
    method: "question.reply",
    operation: "session.question.reply",
    operationID: 4053,
  },
  {
    method: "question.reject",
    operation: "session.question.reject",
    operationID: 4052,
  },
  {
    method: "reference.list",
    operation: "reference.list",
    operationID: 2056,
  },
  {
    method: "projectCopy.create",
    operation: "projectCopy.create",
    operationID: 3027,
  },
  {
    method: "projectCopy.remove",
    operation: "projectCopy.remove",
    operationID: 3029,
  },
  {
    method: "projectCopy.refresh",
    operation: "projectCopy.refresh",
    operationID: 3028,
  },
  {
    method: "vcs.status",
    operation: "vcs.status",
    operationID: 3052,
  },
  {
    method: "vcs.branch",
    operation: "vcs.branch",
    operationID: 3050,
  },
  {
    method: "vcs.diff",
    operation: "vcs.diff",
    operationID: 3051,
  },
  {
    method: "projectArtifact.artifact.list",
    operation: "artifact.list",
    operationID: 2008,
  },
  {
    method: "projectArtifact.artifact.get",
    operation: "artifact.get",
    operationID: 2007,
  },
  {
    method: "projectArtifact.artifact.create",
    operation: "artifact.create",
    operationID: 2002,
  },
  {
    method: "projectArtifact.artifact.update",
    operation: "artifact.update",
    operationID: 2018,
  },
  {
    method: "projectArtifact.artifact.global.confirm",
    operation: "artifact.confirmGlobal",
    operationID: 2001,
  },
  {
    method: "projectArtifact.artifact.disable",
    operation: "artifact.disable",
    operationID: 2003,
  },
  {
    method: "projectArtifact.artifact.enable",
    operation: "artifact.enable",
    operationID: 2004,
  },
  {
    method: "projectArtifact.artifact.remove",
    operation: "artifact.remove",
    operationID: 2013,
  },
  {
    method: "projectArtifact.artifact.restore",
    operation: "artifact.restore",
    operationID: 2014,
  },
  {
    method: "projectArtifact.artifact.revert",
    operation: "artifact.revert",
    operationID: 2015,
  },
  {
    method: "projectArtifact.artifact.metrics",
    operation: "artifact.metrics",
    operationID: 2009,
  },
  {
    method: "projectArtifact.artifact.promotion.preview",
    operation: "artifact.promotion.preview",
    operationID: 2011,
  },
  {
    method: "projectArtifact.artifact.promotion.confirm",
    operation: "artifact.promotion.confirm",
    operationID: 2010,
  },
  {
    method: "projectArtifact.artifact.fork.preview",
    operation: "artifact.fork.preview",
    operationID: 2006,
  },
  {
    method: "projectArtifact.artifact.fork.confirm",
    operation: "artifact.fork.confirm",
    operationID: 2005,
  },
  {
    method: "projectArtifact.artifact.shadow.preview",
    operation: "artifact.shadow.preview",
    operationID: 2017,
  },
  {
    method: "projectArtifact.artifact.shadow.confirm",
    operation: "artifact.shadow.confirm",
    operationID: 2016,
  },
  {
    method: "projectArtifact.artifact.purge",
    operation: "artifact.purge",
    operationID: 2012,
  },
  {
    method: "debug.location.list",
    operation: "debug.location",
    operationID: 3011,
  },
  {
    method: "debug.location.evict",
    operation: "debug.location.evict",
    operationID: 3012,
  },
  {
    method: "browser.status",
    operation: "browser.status",
    operationID: 3008,
  },
  {
    method: "browser.tabs",
    operation: "browser.tabs",
    operationID: 3010,
  },
  {
    method: "browser.start",
    operation: "browser.start",
    operationID: 3007,
  },
  {
    method: "browser.observe",
    operation: "browser.observe",
    operationID: 3004,
  },
  {
    method: "browser.open",
    operation: "browser.open",
    operationID: 3005,
  },
  {
    method: "browser.close",
    operation: "browser.close",
    operationID: 3001,
  },
  {
    method: "browser.release",
    operation: "browser.release",
    operationID: 3006,
  },
  {
    method: "browser.action",
    operation: "browser.action",
    operationID: 3000,
  },
  {
    method: "browser.control",
    operation: "browser.control",
    operationID: 3002,
  },
  {
    method: "browser.stop",
    operation: "browser.stop",
    operationID: 3009,
  },
  {
    method: "browser.forget",
    operation: "browser.forget",
    operationID: 3003,
  },
  {
    method: "isolatedBrowser.status",
    operation: "isolatedBrowser.status",
    operationID: 3022,
  },
  {
    method: "isolatedBrowser.start",
    operation: "isolatedBrowser.start",
    operationID: 3021,
  },
  {
    method: "isolatedBrowser.tabs",
    operation: "isolatedBrowser.tabs",
    operationID: 3024,
  },
  {
    method: "isolatedBrowser.observe",
    operation: "isolatedBrowser.observe",
    operationID: 3020,
  },
  {
    method: "isolatedBrowser.action",
    operation: "isolatedBrowser.action",
    operationID: 3018,
  },
  {
    method: "isolatedBrowser.control",
    operation: "isolatedBrowser.control",
    operationID: 3019,
  },
  {
    method: "isolatedBrowser.stop",
    operation: "isolatedBrowser.stop",
    operationID: 3023,
  },
  {
    method: "usage.get",
    operation: "usage.get",
    operationID: 2058,
  },
  {
    method: "usage.report",
    operation: "usage.report",
    operationID: 2059,
  },
  {
    method: "remote.get",
    operation: "remote.get",
    operationID: 3037,
  },
  {
    method: "remote.set",
    operation: "remote.set",
    operationID: 3038,
  },
  {
    method: "keepAwake.get",
    operation: "keepAwake.get",
    operationID: 3025,
  },
  {
    method: "keepAwake.set",
    operation: "keepAwake.set",
    operationID: 3026,
  },
  {
    method: "config.diagnostics",
    operation: "config.diagnostics",
    operationID: 2020,
  },
] as const
export function bind(transport: LocalTransport): Client {
  return {
    health: {
      get: (requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["health"]["get"]>>>(
          { method: "health.get", operationID: 3016, resultPath: ["data"], empty: false },
          {},
          undefined,
          requestOptions,
        ),
      stop: (input: HealthStopInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["health"]["stop"]>>>(
          { method: "health.stop", operationID: 3017, resultPath: ["data"], empty: false },
          { payload: { instanceID: input["instanceID"] } },
          input,
          requestOptions,
        ),
    },
    server: {
      get: (requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["server"]["get"]>>>(
          { method: "server.get", operationID: 3039, resultPath: [], empty: false },
          {},
          undefined,
          requestOptions,
        ),
      telemetry: {
        append: (input: ServerTelemetryAppendInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["server"]["telemetry"]["append"]>>>(
            { method: "server.telemetry.append", operationID: 3046, resultPath: [], empty: false },
            { payload: { samples: input["samples"] } },
            input,
            requestOptions,
          ),
        list: (input?: ServerTelemetryListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["server"]["telemetry"]["list"]>>>(
            { method: "server.telemetry.list", operationID: 3049, resultPath: ["data"], empty: false },
            { query: { limit: input?.["limit"], before: input?.["before"] } },
            input,
            requestOptions,
          ),
        consent: {
          get: (requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["server"]["telemetry"]["consent"]["get"]>>>(
              { method: "server.telemetry.consent.get", operationID: 3047, resultPath: ["data"], empty: false },
              {},
              undefined,
              requestOptions,
            ),
          set: (input: ServerTelemetryConsentSetInput, requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["server"]["telemetry"]["consent"]["set"]>>>(
              { method: "server.telemetry.consent.set", operationID: 3048, resultPath: ["data"], empty: false },
              { payload: { enabled: input["enabled"], noticeVersion: input["noticeVersion"] } },
              input,
              requestOptions,
            ),
        },
      },
    },
    location: {
      get: (input?: LocationGetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["location"]["get"]>>>(
          { method: "location.get", operationID: 2035, resultPath: ["data"], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
    },
    agent: {
      list: (input?: AgentListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["agent"]["list"]>>>(
          { method: "agent.list", operationID: 2000, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
    },
    plugin: {
      list: (input?: PluginListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["plugin"]["list"]>>>(
          { method: "plugin.list", operationID: 2044, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
    },
    session: {
      list: (input?: SessionListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["list"]>>>(
          { method: "session.list", operationID: 4038, resultPath: ["data"], empty: false },
          {
            query: {
              workspace: input?.["workspace"],
              limit: input?.["limit"],
              order: input?.["order"],
              search: input?.["search"],
              parentID: input?.["parentID"],
              directory: input?.["directory"],
              project: input?.["project"],
              subpath: input?.["subpath"],
              cursor: input?.["cursor"],
            },
          },
          input,
          requestOptions,
        ),
      create: (input?: SessionCreateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["create"]>>>(
          { method: "session.create", operationID: 4018, resultPath: ["data"], empty: false },
          {
            payload: {
              id: input?.["id"],
              parentID: input?.["parentID"],
              agent: input?.["agent"],
              model: input?.["model"],
              location: input?.["location"],
            },
          },
          input,
          requestOptions,
        ),
      active: (requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["active"]>>>(
          { method: "session.active", operationID: 4008, resultPath: ["data"], empty: false },
          {},
          undefined,
          requestOptions,
        ),
      outstanding: (input?: SessionOutstandingInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["outstanding"]>>>(
          { method: "session.outstanding", operationID: 4043, resultPath: [], empty: false },
          { query: { failures: input?.["failures"] } },
          input,
          requestOptions,
        ),
      completions: (input?: SessionCompletionsInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["completions"]>>>(
          { method: "session.completions", operationID: 4016, resultPath: ["data"], empty: false },
          { query: { after: input?.["after"], limit: input?.["limit"] } },
          input,
          requestOptions,
        ),
      get: (input: SessionGetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["get"]>>>(
          { method: "session.get", operationID: 4030, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      snapshot: (input: SessionSnapshotInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["snapshot"]>>>(
          { method: "session.snapshot", operationID: 4063, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] }, query: { limit: input["limit"], before: input["before"] } },
          input,
          requestOptions,
        ),
      attachment: {
        read: (input: SessionAttachmentReadInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["attachment"]["read"]>>>(
            { method: "session.attachment.read", operationID: 4010, resultPath: [], empty: false },
            { params: { sessionID: input["sessionID"], digest: input["digest"] } },
            input,
            requestOptions,
          ),
      },
      diagnostics: (input: SessionDiagnosticsInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["diagnostics"]>>>(
          { method: "session.diagnostics", operationID: 4020, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      autonomy: {
        get: (input: SessionAutonomyGetInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["autonomy"]["get"]>>>(
            { method: "session.autonomy.get", operationID: 4011, resultPath: ["data"], empty: false },
            { params: { sessionID: input["sessionID"] } },
            input,
            requestOptions,
          ),
        set: (input: SessionAutonomySetInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["autonomy"]["set"]>>>(
            { method: "session.autonomy.set", operationID: 4012, resultPath: ["data"], empty: false },
            { params: { sessionID: input["sessionID"] }, payload: input["payload"] },
            input,
            requestOptions,
          ),
      },
      remove: (input: SessionRemoveInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["remove"]>>>(
          { method: "session.remove", operationID: 4054, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      archive: (input: SessionArchiveInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["archive"]>>>(
          { method: "session.archive", operationID: 4009, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      unarchive: (input: SessionUnarchiveInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["unarchive"]>>>(
          { method: "session.unarchive", operationID: 4075, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      pin: (input: SessionPinInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["pin"]>>>(
          { method: "session.pin", operationID: 4049, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      unpin: (input: SessionUnpinInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["unpin"]>>>(
          { method: "session.unpin", operationID: 4076, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      subagent: {
        list: (input: SessionSubagentListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["subagent"]["list"]>>>(
            { method: "session.subagent.list", operationID: 4067, resultPath: ["data"], empty: false },
            { params: { parentID: input["parentID"] }, query: { limit: input["limit"], cursor: input["cursor"] } },
            input,
            requestOptions,
          ),
        launch: (input: SessionSubagentLaunchInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["subagent"]["launch"]>>>(
            { method: "session.subagent.launch", operationID: 4066, resultPath: ["data"], empty: false },
            {
              params: { parentID: input["parentID"] },
              payload: {
                parentAssistantMessageID: input["parentAssistantMessageID"],
                toolCallID: input["toolCallID"],
                agent: input["agent"],
                description: input["description"],
                prompt: input["prompt"],
                background: input["background"],
                model: input["model"],
              },
            },
            input,
            requestOptions,
          ),
        message: (input: SessionSubagentMessageInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["subagent"]["message"]>>>(
            { method: "session.subagent.message", operationID: 4068, resultPath: ["data"], empty: false },
            {
              params: { parentID: input["parentID"], childID: input["childID"] },
              payload: { messageID: input["messageID"], text: input["text"], delivery: input["delivery"] },
            },
            input,
            requestOptions,
          ),
        answer: (input: SessionSubagentAnswerInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["subagent"]["answer"]>>>(
            { method: "session.subagent.answer", operationID: 4064, resultPath: ["data"], empty: false },
            {
              params: { parentID: input["parentID"], childID: input["childID"], questionID: input["questionID"] },
              payload: { text: input["text"], data: input["data"] },
            },
            input,
            requestOptions,
          ),
        cancel: (input: SessionSubagentCancelInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["subagent"]["cancel"]>>>(
            { method: "session.subagent.cancel", operationID: 4065, resultPath: ["data"], empty: false },
            { params: { parentID: input["parentID"], childID: input["childID"] } },
            input,
            requestOptions,
          ),
        resume: (input: SessionSubagentResumeInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["subagent"]["resume"]>>>(
            { method: "session.subagent.resume", operationID: 4069, resultPath: ["data"], empty: false },
            { params: { parentID: input["parentID"], childID: input["childID"] } },
            input,
            requestOptions,
          ),
      },
      todo: {
        list: (input: SessionTodoListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["todo"]["list"]>>>(
            { method: "session.todo.list", operationID: 4073, resultPath: ["data"], empty: false },
            { params: { sessionID: input["sessionID"] } },
            input,
            requestOptions,
          ),
        update: (input: SessionTodoUpdateInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["todo"]["update"]>>>(
            { method: "session.todo.update", operationID: 4074, resultPath: ["data"], empty: false },
            { params: { sessionID: input["sessionID"] }, payload: { todos: input["todos"] } },
            input,
            requestOptions,
          ),
      },
      fork: (input: SessionForkInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["fork"]>>>(
          { method: "session.fork", operationID: 4022, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] }, payload: { messageID: input["messageID"] } },
          input,
          requestOptions,
        ),
      switchAgent: (input: SessionSwitchAgentInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["switchAgent"]>>>(
          { method: "session.switchAgent", operationID: 4070, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] }, payload: { agent: input["agent"] } },
          input,
          requestOptions,
        ),
      switchModel: (input: SessionSwitchModelInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["switchModel"]>>>(
          { method: "session.switchModel", operationID: 4071, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] }, payload: { model: input["model"] } },
          input,
          requestOptions,
        ),
      rename: (input: SessionRenameInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["rename"]>>>(
          { method: "session.rename", operationID: 4055, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] }, payload: { title: input["title"] } },
          input,
          requestOptions,
        ),
      daybreak: {
        set: (input: SessionDaybreakSetInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["daybreak"]["set"]>>>(
            { method: "session.daybreak.set", operationID: 4019, resultPath: ["data"], empty: false },
            { params: { sessionID: input["sessionID"] }, payload: { daybreak: input["daybreak"] } },
            input,
            requestOptions,
          ),
      },
      move: (input: SessionMoveInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["move"]>>>(
          { method: "session.move", operationID: 4042, resultPath: [], empty: true },
          {
            params: { sessionID: input["sessionID"] },
            payload: { directory: input["directory"], workspaceID: input["workspaceID"] },
          },
          input,
          requestOptions,
        ),
      prompt: (input: SessionPromptInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["prompt"]>>>(
          { method: "session.prompt", operationID: 4050, resultPath: ["data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            payload: {
              id: input["id"],
              text: input["text"],
              files: input["files"],
              agents: input["agents"],
              metadata: input["metadata"],
              delivery: input["delivery"],
              resume: input["resume"],
            },
          },
          input,
          requestOptions,
        ),
      command: (input: SessionCommandInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["command"]>>>(
          { method: "session.command", operationID: 4014, resultPath: ["data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            payload: {
              id: input["id"],
              command: input["command"],
              arguments: input["arguments"],
              agent: input["agent"],
              model: input["model"],
              files: input["files"],
              agents: input["agents"],
              delivery: input["delivery"],
              resume: input["resume"],
            },
          },
          input,
          requestOptions,
        ),
      skill: (input: SessionSkillInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["skill"]>>>(
          { method: "session.skill", operationID: 4061, resultPath: [], empty: true },
          {
            params: { sessionID: input["sessionID"] },
            payload: { id: input["id"], skill: input["skill"], resume: input["resume"] },
          },
          input,
          requestOptions,
        ),
      usage: (input: SessionUsageInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["usage"]>>>(
          { method: "session.usage", operationID: 4077, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      usageReport: (input: SessionUsageReportInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["usageReport"]>>>(
          { method: "session.usageReport", operationID: 4078, resultPath: ["data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            query: {
              group: input["group"],
              timeZone: input["timeZone"],
              from: input["from"],
              to: input["to"],
              offset: input["offset"],
              limit: input["limit"],
              sort: input["sort"],
              order: input["order"],
            },
          },
          input,
          requestOptions,
        ),
      skills: (input: SessionSkillsInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["skills"]>>>(
          { method: "session.skills", operationID: 4062, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      resolveSkillConflict: (input: SessionResolveSkillConflictInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["resolveSkillConflict"]>>>(
          { method: "session.resolveSkillConflict", operationID: 4056, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] }, payload: { winner: input["winner"], loser: input["loser"] } },
          input,
          requestOptions,
        ),
      synthetic: (input: SessionSyntheticInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["synthetic"]>>>(
          { method: "session.synthetic", operationID: 4072, resultPath: ["data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            payload: {
              id: input["id"],
              text: input["text"],
              description: input["description"],
              metadata: input["metadata"],
              delivery: input["delivery"],
              resume: input["resume"],
            },
          },
          input,
          requestOptions,
        ),
      shell: (input: SessionShellInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["shell"]>>>(
          { method: "session.shell", operationID: 4060, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] }, payload: { id: input["id"], command: input["command"] } },
          input,
          requestOptions,
        ),
      compact: (input: SessionCompactInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["compact"]>>>(
          { method: "session.compact", operationID: 4015, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] }, payload: { id: input["id"] } },
          input,
          requestOptions,
        ),
      compaction: {
        list: (input: SessionCompactionListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["compaction"]["list"]>>>(
            { method: "session.compaction.list", operationID: 4081, resultPath: ["data"], empty: false },
            { params: { sessionID: input["sessionID"] } },
            input,
            requestOptions,
          ),
      },
      wait: (input: SessionWaitInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["wait"]>>>(
          { method: "session.wait", operationID: 4079, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      revert: {
        stage: (input: SessionRevertStageInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["revert"]["stage"]>>>(
            { method: "session.revert.stage", operationID: 4059, resultPath: ["data"], empty: false },
            {
              params: { sessionID: input["sessionID"] },
              payload: { messageID: input["messageID"], files: input["files"] },
            },
            input,
            requestOptions,
          ),
        clear: (input: SessionRevertClearInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["revert"]["clear"]>>>(
            { method: "session.revert.clear", operationID: 4057, resultPath: [], empty: true },
            { params: { sessionID: input["sessionID"] } },
            input,
            requestOptions,
          ),
        commit: (input: SessionRevertCommitInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["revert"]["commit"]>>>(
            { method: "session.revert.commit", operationID: 4058, resultPath: [], empty: true },
            { params: { sessionID: input["sessionID"] } },
            input,
            requestOptions,
          ),
      },
      context: (input: SessionContextInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["context"]>>>(
          { method: "session.context", operationID: 4017, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      "file-change": {
        list: (input: SessionFileChangeListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["file-change"]["list"]>>>(
            { method: "session.file-change.list", operationID: 4021, resultPath: ["data"], empty: false },
            { params: { sessionID: input["sessionID"] } },
            input,
            requestOptions,
          ),
      },
      pending: {
        list: (input: SessionPendingListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["session"]["pending"]["list"]>>>(
            { method: "session.pending.list", operationID: 4044, resultPath: ["data"], empty: false },
            { params: { sessionID: input["sessionID"] } },
            input,
            requestOptions,
          ),
      },
      instructions: {
        entry: {
          list: (input: SessionInstructionsEntryListInput, requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["session"]["instructions"]["entry"]["list"]>>>(
              { method: "session.instructions.entry.list", operationID: 4034, resultPath: ["data"], empty: false },
              { params: { sessionID: input["sessionID"] } },
              input,
              requestOptions,
            ),
          put: (input: SessionInstructionsEntryPutInput, requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["session"]["instructions"]["entry"]["put"]>>>(
              { method: "session.instructions.entry.put", operationID: 4035, resultPath: [], empty: true },
              { params: { sessionID: input["sessionID"], key: input["key"] }, payload: { value: input["value"] } },
              input,
              requestOptions,
            ),
          remove: (input: SessionInstructionsEntryRemoveInput, requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["session"]["instructions"]["entry"]["remove"]>>>(
              { method: "session.instructions.entry.remove", operationID: 4036, resultPath: [], empty: true },
              { params: { sessionID: input["sessionID"], key: input["key"] } },
              input,
              requestOptions,
            ),
        },
      },
      generate: (input: SessionGenerateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["generate"]>>>(
          { method: "session.generate", operationID: 4029, resultPath: ["data", "data"], empty: false },
          { params: { sessionID: input["sessionID"] }, payload: { prompt: input["prompt"] } },
          input,
          requestOptions,
        ),
      prediction: (input: SessionPredictionInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["prediction"]>>>(
          { method: "session.prediction", operationID: 4082, resultPath: ["data", "data"], empty: false },
          { params: { sessionID: input["sessionID"] }, payload: { memory: input["memory"], hint: input["hint"] } },
          input,
          requestOptions,
        ),
      promptGenerate: (input: SessionPromptGenerateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["promptGenerate"]>>>(
          { method: "session.promptGenerate", operationID: 4083, resultPath: ["data", "data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            payload: { mode: input["mode"], intent: input["intent"], memory: input["memory"] },
          },
          input,
          requestOptions,
        ),
      log: (input: SessionLogInput, requestOptions?: RequestOptions) =>
        transport.stream<StreamValue<ReturnType<Client["session"]["log"]>>>(
          { method: "session.log", operationID: 4039, resultPath: [], empty: false },
          { params: { sessionID: input["sessionID"] }, query: { after: input["after"], follow: input["follow"] } },
          input,
          requestOptions,
        ),
      interrupt: (input: SessionInterruptInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["interrupt"]>>>(
          { method: "session.interrupt", operationID: 4037, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      background: (input: SessionBackgroundInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["background"]>>>(
          { method: "session.background", operationID: 4013, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      message: (input: SessionMessageInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["session"]["message"]>>>(
          { method: "session.message", operationID: 4040, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"], messageID: input["messageID"] } },
          input,
          requestOptions,
        ),
    },
    guardrail: {
      status: (input: GuardrailStatusInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["guardrail"]["status"]>>>(
          { method: "guardrail.status", operationID: 4033, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      request: {
        list: (input: GuardrailRequestListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["guardrail"]["request"]["list"]>>>(
            { method: "guardrail.request.list", operationID: 4031, resultPath: ["data"], empty: false },
            { params: { sessionID: input["sessionID"] } },
            input,
            requestOptions,
          ),
        reply: (input: GuardrailRequestReplyInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["guardrail"]["request"]["reply"]>>>(
            { method: "guardrail.request.reply", operationID: 4032, resultPath: [], empty: true },
            {
              params: { sessionID: input["sessionID"], requestID: input["requestID"] },
              payload: { reply: input["reply"] },
            },
            input,
            requestOptions,
          ),
      },
    },
    message: {
      list: (input: MessageListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["message"]["list"]>>>(
          { method: "message.list", operationID: 4041, resultPath: ["data", "data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      capturedInputs: (input: MessageCapturedInputsInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["message"]["capturedInputs"]>>>(
          { method: "message.capturedInputs", operationID: 4080, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] }, query: { after: input["after"], limit: input["limit"] } },
          input,
          requestOptions,
        ),
    },
    model: {
      list: (input?: ModelListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["model"]["list"]>>>(
          { method: "model.list", operationID: 2043, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
      default: (input?: ModelDefaultInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["model"]["default"]>>>(
          { method: "model.default", operationID: 2042, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
    },
    generate: {
      text: (input: GenerateTextInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["generate"]["text"]>>>(
          { method: "generate.text", operationID: 4003, resultPath: ["data", "data"], empty: false },
          { query: { location: input["location"] }, payload: { prompt: input["prompt"], model: input["model"] } },
          input,
          requestOptions,
        ),
    },
    provider: {
      integrations: (input?: ProviderIntegrationsInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["provider"]["integrations"]>>>(
          { method: "provider.integrations", operationID: 2051, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
      list: (input?: ProviderListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["provider"]["list"]>>>(
          { method: "provider.list", operationID: 2052, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
      refresh: (input?: ProviderRefreshInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["provider"]["refresh"]>>>(
          { method: "provider.refresh", operationID: 2053, resultPath: [], empty: true },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
      get: (input: ProviderGetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["provider"]["get"]>>>(
          { method: "provider.get", operationID: 2050, resultPath: [], empty: false },
          { params: { providerID: input["providerID"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
    },
    providerUsage: {
      list: (input?: ProviderUsageListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["providerUsage"]["list"]>>>(
          { method: "providerUsage.list", operationID: 2055, resultPath: [], empty: false },
          { query: { location: input?.["location"], refresh: input?.["refresh"] } },
          input,
          requestOptions,
        ),
      get: (input: ProviderUsageGetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["providerUsage"]["get"]>>>(
          { method: "providerUsage.get", operationID: 2054, resultPath: [], empty: false },
          {
            params: { providerID: input["providerID"] },
            query: { location: input["location"], refresh: input["refresh"] },
          },
          input,
          requestOptions,
        ),
    },
    integration: {
      list: (input?: IntegrationListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["integration"]["list"]>>>(
          { method: "integration.list", operationID: 2029, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
      get: (input: IntegrationGetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["integration"]["get"]>>>(
          { method: "integration.get", operationID: 2028, resultPath: [], empty: false },
          { params: { integrationID: input["integrationID"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
      wellknown: {
        add: (input: IntegrationWellknownAddInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["integration"]["wellknown"]["add"]>>>(
            { method: "integration.wellknown.add", operationID: 2034, resultPath: [], empty: true },
            { query: { location: input["location"] }, payload: { url: input["url"] } },
            input,
            requestOptions,
          ),
      },
      connect: {
        key: (input: IntegrationConnectKeyInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["integration"]["connect"]["key"]>>>(
            { method: "integration.connect.key", operationID: 2027, resultPath: [], empty: true },
            {
              params: { integrationID: input["integrationID"] },
              query: { location: input["location"] },
              payload: { key: input["key"], label: input["label"] },
            },
            input,
            requestOptions,
          ),
      },
      oauth: {
        connect: (input: IntegrationOauthConnectInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["integration"]["oauth"]["connect"]>>>(
            { method: "integration.oauth.connect", operationID: 2032, resultPath: [], empty: false },
            {
              params: { integrationID: input["integrationID"] },
              query: { location: input["location"] },
              payload: { methodID: input["methodID"], inputs: input["inputs"], label: input["label"] },
            },
            input,
            requestOptions,
          ),
        status: (input: IntegrationOauthStatusInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["integration"]["oauth"]["status"]>>>(
            { method: "integration.oauth.status", operationID: 2033, resultPath: [], empty: false },
            {
              params: { integrationID: input["integrationID"], attemptID: input["attemptID"] },
              query: { location: input["location"] },
            },
            input,
            requestOptions,
          ),
        complete: (input: IntegrationOauthCompleteInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["integration"]["oauth"]["complete"]>>>(
            { method: "integration.oauth.complete", operationID: 2031, resultPath: [], empty: true },
            {
              params: { integrationID: input["integrationID"], attemptID: input["attemptID"] },
              query: { location: input["location"] },
              payload: { code: input["code"] },
            },
            input,
            requestOptions,
          ),
        cancel: (input: IntegrationOauthCancelInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["integration"]["oauth"]["cancel"]>>>(
            { method: "integration.oauth.cancel", operationID: 2030, resultPath: [], empty: true },
            {
              params: { integrationID: input["integrationID"], attemptID: input["attemptID"] },
              query: { location: input["location"] },
            },
            input,
            requestOptions,
          ),
      },
      command: {
        connect: (input: IntegrationCommandConnectInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["integration"]["command"]["connect"]>>>(
            { method: "integration.command.connect", operationID: 2025, resultPath: [], empty: false },
            {
              params: { integrationID: input["integrationID"] },
              query: { location: input["location"] },
              payload: { methodID: input["methodID"], label: input["label"] },
            },
            input,
            requestOptions,
          ),
        status: (input: IntegrationCommandStatusInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["integration"]["command"]["status"]>>>(
            { method: "integration.command.status", operationID: 2026, resultPath: [], empty: false },
            {
              params: { integrationID: input["integrationID"], attemptID: input["attemptID"] },
              query: { location: input["location"] },
            },
            input,
            requestOptions,
          ),
        cancel: (input: IntegrationCommandCancelInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["integration"]["command"]["cancel"]>>>(
            { method: "integration.command.cancel", operationID: 2024, resultPath: [], empty: true },
            {
              params: { integrationID: input["integrationID"], attemptID: input["attemptID"] },
              query: { location: input["location"] },
            },
            input,
            requestOptions,
          ),
      },
    },
    mcp: {
      list: (input?: McpListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["mcp"]["list"]>>>(
          { method: "mcp.list", operationID: 2039, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
      add: (input: McpAddInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["mcp"]["add"]>>>(
          { method: "mcp.add", operationID: 2036, resultPath: [], empty: true },
          {
            params: { server: input["server"] },
            query: { location: input["location"] },
            payload: { config: input["config"] },
          },
          input,
          requestOptions,
        ),
      remove: (input: McpRemoveInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["mcp"]["remove"]>>>(
          { method: "mcp.remove", operationID: 2040, resultPath: [], empty: true },
          { params: { server: input["server"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
      connect: (input: McpConnectInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["mcp"]["connect"]>>>(
          { method: "mcp.connect", operationID: 2037, resultPath: [], empty: true },
          { params: { server: input["server"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
      disconnect: (input: McpDisconnectInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["mcp"]["disconnect"]>>>(
          { method: "mcp.disconnect", operationID: 2038, resultPath: [], empty: true },
          { params: { server: input["server"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
      resource: {
        catalog: (input?: McpResourceCatalogInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["mcp"]["resource"]["catalog"]>>>(
            { method: "mcp.resource.catalog", operationID: 2041, resultPath: [], empty: false },
            { query: { location: input?.["location"] } },
            input,
            requestOptions,
          ),
      },
    },
    credential: {
      update: (input: CredentialUpdateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["credential"]["update"]>>>(
          { method: "credential.update", operationID: 2023, resultPath: [], empty: true },
          {
            params: { credentialID: input["credentialID"] },
            query: { location: input["location"] },
            payload: { label: input["label"] },
          },
          input,
          requestOptions,
        ),
      activate: (input: CredentialActivateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["credential"]["activate"]>>>(
          { method: "credential.activate", operationID: 2021, resultPath: [], empty: true },
          { params: { credentialID: input["credentialID"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
      remove: (input: CredentialRemoveInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["credential"]["remove"]>>>(
          { method: "credential.remove", operationID: 2022, resultPath: [], empty: true },
          { params: { credentialID: input["credentialID"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
    },
    project: {
      list: (requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["project"]["list"]>>>(
          { method: "project.list", operationID: 2049, resultPath: [], empty: false },
          {},
          undefined,
          requestOptions,
        ),
      inventory: (input?: ProjectInventoryInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["project"]["inventory"]>>>(
          { method: "project.inventory", operationID: 2048, resultPath: ["data"], empty: false },
          { query: { limit: input?.["limit"], search: input?.["search"], cursor: input?.["cursor"] } },
          input,
          requestOptions,
        ),
      current: (input?: ProjectCurrentInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["project"]["current"]>>>(
          { method: "project.current", operationID: 2045, resultPath: ["data"], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
      directories: (input: ProjectDirectoriesInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["project"]["directories"]>>>(
          { method: "project.directories", operationID: 2046, resultPath: ["data"], empty: false },
          { params: { projectID: input["projectID"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
      forget: (input: ProjectForgetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["project"]["forget"]>>>(
          { method: "project.forget", operationID: 2047, resultPath: [], empty: true },
          { params: { projectID: input["projectID"] }, payload: { directory: input["directory"] } },
          input,
          requestOptions,
        ),
    },
    form: {
      request: {
        list: (input?: FormRequestListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["form"]["request"]["list"]>>>(
            { method: "form.request.list", operationID: 4002, resultPath: [], empty: false },
            { query: { location: input?.["location"] } },
            input,
            requestOptions,
          ),
      },
      list: (input: FormListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["form"]["list"]>>>(
          { method: "form.list", operationID: 4026, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      create: (input: FormCreateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["form"]["create"]>>>(
          { method: "form.create", operationID: 4024, resultPath: ["data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            payload: { id: input["id"], title: input["title"], metadata: input["metadata"], fields: input["fields"] },
          },
          input,
          requestOptions,
        ),
      get: (input: FormGetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["form"]["get"]>>>(
          { method: "form.get", operationID: 4025, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"], formID: input["formID"] } },
          input,
          requestOptions,
        ),
      state: (input: FormStateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["form"]["state"]>>>(
          { method: "form.state", operationID: 4028, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"], formID: input["formID"] } },
          input,
          requestOptions,
        ),
      reply: (input: FormReplyInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["form"]["reply"]>>>(
          { method: "form.reply", operationID: 4027, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"], formID: input["formID"] }, payload: { answer: input["answer"] } },
          input,
          requestOptions,
        ),
      cancel: (input: FormCancelInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["form"]["cancel"]>>>(
          { method: "form.cancel", operationID: 4023, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"], formID: input["formID"] } },
          input,
          requestOptions,
        ),
    },
    permission: {
      request: {
        list: (input?: PermissionRequestListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["permission"]["request"]["list"]>>>(
            { method: "permission.request.list", operationID: 4004, resultPath: [], empty: false },
            { query: { location: input?.["location"] } },
            input,
            requestOptions,
          ),
      },
      saved: {
        list: (input?: PermissionSavedListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["permission"]["saved"]["list"]>>>(
            { method: "permission.saved.list", operationID: 4005, resultPath: ["data"], empty: false },
            { query: { projectID: input?.["projectID"] } },
            input,
            requestOptions,
          ),
        remove: (input: PermissionSavedRemoveInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["permission"]["saved"]["remove"]>>>(
            { method: "permission.saved.remove", operationID: 4006, resultPath: [], empty: true },
            { params: { id: input["id"] } },
            input,
            requestOptions,
          ),
      },
      create: (input: PermissionCreateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["permission"]["create"]>>>(
          { method: "permission.create", operationID: 4045, resultPath: ["data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            payload: {
              id: input["id"],
              action: input["action"],
              resources: input["resources"],
              save: input["save"],
              metadata: input["metadata"],
              source: input["source"],
              agent: input["agent"],
            },
          },
          input,
          requestOptions,
        ),
      list: (input: PermissionListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["permission"]["list"]>>>(
          { method: "permission.list", operationID: 4047, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      get: (input: PermissionGetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["permission"]["get"]>>>(
          { method: "permission.get", operationID: 4046, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"], requestID: input["requestID"] } },
          input,
          requestOptions,
        ),
      reply: (input: PermissionReplyInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["permission"]["reply"]>>>(
          { method: "permission.reply", operationID: 4048, resultPath: [], empty: true },
          {
            params: { sessionID: input["sessionID"], requestID: input["requestID"] },
            payload: { reply: input["reply"], message: input["message"] },
          },
          input,
          requestOptions,
        ),
    },
    file: {
      read: (input: FileReadInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["file"]["read"]>>>(
          { method: "file.read", operationID: 3015, resultPath: [], empty: false },
          { params: { path: input["path"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
      list: (input?: FileListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["file"]["list"]>>>(
          { method: "file.list", operationID: 3014, resultPath: [], empty: false },
          { query: { location: input?.["location"], path: input?.["path"] } },
          input,
          requestOptions,
        ),
      find: (input: FileFindInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["file"]["find"]>>>(
          { method: "file.find", operationID: 3013, resultPath: [], empty: false },
          { query: { location: input["location"], query: input["query"], type: input["type"], limit: input["limit"] } },
          input,
          requestOptions,
        ),
    },
    command: {
      list: (input?: CommandListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["command"]["list"]>>>(
          { method: "command.list", operationID: 2019, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
    },
    skill: {
      list: (input?: SkillListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["skill"]["list"]>>>(
          { method: "skill.list", operationID: 2057, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
    },
    event: {
      subscribe: (requestOptions?: RequestOptions) =>
        transport.stream<StreamValue<ReturnType<Client["event"]["subscribe"]>>>(
          { method: "event.subscribe", operationID: 4000, resultPath: [], empty: false },
          { scope: transport.globalScope() },
          undefined,
          requestOptions,
        ),
    },
    pty: {
      list: (input: PtyListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["pty"]["list"]>>>(
          { method: "pty.list", operationID: 3034, resultPath: [], empty: false },
          { query: { location: input["location"], sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      create: (input: PtyCreateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["pty"]["create"]>>>(
          { method: "pty.create", operationID: 3032, resultPath: [], empty: false },
          {
            query: { location: input["location"] },
            payload: {
              sessionID: input["sessionID"],
              command: input["command"],
              args: input["args"],
              cwd: input["cwd"],
              title: input["title"],
              env: input["env"],
              size: input["size"],
              maxRuntimeSeconds: input["maxRuntimeSeconds"],
              maxRetainedBytes: input["maxRetainedBytes"],
            },
          },
          input,
          requestOptions,
        ),
      get: (input: PtyGetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["pty"]["get"]>>>(
          { method: "pty.get", operationID: 3033, resultPath: [], empty: false },
          { params: { ptyID: input["ptyID"] }, query: { location: input["location"], sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      update: (input: PtyUpdateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["pty"]["update"]>>>(
          { method: "pty.update", operationID: 3036, resultPath: [], empty: false },
          {
            params: { ptyID: input["ptyID"] },
            query: { location: input["location"] },
            payload: {
              sessionID: input["sessionID"],
              generation: input["generation"],
              expectedFence: input["expectedFence"],
              actor: input["actor"],
              title: input["title"],
              size: input["size"],
            },
          },
          input,
          requestOptions,
        ),
      remove: (input: PtyRemoveInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["pty"]["remove"]>>>(
          { method: "pty.remove", operationID: 3035, resultPath: [], empty: true },
          { params: { ptyID: input["ptyID"] }, query: { location: input["location"], sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      control: (input: PtyControlInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["pty"]["control"]>>>(
          { method: "pty.control", operationID: 3031, resultPath: [], empty: false },
          {
            params: { ptyID: input["ptyID"] },
            query: { location: input["location"] },
            payload: {
              sessionID: input["sessionID"],
              generation: input["generation"],
              expectedFence: input["expectedFence"],
              action: input["action"],
            },
          },
          input,
          requestOptions,
        ),
      connect: {
        token: (input: PtyConnectTokenInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["pty"]["connect"]["token"]>>>(
            { method: "pty.connect.token", operationID: 3030, resultPath: [], empty: false },
            {
              params: { ptyID: input["ptyID"] },
              query: { location: input["location"] },
              headers: { x_ycoding_ticket: input["x-ycoding-ticket"] },
              payload: {
                sessionID: input["sessionID"],
                access: input["access"],
                generation: input["generation"],
                expectedFence: input["expectedFence"],
              },
            },
            input,
            requestOptions,
          ),
      },
    },
    shell: {
      list: (input?: ShellListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["shell"]["list"]>>>(
          { method: "shell.list", operationID: 3042, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
      create: (input: ShellCreateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["shell"]["create"]>>>(
          { method: "shell.create", operationID: 3040, resultPath: [], empty: false },
          {
            query: { location: input["location"] },
            payload: {
              command: input["command"],
              cwd: input["cwd"],
              timeout: input["timeout"],
              memoryLimitMb: input["memoryLimitMb"],
              metadata: input["metadata"],
            },
          },
          input,
          requestOptions,
        ),
      get: (input: ShellGetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["shell"]["get"]>>>(
          { method: "shell.get", operationID: 3041, resultPath: [], empty: false },
          { params: { id: input["id"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
      timeout: (input: ShellTimeoutInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["shell"]["timeout"]>>>(
          { method: "shell.timeout", operationID: 3045, resultPath: [], empty: false },
          {
            params: { id: input["id"] },
            query: { location: input["location"] },
            payload: { timeout: input["timeout"] },
          },
          input,
          requestOptions,
        ),
      output: (input: ShellOutputInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["shell"]["output"]>>>(
          { method: "shell.output", operationID: 3043, resultPath: [], empty: false },
          {
            params: { id: input["id"] },
            query: { location: input["location"], cursor: input["cursor"], limit: input["limit"] },
          },
          input,
          requestOptions,
        ),
      remove: (input: ShellRemoveInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["shell"]["remove"]>>>(
          { method: "shell.remove", operationID: 3044, resultPath: [], empty: true },
          { params: { id: input["id"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
    },
    question: {
      request: {
        list: (input?: QuestionRequestListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["question"]["request"]["list"]>>>(
            { method: "question.request.list", operationID: 4007, resultPath: [], empty: false },
            { query: { location: input?.["location"] } },
            input,
            requestOptions,
          ),
      },
      list: (input: QuestionListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["question"]["list"]>>>(
          { method: "question.list", operationID: 4051, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      reply: (input: QuestionReplyInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["question"]["reply"]>>>(
          { method: "question.reply", operationID: 4053, resultPath: [], empty: true },
          {
            params: { sessionID: input["sessionID"], requestID: input["requestID"] },
            payload: { answers: input["answers"] },
          },
          input,
          requestOptions,
        ),
      reject: (input: QuestionRejectInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["question"]["reject"]>>>(
          { method: "question.reject", operationID: 4052, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"], requestID: input["requestID"] } },
          input,
          requestOptions,
        ),
    },
    reference: {
      list: (input?: ReferenceListInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["reference"]["list"]>>>(
          { method: "reference.list", operationID: 2056, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
    },
    projectCopy: {
      create: (input: ProjectCopyCreateInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["projectCopy"]["create"]>>>(
          { method: "projectCopy.create", operationID: 3027, resultPath: ["data"], empty: false },
          {
            params: { projectID: input["projectID"] },
            query: { location: input["location"] },
            payload: { strategy: input["strategy"], directory: input["directory"], name: input["name"] },
          },
          input,
          requestOptions,
        ),
      remove: (input: ProjectCopyRemoveInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["projectCopy"]["remove"]>>>(
          { method: "projectCopy.remove", operationID: 3029, resultPath: [], empty: true },
          {
            params: { projectID: input["projectID"] },
            query: { location: input["location"] },
            payload: { directory: input["directory"], force: input["force"] },
          },
          input,
          requestOptions,
        ),
      refresh: (input: ProjectCopyRefreshInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["projectCopy"]["refresh"]>>>(
          { method: "projectCopy.refresh", operationID: 3028, resultPath: [], empty: true },
          { params: { projectID: input["projectID"] }, query: { location: input["location"] } },
          input,
          requestOptions,
        ),
    },
    vcs: {
      status: (input?: VcsStatusInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["vcs"]["status"]>>>(
          { method: "vcs.status", operationID: 3052, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
      branch: (input?: VcsBranchInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["vcs"]["branch"]>>>(
          { method: "vcs.branch", operationID: 3050, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
      diff: (input: VcsDiffInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["vcs"]["diff"]>>>(
          { method: "vcs.diff", operationID: 3051, resultPath: [], empty: false },
          { query: { location: input["location"], mode: input["mode"], context: input["context"] } },
          input,
          requestOptions,
        ),
    },
    projectArtifact: {
      artifact: {
        list: (input: ProjectArtifactArtifactListInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["list"]>>>(
            { method: "projectArtifact.artifact.list", operationID: 2008, resultPath: ["data"], empty: false },
            {
              query: { location: input["location"], scope: input["scope"], kind: input["kind"], stage: input["stage"] },
            },
            input,
            requestOptions,
          ),
        get: (input: ProjectArtifactArtifactGetInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["get"]>>>(
            { method: "projectArtifact.artifact.get", operationID: 2007, resultPath: ["data"], empty: false },
            {
              params: { scope: input["scope"], kind: input["kind"], id: input["id"] },
              query: { location: input["location"] },
            },
            input,
            requestOptions,
          ),
        create: (input: ProjectArtifactArtifactCreateInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["create"]>>>(
            { method: "projectArtifact.artifact.create", operationID: 2002, resultPath: ["data"], empty: false },
            {
              query: { location: input["location"] },
              payload: { scope: input["scope"], id: input["id"], definition: input["definition"] },
            },
            input,
            requestOptions,
          ),
        update: (input: ProjectArtifactArtifactUpdateInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["update"]>>>(
            { method: "projectArtifact.artifact.update", operationID: 2018, resultPath: ["data"], empty: false },
            {
              params: { scope: input["scope"], kind: input["kind"], id: input["id"] },
              query: { location: input["location"] },
              payload: {
                definition: input["definition"],
                expectedRevision: input["expectedRevision"],
                expectedVersionID: input["expectedVersionID"],
                expectedDigest: input["expectedDigest"],
              },
            },
            input,
            requestOptions,
          ),
        global: {
          confirm: (input: ProjectArtifactArtifactGlobalConfirmInput, requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["global"]["confirm"]>>>(
              {
                method: "projectArtifact.artifact.global.confirm",
                operationID: 2001,
                resultPath: ["data"],
                empty: false,
              },
              { query: { location: input["location"] }, payload: { token: input["token"] } },
              input,
              requestOptions,
            ),
        },
        disable: (input: ProjectArtifactArtifactDisableInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["disable"]>>>(
            { method: "projectArtifact.artifact.disable", operationID: 2003, resultPath: [], empty: true },
            {
              params: { scope: input["scope"], kind: input["kind"], id: input["id"] },
              query: { location: input["location"] },
              payload: {
                expectedRevision: input["expectedRevision"],
                expectedVersionID: input["expectedVersionID"],
                expectedDigest: input["expectedDigest"],
              },
            },
            input,
            requestOptions,
          ),
        enable: (input: ProjectArtifactArtifactEnableInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["enable"]>>>(
            { method: "projectArtifact.artifact.enable", operationID: 2004, resultPath: [], empty: true },
            {
              params: { scope: input["scope"], kind: input["kind"], id: input["id"] },
              query: { location: input["location"] },
              payload: {
                expectedRevision: input["expectedRevision"],
                expectedVersionID: input["expectedVersionID"],
                expectedDigest: input["expectedDigest"],
              },
            },
            input,
            requestOptions,
          ),
        remove: (input: ProjectArtifactArtifactRemoveInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["remove"]>>>(
            { method: "projectArtifact.artifact.remove", operationID: 2013, resultPath: ["data"], empty: false },
            {
              params: { scope: input["scope"], kind: input["kind"], id: input["id"] },
              query: { location: input["location"] },
              payload: {
                expectedRevision: input["expectedRevision"],
                expectedVersionID: input["expectedVersionID"],
                expectedDigest: input["expectedDigest"],
              },
            },
            input,
            requestOptions,
          ),
        restore: (input: ProjectArtifactArtifactRestoreInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["restore"]>>>(
            { method: "projectArtifact.artifact.restore", operationID: 2014, resultPath: [], empty: true },
            { params: { deletionID: input["deletionID"] }, query: { location: input["location"] } },
            input,
            requestOptions,
          ),
        revert: (input: ProjectArtifactArtifactRevertInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["revert"]>>>(
            { method: "projectArtifact.artifact.revert", operationID: 2015, resultPath: [], empty: true },
            {
              params: { scope: input["scope"], kind: input["kind"], id: input["id"] },
              query: { location: input["location"] },
              payload: {
                expectedRevision: input["expectedRevision"],
                expectedVersionID: input["expectedVersionID"],
                expectedDigest: input["expectedDigest"],
                targetVersionID: input["targetVersionID"],
              },
            },
            input,
            requestOptions,
          ),
        metrics: (input: ProjectArtifactArtifactMetricsInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["metrics"]>>>(
            { method: "projectArtifact.artifact.metrics", operationID: 2009, resultPath: ["data"], empty: false },
            {
              params: { scope: input["scope"], kind: input["kind"], id: input["id"] },
              query: { location: input["location"] },
            },
            input,
            requestOptions,
          ),
        promotion: {
          preview: (input: ProjectArtifactArtifactPromotionPreviewInput, requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["promotion"]["preview"]>>>(
              {
                method: "projectArtifact.artifact.promotion.preview",
                operationID: 2011,
                resultPath: ["data"],
                empty: false,
              },
              {
                params: { kind: input["kind"], id: input["id"] },
                query: { location: input["location"] },
                payload: {
                  expectedRevision: input["expectedRevision"],
                  expectedVersionID: input["expectedVersionID"],
                  expectedDigest: input["expectedDigest"],
                },
              },
              input,
              requestOptions,
            ),
          confirm: (input: ProjectArtifactArtifactPromotionConfirmInput, requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["promotion"]["confirm"]>>>(
              {
                method: "projectArtifact.artifact.promotion.confirm",
                operationID: 2010,
                resultPath: ["data"],
                empty: false,
              },
              {
                params: { kind: input["kind"], id: input["id"], token: input["token"] },
                query: { location: input["location"] },
              },
              input,
              requestOptions,
            ),
        },
        fork: {
          preview: (input: ProjectArtifactArtifactForkPreviewInput, requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["fork"]["preview"]>>>(
              {
                method: "projectArtifact.artifact.fork.preview",
                operationID: 2006,
                resultPath: ["data"],
                empty: false,
              },
              {
                params: { kind: input["kind"], id: input["id"] },
                query: { location: input["location"] },
                payload: {
                  expectedRevision: input["expectedRevision"],
                  expectedVersionID: input["expectedVersionID"],
                  expectedDigest: input["expectedDigest"],
                },
              },
              input,
              requestOptions,
            ),
          confirm: (input: ProjectArtifactArtifactForkConfirmInput, requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["fork"]["confirm"]>>>(
              {
                method: "projectArtifact.artifact.fork.confirm",
                operationID: 2005,
                resultPath: ["data"],
                empty: false,
              },
              {
                params: { kind: input["kind"], id: input["id"], token: input["token"] },
                query: { location: input["location"] },
              },
              input,
              requestOptions,
            ),
        },
        shadow: {
          preview: (input: ProjectArtifactArtifactShadowPreviewInput, requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["shadow"]["preview"]>>>(
              {
                method: "projectArtifact.artifact.shadow.preview",
                operationID: 2017,
                resultPath: ["data"],
                empty: false,
              },
              {
                params: { kind: input["kind"], id: input["id"] },
                query: { location: input["location"] },
                payload: {
                  expectedRevision: input["expectedRevision"],
                  expectedVersionID: input["expectedVersionID"],
                  expectedDigest: input["expectedDigest"],
                },
              },
              input,
              requestOptions,
            ),
          confirm: (input: ProjectArtifactArtifactShadowConfirmInput, requestOptions?: RequestOptions) =>
            transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["shadow"]["confirm"]>>>(
              { method: "projectArtifact.artifact.shadow.confirm", operationID: 2016, resultPath: [], empty: true },
              {
                params: { kind: input["kind"], id: input["id"], token: input["token"] },
                query: { location: input["location"] },
              },
              input,
              requestOptions,
            ),
        },
        purge: (input?: ProjectArtifactArtifactPurgeInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["projectArtifact"]["artifact"]["purge"]>>>(
            { method: "projectArtifact.artifact.purge", operationID: 2012, resultPath: ["data"], empty: false },
            { query: { location: input?.["location"] } },
            input,
            requestOptions,
          ),
      },
    },
    debug: {
      location: {
        list: (requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["debug"]["location"]["list"]>>>(
            { method: "debug.location.list", operationID: 3011, resultPath: [], empty: false },
            {},
            undefined,
            requestOptions,
          ),
        evict: (input?: DebugLocationEvictInput, requestOptions?: RequestOptions) =>
          transport.call<Awaited<ReturnType<Client["debug"]["location"]["evict"]>>>(
            { method: "debug.location.evict", operationID: 3012, resultPath: [], empty: true },
            { query: { location: input?.["location"] } },
            input,
            requestOptions,
          ),
      },
    },
    browser: {
      status: (input: BrowserStatusInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["browser"]["status"]>>>(
          { method: "browser.status", operationID: 3008, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      tabs: (input: BrowserTabsInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["browser"]["tabs"]>>>(
          { method: "browser.tabs", operationID: 3010, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      start: (input: BrowserStartInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["browser"]["start"]>>>(
          { method: "browser.start", operationID: 3007, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      observe: (input: BrowserObserveInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["browser"]["observe"]>>>(
          { method: "browser.observe", operationID: 3004, resultPath: ["data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            payload: { tabID: input["tabID"], generation: input["generation"], callID: input["callID"] },
          },
          input,
          requestOptions,
        ),
      open: (input: BrowserOpenInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["browser"]["open"]>>>(
          { method: "browser.open", operationID: 3005, resultPath: ["data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            payload: { generation: input["generation"], url: input["url"], callID: input["callID"] },
          },
          input,
          requestOptions,
        ),
      close: (input: BrowserCloseInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["browser"]["close"]>>>(
          { method: "browser.close", operationID: 3001, resultPath: [], empty: true },
          {
            params: { sessionID: input["sessionID"] },
            payload: { tabID: input["tabID"], generation: input["generation"], callID: input["callID"] },
          },
          input,
          requestOptions,
        ),
      release: (input: BrowserReleaseInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["browser"]["release"]>>>(
          { method: "browser.release", operationID: 3006, resultPath: [], empty: true },
          {
            params: { sessionID: input["sessionID"] },
            payload: { tabID: input["tabID"], generation: input["generation"], callID: input["callID"] },
          },
          input,
          requestOptions,
        ),
      action: (input: BrowserActionInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["browser"]["action"]>>>(
          { method: "browser.action", operationID: 3000, resultPath: ["data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            payload: {
              tabID: input["tabID"],
              generation: input["generation"],
              documentGeneration: input["documentGeneration"],
              observationRevision: input["observationRevision"],
              callID: input["callID"],
              action: input["action"],
            },
          },
          input,
          requestOptions,
        ),
      control: (input: BrowserControlInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["browser"]["control"]>>>(
          { method: "browser.control", operationID: 3002, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] }, payload: { action: input["action"] } },
          input,
          requestOptions,
        ),
      stop: (input: BrowserStopInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["browser"]["stop"]>>>(
          { method: "browser.stop", operationID: 3009, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      forget: (input: BrowserForgetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["browser"]["forget"]>>>(
          { method: "browser.forget", operationID: 3003, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
    },
    isolatedBrowser: {
      status: (input: IsolatedBrowserStatusInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["isolatedBrowser"]["status"]>>>(
          { method: "isolatedBrowser.status", operationID: 3022, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      start: (input: IsolatedBrowserStartInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["isolatedBrowser"]["start"]>>>(
          { method: "isolatedBrowser.start", operationID: 3021, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] }, payload: { url: input["url"] } },
          input,
          requestOptions,
        ),
      tabs: (input: IsolatedBrowserTabsInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["isolatedBrowser"]["tabs"]>>>(
          { method: "isolatedBrowser.tabs", operationID: 3024, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
      observe: (input: IsolatedBrowserObserveInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["isolatedBrowser"]["observe"]>>>(
          { method: "isolatedBrowser.observe", operationID: 3020, resultPath: ["data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            payload: {
              tabID: input["tabID"],
              generation: input["generation"],
              callID: input["callID"],
              instanceID: input["instanceID"],
            },
          },
          input,
          requestOptions,
        ),
      action: (input: IsolatedBrowserActionInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["isolatedBrowser"]["action"]>>>(
          { method: "isolatedBrowser.action", operationID: 3018, resultPath: ["data"], empty: false },
          {
            params: { sessionID: input["sessionID"] },
            payload: {
              tabID: input["tabID"],
              generation: input["generation"],
              documentGeneration: input["documentGeneration"],
              observationRevision: input["observationRevision"],
              callID: input["callID"],
              action: input["action"],
              instanceID: input["instanceID"],
            },
          },
          input,
          requestOptions,
        ),
      control: (input: IsolatedBrowserControlInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["isolatedBrowser"]["control"]>>>(
          { method: "isolatedBrowser.control", operationID: 3019, resultPath: ["data"], empty: false },
          { params: { sessionID: input["sessionID"] }, payload: { action: input["action"] } },
          input,
          requestOptions,
        ),
      stop: (input: IsolatedBrowserStopInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["isolatedBrowser"]["stop"]>>>(
          { method: "isolatedBrowser.stop", operationID: 3023, resultPath: [], empty: true },
          { params: { sessionID: input["sessionID"] } },
          input,
          requestOptions,
        ),
    },
    usage: {
      get: (requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["usage"]["get"]>>>(
          { method: "usage.get", operationID: 2058, resultPath: ["data"], empty: false },
          {},
          undefined,
          requestOptions,
        ),
      report: (input: UsageReportInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["usage"]["report"]>>>(
          { method: "usage.report", operationID: 2059, resultPath: ["data"], empty: false },
          {
            query: {
              group: input["group"],
              timeZone: input["timeZone"],
              from: input["from"],
              to: input["to"],
              offset: input["offset"],
              limit: input["limit"],
              sort: input["sort"],
              order: input["order"],
            },
          },
          input,
          requestOptions,
        ),
    },
    remote: {
      get: (requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["remote"]["get"]>>>(
          { method: "remote.get", operationID: 3037, resultPath: ["data"], empty: false },
          {},
          undefined,
          requestOptions,
        ),
      set: (input: RemoteSetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["remote"]["set"]>>>(
          { method: "remote.set", operationID: 3038, resultPath: ["data"], empty: false },
          { payload: { enabled: input["enabled"] } },
          input,
          requestOptions,
        ),
    },
    keepAwake: {
      get: (requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["keepAwake"]["get"]>>>(
          { method: "keepAwake.get", operationID: 3025, resultPath: ["data"], empty: false },
          {},
          undefined,
          requestOptions,
        ),
      set: (input: KeepAwakeSetInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["keepAwake"]["set"]>>>(
          { method: "keepAwake.set", operationID: 3026, resultPath: ["data"], empty: false },
          { payload: { enabled: input["enabled"] } },
          input,
          requestOptions,
        ),
    },
    config: {
      diagnostics: (input?: ConfigDiagnosticsInput, requestOptions?: RequestOptions) =>
        transport.call<Awaited<ReturnType<Client["config"]["diagnostics"]>>>(
          { method: "config.diagnostics", operationID: 2020, resultPath: [], empty: false },
          { query: { location: input?.["location"] } },
          input,
          requestOptions,
        ),
    },
  }
}
