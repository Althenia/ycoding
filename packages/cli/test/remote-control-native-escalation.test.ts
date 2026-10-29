import { expect, test } from "bun:test"
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

function escalationServer(options: { readonly subscribe?: RemoteControlBackend["subscribe"] } = {}) {
  const messages: Array<{ jsonrpc?: string; id?: unknown; method: string; params: unknown }> = []
  const thread = rootSnapshot({ id: "ses_unopened", directory: "/synthetic" })
  const escalation: { listener?: (rootID: string) => void; starts: number; stops: number; watched: string[] } = { starts: 0, stops: 0, watched: [] }
  const requests = new Map<string, ReturnType<typeof pendingRequest>>()
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
    pending: async (rootID) => [requests.get(rootID) ?? requests.set(rootID, pendingRequest(rootID, "per_escalated")).get(rootID)!],
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
  const server = createRemoteControlAppServer({ backend, codexHome: "/synthetic", requestScope: "fixture", send: (text) => messages.push(JSON.parse(text)) })
  const open = async () => {
    await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } }))
    await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }))
  }
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve))
  return { server, messages, escalation, open, settled }
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

test("a failed escalation watch is dropped and revokes only that root without crashing the server", async () => {
  const f = escalationServer({ subscribe: async (rootID) => { if (rootID === "ses_failing") throw Error("Synthetic failure"); return () => {} } })
  await f.open()
  f.escalation.listener?.("ses_failing")
  await f.settled()
  f.escalation.listener?.("ses_failing")
  await f.settled()
  expect(f.escalation.watched).toEqual(["ses_failing"])
  f.escalation.listener?.("ses_unopened")
  await f.settled()
  expect(f.messages.filter((message) => message.method === "item/tool/requestUserInput").map((message) => (message.params as { threadId: string }).threadId)).toEqual(["ses_unopened"])
  expect(JSON.parse((await f.server.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/list" })))!).result.data).toHaveLength(1)
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
