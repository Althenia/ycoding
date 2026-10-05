import {
  RemoteCloseCode,
  RemoteLimits,
  parseChunkedValue,
  parseRelayToClientMessage,
  type RemoteError,
  type RemoteNoticeFrame,
  type RemoteNoticeOperation,
  type RemoteOperation,
  type RemotePriorityHint,
  type RemoteRelayToClient,
} from "@ycoding-ai/remote"

export type RemoteRequestOutcome =
  | { readonly status: "ok"; readonly value: unknown }
  | { readonly status: "failed"; readonly error: RemoteError }
  | { readonly status: "unknown"; readonly error: RemoteError }
  | { readonly status: "unavailable"; readonly reason: "not-connected" | "in-flight-limit" | "request-limit" | "cancelled" }

export type RemoteTransportStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "open"; readonly rttMs?: number }
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "closed"; readonly code: number; readonly reason: string; readonly retryable: boolean }

export type RemoteRequestTiming = {
  readonly operation: RemoteOperation | RemoteNoticeOperation
  readonly outcome: RemoteRequestOutcome["status"]
  readonly reason?: Extract<RemoteRequestOutcome, { status: "unavailable" }>["reason"]
  readonly queueMs: number
  readonly settlementMs?: number
  readonly totalMs: number
}

export type RemoteTransportHandlers = {
  readonly onStatus?: (status: RemoteTransportStatus) => void
  readonly onSessions?: () => void
  readonly onSessionStatus?: (status: { readonly running: readonly string[]; readonly attention: readonly string[]; readonly outstanding?: readonly string[]; readonly failed?: readonly string[] }) => void
  readonly onEvents?: (sessionID: string, events: readonly unknown[]) => void
  readonly onNotices?: (frame: RemoteNoticeFrame) => void
  readonly onRequestTiming?: (timing: RemoteRequestTiming) => void
  /** Called after a successful reconnect so read-only state can be reloaded. */
  readonly onReconnect?: () => void
}

export type RemoteTransportRequest = {
  readonly sessionID?: string
  readonly input?: Readonly<Record<string, unknown>>
  /** Overrides the default outcome timeout. Zero waits indefinitely. */
  readonly timeoutMs?: number
  /** Aborting settles the request as cancelled and asks the relay to drop it. */
  readonly signal?: AbortSignal
}

export type RemoteTransport = {
  readonly connect: () => void
  readonly close: (code?: number, reason?: string) => void
  readonly request: (operation: RemoteOperation | RemoteNoticeOperation, request?: RemoteTransportRequest) => Promise<RemoteRequestOutcome>
  readonly status: () => RemoteTransportStatus
  readonly setPriority: (mode: RemotePriorityHint["mode"]) => void
}

export type RemoteTransportOptions = {
  readonly url: string
  readonly handlers?: RemoteTransportHandlers
  readonly createSocket?: (url: string) => WebSocket
  readonly schedule?: (callback: () => void, ms: number) => () => void
  readonly resetDelayMs?: number
  readonly maxDelayMs?: number
  readonly pingIntervalMs?: number
  readonly pongTimeoutMs?: number
  readonly document?: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">
  readonly window?: Pick<Window, "addEventListener" | "removeEventListener">
  readonly requestTimeoutMs?: number
  readonly maxInFlight?: number
  readonly random?: () => number
  readonly now?: () => number
}

const defaultTimeoutMs = 30_000
const defaultMaxInFlight = 32

export function clientFrameDelay(sentAt: number[], now: number): number {
  while (sentAt[0] !== undefined && now - sentAt[0] >= RemoteLimits.clientRateWindowMs) sentAt.shift()
  return sentAt.length < RemoteLimits.maxClientRequestsPerWindow - 3
    ? 0 : Math.max(1, Math.ceil(RemoteLimits.clientRateWindowMs - (now - sentAt[0]!)))
}

export function createRemoteTransport(options: RemoteTransportOptions): RemoteTransport {
  const handlers = options.handlers ?? {}
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url))
  const schedule = options.schedule ?? defaultSchedule
  const random = options.random ?? Math.random
  const now = options.now ?? (() => performance.now())
  const resetDelayMs = options.resetDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 15_000
  const pingIntervalMs = options.pingIntervalMs ?? 30_000
  const pongTimeoutMs = options.pongTimeoutMs ?? 10_000
  const visibility = options.document ?? (typeof document === "undefined" ? undefined : document)
  const network = options.window ?? (typeof window === "undefined" ? undefined : window)
  const requestTimeoutMs = options.requestTimeoutMs ?? defaultTimeoutMs
  const maxInFlight = options.maxInFlight ?? defaultMaxInFlight

  let current: RemoteTransportStatus = { kind: "idle" }
  let socket: WebSocket | undefined
  let attempt = 0
  let closedByUs = false
  let connectedOnce = false
  let cancelFlush: (() => void) | undefined
  let timer: (() => void) | undefined
  let probing = false
  let probeID = 0
  let listening = false
  let removeSocketListeners: (() => void) | undefined
  let cancelOutbound: (() => void) | undefined
  const outbound: { readonly frame: unknown; readonly requestID?: string; readonly onSend?: () => void }[] = []
  const sentAt: number[] = []

  const pending = new Map<
    string,
    { readonly resolve: (outcome: RemoteRequestOutcome) => void; cancel: () => void; sent: boolean; chunks?: Map<number, string> }
  >()
  let nextID = 0
  let wantedPriority: RemotePriorityHint["mode"] = visibility?.hidden ? "background" : "interactive"
  let sentPriority: RemotePriorityHint["mode"] = "interactive"
  let pingSentAt: number | undefined
  let roundTripMs: number | undefined

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
    probing = false
    probeID += 1
  }

  const stopListening = () => {
    visibility?.removeEventListener("visibilitychange", followVisibility)
    visibility?.removeEventListener("visibilitychange", resume)
    network?.removeEventListener("online", resume)
    listening = false
  }

  const setPriority = (mode: RemotePriorityHint["mode"]) => {
    wantedPriority = mode
    if (mode === sentPriority) return
    if (send({ type: "priority", mode })) sentPriority = mode
  }

  const followVisibility = () => setPriority(visibility?.hidden ? "background" : "interactive")

  const resume = () => {
    if (closedByUs) return
    if (visibility?.hidden) { releaseTimer(); return }
    if (socket?.readyState === 1) probeSocket(socket)
    if (socket === undefined && current.kind === "reconnecting") connect()
  }

  const resetLiveness = (owner: WebSocket) => {
    releaseTimer()
    if (visibility?.hidden) return
    timer = schedule(() => {
      if (socket === owner && !closedByUs && !visibility?.hidden) probeSocket(owner)
    }, pingIntervalMs)
  }

  const probeSocket = (owner: WebSocket) => {
    if (probing || socket !== owner || closedByUs || visibility?.hidden) return
    releaseTimer()
    probing = true
    const id = probeID
    send({ type: "ping" }, () => {
      pingSentAt = now()
      if (socket !== owner || id !== probeID || !probing || visibility?.hidden) return
      timer = schedule(() => {
        if (socket !== owner || id !== probeID || !probing || visibility?.hidden) return
        endSocket(owner, 4000, "Relay heartbeat timed out")
        owner.close(4000, "Relay heartbeat timed out")
      }, pongTimeoutMs)
    })
  }

  const endSocket = (owner: WebSocket, code: number, reason: string) => {
    if (socket !== owner) return
    releaseTimer()
    removeSocketListeners?.()
    removeSocketListeners = undefined
    socket = undefined
    settlePending({
      status: "unknown",
      error: { code: "outcome_unknown", message: "The relay connection closed before this request settled" },
    })
    const retryable = !closedByUs && code !== RemoteCloseCode.unauthorized && code !== RemoteCloseCode.forbidden
    if (!retryable) stopListening()
    publish({ kind: "closed", code, reason: closeReason(code, reason), retryable })
    if (retryable) scheduleReconnect()
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
    if (!listening) {
      visibility?.addEventListener("visibilitychange", followVisibility)
      visibility?.addEventListener("visibilitychange", resume)
      network?.addEventListener("online", resume)
      listening = true
    }
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
    const opened = () => {
      if (socket !== next || closedByUs) return
      const reconnected = connectedOnce
      connectedOnce = true
      attempt = 0
      sentAt.length = 0
      pingSentAt = undefined
      roundTripMs = undefined
      sentPriority = "interactive"
      publish({ kind: "open" })
      setPriority(wantedPriority)
      if (reconnected) handlers.onReconnect?.()
      resetLiveness(next)
    }
    const received = (message: MessageEvent) => {
      if (socket !== next || closedByUs) return
      resetLiveness(next)
      if (pingSentAt !== undefined && current.kind === "open") {
        const sample = now() - pingSentAt
        pingSentAt = undefined
        roundTripMs = roundTripMs === undefined ? sample : 0.3 * sample + 0.7 * roundTripMs
        publish({ kind: "open", rttMs: Math.round(roundTripMs) })
      }
      handleFrame(typeof message.data === "string" ? message.data : "")
    }
    const errored = () => {
      if (socket !== next || closedByUs) return
      const reason =
        next.readyState === next.CLOSED ? "The relay connection closed unexpectedly" : "The relay connection failed"
      publish({ kind: "closed", code: 0, reason, retryable: true })
    }
    const closed = (event: CloseEvent) => endSocket(next, event.code, event.reason)
    next.addEventListener("open", opened)
    next.addEventListener("message", received)
    next.addEventListener("error", errored)
    next.addEventListener("close", closed)
    removeSocketListeners = () => {
      next.removeEventListener("open", opened)
      next.removeEventListener("message", received)
      next.removeEventListener("error", errored)
      next.removeEventListener("close", closed)
    }
  }

  const flushOutbound = () => {
    cancelOutbound?.()
    cancelOutbound = undefined
    if (socket === undefined || socket.readyState !== 1) return
    while (outbound.length > 0 && clientFrameDelay(sentAt, now()) === 0) {
      const entry = outbound.shift()!
      entry.onSend?.()
      socket.send(JSON.stringify(entry.frame))
      sentAt.push(now())
    }
    if (outbound.length > 0)
      cancelOutbound = schedule(flushOutbound, clientFrameDelay(sentAt, now()))
  }

  const send = (frame: unknown, onSend?: () => void, requestID?: string): boolean => {
    if (socket === undefined || socket.readyState !== 1) return false
    outbound.push({ frame, requestID, onSend })
    flushOutbound()
    return true
  }

  const handleFrame = (raw: string) => {
    if (raw.length === 0) return
    const parsed = parseRelayToClientMessage(raw)
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
    if (frame.type === "status") {
      handlers.onSessionStatus?.(frame)
      return
    }
    if (frame.type === "event") {
      handlers.onEvents?.(frame.sessionID, [frame.event])
      return
    }
    if (frame.type === "events") {
      handlers.onEvents?.(frame.sessionID, frame.events)
      return
    }
    if (frame.type === "notice.added" || frame.type === "notice.removed" || frame.type === "notice.cleared" || frame.type === "notice.unavailable" || frame.type === "notice.offline" || frame.type === "notice.present") {
      handlers.onNotices?.(frame)
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

  let timingWarningReported = false
  const reportTiming = (timing: RemoteRequestTiming) => {
    try {
      handlers.onRequestTiming?.(timing)
    } catch {
      if (timingWarningReported) return
      timingWarningReported = true
      console.warn("Web latency diagnostics observer failed.")
    }
  }

  const request: RemoteTransport["request"] = (operation, input = {}) => {
    if (input.signal?.aborted) return unavailableRequest(operation, "cancelled")
    if (socket === undefined || socket.readyState !== 1) {
      return unavailableRequest(operation, "not-connected")
    }
    if (pending.size >= maxInFlight) {
      return unavailableRequest(operation, "in-flight-limit")
    }
    const startedAt = now()
    nextID += 1
    const id = `req_${nextID}_${Math.floor(random() * 1_000_000).toString(36)}`
    return new Promise<RemoteRequestOutcome>((settled) => {
      const timeout = input.timeoutMs ?? requestTimeoutMs
      let transmittedAt: number | undefined
      let recorded = false
      const resolve = (outcome: RemoteRequestOutcome) => {
        if (recorded) return
        recorded = true
        input.signal?.removeEventListener("abort", abort)
        const finishedAt = now()
        const totalMs = Math.max(0, Math.round(finishedAt - startedAt))
        const queueMs = Math.min(totalMs, Math.max(0, Math.round((transmittedAt ?? finishedAt) - startedAt)))
        settled(outcome)
        reportTiming({ operation, outcome: outcome.status,
          ...(outcome.status === "unavailable" ? { reason: outcome.reason } : {}),
          queueMs,
          ...(transmittedAt === undefined ? {} : { settlementMs: Math.max(0, totalMs - queueMs) }), totalMs })
      }
      const entry = { resolve, cancel: () => {}, sent: false }
      const abort = () => {
        if (!pending.delete(id)) return
        entry.cancel()
        const queued = outbound.findIndex((item) => item.requestID === id)
        if (queued >= 0) outbound.splice(queued, 1)
        if (entry.sent) send({ type: "cancel", id })
        resolve({ status: "unavailable", reason: "cancelled" })
      }
      input.signal?.addEventListener("abort", abort, { once: true })
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
          transmittedAt = now()
          if (timeout > 0)
            entry.cancel = schedule(() => {
              if (!pending.delete(id)) return
              resolve({
                status: "unknown",
                error: { code: "outcome_unknown", message: "The request did not settle before the timeout" },
              })
            }, timeout)
        },
        id,
      )
      if (sent) return
      pending.delete(id)
      entry.cancel()
      resolve({ status: "unavailable", reason: "not-connected" })
    })
  }

  const unavailableRequest = (operation: RemoteOperation | RemoteNoticeOperation, reason: Extract<RemoteRequestOutcome, { status: "unavailable" }>["reason"]) => {
    reportTiming({ operation, outcome: "unavailable", reason, queueMs: 0, totalMs: 0 })
    return Promise.resolve({ status: "unavailable" as const, reason })
  }

  return {
    connect,
    close: (code = 1000, reason = "client closed") => {
      closedByUs = true
      cancelFlush?.()
      cancelFlush = undefined
      releaseTimer()
      stopListening()
      removeSocketListeners?.()
      removeSocketListeners = undefined
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
    setPriority,
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
