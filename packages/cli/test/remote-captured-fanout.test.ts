import { expect, test } from "bun:test"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import type { LocalServer } from "../src/remote-local"
import { createOperationCache, createSessionRegistry, createSubscriptions, executeRemoteOperation, markSessionActivity, resetSessionActivity } from "../src/remote-operations"

const patch = (file: string) => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new`
const edit = (file: string) => ({ type: "tool", id: `call_${file}`, name: "edit", state: { status: "completed", structured: { files: [{ file, patch: patch(file), additions: 1, deletions: 1 }] } } })
const reply = (id: string, content: unknown[]) => ({ id, type: "assistant", time: { created: 2, completed: 3 }, content })

function info(id: string, parentID?: string): SessionInfo {
  return {
    id,
    ...(parentID === undefined ? {} : { parentID }),
    projectID: "prj_1",
    model: { providerID: "test", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: id,
    location: { directory: "/work", workspaceID: undefined },
  } as unknown as SessionInfo
}

async function family(childCount: number) {
  const children = Array.from({ length: childCount }, (_, index) => info(`ses_child_${index}`, "ses_root"))
  const infos = [info("ses_root"), ...children]
  const positions = new Map<string, number>()
  const calls: { readonly method: string; readonly args: readonly unknown[] }[] = []
  const allCalls: typeof calls = []
  const results: Partial<Record<keyof LocalServer, unknown>> = {
    listPage: async () => ({ data: infos }),
    getSession: async (sessionID: string) => infos.find((item) => item.id === sessionID),
    snapshot: (sessionID: string) => ({ sourceEpoch: "epoch_1", watermark: { seq: positions.get(sessionID) ?? 1 } }),
    capturedInputs: (sessionID: string) => sessionID === "ses_root"
      ? [{ id: "msg_user", type: "user" }, reply("msg_reply", children.map((child) => ({ type: "tool", id: `call_${child.id}`, name: "subagent", state: { status: "completed", structured: { sessionID: child.id } } })))]
      : [{ id: "msg_task", type: "user" }, reply(`msg_${sessionID}`, [edit(`src/${sessionID}.ts`)])],
  }
  const local = new Proxy({} as LocalServer, {
    get: (_target, property: PropertyKey) => (...args: unknown[]) => {
      calls.push({ method: String(property), args })
      allCalls.push({ method: String(property), args })
      const result = results[property as keyof LocalServer]
      return Promise.resolve(typeof result === "function" ? (result as (...input: unknown[]) => unknown)(...args) : result)
    },
  })
  const registry = createSessionRegistry({ local })
  await registry.refresh()
  const cache = createOperationCache()
  const read = async (signal?: AbortSignal) => {
    const frames = await executeRemoteOperation({
      request: { type: "request", id: "req_1", operation: "session.capturedChanges.list", sessionID: "ses_root" },
      local, sessions: registry, subscriptions: createSubscriptions(), cache, ...(signal === undefined ? {} : { signal }),
    })
    return frames
  }
  const counts = () => {
    const total = new Map<string, number>()
    for (const call of calls) total.set(call.method, (total.get(call.method) ?? 0) + 1)
    calls.length = 0
    return Object.fromEntries([...total].toSorted())
  }
  return { children, positions, calls, allCalls, results, read, counts, registry, cache, local }
}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0)

test("a 130-child family reads 395 times cold and twice when cached, down from 655 and 524", async () => {
  const test = await family(130)
  test.counts()
  expect((await test.read())[0]?.ok).toBe(true)
  const cold = test.counts()
  expect(total(cold)).toBe(395)
  expect(cold).toEqual({ capturedInputs: 131, getSession: 132, snapshot: 132 })
  expect((await test.read())[0]?.ok).toBe(true)
  expect(test.counts()).toEqual({ getSession: 1, snapshot: 1 })
})

test("a cached refresh re-reads only the children a step ended in", async () => {
  const test = await family(130)
  await test.read()
  test.counts()
  test.positions.set("ses_child_3", 9)
  markSessionActivity(test.cache, "ses_child_4")
  await test.read()
  expect(test.counts()).toEqual({ getSession: 2, snapshot: 2 })
  markSessionActivity(test.cache, "ses_child_3")
  await test.read()
  expect(test.counts()).toEqual({ capturedInputs: 131, getSession: 132, snapshot: 132 })
})

test("a moved parent re-reads each child once without a second child pass", async () => {
  const test = await family(130)
  await test.read()
  test.counts()
  test.positions.set("ses_root", 5)
  await test.read()
  expect(test.counts()).toEqual({ capturedInputs: 131, getSession: 132, snapshot: 132 })
})

test("a reset of observed activity re-checks every cached child", async () => {
  const test = await family(3)
  await test.read()
  test.counts()
  resetSessionActivity(test.cache)
  await test.read()
  expect(test.counts()).toEqual({ getSession: 4, snapshot: 4 })
})

test("activity eviction preserves a cached family read at the tracking cap", async () => {
  const test = await family(3)
  for (let index = 0; index < 4_096; index++) markSessionActivity(test.cache, `ses_other_${index}`)
  expect((await test.read())[0]?.ok).toBe(true)
  test.counts()
  markSessionActivity(test.cache, "ses_new_other")
  expect((await test.read())[0]?.ok).toBe(true)
  expect(test.counts()).toEqual({ getSession: 1, snapshot: 1 })
})

test("a cold captured read survives unrelated activity during the read at the tracking cap", async () => {
  const test = await family(3)
  for (let index = 0; index < 4_096; index++) markSessionActivity(test.cache, `ses_other_${index}`)
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const capturedInputs = test.results.capturedInputs as (...args: unknown[]) => unknown
  test.results.capturedInputs = async (...args: unknown[]) => {
    if (args[0] === "ses_root") {
      started.resolve()
      await gate.promise
    }
    return capturedInputs(...args)
  }
  const read = test.read()
  await started.promise
  markSessionActivity(test.cache, "ses_new_other")
  gate.resolve()
  expect((await read)[0]?.ok).toBe(true)
})

test("activity in an evicted child is detected through the activity floor", async () => {
  const test = await family(3)
  await test.read()
  test.counts()
  markSessionActivity(test.cache, "ses_child_1")
  for (let index = 0; index < 4_096; index++) markSessionActivity(test.cache, `ses_other_${index}`)
  expect(test.cache.activity.at.size).toBe(4_096)
  expect(test.cache.activity.at.has("ses_child_1")).toBe(false)
  await test.read()
  expect(test.counts()).toEqual({ getSession: 4, snapshot: 4 })
})

test("concurrent reads of one Session share a single read", async () => {
  const test = await family(5)
  const frames = await Promise.all([test.read(), test.read(), test.read()])
  expect(frames.map((frame) => frame[0]?.ok)).toEqual([true, true, true])
  expect(test.counts().capturedInputs).toBe(6)
})

test("aborting the only waiter aborts every local call, and an aborted waiter leaves the read running for the others", async () => {
  const test = await family(3)
  const signals: AbortSignal[] = []
  const gate = Promise.withResolvers<void>()
  const capturedInputs = test.results.capturedInputs as (...args: unknown[]) => unknown
  test.results.capturedInputs = async (...args: unknown[]) => {
    signals.push(args[2] as AbortSignal)
    await gate.promise
    return capturedInputs(...args)
  }
  const first = new AbortController()
  const second = new AbortController()
  const one = test.read(first.signal)
  const two = test.read(second.signal)
  while (signals.length === 0) await Bun.sleep(1)
  first.abort()
  expect(signals[0]?.aborted).toBe(false)
  second.abort()
  expect(signals[0]?.aborted).toBe(true)
  gate.resolve()
  expect((await one)[0]?.ok).toBe(false)
  expect((await two)[0]?.ok).toBe(false)
  for (const call of test.allCalls.filter((call) => call.method === "snapshot")) expect(call.args[3]).toBeInstanceOf(AbortSignal)
})
