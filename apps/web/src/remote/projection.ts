/**
 * Narrow readers and projection for the relay event stream.
 *
 * The relay forwards the local `packages/protocol` event payload verbatim, so
 * every field is read defensively and unknown events are counted rather than
 * guessed. Nothing here invents content the agent did not send.
 */

import type { Form } from "../../../../packages/schema/src/form"
import { RemoteLimits, isWellFormedBase64, type RemoteCapturedChangesPage, type RemoteCompactionHistory } from "@ycoding-ai/remote"
import { parseUnifiedPatch } from "./file-change-diff"

/** `packages/schema` `Model.Ref`: an object, never a plain string. */
export type ModelRefView = {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export function readModelRef(value: unknown): ModelRefView | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const id = stringField(record.id)
  const providerID = stringField(record.providerID)
  if (id === undefined || providerID === undefined) return undefined
  const variant = stringField(record.variant)
  return { id, providerID, ...(variant === undefined ? {} : { variant }) }
}

/** Display form of a model reference: `provider/model` plus an optional `#variant`. */
export function modelLabel(model: ModelRefView | undefined): string | undefined {
  if (model === undefined) return undefined
  return `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`
}

export type GenerationSpeedSampleView = {
  readonly model: ModelRefView
  readonly tokens: number
  readonly durationNs: number
  readonly tokensPerSecond: number
}

export type GenerationSpeedHistoryView = {
  readonly latest?: GenerationSpeedSampleView
  readonly recent: readonly GenerationSpeedSampleView[]
}

export type ContextWindowView = { readonly model: ModelRefView; readonly used: number; readonly limit: number }

const positiveInteger = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined

function readGenerationSpeedSample(value: unknown): GenerationSpeedSampleView | undefined {
  if (!isRecord(value)) return undefined
  const model = readModelRef(value.model)
  const tokens = positiveInteger(value.tokens)
  const durationNs = positiveInteger(value.durationNs)
  const tokensPerSecond = numberField(value.tokensPerSecond)
  if (!model || tokens === undefined || durationNs === undefined || tokensPerSecond === undefined || tokensPerSecond <= 0) return undefined
  return { model, tokens, durationNs, tokensPerSecond }
}

function readGenerationSpeed(value: unknown): GenerationSpeedHistoryView | undefined {
  if (!isRecord(value) || !Array.isArray(value.recent) || value.recent.length > 8) return undefined
  const recent = value.recent.map(readGenerationSpeedSample)
  if (!recent.every((sample): sample is GenerationSpeedSampleView => sample !== undefined)) return undefined
  const latest = value.latest === undefined ? undefined : readGenerationSpeedSample(value.latest)
  if (value.latest !== undefined && latest === undefined) return undefined
  return { recent, ...(latest === undefined ? {} : { latest }) }
}

function readContextWindow(model: unknown, used: unknown, limit: unknown): ContextWindowView | undefined {
  const selected = readModelRef(model)
  const total = positiveInteger(used)
  const cap = positiveInteger(limit)
  if (!selected || total === undefined || cap === undefined) return undefined
  return { model: selected, used: total, limit: cap }
}

function readAssistantContext(value: unknown): ContextWindowView | undefined {
  if (!isRecord(value) || !isRecord(value.tokens) || !isRecord(value.tokens.cache)) return undefined
  const counts = [value.tokens.input, value.tokens.output, value.tokens.reasoning,
    value.tokens.cache.read, value.tokens.cache.write]
  if (!counts.every((count): count is number => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return undefined
  return readContextWindow(value.model, counts.reduce((sum, count) => sum + count, 0),
    isRecord(value.diagnostics) ? value.diagnostics.contextLimit : undefined)
}

const sameModel = (left: ModelRefView | undefined, right: ModelRefView | undefined) =>
  left !== undefined && right !== undefined && left.providerID === right.providerID && left.id === right.id &&
  (left.variant ?? "default") === (right.variant ?? "default")

export function generationSpeedDisplay(view: SessionView | undefined, selected: ModelRefView | undefined) {
  const history = view?.generationSpeed
  const latest = history?.latest
  if (!latest || !sameModel(latest.model, selected)) return undefined
  const rate = latest.tokensPerSecond
  const label = `${rate >= 1 ? Math.round(rate).toLocaleString("en-US") : rate.toPrecision(2)} tok/s`
  const peak = Math.max(...history.recent.map((sample) => sample.tokensPerSecond))
  const levels = "▁▂▃▄▅▆▇█"
  const trend = history.recent.length < 2 ? undefined
    : history.recent.map((sample) => levels[Math.floor(sample.tokensPerSecond / peak * 7)]).join("")
  return { label, ...(trend === undefined ? {} : { trend }) }
}

const compactTokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

export function contextWindowDisplay(view: SessionView | undefined, selected: ModelRefView | undefined) {
  const context = view?.contextWindow
  if (!context || !sameModel(context.model, selected) || context.used <= 0 || context.limit <= 0) return undefined
  const usedPercent = Math.round(context.used / context.limit * 100)
  if (usedPercent <= 0) return undefined
  return {
    usedPercent,
    leftPercent: Math.max(0, 100 - usedPercent),
    fraction: context.used / context.limit,
    tokens: `${compactTokens.format(context.used)} / ${compactTokens.format(context.limit)} tokens`,
  }
}

export type ToolContentBlock =
  | { readonly kind: "text"; readonly text: string; readonly sourceTruncated?: boolean }
  | { readonly kind: "image"; readonly uri: string; readonly mime: string; readonly name?: string }
  | { readonly kind: "other"; readonly type: string; readonly summary: string }

export type MessageAttachment = { readonly name: string; readonly mime: string; readonly bytes: number; readonly digest: string }

const imageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

function readAttachments(value: unknown): readonly MessageAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): readonly MessageAttachment[] => {
    if (!isRecord(item) || !isRecord(item.content) || item.content.type !== "managed") return []
    const digest = stringField(item.content.digest)
    const mime = stringField(item.mime)
    const bytes = item.content.bytes
    if (digest === undefined || !/^[0-9a-f]{64}$/.test(digest) || mime === undefined ||
      typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return []
    return [{ name: stringField(item.name) ?? "Attachment", mime, bytes, digest }]
  })
}

/**
 * `Shell.Output` page the client holds. `cursor` is the absolute byte offset after the
 * page and `size` the total bytes captured on the device, so `cursor < size` means the
 * remainder is still on the device. Keeping the page and its metadata makes the
 * collapsed view a display decision instead of a data-loss point.
 */
export type ShellOutputView = {
  readonly text: string
  readonly cursor: number
  readonly size: number
  readonly truncated: boolean
}

/**
 * Client page-request state for one shell capture. It is not device data: the device's
 * own page stays in `ShellOutputView`, and this records only what the last explicit
 * request did, so a stalled or failed read is never rendered as output the device sent.
 */
export type ShellOutputFetch =
  /** No request is in flight and the last one settled cleanly. */
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  /** A settled page added nothing while the device still holds bytes. */
  | { readonly state: "stalled" }

export type AssistantPart =
  | {
      readonly kind: "text"
      readonly ordinal: number
      readonly text: string
      readonly phase?: "commentary" | "final_answer"
    }
  | { readonly kind: "reasoning"; readonly ordinal: number; readonly text: string; readonly started?: number; readonly completed?: number }
  | {
      readonly kind: "tool"
      readonly callID: string
      readonly name: string
      readonly status: "streaming" | "running" | "completed" | "failed"
      readonly inputText?: string
      readonly input?: Readonly<Record<string, unknown>>
      readonly content: readonly ToolContentBlock[]
      /** `ToolState.*.structured` as sent: shell correlation and truncation flags. */
      readonly structured?: Readonly<Record<string, unknown>>
      /** Paged capture of the shell this tool ran, when the device reported one. */
      readonly shellOutput?: ShellOutputView
      /** Client request state for `shellOutput`, kept apart from the device's bytes. */
      readonly shellOutputFetch?: ShellOutputFetch
      readonly error?: string
      readonly started?: number
      readonly ran?: number
      readonly completed?: number
    }

export type RemoteMessageView =
  | { readonly kind: "oversized"; readonly id: string; readonly projected: boolean; readonly state: "loading" | "pending" | "error" }
  | {
      readonly kind: "user"
      readonly id: string
      readonly text: string
      readonly attachments?: readonly MessageAttachment[]
      /** Absent when the projection does not carry a delivery mode. */
      readonly delivery?: "steer" | "queue"
      readonly state: "pending" | "promoted" | "consumed"
      readonly created: number
    }
  | {
      readonly kind: "assistant"
      readonly id: string
      readonly agent?: string
      readonly model?: ModelRefView
      readonly parts: readonly AssistantPart[]
      readonly created: number
      readonly completed?: number
      readonly error?: string
      readonly retry?: { readonly attempt: number; readonly at: number; readonly code: string }
    }
  | { readonly kind: "system"; readonly id: string; readonly text: string; readonly source?: string; readonly created: number }
  | {
      readonly kind: "synthetic"
      readonly id: string
      readonly text: string
      readonly description?: string
      readonly source?: string
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly pending?: boolean
      readonly created: number
    }
  | {
      readonly kind: "shell"
      readonly id: string
      readonly shellID: string
      readonly command: string
      readonly status: string
      readonly exit?: number
      readonly output?: ShellOutputView
      /** Client request state for `output`; a running shell has no page yet. */
      readonly outputFetch?: ShellOutputFetch
      readonly created: number
      readonly completed?: number
    }
  | {
      readonly kind: "compaction"
      readonly id: string
      readonly status: "pending" | "running" | "completed" | "failed"
      readonly boundaryMessageID?: string
      readonly jobID?: string
      readonly failureCode?: string
      readonly trigger?: string
      readonly metrics?: RemoteCompactionHistory["data"][number]["metrics"]
      readonly created?: number
      readonly summary?: string
      readonly error?: string
    }
  | {
      readonly kind: "notice"
      readonly id: string
      readonly notice: "agent-switched" | "model-switched" | "skill" | "revert"
      readonly text: string
      readonly created: number
    }

export type FormFieldView = Form.Field
export type FormWhenView = Form.When
export type FormAnswerView = Form.Answer
export type FormView = Omit<Form.Info, "id" | "fields"> & { readonly id: string; readonly fields: readonly FormFieldView[] }

export type PendingRequestView =
  | {
      readonly kind: "permission"
      readonly id: string
      readonly action: string
      readonly resources: readonly string[]
      readonly askedAt: number
    }
  | {
      readonly kind: "guardrail"
      readonly id: string
      readonly sessionID: string
      readonly rootSessionID?: string
      readonly action: string
      readonly resources: readonly string[]
      readonly reason: string
      readonly hardReview: boolean
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly askedAt: number
    }
  | {
      readonly kind: "form"
      readonly id: string
      readonly form: FormView
      readonly askedAt: number
    }

export type SessionAutonomyView = {
  readonly mode: "normal" | "yolo" | "goal"
  readonly yolo: 0 | 1 | 2 | 3
  readonly goal?: {
    readonly text: string
    readonly status: "active" | "completed" | "stopped" | "exhausted"
    readonly iteration: number
    readonly noProgress: number
    readonly maxNoProgress: number
  }
}

export type SessionView = {
  readonly id: string
  readonly title?: string
  readonly agent?: string
  readonly model?: ModelRefView
  readonly generationSpeed?: GenerationSpeedHistoryView
  readonly contextWindow?: ContextWindowView
  readonly status: "idle" | "running" | "interrupted" | "failed"
  readonly archived?: boolean
  readonly lastError?: { readonly code: string; readonly message: string }
  readonly autonomy?: SessionAutonomyView
  readonly executionStarted?: number
  readonly messages: readonly RemoteMessageView[]
  readonly compactionHistory?: RemoteCompactionHistory
  readonly requests: readonly PendingRequestView[]
  readonly capturedChanges?: RemoteCapturedChangesPage["data"]
  readonly unhandledEvents: number
  readonly updatedAt?: number
  readonly activeAt?: number
  /** Highest durable sequence applied for this session; the snapshot watermark seeds it. */
  readonly watermark?: number
  /** Server process epoch the current projection came from. */
  readonly sourceEpoch?: string
}

export type TeamCue =
  | { readonly id: string; readonly kind: "delegated"; readonly childID: string }
  | { readonly id: string; readonly kind: "reported"; readonly childID: string; readonly outcome: "completed" | "failed" | "cancelled" | "lost" }

export function readTeamCue(payload: unknown): TeamCue | undefined {
  if (!isRecord(payload) || !isRecord(payload.durable) || !isRecord(payload.data)) return undefined
  const id = stringField(payload.id)
  const parentID = stringField(payload.data.sessionID)
  if (id === undefined || !id.startsWith("evt_") || parentID === undefined || payload.durable.aggregateID !== parentID ||
    typeof payload.durable.seq !== "number" || !Number.isInteger(payload.durable.seq) || payload.durable.seq < 0) return undefined
  if (payload.type === "session.tool.progress" || payload.type === "session.tool.success") {
    const structured = recordField(payload.data.structured)
    const childID = structured && stringField(structured.sessionID)
    const callID = stringField(payload.data.callID)
    const messageID = stringField(payload.data.assistantMessageID)
    if (childID === undefined || callID === undefined || messageID === undefined || structured?.status !== "running") return undefined
    return { id: `${messageID}:${callID}:${childID}`, kind: "delegated", childID }
  }
  if (payload.type !== "session.synthetic") return undefined
  const metadata = recordField(payload.data.metadata)
  if (metadata?.source !== "subagent_notification") return undefined
  const childID = stringField(metadata.childID)
  const outcome = metadata.type
  const revision = metadata.revision
  if (childID === undefined || (outcome !== "completed" && outcome !== "failed" && outcome !== "cancelled" && outcome !== "lost") ||
    typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return undefined
  return { id: `${id}:${revision}:${childID}`, kind: "reported", childID, outcome }
}

export function isGoalSteerAdmission(payload: unknown): boolean {
  if (!isRecord(payload) || payload.type !== "session.input.admitted" || !isRecord(payload.data) || !isRecord(payload.data.input)) return false
  const input = payload.data.input
  const autonomy = isRecord(input.data) ? recordField(recordField(input.data.metadata)?.autonomy) : undefined
  return input.type === "synthetic" && autonomy?.goal === true
}

/** Caps a derived summary (compaction, non-text tool content) so it cannot dominate the page. */
export const messageTextLimit = 4_000

/**
 * Events the client receives but does not project: they carry no user-visible
 * transcript or request state here, so they are ignored without inflating the
 * unhandled counter.
 */
const ignoredEventTypes: readonly string[] = [
  "session.work.completed",
  "session.file-change.recorded",
  "guardrail.decided",
  "session.instructions.updated",
  "session.task.updated",
  "session.project-artifacts-ended",
  "session.moved",
  "session.forked",
  "session.deleted",
  "session.usage.recorded",
  "session.usage.updated",
  "session.provider.request.recorded",
  "session.skill.deactivated",
  "session.compaction.delta",
  "session.compaction.replaced",
  "todo.updated",
  "server.connected",
]

export function createSessionView(id: string): SessionView {
  return { id, status: "idle", messages: [], requests: [], unhandledEvents: 0 }
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1_000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`
}

export function formatPartDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`
  return formatElapsed(ms)
}

export function sessionStatusLabel(view: SessionView, now: number, waiting = 0): string {
  const goal = view.autonomy?.goal?.status === "active"
  const level = view.autonomy?.yolo ?? 0
  const prefix = level > 0 && goal ? `YOLO ${level} + Goal · autonomous` : level > 0 ? `YOLO ${level} · auto-approve` : goal ? "Goal · autonomous" : ""
  const assistant = view.messages.findLast((message) => message.kind === "assistant")
  const retry = view.status === "running" && assistant?.kind === "assistant" && assistant.completed === undefined ? assistant.retry : undefined
  const retryProgress = assistant?.kind === "assistant" && assistant.parts.some((part) => part.kind === "text" && part.text.length > 0 || part.kind === "reasoning" || part.kind === "tool")
  const activeTool = assistant?.kind === "assistant" ? assistant.parts.findLast((part) => part.kind === "tool" && (part.status === "running" || part.status === "streaming")) : undefined
  const activeReasoning = assistant?.kind === "assistant" ? assistant.parts.findLast((part) => part.kind === "reasoning" && part.completed === undefined) : undefined
  const elapsed = view.executionStarted === undefined ? "" : ` · ${formatElapsed(now - view.executionStarted)}`
  const status = view.status === "failed" ? "provider error"
    : retry && retry.at > now ? `${retry.attempt - 1} failed · retry ${retry.attempt} · in ${Math.ceil((retry.at - now) / 1_000)}s`
    : retry && !retryProgress ? `retrying · attempt ${retry.attempt}`
    : view.requests.length && view.status === "running" ? `? awaiting input${elapsed}`
    : view.status === "running" && activeTool ? `tool running${elapsed}`
    : view.status === "running" && activeReasoning ? `thinking${elapsed}`
    : view.status === "running" && waiting ? `waiting · ${waiting} subagent${waiting === 1 ? "" : "s"}`
    : view.status === "running" ? `cooking${elapsed}`
    : waiting ? `waiting · ${waiting} subagent${waiting === 1 ? "" : "s"}` : "ready"
  return prefix ? `${prefix} · ${status}` : status
}

export function sessionStatusTimed(view: SessionView, waiting = 0): boolean {
  if (view.status !== "running") return false
  if (view.requests.length || waiting === 0) return true
  const assistant = view.messages.findLast((message) => message.kind === "assistant")
  if (assistant?.kind === "assistant" && assistant.completed === undefined && assistant.retry) return true
  return assistant?.kind === "assistant" && assistant.parts.some((part) => part.kind === "tool" && (part.status === "running" || part.status === "streaming") || part.kind === "reasoning" && part.completed === undefined)
}

export function toolSummary(part: Extract<AssistantPart, { kind: "tool" }>): string {
  const input = part.input ?? {}
  const field = (key: string) => typeof input[key] === "string" ? input[key] : undefined
  const name = part.name.toLowerCase()
  if (name === "shell") {
    const command = field("command") ?? "Shell"
    return command.length > 72 ? `${command.slice(0, 35)}…${command.slice(-35)}` : command
  }
  if (name === "read" || name === "write" || name === "edit" || name === "patch") return `${name[0]!.toUpperCase()}${name.slice(1)} ${field("path") ?? "file"}`
  if (name === "grep" || name === "glob") return `${name === "grep" ? "Grep" : "Glob"} "${field("pattern") ?? ""}"${field("path") ? ` in ${field("path")}` : ""}`
  if (name === "subagent") return `${field("agent") ?? field("subagent_type") ?? "General"} Subagent — ${field("description") ?? "Subagent"}`
  if (name === "skill") return `Skill "${field("id") ?? "skill"}"`
  return part.name
}

export function toolTone(part: Extract<AssistantPart, { kind: "tool" }>): "success" | "error" | "attention" | "running" {
  if (part.name.toLowerCase() === "subagent" && part.structured?.status === "running") return "running"
  if (part.status === "completed") return "success"
  if (part.status === "streaming" || part.status === "running") return "running"
  return /abort|cancel|interrupt|kill/i.test(part.error ?? "") ? "attention" : "error"
}

export function transcriptPartVisible(part: AssistantPart): boolean {
  if (part.kind === "text" || part.kind === "reasoning") return Boolean(part.text.trim())
  if (part.name === "goal") return false
  return part.name !== "skill" || part.status !== "completed" || part.structured?.alreadyActive !== true
}

export function transcriptMessageVisible(message: RemoteMessageView): boolean {
  if ((message.kind === "system" || message.kind === "synthetic") && (message.source === "session-state" || message.source === "team-view")) return false
  if (message.kind === "synthetic") return Boolean(message.description?.trim())
  if (message.kind === "compaction") return message.status === "running" || message.status === "completed" || message.status === "failed" && (message.failureCode === "cancelled" || message.failureCode === "superseded" || message.jobID === undefined && message.failureCode === "aborted")
  if (message.kind === "assistant") return message.parts.some(transcriptPartVisible) || message.completed !== undefined || message.error !== undefined || message.retry !== undefined
  return true
}

export function visibleTranscriptMessages(messages: readonly RemoteMessageView[]): readonly RemoteMessageView[] {
  const latestCompaction = messages.findLast((message) => message.kind === "compaction" && transcriptMessageVisible(message))?.id
  const visible = messages.filter((message) => transcriptMessageVisible(message) && (message.kind !== "compaction" || message.id === latestCompaction))
  const pendingInput = (message: RemoteMessageView) => message.kind === "user" && message.state === "pending" || message.kind === "synthetic" && message.pending === true
  return [...visible.filter((message) => !pendingInput(message)), ...visible.filter(pendingInput)]
}

export function readPendingInputs(payload: unknown, sessionID: string): readonly RemoteMessageView[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined
  const rows = payload.data.flatMap((item): readonly RemoteMessageView[] => {
    if (!isRecord(item) || !isRecord(item.data) || item.sessionID !== sessionID) return []
    const id = stringField(item.id)
    const created = numberField(item.timeCreated)
    const delivery = deliveryField(item.delivery)
    if (id === undefined || created === undefined || delivery === undefined) return []
    if (item.type === "user") {
      const text = stringField(item.data.text)
      if (text === undefined) return []
      const attachments = readAttachments(item.data.files)
      return [{ kind: "user", id, text, delivery, state: "pending", created,
        ...(attachments.length === 0 ? {} : { attachments }) }]
    }
    if (item.type !== "synthetic") return []
    const text = stringField(item.data.text)
    if (text === undefined) return []
    const metadata = recordField(item.data.metadata)
    return [{ kind: "synthetic", id, text, pending: true, created,
      ...(stringField(item.data.description) === undefined ? {} : { description: stringField(item.data.description) }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(metadata && stringField(metadata.contextSource) ? { source: stringField(metadata.contextSource) } : {}) }]
  })
  return rows.length === payload.data.length ? rows : undefined
}

export function reconcilePendingInputs(view: SessionView, pending: readonly RemoteMessageView[], retainIDs: ReadonlySet<string> = new Set()): SessionView {
  const known = new Map(view.messages.map((message) => [message.id, message]))
  const retained = view.messages.filter((message) =>
    !(message.kind === "user" && message.state === "pending" || message.kind === "synthetic" && message.pending) || retainIDs.has(message.id))
  const admitted = pending.flatMap((message) => {
    const existing = known.get(message.id)
    if (existing && !(existing.kind === "user" && existing.state === "pending" || existing.kind === "synthetic" && existing.pending)) return []
    return [{ ...message, ...(existing?.kind === "user" && message.kind === "user" && existing.attachments && !message.attachments ? { attachments: existing.attachments } : {}) }]
  })
  return { ...view, messages: visibleTranscript([...retained.filter((message) => !admitted.some((item) => item.id === message.id)), ...admitted]) }
}

export function classifySyntheticNotice(message: RemoteMessageView):
  | { readonly kind: "subagent"; readonly label: string; readonly status: "completed" | "failed" | "waiting" | "updated"; readonly excerpt?: string }
  | { readonly kind: "completion"; readonly label: string; readonly status: string; readonly description: string }
  | { readonly kind: "goal"; readonly text: string }
  | undefined {
  if (message.kind !== "synthetic") return undefined
  const metadata = message.metadata
  if (metadata?.source === "subagent_notification") {
    const type = metadata.type
    const status = type === "completed" || type === "failed" || type === "waiting" ? type : "updated"
    const label = typeof metadata.agent === "string" ? metadata.agent : typeof metadata.childID === "string" ? metadata.childID : "Subagent"
    return { kind: "subagent", label, status, ...(typeof metadata.excerpt === "string" && metadata.excerpt.trim() ? { excerpt: metadata.excerpt } : {}) }
  }
  if (metadata?.source === "subagent" || metadata?.source === "shell") {
    const label = metadata.source === "shell" ? "Shell" : typeof metadata.agent === "string" ? metadata.agent : "Subagent"
    const status = metadata.state === "completed" ? "finished" : metadata.state === "error" ? "failed" : metadata.state === "cancelled" ? "cancelled" : typeof metadata.state === "string" ? metadata.state : "finished"
    return { kind: "completion", label, status, description: message.description ?? "" }
  }
  if (isRecord(metadata?.autonomy) && metadata.autonomy.goal === true) return { kind: "goal", text: message.text }
  return undefined
}

export function noticeSummary(source: string | undefined, text: string): string | undefined {
  const prefix = source === "session-state" ? "Authoritative current Session state (JSON):\n"
    : source === "team-view" ? "Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n" : undefined
  if (!prefix || !text.startsWith(prefix)) return undefined
  const unavailable = source === "session-state" ? "Session state · unavailable" : "TeamView · unavailable"
  try {
    const value: unknown = JSON.parse(text.slice(prefix.length).split("\n")[0] ?? "")
    if (!isRecord(value)) return unavailable
    if (source === "session-state") {
      const autonomy = isRecord(value.autonomy) ? value.autonomy : {}
      const count = Array.isArray(value.todos) ? value.todos.length : 0
      return `Session state · ${typeof autonomy.mode === "string" ? autonomy.mode : "unknown"} · YOLO ${typeof autonomy.yolo === "number" || typeof autonomy.yolo === "boolean" ? autonomy.yolo : 0} · ${count} ${count === 1 ? "task" : "tasks"}`
    }
    const children = Array.isArray(value.children) ? value.children : []
    const states = children.flatMap((child) => isRecord(child) && typeof child.state === "string" ? [child.state] : [])
    const omitted = typeof value.omitted === "number" && value.omitted > 0 ? value.omitted : 0
    if (!states.length) return omitted ? `TeamView · ${omitted} omitted` : "TeamView · no children"
    return `TeamView · ${[...new Set(states)].map((state) => `${states.filter((item) => item === state).length} ${state}`).concat(omitted ? [`${omitted} omitted`] : []).join(" · ")}`
  } catch {
    return unavailable
  }
}

export function boundedText(
  text: string,
  limit = messageTextLimit,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

/** Collapsed-output budget: a few lines, also bounded by characters. */
const previewLineLimit = 12
const previewCharLimit = 2_000

/**
 * Collapsed preview of available text. `hasMore` is true only when the preview is
 * shorter than the text, so a control built on it always changes what is rendered.
 */
export function previewText(
  text: string,
  limit: { readonly lines: number; readonly chars: number } = { lines: previewLineLimit, chars: previewCharLimit },
): { readonly text: string; readonly hasMore: boolean } {
  const wholeLines = text.split("\n").slice(0, limit.lines).join("\n")
  const cut = wholeLines.length > limit.chars ? wholeLines.slice(0, limit.chars) : wholeLines
  return { text: cut, hasMore: cut.length < text.length }
}

/**
 * Source-side limit notice. It stays separate from the collapsed preview so a
 * "Show more" control never has to stand in for output the device did not send.
 */
export function shellOutputNotice(output: ShellOutputView): string | undefined {
  if (output.cursor < output.size) {
    return `Showing the first ${output.cursor} of ${output.size} bytes retained on the device; the rest stays on the device.`
  }
  if (output.truncated) return `The device reports this output as truncated at ${output.size} bytes.`
  return undefined
}

function readShellOutput(value: unknown): ShellOutputView | undefined {
  if (!isRecord(value)) return undefined
  const text = typeof value.output === "string" ? value.output : undefined
  const cursor = numberField(value.cursor)
  const size = numberField(value.size)
  if (text === undefined || cursor === undefined || size === undefined) return undefined
  return { text, cursor, size, truncated: value.truncated === true }
}

/** Reads a `session.shell.output` response envelope: `{ data: Shell.Output }`. */
export function readShellOutputPage(payload: unknown): ShellOutputView | undefined {
  return readShellOutput(isRecord(payload) ? payload.data : undefined)
}

/**
 * Applies a device page that starts at byte zero, from a `session.shell.*` event or a
 * snapshot message. A client that already fetched past it keeps its longer text: both
 * are decodings of the same capture prefix, so the device page adds nothing new.
 */
export function mergeShellOutputSnapshot(
  existing: ShellOutputView | undefined,
  page: ShellOutputView,
): ShellOutputView {
  if (existing === undefined || existing.cursor < page.cursor) return page
  return {
    ...existing,
    size: Math.max(existing.size, page.size),
    truncated: existing.truncated || page.truncated,
  }
}

/**
 * Appends one fetched continuation page. `from` is the byte cursor the page was asked
 * for, so bytes a durable update already delivered are dropped instead of repeated. A
 * device read clamps a cursor past its own capture to the captured size, so a reply can
 * name a smaller cursor than the client holds and must never rewind it.
 */
export function appendShellOutputPage(
  existing: ShellOutputView | undefined,
  page: ShellOutputView,
  from: number,
): ShellOutputView {
  if (existing !== undefined && existing.cursor > from) {
    return {
      ...existing,
      size: Math.max(existing.size, page.size),
      truncated: existing.truncated || page.truncated,
    }
  }
  return {
    text: `${existing?.text ?? ""}${page.text}`,
    cursor: Math.max(existing?.cursor ?? 0, page.cursor),
    size: Math.max(existing?.size ?? 0, page.size),
    truncated: (existing?.truncated ?? false) || page.truncated,
  }
}

/**
 * The shell a tool call ran on the device, read from the `structured` record the device
 * sent. A tool call that carries no such record has no readable capture: the transcript
 * never carries a capture path, and remote input never selects one.
 */
export function toolShellID(part: Extract<AssistantPart, { kind: "tool" }>): string | undefined {
  const value = part.structured?.shellID
  return typeof value === "string" && /^sh_[A-Za-z0-9]+$/.test(value) ? value : undefined
}

/**
 * The paged capture the client holds for one shell, from its transcript message or from
 * the tool call that ran it. `undefined` means no page has been read for that shell yet.
 */
export function shellOutputFor(view: SessionView, shellID: string): ShellOutputView | undefined {
  const message = view.messages.find(
    (entry): entry is Extract<RemoteMessageView, { kind: "shell" }> =>
      entry.kind === "shell" && entry.shellID === shellID,
  )
  return message === undefined ? findToolShellPart(view, shellID)?.shellOutput : message.output
}

/** The client page-request state for one shell, wherever the client holds that shell. */
export function shellOutputFetchFor(view: SessionView, shellID: string): ShellOutputFetch | undefined {
  const message = view.messages.find(
    (entry): entry is Extract<RemoteMessageView, { kind: "shell" }> =>
      entry.kind === "shell" && entry.shellID === shellID,
  )
  return message === undefined ? findToolShellPart(view, shellID)?.shellOutputFetch : message.outputFetch
}

/** Records the client page-request state for one shell without touching device data. */
export function withShellOutputFetch(view: SessionView, shellID: string, fetch: ShellOutputFetch): SessionView {
  return updateShellOutput(
    view,
    shellID,
    (message) => ({ ...message, outputFetch: fetch }),
    (part) => ({ ...part, shellOutputFetch: fetch }),
  )
}

/**
 * Applies one fetched page to the shell it names, wherever the client holds that shell.
 * A shell the view no longer contains is left alone, so a late page cannot attach to a
 * different shell or session.
 */
export function withShellOutputPage(
  view: SessionView,
  shellID: string,
  page: ShellOutputView,
  from: number,
  fetch: ShellOutputFetch,
): SessionView {
  return updateShellOutput(
    view,
    shellID,
    (message) => ({ ...message, output: appendShellOutputPage(message.output, page, from), outputFetch: fetch }),
    (part) => ({ ...part, shellOutput: appendShellOutputPage(part.shellOutput, page, from), shellOutputFetch: fetch }),
  )
}

function findToolShellPart(
  view: SessionView,
  shellID: string,
): Extract<AssistantPart, { kind: "tool" }> | undefined {
  for (const message of view.messages) {
    if (message.kind !== "assistant") continue
    for (const part of message.parts) {
      if (part.kind === "tool" && toolShellID(part) === shellID) return part
    }
  }
  return undefined
}

function updateShellOutput(
  view: SessionView,
  shellID: string,
  updateMessage: (
    message: Extract<RemoteMessageView, { kind: "shell" }>,
  ) => Extract<RemoteMessageView, { kind: "shell" }>,
  updatePart: (part: Extract<AssistantPart, { kind: "tool" }>) => Extract<AssistantPart, { kind: "tool" }>,
): SessionView {
  let changed = false
  const messages = view.messages.map((message) => {
    if (message.kind === "shell" && message.shellID === shellID) {
      changed = true
      return updateMessage(message)
    }
    if (message.kind !== "assistant") return message
    if (!message.parts.some((part) => part.kind === "tool" && toolShellID(part) === shellID)) return message
    changed = true
    return {
      ...message,
      parts: message.parts.map((part) =>
        part.kind === "tool" && toolShellID(part) === shellID ? updatePart(part) : part,
      ),
    }
  })
  return changed ? { ...view, messages } : view
}

/** Reads a Protocol response envelope: the JSON body is `{ data: [...] }`. */
export function readDataList(payload: unknown): readonly unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return []
  return payload.data
}

export function readSessionInfoList(payload: unknown): readonly unknown[] {
  return readDataList(payload)
}

export function readMessageList(payload: unknown): readonly RemoteMessageView[] {
  return readDataList(payload).flatMap((item) => {
    const message = readProjectedMessage(item)
    return message ? [message] : []
  })
}

export function readAutonomy(payload: unknown): SessionAutonomyView | undefined {
  const data = dataOf(payload)
  if (!isRecord(data)) return undefined
  const mode = data.mode === "goal" || data.mode === "yolo" ? data.mode : "normal"
  const goal = isRecord(data.goal) ? readGoal(data.goal) : undefined
  return {
    mode: goal?.status === "active" ? "goal" : mode,
    yolo: readYolo(data.yolo),
    ...(goal === undefined ? {} : { goal }),
  }
}

export function applySessionEvent(view: SessionView, payload: unknown, now: number): SessionView {
  const event = readEvent(payload)
  if (!event) return bump(view)
  if (ignoredEventTypes.includes(event.type)) return view
  const data = event.data
  const activeAt = event.created === undefined ? view.activeAt : Math.max(view.activeAt ?? event.created, event.created)
  switch (event.type) {
    case "session.created": {
      const created = readModelRef(data.model)
      return {
        ...view,
        title: stringField(data.title) ?? view.title,
        agent: stringField(data.agent) ?? view.agent,
        model: created ?? view.model,
        updatedAt: now,
      }
    }
    case "session.renamed":
      return { ...view, title: stringField(data.title) ?? view.title, updatedAt: now }
    case "session.archived":
      return { ...view, archived: true, updatedAt: now }
    case "session.unarchived":
      return { ...view, archived: false, updatedAt: now }
    case "session.agent.selected":
      return { ...view, agent: stringField(data.agent) ?? view.agent, updatedAt: now }
    case "session.model.selected": {
      const selected = readModelRef(data.model)
      return { ...view, model: selected ?? view.model, updatedAt: now }
    }
    case "session.diagnostics.updated": {
      if (stringField(data.sessionID) !== view.id || !isRecord(data.diagnostics)) return view
      const context = isRecord(data.diagnostics.context) ? data.diagnostics.context : undefined
      return { ...view, generationSpeed: readGenerationSpeed(data.diagnostics.generationSpeed),
        contextWindow: readContextWindow(data.diagnostics.model, context?.total, context?.limit), updatedAt: now }
    }
    case "session.execution.started":
      return { ...clearAssistantRetry(view), status: "running", executionStarted: now, updatedAt: now }
    case "session.execution.succeeded":
      return { ...clearAssistantRetry(view), status: "idle", executionStarted: undefined, updatedAt: now, activeAt }
    case "session.execution.failed":
      return { ...clearAssistantRetry(view), status: "failed", executionStarted: undefined, lastError: readError(data.error), updatedAt: now, activeAt }
    case "session.execution.interrupted":
      return { ...clearAssistantRetry(view), status: "interrupted", executionStarted: undefined, updatedAt: now, activeAt }
    case "session.status":
      return applyStatus(view, data, now)
    case "session.idle":
      return { ...clearAssistantRetry(view), status: "idle", executionStarted: undefined, updatedAt: now }
    case "session.retry.scheduled":
      return { ...withAssistant(view, data, now, (message) => ({ ...message, retry: readAssistantRetry(data) ?? message.retry })), status: "running", updatedAt: now }
    case "session.input.admitted":
      return applyAdmitted(view, data, now)
    case "session.input.promoted":
      return view.messages.some((message) => message.id === data.inputID && message.kind === "synthetic")
        ? { ...view, messages: view.messages.map((message) => message.id === data.inputID && message.kind === "synthetic" ? { ...message, pending: false } : message) }
        : updateUserMessage(view, stringField(data.inputID), (message) => ({ ...message, state: "promoted" }))
    case "session.input.consumed": {
      const ids = stringList(data.inputIDs)
      return ids.reduce(
        (current, id) => updateUserMessage(current, id, (message) => ({ ...message, state: "consumed" })),
        view,
      )
    }
    case "session.step.started":
      return withAssistant(view, data, now, (message) => {
        const stepModel = readModelRef(data.model)
        return {
          ...message,
          created: message.parts.length === 0 ? now : message.created,
          agent: stringField(data.agent) ?? message.agent,
          model: stepModel ?? message.model,
          retry: undefined,
        }
      })
    case "session.step.ended":
      return { ...withAssistant(view, data, now, (message) => ({ ...message, completed: now, retry: undefined })), activeAt }
    case "session.step.failed":
      return { ...withAssistant(view, data, now, (message) => ({
        ...message,
        completed: now,
        retry: undefined,
        error: readError(data.error)?.message ?? "The step failed",
      })), activeAt }
    case "session.text.started":
      return withTextPart(view, data, now, (part) => part)
    case "session.text.delta":
      return withTextPart(view, data, now, (part) => ({ ...part, text: part.text + (stringField(data.delta) ?? "") }))
    case "session.text.ended":
      return withTextPart(view, data, now, (part) => ({
        ...part,
        text: stringField(data.text) ?? part.text,
        ...(phaseField(data.phase) === undefined ? {} : { phase: phaseField(data.phase) }),
      }))
    case "session.reasoning.started":
      return withReasoningPart(view, data, now, (part) => ({ ...part, started: part.started ?? now }))
    case "session.reasoning.delta":
      return withReasoningPart(view, data, now, (part) => ({
        ...part,
        text: part.text + (stringField(data.delta) ?? ""),
      }))
    case "session.reasoning.ended":
      return withReasoningPart(view, data, now, (part) => ({ ...part, text: stringField(data.text) ?? part.text, completed: now }))
    case "session.tool.input.started":
      return withToolPart(view, data, now, (part) => ({
        ...part,
        name: stringField(data.name) ?? part.name,
        status: "streaming",
        started: part.started ?? now,
      }))
    case "session.tool.input.delta":
      return withToolPart(view, data, now, (part) => ({
        ...part,
        status: "streaming",
        inputText: (part.inputText ?? "") + (stringField(data.delta) ?? ""),
      }))
    case "session.tool.input.ended":
      return withToolPart(view, data, now, (part) => ({
        ...part,
        status: "running",
        ran: part.ran ?? now,
        inputText: stringField(data.text) ?? part.inputText,
      }))
    case "session.tool.called":
      return withToolPart(view, data, now, (part) => ({
        ...part,
        status: "running",
        ran: part.ran ?? now,
        input: recordField(data.input) ?? part.input,
      }))
    case "session.tool.progress":
      return withToolPart(view, data, now, (part) => ({
        ...part,
        status: "running",
        content: readToolContent(data.content),
        structured: recordField(data.structured) ?? part.structured,
      }))
    case "session.tool.success":
      return withToolPart(view, data, now, (part) => ({
        ...part,
        status: "completed",
        completed: now,
        content: readToolContent(data.content),
        input: recordField(data.input) ?? part.input,
        structured: recordField(data.structured) ?? part.structured,
      }))
    case "session.tool.failed":
      return withToolPart(view, data, now, (part) => ({
        ...part,
        status: "failed",
        completed: now,
        error: readError(data.error)?.message ?? "The tool failed",
      }))
    case "session.shell.started":
      return applyShell(view, data, now, false)
    case "session.shell.ended":
      return applyShell(view, data, now, true)
    case "session.context.observed":
      return pushMessage(view, {
        kind: data.source === "team-view" ? "synthetic" : "system",
        id: event.id ?? `context_${view.messages.length}`,
        text: stringField(data.text) ?? "",
        ...(stringField(data.source) ? { source: stringField(data.source) } : {}),
        created: now,
      })
    case "session.compaction.admitted":
      return withCompaction(view, data, "pending", event.created ?? now)
    case "session.compaction.started":
      return withCompaction(view, data, "running", event.created ?? now)
    case "session.compaction.ended":
      return stringField(data.jobID) === undefined ? view : {
        ...withCompaction(view, data, "completed", event.created ?? now),
        generationSpeed: undefined, contextWindow: undefined,
      }
    case "session.compaction.failed":
      return withCompaction(view, data, "failed", event.created ?? now, readError(data.error)?.message)
    case "session.synthetic":
      return pushMessage(view, {
        kind: "synthetic",
        id: event.id ?? `synthetic_${view.messages.length}`,
        text: stringField(data.text) ?? "",
        ...(stringField(data.description) === undefined ? {} : { description: stringField(data.description) }),
        ...(recordField(data.metadata) === undefined ? {} : { metadata: recordField(data.metadata) }),
        ...(isRecord(data.metadata) && stringField(data.metadata.contextSource) ? { source: stringField(data.metadata.contextSource) } : {}),
        created: now,
      })
    case "session.skill.activated":
      return pushMessage(view, {
        kind: "notice",
        id: event.id ?? `skill_${view.messages.length}`,
        notice: "skill",
        text: `Skill activated: ${stringField(data.name) ?? stringField(data.id) ?? "unknown"}`,
        created: now,
      })
    case "session.revert.staged":
      return pushNotice(view, "revert", "Revert staged", now)
    case "session.revert.cleared":
      return pushNotice(view, "revert", "Revert cleared", now)
    case "session.revert.committed":
      return { ...pushNotice(view, "revert", `Revert committed to ${stringField(data.to) ?? "boundary"}`, now),
        generationSpeed: undefined, contextWindow: undefined }
    case "permission.v2.asked":
      return pushRequest(view, {
        kind: "permission",
        id: stringField(data.id) ?? "permission",
        action: stringField(data.action) ?? "unknown action",
        resources: stringList(data.resources),
        askedAt: now,
      })
    case "permission.v2.replied":
      return removeRequest(view, stringField(data.requestID))
    case "guardrail.asked":
      return pushRequest(view, {
        kind: "guardrail",
        id: stringField(data.id) ?? "guardrail",
        sessionID: stringField(data.sessionID) ?? view.id,
        ...(stringField(data.rootSessionID) === undefined ? {} : { rootSessionID: stringField(data.rootSessionID) }),
        action: stringField(data.action) ?? "unknown action",
        resources: stringList(data.resources),
        reason: stringField(data.reason) ?? "Guardrail review required",
        hardReview: data.hardReview === true,
        ...(isRecord(data.metadata) ? { metadata: data.metadata } : {}),
        askedAt: now,
      })
    case "guardrail.replied":
      return removeRequest(view, stringField(data.requestID))
    case "form.created": {
      const form = readForms([data.form])[0]
      if (form === undefined || form.sessionID !== view.id) return view
      return pushRequest(view, { kind: "form", id: form.id, form, askedAt: now })
    }
    case "form.replied":
    case "form.cancelled":
      return data.sessionID === view.id ? removeRequest(view, stringField(data.id)) : view
    default:
      return bump(view)
  }
}

export function readSnapshotParts(content: unknown): readonly AssistantPart[] {
  if (!Array.isArray(content)) return []
  const parts: AssistantPart[] = []
  for (const item of content) {
    if (!isRecord(item)) continue
    if (item.type === "text") {
      parts.push({
        kind: "text",
        ordinal: parts.length,
        text: stringField(item.text) ?? "",
        ...(phaseField(item.phase) === undefined ? {} : { phase: phaseField(item.phase) }),
      })
      continue
    }
    if (item.type === "reasoning") {
      const time = recordField(item.time)
      parts.push({ kind: "reasoning", ordinal: parts.length, text: stringField(item.text) ?? "", ...(time && numberField(time.created) !== undefined ? { started: numberField(time.created) } : {}), ...(time && numberField(time.completed) !== undefined ? { completed: numberField(time.completed) } : {}) })
      continue
    }
    if (item.type === "tool") {
      const state = isRecord(item.state) ? item.state : {}
      const status = stringField(state.status)
      const time = recordField(item.time)
      parts.push({
        kind: "tool",
        callID: stringField(item.id) ?? `tool-${parts.length}`,
        name: stringField(item.name) ?? "tool",
        status: status === "error" ? "failed" : status === "streaming" || status === "running" ? status : "completed",
        ...(stringField(state.input) === undefined ? {} : { inputText: stringField(state.input) }),
        ...(recordField(state.input) === undefined ? {} : { input: recordField(state.input) }),
        content: readToolContent(state.content),
        ...(time && numberField(time.created) !== undefined ? { started: numberField(time.created) } : {}),
        ...(time && numberField(time.ran) !== undefined ? { ran: numberField(time.ran) } : {}),
        ...(time && numberField(time.completed) !== undefined ? { completed: numberField(time.completed) } : {}),
        ...(recordField(state.structured) === undefined ? {} : { structured: recordField(state.structured) }),
        ...(readError(state.error)?.message === undefined ? {} : { error: readError(state.error)?.message }),
      })
    }
  }
  return parts
}

export function readToolContent(content: unknown): readonly ToolContentBlock[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((item): readonly ToolContentBlock[] => {
    if (!isRecord(item)) return []
    const type = stringField(item.type) ?? "unknown"
    if (type === "text") {
      const text = stringField(item.text)
      if (text === undefined) return []
      const visible = text.replace(
        /\.\.\. output truncated; full content saved to [^\r\n]*|\[output truncated; full output saved to: [^\r\n]*/g,
        "[full output retained on the device]",
      )
      return [{ kind: "text", text: visible, ...(visible === text ? {} : { sourceTruncated: true }) }]
    }
    if (type === "file") {
      const mime = stringField(item.mime)
      const uri = stringField(item.uri)
      if (mime !== undefined && imageMimes.has(mime) && uri !== undefined &&
        uri.startsWith(`data:${mime};base64,`) && isWellFormedBase64(uri.slice(`data:${mime};base64,`.length)))
        return [{ kind: "image", uri, mime, ...(stringField(item.name) === undefined ? {} : { name: stringField(item.name) }) }]
      return [{ kind: "other", type, summary: stringField(item.name) ?? "File" }]
    }
    const summary = Object.entries(item)
      .flatMap(([key, entry]) => (typeof entry === "string" ? [`${key}: ${boundedText(entry, 200).text}`] : []))
      .join(", ")
    return [{ kind: "other" as const, type, summary }]
  })
}

/** Reads the browser-safe structural projection of `Form.Info` without importing runtime code. */
export function readForms(value: unknown): readonly FormView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): readonly FormView[] => {
    if (!isRecord(item)) return []
    const id = stringField(item.id)
    const sessionID = stringField(item.sessionID)
    const title = stringField(item.title)
    if (id === undefined || sessionID === undefined || title === undefined || !Array.isArray(item.fields)) return []
    const fields = item.fields.flatMap(readFormField)
    return fields.length === 0 || fields.length !== item.fields.length ? [] : [{ id, sessionID, title, ...(recordField(item.metadata) === undefined ? {} : { metadata: recordField(item.metadata) }), fields }]
  })
}

function readFormField(value: unknown): readonly FormFieldView[] {
  if (!isRecord(value)) return []
  const key = stringField(value.key)
  const type = stringField(value.type)
  if (key === undefined || type === undefined) return []
  const when = readFormWhen(value.when)
  if (value.when !== undefined && (!Array.isArray(value.when) || when.length !== value.when.length)) return []
  const common = { key, ...(stringField(value.title) === undefined ? {} : { title: stringField(value.title) }), ...(stringField(value.description) === undefined ? {} : { description: stringField(value.description) }), ...(typeof value.required === "boolean" ? { required: value.required } : {}), ...(value.when === undefined ? {} : { when }) }
  if (type === "external") {
    const url = stringField(value.url)
    return url === undefined ? [] : [{ key, type, url, ...(stringField(value.title) === undefined ? {} : { title: stringField(value.title) }), ...(stringField(value.description) === undefined ? {} : { description: stringField(value.description) }) }]
  }
  if (type === "string") {
    const options = readFormOptions(value.options)
    if (value.options !== undefined && (!Array.isArray(value.options) || options.length !== value.options.length)) return []
    return [{ ...common, type,
      ...(value.options === undefined ? {} : { options }),
      ...(typeof value.custom === "boolean" ? { custom: value.custom } : {}),
      ...(typeof value.default === "string" ? { default: value.default } : {}),
      ...(typeof value.placeholder === "string" ? { placeholder: value.placeholder } : {}),
      ...(typeof value.pattern === "string" ? { pattern: value.pattern } : {}),
      ...(typeof value.minLength === "number" ? { minLength: value.minLength } : {}),
      ...(typeof value.maxLength === "number" ? { maxLength: value.maxLength } : {}),
      ...(value.format === "email" || value.format === "uri" || value.format === "date" || value.format === "date-time" ? { format: value.format } : {}),
    }]
  }
  if (type === "multiselect") {
    const options = readFormOptions(value.options)
    if (!Array.isArray(value.options) || options.length !== value.options.length) return []
    return [{ ...common, type, options,
      ...(typeof value.custom === "boolean" ? { custom: value.custom } : {}),
      ...(Array.isArray(value.default) ? { default: stringList(value.default) } : {}),
      ...(typeof value.minItems === "number" ? { minItems: value.minItems } : {}),
      ...(typeof value.maxItems === "number" ? { maxItems: value.maxItems } : {}),
    }]
  }
  if (type === "number" || type === "integer") return [{ ...common, type, ...(typeof value.minimum === "number" ? { minimum: value.minimum } : {}), ...(typeof value.maximum === "number" ? { maximum: value.maximum } : {}), ...(typeof value.default === "number" ? { default: value.default } : {}) }]
  if (type === "boolean") return [{ ...common, type, ...(typeof value.default === "boolean" ? { default: value.default } : {}) }]
  return []
}

function readFormOptions(value: unknown) { return Array.isArray(value) ? value.flatMap((option) => isRecord(option) && stringField(option.value) !== undefined && stringField(option.label) !== undefined ? [{ value: stringField(option.value) ?? "", label: stringField(option.label) ?? "", ...(stringField(option.description) === undefined ? {} : { description: stringField(option.description) }) }] : []) : [] }
function readFormWhen(value: unknown): readonly FormWhenView[] { return Array.isArray(value) ? value.flatMap((when) => isRecord(when) && stringField(when.key) !== undefined && (when.op === "eq" || when.op === "neq") && (typeof when.value === "string" || typeof when.value === "number" || typeof when.value === "boolean") ? [{ key: stringField(when.key) ?? "", op: when.op, value: when.value }] : []) : [] }

export function readError(
  value: unknown,
): { readonly code: string; readonly message: string } | undefined {
  if (!isRecord(value)) return undefined
  const code = stringField(value.code) ?? stringField(value.type)
  const message = stringField(value.message)
  if (code === undefined && message === undefined) return undefined
  return { code: code ?? "error", message: message ?? code ?? "unknown error" }
}

function readAssistantRetry(value: unknown): Extract<RemoteMessageView, { kind: "assistant" }>["retry"] {
  if (!isRecord(value)) return undefined
  const attempt = positiveInteger(value.attempt)
  const at = numberField(value.at)
  return attempt === undefined || at === undefined || at < 0 ? undefined : { attempt, at, code: readError(value.error)?.code ?? "unknown" }
}

function applyStatus(view: SessionView, data: Record<string, unknown>, now: number): SessionView {
  const status = isRecord(data.status) ? data.status : {}
  if (status.type === "busy") return { ...view, status: "running", updatedAt: now }
  if (status.type === "idle") return { ...clearAssistantRetry(view), status: "idle", executionStarted: undefined, updatedAt: now }
  if (status.type === "retry") {
    const assistant = view.messages.findLast((message) => message.kind === "assistant")
    return { ...(assistant?.kind !== "assistant" ? view : withAssistant(view, { assistantMessageID: assistant.id }, now, (message) => ({ ...message,
      retry: { attempt: numberField(status.attempt) ?? 1, at: numberField(status.next) ?? now, code: stringField(status.message) ?? "retrying" } }))),
      status: "running",
      updatedAt: now,
    }
  }
  return bump(view)
}

function bump(view: SessionView): SessionView {
  return { ...view, unhandledEvents: view.unhandledEvents + 1 }
}

function readEvent(
  payload: unknown,
): { readonly type: string; readonly id?: string; readonly created?: number; readonly data: Record<string, unknown> } | undefined {
  if (!isRecord(payload)) return undefined
  const type = stringField(payload.type)
  if (type === undefined) return undefined
  if (!isRecord(payload.data)) return undefined
  return { type, id: stringField(payload.id), created: numberField(payload.created), data: payload.data }
}

function applyAdmitted(view: SessionView, data: Record<string, unknown>, now: number): SessionView {
  const id = stringField(data.inputID)
  if (id === undefined) return bump(view)
  const existing = view.messages.find((message) => message.id === id)
  // `session.input.admitted` carries `SessionPending.Message`: `{ type, data, delivery }`.
  const pending = isRecord(data.input) ? data.input : {}
  const payload = isRecord(pending.data) ? pending.data : pending
  if (pending.type === "synthetic") {
    const metadata = recordField(payload.metadata)
    const message: RemoteMessageView = {
      kind: "synthetic",
      id,
      text: stringField(payload.text) ?? "",
      ...(stringField(payload.description) ? { description: stringField(payload.description) } : {}),
      ...(metadata === undefined ? {} : { metadata }),
      ...(metadata && stringField(metadata.contextSource) ? { source: stringField(metadata.contextSource) } : {}),
      pending: true,
      created: existing?.kind === "synthetic" ? existing.created : now,
    }
    return existing ? replaceMessage(view, message) : pushMessage(view, message)
  }
  const text = stringField(payload.text) ?? (existing?.kind === "user" ? existing.text : "")
  const attachments = readAttachments(payload.files)
  const message: RemoteMessageView = {
    kind: "user",
    id,
    text,
    ...(attachments.length > 0 ? { attachments } : existing?.kind === "user" && existing.attachments ? { attachments: existing.attachments } : {}),
    delivery: deliveryField(pending.delivery),
    state: existing?.kind === "user" ? existing.state : "pending",
    created: existing?.kind === "user" ? existing.created : now,
  }
  return existing ? replaceMessage(view, message) : pushMessage(view, message)
}

function pushNotice(view: SessionView, notice: Extract<RemoteMessageView, { kind: "notice" }>["notice"], text: string, now: number): SessionView {
  return pushMessage(view, { kind: "notice", id: `notice_${notice}_${view.messages.length}`, notice, text, created: now })
}

function updateUserMessage(
  view: SessionView,
  id: string | undefined,
  update: (message: Extract<RemoteMessageView, { kind: "user" }>) => Extract<RemoteMessageView, { kind: "user" }>,
): SessionView {
  if (id === undefined) return bump(view)
  const existing = view.messages.find((message) => message.id === id)
  if (!existing || existing.kind !== "user") return view
  return replaceMessage(view, update(existing))
}

function withAssistant(
  view: SessionView,
  data: Record<string, unknown>,
  now: number,
  update: (
    message: Extract<RemoteMessageView, { kind: "assistant" }>,
  ) => Extract<RemoteMessageView, { kind: "assistant" }>,
): SessionView {
  const id = stringField(data.assistantMessageID)
  if (id === undefined) return bump(view)
  const existing = view.messages.find((message) => message.id === id)
  if (existing && existing.kind !== "assistant") return view
  const message =
    existing ?? { kind: "assistant" as const, id, parts: [] as readonly AssistantPart[], created: now }
  const updated = update(message)
  return existing ? replaceMessage(view, updated) : pushMessage(view, updated)
}

export function clearAssistantRetry(view: SessionView): SessionView {
  const assistant = view.messages.findLast((message) => message.kind === "assistant")
  return assistant?.kind === "assistant" && assistant.retry ? replaceMessage(view, { ...assistant, retry: undefined }) : view
}

function withTextPart(
  view: SessionView,
  data: Record<string, unknown>,
  now: number,
  update: (part: Extract<AssistantPart, { kind: "text" }>) => Extract<AssistantPart, { kind: "text" }>,
): SessionView {
  return withPart(view, data, now, "text", update, (ordinal) => ({ kind: "text", ordinal, text: "" }))
}

function withReasoningPart(
  view: SessionView,
  data: Record<string, unknown>,
  now: number,
  update: (part: Extract<AssistantPart, { kind: "reasoning" }>) => Extract<AssistantPart, { kind: "reasoning" }>,
): SessionView {
  return withPart(view, data, now, "reasoning", update, (ordinal) => ({ kind: "reasoning", ordinal, text: "" }))
}

function withPart<Kind extends "text" | "reasoning">(
  view: SessionView,
  data: Record<string, unknown>,
  now: number,
  kind: Kind,
  update: (part: Extract<AssistantPart, { kind: Kind }>) => Extract<AssistantPart, { kind: Kind }>,
  create: (ordinal: number) => Extract<AssistantPart, { kind: Kind }>,
): SessionView {
  const ordinal = numberField(data.ordinal)
  if (ordinal === undefined) return bump(view)
  return withAssistant(view, data, now, (message) => {
    const index = message.parts.findIndex((part) => part.kind === kind && part.ordinal === ordinal)
    if (index < 0) return { ...message, parts: [...message.parts, update(create(ordinal))] }
    return {
      ...message,
      parts: message.parts.map((part, position) =>
        position === index ? update(part as Extract<AssistantPart, { kind: Kind }>) : part,
      ),
    }
  })
}

function withToolPart(
  view: SessionView,
  data: Record<string, unknown>,
  now: number,
  update: (part: Extract<AssistantPart, { kind: "tool" }>) => Extract<AssistantPart, { kind: "tool" }>,
): SessionView {
  const callID = stringField(data.callID)
  if (callID === undefined) return bump(view)
  return withAssistant(view, data, now, (message) => {
    const index = message.parts.findIndex((part) => part.kind === "tool" && part.callID === callID)
    if (index < 0) {
      const created: Extract<AssistantPart, { kind: "tool" }> = {
        kind: "tool",
        callID,
        name: stringField(data.name) ?? "tool",
        status: "running",
        content: [],
      }
      return { ...message, parts: [...message.parts, update(created)] }
    }
    return {
      ...message,
      parts: message.parts.map((part, position) =>
        position === index && part.kind === "tool" ? update(part) : part,
      ),
    }
  })
}

function applyShell(view: SessionView, data: Record<string, unknown>, now: number, ended: boolean): SessionView {
  const shell = isRecord(data.shell) ? data.shell : data
  const shellID = stringField(shell.id) ?? stringField(data.shellID)
  if (shellID === undefined) return bump(view)
  const id = `msg_${shellID.replace(/^sh_/, "")}`
  const existing = view.messages.find((message) => message.id === id)
  const output = readShellOutput(data.output)
  const exit = numberField(shell.exit)
  const message: Extract<RemoteMessageView, { kind: "shell" }> = {
    kind: "shell",
    id,
    shellID,
    command: stringField(shell.command) ?? (existing?.kind === "shell" ? existing.command : "command"),
    status: ended ? stringField(shell.status) ?? "exited" : "running",
    ...(exit === undefined ? existing?.kind === "shell" && existing.exit !== undefined ? { exit: existing.exit } : {} : { exit }),
    ...(output === undefined
      ? existing?.kind === "shell" && existing.output !== undefined
        ? { output: existing.output }
        : {}
      : { output: mergeShellOutputSnapshot(existing?.kind === "shell" ? existing.output : undefined, output) }),
    ...(existing?.kind === "shell" && existing.outputFetch !== undefined ? { outputFetch: existing.outputFetch } : {}),
    created: existing?.kind === "shell" ? existing.created : now,
    ...(ended ? { completed: now } : {}),
  }
  const next = existing ? replaceMessage(view, message) : pushMessage(view, message)
  return { ...next, updatedAt: now }
}

function withCompaction(
  view: SessionView,
  data: Record<string, unknown>,
  status: "pending" | "running" | "completed" | "failed",
  created: number,
  error?: string,
): SessionView {
  const jobID = stringField(data.jobID)
  const existing = view.messages.find((message) => message.kind === "compaction" && (message.jobID === jobID && jobID !== undefined || message.id === jobID))
  const id = existing?.id ?? jobID ?? stringField(data.inputID) ?? `compaction_${view.messages.length}`
  const trigger = stringField(data.reason) ?? stringField(data.trigger)
  const messageTrigger = trigger ?? (existing?.kind === "compaction" ? existing.trigger : undefined)
  const boundary = isRecord(data.boundary) ? stringField(data.boundary.messageID) : undefined
  const metrics = readCompactionMetrics(data.metrics)
  const message: Extract<RemoteMessageView, { kind: "compaction" }> = {
    kind: "compaction",
    id,
    status,
    ...(jobID ? { jobID } : {}),
    ...(status === "failed" ? { failureCode: stringField(data.code) ?? readError(data.error)?.code } : {}),
    ...(status === "completed" && boundary !== undefined ? { boundaryMessageID: boundary } : {}),
    ...(messageTrigger === undefined ? {} : { trigger: messageTrigger }),
    ...(metrics ? { metrics } : {}),
    created: existing?.kind === "compaction" && existing.created !== undefined ? existing.created : created,
    ...(error === undefined ? {} : { error }),
  }
  const updated = existing ? replaceMessage(view, message) : pushMessage(view, message)
  return { ...updated, messages: visibleTranscript(updated.messages),
    ...(view.compactionHistory === undefined || jobID === undefined ? {} : { compactionHistory: updateCompactionHistory(view.compactionHistory, message) }) }
}

function updateCompactionHistory(history: RemoteCompactionHistory, message: Extract<RemoteMessageView, { kind: "compaction" }>): RemoteCompactionHistory {
  if (message.jobID === undefined) return history
  const prior = history.data.find((entry) => entry.jobID === message.jobID)
  if (prior && (prior.status === "completed" || prior.status === "failed") && (message.status === "pending" || message.status === "running")) return history
  const entry = { jobID: message.jobID, trigger: message.trigger ?? prior?.trigger ?? "", status: message.status,
    created: message.created ?? prior?.created ?? 0,
    ...(message.status === "completed" && (message.metrics ?? prior?.metrics) ? { metrics: message.metrics ?? prior?.metrics } : {}),
    ...(message.status === "failed" && message.failureCode ? { code: message.failureCode } : {}) }
  const entries = prior === undefined ? [...history.data, entry] : history.data.map((item) => item.jobID === message.jobID ? entry : item)
  const saved = (item: typeof entry | typeof prior) => item?.status === "completed" && item.metrics ? item.metrics.inputTokens - item.metrics.retainedTokens : 0
  const omitted = entries.length > RemoteLimits.maxCompactionHistory ? entries[0] : undefined
  return { data: entries.slice(-RemoteLimits.maxCompactionHistory),
    truncated: history.truncated || omitted !== undefined,
    completedBefore: history.completedBefore + (omitted?.status === "completed" && omitted.metrics ? 1 : 0),
    completedCount: history.completedCount + Number(entry.status === "completed" && entry.metrics !== undefined) - Number(prior?.status === "completed" && prior.metrics !== undefined),
    totalSavedTokens: history.totalSavedTokens + saved(entry) - saved(prior) }
}

function readCompactionMetrics(value: unknown): NonNullable<RemoteCompactionHistory["data"][number]["metrics"]> | undefined {
  if (!isRecord(value)) return undefined
  if (!nonNegativeInteger(value.excludedMessages) || !nonNegativeInteger(value.excludedParts) || !nonNegativeInteger(value.inputTokens) || !nonNegativeInteger(value.retainedTokens)) return undefined
  return { excludedMessages: value.excludedMessages, excludedParts: value.excludedParts, inputTokens: value.inputTokens, retainedTokens: value.retainedTokens }
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function readCompactionHistory(value: unknown): RemoteCompactionHistory | undefined {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > RemoteLimits.maxCompactionHistory || typeof value.truncated !== "boolean" ||
    typeof value.completedBefore !== "number" || !Number.isSafeInteger(value.completedBefore) || value.completedBefore < 0 ||
    typeof value.completedCount !== "number" || !Number.isSafeInteger(value.completedCount) || value.completedCount < 0 ||
    typeof value.totalSavedTokens !== "number" || !Number.isSafeInteger(value.totalSavedTokens)) return undefined
  const data = value.data.map((item): RemoteCompactionHistory["data"][number] | undefined => {
    if (!isRecord(item) || typeof item.jobID !== "string" || !/^cmp_[A-Za-z0-9_-]+$/.test(item.jobID) ||
      typeof item.trigger !== "string" || item.trigger.length === 0 || item.trigger.length > 64 ||
      (item.status !== "pending" && item.status !== "running" && item.status !== "completed" && item.status !== "failed") ||
      typeof item.created !== "number" || !Number.isSafeInteger(item.created) || item.created < 0) return undefined
    const status = item.status
    const metrics = status === "completed" ? readCompactionMetrics(item.metrics) : undefined
    const code = status === "failed" ? stringField(item.code) : undefined
    if (status === "completed" && !metrics || status === "failed" && (code === undefined || code.length > 64)) return undefined
    return { jobID: item.jobID, trigger: item.trigger, status, created: item.created,
      ...(metrics ? { metrics } : {}), ...(code ? { code } : {}) }
  })
  if (data.some((item) => item === undefined)) return undefined
  const entries = data.filter((item): item is NonNullable<typeof item> => item !== undefined)
  const completed = entries.filter((item) => item.status === "completed")
  if (value.completedBefore + completed.length !== value.completedCount || !value.truncated && value.completedBefore > 0) return undefined
  return { data: entries, truncated: value.truncated, completedBefore: value.completedBefore, completedCount: value.completedCount, totalSavedTokens: value.totalSavedTokens }
}

export function visibleTranscript(messages: readonly RemoteMessageView[]): readonly RemoteMessageView[] {
  const positions = new Map(messages.map((message, index) => [message.id, index]))
  const boundary = messages.reduce((latest, message, index) => {
    if (message.kind !== "compaction" || message.status !== "completed" || !message.boundaryMessageID) return latest
    const position = positions.get(message.boundaryMessageID)
    return position !== undefined && position < index ? Math.max(latest, position) : latest
  }, -1)
  const retained = boundary < 0 ? messages : messages.filter((message, index) => index > boundary || message.kind === "compaction")
  const latestCompaction = retained.findLast((message) => message.kind === "compaction")?.id
  const checkpoint = retained.findLast((message) => message.kind === "compaction" && message.status === "completed" && !!message.boundaryMessageID)?.id
  return retained.filter((message) => message.kind !== "compaction" || message.id === latestCompaction || message.id === checkpoint)
}

export function hasCompactionCheckpoint(messages: readonly RemoteMessageView[]): boolean {
  return messages.some((message) => message.kind === "compaction" && message.status === "completed" && !!message.boundaryMessageID)
}

function pushMessage(view: SessionView, message: RemoteMessageView): SessionView {
  return { ...view, messages: [...view.messages, message] }
}

function replaceMessage(view: SessionView, message: RemoteMessageView): SessionView {
  const index = view.messages.findIndex((existing) => existing.id === message.id)
  if (index < 0) return { ...view, messages: [...view.messages, message] }
  return { ...view, messages: view.messages.map((existing, position) => (position === index ? message : existing)) }
}

function pushRequest(view: SessionView, request: PendingRequestView): SessionView {
  return { ...view, requests: [...view.requests.filter((existing) => existing.id !== request.id), request] }
}

function removeRequest(view: SessionView, requestID: string | undefined): SessionView {
  if (requestID === undefined) return bump(view)
  return { ...view, requests: view.requests.filter((request) => request.id !== requestID) }
}

export function readProjectedMessage(value: unknown): RemoteMessageView | undefined {
  if (!isRecord(value)) return undefined
  const id = stringField(value.id)
  const type = stringField(value.type)
  if (id === undefined || type === undefined) return undefined
  const time = isRecord(value.time) ? value.time : {}
  const created = numberField(time.created) ?? 0
  const completed = numberField(time.completed)

  if (type === "user") {
    // The projection carries no delivery mode and marks consumption by timestamp.
    const attachments = readAttachments(value.files)
    return {
      kind: "user",
      id,
      text: stringField(value.text) ?? "",
      ...(attachments.length === 0 ? {} : { attachments }),
      state: numberField(time.consumed) === undefined ? "promoted" : "consumed",
      created,
    }
  }
  if (type === "system") {
    const metadata = recordField(value.metadata)
    return { kind: "system", id, text: stringField(value.text) ?? "", ...(metadata && stringField(metadata.contextSource) ? { source: stringField(metadata.contextSource) } : {}), created }
  }
  if (type === "synthetic") {
    const description = stringField(value.description)
    const metadata = recordField(value.metadata)
    return { kind: "synthetic", id, text: stringField(value.text) ?? "", ...(description === undefined ? {} : { description }), ...(metadata === undefined ? {} : { metadata }), ...(metadata && stringField(metadata.contextSource) ? { source: stringField(metadata.contextSource) } : {}), created }
  }
  if (type === "agent-switched") {
    return { kind: "notice", id, notice: "agent-switched", text: `Agent: ${stringField(value.agent) ?? "unknown"}`, created }
  }
  if (type === "model-switched") {
    return { kind: "notice", id, notice: "model-switched", text: `Model: ${modelLabel(readModelRef(value.model)) ?? "unknown"}`, created }
  }
  if (type === "skill") {
    return { kind: "notice", id, notice: "skill", text: `Skill: ${stringField(value.name) ?? stringField(value.skill) ?? "unknown"}`, created }
  }
  if (type === "shell") {
    const output = readShellOutput(value.output)
    const exit = numberField(value.exit)
    return {
      kind: "shell",
      id,
      shellID: stringField(value.shellID) ?? id,
      command: stringField(value.command) ?? "command",
      status: stringField(value.status) ?? "exited",
      ...(exit === undefined ? {} : { exit }),
      ...(output === undefined ? {} : { output }),
      created,
      ...(completed === undefined ? {} : { completed }),
    }
  }
  if (type === "compaction") {
    const status = stringField(value.status)
    if (status !== "pending" && status !== "running" && status !== "failed" && status !== "completed") return undefined
    const summary = stringField(value.summary)
    const trigger = stringField(value.trigger) ?? stringField(value.reason)
    const boundary = isRecord(value.boundary) ? stringField(value.boundary.messageID) : undefined
    const metrics = readCompactionMetrics(value.metrics)
    return {
      kind: "compaction",
      id,
      status,
      ...(stringField(value.jobID) ? { jobID: stringField(value.jobID) } : {}),
      ...(status === "failed" ? { failureCode: stringField(value.code) ?? readError(value.error)?.code } : {}),
      ...(status === "completed" && boundary !== undefined ? { boundaryMessageID: boundary } : {}),
      ...(trigger === undefined ? {} : { trigger }),
      ...(metrics === undefined ? {} : { metrics }),
      ...(isRecord(value.time) && typeof value.time.created === "number" ? { created: value.time.created } : {}),
      ...(summary === undefined ? {} : { summary: boundedText(summary).text }),
    }
  }
  if (type === "assistant") {
    const error = readError(value.error)
    const assistantModel = readModelRef(value.model)
    const retry = readAssistantRetry(value.retry)
    return {
      kind: "assistant",
      id,
      ...(stringField(value.agent) === undefined ? {} : { agent: stringField(value.agent) }),
      ...(assistantModel === undefined ? {} : { model: assistantModel }),
      parts: readSnapshotParts(value.content),
      created,
      ...(completed === undefined ? {} : { completed }),
      ...(error === undefined ? {} : { error: error.message }),
      ...(retry === undefined ? {} : { retry }),
    }
  }
  return undefined
}

function readGoal(value: Record<string, unknown>): NonNullable<SessionAutonomyView["goal"]> | undefined {
  const text = stringField(value.text)
  if (text === undefined) return undefined
  const status = stringField(value.status)
  return {
    text,
    status: status === "completed" || status === "stopped" || status === "exhausted" ? status : "active",
    iteration: numberField(value.iteration) ?? 0,
    noProgress: numberField(value.noProgress) ?? 0,
    maxNoProgress: numberField(value.maxNoProgress) ?? 0,
  }
}

function readYolo(value: unknown): 0 | 1 | 2 | 3 {
  if (value === true) return 2
  if (value === 1 || value === 2 || value === 3) return value
  return 0
}

function deliveryField(value: unknown): "steer" | "queue" {
  return value === "queue" ? "queue" : "steer"
}

function phaseField(value: unknown): "commentary" | "final_answer" | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined
}

function dataOf(payload: unknown): unknown {
  if (isRecord(payload) && "data" in payload) return payload.data
  return payload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function recordField(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/* -------------------------------------------------------------------------- */
/* Snapshot and list reads                                                    */
/* -------------------------------------------------------------------------- */

export type SessionSnapshot = {
  readonly messages: readonly RemoteMessageView[]
  readonly generationSpeed?: GenerationSpeedHistoryView
  readonly contextWindow?: ContextWindowView
  readonly before?: string
  readonly coveredAssistantIDs: readonly string[]
  readonly title?: string
  readonly parentID?: string
  readonly agent?: string
  readonly model?: ModelRefView
  readonly archived?: boolean
  /** Highest durable sequence covered by the snapshot; events at or below it are duplicates. */
  readonly watermark?: number
  readonly sourceEpoch?: string
}

/**
 * Reads `v2.session.snapshot` (`{ sourceEpoch, session, messages, watermark }`).
 * A body that is not a session projection is rejected instead of being read as
 * an empty projection, so a wrong response cannot erase the transcript.
 */
export function readSnapshot(payload: unknown): SessionSnapshot | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined
  if (payload.before !== undefined && (typeof payload.before !== "string" || payload.before.length === 0 || payload.before.length > 256)) return undefined
  const session = isRecord(payload.session) ? payload.session : {}
  const watermark = isRecord(payload.watermark) ? numberField(payload.watermark.seq) : undefined
  const sourceEpoch = stringField(payload.sourceEpoch)
  const archived = isRecord(session.time) && numberField(session.time.archived) !== undefined
  const model = readModelRef(session.model)
  const allMessages = payload.messages.flatMap((item) => {
    const message = readProjectedMessage(item)
    return message ? [message] : []
  })
  const messages = visibleTranscript(allMessages)
  const compactionIndex = payload.messages.findLastIndex((item) => isRecord(item) && item.type === "compaction" && item.status === "completed")
  const assistant = payload.messages.findLast((item, index) => index > compactionIndex && isRecord(item) &&
    item.type === "assistant" && isRecord(item.tokens))
  const contextWindow = readAssistantContext(assistant)
  const generationSpeed = assistant === undefined ? undefined : readGenerationSpeed(payload.generationSpeed)
  const visibleIDs = new Set(messages.map((message) => message.id))
  return {
    messages,
    ...(payload.before === undefined ? {} : { before: payload.before }),
    coveredAssistantIDs: allMessages.flatMap((message) => message.kind === "assistant" && !visibleIDs.has(message.id) ? [message.id] : []),
    ...(stringField(session.title) === undefined ? {} : { title: stringField(session.title) }),
    ...(stringField(session.parentID) === undefined ? {} : { parentID: stringField(session.parentID) }),
    ...(stringField(session.agent) === undefined ? {} : { agent: stringField(session.agent) }),
    ...(model === undefined ? {} : { model }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(generationSpeed === undefined ? {} : { generationSpeed }),
    ...(archived ? { archived: true } : {}),
    ...(watermark === undefined ? {} : { watermark }),
    ...(sourceEpoch === undefined ? {} : { sourceEpoch }),
  }
}

function openPartKey(message: Extract<RemoteMessageView, { kind: "assistant" }>, part: AssistantPart): string | undefined {
  if (message.completed !== undefined) return undefined
  if (part.kind === "text") return part.text === "" ? partKey(message.id, "text", String(part.ordinal)) : undefined
  if (part.kind === "reasoning") return part.text === "" && part.completed === undefined ? partKey(message.id, "reasoning", String(part.ordinal)) : undefined
  return part.status === "streaming" && (part.inputText ?? "") === "" ? partKey(message.id, "tool", part.callID) : undefined
}

/** Part keys a snapshot already covers; matching ephemeral fragments are stale. */
export function sealedPartKeys(messages: readonly RemoteMessageView[]): readonly string[] {
  return messages.flatMap((message) => {
    if (message.kind !== "assistant") return []
    return message.parts.flatMap((part) => {
      if (openPartKey(message, part) !== undefined) return []
      if (part.kind === "text" || part.kind === "reasoning") return [partKey(message.id, part.kind, String(part.ordinal))]
      if (part.kind === "tool") return [partKey(message.id, "tool", part.callID)]
      return []
    })
  })
}

export function streamedPartText(messages: readonly RemoteMessageView[]): ReadonlyMap<string, string> {
  return new Map(messages.flatMap((message) => {
    if (message.kind !== "assistant") return []
    return message.parts.flatMap((part): readonly (readonly [string, string])[] => {
      const key = part.kind === "tool" ? partKey(message.id, "tool", part.callID) : partKey(message.id, part.kind, String(part.ordinal))
      const text = part.kind === "tool" ? part.inputText : part.text
      return text === undefined || text === "" ? [] : [[key, text]]
    })
  }))
}

export function carryStreamedText(messages: readonly RemoteMessageView[], streamed: ReadonlyMap<string, string>): readonly RemoteMessageView[] {
  if (streamed.size === 0) return messages
  return messages.map((message) => {
    if (message.kind !== "assistant") return message
    let changed = false
    const parts = message.parts.map((part) => {
      const key = openPartKey(message, part)
      const text = key === undefined ? undefined : streamed.get(key)
      if (text === undefined) return part
      changed = true
      return part.kind === "tool" ? { ...part, inputText: text } : { ...part, text }
    })
    return changed ? { ...message, parts } : message
  })
}

/** Part key for an ephemeral fragment, when it names one. */
export function ephemeralPartKey(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.type !== "string") return undefined
  if (!payload.type.startsWith("session.text.") && !payload.type.startsWith("session.reasoning.") && !payload.type.startsWith("session.tool.")) {
    return undefined
  }
  if (!isRecord(payload.data)) return undefined
  const assistantMessageID = stringField(payload.data.assistantMessageID)
  if (assistantMessageID === undefined) return undefined
  if (payload.type.startsWith("session.tool.")) {
    const callID = stringField(payload.data.callID)
    return callID === undefined ? undefined : partKey(assistantMessageID, "tool", callID)
  }
  const ordinal = numberField(payload.data.ordinal)
  if (ordinal === undefined) return undefined
  return partKey(assistantMessageID, payload.type.startsWith("session.reasoning.") ? "reasoning" : "text", String(ordinal))
}

export function ephemeralAssistantID(payload: unknown): string | undefined {
  if (ephemeralPartKey(payload) === undefined || !isRecord(payload) || !isRecord(payload.data)) return undefined
  return stringField(payload.data.assistantMessageID)
}

/** Part key that a durable boundary re-opens. */
export function openedPartKey(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.type !== "string") return undefined
  if (!isRecord(payload.data)) return undefined
  const assistantMessageID = stringField(payload.data.assistantMessageID)
  if (assistantMessageID === undefined) return undefined
  if (payload.type === "session.tool.input.started") {
    const callID = stringField(payload.data.callID)
    return callID === undefined ? undefined : partKey(assistantMessageID, "tool", callID)
  }
  if (payload.type === "session.text.started" || payload.type === "session.reasoning.started") {
    const ordinal = numberField(payload.data.ordinal)
    if (ordinal === undefined) return undefined
    return partKey(assistantMessageID, payload.type === "session.reasoning.started" ? "reasoning" : "text", String(ordinal))
  }
  return undefined
}

/** Durable aggregate a payload belongs to, when it declares one. */
export function readAggregateID(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.durable)) return undefined
  return stringField(payload.durable.aggregateID)
}

function partKey(messageID: string, kind: string, part: string): string {
  return `${messageID}:${kind}:${part}`
}

export function readPermissionRequests(payload: unknown, now: number): readonly PendingRequestView[] {
  return readDataList(payload).flatMap((item) => {
    if (!isRecord(item)) return []
    const id = stringField(item.id)
    if (id === undefined) return []
    return [
      {
        kind: "permission" as const,
        id,
        action: stringField(item.action) ?? "unknown action",
        resources: stringList(item.resources),
        askedAt: now,
      },
    ]
  })
}

export function readGuardrailRequests(payload: unknown, now: number): readonly PendingRequestView[] {
  return readDataList(payload).flatMap((item) => {
    if (!isRecord(item)) return []
    const id = stringField(item.id)
    const sessionID = stringField(item.sessionID)
    if (id === undefined || sessionID === undefined) return []
    return [
      {
        kind: "guardrail" as const,
        id,
        sessionID,
        ...(stringField(item.rootSessionID) === undefined ? {} : { rootSessionID: stringField(item.rootSessionID) }),
        action: stringField(item.action) ?? "unknown action",
        resources: stringList(item.resources),
        reason: stringField(item.reason) ?? "Guardrail review required",
        hardReview: item.hardReview === true,
        ...(isRecord(item.metadata) ? { metadata: item.metadata } : {}),
        askedAt: now,
      },
    ]
  })
}

export function readFormRequests(payload: unknown, now: number): readonly Extract<PendingRequestView, { kind: "form" }>[] {
  return readForms(payload).map((form) => ({ kind: "form", id: form.id, form, askedAt: now }))
}

export function readCapturedChangesPage(value: unknown): RemoteCapturedChangesPage | undefined {
  if (!isRecord(value) || !Array.isArray(value.data) ||
    (value.cursor !== undefined && (!isRecord(value.cursor) || value.cursor.next !== undefined && (typeof value.cursor.next !== "string" || value.cursor.next.length === 0 || value.cursor.next.length > 256)))) return undefined
  const files = value.data.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.placementMessageID !== "string" || entry.placementMessageID === "" || typeof entry.path !== "string" || !Number.isSafeInteger(entry.additions) || !Number.isSafeInteger(entry.deletions) ||
      (entry.additions as number) < 0 || (entry.deletions as number) < 0 || !["created", "deleted", "modified"].includes(String(entry.status)) || !Array.isArray(entry.files)) return undefined
    const patches = entry.files.map((patch: unknown) => {
      if (!isRecord(patch) || typeof patch.diff !== "string" || patch.path !== entry.path || !Number.isSafeInteger(patch.additions) || !Number.isSafeInteger(patch.deletions) ||
        (patch.additions as number) < 0 || (patch.deletions as number) < 0 || !["created", "deleted", "modified"].includes(String(patch.status)) ||
        (patch.unavailable !== undefined && patch.unavailable !== true)) return undefined
      const parsed = patch.unavailable === true ? undefined : parseUnifiedPatch(patch.diff)
      if (patch.unavailable === true ? patch.diff !== "" || patch.additions !== 0 || patch.deletions !== 0
        : !parsed || parsed.unified.filter((line) => line.kind === "added").length !== patch.additions ||
          parsed.unified.filter((line) => line.kind === "removed").length !== patch.deletions) return undefined
      return { path: entry.path as string, diff: patch.diff, additions: patch.additions as number, deletions: patch.deletions as number,
        status: patch.status as "created" | "deleted" | "modified", ...(patch.unavailable === true ? { unavailable: true } : {}) }
    })
    if (patches.some((patch) => patch === undefined) || patches.length === 0 ||
      patches.reduce((total, patch) => total + (patch?.additions ?? 0), 0) !== entry.additions ||
      patches.reduce((total, patch) => total + (patch?.deletions ?? 0), 0) !== entry.deletions) return undefined
    return { placementMessageID: entry.placementMessageID, path: entry.path, additions: entry.additions as number, deletions: entry.deletions as number,
      status: entry.status as "created" | "deleted" | "modified", files: patches.filter((patch): patch is NonNullable<typeof patch> => patch !== undefined) }
  })
  if (files.some((file) => file === undefined)) return undefined
  return {
    data: files.filter((file): file is NonNullable<typeof file> => file !== undefined),
    ...(isRecord(value.cursor) && typeof value.cursor.next === "string" ? { cursor: { next: value.cursor.next } } : {}) }
}

/** Durable sequence and epoch carried by one event payload. */
export function readEventSequence(payload: unknown): { readonly seq?: number; readonly sourceEpoch?: string } {
  if (!isRecord(payload)) return {}
  const durable = isRecord(payload.durable) ? payload.durable : {}
  return {
    ...(numberField(durable.seq) === undefined ? {} : { seq: numberField(durable.seq) }),
    ...(stringField(payload.sourceEpoch) === undefined ? {} : { sourceEpoch: stringField(payload.sourceEpoch) }),
  }
}

export function canReplyToRequest(request: PendingRequestView, activeSessionID: string | undefined): boolean {
  if (request.kind !== "guardrail") return true
  return activeSessionID !== undefined
}

export function guardrailContextAvailable(request: PendingRequestView): boolean {
  return request.kind !== "guardrail" || request.resources.some((resource) => resource.trim() !== "") ||
    typeof request.metadata?.command === "string" && request.metadata.command.trim() !== ""
}

/** Replaces the request queue with an authoritative list read. */
export function replaceRequests(view: SessionView, requests: readonly PendingRequestView[]): SessionView {
  return { ...view, requests: [...requests] }
}
