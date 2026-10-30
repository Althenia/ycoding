import { expect, test } from "bun:test"
import { DateTime } from "effect"
import type { EventManifest } from "@ycoding-ai/schema/event-manifest"
import { createRemoteControlAppServer, type RemoteControlBackend } from "../src/remote-control/app-server"
import { pendingRequest, requestBackend, rootSnapshot } from "./remote-control-fixture"

test("pending decisions use the native user-input request, not an invented approval notification", async () => {
  const messages: Array<{ method: string; params: unknown }> = []
  const thread = rootSnapshot({ id: "ses_test", directory: "/synthetic" })
  const backend: RemoteControlBackend = {
    ...requestBackend,
    createThread: async () => thread,
    getThread: async () => thread,
    listThreads: async () => [thread],
    prompt: async () => ({ messageID: "msg_test" }),
    interrupt: async () => {},
    models: async () => [],
    skills: async () => [],
    account: async () => undefined,
    pending: async () => [pendingRequest(thread.session.id, "per_test")],
  }
  const server = createRemoteControlAppServer({ backend, codexHome: "/synthetic", requestScope: "fixture", send: (text) => messages.push(JSON.parse(text)) })
  await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } }))
  await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }))
  await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/read", params: { threadId: "ses_test" } }))
  expect(messages.some((message) => message.method === "item/approvalRequested")).toBe(false)
  expect(messages.some((message) => message.method === "item/tool/requestUserInput")).toBe(true)
})

function escalationServer(options: { readonly subscribe?: RemoteControlBackend["subscribe"]; readonly pendingFailures?: number } = {}) {
  const messages: Array<{ jsonrpc?: string; id?: unknown; method: string; params: unknown }> = []
  const thread = rootSnapshot({ id: "ses_unopened", directory: "/synthetic" })
  const escalation: { listener?: (rootID: string) => void; starts: number; stops: number; watched: string[] } = { starts: 0, stops: 0, watched: [] }
  const requests = new Map<string, ReturnType<typeof pendingRequest>>()
  const pending = { failures: options.pendingFailures ?? 0, empty: false, calls: 0 }
  const timers: Array<{ readonly delay: number; readonly run: () => void; cancelled: boolean; fired: boolean }> = []
  const backend: RemoteControlBackend = {
    ...requestBackend,
    createThread: async () => thread,
    getThread: async () => thread,
    listThreads: async () => [thread],
    prompt: async () => ({ messageID: "msg_test" }),
    interrupt: async () => {},
    models: async () => [],
    skills: async () => [],
    account: async () => undefined,
    archiveThread: async () => {},
    deleteThread: async () => {},
    unarchiveThread: async () => thread,
    pending: async (rootID) => {
      pending.calls++
      if (pending.failures > 0) { pending.failures--; throw Error("Synthetic pending failure") }
      if (pending.empty) return []
      return [requests.get(rootID) ?? requests.set(rootID, pendingRequest(rootID, rootID === "ses_unopened" ? "per_escalated" : `per_${rootID}`)).get(rootID)!]
    },
    subscribe: async (rootID, listener, retired) => {
      escalation.watched.push(rootID)
      return options.subscribe ? options.subscribe(rootID, listener, retired) : () => {}
    },
    subscribeEscalations: async (listener) => {
      escalation.starts++
      escalation.listener = listener
      return () => { escalation.stops++ }
    },
  }
  const server = createRemoteControlAppServer({ backend, codexHome: "/synthetic", requestScope: "fixture", send: (text) => messages.push(JSON.parse(text)),
    schedule: (run, delay) => {
      const timer = { delay, run, cancelled: false, fired: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve))
  const live = () => timers.filter((timer) => !timer.cancelled && !timer.fired)
  const fireNext = async () => {
    const timer = live()[0]
    if (!timer) return
    timer.fired = true
    timer.run()
    await settled()
  }
  const open = async () => {
    await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } }))
    await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }))
  }
  return { server, messages, escalation, pending, timers, live, fireNext, open, settled }
}

test("an escalation for a root this connection never opened surfaces the native user-input request", async () => {
  const f = escalationServer()
  await f.server.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } }))
  expect(f.escalation.starts).toBe(0)
  await f.server.handle(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }))
  await f.server.handle(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }))
  expect(f.escalation.starts).toBe(1)
  f.escalation.listener?.("ses_unopened")
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(f.escalation.watched).toEqual(["ses_unopened"])
  expect(f.messages.filter((message) => message.method === "item/tool/requestUserInput")).toEqual([{
    jsonrpc: "2.0", id: "per_escalated", method: "item/tool/requestUserInput",
    params: { threadId: "ses_unopened", turnId: "turn", itemId: "item", isBlocking: true, questions: pendingRequest("ses_unopened").questions },
  }])
  f.server.retire()
  expect(f.escalation.stops).toBe(1)
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(f.escalation.watched).toEqual(["ses_unopened"])
})

const userInputs = (f: ReturnType<typeof escalationServer>) =>
  f.messages.filter((message) => message.method === "item/tool/requestUserInput").map((message) => (message.params as { threadId: string }).threadId)

test("a failed escalation watch is dropped without revoking its root or crashing the server", async () => {
  const failing = new Set(["ses_failing"])
  const f = escalationServer({ subscribe: async (rootID) => { if (failing.has(rootID)) throw Error("Synthetic failure"); return () => {} } })
  await f.open()
  f.escalation.listener?.("ses_failing")
  await f.settled()
  f.escalation.listener?.("ses_failing")
  await f.settled()
  expect(f.escalation.watched).toEqual(["ses_failing", "ses_failing"])
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(userInputs(f)).toEqual(["ses_unopened"])
  failing.clear()
  f.escalation.listener?.("ses_failing")
  await f.settled()
  expect(userInputs(f)).toEqual(["ses_unopened", "ses_failing"])
  expect(JSON.parse((await f.server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/list" })))!).result.data).toHaveLength(1)
  f.server.retire()
})

test("a failed pending read keeps the subscription and the next escalation for the same root surfaces one request", async () => {
  let stops = 0
  const f = escalationServer({ pendingFailures: 1, subscribe: async () => () => { stops++ } })
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(userInputs(f)).toEqual([])
  expect(f.messages.filter((message) => message.method === "serverRequest/resolved")).toEqual([])
  expect(stops).toBe(0)
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(userInputs(f)).toEqual(["ses_unopened"])
  expect(f.escalation.watched).toEqual(["ses_unopened"])
  expect(stops).toBe(0)
  f.server.retire()
})

const event = (type: string, data: Record<string, unknown> = {}): EventManifest.ServerEvent =>
  Object.assign(Object.create(null), { type, created: DateTime.makeUnsafe(1_700_000_000_000), data: { sessionID: "ses_unopened", ...data } })

test("a later runtime event retries a failed pending read through the same subscription", async () => {
  let emit: Parameters<RemoteControlBackend["subscribe"]>[1] | undefined
  const f = escalationServer({ pendingFailures: 1, subscribe: async (_, listener) => { emit = listener; return () => {} } })
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(userInputs(f)).toEqual([])
  emit?.(event("session.execution.started"))
  await f.settled()
  expect(userInputs(f)).toEqual(["ses_unopened"])
  expect(f.escalation.watched).toEqual(["ses_unopened"])
  f.server.retire()
})

test("a failed pending read does not stop an already started turn from completing", async () => {
  let emit: Parameters<RemoteControlBackend["subscribe"]>[1] | undefined
  const f = escalationServer({ subscribe: async (_, listener) => { emit = listener; return () => {} } })
  await f.open()
  await f.server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "turn/start", params: { threadId: "ses_unopened", input: [{ type: "text", text: "go" }] } }))
  expect(userInputs(f)).toEqual(["ses_unopened"])
  f.pending.failures = 1
  emit?.(event("session.execution.started"))
  emit?.(event("session.input.consumed", { inputIDs: ["msg_test"] }))
  emit?.(event("session.execution.succeeded"))
  await f.settled()
  expect(f.messages.filter((message) => message.method === "turn/completed")).toHaveLength(1)
  expect(f.messages.filter((message) => message.method === "serverRequest/resolved")).toEqual([])
  expect(userInputs(f)).toEqual(["ses_unopened"])
  f.server.retire()
})

test("a failed read keeps a held request, and a later successful read that no longer lists it resolves it once", async () => {
  let emit: Parameters<RemoteControlBackend["subscribe"]>[1] | undefined
  const f = escalationServer({ subscribe: async (_, listener) => { emit = listener; return () => {} } })
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(userInputs(f)).toEqual(["ses_unopened"])
  f.pending.failures = 1
  emit?.(event("session.execution.started"))
  await f.settled()
  expect(f.messages.filter((message) => message.method === "serverRequest/resolved")).toEqual([])
  f.pending.empty = true
  emit?.(event("session.execution.started"))
  await f.settled()
  expect(f.messages.filter((message) => message.method === "serverRequest/resolved")).toEqual([
    { jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: "ses_unopened", requestId: "per_escalated" } },
  ])
  f.server.retire()
})

test("a failed initial read is retried once with no later event and surfaces one request", async () => {
  const f = escalationServer({ pendingFailures: 1 })
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(userInputs(f)).toEqual([])
  expect(f.live().map((timer) => timer.delay)).toEqual([1_000])
  await f.fireNext()
  expect(userInputs(f)).toEqual(["ses_unopened"])
  expect(f.live()).toEqual([])
  expect(f.pending.calls).toBe(2)
  f.server.retire()
})

test("a successful read from another path cancels the scheduled retry", async () => {
  let emit: Parameters<RemoteControlBackend["subscribe"]>[1] | undefined
  const f = escalationServer({ pendingFailures: 1, subscribe: async (_, listener) => { emit = listener; return () => {} } })
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(f.live()).toHaveLength(1)
  emit?.(event("session.execution.started"))
  await f.settled()
  expect(userInputs(f)).toEqual(["ses_unopened"])
  expect(f.live()).toEqual([])
  f.server.retire()
})

test("the scheduled retry is cancelled by stream retirement and by archiving the root", async () => {
  const retired = escalationServer({ pendingFailures: 1 })
  await retired.open()
  retired.escalation.listener?.("ses_unopened")
  await retired.settled()
  expect(retired.live()).toHaveLength(1)
  retired.server.retire()
  expect(retired.live()).toEqual([])
  expect(retired.pending.calls).toBe(1)

  const archived = escalationServer({ pendingFailures: 1 })
  await archived.open()
  archived.escalation.listener?.("ses_unopened")
  await archived.settled()
  expect(archived.live()).toHaveLength(1)
  await archived.server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/archive", params: { threadId: "ses_unopened" } }))
  expect(archived.live()).toEqual([])
  await archived.fireNext()
  expect(archived.pending.calls).toBe(1)
  expect(userInputs(archived)).toEqual([])
  archived.server.retire()
})

test("repeated read failures retry with increasing delays and stop at the cap", async () => {
  const f = escalationServer({ pendingFailures: 100 })
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  while (f.live().length) await f.fireNext()
  expect(f.timers.map((timer) => timer.delay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  expect(f.pending.calls).toBe(6)
  expect(userInputs(f)).toEqual([])
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(f.pending.calls).toBe(7)
  expect(f.live()).toEqual([])
  f.server.retire()
})

test("a request that settled before the retry is not sent, and a held one is resolved exactly once", async () => {
  const unsent = escalationServer({ pendingFailures: 1 })
  await unsent.open()
  unsent.escalation.listener?.("ses_unopened")
  await unsent.settled()
  unsent.pending.empty = true
  await unsent.fireNext()
  expect(userInputs(unsent)).toEqual([])
  expect(unsent.messages.filter((message) => message.method === "serverRequest/resolved")).toEqual([])
  unsent.server.retire()

  let emit: Parameters<RemoteControlBackend["subscribe"]>[1] | undefined
  const held = escalationServer({ subscribe: async (_, listener) => { emit = listener; return () => {} } })
  await held.open()
  held.escalation.listener?.("ses_unopened")
  await held.settled()
  expect(userInputs(held)).toEqual(["ses_unopened"])
  held.pending.failures = 1
  emit?.(event("session.execution.started"))
  await held.settled()
  expect(held.live()).toHaveLength(1)
  held.pending.empty = true
  await held.fireNext()
  expect(held.messages.filter((message) => message.method === "serverRequest/resolved")).toHaveLength(1)
  expect(userInputs(held)).toEqual(["ses_unopened"])
  held.server.retire()
})

test("a failed first subscription is retried on the schedule with no later event and surfaces one request", async () => {
  let attempts = 0
  let live = 0
  let stops = 0
  const f = escalationServer({ subscribe: async () => {
    if (++attempts === 1) throw Error("Synthetic subscribe failure")
    live++
    return () => { stops++ }
  } })
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(userInputs(f)).toEqual([])
  expect(f.live().map((timer) => timer.delay)).toEqual([1_000])
  await f.fireNext()
  expect(userInputs(f)).toEqual(["ses_unopened"])
  expect(f.live()).toEqual([])
  expect(f.escalation.watched).toEqual(["ses_unopened", "ses_unopened"])
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(f.escalation.watched).toHaveLength(2)
  expect(userInputs(f)).toEqual(["ses_unopened"])
  expect(live - stops).toBe(1)
  f.server.retire()
  expect(live - stops).toBe(0)
})

test("repeated subscribe failures retry with increasing delays and stop at the cap", async () => {
  const f = escalationServer({ subscribe: async () => { throw Error("Synthetic subscribe failure") } })
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  while (f.live().length) await f.fireNext()
  expect(f.timers.map((timer) => timer.delay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  expect(f.escalation.watched).toHaveLength(6)
  expect(userInputs(f)).toEqual([])
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(f.escalation.watched).toHaveLength(7)
  expect(f.live()).toEqual([])
  f.server.retire()
})

test("retirement or archive cancels a pending subscribe retry, and a late subscription is stopped", async () => {
  const failing = () => { throw Error("Synthetic subscribe failure") }
  const retired = escalationServer({ subscribe: async () => failing() })
  await retired.open()
  retired.escalation.listener?.("ses_unopened")
  await retired.settled()
  expect(retired.live()).toHaveLength(1)
  retired.server.retire()
  expect(retired.live()).toEqual([])
  expect(retired.escalation.watched).toHaveLength(1)

  const archived = escalationServer({ subscribe: async () => failing() })
  await archived.open()
  archived.escalation.listener?.("ses_unopened")
  await archived.settled()
  await archived.server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/archive", params: { threadId: "ses_unopened" } }))
  expect(archived.live()).toEqual([])
  await archived.fireNext()
  expect(archived.escalation.watched).toHaveLength(1)
  expect(userInputs(archived)).toEqual([])
  archived.server.retire()

  const gate = Promise.withResolvers<() => void>()
  let attempts = 0
  let stops = 0
  const late = escalationServer({ subscribe: async () => {
    if (++attempts === 1) throw Error("Synthetic subscribe failure")
    return gate.promise
  } })
  await late.open()
  late.escalation.listener?.("ses_unopened")
  await late.settled()
  await late.fireNext()
  expect(late.escalation.watched).toHaveLength(2)
  late.server.retire()
  gate.resolve(() => { stops++ })
  await late.settled()
  expect(stops).toBe(1)
  expect(userInputs(late)).toEqual([])
  expect(late.live()).toEqual([])
})

test("unarchiving an archived root re-establishes its watch and surfaces its pending request again", async () => {
  const f = escalationServer()
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  await f.server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/archive", params: { threadId: "ses_unopened" } }))
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(f.escalation.watched).toEqual(["ses_unopened"])
  await f.server.handle(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "thread/unarchive", params: { threadId: "ses_unopened" } }))
  await f.settled()
  expect(f.escalation.watched).toEqual(["ses_unopened", "ses_unopened"])
  expect(userInputs(f)).toEqual(["ses_unopened", "ses_unopened"])
  f.server.retire()
})

test("archiving or deleting a root fences later escalations for it", async () => {
  for (const method of ["thread/archive", "thread/delete"]) {
    const f = escalationServer()
    await f.open()
    await f.server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params: { threadId: "ses_unopened" } }))
    f.escalation.listener?.("ses_unopened")
    await f.settled()
    expect(f.escalation.watched).toEqual([])
    expect(userInputs(f)).toEqual([])
    f.server.retire()
  }
})

test("a subscription retirement report fences later escalations for that root", async () => {
  let retire: (() => void) | undefined
  const f = escalationServer({ subscribe: async (_, __, retired) => { retire = retired; return () => {} } })
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(userInputs(f)).toEqual(["ses_unopened"])
  retire?.()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(f.escalation.watched).toEqual(["ses_unopened"])
  expect(f.messages.filter((message) => message.method === "serverRequest/resolved")).toHaveLength(1)
  f.server.retire()
})

test("an escalation subscription that resolves after retirement is stopped", async () => {
  const gate = Promise.withResolvers<() => void>()
  let stops = 0
  const thread = rootSnapshot({ id: "ses_late", directory: "/synthetic" })
  const backend: RemoteControlBackend = {
    ...requestBackend,
    createThread: async () => thread, getThread: async () => thread, listThreads: async () => [thread],
    prompt: async () => ({ messageID: "msg_test" }), interrupt: async () => {}, models: async () => [], skills: async () => [], account: async () => undefined,
    subscribeEscalations: () => gate.promise,
  }
  const server = createRemoteControlAppServer({ backend, codexHome: "/synthetic", requestScope: "fixture", send: () => {} })
  await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } }))
  await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }))
  server.retire()
  gate.resolve(() => { stops++ })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(stops).toBe(1)
})
