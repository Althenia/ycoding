import type { InteractionPreview, InteractionStatus, SessionInteractionRequestInput, YCodingClient, YCodingEvent } from "@ycoding-ai/client"
import type { Pty } from "@ycoding-ai/client/effect"

export class DesktopError extends Error {}

const encoder = new TextEncoder()
export const utf8Length = (value: string) => encoder.encode(value).length

export type Selection = { readonly mode: "own" } | { readonly mode: "shared"; readonly server?: string }
export type Preferences = { readonly selection?: Selection; readonly sharedEndpoint?: string; readonly error?: string }
export type ConnectionState = {
  readonly generation: number
  readonly status: "idle" | "connecting" | "connected" | "reconnecting" | "error"
  readonly mode?: Selection["mode"]
  readonly revision?: number
  readonly version?: string
  readonly backendPID?: number
  readonly error?: string
  readonly notice?: string
}
export type SessionsQuery =
  | { readonly search?: string; readonly revision?: never; readonly cursor?: never }
  | { readonly revision: number; readonly cursor: string; readonly search?: never }
export type SessionItem = {
  readonly id: string
  readonly parentID?: string
  readonly title: string
  readonly location: { readonly directory: string; readonly workspaceID?: string }
  readonly time: { readonly updated: number; readonly active?: number; readonly archived?: number; readonly pinned?: number }
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string }
  readonly revert?: { readonly messageID: string; readonly files?: ReadonlyArray<{ readonly file: string; readonly status?: "added" | "deleted" | "modified"; readonly additions: number; readonly deletions: number }> }
  readonly tokens: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } }
  readonly cost: number
}
export type Sessions = { readonly revision: number; readonly items: readonly SessionItem[]; readonly next?: string; readonly running?: readonly string[]; readonly waiting?: readonly string[] }
export type SessionRead = { readonly revision: number; readonly item: SessionItem }
export type SessionAutonomySnapshot = { readonly revision: number; readonly sessionID: string; readonly autonomy: Awaited<ReturnType<YCodingClient["session"]["autonomy"]["get"]>> }
export type SetAutonomyInput = { readonly sessionID: string; readonly revision: number; readonly payload: Parameters<YCodingClient["session"]["autonomy"]["set"]>[0]["payload"] }
export type SessionFileChanges = { readonly revision: number; readonly sessionID: string; readonly items: Awaited<ReturnType<YCodingClient["session"]["file-change"]["list"]>>; readonly turns?: ReadonlyArray<{ readonly id: string; readonly type: "user" | "synthetic" | "assistant"; readonly files: ReadonlyArray<{ readonly path: string; readonly patch: string; readonly additions: number; readonly deletions: number }> }>; readonly turnsComplete?: boolean; readonly turnsNotice?: string }
export type PageInput = { readonly cursor?: string; readonly revision?: number; readonly search?: string }
export type BrowseDirectoryInput = { readonly directory?: string; readonly showHidden?: boolean }
export type DirectoryListing = { readonly directory: string; readonly parent: string | null; readonly home: string; readonly entries: ReadonlyArray<{ readonly name: string; readonly path: string; readonly kind: "directory" | "file" }>; readonly truncated: boolean }
export type OpenedDirectory = { readonly revision: number; readonly directory: string; readonly projectID: string }
export type ActivityInput = string | ({ readonly sessionID: string } & PageInput)
export type ShellOutputInput = { readonly sessionID: string; readonly shellID: string; readonly cursor?: number; readonly limit?: number }
export type ShellSummary = { readonly status: "running" | "exited" | "timeout" | "memory-limit" | "killed"; readonly command: string; readonly cwd: string; readonly pid?: number; readonly exit?: number; readonly time: { readonly started: number; readonly completed?: number } }
export type ShellOutput = { readonly revision: number; readonly sessionID: string; readonly shellID: string; readonly shell: ShellSummary; readonly output: string; readonly cursor: number; readonly size: number; readonly truncated: boolean }
export type RevertInput = { readonly action: "stage"; readonly sessionID: string; readonly revision: number; readonly messageID: string; readonly files?: boolean } | { readonly action: "commit" | "clear"; readonly sessionID: string; readonly revision: number }
export type WorkspaceDirectoriesInput = { readonly projectID: string; readonly directory?: string }
export type WorkspaceDirectories = { readonly revision: number; readonly projectID: string; readonly directories: ReadonlyArray<{ readonly directory: string; readonly name?: string; readonly kind?: string; readonly available?: boolean }> }
export type SettingsSnapshot = {
  readonly revision: number
  readonly keepAwake: Awaited<ReturnType<YCodingClient["keepAwake"]["get"]>>
  readonly telemetryConsent: Awaited<ReturnType<YCodingClient["server"]["telemetry"]["consent"]["get"]>>
  readonly telemetrySamples: Awaited<ReturnType<YCodingClient["server"]["telemetry"]["list"]>>["data"]
  readonly savedPermissions: Awaited<ReturnType<YCodingClient["permission"]["saved"]["list"]>>
  readonly telemetryNotice?: string
}
export type SettingsMutationInput =
  | { readonly kind: "keep-awake"; readonly revision: number; readonly enabled: boolean }
  | { readonly kind: "telemetry-consent"; readonly revision: number; readonly enabled: boolean; readonly noticeVersion?: 1 }
  | { readonly kind: "remove-saved-permission"; readonly revision: number; readonly id: string }
export type ProjectMutationInput =
  | { readonly kind: "create"; readonly revision: number; readonly name: string; readonly masterSessionID: string; readonly memberSessionIDs: readonly string[] }
  | { readonly kind: "create-in-directory"; readonly revision: number; readonly name: string; readonly directory: string; readonly masterTitle?: string; readonly memberSessionIDs: readonly string[] }
  | { readonly kind: "update"; readonly revision: number; readonly groupID: string; readonly groupRevision: number; readonly concurrency?: number | null; readonly delegatedDecisions?: NonNullable<Parameters<YCodingClient["coordination"]["update"]>[0]["settings"]>["delegatedDecisions"]; readonly name?: string; readonly masterSessionID?: string; readonly memberSessionIDs?: readonly string[] }
  | { readonly kind: "delete"; readonly revision: number; readonly groupID: string }
  | { readonly kind: "new-member"; readonly revision: number; readonly groupID: string; readonly groupRevision: number; readonly directory: string; readonly title?: string }
  | { readonly kind: "delete-member"; readonly revision: number; readonly groupID: string; readonly groupRevision: number; readonly sessionID: string }
  | { readonly kind: "attach-member"; readonly revision: number; readonly groupID: string; readonly sessionID: string; readonly ownerSessionID?: string }
  | { readonly kind: "detach-member"; readonly revision: number; readonly groupID: string; readonly sessionID: string }
export type WorkspaceMutationInput =
  | { readonly kind: "create-copy"; readonly revision: number; readonly projectID: string; readonly sourceDirectory: string; readonly directory: string; readonly strategy?: string; readonly name?: string }
  | { readonly kind: "refresh-copies"; readonly revision: number; readonly projectID: string; readonly directory: string }
  | { readonly kind: "forget"; readonly revision: number; readonly projectID: string; readonly directory: string }
export type UsageRange = "today" | "7d" | "30d" | "all"
export type SessionActivity = {
  readonly revision: number
  readonly sessionID: string
  readonly subagents: Awaited<ReturnType<YCodingClient["session"]["subagent"]["list"]>>["data"]
  readonly subagentNext?: string
  readonly total: number
  readonly activeTotal: number
  readonly shells: ReadonlyArray<Awaited<ReturnType<YCodingClient["shell"]["list"]>>["data"][number] & { readonly ownerSessionID: string }>
  readonly unattributedShellCount: number
}
export type ProjectsSnapshot = {
  readonly revision: number
  readonly settings: Awaited<ReturnType<YCodingClient["coordination"]["settings"]>>
  readonly groups: readonly Awaited<ReturnType<YCodingClient["coordination"]["get"]>>[]
  readonly repositories: Awaited<ReturnType<YCodingClient["project"]["inventory"]>>["data"]
  readonly repositoriesNext?: string
}
export type UsageSnapshot = { readonly revision: number; readonly summary: Awaited<ReturnType<YCodingClient["usage"]["get"]>>; readonly report: Awaited<ReturnType<YCodingClient["usage"]["report"]>>; readonly hasMoreModels: boolean; readonly range: UsageRange; readonly quotas: Awaited<ReturnType<YCodingClient["providerUsage"]["list"]>>["data"]; readonly quotasNotice?: string }
export type PinRequest = { readonly sessionID: string; readonly revision: number; readonly pinned: boolean }
export type Session = Awaited<ReturnType<YCodingClient["session"]["create"]>>
export type Messages = Awaited<ReturnType<YCodingClient["message"]["list"]>>
export type Workspace = { readonly directory: string; readonly name?: string }
export type NewSession = { readonly directory?: string; readonly sessionID: string; readonly agent?: string }
export type PromptMention = { readonly start: number; readonly end: number; readonly text: string }
export type PromptFile = { readonly uri: string; readonly name?: string; readonly description?: string; readonly mention?: PromptMention }
export type PromptAgent = { readonly name: string; readonly mention?: PromptMention }
export type PromptDelivery = "queue" | "steer"
export type Prompt = { readonly sessionID: string; readonly promptID: string; readonly text: string; readonly files?: readonly PromptFile[]; readonly agents?: readonly PromptAgent[]; readonly delivery?: PromptDelivery } & ({ readonly steerNow?: never; readonly revision?: never } | { readonly steerNow: true; readonly revision: number })
export type ComposerCommandInput = { readonly sessionID: string; readonly promptID: string; readonly command: string; readonly arguments?: string; readonly agent?: string; readonly model?: ModelSelection; readonly files?: readonly PromptFile[]; readonly agents?: readonly PromptAgent[]; readonly delivery?: PromptDelivery }
export type CompactInput = { readonly sessionID: string; readonly revision: number; readonly compactionID: string }
export type CompactResult = Awaited<ReturnType<YCodingClient["session"]["compact"]>>
export type ComposerCatalog = {
  readonly revision: number
  readonly source: ModelSource
  readonly commands: readonly { readonly name: string; readonly description?: string }[]
  readonly skills: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
  readonly agents: readonly { readonly id: string; readonly name: string; readonly mode: "subagent" | "primary" | "all"; readonly description?: string }[]
  readonly errors: { readonly commands?: string; readonly skills?: string; readonly agents?: string }
}
export type FindFilesInput = { readonly source?: string | { readonly directory?: string }; readonly query: string }
export type FileMatches = { readonly revision: number; readonly source: ModelSource; readonly entries: readonly { readonly path: string; readonly type: "file" | "directory" }[] }
export type Admission = Awaited<ReturnType<YCodingClient["session"]["prompt"]>>
export type PermissionRequest = Awaited<ReturnType<YCodingClient["permission"]["list"]>>[number]
export type FormRequest = Awaited<ReturnType<YCodingClient["form"]["list"]>>[number]
export type PermissionDecision = Parameters<YCodingClient["permission"]["reply"]>[0]["reply"]
export type FormAnswer = Parameters<YCodingClient["form"]["reply"]>[0]["answer"]
export type QuestionRequest = Awaited<ReturnType<YCodingClient["question"]["list"]>>[number]
export type PendingRequests = {
  readonly sessionID: string
  readonly revision: number
  readonly permissions: readonly PermissionRequest[]
  readonly forms: readonly FormRequest[]
  readonly questions?: readonly QuestionRequest[]
  readonly guardrails?: ReadonlyArray<Omit<Awaited<ReturnType<YCodingClient["guardrail"]["request"]["list"]>>[number], "metadata">>
  readonly reviews?: Awaited<ReturnType<YCodingClient["review"]["list"]>>
  readonly location?: RequestLocation
  readonly rootSessionID?: string
  readonly guardrailDecisions?: DisplayValue
}
export type RequestLocation = { readonly directory: string; readonly workspace?: string }
export type GlobalRequestsInput = { readonly scope: "global"; readonly directory: string; readonly workspace?: string }
export type RequestReply =
  | { readonly kind: "question"; readonly sessionID: string; readonly revision: number; readonly requestID: string; readonly answers: readonly (readonly string[])[] }
  | { readonly kind: "question-reject"; readonly sessionID: string; readonly revision: number; readonly requestID: string }
  | { readonly kind: "guardrail"; readonly sessionID: string; readonly revision: number; readonly requestID: string; readonly reply: Parameters<YCodingClient["guardrail"]["request"]["reply"]>[0]["reply"] }
  | { readonly kind: "guardrail-recovery"; readonly sessionID: string; readonly revision: number; readonly requestID: string; readonly action: "cancel" | "retry" }
  | { readonly kind: "review"; readonly sessionID: string; readonly revision: number; readonly itemID: string; readonly decision: Parameters<YCodingClient["review"]["decide"]>[0]["decision"] }
  | { readonly kind: "permission"; readonly sessionID: string; readonly revision: number; readonly requestID: string; readonly reply: PermissionDecision; readonly message?: string }
  | { readonly kind: "form"; readonly sessionID: string; readonly revision: number; readonly formID: string; readonly answer: FormAnswer; readonly location?: RequestLocation }
  | { readonly kind: "form-cancel"; readonly sessionID: string; readonly revision: number; readonly formID: string; readonly location?: RequestLocation }
export type ModelStatus = "alpha" | "beta" | "deprecated" | "active"
export type ModelSelection = Parameters<YCodingClient["session"]["switchModel"]>[0]["model"]
export type ModelProfileOption = { readonly name: string; readonly active: boolean; readonly variants: readonly string[] }
export type ModelOption = {
  readonly id: string
  readonly providerID: string
  readonly name: string
  readonly enabled: boolean
  readonly status: ModelStatus
  readonly limit: { readonly context: number; readonly output: number }
  readonly variants: readonly string[]
  readonly profiles: readonly ModelProfileOption[]
}
export type ModelSource = { readonly sessionID: string } | { readonly directory?: string }
export type ModelCatalog = { readonly revision: number; readonly models: readonly ModelOption[]; readonly default: ModelSelection | null } & (
  | { readonly source: { readonly sessionID: string }; readonly current: ModelSelection | null; readonly running: boolean }
  | { readonly source: { readonly directory?: string } })
export type ModelSwitch = { readonly sessionID: string; readonly revision: number; readonly model: ModelSelection }
export type DesktopSource = string | { readonly directory?: string }
export type UsageReportQuery = NonNullable<NonNullable<Parameters<YCodingClient["usage"]["dashboard"]>[0]>["daily"]>
export type UsageDashboardInput = { readonly refresh?: boolean; readonly daily?: UsageReportQuery; readonly monthly?: UsageReportQuery; readonly breakdown?: UsageReportQuery }
export type UsageDashboard = { readonly revision: number; readonly dashboard: DisplayValue }
export type IncidentsInput =
  | { readonly kind: "report"; readonly group: "model" | "agent"; readonly from?: number; readonly to?: number; readonly offset?: number; readonly limit?: number }
  | { readonly kind: "recent"; readonly provider: string; readonly model: string; readonly agent?: string; readonly limit?: number }
  | { readonly kind: "guidance"; readonly provider: string; readonly model: string; readonly source?: DesktopSource }
export type IncidentMutationInput = { readonly revision: number; readonly kind: "guidance-clear"; readonly provider: string; readonly model: string; readonly source?: DesktopSource }
export type Incidents = { readonly revision: number; readonly kind: IncidentsInput["kind"]; readonly data: DisplayValue }
export type TelemetryBatch = Parameters<YCodingClient["server"]["telemetry"]["append"]>[0]
export type TelemetryConsentSnapshot = { readonly revision: number; readonly state: Awaited<ReturnType<YCodingClient["server"]["telemetry"]["consent"]["get"]>> }
type IntegrationMethod = Awaited<ReturnType<YCodingClient["integration"]["list"]>>["data"][number]["methods"][number]
export type IntegrationItem = { readonly id: string; readonly name: string; readonly methods: readonly (Exclude<IntegrationMethod, { readonly type: "command" }> | Omit<Extract<IntegrationMethod, { readonly type: "command" }>, "command">)[]; readonly connections: Awaited<ReturnType<YCodingClient["integration"]["list"]>>["data"][number]["connections"] }
export type IntegrationsSnapshot = { readonly revision: number; readonly source: ModelSource; readonly items: readonly IntegrationItem[] }
type IntegrationMutation = { readonly revision: number; readonly source?: DesktopSource }
export type IntegrationMutationInput = IntegrationMutation & (
  | { readonly kind: "connect-key"; readonly integrationID: string; readonly key: string; readonly label?: string }
  | { readonly kind: "oauth-start"; readonly integrationID: string; readonly methodID: string; readonly inputs?: Readonly<Record<string, string>>; readonly label?: string }
  | { readonly kind: "oauth-status" | "oauth-cancel" | "command-status" | "command-cancel"; readonly integrationID: string; readonly attemptID: string }
  | { readonly kind: "oauth-complete"; readonly integrationID: string; readonly attemptID: string; readonly code?: string }
  | { readonly kind: "command-start"; readonly integrationID: string; readonly methodID: string; readonly label?: string }
  | { readonly kind: "wellknown-add"; readonly url: string }
  | { readonly kind: "credential-activate" | "credential-remove"; readonly credentialID: string }
  | { readonly kind: "credential-rename"; readonly credentialID: string; readonly label: string }
  | { readonly kind: "credential-refresh"; readonly credentialID: string })
export type IntegrationAttempt = { readonly kind: "oauth" | "command"; readonly attemptID: string; readonly status: "pending" | "complete" | "failed" | "expired"; readonly url?: string; readonly mode?: "auto" | "code"; readonly manualCode?: boolean; readonly instructions?: string; readonly message?: string; readonly time: { readonly created: number; readonly expires: number } }
export type IntegrationMutationResult = { readonly revision: number; readonly attempt?: IntegrationAttempt; readonly refresh?: { readonly status: "refreshed"; readonly expires: number } | { readonly status: "failed"; readonly message: string } }
export type McpResource = { readonly server: string; readonly name: string; readonly uri?: string; readonly uriTemplate?: string; readonly description?: string; readonly mimeType?: string }
export type McpSnapshot = { readonly revision: number; readonly source: ModelSource; readonly items: ReadonlyArray<{ readonly name: string; readonly status: "connected" | "pending" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"; readonly error?: string; readonly resources: readonly McpResource[] }>; readonly resources: readonly McpResource[]; readonly resourcesNotice?: string }
export type McpMutationInput = { readonly revision: number; readonly source?: DesktopSource; readonly name: string } & (
  | { readonly kind: "connect" | "disconnect" | "remove" }
  | { readonly kind: "add"; readonly config: { readonly type: "local"; readonly command: readonly string[]; readonly cwd?: string; readonly disabled?: boolean } | { readonly type: "remote"; readonly url: string; readonly disabled?: boolean } })
export type SessionManageInput = { readonly revision: number; readonly sessionID: string } & (
  | { readonly kind: "rename"; readonly title: string }
  | { readonly kind: "fork"; readonly messageID?: string }
  | { readonly kind: "archive" | "unarchive" | "delete" | "background" }
  | { readonly kind: "move"; readonly directory: string }
  | { readonly kind: "daybreak"; readonly daybreak: "daybreak_blue" | "daybreak_red" | null }
  | { readonly kind: "cancel-subagent"; readonly childSessionID: string }
  | { readonly kind: "kill-shell"; readonly shellID: string }
  | { readonly kind: "resolve-skill-conflict"; readonly winner: string; readonly loser: string }
  | { readonly kind: "answer-subagent"; readonly childSessionID: string; readonly questionID: string; readonly text: string; readonly data?: DisplayValue })
export type SessionManageResult = { readonly revision: number; readonly sessionID: string; readonly item?: SessionItem }
export type VcsDiffSnapshot = { readonly revision: number; readonly source: ModelSource; readonly mode: "git" | "branch"; readonly branch: Awaited<ReturnType<YCodingClient["vcs"]["branch"]>>["data"]; readonly status: Awaited<ReturnType<YCodingClient["vcs"]["status"]>>["data"]; readonly files: Awaited<ReturnType<YCodingClient["vcs"]["diff"]>>["data"] }
export type SystemInput = { readonly sessionID?: string; readonly directory?: string }
export type DisplayValue = null | string | number | boolean | readonly DisplayValue[] | { readonly [key: string]: DisplayValue }
export type SystemSnapshot = { readonly revision: number; readonly connection: ConnectionState; readonly sessionID?: string; readonly directory?: string; readonly browser?: DisplayValue; readonly browserTabs?: DisplayValue; readonly pairing?: { readonly secret: string; readonly expiresAt: number }; readonly isolatedBrowser?: DisplayValue; readonly isolatedBrowserTabs?: DisplayValue; readonly skills?: DisplayValue; readonly sessionSkills?: DisplayValue; readonly artifacts?: DisplayValue; readonly plugins?: DisplayValue; readonly remote?: DisplayValue; readonly dots?: DisplayValue; readonly server?: { readonly urls: readonly string[] }; readonly configDiagnostics?: DisplayValue; readonly providers?: DisplayValue; readonly references?: DisplayValue; readonly notices: Readonly<Record<string, string>> }
export type SystemManageInput = SystemInput & { readonly revision: number } & (
  | { readonly kind: "browser-start" | "browser-forget" | "isolated-browser-stop" }
  | { readonly kind: "isolated-browser-start"; readonly url: string }
  | { readonly kind: "artifact-enable" | "artifact-disable"; readonly artifact: Omit<Parameters<YCodingClient["projectArtifact"]["artifact"]["enable"]>[0], "location"> }
  | { readonly kind: "remote-set"; readonly enabled: boolean }
  | { readonly kind: "isolated-browser-pause" | "isolated-browser-resume" }
  | { readonly kind: "dots-set"; readonly enabled: boolean; readonly expectedRevision: number }
  | { readonly kind: "dots-attach"; readonly replaceOthers: boolean; readonly expectedTarget?: DotsTarget }
  | { readonly kind: "dots-detach"; readonly expectedTarget?: DotsTarget })
export type SessionSnapshotInput =
  | { readonly sessionID: string; readonly revision?: never; readonly sourceEpoch?: never; readonly before?: never }
  | { readonly sessionID: string; readonly revision: number; readonly sourceEpoch: string; readonly before: string }
export type SessionSnapshot = { readonly revision: number; readonly sessionID: string; readonly sourceEpoch: string; readonly item: SessionItem; readonly messages: Awaited<ReturnType<YCodingClient["session"]["snapshot"]>>["messages"]; readonly watermark: { readonly seq?: number }; readonly before?: string }
export type PendingInput = { readonly id: string; readonly sessionID: string; readonly admittedSeq: number; readonly timeCreated: number } & (
  | { readonly type: "user" | "synthetic"; readonly delivery: "steer" | "queue"; readonly text: string; readonly description?: string; readonly source?: string }
  | { readonly type: "compaction" })
export type PendingInputAction = { readonly sessionID: string; readonly messageID: string }
export type SessionAttachmentInput = { readonly sessionID: string; readonly digest: string }
export type SessionAttachment = { readonly revision: number; readonly sessionID: string; readonly digest: string; readonly mime: string; readonly bytes: number; readonly data: string }
export type PendingInputs = { readonly revision: number; readonly sessionID: string; readonly items: readonly PendingInput[] }
export type SessionTodo = { readonly content: string; readonly status: "pending" | "in_progress" | "completed" | "cancelled"; readonly priority: "high" | "medium" | "low" }
export type SessionInsightsInput = { readonly sessionID: string; readonly taskSessionIDs?: readonly string[] }
export type SessionInsights = { readonly revision: number; readonly sessionID: string; readonly todos?: readonly SessionTodo[]; readonly diagnostics?: DisplayValue; readonly usage?: DisplayValue; readonly taskCosts?: DisplayValue; readonly compactions?: DisplayValue; readonly notices: Readonly<Record<string, string>> }
export type AgentSwitch = { readonly sessionID: string; readonly revision: number; readonly agent: string }
export type SkillActivation = { readonly sessionID: string; readonly revision: number; readonly promptID: string; readonly skill: string }
export type ShellCommandInput = { readonly sessionID: string; readonly revision: number; readonly command: string }
export type EditorContextInput = { readonly sessionID: string; readonly revision: number; readonly promptID: string; readonly text: string }
export type SideChatInput = { readonly parentID: string; readonly sessionID: string; readonly revision: number; readonly model?: ModelSelection; readonly text?: string; readonly promptID?: string }
export type SideChat = { readonly revision: number; readonly item: SessionItem; readonly admitted?: PendingInput }
export type ParentSteerInput = { readonly sessionID: string; readonly revision: number; readonly promptID: string; readonly text: string }
export type MemoryScope = "repository" | "knowledge"
export type PredictionInput = { readonly sessionID: string; readonly memory: readonly MemoryScope[]; readonly hint?: string }
export type Prediction = { readonly revision: number; readonly sessionID: string; readonly result: { readonly status: "suggested"; readonly text: string } | { readonly status: "unavailable" } }
export type PromptGenerateInput = { readonly sessionID: string; readonly mode: "start" | "steer" | "queue" | "goal"; readonly intent: string; readonly memory: readonly MemoryScope[] }
export type GeneratedPrompt = { readonly revision: number; readonly sessionID: string; readonly result: { readonly status: "generated"; readonly text: string } | { readonly status: "unavailable" } }
export type SessionTerminal = Pty.Info
export type SessionTerminals = { readonly revision: number; readonly sessionID: string; readonly items: readonly SessionTerminal[] }
export type SessionTerminalRead = { readonly revision: number; readonly sessionID: string; readonly item: SessionTerminal }
export type TerminalAccess = "inspect" | "control"
export type TerminalSize = { readonly rows: number; readonly cols: number }
export type TerminalConnectInput = { readonly sessionID: string; readonly ptyID: string; readonly generation: number; readonly offset: number; readonly access: TerminalAccess; readonly fence?: number }
export type TerminalStream = { readonly revision: number; readonly streamID: string }
export type TerminalFrames = { readonly frames: readonly string[]; readonly status: "open" | "closed" | "error" }
export type TerminalWriteInput = { readonly streamID: string; readonly data: string }
export type TerminalControlInput = { readonly sessionID: string; readonly ptyID: string; readonly generation: number; readonly expectedFence: number; readonly action: "take" | "pause" | "agent" }
export type TerminalResizeInput = { readonly sessionID: string; readonly ptyID: string; readonly generation: number; readonly expectedFence: number; readonly size: TerminalSize }
export type TranscriptExportInput = { readonly sessionID: string; readonly format: "json" | "markdown"; readonly thinking?: boolean; readonly debug?: boolean }
export type TranscriptExport = { readonly revision: number; readonly sessionID: string; readonly format: "json" | "markdown"; readonly content: string; readonly filename: string; readonly mimeType: "application/json" | "text/markdown" }
export type SavedExport = { readonly saved: boolean; readonly path?: string }
export type ArtifactScope = "project" | "global"
export type ArtifactKind = "skill" | "command" | "agent" | "plugin"
export type ArtifactStage = "trial" | "active" | "degraded" | "disabled" | "quarantine"
export type ArtifactsInput = { readonly source?: DesktopSource; readonly scope: ArtifactScope | "trash"; readonly stage?: ArtifactStage }
export type ArtifactsSnapshot = { readonly revision: number; readonly source: ModelSource; readonly scope: ArtifactScope | "trash"; readonly items: readonly DisplayValue[] }
export type ArtifactInput = { readonly source?: DesktopSource; readonly scope: ArtifactScope; readonly kind: ArtifactKind; readonly id: string }
export type ArtifactIdentity = { readonly scope: ArtifactScope; readonly kind: ArtifactKind; readonly id: string; readonly expectedRevision: number; readonly expectedVersionID: string; readonly expectedDigest: string }
export type ArtifactDetail = { readonly revision: number; readonly source: ModelSource; readonly identity: ArtifactIdentity; readonly stage: ArtifactStage; readonly versionIDs: readonly string[]; readonly details: DisplayValue; readonly metrics: DisplayValue }
export type ArtifactPreviewKind = "promotion" | "fork" | "shadow"
export type ArtifactMutationInput = { readonly revision: number; readonly source?: DesktopSource } & (
  | { readonly kind: "revert"; readonly artifact: ArtifactIdentity; readonly targetVersionID: string }
  | { readonly kind: "remove"; readonly artifact: ArtifactIdentity }
  | { readonly kind: "preview"; readonly preview: ArtifactPreviewKind; readonly artifact: ArtifactIdentity }
  | { readonly kind: "confirm"; readonly preview: ArtifactPreviewKind; readonly artifact: ArtifactIdentity; readonly token: string }
  | { readonly kind: "restore"; readonly deletionID: string })
export type ArtifactMutationResult = { readonly revision: number; readonly preview?: { readonly kind: ArtifactPreviewKind; readonly token: string; readonly expiresAt: number; readonly confirmable: boolean; readonly details: DisplayValue }; readonly result?: DisplayValue }
export type DotsTarget = { readonly dotID: string; readonly threadID: string; readonly environmentID: string; readonly revision: string }
export type DesktopMenuAction = "check-for-updates" | "open-settings" | "new-chat"
export type ClipboardContent = {
  readonly text: string | null
  readonly imageBase64?: string | null
  readonly formats: readonly string[]
}
export type UpdateCheckResult = {
  readonly currentVersion: string
  readonly latestVersion: string
  readonly updateAvailable: boolean
  readonly releaseUrl: string
  readonly publishedAt: string
  readonly releaseNotes: string
  readonly canInstall: boolean
  readonly cannotInstallReason?: string
}
export type UpdateInstallResult = {
  readonly installedVersion: string
  readonly relaunching: boolean
}

const CLIPBOARD_TEXT_LIMIT = 10 * 1024 * 1024
const UPDATE_VERSION_LIMIT = 128

export function validateClipboardWrite(value: unknown): { readonly text: string } {
  if (typeof value !== "object" || value === null || Object.keys(value).some((key) => key !== "text") || !("text" in value) || typeof value.text !== "string" || value.text.length > CLIPBOARD_TEXT_LIMIT || utf8Length(value.text) > CLIPBOARD_TEXT_LIMIT)
    throw new DesktopError("Clipboard text must be a string up to 10 MiB.")
  return { text: value.text }
}

export function validateInstallUpdateInput(value: unknown): { readonly version?: string } {
  const invalid = () => new DesktopError("Choose a valid update version.")
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Object.keys(value).some((key) => key !== "version")) throw invalid()
  const version = "version" in value ? value.version : undefined
  if (version === undefined) return {}
  if (typeof version !== "string" || !version.trim() || version.length > UPDATE_VERSION_LIMIT || version.includes("\0")) throw invalid()
  return { version }
}

export type AttentionNotification = { readonly kind: "request" | "complete" | "failure"; readonly silent: boolean }

type InteractionOwner = { readonly sessionID: string; readonly revision: number }
type InteractionFence = InteractionOwner & { readonly generation: string }

export type DesktopAPI = {
  readonly notify: (input: AttentionNotification) => Promise<void>
  readonly quit: () => Promise<void>
  readonly readClipboard: () => Promise<ClipboardContent>
  readonly writeClipboard: (input: { readonly text: string }) => Promise<void>
  readonly checkForUpdates: () => Promise<UpdateCheckResult>
  readonly installUpdate: (input?: { readonly version?: string }) => Promise<UpdateInstallResult>
  readonly onMenuAction: (listen: (action: DesktopMenuAction) => void) => () => void
  readonly browseDirectory: (input?: BrowseDirectoryInput) => Promise<DirectoryListing>
  readonly openDirectory: (input: { readonly directory: string }) => Promise<OpenedDirectory>
  readonly createDirectory: (input: { readonly parentDirectory: string; readonly name: string }) => Promise<OpenedDirectory>
  readonly pickDirectory: (input?: { readonly startingFolder?: string }) => Promise<{ readonly directory: string | null }>
  readonly openExternalUrl: (input: { readonly url: string }) => Promise<{ readonly opened: boolean }>
  readonly integrations: (source?: DesktopSource) => Promise<IntegrationsSnapshot>
  readonly manageIntegration: (input: IntegrationMutationInput) => Promise<IntegrationMutationResult>
  readonly mcpServers: (source?: DesktopSource) => Promise<McpSnapshot>
  readonly manageMcp: (input: McpMutationInput) => Promise<McpSnapshot>
  readonly manageSession: (input: SessionManageInput) => Promise<SessionManageResult>
  readonly vcsDiff: (input: { readonly source?: DesktopSource; readonly mode: "git" | "branch" }) => Promise<VcsDiffSnapshot>
  readonly systemSnapshot: (input?: SystemInput) => Promise<SystemSnapshot>
  readonly manageSystem: (input: SystemManageInput) => Promise<SystemSnapshot>
  readonly interactionStatus: (input: InteractionOwner) => Promise<InteractionStatus>
  readonly interactionPreview: (input: InteractionFence) => Promise<InteractionPreview>
  readonly interactionStop: (input: InteractionFence) => Promise<void>
  readonly interactionResume: (input: InteractionFence) => Promise<void>
  readonly interactionRequest: (input: InteractionOwner & { readonly payload: SessionInteractionRequestInput["payload"] }) => Promise<void>
  readonly preferences: () => Promise<Preferences>
  readonly state: () => Promise<ConnectionState>
  readonly connect: (selection: Selection) => Promise<ConnectionState>
  readonly disconnect: () => Promise<void>
  readonly restartBackend: (input: { readonly revision: number }) => Promise<ConnectionState>
  readonly editorSelection: (input: { readonly directory: string; readonly revision: number }) => Promise<import("./editor-integration").EditorSnapshot>
  readonly editDraft: (input: { readonly text: string; readonly directory: string }) => Promise<import("./editor-integration").DraftEditorResult>
  readonly sessions: (query: SessionsQuery) => Promise<Sessions>
  readonly session: (input: { readonly sessionID: string }) => Promise<SessionRead>
  readonly autonomy: (sessionID: string) => Promise<SessionAutonomySnapshot>
  readonly setAutonomy: (input: SetAutonomyInput) => Promise<SessionAutonomySnapshot>
  readonly fileChanges: (sessionID: string) => Promise<SessionFileChanges>
  readonly activity: (input: ActivityInput) => Promise<SessionActivity>
  readonly shellOutput: (input: ShellOutputInput) => Promise<ShellOutput>
  readonly projects: (input?: PageInput) => Promise<ProjectsSnapshot>
  readonly workspaceDirectories: (input: WorkspaceDirectoriesInput) => Promise<WorkspaceDirectories>
  readonly settings: () => Promise<SettingsSnapshot>
  readonly changeSettings: (input: SettingsMutationInput) => Promise<SettingsSnapshot>
  readonly changeProject: (input: ProjectMutationInput) => Promise<ProjectsSnapshot>
  readonly changeWorkspace: (input: WorkspaceMutationInput) => Promise<WorkspaceDirectories | null>
  readonly usage: (input?: { readonly range?: UsageRange }) => Promise<UsageSnapshot>
  readonly usageDashboard: (input?: UsageDashboardInput) => Promise<UsageDashboard>
  readonly incidents: (input: IncidentsInput) => Promise<Incidents>
  readonly manageIncident: (input: IncidentMutationInput) => Promise<Incidents>
  readonly appendTelemetry: (input: TelemetryBatch) => Promise<{ readonly accepted: number }>
  readonly telemetryConsent: () => Promise<TelemetryConsentSnapshot>
  readonly revert: (input: RevertInput) => Promise<Awaited<ReturnType<YCodingClient["session"]["revert"]["stage"]>> | null>
  readonly pin: (request: PinRequest) => Promise<void>
  readonly workspaces: () => Promise<readonly Workspace[]>
  readonly messages: (sessionID: string) => Promise<Messages>
  readonly createSession: (input: NewSession) => Promise<Session>
  readonly prompt: (input: Prompt) => Promise<Admission>
  readonly command: (input: ComposerCommandInput) => Promise<Admission>
  readonly compact: (input: CompactInput) => Promise<CompactResult>
  readonly composerCatalog: (source?: string | { readonly directory?: string }) => Promise<ComposerCatalog>
  readonly findFiles: (input: FindFilesInput) => Promise<FileMatches>
  readonly interrupt: (sessionID: string) => Promise<void>
  readonly requests: (input: string | GlobalRequestsInput) => Promise<PendingRequests>
  readonly reply: (input: RequestReply) => Promise<void>
  readonly models: (source?: string | { readonly directory?: string }) => Promise<ModelCatalog>
  readonly switchModel: (input: ModelSwitch) => Promise<void>
  readonly sessionSnapshot: (input: SessionSnapshotInput) => Promise<SessionSnapshot>
  readonly pendingInputs: (sessionID: string) => Promise<PendingInputs>
  readonly removePending: (input: PendingInputAction) => Promise<void>
  readonly steerPending: (input: PendingInputAction) => Promise<void>
  readonly sessionAttachment: (input: SessionAttachmentInput) => Promise<SessionAttachment>
  readonly sessionInsights: (input: SessionInsightsInput) => Promise<SessionInsights>
  readonly switchAgent: (input: AgentSwitch) => Promise<void>
  readonly activateSkill: (input: SkillActivation) => Promise<void>
  readonly runShell: (input: ShellCommandInput) => Promise<void>
  readonly sendEditorContext: (input: EditorContextInput) => Promise<PendingInput>
  readonly openSideChat: (input: SideChatInput) => Promise<SideChat>
  readonly steerParent: (input: ParentSteerInput) => Promise<PendingInput>
  readonly prediction: (input: PredictionInput) => Promise<Prediction>
  readonly promptGenerate: (input: PromptGenerateInput) => Promise<GeneratedPrompt>
  readonly terminals: (input: { readonly sessionID: string }) => Promise<SessionTerminals>
  readonly terminal: (input: { readonly sessionID: string; readonly ptyID: string }) => Promise<SessionTerminalRead>
  readonly terminalConnect: (input: TerminalConnectInput) => Promise<TerminalStream>
  readonly terminalRead: (input: { readonly streamID: string }) => Promise<TerminalFrames>
  readonly terminalWrite: (input: TerminalWriteInput) => Promise<void>
  readonly terminalClose: (input: { readonly streamID: string }) => Promise<void>
  readonly terminalControl: (input: TerminalControlInput) => Promise<SessionTerminalRead>
  readonly terminalResize: (input: TerminalResizeInput) => Promise<SessionTerminalRead>
  readonly exportSession: (input: TranscriptExportInput) => Promise<TranscriptExport>
  readonly saveExportSession: (input: TranscriptExportInput) => Promise<SavedExport>
  readonly artifacts: (input: ArtifactsInput) => Promise<ArtifactsSnapshot>
  readonly artifact: (input: ArtifactInput) => Promise<ArtifactDetail>
  readonly manageArtifact: (input: ArtifactMutationInput) => Promise<ArtifactMutationResult>
  readonly onState: (listen: (state: ConnectionState) => void) => () => void
  readonly onEvent: (listen: (event: YCodingEvent) => void) => () => void
  readonly onResync: (listen: () => void) => () => void
}
