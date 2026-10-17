export * as TaskMCPTasks from "./tasks"

import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

export type Inspection = {
  state: "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted"
  text: string
  truncated: boolean
}
export type Backend = {
  prepare(input: { sessionID: string; workspace: string }): Promise<void>
  start(input: { sessionID: string; promptID: string; prompt: string; workspace: string }): Promise<void>
  inspect(sessionID: string, workspace: string): Promise<Inspection>
  cancel(sessionID: string, workspace: string): Promise<void>
}

const recordSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string().regex(/^ses_mcp_[a-f0-9]{32}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative(),
    phase: z.enum(["preparing", "admitting", "admitted", "interrupted", "cancelled", "failed"]),
    cancelRequested: z.boolean(),
  })
  .strict()
type Record = z.infer<typeof recordSchema>
export type Start = { requestId: string; prompt: string }
export type View = {
  taskId: string
  workspace: string
  createdAt: number
  state: Inspection["state"] | "cancelling" | "cancelled"
}
export class TaskError extends Error {}

/** Ownership/admission index only. Execution and transcript remain owned by durable Sessions. */
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
    const record = recordSchema.parse(JSON.parse(await readFile(path.join(directory, file), "utf8")))
    if (file !== `${record.taskId}.json`) throw new TaskError("Invalid task registry entry")
    // Never replay a partially prepared task or an uncertain prompt admission after a crash.
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
      let active = 0
      // Retained history must not fan out thousands of local API calls at once.
      for (const record of records.values()) {
        if (["queued", "running", "waiting", "cancelling"].includes((await inspect(record)).state)) active++
        if (active >= maxConcurrent) throw new TaskError("Concurrent task capacity reached")
      }
      const record: Record = {
        version: 1,
        taskId,
        digest,
        createdAt: Date.now(),
        phase: "preparing",
        cancelRequested: false,
      }
      await save(record)
      records.set(taskId, record)
      const work = admit(record, input.prompt)
        .catch(() =>
          serial(async () => {
            // An admission failure can be a lost HTTP response. Inspect the Session; never replay it.
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
      // Own background preparation failures, including a disk failure recording the outcome.
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
    const tasks: View[] = []
    for (let offset = 0; offset < Math.min(limit, selected.length); offset += 4)
      tasks.push(...(await Promise.all(selected.slice(offset, Math.min(offset + 4, limit)).map(get))))
    return {
      tasks,
      ...(selected.length > limit ? { nextCursor: selected[limit - 1] } : {}),
    }
  }
  return {
    start,
    get,
    result: (taskId: string) => inspect(requireTask(taskId)),
    cancel,
    list,
    settleAdmissions: () => Promise.all(admissions).then(() => undefined),
  }
}
export type Interface = Awaited<ReturnType<typeof open>>
