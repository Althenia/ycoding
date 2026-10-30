import { expect, test } from "bun:test"
import { DateTime } from "effect"
import type { EventManifest } from "@ycoding-ai/schema/event-manifest"
import { createRemoteControlAppServer, type RemoteControlBackend } from "../src/remote-control/app-server"
import { createRemoteControlHost, type RemoteControlSocket } from "../src/remote-control/host"
import { nativeHost, pendingRequest, requestBackend, rootSnapshot } from "./remote-control-fixture"

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
  const status: { active: boolean; waiting: Array<"approval" | "user-input">; failGet: boolean; gate: Promise<void> | undefined; script: Array<{ active: boolean; waiting: Array<"approval" | "user-input"> }> } = { active: false, waiting: [], failGet: false, gate: undefined, script: [] }
  const stream: { emit?: Parameters<RemoteControlBackend["subscribe"]>[1]; retire?: () => void } = {}
  const timers: Array<{ readonly delay: number; readonly run: () => void; cancelled: boolean; fired: boolean }> = []
  const backend: RemoteControlBackend = {
    ...requestBackend,
    createThread: async () => thread,
    getThread: async () => {
      await status.gate
      if (status.failGet) throw Error("Synthetic read failure")
      const scripted = status.script.shift()
      return { ...thread, active: scripted?.active ?? status.active, waiting: [...(scripted?.waiting ?? status.waiting)] }
    },
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
      stream.emit = listener
      stream.retire = retired
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
  return { server, messages, escalation, pending, status, stream, timers, live, fireNext, open, settled }
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

const statusChanges = (f: ReturnType<typeof escalationServer>) =>
  f.messages.filter((message) => message.method === "thread/status/changed").map((message) => message.params)
const rpc = (f: ReturnType<typeof escalationServer>, id: number, method: string, params: Record<string, unknown> = {}) =>
  f.server.handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
const waitingOnApproval = { threadId: "ses_unopened", status: { type: "active", activeFlags: ["waitingOnApproval"] } }
const idle = { threadId: "ses_unopened", status: { type: "idle" } }
const active = { threadId: "ses_unopened", status: { type: "active", activeFlags: [] } }

test("a watched root reports one status notification per transition, in order", async () => {
  const f = escalationServer()
  await f.open()
  await rpc(f, 2, "thread/read", { threadId: "ses_unopened" })
  await f.settled()
  expect(statusChanges(f)).toEqual([])
  f.status.active = true
  f.status.waiting = ["approval"]
  f.stream.emit?.(event("session.execution.started"))
  await f.settled()
  expect(statusChanges(f)).toEqual([waitingOnApproval])
  f.status.active = false
  f.status.waiting = []
  f.stream.emit?.(event("session.execution.succeeded"))
  await f.settled()
  expect(statusChanges(f)).toEqual([waitingOnApproval, idle])
  f.server.retire()
})

test("an unchanged recomputed status sends nothing", async () => {
  const f = escalationServer()
  await f.open()
  await rpc(f, 2, "thread/read", { threadId: "ses_unopened" })
  f.stream.emit?.(event("session.execution.started"))
  f.stream.emit?.(event("session.execution.succeeded"))
  await f.settled()
  f.status.active = true
  f.stream.emit?.(event("session.execution.started"))
  await f.settled()
  f.stream.emit?.(event("session.execution.started"))
  await f.settled()
  expect(statusChanges(f)).toEqual([active])
  f.server.retire()
})

test("an execution started by another client reports active and then idle", async () => {
  const f = escalationServer()
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(statusChanges(f)).toEqual([])
  f.status.active = true
  f.stream.emit?.(event("session.execution.started"))
  await f.settled()
  f.status.active = false
  f.stream.emit?.(event("session.execution.interrupted"))
  await f.settled()
  expect(statusChanges(f)).toEqual([active, idle])
  expect(f.messages.filter((message) => message.method.startsWith("turn/"))).toEqual([])
  f.server.retire()
})

test("a completed pending read refreshes the status", async () => {
  const f = escalationServer()
  await f.open()
  await rpc(f, 2, "thread/read", { threadId: "ses_unopened" })
  f.status.waiting = ["user-input"]
  f.stream.emit?.(event("session.question.asked"))
  await f.settled()
  expect(statusChanges(f)).toEqual([{ threadId: "ses_unopened", status: { type: "active", activeFlags: ["waitingOnUserInput"] } }])
  f.server.retire()
})

test("no status notification follows archive, delete, backend retirement, or server retirement", async () => {
  for (const method of ["thread/archive", "thread/delete"]) {
    const f = escalationServer()
    await f.open()
    await rpc(f, 2, "thread/read", { threadId: "ses_unopened" })
    await rpc(f, 3, method, { threadId: "ses_unopened" })
    f.status.active = true
    f.stream.emit?.(event("session.execution.started"))
    f.escalation.listener?.("ses_unopened")
    await f.settled()
    expect(statusChanges(f)).toEqual([])
    f.server.retire()
  }
  const retired = escalationServer()
  await retired.open()
  await rpc(retired, 2, "thread/read", { threadId: "ses_unopened" })
  retired.stream.retire?.()
  retired.status.active = true
  retired.stream.emit?.(event("session.execution.started"))
  await retired.settled()
  expect(statusChanges(retired)).toEqual([])
  retired.server.retire()

  const closing = escalationServer()
  await closing.open()
  await rpc(closing, 2, "thread/read", { threadId: "ses_unopened" })
  closing.status.active = true
  closing.stream.emit?.(event("session.execution.started"))
  closing.server.retire()
  await closing.settled()
  closing.stream.emit?.(event("session.execution.succeeded"))
  await closing.settled()
  expect(statusChanges(closing)).toEqual([])

  const racing = escalationServer()
  await racing.open()
  await rpc(racing, 2, "thread/read", { threadId: "ses_unopened" })
  const gate = Promise.withResolvers<void>()
  racing.status.gate = gate.promise
  racing.status.active = true
  racing.stream.emit?.(event("session.execution.started"))
  await racing.settled()
  racing.stream.retire?.()
  gate.resolve()
  await racing.settled()
  expect(statusChanges(racing)).toEqual([])
  racing.server.retire()
})

test("a failing status read sends nothing, keeps the root, and recovers on the next trigger", async () => {
  const f = escalationServer()
  await f.open()
  await rpc(f, 2, "thread/read", { threadId: "ses_unopened" })
  f.status.active = true
  f.status.failGet = true
  f.stream.emit?.(event("session.execution.started"))
  await f.settled()
  expect(statusChanges(f)).toEqual([])
  f.status.failGet = false
  f.stream.emit?.(event("session.execution.started"))
  await f.settled()
  expect(statusChanges(f)).toEqual([active])
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(userInputs(f)).toEqual(["ses_unopened"])
  f.server.retire()
})

test("concurrent triggers share one recomputation and keep the latest status", async () => {
  const f = escalationServer()
  await f.open()
  await rpc(f, 2, "thread/read", { threadId: "ses_unopened" })
  f.status.active = true
  for (let index = 0; index < 5; index++) f.stream.emit?.(event("session.execution.started"))
  await f.settled()
  expect(statusChanges(f)).toEqual([active])
  f.server.retire()
})

test("the first observation after a watch is sent only when it differs from the last status this stream received", async () => {
  const same = escalationServer()
  await same.open()
  await rpc(same, 2, "thread/list")
  same.escalation.listener?.("ses_unopened")
  await same.settled()
  expect(statusChanges(same)).toEqual([])
  same.server.retire()

  const changed = escalationServer()
  await changed.open()
  await rpc(changed, 2, "thread/list")
  changed.status.active = true
  changed.escalation.listener?.("ses_unopened")
  await changed.settled()
  expect(statusChanges(changed)).toEqual([active])
  changed.server.retire()
})

test("a decision that became pending after a thread/read snapshot is reported on the first pending read", async () => {
  const f = escalationServer()
  await f.open()
  f.status.script = [{ active: true, waiting: [] }, { active: true, waiting: ["approval"] }]
  const read = JSON.parse((await rpc(f, 2, "thread/read", { threadId: "ses_unopened" }))!)
  expect(read.result.thread.status).toEqual({ type: "active", activeFlags: [] })
  await f.settled()
  expect(statusChanges(f)).toEqual([waitingOnApproval])
  expect(userInputs(f)).toEqual(["ses_unopened"])
  f.server.retire()
})

test("a decision pending when an unarchived root is restored is reported without a thread read", async () => {
  const f = escalationServer()
  await f.open()
  await rpc(f, 2, "thread/read", { threadId: "ses_unopened" })
  await rpc(f, 3, "thread/archive", { threadId: "ses_unopened" })
  f.status.waiting = ["approval"]
  f.status.active = true
  const restored = JSON.parse((await rpc(f, 4, "thread/unarchive", { threadId: "ses_unopened" }))!)
  expect(restored.result.thread.status).toEqual({ type: "idle" })
  await f.settled()
  expect(statusChanges(f)).toEqual([waitingOnApproval])
  expect(userInputs(f)).toEqual(["ses_unopened", "ses_unopened"])
  f.server.retire()
})

test("a thread/read whose pending read reports no change sends no status notification", async () => {
  const f = escalationServer()
  await f.open()
  await rpc(f, 2, "thread/read", { threadId: "ses_unopened" })
  await f.settled()
  expect(statusChanges(f)).toEqual([])
  expect(userInputs(f)).toEqual(["ses_unopened"])
  f.server.retire()
})

const hostAddress = { client_id: "client-a", stream_id: "stream-a", env_id: "env" }
const hostFrame = (seq: number, message: unknown) => JSON.stringify({ type: "client_message", ...hostAddress, seq_id: seq, message })

async function hostFixture(options: { readonly script: Array<{ active: boolean; waiting: Array<"approval" | "user-input"> }>; readonly diagnostics?: string[] }) {
  const sent: Array<Record<string, any>> = []
  let receive = (_text: string) => {}
  const thread = rootSnapshot({ id: "ses_thread", directory: "/synthetic" })
  const script = [...options.script]
  const latest = { ...options.script.at(-1)! }
  const backend: RemoteControlBackend = {
    ...requestBackend,
    createThread: async () => thread,
    getThread: async () => ({ ...thread, ...(script.shift() ?? latest) }),
    listThreads: async () => [thread],
    prompt: async () => ({ messageID: "message" }), interrupt: async () => {},
    models: async () => [], skills: async () => [], account: async () => undefined,
    pending: async () => [pendingRequest("ses_thread", "per_host")],
  }
  const state = { enabled: true, profile: "fixture", installationID: "install", enrollments: {} }
  const host = createRemoteControlHost({
    store: { load: async () => state, enrollment: async () => undefined, saveEnrollment: async () => state, deleteEnrollment: async () => state },
    native: nativeHost(backend), codexHome: "/synthetic",
    ...(options.diagnostics === undefined ? {} : { onDiagnostic: (message: string) => options.diagnostics!.push(message) }),
    fetchFn: async () => Response.json({ server_id: "server", environment_id: "env", remote_control_token: "synthetic" }),
    connect: async () => {
      const socket: RemoteControlSocket = { send: (text) => { sent.push(JSON.parse(text)) }, close: () => {}, onMessage: (handler) => { receive = handler }, onClose: () => {}, onError: () => {} }
      return socket
    },
  })
  await host.connectOnce()
  const flush = async () => { for (let index = 0; index < 4; index++) await new Promise<void>((resolve) => setImmediate(resolve)) }
  const wire = () => sent.filter((frame) => frame.type === "server_message").map((frame) => frame.message as Record<string, any>)
  return {
    host, flush, wire,
    send: (seq: number, message: unknown, stream = hostAddress.stream_id) => receive(JSON.stringify({ type: "client_message", ...hostAddress, stream_id: stream, seq_id: seq, message })),
    close: (seq: number, stream: string) => receive(JSON.stringify({ type: "client_closed", ...hostAddress, stream_id: stream, seq_id: seq })),
  }
}

test("on the wire a thread result is never older than a status notification already received for that root", async () => {
  const f = await hostFixture({ script: [{ active: true, waiting: [] }, { active: true, waiting: ["approval"] }] })
  try {
    f.send(1, { id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } })
    f.send(2, { jsonrpc: "2.0", method: "initialized" })
    await f.flush()
    f.send(3, { id: 2, method: "thread/read", params: { threadId: "ses_thread" } })
    await f.flush()
    const frames = f.wire()
    let view: unknown
    let seen: string[] = []
    for (const message of frames) {
      if (message.id === 2) { view = message.result.thread.status; seen.push("result") }
      else if (message.method === "thread/status/changed") { view = message.params.status; seen.push("status") }
    }
    expect(seen).toEqual(["result", "status"])
    expect(view).toEqual({ type: "active", activeFlags: ["waitingOnApproval"] })
  } finally { await f.host.stop() }
})

test("a terminal execution event reports idle even while the backend registry still lists the execution", async () => {
  const f = escalationServer()
  await f.open()
  await rpc(f, 2, "thread/read", { threadId: "ses_unopened" })
  f.status.active = true
  f.stream.emit?.(event("session.execution.started"))
  await f.settled()
  expect(statusChanges(f)).toEqual([active])
  f.stream.emit?.(Object.assign(event("session.execution.succeeded"), { data: { sessionID: "ses_child" } }))
  await f.settled()
  expect(statusChanges(f)).toEqual([active])
  f.stream.emit?.(event("session.execution.succeeded"))
  await f.settled()
  expect(statusChanges(f)).toEqual([active, idle])
  f.stream.emit?.(event("session.execution.started"))
  await f.settled()
  expect(statusChanges(f)).toEqual([active, idle, active])
  f.server.retire()
})

test("a thread result read after a terminal execution event uses the same active rule as the notification", async () => {
  const f = escalationServer()
  await f.open()
  await rpc(f, 2, "thread/read", { threadId: "ses_unopened" })
  f.status.active = true
  f.stream.emit?.(event("session.execution.started"))
  await f.settled()
  f.stream.emit?.(event("session.execution.succeeded"))
  await f.settled()
  expect(statusChanges(f)).toEqual([active, idle])
  const read = JSON.parse((await rpc(f, 3, "thread/read", { threadId: "ses_unopened" }))!)
  expect(read.result.thread.status).toEqual({ type: "idle" })
  await f.settled()
  expect(statusChanges(f)).toEqual([active, idle])
  f.server.retire()
})

test("stream counts are reported through the diagnostic sink on real transitions only, without identifiers", async () => {
  const diagnostics: string[] = []
  const f = await hostFixture({ script: [{ active: false, waiting: [] }], diagnostics })
  const lines = () => diagnostics.filter((line) => line.startsWith("Remote-control streams"))
  const counts = () => lines().map((line) => line.replace(/ at=\S+$/, ""))
  try {
    for (const stream of ["stream-one", "stream-two"]) {
      f.send(1, { id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } }, stream)
      f.send(2, { jsonrpc: "2.0", method: "initialized" }, stream)
      await f.flush()
    }
    expect(counts()).toEqual(["Remote-control streams open=1 initialized=1", "Remote-control streams open=2 initialized=2"])
    f.send(3, { id: 2, method: "thread/list" }, "stream-one")
    await f.flush()
    expect(lines()).toHaveLength(2)
    f.close(4, "stream-one")
    await f.flush()
    expect(counts().at(-1)).toBe("Remote-control streams open=1 initialized=1")
    expect(lines()).toHaveLength(3)
  } finally { await f.host.stop() }
  expect(counts().at(-1)).toBe("Remote-control streams open=0 initialized=0")
  expect(lines()).toHaveLength(4)
  f.send(5, { id: 3, method: "thread/list" }, "stream-two")
  await f.flush()
  expect(lines()).toHaveLength(4)
  for (const line of lines()) {
    expect(line).toMatch(/^Remote-control streams open=\d+ initialized=\d+ at=\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    for (const forbidden of ["client-a", "stream-one", "stream-two", "ses_thread", "env", "synthetic"]) expect(line).not.toContain(forbidden)
  }
})

const resolutions = (f: ReturnType<typeof escalationServer>) =>
  f.messages.filter((message) => message.method === "serverRequest/resolved").map((message) => (message.params as { requestId: string }).requestId)

test.each([
  ["form.replied", { id: "item" }],
  ["form.cancelled", { id: "item" }],
  ["form.timed_out", { id: "item" }],
  ["question.replied", { requestID: "item" }],
  ["question.rejected", { requestID: "item" }],
  ["question.timed_out", { requestID: "item" }],
  ["permission.replied", { requestID: "item" }],
  ["permission.cancelled", { requestID: "item" }],
  ["guardrail.replied", { requestID: "item" }],
  ["guardrail.cancelled", { requestID: "item" }],
] as const)("%s resolves a held request exactly once while the pending read still lists it", async (type, data) => {
  const f = escalationServer()
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(userInputs(f)).toEqual(["ses_unopened"])
  f.stream.emit?.(event(type, data))
  await f.settled()
  expect(resolutions(f)).toEqual(["per_escalated"])
  f.stream.emit?.(event("session.execution.started"))
  f.stream.emit?.(event(type, data))
  await f.settled()
  expect(resolutions(f)).toEqual(["per_escalated"])
  expect(userInputs(f)).toEqual(["ses_unopened"])
  f.pending.empty = true
  f.stream.emit?.(event("session.execution.started"))
  await f.settled()
  expect(resolutions(f)).toEqual(["per_escalated"])
  f.server.retire()
})

test("a resolution event that arrives before the request was surfaced keeps the stale listing from being delivered", async () => {
  const f = escalationServer()
  f.pending.empty = true
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  f.stream.emit?.(event("form.replied", { id: "item" }))
  await f.settled()
  f.pending.empty = false
  f.stream.emit?.(event("session.execution.started"))
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(userInputs(f)).toEqual([])
  expect(resolutions(f)).toEqual([])
  f.server.retire()
})

test("an unrelated or still pending request is not resolved by another request's settlement event", async () => {
  const f = escalationServer()
  await f.open()
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  f.stream.emit?.(event("form.replied", { id: "per_other" }))
  f.stream.emit?.(event("question.asked", { id: "item" }))
  await f.settled()
  expect(resolutions(f)).toEqual([])
  f.server.retire()
})
