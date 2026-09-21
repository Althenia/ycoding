import {
  parseClientMessage,
  serializeEvent,
  serializeResponse,
  serializeSessions,
  type RemoteErrorCode,
  type RemoteRequest,
} from "@ycoding-ai/remote"

export type RelayHandlerOutcome =
  | { readonly ok: true; readonly value: unknown; readonly chunks?: readonly { readonly index: number; readonly slice: string }[] }
  | { readonly ok: false; readonly code: RemoteErrorCode; readonly message: string }
  | "silent"
  | "close"
  /** Fall through to the double's built-in agent behavior for this operation. */
  | "default"

/** Handlers may return a promise so tests can gate a response deterministically. */
export type RelayHandlerResult = RelayHandlerOutcome | Promise<RelayHandlerOutcome>
export type RelayRequestHandler = (request: RemoteRequest) => RelayHandlerResult

type ConcreteResult = Exclude<RelayHandlerOutcome, "default">

export type RelayDoubleOptions = {
  readonly me?: unknown
  readonly meStatus?: number
  readonly devices?: unknown
  /** Raw body for `/api/devices`, used to assert the pinned shape is required. */
  readonly devicesRaw?: unknown
  readonly enrollmentStatus?: number
  readonly handler?: RelayRequestHandler
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
  readonly questions?: readonly unknown[]
}

export type RelayDouble = {
  readonly httpURL: string
  readonly wsURL: (deviceID: string) => string
  readonly requests: RemoteRequest[]
  readonly pongs: number
  readonly connections: number
  readonly closeEvents: readonly { readonly code: number; readonly reason: string }[]
  readonly rejectedFrames: readonly string[]
  setMe: (value: unknown, status?: number) => void
  pushEvent: (sessionID: string, event: unknown) => void
  pushSessions: (sessionIDs: readonly string[]) => void
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
  devices: [{ id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active" }],
}

export async function startRelayDouble(options: RelayDoubleOptions = {}): Promise<RelayDouble> {
  const requests: RemoteRequest[] = []
  let pongs = 0
  let connections = 0
  const closeEvents: { code: number; reason: string }[] = []
  const rejectedFrames: string[] = []
  let me: unknown = options.me ?? defaultMe
  let meStatus = options.meStatus ?? 200
  const sockets = new Set<{ send: (data: string) => void; close: (code?: number, reason?: string) => void }>()

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

  const builtInHandler = (request: RemoteRequest): ConcreteResult => {
      if (request.operation === "session.list") {
        return { ok: true, value: { data: listedSessions() } }
      }
      if (String(request.operation) === "session.active") {
        return { ok: true, value: { data: options.activeSessions ?? {} } }
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
      if (request.operation === "session.question.list") {
        return { ok: true, value: { data: options.questions ?? [] } }
      }
      if (request.operation === "session.fileChange.list") {
        return { ok: true, value: { data: [] } }
      }
      if (request.operation === "session.prompt") {
        return {
          ok: true,
          value: {
            data: {
              id: request.input?.id,
              admittedSeq: 1,
              sessionID: request.sessionID,
              type: "user",
              delivery: request.input?.delivery ?? "steer",
              data: { text: request.input?.text },
            },
          },
        }
      }
      if (request.operation === "session.goal.set" || request.operation === "session.goal.stop") {
        const text = typeof request.input?.goal === "string" ? request.input.goal : undefined
        return {
          ok: true,
          value: {
            data: {
              mode: "normal",
              yolo: 0,
              ...(text === undefined
                ? {}
                : { goal: { text, status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } }),
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

  const handle = async (request: RemoteRequest): Promise<ConcreteResult> => {
    if (options.handler === undefined) return builtInHandler(request)
    const result = await options.handler(request)
    return result === "default" ? builtInHandler(request) : result
  }
  const baseMe = (options.me ?? defaultMe) as { readonly devices?: unknown }

  const server = Bun.serve<{ deviceID: string }>({
    port: 0,
    fetch(request, self) {
      const url = new URL(request.url)
      if (url.pathname === "/ws/client") {
        const deviceID = url.searchParams.get("device") ?? ""
        if (self.upgrade(request, { data: { deviceID } })) return undefined
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
      close(_socket, code, reason) {
        closeEvents.push({ code, reason })
      },
      open(socket) {
        connections += 1
        sockets.add(socket as unknown as { send: (data: string) => void; close: () => void })
        socket.send(serializeSessions({ type: "sessions", sessionIDs: options.advertisedSessions ?? ["ses_a", "ses_b"] }))
      },
      message(socket, raw) {
        const text = typeof raw === "string" ? raw : raw.toString()
        const parsed = parseClientMessage(text)
        if (!parsed.ok) {
          rejectedFrames.push(text)
          socket.close(1003, "invalid frame")
          return
        }
        if (parsed.value.type === "pong") {
          pongs += 1
          return
        }
        if (parsed.value.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }))
          return
        }
        requests.push(parsed.value)
        const id = parsed.value.id
        const respond = (result: ConcreteResult) => {
          if (result === "silent") return
          if (result === "close") {
            socket.close(1012, "replaced by a newer agent connection")
            return
          }
          if (!result.ok) {
            socket.send(serializeResponse({ type: "response", id, ok: false, error: { code: result.code, message: result.message } }))
            return
          }
          if (result.chunks === undefined) {
            socket.send(serializeResponse({ type: "response", id, ok: true, value: result.value }))
            return
          }
          const chunks = result.chunks
          for (const [position, chunk] of chunks.entries()) {
            socket.send(
              serializeResponse({
                type: "response",
                id,
                ok: true,
                value: chunk.slice,
                chunk: { index: chunk.index, last: position === chunks.length - 1 },
              }),
            )
          }
        }
        void handle(parsed.value).then(respond)
      },
    },
  })

  return {
    httpURL: `http://127.0.0.1:${server.port}`,
    wsURL: (deviceID: string) => `ws://127.0.0.1:${server.port}/ws/client?device=${encodeURIComponent(deviceID)}`,
    requests,
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
      for (const socket of sockets) socket.send(serializeEvent({ type: "event", sessionID, event }))
    },
    pushSessions: (sessionIDs) => {
      for (const socket of sockets) socket.send(serializeSessions({ type: "sessions", sessionIDs }))
    },
    dropConnections: (code, reason) => {
      for (const socket of sockets) socket.close(code, reason)
      sockets.clear()
    },
    stop: async () => {
      sockets.clear()
      await server.stop(true)
    },
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out")
    await Bun.sleep(5)
  }
}
