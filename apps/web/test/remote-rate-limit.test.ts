import { describe, expect, test } from "bun:test"
import { RemoteLimits, parseClientMessage, parseRelayToAgentMessage, serializeResponse, type RemoteRequest } from "@ycoding-ai/remote"
import { createRelay } from "../../../infra/cloudflare/src/relay/core"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { waitFor } from "./relay-double"

async function harness(count: number) {
  const sockets = new Map<string, Bun.ServerWebSocket<{ id: string }>>()
  const closed: { code: number; reason: string }[] = []
  const requests: RemoteRequest[] = []
  let pongs = 0
  const relay = createRelay({
    now: Date.now,
    newID: () => crypto.randomUUID(),
    send: (connectionID, raw) => {
      if (connectionID !== "agent") {
        sockets.get(connectionID)?.send(raw)
        return
      }
      const parsed = parseRelayToAgentMessage(raw)
      if (!parsed.ok) throw new Error(parsed.error.message)
      if (parsed.value.type !== "request") return
      const request = parsed.value
      requests.push(request)
      if (request.operation === "session.interrupt") return
      const offset = Number(request.input?.cursor ?? 0)
      const limit = Number(request.input?.limit ?? RemoteLimits.maxSessionListPage)
      const data = request.operation === "session.list"
        ? Array.from({ length: Math.min(limit, count - offset) }, (_, index) => ({
            id: `ses_${offset + index}`,
            title: `Session ${offset + index}`,
            time: { created: 1, updated: 1 },
          }))
        : {}
      void relay.handleAgentMessage("agent", serializeResponse({
        type: "response",
        id: request.id,
        ok: true,
        value: {
          data,
          ...(request.operation === "session.list" && offset + limit < count
            ? { cursor: { next: String(offset + limit) } }
            : {}),
        },
      }))
    },
    close: (connectionID, code, reason) => {
      closed.push({ code, reason })
      sockets.get(connectionID)?.close(code, reason)
    },
    saveSubscriptions: () => {},
    savePending: () => {},
    authorizeClientCommand: async () => ({ ok: true }),
    authorizeAgentCommand: async () => ({ ok: true }),
    authorityTtlMs: 5_000,
  })
  const connection = {
    ownerID: "usr_test",
    deviceID: "dev_test",
    browserSessionID: "browser_test",
    credentialExpiresAt: Date.now() + 120_000,
    subscriptions: [],
    pending: [],
  }
  await relay.attach({ ...connection, connectionID: "agent", role: "agent" })
  const server = Bun.serve<{ id: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/api/me") return Response.json({
        user: { id: connection.ownerID },
        session: { expiresAt: connection.credentialExpiresAt },
        devices: [{ id: connection.deviceID, name: "Test machine", status: "active", online: true, createdAt: 1 }],
      })
      if (server.upgrade(request, { data: { id: crypto.randomUUID() } })) return undefined
      return new Response("WebSocket required", { status: 426 })
    },
    websocket: {
      async open(socket) {
        sockets.set(socket.data.id, socket)
        await relay.attach({ ...connection, connectionID: socket.data.id, role: "client" })
      },
      message(socket, raw) {
        const parsed = parseClientMessage(String(raw))
        if (parsed.ok && parsed.value.type === "pong") pongs += 1
        return relay.handleClientMessage(socket.data.id, String(raw))
      },
      close(socket) {
        sockets.delete(socket.data.id)
        relay.detach(socket.data.id)
      },
    },
  })
  return {
    server,
    closed,
    requests,
    get pongs() { return pongs },
    ping: () => {
      for (const socket of sockets.values()) socket.send('{"type":"ping"}')
    },
    drop: () => {
      for (const socket of sockets.values()) socket.close(1012, "Connection interrupted")
    },
  }
}

describe("remote request budget integration", () => {
  test("loads an inventory larger than one relay request window without reconnecting", async () => {
    const count = 6_201
    const fixture = await harness(count)
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: `http://127.0.0.1:${fixture.server.port}` }),
      createTransport: (_deviceID, handlers) => createRemoteTransport({
        url: `ws://127.0.0.1:${fixture.server.port}`,
        handlers,
      }),
    })
    try {
      await store.load()
      await waitFor(() => store.state().sessions.length === count || fixture.closed.length > 0, 25_000)
      expect(fixture.closed).toEqual([])
      expect(store.state().connection.kind).toBe("connected")
      expect(store.state().sessions).toHaveLength(count)
      expect(store.state().sessions.at(-1)?.id).toBe("ses_6200")
      expect(fixture.requests.filter((request) => request.operation === "session.list")).toHaveLength(32)
      const initial = store.state().sessions
      fixture.drop()
      await waitFor(() => store.state().sessions !== initial || fixture.closed.length > 0, 25_000)
      expect(fixture.closed).toEqual([])
      expect(store.state().connection.kind).toBe("connected")
      expect(store.state().sessions.map((session) => session.id)).toEqual(initial.map((session) => session.id))
      expect(fixture.requests.every((request) => request.operation === "session.list" || request.operation === "session.active")).toBe(true)
    } finally {
      store.dispose()
      await fixture.server.stop(true)
    }
  }, 60_000)

  test("bounds delayed requests, cancels unsent mutations on a drop, and never replays them", async () => {
    const fixture = await harness(0)
    const transport = createRemoteTransport({
      url: `ws://127.0.0.1:${fixture.server.port}`,
      resetDelayMs: 10,
      random: () => 1,
    })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      for (let index = 0; index < RemoteLimits.maxClientRequestsPerWindow - 2; index += 1)
        expect((await transport.request("session.active")).status).toBe("ok")
      fixture.ping()
      await waitFor(() => fixture.pongs === 1)
      const sent = transport.request("session.interrupt", { sessionID: "ses_test" })
      await waitFor(() => fixture.requests.length === RemoteLimits.maxClientRequestsPerWindow - 1)
      let settled = 0
      const delayed = Array.from({ length: 31 }, () => transport.request("session.prompt", {
        sessionID: "ses_test",
        input: { text: "Never replay this prompt" },
        timeoutMs: 1,
      }).then((outcome) => {
        settled += 1
        return outcome
      }))
      expect(await transport.request("session.active")).toEqual({ status: "unavailable", reason: "in-flight-limit" })
      await Bun.sleep(20)
      expect(fixture.closed).toEqual([])
      expect(settled).toBe(0)
      expect(fixture.requests).toHaveLength(RemoteLimits.maxClientRequestsPerWindow - 1)
      fixture.drop()
      expect((await sent).status).toBe("unknown")
      expect(await Promise.all(delayed)).toEqual(Array.from({ length: 31 }, () => ({ status: "unavailable", reason: "not-connected" })))
      await waitFor(() => transport.status().kind === "open")
      expect((await transport.request("session.active")).status).toBe("ok")
      expect(fixture.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
      expect(fixture.closed).toEqual([])
    } finally {
      transport.close()
      await fixture.server.stop(true)
    }
  })
})
