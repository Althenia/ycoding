import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
import { connectNative } from "../src/native-client"
import { createEventStream, createFetch } from "../../tui/test/fixture/tui-client"

test("native readiness rejects health without a valid native handshake", async () => {
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/health")
        return Response.json({ healthy: true, version: "negative-fixture", pid: process.pid, sourceEpoch: "negative-fixture" })
      return new Response('data: {"type":"wrong.initial.event"}\n\n', { headers: { "content-type": "text/event-stream" } })
    },
  })
  const statuses: unknown[] = []
  await expect(connectNative({ url: server.url.toString() }, { signal: new AbortController().signal, onStatus: (status) => { statuses.push(status) } })).rejects.toThrow()
  expect(statuses).toEqual([])
})

test("native readiness aborts a stalled initial stream and exposes no connection", async () => {
  const requested = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const events = createEventStream({ ready: false })
  const fixture = createFetch((url) => url.pathname === "/api/health"
    ? Response.json({ healthy: true, version: "negative-fixture", pid: process.pid, sourceEpoch: "negative-fixture" })
    : undefined, events)
  const abort = new AbortController()
  const pending = connectNative({ url: "http://127.0.0.1:1" }, { signal: abort.signal, fetch: fixture.fetch, socket: () => {
    const socket = fixture.fetch.socket()
    socket.addEventListener("close", () => cancelled.resolve(), { once: true })
    requested.resolve()
    return socket
  } })
  await requested.promise
  abort.abort()
  await expect(pending).rejects.toThrow()
  await cancelled.promise
})

test("native v5 reads a resident snapshot with managed attachments", async () => {
  const messages: SessionMessageInfo[] = [
    ...Array.from({ length: 100 }, (_, index): SessionMessageInfo => ({ id: `msg_prompt_${index}`, type: "user", text: `Synthetic ${index}. ${"Retained history ".repeat(16)}`, files: index === 99 ? [{ content: { type: "managed", digest: "a".repeat(64), bytes: 4, path: `attachments/sha256/aa/${"a".repeat(64)}` }, mime: "text/plain", name: "notes.txt" }] : [], agents: index === 99 ? [{ name: "reviewer" }] : [], time: { created: index + 1 } })),
    { id: "msg_response", type: "assistant", agent: "build", model: { id: "synthetic", providerID: "synthetic" }, content: [{ type: "text", text: "Synthetic response", time: { created: 500 } }], time: { created: 500, completed: 501 } },
  ]
  const health = { healthy: true, version: "synthetic", pid: 101, sourceEpoch: "synthetic" }
  const attachment = { mime: "text/plain", bytes: 4, data: "dGV4dA==" }
  const fixture = createFetch((url) => {
    if (url.pathname === "/api/health") return Response.json(health)
    if (url.pathname === `/api/session/ses_test/attachment/${"a".repeat(64)}`) return Response.json(attachment)
    if (url.pathname.endsWith("/snapshot")) return Response.json({
      sourceEpoch: "synthetic",
      session: { id: "ses_test", title: "Synthetic", model: { id: "synthetic", providerID: "synthetic" } },
      messages,
      watermark: { type: "log.synced", aggregateID: "ses_test", seq: 1000 },
    })
  })
  using server = fixture.listen((request) => fixture.fetch(request))
  const connection = await connectNative({ url: server.url.toString() }, { signal: new AbortController().signal })
  try {
    expect((await connection.api.session.snapshot({ sessionID: "ses_test", limit: 100 })).messages).toEqual(messages)
    expect(await connection.api.session.attachment.read({ sessionID: "ses_test", digest: "a".repeat(64) })).toEqual(attachment)
  } finally { await connection.close() }
})

test("reconnect reports the current backend identity and endpoint", async () => {
  const identity = (version: string, pid: number) => ({ healthy: true as const, version, pid, sourceEpoch: version })
  const firstFixture = createFetch((url) => url.pathname === "/api/health" ? Response.json(identity("identity-a", 101)) : undefined, createEventStream({ end: true }))
  const secondFixture = createFetch((url) => url.pathname === "/api/health" ? Response.json(identity("identity-b", 202)) : undefined)
  using first = firstFixture.listen((request) => firstFixture.fetch(request))
  using second = secondFixture.listen((request) => secondFixture.fetch(request))
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
