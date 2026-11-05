import { expect, test } from "bun:test"
import { connectNative } from "../src/native-client"

test("native readiness rejects health without the initial server.connected event", async () => {
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/health")
        return Response.json({ healthy: true, version: "negative-fixture", pid: process.pid, sourceEpoch: "negative-fixture" })
      return new Response('data: {"type":"wrong.initial.event"}\n\n', { headers: { "content-type": "text/event-stream" } })
    },
  })
  await expect(connectNative({ url: server.url.toString() }, { signal: new AbortController().signal })).rejects.toThrow("server.connected")
})

test("native readiness aborts a stalled initial stream and exposes no connection", async () => {
  const requested = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/health")
        return Response.json({ healthy: true, version: "negative-fixture", pid: process.pid, sourceEpoch: "negative-fixture" })
      request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true })
      requested.resolve()
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve() } }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const abort = new AbortController()
  const pending = connectNative({ url: server.url.toString() }, { signal: abort.signal })
  await requested.promise
  abort.abort()
  await expect(pending).rejects.toThrow()
  await cancelled.promise
})

test("reconnect reports the current backend identity and endpoint", async () => {
  const identity = (version: string, pid: number) => ({ healthy: true as const, version, pid, sourceEpoch: version })
  const connected = 'data: {"type":"server.connected","properties":{}}\n\n'
  using first = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/health") return Response.json(identity("identity-a", 101))
      return new Response(connected, { headers: { "content-type": "text/event-stream" } })
    },
  })
  using second = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/health") return Response.json(identity("identity-b", 202))
      return new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new TextEncoder().encode(connected)) } }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const statuses: unknown[] = []
  const settled = Promise.withResolvers<void>()
  const connection = await connectNative({ url: first.url.toString() }, {
    signal: new AbortController().signal,
    reconnect: async () => ({ url: second.url.toString() }),
    onStatus: (status) => { statuses.push(status); if (statuses.length === 3) settled.resolve() },
  })
  try {
    await settled.promise
    expect(statuses).toEqual([
      { status: "connected", health: identity("identity-a", 101) },
      { status: "reconnecting" },
      { status: "connected", health: identity("identity-b", 202) },
    ])
    expect(connection.health).toEqual(identity("identity-b", 202))
    expect((await connection.api.health.get()).version).toBe("identity-b")
  } finally {
    await connection.close()
  }
})
