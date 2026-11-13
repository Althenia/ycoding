import { spawn, execFile } from "node:child_process"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { capturedPartPatches } from "@ycoding-ai/client/file-change-summary"
import type { Endpoint } from "@ycoding-ai/client/service"
import type { YCodingEvent } from "@ycoding-ai/client"
import { Coordination, Form, Integration, KeepAwake, PermissionSaved, Project, ProjectCopy, Schema, Telemetry } from "@ycoding-ai/client/effect"
import { currentModel, modelSelection, modelSource, openedModelLocation, projectDefault, projectModels, running, sameModelLocation, sessionModelLocation, switchRequest, type ModelLocation } from "./models"
import { connectNative } from "./native-client"
import { validateSelection } from "./preferences"
import { activityInput, directoriesInput, isRevision, pageInput, requestReply, revertInput, session, setAutonomyInput, shellOutputInput, usageInput } from "./requests"
import { bundledBackend } from "./resources"
import { describeError, redactSecrets } from "./app-log"
import { pinRequest, projectSessionRecord, projectSessions, sessionsQuery, sessionTarget } from "./sessions"
import { DesktopError, utf8Length, type ConnectionState, type Selection, type SessionFileChanges, type DirectoryListing, type OpenedDirectory, type IntegrationsSnapshot, type IntegrationMutationInput, type IntegrationMutationResult, type IntegrationAttempt, type McpResource, type McpMutationInput, type McpSnapshot, type SessionManageInput, type SessionManageResult, type VcsDiffSnapshot, type SystemInput, type SystemManageInput, type SystemSnapshot, type DisplayValue, type RequestReply } from "./contract"

type Native = Awaited<ReturnType<typeof connectNative>>
type Control = ReturnType<typeof openControl>
type Attempt = { readonly generation: number; readonly abort: AbortController; readonly mode: Selection["mode"]; revision: number; control?: Control; native?: Native; pending?: Promise<ConnectionState>; cleanup?: Promise<void>; retirement?: Promise<void>; confirmed?: boolean; reported?: boolean }
type Pages = { readonly revision: number; readonly cursors: string[] }
type Launch = (command: readonly [string, ...string[]]) => readonly [string, ...string[]]
type Options = {
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly fetch?: typeof globalThis.fetch
  readonly launch?: Launch
  readonly onEvent?: (event: YCodingEvent) => void | Promise<void>
  readonly onState?: (state: ConnectionState) => void
  readonly log?: (line: string) => void
}

const direct: Launch = (command) => command
const unsent = "The backend connection changed before the answer was sent. Refresh requests and answer again."
const unswitched = "The backend connection changed before the model was switched. Refresh models and choose again."
const stopFirst = "Stop the running chat before switching models."
const unpaged = "The backend connection changed before more Sessions were read. Refresh Sessions."
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value)
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
const optional = (value: unknown, check: (input: unknown) => boolean) => value === undefined || check(value)
const literal = (value: unknown, choices: readonly string[]) => typeof value === "string" && choices.includes(value)
const string = (value: unknown) => typeof value === "string"
const boolean = (value: unknown) => typeof value === "boolean"
const decodeKeepAwake = Schema.decodeUnknownSync(Schema.toCodecJson(KeepAwake.Status))
const decodeConsent = Schema.decodeUnknownSync(Schema.toCodecJson(Telemetry.Consent))
const decodeConsentState = Schema.decodeUnknownSync(Schema.toCodecJson(Telemetry.ConsentState))
const decodeSamples = Schema.decodeUnknownSync(Schema.toCodecJson(Telemetry.Page))
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
const decodeProjectName = Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.CreateInput.fields.name))
const decodeProjectMembers = Schema.decodeUnknownSync(Schema.toCodecJson(Coordination.CreateInput.fields.memberSessionIDs))
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
  (value.sleep === undefined || value.sleep === null || object(value.sleep)) && object(value.effective) && autonomyDecision(value.effective.permissions) && autonomyDecision(value.effective.guardrails) && autonomyDecision(value.effective.answers) && boolean(value.effective.asleep) && boolean(value.effective.guardrailsEnabled) && object(value.effective.inherited) && [value.effective.inherited.permissions, value.effective.inherited.guardrails, value.effective.inherited.answers].every((item) => item === null || optional(item, sessionID))
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

const hiddenFields = new Set(["auth", "password", "authorization", "headers", "environment", "token", "accesstoken", "access_token", "refreshtoken", "refresh_token", "apikey", "api_key", "credentials", "client_secret", "secret", "key", "config", "settings", "metadata"])

function displayValue(value: unknown): DisplayValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(displayValue)
  if (!object(value)) throw new DesktopError("The backend returned invalid display data.")
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !hiddenFields.has(key.toLowerCase()) && item !== undefined).map(([key, item]) => [key, displayValue(item)]))
}

function displayFields(value: unknown, keys: readonly string[]) {
  if (!object(value)) throw new DesktopError("The backend returned invalid display data.")
  return displayValue(fields(value, keys))
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
  if (!object(value) || !idInput(value.id) || typeof value.sessionID !== "string" || typeof value.rootSessionID !== "string" || typeof value.action !== "string" || typeof value.reason !== "string" || !Array.isArray(value.resources) || !value.resources.every(string) || !Array.isArray(value.ruleIDs) || !value.ruleIDs.every(string) || typeof value.standard !== "boolean") throw new DesktopError("The backend returned an invalid guardrail request.")
  session(value.sessionID)
  session(value.rootSessionID)
  return displayFields(value, ["id", "sessionID", "rootSessionID", "action", "resources", "ruleIDs", "reason", "standard", "hardReview", "risk", "escalation", "coordinationEscalation", "source"]) as NonNullable<import("./contract").PendingRequests["guardrails"]>[number]
}

function projectReview(value: unknown) {
  if (!object(value) || !idInput(value.itemID) || typeof value.sessionID !== "string" || typeof value.rootSessionID !== "string" || typeof value.sessionTitle !== "string" || !count(value.created) || !literal(value.kind, ["question", "subagent_question", "guardrail", "permission", "recovery"]) || !object(value.payload)) throw new DesktopError("The backend returned an invalid review item.")
  session(value.sessionID)
  session(value.rootSessionID)
  return displayFields(value, ["itemID", "sessionID", "rootSessionID", "sessionTitle", "created", "kind", "reason", "choice", "confidence", "grades", "origin", "payload", "child"]) as NonNullable<import("./contract").PendingRequests["reviews"]>[number]
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
  return { models: projectModels(list.data), default: projectDefault(fallback.data) }
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
  if (!Array.isArray(value) || value.length > 20) throw new DesktopError("Invalid message.")
  return value.map((item) => {
    if (!object(item) || Object.keys(item).some((key) => !["uri", "name", "description", "mention"].includes(key)) || typeof item.uri !== "string" || item.uri.length === 0 || item.uri.length > 2048) throw new DesktopError("Invalid message.")
    let url: URL
    try { url = new URL(item.uri) } catch { throw new DesktopError("Invalid message.") }
    if (url.protocol !== "file:" || url.username || url.password || (url.hostname !== "" && url.hostname !== "localhost")) throw new DesktopError("Invalid message.")
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
  private snapshot: ConnectionState = { generation: 0, status: "idle" }

  constructor(private readonly resources: string, private readonly options: Options = {}) {}

  state() { return this.snapshot }

  private publish(state: ConnectionState) {
    if (state.revision !== this.pages?.revision) this.pages = undefined
    this.snapshot = state
    this.options.onState?.(state)
    return state
  }

  async connect(input: unknown): Promise<ConnectionState> {
    const selection = validateSelection(input)
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
    const attempt: Attempt = { generation, mode: selection.mode, abort: new AbortController(), revision: 0 }
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
        if (selection.mode === "own" && endpoint.auth === undefined) throw new DesktopError("The private backend did not provide its authentication capability.")
        const native = await connectNative(endpoint, {
          signal: attempt.abort.signal,
          fetch: this.options.fetch,
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
          reconnect: selection.mode === "shared" && !selection.server ? async (signal) => {
            await attempt.control?.close()
            signal.throwIfAborted()
            attempt.control = openControl(binary, selection, this.options.env, signal, launch, this.options.cwd, this.options.log)
            return attempt.control.ready
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
    let value: T
    const ensureCurrent = (message: string) => {
      if (this.current !== current || this.snapshot.status !== "connected" || current.revision !== revision) throw new DesktopError(message)
    }
    try { value = await run(current.native.api, current.abort.signal, revision, ensureCurrent) }
    catch (error) { throw error instanceof DesktopError ? error : new DesktopError(failure) }
    ensureCurrent(fence.changed ?? "The backend connection changed.")
    return value
  }

  async sessions(input: unknown) {
    const query = sessionsQuery(input)
    const page = query.cursor === undefined
      ? await this.use("Sessions could not be read. Refresh to retry.", async (api, signal, revision) =>
        projectSessions(await api.session.list({ limit: 40, ...(query.search === undefined ? {} : { search: query.search }) }, { signal }), revision))
      : await this.use("More Sessions could not be read. Refresh to retry.", async (api, signal, revision) => {
        const pages = this.pages
        if (pages?.revision !== revision || !pages.cursors.includes(query.cursor)) throw new DesktopError("Load more Sessions only from the current list. Refresh Sessions and try again.")
        return projectSessions(await api.session.list({ limit: 40, cursor: query.cursor }, { signal }), revision)
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

  private projectAutonomy(value: Awaited<ReturnType<Native["api"]["session"]["autonomy"]["get"]>>) {
    if (!autonomyValid(value)) throw new Error("Invalid autonomy view")
    return { ...fields(value, ["mode", "permissions", "guardrails", "answers"]), ...(value.goal === undefined ? {} : { goal: value.goal === null ? null : fields(value.goal, ["text", "status", "iteration", "noProgress", "maxNoProgress", "lastProgressDigest"]) }), ...(value.sleep === undefined ? {} : { sleep: value.sleep === null ? null : {} }), effective: { ...fields(value.effective, ["permissions", "guardrails", "answers", "asleep", "guardrailsEnabled"]), inherited: fields(value.effective.inherited, ["permissions", "guardrails", "answers"]) } }
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
      const directory = found.location.directory
      const location = { directory, ...(found.location.workspaceID === undefined ? {} : { workspace: found.location.workspaceID }) }
      const listed = await api.shell.list({ location }, { signal })
      if (!sameModelLocation(listed, location) || !Array.isArray(listed.data) || !listed.data.every(shellValid)) throw new DesktopError("This shell is not attributed to the selected Session.")
      const target = listed.data.find((shell) => shell.id === request.shellID)
      const owner = object(target?.metadata) ? target.metadata.sessionID : undefined
      if (typeof owner !== "string" || !owner) throw new DesktopError("This shell is not attributed to the selected Session.")
      if (owner !== request.sessionID) {
        const children = await api.session.subagent.list({ parentID: request.sessionID, limit: 10 }, { signal })
        if (!object(children) || !Array.isArray(children.data) || !children.data.every((task) => taskValid(task, request.sessionID)) || !children.data.some((task) => task.sessionID === owner)) throw new DesktopError("This shell is not attributed to the selected Session.")
      }
      ensureCurrent("The backend connection changed before shell output was read.")
      const result = await api.shell.output({ id: request.shellID, location, ...(request.cursor === undefined ? {} : { cursor: request.cursor }), ...(request.limit === undefined ? {} : { limit: request.limit }) }, { signal })
      if (!sameModelLocation(result, location) || !object(result.data) || !string(result.data.output) || !count(result.data.cursor) || !count(result.data.size) || !boolean(result.data.truncated)) throw new Error("Invalid shell output")
      return { revision, sessionID: request.sessionID, shellID: request.shellID, ...fields(result.data, ["output", "cursor", "size", "truncated"]) }
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
      const result = await api.integration.list(location ? { location } : undefined, { signal })
      const rows = catalogEnvelope(result, location, "integration")
      const items = rows.map((row) => {
        const item = decodeIntegration(row)
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
      "wellknown-add": { url: textInput }, "credential-activate": { credentialID: idInput }, "credential-rename": { credentialID: idInput, label: textInput }, "credential-remove": { credentialID: idInput },
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
    }, { sessionID: (value) => { session(value); return true } })
    const changed = "The Session change was not confirmed. Refresh the Session before retrying."
    return this.use(changed, async (api, signal, revision, ensureCurrent) => {
      const sessionID = request.sessionID
      const options = { signal }
      if (request.kind === "move") await existingDirectory(request.directory)
      ensureCurrent(changed)
      switch (request.kind) {
        case "rename": await api.session.rename({ sessionID, title: request.title.trim() }, options); break
        case "fork": { const item = await api.session.fork({ sessionID, ...(request.messageID === undefined ? {} : { messageID: request.messageID }) }, options); return { revision, sessionID, item: projectSessionRecord(item.id, item) } }
        case "archive": await api.session.archive({ sessionID }, options); break
        case "unarchive": await api.session.unarchive({ sessionID }, options); break
        case "delete": await api.session.remove({ sessionID }, options); break
        case "move": await api.session.move({ sessionID, directory: request.directory }, options); break
        case "daybreak": await api.session.daybreak.set({ sessionID, daybreak: request.daybreak }, options); break
        case "background": await api.session.background({ sessionID }, options); break
        case "cancel-subagent": await api.session.subagent.cancel({ parentID: sessionID, childID: request.childSessionID }, options); break
        case "resolve-skill-conflict": await api.session.resolveSkillConflict({ sessionID, winner: request.winner, loser: request.loser }, options); break
        case "kill-shell": {
          const location = sessionModelLocation(sessionID, await api.session.get({ sessionID }, options))
          const shells = await api.shell.list({ location }, options)
          if (!sameModelLocation(shells, location) || !Array.isArray(shells.data) || !shells.data.some((shell) => shell.id === request.shellID && object(shell.metadata) && shell.metadata.sessionID === sessionID)) throw new DesktopError("This shell is not attributed to the selected Session.")
          ensureCurrent(changed)
          await api.shell.remove({ id: request.shellID, location }, options)
          break
        }
      }
      return { revision, sessionID }
    }, { revision: request.revision, changed })
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
      const [skills, sessionSkills, artifacts, plugins, remote, dots, server, browser, browserTabs, isolatedBrowser, isolatedBrowserTabs] = await Promise.all([
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
      ])
      return { revision, connection: { ...this.state() }, ...(requested.sessionID ? { sessionID: requested.sessionID } : {}), ...(location?.directory ? { directory: location.directory } : {}), ...(skills === undefined ? {} : { skills }), ...(sessionSkills === undefined ? {} : { sessionSkills }), ...(artifacts === undefined ? {} : { artifacts }), ...(plugins === undefined ? {} : { plugins }), ...(remote === undefined ? {} : { remote }), ...(dots === undefined ? {} : { dots }), ...(server === undefined ? {} : { server: server as { urls: string[] } }), ...(browser === undefined ? {} : { browser }), ...(browserTabs === undefined ? {} : { browserTabs }), ...(isolatedBrowser === undefined ? {} : { isolatedBrowser }), ...(isolatedBrowserTabs === undefined ? {} : { isolatedBrowserTabs }), notices }
    })
  }

  async manageSystem(input: unknown): Promise<SystemSnapshot> {
    const request = mutation<SystemManageInput>(input, {
      "browser-start": {}, "browser-forget": {}, "isolated-browser-start": { url: textInput }, "isolated-browser-stop": {},
      "artifact-enable": { artifact: object }, "artifact-disable": { artifact: object }, "plugin-activate": { id: textInput }, "plugin-deactivate": { id: textInput }, "plugin-add": { spec: textInput }, "remote-set": { enabled: boolean },
    }, { sessionID: maybe((value) => { session(value); return true }), directory: maybe(directoryInput) })
    if (request.kind.startsWith("plugin-")) throw new DesktopError("This backend exposes plugin discovery only. Configure plugins in ycoding.json and restart the backend to apply changes.")
    if ((request.kind.startsWith("browser-") || request.kind.startsWith("isolated-browser-")) && request.sessionID === undefined) throw new DesktopError("Choose a Session before managing a browser.")
    if (request.kind === "artifact-enable" || request.kind === "artifact-disable") checkedObject(request.artifact, { scope: (value) => value === "project" || value === "global", kind: (value) => literal(value, ["skill", "command", "agent", "plugin"]), id: idInput, expectedRevision: isRevision, expectedVersionID: idInput, expectedDigest: (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) })
    if (request.kind === "isolated-browser-start") safeURL(request.url, ["http:", "https:"])
    const changed = "The system change was not confirmed. Refresh status before retrying."
    return this.use(changed, async (api, signal, _revision, ensureCurrent) => {
      const location = await parityLocation(api, signal, modelSource(request.sessionID ?? (request.directory ? { directory: request.directory } : undefined)))
      const sessionID = request.sessionID!
      const options = { signal }
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
      return { revision, settings: fields(settings, ["enabled", "categories", "actions", "resources", "expiresAt"]), groups: projected, repositories: inventory.data.map((entry) => fields(entry, ["projectID", "projectName", "projectWorktree", "directory", "strategy", "sessions", "timeActive", "available"])), ...(typeof inventory.cursor?.next === "string" ? { repositoriesNext: inventory.cursor.next } : {}) }
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
        const page = await api.server.telemetry.list({ limit: 10 }, { signal }).catch(() => undefined)
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
      checkedObject(input, { kind: string, revision: isRevision, name: (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120, directory: directoryInput, masterTitle: maybe((value) => typeof value === "string" && utf8Length(value) <= 4096), memberSessionIDs: (value) => Array.isArray(value) && value.every((id) => { session(id); return true }) }, "Invalid project change.")
      const name = String(input.name).trim()
      const title = typeof input.masterTitle === "string" ? input.masterTitle.trim() || name : name
      const memberSessionIDs = decodeProjectMembers(input.memberSessionIDs)
      decodeProjectName(name)
      const revision = input.revision as number
      const changed = "Project creation was not confirmed. Refresh Sessions and Projects before retrying."
      return this.use(changed, async (api, signal, _revision, ensureCurrent) => {
        const directory = await existingDirectory(input.directory)
        ensureCurrent(changed)
        await this.registerDirectory(api, signal, _revision, directory)
        ensureCurrent(changed)
        const created = await api.session.create({ location: { directory }, title }, { signal })
        if (typeof created.id !== "string" || !sessionID(created.id)) throw new DesktopError(changed)
        try {
          if (created.location.directory !== directory || created.scope === "standalone") throw new DesktopError("The backend returned a different Session placement")
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
    if (typeof input !== "object" || input === null || Object.keys(input).some((key) => key !== "directory" && key !== "sessionID") || !("sessionID" in input))
      throw new DesktopError("Choose a previously opened repository.")
    const id = session(input.sessionID)
    const directory = "directory" in input ? input.directory : undefined
    const changed = "The chat creation was not confirmed before the connection changed. Check Sessions before retrying."
    if (directory === undefined || directory === "") return this.use("The chat creation was not confirmed. Check Sessions before retrying.", async (api, signal) => {
      const created = await api.session.create({ id }, { signal })
      if (created.id !== id || created.scope === "standalone")
        throw new DesktopError("The backend returned a different Session placement. Check Sessions before retrying.")
      return created
    }, { changed })
    if (typeof directory !== "string" || utf8Length(directory) > 4096 || !path.isAbsolute(directory)) throw new DesktopError("Choose a previously opened repository.")
    return this.use("The chat creation was not confirmed. Check Sessions before retrying.", async (api, signal, _revision, ensureCurrent) => {
      const listed = await api.project.inventory({ limit: 50, search: directory }, { signal })
      if (!listed.data.some((entry) => entry.available && entry.directory === directory))
        throw new DesktopError("Choose an available, previously opened repository for the new chat.")
      ensureCurrent("The backend connection changed before the chat was created. Refresh and try again.")
      const created = await api.session.create({ id, location: { directory } }, { signal })
      if (created.id !== id || created.location.directory !== directory || created.scope === "standalone")
        throw new DesktopError("The backend returned a different Session placement. Check Sessions before retrying.")
      return created
    }, { changed })
  }

  async prompt(input: unknown) {
    if (typeof input !== "object" || input === null || Object.keys(input).some((key) => !["promptID", "sessionID", "text", "files", "agents"].includes(key)) ||
      !("sessionID" in input) || !("promptID" in input) || !("text" in input)) throw new DesktopError("Invalid message.")
    const sessionID = session(input.sessionID)
    const id = input.promptID
    if (typeof id !== "string" || !/^msg_[A-Za-z0-9_-]{1,124}$/.test(id)) throw new DesktopError("Invalid message.")
    const text = input.text
    if (typeof text !== "string" || !text.trim()) throw new DesktopError("Enter a message before sending.")
    if (text.length > 200_000) throw new DesktopError("The message is too long to send.")
    const files = promptFiles("files" in input ? input.files : undefined, text)
    const agents = promptAgents("agents" in input ? input.agents : undefined, text)
    return this.use("The message was not confirmed. Retry sends the same message once; check the Session first.", async (api, signal) => {
      const admitted = await api.session.prompt({ id, sessionID, text, ...(files === undefined ? {} : { files }), ...(agents === undefined ? {} : { agents }) }, { signal })
      if (admitted.id !== id || admitted.sessionID !== sessionID) throw new DesktopError("The backend confirmed a different message. Check the Session before sending again.")
      return admitted
    }, { changed: "The message was not confirmed before the connection changed. Retry sends the same message once; check the Session first." })
  }

  async command(input: unknown) {
    if (typeof input !== "object" || input === null || Object.keys(input).some((key) => !["promptID", "sessionID", "command", "arguments"].includes(key)) ||
      !("sessionID" in input) || !("promptID" in input) || !("command" in input)) throw new DesktopError("Invalid command.")
    const sessionID = session(input.sessionID)
    const id = input.promptID
    if (typeof id !== "string" || !/^msg_[A-Za-z0-9_-]{1,124}$/.test(id)) throw new DesktopError("Invalid command.")
    const command = input.command
    if (typeof command !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(command)) throw new DesktopError("Invalid command.")
    const args = "arguments" in input ? input.arguments : undefined
    if (args !== undefined && (typeof args !== "string" || args.length > 200_000)) throw new DesktopError("Invalid command.")
    return this.use("The command was not confirmed. Check the Session before running it again.", async (api, signal) => {
      const admitted = await api.session.command({ id, sessionID, command, ...(args ? { arguments: args } : {}) }, { signal })
      if (admitted.id !== id || admitted.sessionID !== sessionID) throw new DesktopError("The backend confirmed a different command. Check the Session before running it again.")
      return admitted
    }, { changed: "The command was not confirmed before the connection changed. Check the Session before running it again." })
  }

  async compact(input: unknown) {
    if (typeof input !== "object" || input === null || Object.keys(input).sort().join() !== "promptID,sessionID" ||
      !("sessionID" in input) || !("promptID" in input)) throw new DesktopError("Invalid compaction request.")
    const sessionID = session(input.sessionID)
    const id = input.promptID
    if (typeof id !== "string" || !/^msg_[A-Za-z0-9_-]{1,124}$/.test(id)) throw new DesktopError("Invalid compaction request.")
    return this.use("Compaction was not confirmed. Check the Session before retrying.", (api, signal) => api.session.compact({ sessionID, id }, { signal }),
      { changed: "Compaction was not confirmed before the connection changed. Check the Session before retrying." })
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
          const name = row.name; const description = row.description
          if (!catalogText(name, 128) || !boolean(row.hidden) || !catalogDescription(description)) throw new DesktopError("The backend returned an invalid agent. Refresh to retry.")
          return row.hidden ? [] : [{ name, ...(description === undefined ? {} : { description }) }]
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

  async requests(input: unknown) {
    const sessionID = session(input)
    return this.use("Pending requests could not be read. Refresh to retry.", async (api, signal, revision) => {
      const [permissions, forms, guardrails, reviews] = await Promise.all([api.permission.list({ sessionID }, { signal }), api.form.list({ sessionID }, { signal }), api.guardrail.request.list({ sessionID }, { signal }).catch(() => undefined), api.review.list({ sessionID }, { signal }).catch(() => undefined)])
      if (guardrails !== undefined && !Array.isArray(guardrails)) throw new DesktopError("The backend returned invalid guardrail requests.")
      if (reviews !== undefined && !Array.isArray(reviews)) throw new DesktopError("The backend returned invalid review items.")
      return { sessionID, revision, permissions, forms, ...(guardrails?.length ? { guardrails: guardrails.map(projectGuardrail) } : {}), ...(reviews?.length ? { reviews: reviews.map(projectReview) } : {}) }
    })
  }

  async reply(input: unknown) {
    if (object(input) && (input.kind === "guardrail" || input.kind === "review")) {
      const answer = mutation<Extract<RequestReply, { kind: "guardrail" | "review" }>>(input, { guardrail: { requestID: idInput, reply: (value) => literal(value, ["once", "always", "reject"]) }, review: { itemID: idInput, decision: reviewDecision } }, { sessionID: (value) => { session(value); return true } })
      const changed = "The answer was not confirmed before the connection changed. Refresh requests to see whether it was applied."
      await this.use("The answer was not confirmed. Refresh requests to see whether it was applied.", async (api, signal, _revision, ensureCurrent) => {
        const target = answer.kind === "guardrail"
          ? (await api.guardrail.request.list({ sessionID: answer.sessionID }, { signal })).find((item) => item.id === answer.requestID)
          : (await api.review.list({ sessionID: answer.sessionID }, { signal })).find((item) => item.itemID === answer.itemID)
        if (!target) throw new DesktopError("This request is no longer pending. Refresh requests.")
        session(target.sessionID)
        ensureCurrent(unsent)
        if (answer.kind === "guardrail") await api.guardrail.request.reply({ sessionID: target.sessionID, requestID: answer.requestID, reply: answer.reply }, { signal })
        else await api.review.decide({ sessionID: target.sessionID, itemID: answer.itemID, decision: answer.decision }, { signal })
      }, { revision: answer.revision, changed })
      return null
    }
    const answer = requestReply(input)
    const stale = "This request is no longer pending. Refresh requests."
    const target = await this.use("Pending requests could not be read. Refresh to retry.", async (api, signal) => {
      if (answer.kind === "permission") {
        const request = (await api.permission.list({ sessionID: answer.sessionID }, { signal })).find((item) => item.id === answer.requestID)
        if (!request) throw new DesktopError(stale)
        return { sessionID: request.sessionID, id: request.id }
      }
      const form = (await api.form.list({ sessionID: answer.sessionID }, { signal })).find((item) => item.id === answer.formID)
      if (!form) throw new DesktopError(stale)
      return { sessionID: form.sessionID, id: form.id }
    }, { revision: answer.revision, changed: unsent })
    await this.use("The answer was not confirmed. Refresh requests to see whether it was applied.", async (api, signal) => {
      if (answer.kind === "permission")
        await api.permission.reply({ sessionID: target.sessionID, requestID: target.id, reply: answer.reply, ...(answer.message === undefined ? {} : { message: answer.message }) }, { signal })
      else if (answer.kind === "form") await api.form.reply({ sessionID: target.sessionID, formID: target.id, answer: answer.answer }, { signal })
      else await api.form.cancel({ sessionID: target.sessionID, formID: target.id }, { signal })
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
}
