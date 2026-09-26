import {
  RemoteCloseCode,
  RemoteLimits,
  parseAgentMessage,
  parseChunkedValue,
  type RemoteError,
  type RemoteOperation,
  type RemoteRelayToClient,
} from "@ycoding-ai/remote"

export type RemoteRequestOutcome =
  | { readonly status: "ok"; readonly value: unknown }
  | { readonly status: "failed"; readonly error: RemoteError }
  | { readonly status: "unknown"; readonly error: RemoteError }
  | { readonly status: "unavailable"; readonly reason: "not-connected" | "in-flight-limit" | "request-limit" }

export type RemoteTransportStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "open" }
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "closed"; readonly code: number; readonly reason: string; readonly retryable: boolean }

export type RemoteTransportHandlers = {
  readonly onStatus?: (status: RemoteTransportStatus) => void
  readonly onSessions?: () => void
  readonly onEvent?: (sessionID: string, event: unknown) => void
  /** Called after a successful reconnect so read-only state can be reloaded. */
  readonly onReconnect?: () => void
}

export type RemoteTransportRequest = {
  readonly sessionID?: string
  readonly input?: Readonly<Record<string, unknown>>
  /** Overrides the default outcome timeout. Zero waits indefinitely. */
  readonly timeoutMs?: number
}

export type RemoteTransport = {
  readonly connect: () => void
  readonly close: (code?: number, reason?: string) => void
  readonly request: (operation: RemoteOperation, request?: RemoteTransportRequest) => Promise<RemoteRequestOutcome>
  readonly status: () => RemoteTransportStatus
}

export type RemoteTransportOptions = {
  readonly url: string
  readonly handlers?: RemoteTransportHandlers
  readonly createSocket?: (url: string) => WebSocket
  readonly schedule?: (callback: () => void, ms: number) => () => void
  readonly resetDelayMs?: number
  readonly maxDelayMs?: number
  readonly pingIntervalMs?: number
  readonly requestTimeoutMs?: number
  readonly maxInFlight?: number
  readonly random?: () => number
}

const defaultTimeoutMs = 30_000
const defaultMaxInFlight = 32

export function createRemoteTransport(options: RemoteTransportOptions): RemoteTransport {
  const handlers = options.handlers ?? {}
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url))
  const schedule = options.schedule ?? defaultSchedule
  const random = options.random ?? Math.random
  const resetDelayMs = options.resetDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 15_000
  const pingIntervalMs = options.pingIntervalMs ?? 30_000
  const requestTimeoutMs = options.requestTimeoutMs ?? defaultTimeoutMs
  const maxInFlight = options.maxInFlight ?? defaultMaxInFlight

  let current: RemoteTransportStatus = { kind: "idle" }
  let socket: WebSocket | undefined
  let attempt = 0
  let closedByUs = false
  let connectedOnce = false
  let cancelFlush: (() => void) | undefined
  let timer: (() => void) | undefined
  let cancelOutbound: (() => void) | undefined
  const outbound: { readonly frame: unknown; readonly onSend?: () => void }[] = []
  const sentAt: number[] = []

  const pending = new Map<
    string,
    { readonly resolve: (outcome: RemoteRequestOutcome) => void; cancel: () => void; sent: boolean; chunks?: Map<number, string> }
  >()
  let nextID = 0

  const publish = (status: RemoteTransportStatus) => {
    current = status
    handlers.onStatus?.(status)
  }

  const settlePending = (outcome: RemoteRequestOutcome) => {
    cancelOutbound?.()
    cancelOutbound = undefined
    outbound.length = 0
    for (const entry of pending.values()) {
      entry.cancel()
      entry.resolve(entry.sent ? outcome : { status: "unavailable", reason: "not-connected" })
    }
    pending.clear()
  }

  const releaseTimer = () => {
    timer?.()
    timer = undefined
  }

  const scheduleReconnect = () => {
    const delayMs = Math.min(maxDelayMs, resetDelayMs * 2 ** attempt)
    const jittered = Math.round(delayMs * (0.5 + random() / 2))
    attempt += 1
    publish({ kind: "reconnecting", attempt, delayMs: jittered })
    cancelFlush = schedule(() => {
      if (!closedByUs) connect()
    }, jittered)
  }

  const connect = () => {
    if (socket !== undefined && socket.readyState <= 1) return
    closedByUs = false
    cancelFlush?.()
    cancelFlush = undefined
    publish({ kind: "connecting", attempt })
    let next: WebSocket
    try {
      next = createSocket(options.url)
    } catch (cause) {
      publish({ kind: "closed", code: 0, reason: cause instanceof Error ? cause.message : "socket failed", retryable: true })
      scheduleReconnect()
      return
    }
    socket = next
    next.addEventListener("open", () => {
      const reconnected = connectedOnce
      connectedOnce = true
      attempt = 0
      sentAt.length = 0
      publish({ kind: "open" })
      if (reconnected) handlers.onReconnect?.()
      timer = schedule(() => send({ type: "ping" }), pingIntervalMs)
    })
    next.addEventListener("message", (message) => {
      releaseTimer()
      handleFrame(typeof message.data === "string" ? message.data : "")
      timer = schedule(() => send({ type: "ping" }), pingIntervalMs)
    })
    next.addEventListener("error", () => {
      const reason =
        next.readyState === next.CLOSED ? "The relay connection closed unexpectedly" : "The relay connection failed"
      publish({ kind: "closed", code: 0, reason, retryable: true })
    })
    next.addEventListener("close", (event) => {
      releaseTimer()
      socket = undefined
      // A dropped connection leaves in-flight mutations without a settlement.
      settlePending({
        status: "unknown",
        error: { code: "outcome_unknown", message: "The relay connection closed before this request settled" },
      })
      if (closedByUs) {
        publish({ kind: "closed", code: event.code, reason: event.reason, retryable: false })
        return
      }
      const retryable = event.code !== RemoteCloseCode.unauthorized && event.code !== RemoteCloseCode.forbidden
      const reason = closeReason(event.code, event.reason)
      publish({ kind: "closed", code: event.code, reason, retryable })
      if (retryable) scheduleReconnect()
    })
  }

  const flushOutbound = () => {
    cancelOutbound?.()
    cancelOutbound = undefined
    if (socket === undefined || socket.readyState !== 1) return
    const now = performance.now()
    while (sentAt[0] !== undefined && now - sentAt[0] >= RemoteLimits.clientRateWindowMs) sentAt.shift()
    while (outbound.length > 0 && sentAt.length < RemoteLimits.maxClientRequestsPerWindow) {
      const entry = outbound.shift()!
      entry.onSend?.()
      socket.send(JSON.stringify(entry.frame))
      sentAt.push(performance.now())
    }
    if (outbound.length > 0)
      cancelOutbound = schedule(
        flushOutbound,
        Math.max(1, Math.ceil(RemoteLimits.clientRateWindowMs - (performance.now() - sentAt[0]!))),
      )
  }

  const send = (frame: unknown, onSend?: () => void): boolean => {
    if (socket === undefined || socket.readyState !== 1) return false
    outbound.push({ frame, onSend })
    flushOutbound()
    return true
  }

  const handleFrame = (raw: string) => {
    if (raw.length === 0) return
    const parsed = parseAgentMessage(raw)
    if (!parsed.ok) {
      handlers.onStatus?.({ kind: "closed", code: parsed.error.code === "message_too_large" ? 1009 : 1003, reason: parsed.error.message, retryable: true })
      return
    }
    const frame = parsed.value
    if (frame.type === "ping") {
      send({ type: "pong" })
      return
    }
    if (frame.type === "pong") return
    if (frame.type === "sessions") {
      handlers.onSessions?.()
      return
    }
    if (frame.type === "event") {
      handlers.onEvent?.(frame.sessionID, frame.event)
      return
    }
    settle(frame)
  }

  const settle = (frame: Extract<RemoteRelayToClient, { type: "response" }>) => {
    const entry = pending.get(frame.id)
    if (!entry) return
    if (!frame.ok) {
      entry.cancel()
      pending.delete(frame.id)
      entry.resolve({ status: "failed", error: frame.error })
      return
    }
    if (frame.chunk === undefined) {
      entry.cancel()
      pending.delete(frame.id)
      entry.resolve({ status: "ok", value: frame.value })
      return
    }
    const chunks = entry.chunks ?? new Map<number, string>()
    if (typeof frame.value !== "string") {
      entry.cancel()
      pending.delete(frame.id)
      entry.resolve({ status: "failed", error: { code: "invalid_message", message: "Chunked response carried a non-string slice" } })
      return
    }
    // The shared parser bounds each frame and its chunk index; distinct map
    // entries therefore bound the whole response, not just one frame's size.
    chunks.set(frame.chunk.index, frame.value)
    if (!frame.chunk.last) {
      entry.chunks = chunks
      return
    }
    entry.cancel()
    pending.delete(frame.id)
    const ordered = [...chunks.entries()].sort((left, right) => left[0] - right[0])
    const contiguous = ordered.every(([index], position) => index === position)
    if (!contiguous) {
      entry.resolve({
        status: "failed",
        error: { code: "invalid_message", message: "Chunked response did not assemble into a complete value" },
      })
      return
    }
    const joined = parseChunkedValue(ordered.map(([, slice]) => slice))
    entry.resolve(joined.ok ? { status: "ok", value: joined.value } : { status: "failed", error: joined.error })
  }

  const request: RemoteTransport["request"] = (operation, input = {}) => {
    if (socket === undefined || socket.readyState !== 1) {
      return Promise.resolve({ status: "unavailable", reason: "not-connected" })
    }
    if (pending.size >= maxInFlight) {
      return Promise.resolve({ status: "unavailable", reason: "in-flight-limit" })
    }
    nextID += 1
    const id = `req_${nextID}_${Math.floor(random() * 1_000_000).toString(36)}`
    return new Promise<RemoteRequestOutcome>((resolve) => {
      const timeout = input.timeoutMs ?? requestTimeoutMs
      const entry = { resolve, cancel: () => {}, sent: false }
      pending.set(id, entry)
      const sent = send(
        {
          type: "request",
          id,
          operation,
          ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
          ...(input.input === undefined ? {} : { input: input.input }),
        },
        () => {
          entry.sent = true
          if (timeout > 0)
            entry.cancel = schedule(() => {
              if (!pending.delete(id)) return
              resolve({
                status: "unknown",
                error: { code: "outcome_unknown", message: "The request did not settle before the timeout" },
              })
            }, timeout)
        },
      )
      if (sent) return
      pending.delete(id)
      entry.cancel()
      resolve({ status: "unavailable", reason: "not-connected" })
    })
  }

  return {
    connect,
    close: (code = 1000, reason = "client closed") => {
      closedByUs = true
      cancelFlush?.()
      cancelFlush = undefined
      releaseTimer()
      const active = socket
      socket = undefined
      active?.close(code, reason)
      settlePending({
        status: "unknown",
        error: { code: "outcome_unknown", message: "The client closed the connection before this request settled" },
      })
      publish({ kind: "closed", code, reason, retryable: false })
    },
    request,
    status: () => current,
  }
}

function closeReason(code: number, reason: string): string {
  if (reason.length > 0) return reason
  if (code === RemoteCloseCode.unauthorized) return "Your session or device credential expired. Sign in again."
  if (code === RemoteCloseCode.forbidden) return "This account is not permitted to use that device."
  if (code === RemoteCloseCode.serviceRestart) return "A newer agent connection replaced this one."
  if (code === RemoteCloseCode.policyViolation) return "The relay closed the connection for a policy violation."
  if (code === RemoteCloseCode.tooLarge) return "A message exceeded the relay frame bound."
  if (code === 1006) return "The relay connection dropped."
  return `The relay connection closed with code ${code}.`
}

function defaultSchedule(callback: () => void, ms: number): () => void {
  const handle = setTimeout(callback, ms)
  return () => clearTimeout(handle)
}
