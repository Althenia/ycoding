import { expect, test } from "bun:test"
import { createRemoteControlHost, type RemoteControlSocket } from "../src/remote-control/host"
import type { RemoteControlBackend } from "../src/remote-control/app-server"
import type { RemoteControlStateStore, RemoteControlEnrollment } from "../src/remote-control/state"
import type { SessionMessage } from "@ycoding-ai/schema/session-message"
import { nativeHost, requestBackend, pendingRequest, rootSnapshot } from "./remote-control-fixture"

function fixture() {
  let enrollment: RemoteControlEnrollment | undefined
  const state = { enabled: true, profile: "fixture", installationID: "install", enrollments: {} }
  const store: RemoteControlStateStore = {
    load: async () => state,
    enrollment: async () => enrollment,
    saveEnrollment: async (input) => { enrollment = input.enrollment; return state },
    deleteEnrollment: async () => { enrollment = undefined; return state },
  }
  const reads: Array<ReturnType<typeof Promise.withResolvers<SessionMessage.Info[]>>> = []
  const started = Promise.withResolvers<void>()
  const backend: RemoteControlBackend = {
    ...requestBackend,
    createThread: async () => rootSnapshot({ id: "ses_a", directory: "/synthetic" }),
    getThread: async (id) => rootSnapshot({ id, directory: "/synthetic" }),
    listThreads: async () => [],
    readThread: async (id) => { const gate = Promise.withResolvers<SessionMessage.Info[]>(); reads.push(gate); started.resolve(); return { ...rootSnapshot({ id, directory: "/synthetic" }), messages: await gate.promise } },
    prompt: async () => ({ messageID: "msg_a" }),
    interrupt: async () => {},
    models: async () => [], skills: async () => [], account: async () => undefined,
    pending: async () => [pendingRequest("ses_a")],
  }
  const sockets: Array<{ socket: RemoteControlSocket; sent: Record<string, unknown>[]; message: (text: string) => void; close: () => void; closed: () => boolean }> = []
  const diagnostics: string[] = []
  const host = createRemoteControlHost({
    store, native: nativeHost(backend), codexHome: "/synthetic", onDiagnostic: (message) => diagnostics.push(message),
    fetchFn: async () => Response.json({ server_id: "server", environment_id: "env", remote_control_token: "synthetic" }),
    connect: async () => {
      const sent: Record<string, unknown>[] = []
      let onMessage: (text: string) => void = () => {}
      let onClose: () => void = () => {}
      let closed = false
      const socket: RemoteControlSocket = {
        send: (text) => { sent.push(JSON.parse(text)) },
        close: () => { closed = true; onClose() },
        onMessage: (handler) => { onMessage = handler }, onClose: (handler) => { onClose = handler }, onError: () => {},
      }
      sockets.push({ socket, sent, message: (text) => onMessage(text), close: () => onClose(), closed: () => closed })
      return socket
    },
  })
  let seq = 0
  const frame = (client: string, stream: string, message: unknown, env = "env") => JSON.stringify({ type: "client_message", client_id: client, stream_id: stream, env_id: env, seq_id: ++seq, message })
  const send = (index: number, client: string, stream: string, method: string, id: number, params: unknown = {}) =>
    sockets[index]!.message(frame(client, stream, { id, method, params }))
  const init = (index: number, client: string, stream: string) => send(index, client, stream, "initialize", 1, { clientInfo: { name: "fixture" } })
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  return { host, sockets, reads, started, frame, send, init, flush, diagnostics }
}

function messages(socket: ReturnType<typeof fixture>["sockets"][number]) {
  return socket.sent.filter((frame) => frame.type === "server_message").map((frame) => ({ client: frame.client_id, stream: frame.stream_id, message: JSON.parse(JSON.stringify(frame.message)) }))
}

test("interleaved clients initialize independently and late notifications keep their originating stream", async () => {
  const f = fixture()
  await f.host.connectOnce()
  f.init(0, "a", "one")
  f.init(0, "b", "two")
  await f.flush()
  expect(messages(f.sockets[0]!).filter((item) => item.message.id === 1).map((item) => [item.client, item.stream, !!item.message.result])).toEqual([["a", "one", true], ["b", "two", true]])
  f.send(0, "a", "one", "thread/read", 7, { threadId: "ses_a", includeTurns: true })
  await f.started.promise
  f.send(0, "b", "two", "thread/list", 7)
  await f.flush()
  f.reads[0]!.resolve([])
  await f.flush()
  const output = messages(f.sockets[0]!)
  expect(output.filter((item) => item.message.id === 7).map((item) => [item.client, item.stream]).toSorted()).toEqual([["a", "one"], ["b", "two"]])
  expect(output.find((item) => item.message.method === "item/tool/requestUserInput")).toMatchObject({ client: "a", stream: "one" })
  await f.host.stop()
})

test("closing a stream isolates siblings and retires pending callbacks; replacement and shutdown retire sockets", async () => {
  const f = fixture()
  await f.host.connectOnce()
  f.init(0, "a", "one")
  f.init(0, "b", "two")
  await f.flush()
  f.send(0, "a", "one", "thread/read", 9, { threadId: "ses_a", includeTurns: true })
  await f.started.promise
  f.sockets[0]!.message(JSON.stringify({ type: "client_closed", client_id: "a", stream_id: "one", env_id: "env", seq_id: 20 }))
  expect(f.sockets[0]!.closed()).toBe(false)
  f.reads[0]!.resolve([])
  await f.flush()
  expect(messages(f.sockets[0]!).some((item) => item.client === "a" && (item.message.id === 9 || item.message.method === "item/tool/requestUserInput"))).toBe(false)
  f.send(0, "b", "two", "thread/list", 10)
  f.init(0, "a", "new")
  await f.flush()
  expect(messages(f.sockets[0]!).find((item) => item.client === "b" && item.message.id === 10)?.message.result).toBeDefined()
  expect(messages(f.sockets[0]!).find((item) => item.stream === "new" && item.message.id === 1)?.message.result).toBeDefined()
  await f.host.connectOnce()
  const before = f.sockets[0]!.sent.length
  f.send(0, "b", "two", "thread/list", 11)
  await f.flush()
  expect(f.sockets[0]!.sent.length).toBe(before)
  await f.host.stop()
  const after = f.sockets[1]!.sent.length
  f.init(1, "c", "three")
  await f.flush()
  expect(f.sockets[1]!.sent.length).toBe(after)
})

test("rejects another environment and clears incomplete chunks on stream closure", async () => {
  const f = fixture()
  await f.host.connectOnce()
  f.sockets[0]!.message(f.frame("a", "one", { id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } }, "other"))
  f.sockets[0]!.message(JSON.stringify({ type: "ping", stream_id: "private-stream", message: "private-payload", env_id: null }))
  expect(f.diagnostics).toEqual(['Dropped remote-control frame: missing_address {"type":"ping","keys":["env_id","message","stream_id","type"],"address":["env_id","stream_id"]}'])
  expect(f.sockets[0]!.sent).toEqual([])
  const chunk = (segment: number) => JSON.stringify({ type: "client_message_chunk", client_id: "a", stream_id: "one", env_id: "env", seq_id: 1, segment_id: segment, segment_count: 2, message_size_bytes: 4, message_chunk_base64: Buffer.from(segment ? "cd" : "ab").toString("base64") })
  f.sockets[0]!.message(chunk(0))
  f.sockets[0]!.message(JSON.stringify({ type: "client_closed", client_id: "a", stream_id: "one", env_id: "env", seq_id: 2 }))
  f.sockets[0]!.message(chunk(1))
  expect(f.sockets[0]!.sent).toEqual([{ type: "ack", client_id: "a", stream_id: "one", env_id: "env", seq_id: 1, segment_id: 0, segment_count: 2 }])
  await f.host.stop()
})

test("interleaved chunks on the same stream name remain isolated by client", async () => {
  const f = fixture()
  await f.host.connectOnce()
  const bytes = Buffer.from(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } }))
  const cut = Math.floor(bytes.length / 2)
  const chunk = (client: string, segment: number) => JSON.stringify({ type: "client_message_chunk", client_id: client, stream_id: "same", env_id: "env", seq_id: 1, segment_id: segment, segment_count: 2, message_size_bytes: bytes.length, message_chunk_base64: bytes.subarray(segment === 0 ? 0 : cut, segment === 0 ? cut : bytes.length).toString("base64") })
  for (const client of ["a", "b"]) f.sockets[0]!.message(chunk(client, 0))
  for (const client of ["a", "b"]) f.sockets[0]!.message(chunk(client, 1))
  await f.flush()
  expect(messages(f.sockets[0]!).map((item) => [item.client, item.stream, !!item.message.result])).toEqual([["a", "same", true], ["b", "same", true]])
  await f.host.stop()
})

test.each(["replacement", "shutdown"] as const)("late backend results are suppressed after socket %s", async (action) => {
  const f = fixture()
  await f.host.connectOnce()
  f.init(0, "a", "one")
  await f.flush()
  f.send(0, "a", "one", "thread/read", 12, { threadId: "ses_a", includeTurns: true })
  await f.started.promise
  if (action === "replacement") await f.host.connectOnce()
  else await f.host.stop()
  const count = f.sockets[0]!.sent.length
  f.reads[0]!.resolve([])
  await f.flush()
  expect(f.sockets[0]!.sent.length).toBe(count)
  expect(messages(f.sockets[0]!).some((item) => item.message.id === 12 || item.message.method === "item/tool/requestUserInput")).toBe(false)
  await f.host.stop()
})
