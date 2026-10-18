import { describe, expect, test } from "bun:test"
import { WebLimits, type RelayRequestView } from "../src/remote/wire-views"
import { createAgentPeer, binaryData, binaryFrame, startAgent } from "./core-peer"
import { fixtureSession, fixtureSnapshot } from "./wire-peer"
import { createRelay } from "../../../infra/cloudflare/src/relay/core"
import { PublicEventSchema } from "@ycoding-ai/remote"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { loadWorkspaces } from "./remote-queries"
import { fixtureResult, waitFor } from "./relay-double"
import { createRemoteStoreClock } from "./remote-store-clock"
import { accountedTask } from "./usage-fixture"

async function harness(count: number, statusGate?: Promise<void>, residentMessages = 0) {
  const sockets = new Map<string, Bun.ServerWebSocket<{ id: string }>>()
  const closed: { code: number; reason: string }[] = []
  const requests: RelayRequestView[] = []
  let statusReads = 0
  let statusResponses = 0
  let clientPings = 0
  const gatedResponses: Promise<void>[] = []
  const eventSequences = new Map<string, number>()
  let clockSkew = 0
  const agent = createAgentPeer(
    () => performance.now() + clockSkew,
    (request, dispatch, peer) => {
      requests.push(request)
      if (request.operation === "session.interrupt") return
      const offset = Number(request.input?.cursor ?? 0)
      const limit = Number(request.input?.limit ?? WebLimits.maxSessionListPage)
      const data =
        request.operation === "session.status"
          ? { running: [], attention: [] }
          : request.operation === "catalog.get"
            ? { agents: [], models: [], commands: [], skills: [], references: [], resources: [] }
            : request.operation === "fs.find"
              ? { files: [{ path: "src/a.ts", uri: "file:///work/src/a.ts", kind: "file" }] }
              : request.operation === "workspace.list"
                ? [
                    { id: "wsp_even", projectID: "prj_even", directory: "/work/even" },
                    { id: "wsp_odd", projectID: "prj_odd", directory: "/work/odd" },
                  ]
                : request.operation === "session.list"
                  ? Array.from({ length: Math.min(limit, Math.ceil(count / 2) - offset) }, (_, index) => ({
                      ...fixtureSession(
                        `ses_${(offset + index) * 2 + (request.input?.workspace === "wsp_odd" ? 1 : 0)}`,
                      ),
                      title: `Session ${(offset + index) * 2}`,
                      time: { created: 1, updated: 1 },
                    }))
                  : {}
      const respond = () => {
        if (request.operation === "session.status") statusResponses += 1
        if (peer.cancelled.has(dispatch.requestID)) return
        const value =
          request.operation === "session.status" ||
          request.operation === "fs.find" ||
          request.operation === "catalog.get"
            ? data
            : {
                data,
                ...(request.operation === "session.list"
                  ? {
                      cursor: {
                        ...(offset > 0 ? { previous: String(Math.max(0, offset - limit)) } : {}),
                        ...(offset + limit < Math.ceil(count / 2) ? { next: String(offset + limit) } : {}),
                      },
                    }
                  : {}),
              }
        if (request.operation === "session.snapshot") {
          peer.result(
            dispatch,
            fixtureResult("session.snapshot", {
              ...fixtureSnapshot(request.sessionID!).data,
              sourceEpoch: peer.backendEpoch,
              watermark: {
                type: "log.synced",
                aggregateID: request.sessionID!,
                seq: eventSequences.get(request.sessionID!) ?? 0,
              },
              messages: Array.from({ length: residentMessages }, (_, index) => ({
                id: `msg_${index}`,
                type: "user",
                text: `Prompt ${index}`,
                files: [],
                agents: [],
                time: { created: index + 1, consumed: index + 2 },
              })),
            }),
          )
          return
        }
        if (request.operation === "session.promptCosts") {
          const ids = Array.isArray(request.input?.inputIDs) ? (request.input.inputIDs as string[]) : []
          peer.result(dispatch, {
            data: {
              units: ids.map((inputID) => ({
                anchor: { sessionID: request.sessionID!, inputID },
                ...accountedTask(request.sessionID!, 0.01, 10),
                helpers: [],
              })),
              unattributed: accountedTask().children,
              history: "retained",
            },
          })
          return
        }
        if (request.operation === "session.taskCosts") {
          peer.result(dispatch, { data: { tasks: [], total: accountedTask().children, history: "retained" } })
          return
        }
        if (request.operation === "event.subscribe") {
          peer.control({
            case: "resyncRequired",
            value: { scope: dispatch.request.scope!, sourceEpoch: peer.backendEpoch },
          })
          peer.result(dispatch, { subscription_id: `sub-${request.sessionID}-${crypto.randomUUID()}` })
          return
        }
        if (request.operation === "session.get") {
          peer.result(dispatch, { data: fixtureSession(request.sessionID!) })
          return
        }
        if (request.operation === "session.log") {
          const subscription = `log-${dispatch.requestID}`
          peer.result(dispatch, { subscription_id: subscription })
          peer.log(
            request.sessionID!,
            subscription,
            [],
            Math.max(
              typeof request.input?.after === "number" ? request.input.after : 0,
              eventSequences.get(request.sessionID!) ?? 0,
            ),
          )
          return
        }
        if (request.operation === "session.autonomy.get") {
          peer.result(dispatch, {
            data: {
              mode: "normal",
              yolo: 0,
              effective: {
                yolo: 0,
                asleep: false,
                guardrailsEnabled: true,
                ordinaryReviewsAuto: false,
                modelReviews: false,
                hardModelReviews: false,
              },
            },
          })
          return
        }
        if (request.operation === "session.guardrail.status") {
          peer.result(dispatch, {
            data: {
              rootSessionID: request.sessionID,
              profile: "standard",
              customRules: 0,
              approvals: 0,
              blocked: 0,
              counters: [],
              invalidFiles: [],
              decisions: [],
            },
          })
          return
        }
        if (request.operation === "session.subagent.list") {
          peer.result(dispatch, {
            data: { data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} },
          })
          return
        }
        if (request.operation === "session.team.shell.list") {
          peer.result(dispatch, { data: [], truncated: false })
          return
        }
        if (request.operation === "telemetry.consent.get") {
          peer.result(dispatch, { data: { noticeVersion: 1 } })
          return
        }
        if (request.operation === "session.form.list") {
          peer.result(dispatch, { data: [] })
          return
        }
        if (
          [
            "session.pending.list",
            "session.todo.list",
            "session.capturedChanges.list",
            "session.permission.list",
            "session.guardrail.request.list",
            "session.review.list",
          ].includes(request.operation)
        ) {
          peer.result(dispatch, { data: [] })
          return
        }
        if (request.operation === "session.compaction.list") {
          peer.result(dispatch, {
            data: { data: [], truncated: false, completedBefore: 0, completedCount: 0, totalSavedTokens: 0 },
          })
          return
        }
        peer.result(dispatch, fixtureResult(request.operation, value))
      }
      if (request.operation === "session.status" && statusGate && ++statusReads === 1)
        gatedResponses.push(statusGate.then(respond))
      else void respond()
    },
  )
  const deliveries: Promise<void>[] = []
  let agentDelivery = Promise.resolve()
  const relay = createRelay({
    now: Date.now,
    monotonic: () => performance.now(),
    newID: () => crypto.randomUUID(),
    send: (connectionID, raw) =>
      connectionID === "agent" ? agent.receive(raw.slice().buffer) : sockets.get(connectionID)?.send(raw),
    close: (connectionID, code, reason) => {
      if (connectionID === "agent" || sockets.has(connectionID)) closed.push({ code, reason })
      sockets.get(connectionID)?.close(code, reason)
    },
    loadOfflineCheck: async () => undefined,
    saveOfflineCheck: async () => undefined,
    notices: {
      append: () => ({ notices: [], total: 0 }),
      repeat: () => [],
      complete: () => ({ notices: [], total: 0 }),
      page: () => ({ notices: [], total: 0 }),
      remove: () => ({ ids: [], total: 0 }),
      clear: () => {},
      unavailable: () => false,
      markUnavailable: () => {},
    },
    authorizeClientCommand: async () => ({ ok: true, ownerID: "usr_test" }),
    authorizeAgentCommand: async () => ({ ok: true, ownerID: "usr_test" }),
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
  agent.message = (raw) => {
    agentDelivery = agentDelivery.then(() => relay.handleAgentMessage("agent", raw))
    deliveries.push(agentDelivery)
  }
  startAgent(agent)
  while (deliveries.length) await Promise.all(deliveries.splice(0))
  const server = Bun.serve<{ id: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/api/me")
        return Response.json({
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
        const frame = binaryFrame(raw)
        if (frame.body.case === "control" && frame.body.value.kind.case === "ping") clientPings += 1
        return relay.handleClientMessage(socket.data.id, binaryData(raw))
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
    diagnostics: () => ({
      agent: agent.connection.state,
      relayAgent: relay.agentConnected(),
      peers: sockets.size,
      closed: closed.slice(0, 8),
      closedCount: closed.length,
      requests: requests.slice(-40).map((request) => request.operation),
      requestCount: requests.length,
      failures: agent.failures.slice(0, 8).map((error) => error.message),
    }),
    get statusResponses() {
      return statusResponses
    },
    settleStatus: () => Promise.all(gatedResponses),
    get clientPings() {
      return clientPings
    },
    ping: () => relay.sweep(),
    drop: () => {
      for (const socket of sockets.values()) socket.close(1012, "Connection interrupted")
    },
    status: async (running: readonly string[], attention: readonly string[]) => {
      agent.control({ case: "status", value: { running: [...running], attention: [...attention] } })
      while (deliveries.length) await Promise.all(deliveries.splice(0))
    },
    invalidate: async () => {
      agent.control({ case: "inventoryInvalidated", value: {} })
      while (deliveries.length) await Promise.all(deliveries.splice(0))
    },
    flushEvents: async () => {
      clockSkew += 40
      agent.flush()
      while (deliveries.length) await Promise.all(deliveries.splice(0))
    },
    lastSequence: (sessionID: string) => eventSequences.get(sessionID) ?? 0,

    event: async (sessionID: string, event: Record<string, unknown>) => {
      const branch = PublicEventSchema.fields.find((field) => field.name === String(event.type).replaceAll(".", "_"))
      const durable = branch?.message?.fields.some((field) => field.name === "durable") === true
      const seq = (eventSequences.get(sessionID) ?? 0) + 1
      if (durable) eventSequences.set(sessionID, seq)
      agent.events(sessionID, [
        {
          id: crypto.randomUUID(),
          created: Date.now(),
          sourceEpoch: agent.backendEpoch,
          ...(durable ? { durable: { aggregateID: sessionID, seq, version: 1 } } : {}),
          ...event,
          data: { sessionID, ...(event.data as object) },
        },
      ])
      while (deliveries.length) await Promise.all(deliveries.splice(0))
    },
  }
}

function observedStore(fixture: Awaited<ReturnType<typeof harness>>) {
  const statuses: string[] = []
  const resyncs: string[] = []
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: `http://127.0.0.1:${fixture.server.port}` }),
    createTransport: (_deviceID, handlers) =>
      createRemoteTransport({
        url: `ws://127.0.0.1:${fixture.server.port}`,
        handlers: {
          ...handlers,
          onStatus: (status) => {
            statuses.push(status.kind)
            handlers.onStatus?.(status)
          },
          onResync: (sessionID) => {
            resyncs.push(sessionID)
            handlers.onResync?.(sessionID)
          },
        },
      }),
  })
  return { store, statuses, resyncs }
}

describe("remote request budget integration", () => {
  test("a pending status read does not hold the Session list, next page, or a newer inventory", async () => {
    const status = Promise.withResolvers<void>()
    const fixture = await harness(100, status.promise)
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: `http://127.0.0.1:${fixture.server.port}` }),
      createTransport: (_deviceID, handlers) =>
        createRemoteTransport({ url: `ws://127.0.0.1:${fixture.server.port}`, handlers }),
    })
    try {
      await store.load()
      await waitFor(() => store.state().sessionListStatus === "ready" && store.state().sessions.length === 25).catch(
        (cause: unknown) => {
          throw new Error(
            JSON.stringify({
              ...fixture.diagnostics(),
              transport: store.state().transport,
              connection: store.state().connection,
              list: store.state().sessionListStatus,
            }),
            { cause },
          )
        },
      )
      await store.nextSessionsPage()
      expect(store.state().sessions).toHaveLength(50)
      expect(await loadWorkspaces(store)).toHaveLength(2)
      await fixture.invalidate()
      await waitFor(() => fixture.requests.filter((request) => request.operation === "workspace.list").length >= 2, 500)
      await fixture.status([], [])
      await waitFor(() => store.state().carouselStatus === "ready", 500)
      status.resolve()
      expect(fixture.closed).toEqual([])
    } finally {
      status.resolve()
      await fixture.settleStatus()
      store.dispose()
      await fixture.server.stop(true)
    }
  }, 5_000)

  test("a failed status request leaves the small Session inventory and carousel readable", async () => {
    const fixture = await harness(10)
    const logged: unknown[][] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args)
    }
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: `http://127.0.0.1:${fixture.server.port}` }),
      createTransport: (_deviceID, handlers) => {
        const transport = createRemoteTransport({ url: `ws://127.0.0.1:${fixture.server.port}`, handlers })
        return {
          ...transport,
          request: (operation, input) =>
            operation === "session.status"
              ? Promise.reject(new Error("Synthetic status transport failure token=secret"))
              : transport.request(operation, input),
        }
      },
    })
    try {
      await store.load()
      await waitFor(() => store.state().sessions.length === 5 && store.state().carouselSessions?.length === 5)
      expect(store.state().sessionListStatus).toBe("ready")
      expect(store.state().carouselStatus).toBe("ready")
      expect(fixture.closed).toEqual([])
      expect(logged).toEqual([["Session status read failed"]])
    } finally {
      console.error = originalError
      store.dispose()
      await fixture.server.stop(true)
    }
  })

  test("a late status reply from the closed socket cannot reset the recovered carousel", async () => {
    const status = Promise.withResolvers<void>()
    const fixture = await harness(10, status.promise)
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: `http://127.0.0.1:${fixture.server.port}` }),
      createTransport: (_deviceID, handlers) =>
        createRemoteTransport({
          url: `ws://127.0.0.1:${fixture.server.port}`,
          handlers,
          resetDelayMs: 10,
          random: () => 0.5,
        }),
    })
    try {
      await store.load()
      await waitFor(
        () =>
          store.state().sessions.length === 5 &&
          fixture.requests.some((request) => request.operation === "session.status"),
      )
      fixture.drop()
      await waitFor(
        () =>
          fixture.requests.filter((request) => request.operation === "session.status").length === 2 &&
          store.state().carouselStatus === "ready" &&
          store.state().carouselSessions?.length === 5,
        5_000,
      )
      const carousel = store.state().carouselSessions
      status.resolve()
      await waitFor(() => fixture.statusResponses === 2)
      expect(store.state().carouselSessions).toEqual(carousel)
      expect(store.state().connection.kind).toBe("connected")
      expect(fixture.closed).toEqual([])
    } finally {
      status.resolve()
      await fixture.settleStatus()
      store.dispose()
      await fixture.server.stop(true)
    }
  }, 10_000)

  for (const selected of [false, true])
    test(`loads the small running and recent inventory promptly after reconnect${selected ? " with a selected Session" : ""}`, async () => {
      const fixture = await harness(10)
      const store = createRemoteStore({
        http: createRemoteHttp({ baseURL: `http://127.0.0.1:${fixture.server.port}` }),
        createTransport: (_deviceID, handlers) =>
          createRemoteTransport({
            url: `ws://127.0.0.1:${fixture.server.port}`,
            handlers,
            resetDelayMs: 10,
            random: () => 0.5,
          }),
      })
      try {
        await store.load()
        await waitFor(() => store.state().sessions.length === 5 && store.state().carouselSessions?.length === 5)
        if (selected) await store.selectSession("ses_0")
        fixture.drop()
        await waitFor(
          () =>
            fixture.requests.filter((request) => request.operation === "workspace.list").length >= 2 &&
            store.state().sessionListStatus === "ready" &&
            store.state().sessions.length === 5,
          5_000,
        )
        await waitFor(
          () => store.state().carouselStatus === "ready" && store.state().carouselSessions?.length === 5,
          1_000,
        )
        expect(fixture.closed).toEqual([])
        expect(store.state().connection.kind).toBe("connected")
        if (selected) expect(store.state().activeSessionID).toBe("ses_0")
      } catch (cause) {
        throw new Error(
          `Reconnect did not settle: ${JSON.stringify({ fixture: fixture.diagnostics(), transport: store.state().transport, connection: store.state().connection, sessionListStatus: store.state().sessionListStatus, carouselStatus: store.state().carouselStatus, sessions: store.state().sessions.length, carousel: store.state().carouselSessions?.length })}`,
          { cause },
        )
      } finally {
        store.dispose()
        await fixture.server.stop(true)
      }
    }, 10_000)

  test("keeps status, catalog, file reads, and inventory invalidation bursts inside the relay window", async () => {
    const fixture = await harness(200)
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: `http://127.0.0.1:${fixture.server.port}` }),
      createTransport: (_deviceID, handlers) =>
        createRemoteTransport({ url: `ws://127.0.0.1:${fixture.server.port}`, handlers }),
    })
    try {
      await store.load()
      await waitFor(() => store.state().sessions.length === 25, 25_000)
      await fixture.status(["ses_2"], ["ses_4"])
      await waitFor(() => store.state().sessionStatus?.running.has("ses_2") === true, 25_000)
      await Promise.all([
        store.loadCatalog({ sessionID: "ses_2" }),
        store.loadCatalog({ workspaceID: "wsp_even" }),
        store.findFiles({ sessionID: "ses_2" }, "a"),
        store.findFiles({ workspaceID: "wsp_even" }, "a"),
      ])
      for (let index = 0; index < 123; index += 1) await fixture.invalidate()
      fixture.ping()
      for (let index = 0; index < 121; index += 1)
        expect((await store.findFiles({ sessionID: "ses_2" }, `query-${index}`)).status).toBe("ok")
      await waitFor(
        () =>
          store.state().sessionListStatus === "ready" && store.state().catalogs["session:ses_2"]?.status === "ready",
        30_000,
      )
      expect(fixture.closed).toEqual([])
      expect(fixture.requests.length).toBeGreaterThan(WebLimits.maxClientRequestsPerWindow)
      expect(fixture.requests.filter((request) => request.operation === "session.status")).toHaveLength(1)
      expect(fixture.requests.filter((request) => request.operation === "catalog.get")).toHaveLength(2)
      expect(fixture.requests.filter((request) => request.operation === "fs.find")).toHaveLength(123)
      expect(store.state().connection.kind).toBe("connected")
    } finally {
      store.dispose()
      await fixture.server.stop(true)
    }
  }, 60_000)
  test("a Session log through the real relay settles on the snapshot's backend epoch without a client close or reconnect", async () => {
    const fixture = await harness(10, undefined, 1)
    const { store, statuses, resyncs } = observedStore(fixture)
    const operations = (name: string) =>
      fixture.requests.filter((request) => request.operation === name && request.sessionID === "ses_0")
    try {
      await store.load()
      await waitFor(() => store.state().sessions.length > 0, 25_000)
      await store.selectSession("ses_0")
      await waitFor(() => operations("session.log").length === 1, 25_000)
      await fixture.event("ses_0", { type: "session.execution.succeeded", data: {} })
      await fixture.flushEvents()
      await waitFor(() => {
        fixture.ping()
        return store.state().view?.watermark === 1
      }, 25_000)
      expect(resyncs).toEqual([])
      expect(statuses.filter((kind) => kind === "closed" || kind === "reconnecting")).toEqual([])
      expect(statuses.filter((kind) => kind === "connecting")).toHaveLength(1)
      expect(operations("event.subscribe")).toHaveLength(1)
      expect(operations("session.snapshot")).toHaveLength(1)
      expect(operations("session.log")).toHaveLength(1)
      expect(fixture.closed).toEqual([])
    } finally {
      store.dispose()
      await fixture.server.stop(true)
    }
  }, 60_000)

  test("continuous accounting events over a full resident page fetch no prompt costs and stay inside the relay window", async () => {
    const fixture = await harness(10, undefined, 100)
    const observed = observedStore(fixture)
    const store = observed.store
    const promptReads = () => fixture.requests.filter((request) => request.operation === "session.promptCosts")
    const accountingEvent = (index: number) => ({
      type: index % 20 === 19 ? "session.execution.succeeded" : "session.usage.updated",
      data:
        index % 20 === 19
          ? {}
          : { cost: 0.01, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    })
    const deliver = async (batch: number) => {
      for (let index = batch * 20; index < batch * 20 + 20; index += 1) await fixture.event("ses_0", accountingEvent(index))
      await fixture.flushEvents()
      await waitFor(() => {
        fixture.ping()
        return store.state().view?.watermark === fixture.lastSequence("ses_0")
      }, 25_000).catch(
        (cause: unknown) => {
          throw new Error(
            JSON.stringify({
              batch,
              watermark: store.state().view?.watermark,
              pushed: fixture.lastSequence("ses_0"),
              ...fixture.diagnostics(),
            }),
            { cause },
          )
        },
      )
    }
    const settled = () => {
      fixture.ping()
      return (
        store.state().view?.watermark === fixture.lastSequence("ses_0")
      )
    }
    try {
      await store.load()
      await waitFor(() => store.state().sessions.length > 0, 25_000)
      await store.selectSession("ses_0")
      expect(store.state().view?.messages).toHaveLength(100)
      expect(promptReads()).toHaveLength(0)
      for (let batch = 0; batch < 20; batch += 1) await deliver(batch)
      await waitFor(settled, 25_000)
      expect(promptReads()).toHaveLength(0)

      const admitted = fixture.requests.length
      const started = performance.now()
      let probe: ReturnType<typeof store.findFiles> | undefined
      for (let batch = 0; batch < 20; batch += 1) {
        await deliver(batch)
        if (batch === 10) probe = store.findFiles({ sessionID: "ses_0" }, "during-events")
      }
      expect((await probe!).status).toBe("ok")
      await waitFor(settled, 25_000)
      const windows = Math.ceil((performance.now() - started) / WebLimits.clientRateWindowMs)
      expect(fixture.requests.length - admitted).toBeLessThanOrEqual(
        (WebLimits.maxClientRequestsPerWindow - 3) * windows,
      )
      expect(promptReads()).toHaveLength(0)
      expect(fixture.closed).toEqual([])
      expect(observed.statuses.filter((kind) => kind === "closed" || kind === "reconnecting")).toEqual([])
      expect(observed.resyncs).toEqual([])
      expect(store.state().connection.kind).toBe("connected")
    } finally {
      store.dispose()
      await fixture.server.stop(true)
    }
  }, 60_000)

  test("loads a bounded first page of a large inventory and continues only on demand", async () => {
    const count = 14_501
    const fixture = await harness(count)
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: `http://127.0.0.1:${fixture.server.port}` }),
      createTransport: (_deviceID, handlers) =>
        createRemoteTransport({
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
      expect(
        fixture.requests.filter(
          (request) => request.operation === "session.list" && request.input?.workspace !== undefined,
        ),
      ).toHaveLength(1)
      expect(
        fixture.requests
          .filter((request) => request.operation === "session.list" && request.input?.workspace === undefined)
          .every((request) => typeof request.input?.limit === "number" && request.input.limit <= 10),
      ).toBe(true)
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
      expect(fixture.requests.filter((request) => request.operation === "telemetry.consent.get")).toHaveLength(2)
      expect(
        fixture.requests.every(
          (request) =>
            request.operation === "workspace.list" ||
            request.operation === "session.list" ||
            request.operation === "session.status" ||
            request.operation === "telemetry.consent.get",
        ),
      ).toBe(true)
    } finally {
      store.dispose()
      await fixture.server.stop(true)
    }
  }, 60_000)

  test("bounds delayed requests, cancels unsent mutations on a drop, and never replays them", async () => {
    const pacedBudget = WebLimits.maxClientRequestsPerWindow - 3
    const fixture = await harness(0)
    const transport = createRemoteTransport({
      url: `ws://127.0.0.1:${fixture.server.port}`,
      resetDelayMs: 10,
      random: () => 1,
      pingIntervalMs: 100,
    })
    try {
      transport.connect()
      await waitFor(() => transport.status().kind === "open")
      for (let index = 0; index < pacedBudget - 2; index += 1)
        expect((await transport.request("session.list")).status).toBe("ok")
      await waitFor(() => fixture.clientPings > 1)
      const sent = transport.request("session.interrupt", { sessionID: "ses_test" })
      await waitFor(() => fixture.requests.length === pacedBudget - 1)
      let settled = 0
      const delayed = Array.from({ length: 31 }, () =>
        transport
          .request("session.prompt", {
            sessionID: "ses_test",
            input: { text: "Never replay this prompt" },
            timeoutMs: 1,
          })
          .then((outcome) => {
            settled += 1
            return outcome
          }),
      )
      expect(await transport.request("session.list")).toEqual({ status: "unavailable", reason: "in-flight-limit" })
      await Bun.sleep(20)
      expect(fixture.closed).toEqual([])
      expect(settled).toBe(0)
      expect(fixture.requests).toHaveLength(pacedBudget - 1)
      fixture.drop()
      expect((await sent).status).toBe("unknown")
      expect(await Promise.all(delayed)).toEqual(
        Array.from({ length: 31 }, () => ({ status: "unavailable", reason: "not-connected" })),
      )
      await waitFor(() => transport.status().kind === "open")
      expect((await transport.request("session.list")).status).toBe("ok")
      expect(fixture.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
      expect(fixture.closed).toEqual([])
    } finally {
      transport.close()
      await fixture.server.stop(true)
    }
  })
})
