export * as TaskMCPTasks from "./tasks"

import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"

export type Inspection = {
  state: "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted"
  text: string
  truncated: boolean
}
const strict = { parseOptions: { onExcessProperty: "error" } } as const
const AnswerText = Schema.String.check(Schema.isMaxLength(8192))
export const InteractionResponse = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("form"),
    answer: Schema.Record(
      Schema.String,
      Schema.Union([AnswerText, Schema.Finite, Schema.Boolean, Schema.Array(AnswerText).check(Schema.isMaxLength(32))]),
    ).check(
      Schema.isMaxProperties(32),
      Schema.isPropertyNames(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
    ),
  }).annotate(strict),
  Schema.Struct({
    action: Schema.Literal("question"),
    answers: Schema.Array(Schema.Array(AnswerText).check(Schema.isMaxLength(32))).check(Schema.isMaxLength(32)),
  }).annotate(strict),
  Schema.Struct({ action: Schema.Literals(["once", "reject", "cancel"]) }).annotate(strict),
]).check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value)) <= 65536))
export type InteractionResponse = typeof InteractionResponse.Type
export const decodeInteractionResponse = Schema.decodeUnknownOption(InteractionResponse)
export type Interaction = {
  interactionId: string
  sessionID: string
  kind: "form" | "question" | "permission" | "guardrail" | "review"
  revision: string
  details: unknown
  allowedResponses: InteractionResponse["action"][]
  actionable: boolean
  reason?: string
}
export type InteractionReply = { interactionId: string; revision: string; response: InteractionResponse }
export type Backend = {
  prepare(input: { sessionID: string; workspace: string }): Promise<void>
  start(input: { sessionID: string; promptID: string; prompt: string; workspace: string }): Promise<void>
  inspect(sessionID: string, workspace: string): Promise<Inspection>
  cancel(sessionID: string, workspace: string): Promise<void>
  interactions(sessionID: string, workspace: string): Promise<{ items: Interaction[]; truncated: boolean }>
  respond(sessionID: string, workspace: string, input: InteractionReply): Promise<void>
}

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const StoredRecord = Schema.Struct({
  version: Schema.Literal(1),
  taskId: Schema.String.check(Schema.isPattern(/^ses_mcp_[a-f0-9]{32}$/)),
  digest: Digest,
  createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  phase: Schema.Literals(["preparing", "admitting", "admitted", "interrupted", "cancelled", "failed"]),
  cancelRequested: Schema.Boolean,
  replies: Schema.optional(Schema.Array(Digest).check(Schema.isMaxLength(256))),
}).annotate(strict)
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRecord))
type Record = {
  -readonly [Key in keyof Omit<typeof StoredRecord.Type, "replies">]: (typeof StoredRecord.Type)[Key]
} & {
  replies: string[]
}
export type Start = { requestId: string; prompt: string }
export type View = {
  taskId: string
  workspace: string
  createdAt: number
  state: Inspection["state"] | "cancelling" | "cancelled"
}
export class TaskError extends Error {}
export class InteractionRejected extends TaskError {}

export async function open(options: {
  directory: string
  workspaceRoot: string
  identity: string
  backend: Backend
  maxConcurrent?: number
}) {
  const maxConcurrent = options.maxConcurrent ?? 4
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16)
    throw new TaskError("maxConcurrent must be between 1 and 16")
  await mkdir(options.directory, { recursive: true, mode: 0o700 })
  await mkdir(options.workspaceRoot, { recursive: true, mode: 0o700 })
  const directory = await realpath(options.directory)
  const workspaceRoot = await realpath(options.workspaceRoot)
  const binding = JSON.stringify({ identity: options.identity, workspaceRoot })
  const bindingFile = path.join(directory, "binding.json")
  await writeFile(bindingFile, binding, { flag: "wx", mode: 0o600 }).catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
  })
  if ((await readFile(bindingFile, "utf8")) !== binding)
    throw new TaskError("Task registry belongs to another configuration")
  const files = (await readdir(directory)).filter((name) => /^ses_mcp_[a-f0-9]{32}\.json$/.test(name))
  if (files.length > 1000) throw new TaskError("Task registry exceeds its 1000-task limit")
  const records = new Map<string, Record>()
  const admissions = new Set<Promise<void>>()
  const lock = { tail: Promise.resolve() }
  const serial = <A>(run: () => Promise<A>): Promise<A> => {
    const next = lock.tail.then(run)
    lock.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const workspace = (record: Record) => path.join(workspaceRoot, record.taskId)
  const save = async (record: Record) => {
    const temporary = path.join(directory, `.${record.taskId}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
    await rename(temporary, path.join(directory, `${record.taskId}.json`))
  }
  for (const file of files) {
    const stored = decodeRecord(await readFile(path.join(directory, file), "utf8"))
    const record: Record = { ...stored, replies: [...(stored.replies ?? [])] }
    if (file !== `${record.taskId}.json`) throw new TaskError("Invalid task registry entry")
    if (record.phase === "preparing") record.phase = record.cancelRequested ? "cancelled" : "interrupted"
    if (record.phase === "admitting") record.phase = "admitted"
    records.set(record.taskId, record)
    await save(record)
  }
  const requireTask = (taskId: string) => {
    const record = records.get(taskId)
    if (!record) throw new TaskError("Unknown task")
    return record
  }
  const inspect = async (record: Record): Promise<View & { text: string; truncated: boolean }> => {
    const result: Inspection | { state: "cancelled"; text: string; truncated: boolean } =
      record.phase === "preparing" || record.phase === "admitting"
        ? { state: "queued", text: "", truncated: false }
        : record.phase === "interrupted" || record.phase === "cancelled" || record.phase === "failed"
          ? { state: record.phase, text: "", truncated: false }
          : await options.backend.inspect(record.taskId, workspace(record))
    const state =
      record.cancelRequested && ["queued", "running", "waiting"].includes(result.state)
        ? "cancelling"
        : record.cancelRequested && result.state === "interrupted"
          ? "cancelled"
          : result.state
    return { taskId: record.taskId, workspace: workspace(record), createdAt: record.createdAt, ...result, state }
  }
  const get = async (taskId: string): Promise<View> => {
    const value = await inspect(requireTask(taskId))
    return { taskId: value.taskId, workspace: value.workspace, createdAt: value.createdAt, state: value.state }
  }
  const admit = async (record: Record, prompt: string) => {
    await options.backend.prepare({ sessionID: record.taskId, workspace: workspace(record) })
    const proceed = await serial(async () => {
      record.phase = record.cancelRequested ? "cancelled" : "admitting"
      await save(record)
      return !record.cancelRequested
    })
    if (!proceed) return
    await options.backend.start({
      sessionID: record.taskId,
      promptID: `msg_mcp_${record.taskId.slice(8)}`,
      prompt,
      workspace: workspace(record),
    })
    await serial(async () => {
      record.phase = "admitted"
      await save(record)
    })
    if (record.cancelRequested) await options.backend.cancel(record.taskId, workspace(record))
  }
  const start = (input: Start) =>
    serial(async () => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) throw new TaskError("Invalid requestId")
      if (!input.prompt.trim() || Buffer.byteLength(input.prompt) > 65536)
        throw new TaskError("Prompt must contain 1–65536 UTF-8 bytes")
      const taskId = `ses_mcp_${createHash("sha256").update(`${options.identity}\0${input.requestId}`).digest("hex").slice(0, 32)}`
      const digest = createHash("sha256").update(input.prompt).digest("hex")
      const existing = records.get(taskId)
      if (existing) {
        if (existing.digest !== digest) throw new TaskError("requestId already belongs to another prompt")
        return get(taskId)
      }
      if (records.size >= 1000)
        throw new TaskError("Task registry capacity reached; use a new registry after reviewing retained tasks")
      const active = { count: 0 }
      for (const record of records.values()) {
        if (["queued", "running", "waiting", "cancelling"].includes((await inspect(record)).state)) active.count++
        if (active.count >= maxConcurrent) throw new TaskError("Concurrent task capacity reached")
      }
      const record: Record = {
        version: 1,
        taskId,
        digest,
        createdAt: Date.now(),
        phase: "preparing",
        cancelRequested: false,
        replies: [],
      }
      await save(record)
      records.set(taskId, record)
      const work = admit(record, input.prompt)
        .catch(() =>
          serial(async () => {
            record.phase =
              record.phase === "admitting" || record.phase === "admitted"
                ? "admitted"
                : record.cancelRequested
                  ? "cancelled"
                  : "failed"
            await save(record)
          }),
        )
        .finally(() => admissions.delete(work))
      admissions.add(work)
      void work.catch(() => undefined)
      return get(taskId)
    })
  const cancel = async (taskId: string) => {
    const record = requireTask(taskId)
    await serial(async () => {
      record.cancelRequested = true
      await save(record)
    })
    if (record.phase === "admitted") await options.backend.cancel(taskId, workspace(record))
    return get(taskId)
  }
  const list = async (input: { cursor?: string; limit?: number } = {}) => {
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TaskError("Limit must be between 1 and 50")
    if (input.cursor !== undefined && !records.has(input.cursor)) throw new TaskError("Invalid cursor")
    const selected = [...records.keys()]
      .sort()
      .filter((id) => input.cursor === undefined || id > input.cursor)
      .slice(0, limit + 1)
    const visible = selected.slice(0, limit)
    const pages = Array.from({ length: Math.ceil(visible.length / 4) }, (_, index) =>
      visible.slice(index * 4, index * 4 + 4),
    )
    const tasks: View[] = []
    for (const page of pages) tasks.push(...(await Promise.all(page.map(get))))
    return {
      tasks,
      ...(selected.length > limit ? { nextCursor: selected[limit - 1] } : {}),
    }
  }
  const interactions = async (taskId: string) => {
    const record = requireTask(taskId)
    if (record.phase !== "admitted") return { items: [], truncated: false }
    const result = await options.backend.interactions(taskId, workspace(record))
    const items: Interaction[] = []
    for (const original of result.items) {
      const key = createHash("sha256").update(`${original.interactionId}\0${original.revision}`).digest("hex")
      const item: Interaction =
        record.cancelRequested || record.replies.includes(key)
          ? {
              ...original,
              actionable: false,
              allowedResponses: [],
              reason: record.cancelRequested
                ? "Task cancellation requested; resolve locally"
                : "Response already submitted or uncertain; inspect locally",
            }
          : original
      if (
        items.length === 50 ||
        Buffer.byteLength(JSON.stringify({ items: [...items, item], truncated: false })) > 65536
      )
        break
      items.push(item)
    }
    return { items, truncated: result.truncated || items.length < result.items.length }
  }

  const respond = (taskId: string, input: InteractionReply) =>
    serial(async () => {
      const record = requireTask(taskId)
      if (record.cancelRequested) throw new TaskError("Task cancellation was requested; resolve locally")
      if (record.phase !== "admitted") throw new TaskError("Task is not admitted")
      if (!input.interactionId || input.interactionId.length > 256 || !/^[a-f0-9]{64}$/.test(input.revision))
        throw new TaskError("Invalid interaction reference")
      const response = Option.getOrUndefined(decodeInteractionResponse(input.response))
      if (!response) throw new TaskError("Invalid tool arguments")
      const key = createHash("sha256").update(`${input.interactionId}\0${input.revision}`).digest("hex")
      if (record.replies.includes(key))
        throw new TaskError("Interaction already submitted or uncertain; inspect locally")
      const current = (await interactions(taskId)).items.find((item) => item.interactionId === input.interactionId)
      if (!current || current.revision !== input.revision || current.sessionID !== taskId)
        throw new TaskError("Interaction is stale or unavailable")
      if (!current.actionable || !current.allowedResponses.includes(response.action))
        throw new TaskError("Interaction response is not actionable")
      if (record.replies.length >= 256) throw new TaskError("Interaction reply limit reached; resolve locally")
      record.replies.push(key)
      await save(record)
      return options.backend.respond(taskId, workspace(record), { ...input, response }).then(
        () => ({ taskId, interactionId: input.interactionId, submitted: true }),
        async (error: unknown) => {
          if (error instanceof InteractionRejected) {
            record.replies = record.replies.filter((reply) => reply !== key)
            await save(record)
          }
          throw error
        },
      )
    })
  return {
    interactions,
    respond,
    start,
    get,
    result: (taskId: string) => inspect(requireTask(taskId)),
    cancel,
    list,
    settleAdmissions: () => Promise.all(admissions).then(() => undefined),
  }
}
export type Interface = Awaited<ReturnType<typeof open>>
