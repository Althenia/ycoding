import { OpenAICodex } from "@ycoding-ai/core/plugin/provider/openai-codex"
import { Platform } from "@ycoding-ai/core/util/platform"
import { DateTime } from "effect"
import { platformFamily } from "./types"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import type { EventManifest } from "@ycoding-ai/schema/event-manifest"
import type { SessionMessage } from "@ycoding-ai/schema/session-message"

export type RemoteControlLocation = { readonly directory: string; readonly workspaceID?: string }
export interface RemoteControlBackend {
  readonly createThread: (input: { readonly location: RemoteControlLocation; readonly title?: string; readonly inputID: string }) => Promise<NativeDots.RootSnapshot>
  readonly getThread: NativeDots.Channel["getRoot"]
  readonly listThreads: NativeDots.Channel["listRoots"]
  readonly readThread: NativeDots.Channel["readRoot"]
  readonly prompt: (
    threadID: string,
    input: {
      readonly text: string
      readonly inputID: string
      readonly delivery: "steer" | "queue"
    },
  ) => Promise<{ readonly messageID: string }>
  readonly interrupt: (threadID: string) => Promise<void>
  readonly models: () => Promise<readonly { readonly id: string; readonly providerID?: string; readonly name?: string }[]>
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
}

const refusedPrefixes = ["command/", "process/", "fs/", "permission/", "guardrail/", "question/", "form/"] as const
const unsupportedOverrides = ["model", "modelProvider", "approvalPolicy", "approvalsReviewer", "sandbox", "sandboxPolicy", "config"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function validHeaderValue(value: string) {
  return value.length > 0 && value.length <= 256 && !/[\0-\x1f\x7f]/.test(value)
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
    model: snapshot.selectedModel?.id ?? "unknown",
    reasoningEffort: null,
    createdAt: Math.floor(DateTime.toEpochMillis(thread.time.created) / 1_000),
    updatedAt: Math.floor(DateTime.toEpochMillis(thread.time.updated) / 1_000),
    recencyAt: null,
    status: snapshot.active || snapshot.waiting.length > 0
      ? { type: "active", activeFlags: snapshot.waiting.map((wait) => wait === "approval" ? "waitingOnApproval" : "waitingOnUserInput") }
      : { type: "idle" },
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
    approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, reasoningEffort: null }
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
  let escalationsStarted = false
  let stopEscalations: (() => void) | undefined
  const notify = (method: string, params: unknown) => {
    if (active) input.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
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

  function surfaceApprovals(threadID: string): Promise<void> {
    if (revoked.has(threadID)) return Promise.reject(new Error("Native access retired"))
    dirty.add(threadID)
    const current = refreshing.get(threadID)
    if (current) return current
    const task = (async () => {
      do {
        dirty.delete(threadID)
        const requests = await backend.pending(threadID)
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
      const override = unsupportedOverrides.find((field) => params[field] !== undefined && params[field] !== null)
      if (override !== undefined) return failure(id, -32602, `Native ${override} overrides are unsupported; YCoding owns execution configuration`)
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
        const thread = await backend.createThread({
          location: { directory: cwd },
          inputID: JSON.stringify([input.requestScope, method, id]),
          ...(typeof params.title === "string" ? { title: params.title } : {}),
        })
        await watch(thread.session.id)
        const started = threadWire(thread)
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
        if (escalationsStarted) escalated(threadID)
        return result(id, { thread: threadWire(thread) })
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
        const loaded = params.excludeTurns === true ? undefined : await backend.readThread(threadID)
        const thread = params.excludeTurns === true ? await backend.getThread(threadID) : loaded
        if (thread === undefined) return failure(id, -32602, "Thread is unavailable")
        if (changedDirectory(params, thread)) return failure(id, -32602, "cwd cannot change an existing YCoding Session")
        const messages = loaded?.messages ?? []
        await watch(thread.session.id)
        return result(id, { ...threadConfiguration(threadWire(thread, messages, transcriptSummaries(messages))), turnsBackwardsCursor: null, itemsBackwardsCursor: null })
      }
      case "thread/list": {
        const threads = await backend.listThreads()
        return result(id, { data: threads.map((thread) => threadWire(thread)), nextCursor: null, backwardsCursor: null })
      }
      case "thread/read": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        if (threadID === undefined) return failure(id, -32602, "threadId is required")
        const loaded = params.includeTurns === true ? await backend.readThread(threadID) : undefined
        const thread = params.includeTurns === true ? loaded : await backend.getThread(threadID)
        if (thread === undefined) return failure(id, -32602, "Thread is unavailable")
        const messages = loaded?.messages ?? []
        await watch(threadID)
        return result(id, { thread: threadWire(thread, messages, transcriptSummaries(messages)) })
      }
      case "turn/start":
      case "turn/steer": {
        const threadID = typeof params.threadId === "string" ? params.threadId : undefined
        const text = inputText(params)
        if (threadID === undefined || text === undefined) return failure(id, -32602, "threadId and text input are required")
        const thread = await backend.getThread(threadID)
        if (thread === undefined) return failure(id, -32602, "Thread is unavailable")
        if (changedDirectory(params, thread)) return failure(id, -32602, "cwd cannot change an existing YCoding Session")
        await watch(threadID)
        const admission = admissions.get(threadID) ?? { count: 0, events: [] }
        admissions.set(threadID, admission)
        admission.count++
        let admitted: { readonly messageID: string }
        try {
          admitted = await backend.prompt(threadID, {
            text,
            inputID: JSON.stringify([input.requestScope, method, id]),
            delivery: "steer",
          })
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
      case "config/read":
        return result(id, { config: {} })
      case "model/list": {
        const models = await backend.models()
        return result(id, {
          data: models.map((model) => ({
            id: model.id,
            model: model.id,
            displayName: model.name ?? model.id,
            ...(model.providerID === undefined ? {} : { providerId: model.providerID }),
          })),
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
      } catch {
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
