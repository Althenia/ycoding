import { OpenAICodex } from "@ycoding-ai/core/plugin/provider/openai-codex"
import { Platform } from "@ycoding-ai/core/util/platform"
import { Cause, DateTime } from "effect"
import { platformFamily } from "./types"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import type { EventManifest } from "@ycoding-ai/schema/event-manifest"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import type { SessionMessage } from "@ycoding-ai/schema/session-message"

export type RemoteControlLocation = { readonly directory: string; readonly workspaceID?: string }
export interface RemoteControlModel {
  readonly id: string
  readonly providerID?: string
  readonly name?: string
  readonly profile?: string
  readonly active?: boolean
  readonly variants?: readonly string[]
  readonly isDefault?: boolean
}
export interface RemoteControlBackend {
  readonly createThread: (input: {
    readonly location: RemoteControlLocation
    readonly title?: string
    readonly inputID: string
    readonly model?: Model.Ref
  }) => Promise<NativeDots.RootSnapshot>
  readonly getThread: NativeDots.Channel["getRoot"]
  readonly listThreads: NativeDots.Channel["listRoots"]
  readonly readThread: NativeDots.Channel["readRoot"]
  readonly prompt: (
    threadID: string,
    input: {
      readonly text: string
      readonly inputID: string
      readonly delivery: "steer" | "queue"
      readonly model?: Model.Ref
    },
  ) => Promise<{ readonly messageID: string }>
  readonly interrupt: (threadID: string) => Promise<void>
  readonly models: () => Promise<readonly RemoteControlModel[]>
  readonly skills: () => Promise<readonly { readonly id: string; readonly name?: string }[]>
  readonly account: () => Promise<{ readonly profile: string } | undefined>
  readonly pending: (threadID: string) => Promise<readonly NativeDots.NativeRequest[]>
  readonly settle: NativeDots.Channel["settle"]
  readonly subscribe: NativeDots.Channel["subscribe"]
  readonly renameThread: (threadID: string, title: string) => Promise<void>
  readonly archiveThread: (threadID: string) => Promise<void>
  readonly unarchiveThread: (threadID: string) => Promise<NativeDots.RootSnapshot>
  readonly deleteThread: (threadID: string) => Promise<void>
  readonly subscribeEscalations: NativeDots.Channel["subscribeEscalations"]
  readonly retire: () => void
  readonly selectModel?: (rootID: string, model: Model.Ref) => Promise<NativeDots.RootSnapshot>
  readonly defaultModel?: () => Promise<Model.Ref | undefined>
  readonly setDefaultModel?: (model: Model.Ref) => Promise<Model.Ref>
}

const settlementEvents = new Set([
  "form.replied", "form.cancelled", "form.timed_out",
  "question.replied", "question.rejected", "question.timed_out",
  "permission.replied", "permission.cancelled",
  "guardrail.replied", "guardrail.cancelled",
])
const maxSettledRequests = 1024

const refusedPrefixes = ["command/", "process/", "fs/", "permission/", "guardrail/", "question/", "form/"] as const
const rejectedOverrides = ["approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy"] as const
const legacyRejectedOverrides = ["model", "modelProvider", "config"] as const
const validReasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function validHeaderValue(value: string) {
  return value.length > 0 && value.length <= 256 && !/[\0-\x1f\x7f]/.test(value)
}

export function formatWireModel(model: {
  readonly id: string
  readonly providerID?: string
  readonly profile?: string
}): string {
  if (model.profile !== undefined) return `${model.profile}#${model.providerID}/${model.id}`
  if (model.providerID !== undefined) return `${model.providerID}/${model.id}`
  return model.id
}

export async function parseWireModel(input: {
  readonly modelParam: string
  readonly modelProviderParam?: string
  readonly effortParam?: string
  readonly profileHint?: string
  readonly models: () => Promise<readonly RemoteControlModel[]>
}): Promise<Model.Ref> {
  const { modelParam, modelProviderParam, effortParam, profileHint, models } = input
  const list = await models()
  const wireMatches = list.filter((model) =>
    model.providerID !== undefined &&
    formatWireModel(model) === modelParam &&
    (profileHint === undefined || model.profile === undefined || model.profile === profileHint),
  )
  if (wireMatches.length === 1) {
    const match = wireMatches[0]!
    if (modelProviderParam !== undefined && modelProviderParam !== "ycoding" && modelProviderParam !== match.providerID) {
      throw new Error("modelProvider does not match model prefix")
    }
    const profile = match.profile ?? profileHint
    return Model.Ref.make({
      providerID: Provider.ID.make(match.providerID!),
      id: Model.ID.make(match.id),
      ...(profile !== undefined ? { profile: Model.ProfileName.make(profile) } : {}),
      ...(effortParam !== undefined ? { variant: Model.VariantID.make(effortParam) } : {}),
    })
  }
  if (wireMatches.length > 1) {
    throw new Error("Ambiguous wire model ID")
  }
  if (modelParam.includes("/") || modelParam.includes("#")) {
    const parsed = Model.Ref.parse(modelParam)
    if (modelProviderParam !== undefined && modelProviderParam !== "ycoding" && modelProviderParam !== parsed.providerID) {
      throw new Error("modelProvider does not match model prefix")
    }
    if (profileHint !== undefined && parsed.profile !== undefined && parsed.profile !== profileHint) {
      throw new Error("profile does not match model prefix")
    }
    if (parsed.variant !== undefined && effortParam !== undefined && parsed.variant !== effortParam) {
      throw new Error("Conflicting reasoning effort values")
    }
    const profile = parsed.profile ?? profileHint
    const variant = effortParam ?? parsed.variant
    return Model.Ref.make({
      providerID: parsed.providerID,
      id: parsed.id,
      ...(profile !== undefined ? { profile: Model.ProfileName.make(profile) } : {}),
      ...(variant !== undefined ? { variant: Model.VariantID.make(variant) } : {}),
    })
  }
  if (modelProviderParam !== undefined) {
    if (modelProviderParam.includes("/") || modelProviderParam.includes("#")) {
      throw new Error("Invalid modelProvider")
    }
    return Model.Ref.make({
      providerID: Provider.ID.make(modelProviderParam),
      id: Model.ID.make(modelParam),
      ...(profileHint !== undefined ? { profile: Model.ProfileName.make(profileHint) } : {}),
      ...(effortParam !== undefined ? { variant: Model.VariantID.make(effortParam) } : {}),
    })
  }
  const matches = list.filter((model) => model.id === modelParam && model.profile === profileHint)
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? "Unknown model" : "Ambiguous bare model ID")
  }
  const match = matches[0]!
  if (match.providerID === undefined) {
    throw new Error("Model provider is unavailable")
  }
  return Model.Ref.make({
    providerID: Provider.ID.make(match.providerID),
    id: Model.ID.make(match.id),
    ...(profileHint !== undefined ? { profile: Model.ProfileName.make(profileHint) } : {}),
    ...(effortParam !== undefined ? { variant: Model.VariantID.make(effortParam) } : {}),
  })
}

function validateThreadConfig(raw: unknown): { readonly ok: true; readonly model?: string; readonly effort?: string } | { readonly ok: false; readonly message: string } {
  if (raw === undefined || raw === null) return { ok: true }
  if (!isRecord(raw) || Array.isArray(raw)) return { ok: false, message: "config must be an object" }
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "model" && key !== "model_reasoning_effort" && value !== undefined && value !== null) {
      return { ok: false, message: `Native config.${key} overrides are unsupported; YCoding owns execution configuration` }
    }
  }
  let model: string | undefined
  if (raw.model !== undefined && raw.model !== null) {
    if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
      return { ok: false, message: "config.model must be a non-empty string" }
    }
    model = raw.model
  }
  let effort: string | undefined
  if (raw.model_reasoning_effort !== undefined && raw.model_reasoning_effort !== null) {
    if (typeof raw.model_reasoning_effort !== "string" || raw.model_reasoning_effort.trim().length === 0) {
      return { ok: false, message: "config.model_reasoning_effort must be a non-empty string" }
    }
    effort = raw.model_reasoning_effort
  }
  return { ok: true, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }
}

function extractModelInputs(
  params: Record<string, unknown>,
  configInfo?: { readonly model?: string; readonly effort?: string },
): { readonly ok: true; readonly modelParam?: string; readonly modelProviderParam?: string; readonly effortParam?: string } | { readonly ok: false; readonly message: string } {
  const modelCandidates: string[] = []
  const effortCandidates: string[] = []
  const pushString = (target: string[], raw: unknown, label: string): string | undefined => {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== "string" || raw.trim().length === 0) return `${label} must be a non-empty string`
    target.push(raw)
    return undefined
  }

  let error = pushString(modelCandidates, params.model, "model")
  if (error) return { ok: false, message: error }
  if (configInfo?.model !== undefined) modelCandidates.push(configInfo.model)

  let modelProviderParam: string | undefined
  if (params.modelProvider !== undefined && params.modelProvider !== null) {
    if (typeof params.modelProvider !== "string" || params.modelProvider.trim().length === 0) {
      return { ok: false, message: "modelProvider must be a non-empty string" }
    }
    modelProviderParam = params.modelProvider
  }

  error = pushString(effortCandidates, params.effort, "effort")
    ?? pushString(effortCandidates, params.reasoningEffort, "reasoningEffort")
  if (error) return { ok: false, message: error }
  if (configInfo?.effort !== undefined) effortCandidates.push(configInfo.effort)

  if (params.collaborationMode !== undefined && params.collaborationMode !== null) {
    if (!isRecord(params.collaborationMode) || Array.isArray(params.collaborationMode)) {
      return { ok: false, message: "collaborationMode must be an object" }
    }
    const settings = params.collaborationMode.settings
    if (settings !== undefined && settings !== null) {
      if (!isRecord(settings) || Array.isArray(settings)) {
        return { ok: false, message: "collaborationMode.settings must be an object" }
      }
      error = pushString(modelCandidates, settings.model, "collaborationMode.settings.model")
        ?? pushString(effortCandidates, settings.reasoning_effort, "collaborationMode.settings.reasoning_effort")
      if (error) return { ok: false, message: error }
    }
  }

  if (new Set(modelCandidates).size > 1) return { ok: false, message: "Conflicting model values" }
  if (new Set(effortCandidates).size > 1) return { ok: false, message: "Conflicting reasoning effort values" }

  return {
    ok: true,
    ...(modelCandidates[0] === undefined ? {} : { modelParam: modelCandidates[0] }),
    ...(modelProviderParam === undefined ? {} : { modelProviderParam }),
    ...(effortCandidates[0] === undefined ? {} : { effortParam: effortCandidates[0] }),
  }
}

async function resolveRequestedModel(input: {
  readonly extracted: { readonly modelParam?: string; readonly modelProviderParam?: string; readonly effortParam?: string }
  readonly fallbackModel: () => Promise<Model.Ref | undefined>
  readonly models: () => Promise<readonly RemoteControlModel[]>
}): Promise<{ readonly ok: true; readonly model?: Model.Ref } | { readonly ok: false; readonly message: string }> {
  const { extracted, fallbackModel, models } = input
  if (extracted.modelParam !== undefined) {
    try {
      return {
        ok: true,
        model: await parseWireModel({
          modelParam: extracted.modelParam,
          modelProviderParam: extracted.modelProviderParam,
          effortParam: extracted.effortParam,
          models,
        }),
      }
    } catch {
      return { ok: false, message: "Invalid model or reasoning effort" }
    }
  }
  if (extracted.modelProviderParam !== undefined) {
    return { ok: false, message: "model is required when modelProvider is specified" }
  }
  const base = await fallbackModel()
  if (extracted.effortParam !== undefined) {
    if (!base) return { ok: false, message: "Cannot set reasoning effort without a model" }
    try {
      return { ok: true, model: Model.Ref.make({ ...base, variant: Model.VariantID.make(extracted.effortParam) }) }
    } catch {
      return { ok: false, message: "Invalid reasoning effort" }
    }
  }
  return { ok: true, ...(base === undefined ? {} : { model: base }) }
}

function threadStatus(snapshot: NativeDots.RootSnapshot) {
  if (snapshot.snapshotError) return { type: "systemError" }
  return snapshot.active || snapshot.waiting.length > 0
    ? { type: "active", activeFlags: snapshot.waiting.map((wait) => wait === "approval" ? "waitingOnApproval" : "waitingOnUserInput") }
    : { type: "idle" }
}

function threadWire(snapshot: NativeDots.RootSnapshot, messages: readonly SessionMessage.Info[] = [], summaries: ReturnType<typeof transcriptSummaries> = []) {
  const thread = snapshot.session
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: thread.fork?.sessionID ?? null,
    parentThreadId: null,
    preview: messages.find((message) => message.type === "user")?.text ?? "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: thread.projectID,
    historyMode: "legacy",
    modelProvider: snapshot.selectedModel?.providerID ?? "unknown",
    model: snapshot.selectedModel ? formatWireModel(snapshot.selectedModel) : "unknown",
    reasoningEffort: snapshot.selectedModel?.variant ?? null,
    createdAt: Math.floor(DateTime.toEpochMillis(thread.time.created) / 1_000),
    updatedAt: Math.floor(DateTime.toEpochMillis(thread.time.updated) / 1_000),
    recencyAt: null,
    status: threadStatus(snapshot),
    path: null,
    cwd: thread.location.directory,
    cliVersion: "unknown",
    originator: null,
    source: "unknown",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.title,
    turns: summaries,
  }
}

function threadConfiguration(thread: ReturnType<typeof threadWire>) {
  return { thread, model: thread.model, modelProvider: thread.modelProvider, serviceTier: null, cwd: thread.cwd,
    approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, reasoningEffort: thread.reasoningEffort }
}

function changedDirectory(params: Record<string, unknown>, snapshot: NativeDots.RootSnapshot) {
  return params.cwd !== undefined && params.cwd !== null && params.cwd !== snapshot.session.location.directory
}

function transcriptSummaries(messages: readonly SessionMessage.Info[]) {
  const completeProjection = { status: "completed", itemsView: "summary", error: null, startedAt: null, completedAt: null, durationMs: null } as const
  const summaries: Array<typeof completeProjection & { id: string; items: Array<Record<string, unknown>> }> = []
  for (const message of messages) {
    if (message.type === "user") {
      summaries.push({
        id: message.id,
        ...completeProjection,
        items: [{ type: "userMessage", id: message.id, clientId: null, content: [{ type: "text", text: message.text, text_elements: [] }] }],
      })
      continue
    }
    if (message.type !== "assistant") continue
    const item = { type: "agentMessage", id: message.id, text: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""), phase: null, memoryCitation: null, delivery: null, questions: null }
    const current = summaries[summaries.length - 1]
    if (current) current.items.push(item)
    else summaries.push({ id: message.id, ...completeProjection, items: [item] })
  }
  return summaries
}

function inputText(params: Record<string, unknown>) {
  const input = params.input
  if (!Array.isArray(input)) return undefined
  const texts = input.flatMap((item) =>
    isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
  )
  return texts.length > 0 ? texts.join("\n") : undefined
}

const retryDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000]

export function createRemoteControlAppServer(input: {
  readonly backend: RemoteControlBackend
  readonly codexHome: string
  readonly requestScope: string
  readonly send: (text: string) => void
  readonly onDiagnostic?: (message: string) => void
  readonly schedule?: (run: () => void, delayMs: number) => () => void
}) {
  const backend = input.backend
  const schedule = input.schedule ?? ((run, delayMs) => {
    const timer = setTimeout(run, delayMs)
    return () => clearTimeout(timer)
  })
  let initialized = false
  let ready = false
  let active = true
  const pending = new Map<string, { readonly request: NativeDots.NativeRequest; settling: boolean }>()
  const subscriptions = new Map<string, { readonly pending: Promise<() => void>; stop?: () => void }>()
  const refreshing = new Map<string, Promise<void>>()
  const retries = new Map<string, { attempt: number; cancel?: () => void }>()
  const dirty = new Set<string>()
  type Item = { id: string; type: "agentMessage"; text: string; phase?: "commentary" | "final_answer" }
  const turns = new Map<string, { threadID: string; items: Map<string, Item>; completed: Set<string> }>()
  const consumed = new Map<string, Set<string>>()
  const admissions = new Map<string, { count: number; events: EventManifest.ServerEvent[] }>()
  const revoked = new Set<string>()
  const knownStatus = new Map<string, string>()
  const settledRequests = new Set<string>()
  const statusRefreshing = new Set<string>()
  const statusDirty = new Set<string>()
  const statusHeld = new Map<string, number>()
  let escalationsStarted = false
  let stopEscalations: (() => void) | undefined
  const notify = (method: string, params: unknown) => {
    if (active) input.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
  }

  const wire = (snapshot: NativeDots.RootSnapshot, messages: readonly SessionMessage.Info[] = [], summaries: ReturnType<typeof transcriptSummaries> = []) => {
    knownStatus.set(snapshot.session.id, JSON.stringify(threadStatus(snapshot)))
    return threadWire(snapshot, messages, summaries)
  }

  function holdStatus(threadID: string) {
    statusHeld.set(threadID, (statusHeld.get(threadID) ?? 0) + 1)
    return () => {
      setImmediate(() => {
        const remaining = (statusHeld.get(threadID) ?? 1) - 1
        if (remaining > 0) {
          statusHeld.set(threadID, remaining)
          return
        }
        statusHeld.delete(threadID)
        if (active) void refreshStatus(threadID)
      })
    }
  }

  async function watchWith<T>(threadID: string, build: () => T): Promise<T> {
    const release = holdStatus(threadID)
    try {
      await watch(threadID)
      return build()
    } finally {
      release()
    }
  }

  async function refreshStatus(threadID: string): Promise<void> {
    statusDirty.add(threadID)
    if (statusRefreshing.has(threadID)) return
    statusRefreshing.add(threadID)
    try {
      while (statusDirty.delete(threadID)) {
        if (statusHeld.has(threadID)) continue
        const snapshot = await backend.getThread(threadID).catch(() => undefined)
        if (!active || revoked.has(threadID) || !subscriptions.has(threadID) || snapshot === undefined || statusHeld.has(threadID)) continue
        const status = threadStatus(snapshot)
        const key = JSON.stringify(status)
        const known = knownStatus.get(threadID)
        knownStatus.set(threadID, key)
        if (known !== undefined && known !== key) notify("thread/status/changed", { threadId: threadID, status })
      }
    } finally {
      statusRefreshing.delete(threadID)
    }
  }

  const result = (id: unknown, value: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result: value })
  const failure = (id: unknown, code: number, message: string) =>
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })

  function resolved(request: NativeDots.NativeRequest) {
    pending.delete(request.id)
    notify("serverRequest/resolved", { threadId: request.threadID, requestId: request.id })
  }

  function completeTurn(id: string, status: "completed" | "failed" | "interrupted", error: { message: string } | null, completedAtMs: number) {
    const turn = turns.get(id)
    if (!turn) return
    for (const item of turn.items.values()) if (!turn.completed.has(item.id))
      notify("item/completed", { threadId: turn.threadID, turnId: id, item, completedAtMs })
    notify("turn/completed", { threadId: turn.threadID, turn: { id, status, error, items: [...turn.items.values()] } })
    turns.delete(id)
  }

  function cancelRetry(threadID: string) {
    retries.get(threadID)?.cancel?.()
    retries.delete(threadID)
  }

  function scheduleRetry(threadID: string) {
    if (!active || revoked.has(threadID)) return
    const entry = retries.get(threadID) ?? { attempt: 0 }
    retries.set(threadID, entry)
    if (entry.cancel || entry.attempt >= retryDelaysMs.length) return
    const delay = retryDelaysMs[entry.attempt]
    entry.attempt++
    entry.cancel = schedule(() => {
      entry.cancel = undefined
      void watch(threadID).catch(() => scheduleRetry(threadID))
    }, delay)
  }

  function retireRoot(threadID: string) {
    const completedAtMs = Date.now()
    revoked.add(threadID)
    knownStatus.delete(threadID)
    cancelRetry(threadID)
    for (const held of pending.values()) if (held.request.threadID === threadID) resolved(held.request)
    for (const [id, turn] of turns) if (turn.threadID === threadID) completeTurn(id, "interrupted", null, completedAtMs)
    admissions.delete(threadID)
    consumed.delete(threadID)
  }

  function runtimeEvent(threadID: string, event: EventManifest.ServerEvent) {
    if (!active || revoked.has(threadID) || !("sessionID" in event.data) || event.data.sessionID !== threadID) return
    const admission = admissions.get(threadID)
    if (admission) { admission.events.push(event); return }
    if (event.type === "session.execution.started") { consumed.set(threadID, new Set()); return }
    if (event.type === "session.input.consumed") {
      const current = consumed.get(threadID) ?? new Set<string>()
      for (const id of event.data.inputIDs) if (turns.get(id)?.threadID === threadID) current.add(id)
      consumed.set(threadID, current)
      return
    }
    const current = consumed.get(threadID)
    if (!current?.size) return
    if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
      for (const id of current) completeTurn(id,
        event.type === "session.execution.succeeded" ? "completed" : event.type === "session.execution.failed" ? "failed" : "interrupted",
        event.type === "session.execution.failed" ? { message: "message" in event.data.error ? String(event.data.error.message) : "Session execution failed" } : null,
        DateTime.toEpochMillis(event.created))
      consumed.delete(threadID)
      return
    }
    if (event.type !== "session.text.started" && event.type !== "session.text.delta" && event.type !== "session.text.ended") return
    const itemID = `${event.data.assistantMessageID}:${event.data.ordinal}`
    for (const id of current) {
      const turn = turns.get(id)
      if (!turn) continue
      if (event.type === "session.text.started") {
        if (turn.items.has(itemID)) continue
        const item: Item = { id: itemID, type: "agentMessage", text: "", ...(event.data.phase === undefined ? {} : { phase: event.data.phase }) }
        turn.items.set(itemID, item)
        notify("item/started", { threadId: threadID, turnId: id, item: { ...item }, startedAtMs: DateTime.toEpochMillis(event.created) })
      } else {
        const item = turn.items.get(itemID)
        if (!item || turn.completed.has(itemID)) continue
        if (event.type === "session.text.delta") {
          item.text += event.data.delta
          notify("item/agentMessage/delta", { threadId: threadID, turnId: id, itemId: itemID, delta: event.data.delta })
        } else {
          item.text = event.data.text
          if (event.data.phase !== undefined) item.phase = event.data.phase
          turn.completed.add(itemID)
          notify("item/completed", { threadId: threadID, turnId: id, item: { ...item }, completedAtMs: DateTime.toEpochMillis(event.created) })
        }
      }
    }
  }

  function noteSettlement(event: EventManifest.ServerEvent) {
    const data: unknown = event.data
    if (!settlementEvents.has(event.type) || !isRecord(data)) return
    const id = typeof data.requestID === "string" ? data.requestID : typeof data.id === "string" ? data.id : undefined
    if (id === undefined) return
    settledRequests.add(id)
    if (settledRequests.size > maxSettledRequests) for (const oldest of settledRequests) { settledRequests.delete(oldest); break }
  }

  function surfaceApprovals(threadID: string): Promise<void> {
    if (revoked.has(threadID)) return Promise.reject(new Error("Native access retired"))
    dirty.add(threadID)
    const current = refreshing.get(threadID)
    if (current) return current
    const task = (async () => {
      do {
        dirty.delete(threadID)
        const requests = (await backend.pending(threadID)).filter((item) => !settledRequests.has(item.itemID))
        if (!active || revoked.has(threadID)) return
        for (const held of pending.values())
          if (held.request.threadID === threadID && !held.settling && !requests.some((item) => item.id === held.request.id && item.handle === held.request.handle)) resolved(held.request)
        for (const request of requests) {
          if (pending.has(request.id)) continue
          pending.set(request.id, { request, settling: false })
          input.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, method: "item/tool/requestUserInput", params: {
            threadId: request.threadID, turnId: request.turnID, itemId: request.itemID, isBlocking: true,
            questions: request.questions.map((question) => ({ ...question, options: question.options ?? [] })),
          } }))
        }
      } while (dirty.has(threadID))
      void refreshStatus(threadID)
    })()
    refreshing.set(threadID, task)
    void task.then(() => {
      if (refreshing.get(threadID) === task) refreshing.delete(threadID)
      cancelRetry(threadID)
    }, () => {
      if (refreshing.get(threadID) === task) refreshing.delete(threadID)
      scheduleRetry(threadID)
    })
    return task
  }

  async function watch(threadID: string) {
    let entry = subscriptions.get(threadID)
    if (!entry) {
      const subscription = backend.subscribe(threadID, (event) => {
        runtimeEvent(threadID, event)
        noteSettlement(event)
        if (event.type === "session.status" || event.type === "session.task.updated" || event.type.startsWith("session.shell.") || event.type.startsWith("session.execution.")) {
          void refreshStatus(threadID)
        }
        void surfaceApprovals(threadID).catch(() => {})
      }, () => retireRoot(threadID))
      entry = { pending: subscription }
      subscriptions.set(threadID, entry)
    }
    try {
      const stop = await entry.pending
      if (!active || revoked.has(threadID)) throw new Error("Native access retired")
      entry.stop = stop
    } catch (error) {
      if (subscriptions.get(threadID) === entry) dropSubscription(threadID)
      throw error
    }
    await surfaceApprovals(threadID)
  }

  function dropSubscription(threadID: string) {
    const entry = subscriptions.get(threadID)
    if (!entry) return
    subscriptions.delete(threadID)
    if (entry.stop) entry.stop()
    else void entry.pending.then((stop) => stop(), () => {})
  }

  function restoreRoot(threadID: string) {
    if (!revoked.delete(threadID)) return
    dropSubscription(threadID)
  }

  function escalated(threadID: string) {
    if (!active || revoked.has(threadID)) return
    void watch(threadID).catch(() => scheduleRetry(threadID))
  }

  function startEscalations() {
    if (escalationsStarted) return
    escalationsStarted = true
    let subscription: Promise<() => void>
    try {
      subscription = Promise.resolve(backend.subscribeEscalations(escalated))
    } catch {
      return
    }
    void subscription.then((stop) => {
      if (active) stopEscalations = stop
      else stop()
    }, () => {})
  }

  async function response(record: Record<string, unknown>): Promise<string | undefined> {
    const id = record.id
    if (typeof id !== "string") return failure(id ?? null, -32600, "Unknown native request")
    const held = pending.get(id)
    if (!held || held.settling) return failure(id, -32600, "Unknown or completed native request")
    if ("error" in record) return failure(id, -32603, "Native decision was not delivered; the request remains pending")
    const result = isRecord(record.result) ? record.result : undefined
    const answers = isRecord(result?.answers) ? result.answers : undefined
    if (!result || Object.keys(result).length !== 1 || !answers)
      return failure(id, -32602, "Answers do not match the native request")
    const validated: Array<[string, { answers: string[] }]> = []
    for (const [key, raw] of Object.entries(answers)) {
      const question = held.request.questions.find((question) => question.id === key)
      const answer = isRecord(raw) ? raw : undefined
      if (!question) return failure(id, -32602, "Answer does not match a native question")
      if (!answer || Object.keys(answer).length !== 1 || !Array.isArray(answer.answers) || answer.answers.length !== 1 || typeof answer.answers[0] !== "string")
        return failure(id, -32602, "Answers do not match the native request")
      const value = answer.answers[0]
      if (!question.isOther && question.options?.length && !question.options.some((option) => option.label === value))
        return failure(id, -32602, "Answer is not an available option")
      validated.push([question.id, { answers: [value] }])
    }
    held.settling = true
    try {
      const current = await backend.pending(held.request.threadID)
      if (!active || !current.some((item) => item.id === id && item.handle === held.request.handle)) throw new Error("Native request is stale")
      await backend.settle(held.request.handle, Object.fromEntries(validated))
      if (!active) return failure(id, -32600, "Native connection retired during settlement")
      resolved(held.request)
      await surfaceApprovals(held.request.threadID)
      return undefined
    } catch {
      held.settling = false
      if (pending.get(id) === held) {
        try {
          const current = await backend.pending(held.request.threadID)
          if (!current.some((item) => item.id === id && item.handle === held.request.handle)) resolved(held.request)
        } catch { resolved(held.request) }
      }
      return failure(id, -32603, "Native decision could not be confirmed")
    }
  }

  async function dispatch(method: string, params: Record<string, unknown>, id: unknown): Promise<string> {
    if (method === "initialize") {
      if (initialized) return failure(id, -32600, "Already initialized")
      const clientInfo = isRecord(params.clientInfo) ? params.clientInfo : undefined
      const name = clientInfo?.name
      if (typeof name !== "string" || !validHeaderValue(name)) return failure(id, -32602, "Invalid clientInfo.name")
      initialized = true
      return result(id, {
        userAgent: OpenAICodex.userAgent(),
        codexHome: input.codexHome,
        platformFamily: platformFamily(),
        platformOs: Platform.upstreamOs(),
        serverInfo: { name: OpenAICodex.clientInfo.name, title: OpenAICodex.clientInfo.title, version: OpenAICodex.clientInfo.version },
        capabilities: {},
      })
    }
    if (!initialized) return failure(id, -32002, "Not initialized")
    if (method.startsWith("thread/") || method.startsWith("turn/")) {
      const rejected = rejectedOverrides.find((field) => params[field] !== undefined && params[field] !== null)
      if (rejected !== undefined) return failure(id, -32602, `Native ${rejected} overrides are unsupported; YCoding owns execution configuration`)
      if (
        method !== "thread/start" &&
        method !== "thread/resume" &&
        method !== "thread/settings/update" &&
        method !== "turn/start" &&
        method !== "turn/steer"
      ) {
        const extra = legacyRejectedOverrides.find((field) => params[field] !== undefined && params[field] !== null)
        if (extra !== undefined) return failure(id, -32602, `Native ${extra} overrides are unsupported; YCoding owns execution configuration`)
      }
      if (
        (method === "turn/start" || method === "turn/steer" || method === "thread/settings/update") &&
        params.config !== undefined &&
        params.config !== null
      ) {
        return failure(id, -32602, "Native config overrides are unsupported; YCoding owns execution configuration")
      }
    }
    if (
      refusedPrefixes.some((prefix) => method.startsWith(prefix)) ||
      method.includes("requestApproval") ||
      method.includes("/reply") ||
      method.includes("/approve")
    )
      return failure(id, -32601, "Method not found")

    switch (method) {
      case "thread/start": {
        const cwd = typeof params.cwd === "string" ? params.cwd : undefined
        if (cwd === undefined) return failure(id, -32602, "cwd is required")
        const configInfo = validateThreadConfig(params.config)
        if (!configInfo.ok) return failure(id, -32602, configInfo.message)
        const extracted = extractModelInputs(params, configInfo)
        if (!extracted.ok) return failure(id, -32602, extracted.message)
        const resolved = await resolveRequestedModel({
          extracted,
          fallbackModel: () => backend.defaultModel ? backend.defaultModel() : Promise.resolve(undefined),
          models: backend.models,
        })
        if (!resolved.ok) return failure(id, -32602, resolved.message)
        let thread: NativeDots.RootSnapshot
        try {
          thread = await backend.createThread({
            location: { directory: cwd },
            inputID: JSON.stringify([input.requestScope, method, id]),
            ...(typeof params.title === "string" ? { title: params.title } : {}),
            ...(resolved.model === undefined ? {} : { model: resolved.model }),
          })
        } catch {
          return failure(id, -32602, "Thread parameters are invalid or unavailable")
        }
        const started = await watchWith(thread.session.id, () => wire(thread))
        notify("thread/started", { thread: started })
        return result(id, threadConfiguration(started))
      }
      case "thread/name/set": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        const name = typeof params.name === "string" && params.name.trim().length > 0 ? params.name : undefined
        if (threadID === undefined || name === undefined) return failure(id, -32602, "threadId and a nonempty name are required")
        if (await backend.getThread(threadID) === undefined) return failure(id, -32602, "Thread is unavailable")
        await backend.renameThread(threadID, name)
        notify("thread/name/updated", { threadId: threadID, threadName: name })
        return result(id, {})
      }
      case "thread/archive": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        if (threadID === undefined) return failure(id, -32602, "threadId is required")
        if (await backend.getThread(threadID) === undefined) return failure(id, -32602, "Thread is unavailable")
        await backend.archiveThread(threadID)
        retireRoot(threadID)
        notify("thread/archived", { threadId: threadID })
        return result(id, {})
      }
      case "thread/unarchive": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        if (threadID === undefined) return failure(id, -32602, "threadId is required")
        let thread: NativeDots.RootSnapshot
        try {
          thread = await backend.unarchiveThread(threadID)
        } catch {
          return failure(id, -32602, "Thread is unavailable")
        }
        restoreRoot(threadID)
        notify("thread/unarchived", { threadId: threadID })
        const restored = wire(thread)
        if (escalationsStarted) {
          const release = holdStatus(threadID)
          escalated(threadID)
          release()
        }
        return result(id, { thread: restored })
      }
      case "thread/delete": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        if (threadID === undefined) return failure(id, -32602, "threadId is required")
        try {
          await backend.deleteThread(threadID)
        } catch {
          return failure(id, -32602, "Thread is unavailable")
        }
        retireRoot(threadID)
        notify("thread/deleted", { threadId: threadID })
        return result(id, {})
      }
      case "thread/resume": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        if (threadID === undefined) return failure(id, -32602, "threadId is required")
        const configInfo = validateThreadConfig(params.config)
        if (!configInfo.ok) return failure(id, -32602, configInfo.message)
        const extracted = extractModelInputs(params, configInfo)
        if (!extracted.ok) return failure(id, -32602, extracted.message)
        const loaded = params.excludeTurns === true ? undefined : await backend.readThread(threadID)
        let thread = params.excludeTurns === true ? await backend.getThread(threadID) : loaded
        if (thread === undefined) return failure(id, -32602, "Thread is unavailable")
        if (changedDirectory(params, thread)) return failure(id, -32602, "cwd cannot change an existing YCoding Session")
        if (extracted.modelParam !== undefined || extracted.modelProviderParam !== undefined || extracted.effortParam !== undefined) {
          const current = thread.selectedModel
          const resolved = await resolveRequestedModel({
            extracted,
            fallbackModel: async () => current ?? (backend.defaultModel ? await backend.defaultModel() : undefined),
            models: backend.models,
          })
          if (!resolved.ok) return failure(id, -32602, resolved.message)
          if (!backend.selectModel || !resolved.model) return failure(id, -32602, "Model selection is unsupported")
          try {
            thread = await backend.selectModel(threadID, resolved.model)
          } catch {
            return failure(id, -32602, "Model selection is invalid or unavailable")
          }
        }
        const messages = loaded?.messages ?? []
        const configured = await watchWith(thread.session.id, () => threadConfiguration(wire(thread, messages, transcriptSummaries(messages))))
        return result(id, { ...configured, turnsBackwardsCursor: null, itemsBackwardsCursor: null })
      }
      case "thread/settings/update": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        if (threadID === undefined) return failure(id, -32602, "threadId is required")
        const extracted = extractModelInputs(params)
        if (!extracted.ok) return failure(id, -32602, extracted.message)
        const thread = await backend.getThread(threadID)
        if (thread === undefined) return failure(id, -32602, "Thread is unavailable")
        if (changedDirectory(params, thread)) return failure(id, -32602, "cwd cannot change an existing YCoding Session")
        if (extracted.modelParam !== undefined || extracted.modelProviderParam !== undefined || extracted.effortParam !== undefined) {
          const resolved = await resolveRequestedModel({
            extracted,
            fallbackModel: async () => thread.selectedModel ?? (backend.defaultModel ? await backend.defaultModel() : undefined),
            models: backend.models,
          })
          if (!resolved.ok) return failure(id, -32602, resolved.message)
          if (!backend.selectModel || !resolved.model) return failure(id, -32602, "Model selection is unsupported")
          try {
            const updated = await backend.selectModel(threadID, resolved.model)
            notify("thread/started", { thread: wire(updated) })
          } catch {
            return failure(id, -32602, "Model selection is invalid or unavailable")
          }
        }
        return result(id, {})
      }
      case "thread/list": {
        const threads = await backend.listThreads()
        return result(id, { data: threads.map((thread) => wire(thread)), nextCursor: null, backwardsCursor: null })
      }
      case "thread/read": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        if (threadID === undefined) return failure(id, -32602, "threadId is required")
        const loaded = params.includeTurns === true ? await backend.readThread(threadID) : undefined
        const thread = params.includeTurns === true ? loaded : await backend.getThread(threadID)
        if (thread === undefined) return failure(id, -32602, "Thread is unavailable")
        const messages = loaded?.messages ?? []
        const wired = await watchWith(threadID, () => wire(thread, messages, transcriptSummaries(messages)))
        return result(id, { thread: wired })
      }
      case "turn/start":
      case "turn/steer": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        const text = inputText(params)
        if (threadID === undefined || text === undefined) return failure(id, -32602, "threadId and text input are required")
        const extracted = extractModelInputs(params)
        if (!extracted.ok) return failure(id, -32602, extracted.message)
        const thread = await backend.getThread(threadID)
        if (thread === undefined) return failure(id, -32602, "Thread is unavailable")
        if (changedDirectory(params, thread)) return failure(id, -32602, "cwd cannot change an existing YCoding Session")
        let resolvedModel: Model.Ref | undefined
        if (extracted.modelParam !== undefined || extracted.modelProviderParam !== undefined || extracted.effortParam !== undefined) {
          const resolved = await resolveRequestedModel({
            extracted,
            fallbackModel: async () => thread.selectedModel ?? (backend.defaultModel ? await backend.defaultModel() : undefined),
            models: backend.models,
          })
          if (!resolved.ok) return failure(id, -32602, resolved.message)
          resolvedModel = resolved.model
          if (resolvedModel && backend.selectModel) {
            try {
              await backend.selectModel(threadID, resolvedModel)
            } catch {
              return failure(id, -32602, "Model selection is invalid or unavailable")
            }
          }
        }
        await watch(threadID)
        const admission = admissions.get(threadID) ?? { count: 0, events: [] }
        admissions.set(threadID, admission)
        admission.count++
        let admitted: { readonly messageID: string }
        try {
          try {
            admitted = await backend.prompt(threadID, {
              text,
              inputID: JSON.stringify([input.requestScope, method, id]),
              delivery: "steer",
              ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
            })
          } catch (error) {
            if (resolvedModel !== undefined) return failure(id, -32602, "Model selection is invalid or unavailable")
            throw error
          }
          if (!active || revoked.has(threadID)) throw new Error("Native connection retired during admission")
          turns.set(admitted.messageID, { threadID, items: new Map(), completed: new Set() })
          notify("turn/started", { threadId: threadID, turn: { id: admitted.messageID, status: "inProgress", error: null, items: [] } })
        } finally {
          admission.count--
          if (!admission.count) {
            admissions.delete(threadID)
            for (const event of admission.events) runtimeEvent(threadID, event)
          }
        }
        return result(id, { turn: { id: admitted.messageID, status: "inProgress", items: [] } })
      }
      case "turn/interrupt": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        if (threadID === undefined) return failure(id, -32602, "threadId is required")
        const thread = await backend.getThread(threadID)
        if (thread === undefined) return failure(id, -32602, "Thread is unavailable")
        if (changedDirectory(params, thread)) return failure(id, -32602, "cwd cannot change an existing YCoding Session")
        await backend.interrupt(threadID)
        return result(id, {})
      }
      case "account/read": {
        const account = await backend.account()
        return result(id, {
          account: account === undefined ? null : { type: "chatgpt", profile: account.profile },
          requiresOpenaiAuth: account === undefined,
        })
      }
      case "getAuthStatus": {
        const account = await backend.account()
        return result(id, { authMethod: account === undefined ? null : "chatgpt", requiresOpenaiAuth: account === undefined })
      }
      case "config/read": {
        const defaultModel = backend.defaultModel ? await backend.defaultModel() : undefined
        return result(id, {
          config: {
            model_provider: "ycoding",
            model_providers: { ycoding: { name: "YCoding" } },
            ...(defaultModel
              ? {
                  model: formatWireModel(defaultModel),
                  ...(defaultModel.variant ? { model_reasoning_effort: defaultModel.variant } : {}),
                }
              : {}),
          },
        })
      }
      case "config/batchWrite": {
        if (!Array.isArray(params.edits)) return failure(id, -32602, "edits array is required")
        if (params.edits.length === 0) return result(id, {})
        let modelValue: string | undefined
        let effortValue: string | null | undefined
        let profileName: string | undefined
        for (const entry of params.edits) {
          if (!isRecord(entry) || Array.isArray(entry) || typeof entry.keyPath !== "string") {
            return failure(id, -32602, "Invalid config edit")
          }
          if (entry.mergeStrategy !== undefined && entry.mergeStrategy !== null && entry.mergeStrategy !== "replace" && entry.mergeStrategy !== "upsert") {
            return failure(id, -32602, "Unsupported mergeStrategy")
          }
          const keyPath = entry.keyPath
          if (keyPath === "model") {
            if (typeof entry.value !== "string" || entry.value.trim().length === 0) {
              return failure(id, -32602, "model edit requires a non-empty string value")
            }
            if (modelValue !== undefined && modelValue !== entry.value) {
              return failure(id, -32602, "Conflicting model edits")
            }
            modelValue = entry.value
          } else if (keyPath === "model_reasoning_effort") {
            if (entry.value !== null && (typeof entry.value !== "string" || entry.value.trim().length === 0)) {
              return failure(id, -32602, "model_reasoning_effort edit requires a non-empty string or null")
            }
            if (effortValue !== undefined && effortValue !== entry.value) {
              return failure(id, -32602, "Conflicting reasoning effort edits")
            }
            effortValue = entry.value
          } else if (keyPath.startsWith("profiles.") && keyPath.endsWith(".model")) {
            const p = keyPath.slice("profiles.".length, -".model".length)
            if (p.length === 0 || p.includes(".")) return failure(id, -32602, "Invalid profile keyPath")
            if (profileName !== undefined && profileName !== p) return failure(id, -32602, "Conflicting profile edits")
            if (typeof entry.value !== "string" || entry.value.trim().length === 0) {
              return failure(id, -32602, "profile model edit requires a non-empty string value")
            }
            if (modelValue !== undefined && modelValue !== entry.value) {
              return failure(id, -32602, "Conflicting model edits")
            }
            profileName = p
            modelValue = entry.value
          } else if (keyPath.startsWith("profiles.") && keyPath.endsWith(".model_reasoning_effort")) {
            const p = keyPath.slice("profiles.".length, -".model_reasoning_effort".length)
            if (p.length === 0 || p.includes(".")) return failure(id, -32602, "Invalid profile keyPath")
            if (profileName !== undefined && profileName !== p) return failure(id, -32602, "Conflicting profile edits")
            if (entry.value !== null && (typeof entry.value !== "string" || entry.value.trim().length === 0)) {
              return failure(id, -32602, "profile model_reasoning_effort edit requires a non-empty string or null")
            }
            if (effortValue !== undefined && effortValue !== entry.value) {
              return failure(id, -32602, "Conflicting reasoning effort edits")
            }
            profileName = p
            effortValue = entry.value
          } else {
            return failure(id, -32602, `Unsupported config edit keyPath: ${keyPath}`)
          }
        }
        let targetModel: Model.Ref
        try {
          if (modelValue !== undefined) {
            targetModel = await parseWireModel({
              modelParam: modelValue,
              ...(typeof effortValue === "string" ? { effortParam: effortValue } : {}),
              ...(profileName !== undefined ? { profileHint: profileName } : {}),
              models: backend.models,
            })
            if (effortValue === null && targetModel.variant !== undefined) {
              return failure(id, -32602, "Conflicting reasoning effort edits")
            }
          } else {
            const current = backend.defaultModel ? await backend.defaultModel() : undefined
            if (!current) return failure(id, -32602, "Cannot update reasoning effort without a default model")
            if (profileName !== undefined && current.profile !== profileName) {
              return failure(id, -32602, "Profile does not match current default model")
            }
            targetModel = Model.Ref.make({
              providerID: current.providerID,
              id: current.id,
              ...(current.profile !== undefined ? { profile: current.profile } : {}),
              ...(typeof effortValue === "string" ? { variant: Model.VariantID.make(effortValue) } : {}),
            })
          }
        } catch {
          return failure(id, -32602, "Invalid model or profile configuration")
        }
        if (backend.setDefaultModel) {
          try {
            await backend.setDefaultModel(targetModel)
          } catch {
            return failure(id, -32602, "Unknown or unavailable model or profile")
          }
        } else {
          const models = await backend.models()
          const match = models.find((m) =>
            m.id === targetModel.id &&
            m.providerID === targetModel.providerID &&
            m.profile === targetModel.profile,
          )
          if (!match) return failure(id, -32602, "Unknown model or profile")
          if (targetModel.variant !== undefined) {
            const supported = match.variants
            if (!validReasoningEfforts.has(targetModel.variant) || (supported !== undefined && !supported.includes(targetModel.variant))) {
              return failure(id, -32602, "Unsupported reasoning effort for model")
            }
          }
        }
        return result(id, {})
      }
      case "model/list": {
        const [models, defaultModel] = await Promise.all([
          backend.models(),
          backend.defaultModel ? backend.defaultModel() : Promise.resolve(undefined),
        ])
        const matchesDefaultModel = (model: RemoteControlModel) =>
          defaultModel !== undefined &&
          model.id === defaultModel.id &&
          model.providerID === defaultModel.providerID &&
          model.profile === defaultModel.profile
        const hasRemoteDefault = models.some(matchesDefaultModel)
        return result(id, {
          data: models.map((model) => {
            const wireID = formatWireModel(model)
            const displayName = model.profile !== undefined
              ? `${model.name ?? model.id} (${model.providerID} · ${model.profile})`
              : model.providerID !== undefined
                ? `${model.name ?? model.id} (${model.providerID})`
                : `${model.name ?? model.id}`
            const isDefault = hasRemoteDefault ? matchesDefaultModel(model) : Boolean(model.isDefault)
            const efforts: string[] = []
            for (const variant of model.variants ?? []) {
              if (validReasoningEfforts.has(variant) && !efforts.includes(variant)) efforts.push(variant)
            }
            const supportedReasoningEfforts = efforts.map((reasoningEffort) => ({
              reasoningEffort,
              description: reasoningEffort,
            }))
            const defaultReasoningEffort = efforts.includes("medium") ? "medium" : (efforts[0] ?? null)
            return {
              id: wireID,
              model: wireID,
              displayName,
              hidden: false,
              isDefault,
              supportedReasoningEfforts,
              defaultReasoningEffort,
              ...(model.providerID === undefined ? {} : { providerId: model.providerID }),
              ...(model.profile === undefined ? {} : { profile: model.profile }),
            }
          }),
        })
      }
      case "skills/list": {
        const skills = await backend.skills()
        return result(id, { data: skills.map((skill) => ({ id: skill.id, name: skill.name ?? skill.id })) })
      }
      default:
        return failure(id, -32601, "Method not found")
    }
  }

  return {
    handle: async (text: string): Promise<string | undefined> => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return failure(null, -32700, "Parse error")
      }
      if (!isRecord(parsed)) return failure(null, -32600, "Invalid Request")
      if (!active) return failure(parsed.id ?? null, -32600, "Native connection is retired")
      if (typeof parsed.method !== "string") return response(parsed)
      const params = isRecord(parsed.params) ? parsed.params : {}
      if (parsed.method === "initialized") {
        ready = initialized
        if (ready) startEscalations()
        return undefined
      }
      if (!("id" in parsed)) return undefined
      const id = parsed.id ?? null
      try {
        const reply = await dispatch(parsed.method, params, id)
        return active ? reply : failure(id, -32600, "Native connection is retired")
      } catch (error) {
        const cause = Cause.isCause(error) ? error : undefined
        const value = cause ? Cause.squash(cause) : error
        const kinds = isRecord(value)
          ? [value._tag, value.code, typeof value.constructor === "function" ? value.constructor.name : undefined]
          : []
        const kind = kinds.find((item): item is string | number => (typeof item === "string" && /^[A-Za-z0-9_.-]+$/.test(item)) || (typeof item === "number" && Number.isFinite(item)))
          ?? cause?.reasons[0]?._tag ?? typeof value
        input.onDiagnostic?.(`Remote-control request failed ${JSON.stringify({
          method: parsed.method.slice(0, 80).replace(/[^A-Za-z0-9_./-]/g, "_"), kind: String(kind).slice(0, 80),
        })}`)
        return failure(id, -32603, "Remote-control request failed")
      }
    },
    ready: () => ready,
    retire: () => {
      if (!active) return
      active = false
      pending.clear()
      turns.clear()
      consumed.clear()
      admissions.clear()
      dirty.clear()
      for (const threadID of [...retries.keys()]) cancelRetry(threadID)
      stopEscalations?.()
      stopEscalations = undefined
      for (const subscription of subscriptions.values()) {
        if (subscription.stop) subscription.stop()
        else void subscription.pending.then((stop) => stop(), () => {})
      }
      subscriptions.clear()
      backend.retire()
    },
  }
}
