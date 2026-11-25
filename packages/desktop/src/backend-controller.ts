import { spawn, execFile } from "node:child_process"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { capturedPartPatches } from "@ycoding-ai/client/file-change-summary"
import { Service, type Endpoint } from "@ycoding-ai/client/service"
import { isSessionDirectoryPath } from "../../remote/src/session-directory"
import { interactionGeneration } from "../../../apps/web/src/remote/interaction-control"
import { chromeInteractionURL } from "./interaction-request"
import { BackendRestart, type RestartPorts } from "./restart"
import { DesktopEditor, openDesktopEditor, type DraftEditorResult } from "./editor-integration"
import type { YCodingEvent } from "@ycoding-ai/client"
import { Coordination, Form, Integration, Interaction, KeepAwake, PermissionSaved, Project, ProjectCopy, Pty, Schema, Telemetry } from "@ycoding-ai/client/effect"
import { terminalConnectInput, terminalControlInput, terminalResizeInput, terminalStreamInput, terminalWriteInput, agentSwitchInput, globalRequestsInput, usageDashboardInput, incidentsInput, incidentMutationInput, answerData, artifactInput, artifactMutationInput, artifactsInput, dotsTarget, editorInput, exportFilename, exportInput, insightsInput, pendingInput, predictionInput, promptGenerateInput, sameIdentity, sameTarget, sessionMarkdown, shellInput, sideChatContext, sideChatInput, skillInput, snapshotInput, steerInput, terminalInput, todoItems } from "./capabilities"
import { currentModel, modelSelection, modelSource, openedModelLocation, projectDefault, projectModels, running, sameModelLocation, sessionModelLocation, switchRequest, type ModelLocation } from "./models"
import { connectNative } from "./native-client"
import { TerminalRelay, terminalSocketUrl, type TerminalSocketFactory } from "./terminal-relay"
import { validateSelection } from "./preferences"
import { questionAnswerError } from "./question-rules"
import { composerByteLimit, composerFileLimit, inlineFileSize } from "./composer-files"
import { activityInput, attachmentRead, directoriesInput, pendingAction, isRevision, pageInput, requestReply, revertInput, session, setAutonomyInput, shellOutputInput, usageInput } from "./requests"
import { bundledBackend } from "./resources"
import { describeError, redactSecrets } from "./app-log"
import { pinRequest, projectSessionRecord, projectSessions, sessionsQuery, sessionTarget } from "./sessions"
import { DesktopError, utf8Length, type SessionAttachment, type ConnectionState, type Selection, type SessionFileChanges, type DirectoryListing, type OpenedDirectory, type IntegrationsSnapshot, type IntegrationMutationInput, type IntegrationMutationResult, type IntegrationAttempt, type McpResource, type McpMutationInput, type McpSnapshot, type SessionManageInput, type SessionManageResult, type VcsDiffSnapshot, type SystemInput, type SystemManageInput, type SystemSnapshot, type DisplayValue, type RequestReply, type SessionSnapshot, type PendingInput, type PendingInputs, type SessionInsights, type SideChat, type Prediction, type GeneratedPrompt, type SessionTerminals, type SessionTerminalRead, type TerminalFrames, type TerminalStream, type TranscriptExport, type ArtifactScope, type ArtifactKind, type ArtifactStage, type ArtifactIdentity, type ArtifactsSnapshot, type ArtifactDetail, type ArtifactMutationResult, type ArtifactPreviewKind, type DotsTarget, type Admission, type PendingRequests, type UsageDashboard, type Incidents, type ShellSummary, type ModelSelection, type TelemetryConsentSnapshot } from "./contract"

type Native = Awaited<ReturnType<typeof connectNative>>
type Control = ReturnType<typeof openControl>
type Attempt = { readonly generation: number; readonly abort: AbortController; readonly mode: Selection["mode"]; readonly selection: Selection; revision: number; control?: Control; native?: Native; pending?: Promise<ConnectionState>; cleanup?: Promise<void>; retirement?: Promise<void>; confirmed?: boolean; reported?: boolean; steers?: Map<string, Steer>; endpoint?: Endpoint }
type Steer = { readonly key: string; readonly revision: number; admitted: boolean; interrupt: "unsent" | "sent" | "confirmed"; receipt?: Admission; pending?: Promise<Admission> }
type Pages = { readonly revision: number; readonly cursors: string[] }
type Launch = (command: readonly [string, ...string[]]) => readonly [string, ...string[]]
type Options = {
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly fetch?: typeof globalThis.fetch
  readonly socket?: Parameters<typeof connectNative>[1]["socket"]
  readonly launch?: Launch
  readonly onEvent?: (event: YCodingEvent) => void | Promise<void>
  readonly onState?: (state: ConnectionState) => void
  readonly log?: (line: string) => void
  readonly terminalSocket?: TerminalSocketFactory
  readonly editor?: Pick<DesktopEditor, "read" | "close">
  readonly openEditor?: (input: { text: string; directory: string }) => Promise<DraftEditorResult>
  readonly restartService?: RestartPorts["service"]
}

const direct: Launch = (command) => command
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])
const isLoopbackSelection = (server: string) => URL.canParse(server) && loopbackHosts.has(new URL(server).hostname)
const unsent = "The backend connection changed before the answer was sent. Refresh requests and answer again."
const unswitched = "The backend connection changed before the model was switched. Refresh models and choose again."
const stopFirst = "Stop the running chat before switching models."
const unpaged = "The backend connection changed before more Sessions were read. Refresh Sessions."
const TELEMETRY_READ_MS = 5_000
const TELEMETRY_WRITE_MS = 20_000
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value)
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
const optional = (value: unknown, check: (input: unknown) => boolean) => value === undefined || check(value)
const literal = (value: unknown, choices: readonly string[]) => typeof value === "string" && choices.includes(value)
const string = (value: unknown) => typeof value === "string"
const boolean = (value: unknown) => typeof value === "boolean"
const decodeKeepAwake = Schema.decodeUnknownSync(Schema.toCodecJson(KeepAwake.Status))
const decodeInteractionRequest = Schema.decodeUnknownOption(Interaction.Request, { onExcessProperty: "error" })
const decodeConsent = Schema.decodeUnknownSync(Schema.toCodecJson(Telemetry.Consent))
const decodeConsentState = Schema.decodeUnknownSync(Schema.toCodecJson(Telemetry.ConsentState))
const decodeSamples = Schema.decodeUnknownSync(Schema.toCodecJson(Telemetry.Page))
const decodeBatch = Schema.decodeUnknownSync(Telemetry.Batch)
const decodePermissions = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(PermissionSaved.Info)))
const decodePermissionID = Schema.decodeUnknownSync(Schema.toCodecJson(PermissionSaved.ID))
const decodeGroup = Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.Info))
const decodeGroupID = Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.GroupID))
const decodeCreate = Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.CreateInput))
const decodeUpdate = Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.UpdateInput))
const decodeProjectID = Schema.decodeUnknownSync(Schema.toCodecJson(Project.ID))
const decodeCopyInput = Schema.decodeUnknownSync(Schema.toCodecJson(ProjectCopy.CreateInput))
const decodeCopy = Schema.decodeUnknownSync(Schema.toCodecJson(ProjectCopy.Copy))
const decodeIntegration = Schema.decodeUnknownSync(Schema.toCodecJson(Integration.Info))
const decodeFormAnswer = Schema.decodeUnknownSync(Schema.toCodecJson(Form.Answer))
const decodeFormFields = Schema.decodeUnknownSync(Schema.toCodecJson(Form.Fields))
const decodeProjectName = Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.CreateInput.fields.name))
const decodeProjectMembers = Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.CreateInput.fields.memberSessionIDs))
const decodePtyInfo = Schema.decodeUnknownSync(Schema.toCodecJson(Pty.Info))
const decodePty = (value: unknown) => decodePtyInfo(value)
const optionalPty = (value: unknown) => { try { return [decodePtyInfo(value)] } catch { return [] } }
const boundedText = (value: unknown, limit: number) => typeof value === "string" && value.length <= limit && utf8Length(value) <= limit
const nonempty = (value: unknown) => typeof value === "string" && value.length > 0
const limited = (value: unknown, limit: number) => typeof value === "string" && value.length > 0 && value.length <= limit
const prefix = (value: unknown, start: string) => typeof value === "string" && value.startsWith(start)
const sessionID = (value: unknown) => prefix(value, "ses")
const modelID = string
const groupID = (value: unknown) => prefix(value, "cgrp_") && typeof value === "string" && value.length > 5 && value.length <= 96
const ref = (value: unknown) => object(value) && modelID(value.id) && string(value.providerID) && optional(value.variant, string) && optional(value.profile, nonempty)
const autonomyDecision = (value: unknown) => literal(value, ["manual", "auto", "yolo"])
const autonomyValid = (value: unknown) => object(value) && value.mode === "normal" && autonomyDecision(value.permissions) && autonomyDecision(value.guardrails) && autonomyDecision(value.answers) &&
  (value.goal === undefined || value.goal === null || (object(value.goal) && string(value.goal.text) && literal(value.goal.status, ["active", "completed", "stopped", "exhausted"]) && count(value.goal.iteration) && count(value.goal.noProgress) && count(value.goal.maxNoProgress) && value.goal.maxNoProgress > 0 && (value.goal.lastProgressDigest === null || optional(value.goal.lastProgressDigest, string)))) &&
  (value.defer === undefined || value.defer === null || object(value.defer)) && object(value.effective) && autonomyDecision(value.effective.permissions) && autonomyDecision(value.effective.guardrails) && autonomyDecision(value.effective.answers) && boolean(value.effective.deferred) && boolean(value.effective.guardrailsEnabled) && object(value.effective.inherited) && [value.effective.inherited.permissions, value.effective.inherited.guardrails, value.effective.inherited.answers].every((item) => item === null || optional(item, sessionID))
const fields = <T extends object>(value: T, keys: readonly string[]): T => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, Reflect.get(value, key)])) as T
const cursor = (value: unknown) => value === undefined || (object(value) && (value.next === undefined || value.next === null || (typeof value.next === "string" && value.next.length > 0 && utf8Length(value.next) <= 4096)))
const times = (value: unknown) => object(value) && count(value.created) && count(value.updated)
const tokens = (value: unknown) => object(value) && finite(value.input) && finite(value.output) && finite(value.reasoning) && object(value.cache) && finite(value.cache.read) && finite(value.cache.write)
const kinds = ["question", "permission", "review"] as const
const decisions = (value: unknown) => object(value) && Array.isArray(value.categories) && value.categories.length <= 3 && value.categories.every((kind) => literal(kind, kinds)) &&
  optional(value.actions, (items) => Array.isArray(items) && items.length <= 32 && items.every((item) => limited(item, 512))) && optional(value.resources, (items) => Array.isArray(items) && items.length <= 32 && items.every((item) => limited(item, 512))) && optional(value.expiresAt, count)
const groupSettings = (value: unknown) => object(value) && (value.concurrency === null || (count(value.concurrency) && value.concurrency > 0)) && optional(value.delegatedDecisions, decisions)
const pending = (value: unknown) => object(value) && literal(value.kind, kinds) && limited(value.requestID, 256) && limited(value.fingerprint, 256) && typeof value.summary === "string" && value.summary.length <= 500
const participantRef = (value: unknown) => object(value) && sessionID(value.sessionID) && string(value.title)
const participant = (value: unknown) => object(value) && sessionID(value.sessionID) && string(value.title) && object(value.location) && string(value.location.directory) && optional(value.location.workspaceID, (workspace) => prefix(workspace, "wrk")) && literal(value.state, ["idle", "running", "waiting", "failed"]) && count(value.lastActivity) && Array.isArray(value.pending) && value.pending.length <= 50 && value.pending.every(pending) && optional(value.drivenBy, participantRef) && optional(value.owner, participantRef)
const money = finite
const provenance = (value: unknown) => literal(value, ["recorded", "current_catalog"])
const coverage = (value: unknown) => object(value) && count(value.pricedRequests) && count(value.unpricedRequests)
const outcomes = (value: unknown) => object(value) && count(value.completed) && count(value.failed) && count(value.cancelled)
const metrics = (value: unknown) => object(value) && count(value.logical) && count(value.physical) && count(value.helpers) && count(value.continued) && count(value.fallback) && tokens(value.tokens) && optional(value.cost, money) && optional(value.cacheReadReported, boolean)
const reportMetrics = (value: unknown) => metrics(value) && object(value) && optional(value.costCoverage, coverage) && optional(value.costProvenance, provenance) && ((value.cost === undefined) === (value.costProvenance === undefined)) && optional(value.outcomes, outcomes)
const spend = (value: unknown) => object(value) && ref(value.model) && count(value.requests) && tokens(value.tokens) && optional(value.cacheReadReported, boolean) && optional(value.cost, money) && optional(value.costProvenance, provenance) && ((value.cost === undefined) === (value.costProvenance === undefined))
const timingKeys = ["firstOutputMs", "totalMs", "retryWaitMs", "promptEvalDurationNs", "generationDurationNs", "observedGenerationDurationNs", "generatedTokens", "estimatedTokens", "estimatedGenerationDurationNs", "loadDurationNs"] as const
const positiveTimingKeys = ["observedGenerationDurationNs", "generatedTokens", "estimatedTokens", "estimatedGenerationDurationNs"] as const
const speedCounts = ["generationSamples", "providerTimedSamples", "observedSamples", "samples"] as const
const speedValues = ["generationP50TokensPerSecond", "generationP90TokensPerSecond", "generationP95TokensPerSecond", "meanTokensPerSecond", "firstOutputP50Ms", "firstOutputP95Ms", "firstOutputP99Ms", "totalP50Ms", "totalP95Ms", "totalP99Ms", "outputTokensPerSecond"] as const
const speedTimes = ["firstOutputP50Ms", "firstOutputP95Ms", "firstOutputP99Ms", "totalP50Ms", "totalP95Ms", "totalP99Ms"] as const
const timing = (value: unknown) => object(value) && timingKeys.every((key) => optional(value[key], count)) && positiveTimingKeys.every((key) => optional(value[key], (item) => count(item) && item > 0)) && optional(value.receivedOutput, (item) => object(item) && count(item.estimatedTokens) && item.estimatedTokens > 0 && count(item.durationNs) && item.durationNs > 0)
const speed = (value: unknown) => object(value) && speedCounts.every((key) => count(value[key])) && speedValues.every((key) => optional(value[key], amount)) && speedTimes.every((key) => optional(value[key], count))
const dimensions = (value: unknown) => {
  if (!object(value) || typeof value.group !== "string") return false
  if (value.group === "provider") return string(value.providerID)
  if (value.group === "provider-model") return string(value.providerID) && modelID(value.modelID)
  if (value.group === "model-id") return modelID(value.modelID)
  if (value.group === "profile" || value.group === "provider-profile-model") return string(value.providerID) && (value.group === "profile" || modelID(value.modelID)) && literal(value.profileState, ["recorded", "provider-default"]) && (value.profileState === "recorded" ? nonempty(value.profile) : value.profile === undefined)
  if (value.group === "task") return optional(value.sessionID, sessionID) && literal(value.attribution, ["complete", "partial", "unattributed"])
  if (value.group === "prompt") return optional(value.anchor, (anchor) => object(anchor) && sessionID(anchor.sessionID) && prefix(anchor.inputID, "msg_")) && literal(value.attribution, ["complete", "partial", "unattributed"])
  return false
}
const summaryValid = (value: unknown) => metrics(value) && object(value) && optional(value.models, (items) => Array.isArray(items) && items.every(spend)) && optional(value.latestNamespace, (item) => typeof item === "string" && item.length === 8) && optional(value.latestTiming, timing) && optional(value.latestInvalidation, (item) => literal(item, ["first-request", "compaction-reset", "model-switched", "model-variant-switched", "stable-hit", "prefix-changed", "system-prefix-changed", "tool-prefix-changed", "below-minimum", "provider-not-reported", "cache-disabled", "retry-fallback"]))
const jsonData = (value: unknown) => { const encoded = JSON.stringify(value); return encoded !== undefined && utf8Length(encoded) <= 8192 }
const taskValid = (task: unknown, parentID: string) => object(task) && sessionID(task.sessionID) && task.parentID === parentID && boundedText(task.description, 4096) && string(task.agent) && ref(task.model) && boolean(task.background) && literal(task.state, ["starting", "running", "waiting", "supervising", "cancelling", "cancelled", "completed", "failed", "lost"]) && count(task.revision) && times(task.time) && optional(task.pinnedAt, count) && optional(task.progress, (value) => object(value) && boundedText(value.text, 4096) && count(value.time)) && optional(task.question, (value) => object(value) && prefix(value.id, "qst_") && boundedText(value.text, 8192) && optional(value.data, jsonData) && count(value.time) && optional(value.deferred, boolean)) && optional(task.stoppedRecovery, (value) => object(value) && prefix(value.itemID, "rvw_"))
const shellValid = (shell: unknown) => object(shell) && prefix(shell.id, "sh_") && literal(shell.status, ["running", "exited", "timeout", "memory-limit", "killed"]) && string(shell.command) && string(shell.cwd) && string(shell.shell) && string(shell.file) && object(shell.time) && money(shell.time.started) && optional(shell.time.completed, money) && optional(shell.pid, count) && optional(shell.exit, money) && optional(shell.toolCallID, nonempty) && optional(shell.metadata, object)
const quotaWindow = (value: unknown) => object(value) && nonempty(value.id) && nonempty(value.label) && optional(value.group, nonempty) && literal(value.unit, ["percent", "usd", "requests", "tokens", "count"]) && optional(value.used, amount) && optional(value.limit, amount) && optional(value.remaining, amount) && optional(value.unlimited, boolean) && optional(value.resetAt, count) && optional(value.periodSeconds, count)
const quota = (value: unknown) => object(value) && string(value.providerID) && nonempty(value.label) && optional(value.profile, nonempty) && literal(value.status, ["available", "stale", "unsupported", "unauthorized", "error"]) && literal(value.source, ["provider_api", "local_client_rpc", "response_headers", "response_stream", "provider_internal_api", "local_session"]) && literal(value.stability, ["stable", "client_contract", "observed", "best_effort"]) && count(value.updatedAt) && Array.isArray(value.windows) && value.windows.every(quotaWindow) && optional(value.message, string)

type Check = (value: unknown) => boolean
const textInput: Check = (value) => typeof value === "string" && value.trim().length > 0 && utf8Length(value) <= 4096 && !value.includes("\0")
const idInput: Check = (value) => typeof value === "string" && value.length > 0 && utf8Length(value) <= 4096 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
const directoryInput: Check = (value) => typeof value === "string" && path.isAbsolute(value) && utf8Length(value) <= 4096 && !value.includes("\0")
const maybe = (check: Check): Check => (value) => value === undefined || check(value)

function checkedObject(value: unknown, checks: Readonly<Record<string, Check>>, message = "Invalid desktop request."): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((key) => !Object.hasOwn(checks, key)) || !Object.entries(checks).every(([key, check]) => check(value[key]))) throw new DesktopError(message)
}

function mutation<T>(value: unknown, shapes: Readonly<Record<string, Readonly<Record<string, Check>>>>, common: Readonly<Record<string, Check>> = {}): T {
  if (!object(value) || typeof value.kind !== "string" || !Object.hasOwn(shapes, value.kind)) throw new DesktopError("Invalid desktop change.")
  checkedObject(value, { kind: string, revision: isRevision, ...common, ...shapes[value.kind] })
  return value as T
}

async function existingDirectory(value: unknown) {
  if (!directoryInput(value) || typeof value !== "string") throw new DesktopError("Choose an absolute folder path of at most 4096 UTF-8 bytes.")
  const directory = path.resolve(value)
  const info = await fs.stat(directory).catch(() => { throw new DesktopError("This folder is unavailable. Check its path and access permissions.") })
  if (!info.isDirectory()) throw new DesktopError("Choose a folder, not a file.")
  return directory
}


function projectDirectory(value: unknown) {
  const typed = typeof value === "string" ? value.trim() : ""
  if (!isSessionDirectoryPath(typed)) throw new DesktopError("Enter an absolute folder path on the backend machine (such as /srv/app, C:\\Work or \\\\server\\share\\dir), or one starting with ~.")
  return typed
}

const hiddenFields = new Set(["auth", "password", "authorization", "headers", "environment", "token", "accesstoken", "access_token", "refreshtoken", "refresh_token", "apikey", "api_key", "credentials", "client_secret", "secret", "key", "config", "settings", "metadata"])

const reportHiddenFields = new Set([...hiddenFields].filter((key) => key !== "key"))

function displayValue(value: unknown, hidden: ReadonlySet<string> = hiddenFields): DisplayValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item) => displayValue(item, hidden))
  if (!object(value)) throw new DesktopError("The backend returned invalid display data.")
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !hidden.has(key.toLowerCase()) && item !== undefined).map(([key, item]) => [key, displayValue(item, hidden)]))
}

function displayFields(value: unknown, keys: readonly string[]) {
  if (!object(value)) throw new DesktopError("The backend returned invalid display data.")
  return displayValue(fields(value, keys))
}

function credentialFree(value: unknown) {
  if (typeof value !== "string" || utf8Length(value) > 8192) throw new Error("Invalid repository")
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    return url.href
  } catch { return value.replace(/^[^@/]*@/, "") }
}

function safeURL(value: unknown, protocols: readonly string[] = ["https:"]) {
  if (typeof value !== "string" || utf8Length(value) > 8192) throw new DesktopError("Choose a valid HTTPS URL without credentials.")
  let url: URL
  try { url = new URL(value) } catch { throw new DesktopError("Choose a valid HTTPS URL without credentials.") }
  if (!protocols.includes(url.protocol) || url.username || url.password) throw new DesktopError("Choose a valid HTTPS URL without credentials.")
  return url.href
}

async function parityLocation(api: Native["api"], signal: AbortSignal, source: ReturnType<typeof modelSource>) {
  if ("sessionID" in source) return sessionModelLocation(source.sessionID, await api.session.get({ sessionID: source.sessionID }, { signal }))
  return source.directory === undefined ? undefined : { directory: source.directory }
}

function attemptResult(value: unknown, kind: IntegrationAttempt["kind"], attemptID?: string): IntegrationAttempt {
  if (!object(value) || !object(value.time) || !count(value.time.created) || !count(value.time.expires)) throw new DesktopError("The backend returned an invalid connection attempt.")
  const id = attemptID ?? value.attemptID
  if (typeof id !== "string" || !idInput(id)) throw new DesktopError("The backend returned an invalid connection attempt.")
  const status = value.status === undefined ? "pending" : value.status
  if (status !== "pending" && status !== "complete" && status !== "failed" && status !== "expired") throw new DesktopError("The backend returned an invalid connection status.")
  if (!optional(value.instructions, string) || !optional(value.message, string) || !optional(value.manualCode, boolean) || !optional(value.mode, (mode) => mode === "auto" || mode === "code")) throw new DesktopError("The backend returned an invalid connection attempt.")
  return { kind, attemptID: id, status, time: { created: value.time.created, expires: value.time.expires }, ...(value.url === undefined ? {} : { url: safeURL(value.url) }), ...(value.mode === "auto" || value.mode === "code" ? { mode: value.mode } : {}), ...(typeof value.manualCode === "boolean" ? { manualCode: value.manualCode } : {}), ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}), ...(typeof value.message === "string" ? { message: value.message } : {}) }
}

function projectGuardrail(value: unknown) {
  if (!object(value) || !idInput(value.id) || typeof value.sessionID !== "string" || typeof value.rootSessionID !== "string" || typeof value.action !== "string" || typeof value.reason !== "string" || (value.created !== undefined && !count(value.created)) || !Array.isArray(value.resources) || !value.resources.every(string) || !Array.isArray(value.ruleIDs) || !value.ruleIDs.every(string) || typeof value.standard !== "boolean") throw new DesktopError("The backend returned an invalid guardrail request.")
  session(value.sessionID)
  session(value.rootSessionID)
  return displayFields(value, ["id", "created", "sessionID", "rootSessionID", "action", "resources", "ruleIDs", "reason", "standard", "hardReview", "risk", "escalation", "coordinationEscalation", "source"]) as NonNullable<import("./contract").PendingRequests["guardrails"]>[number]
}

function projectReview(value: unknown) {
  if (!object(value) || !idInput(value.itemID) || typeof value.sessionID !== "string" || typeof value.rootSessionID !== "string" || typeof value.sessionTitle !== "string" || !count(value.created) || !literal(value.kind, ["question", "subagent_question", "guardrail", "permission", "recovery"]) || !object(value.payload)) throw new DesktopError("The backend returned an invalid review item.")
  session(value.sessionID)
  session(value.rootSessionID)
  const projected = displayFields(value, ["itemID", "sessionID", "rootSessionID", "sessionTitle", "created", "kind", "reason", "choice", "confidence", "grades", "origin", "payload", "child"]) as NonNullable<import("./contract").PendingRequests["reviews"]>[number]
  if (value.payload.type !== "form") return projected
  if (typeof value.payload.title !== "string") throw new DesktopError("The backend returned an invalid review form.")
  return { ...projected, payload: { type: "form", title: value.payload.title, fields: decodeFormFields(value.payload.fields) } } as typeof projected
}

function reviewDecision(value: unknown): boolean {
  if (!object(value)) return false
  if (value.kind === "permission" || value.kind === "guardrail") return Object.keys(value).every((key) => key === "kind" || key === "reply") && literal(value.reply, ["once", "always", "reject"])
  if (value.kind === "recovery") return Object.keys(value).every((key) => key === "kind" || key === "choice") && literal(value.choice, ["continue", "stop"])
  if (value.kind !== "question" && value.kind !== "subagent_question") return false
  if (value.dismissed === true) return Object.keys(value).every((key) => key === "kind" || key === "dismissed")
  if (value.kind === "subagent_question") return Object.keys(value).every((key) => ["kind", "text", "data"].includes(key)) && boundedText(value.text, 8192) && nonempty(value.text) && optional(value.data, jsonData)
  if (Object.keys(value).some((key) => key !== "kind" && key !== "answers")) return false
  if (Array.isArray(value.answers)) return value.answers.every((answer) => Array.isArray(answer) && answer.every(string))
  try { decodeFormAnswer(value.answers); return utf8Length(JSON.stringify(value.answers)) <= 500_000 } catch { return false }
}

async function catalog(api: Native["api"], signal: AbortSignal, location?: ModelLocation) {
  const input = location === undefined ? undefined : { location }
  const [list, fallback] = await Promise.all([api.model.list(input, { signal }), api.model.default(input, { signal })])
  const expected = location ?? { directory: list.location?.directory, workspace: list.location?.workspaceID }
  if (typeof expected.directory !== "string" || !sameModelLocation(list, expected) || !sameModelLocation(fallback, expected))
    throw new DesktopError("The backend returned models for a different location. Refresh to retry.")
  return { models: projectModels(list.data), default: projectDefault(fallback.data ?? null) }
}

async function composerLocation(api: Native["api"], signal: AbortSignal, source: ReturnType<typeof modelSource>): Promise<ModelLocation | undefined> {
  if (!("sessionID" in source)) {
    if (source.directory === undefined) return undefined
    const listed = await api.project.inventory({ limit: 50, search: source.directory }, { signal })
    return openedModelLocation(source.directory, listed.data)
  }
  const found = await api.session.get({ sessionID: source.sessionID }, { signal })
  if (!object(found) || found.id !== source.sessionID) throw new DesktopError("The backend returned a different Session. Refresh and try again.")
  const location = object(found.location) ? found.location : undefined
  if (!location || typeof location.directory !== "string" || !path.isAbsolute(location.directory)) return undefined
  return sessionModelLocation(source.sessionID, found)
}

function catalogEnvelope(value: unknown, location: ModelLocation | undefined, label: string): unknown[] {
  if (!object(value) || !Array.isArray(value.data)) throw new DesktopError(`The backend returned an invalid ${label} list. Refresh to retry.`)
  if (location !== undefined && !sameModelLocation(value, location)) throw new DesktopError(`The backend returned ${label} for a different location. Refresh to retry.`)
  return value.data
}

const selectableAgent = (agent: string) => (row: unknown) => object(row) && row.id === agent && row.hidden === false && row.mode !== "subagent" && row.id !== "btw"
const catalogText = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit && utf8Length(value) <= limit * 4
const catalogDescription = (value: unknown): value is string | undefined => value === undefined || catalogText(value, 512)

function promptMention(value: unknown, text: string) {
  if (value === undefined) return undefined
  if (!object(value) || Object.keys(value).sort().join() !== "end,start,text" || !count(value.start) || !count(value.end) ||
    typeof value.text !== "string" || value.start >= value.end || value.end > text.length || value.text !== text.slice(value.start, value.end) || !value.text.startsWith("@") || value.text.length > 300)
    throw new DesktopError("Invalid message.")
  return { start: value.start, end: value.end, text: value.text }
}

function promptFiles(value: unknown, text: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > composerFileLimit) throw new DesktopError("Invalid message.")
  let inlineBytes = 0
  return value.map((item) => {
    if (!object(item) || Object.keys(item).some((key) => !["uri", "name", "description", "mention"].includes(key)) || typeof item.uri !== "string" || item.uri.length === 0) throw new DesktopError("Invalid message.")
    if (item.uri.startsWith("data:")) {
      const bytes = inlineFileSize(item.uri)
      if (bytes === undefined) throw new DesktopError("Invalid attachment data.")
      inlineBytes += bytes
      if (inlineBytes > composerByteLimit) throw new DesktopError("Attach at most 20 MiB of file data to a message.")
    } else if (!/^ycoding-attachment:\/\/sha256\/[0-9a-f]{64}$/.test(item.uri)) {
      if (item.uri.length > 2048) throw new DesktopError("Invalid message.")
      let url: URL
      try { url = new URL(item.uri) } catch { throw new DesktopError("Invalid message.") }
      if (url.protocol !== "file:" || url.username || url.password || (url.hostname !== "" && url.hostname !== "localhost")) throw new DesktopError("Invalid message.")
    }
    const name = item.name
    if (name !== undefined && (typeof name !== "string" || name.length === 0 || name.length > 255 || /[/\u0000-\u001f]/.test(name))) throw new DesktopError("Invalid message.")
    const description = item.description
    if (!catalogDescription(description)) throw new DesktopError("Invalid message.")
    const mention = promptMention(item.mention, text)
    return { uri: item.uri, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }), ...(mention === undefined ? {} : { mention }) }
  })
}

function promptAgents(value: unknown, text: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 20) throw new DesktopError("Invalid message.")
  return value.map((item) => {
    if (!object(item) || Object.keys(item).some((key) => !["name", "mention"].includes(key)) || typeof item.name !== "string" || item.name.length === 0 || item.name.length > 128 || /[\s\u0000-\u001f]/.test(item.name)) throw new DesktopError("Invalid message.")
    const mention = promptMention(item.mention, text)
    return { name: item.name, ...(mention === undefined ? {} : { mention }) }
  })
}

const unattributedShell = "This shell is not attributed to the selected Session."
const familyID = (value: unknown): value is string => sessionID(value)

async function familyRoot(api: Native["api"], signal: AbortSignal, start: unknown) {
  if (!object(start) || !familyID(start.id)) throw new DesktopError(unattributedShell)
  let current: Record<string, unknown> & { readonly id: string } = { ...start, id: start.id }
  const seen = new Set([start.id])
  while (current.parentID !== undefined && current.parentID !== null) {
    const parentID = current.parentID
    if (!familyID(parentID) || seen.has(parentID) || seen.size >= 256) throw new DesktopError(unattributedShell)
    seen.add(parentID)
    const parent: unknown = await api.session.get({ sessionID: parentID }, { signal })
    if (!object(parent) || parent.id !== parentID) throw new DesktopError(unattributedShell)
    current = { ...parent, id: parentID }
  }
  return current.id
}

async function sameShellFamily(api: Native["api"], signal: AbortSignal, selected: { readonly id: string }, shell: unknown) {
  const owner = object(shell) && object(shell.metadata) ? shell.metadata.sessionID : undefined
  if (!familyID(owner)) throw new DesktopError(unattributedShell)
  if (owner === selected.id) return
  const root = await familyRoot(api, signal, selected)
  if (owner === root) return
  if (await familyRoot(api, signal, await api.session.get({ sessionID: owner }, { signal })) !== root) throw new DesktopError(unattributedShell)
}

async function familyShell(api: Native["api"], signal: AbortSignal, selected: { readonly id: string }, shellID: string) {
  const search = async (location: ModelLocation) => {
    const listed = await api.shell.list({ location }, { signal })
    if (!sameModelLocation(listed, location) || !Array.isArray(listed.data) || !listed.data.every(shellValid)) throw new DesktopError(unattributedShell)
    return listed.data.find((shell) => shell.id === shellID)
  }
  const own = sessionModelLocation(selected.id, selected)
  const found = async (shell: Awaited<ReturnType<typeof search>>, location: ModelLocation) => {
    await sameShellFamily(api, signal, selected, shell)
    return { shell: shell!, location }
  }
  const here = await search(own)
  if (here) return found(here, own)
  const rootID = await familyRoot(api, signal, selected)
  const members: unknown[] = [rootID === selected.id ? selected : await api.session.get({ sessionID: rootID }, { signal })]
  const seen = new Set([rootID])
  for (let index = 0; index < members.length; index++) {
    const parent = members[index]
    if (!object(parent) || !familyID(parent.id)) throw new DesktopError(unattributedShell)
    let next: string | undefined
    do {
      const page = await api.session.list({ parentID: parent.id, limit: 200, ...(next === undefined ? {} : { cursor: next }) }, { signal })
      if (!object(page) || !Array.isArray(page.data)) throw new DesktopError(unattributedShell)
      for (const child of page.data) {
        if (!object(child) || child.parentID !== parent.id || !familyID(child.id) || seen.has(child.id)) continue
        if (seen.size >= 1000) throw new DesktopError(unattributedShell)
        seen.add(child.id)
        members.push(child)
      }
      const cursor = object(page.cursor) ? page.cursor.next : undefined
      next = typeof cursor === "string" && cursor ? cursor : undefined
    } while (next !== undefined)
  }
  const locations = new Map(members.map((member) => { const location = sessionModelLocation((member as { id: string }).id, member); return [`${location.directory}\0${location.workspace ?? ""}`, location] as const }))
  locations.delete(`${own.directory}\0${own.workspace ?? ""}`)
  for (const location of locations.values()) {
    const shell = await search(location)
    if (shell) return found(shell, location)
  }
  throw new DesktopError(unattributedShell)
}

async function directoryActivity(api: Native["api"], signal: AbortSignal) {
  const [decisions, outstanding] = await Promise.allSettled([api.decision.list({ signal }), api.session.outstanding(undefined, { signal })])
  const running = outstanding.status === "fulfilled" && object(outstanding.value) && Array.isArray(outstanding.value.running) && outstanding.value.running.every(familyID) ? [...new Set(outstanding.value.running)] : undefined
  const waiting = decisions.status === "fulfilled" && Array.isArray(decisions.value) && decisions.value.every((item) => object(item) && familyID(item.sessionID))
    ? await Promise.all([...new Set(decisions.value.map((item) => item.sessionID))].map(async (sessionID) => familyRoot(api, signal, await api.session.get({ sessionID }, { signal })))).then((roots) => [...new Set(roots)], () => undefined)
    : undefined
  return { ...(running === undefined ? {} : { running }), ...(waiting === undefined ? {} : { waiting }) }
}

async function readTarget(api: Native["api"], signal: AbortSignal, sessionID: string) {
  const [found, active] = await Promise.all([api.session.get({ sessionID }, { signal }), api.session.active({ signal })])
  return { location: sessionModelLocation(sessionID, found), current: currentModel(found), running: running(active, sessionID) }
}

function reply(value: unknown, version: string): Endpoint & { readonly pid?: number } {
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "desktop.endpoint" ||
    !("version" in value) || value.version !== version || !("endpoint" in value) || typeof value.endpoint !== "object" || value.endpoint === null)
    throw new Error("The bundled backend returned an incompatible lease response.")
  const endpoint = value.endpoint
  if (!("url" in endpoint) || typeof endpoint.url !== "string") throw new Error("Invalid native backend endpoint.")
  const url = new URL(endpoint.url)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid native backend endpoint.")
  const base = { url: url.href, ...("pid" in endpoint && count(endpoint.pid) && endpoint.pid > 0 ? { pid: endpoint.pid } : {}) }
  if (!("auth" in endpoint) || endpoint.auth === undefined) return base
  const auth = endpoint.auth
  if (typeof auth !== "object" || auth === null || !("type" in auth) || auth.type !== "basic" ||
    !("username" in auth) || typeof auth.username !== "string" || !("password" in auth) || typeof auth.password !== "string")
    throw new Error("Invalid native backend authentication capability.")
  return { ...base, auth: { type: "basic", username: auth.username, password: auth.password } }
}

function openControl(binary: { executable: string; version: string }, selection: Selection, env: NodeJS.ProcessEnv | undefined, signal: AbortSignal, launch: Launch, cwd?: string, log?: (line: string) => void) {
  const args = ["desktop-host", "--backend", binary.executable, "--mode", selection.mode]
  if (selection.mode === "shared" && selection.server) args.push("--server", selection.server)
  const [file, ...rest] = launch([binary.executable, ...args])
  const process = spawn(file, rest, { env, cwd, stdio: ["pipe", "pipe", "pipe"] })
  const ready = Promise.withResolvers<Endpoint & { readonly pid?: number }>()
  const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
  const invalidated = Promise.withResolvers<void>()
  let buffer = ""
  let received = false
  let backendPID: number | undefined
  let terminal = false
  let protocolError = false
  let processError = false
  let ended = false
  let launched = false
  let spawnFailed = false
  let closing: Promise<void> | undefined
  const failure = () => new DesktopError(selection.mode === "own"
    ? "The private bundled backend did not start. Retry or rebuild the desktop app."
    : "The shared backend is unavailable or incompatible. Start it manually or check the endpoint and retry.")
  const stop = () => { void close().catch(() => undefined) }
  const timeout = setTimeout(() => { ready.reject(failure()); stop() }, 30_000)
  process.stdout.on("data", (chunk: Buffer) => {
    if (protocolError || (received && selection.mode === "shared")) return
    buffer += chunk.toString("utf8")
    try {
      if (buffer.length > 65_536) throw failure()
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const record: unknown = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (selection.mode === "own" && object(record) && record.type === "desktop.retired") {
          const hasPID = Object.hasOwn(record, "pid")
          if (terminal || Object.keys(record).length !== (hasPID ? 2 : 1) ||
            (hasPID && (!count(record.pid) || record.pid <= 0)) || (received && record.pid !== backendPID))
            throw failure()
          terminal = true
          invalidated.resolve()
          if (!received) { clearTimeout(timeout); ready.reject(failure()); stop() }
        } else if (!received) {
          if (terminal) throw failure()
          const endpoint = reply(record, binary.version)
          if (selection.mode === "own" && endpoint.pid === undefined) throw failure()
          received = true
          backendPID = endpoint.pid
          clearTimeout(timeout)
          ready.resolve(endpoint)
        } else if (selection.mode === "own") throw failure()
      }
    } catch {
      protocolError = true
      invalidated.resolve()
      ready.reject(failure())
      stop()
    }
  })
  let stderrBudget = 16_384
  process.stderr.on("data", (chunk: Buffer) => {
    if (stderrBudget <= 0) return
    const text = chunk.toString("utf8").slice(0, stderrBudget)
    stderrBudget -= text.length
    for (const line of text.split("\n")) if (line.trim()) log?.(`desktop-host: ${redactSecrets(line.trim())}`)
  })
  process.stdin.on("error", () => { processError = true; invalidated.resolve(); ready.reject(failure()) })
  process.once("spawn", () => { launched = true })
  process.once("error", () => { spawnFailed = !launched && process.pid === undefined; processError = true; invalidated.resolve(); ready.reject(failure()) })
  process.once("close", (code, signal) => {
    ended = true
    invalidated.resolve()
    if (selection.mode === "own" && buffer.length > 0) protocolError = true
    clearTimeout(timeout)
    ready.reject(failure())
    closed.resolve({ code, signal })
  })
  const confirmed = () => ended && (spawnFailed || (!processError && !protocolError && (selection.mode === "shared" || terminal)))
  const abort = () => { ready.reject(new DesktopError("Backend connection was cancelled.")); stop() }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  function close() {
    if (closing) return closing
    closing = (async () => {
      signal.removeEventListener("abort", abort)
      clearTimeout(timeout)
      if (!ended) process.stdin.end()
      const terminate = setTimeout(() => process.kill("SIGTERM"), 5_000)
      const force = setTimeout(() => process.kill("SIGKILL"), 8_000)
      try {
        const result = await closed.promise
        if (!confirmed() || result.code !== 0 || result.signal !== null)
          throw new DesktopError("The backend control did not close successfully.")
      } finally { clearTimeout(terminate); clearTimeout(force) }
    })()
    return closing
  }
  return { ready: ready.promise, invalidated: invalidated.promise, close, confirmed, get active() { return !ended && !terminal && !protocolError && !processError } }
}

async function checkVersion(binary: { executable: string; version: string }, env: NodeJS.ProcessEnv | undefined, signal: AbortSignal, launch: Launch, cwd?: string) {
  const [file, ...rest] = launch([binary.executable, "--version"])
  const version = await new Promise<string>((resolve, reject) => {
    execFile(file, rest, { env, cwd, signal, timeout: 10_000, maxBuffer: 16_384 }, (error, stdout) => {
      if (error) reject(new DesktopError("The bundled backend could not report its version. Rebuild the desktop app."))
      else resolve(stdout.trim())
    })
  })
  if (version !== `ycoding v${binary.version}`) throw new DesktopError("The bundled backend version does not match its bundle manifest. Rebuild the desktop app.")
}

export class BackendController {
  private current?: Attempt
  private retired?: Attempt
  private generation = 0
  private revision = 0
  private pages?: Pages
  private previews = new Map<string, { readonly connection: number; readonly preview: ArtifactPreviewKind; readonly identity: ArtifactIdentity; readonly expiresAt: number; readonly confirmable: boolean }>()
  private snapshot: ConnectionState = { generation: 0, status: "idle" }
  private readonly streams: TerminalRelay
  private readonly editor: Pick<DesktopEditor, "read" | "close">
  private readonly restart = new BackendRestart()

  constructor(private readonly resources: string, private readonly options: Options = {}) {
    this.streams = new TerminalRelay(options.terminalSocket)
    this.editor = options.editor ?? new DesktopEditor({ env: options.env })
  }

  state() { return this.snapshot }

  private publish(state: ConnectionState) {
    if (state.revision !== this.pages?.revision) this.pages = undefined
    this.streams.retain(state.status === "connected" ? state.revision : undefined)
    this.snapshot = state
    this.options.onState?.(state)
    return state
  }

  async connect(input: unknown): Promise<ConnectionState> {
    const selection = validateSelection(input)
    this.editor.close()
    const previous = this.current ?? this.retired
    previous?.abort.abort()
    this.current = undefined
    this.retired = previous
    const generation = ++this.generation
    this.publish({ generation, mode: selection.mode, status: "connecting" })
    try { await this.retire(previous) }
    catch (error) {
      const retry = previous?.confirmed === true && previous.reported === true
      if (previous) previous.reported = true
      if (!retry) {
        const failure = error instanceof DesktopError ? error : new DesktopError("The previous backend could not be retired. Backend ownership is unconfirmed.")
        if (this.generation === generation) this.publish({ generation, mode: selection.mode, status: "error", error: failure.message })
        throw failure
      }
    }
    if (this.generation !== generation) throw new DesktopError("Backend connection was cancelled.")
    const attempt: Attempt = { generation, mode: selection.mode, selection, abort: new AbortController(), revision: 0 }
    this.current = attempt
    this.retired = undefined
    const active = () => this.current === attempt && !attempt.abort.signal.aborted && (selection.mode === "shared" || attempt.control?.active === true)
    attempt.pending = (async () => {
      try {
        if (this.current !== attempt) throw new DesktopError("Backend connection was cancelled.")
        const binary = await bundledBackend(this.resources)
        const launch = this.options.launch ?? direct
        await checkVersion(binary, this.options.env, attempt.abort.signal, launch, this.options.cwd)
        attempt.abort.signal.throwIfAborted()
        attempt.control = openControl(binary, selection, this.options.env, attempt.abort.signal, launch, this.options.cwd, this.options.log)
        if (selection.mode === "own") void attempt.control.invalidated.then(() => this.stopped(attempt))
        const endpoint = await attempt.control.ready
        if (!active()) throw new DesktopError("Backend connection was cancelled.")
        attempt.endpoint = endpoint
        if (selection.mode === "own" && endpoint.auth === undefined) throw new DesktopError("The private backend did not provide its authentication capability.")
        const native = await connectNative(endpoint, {
          signal: attempt.abort.signal,
          fetch: this.options.fetch,
          socket: this.options.socket,
          directory: this.options.cwd,
          version: selection.mode === "own" ? binary.version : undefined,
          log: this.options.log,
          onEvent: (event) => active() ? this.options.onEvent?.(event) : undefined,
          onStatus: (status) => {
            if (!active() || this.snapshot.status === "connecting") return
            if (status.status !== "connected") {
              if (this.snapshot.status !== "reconnecting") attempt.revision = ++this.revision
              this.publish({ ...this.snapshot, status: "reconnecting", revision: attempt.revision })
              return
            }
            attempt.revision = ++this.revision
            this.publish({ generation: attempt.generation, mode: selection.mode, status: "connected", revision: attempt.revision, version: status.health.version, backendPID: status.health.pid })
          },
          reconnect: selection.mode === "shared" && (!selection.server || isLoopbackSelection(selection.server)) ? async (signal) => {
            const control = openControl(binary, selection, this.options.env, signal, launch, this.options.cwd, this.options.log)
            const moved = await control.ready.catch(async (error: unknown) => {
              await control.close().catch(() => undefined)
              throw error
            })
            const previous = attempt.control
            attempt.control = control
            attempt.endpoint = moved
            void previous?.close().catch((error: unknown) => { this.options.log?.(`Replaced backend control: ${error instanceof Error ? error.message : "unknown error"}`) })
            return moved
          } : undefined,
        })
        attempt.native = native
        if (selection.mode === "own" && native.health.pid !== endpoint.pid) throw new DesktopError("The private backend identity does not match its ownership lease.")
        if (!active()) throw new DesktopError("Backend connection was cancelled.")
        attempt.revision = ++this.revision
        const connected = this.publish({ generation: attempt.generation, mode: selection.mode, status: "connected", revision: attempt.revision, version: native.health.version, backendPID: native.health.pid })
        return connected
      } catch (error) {
        if (!(error instanceof DesktopError)) this.options.log?.(`Backend connection error: ${describeError(error)}`)
        let failure = error instanceof DesktopError ? error : new DesktopError(attempt.abort.signal.aborted ? "Backend connection was cancelled." : "Backend connection failed. Retry.")
        attempt.abort.abort()
        try { await this.cleanup(attempt) }
        catch (cleanupError) {
          const detail = cleanupError instanceof DesktopError ? cleanupError.message : "The backend could not be retired. Backend ownership is unconfirmed."
          failure = new DesktopError(`${failure.message} ${detail}`)
        }
        attempt.reported = true
        if (this.current === attempt) this.publish({ generation: attempt.generation, mode: selection.mode, status: "error", error: failure.message })
        throw failure
      }
    })()
    return attempt.pending
  }

  async disconnect() {
    this.editor.close()
    this.streams.retain(undefined)
    const previous = this.current ?? this.retired
    this.current = undefined
    this.retired = previous
    const generation = ++this.generation
    try { await this.retire(previous) }
    catch (error) {
      if (previous) previous.reported = true
      const failure = error instanceof DesktopError ? error : new DesktopError("The backend could not be retired. Backend ownership is unconfirmed.")
      if (this.generation === generation) this.publish({ generation, mode: previous?.mode, status: "error", error: failure.message })
      throw failure
    }
    if (this.generation === generation) this.publish({ generation, status: "idle" })
  }

  private async stopped(attempt: Attempt) {
    if (this.current !== attempt || attempt.abort.signal.aborted) return
    attempt.abort.abort()
    this.editor.close()
    this.streams.retain(undefined)
    await attempt.pending?.catch(() => undefined)
    if (attempt.reported) return
    let error = "The private backend stopped unexpectedly. Start my own backend to restart it, or connect to a shared backend."
    try { await this.cleanup(attempt) }
    catch (failure) {
      error = attempt.confirmed
        ? "The private backend stopped unexpectedly and its control closed unsuccessfully. Start my own backend to restart it, or connect to a shared backend."
        : failure instanceof DesktopError ? failure.message : "The backend could not be retired. Backend ownership is unconfirmed."
    }
    attempt.reported = true
    if (this.current === attempt)
      this.publish({ generation: attempt.generation, mode: "own", status: "error", error })
  }

  private retire(previous: Attempt | undefined): Promise<void> {
    if (!previous) return Promise.resolve()
    return previous.retirement ??= (async () => {
      previous.abort.abort()
      await previous.pending?.catch(() => undefined)
      await this.cleanup(previous)
    })()
  }

  private cleanup(attempt: Attempt): Promise<void> {
    return attempt.cleanup ??= (async () => {
      const results = await Promise.allSettled([attempt.native?.close(), attempt.control?.close()])
      attempt.confirmed = results[0]?.status === "fulfilled" && (attempt.control?.confirmed() ?? true)
      const failed = results.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    })()
  }

  private async use<T>(failure: string, run: (api: Native["api"], signal: AbortSignal, revision: number, ensureCurrent: (message: string) => void) => Promise<T>, fence: { readonly revision?: number; readonly unsent?: string; readonly changed?: string } = {}) {
    const current = this.current
    if (!current?.native || this.snapshot.status !== "connected") throw new DesktopError("Connect to a backend before using Sessions.")
    const revision = current.revision
    if (fence.revision !== undefined && fence.revision !== revision) throw new DesktopError(fence.unsent ?? unsent)
    const api = current.native.api
    const epoch = api.transport.connectionEpoch
    const changed = fence.changed ?? "The backend connection changed."
    let value: T
    const ensureCurrent = (message: string) => {
      if (this.current !== current || this.snapshot.status !== "connected" || current.revision !== revision ||
        current.native?.api !== api || api.transport.connectionEpoch !== epoch || api.transport.state === "closed") throw new DesktopError(message)
    }
    try { value = await run(api, current.abort.signal, revision, ensureCurrent) }
    catch (error) {
      if (error instanceof DesktopError) throw error
      ensureCurrent(changed)
      throw new DesktopError(failure)
    }
    ensureCurrent(changed)
    return value
  }

  async restartBackend(input: unknown): Promise<ConnectionState> {
    const attempt = this.current
    if (!attempt?.endpoint || this.snapshot.status !== "connected") throw new DesktopError("Connect to a backend before restarting it.")
    const binary = await bundledBackend(this.resources)
    let generation = attempt.generation
    let detached = false
    return this.restart.run(input, {
      state: () => this.state(), selection: attempt.selection, endpoint: attempt.endpoint,
      command: [binary.executable, "serve", "--service"], version: binary.version,
      current: () => this.generation === generation && (detached ? this.current === undefined : this.current === attempt),
      disconnect: async () => { generation = this.generation + 1; detached = true; await this.disconnect() },
      connect: (selection) => this.connect(selection), service: this.options.restartService ?? Service,
    })
  }

  async editorSelection(input: unknown) {
    if (!object(input) || Object.keys(input).some((key) => !["directory", "revision"].includes(key)) || typeof input.directory !== "string" || !path.isAbsolute(input.directory) || input.directory.includes("\0") || utf8Length(input.directory) > 4096 || !isRevision(input.revision)) throw new DesktopError("Choose a current workspace for IDE context.")
    const directory = input.directory
    return this.use("IDE context could not be read.", () => this.editor.read(directory), { revision: input.revision })
  }

  async editDraft(input: unknown): Promise<DraftEditorResult> {
    if (!object(input) || Object.keys(input).some((key) => !["text", "directory"].includes(key)) || typeof input.text !== "string" || utf8Length(input.text) > 1024 * 1024 || typeof input.directory !== "string" || !path.isAbsolute(input.directory) || input.directory.includes("\0") || utf8Length(input.directory) > 4096) throw new DesktopError("Choose an absolute workspace and a draft within the editor size limit.")
    return this.options.openEditor ? this.options.openEditor({ text: input.text, directory: input.directory }) : openDesktopEditor({ text: input.text, directory: input.directory }, { env: this.options.env })
  }

  async sessions(input: unknown) {
    const query = sessionsQuery(input)
    const page = query.cursor === undefined
      ? await this.use("Sessions could not be read. Refresh to retry.", async (api, signal, revision) => {
        const [page, activity] = await Promise.all([api.session.list({ limit: 40, ...(query.search === undefined ? {} : { search: query.search }), background: "exclude" }, { signal }), directoryActivity(api, signal)])
        return { ...projectSessions(page, revision), ...activity }
      })
      : await this.use("More Sessions could not be read. Refresh to retry.", async (api, signal, revision) => {
        const pages = this.pages
        if (pages?.revision !== revision || !pages.cursors.includes(query.cursor)) throw new DesktopError("Load more Sessions only from the current list. Refresh Sessions and try again.")
        return projectSessions(await api.session.list({ limit: 40, cursor: query.cursor, background: "exclude" }, { signal }), revision)
      }, { revision: query.revision, unsent: unpaged, changed: unpaged })
    if (page.next !== undefined && page.revision === this.current?.revision) {
      const pages: Pages = this.pages?.revision === page.revision ? this.pages : { revision: page.revision, cursors: [] }
      this.pages = pages
      const known = pages.cursors.indexOf(page.next)
      if (known >= 0) pages.cursors.splice(known, 1)
      pages.cursors.push(page.next)
      if (pages.cursors.length > 64) pages.cursors.shift()
    }
    return page
  }

  async session(input: unknown) {
    const sessionID = sessionTarget(input)
    return this.use("The Session could not be read. Refresh to retry.", async (api, signal, revision) =>
      ({ revision, item: projectSessionRecord(sessionID, await api.session.get({ sessionID }, { signal })) }),
    { changed: "The backend connection changed while the Session was read. Refresh to retry." })
  }

  async interactionStatus(input: unknown) {
    checkedObject(input, { sessionID, revision: isRevision })
    const revision = input.revision
    if (!isRevision(revision)) throw new DesktopError("Refresh the connection before reading interaction status.")
    const path = { sessionID: session(input.sessionID) }
    return this.use("Interaction status could not be read.", (api, signal) => api.sessionInteraction.status(path, { signal }), { revision })
  }

  async interactionPreview(input: unknown) {
    checkedObject(input, { sessionID, revision: isRevision, generation: interactionGeneration })
    const { revision, generation } = input
    if (!isRevision(revision) || !interactionGeneration(generation)) throw new DesktopError("Choose the current interaction preview.")
    const query = { sessionID: session(input.sessionID), generation }
    return this.use("Interaction preview could not be read.", (api, signal) => api.sessionInteraction.preview(query, { signal }), { revision })
  }

  async interactionStop(input: unknown) {
    checkedObject(input, { sessionID, revision: isRevision, generation: interactionGeneration })
    const { revision, generation } = input
    if (!isRevision(revision) || !interactionGeneration(generation)) throw new DesktopError("Choose the current interaction to stop.")
    const request = { sessionID: session(input.sessionID), generation }
    await this.use("Stop was not confirmed. Check the reported status.", (api, signal) => api.sessionInteraction.stop(request, { signal }), { revision })
  }

  async interactionResume(input: unknown) {
    checkedObject(input, { sessionID, revision: isRevision, generation: interactionGeneration })
    const { revision, generation } = input
    if (!isRevision(revision) || !interactionGeneration(generation)) throw new DesktopError("Choose the current interaction to resume.")
    const request = { sessionID: session(input.sessionID), generation }
    await this.use("Resume was not confirmed. Check the reported status.", (api, signal) => api.sessionInteraction.resume(request, { signal }), { revision })
  }

  async interactionRequest(input: unknown) {
    checkedObject(input, { sessionID, revision: isRevision, payload: object })
    const revision = input.revision
    const proposal = decodeInteractionRequest(input.payload)
    if (!isRevision(revision) || proposal._tag === "None" || (proposal.value.url !== undefined && !chromeInteractionURL(proposal.value.url)))
      throw new DesktopError("Choose a valid local interaction proposal.")
    const path = { sessionID: session(input.sessionID) }
    await this.use("The request was not confirmed. Check the reported status.", (api, signal) => {
      const endpoint = this.current?.endpoint
      if (!endpoint || !isLoopbackSelection(endpoint.url)) throw new DesktopError("Request interaction from the machine that runs the backend.")
      return api.sessionInteraction.request({ ...path, payload: proposal.value }, { signal })
    }, { revision })
  }

  private projectAutonomy(value: Awaited<ReturnType<Native["api"]["session"]["autonomy"]["get"]>>) {
    if (!autonomyValid(value)) throw new Error("Invalid autonomy view")
    return { ...fields(value, ["mode", "permissions", "guardrails", "answers"]), ...(value.goal === undefined ? {} : { goal: value.goal === null ? null : fields(value.goal, ["text", "status", "iteration", "noProgress", "maxNoProgress", "lastProgressDigest"]) }), ...(value.defer === undefined ? {} : { defer: value.defer === null ? null : {} }), effective: { ...fields(value.effective, ["permissions", "guardrails", "answers", "deferred", "guardrailsEnabled"]), inherited: fields(value.effective.inherited, ["permissions", "guardrails", "answers"]) } }
  }

  async autonomy(input: unknown) {
    const sessionID = session(input)
    return this.use("Autonomy could not be read. Refresh to retry.", async (api, signal, revision) => ({ revision, sessionID, autonomy: this.projectAutonomy(await api.session.autonomy.get({ sessionID }, { signal })) }))
  }

  async setAutonomy(input: unknown) {
    const request = setAutonomyInput(input)
    const changed = "The autonomy change was not confirmed. Refresh the Session before retrying."
    return this.use(changed, async (api, signal, revision, ensureCurrent) => {
      ensureCurrent("The backend connection changed before autonomy was changed.")
      return { revision, sessionID: request.sessionID, autonomy: this.projectAutonomy(await api.session.autonomy.set({ sessionID: request.sessionID, payload: request.payload }, { signal })) }
    }, { revision: request.revision, unsent: "The backend connection changed before autonomy was changed.", changed })
  }

  async fileChanges(input: unknown): Promise<SessionFileChanges> {
    const sessionID = session(input)
    return this.use("Captured file changes could not be read. Refresh to retry.", async (api, signal, revision) => {
      const [items, captured] = await Promise.all([api.session["file-change"].list({ sessionID }, { signal }), api.message.capturedInputs({ sessionID, limit: 50 }, { signal }).catch(() => undefined)])
      if (!Array.isArray(items) || !items.every((item) => object(item) && typeof item.path === "string" && typeof item.patch === "string" && count(item.additions) && count(item.deletions))) throw new Error("Invalid file changes")
      if (captured !== undefined && (!object(captured) || !Array.isArray(captured.data) || !optional(captured.next, count))) throw new Error("Invalid captured inputs")
      const turns: { id: string; type: "user" | "synthetic" | "assistant"; files: { path: string; patch: string; additions: number; deletions: number }[] }[] | undefined = captured === undefined ? undefined : []
      for (const entry of captured?.data ?? []) {
        if (!object(entry) || !prefix(entry.id, "msg_") || !literal(entry.type, ["user", "synthetic", "assistant"]) || (entry.content !== undefined && !Array.isArray(entry.content))) throw new Error("Invalid captured input")
        if (entry.type === "user" || !turns!.length) turns!.push({ id: entry.id, type: entry.type, files: [] })
        for (const part of entry.content ?? []) {
          if (!object(part) || part.type !== "tool" || !string(part.name) || !object(part.state)) throw new Error("Invalid captured tool")
          const structured = part.state.structured
          if (structured === undefined) continue
          if (!object(structured) || (structured.files !== undefined && !Array.isArray(structured.files))) throw new Error("Invalid captured files")
          for (const file of structured.files ?? []) {
            if (!object(file) || !string(file.patch) || !optional(file.file, string)) throw new Error("Invalid captured file")
          }
          turns!.at(-1)!.files.push(...capturedPartPatches(part).map((patch) => ({ path: patch.path, patch: patch.diff, additions: patch.additions, deletions: patch.deletions })))
        }
      }
      return { revision, sessionID, items: items.map((item) => fields(item, ["path", "patch", "additions", "deletions"])), ...(captured === undefined ? { turnsComplete: false, turnsNotice: "Turn-level change history could not be read. Showing Session aggregate changes." } : captured.next !== undefined ? { turns, turnsComplete: false, turnsNotice: "Showing the first 50 captured inputs. Later turns may be omitted from turn filters." } : { turns, turnsComplete: true }) }
    })
  }

  async activity(input: unknown) {
    const { sessionID, page: requested } = activityInput(input)
    return this.use("Session activity could not be read. Refresh to retry.", async (api, signal, revision) => {
      const [found, page] = await Promise.all([api.session.get({ sessionID }, { signal }), api.session.subagent.list({ parentID: sessionID, limit: 10, ...(requested.cursor === undefined ? {} : { cursor: requested.cursor }) }, { signal })])
      if (!object(found) || found.id !== sessionID || (found.scope !== undefined && found.scope !== "bound" && found.scope !== "standalone") || !object(found.location) || typeof found.location.directory !== "string" ||
        !object(page) || !Array.isArray(page.data) || !page.data.every((task) => taskValid(task, sessionID)) ||
        !object(page.summary) || !count(page.summary.total) || !count(page.summary.active) || !cursor(page.cursor)) throw new Error("Invalid activity")
      const allowed = new Set([sessionID, ...page.data.map((task) => task.sessionID)])
      const result = found.scope !== "standalone" && found.location.directory
        ? await api.shell.list({ location: { directory: found.location.directory } }, { signal }) : undefined
      if (result !== undefined && (!object(result) || !object(result.location) || result.location.directory !== found.location.directory || !Array.isArray(result.data) || !result.data.every(shellValid))) throw new Error("Invalid shells")
      const shells: import("./contract").SessionActivity["shells"][number][] = []
      let unattributedShellCount = 0
      for (const shell of result?.data ?? []) {
        const owner = object(shell.metadata) ? shell.metadata.sessionID : undefined
        if (typeof owner !== "string" || !owner) { unattributedShellCount++; continue }
        if (allowed.has(owner)) shells.push({ ...fields(shell, ["id", "status", "command", "cwd", "shell", "file", "pid", "exit", "metadata", "toolCallID"]), time: fields(shell.time, ["started", "completed"]), ownerSessionID: owner })
      }
      const subagents = page.data.map((task) => ({ ...fields(task, ["sessionID", "parentID", "description", "agent", "background", "state", "revision", "pinnedAt"]), model: fields(task.model, ["id", "providerID", "variant", "profile"]), time: fields(task.time, ["created", "updated"]), ...(task.progress ? { progress: fields(task.progress, ["text", "time"]) } : {}), ...(task.question ? { question: fields(task.question, ["id", "text", "data", "time", "deferred"]) } : {}), ...(task.stoppedRecovery ? { stoppedRecovery: fields(task.stoppedRecovery, ["itemID"]) } : {}) }))
      return { revision, sessionID, subagents, ...(typeof page.cursor?.next === "string" ? { subagentNext: page.cursor.next } : {}), total: page.summary.total, activeTotal: page.summary.active, shells, unattributedShellCount }
    }, { revision: requested.revision })
  }

  async shellOutput(input: unknown) {
    const request = shellOutputInput(input)
    return this.use("Shell output could not be read. Refresh to retry.", async (api, signal, revision, ensureCurrent) => {
      const found = await api.session.get({ sessionID: request.sessionID }, { signal })
      if (!object(found) || found.id !== request.sessionID || found.scope === "standalone" || !object(found.location) || typeof found.location.directory !== "string" || !path.isAbsolute(found.location.directory) || !optional(found.location.workspaceID, string)) throw new Error("Invalid Session")
      const { shell, location } = await familyShell(api, signal, found, request.shellID)
      ensureCurrent("The backend connection changed before shell output was read.")
      const result = await api.shell.output({ id: request.shellID, location, ...(request.cursor === undefined ? {} : { cursor: request.cursor }), ...(request.limit === undefined ? {} : { limit: request.limit }) }, { signal })
      if (!sameModelLocation(result, location) || !object(result.data) || !string(result.data.output) || !count(result.data.cursor) || !count(result.data.size) || !boolean(result.data.truncated)) throw new Error("Invalid shell output")
      const summary = { ...fields(shell, ["status", "command", "cwd", "pid", "exit"]), time: fields(shell.time, ["started", "completed"]) } as ShellSummary
      return { revision, sessionID: request.sessionID, shellID: request.shellID, shell: summary, ...fields(result.data, ["output", "cursor", "size", "truncated"]) }
    })
  }

  async browseDirectory(input?: unknown): Promise<DirectoryListing> {
    if (input !== undefined) checkedObject(input, { directory: maybe(directoryInput), showHidden: maybe(boolean) })
    const directory = await existingDirectory(object(input) ? input.directory ?? this.options.cwd ?? os.homedir() : this.options.cwd ?? os.homedir())
    const listed = await fs.readdir(directory, { withFileTypes: true }).catch(() => { throw new DesktopError("This folder cannot be browsed. Check its access permissions.") })
    const entries = (await Promise.all(listed.filter((entry) => (object(input) && input.showHidden === true) || !entry.name.startsWith(".")).map(async (entry) => {
      const target = path.join(directory, entry.name)
      const info = entry.isSymbolicLink() ? await fs.stat(target).catch(() => undefined) : entry
      if (!info || (!info.isDirectory() && !info.isFile())) return undefined
      return { name: entry.name, path: target, kind: info.isDirectory() ? "directory" as const : "file" as const }
    }))).filter((entry) => entry !== undefined).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) || a.name.localeCompare(b.name))
    return { directory, parent: path.dirname(directory) === directory ? null : path.dirname(directory), home: os.homedir(), entries: entries.slice(0, 500), truncated: entries.length > 500 }
  }

  private async registerDirectory(api: Native["api"], signal: AbortSignal, revision: number, directory: string): Promise<OpenedDirectory> {
    const info = await api.location.get({ location: { directory } }, { signal })
    if (!object(info) || typeof info.directory !== "string" || !directoryInput(info.directory) || !object(info.project) || typeof info.project.id !== "string") throw new DesktopError("The backend returned an invalid folder registration.")
    return { revision, directory: info.directory, projectID: info.project.id }
  }

  async openDirectory(input: unknown): Promise<OpenedDirectory> {
    checkedObject(input, { directory: directoryInput })
    const directory = await existingDirectory(input.directory)
    return this.use("This folder could not be registered. Check backend access and try again.", (api, signal, revision) => this.registerDirectory(api, signal, revision, directory))
  }

  async createDirectory(input: unknown): Promise<OpenedDirectory> {
    checkedObject(input, { parentDirectory: directoryInput, name: string })
    const parentDirectory = await existingDirectory(input.parentDirectory)
    const name = typeof input.name === "string" ? input.name.trim() : ""
    if (!name || utf8Length(name) > 255 || name === "." || name === ".." || /[/\\\u0000-\u001f\u007f-\u009f]/.test(name)) throw new DesktopError("Enter a folder name of at most 255 UTF-8 bytes without separators or control characters.")
    return this.use("Folder creation was not confirmed. Browse the parent folder before retrying.", async (api, signal, revision, ensureCurrent) => {
      const target = path.join(parentDirectory, name)
      ensureCurrent("The backend connection changed before the folder was created.")
      await fs.mkdir(target, { recursive: false }).catch((error: unknown) => {
        const code = object(error) ? error.code : undefined
        throw new DesktopError(code === "EEXIST" ? "A folder or file with this name already exists. Choose another name." : code === "EACCES" || code === "EPERM" ? "This folder cannot be created. Check the parent folder's access permissions." : "This folder could not be created. Check the parent folder and try again.")
      })
      ensureCurrent("The folder was created, but the backend connection changed before registration. Browse and open the folder to register it.")
      return this.registerDirectory(api, signal, revision, target).catch(() => { throw new DesktopError("The folder was created, but registration failed. Browse and open the folder to register it.") })
    })
  }

  async integrations(input?: unknown): Promise<IntegrationsSnapshot> {
    const source = modelSource(input)
    return this.use("Integrations could not be read. Refresh to retry.", async (api, signal, revision) => {
      const location = await parityLocation(api, signal, source)
      const input = location ? { location } : undefined
      const [result, connections] = await Promise.all([
        api.integration.list(input, { signal }),
        api.provider.integrations(input, { signal }),
      ])
      const integrationIDs = new Set(catalogEnvelope(connections, location, "provider integrations").map((item) => {
        if (!object(item) || typeof item.integrationID !== "string") throw new DesktopError("The backend returned an invalid provider integration. Refresh to retry.")
        return item.integrationID
      }))
      const items = catalogEnvelope(result, location, "integration").map((item) => decodeIntegration(item)).filter((item) => integrationIDs.has(item.id)).map((item) => {
        const methods = item.methods.map((method) => {
          if (method.type === "command") return { type: method.type, id: method.id, label: method.label }
          if (method.type === "env") return { type: method.type, names: [...method.names] }
          if (method.type === "oauth") {
            const { prompts, ...rest } = method
            return { ...rest, ...(prompts ? { prompts: prompts.map((prompt) => prompt.type === "select" ? { ...prompt, options: [...prompt.options] } : prompt) } : {}) }
          }
          return method
        })
        return { id: item.id, name: item.name, methods, connections: [...item.connections] }
      })
      return { revision, source, items }
    })
  }

  async manageIntegration(input: unknown): Promise<IntegrationMutationResult> {
    const integrationID = idInput
    const attemptID = idInput
    const label = maybe(textInput)
    const request = mutation<IntegrationMutationInput>(input, {
      "connect-key": { integrationID, key: (value) => typeof value === "string" && value.trim().length > 0 && utf8Length(value) <= 65536, label },
      "oauth-start": { integrationID, methodID: idInput, inputs: maybe((value) => object(value) && Object.entries(value).every(([key, item]) => idInput(key) && typeof item === "string") && utf8Length(JSON.stringify(value)) <= 65536), label },
      "oauth-status": { integrationID, attemptID }, "oauth-complete": { integrationID, attemptID, code: maybe(textInput) }, "oauth-cancel": { integrationID, attemptID },
      "command-start": { integrationID, methodID: idInput, label }, "command-status": { integrationID, attemptID }, "command-cancel": { integrationID, attemptID },
      "wellknown-add": { url: textInput }, "credential-activate": { credentialID: idInput }, "credential-rename": { credentialID: idInput, label: textInput }, "credential-remove": { credentialID: idInput }, "credential-refresh": { credentialID: idInput },
    }, { source: () => true })
    const source = modelSource(request.source)
    if (request.kind === "wellknown-add") safeURL(request.url)
    const changed = "The integration change was not confirmed. Refresh connections before retrying."
    return this.use(changed, async (api, signal, revision, ensureCurrent) => {
      const location = await parityLocation(api, signal, source)
      const query = location ? { location } : {}
      ensureCurrent(changed)
      const options = { signal }
      switch (request.kind) {
        case "connect-key": await api.integration.connect.key({ ...query, integrationID: request.integrationID, key: request.key, ...(request.label === undefined ? {} : { label: request.label.trim() }) }, options); break
        case "oauth-start": return { revision, attempt: attemptResult((await api.integration.oauth.connect({ ...query, integrationID: request.integrationID, methodID: request.methodID, inputs: request.inputs ?? {}, ...(request.label === undefined ? {} : { label: request.label.trim() }) }, options)).data, "oauth") }
        case "oauth-status": return { revision, attempt: attemptResult((await api.integration.oauth.status({ ...query, integrationID: request.integrationID, attemptID: request.attemptID }, options)).data, "oauth", request.attemptID) }
        case "oauth-complete": await api.integration.oauth.complete({ ...query, integrationID: request.integrationID, attemptID: request.attemptID, ...(request.code === undefined ? {} : { code: request.code }) }, options); break
        case "oauth-cancel": await api.integration.oauth.cancel({ ...query, integrationID: request.integrationID, attemptID: request.attemptID }, options); break
        case "command-start": return { revision, attempt: attemptResult((await api.integration.command.connect({ ...query, integrationID: request.integrationID, methodID: request.methodID, ...(request.label === undefined ? {} : { label: request.label.trim() }) }, options)).data, "command") }
        case "command-status": return { revision, attempt: attemptResult((await api.integration.command.status({ ...query, integrationID: request.integrationID, attemptID: request.attemptID }, options)).data, "command", request.attemptID) }
        case "command-cancel": await api.integration.command.cancel({ ...query, integrationID: request.integrationID, attemptID: request.attemptID }, options); break
        case "wellknown-add": await api.integration.wellknown.add({ ...query, url: request.url }, options); break
        case "credential-activate": await api.credential.activate({ ...query, credentialID: request.credentialID }, options); break
        case "credential-rename": await api.credential.update({ ...query, credentialID: request.credentialID, label: request.label.trim() }, options); break
        case "credential-remove": await api.credential.remove({ ...query, credentialID: request.credentialID }, options); break
        case "credential-refresh": {
          const result = await api.credential.refresh({ ...query, credentialID: request.credentialID }, options)
          if (location && !sameModelLocation(result, location)) throw new DesktopError("The backend refreshed a credential for another folder. Refresh connections.")
          const outcome = result.data
          if (outcome.status === "refreshed" && count(outcome.expires)) return { revision, refresh: { status: "refreshed" as const, expires: outcome.expires } }
          if (outcome.status === "failed" && typeof outcome.message === "string") return { revision, refresh: { status: "failed" as const, message: outcome.message } }
          throw new DesktopError("The backend returned an invalid refresh result. Refresh connections.")
        }
      }
      return { revision }
    }, { revision: request.revision, changed })
  }

  async mcpServers(input?: unknown): Promise<McpSnapshot> {
    const source = modelSource(input)
    return this.use("MCP servers could not be read. Refresh to retry.", async (api, signal, revision) => {
      const location = await parityLocation(api, signal, source)
      const query = location ? { location } : undefined
      const [list, catalog] = await Promise.all([api.mcp.list(query, { signal }), api.mcp.resource.catalog(query, { signal }).catch(() => undefined)])
      const rows = catalogEnvelope(list, location, "MCP server")
      if (catalog !== undefined && (!sameModelLocation(catalog, location ?? { directory: catalog.location.directory }) || !object(catalog.data) || !Array.isArray(catalog.data.resources) || !Array.isArray(catalog.data.templates))) throw new DesktopError("The backend returned invalid MCP resources.")
      const resources = [...(catalog?.data.resources ?? []), ...(catalog?.data.templates ?? [])].map((resource): McpResource => {
        if (typeof resource.server !== "string" || typeof resource.name !== "string") throw new DesktopError("The backend returned an invalid MCP resource.")
        const raw: Record<string, unknown> = resource
        const projected = fields(raw, ["uri", "uriTemplate", "description", "mimeType"])
        if (!Object.values(projected).every(string)) throw new DesktopError("The backend returned an invalid MCP resource.")
        return { server: resource.server, name: resource.name, ...(typeof projected.uri === "string" ? { uri: projected.uri } : {}), ...(typeof projected.uriTemplate === "string" ? { uriTemplate: projected.uriTemplate } : {}), ...(typeof projected.description === "string" ? { description: projected.description } : {}), ...(typeof projected.mimeType === "string" ? { mimeType: projected.mimeType } : {}) }
      })
      const mcpStatus = (value: unknown): value is McpSnapshot["items"][number]["status"] => value === "connected" || value === "pending" || value === "disabled" || value === "failed" || value === "needs_auth" || value === "needs_client_registration"
      const items = rows.map((row) => {
        if (!object(row) || typeof row.name !== "string" || !object(row.status)) throw new DesktopError("The backend returned an invalid MCP server.")
        const status = row.status.status
        if (!mcpStatus(status)) throw new DesktopError("The backend returned an invalid MCP status.")
        if (!optional(row.status.error, string)) throw new DesktopError("The backend returned an invalid MCP error.")
        return { name: row.name, status, ...(typeof row.status.error === "string" ? { error: row.status.error } : {}), resources: resources.filter((resource) => resource.server === row.name) }
      })
      return { revision, source, items, resources, ...(catalog === undefined ? { resourcesNotice: "MCP resources could not be read. Server status is still available." } : {}) }
    })
  }

  async manageMcp(input: unknown): Promise<McpSnapshot> {
    const request = mutation<McpMutationInput>(input, { connect: {}, disconnect: {}, remove: {}, add: { config: object } }, { name: textInput, source: () => true })
    const source = modelSource(request.source)
    if (request.kind === "add") {
      if (request.config.type === "local") checkedObject(request.config, { type: (value) => value === "local", command: (value) => Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every(textInput), cwd: maybe(directoryInput), disabled: maybe(boolean) })
      else if (request.config.type === "remote") { checkedObject(request.config, { type: (value) => value === "remote", url: textInput, disabled: maybe(boolean) }); safeURL(request.config.url) }
      else throw new DesktopError("Choose a local command or an HTTPS MCP URL without secret headers.")
    }
    const changed = "The MCP change was not confirmed. Refresh servers before retrying."
    return this.use(changed, async (api, signal, _revision, ensureCurrent) => {
      const location = await parityLocation(api, signal, source)
      const query = { ...(location ? { location } : {}), server: request.name.trim() }
      ensureCurrent(changed)
      if (request.kind === "add") await api.mcp.add({ ...query, config: request.config }, { signal })
      if (request.kind === "connect") await api.mcp.connect(query, { signal })
      if (request.kind === "disconnect") await api.mcp.disconnect(query, { signal })
      if (request.kind === "remove") await api.mcp.remove(query, { signal })
      ensureCurrent(changed)
      return this.mcpServers(request.source)
    }, { revision: request.revision, changed })
  }

  async manageSession(input: unknown): Promise<SessionManageResult> {
    const request = mutation<SessionManageInput>(input, {
      rename: { title: textInput }, fork: { messageID: maybe((value) => typeof value === "string" && /^msg_[A-Za-z0-9_-]{1,124}$/.test(value)) }, archive: {}, unarchive: {}, delete: {}, background: {}, move: { directory: directoryInput }, daybreak: { daybreak: (value) => value === null || value === "daybreak_blue" || value === "daybreak_red" }, "cancel-subagent": { childSessionID: (value) => { session(value); return true } }, "kill-shell": { shellID: idInput }, "resolve-skill-conflict": { winner: idInput, loser: idInput },
      "answer-subagent": { childSessionID: (value) => { session(value); return true }, questionID: (value) => idInput(value) && prefix(value, "qst_"), text: (value) => nonempty(value) && boundedText(value, 65_536), data: maybe(answerData) },
    }, { sessionID: (value) => { session(value); return true } })
    const changed = "The Session change was not confirmed. Refresh the Session before retrying."
    return this.use(changed, async (api, signal, revision, ensureCurrent) => {
      const sessionID = request.sessionID
      const options = { signal }
      if (request.kind === "move") await existingDirectory(request.directory)
      ensureCurrent(changed)
      switch (request.kind) {
        case "rename": await api.session.rename({ sessionID, title: request.title.trim() }, options); break
        case "fork": {
          const item = await api.session.fork({ sessionID, ...(request.messageID === undefined ? {} : { messageID: request.messageID }) }, options)
          if (!object(item) || item.id === sessionID || item.parentID !== sessionID) throw new DesktopError("The backend returned a different fork. Check Sessions before retrying.")
          return { revision, sessionID, item: projectSessionRecord(item.id, item) }
        }
        case "archive": await api.session.archive({ sessionID }, options); break
        case "unarchive": await api.session.unarchive({ sessionID }, options); break
        case "delete": await api.session.remove({ sessionID }, options); break
        case "move": await api.session.move({ sessionID, directory: request.directory }, options); break
        case "daybreak": await api.session.daybreak.set({ sessionID, daybreak: request.daybreak }, options); break
        case "background": await api.session.background({ sessionID }, options); break
        case "cancel-subagent": await api.session.subagent.cancel({ parentID: sessionID, childID: request.childSessionID }, options); break
        case "resolve-skill-conflict": await api.session.resolveSkillConflict({ sessionID, winner: request.winner, loser: request.loser }, options); break
        case "answer-subagent": {
          let next: string | undefined
          let task: { readonly state: string; readonly question?: { readonly id: string } } | undefined
          for (let page = 0; page < 50 && task === undefined; page++) {
            const listed = await api.session.subagent.list({ parentID: sessionID, limit: 10, ...(next === undefined ? {} : { cursor: next }) }, options)
            if (!object(listed) || !Array.isArray(listed.data) || !listed.data.every((item) => taskValid(item, sessionID)) || !cursor(listed.cursor)) throw new DesktopError("The backend returned invalid subagents. Refresh and try again.")
            task = listed.data.find((item) => item.sessionID === request.childSessionID)
            next = typeof listed.cursor?.next === "string" ? listed.cursor.next : undefined
            if (next === undefined) break
          }
          if (task?.state !== "waiting" || task.question?.id !== request.questionID) throw new DesktopError("This question changed or was resolved. Refresh subagents; the answer was not sent.")
          ensureCurrent(changed)
          await api.session.subagent.answer({ parentID: sessionID, childID: request.childSessionID, questionID: request.questionID, text: request.text, ...(request.data === undefined ? {} : { data: JSON.parse(JSON.stringify(request.data)) }) }, options)
          break
        }
        case "kill-shell": {
          const { location } = await familyShell(api, signal, await api.session.get({ sessionID }, options), request.shellID)
          ensureCurrent(changed)
          await api.shell.remove({ id: request.shellID, location }, options)
          break
        }
      }
      return { revision, sessionID }
    }, { revision: request.revision, unsent: "The backend connection changed before the Session change was sent. Refresh the Session and try again.", changed })
  }

  async vcsDiff(input: unknown): Promise<VcsDiffSnapshot> {
    checkedObject(input, { source: () => true, mode: (value) => value === "git" || value === "branch" })
    const source = modelSource(input.source)
    const mode = input.mode === "branch" ? "branch" : "git"
    return this.use("Version-control changes could not be read. Refresh to retry.", async (api, signal, revision) => {
      const location = await parityLocation(api, signal, source)
      const query = location ? { location } : undefined
      const [branch, status, files] = await Promise.all([api.vcs.branch(query, { signal }), api.vcs.status(query, { signal }), api.vcs.diff({ ...query, mode: mode === "git" ? "working" : "branch" }, { signal })])
      if (location && [branch, status, files].some((result) => !sameModelLocation(result, location))) throw new DesktopError("The backend returned changes for another folder.")
      if (!object(branch.data) || !Object.values(fields(branch.data, ["current", "default"])).every(string) || !Array.isArray(status.data) || !Array.isArray(files.data)) throw new DesktopError("The backend returned invalid version-control data.")
      return { revision, source, mode, branch: fields(branch.data, ["current", "default"]), status: status.data.map((file) => {
        if (typeof file.file !== "string" || !count(file.additions) || !count(file.deletions) || !literal(file.status, ["added", "deleted", "modified"])) throw new DesktopError("The backend returned an invalid file status.")
        return fields(file, ["file", "additions", "deletions", "status"])
      }), files: files.data.map((file) => {
        if (typeof file.file !== "string" || typeof file.patch !== "string" || !count(file.additions) || !count(file.deletions) || !literal(file.status, ["added", "deleted", "modified"])) throw new DesktopError("The backend returned an invalid file diff.")
        return fields(file, ["file", "patch", "additions", "deletions", "status"])
      }) }
    })
  }

  async systemSnapshot(input?: unknown): Promise<SystemSnapshot> {
    if (input !== undefined) checkedObject(input, { sessionID: maybe((value) => { session(value); return true }), directory: maybe(directoryInput) })
    const requested: SystemInput = object(input) ? { ...(typeof input.sessionID === "string" ? { sessionID: input.sessionID } : {}), ...(typeof input.directory === "string" ? { directory: input.directory } : {}) } : {}
    return this.use("System status could not be read. Refresh to retry.", async (api, signal, revision) => {
      const source = modelSource(requested.sessionID ?? (requested.directory ? { directory: requested.directory } : undefined))
      const location = await parityLocation(api, signal, source)
      const query = location ? { location } : undefined
      const notices: Record<string, string> = {}
      const read = async <T,>(name: string, run: () => Promise<T>, project: (value: T) => DisplayValue) => {
        try { return project(await run()) }
        catch { notices[name] = `${name} could not be read. Refresh to retry.`; return undefined }
      }
      const rows = (value: unknown, keys: readonly string[]) => {
        if (!Array.isArray(value)) throw new Error("Invalid catalog")
        return value.map((row) => displayFields(row, keys))
      }
      const tabKeys = ["id", "sessionID", "title", "page", "status", "generation", "documentGeneration", "observationRevision", "pauseReason", "mode", "lease", "deliverable"]
      const reference = (row: unknown) => {
        if (!object(row) || !object(row.source) || !literal(row.source.type, ["local", "git"])) throw new Error("Invalid reference")
        const source = row.source.type === "git" ? { ...fields(row.source, ["type", "branch"]), repository: credentialFree(row.source.repository) } : fields(row.source, ["type", "path"])
        return displayValue({ ...fields(row, ["name", "path", "description", "hidden"]), source })
      }
      const [skills, sessionSkills, artifacts, plugins, remote, dots, server, browser, browserTabs, isolatedBrowser, isolatedBrowserTabs, configDiagnostics, providers, references] = await Promise.all([
        read("Skills", () => api.skill.list(query, { signal }), (result) => rows(catalogEnvelope(result, location, "skill"), ["id", "name", "description"])),
        requested.sessionID ? read("Session skills", () => api.session.skills({ sessionID: requested.sessionID! }, { signal }), (result) => rows(result, ["id", "name", "state", "inactiveReason", "activatedBy", "activationMessageID", "conflicts", "declarations"])) : undefined,
        read("Artifacts", () => api.projectArtifact.artifact.list({ ...query, scope: "project" }, { signal }), (result) => rows(result, ["scope", "kind", "id", "name", "description", "stage", "revision", "currentVersionID", "currentDigest", "lastUsedAt", "timeUpdated"])),
        read("Plugins", () => api.plugin.list(query, { signal }), (result) => rows(catalogEnvelope(result, location, "plugin"), ["id"])),
        read("Remote", () => api.remote.get({ signal }), (result) => displayFields(result, ["state", "message"])),
        read("Dots", () => api.dots.get({ signal }), (result) => displayFields(result, ["access", "configuration", "connection", "computer"])),
        read("Server", () => api.server.get({ signal }), (result) => ({ urls: result.urls.flatMap((value) => { try { return [safeURL(value, ["http:", "https:"])] } catch { return [] } }) })),
        requested.sessionID ? read("Browser", () => api.browser.status({ sessionID: requested.sessionID! }, { signal }), (result) => displayFields(result, ["state", "paired", "profileGranted", "generation", "pairingExpiresAt", "extensionID", "pendingCallID"])) : undefined,
        requested.sessionID ? read("Browser tabs", () => api.browser.tabs({ sessionID: requested.sessionID! }, { signal }), (result) => rows(result, tabKeys)) : undefined,
        requested.sessionID ? read("Isolated browser", () => api.isolatedBrowser.status({ sessionID: requested.sessionID! }, { signal }), (result) => displayFields(result, ["mode", "state", "reason", "instanceID", "tab"])) : undefined,
        requested.sessionID ? read("Isolated browser tabs", () => api.isolatedBrowser.tabs({ sessionID: requested.sessionID! }, { signal }), (result) => rows(result, tabKeys)) : undefined,
        read("Config diagnostics", () => api.config.diagnostics(query, { signal }), (result) => rows(catalogEnvelope(result, location, "config diagnostic"), ["path", "reason", "jsonPath", "failClosed", "message"])),
        read("Providers", () => api.provider.list(query, { signal }), (result) => rows(catalogEnvelope(result, location, "provider"), ["id", "name", "integrationID", "disabled", "package"])),
        read("References", () => api.reference.list(query, { signal }), (result) => catalogEnvelope(result, location, "reference").map(reference)),
      ])
      return { revision, connection: { ...this.state() }, ...(requested.sessionID ? { sessionID: requested.sessionID } : {}), ...(location?.directory ? { directory: location.directory } : {}), ...(skills === undefined ? {} : { skills }), ...(sessionSkills === undefined ? {} : { sessionSkills }), ...(artifacts === undefined ? {} : { artifacts }), ...(plugins === undefined ? {} : { plugins }), ...(remote === undefined ? {} : { remote }), ...(dots === undefined ? {} : { dots }), ...(server === undefined ? {} : { server: server as { urls: string[] } }), ...(browser === undefined ? {} : { browser }), ...(browserTabs === undefined ? {} : { browserTabs }), ...(isolatedBrowser === undefined ? {} : { isolatedBrowser }), ...(isolatedBrowserTabs === undefined ? {} : { isolatedBrowserTabs }), ...(configDiagnostics === undefined ? {} : { configDiagnostics }), ...(providers === undefined ? {} : { providers }), ...(references === undefined ? {} : { references }), notices }
    })
  }

  async manageSystem(input: unknown): Promise<SystemSnapshot> {
    const request = mutation<SystemManageInput>(input, {
      "browser-start": {}, "browser-forget": {}, "isolated-browser-start": { url: textInput }, "isolated-browser-stop": {},
      "artifact-enable": { artifact: object }, "artifact-disable": { artifact: object }, "remote-set": { enabled: boolean },
      "isolated-browser-pause": {}, "isolated-browser-resume": {}, "dots-set": { enabled: boolean, expectedRevision: isRevision }, "dots-attach": { replaceOthers: boolean, expectedTarget: maybe(dotsTarget) }, "dots-detach": { expectedTarget: maybe(dotsTarget) },
    }, { sessionID: maybe((value) => { session(value); return true }), directory: maybe(directoryInput) })
    if ((request.kind.startsWith("browser-") || request.kind.startsWith("isolated-browser-")) && request.sessionID === undefined) throw new DesktopError("Choose a Session before managing a browser.")
    if (request.kind === "artifact-enable" || request.kind === "artifact-disable") checkedObject(request.artifact, { scope: (value) => value === "project" || value === "global", kind: (value) => literal(value, ["skill", "command", "agent", "plugin"]), id: idInput, expectedRevision: isRevision, expectedVersionID: idInput, expectedDigest: (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) })
    if (request.kind === "isolated-browser-start") safeURL(request.url, ["http:", "https:"])
    const changed = "The system change was not confirmed. Refresh status before retrying."
    return this.use(changed, async (api, signal, _revision, ensureCurrent) => {
      const location = await parityLocation(api, signal, modelSource(request.sessionID ?? (request.directory ? { directory: request.directory } : undefined)))
      const options = { signal }
      const sessionID = request.sessionID!
      let pairing: SystemSnapshot["pairing"]
      ensureCurrent(changed)
      switch (request.kind) {
        case "browser-start": {
          const result = await api.browser.start({ sessionID }, options)
          if (typeof result.secret !== "string" || !count(result.expiresAt)) throw new DesktopError("The backend returned invalid pairing information.")
          pairing = { secret: result.secret, expiresAt: result.expiresAt }
          break
        }
        case "browser-forget": await api.browser.forget({ sessionID }, options); break
        case "isolated-browser-start": await api.isolatedBrowser.start({ sessionID, url: request.url }, options); break
        case "isolated-browser-stop": await api.isolatedBrowser.stop({ sessionID }, options); break
        case "artifact-enable": await api.projectArtifact.artifact.enable({ ...(location ? { location } : {}), ...request.artifact }, options); break
        case "artifact-disable": await api.projectArtifact.artifact.disable({ ...(location ? { location } : {}), ...request.artifact }, options); break
        case "remote-set": await api.remote.set({ enabled: request.enabled }, options); break
        case "isolated-browser-pause":
        case "isolated-browser-resume": {
          const pause = request.kind === "isolated-browser-pause"
          const status = await api.isolatedBrowser.status({ sessionID }, options)
          if (status.state !== (pause ? "ready" : "paused")) throw new DesktopError(`The isolated browser is ${status.state}. Refresh status before retrying.`)
          ensureCurrent(changed)
          await api.isolatedBrowser.control({ sessionID, action: pause ? "pause" : "resume" }, options)
          break
        }
        case "dots-set": {
          const status = await api.dots.get(options)
          if (status.access.revision !== request.expectedRevision) throw new DesktopError("Dots access changed. Refresh status before retrying.")
          if (status.access.enabled === request.enabled) break
          if (request.enabled && !status.configuration.ready) throw new DesktopError("Dots is not configured on this computer.")
          ensureCurrent(changed)
          await api.dots.set({ enabled: request.enabled, expectedRevision: request.expectedRevision }, options)
          break
        }
        case "dots-attach":
        case "dots-detach": {
          const attach = request.kind === "dots-attach"
          const status = await api.dots.get(options)
          const expectedTarget: DotsTarget | undefined = request.expectedTarget
          const computer = status.computer
          if (!status.access.enabled || !computer || computer.state !== (attach ? "detached" : "attached") || !sameTarget(computer.target, expectedTarget)) throw new DesktopError("The Dots computer changed. Refresh status before retrying.")
          ensureCurrent(changed)
          if (request.kind === "dots-attach") await api.dots.attach({ replaceOthers: request.replaceOthers, ...(expectedTarget === undefined ? {} : { expectedTarget }) }, options)
          else await api.dots.detach(expectedTarget === undefined ? {} : { expectedTarget }, options)
          break
        }
      }
      ensureCurrent(changed)
      const snapshot = await this.systemSnapshot({ ...(request.sessionID ? { sessionID: request.sessionID } : {}), ...(request.directory ? { directory: request.directory } : {}) })
      return { ...snapshot, ...(pairing ? { pairing } : {}) }
    }, { revision: request.revision, changed })
  }

  async projects(input?: unknown) {
    if (input !== undefined) checkedObject(input, { cursor: maybe((value) => typeof value === "string" && value.length > 0 && utf8Length(value) <= 4096), revision: maybe(isRevision), search: maybe((value) => typeof value === "string" && utf8Length(value.trim()) <= 256) }, "Invalid page request.")
    const requested = pageInput(object(input) ? { ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(input.revision === undefined ? {} : { revision: input.revision }) } : undefined)
    const search = object(input) && typeof input.search === "string" ? input.search.trim() || undefined : undefined
    return this.use("Projects could not be read. Refresh to retry.", async (api, signal, revision) => {
      const [list, settings, inventory] = await Promise.all([api.coordination.list({ signal }), api.coordination.settings({ signal }), api.project.inventory({ limit: 50, ...(requested.cursor === undefined ? {} : { cursor: requested.cursor }), ...(search === undefined ? {} : { search }) }, { signal })])
      if (!Array.isArray(list) || !list.every((group) => object(group) && groupID(group.id)) || !object(settings) || typeof settings.enabled !== "boolean" || !decisions(settings) ||
        !object(inventory) || !Array.isArray(inventory.data) || !inventory.data.every((entry) => object(entry) && typeof entry.projectID === "string" && typeof entry.projectWorktree === "string" && typeof entry.directory === "string" && optional(entry.projectName, string) && optional(entry.strategy, string) && count(entry.sessions) && count(entry.timeActive) && typeof entry.available === "boolean") || !cursor(inventory.cursor)) throw new Error("Invalid projects")
      const groups = await Promise.all(list.map((group) => api.coordination.get({ groupID: group.id }, { signal })))
      if (!groups.every((group, index) => object(group) && group.id === list[index]?.id && typeof group.name === "string" && count(group.revision) && typeof group.active === "boolean" && optional(group.pausedReason, (value) => literal(value, ["interrupted", "restart"])) && participant(group.master) && Array.isArray(group.members) && group.members.every(participant) && groupSettings(group.settings) && times(group.time))) throw new Error("Invalid coordination group")
      const projectParticipant = (entry: typeof groups[number]["master"]) => ({ ...fields(entry, ["sessionID", "title", "state", "lastActivity"]), location: fields(entry.location, ["directory", "workspaceID"]), pending: entry.pending.map((request) => fields(request, ["kind", "requestID", "fingerprint", "summary"])), ...(entry.drivenBy ? { drivenBy: fields(entry.drivenBy, ["sessionID", "title"]) } : {}), ...(entry.owner ? { owner: fields(entry.owner, ["sessionID", "title"]) } : {}) })
      const projected = groups.map((group) => ({ ...fields(group, ["id", "name", "revision", "active", "pausedReason"]), master: projectParticipant(group.master), members: group.members.map(projectParticipant), settings: { ...fields(group.settings, ["concurrency"]), ...(group.settings.delegatedDecisions ? { delegatedDecisions: fields(group.settings.delegatedDecisions, ["categories", "actions", "resources", "expiresAt"]) } : {}) }, time: fields(group.time, ["created", "updated"]) }))
      return { revision, settings: fields(settings, ["enabled", "categories", "actions", "resources", "expiresAt"]), groups: projected, repositories: inventory.data.map((entry) => ({ ...fields(entry, ["projectID", "projectName", "projectWorktree", "directory", "strategy", "sessions", "timeActive", "available"]), ...(entry.projectWorktree === path.parse(entry.directory).root ? { projectWorktree: entry.directory } : {}) })), ...(typeof inventory.cursor?.next === "string" ? { repositoriesNext: inventory.cursor.next } : {}) }
    }, { revision: requested.revision })
  }

  async workspaceDirectories(input: unknown) {
    const request = directoriesInput(input)
    return this.use("Project directories could not be read. Refresh to retry.", async (api, signal, revision) => {
      const directories = await api.project.directories({ projectID: request.projectID, ...(request.directory === undefined ? {} : { location: { directory: request.directory } }) }, { signal })
      if (!Array.isArray(directories) || !directories.every((entry) => object(entry) && string(entry.directory) && optional(entry.strategy, string))) throw new Error("Invalid directories")
      return { revision, projectID: request.projectID, directories: directories.map((entry) => ({ directory: entry.directory, ...(entry.strategy === undefined ? {} : { kind: entry.strategy }) })) }
    })
  }

  async settings() {
    return this.use("Settings could not be read. Refresh to retry.", async (api, signal, revision, ensureCurrent) => {
      const [awake, consent, permissions] = await Promise.all([api.keepAwake.get({ signal }), api.server.telemetry.consent.get({ signal }), api.permission.saved.list({}, { signal })])
      const keepAwake = decodeKeepAwake(awake)
      const telemetryConsent = decodeConsentState(consent)
      const savedPermissions = decodePermissions(permissions)
      let telemetrySamples: ReturnType<typeof decodeSamples>["data"] = []
      let telemetryNotice: string | undefined
      if (telemetryConsent.consent?.enabled) {
        const page = await api.server.telemetry.list({ limit: 10 }, { signal: AbortSignal.any([signal, AbortSignal.timeout(TELEMETRY_READ_MS)]) }).catch(() => undefined)
        ensureCurrent("The backend connection changed before settings were read.")
        if (page === undefined) telemetryNotice = "Telemetry samples could not be read."
        else telemetrySamples = decodeSamples(page).data
      }
      return { revision, keepAwake, telemetryConsent, telemetrySamples: [...telemetrySamples], savedPermissions: [...savedPermissions], ...(telemetryNotice ? { telemetryNotice } : {}) }
    })
  }

  async changeSettings(input: unknown) {
    if (!object(input) || !isRevision(input.revision)) throw new DesktopError("Invalid settings change.")
    const allowed = input.kind === "keep-awake" ? ["kind", "revision", "enabled"] : input.kind === "telemetry-consent" ? ["kind", "revision", "enabled", "noticeVersion"] : input.kind === "remove-saved-permission" ? ["kind", "revision", "id"] : []
    if (!allowed.length || Object.keys(input).some((key) => !allowed.includes(key))) throw new DesktopError("Invalid settings change.")
    if ((input.kind === "keep-awake" || input.kind === "telemetry-consent") && typeof input.enabled !== "boolean") throw new DesktopError("Invalid settings change.")
    if (input.kind === "telemetry-consent" && input.noticeVersion !== undefined && input.noticeVersion !== 1) throw new DesktopError("Invalid settings change.")
    if (input.kind === "remove-saved-permission") {
      if (typeof input.id !== "string" || !input.id.trim() || utf8Length(input.id) > 1024) throw new DesktopError("Invalid settings change.")
      try { decodePermissionID(input.id) } catch { throw new DesktopError("Invalid settings change.") }
    }
    const revision = input.revision
    const changed = "The settings change was not confirmed. Refresh settings before retrying."
    return this.use(changed, async (api, signal, _revision, ensureCurrent) => {
      ensureCurrent(changed)
      if (input.kind === "keep-awake" && typeof input.enabled === "boolean") {
        const result = decodeKeepAwake(await api.keepAwake.set({ enabled: input.enabled }, { signal }))
        if (result.state !== "unsupported" && (result.state === "error" || (result.manual === undefined ? result.state !== (input.enabled ? "on" : "off") : result.manual !== input.enabled))) throw new DesktopError(changed)
      } else if (input.kind === "telemetry-consent" && typeof input.enabled === "boolean") {
        const result = decodeConsent(await api.server.telemetry.consent.set({ enabled: input.enabled, noticeVersion: 1 }, { signal }))
        if (result.enabled !== input.enabled || result.noticeVersion !== 1) throw new DesktopError(changed)
      } else if (input.kind === "remove-saved-permission" && typeof input.id === "string") await api.permission.saved.remove({ id: input.id }, { signal })
      else throw new DesktopError("Invalid settings change.")
      ensureCurrent(changed)
      return this.settings()
    }, { revision, unsent: "Settings are out of date. Refresh before changing them.", changed })
  }

  async changeProject(input: unknown) {
    if (!object(input) || !isRevision(input.revision)) throw new DesktopError("Invalid project change.")
    if (input.kind === "create-in-directory") {
      checkedObject(input, { kind: string, revision: isRevision, name: (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120, directory: string, masterTitle: maybe((value) => typeof value === "string" && utf8Length(value) <= 4096), memberSessionIDs: (value) => Array.isArray(value) && value.every((id) => { session(id); return true }) }, "Invalid project change.")
      const name = String(input.name).trim()
      const title = typeof input.masterTitle === "string" ? input.masterTitle.trim() || name : name
      const memberSessionIDs = decodeProjectMembers(input.memberSessionIDs)
      decodeProjectName(name)
      const revision = input.revision as number
      const changed = "Project creation was not confirmed. Refresh Sessions and Projects before retrying."
      return this.use(changed, async (api, signal, _revision, ensureCurrent) => {
        const directory = projectDirectory(input.directory)
        const created = await api.session.create({ location: { directory }, title }, { signal })
        if (typeof created.id !== "string" || !sessionID(created.id)) throw new DesktopError(changed)
        try {
          if (typeof created.location.directory !== "string" || created.scope === "standalone") throw new DesktopError("The backend returned an invalid Session placement")
          ensureCurrent("The backend connection changed")
          decodeGroup(await api.coordination.create({ name, masterSessionID: created.id, memberSessionIDs }, { signal }))
        } catch (error) {
          const reason = error instanceof DesktopError ? error.message : "the backend did not confirm the coordination group"
          throw new DesktopError(`Master Session ${created.id} was created, but Project creation failed: ${reason}. Choose Existing Session to reuse it.`)
        }
        ensureCurrent(changed)
        return this.projects()
      }, { revision, changed })
    }
    if (input.kind === "attach-member" || input.kind === "detach-member") {
      const attach = input.kind === "attach-member"
      checkedObject(input, { kind: string, revision: isRevision, groupID, sessionID: (value) => { session(value); return true }, ...(attach ? { ownerSessionID: maybe((value) => { session(value); return true }) } : {}) }, "Invalid project change.")
      const target = decodeGroupID(input.groupID)
      const member = String(input.sessionID)
      const changed = attach ? "Member attachment was not confirmed. Refresh Projects before retrying." : "Member removal was not confirmed. Refresh Projects before retrying."
      return this.use(changed, async (api, signal, _revision, ensureCurrent) => {
        ensureCurrent(changed)
        if (attach) {
          const result = await api.coordination.attach({ groupID: target, sessionID: member, ...(input.ownerSessionID === undefined ? {} : { ownerSessionID: String(input.ownerSessionID) }) }, { signal })
          if (result.groupID !== target || result.sessionID !== member) throw new DesktopError(changed)
        } else {
          const result = await api.coordination.detach({ groupID: target, sessionID: member }, { signal })
          if (result.sessionID !== member || result.removed !== true) throw new DesktopError(changed)
        }
        ensureCurrent(changed)
        return this.projects()
      }, { revision: input.revision as number, unsent: "Projects are out of date. Refresh before changing them.", changed })
    }
    if (input.kind === "new-member" || input.kind === "delete-member") {
      const member = input.kind === "new-member"
      checkedObject(input, member
        ? { kind: string, revision: isRevision, groupID, groupRevision: isRevision, directory: string, title: maybe((value) => typeof value === "string" && utf8Length(value) <= 4096) }
        : { kind: string, revision: isRevision, groupID, groupRevision: isRevision, sessionID: (value) => { session(value); return true } }, "Invalid project change.")
      const target = decodeGroupID(input.groupID)
      const expected = input.groupRevision
      const title = typeof input.title === "string" ? input.title.trim() : ""
      const changed = member ? "Member creation was not confirmed. Refresh Sessions and Projects before retrying." : "Member deletion was not confirmed. Refresh Projects before retrying."
      return this.use(changed, async (api, signal, _revision, ensureCurrent) => {
        const current = decodeGroup(await api.coordination.get({ groupID: target }, { signal }))
        if (current.id !== target || current.revision !== expected) throw new DesktopError("The project changed. Refresh projects before retrying.")
        const members: string[] = current.members.map((entry) => entry.sessionID)
        if (!member) {
          if (!members.includes(String(input.sessionID))) throw new DesktopError("Only a member Session can be deleted from its Project.")
          ensureCurrent(changed)
          await api.session.remove({ sessionID: String(input.sessionID) }, { signal })
          ensureCurrent(changed)
          return this.projects()
        }
        const directory = projectDirectory(input.directory)
        const created = await api.session.create({ location: { directory }, ...(title ? { title } : {}) }, { signal })
        if (typeof created.id !== "string" || !sessionID(created.id)) throw new DesktopError(changed)
        try {
          if (typeof created.location.directory !== "string" || created.scope === "standalone") throw new DesktopError("the backend returned an invalid Session placement")
          ensureCurrent("the backend connection changed")
          const attached = await api.coordination.attach({ groupID: target, sessionID: created.id }, { signal })
          if (attached.groupID !== target || attached.sessionID !== created.id) throw new DesktopError("the backend did not confirm the membership")
        } catch (error) {
          const reason = error instanceof DesktopError ? error.message : "the backend did not confirm the membership"
          throw new DesktopError(`Session created: ${created.id}. Project membership not confirmed: ${reason}. Add the existing Session instead of creating another.`)
        }
        ensureCurrent(changed)
        return this.projects()
      }, { revision: input.revision as number, unsent: "Projects are out of date. Refresh before changing them.", changed })
    }
    const allowed = input.kind === "create" ? ["kind", "revision", "name", "masterSessionID", "memberSessionIDs"] : input.kind === "update" ? ["kind", "revision", "groupID", "groupRevision", "concurrency", "delegatedDecisions", "name", "masterSessionID", "memberSessionIDs"] : input.kind === "delete" ? ["kind", "revision", "groupID"] : []
    if (!allowed.length || Object.keys(input).some((key) => !allowed.includes(key))) throw new DesktopError("Invalid project change.")
    const revision = input.revision
    let id: ReturnType<typeof decodeGroupID> | undefined
    let create: ReturnType<typeof decodeCreate> | undefined
    let update: ReturnType<typeof decodeUpdate> | undefined
    try {
      if (input.kind !== "create") id = decodeGroupID(input.groupID)
      if (input.kind !== "delete") {
        const name = typeof input.name === "string" ? input.name.trim() : input.name
        if (input.masterSessionID !== undefined) session(input.masterSessionID)
        if (Array.isArray(input.memberSessionIDs)) input.memberSessionIDs.forEach(session)
        if (input.kind === "create") create = decodeCreate({ name, masterSessionID: input.masterSessionID, memberSessionIDs: input.memberSessionIDs })
        else update = decodeUpdate({ revision: input.groupRevision, ...(input.name === undefined ? {} : { name }), ...(input.masterSessionID === undefined ? {} : { masterSessionID: input.masterSessionID }), ...(input.memberSessionIDs === undefined ? {} : { memberSessionIDs: input.memberSessionIDs }), ...(input.concurrency === undefined && input.delegatedDecisions === undefined ? {} : { settings: { concurrency: input.concurrency ?? null, ...(input.delegatedDecisions === undefined ? {} : { delegatedDecisions: input.delegatedDecisions }) } }) })
      }
    } catch { throw new DesktopError("Invalid project change.") }
    const changed = "The project change was not confirmed. Refresh projects before retrying."
    return this.use(changed, async (api, signal, _revision, ensureCurrent) => {
      if (create) {
        ensureCurrent(changed)
        decodeGroup(await api.coordination.create(create, { signal }))
      } else if (id && update) {
        let payload = update
        if (update.settings) {
          const current = decodeGroup(await api.coordination.get({ groupID: id }, { signal }))
          if (current.id !== id || current.revision !== update.revision) throw new DesktopError("The project changed. Refresh projects before retrying.")
          payload = { ...update, settings: { ...current.settings, ...(input.concurrency === undefined ? {} : { concurrency: update.settings.concurrency }), ...(input.delegatedDecisions === undefined ? {} : { delegatedDecisions: update.settings.delegatedDecisions }) } }
        }
        ensureCurrent(changed)
        const result = decodeGroup(await api.coordination.update({ groupID: id, ...payload }, { signal }))
        if (result.id !== id) throw new DesktopError(changed)
      } else if (id && input.kind === "delete") {
        ensureCurrent(changed)
        await api.coordination.delete({ groupID: id }, { signal })
      } else throw new DesktopError("Invalid project change.")
      ensureCurrent(changed)
      return this.projects()
    }, { revision, unsent: "Projects are out of date. Refresh before changing them.", changed })
  }

  async changeWorkspace(input: unknown) {
    if (!object(input) || !isRevision(input.revision)) throw new DesktopError("Invalid workspace change.")
    const allowed = input.kind === "create-copy" ? ["kind", "revision", "projectID", "sourceDirectory", "directory", "strategy", "name"] : input.kind === "refresh-copies" || input.kind === "forget" ? ["kind", "revision", "projectID", "directory"] : []
    if (!allowed.length || Object.keys(input).some((key) => !allowed.includes(key)) || typeof input.projectID !== "string" || !input.projectID || typeof input.directory !== "string" || !path.isAbsolute(input.directory)) throw new DesktopError("Invalid workspace change.")
    const revision = input.revision
    let projectID: ReturnType<typeof decodeProjectID>
    let copy: ReturnType<typeof decodeCopyInput> | undefined
    try {
      projectID = decodeProjectID(input.projectID)
      if (input.kind === "create-copy") {
        if (typeof input.sourceDirectory !== "string" || !path.isAbsolute(input.sourceDirectory)) throw new Error("Invalid source")
        copy = decodeCopyInput({ projectID, sourceDirectory: input.sourceDirectory, directory: input.directory, strategy: input.strategy ?? "git_worktree", ...(input.name === undefined ? {} : { name: input.name }) })
      }
    } catch { throw new DesktopError("Invalid workspace change.") }
    const directory = input.directory
    const changed = "The workspace change was not confirmed. Refresh workspaces before retrying."
    return this.use(changed, async (api, signal, _revision, ensureCurrent) => {
      ensureCurrent(changed)
      if (copy) {
        decodeCopy(await api.projectCopy.create({ projectID, location: { directory: copy.sourceDirectory }, strategy: copy.strategy, directory: copy.directory, ...(copy.name ? { name: copy.name } : {}) }, { signal }))
      } else if (input.kind === "refresh-copies") await api.projectCopy.refresh({ projectID, location: { directory } }, { signal })
      else if (input.kind === "forget") {
        await api.project.forget({ projectID, directory }, { signal })
        ensureCurrent(changed)
        return null
      } else throw new DesktopError("Invalid workspace change.")
      ensureCurrent(changed)
      return this.workspaceDirectories({ projectID, directory: copy?.sourceDirectory ?? directory })
    }, { revision, unsent: "Workspaces are out of date. Refresh before changing them.", changed })
  }

  async usage(input?: unknown) {
    const range = usageInput(input)
    const now = Date.now()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const period = range === "all" ? {} : { from: range === "today" ? start.getTime() : now - (range === "7d" ? 7 : 30) * 86_400_000, to: now }
    return this.use("Usage could not be read. Refresh to retry.", async (api, signal, revision) => {
      const [summary, report, quotaResult] = await Promise.all([api.usage.get({ signal }), api.usage.report({ group: "model", limit: 25, sort: "cost", order: "desc", ...period }, { signal }), api.providerUsage.list(undefined, { signal }).catch(() => undefined)])
      if (!summaryValid(summary) || !object(report) || report.group !== "model" || !Array.isArray(report.rows) || !report.rows.every((row) => reportMetrics(row) && typeof row.key === "string" && typeof row.label === "string" && optional(row.model, ref) && optional(row.dimensions, dimensions) && optional(row.speed, speed) && optional(row.concurrency, amount)) || !reportMetrics(report.total) || !count(report.rowCount) || (report.nextOffset !== undefined && !count(report.nextOffset)) || !optional(report.speed, speed)) throw new Error("Invalid usage")
      const projectTokens = (value: typeof summary.tokens) => ({ ...fields(value, ["input", "output", "reasoning"]), cache: fields(value.cache, ["read", "write"]) })
      const projectSpeed = (value: NonNullable<typeof report.speed>) => fields(value, [...speedCounts, ...speedValues])
      const projectMetrics = (value: typeof report.total) => ({ ...fields(value, ["logical", "physical", "helpers", "continued", "fallback", "cost", "costProvenance", "cacheReadReported"]), tokens: projectTokens(value.tokens), ...(value.costCoverage ? { costCoverage: fields(value.costCoverage, ["pricedRequests", "unpricedRequests"]) } : {}), ...(value.outcomes ? { outcomes: fields(value.outcomes, ["completed", "failed", "cancelled"]) } : {}) })
      const projectDimensions = (value: NonNullable<typeof report.rows[number]["dimensions"]>) => {
        const keys = { provider: ["group", "providerID"], "provider-model": ["group", "providerID", "modelID"], "model-id": ["group", "modelID"], profile: ["group", "providerID", "profile", "profileState"], "provider-profile-model": ["group", "providerID", "profile", "profileState", "modelID"], task: ["group", "sessionID", "attribution"], prompt: ["group", "attribution"] }
        return { ...fields(value, keys[value.group]), ...(value.group === "prompt" && value.anchor ? { anchor: fields(value.anchor, ["sessionID", "inputID"]) } : {}) }
      }
      const projectedSummary = { ...fields(summary, ["logical", "physical", "helpers", "continued", "fallback", "cacheReadReported", "cost", "latestInvalidation", "latestNamespace"]), tokens: projectTokens(summary.tokens), ...(summary.models ? { models: summary.models.map((model) => ({ ...fields(model, ["requests", "cacheReadReported", "cost", "costProvenance"]), model: fields(model.model, ["id", "providerID", "variant", "profile"]), tokens: projectTokens(model.tokens) })) } : {}), ...(summary.latestTiming ? { latestTiming: { ...fields(summary.latestTiming, timingKeys), ...(summary.latestTiming.receivedOutput ? { receivedOutput: fields(summary.latestTiming.receivedOutput, ["estimatedTokens", "durationNs"]) } : {}) } } : {}) }
      const rows = report.rows.map((row) => ({ ...projectMetrics(row), ...fields(row, ["key", "label", "concurrency"]), ...(row.model ? { model: fields(row.model, ["id", "providerID", "variant", "profile"]) } : {}), ...(row.dimensions ? { dimensions: projectDimensions(row.dimensions) } : {}), ...(row.speed ? { speed: projectSpeed(row.speed) } : {}) }))
      if (quotaResult !== undefined && (!object(quotaResult) || !Array.isArray(quotaResult.data) || !quotaResult.data.every(quota))) throw new Error("Invalid quota snapshots")
      const quotas = quotaResult?.data.map((snapshot) => ({ ...fields(snapshot, ["providerID", "label", "profile", "status", "source", "stability", "updatedAt", "message"]), windows: snapshot.windows.map((window) => fields(window, ["id", "label", "group", "unit", "used", "limit", "remaining", "unlimited", "resetAt", "periodSeconds"])) })) ?? []
      return { revision, range, quotas, ...(quotaResult === undefined ? { quotasNotice: "Provider quotas could not be read." } : {}), summary: projectedSummary, report: { ...fields(report, ["group", "rowCount", "nextOffset"]), rows, total: projectMetrics(report.total), ...(report.speed ? { speed: projectSpeed(report.speed) } : {}) }, hasMoreModels: report.nextOffset !== undefined }
    })
  }

  async usageDashboard(input?: unknown): Promise<UsageDashboard> {
    const request = usageDashboardInput(input)
    return this.use("The usage dashboard could not be read. Refresh to retry.", async (api, signal, revision) => {
      const info = await api.usage.dashboard(request, { signal })
      if (!object(info) || !literal(info.status, ["preparing", "error", "ready"])) throw new DesktopError("The backend returned an invalid usage dashboard. Refresh to retry.")
      return { revision, dashboard: displayValue(info, reportHiddenFields) }
    })
  }

  async incidents(input: unknown): Promise<Incidents> {
    const request = incidentsInput(input)
    return this.use("Model incidents could not be read. Refresh to retry.", async (api, signal, revision) => {
      const { kind, ...query } = request
      const data = request.kind === "report" ? await api.incident.report(query as Omit<typeof request, "kind">, { signal })
        : request.kind === "recent" ? await api.incident.recent(query as Omit<typeof request, "kind">, { signal })
        : await api.incident.guidance.get({ provider: request.provider, model: request.model, ...(await this.artifactLocation(api, signal, modelSource(request.source))) }, { signal })
      if (!object(data)) throw new DesktopError("The backend returned invalid model incidents. Refresh to retry.")
      return { revision, kind, data: displayValue(data, reportHiddenFields) }
    })
  }

  async manageIncident(input: unknown): Promise<Incidents> {
    const request = incidentMutationInput(input)
    const changed = "The incident guidance change was not confirmed. Refresh incidents before retrying."
    return this.use(changed, async (api, signal, revision, ensureCurrent) => {
      const location = await this.artifactLocation(api, signal, modelSource(request.source))
      ensureCurrent("The backend connection changed before the incident guidance was cleared. Refresh incidents and try again.")
      const data = await api.incident.guidance.clear({ provider: request.provider, model: request.model, ...location }, { signal })
      if (!object(data)) throw new DesktopError(changed)
      return { revision, kind: "guidance" as const, data: displayValue(data, reportHiddenFields) }
    }, { revision: request.revision, unsent: "The backend connection changed before the incident guidance was cleared. Refresh incidents and try again.", changed })
  }

  async appendTelemetry(input: unknown) {
    let batch: Telemetry.Batch
    try { batch = decodeBatch(input) } catch { throw new DesktopError("Invalid telemetry samples.") }
    return this.use("Telemetry samples were not confirmed.", async (api, signal) => {
      const result = await api.server.telemetry.append(batch, { signal: AbortSignal.any([signal, AbortSignal.timeout(TELEMETRY_WRITE_MS)]) })
      if (!object(result) || !count(result.accepted)) throw new DesktopError("The backend returned an invalid telemetry receipt.")
      return { accepted: result.accepted }
    })
  }

  async telemetryConsent(): Promise<TelemetryConsentSnapshot> {
    return this.use("Telemetry consent could not be read. Refresh to retry.", async (api, signal, revision) => {
      const consent = await api.server.telemetry.consent.get({ signal })
      try { return { revision, state: decodeConsentState(consent) } }
      catch { throw new DesktopError("The backend returned invalid telemetry consent. Refresh to retry.") }
    })
  }

  async revert(input: unknown) {
    const request = revertInput(input)
    const failure = "The revert result was not confirmed. Refresh the Session before retrying."
    return this.use(failure, async (api, signal, _revision, ensureCurrent) => {
      ensureCurrent("The backend connection changed before revert was sent.")
      if (request.action === "stage") {
        const result = await api.session.revert.stage({ sessionID: request.sessionID, messageID: request.messageID, ...(request.files === undefined ? {} : { files: request.files }) }, { signal })
        if (!object(result) || result.messageID !== request.messageID || !optional(result.snapshot, string) || (result.files !== undefined && (!Array.isArray(result.files) || !result.files.every((file) => object(file) && string(file.file) && string(file.patch) && count(file.additions) && count(file.deletions) && literal(file.status, ["added", "deleted", "modified"]))))) throw new Error("Invalid staged revert")
        return { messageID: result.messageID, ...(result.snapshot === undefined ? {} : { snapshot: result.snapshot }), ...(result.files === undefined ? {} : { files: result.files.map((file) => fields(file, ["file", "patch", "additions", "deletions", "status"])) }) }
      }
      if (request.action === "commit") await api.session.revert.commit({ sessionID: request.sessionID }, { signal })
      else await api.session.revert.clear({ sessionID: request.sessionID }, { signal })
      return null
    }, { revision: request.revision, unsent: "The backend connection changed before revert was sent.", changed: failure })
  }

  async pin(input: unknown) {
    const request = pinRequest(input)
    await this.use("The pin change was not confirmed. Refresh Sessions to see whether it changed.", async (api, signal) => {
      if (request.pinned) await api.session.pin({ sessionID: request.sessionID }, { signal })
      else await api.session.unpin({ sessionID: request.sessionID }, { signal })
    }, { revision: request.revision, unsent: "The backend connection changed before the pin was changed. Refresh Sessions and try again.",
      changed: "The pin change was not confirmed before the connection changed. Refresh Sessions to see whether it changed." })
    return null
  }

  async workspaces() {
    return this.use("Previously opened repositories could not be read. Refresh to retry.", async (api, signal) =>
      (await api.project.inventory({ limit: 50 }, { signal })).data
        .filter((entry) => entry.available)
        .map((entry) => ({ directory: entry.directory, ...(entry.projectName ? { name: entry.projectName } : {}) })))
  }

  async messages(input: unknown) {
    const sessionID = session(input)
    return this.use("The transcript could not be read. Refresh to retry.", (api, signal) => api.message.list({ sessionID }, { signal }))
  }

  async createSession(input: unknown) {
    if (typeof input !== "object" || input === null || Object.keys(input).some((key) => !["directory", "sessionID", "agent"].includes(key)) || !("sessionID" in input))
      throw new DesktopError("Choose a previously opened repository.")
    const id = session(input.sessionID)
    const directory = "directory" in input ? input.directory : undefined
    const agent = "agent" in input ? input.agent : undefined
    if (agent !== undefined && (typeof agent !== "string" || !idInput(agent) || utf8Length(agent) > 256)) throw new DesktopError("Choose an available agent for the new chat.")
    if (directory !== undefined && directory !== "" && (typeof directory !== "string" || utf8Length(directory) > 4096 || !path.isAbsolute(directory))) throw new DesktopError("Choose a previously opened repository.")
    const location = typeof directory === "string" && directory !== "" ? { directory } : undefined
    const changed = "The chat creation was not confirmed before the connection changed. Check Sessions before retrying."
    return this.use("The chat creation was not confirmed. Check Sessions before retrying.", async (api, signal, _revision, ensureCurrent) => {
      if (location) {
        const listed = await api.project.inventory({ limit: 50, search: location.directory }, { signal })
        if (!listed.data.some((entry) => entry.available && entry.directory === location.directory))
          throw new DesktopError("Choose an available, previously opened repository for the new chat.")
      }
      if (typeof agent === "string") {
        const agents = catalogEnvelope(await api.agent.list(location ? { location } : undefined, { signal }), location, "agent")
        if (!agents.some(selectableAgent(agent))) throw new DesktopError("This agent is unavailable for the new chat. Refresh agents and choose again.")
      }
      ensureCurrent("The backend connection changed before the chat was created. Refresh and try again.")
      const created = await api.session.create({ id, ...(location ? { location } : {}), ...(typeof agent === "string" ? { agent } : {}) }, { signal })
      if (created.id !== id || (location && created.location.directory !== location.directory) || created.scope === "standalone")
        throw new DesktopError("The backend returned a different Session placement. Check Sessions before retrying.")
      if (typeof agent === "string" && created.agent !== agent)
        throw new DesktopError("This chat already exists with a different agent. Start a new chat to use the selected agent.")
      return created
    }, { changed })
  }

  async prompt(input: unknown) {
    if (typeof input !== "object" || input === null || Object.keys(input).some((key) => !["promptID", "sessionID", "text", "files", "agents", "delivery", "steerNow", "revision"].includes(key)) ||
      !("sessionID" in input) || !("promptID" in input) || !("text" in input)) throw new DesktopError("Invalid message.")
    const sessionID = session(input.sessionID)
    const id = input.promptID
    if (typeof id !== "string" || !/^msg_[A-Za-z0-9_-]{1,124}$/.test(id)) throw new DesktopError("Invalid message.")
    const text = input.text
    if (typeof text !== "string" || !text.trim()) throw new DesktopError("Enter a message before sending.")
    if (text.length > 200_000) throw new DesktopError("The message is too long to send.")
    const files = promptFiles("files" in input ? input.files : undefined, text)
    const agents = promptAgents("agents" in input ? input.agents : undefined, text)
    const delivery = "delivery" in input ? input.delivery : undefined
    if (delivery !== undefined && delivery !== "queue" && delivery !== "steer") throw new DesktopError("Invalid message.")
    if ("revision" in input && !("steerNow" in input)) throw new DesktopError("Invalid message.")
    if ("steerNow" in input) {
      const revision = "revision" in input ? input.revision : undefined
      if (input.steerNow !== true || !isRevision(revision)) throw new DesktopError("Invalid message.")
      if (delivery === "queue") throw new DesktopError("A queued message cannot steer now. Send it as Auto or Steer.")
      const body = { id, sessionID, text, ...(files === undefined ? {} : { files }), ...(agents === undefined ? {} : { agents }), ...(delivery === undefined ? {} : { delivery: "steer" as const }) }
      return this.steerNow(body, revision)
    }
    return this.use("The message was not confirmed. Retry sends the same message once; check the Session first.", async (api, signal) => {
      const admitted = await api.session.prompt({ id, sessionID, text, ...(files === undefined ? {} : { files }), ...(agents === undefined ? {} : { agents }), ...(delivery === undefined ? {} : { delivery }) }, { signal })
      if (admitted.id !== id || admitted.sessionID !== sessionID) throw new DesktopError("The backend confirmed a different message. Check the Session before sending again.")
      if (delivery !== undefined && admitted.delivery !== delivery) throw new DesktopError("The backend admitted this message with a different delivery. Check the Session before sending again.")
      return admitted
    }, { changed: "The message was not confirmed before the connection changed. Retry sends the same message once; check the Session first." })
  }

  private steerNow(body: { readonly id: string; readonly sessionID: string; readonly text: string; readonly files?: NonNullable<ReturnType<typeof promptFiles>>; readonly agents?: NonNullable<ReturnType<typeof promptAgents>>; readonly delivery?: "steer" }, expected: number) {
    const failure = "The interrupt was confirmed but the message was not woken. Retrying wakes it once more without interrupting; check the Session first."
    const changed = "The backend connection changed while steering this message. Check the Session before sending again."
    const blocked = "The interrupt for this steer was not confirmed. Review the Session; this message will not interrupt or wake again."
    return this.use(failure, async (api, signal, revision, ensureCurrent) => {
      const attempt = this.current
      if (!attempt) throw new DesktopError(changed)
      const steers = attempt.steers ??= new Map()
      const key = JSON.stringify(body)
      const known = steers.get(body.id)
      if (known && known.key !== key) throw new DesktopError("This message was already steered with different content, Session or delivery. Start a new message.")
      if (known?.receipt) return known.receipt
      if (known?.pending) return known.pending
      if (!known && steers.size >= 256) throw new DesktopError("Too many steered messages on this connection. Reconnect to the backend before steering again.")
      const entry: Steer = known ?? { key, revision, admitted: false, interrupt: "unsent" }
      steers.set(body.id, entry)
      if (entry.revision !== revision) throw new DesktopError(changed)
      if (entry.interrupt === "sent") throw new DesktopError(blocked)
      const confirm = (admitted: Admission) => {
        if (admitted.id !== body.id || admitted.sessionID !== body.sessionID) throw new DesktopError("The backend confirmed a different message. Check the Session before sending again.")
        if (admitted.type !== "user" || admitted.delivery !== "steer") throw new DesktopError("The backend admitted this message with a different delivery. Check the Session before sending again.")
        return admitted
      }
      const run = async () => {
        if (!entry.admitted) {
          ensureCurrent("The backend connection changed before the message was sent. Refresh the Session and try again.")
          try { confirm(await api.session.prompt({ ...body, resume: false }, { signal })) }
          catch (error) { throw error instanceof DesktopError ? error : new DesktopError("The message was not confirmed. Retry sends the same message once; check the Session first.") }
          entry.admitted = true
        }
        if (entry.interrupt === "unsent") {
          ensureCurrent(changed)
          entry.interrupt = "sent"
          try { await api.session.interrupt({ sessionID: body.sessionID }, { signal }) }
          catch { throw new DesktopError(blocked) }
          ensureCurrent(blocked)
          entry.interrupt = "confirmed"
        }
        ensureCurrent(changed)
        entry.receipt = confirm(await api.session.prompt({ ...body, resume: true }, { signal }))
        return entry.receipt
      }
      entry.pending = run()
      try { return await entry.pending }
      finally { entry.pending = undefined }
    }, { revision: expected, unsent: "The backend connection changed before this steer was sent. Check the Session before sending again.", changed })
  }

  async command(input: unknown) {
    if (typeof input !== "object" || input === null || Object.keys(input).some((key) => !["promptID", "sessionID", "command", "arguments", "agent", "model", "files", "agents", "delivery"].includes(key)) ||
      !("sessionID" in input) || !("promptID" in input) || !("command" in input)) throw new DesktopError("Invalid command.")
    const sessionID = session(input.sessionID)
    const id = input.promptID
    if (typeof id !== "string" || !/^msg_[A-Za-z0-9_-]{1,124}$/.test(id)) throw new DesktopError("Invalid command.")
    const command = input.command
    if (typeof command !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(command)) throw new DesktopError("Invalid command.")
    const args = "arguments" in input ? input.arguments : undefined
    if (args !== undefined && (typeof args !== "string" || args.length > 200_000)) throw new DesktopError("Invalid command.")
    const line = `/${command}${args ? ` ${args}` : ""}`
    const files = promptFiles("files" in input ? input.files : undefined, line)
    const agents = promptAgents("agents" in input ? input.agents : undefined, line)
    const delivery = "delivery" in input ? input.delivery : undefined
    if (delivery !== undefined && delivery !== "queue" && delivery !== "steer") throw new DesktopError("Invalid command.")
    const agent = "agent" in input ? input.agent : undefined
    if (agent !== undefined && (typeof agent !== "string" || !idInput(agent) || utf8Length(agent) > 256)) throw new DesktopError("Invalid command.")
    const requestedModel = "model" in input ? input.model : undefined
    return this.use("The command was not confirmed. Check the Session before running it again.", async (api, signal, _revision, ensureCurrent) => {
      let model: ModelSelection | undefined
      if (agent !== undefined || requestedModel !== undefined) {
        const { location } = await this.sessionLocation(api, signal, sessionID)
        if (agent !== undefined && !catalogEnvelope(await api.agent.list({ location }, { signal }), location, "agent").some(selectableAgent(agent))) throw new DesktopError("This agent is unavailable for the command. Refresh agents and choose again.")
        if (requestedModel !== undefined) model = modelSelection(requestedModel, (await catalog(api, signal, location)).models)
        ensureCurrent("The backend connection changed before the command was sent. Refresh and try again.")
      }
      const admitted = await api.session.command({ id, sessionID, command, ...(args ? { arguments: args } : {}), ...(agent === undefined ? {} : { agent }), ...(model === undefined ? {} : { model }), ...(files === undefined ? {} : { files }), ...(agents === undefined ? {} : { agents }), ...(delivery === undefined ? {} : { delivery: delivery as "queue" | "steer" }) }, { signal })
      if (admitted.id !== id || admitted.sessionID !== sessionID) throw new DesktopError("The backend confirmed a different command. Check the Session before running it again.")
      return admitted
    }, { changed: "The command was not confirmed before the connection changed. Check the Session before running it again." })
  }

  async compact(input: unknown) {
    if (typeof input !== "object" || input === null || Object.keys(input).sort().join() !== "compactionID,revision,sessionID" ||
      !("sessionID" in input) || !("revision" in input) || !("compactionID" in input) || !isRevision(input.revision)) throw new DesktopError("Invalid compaction request.")
    const sessionID = session(input.sessionID)
    const compactionID = input.compactionID
    if (typeof compactionID !== "string" || !/^cmp_[A-Za-z0-9_-]{1,124}$/.test(compactionID)) throw new DesktopError("Invalid compaction request.")
    return this.use("Compaction was not confirmed. Check the Session before retrying.", async (api, signal) => {
      const result = await api.session.compact({ sessionID, id: compactionID }, { signal })
      if (!object(result) || result.id !== compactionID || result.sessionID !== sessionID) throw new DesktopError("The backend reported a different compaction. Check the Session before retrying.")
      return result
    }, { revision: input.revision, unsent: "The backend connection changed before compaction was requested. Refresh the Session and try again.", changed: "Compaction was not confirmed before the connection changed. Check the Session before retrying." })
  }

  async composerCatalog(input?: unknown) {
    const source = modelSource(input)
    return this.use("Composer suggestions could not be read. Plain text still sends.", async (api, signal, revision) => {
      const location = await composerLocation(api, signal, source)
      const arg = location === undefined ? undefined : { location }
      const errors: { commands?: string; skills?: string; agents?: string } = {}
      const section = async <T,>(label: "commands" | "skills" | "agents", read: () => Promise<unknown>, project: (rows: unknown[]) => T[]): Promise<T[]> => {
        try { return project(catalogEnvelope(await read(), location, label)) }
        catch (cause) { errors[label] = cause instanceof DesktopError ? cause.message : `${label[0]!.toUpperCase()}${label.slice(1)} could not be read.`; return [] }
      }
      const [commands, skills, agents] = await Promise.all([
        section("commands", () => api.command.list(arg, { signal }), (rows) => rows.map((row) => {
          if (!object(row)) throw new DesktopError("The backend returned an invalid command. Refresh to retry.")
          const name = row.name; const description = row.description
          if (!catalogText(name, 128) || !catalogDescription(description)) throw new DesktopError("The backend returned an invalid command. Refresh to retry.")
          return { name, ...(description === undefined ? {} : { description }) }
        }).slice(0, 200)),
        section("skills", () => api.skill.list(arg, { signal }), (rows) => rows.map((row) => {
          if (!object(row)) throw new DesktopError("The backend returned an invalid skill. Refresh to retry.")
          const id = row.id; const name = row.name; const description = row.description
          if (!catalogText(id, 128) || !catalogText(name, 128) || !catalogDescription(description)) throw new DesktopError("The backend returned an invalid skill. Refresh to retry.")
          return { id, name, ...(description === undefined ? {} : { description }) }
        }).slice(0, 200)),
        section("agents", () => api.agent.list(arg, { signal }), (rows) => rows.flatMap((row) => {
          if (!object(row)) throw new DesktopError("The backend returned an invalid agent. Refresh to retry.")
          const id = row.id; const name = row.name; const mode = row.mode; const description = row.description
          if (!catalogText(id, 128) || !catalogText(name, 128) || !boolean(row.hidden) || (mode !== "subagent" && mode !== "primary" && mode !== "all") || !catalogDescription(description)) throw new DesktopError("The backend returned an invalid agent. Refresh to retry.")
          return row.hidden ? [] : [{ id, name, mode: mode as "subagent" | "primary" | "all", ...(description === undefined ? {} : { description }) }]
        }).slice(0, 100)),
      ])
      return { revision, source, commands, skills, agents, errors }
    })
  }

  async findFiles(input: unknown) {
    if (typeof input !== "object" || input === null || Object.keys(input).some((key) => !["source", "query"].includes(key)) || !("query" in input)) throw new DesktopError("Invalid file search.")
    const source = modelSource("source" in input ? input.source : undefined)
    const query = input.query
    if (typeof query !== "string" || query.length > 256 || utf8Length(query) > 1024 || query.includes("\0")) throw new DesktopError("Invalid file search.")
    return this.use("Files could not be read. Plain text still sends.", async (api, signal, revision) => {
      const location = await composerLocation(api, signal, source)
      const result = query === "" ? await api.file.list(location === undefined ? undefined : { location }, { signal }) : await api.file.find({ ...(location === undefined ? {} : { location }), query, limit: 20 }, { signal })
      const rows = catalogEnvelope(result, location, "file")
      const entries = rows.map((row) => {
        if (!object(row)) throw new DesktopError("The backend returned an invalid file entry. Refresh to retry.")
        const entryPath = row.path
        const type = row.type === "directory" ? "directory" as const : row.type === "file" ? "file" as const : undefined
        if (typeof entryPath !== "string" || entryPath.length === 0 || entryPath.length > 1024 || path.isAbsolute(entryPath) || entryPath.split("/").includes("..") || type === undefined)
          throw new DesktopError("The backend returned an invalid file entry. Refresh to retry.")
        return { path: entryPath, type }
      }).slice(0, 50)
      return { revision, source, entries }
    })
  }

  async interrupt(input: unknown) {
    const sessionID = session(input)
    await this.use("Stopping the chat was not confirmed. Check the Session before retrying.", (api, signal) => api.session.interrupt({ sessionID }, { signal }),
      { changed: "Stopping the chat was not confirmed before the connection changed. Check the Session before retrying." })
    return null
  }

  async requests(input: unknown): Promise<PendingRequests> {
    if (object(input)) {
      const scope = globalRequestsInput(input)
      const location = { directory: scope.directory, ...(scope.workspace === undefined ? {} : { workspace: scope.workspace }) }
      return this.use("MCP requests could not be read. Refresh to retry.", async (api, signal, revision) => {
        const listed = await api.form.request.list({ location }, { signal })
        if (!sameModelLocation(listed, location) || !Array.isArray(listed.data)) throw new DesktopError("The backend returned MCP requests for a different location. Refresh to retry.")
        return { sessionID: "global", revision, permissions: [], forms: listed.data.filter((form) => form.sessionID === "global"), location }
      })
    }
    const sessionID = session(input)
    return this.use("Pending requests could not be read. Refresh to retry.", async (api, signal, revision) => {
      const [permissions, forms, guardrails, reviews, status, questions] = await Promise.all([api.permission.list({ sessionID }, { signal }), api.form.list({ sessionID }, { signal }), api.guardrail.request.list({ sessionID }, { signal }).catch(() => undefined), api.review.list({ sessionID }, { signal }).catch(() => undefined), api.guardrail.status({ sessionID }, { signal }).catch(() => undefined), api.question.list({ sessionID }, { signal })])
      if (!Array.isArray(questions) || questions.some((question) => question.sessionID !== sessionID)) throw new DesktopError("The backend returned questions for a different Session. Refresh requests.")
      if (guardrails !== undefined && !Array.isArray(guardrails)) throw new DesktopError("The backend returned invalid guardrail requests.")
      if (reviews !== undefined && !Array.isArray(reviews)) throw new DesktopError("The backend returned invalid review items.")
      const decided = object(status) && familyID(status.rootSessionID) && optional(status.decisions, (items) => Array.isArray(items) && items.length <= 1000 && items.every((item) => object(item) && familyID(item.sessionID) && count(item.created) && nonempty(item.requestID) && string(item.reply)))
        ? { rootSessionID: status.rootSessionID, guardrailDecisions: ((status.decisions ?? []) as unknown[]).map((item) => displayFields(item, ["sessionID", "created", "requestID", "reply", "authority", "choice", "confidence", "grades", "ruleIDs", "source", "reason"])) }
        : {}
      return { sessionID, revision, permissions, forms, ...(questions.length ? { questions } : {}), ...(guardrails?.length ? { guardrails: guardrails.map(projectGuardrail) } : {}), ...(reviews?.length ? { reviews: reviews.map(projectReview) } : {}), ...decided }
    })
  }

  async reply(input: unknown) {
    if (object(input) && (input.kind === "guardrail" || input.kind === "guardrail-recovery" || input.kind === "review")) {
      const answer = mutation<Extract<RequestReply, { kind: "guardrail" | "guardrail-recovery" | "review" }>>(input, { guardrail: { requestID: idInput, reply: (value) => literal(value, ["once", "always", "reject"]) }, "guardrail-recovery": { requestID: idInput, action: (value) => literal(value, ["cancel", "retry"]) }, review: { itemID: idInput, decision: reviewDecision } }, { sessionID: (value) => { session(value); return true } })
      const changed = "The answer was not confirmed before the connection changed. Refresh requests to see whether it was applied."
      await this.use("The answer was not confirmed. Refresh requests to see whether it was applied.", async (api, signal, _revision, ensureCurrent) => {
        const target = answer.kind !== "review"
          ? (await api.guardrail.request.list({ sessionID: answer.sessionID }, { signal })).find((item) => item.id === answer.requestID)
          : (await api.review.list({ sessionID: answer.sessionID }, { signal })).find((item) => item.itemID === answer.itemID)
        if (!target) throw new DesktopError("This request is no longer pending. Refresh requests.")
        session(target.sessionID)
        ensureCurrent(unsent)
        if (answer.kind === "guardrail") await api.guardrail.request.reply({ sessionID: target.sessionID, requestID: answer.requestID, reply: answer.reply }, { signal })
        else if (answer.kind === "guardrail-recovery" && answer.action === "cancel") await api.guardrail.request.cancel({ sessionID: target.sessionID, requestID: answer.requestID }, { signal })
        else if (answer.kind === "guardrail-recovery") await api.guardrail.request.retry({ sessionID: target.sessionID, requestID: answer.requestID }, { signal })
        else await api.review.decide({ sessionID: target.sessionID, itemID: answer.itemID, decision: answer.decision }, { signal })
      }, { revision: answer.revision, changed })
      return null
    }
    const answer = requestReply(input)
    const stale = "This request is no longer pending. Refresh requests."
    const target = await this.use("Pending requests could not be read. Refresh to retry.", async (api, signal) => {
      if (answer.kind === "question" || answer.kind === "question-reject") {
        const listed = await api.question.list({ sessionID: answer.sessionID }, { signal })
        const question = listed.find((item) => item.id === answer.requestID && item.sessionID === answer.sessionID)
        if (!question) throw new DesktopError(stale)
        if (answer.kind === "question") {
          const problem = questionAnswerError(question.questions, answer.answers)
          if (problem) throw new DesktopError(problem)
        }
        return { sessionID: question.sessionID, id: question.id }
      }
      if (answer.kind === "permission") {
        const request = (await api.permission.list({ sessionID: answer.sessionID }, { signal })).find((item) => item.id === answer.requestID)
        if (!request) throw new DesktopError(stale)
        return { sessionID: request.sessionID, id: request.id }
      }
      if (answer.location) {
        const location = answer.location
        const listed = await api.form.request.list({ location }, { signal })
        if (!sameModelLocation(listed, location) || !Array.isArray(listed.data)) throw new DesktopError("The backend returned MCP requests for a different location. Refresh requests.")
        const form = listed.data.find((item) => item.id === answer.formID && item.sessionID === "global")
        if (!form) throw new DesktopError(stale)
        return { sessionID: form.sessionID, id: form.id }
      }
      const form = (await api.form.list({ sessionID: answer.sessionID }, { signal })).find((item) => item.id === answer.formID)
      if (!form) throw new DesktopError(stale)
      return { sessionID: form.sessionID, id: form.id }
    }, { revision: answer.revision, changed: unsent })
    const scoped = (answer.kind === "form" || answer.kind === "form-cancel") && answer.location ? { headers: { "x-ycoding-directory": encodeURIComponent(answer.location.directory), ...(answer.location.workspace === undefined ? {} : { "x-ycoding-workspace": answer.location.workspace }) } } : {}
    await this.use("The answer was not confirmed. Refresh requests to see whether it was applied.", async (api, signal) => {
      if (answer.kind === "question") await api.question.reply({ sessionID: target.sessionID, requestID: target.id, answers: answer.answers }, { signal })
      else if (answer.kind === "question-reject") await api.question.reject({ sessionID: target.sessionID, requestID: target.id }, { signal })
      else if (answer.kind === "permission")
        await api.permission.reply({ sessionID: target.sessionID, requestID: target.id, reply: answer.reply, ...(answer.message === undefined ? {} : { message: answer.message }) }, { signal })
      else if (answer.kind === "form") await api.form.reply({ sessionID: target.sessionID, formID: target.id, answer: answer.answer }, { signal, ...scoped })
      else await api.form.cancel({ sessionID: target.sessionID, formID: target.id }, { signal, ...scoped })
    }, { revision: answer.revision, changed: "The answer was not confirmed before the connection changed. Refresh requests to see whether it was applied." })
    return null
  }

  async models(input?: unknown) {
    const source = modelSource(input)
    return this.use("Models could not be read. Refresh to retry.", async (api, signal, revision) => {
      if (!("sessionID" in source)) {
        if (source.directory === undefined) return { revision, source, ...(await catalog(api, signal)) }
        const listed = await api.project.inventory({ limit: 50, search: source.directory }, { signal })
        return { revision, source, ...(await catalog(api, signal, openedModelLocation(source.directory, listed.data))) }
      }
      const target = await readTarget(api, signal, source.sessionID)
      return { revision, source, current: target.current, running: target.running, ...(await catalog(api, signal, target.location)) }
    })
  }

  async switchModel(input: unknown) {
    const request = switchRequest(input)
    const model = await this.use("Models could not be read. Refresh models and choose again.", async (api, signal) => {
      const target = await readTarget(api, signal, request.sessionID)
      if (target.running) throw new DesktopError(stopFirst)
      return modelSelection(request.model, (await catalog(api, signal, target.location)).models)
    }, { revision: request.revision, unsent: unswitched, changed: unswitched })
    await this.use("The model switch was not confirmed. Refresh models to see whether it changed.", async (api, signal, _revision, ensureCurrent) => {
      if (running(await api.session.active({ signal }), request.sessionID)) throw new DesktopError(stopFirst)
      ensureCurrent(unswitched)
      await api.session.switchModel({ sessionID: request.sessionID, model }, { signal })
    }, { revision: request.revision, unsent: unswitched, changed: "The model switch was not confirmed before the connection changed. Refresh models to see whether it changed." })
    return null
  }

  private async sessionLocation(api: Native["api"], signal: AbortSignal, sessionID: string) {
    const found = await api.session.get({ sessionID }, { signal })
    return { found, location: sessionModelLocation(sessionID, found) }
  }

  async sessionSnapshot(input: unknown): Promise<SessionSnapshot> {
    const request = snapshotInput(input)
    const stale = "The backend connection changed before older history was read. Refresh history."
    return this.use("Session history could not be read. Refresh to retry.", async (api, signal, revision) => {
      const page = await api.session.snapshot({ sessionID: request.sessionID, limit: 100, ...(request.before === undefined ? {} : { before: request.before }) }, { signal })
      if (!object(page) || !nonempty(page.sourceEpoch) || !object(page.watermark) || page.watermark.aggregateID !== request.sessionID || !optional(page.watermark.seq, count) || !Array.isArray(page.messages) || !optional(page.before, nonempty))
        throw new DesktopError("The backend returned an invalid Session history page. Refresh to retry.")
      if (request.before !== undefined && (page.sourceEpoch !== request.sourceEpoch || page.before === request.before))
        throw new DesktopError("The older history page does not belong to the resident Session. Refresh history.")
      const seq = page.watermark.seq
      return { revision, sessionID: request.sessionID, sourceEpoch: page.sourceEpoch, item: projectSessionRecord(request.sessionID, page.session), messages: page.messages, watermark: typeof seq === "number" ? { seq } : {}, ...(typeof page.before === "string" ? { before: page.before } : {}) }
    }, { revision: request.revision, unsent: stale, changed: stale })
  }

  async pendingInputs(input: unknown): Promise<PendingInputs> {
    const sessionID = session(input)
    return this.use("Pending inputs could not be read. Refresh to retry.", async (api, signal, revision) => {
      const items = await api.session.pending.list({ sessionID }, { signal })
      if (!Array.isArray(items)) throw new DesktopError("The backend returned invalid pending inputs. Refresh to retry.")
      return { revision, sessionID, items: items.map((item) => pendingInput(item, sessionID)) }
    })
  }

  async removePending(input: unknown) {
    const request = pendingAction(input)
    await this.use("The pending message could not be removed. It may no longer be pending.", (api, signal) => api.session.pending.remove(request, { signal }))
  }

  async steerPending(input: unknown) {
    const request = pendingAction(input)
    await this.use("The pending message could not be steered. It may no longer be pending.", (api, signal) => api.session.pending.steer(request, { signal }))
  }

  async deleteMessage(input: unknown) {
    if (!object(input) || !isRevision(input.revision)) throw new DesktopError("Refresh the Session before deleting a message.")
    const { revision, ...action } = input
    const request = pendingAction(action)
    await this.use("The backend did not confirm deletion. Refresh before trying again.", async (api, signal) => {
      try { await api.session.deleteMessage(request, { signal }) }
      catch (cause) {
        if (object(cause) && cause._tag === "MessageDeleteRefusedError") {
          if (cause.reason === "read") throw new DesktopError("YCoding has already read this message.")
          if (cause.reason === "not_owned") throw new DesktopError("You can only delete your own messages.")
        }
        if (object(cause) && cause._tag === "MessageNotFoundError") throw new DesktopError("This message is no longer available.")
        throw cause
      }
    }, { revision })
  }

  async sessionAttachment(input: unknown): Promise<SessionAttachment> {
    const request = attachmentRead(input)
    return this.use("The attachment could not be read.", async (api, signal, revision) => {
      const file = await api.session.attachment.read(request, { signal })
      if (!object(file) || !nonempty(file.mime) || !count(file.bytes) || typeof file.data !== "string") throw new DesktopError("The backend returned an invalid attachment.")
      return { revision, sessionID: request.sessionID, digest: request.digest, mime: file.mime, bytes: file.bytes, data: file.data }
    })
  }

  async sessionInsights(input: unknown): Promise<SessionInsights> {
    const request = insightsInput(input)
    const sessionID = request.sessionID
    return this.use("Session details could not be read. Refresh to retry.", async (api, signal, revision) => {
      const notices: Record<string, string> = {}
      const read = async <T,>(name: string, run: () => Promise<T>) => {
        try { return await run() }
        catch { notices[name] = `${name} could not be read. Refresh to retry.`; return undefined }
      }
      const taskCosts = async (ids: readonly string[]) => {
        const tasks: DisplayValue[] = []
        let partial = false
        for (let offset = 0; offset < ids.length; offset += 100) {
          const first = ids[offset]!
          const batch: [string, ...string[]] = [first, ...ids.slice(offset + 1, offset + 100)]
          const page = await api.session.taskCosts({ sessionID, sessionIDs: batch }, { signal })
          if (!object(page) || !Array.isArray(page.tasks) || !literal(page.history, ["retained", "partial"]) || !page.tasks.every((task) => object(task) && batch.includes(task.sessionID))) throw new Error("Invalid task costs")
          tasks.push(...page.tasks.map((task) => displayValue(task)))
          partial ||= page.history === "partial"
        }
        return { tasks, history: partial ? "partial" : "retained" }
      }
      const [todos, diagnostics, usage, costs, compactions] = await Promise.all([
        read("Todos", async () => todoItems(await api.session.todo.list({ sessionID }, { signal }))),
        read("Context diagnostics", async () => { const value = await api.session.diagnostics({ sessionID }, { signal }); return value === undefined || value === null ? null : displayValue(value) }),
        read("Usage", async () => { const value = await api.session.usage({ sessionID }, { signal }); if (!summaryValid(value)) throw new Error("Invalid usage"); return displayValue(value) }),
        request.taskSessionIDs?.length ? read("Subagent costs", () => taskCosts(request.taskSessionIDs!)) : undefined,
        read("Compaction history", async () => { const value = await api.session.compaction.list({ sessionID }, { signal }); if (!object(value) || !Array.isArray(value.data) || !value.data.every((job) => object(job) && nonempty(job.jobID) && string(job.status))) throw new Error("Invalid compaction history"); return displayValue(value) }),
      ])
      return { revision, sessionID, ...(todos === undefined ? {} : { todos }), ...(diagnostics === undefined ? {} : { diagnostics }), ...(usage === undefined ? {} : { usage }), ...(costs === undefined ? {} : { taskCosts: costs }), ...(compactions === undefined ? {} : { compactions }), notices }
    })
  }

  async switchAgent(input: unknown) {
    const request = agentSwitchInput(input)
    const stale = "The backend connection changed before the agent was switched. Refresh agents and choose again."
    await this.use("The agent switch was not confirmed. Refresh the Session to see whether it changed.", async (api, signal, _revision, ensureCurrent) => {
      const { found, location } = await this.sessionLocation(api, signal, request.sessionID)
      if (object(found) && found.agent === request.agent) return
      const agents = catalogEnvelope(await api.agent.list({ location }, { signal }), location, "agent")
      if (!agents.some(selectableAgent(request.agent))) throw new DesktopError("This agent is unavailable for the Session. Refresh agents and choose again.")
      ensureCurrent(stale)
      await api.session.switchAgent({ sessionID: request.sessionID, agent: request.agent }, { signal })
    }, { revision: request.revision, unsent: stale, changed: "The agent switch was not confirmed before the connection changed. Refresh the Session to see whether it changed." })
    return null
  }

  async activateSkill(input: unknown) {
    const request = skillInput(input)
    const stale = "The backend connection changed before the skill was activated. Refresh skills and choose again."
    await this.use("Skill activation was not confirmed. Check the Session before retrying.", async (api, signal, _revision, ensureCurrent) => {
      const { location } = await this.sessionLocation(api, signal, request.sessionID)
      const skills = catalogEnvelope(await api.skill.list({ location }, { signal }), location, "skill")
      if (!skills.some((row) => object(row) && row.id === request.skill)) throw new DesktopError("This skill is unavailable for the Session. Refresh skills and choose again.")
      ensureCurrent(stale)
      await api.session.skill({ sessionID: request.sessionID, id: request.promptID, skill: request.skill }, { signal })
    }, { revision: request.revision, unsent: stale, changed: "Skill activation was not confirmed before the connection changed. Check the Session before retrying." })
    return null
  }

  async runShell(input: unknown) {
    const request = shellInput(input)
    const stale = "The backend connection changed before the shell command was sent."
    await this.use("The shell command was not confirmed. Check the Session before running it again.", async (api, signal, _revision, ensureCurrent) => {
      const { found } = await this.sessionLocation(api, signal, request.sessionID)
      if (object(found) && found.scope === "standalone") throw new DesktopError("This Session has no working folder for shell commands.")
      ensureCurrent(stale)
      await api.session.shell({ sessionID: request.sessionID, command: request.command }, { signal })
    }, { revision: request.revision, unsent: stale, changed: "The shell command was not confirmed before the connection changed. Check the Session before running it again." })
    return null
  }

  async sendEditorContext(input: unknown): Promise<PendingInput> {
    const request = editorInput(input)
    return this.use("Editor context was not confirmed. Check the Session before retrying.", async (api, signal) => {
      const admitted = pendingInput(await api.session.synthetic({ id: request.promptID, sessionID: request.sessionID, text: request.text, resume: false }, { signal }), request.sessionID)
      if (admitted.id !== request.promptID) throw new DesktopError("The backend confirmed different editor context. Check the Session before retrying.")
      return admitted
    }, { revision: request.revision, unsent: "The backend connection changed before editor context was sent.", changed: "Editor context was not confirmed before the connection changed. Check the Session before retrying." })
  }

  async openSideChat(input: unknown): Promise<SideChat> {
    const request = sideChatInput(input)
    const stale = "The backend connection changed before the side chat was created."
    return this.use("Side chat creation was not confirmed. Check Sessions before retrying.", async (api, signal, revision, ensureCurrent) => {
      const parent = await api.session.get({ sessionID: request.parentID }, { signal })
      if (!object(parent) || parent.id !== request.parentID) throw new DesktopError("The parent Session is unavailable. Refresh Sessions.")
      const history = await api.session.snapshot({ sessionID: request.parentID, limit: 100 }, { signal })
      if (!object(history) || !object(history.watermark) || history.watermark.aggregateID !== request.parentID || !Array.isArray(history.messages)) throw new DesktopError("The parent history could not be read. Refresh and try again.")
      ensureCurrent(stale)
      const created = await api.session.create({ id: request.sessionID, parentID: request.parentID, agent: "btw", ...(request.model ? { model: request.model } : {}) }, { signal })
      if (!object(created) || created.id !== request.sessionID || created.parentID !== request.parentID || created.agent !== "btw") throw new DesktopError("The backend returned a different side chat. Check Sessions before retrying.")
      let admitted: PendingInput | undefined
      try {
        ensureCurrent("the backend connection changed")
        await api.session.synthetic({ sessionID: request.sessionID, text: sideChatContext(history.messages), description: "Parent session history snapshot", delivery: "steer", resume: false }, { signal })
        if (request.text !== undefined && request.promptID !== undefined) {
          ensureCurrent("the backend connection changed")
          admitted = pendingInput(await api.session.prompt({ id: request.promptID, sessionID: request.sessionID, text: request.text }, { signal }), request.sessionID)
          if (admitted.id !== request.promptID) throw new DesktopError("the backend confirmed a different message")
        }
      } catch (error) {
        const reason = error instanceof DesktopError ? error.message : "the backend did not confirm its context"
        throw new DesktopError(`Side chat ${request.sessionID} was created, but setup was not confirmed: ${reason}. Open it from Sessions instead of creating another.`)
      }
      return { revision, item: projectSessionRecord(request.sessionID, created), ...(admitted ? { admitted } : {}) }
    }, { revision: request.revision, unsent: stale, changed: "Side chat creation was not confirmed before the connection changed. Check Sessions before retrying." })
  }

  async steerParent(input: unknown): Promise<PendingInput> {
    const request = steerInput(input)
    const stale = "The backend connection changed before the conclusion was sent."
    return this.use("The conclusion was not confirmed. Check the parent Session before sending again.", async (api, signal, _revision, ensureCurrent) => {
      const side = await api.session.get({ sessionID: request.sessionID }, { signal })
      if (!object(side) || side.id !== request.sessionID || side.agent !== "btw" || typeof side.parentID !== "string") throw new DesktopError("Only a side chat can send a conclusion to its parent.")
      const parentID = side.parentID
      const parent = await api.session.get({ sessionID: parentID }, { signal })
      if (!object(parent) || parent.id !== parentID) throw new DesktopError("The immediate parent Session is unavailable.")
      ensureCurrent(stale)
      const admitted = pendingInput(await api.session.prompt({ id: request.promptID, sessionID: parentID, text: request.text, delivery: "steer" }, { signal }), parentID)
      if (admitted.id !== request.promptID) throw new DesktopError("The backend confirmed a different message. Check the parent Session before sending again.")
      return admitted
    }, { revision: request.revision, unsent: stale, changed: "The conclusion was not confirmed before the connection changed. Check the parent Session before sending again." })
  }

  async prediction(input: unknown): Promise<Prediction> {
    const request = predictionInput(input)
    return this.use("A suggestion could not be generated. Try again.", async (api, signal, revision) => {
      const result = await api.session.prediction({ sessionID: request.sessionID, memory: [...request.memory], ...(request.hint === undefined ? {} : { hint: request.hint }) }, { signal })
      if (object(result) && result.status === "unavailable") return { revision, sessionID: request.sessionID, result: { status: "unavailable" as const } }
      if (!object(result) || result.status !== "suggested" || typeof result.text !== "string") throw new DesktopError("The backend returned an invalid suggestion.")
      return { revision, sessionID: request.sessionID, result: { status: "suggested" as const, text: result.text } }
    })
  }

  async promptGenerate(input: unknown): Promise<GeneratedPrompt> {
    const request = promptGenerateInput(input)
    return this.use("A prompt draft could not be generated. Try again.", async (api, signal, revision) => {
      const result = await api.session.promptGenerate({ sessionID: request.sessionID, mode: request.mode, intent: request.intent, memory: [...request.memory] }, { signal })
      if (object(result) && result.status === "unavailable") return { revision, sessionID: request.sessionID, result: { status: "unavailable" as const } }
      if (!object(result) || result.status !== "generated" || typeof result.text !== "string") throw new DesktopError("The backend returned an invalid prompt draft.")
      return { revision, sessionID: request.sessionID, result: { status: "generated" as const, text: result.text } }
    })
  }

  async terminals(input: unknown): Promise<SessionTerminals> {
    const { sessionID } = terminalInput(input, false)
    return this.use("Session terminals could not be read. Refresh to retry.", async (api, signal, revision) => {
      const { location } = await this.sessionLocation(api, signal, sessionID)
      const listed = await api.pty.list({ sessionID, location }, { signal })
      if (!sameModelLocation(listed, location) || !Array.isArray(listed.data)) throw new DesktopError("The backend returned terminals for another folder. Refresh to retry.")
      return { revision, sessionID, items: listed.data.flatMap(optionalPty).filter((item) => item.sessionID === sessionID) }
    })
  }

  async terminal(input: unknown): Promise<SessionTerminalRead> {
    const request = terminalInput(input, true)
    const ptyID = request.ptyID!
    return this.use("The terminal could not be read. Refresh to retry.", async (api, signal, revision) => {
      const { location } = await this.sessionLocation(api, signal, request.sessionID)
      const found = await api.pty.get({ ptyID, sessionID: request.sessionID, location }, { signal })
      if (!sameModelLocation(found, location)) throw new DesktopError("The backend returned a terminal for another folder. Refresh to retry.")
      const item = decodePty(found.data)
      if (item.id !== ptyID || item.sessionID !== request.sessionID) throw new DesktopError("This terminal is not attributed to the selected Session.")
      return { revision, sessionID: request.sessionID, item }
    })
  }

  async terminalConnect(input: unknown): Promise<TerminalStream> {
    const request = terminalConnectInput(input)
    return this.use("The terminal stream could not be opened. Refresh to retry.", async (api, signal, revision, ensureCurrent) => {
      const { location } = await this.sessionLocation(api, signal, request.sessionID)
      const issued = await api.pty.connect.token({ ptyID: request.ptyID, sessionID: request.sessionID, access: request.access, generation: request.generation, expectedFence: request.fence, location, "x-ycoding-ticket": "1" }, { signal })
      const token: unknown = issued.data
      const ticket = object(token) ? token.ticket : undefined
      if (!object(token) || typeof ticket !== "string" || !ticket || token.access !== request.access || token.generation !== request.generation || (request.access === "control" && token.fence !== request.fence))
        throw new DesktopError("The backend returned an invalid terminal ticket. Refresh to retry.")
      ensureCurrent("The backend connection changed before the terminal stream opened.")
      const endpoint = this.current?.endpoint
      if (!endpoint) throw new DesktopError("The backend endpoint is unavailable. Reconnect and retry.")
      return { revision, streamID: this.streams.open(terminalSocketUrl(endpoint.url, { ...request, location, ticket }), revision, request.access) }
    })
  }

  terminalRead(input: unknown): Promise<TerminalFrames> {
    return this.streams.read(terminalStreamInput(input))
  }

  async terminalWrite(input: unknown) {
    const request = terminalWriteInput(input)
    if (!this.streams.write(request.streamID, request.data)) throw new DesktopError("Terminal input was not delivered. Refresh the terminal before typing again.")
  }

  async terminalClose(input: unknown) {
    this.streams.close(terminalStreamInput(input))
  }

  async terminalControl(input: unknown): Promise<SessionTerminalRead> {
    const request = terminalControlInput(input)
    return this.use("Terminal control was not confirmed. Refresh the terminal before retrying.", async (api, signal, revision) => {
      const { location } = await this.sessionLocation(api, signal, request.sessionID)
      const changed = await api.pty.control({ ptyID: request.ptyID, sessionID: request.sessionID, generation: request.generation, expectedFence: request.expectedFence, action: request.action, location }, { signal })
      return { revision, sessionID: request.sessionID, item: this.ownedPty(changed, location, request) }
    })
  }

  async terminalResize(input: unknown): Promise<SessionTerminalRead> {
    const request = terminalResizeInput(input)
    return this.use("The terminal resize was not confirmed. Refresh the terminal before retrying.", async (api, signal, revision) => {
      const { location } = await this.sessionLocation(api, signal, request.sessionID)
      const changed = await api.pty.update({ ptyID: request.ptyID, sessionID: request.sessionID, generation: request.generation, expectedFence: request.expectedFence, actor: "user", size: request.size, location }, { signal })
      return { revision, sessionID: request.sessionID, item: this.ownedPty(changed, location, request) }
    })
  }

  private ownedPty(value: unknown, location: ModelLocation, request: { readonly ptyID: string; readonly sessionID: string }) {
    if (!sameModelLocation(value, location) || !object(value)) throw new DesktopError("The backend returned a terminal for another folder. Refresh to retry.")
    const item = decodePty(value.data)
    if (item.id !== request.ptyID || item.sessionID !== request.sessionID) throw new DesktopError("This terminal is not attributed to the selected Session.")
    return item
  }

  async exportSession(input: unknown): Promise<TranscriptExport> {
    const request = exportInput(input)
    return this.use("The transcript could not be exported. Refresh to retry.", async (api, signal, revision) => {
      const events = async () => {
        const items: unknown[] = []
        for await (const event of api.session.log({ sessionID: request.sessionID, follow: false }, { signal })) {
          if (!object(event) || typeof event.type !== "string") throw new DesktopError("The backend returned an invalid Session log. Refresh to retry.")
          if (event.type === "log.synced") continue
          if (items.push(event) > 100_000) throw new DesktopError("The Session log is too large to export.")
        }
        return items
      }
      const [info, messages] = await Promise.all([api.session.get({ sessionID: request.sessionID }, { signal }), request.debug ? events() : api.message.list({ sessionID: request.sessionID }, { signal })])
      if (!object(info) || info.id !== request.sessionID || typeof info.title !== "string" || !times(info.time) || !Array.isArray(messages)) throw new DesktopError("The backend returned an invalid transcript. Refresh to retry.")
      const content = request.format === "json" ? `${JSON.stringify(request.debug ? { info, events: messages } : { info, messages }, null, 2)}\n` : sessionMarkdown(info, messages as Awaited<ReturnType<Native["api"]["message"]["list"]>>, request.thinking === true)
      return { revision, sessionID: request.sessionID, format: request.format, content, filename: exportFilename(info, request.format), mimeType: request.format === "json" ? "application/json" as const : "text/markdown" as const }
    })
  }

  private async artifactLocation(api: Native["api"], signal: AbortSignal, source: ReturnType<typeof modelSource>) {
    const location = await parityLocation(api, signal, source)
    return location ? { location } : {}
  }

  private async readArtifact(api: Native["api"], signal: AbortSignal, query: { readonly location?: ModelLocation }, scope: ArtifactScope, kind: ArtifactKind, id: string) {
    const details = await api.projectArtifact.artifact.get({ ...query, scope, kind, id }, { signal })
    if (!object(details) || !object(details.artifact) || details.artifact.id !== id || details.artifact.kind !== kind || !count(details.artifact.revision) || !literal(details.artifact.stage, ["trial", "active", "degraded", "disabled", "quarantine"]) ||
      !object(details.currentVersion) || !nonempty(details.currentVersion.id) || !nonempty(details.currentVersion.contentDigest) || !Array.isArray(details.versions) || !details.versions.every((version) => object(version) && nonempty(version.id)))
      throw new DesktopError("The backend returned an invalid artifact. Refresh to retry.")
    const identity: ArtifactIdentity = { scope, kind, id, expectedRevision: details.artifact.revision, expectedVersionID: details.currentVersion.id, expectedDigest: details.currentVersion.contentDigest }
    return { details, identity, stage: details.artifact.stage as ArtifactStage, versionIDs: details.versions.map((version) => version.id) }
  }

  async artifacts(input: unknown): Promise<ArtifactsSnapshot> {
    const request = artifactsInput(input)
    const source = modelSource(request.source)
    return this.use("Artifacts could not be read. Refresh to retry.", async (api, signal, revision) => {
      const query = await this.artifactLocation(api, signal, source)
      const rows = await api.projectArtifact.artifact.list({ ...query, scope: request.scope, ...(request.stage === undefined ? {} : { stage: request.stage }) }, { signal })
      if (!Array.isArray(rows)) throw new DesktopError("The backend returned an invalid artifact list. Refresh to retry.")
      const keys = request.scope === "trash" ? ["deletionID", "scope", "kind", "id", "priorStage", "priorVersionID", "deletedAt", "purgeAfter"] : ["scope", "kind", "id", "name", "description", "stage", "revision", "currentVersionID", "currentDigest", "lastUsedAt", "timeUpdated"]
      return { revision, source, scope: request.scope, items: rows.map((row) => displayFields(row, keys)) }
    })
  }

  async artifact(input: unknown): Promise<ArtifactDetail> {
    const request = artifactInput(input)
    const source = modelSource(request.source)
    return this.use("The artifact could not be read. Refresh to retry.", async (api, signal, revision) => {
      const query = await this.artifactLocation(api, signal, source)
      const [read, metrics] = await Promise.all([this.readArtifact(api, signal, query, request.scope, request.kind, request.id), api.projectArtifact.artifact.metrics({ ...query, scope: request.scope, kind: request.kind, id: request.id }, { signal })])
      return { revision, source, identity: read.identity, stage: read.stage, versionIDs: read.versionIDs, details: displayValue(read.details), metrics: displayValue(metrics) }
    })
  }

  async manageArtifact(input: unknown): Promise<ArtifactMutationResult> {
    const request = artifactMutationInput(input)
    const source = modelSource(request.source)
    const changed = "The artifact change was not confirmed. Refresh artifacts before retrying."
    const stale = "The artifact changed. Refresh it before retrying."
    return this.use(changed, async (api, signal, revision, ensureCurrent) => {
      const query = await this.artifactLocation(api, signal, source)
      const options = { signal }
      if (request.kind === "restore") {
        const trash = await api.projectArtifact.artifact.list({ ...query, scope: "trash" }, options)
        if (!Array.isArray(trash) || !trash.some((row) => object(row) && "deletionID" in row && row.deletionID === request.deletionID)) throw new DesktopError("This artifact is no longer in trash. Refresh artifacts.")
        ensureCurrent(changed)
        await api.projectArtifact.artifact.restore({ ...query, deletionID: request.deletionID }, options)
        return { revision }
      }
      const target = request.artifact
      const current = await this.readArtifact(api, signal, query, target.scope, target.kind, target.id)
      if (!sameIdentity(current.identity, target)) throw new DesktopError(stale)
      const identity = { ...query, scope: target.scope, kind: target.kind, id: target.id, expectedRevision: target.expectedRevision, expectedVersionID: target.expectedVersionID, expectedDigest: target.expectedDigest }
      if (request.kind === "revert") {
        if (request.targetVersionID === target.expectedVersionID || !current.versionIDs.includes(request.targetVersionID)) throw new DesktopError("Choose an earlier version of this artifact.")
        ensureCurrent(changed)
        await api.projectArtifact.artifact.revert({ ...identity, targetVersionID: request.targetVersionID }, options)
        return { revision }
      }
      if (request.kind === "remove") {
        ensureCurrent(changed)
        return { revision, result: displayValue(await api.projectArtifact.artifact.remove(identity, options)) }
      }
      const kind = target.kind
      const id = target.id
      if (request.kind === "preview") {
        ensureCurrent(changed)
        const preview = request.preview === "promotion" ? await api.projectArtifact.artifact.promotion.preview({ ...query, kind, id, expectedRevision: target.expectedRevision, expectedVersionID: target.expectedVersionID, expectedDigest: target.expectedDigest }, options)
          : request.preview === "fork" ? await api.projectArtifact.artifact.fork.preview({ ...query, kind, id, expectedRevision: target.expectedRevision, expectedVersionID: target.expectedVersionID, expectedDigest: target.expectedDigest }, options)
            : await api.projectArtifact.artifact.shadow.preview({ ...query, kind, id, expectedRevision: target.expectedRevision, expectedVersionID: target.expectedVersionID, expectedDigest: target.expectedDigest }, options)
        if (!object(preview) || !nonempty(preview.token) || utf8Length(preview.token) > 1024 || !count(preview.expiresAt)) throw new DesktopError("The backend returned an invalid confirmation preview.")
        const confirmable = !(request.preview === "promotion" && "collision" in preview && preview.collision !== undefined)
        this.previews.set(preview.token, { connection: revision, preview: request.preview, identity: target, expiresAt: preview.expiresAt, confirmable })
        return { revision, preview: { kind: request.preview, token: preview.token, expiresAt: preview.expiresAt, confirmable, details: displayValue(preview) } }
      }
      const issued = this.previews.get(request.token)
      if (!issued || issued.connection !== revision || issued.preview !== request.preview || !sameIdentity(issued.identity, target)) throw new DesktopError("Preview this change again before confirming it.")
      if (!issued.confirmable) throw new DesktopError("This promotion collides with an existing global artifact and cannot be confirmed.")
      if (issued.expiresAt <= Date.now()) { this.previews.delete(request.token); throw new DesktopError("The confirmation preview expired. Preview the change again.") }
      ensureCurrent(changed)
      this.previews.delete(request.token)
      const confirm = { ...query, kind, id, token: request.token }
      if (request.preview === "promotion") return { revision, result: displayValue(await api.projectArtifact.artifact.promotion.confirm(confirm, options)) }
      if (request.preview === "fork") return { revision, result: displayValue(await api.projectArtifact.artifact.fork.confirm(confirm, options)) }
      await api.projectArtifact.artifact.shadow.confirm(confirm, options)
      return { revision }
    }, { revision: request.revision, unsent: "The backend connection changed before the artifact change was sent. Refresh artifacts and try again.", changed })
  }
}
