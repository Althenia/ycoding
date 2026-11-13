import type { YCodingClient, YCodingEvent } from "@ycoding-ai/client"

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
  readonly location: { readonly directory: string }
  readonly time: { readonly updated: number; readonly active?: number; readonly archived?: number; readonly pinned?: number }
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string }
  readonly revert?: { readonly messageID: string; readonly files?: ReadonlyArray<{ readonly file: string; readonly status?: "added" | "deleted" | "modified"; readonly additions: number; readonly deletions: number }> }
  readonly tokens: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } }
  readonly cost: number
}
export type Sessions = { readonly revision: number; readonly items: readonly SessionItem[]; readonly next?: string }
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
export type ShellOutput = { readonly revision: number; readonly sessionID: string; readonly shellID: string; readonly output: string; readonly cursor: number; readonly size: number; readonly truncated: boolean }
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
export type NewSession = { readonly directory?: string; readonly sessionID: string }
export type PromptMention = { readonly start: number; readonly end: number; readonly text: string }
export type PromptFile = { readonly uri: string; readonly name?: string; readonly description?: string; readonly mention?: PromptMention }
export type PromptAgent = { readonly name: string; readonly mention?: PromptMention }
export type Prompt = { readonly sessionID: string; readonly promptID: string; readonly text: string; readonly files?: readonly PromptFile[]; readonly agents?: readonly PromptAgent[] }
export type ComposerCommandInput = { readonly sessionID: string; readonly promptID: string; readonly command: string; readonly arguments?: string }
export type CompactInput = { readonly sessionID: string; readonly promptID: string }
export type CompactResult = Awaited<ReturnType<YCodingClient["session"]["compact"]>>
export type ComposerCatalog = {
  readonly revision: number
  readonly source: ModelSource
  readonly commands: readonly { readonly name: string; readonly description?: string }[]
  readonly skills: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
  readonly agents: readonly { readonly name: string; readonly description?: string }[]
  readonly errors: { readonly commands?: string; readonly skills?: string; readonly agents?: string }
}
export type FindFilesInput = { readonly source?: string | { readonly directory?: string }; readonly query: string }
export type FileMatches = { readonly revision: number; readonly source: ModelSource; readonly entries: readonly { readonly path: string; readonly type: "file" | "directory" }[] }
export type Admission = Awaited<ReturnType<YCodingClient["session"]["prompt"]>>
export type PermissionRequest = Awaited<ReturnType<YCodingClient["permission"]["list"]>>[number]
export type FormRequest = Awaited<ReturnType<YCodingClient["form"]["list"]>>[number]
export type PermissionDecision = Parameters<YCodingClient["permission"]["reply"]>[0]["reply"]
export type FormAnswer = Parameters<YCodingClient["form"]["reply"]>[0]["answer"]
export type PendingRequests = {
  readonly sessionID: string
  readonly revision: number
  readonly permissions: readonly PermissionRequest[]
  readonly forms: readonly FormRequest[]
  readonly guardrails?: ReadonlyArray<Omit<Awaited<ReturnType<YCodingClient["guardrail"]["request"]["list"]>>[number], "metadata">>
  readonly reviews?: Awaited<ReturnType<YCodingClient["review"]["list"]>>
}
export type RequestReply =
  | { readonly kind: "guardrail"; readonly sessionID: string; readonly revision: number; readonly requestID: string; readonly reply: Parameters<YCodingClient["guardrail"]["request"]["reply"]>[0]["reply"] }
  | { readonly kind: "review"; readonly sessionID: string; readonly revision: number; readonly itemID: string; readonly decision: Parameters<YCodingClient["review"]["decide"]>[0]["decision"] }
  | { readonly kind: "permission"; readonly sessionID: string; readonly revision: number; readonly requestID: string; readonly reply: PermissionDecision; readonly message?: string }
  | { readonly kind: "form"; readonly sessionID: string; readonly revision: number; readonly formID: string; readonly answer: FormAnswer }
  | { readonly kind: "form-cancel"; readonly sessionID: string; readonly revision: number; readonly formID: string }
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
  | { readonly kind: "credential-rename"; readonly credentialID: string; readonly label: string })
export type IntegrationAttempt = { readonly kind: "oauth" | "command"; readonly attemptID: string; readonly status: "pending" | "complete" | "failed" | "expired"; readonly url?: string; readonly mode?: "auto" | "code"; readonly manualCode?: boolean; readonly instructions?: string; readonly message?: string; readonly time: { readonly created: number; readonly expires: number } }
export type IntegrationMutationResult = { readonly revision: number; readonly attempt?: IntegrationAttempt }
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
  | { readonly kind: "resolve-skill-conflict"; readonly winner: string; readonly loser: string })
export type SessionManageResult = { readonly revision: number; readonly sessionID: string; readonly item?: SessionItem }
export type VcsDiffSnapshot = { readonly revision: number; readonly source: ModelSource; readonly mode: "git" | "branch"; readonly branch: Awaited<ReturnType<YCodingClient["vcs"]["branch"]>>["data"]; readonly status: Awaited<ReturnType<YCodingClient["vcs"]["status"]>>["data"]; readonly files: Awaited<ReturnType<YCodingClient["vcs"]["diff"]>>["data"] }
export type SystemInput = { readonly sessionID?: string; readonly directory?: string }
export type DisplayValue = null | string | number | boolean | readonly DisplayValue[] | { readonly [key: string]: DisplayValue }
export type SystemSnapshot = { readonly revision: number; readonly connection: ConnectionState; readonly sessionID?: string; readonly directory?: string; readonly browser?: DisplayValue; readonly browserTabs?: DisplayValue; readonly pairing?: { readonly secret: string; readonly expiresAt: number }; readonly isolatedBrowser?: DisplayValue; readonly isolatedBrowserTabs?: DisplayValue; readonly skills?: DisplayValue; readonly sessionSkills?: DisplayValue; readonly artifacts?: DisplayValue; readonly plugins?: DisplayValue; readonly remote?: DisplayValue; readonly dots?: DisplayValue; readonly server?: { readonly urls: readonly string[] }; readonly notices: Readonly<Record<string, string>> }
export type SystemManageInput = SystemInput & { readonly revision: number } & (
  | { readonly kind: "browser-start" | "browser-forget" | "isolated-browser-stop" }
  | { readonly kind: "isolated-browser-start"; readonly url: string }
  | { readonly kind: "artifact-enable" | "artifact-disable"; readonly artifact: Omit<Parameters<YCodingClient["projectArtifact"]["artifact"]["enable"]>[0], "location"> }
  | { readonly kind: "plugin-activate" | "plugin-deactivate"; readonly id: string }
  | { readonly kind: "plugin-add"; readonly spec: string }
  | { readonly kind: "remote-set"; readonly enabled: boolean })
export type DesktopAPI = {
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
  readonly preferences: () => Promise<Preferences>
  readonly state: () => Promise<ConnectionState>
  readonly connect: (selection: Selection) => Promise<ConnectionState>
  readonly disconnect: () => Promise<void>
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
  readonly requests: (sessionID: string) => Promise<PendingRequests>
  readonly reply: (input: RequestReply) => Promise<void>
  readonly models: (source?: string | { readonly directory?: string }) => Promise<ModelCatalog>
  readonly switchModel: (input: ModelSwitch) => Promise<void>
  readonly onState: (listen: (state: ConnectionState) => void) => () => void
  readonly onEvent: (listen: (event: YCodingEvent) => void) => () => void
  readonly onResync: (listen: () => void) => () => void
}
