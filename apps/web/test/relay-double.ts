import {
  RemoteWebSocketPath,
  remotePayloadCodecs,
  PublicEventSchema,
  create,
  encodeStrict,
  encodeLossless,
  ScopeSchema,
  ControlSchema,
  ConnectorNoticePageSchema,
  ResultSchema,
  TypedPayloadSchema,
  NoticeCategory,
  AttentionNeed,
  type RemoteErrorCode,
  type Decision,
  type Notice,
} from "@ycoding-ai/remote"
import {
  WebLimits,
  type NoticeFrame,
  type NoticePageView,
  type NoticeRequestView,
  type RelayRequestView,
} from "../src/remote/wire-views"
import { BinarySocket, fixtureSession, requestView } from "./wire-peer"

export const pacedFlowTimeoutMs = WebLimits.clientRateWindowMs + 5_000

export type RelayHandlerOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly asset: { readonly data: Uint8Array; readonly mime: string } }
  | { readonly wire: (peer: BinarySocket, dispatch: Extract<Decision, { type: "dispatch" }>) => void }
  | { readonly ok: false; readonly code: RemoteErrorCode; readonly message: string }
  | "silent"
  | "close"
  /** Fall through to the double's built-in agent behavior for this operation. */
  | "default"

/** Handlers may return a promise so tests can gate a response deterministically. */
export type RelayHandlerResult = RelayHandlerOutcome | Promise<RelayHandlerOutcome>
export type RelayRequestHandler = (request: RelayRequestView) => RelayHandlerResult

type ConcreteResult = Exclude<RelayHandlerOutcome, "default">

export type RelayDoubleOptions = {
  readonly me?: unknown
  readonly meStatus?: number
  readonly devices?: unknown
  /** Raw body for `/api/devices`, used to assert the pinned shape is required. */
  readonly devicesRaw?: unknown
  readonly enrollmentStatus?: number
  readonly handler?: RelayRequestHandler
  readonly noticeError?: { readonly code: RemoteErrorCode; readonly message: string }
  readonly noticePage?: NoticePageView
  readonly noticeHandler?: (request: NoticeRequestView) => unknown | Promise<unknown>
  readonly advertisedSessions?: readonly string[]
  readonly messages?: Record<string, readonly unknown[]>
  readonly watermark?: number
  /** Active-session read payload: `{ data: Record<SessionID, { type: "running" }> }`. */
  readonly activeSessions?: Record<string, { readonly type: "running" }>
  /** Overrides the session projection returned for `session.snapshot`. */
  readonly snapshot?: (sessionID: string) => unknown
  readonly autonomy?: unknown
  readonly permissions?: readonly unknown[]
  readonly guardrailRequests?: readonly unknown[]
  readonly forms?: readonly unknown[]
  readonly usageProviders?: readonly unknown[]
  readonly usageSummary?: unknown
  readonly usageReport?: (input: Readonly<Record<string, unknown>> | undefined) => unknown
}

export type RelayDouble = {
  readonly httpURL: string
  readonly wsURL: (deviceID: string) => string
  readonly requests: RelayRequestView[]
  readonly noticeRequests: NoticeRequestView[]
  readonly pongs: number
  readonly connections: number
  readonly closeEvents: readonly { readonly code: number; readonly reason: string }[]
  readonly rejectedFrames: readonly string[]
  readonly createSocket: (url: string) => WebSocket
  readonly diagnostics: () => Promise<Readonly<Record<string, unknown>>>
  setMe: (value: unknown, status?: number) => void
  pushEvent: (sessionID: string, event: unknown) => void
  pushSessions: (sessionIDs: readonly string[]) => void
  pushResync: (sessionID: string) => void
  pushNotices: (frame: NoticeFrame) => void
  setNoticePage: (page: NoticePageView) => void
  setNoticeError: (error: { readonly code: RemoteErrorCode; readonly message: string } | undefined) => void
  pushStatus: (
    running: readonly string[],
    attention: readonly string[],
    outstanding?: readonly string[],
    failed?: readonly string[],
  ) => void
  dropConnections: (code: number, reason: string) => void
  stop: () => Promise<void>
}

/**
 * Fixture guard: `Model.Ref` is an object in `packages/schema`, so a fixture that
 * passes a plain string must fail loudly instead of silently exercising a shape
 * the runtime never sends.
 */
function requireModelRef(value: unknown, label: string): unknown {
  if (typeof value === "string") throw new Error(`${label}: model fixtures must use a Model.Ref object, not a string`)
  return value
}

const defaultSessionModel = { id: "gpt-5", providerID: "openai" } as const

const defaultMe = {
  user: { id: "user_1" },
  session: { expiresAt: 4_102_444_800_000 },
  devices: [{ id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active", online: true }],
}

export async function startRelayDouble(options: RelayDoubleOptions = {}): Promise<RelayDouble> {
  const requests: RelayRequestView[] = []
  const sequences = new Map<string, number>()
  const noticeRequests: NoticeRequestView[] = []
  let noticePage: NoticePageView = options.noticePage ?? { notices: [], total: 0, unavailable: false }
  let noticeError = options.noticeError
  let pongs = 0
  let connections = 0
  const closeEvents: { code: number; reason: string }[] = []
  const rejectedFrames: string[] = []
  let me: unknown = options.me ?? defaultMe
  let meStatus = options.meStatus ?? 200
  const sockets = new Set<BinarySocket>()
  const lifecycle: {
    readonly at: number
    readonly kind: string
    readonly path?: string
    readonly accepted?: boolean
    readonly code?: number
  }[] = []
  const record = (entry: Omit<(typeof lifecycle)[number], "at">) => {
    lifecycle.push({ at: performance.now(), ...entry })
    if (lifecycle.length > 16) lifecycle.shift()
  }
  let startupProbe: Promise<void> | undefined

  const listedSessions = () => [
    {
      id: "ses_a",
      title: "Alpha session",
      agent: "god",
      model: requireModelRef(defaultSessionModel, "session.list ses_a"),
      time: { created: 1, updated: 2 },
    },
    { id: "ses_b", title: "Beta session", time: { created: 1, updated: 1 } },
  ]

  const builtInHandler = (request: RelayRequestView): ConcreteResult => {
    if (request.operation === "event.subscribe") return { ok: true, value: { subscription_id: `sub-${request.id}` } }
    if (request.operation === "event.unsubscribe") return { ok: true, value: { data: {} } }
    if (request.operation === "workspace.list") {
      if (request.input?.sessionsOnly !== true) return { ok: true, value: { data: [] } }
      const data = [
        ...new Map(
          listedSessions().map((session) => {
            const item = session as { readonly projectID?: string; readonly location?: { readonly directory?: string } }
            const projectID = item.projectID ?? "prj_default"
            const directory = item.location?.directory ?? "/work"
            return [
              `${projectID}:${directory}`,
              { id: `wsp_${projectID}_${directory.replaceAll("/", "_")}`, projectID, directory },
            ] as const
          }),
        ).values(),
      ]
      return { ok: true, value: { data } }
    }
    if (request.operation === "session.list") {
      return { ok: true, value: { data: listedSessions() } }
    }
    if (request.operation === "session.status") return { ok: true, value: { running: [], attention: [] } }
    if (request.operation === "keepAwake.get") return { ok: true, value: { data: { state: "unsupported" } } }
    if (request.operation === "catalog.get")
      return {
        ok: true,
        value: {
          agents: [{ id: "god", name: "god", mode: "primary", hidden: false }],
          models: [{ providerID: "openai", providerName: "OpenAI", id: "gpt-5", name: "Fixture model", variants: [] }],
          defaultModel: { providerID: "openai", id: "gpt-5" },
          commands: [],
          skills: [],
          references: [],
          resources: [],
        },
      }
    if (request.operation === "telemetry.append") {
      if (!Array.isArray(request.input?.samples)) throw new Error("Missing telemetry samples")
      return { ok: true, value: { accepted: request.input.samples.length } }
    }
    if (request.operation === "session.get")
      return {
        ok: true,
        value: {
          data:
            listedSessions().find((session) => session.id === request.sessionID) ?? fixtureSession(request.sessionID!),
        },
      }
    if (["session.pending.list", "session.todo.list", "session.capturedChanges.list"].includes(request.operation))
      return { ok: true, value: { data: [] } }
    if (request.operation === "session.subagent.list")
      return { ok: true, value: { data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} } }
    if (request.operation === "session.team.shell.list") return { ok: true, value: { data: [], truncated: false } }
    if (request.operation === "session.team.economics") return { ok: true, value: { data: [] } }
    if (request.operation === "session.side-chat.list") return { ok: true, value: { data: [], cursor: {} } }
    if (request.operation === "session.compaction.list")
      return {
        ok: true,
        value: { data: [], truncated: false, completedBefore: 0, completedCount: 0, totalSavedTokens: 0 },
      }
    if (request.operation === "session.log") return { ok: true, value: { data: [] } }
    if (request.operation === "telemetry.consent.get")
      return {
        ok: true,
        value: { data: { noticeVersion: 1, consent: { enabled: true, noticeVersion: 1, decidedAt: 1 } } },
      }
    if (request.operation === "telemetry.consent.set")
      return { ok: true, value: { data: { enabled: request.input?.enabled === true, noticeVersion: 1, decidedAt: 1 } } }
    if (request.operation === "telemetry.append")
      return { ok: true, value: { accepted: Array.isArray(request.input?.samples) ? request.input.samples.length : 0 } }
    if (request.operation === "providerUsage.list")
      return {
        ok: true,
        value: {
          location: { directory: "/work", project: { id: "prj_default", directory: "/work" } },
          data: options.usageProviders ?? [
            {
              providerID: "openai",
              label: "Codex",
              status: "available",
              source: "provider_api",
              stability: "stable",
              updatedAt: 1000,
              windows: [{ id: "week", label: "Weekly", unit: "percent", used: 40, limit: 100 }],
            },
          ],
        },
      }
    if (request.operation === "usage.get")
      return {
        ok: true,
        value: {
          data: options.usageSummary ?? {
            logical: 1,
            physical: 1,
            helpers: 0,
            continued: 0,
            fallback: 0,
            cost: 0.02,
            tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
          },
        },
      }
    if (request.operation === "usage.report")
      return {
        ok: true,
        value: {
          data: options.usageReport?.(request.input) ?? {
            group: request.input?.group ?? "day",
            rows: [
              {
                key: "2026-09-27",
                label: "2026-09-27",
                logical: 1,
                physical: 1,
                helpers: 0,
                continued: 0,
                fallback: 0,
                cost: 0.02,
                costProvenance: "recorded",
                tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
              },
            ],
            total: {
              logical: 1,
              physical: 1,
              helpers: 0,
              continued: 0,
              fallback: 0,
              cost: 0.02,
              costProvenance: "recorded",
              tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
            },
            rowCount: 1,
          },
        },
      }
    if (request.operation === "session.messages") {
      return { ok: true, value: { data: options.messages?.[request.sessionID ?? ""] ?? [] } }
    }
    if (request.operation === "session.snapshot") {
      const sessionID = request.sessionID ?? ""
      if (options.snapshot !== undefined) return { ok: true, value: options.snapshot(sessionID) }
      const listed = listedSessions().find((entry) => entry.id === sessionID)
      return {
        ok: true,
        value: {
          sourceEpoch: "epoch_1",
          session: listed ?? { id: sessionID, title: sessionID, time: { created: 1, updated: 1 } },
          messages: options.messages?.[sessionID] ?? [],
          watermark: { type: "log.synced", aggregateID: sessionID, seq: options.watermark ?? 0 },
        },
      }
    }
    if (request.operation === "session.autonomy.get") {
      return { ok: true, value: { data: options.autonomy ?? { mode: "normal", yolo: 0 } } }
    }
    if (request.operation === "session.permission.list") {
      return { ok: true, value: { data: options.permissions ?? [] } }
    }
    if (request.operation === "session.guardrail.request.list") {
      return { ok: true, value: { data: options.guardrailRequests ?? [] } }
    }
    if (request.operation === "session.form.list") {
      return { ok: true, value: options.forms ?? [] }
    }
    if (request.operation === "session.prompt" || request.operation === "session.command") {
      return {
        ok: true,
        value: {
          data: {
            id: request.input?.id,
            admittedSeq: 1,
            timeCreated: 1,
            sessionID: request.sessionID,
            type: "user",
            delivery: request.input?.delivery ?? "steer",
            data: {
              text:
                request.operation === "session.command"
                  ? `/${request.input?.command}${request.input?.arguments ? ` ${request.input.arguments}` : ""}`
                  : request.input?.text,
              ...(request.input?.metadata === undefined ? {} : { metadata: request.input.metadata }),
            },
          },
        },
      }
    }
    if (request.operation === "session.autonomy.set") {
      const yolo = request.input?.yolo
      const goal = request.input?.goal
      return {
        ok: true,
        value: {
          data: {
            mode: "normal",
            yolo: typeof yolo === "number" ? yolo : 0,
            ...(typeof goal === "string"
              ? {
                  goal: {
                    text: goal,
                    status: "active",
                    iteration: 0,
                    noProgress: 0,
                    maxNoProgress: 3,
                  },
                }
              : {}),
          },
        },
      }
    }
    return { ok: true, value: null }
  }

  const handle = async (request: RelayRequestView): Promise<ConcreteResult> => {
    const selected = options.handler === undefined ? "default" : await options.handler(request)
    const result = selected === "default" ? builtInHandler(request) : selected
    if (
      request.operation === "session.snapshot" &&
      request.sessionID &&
      typeof result === "object" &&
      "ok" in result &&
      result.ok &&
      typeof result.value === "object" &&
      result.value !== null
    ) {
      const watermark = Reflect.get(result.value, "watermark")
      if (typeof watermark === "object" && watermark !== null && typeof Reflect.get(watermark, "seq") === "number")
        sequences.set(request.sessionID, Math.max(sequences.get(request.sessionID) ?? 0, Reflect.get(watermark, "seq")))
    }
    return result
  }
  const baseMe = (options.me ?? defaultMe) as { readonly devices?: unknown }

  const server = Bun.serve<{ deviceID: string; peer?: BinarySocket }>({
    port: 0,
    fetch(request, self) {
      const url = new URL(request.url)
      record({ kind: "http", path: url.pathname })
      if (url.pathname === RemoteWebSocketPath.client) {
        const deviceID = url.searchParams.get("device") ?? ""
        const accepted = self.upgrade(request, { data: { deviceID } })
        record({ kind: "upgrade", accepted })
        if (accepted) return undefined
        return new Response("upgrade failed", { status: 400 })
      }
      if (url.pathname === "/api/me") {
        return Response.json(me, { status: meStatus })
      }
      if (url.pathname === "/api/devices") {
        if (options.devicesRaw !== undefined) return Response.json(options.devicesRaw)
        return Response.json({ devices: options.devices ?? baseMe.devices ?? [] })
      }
      if (url.pathname === "/api/devices/enrollments") {
        return Response.json(
          options.enrollmentStatus === undefined
            ? { enrollmentID: "enr_1", code: "AAAA-BBBB-CCCC-DDDD-EEEE", expiresAt: 4_102_444_800_000 }
            : { error: { code: "forbidden", message: "cannot enroll" } },
          { status: options.enrollmentStatus ?? 200 },
        )
      }
      if (url.pathname.startsWith("/api/devices/") && url.pathname.endsWith("/revoke")) {
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/auth/logout") return new Response(null, { status: 204 })
      return Response.json({ error: { code: "forbidden", message: "unknown route" } }, { status: 404 })
    },
    websocket: {
      close(socket, code, reason) {
        record({ kind: "close", code })
        closeEvents.push({ code, reason })
        if (socket.data.peer) {
          sockets.delete(socket.data.peer)
          socket.data.peer.connection.close(5)
        }
      },
      open(socket) {
        record({ kind: "open" })
        connections += 1
        const peer = new BinarySocket(
          () => performance.now(),
          (request, dispatch) => {
            if (request.operation.startsWith("notice.")) {
              const operation = request.operation
              if (
                operation !== "notice.subscribe" &&
                operation !== "notice.list" &&
                operation !== "notice.read" &&
                operation !== "notice.readAll"
              )
                throw new Error("Invalid notice operation")
              const noticeRequest: NoticeRequestView = {
                id: request.id,
                operation,
                ...(request.input === undefined ? {} : { input: request.input as NoticeRequestView["input"] }),
              }
              noticeRequests.push(noticeRequest)
              if (noticeError) {
                respond(peer, dispatch, { ok: false, ...noticeError })
                return
              }
              void Promise.resolve(options.noticeHandler?.(noticeRequest)).then((answer) => {
                if (operation !== "notice.subscribe" && operation !== "notice.list") {
                  peer.result(dispatch, { data: {} })
                  return
                }
                peer.body({
                  case: "result",
                  value: create(ResultSchema, {
                    requestId: dispatch.requestID,
                    operationId: dispatch.operation.operationId,
                    settlement: dispatch.operation.settlement,
                    outcome: {
                      case: "success",
                      value: create(TypedPayloadSchema, {
                        typeName: ConnectorNoticePageSchema.typeName,
                        payload: encodeStrict(
                          ConnectorNoticePageSchema,
                          create(
                            ConnectorNoticePageSchema,
                            noticePageWire(answer === undefined ? noticePage : (answer as NoticePageView)),
                          ),
                        ),
                      }),
                    },
                  }),
                })
              })
              return
            }
            requests.push(request)
            void handle(request).then((result) => respond(peer, dispatch, result))
          },
          "epoch_1",
        )
        peer.message = (data) => {
          if (socket.readyState === 1) socket.send(data)
        }
        peer.close = (code, reason) => socket.close(code ?? 1000, reason ?? "")
        peer.open()
        socket.data.peer = peer
        sockets.add(peer)
      },
      message(socket, raw) {
        const peer = socket.data.peer!
        const before = peer.sent.length
        peer.receive(typeof raw === "string" ? raw : Uint8Array.from(raw).buffer)
        pongs += peer.sent
          .slice(before)
          .filter((frame) => frame.body.case === "control" && frame.body.value.kind.case === "pong").length
        if (peer.connection.state === "closed") {
          rejectedFrames.push("Invalid binary frame")
          socket.close(1002, "MALFORMED")
        }
      },
    },
  })

  const diagnostics = async () => {
    const snapshot = {
      listener: { hostname: server.hostname, port: server.port },
      connections,
      pendingWebSockets: server.pendingWebSockets,
      pendingRequests: server.pendingRequests,
      lifecycle: [...lifecycle],
      requests: requests.slice(-16).map((request) => request.operation),
      noticeRequests: noticeRequests.slice(-8).map((request) => request.operation),
      rejectedFrameCount: rejectedFrames.length,
    }
    const probes = await Promise.all(
      ["127.0.0.1", "[::1]"].map(async (host) => {
        const response = await fetch(`http://${host}:${server.port}/api/me`, {
          signal: AbortSignal.timeout(200),
        }).catch((cause: unknown) => cause)
        if (response instanceof Response) {
          await response.body?.cancel()
          return { host, status: response.status }
        }
        return { host, error: response instanceof Error ? response.message : String(response) }
      }),
    )
    return { ...snapshot, probes }
  }

  return {
    httpURL: `http://127.0.0.1:${server.port}`,
    wsURL: (deviceID: string) =>
      `ws://127.0.0.1:${server.port}${RemoteWebSocketPath.client}?device=${encodeURIComponent(deviceID)}`,
    requests,
    noticeRequests,
    diagnostics,
    createSocket: (url) => {
      const socket = new WebSocket(url)
      socket.addEventListener("error", (event) => {
        if (connections > 0 || startupProbe !== undefined) return
        const error = {
          message: String(Reflect.get(event, "message")),
          cause: String(Reflect.get(event, "error")),
          readyState: socket.readyState,
        }
        startupProbe = diagnostics().then((details) => {
          console.error(JSON.stringify({ diagnostic: "relay-startup", error, ...details }))
        })
      })
      return socket
    },
    get pongs() {
      return pongs
    },
    get connections() {
      return connections
    },
    get closeEvents() {
      return closeEvents
    },
    get rejectedFrames() {
      return rejectedFrames
    },
    setMe: (value, status = 200) => {
      me = value
      meStatus = status
    },
    pushEvent: (sessionID, event) => {
      const value = typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {}
      const data = typeof value.data === "object" && value.data !== null ? (value.data as Record<string, unknown>) : {}
      const type = value.type
      const branch =
        typeof type === "string"
          ? PublicEventSchema.fields.find((field) => field.name === type.replaceAll(".", "_"))
          : undefined
      const publicEvent = !branch?.message?.fields.some((field) => field.name === "durable")
      const sequence = sequences.get(sessionID) ?? options.watermark ?? 0
      const durable = value.durable ?? { aggregateID: sessionID, seq: sequence + 1, version: 1 }
      if (!publicEvent && typeof durable === "object" && durable !== null)
        sequences.set(sessionID, Number(Reflect.get(durable, "seq")))
      const defaults =
        value.type === "session.step.ended"
          ? { finish: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
          : {}
      for (const socket of sockets) {
        socket.events(sessionID, [
          {
            id: crypto.randomUUID(),
            created: Date.now(),
            sourceEpoch: "epoch_1",
            ...(!publicEvent ? { durable } : {}),
            ...value,
            data: { sessionID, ...defaults, ...data },
          },
        ])
        setTimeout(() => socket.flush(), 45)
      }
    },
    pushSessions: (_sessionIDs) => {
      for (const socket of sockets) socket.control({ case: "inventoryInvalidated", value: {} })
    },
    pushResync: (sessionID) => {
      for (const socket of sockets)
        socket.control({
          case: "resyncRequired",
          value: {
            scope: create(ScopeSchema, { target: { case: "session", value: sessionID } }),
            sourceEpoch: "epoch_1",
          },
        })
    },
    setNoticePage: (page) => {
      noticePage = page
    },
    setNoticeError: (error) => {
      noticeError = error
    },
    pushNotices: (frame) => {
      for (const socket of sockets) socket.control({ case: "notice", value: noticeWire(frame) })
    },
    pushStatus: (running, attention, outstanding, failed) => {
      for (const socket of sockets)
        socket.control({
          case: "status",
          value: {
            running: [...running],
            attention: [...attention],
            ...(outstanding === undefined ? {} : { outstanding: { items: [...outstanding] } }),
            ...(failed === undefined ? {} : { failed: { items: [...failed] } }),
          },
        })
    },
    dropConnections: (code, reason) => {
      for (const socket of sockets) socket.close(code, reason)
      sockets.clear()
    },
    stop: async () => {
      if (startupProbe !== undefined) await startupProbe
      sockets.clear()
      await server.stop(true)
    },
  }
}

export function fixtureResult(operation: string, value: unknown, sessionID?: string) {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  const info = (value: unknown) =>
    typeof value === "object" && value !== null
      ? { ...fixtureSession(String(Reflect.get(value, "id"))), ...value }
      : value
  const message = (value: unknown) =>
    typeof value === "object" && value !== null && Reflect.get(value, "type") === "assistant"
      ? { agent: "god", model: { providerID: "openai", id: "gpt-5" }, ...value }
      : value
  if (operation === "session.snapshot")
    return {
      data: {
        ...record,
        session: info(record?.session),
        messages: Array.isArray(record?.messages) ? record.messages.map(message) : record?.messages,
      },
    }
  if (operation === "session.list")
    return {
      data: { data: Array.isArray(record?.data) ? record.data.map(info) : record?.data, cursor: record?.cursor ?? {} },
    }
  if (operation === "session.get" || operation === "session.create" || operation === "session.side-chat.create")
    return { data: info(record?.data) }
  if (operation === "session.messages")
    return { data: { data: Array.isArray(record?.data) ? record.data.map(message) : record?.data } }
  if (operation === "session.message") return { data: message(value) }
  if (operation === "session.prompt" || operation === "session.command") {
    const pending =
      typeof record?.data === "object" && record.data !== null ? (record.data as Record<string, unknown>) : {}
    return {
      data: {
        timeCreated: 1,
        sessionID,
        type: "user",
        delivery: "steer",
        ...pending,
        data: pending.data ?? { text: pending.text ?? "" },
      },
    }
  }
  if (operation === "shell.output")
    return { location: { directory: "/work", project: { id: "prj_fixture", directory: "/work" } }, ...record }
  if (operation === "session.guardrail.request.list")
    return {
      data: Array.isArray(record?.data)
        ? record.data.map((review) => ({ ruleIDs: [], standard: true, ...review }))
        : record?.data,
    }
  if (
    operation === "catalog.get" ||
    operation === "session.form.list" ||
    operation === "session.compaction.list" ||
    operation === "session.subagent.list" ||
    operation === "telemetry.list"
  )
    return { data: value }
  if (operation === "fs.find")
    return {
      data: Array.isArray(record?.files) ? record.files.map((file) => ({ ...file, type: file.kind })) : record?.files,
    }
  if (operation === "session.promptGenerate" || operation === "session.prediction") return { data: { data: value } }
  if (
    value === null &&
    remotePayloadCodecs
      .get(operation)
      ?.result.schema.fields.some(
        (field) => field.name === "data" && field.fieldKind === "message" && field.message.name === "Empty",
      )
  )
    return { data: {} }
  return value
}

function respond(peer: BinarySocket, dispatch: Extract<Decision, { type: "dispatch" }>, result: ConcreteResult) {
  if (peer.readyState !== 1 || peer.cancelled.has(dispatch.requestID)) return
  if (result === "silent") return
  if (result === "close") {
    peer.close(1012, "EPOCH")
    return
  }
  if ("wire" in result) {
    result.wire(peer, dispatch)
    return
  }
  if ("asset" in result) {
    peer.asset(dispatch, result.asset.data, result.asset.mime)
    return
  }
  if (!result.ok) {
    const errors = remotePayloadCodecs.get(dispatch.operation.diagnosticName)!.errors
    if (errors.has("ycoding.v5.Connector_Error")) {
      peer.error(dispatch, "ycoding.v5.Connector_Error", { code: result.code, message: result.message })
      return
    }
    const tag =
      result.code === "unauthorized" || result.code === "forbidden"
        ? "UnauthorizedError"
        : result.code === "not_found" || result.code === "session_not_allowed"
          ? "SessionNotFoundError"
          : result.code === "invalid_message"
            ? "InvalidRequestError"
            : "UnknownError"
    if (!errors.has(`ycoding.v5.${tag}`)) {
      peer.close(1012, "EPOCH")
      return
    }
    peer.error(dispatch, `ycoding.v5.${tag}`, {
      _tag: tag,
      message: result.message,
      sessionID: dispatch.request.scope?.target.case === "session" ? dispatch.request.scope.target.value : undefined,
      kind: "payload",
      ref: "fixture",
    })
    return
  }
  try {
    if (dispatch.operation.diagnosticName === "session.log") {
      const request = requestView(dispatch)
      const events =
        typeof result.value === "object" && result.value !== null ? Reflect.get(result.value, "data") : undefined
      const subscription = `log-${dispatch.requestID}`
      peer.result(dispatch, { subscription_id: subscription })
      peer.log(
        request.sessionID!,
        subscription,
        Array.isArray(events) ? events : [],
        typeof request.input?.after === "number" ? request.input.after : 0,
      )
      return
    }
    peer.result(
      dispatch,
      fixtureResult(
        dispatch.operation.diagnosticName,
        result.value,
        dispatch.request.scope?.target.case === "session" ? dispatch.request.scope.target.value : undefined,
      ),
    )
  } catch (cause) {
    throw new Error(
      `Invalid fixture result for ${dispatch.operation.diagnosticName}: ${cause instanceof Error ? cause.message : "Encoding failed"}`,
      { cause },
    )
  }
}

function noticeRecord(notice: NoticePageView["notices"][number]) {
  return {
    id: notice.id,
    category:
      notice.category === "approval-requested" ? NoticeCategory.APPROVAL_REQUESTED : NoticeCategory.AGENT_COMPLETED,
    sessionId: notice.sessionID,
    createdMs: BigInt(notice.createdAt),
  }
}

function noticeWire(frame: NoticeFrame): Notice {
  if (frame.type === "notice.added")
    return {
      $typeName: "ycoding.v5.Notice",
      kind: {
        case: "added",
        value: {
          $typeName: "ycoding.v5.NoticesAdded",
          notices: frame.notices.map((notice) => ({ $typeName: "ycoding.v5.NoticeRecord", ...noticeRecord(notice) })),
          total: BigInt(frame.total),
        },
      },
    }
  if (frame.type === "notice.removed")
    return {
      $typeName: "ycoding.v5.Notice",
      kind: {
        case: "removed",
        value: { $typeName: "ycoding.v5.NoticesRemoved", ids: [...frame.ids], total: BigInt(frame.total) },
      },
    }
  if (frame.type === "notice.cleared")
    return { $typeName: "ycoding.v5.Notice", kind: { case: "cleared", value: { $typeName: "ycoding.v5.Empty" } } }
  if (frame.type === "notice.unavailable")
    return { $typeName: "ycoding.v5.Notice", kind: { case: "unavailable", value: { $typeName: "ycoding.v5.Empty" } } }
  if (frame.type === "notice.offline")
    return {
      $typeName: "ycoding.v5.Notice",
      kind: { case: "offline", value: { $typeName: "ycoding.v5.Offline", atMs: BigInt(frame.at) } },
    }
  return create(ControlSchema.fields.find((field) => field.name === "notice")!.message!, {
    kind: {
      case: "present",
      value: {
        items: frame.items.map((item) => {
          if (item.kind === "offline") return { kind: { case: "offline", value: { atMs: BigInt(item.at) } } }
          return {
            kind: {
              case: "notice",
              value: {
                notice: noticeRecord(item.notice),
                ...(item.detail === undefined
                  ? {}
                  : {
                      detail: {
                        ...(item.detail.title === undefined ? {} : { title: encodeLossless(item.detail.title) }),
                        ...(item.detail.repeat === undefined ? {} : { repeat: item.detail.repeat }),
                        ...(item.detail.need === undefined
                          ? {}
                          : {
                              need:
                                item.detail.need === "permission"
                                  ? AttentionNeed.PERMISSION
                                  : item.detail.need === "question"
                                    ? AttentionNeed.QUESTION
                                    : item.detail.need === "review"
                                      ? AttentionNeed.REVIEW
                                      : item.detail.need === "failed"
                                        ? AttentionNeed.FAILED
                                        : AttentionNeed.BLOCKED,
                            }),
                      },
                    }),
              },
            },
          }
        }),
      },
    },
  }) as Notice
}

function noticePageWire(page: NoticePageView) {
  return {
    notice: noticeWire({ type: "notice.added", notices: page.notices, total: page.total }),
    unavailable: page.unavailable,
    ...(page.next === undefined ? {} : { next: page.next }),
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out")
    await Bun.sleep(5)
  }
}
