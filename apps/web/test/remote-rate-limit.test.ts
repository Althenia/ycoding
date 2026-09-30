import { describe, expect, test } from "bun:test"
import { RemoteLimits, parseClientMessage, parseRelayToAgentMessage, serializeResponse, serializeSessions, serializeStatus, type RemoteRequest, type RemoteStatus } from "@ycoding-ai/remote"
import { createRelay } from "../../../infra/cloudflare/src/relay/core"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { waitFor } from "./relay-double"

async function harness(count: number) {
  const sockets = new Map<string, Bun.ServerWebSocket<{ id: string }>>()
  const closed: { code: number; reason: string }[] = []
  const requests: RemoteRequest[] = []
  let storedStatus: RemoteStatus | undefined
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
      const data = request.operation === "session.status"
        ? { running: [], attention: [] }
        : request.operation === "session.catalog" || request.operation === "workspace.catalog"
        ? { agents: [], models: [], commands: [], skills: [], references: [], resources: [] }
        : request.operation === "session.file.find" || request.operation === "workspace.file.find"
        ? { files: [{ path: "src/a.ts", uri: "file:///work/src/a.ts", kind: "file" }] }
        : request.operation === "workspace.list"
        ? [{ id: "wsp_even", projectID: "prj_even", directory: "/work/even" },
          { id: "wsp_odd", projectID: "prj_odd", directory: "/work/odd" }]
        : request.operation === "session.list"
        ? Array.from({ length: Math.min(limit, Math.ceil(count / 2) - offset) }, (_, index) => ({
            id: `ses_${(offset + index) * 2 + (request.input?.workspace === "wsp_odd" ? 1 : 0)}`,
            title: `Session ${(offset + index) * 2}`,
            time: { created: 1, updated: 1 },
          }))
        : {}
      void relay.handleAgentMessage("agent", serializeResponse({
        type: "response",
        id: request.id,
        ok: true,
        value: request.operation === "session.file.find" || request.operation === "workspace.file.find" || request.operation === "session.catalog" || request.operation === "workspace.catalog" ? data : {
          data,
          ...(request.operation === "session.list"
            ? { cursor: { ...(offset > 0 ? { previous: String(Math.max(0, offset - limit)) } : {}),
              ...(offset + limit < Math.ceil(count / 2) ? { next: String(offset + limit) } : {}) } }
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
    loadStatus: async () => storedStatus,
    saveStatus: async (status) => { storedStatus = status },
    loadOfflineCheck: async () => undefined,
    saveOfflineCheck: async () => undefined,
    notices: { append: () => ({ notices: [], total: 0 }), complete: () => ({ notices: [], total: 0 }), page: () => ({ notices: [], total: 0 }), remove: () => ({ ids: [], total: 0 }), clear: () => {}, unavailable: () => false, markUnavailable: () => {} },
    saveNoticeSubscription: () => {},
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
    noticesSubscribed: false,
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
    status: (running: readonly string[], attention: readonly string[]) => relay.handleAgentMessage("agent", serializeStatus({ type: "status", running, attention })),
    invalidate: () => relay.handleAgentMessage("agent", serializeSessions({ type: "sessions" })),
  }
}

describe("remote request budget integration", () => {
  test("keeps status, catalog, file reads, and inventory invalidation bursts inside the relay window", async () => {
    const fixture = await harness(200)
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: `http://127.0.0.1:${fixture.server.port}` }),
      createTransport: (_deviceID, handlers) => createRemoteTransport({ url: `ws://127.0.0.1:${fixture.server.port}`, handlers }),
    })
    try {
      await store.load()
      await waitFor(() => store.state().sessions.length === 25, 25_000)
      await fixture.status(["ses_2"], ["ses_4"])
      await waitFor(() => store.state().sessionStatus?.running.has("ses_2") === true, 25_000)
      await Promise.all([
        store.loadCatalog({ sessionID: "ses_2" }), store.loadCatalog({ workspaceID: "wsp_even" }),
        store.findFiles({ sessionID: "ses_2" }, "a"), store.findFiles({ workspaceID: "wsp_even" }, "a"),
      ])
      for (let index = 0; index < 33; index += 1) await fixture.invalidate()
      fixture.ping()
      for (let index = 0; index < 31; index += 1)
        expect((await store.findFiles({ sessionID: "ses_2" }, `query-${index}`)).status).toBe("ok")
      await waitFor(() => store.state().sessionListStatus === "ready" && store.state().catalogs["session:ses_2"]?.status === "ready", 30_000)
      expect(fixture.closed).toEqual([])
      expect(fixture.requests.length).toBeGreaterThan(RemoteLimits.maxClientRequestsPerWindow)
      expect(fixture.requests.filter((request) => request.operation === "session.status")).toHaveLength(1)
      expect(fixture.requests.filter((request) => request.operation === "session.catalog" || request.operation === "workspace.catalog")).toHaveLength(2)
      expect(fixture.requests.filter((request) => request.operation === "session.file.find" || request.operation === "workspace.file.find")).toHaveLength(33)
      expect(store.state().connection.kind).toBe("connected")
    } finally { store.dispose(); await fixture.server.stop(true) }
  }, 60_000)
  test("loads a bounded first page of a large inventory and continues only on demand", async () => {
    const count = 14_501
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
      await waitFor(() => store.state().sessions.length === 25 || fixture.closed.length > 0, 25_000)
      expect(fixture.closed).toEqual([])
      expect(store.state().connection.kind).toBe("connected")
      expect(store.state().sessions).toHaveLength(25)
      expect(store.state().sessions.map((session) => session.id)).toContain("ses_0")
      expect(store.state().sessions.map((session) => session.id)).toContain("ses_48")
      expect(fixture.requests.filter((request) => request.operation === "session.list" && request.input?.workspace !== undefined)).toHaveLength(1)
      expect(fixture.requests.filter((request) => request.operation === "session.list" && request.input?.workspace === undefined)
        .every((request) => typeof request.input?.limit === "number" && request.input.limit <= 10)).toBe(true)
      expect(store.state().sessionHasNext).toBe(true)
      await store.nextSessionsPage()
      expect(store.state().sessions).toHaveLength(50)
      for (let index = 0; index < 3; index += 1) await store.nextSessionsPage()
      expect(store.state().sessions).toHaveLength(75)
      expect(store.state().sessions.map((session) => session.id)).toContain("ses_248")
      expect(store.state().sessions.map((session) => session.id)).not.toContain("ses_0")
      await store.previousSessionsPage()
      expect(store.state().sessions.map((session) => session.id)).toContain("ses_50")
      expect(store.state().sessions.map((session) => session.id)).not.toContain("ses_248")
      expect(store.state().sessions).toHaveLength(75)
      store.selectWorkspace("wsp_odd")
      await waitFor(() => store.state().sessions[0]?.id === "ses_1")
      expect(store.state().sessions).toHaveLength(25)
      const initial = store.state().sessions
      fixture.drop()
      await waitFor(() => store.state().sessions !== initial || fixture.closed.length > 0, 25_000)
      expect(fixture.closed).toEqual([])
      expect(store.state().connection.kind).toBe("connected")
      expect(store.state().sessions.map((session) => session.id)).toEqual(initial.map((session) => session.id))
      expect(fixture.requests.every((request) => request.operation === "workspace.list" || request.operation === "session.list" || request.operation === "session.status")).toBe(true)
    } finally {
      store.dispose()
      await fixture.server.stop(true)
    }
  }, 60_000)

  test("bounds delayed requests, cancels unsent mutations on a drop, and never replays them", async () => {
    const pacedBudget = 27
    const fixture = await harness(0)
    const transport = createRemoteTransport({
      url: `ws://127.0.0.1:${fixture.server.port}`,
      resetDelayMs: 10,
      random: () => 1,
    })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      for (let index = 0; index < pacedBudget - 2; index += 1)
        expect((await transport.request("session.active")).status).toBe("ok")
      fixture.ping()
      await waitFor(() => fixture.pongs === 1)
      const sent = transport.request("session.interrupt", { sessionID: "ses_test" })
      await waitFor(() => fixture.requests.length === pacedBudget - 1)
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
      expect(fixture.requests).toHaveLength(pacedBudget - 1)
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
