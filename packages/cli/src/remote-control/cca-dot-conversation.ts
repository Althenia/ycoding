import { randomUUID } from "node:crypto"
import type { DotsAccess } from "@ycoding-ai/core/dots/access"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import type { RemoteControlCredential } from "@ycoding-ai/core/remote-control/credential"
import { RemoteLimits } from "@ycoding-ai/remote"
import type { Dots } from "@ycoding-ai/schema/dots"
import { CcaComputerFailure, ccaPinnedCredential, ccaResolveDot, ccaRestGet, ccaRestSend } from "./cca-computer"
import { ccaDurableAdmissionTimeoutMs, ccaDurableHistoryBaseURL, listCcaDurableThreads, type CcaDurableClient, type CcaDurableServerRequest } from "./cca-durable-host"
import type { CcaFetch } from "./cca-executor-registration"

export const ccaConversationDeadlineMs = 30_000
export const ccaHistoryMaxBytes = 16 * 1024 * 1024
const threadPageLimit = 100
const maxThreadPages = 20
const taskPageLimit = 100
const maxTaskPages = 10
const defaultTurnLimit = 20
const defaultUpdateLimit = 50
const identifierPattern = /^[a-z][a-z0-9_-]{0,63}$/
const itemTypePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const turnStatuses = ["inProgress", "completed", "interrupted", "failed"] as const
const decisions = new Set(["accept", "acceptForSession", "decline", "cancel"])

export interface CcaDotConversationDeps {
  readonly native: Pick<NativeDots.Host, "configuration" | "credential">
  readonly durable: () => CcaDurableClient | undefined
  readonly fetch?: CcaFetch
  readonly historyBaseURL?: string
}

type Problem = DotsAccess.ConversationProblem
type Result<T> = DotsAccess.ConversationResult<T>
type Context = { readonly credential: RemoteControlCredential.Resolved; readonly dotID: string; readonly rootThreadID: string | undefined }
type Details = Pick<Dots.ConversationThread, "name" | "preview" | "status" | "updatedAt">

class Failure extends Error {
  readonly problem: Problem
  constructor(problem: Problem) {
    super(problem)
    this.problem = problem
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const fields = (value: unknown) => {
  if (!isRecord(value)) throw new Failure("malformed")
  return value
}
const id = (value: unknown) => {
  if (typeof value !== "string" || !value || value.length > 256) throw new Failure("malformed")
  return value
}
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined)
const label = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, max) || undefined : undefined
const optionalText = (value: unknown, max: number) => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new Failure("malformed")
  return value.slice(0, max)
}
const timestamp = (value: unknown) => {
  if (typeof value !== "string" || !value || value.length > 64 || Number.isNaN(Date.parse(value))) throw new Failure("malformed")
  return value
}
const cursorOf = (value: unknown) => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || !value || value.length > 4096) throw new Failure("malformed")
  return value
}

function problemOf(error: unknown): Problem {
  if (error instanceof Failure) return error.problem
  if (error instanceof CcaComputerFailure) {
    if (error.problem === "configuration" || error.problem === "authentication" || error.problem === "dot-unavailable") return error.problem
    return "connection"
  }
  return "connection"
}

async function run<T>(work: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    return { ok: false, problem: problemOf(error) }
  }
}

function threadStatus(value: unknown): Dots.ConversationStatus | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === "idle") return "idle"
  if (value.type === "notLoaded") return "not-loaded"
  if (value.type === "systemError") return "error"
  if (value.type !== "active") return undefined
  const flags = Array.isArray(value.activeFlags) ? value.activeFlags : []
  if (flags.includes("waitingOnApproval")) return "waiting-approval"
  if (flags.includes("waitingOnUserInput")) return "waiting-input"
  return "active"
}

function details(thread: Record<string, unknown>): Details {
  const name = label(thread.name, 256)
  const preview = label(thread.preview, 500)
  const status = threadStatus(thread.status)
  const updatedAt = typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt) && thread.updatedAt >= 0 ? Math.floor(thread.updatedAt) : undefined
  return {
    ...(name ? { name } : {}),
    ...(preview ? { preview } : {}),
    ...(status ? { status } : {}),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

function task(value: unknown): Dots.Task {
  const row = fields(value)
  if (typeof row.title !== "string" || typeof row.status !== "string" || !identifierPattern.test(row.status)) throw new Failure("malformed")
  const description = optionalText(row.description, 4000)
  const latestUpdate = optionalText(row.latest_update, 4000)
  const emoji = optionalText(row.emoji, 16)
  return {
    taskID: id(row.id),
    title: row.title.slice(0, 500),
    ...(description === undefined ? {} : { description }),
    status: row.status,
    ...(latestUpdate === undefined ? {} : { latestUpdate }),
    ...(emoji === undefined ? {} : { emoji }),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

function bounded(value: string) {
  return value.length > 65536 ? { text: value.slice(0, 65536), truncated: true as const } : { text: value }
}

function item(value: unknown): Dots.TranscriptItem {
  const row = fields(value)
  const itemID = id(row.id)
  if (typeof row.type !== "string" || !itemTypePattern.test(row.type)) throw new Failure("malformed")
  if (row.type === "userMessage") {
    if (!Array.isArray(row.content)) throw new Failure("malformed")
    const parts: string[] = []
    for (const part of row.content) {
      const entry = fields(part)
      if (entry.type !== "text") continue
      if (typeof entry.text !== "string") throw new Failure("malformed")
      parts.push(entry.text)
    }
    return { type: "userMessage", itemID, ...bounded(parts.join("\n")) }
  }
  if (row.type === "agentMessage") {
    if (typeof row.text !== "string") throw new Failure("malformed")
    return { type: "agentMessage", itemID, ...bounded(row.text) }
  }
  if (row.type === "commandExecution") {
    if (typeof row.command !== "string") throw new Failure("malformed")
    if (row.exitCode !== undefined && row.exitCode !== null && !Number.isInteger(row.exitCode)) throw new Failure("malformed")
    return { type: "commandExecution", itemID, command: row.command.slice(0, 8192), ...(typeof row.exitCode === "number" ? { exitCode: row.exitCode } : {}) }
  }
  if (row.type === "fileChange") {
    if (!Array.isArray(row.changes)) throw new Failure("malformed")
    const paths = row.changes.slice(0, 100).map((change) => {
      const entry = fields(change)
      if (typeof entry.path !== "string") throw new Failure("malformed")
      return entry.path.slice(0, 4096)
    })
    return { type: "fileChange", itemID, paths }
  }
  return { type: "other", itemID, itemType: row.type }
}

function turn(value: unknown): Dots.TranscriptTurn {
  const row = fields(value)
  if (!Array.isArray(row.items) || row.items.length > 500) throw new Failure("malformed")
  const status = turnStatuses.find((candidate) => candidate === row.status)
  return { turnID: id(row.id), ...(status ? { status } : {}), items: row.items.map(item) }
}

function pendingRequest(request: CcaDurableServerRequest): Dots.PendingRequest {
  const params = request.params
  const kind = request.method === "item/commandExecution/requestApproval" ? "command-approval"
    : request.method === "item/fileChange/requestApproval" ? "file-change-approval"
    : request.method === "item/permissions/requestApproval" ? "permissions-approval"
    : "user-input"
  const turnID = typeof params.turnId === "string" && params.turnId && params.turnId.length <= 256 ? params.turnId : undefined
  const reason = text(params.reason, 2000)
  const command = text(params.command, 8192)
  const cwd = text(params.cwd, 4096)
  const questions = kind !== "user-input" || !Array.isArray(params.questions) ? undefined : params.questions.slice(0, 16).flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id || value.id.length > 256 || typeof value.question !== "string") return []
    const header = text(value.header, 256)
    const options = Array.isArray(value.options) ? value.options.slice(0, 32).flatMap((option) => {
      if (!isRecord(option) || typeof option.label !== "string") return []
      const description = text(option.description, 1000)
      return [{ label: option.label.slice(0, 256), ...(description === undefined ? {} : { description }) }]
    }) : undefined
    return [{ questionID: value.id, ...(header === undefined ? {} : { header }), question: value.question.slice(0, 2000), ...(options === undefined ? {} : { options }) }]
  })
  return {
    requestID: request.requestID,
    threadID: request.threadID,
    ...(turnID === undefined ? {} : { turnID }),
    kind,
    ...(reason === undefined ? {} : { reason }),
    ...(command === undefined ? {} : { command }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(questions === undefined ? {} : { questions }),
  }
}

function responseFor(request: CcaDurableServerRequest, input: Dots.RequestResponse): unknown {
  if (request.method === "item/permissions/requestApproval") throw new Failure("unsupported")
  if (request.method === "item/tool/requestUserInput") {
    if (input.answers === undefined) throw new Failure("invalid-answer")
    const known = new Set(Array.isArray(request.params.questions) ? request.params.questions.flatMap((question) => isRecord(question) && typeof question.id === "string" ? [question.id] : []) : [])
    const entries = Object.entries(input.answers)
    if (!entries.length || entries.some(([questionID]) => !known.has(questionID))) throw new Failure("invalid-answer")
    return { answers: Object.fromEntries(entries.map(([questionID, answers]) => [questionID, { answers: [...answers] }])) }
  }
  if (input.decision === undefined || !decisions.has(input.decision)) throw new Failure("invalid-answer")
  return { decision: input.decision }
}

export function createCcaDotConversation(deps: CcaDotConversationDeps): DotsAccess.Conversation {
  const fetchFn = deps.fetch ?? fetch
  const historyBaseURL = (deps.historyBaseURL ?? ccaDurableHistoryBaseURL).replace(/\/+$/, "")
  const historyHeaders = { "X-OpenAI-Product-Sku": "codex" }
  const sending = new Map<string, Promise<Result<Dots.SendResult>>>()
  let resuming: Promise<Result<Dots.ResumeResult>> | undefined

  const deadline = () => AbortSignal.timeout(ccaConversationDeadlineMs)

  async function context(signal: AbortSignal): Promise<Context> {
    const { credential } = await ccaPinnedCredential(deps.native)
    const dotID = await ccaResolveDot(fetchFn, credential, signal)
    const root = await ccaRestGet(fetchFn, `/tbo/${encodeURIComponent(dotID)}/root-thread`, {}, credential, signal)
    const rootThreadID = root.root_thread_id === undefined || root.root_thread_id === null ? undefined : id(root.root_thread_id)
    return { credential, dotID, rootThreadID }
  }

  async function members(owner: Context, signal: AbortSignal) {
    const threads = owner.rootThreadID === undefined ? [] : [owner.rootThreadID]
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < maxThreadPages; page++) {
      const body = await ccaRestGet(fetchFn, `/tbo/${encodeURIComponent(owner.dotID)}/threads`, { cursor, limit: String(threadPageLimit), include_hidden: "false" }, owner.credential, signal)
      if (!Array.isArray(body.items)) throw new Failure("malformed")
      for (const entry of body.items) {
        const threadID = id(fields(entry).thread_id)
        if (!threads.includes(threadID)) threads.push(threadID)
      }
      cursor = cursorOf(body.cursor)
      if (cursor === undefined) return threads
      if (cursors.has(cursor)) throw new Failure("malformed")
      cursors.add(cursor)
    }
    throw new Failure("malformed")
  }

  async function tasks(owner: Context, signal: AbortSignal) {
    const rows: Dots.Task[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < maxTaskPages; page++) {
      const body = await ccaRestGet(fetchFn, `/tbo/${encodeURIComponent(owner.dotID)}/tasks`, { cursor, limit: String(taskPageLimit) }, owner.credential, signal)
      if (!Array.isArray(body.data)) throw new Failure("malformed")
      rows.push(...body.data.map(task))
      cursor = cursorOf(body.next_cursor)
      if (cursor === undefined) return rows
      if (cursors.has(cursor)) throw new Failure("malformed")
      cursors.add(cursor)
    }
    throw new Failure("malformed")
  }

  async function catalog() {
    const client = deps.durable()
    if (!client?.connected()) return new Map<string, Details>()
    const threads = await listCcaDurableThreads(client).catch(() => undefined)
    return new Map((threads ?? []).flatMap((thread): [string, Details][] => typeof thread.id === "string" ? [[thread.id, details(thread)]] : []))
  }

  async function member(threadID: string, signal: AbortSignal) {
    const owner = await context(signal)
    if (!(await members(owner, signal)).includes(threadID)) throw new Failure("thread-unavailable")
    return owner
  }

  function client() {
    const current = deps.durable()
    if (!current?.connected()) throw new Failure("durable-unavailable")
    return current
  }

  async function send(threadID: string, input: Dots.ThreadSend): Promise<Dots.SendResult> {
    await member(threadID, deadline())
    const durable = client()
    durable.watch(threadID)
    const reply = await durable.request("turn/addUserMessage", {
      threadId: threadID,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      clientUserMessageId: input.clientMessageID,
      messageThreadId: randomUUID(),
      ...(input.mode === "queue" ? { mode: "queue" } : {}),
    }, ccaDurableAdmissionTimeoutMs)
    if (reply.kind === "not-sent") throw new Failure("durable-unavailable")
    if (reply.kind === "error") throw new Failure("rejected")
    if (reply.kind === "unknown") return { admission: "unknown" }
    const result = isRecord(reply.result) ? reply.result : {}
    const turnValue = isRecord(result.turn) ? result.turn.id : undefined
    const turnID = typeof turnValue === "string" && turnValue && turnValue.length <= 256 ? turnValue : undefined
    const admission = result.admissionOutcome === "started" || result.admissionOutcome === "steered" || result.admissionOutcome === "duplicate" ? result.admissionOutcome : "unknown"
    return { admission, ...(turnID === undefined ? {} : { turnID }) }
  }

  async function resume(): Promise<Dots.ResumeResult> {
    const owner = await context(deadline())
    const response = await ccaRestSend(fetchFn, "POST", `/tbo/${encodeURIComponent(owner.dotID)}/runtime/resume`, {}, owner.credential, AbortSignal.timeout(RemoteLimits.dotsConnectMs)).catch(() => undefined)
    if (response === undefined) return { outcome: "unknown" }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      throw new Failure("authentication")
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => {})
      return { outcome: "unknown" }
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Failure("rejected")
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!isRecord(body) || typeof body.thread_id !== "string" || !body.thread_id || body.thread_id.length > 256) return { outcome: "unknown" }
    return {
      outcome: body.status === "unconfirmed" ? "unconfirmed" : "resumed",
      threadID: body.thread_id,
      ...(owner.rootThreadID === undefined ? {} : { rootChanged: body.thread_id !== owner.rootThreadID }),
    }
  }

  return {
    threads: () => run(async () => {
      const signal = deadline()
      const owner = await context(signal)
      const [threadIDs, rows, known] = await Promise.all([members(owner, signal), tasks(owner, signal), catalog()])
      return {
        dotID: owner.dotID,
        ...(owner.rootThreadID === undefined ? {} : { rootThreadID: owner.rootThreadID }),
        threads: threadIDs.map((threadID) => ({ threadID, kind: threadID === owner.rootThreadID ? "root" as const : "task" as const, ...known.get(threadID) })),
        tasks: rows,
      }
    }),
    taskUpdates: (taskID, page) => run(async () => {
      const signal = deadline()
      const owner = await context(signal)
      const body = await ccaRestGet(fetchFn, `/tbo/${encodeURIComponent(owner.dotID)}/tasks/${encodeURIComponent(taskID)}/updates`, {
        cursor: page.cursor, limit: String(page.limit ?? defaultUpdateLimit),
      }, owner.credential, signal)
      if (!Array.isArray(body.data) || body.data.length > 50) throw new Failure("malformed")
      const updates = body.data.map((value) => {
        const row = fields(value)
        if (typeof row.text !== "string" || row.task_id !== taskID) throw new Failure("malformed")
        return { updateID: id(row.id), text: row.text.slice(0, 8000), createdAt: timestamp(row.created_at) }
      })
      const nextCursor = cursorOf(body.next_cursor)
      return { taskID, updates, ...(nextCursor === undefined ? {} : { nextCursor }) }
    }),
    read: (threadID, page) => run(async () => {
      const signal = deadline()
      const owner = await member(threadID, signal)
      const options = { headers: historyHeaders, maxBytes: ccaHistoryMaxBytes }
      const path = `/${encodeURIComponent(threadID)}`
      const [summary, history] = await Promise.all([
        ccaRestGet(fetchFn, `/v1/threads${path}`, {}, owner.credential, signal, historyBaseURL, options),
        ccaRestGet(fetchFn, `/v2/threads${path}/turns`, {
          cursor: page.cursor, limit: String(page.limit ?? defaultTurnLimit), sortDirection: "desc", itemsView: "full",
        }, owner.credential, signal, historyBaseURL, options),
      ])
      const thread = fields(summary.thread)
      if (thread.id !== threadID) throw new Failure("malformed")
      if (!Array.isArray(history.data) || history.data.length > 50) throw new Failure("malformed")
      const turns = history.data.map(turn).reverse()
      const nextCursor = cursorOf(history.nextCursor)
      deps.durable()?.watch(threadID)
      return {
        thread: { threadID, kind: threadID === owner.rootThreadID ? "root" as const : "task" as const, ...details(thread) },
        turns,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      }
    }),
    send: (threadID, input) => {
      const key = JSON.stringify([threadID, input.clientMessageID])
      const existing = sending.get(key)
      if (existing) return existing
      const attempt = run(() => send(threadID, input))
      sending.set(key, attempt)
      void attempt.finally(() => { if (sending.get(key) === attempt) sending.delete(key) })
      return attempt
    },
    interrupt: (threadID, input) => run(async () => {
      await member(threadID, deadline())
      const reply = await client().request("turn/interrupt", { threadId: threadID, turnId: input.turnID })
      if (reply.kind === "not-sent") throw new Failure("durable-unavailable")
      if (reply.kind === "unknown") return { outcome: "unknown" as const }
      if (reply.kind === "error" && !reply.message.includes("no active turn to interrupt")) throw new Failure("rejected")
      return { outcome: "interrupted" as const }
    }),
    resume: () => {
      if (resuming) return resuming
      const attempt = run(resume)
      resuming = attempt
      void attempt.finally(() => { if (resuming === attempt) resuming = undefined })
      return attempt
    },
    requests: (threadID) => run(async () => {
      await member(threadID, deadline())
      const durable = client()
      durable.watch(threadID)
      return { threadID, requests: durable.pending(threadID).map(pendingRequest) }
    }),
    respond: (threadID, requestID, input) => run(async () => {
      const durable = deps.durable()
      const request = durable?.pending(threadID).find((candidate) => candidate.requestID === requestID)
      if (!durable || !request) throw new Failure("stale")
      const outcome = await durable.answer(threadID, requestID, responseFor(request, input))
      if (outcome === "stale") throw new Failure("stale")
      return { outcome }
    }),
  }
}
