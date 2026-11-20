import { DesktopError, utf8Length, type TerminalConnectInput, type TerminalControlInput, type TerminalResizeInput, type TerminalWriteInput, type AgentSwitch, type ArtifactIdentity, type ArtifactInput, type ArtifactMutationInput, type ArtifactsInput, type DotsTarget, type EditorContextInput, type ModelSelection, type ParentSteerInput, type PendingInput, type PredictionInput, type PromptGenerateInput, type SessionInsightsInput, type SessionSnapshotInput, type SessionTodo, type ShellCommandInput, type SideChatInput, type SkillActivation, type TranscriptExportInput, type GlobalRequestsInput, type UsageDashboardInput, type UsageReportQuery, type IncidentsInput, type IncidentMutationInput } from "./contract"
import { isRevision, isSessionID } from "./requests"

type Check = (value: unknown) => boolean

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const maybe = (check: Check): Check => (value) => value === undefined || check(value)
const literal = (choices: readonly string[]): Check => (value) => typeof value === "string" && choices.includes(value)
const bounded = (limit: number): Check => (value) => typeof value === "string" && value.trim().length > 0 && value.length <= limit && utf8Length(value) <= limit && !value.includes("\0")
const identifier: Check = (value) => typeof value === "string" && value.length > 0 && utf8Length(value) <= 256 && !/[\u0000-\u001f\u007f-\u009f\s]/.test(value)
const messageID: Check = (value) => typeof value === "string" && /^msg_[A-Za-z0-9_-]{1,124}$/.test(value)
const digest: Check = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const memory: Check = (value) => Array.isArray(value) && value.length <= 2 && new Set(value).size === value.length && value.every(literal(["repository", "knowledge"]))
const jsonValue: Check = (value) => { const encoded = JSON.stringify(value); return encoded !== undefined && utf8Length(encoded) <= 8192 }
const artifactScopes = ["project", "global"] as const
const artifactKinds = ["skill", "command", "agent", "plugin"] as const
const artifactStages = ["trial", "active", "degraded", "disabled", "quarantine"] as const

function shape(value: unknown, checks: Readonly<Record<string, Check>>, message: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !Object.hasOwn(checks, key)) || !Object.entries(checks).every(([key, check]) => check(value[key]))) throw new DesktopError(message)
  return value
}

export function snapshotInput(value: unknown): SessionSnapshotInput {
  const input = shape(value, { sessionID: isSessionID, revision: maybe(isRevision), sourceEpoch: maybe(bounded(256)), before: maybe(bounded(256)) }, "Invalid history request.")
  const paging = [input.revision, input.sourceEpoch, input.before].filter((item) => item !== undefined).length
  if (paging !== 0 && paging !== 3) throw new DesktopError("Load older history only from the resident page. Refresh history and try again.")
  const sessionID = String(input.sessionID)
  if (paging === 0) return { sessionID }
  return { sessionID, revision: Number(input.revision), sourceEpoch: String(input.sourceEpoch), before: String(input.before) }
}

export function insightsInput(value: unknown): SessionInsightsInput {
  const input = shape(value, { sessionID: isSessionID, taskSessionIDs: maybe((ids) => Array.isArray(ids) && ids.length <= 1000 && ids.every(isSessionID)) }, "Invalid Session details request.")
  const sessionID = String(input.sessionID)
  return Array.isArray(input.taskSessionIDs) ? { sessionID, taskSessionIDs: [...new Set(input.taskSessionIDs.map(String))].sort() } : { sessionID }
}

export function agentSwitchInput(value: unknown): AgentSwitch {
  const input = shape(value, { sessionID: isSessionID, revision: isRevision, agent: identifier }, "Choose an available agent.")
  return { sessionID: String(input.sessionID), revision: Number(input.revision), agent: String(input.agent) }
}

export function skillInput(value: unknown): SkillActivation {
  const input = shape(value, { sessionID: isSessionID, revision: isRevision, promptID: messageID, skill: identifier }, "Choose an available skill.")
  return { sessionID: String(input.sessionID), revision: Number(input.revision), promptID: String(input.promptID), skill: String(input.skill) }
}

export function shellInput(value: unknown): ShellCommandInput {
  const input = shape(value, { sessionID: isSessionID, revision: isRevision, command: bounded(65_536) }, "Enter a shell command of at most 64 KiB without NUL characters.")
  return { sessionID: String(input.sessionID), revision: Number(input.revision), command: String(input.command) }
}

export function editorInput(value: unknown): EditorContextInput {
  const input = shape(value, { sessionID: isSessionID, revision: isRevision, promptID: messageID, text: bounded(200_000) }, "Invalid editor context.")
  return { sessionID: String(input.sessionID), revision: Number(input.revision), promptID: String(input.promptID), text: String(input.text) }
}

const modelRef: Check = (value) => record(value) && Object.keys(value).every((key) => ["id", "providerID", "variant", "profile"].includes(key)) && identifier(value.id) && identifier(value.providerID) && maybe(identifier)(value.variant) && maybe(identifier)(value.profile)

export function sideChatInput(value: unknown): SideChatInput {
  const input = shape(value, { parentID: isSessionID, sessionID: isSessionID, revision: isRevision, model: maybe(modelRef), text: maybe(bounded(200_000)), promptID: maybe(messageID) }, "Invalid side chat request.")
  if (input.parentID === input.sessionID || (input.text === undefined) !== (input.promptID === undefined)) throw new DesktopError("Invalid side chat request.")
  const model = record(input.model) ? { id: String(input.model.id), providerID: String(input.model.providerID), ...(input.model.variant === undefined ? {} : { variant: String(input.model.variant) }), ...(input.model.profile === undefined ? {} : { profile: String(input.model.profile) }) } as ModelSelection : undefined
  return { parentID: String(input.parentID), sessionID: String(input.sessionID), revision: Number(input.revision), ...(model ? { model } : {}), ...(input.text === undefined ? {} : { text: String(input.text), promptID: String(input.promptID) }) }
}

export function steerInput(value: unknown): ParentSteerInput {
  const input = shape(value, { sessionID: isSessionID, revision: isRevision, promptID: messageID, text: bounded(200_000) }, "Invalid side chat conclusion.")
  return { sessionID: String(input.sessionID), revision: Number(input.revision), promptID: String(input.promptID), text: String(input.text) }
}

export function predictionInput(value: unknown): PredictionInput {
  const input = shape(value, { sessionID: isSessionID, memory, hint: maybe((hint) => typeof hint === "string" && hint.length <= 2000 && !hint.includes("\0")) }, "Invalid suggestion request.")
  return { sessionID: String(input.sessionID), memory: (input.memory as PredictionInput["memory"]).slice(), ...(typeof input.hint === "string" ? { hint: input.hint } : {}) }
}

export function promptGenerateInput(value: unknown): PromptGenerateInput {
  const input = shape(value, { sessionID: isSessionID, mode: literal(["start", "steer", "queue", "goal"]), intent: (intent) => typeof intent === "string" && /\S/.test(intent) && intent.length <= 4000 && !intent.includes("\0"), memory }, "Invalid prompt draft request.")
  return { sessionID: String(input.sessionID), mode: input.mode as PromptGenerateInput["mode"], intent: String(input.intent), memory: (input.memory as PromptGenerateInput["memory"]).slice() }
}

export function terminalInput(value: unknown, single: boolean) {
  const input = shape(value, single ? { sessionID: isSessionID, ptyID } : { sessionID: isSessionID }, "Choose a Session terminal.")
  return { sessionID: String(input.sessionID), ...(single ? { ptyID: String(input.ptyID) } : {}) }
}

const ptyID: Check = (id) => identifier(id) && String(id).startsWith("pty")
const positive: Check = (value) => count(value) && value > 0
const streamID: Check = (value) => typeof value === "string" && /^term_[A-Za-z0-9-]{1,64}$/.test(value)
const size: Check = (value) => record(value) && Object.keys(value).length === 2 && positive(value.rows) && Number(value.rows) <= 200 && positive(value.cols) && Number(value.cols) <= 500

export function terminalConnectInput(value: unknown): TerminalConnectInput {
  const input = shape(value, { sessionID: isSessionID, ptyID, generation: positive, offset: count, access: literal(["inspect", "control"]), fence: maybe(positive) }, "Choose a Session terminal.")
  if ((input.access === "control") !== (input.fence !== undefined)) throw new DesktopError("Terminal control requires the current writer fence.")
  return { sessionID: String(input.sessionID), ptyID: String(input.ptyID), generation: Number(input.generation), offset: Number(input.offset), access: input.access as TerminalConnectInput["access"], ...(input.fence === undefined ? {} : { fence: Number(input.fence) }) }
}

export function terminalStreamInput(value: unknown) {
  return String(shape(value, { streamID }, "Choose an open terminal stream.").streamID)
}

export function terminalWriteInput(value: unknown): TerminalWriteInput {
  const input = shape(value, { streamID, data: (data) => typeof data === "string" && data.length > 0 && utf8Length(data) <= 64 * 1024 }, "Terminal input must be 1 byte to 64 KiB of text.")
  return { streamID: String(input.streamID), data: String(input.data) }
}

export function terminalControlInput(value: unknown): TerminalControlInput {
  const input = shape(value, { sessionID: isSessionID, ptyID, generation: positive, expectedFence: positive, action: literal(["take", "pause", "agent"]) }, "Choose a terminal control action.")
  return { sessionID: String(input.sessionID), ptyID: String(input.ptyID), generation: Number(input.generation), expectedFence: Number(input.expectedFence), action: input.action as TerminalControlInput["action"] }
}

export function terminalResizeInput(value: unknown): TerminalResizeInput {
  const input = shape(value, { sessionID: isSessionID, ptyID, generation: positive, expectedFence: positive, size }, "Terminal size must be 1 to 200 rows and 1 to 500 columns.")
  const dimensions = input.size as TerminalResizeInput["size"]
  return { sessionID: String(input.sessionID), ptyID: String(input.ptyID), generation: Number(input.generation), expectedFence: Number(input.expectedFence), size: { rows: dimensions.rows, cols: dimensions.cols } }
}

export function exportInput(value: unknown): TranscriptExportInput {
  const input = shape(value, { sessionID: isSessionID, format: literal(["json", "markdown"]), thinking: maybe((item) => typeof item === "boolean"), debug: maybe((item) => typeof item === "boolean") }, "Choose JSON or Markdown export.")
  if (input.debug === true && input.format !== "json") throw new DesktopError("Debug export is available for JSON only.")
  return { sessionID: String(input.sessionID), format: input.format === "json" ? "json" : "markdown", ...(input.thinking === undefined ? {} : { thinking: input.thinking === true }), ...(input.debug === undefined ? {} : { debug: input.debug === true }) }
}

const absolute: Check = (value) => typeof value === "string" && value.startsWith("/") && utf8Length(value) <= 4096 && !value.includes("\0")
const limited = (max: number): Check => (value) => count(value) && value >= 1 && value <= max
const ordered = (input: Record<string, unknown>) => input.from === undefined || input.to === undefined || Number(input.from) < Number(input.to)

export function globalRequestsInput(value: unknown): GlobalRequestsInput {
  const input = shape(value, { scope: literal(["global"]), directory: absolute, workspace: maybe(identifier) }, "Choose an opened location for MCP requests.")
  return { scope: "global", directory: String(input.directory), ...(input.workspace === undefined ? {} : { workspace: String(input.workspace) }) }
}

const reportGroups = ["model", "hour", "day", "month", "session", "project", "agent", "provider", "provider-profile-model", "provider-model", "model-id", "profile", "prompt", "task"]
const reportQuery: Check = (value) => record(value) && ordered(value) && Object.keys(value).every((key) => Object.hasOwn(reportChecks, key)) && Object.entries(reportChecks).every(([key, check]) => check(value[key]))
const reportChecks: Readonly<Record<string, Check>> = {
  group: literal(reportGroups), providerID: maybe(identifier), profile: maybe(identifier), modelID: maybe(identifier), selectedEffort: maybe(bounded(256)), timeZone: maybe(bounded(128)),
  from: maybe(count), to: maybe(count), offset: maybe(count), limit: maybe(limited(200)),
  sort: maybe(literal(["key", "tokens", "cost", "steps", "input", "output", "reasoning", "cacheRead", "cacheWrite"])), order: maybe(literal(["asc", "desc"])),
}

export function usageDashboardInput(value: unknown): UsageDashboardInput {
  if (value === undefined) return {}
  const input = shape(value, { refresh: maybe((item) => typeof item === "boolean"), daily: maybe(reportQuery), monthly: maybe(reportQuery), breakdown: maybe(reportQuery) }, "Invalid usage dashboard request.")
  const query = (item: unknown) => ({ ...(item as UsageReportQuery) })
  return { ...(input.refresh === undefined ? {} : { refresh: input.refresh === true }), ...(input.daily === undefined ? {} : { daily: query(input.daily) }), ...(input.monthly === undefined ? {} : { monthly: query(input.monthly) }), ...(input.breakdown === undefined ? {} : { breakdown: query(input.breakdown) }) }
}

export function incidentsInput(value: unknown): IncidentsInput {
  const invalid = "Invalid model incident request."
  if (!record(value)) throw new DesktopError(invalid)
  if (value.kind === "report") {
    const input = shape(value, { kind: () => true, group: literal(["model", "agent"]), from: maybe(count), to: maybe(count), offset: maybe(count), limit: maybe(limited(200)) }, invalid)
    if (!ordered(input)) throw new DesktopError(invalid)
    return { kind: "report", group: input.group === "agent" ? "agent" : "model", ...numbers(input, ["from", "to", "offset", "limit"]) }
  }
  if (value.kind === "recent") {
    const input = shape(value, { kind: () => true, provider: identifier, model: identifier, agent: maybe(identifier), limit: maybe(limited(50)) }, invalid)
    return { kind: "recent", provider: String(input.provider), model: String(input.model), ...(input.agent === undefined ? {} : { agent: String(input.agent) }), ...numbers(input, ["limit"]) }
  }
  if (value.kind === "guidance") {
    const input = shape(value, { kind: () => true, provider: identifier, model: identifier, source: () => true }, invalid)
    return { kind: "guidance", provider: String(input.provider), model: String(input.model), ...(input.source === undefined ? {} : { source: input.source as Extract<IncidentsInput, { kind: "guidance" }>["source"] }) }
  }
  throw new DesktopError(invalid)
}

export function incidentMutationInput(value: unknown): IncidentMutationInput {
  const input = shape(value, { revision: isRevision, kind: literal(["guidance-clear"]), provider: identifier, model: identifier, source: () => true }, "Invalid model incident change.")
  return { revision: Number(input.revision), kind: "guidance-clear", provider: String(input.provider), model: String(input.model), ...(input.source === undefined ? {} : { source: input.source as IncidentMutationInput["source"] }) }
}

const numbers = (input: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, Number(input[key])]))

export function artifactsInput(value: unknown): ArtifactsInput {
  const input = shape(value, { source: () => true, scope: literal([...artifactScopes, "trash"]), stage: maybe(literal(artifactStages)) }, "Invalid artifact list request.")
  if (input.scope === "trash" && input.stage !== undefined) throw new DesktopError("Invalid artifact list request.")
  return { ...(input.source === undefined ? {} : { source: input.source as ArtifactsInput["source"] }), scope: input.scope as ArtifactsInput["scope"], ...(input.stage === undefined ? {} : { stage: input.stage as ArtifactsInput["stage"] }) }
}

export function artifactInput(value: unknown): ArtifactInput {
  const input = shape(value, { source: () => true, scope: literal(artifactScopes), kind: literal(artifactKinds), id: identifier }, "Choose an artifact.")
  return { ...(input.source === undefined ? {} : { source: input.source as ArtifactInput["source"] }), scope: input.scope as ArtifactInput["scope"], kind: input.kind as ArtifactInput["kind"], id: String(input.id) }
}

const identityCheck: Check = (value) => {
  try { shape(value, { scope: literal(artifactScopes), kind: literal(artifactKinds), id: identifier, expectedRevision: isRevision, expectedVersionID: identifier, expectedDigest: digest }, ""); return true } catch { return false }
}

export function artifactMutationInput(value: unknown): ArtifactMutationInput {
  if (!record(value)) throw new DesktopError("Invalid artifact change.")
  const common = { revision: isRevision, source: () => true }
  const preview = literal(["promotion", "fork", "shadow"])
  const shapes: Readonly<Record<string, Readonly<Record<string, Check>>>> = {
    revert: { artifact: identityCheck, targetVersionID: identifier },
    remove: { artifact: identityCheck },
    preview: { artifact: identityCheck, preview },
    confirm: { artifact: identityCheck, preview, token: bounded(1024) },
    restore: { deletionID: identifier },
  }
  const kind = typeof value.kind === "string" && Object.hasOwn(shapes, value.kind) ? value.kind : undefined
  if (kind === undefined) throw new DesktopError("Invalid artifact change.")
  shape(value, { kind: () => true, ...common, ...shapes[kind] }, "Invalid artifact change.")
  const request = value as ArtifactMutationInput
  if ((request.kind === "preview" || request.kind === "confirm") && request.artifact.scope !== (request.preview === "fork" ? "global" : "project"))
    throw new DesktopError(request.preview === "fork" ? "Only global artifacts can be forked into the project." : "Only project artifacts can be promoted or shadowed.")
  return request
}

export const sameIdentity = (left: ArtifactIdentity, right: ArtifactIdentity) => left.scope === right.scope && left.kind === right.kind && left.id === right.id && left.expectedRevision === right.expectedRevision && left.expectedVersionID === right.expectedVersionID && left.expectedDigest === right.expectedDigest

const targetCheck: Check = (value) => {
  try { shape(value, { dotID: bounded(256), threadID: bounded(256), environmentID: bounded(256), revision: digest }, ""); return true } catch { return false }
}

export const dotsTarget = targetCheck
export const sameTarget = (current: unknown, expected: DotsTarget | undefined) => {
  if (expected === undefined) return current === undefined
  return record(current) && current.dotID === expected.dotID && current.threadID === expected.threadID && current.environmentID === expected.environmentID && current.revision === expected.revision
}

export const answerData = jsonValue

export function pendingInput(value: unknown, sessionID: string): PendingInput {
  const invalid = () => new DesktopError("The backend returned an invalid pending input. Refresh to retry.")
  if (!record(value) || !identifier(value.id) || value.sessionID !== sessionID || !count(value.admittedSeq) || !count(value.timeCreated)) throw invalid()
  const base = { id: String(value.id), sessionID, admittedSeq: Number(value.admittedSeq), timeCreated: Number(value.timeCreated) }
  if (value.type === "compaction") return { ...base, type: "compaction" }
  const data = value.data
  if ((value.type !== "user" && value.type !== "synthetic") || (value.delivery !== "steer" && value.delivery !== "queue") || !record(data) || typeof data.text !== "string" || !maybe((item) => typeof item === "string")(data.description)) throw invalid()
  const source = record(data.metadata) && typeof data.metadata.source === "string" ? data.metadata.source : undefined
  return { ...base, type: value.type === "user" ? "user" : "synthetic", delivery: value.delivery === "steer" ? "steer" : "queue", text: String(data.text), ...(typeof data.description === "string" ? { description: data.description } : {}), ...(source === undefined ? {} : { source }) }
}

export function todoItems(value: unknown): SessionTodo[] {
  if (!Array.isArray(value) || !value.every((item) => record(item) && typeof item.content === "string" && literal(["pending", "in_progress", "completed", "cancelled"])(item.status) && literal(["high", "medium", "low"])(item.priority))) throw new DesktopError("The backend returned invalid todos.")
  return value.map((item) => ({ content: item.content, status: item.status, priority: item.priority }))
}

const messageText = (value: unknown) => record(value) && typeof value.text === "string" ? value.text : ""

export function sideChatContext(messages: readonly unknown[]) {
  const recent = messages.flatMap((message) => {
    if (!record(message)) return []
    if (message.type === "user") return [{ role: "User", text: messageText(message) }]
    if (message.type === "synthetic") return [{ role: "Context", text: messageText(message) }]
    if (message.type !== "assistant" || !Array.isArray(message.content)) return []
    return message.content.filter((part) => record(part) && part.type === "text").map((part) => ({ role: "Assistant", text: messageText(part) }))
  }).slice(-12)
  return ["Recent parent session history (latest projected window):", ...recent.map((item) => `${item.role}:\n${item.text}`)].join("\n\n")
}

function checkpointSummary(text: string) {
  return /<summary>\n([\s\S]*)\n<\/summary>\s*<\/conversation-checkpoint>/.exec(text)?.[1] ?? text
}

function toolSection(part: Record<string, unknown>) {
  const state = record(part.state) ? part.state : {}
  const input = typeof state.input === "string" ? state.input : JSON.stringify(state.input, null, 2)
  const output = state.status === "error"
    ? record(state.error) && typeof state.error.message === "string" ? state.error.message : ""
    : state.status === "streaming" || !Array.isArray(state.content) ? ""
      : state.content.map((entry) => record(entry) ? entry.type === "text" ? messageText(entry) : String(entry.name ?? entry.uri ?? "") : "").join("\n")
  return `**Tool: ${String(part.name)}**\n\n**Input:**\n\`\`\`json\n${input}\n\`\`\`\n\n${output}`
}

export function exportFilename(session: { readonly id: string; readonly title: string }, format: "json" | "markdown") {
  const slug = session.title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "")
  return `${slug ? `${slug}-` : "session-"}${session.id}.${format === "json" ? "json" : "md"}`
}

export function sessionMarkdown(session: { readonly id: string; readonly title: string; readonly time: { readonly created: number; readonly updated: number } }, messages: readonly unknown[], thinking: boolean) {
  const body = messages.flatMap((message) => {
    if (!record(message)) return []
    if (message.type === "synthetic" && record(message.metadata) && message.metadata.compactionCheckpoint !== undefined) return [`## Compaction checkpoint\n\n${checkpointSummary(messageText(message))}`]
    if (message.type === "user") return [`## User\n\n${messageText(message)}`]
    if (message.type === "shell") return [`## Shell\n\n\`\`\`\n$ ${String(message.command ?? "")}\n${record(message.output) && typeof message.output.output === "string" ? message.output.output : ""}\n\`\`\``]
    if (message.type !== "assistant" || !Array.isArray(message.content)) return []
    const content = message.content.flatMap((part) => {
      if (!record(part)) return []
      if (part.type === "text") return [messageText(part)]
      if (part.type === "reasoning") return thinking ? [`_Thinking:_\n\n${messageText(part)}`] : []
      return part.type === "tool" ? [toolSection(part)] : []
    })
    return [`## Assistant\n\n${content.join("\n\n")}`]
  })
  return `# ${session.title}\n\n**Session ID:** ${session.id}\n**Created:** ${new Date(session.time.created).toLocaleString()}\n**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n---\n\n${body.join("\n\n---\n\n")}\n`
}
