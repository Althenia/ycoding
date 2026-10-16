import {
  createRemoteConnection,
  receiveBinary,
  frameReservation,
  decodeRemoteResult,
  decodeRemoteEvent,
  create,
  encodeStrict,
  FrameSchema,
  ControlSchema,
  PublicEventSchema,
  SessionLogItemSchema,
  LosslessStringSchema,
  remotePayloadCodecs,
  ConnectorNoticePageSchema,
  decodeLossless,
  PriorityMode,
  AttentionNeed,
  LedgerClass,
  FailureCategory,
  ReservationBudget,
  takeAsset,
  WireLimit,
  RemoteCloseCode,
  type Connection,
  type Decision,
  type Frame,
  type RemoteError,
  type Scope,
  type Presentation,
} from "@ycoding-ai/remote"
import { prepareRemoteRequest, readWireMessage } from "./wire"
import type { NoticeFrame } from "./wire-views"

export type RemoteRequestOutcome =
  | { readonly status: "ok"; readonly value: unknown }
  | { readonly status: "failed"; readonly error: RemoteError }
  | { readonly status: "unknown"; readonly error: RemoteError }
  | {
      readonly status: "unavailable"
      readonly reason: "not-connected" | "in-flight-limit" | "request-limit" | "cancelled"
    }
export type RemoteTransportStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "open"; readonly rttMs?: number }
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "closed"; readonly code: number; readonly reason: string; readonly retryable: boolean }
export type RemoteRequestTiming = {
  readonly operation: string
  readonly outcome: RemoteRequestOutcome["status"]
  readonly reason?: Extract<RemoteRequestOutcome, { status: "unavailable" }>["reason"]
  readonly queueMs: number
  readonly settlementMs?: number
  readonly totalMs: number
}
export type RemoteTransportHandlers = {
  readonly onResync?: (sessionID: string) => void
  readonly onStatus?: (status: RemoteTransportStatus) => void
  readonly onSessions?: () => void
  readonly onSessionStatus?: (status: {
    readonly running: readonly string[]
    readonly attention: readonly string[]
    readonly outstanding?: readonly string[]
    readonly failed?: readonly string[]
  }) => void
  readonly onEvents?: (sessionID: string, events: readonly unknown[]) => void
  readonly onNotices?: (frame: NoticeFrame) => void
  readonly onRequestTiming?: (timing: RemoteRequestTiming) => void
  readonly onReconnect?: () => void
}
export type RemoteTransportRequest = {
  readonly sessionID?: string
  readonly workspaceID?: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}
export type RemoteTransport = {
  readonly connect: () => void
  readonly close: (code?: number, reason?: string) => void
  readonly request: (operation: string, request?: RemoteTransportRequest) => Promise<RemoteRequestOutcome>
  readonly status: () => RemoteTransportStatus
  readonly setPriority: (mode: "interactive" | "background") => void
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

export function clientFrameDelay(sentAt: number[], now: number): number {
  while (sentAt[0] !== undefined && now - sentAt[0] >= WireLimit.RATE_WINDOW_MS) sentAt.shift()
  return sentAt.length < WireLimit.CLIENT_RATE - 3
    ? 0
    : Math.max(1, Math.ceil(WireLimit.RATE_WINDOW_MS - (now - sentAt[0]!)))
}

type Pending = {
  readonly operation: string
  readonly admissionRequestID?: string
  readonly scope: Scope
  readonly resolve: (outcome: RemoteRequestOutcome) => void
  readonly timeout: number
  cancel: () => void
  sent: boolean
  transmit: () => void
}
type Owner = {
  readonly socket: WebSocket
  readonly connection: Connection
  readonly pending: Map<string, Pending>
  readonly logs: Map<string, { readonly requestID: string; readonly entry: Pending }>
  readonly snapshots: Map<string, string>
  readonly subscriptions: Map<string, { readonly id: string; hydration: "active" | "idle" | "invalidated" }>
  readonly sentAt: number[]
  readonly assets: ReservationBudget
  active: boolean
  sourceEpoch?: string
  cancelTick?: () => void
  cancelProbe?: () => void
  ping?: { readonly id: bigint; readonly at: number }
  rtt?: number
  remove?: () => void
}

export function createRemoteTransport(options: RemoteTransportOptions): RemoteTransport {
  const handlers = options.handlers ?? {}
  const now = options.now ?? (() => performance.now())
  const schedule =
    options.schedule ??
    ((callback, ms) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    })
  const random = options.random ?? Math.random
  const visibility = options.document ?? (typeof document === "undefined" ? undefined : document)
  const network = options.window ?? (typeof window === "undefined" ? undefined : window)
  let current: RemoteTransportStatus = { kind: "idle" }
  let owner: Owner | undefined
  let attempt = 0
  let closedByUs = false
  let connectedOnce = false
  let cancelReconnect: (() => void) | undefined
  let priority: "interactive" | "background" = visibility?.hidden ? "background" : "interactive"
  let timingWarningReported = false
  const reportTiming = (timing: RemoteRequestTiming) => {
    try {
      handlers.onRequestTiming?.(timing)
    } catch {
      if (!timingWarningReported) console.warn("Web latency diagnostics observer failed.")
      timingWarningReported = true
    }
  }
  const publish = (status: RemoteTransportStatus) => {
    current = status
    handlers.onStatus?.(status)
  }
  const currentOwner = (value: Owner) => value.active && owner === value && !closedByUs
  const stopListening = () => {
    visibility?.removeEventListener("visibilitychange", followVisibility)
    network?.removeEventListener("online", resume)
  }
  const end = (value: Owner, code: number, reason: string) => {
    if (!value.active) return
    value.active = false
    value.cancelTick?.()
    value.cancelProbe?.()
    value.remove?.()
    for (const entry of value.pending.values()) {
      entry.cancel()
      entry.resolve(
        entry.sent
          ? {
              status: "unknown",
              error: { code: "outcome_unknown", message: "The relay connection closed before this request settled" },
            }
          : { status: "unavailable", reason: "not-connected" },
      )
    }
    value.pending.clear()
    value.logs.clear()
    value.snapshots.clear()
    value.subscriptions.clear()
    value.connection.close(FailureCategory.EPOCH)
    if (owner !== value) return
    owner = undefined
    const retryable = !closedByUs && code !== RemoteCloseCode.unauthorized && code !== RemoteCloseCode.forbidden
    publish({ kind: "closed", code, reason, retryable })
    if (!retryable) {
      stopListening()
      return
    }
    const delayMs = Math.round(
      Math.min(options.maxDelayMs ?? 15_000, (options.resetDelayMs ?? 500) * 2 ** attempt) * (0.5 + random() / 2),
    )
    attempt += 1
    publish({ kind: "reconnecting", attempt, delayMs })
    cancelReconnect = schedule(connect, delayMs)
  }
  const process = (value: Owner, decisions: readonly Decision[]) => {
    if (!currentOwner(value)) return
    const completed = decisions.filter(
      (decision): decision is Extract<Decision, { type: "bulkComplete"; metadata: object }> =>
        decision.type === "bulkComplete" && decision.metadata !== undefined,
    )
    for (const decision of decisions) {
      if (!currentOwner(value)) break
      if (decision.type === "closed") {
        end(value, decision.code, FailureCategory[decision.category])
        value.socket.close(decision.code, FailureCategory[decision.category])
        continue
      }
      if (decision.type === "ready") {
        value.sourceEpoch = decision.sourceEpoch
        const reconnected = connectedOnce
        connectedOnce = true
        attempt = 0
        publish({ kind: "open" })
        enqueuePriority(value)
        if (reconnected) handlers.onReconnect?.()
        continue
      }
      if (decision.type === "events") {
        if (decision.batch.scope?.target.case !== "session") throw new Error("Invalid Session event scope")
        const events = decision.batch.events.map((event) => {
          const decoded = decodeRemoteEvent(event.event!)
          return readWireMessage(
            decoded.$typeName === PublicEventSchema.typeName ? PublicEventSchema : SessionLogItemSchema,
            decoded,
          )
        })
        const log = value.logs.get(decision.batch.subscriptionId)
        if (log) {
          const synced = events.find(
            (event): event is object =>
              typeof event === "object" && event !== null && Reflect.get(event, "type") === "log.synced",
          )
          if (synced !== undefined) {
            value.logs.delete(decision.batch.subscriptionId)
            log.entry.cancel()
            log.entry.resolve({ status: "ok", value: { watermark: Reflect.get(synced, "seq") } })
          }
        } else handlers.onEvents?.(decision.batch.scope.target.value, events)
        if (decision.ordinal !== undefined)
          process(value, value.connection.consume(LedgerClass.EVENT, decision.ordinal, now()))
        continue
      }
      if (decision.type === "resync") {
        if (decision.scope.target.case === "session") {
          const subscription = value.subscriptions.get(decision.scope.target.value)
          if (subscription) subscription.hydration = "invalidated"
          handlers.onResync?.(decision.scope.target.value)
        }
        continue
      }
      if (decision.type === "control") {
        const control = decision.frame.body.case === "control" ? decision.frame.body.value.kind : undefined
        if (control?.case === "inventoryInvalidated") handlers.onSessions?.()
        if (control?.case === "status")
          handlers.onSessionStatus?.({
            running: control.value.running,
            attention: control.value.attention,
            ...(control.value.outstanding ? { outstanding: control.value.outstanding.items } : {}),
            ...(control.value.failed ? { failed: control.value.failed.items } : {}),
          })
        if (control?.case === "notice") handlers.onNotices?.(noticeView(control.value))
        continue
      }
      if (decision.type === "settled") {
        const entry = value.pending.get(decision.requestID)
        if (!entry) continue
        entry.cancel()
        if (decision.status === "unsent" || decision.status === "unavailable") {
          entry.resolve({ status: "unavailable", reason: "not-connected" })
          continue
        }
        if (decision.status === "unknown") {
          entry.resolve({
            status: "unknown",
            error: { code: "outcome_unknown", message: "The request did not settle" },
          })
          continue
        }
        if (!decision.payload) throw new Error("Missing typed result")
        const codec = remotePayloadCodecs.get(entry.operation)!
        const schema =
          decision.status === "success" ? codec.result.schema : codec.errors.get(decision.payload.typeName)?.schema
        if (!schema) throw new Error("Unknown result schema")
        if (
          decision.status === "success" &&
          (entry.operation === "notice.subscribe" || entry.operation === "notice.list")
        ) {
          const page = decodeRemoteResult(entry.operation, decision.payload, ConnectorNoticePageSchema)
          const notices = noticeView(page.notice!)
          if (notices.type !== "notice.added") throw new Error("Invalid notice page")
          entry.resolve({
            status: "ok",
            value: {
              notices: notices.notices,
              total: notices.total,
              unavailable: page.unavailable,
              ...(page.next ? { next: page.next } : {}),
            },
          })
          continue
        }
        const decoded = decodeRemoteResult(entry.operation, decision.payload)
        const result = readWireMessage(schema, decoded)
        if (decision.status === "rejected") {
          const record = result as { code?: RemoteError["code"]; message?: string; _tag?: string }
          entry.resolve({
            status: "failed",
            error: {
              code: record.code ?? failureCode(decision.payload.typeName),
              message: record.message ?? record._tag ?? "The device rejected the request",
            },
          })
          continue
        }
        if (entry.operation === "session.attachment.read") {
          const delivery = completed.find((delivery) => delivery.start.requestId === decision.requestID)
          const asset = delivery && takeAsset(value.connection, delivery, value.assets)
          if (!asset) throw new Error("Attachment ownership limit")
          entry.resolve({
            status: "ok",
            value: { ...asset, mime: readWireMessage(LosslessStringSchema, asset.metadata.mime) },
          })
          continue
        }
        const fields = result as Record<string, unknown>
        if (entry.operation === "session.log") {
          if (typeof fields.subscription_id !== "string") throw new Error("Missing log subscription identity")
          const subscriptionID = fields.subscription_id
          value.logs.set(subscriptionID, { requestID: decision.requestID, entry })
          entry.cancel = schedule(() => {
            value.logs.delete(subscriptionID)
            process(value, value.connection.releaseSubscription(subscriptionID, now()))
            if (currentOwner(value) && entry.scope.target.case === "session")
              void request("event.unsubscribe", {
                sessionID: entry.scope.target.value,
                input: { subscription_id: subscriptionID },
              })
            entry.resolve({
              status: "unknown",
              error: { code: "outcome_unknown", message: "The log stream did not synchronize" },
            })
            pump(value)
          }, entry.timeout)
          process(value, value.connection.acceptSubscription(decision.requestID, subscriptionID, entry.scope, now()))
          continue
        }
        if (entry.operation === "event.subscribe") {
          if (typeof fields.subscription_id !== "string") throw new Error("Missing subscription identity")
          process(
            value,
            value.connection.acceptSubscription(decision.requestID, fields.subscription_id, entry.scope, now()),
          )
          value.connection.beginHydration(fields.subscription_id)
          if (entry.scope.target.case === "session") {
            value.subscriptions.set(entry.scope.target.value, { id: fields.subscription_id, hydration: "active" })
            const epoch = value.snapshots.get(decision.requestID)
            if (epoch !== undefined) {
              value.snapshots.delete(decision.requestID)
              value.subscriptions.set(entry.scope.target.value, { id: fields.subscription_id, hydration: "idle" })
              process(value, value.connection.completeHydration(fields.subscription_id, epoch, now()))
            }
          }
        }
        if (entry.operation === "session.snapshot" && entry.scope.target.case === "session") {
          const subscription = value.subscriptions.get(entry.scope.target.value)
          const projection = fields.data as { sourceEpoch?: string }
          if (subscription && projection.sourceEpoch) {
            subscription.hydration = "idle"
            process(value, value.connection.completeHydration(subscription.id, projection.sourceEpoch, now()))
          } else if (
            projection.sourceEpoch &&
            entry.admissionRequestID !== undefined &&
            value.pending.has(entry.admissionRequestID)
          )
            value.snapshots.set(entry.admissionRequestID, projection.sourceEpoch)
        }
        entry.resolve({ status: "ok", value: result })
        continue
      }
      if (decision.type === "bulkComplete" && decision.metadata === undefined)
        value.connection.releaseBulk(decision.transferID)
    }
  }
  const pump = (value: Owner) => {
    if (!currentOwner(value) || value.socket.readyState !== 1) return
    for (;;) {
      const prepared = value.connection.prepareHandoff(now())
      process(value, value.connection.takeDecisions())
      if (!prepared || !currentOwner(value)) return
      if (prepared.frame.ledger === LedgerClass.NORMAL && clientFrameDelay(value.sentAt, now()) > 0) {
        value.connection.abortPrepared(prepared)
        return
      }
      if (!value.connection.reservation.reserve(prepared.reservedBytes)) {
        value.connection.abortPrepared(prepared)
        process(value, value.connection.close(FailureCategory.LIMIT))
        return
      }
      try {
        const bytes = encodeStrict(FrameSchema, prepared.frame)
        process(value, value.connection.handoff(prepared, bytes.byteLength, now()))
        if (!currentOwner(value)) return
        if (
          prepared.frame.ledger === LedgerClass.NORMAL &&
          prepared.frame.body.case !== "hello" &&
          prepared.frame.body.case !== "ready"
        )
          value.sentAt.push(now())
        if (prepared.frame.body.case === "request") value.pending.get(prepared.frame.body.value.requestId)?.transmit()
        if (prepared.frame.body.case === "control" && prepared.frame.body.value.kind.case === "ping") {
          value.ping = { id: prepared.frame.body.value.kind.value.id, at: now() }
          startProbe(value)
        }
        value.socket.send(bytes)
      } finally {
        value.connection.reservation.release(prepared.reservedBytes)
      }
    }
  }
  const tick = (value: Owner) => {
    if (!currentOwner(value)) return
    process(value, value.connection.advance(now()))
    pump(value)
    if (currentOwner(value)) value.cancelTick = schedule(() => tick(value), 25)
  }
  const enqueuePriority = (value: Owner) => {
    const body: Frame["body"] = {
      case: "control",
      value: create(ControlSchema, {
        kind: {
          case: "priority",
          value: { mode: priority === "interactive" ? PriorityMode.INTERACTIVE : PriorityMode.BACKGROUND },
        },
      }),
    }
    process(value, value.connection.enqueue(body, frameReservation(body), now()))
    pump(value)
  }
  const setPriority = (mode: "interactive" | "background") => {
    if (priority === mode) return
    priority = mode
    if (owner && current.kind === "open") enqueuePriority(owner)
  }
  const startProbe = (value: Owner) => {
    value.cancelProbe?.()
    value.cancelProbe = undefined
    if (!value.ping || visibility?.hidden) return
    value.cancelProbe = schedule(() => {
      if (!currentOwner(value) || visibility?.hidden) return
      end(value, 4000, "Relay heartbeat timed out")
      value.socket.close(4000, "Relay heartbeat timed out")
    }, options.pongTimeoutMs ?? 10_000)
  }
  const followVisibility = () => {
    setPriority(visibility?.hidden ? "background" : "interactive")
    if (owner && visibility?.hidden) {
      owner.cancelProbe?.()
      owner.cancelProbe = undefined
    }
    if (!visibility?.hidden) resume()
  }
  const resume = () => {
    if (closedByUs) return
    if (owner === undefined && current.kind === "reconnecting") {
      connect()
      return
    }
    if (owner && !visibility?.hidden) {
      process(owner, owner.connection.advance(now()))
      pump(owner)
      startProbe(owner)
    }
  }
  const connect = () => {
    if (owner?.active) return
    closedByUs = false
    cancelReconnect?.()
    visibility?.addEventListener("visibilitychange", followVisibility)
    network?.addEventListener("online", resume)
    publish({ kind: "connecting", attempt })
    const socket = (options.createSocket ?? ((url) => new WebSocket(url)))(options.url)
    socket.binaryType = "arraybuffer"
    const value: Owner = {
      socket,
      connection: createRemoteConnection({
        now: now(),
        budgets: { pendingRequests: options.maxInFlight ?? 32, pingIntervalMs: options.pingIntervalMs ?? 20_000 },
      }),
      pending: new Map(),
      logs: new Map(),
      snapshots: new Map(),
      subscriptions: new Map(),
      sentAt: [],
      assets: new ReservationBudget(32 * 1024 * 1024),
      active: true,
    }
    owner = value
    const opened = () => {
      if (!currentOwner(value)) return
      process(value, value.connection.start(now()))
      pump(value)
    }
    const received = (event: MessageEvent) => {
      if (!currentOwner(value)) return
      try {
        const incoming = receiveBinary(value.connection, event.data, now())
        value.cancelProbe?.()
        value.cancelProbe = undefined
        if (
          incoming.frame?.body.case === "control" &&
          incoming.frame.body.value.kind.case === "pong" &&
          value.ping?.id === incoming.frame.body.value.kind.value.id
        ) {
          const rtt = Math.max(0, now() - value.ping.at)
          value.rtt = value.rtt === undefined ? rtt : 0.3 * rtt + 0.7 * value.rtt
          value.ping = undefined
          if (current.kind === "open") publish({ kind: "open", rttMs: Math.round(value.rtt) })
        }
        process(value, incoming.decisions)
        if (
          incoming.frame?.ledger === LedgerClass.NORMAL &&
          ["request", "result", "control"].includes(incoming.frame.body.case ?? "") &&
          !incoming.decisions.some(
            (decision) =>
              decision.type === "assetMetadata" || decision.type === "resync" || decision.type === "dropped",
          )
        )
          process(value, value.connection.consume(LedgerClass.NORMAL, incoming.frame.deliveryOrdinal, now()))
        pump(value)
      } catch {
        const code = value.connection.state === "established" ? 1002 : 1008
        end(value, code, "MALFORMED")
        socket.close(code, "MALFORMED")
      }
    }
    const closed = (event: CloseEvent) => end(value, event.code, event.reason || "The relay connection dropped.")
    const errored = () => {
      end(value, 1006, "The relay connection failed")
      socket.close()
    }
    socket.addEventListener("open", opened)
    socket.addEventListener("message", received)
    socket.addEventListener("close", closed)
    socket.addEventListener("error", errored)
    value.remove = () => {
      socket.removeEventListener("open", opened)
      socket.removeEventListener("message", received)
      socket.removeEventListener("close", closed)
      socket.removeEventListener("error", errored)
    }
    tick(value)
  }
  const request: RemoteTransport["request"] = (operation, input = {}) => {
    const value = owner
    const unavailable = (reason: Extract<RemoteRequestOutcome, { status: "unavailable" }>["reason"]) => {
      reportTiming({ operation, outcome: "unavailable", reason, queueMs: 0, totalMs: 0 })
      return Promise.resolve<RemoteRequestOutcome>({ status: "unavailable", reason })
    }
    if (input.signal?.aborted) return unavailable("cancelled")
    if (!value || current.kind !== "open" || !currentOwner(value)) return unavailable("not-connected")
    if (value.pending.size >= (options.maxInFlight ?? 32)) return unavailable("in-flight-limit")
    const prepared = prepareRemoteRequest(operation, input)
    const admissionRequestID =
      operation === "session.snapshot" && prepared.scope.target.case === "session"
        ? [...value.pending].findLast(
            ([, pending]) =>
              pending.operation === "event.subscribe" &&
              pending.scope.target.case === "session" &&
              pending.scope.target.value === prepared.scope.target.value,
          )?.[0]
        : undefined
    const admitted = value.connection.request(
      prepared.codec.operation.operationId,
      prepared.scope,
      prepared.payload,
      prepared.payload.byteLength + 512,
      now(),
    )
    if (!admitted.requestID) {
      process(value, admitted.decisions)
      return Promise.resolve({ status: "unavailable", reason: "request-limit" })
    }
    const id = admitted.requestID
    const started = now()
    return new Promise((resolve) => {
      let transmitted: number | undefined
      let settled = false
      const abort = () => {
        const entry = value.pending.get(id)
        if (!entry) return
        value.pending.delete(id)
        for (const [key, log] of value.logs)
          if (log.requestID === id) {
            value.logs.delete(key)
            process(value, value.connection.releaseSubscription(key, now()))
            if (currentOwner(value) && log.entry.scope.target.case === "session")
              void request("event.unsubscribe", {
                sessionID: log.entry.scope.target.value,
                input: { subscription_id: key },
              })
          }
        entry.cancel()
        process(value, value.connection.cancel(id, now()))
        entry.resolve(
          entry.sent
            ? {
                status: "unknown",
                error: { code: "outcome_unknown", message: "The transmitted request was cancelled before settlement" },
              }
            : { status: "unavailable", reason: "cancelled" },
        )
        pump(value)
      }
      const entry: Pending = {
        operation,
        admissionRequestID,
        scope: prepared.scope,
        sent: false,
        timeout: input.timeoutMs ?? options.requestTimeoutMs ?? 30_000,
        cancel: () => {},
        resolve: (outcome) => {
          if (settled) return
          settled = true
          value.pending.delete(id)
          if (operation === "event.subscribe" && outcome.status !== "ok") value.snapshots.delete(id)
          input.signal?.removeEventListener("abort", abort)
          if (
            operation === "session.snapshot" &&
            prepared.scope.target.case === "session" &&
            outcome.status !== "ok" &&
            currentOwner(value) &&
            value.connection.state === "established"
          ) {
            const subscription = value.subscriptions.get(prepared.scope.target.value)
            if (subscription?.hydration === "active" && value.sourceEpoch) {
              subscription.hydration = "idle"
              process(value, value.connection.completeHydration(subscription.id, value.sourceEpoch, now()))
            } else if (
              !subscription &&
              value.sourceEpoch &&
              admissionRequestID !== undefined &&
              value.pending.has(admissionRequestID)
            )
              value.snapshots.set(admissionRequestID, value.sourceEpoch)
          }
          resolve(outcome)
          const totalMs = Math.max(0, Math.round(now() - started))
          const queueMs = Math.min(totalMs, Math.max(0, Math.round((transmitted ?? now()) - started)))
          reportTiming({
            operation,
            outcome: outcome.status,
            ...(outcome.status === "unavailable" ? { reason: outcome.reason } : {}),
            queueMs,
            ...(transmitted === undefined ? {} : { settlementMs: totalMs - queueMs }),
            totalMs,
          })
        },
        transmit: () => {
          entry.sent = true
          transmitted = now()
          if (entry.timeout > 0)
            entry.cancel = schedule(() => {
              process(value, value.connection.expireRequest(id, now()))
              pump(value)
            }, entry.timeout)
        },
      }
      value.pending.set(id, entry)
      input.signal?.addEventListener("abort", abort, { once: true })
      process(value, admitted.decisions)
      if (operation === "session.snapshot" && prepared.scope.target.case === "session") {
        const subscription = value.subscriptions.get(prepared.scope.target.value)
        if (subscription?.hydration === "invalidated") {
          value.connection.beginHydration(subscription.id)
          subscription.hydration = "active"
        }
      }
      if (operation === "event.unsubscribe" && typeof input.input?.subscription_id === "string") {
        process(value, value.connection.releaseSubscription(input.input.subscription_id, now()))
        for (const [sessionID, subscription] of value.subscriptions)
          if (subscription.id === input.input.subscription_id) value.subscriptions.delete(sessionID)
      }
      pump(value)
    })
  }
  return {
    connect,
    request,
    status: () => current,
    setPriority,
    close: (code = 1000, reason = "client closed") => {
      closedByUs = true
      cancelReconnect?.()
      cancelReconnect = undefined
      stopListening()
      if (owner) {
        const value = owner
        end(value, code, reason)
        value.socket.close(code, reason)
      } else publish({ kind: "closed", code, reason, retryable: false })
    },
  }
}

function noticeView(notice: import("@ycoding-ai/remote").Notice): NoticeFrame {
  const kind = notice.kind
  if (kind.case === "cleared" || kind.case === "unavailable") return { type: `notice.${kind.case}` }
  if (kind.case === "offline") return { type: "notice.offline", at: Number(kind.value.atMs) }
  if (kind.case === "removed") return { type: "notice.removed", ids: kind.value.ids, total: Number(kind.value.total) }
  if (kind.case === "added")
    return {
      type: "notice.added",
      total: Number(kind.value.total),
      notices: kind.value.notices.map((notice) => ({
        id: notice.id,
        category: notice.category === 1 ? "approval-requested" : "agent-completed",
        sessionID: notice.sessionId,
        createdAt: Number(notice.createdMs),
      })),
    }
  if (kind.case === "present") return { type: "notice.present", items: kind.value.items.map(presentationView) }
  throw new Error("Invalid notice")
}

function presentationView(item: Presentation): import("./wire-views").NoticePresentationView {
  if (item.kind.case === "offline") return { kind: "offline", at: Number(item.kind.value.atMs) }
  if (item.kind.case !== "notice" || !item.kind.value.notice) throw new Error("Invalid notice presentation")
  const notice = item.kind.value.notice
  const detail = item.kind.value.detail
  const need =
    detail?.need === undefined
      ? undefined
      : (
          {
            [AttentionNeed.PERMISSION]: "permission",
            [AttentionNeed.QUESTION]: "question",
            [AttentionNeed.REVIEW]: "review",
            [AttentionNeed.FAILED]: "failed",
            [AttentionNeed.BLOCKED]: "blocked",
          } as const
        )[detail.need]
  return {
    kind: "notice",
    notice: {
      id: notice.id,
      category: notice.category === 1 ? "approval-requested" : "agent-completed",
      sessionID: notice.sessionId,
      createdAt: Number(notice.createdMs),
    },
    ...(detail
      ? {
          detail: {
            ...(detail.title ? { title: decodeLossless(detail.title) } : {}),
            ...(need ? { need } : {}),
            ...(detail.repeat === true ? { repeat: true } : {}),
          },
        }
      : {}),
  }
}

function failureCode(type: string): RemoteError["code"] {
  if (
    [
      "ycoding.v5.SessionNotFoundError",
      "ycoding.v5.MessageNotFoundError",
      "ycoding.v5.AttachmentNotFoundError",
      "ycoding.v5.ShellNotFoundError",
    ].includes(type)
  )
    return "not_found"
  if (
    ["ycoding.v5.InvalidRequestError", "ycoding.v5.InvalidCursorError", "ycoding.v5.FormInvalidAnswerError"].includes(
      type,
    )
  )
    return "invalid_message"
  if (type === "ycoding.v5.UnauthorizedError") return "unauthorized"
  if (type === "ycoding.v5.ForbiddenError") return "forbidden"
  if (type === "ycoding.v5.TelemetryDisabled") return "telemetry_disabled"
  if (type === "ycoding.v5.ServiceUnavailableError") return "agent_unavailable"
  return "internal_error"
}
