import { expect, test } from "bun:test"
import { createRemoteControlHost, type RemoteControlSocket } from "../src/remote-control/host"
import type { RemoteControlBackend } from "../src/remote-control/app-server"
import { Reassembler } from "../src/remote-control/envelope"
import { nativeHost, requestBackend, rootSnapshot } from "./remote-control-fixture"

const address = { client_id: "client-a", stream_id: "stream-a", env_id: "env" }
const initialize = { id: 1, method: "initialize", params: { clientInfo: { name: "fixture" } } }
const frame = (seq: number, message: unknown = initialize, target = address) =>
  JSON.stringify({ type: "client_message", ...target, seq_id: seq, message })
const ping = (seq: number, target = address) => JSON.stringify({ type: "ping", ...target, seq_id: seq, state: "foreground", skip_history: true })
const chunks = (seq: number, message: unknown = initialize, target = address) => {
  const bytes = Buffer.from(JSON.stringify(message))
  const cut = Math.floor(bytes.length / 2)
  return [bytes.subarray(0, cut), bytes.subarray(cut)].map((part, segment) => JSON.stringify({
    type: "client_message_chunk", ...target, seq_id: seq, segment_id: segment, segment_count: 2,
    message_size_bytes: bytes.length, message_chunk_base64: part.toString("base64"),
  }))
}

async function fixture() {
  const sockets: Array<{ sent: Record<string, unknown>[]; message: (text: string) => void; close: () => void }> = []
  let calls = 0
  const backend: RemoteControlBackend = {
    ...requestBackend,
    createThread: async () => rootSnapshot({ id: "ses_thread", directory: "/synthetic" }),
    getThread: async () => rootSnapshot({ id: "ses_thread", directory: "/synthetic" }),
    listThreads: async () => { calls++; return [] },
    prompt: async () => ({ messageID: "message" }), interrupt: async () => {},
    models: async () => [], skills: async () => [], account: async () => undefined,
  }
  const state = { enabled: true, profile: "fixture", installationID: "install", enrollments: {} }
  const host = createRemoteControlHost({
    store: { load: async () => state, enrollment: async () => undefined, saveEnrollment: async () => state, deleteEnrollment: async () => state },
    native: nativeHost(backend), codexHome: "/synthetic",
    fetchFn: async () => Response.json({ server_id: "server", environment_id: "env", remote_control_token: "synthetic" }),
    connect: async () => {
      const sent: Record<string, unknown>[] = []
      let message = (_text: string) => {}
      let close = () => {}
      const socket: RemoteControlSocket = { send: (text) => { sent.push(JSON.parse(text)) }, close: () => close(), onMessage: (handler) => { message = handler }, onClose: (handler) => { close = handler }, onError: () => {} }
      sockets.push({ sent, message: (text) => message(text), close: () => close() })
      return socket
    },
  })
  await host.connectOnce()
  return { host, sockets, calls: () => calls, flush: () => new Promise<void>((resolve) => setImmediate(resolve)) }
}

test("ACK echoes controller sequence independently of server sequence and sibling streams", async () => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]!
    socket.message(ping(90))
    socket.message(frame(91))
    socket.message(frame(1, initialize, { ...address, client_id: "client-b" }))
    await f.flush()
    expect(socket.sent.filter((item) => item.type === "ack")).toEqual([
      { type: "ack", ...address, seq_id: 90 },
      { type: "ack", ...address, seq_id: 91 },
      { type: "ack", ...address, client_id: "client-b", seq_id: 1 },
    ])
    expect(socket.sent.filter((item) => item.type !== "ack").map((item) => [item.type, item.client_id, item.seq_id])).toEqual([
      ["pong", "client-a", 0], ["server_message", "client-a", 1], ["server_message", "client-b", 0],
    ])
  } finally { await f.host.stop() }
})

test.each([["ping", "pong"], ["client_message", "server_message"]] as const)("socket-scoped %s without env_id receives an authenticated reply", async (type, reply) => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]
    socket.message(JSON.stringify({ type, client_id: address.client_id, stream_id: address.stream_id, seq_id: 1, cursor: "synthetic", state: "foreground", message: initialize }))
    await f.flush()
    expect(socket.sent[0]).toEqual({ type: "ack", ...address, seq_id: 1 })
    expect(socket.sent[1]).toMatchObject({ type: reply, ...address, seq_id: 0 })
    if (type === "client_message") expect(socket.sent[1]?.message).toMatchObject({ id: 1, result: expect.anything() })
  } finally { await f.host.stop() }
})

test("socket-scoped chunks without env_id ACK every segment and dispatch only once", async () => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]
    socket.message(frame(1))
    await f.flush()
    const parts = chunks(2, { id: 2, method: "thread/list" }).map((part) => JSON.stringify({ ...JSON.parse(part), env_id: undefined }))
    for (const part of parts) socket.message(part)
    for (const part of parts) socket.message(part)
    await f.flush()
    expect(socket.sent.filter((item) => item.type === "ack" && item.seq_id === 2)).toEqual([0, 1, 0, 1].map((segment) => ({
      type: "ack", ...address, seq_id: 2, segment_id: segment, segment_count: 2,
    })))
    expect(socket.sent.filter((item) => item.type === "server_message")).toHaveLength(2)
    expect(socket.sent.at(-1)?.message).toMatchObject({ id: 2, result: expect.anything() })
    expect(f.calls()).toBe(1)
  } finally { await f.host.stop() }
})

test("wrong or malformed environment frames cannot dispatch, retire a stream or poison its sequence", async () => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]
    for (const env of ["other", "", null, 1, true, {}, []]) socket.message(JSON.stringify({ ...JSON.parse(frame(99)), env_id: env }))
    await f.flush()
    expect(socket.sent).toEqual([])
    socket.message(JSON.stringify({ ...JSON.parse(frame(1)), env_id: undefined }))
    await f.flush()
    for (const env of ["other", "", null, 1, true, {}, []]) socket.message(JSON.stringify({ type: "client_closed", ...address, env_id: env, seq_id: 100 }))
    socket.message(JSON.stringify({ ...JSON.parse(frame(2, { id: 2, method: "thread/list" })), env_id: undefined }))
    await f.flush()
    expect(socket.sent.filter((item) => item.type === "ack").map((item) => item.seq_id)).toEqual([1, 2])
    expect(socket.sent.filter((item) => item.type === "server_message")).toHaveLength(2)
    expect(socket.sent.every((item) => item.env_id === "env")).toBe(true)
    expect(f.calls()).toBe(1)
  } finally { await f.host.stop() }
})

test("every accepted chunk and replayed chunk receives its own ACK without duplicate dispatch", async () => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]!
    socket.message(frame(1))
    await f.flush()
    const parts = chunks(2, { id: 2, method: "thread/list" })
    socket.message(parts[0]!)
    expect(socket.sent.at(-1)).toEqual({ type: "ack", ...address, seq_id: 2, segment_id: 0, segment_count: 2 })
    socket.message(parts[0]!)
    socket.message(parts[1]!)
    await f.flush()
    for (const part of parts) socket.message(part)
    await f.flush()
    expect(socket.sent.filter((item) => item.type === "ack" && item.seq_id === 2).map((item) => item.segment_id)).toEqual([0, 0, 1, 0, 1])
    expect(f.calls()).toBe(1)
  } finally { await f.host.stop() }
})

test("unacknowledged message replay is ACKed but never redispatched, including stale sequences", async () => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]!
    socket.message(frame(1))
    socket.message(frame(2, { id: 2, method: "thread/list" }))
    socket.message(frame(2, { id: 2, method: "thread/list" }))
    socket.message(frame(1))
    socket.message(frame(2, { id: 3, method: "thread/list" }))
    await f.flush()
    expect(f.calls()).toBe(1)
    expect(socket.sent.filter((item) => item.type === "ack").map((item) => item.seq_id)).toEqual([1, 2, 2, 1])
  } finally { await f.host.stop() }
})

test("reordered or conflicting chunks do not ACK unseen bytes or destroy the accepted prefix", async () => {
  const f = await fixture()
  try {
    const socket = f.sockets[0]!
    const parts = chunks(4)
    socket.message(parts[1]!)
    expect(socket.sent).toEqual([])
    socket.message(parts[0]!)
    socket.message(JSON.stringify({ ...JSON.parse(parts[0]!), message_chunk_base64: Buffer.from("conflict").toString("base64") }))
    socket.message(frame(5))
    expect(socket.sent).toEqual([{ type: "ack", ...address, seq_id: 4, segment_id: 0, segment_count: 2 }])
    socket.message(parts[1]!)
    await f.flush()
    expect(socket.sent.filter((item) => item.type === "ack").map((item) => item.segment_id)).toEqual([0, 1])
    expect(JSON.parse(JSON.stringify(socket.sent.find((item) => item.type === "server_message")?.message)).result).toBeDefined()
  } finally { await f.host.stop() }
})

test("closure retires only its tuple and socket replacement resets receipt and chunk state", async () => {
  const f = await fixture()
  try {
    const first = f.sockets[0]!
    const parts = chunks(1)
    first.message(parts[0]!)
    first.message(JSON.stringify({ type: "client_closed", ...address, env_id: undefined, seq_id: 2 }))
    const count = first.sent.length
    first.message(parts[1]!)
    first.message(frame(3))
    first.message(JSON.stringify({ ...JSON.parse(frame(4)), env_id: undefined }))
    first.message(JSON.stringify({ ...JSON.parse(ping(5)), env_id: undefined }))
    expect(first.sent).toHaveLength(count)
    first.message(frame(1, initialize, { ...address, stream_id: "stream-b" }))
    await f.flush()
    expect(first.sent.some((item) => item.type === "server_message" && item.stream_id === "stream-b")).toBe(true)
    first.close()
    await f.host.connectOnce()
    const second = f.sockets[1]!
    second.message(parts[1]!)
    expect(second.sent).toEqual([])
    second.message(frame(1))
    await f.flush()
    expect(second.sent[0]).toEqual({ type: "ack", ...address, seq_id: 1 })
    expect(second.sent[1]?.seq_id).toBe(0)
    const before = first.sent.length
    first.message(frame(4))
    expect(first.sent).toHaveLength(before)
  } finally { await f.host.stop() }
})

test("sequence metadata is mandatory, nonnegative and safely integral for every inbound kind", () => {
  for (const type of ["client_message", "client_message_chunk", "ping", "client_closed"]) {
    for (const seq of [undefined, null, "1", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(new Reassembler({ envID: "env" }).push(JSON.stringify({ ...JSON.parse(chunks(1)[0]!), type, env_id: undefined, seq_id: seq, message: initialize })).kind).toBe("drop")
    }
  }
  expect(new Reassembler({ envID: "env" }).push(frame(0)).kind).toBe("message")
})

test("Reassembler requires a nonempty authenticated environment", () => {
  expect(() => new Reassembler({ envID: "" })).toThrow("Authenticated remote-control environment is required")
})

test.each(["other", "", null, 1, true, {}, []].map((env) => [env] as const))("supplied environment %j is rejected before receipt or partial-chunk changes", (env) => {
  for (const type of ["ping", "client_message", "client_message_chunk", "client_closed"]) {
    const r = new Reassembler({ envID: "env" })
    const parts = chunks(1).map((part) => JSON.stringify({ ...JSON.parse(part), env_id: undefined }))
    const invalid = { ...JSON.parse(parts[0]), type, env_id: env, message: initialize }
    expect(r.push(JSON.stringify({ ...invalid, seq_id: 99 })).kind).toBe("drop")
    expect(r.push(parts[0]).kind).toBe("pending")
    expect(r.push(JSON.stringify({ ...invalid, segment_id: 1 })).kind).toBe("drop")
    expect(r.push(parts[1]).kind).toBe("message")
    expect(r.push(JSON.stringify({ ...JSON.parse(frame(2)), env_id: undefined })).kind).toBe("message")
  }
})

test("socket-scoped frames retain mandatory nonempty client and stream addresses", () => {
  for (const type of ["ping", "client_message", "client_message_chunk", "client_closed"]) {
    for (const field of ["client_id", "stream_id"]) {
      for (const value of [undefined, "", null, 1]) {
        const r = new Reassembler({ envID: "env" })
        expect(r.push(JSON.stringify({ ...JSON.parse(chunks(1)[0]), type, env_id: undefined, [field]: value, message: initialize })).kind).toBe("drop")
      }
    }
  }
})

test("Reassembler forget and clear reset sequence receipts together with partial chunks", () => {
  const r = new Reassembler({ envID: "env" })
  expect(r.push(frame(8)).kind).toBe("message")
  expect(r.push(frame(8)).kind).toBe("ack")
  r.forget({ clientID: address.client_id, streamID: address.stream_id, envID: address.env_id })
  expect(r.push(frame(8)).kind).toBe("message")
  const other = { ...address, stream_id: "other" }
  const parts = chunks(9, initialize, other)
  expect(r.push(parts[0]!).kind).toBe("pending")
  r.clear()
  expect(r.push(parts[1]!).kind).toBe("drop")
  expect(r.push(frame(8)).kind).toBe("message")
})
