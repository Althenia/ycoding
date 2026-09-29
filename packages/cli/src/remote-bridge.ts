export * as RemoteBridge from "./remote-bridge"

import {
  RemoteCloseCode,
  RemoteLimits,
  parseRelayToAgentMessage,
  serializeEvent,
  type RemoteRequest,
  serializeResponse,
  serializeSessions,
  serializeStatus,
} from "@ycoding-ai/remote"
import { DeviceAuthorizationError } from "./remote-credentials"
import { agentURL } from "./remote-config"
import {
  createSessionRegistry,
  createAttachmentUploads,
  createSubscriptions,
  executeRemoteOperation,
  sessionStatus,
  type SessionRegistry,
  type SubscriptionRegistry,
} from "./remote-operations"
import type { LocalEventStream, LocalServer } from "./remote-local"
import { CloudflareRemoteTransport } from "./remote-transport"

// The local relay agent. It dials out to the relay over WSS and never listens,
// never proxies a caller-supplied URL or method, and never follows a remote
// Location: every local call is addressed from the backend Session inventory.
//
// Authorization is re-checked per request against that inventory, and inbound
// frames are parsed with the shared envelope parser instead of being trusted from
// the relay. Mutations are attempted exactly once: an indeterminate outcome is
// reported as `outcome_unknown` and is never replayed.

export type RelayConnection = {
  readonly connect: () => Promise<void>
  readonly send: (value: string) => Promise<void>
  readonly onMessage: (handler: (frame: unknown) => void) => void
  readonly disconnect: (code?: number, reason?: string) => Promise<void>
}

export type ConnectionInput = {
  readonly url: string
  readonly accessToken: string
  /** Every successful (re)open emits a Session-list invalidation. */
  readonly onOpen: () => void
  readonly onClose: (code?: number, reason?: string) => void
}

export type BridgeCredentials = { readonly accessToken: string; readonly accessExpiresAt: number }

export type RemoteBridgeOptions = {
  /** Enrolled relay origin. Device credentials are only ever sent here. */
  readonly relayURL: string
  readonly local: LocalServer
  /** Mints or rotates the device access credential. */
  readonly credentials: () => Promise<BridgeCredentials>
  /** Test seam; production dials the Cloudflare relay over WSS. */
  readonly createConnection?: (input: ConnectionInput) => RelayConnection
  readonly refreshIntervalMs?: number
  readonly eventRetryInitialMs?: number
  readonly eventRetryMaxMs?: number
  readonly authRetryWindowMs?: number
  readonly now?: () => number
  readonly onDiagnostic?: (message: string) => void
  readonly onTerminal?: (message: string) => void
}

const defaults = {
  refreshIntervalMs: 60_000,
  eventRetryInitialMs: 1_000,
  eventRetryMaxMs: 30_000,
  authRetryWindowMs: 30_000,
  rotateBeforeExpiryMs: 60_000,
}

export type BridgeState = "idle" | "live" | "terminal" | "closed"

const terminalCloseCodes: readonly number[] = [RemoteCloseCode.unauthorized, RemoteCloseCode.forbidden]
const maxPendingEvents = 4_096
const agentFrameIntervalMs = 25

type PendingEvent = {
  readonly event: unknown
  readonly connection: RelayConnection
  readonly streamGeneration: number
}

export class RemoteAgent {
  private readonly registry: SessionRegistry
  private readonly subscriptions: SubscriptionRegistry
  private uploads = createAttachmentUploads()
  private readonly now: () => number
  private readonly refreshIntervalMs: number
  private readonly eventRetryInitialMs: number
  private readonly eventRetryMaxMs: number
  private readonly authRetryWindowMs: number

  private connection?: RelayConnection
  private state: BridgeState = "idle"
  private accessExpiresAt = 0
  private lastAuthAttempt = Number.NEGATIVE_INFINITY
  private refreshTimer?: ReturnType<typeof setTimeout>
  private retryTimer?: ReturnType<typeof setTimeout>
  private statusTimer?: ReturnType<typeof setTimeout>
  private statusReading?: RelayConnection
  private statusOwner?: object
  private statusRetryAttempt = 0
  private statusDirty = false
  private lastStatus?: string
  private attentionStatus?: readonly string[]
  private attentionGeneration = 0
  private failedRoots = new Set<string>()
  private failureChanges = new Map<string, boolean>()
  private failuresHydrated = false
  private eventStop?: () => Promise<void>
  private eventStarting = false
  private eventStreamGeneration = 0
  private readonly pendingEvents: PendingEvent[] = []
  private readonly inFlight = new Map<string, AbortController>()
  private eventDraining = false
  private eventRetryAttempt = 0
  private terminalReason?: string
  private sendQueue: Promise<void> = Promise.resolve()
  private nextSendAt = 0

  constructor(private readonly options: RemoteBridgeOptions) {
    this.now = options.now ?? Date.now
    this.refreshIntervalMs = options.refreshIntervalMs ?? defaults.refreshIntervalMs
    this.eventRetryInitialMs = options.eventRetryInitialMs ?? defaults.eventRetryInitialMs
    this.eventRetryMaxMs = options.eventRetryMaxMs ?? defaults.eventRetryMaxMs
    this.authRetryWindowMs = options.authRetryWindowMs ?? defaults.authRetryWindowMs
    this.registry = createSessionRegistry({
      local: options.local,
      onChange: () => { void this.advertise(); this.attentionStatus = undefined; this.attentionGeneration++; this.failuresHydrated = false; this.scheduleStatus() },
    })
    this.subscriptions = createSubscriptions()
  }

  get currentState(): BridgeState {
    return this.state
  }

  get failure(): string | undefined {
    return this.terminalReason
  }

  /** Session IDs from the latest complete backend inventory refresh. */
  get advertised(): readonly string[] {
    return this.registry.ids()
  }

  async connect(): Promise<void> {
    if (this.state === "live" || this.state === "closed") return
    await this.registry.refresh()
    await this.openConnection()
    this.scheduleRefresh()
  }

  async close(code = RemoteCloseCode.normal, reason = "YCoding stopped") {
    if (this.state === "closed") return
    this.state = "closed"
    this.clearTimers()
    this.pendingEvents.splice(0)
    this.abortRequests()
    this.uploads.clear()
    await this.stopEventStream()
    await this.connection?.disconnect(code, reason)
    this.connection = undefined
  }

  /** Refresh backend state and notify clients to page the current Session list. */
  async republish(): Promise<void> {
    if (this.state !== "live") return
    await this.registry.refresh()
  }

  private async openConnection() {
    const credentials = await this.options.credentials()
    this.accessExpiresAt = credentials.accessExpiresAt
    const connection = (this.options.createConnection ?? createRelayConnection)({
      url: agentURL(this.options.relayURL),
      accessToken: credentials.accessToken,
      onOpen: () => {
        if (this.connection !== connection) return
        this.resetStatusRetry()
        this.statusOwner = {}
        this.sendQueue = Promise.resolve()
        this.nextSendAt = 0
        this.subscriptions.clear()
        this.uploads.clear()
        this.uploads = createAttachmentUploads()
        void this.advertise()
        this.lastStatus = undefined
        this.attentionStatus = undefined
        this.attentionGeneration++
        this.failedRoots.clear()
        this.failureChanges.clear()
        this.failuresHydrated = false
        this.statusReading = undefined
        this.statusDirty = false
        void this.sendStatus()
        this.syncEventStream()
      },
      onClose: (code, reason) => { if (this.connection === connection) this.onConnectionClosed(code, reason) },
    })
    this.connection = connection
    connection.onMessage((frame) => { if (this.connection === connection) this.onFrame(frame) })
    // The invalidation is sent from the open callback, so the bridge is live
    // before the connection settles.
    this.state = "live"
    try {
      await connection.connect()
    } catch (error) {
      this.state = "idle"
      this.connection = undefined
      throw error
    }
  }

  private onFrame(frame: unknown) {
    // The transport already decoded the frame; re-encoding runs the shared parser
    // so no frame reaches the local server without contract validation.
    const parsed = parseRelayToAgentMessage(typeof frame === "string" ? frame : JSON.stringify(frame))
    if (!parsed.ok) {
      if (parsed.id !== undefined)
        void this.send(serializeResponse({ type: "response", id: parsed.id, ok: false, error: parsed.error }), this.connection)
      this.diagnostic(`${parsed.id === undefined ? "ignored an inbound frame" : "rejected an inbound request"}: ${parsed.error.code}`)
      return
    }
    if (parsed.value.type === "subscriptions") {
      this.subscriptions.apply(parsed.value.clientID, parsed.value.sessionIDs)
      return
    }
    if (parsed.value.type === "cancel") { this.inFlight.get(parsed.value.id)?.abort(); return }
    if (parsed.value.type !== "request") return
    const controller = new AbortController()
    this.inFlight.set(parsed.value.id, controller)
    void this.handleRequest(parsed.value, controller)
  }

  private async handleRequest(request: RemoteRequest, controller: AbortController) {
    const owner = this.connection
    try {
      const frames = await executeRemoteOperation({
        request,
        signal: controller.signal,
        uploads: this.uploads,
        sessions: this.registry,
        subscriptions: this.subscriptions,
        local: this.options.local,
      })
      if (this.connection !== owner || controller.signal.aborted) return
      for (const frame of frames) {
        if (controller.signal.aborted) return
        await this.send(serializeResponse(frame), owner)
      }
      if (frames.some((frame) => frame.ok) &&
        (request.operation === "session.goal.stop" || request.operation === "session.goal.set" || request.operation === "session.autonomy.set"))
        this.scheduleStatus()
    } finally {
      if (this.inFlight.get(request.id) === controller) this.inFlight.delete(request.id)
    }
  }

  private abortRequests() {
    for (const controller of this.inFlight.values()) controller.abort()
    this.inFlight.clear()
  }

  private async send(frame: string, connection = this.connection) {
    if (connection === undefined || this.connection !== connection || this.state !== "live") return false
    const sent = this.sendQueue.then(async () => {
      if (this.connection !== connection || this.state !== "live") return false
      const delay = this.nextSendAt - this.now()
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay))
      if (this.connection !== connection || this.state !== "live") return false
      try {
        await connection.send(frame)
        this.nextSendAt = this.now() + agentFrameIntervalMs
        return true
      } catch {
        // A dropped relay connection makes the outcome indeterminate; the client
        // owns that decision and the agent never replays the request.
        this.diagnostic("the relay connection dropped before the frame was delivered")
        return false
      }
    })
    this.sendQueue = sent.then(() => undefined)
    return sent
  }

  private async advertise() {
    if (this.state !== "live") return
    await this.send(serializeSessions({ type: "sessions" }))
  }

  private scheduleStatus() {
    if (this.state !== "live" || this.statusOwner === undefined) return
    if (this.statusReading === this.connection) {
      this.statusDirty = true
      return
    }
    if (this.statusTimer !== undefined) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined
      void this.sendStatus()
    }, 250)
  }

  private async sendStatus() {
    const connection = this.connection
    const owner = this.statusOwner
    if (connection === undefined || owner === undefined || this.state !== "live") return
    if (this.statusReading === connection) {
      this.statusDirty = true
      return
    }
    this.statusReading = connection
    const generation = this.attentionGeneration
    try {
      const status = await sessionStatus(this.options.local, this.registry.snapshot(), this.attentionStatus,
        this.failuresHydrated ? this.failedRoots : undefined)
      if (this.connection !== connection || this.statusOwner !== owner || this.state !== "live") return
      this.statusRetryAttempt = 0
      if (!this.failuresHydrated && generation === this.attentionGeneration) {
        this.failedRoots = new Set(status.failed)
        for (const [root, failed] of this.failureChanges) {
          if (failed) this.failedRoots.add(root)
          else this.failedRoots.delete(root)
        }
        this.failureChanges.clear()
        this.failuresHydrated = true
      }
      if (generation === this.attentionGeneration) this.attentionStatus = status.requestAttention
      const attention = [...new Set([...status.requestAttention, ...this.failedRoots])].sort()
      if (attention.length > RemoteLimits.maxStatusSessions) throw new Error("Session status exceeds the bounded root count")
      const frame = serializeStatus({ type: "status", running: status.running, attention,
        ...(status.outstanding === undefined ? {} : { outstanding: status.outstanding }) })
      if (frame !== this.lastStatus) {
        if (await this.send(frame, connection)) this.lastStatus = frame
      }
    } catch (error) {
      this.diagnostic(`could not read remote Session status: ${describe(error)}`)
      if (this.connection === connection && this.statusOwner === owner && this.state === "live") {
        const delay = Math.min(this.eventRetryInitialMs * 2 ** this.statusRetryAttempt, this.eventRetryMaxMs)
        if (delay < this.eventRetryMaxMs) this.statusRetryAttempt++
        const timer = setTimeout(() => {
          if (this.statusTimer !== timer) return
          this.statusTimer = undefined
          if (this.statusOwner === owner) void this.sendStatus()
        }, delay)
        this.statusTimer = timer
      }
    } finally {
      if (this.statusReading === connection && this.statusOwner === owner) {
        this.statusReading = undefined
        if (this.statusDirty) {
          this.statusDirty = false
          this.scheduleStatus()
        }
      }
    }
  }

  private syncEventStream() {
    const wanted = this.state === "live"
    if (wanted && this.eventStop === undefined && !this.eventStarting) void this.startEventStream()
    if (!wanted && this.eventStop !== undefined)
      void this.stopEventStream().catch((error) => this.diagnostic(`could not stop the local event stream: ${describe(error)}`))
  }

  private async startEventStream() {
    if (this.eventStarting || this.eventStop !== undefined || this.state !== "live") return
    this.eventStarting = true
    const streamGeneration = ++this.eventStreamGeneration
    const stream: LocalEventStream = {
      onEvent: (event) => this.forwardEvent(event, streamGeneration),
      onFailure: (error) => this.onEventStreamEnd(error, streamGeneration),
      onEnd: () => this.onEventStreamEnd(undefined, streamGeneration),
    }
    try {
      const stop = await this.options.local.events(stream)
      if (this.state !== "live" || this.eventStreamGeneration !== streamGeneration) await stop()
      else {
        this.eventStop = stop
        this.eventRetryAttempt = 0
      }
    } catch (error) {
      this.onEventStreamEnd(error, streamGeneration)
    } finally {
      this.eventStarting = false
      if (this.state === "live" && this.eventStop === undefined && this.retryTimer === undefined) this.scheduleEventRetry()
    }
  }

  private async stopEventStream() {
    const stop = this.eventStop
    this.eventStop = undefined
    this.eventStreamGeneration++
    await stop?.()
  }

  private onEventStreamEnd(error: unknown, streamGeneration: number) {
    if (this.eventStreamGeneration !== streamGeneration) return
    this.eventStop = undefined
    this.eventStreamGeneration++
    if (this.state !== "live") return
    if (error !== undefined) this.diagnostic(`the local event stream ended: ${describe(error)}`)
    this.scheduleEventRetry()
  }

  private scheduleEventRetry() {
    if (this.retryTimer !== undefined || this.state !== "live") return
    const delay = Math.min(this.eventRetryInitialMs * 2 ** this.eventRetryAttempt++, this.eventRetryMaxMs)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.state !== "live") return
      void this.startEventStream()
    }, delay)
  }

  private forwardEvent(event: unknown, streamGeneration: number) {
    const connection = this.connection
    if (connection === undefined || this.state !== "live") return
    if (typeof event === "object" && event !== null) {
      const type = Reflect.get(event, "type")
      if (typeof type === "string" && (type.startsWith("session.step.") || type.startsWith("session.execution.") ||
        type.startsWith("session.task.") || type.startsWith("session.shell.") || type.startsWith("shell.") ||
        type.startsWith("session.input.") || type.startsWith("permission.v2.") || type.startsWith("form.") || type.startsWith("guardrail."))) {
        if (type.startsWith("session.execution.failed") || type.startsWith("session.execution.started")) {
          const data = Reflect.get(event, "data")
          const sessionID = typeof data === "object" && data !== null ? Reflect.get(data, "sessionID") : undefined
          const root = typeof sessionID === "string" ? this.registry.root(sessionID) : undefined
          if (root !== undefined) {
            const failed = type.startsWith("session.execution.failed")
            if (failed) this.failedRoots.add(root)
            else this.failedRoots.delete(root)
            if (!this.failuresHydrated) this.failureChanges.set(root, failed)
          }
        }
        if (type.startsWith("permission.v2.") || type.startsWith("form.") || type.startsWith("guardrail.")) {
          this.attentionStatus = undefined
          this.attentionGeneration++
        }
        this.scheduleStatus()
      }
    }
    if (isSessionInventoryEvent(event)) {
      void this.registry.refresh().catch((error) =>
        this.diagnostic(`could not refresh remote Sessions: ${describe(error)}`),
      )
    }
    if (this.pendingEvents.length >= maxPendingEvents) {
      this.pendingEvents.splice(0)
      this.diagnostic("the remote event authorization queue filled; closing for client reconciliation")
      void this.recycleConnection("Remote event authorization queue exceeded its bound")
      return
    }
    this.pendingEvents.push({ event, connection, streamGeneration })
    if (!this.eventDraining) void this.drainEvents()
  }

  private async drainEvents() {
    if (this.eventDraining) return
    this.eventDraining = true
    try {
      for (;;) {
        const pending = this.pendingEvents.shift()
        if (pending === undefined) return
        await this.forwardAuthorizedEvent(pending)
      }
    } finally {
      this.eventDraining = false
      if (this.pendingEvents.length > 0) void this.drainEvents()
    }
  }

  private async forwardAuthorizedEvent(pending: PendingEvent) {
    const sessionID = eventSessionID(pending.event)
    if (sessionID === undefined) return
    if (!this.subscriptions.has(sessionID)) return
    if (
      this.state !== "live" ||
      this.connection !== pending.connection ||
      this.eventStreamGeneration !== pending.streamGeneration ||
      !this.subscriptions.has(sessionID)
    )
      return
    const frame = serializeEvent({ type: "event", sessionID, event: pending.event })
    if (frame.length > RemoteLimits.maxAgentMessageChars) {
      const data = typeof pending.event === "object" && pending.event !== null ? Reflect.get(pending.event, "data") : undefined
      const originalID = typeof pending.event === "object" && pending.event !== null ? Reflect.get(pending.event, "id") : undefined
      const eventID = typeof originalID === "string" && /^evt_[A-Za-z0-9_-]+$/.test(originalID) && originalID.length <= 128 ? originalID : undefined
      const candidates = data && typeof data === "object" ? [Reflect.get(data, "messageID"), Reflect.get(data, "assistantMessageID"), Reflect.get(data, "inputID")] : []
      const messageID = candidates.find((value): value is string => typeof value === "string" && /^msg_[A-Za-z0-9_-]+$/.test(value) && value.length <= 128)
      const durable = typeof pending.event === "object" && pending.event !== null ? Reflect.get(pending.event, "durable") : undefined
      const seq: unknown = durable && typeof durable === "object" ? Reflect.get(durable, "seq") : undefined
      const version: unknown = durable && typeof durable === "object" ? Reflect.get(durable, "version") : undefined
      const markerDurable = durable && typeof durable === "object" && Reflect.get(durable, "aggregateID") === sessionID &&
        typeof seq === "number" && Number.isSafeInteger(seq) && typeof version === "number" && Number.isSafeInteger(version)
        ? { aggregateID: sessionID, seq, version }
        : undefined
      this.diagnostic(`forwarding a bounded invalidation for an oversized ${sessionID} event frame`)
      await this.send(serializeEvent({ type: "event", sessionID, event: {
        type: "session.remote.oversized", ...(eventID === undefined ? {} : { id: eventID }),
        ...(markerDurable === undefined ? {} : { durable: markerDurable }),
        data: { sessionID, ...(messageID === undefined ? {} : { messageID }), truncated: true, omittedChars: frame.length },
      } }), pending.connection)
      return
    }
    await this.send(frame, pending.connection)
  }

  private scheduleRefresh() {
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      if (this.state !== "live") return
      const rotate = this.accessExpiresAt - this.now() < defaults.rotateBeforeExpiryMs
      void (rotate ? this.rotateConnection() : this.republish()).then(() => { this.scheduleStatus(); this.scheduleRefresh() })
    }, this.refreshIntervalMs)
  }

  private onConnectionClosed(code: number | undefined, reason?: string) {
    if (this.state !== "live") return
    this.statusOwner = undefined
    this.resetStatusRetry()
    const reconnect = code === undefined || !terminalCloseCodes.includes(code) ||
      this.now() - this.lastAuthAttempt >= this.authRetryWindowMs
    this.diagnostic(`relay connection closed (code ${code ?? "unreported"}${reason ? `, reason: ${reason}` : ""}); ${reconnect ? "reconnecting" : "not reconnecting"}`)
    this.subscriptions.clear()
    this.uploads.clear()
    this.abortRequests()
    if (code !== undefined && terminalCloseCodes.includes(code)) void this.rotateConnection()
  }

  /**
   * Drop one connection and open a fresh one that invalidates client Session lists.
   * Used when a frame cannot be represented within the agent bound, so clients
   * reconcile through snapshot and history instead of losing an update.
   */
  private async recycleConnection(reason: string) {
    if (this.state !== "live") return
    const previous = this.connection
    this.statusOwner = undefined
    this.resetStatusRetry()
    this.connection = undefined
    this.uploads.clear()
    this.pendingEvents.splice(0)
    this.abortRequests()
    try {
      await previous?.disconnect(RemoteCloseCode.tooLarge, reason)
    } catch (error) {
      this.diagnostic(`could not close the replaced relay connection: ${describe(error)}`)
    }
    try {
      await this.openConnection()
    } catch (error) {
      this.stopForTerminal(error)
    }
  }

  /**
   * The relay rejected or expired the current access credential. Rotate once and
   * reconnect; a definitively revoked device stops the bridge instead of
   * retrying credentials indefinitely.
   */
  private async rotateConnection() {
    if (this.state !== "live") return
    const attempt = this.now()
    if (attempt - this.lastAuthAttempt < this.authRetryWindowMs) {
      this.terminal("The relay rejected the device credential again; enroll this device again")
      return
    }
    this.lastAuthAttempt = attempt
    const previous = this.connection
    this.statusOwner = undefined
    this.resetStatusRetry()
    this.connection = undefined
    this.uploads.clear()
    this.pendingEvents.splice(0)
    this.abortRequests()
    try {
      await previous?.disconnect(RemoteCloseCode.normal, "Rotating the device credential")
    } catch (error) {
      this.diagnostic(`could not close the rotated relay connection: ${describe(error)}`)
    }
    try {
      await this.openConnection()
    } catch (error) {
      this.stopForTerminal(error)
    }
  }

  private terminal(message: string) {
    if (this.state === "terminal" || this.state === "closed") return
    this.state = "terminal"
    this.terminalReason = message
    this.clearTimers()
    this.pendingEvents.splice(0)
    this.uploads.clear()
    this.abortRequests()
    void this.stopEventStream().catch((error) =>
      this.diagnostic(`could not stop the local event stream: ${describe(error)}`),
    )
    const connection = this.connection
    if (connection !== undefined)
      void connection
        .disconnect(RemoteCloseCode.unauthorized, "Device credential rejected")
        .catch((error) => this.diagnostic(`could not close the rejected relay connection: ${describe(error)}`))
    this.connection = undefined
    this.options.onTerminal?.(message)
    this.diagnostic(message)
  }

  private stopForTerminal(error: unknown) {
    if (error instanceof DeviceAuthorizationError) this.terminal(error.message)
    else this.diagnostic(`could not rotate the device credential: ${describe(error)}`)
  }

  private clearTimers() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.statusOwner = undefined
    this.resetStatusRetry()
    this.refreshTimer = undefined
    this.retryTimer = undefined
  }

  private resetStatusRetry() {
    if (this.statusTimer !== undefined) clearTimeout(this.statusTimer)
    this.statusTimer = undefined
    this.statusRetryAttempt = 0
  }

  private diagnostic(message: string) {
    this.options.onDiagnostic?.(message)
  }
}

function createRelayConnection(input: ConnectionInput): RelayConnection {
  return new CloudflareRemoteTransport({
    url: input.url,
    headers: { authorization: `Bearer ${input.accessToken}` },
    onOpen: input.onOpen,
    onClose: ({ code, reason }) => input.onClose(code, reason),
  })
}

function eventSessionID(event: unknown) {
  if (typeof event !== "object" || event === null) return undefined
  const data = Reflect.get(event, "data")
  if (typeof data !== "object" || data === null) return undefined
  if (Reflect.get(event, "type") === "form.created") {
    const form = Reflect.get(data, "form")
    const formSessionID = typeof form === "object" && form !== null ? Reflect.get(form, "sessionID") : undefined
    return typeof formSessionID === "string" ? formSessionID : undefined
  }
  const sessionID = Reflect.get(data, "sessionID")
  return typeof sessionID === "string" ? sessionID : undefined
}

function isSessionInventoryEvent(event: unknown) {
  if (typeof event !== "object" || event === null) return false
  const type = Reflect.get(event, "type")
  return type === "session.created" || type === "session.moved" || type === "session.deleted"
}

function describe(error: unknown) {
  return error instanceof Error || typeof error === "string" ? "operation failed" : "unknown error"
}
