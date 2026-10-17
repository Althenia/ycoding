import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { TaskMCPTasks } from "../src/task-mcp/tasks"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-mcp-"))
  directories.push(directory)
  const calls: string[] = []
  const states = new Map<string, TaskMCPTasks.Inspection>()
  const backend: TaskMCPTasks.Backend = {
    prepare: async ({ sessionID }) => {
      calls.push(`prepare:${sessionID}`)
    },
    start: async ({ sessionID }) => {
      calls.push(`start:${sessionID}`)
      states.set(sessionID, { state: "running", text: "", truncated: false })
    },
    inspect: async (id) => states.get(id) ?? { state: "interrupted", text: "", truncated: false },
    cancel: async (id) => {
      calls.push(`cancel:${id}`)
      states.set(id, { state: "interrupted", text: "", truncated: false })
    },
  }
  const options = {
    directory,
    workspaceRoot: path.join(directory, "workspaces"),
    identity: "repo-1",
    backend,
    maxConcurrent: 2,
  }
  return { tasks: await TaskMCPTasks.open(options), options, backend, calls, states }
}

test("durable idempotent starts isolate workspaces and reject conflicting retries", async () => {
  const f = await fixture()
  const first = await f.tasks.start({ requestId: "first", prompt: "Fix tests" })
  const duplicate = await f.tasks.start({ requestId: "first", prompt: "Fix tests" })
  expect(first.taskId).toBe(duplicate.taskId)
  await f.tasks.settleAdmissions()
  expect(f.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1)
  await expect(f.tasks.start({ requestId: "first", prompt: "Different task" })).rejects.toThrow("requestId")
  const second = await f.tasks.start({ requestId: "second", prompt: "Update docs" })
  expect(second.workspace).not.toBe(first.workspace)
  await f.tasks.settleAdmissions()
  const reopened = await TaskMCPTasks.open(f.options)
  expect((await reopened.get(first.taskId)).state).toBe("running")
  await expect(reopened.get("ses_arbitrary")).rejects.toThrow("Unknown task")
})

test("bounded capacity, pagination, result and correct-task cancellation", async () => {
  const f = await fixture()
  const first = await f.tasks.start({ requestId: "one", prompt: "One" })
  const second = await f.tasks.start({ requestId: "two", prompt: "Two" })
  await f.tasks.settleAdmissions()
  await expect(f.tasks.start({ requestId: "three", prompt: "Three" })).rejects.toThrow("capacity")
  await f.tasks.cancel(first.taskId)
  expect(f.calls).toContain(`cancel:${first.taskId}`)
  expect(f.calls).not.toContain(`cancel:${second.taskId}`)
  expect((await f.tasks.get(first.taskId)).state).toBe("cancelled")
  f.states.set(second.taskId, { state: "completed", text: "Done", truncated: false })
  expect(await f.tasks.result(second.taskId)).toMatchObject({ state: "completed", text: "Done" })
  const page = await f.tasks.list({ limit: 1 })
  expect(page.tasks).toHaveLength(1)
  expect(page.nextCursor).toBeDefined()
  expect((await f.tasks.list({ limit: 1, cursor: page.nextCursor })).tasks).toHaveLength(1)
})

test("cancel during preparation never admits the prompt", async () => {
  const f = await fixture()
  const gate = Promise.withResolvers<void>()
  f.backend.prepare = async () => gate.promise
  const task = await f.tasks.start({ requestId: "slow", prompt: "Slow task" })
  expect((await f.tasks.cancel(task.taskId)).state).toBe("cancelling")
  gate.resolve()
  await f.tasks.settleAdmissions()
  expect(f.calls.filter((call) => call.startsWith("start:"))).toEqual([])
  expect((await f.tasks.get(task.taskId)).state).toBe("cancelled")
})

test("failed admission is explicit and never replayed on retry", async () => {
  const f = await fixture()
  f.backend.start = async () => {
    throw new Error("secret provider details")
  }
  const task = await f.tasks.start({ requestId: "bad", prompt: "Task" })
  await f.tasks.settleAdmissions()
  expect(await f.tasks.get(task.taskId)).toMatchObject({ state: "interrupted" })
  expect(JSON.stringify(await f.tasks.get(task.taskId))).not.toContain("secret")
  expect((await f.tasks.start({ requestId: "bad", prompt: "Task" })).taskId).toBe(task.taskId)
})

test("failed interrupt after admission remains cancelling, never falsely cancelled", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.backend.start = async ({ sessionID }) => {
    entered.resolve()
    await release.promise
    f.states.set(sessionID, { state: "running", text: "", truncated: false })
  }
  f.backend.cancel = async () => {
    throw new Error("backend offline")
  }
  const task = await f.tasks.start({ requestId: "interrupt-failure", prompt: "Task" })
  await entered.promise
  await f.tasks.cancel(task.taskId)
  release.resolve()
  await f.tasks.settleAdmissions()
  expect((await f.tasks.get(task.taskId)).state).toBe("cancelling")
})

test("the same request ID cannot collide across owner configurations", async () => {
  const f = await fixture()
  const first = await f.tasks.start({ requestId: "same", prompt: "Task" })
  await f.tasks.settleAdmissions()
  const other = await TaskMCPTasks.open({
    ...f.options,
    directory: path.join(f.options.directory, "other"),
    identity: "other-owner",
  })
  const second = await other.start({ requestId: "same", prompt: "Task" })
  await other.settleAdmissions()
  expect(first.taskId).not.toBe(second.taskId)
  await expect(other.get(first.taskId)).rejects.toThrow("Unknown task")
  await expect(TaskMCPTasks.open({ ...f.options, identity: "different-owner" })).rejects.toThrow(
    "another configuration",
  )
})

test("a still-pending prompt remains cancelling after interrupt", async () => {
  const f = await fixture()
  const task = await f.tasks.start({ requestId: "pending", prompt: "Task" })
  await f.tasks.settleAdmissions()
  f.states.set(task.taskId, { state: "queued", text: "", truncated: false })
  f.backend.cancel = async () => undefined
  expect((await f.tasks.cancel(task.taskId)).state).toBe("cancelling")
})

test("setup failures are terminal and do not expose backend error details", async () => {
  const f = await fixture()
  f.backend.prepare = async () => {
    throw new Error("private path and credential details")
  }
  const task = await f.tasks.start({ requestId: "setup-failure", prompt: "Task" })
  await f.tasks.settleAdmissions()
  expect((await f.tasks.get(task.taskId)).state).toBe("failed")
  expect(f.calls.filter((call) => call.startsWith("start:"))).toEqual([])
  expect(JSON.stringify(await f.tasks.result(task.taskId))).not.toContain("private")
})
