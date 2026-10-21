export * as RemoteBridge from "./remote-bridge"
import { parseMcpRequest, parseMcpStateAck, parsePreviewAllocateAck, parsePreviewLeaseAck, parsePreviewRequest, parsePreviewStateAck, type McpRequest, type PreviewAllocateAck, type PreviewLeaseAck, type PreviewRequest, type PreviewStateAck } from "@ycoding-ai/remote"
import type { RemoteMcpHost, RemoteMcpPreference } from "./remote-mcp-host"

import {
  RemoteCloseCode,
  RemoteLimits,
  parseRelayToAgentMessage,
  parseAgentMessage,
  quotaKey,
  alertTitle,
  type RemoteAttentionNeed,
  type RemoteRequest,
  type RemoteQuota,
  serializeResponse,
  serializeSessions,
  serializeStatus,
  serializeBlocked,
  serializeCompletions,
} from "@ycoding-ai/remote"
import { DeviceAuthorizationError } from "./remote-credentials"
import { RemoteSetupError, type RemoteDiagnostic } from "./remote-error"
import { agentURL } from "./remote-config"
import {
  createSessionRegistry,
  createOperationCache,
  markSessionActivity,
  resetSessionActivity,
  createAttachmentUploads,
  attentionDetails,
  createSubscriptions,
  executeRemoteOperation,
  successFrames,
  sessionStatus,
  lossOnly,
  type OperationCache,
  type SessionRegistry,
  type SubscriptionRegistry,
} from "./remote-operations"
import type { LocalEventStream, LocalServer } from "./remote-local"
import { RemoteScheduler } from "./remote-scheduler"
import { CloudflareRemoteTransport } from "./remote-transport"
import { SessionWorkCompletion } from "@ycoding-ai/schema/session-work-completion"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Schema } from "effect"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import type { RemoteConnection } from "@ycoding-ai/server/remote-connection"
import { RemoteMcpAuthorization } from "./remote-mcp-authorization"
import type { RemoteAppPreviewHost } from "./remote-app-preview"

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
  /** Bytes queued on the socket and not yet written; bulk slices wait while it is high. */
  readonly bufferedAmount?: number
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
  readonly mcp?: { readonly host: RemoteMcpHost; readonly resource: string; readonly deviceID: string; readonly home: string; readonly authorizationFetch?: RemoteMcpAuthorization.Fetcher; readonly appPreview?: RemoteAppPreviewHost.Config }
  /** Enrolled relay origin. Device credentials are only ever sent here. */
  readonly relayURL: string
  readonly local: LocalServer
  /** Mints or rotates the device access credential. */
  readonly credentials: (signal?: AbortSignal) => Promise<BridgeCredentials>
  /** Test seam; production dials the Cloudflare relay over WSS. */
  readonly createConnection?: (input: ConnectionInput) => RelayConnection
  readonly refreshIntervalMs?: number
  readonly eventRetryInitialMs?: number
  readonly eventRetryMaxMs?: number
  readonly authRetryWindowMs?: number
  readonly conflictRetryMs?: number
  /** Minimum spacing between Session-list invalidation frames; changes inside the window share one trailing frame. */
  readonly advertiseCoalesceMs?: number
  readonly now?: () => number
  readonly onDiagnostic?: RemoteDiagnostic
  readonly onTerminal?: (message: string, retryable?: boolean) => void
}

const defaults = {
  refreshIntervalMs: 60_000,
  eventRetryInitialMs: 1_000,
  eventRetryMaxMs: 30_000,
  authRetryWindowMs: 30_000,
  conflictRetryMs: 60_000,
  advertiseCoalesceMs: 1_000,
  rotateBeforeExpiryMs: 60_000,
}
const verifyWindowMs = 5_000

export type BridgeState = "idle" | "live" | "terminal" | "closed"

const terminalCloseCodes: readonly number[] = [RemoteCloseCode.unauthorized, RemoteCloseCode.forbidden]
const maxPendingEvents = 4_096
const maxPendingQuotas = 256
const slowRequestMs = 1_000
const agentFrameIntervalMs = 25
const interactiveCoalesceMs = 40
const backgroundCoalesceMs = 750

export class RemoteAgent {
  readonly mcpEvents: RemoteConnection.EventAuthorization
  private credential?: BridgeCredentials
  private readonly mcpAcknowledgements = new Map<string, { state: RemoteMcpPreference; resolve: () => void; reject: () => void }>()
  private mcpServer?: Promise<ReturnType<typeof import("./remote-mcp")["createRemoteMcp"]>>
  private mcpCleanup = Promise.resolve()
  private previewHost?: RemoteAppPreviewHost.Host
  private previewEnabled = false
  private readonly previewAcks = new Map<string, (ack: PreviewStateAck | PreviewAllocateAck | PreviewLeaseAck | undefined) => void>()
  private readonly registry: SessionRegistry
  private readonly subscriptions: SubscriptionRegistry
  private uploads = createAttachmentUploads()
  private readonly cache: OperationCache
  private readonly now: () => number
  private readonly refreshIntervalMs: number
  private readonly eventRetryInitialMs: number
  private readonly eventRetryMaxMs: number
  private readonly authRetryWindowMs: number

  private connection?: RelayConnection
  private state: BridgeState = "idle"
  private generation = 0
  private readonly lifetime = new AbortController()
  private connected = false
  private readonly listeners = new Set<(connected: boolean) => void>()
  private accessExpiresAt = 0
  private lastAuthAttempt = Number.NEGATIVE_INFINITY
  private refreshTimer?: ReturnType<typeof setTimeout>
  private retryTimer?: ReturnType<typeof setTimeout>
  private statusTimer?: ReturnType<typeof setTimeout>
  private advertiseTimer?: ReturnType<typeof setTimeout>
  private advertiseDirty = false
  private statusReading?: RelayConnection
  private statusOwner?: object
  private statusRetryAttempt = 0
  private statusDirty = false
  private completionTimer?: ReturnType<typeof setTimeout>
  private conflictTimer?: ReturnType<typeof setTimeout>
  private completionReading?: object
  private completionBaselineOwner?: object
  private completionDirty = false
  private completionRetryAttempt = 0
  private lastStatus?: string
  private attentionStatus?: Readonly<Record<string, RemoteAttentionNeed>>
  private attentionGeneration = 0
  private failedRoots = new Set<string>()
  private failureChanges = new Map<string, boolean>()
  private failuresHydrated = false
  private failureGeneration = 0
  private eventStop?: () => Promise<void>
  private eventStarting = false
  private eventStreamGeneration = 0
  private readonly inFlight = new Map<string, AbortController>()
  private readonly quotas = new Map<string, { readonly quota: RemoteQuota; sent?: object; attempt?: object }>()
  private readonly settledQuotas = new Map<string, number>()
  private eventRetryAttempt = 0
  private eventStreamFailed = false
  private terminalReason?: string
  private readonly scheduler: RemoteScheduler.Scheduler

  constructor(private readonly options: RemoteBridgeOptions) {
    this.now = options.now ?? Date.now
    const mcp = options.mcp
    const authorization = mcp === undefined ? undefined : RemoteMcpAuthorization.create({
      relayURL: options.relayURL,
      deviceID: mcp.deviceID,
      credential: () => this.credential,
      allowed: (epoch) => this.connected && mcp.host.allowed(epoch ?? mcp.host.advertisement().epoch),
      signal: () => mcp.host.authorizationSignal(),
      now: this.now,
      ...(mcp.authorizationFetch === undefined ? {} : { fetcher: mcp.authorizationFetch }),
    })
    const unavailable = () => new McpEvents.Failure({ category: "unavailable", reason: "authorization_unavailable" })
    const authorize = async (request: Parameters<NonNullable<typeof authorization>["authorize"]>[0], signal?: AbortSignal) => {
      if (authorization === undefined) throw unavailable()
      const response = await authorization.authorize(request, signal).catch(() => { throw unavailable() })
      if (response.action === "capabilities") throw unavailable()
      if (!response.authorized) throw new McpEvents.Failure({
        category: response.reason === "unavailable" ? "unavailable" : "unauthorized",
        reason: response.reason === "unavailable" ? "authorization_unavailable" : "grant_revoked",
      })
      return response
    }
    this.mcpEvents = {
      capabilities: async () => authorization === undefined ? false : authorization.authorize({ action: "capabilities" })
        .then((response) => response.action === "capabilities" && response.supported, () => false),
      resolve: (context, signal) => authorize({ action: "resolve", ...context }, signal)
        .then((response) => ({ grantID: response.grantID, expiresAt: response.expiresAt })),
      check: async (principal, signal) => {
        const response = await authorize({
          action: "check", grantID: principal.grantID, epoch: principal.epoch,
          principal: { ownerID: principal.ownerID, deviceID: principal.deviceID, clientID: principal.clientID },
        }, signal)
        if (mcp === undefined) throw unavailable()
        return { expiresAt: response.expiresAt, signal: mcp.host.authorizationSignal() }
      },
    }
    this.cache = createOperationCache(this.now)
    this.refreshIntervalMs = options.refreshIntervalMs ?? defaults.refreshIntervalMs
    this.eventRetryInitialMs = options.eventRetryInitialMs ?? defaults.eventRetryInitialMs
    this.eventRetryMaxMs = options.eventRetryMaxMs ?? defaults.eventRetryMaxMs
    this.authRetryWindowMs = options.authRetryWindowMs ?? defaults.authRetryWindowMs
    this.registry = createSessionRegistry({
      local: options.local,
      verifyWindowMs,
      now: this.now,
      onChange: () => { this.advertise(); this.attentionStatus = undefined; this.attentionGeneration++; this.failuresHydrated = false; this.failureGeneration++; this.scheduleStatus() },
    })
    this.subscriptions = createSubscriptions()
    this.scheduler = new RemoteScheduler.Scheduler({
      intervalMs: agentFrameIntervalMs,
      now: this.now,
      transmit: (frame) => this.transmit(frame),
      bufferedAmount: () => this.connection?.bufferedAmount,
    })
  }

  get currentState(): BridgeState {
    return this.state
  }

  get failure(): string | undefined {
    return this.terminalReason
  }

  subscribe(listener: (connected: boolean) => void) {
    this.listeners.add(listener)
    listener(this.connected)
    return () => { this.listeners.delete(listener) }
  }

  private setConnected(connected: boolean) {
    this.connected = connected
    if (!connected) {
      this.credential = undefined
      this.previewEnabled = false
      for (const settle of this.previewAcks.values()) settle(undefined)
      this.previewAcks.clear()
      this.clearMcpApps()
      this.options.mcp?.host.detach()
      for (const pending of this.mcpAcknowledgements.values()) pending.reject()
      this.mcpAcknowledgements.clear()
    }
    this.listeners.forEach((listener) => listener(connected))
  }

  /** Session IDs from the latest complete backend inventory refresh. */
  get advertised(): readonly string[] {
    return this.registry.ids()
  }

  async connect(): Promise<void> {
    if (this.state === "live" || this.state === "closed") return
    const cycle = this.generation
    await this.registry.refresh()
    if (cycle !== this.generation) return
    await this.openConnection()
    this.scheduleRefresh()
  }

  async close(code = RemoteCloseCode.normal, reason = "YCoding stopped") {
    if (this.state === "closed") return
    this.state = "closed"
    this.generation++
    this.lifetime.abort()
    this.setConnected(false)
    this.clearTimers()
    this.scheduler.reset()
    this.abortRequests()
    this.uploads.clear()
    this.quotas.clear()
    this.settledQuotas.clear()
    const connection = this.connection
    this.connection = undefined
    try {
      await this.stopEventStream()
    } finally {
      await connection?.disconnect(code, reason)
      await this.mcpCleanup
      await (await this.mcpServer)?.close()
      this.previewHost?.close()
    }
  }

  /** Refresh backend state and notify clients to page the current Session list. */
  async republish(): Promise<void> {
    if (this.state !== "live") return
    await this.registry.refresh()
    await this.sendQuotas(true)
  }

  private async openConnection() {
    if (this.state === "closed" || this.state === "terminal") return
    const cycle = this.generation
    const credentials = await this.options.credentials(this.lifetime.signal)
    if (cycle !== this.generation) return
    this.credential = credentials
    this.accessExpiresAt = credentials.accessExpiresAt
    const connection = (this.options.createConnection ?? createRelayConnection)({
      url: agentURL(this.options.relayURL),
      accessToken: credentials.accessToken,
      onOpen: () => {
        if (this.connection !== connection || cycle !== this.generation) return
        this.credential = credentials
        this.setConnected(true)
        this.resetStatusRetry()
        this.resetCompletionRetry()
        this.statusOwner = {}
        this.scheduler.reset()
        if (this.options.mcp) void this.options.mcp.host.attach(this.options.mcp.resource, (state) => this.sendMcpState(state))
        void this.advertisePreview(connection)
        this.subscriptions.clear()
        this.uploads.clear()
        this.uploads = createAttachmentUploads()
        this.resetAdvertise()
        this.advertise()
        this.lastStatus = undefined
        this.attentionStatus = undefined
        this.attentionGeneration++
        this.failedRoots.clear()
        this.failureChanges.clear()
        this.failuresHydrated = false
        this.failureGeneration++
        this.statusReading = undefined
        this.statusDirty = false
        this.completionReading = undefined
        this.completionDirty = false
        void this.sendStatus()
        void this.sendCompletions()
        void this.sendQuotas()
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
      if (this.connection === connection && cycle === this.generation) {
        this.state = "idle"
        this.connection = undefined
        this.setConnected(false)
        await connection.disconnect().catch(() => this.diagnostic("could not close the failed relay connection"))
      }
      throw error
    }
  }

  private onFrame(frame: unknown) {
    const raw = typeof frame === "string" ? frame : JSON.stringify(frame)
    const acknowledgement = parseMcpStateAck(raw)
    if (acknowledgement) {
      const pending = this.mcpAcknowledgements.get(acknowledgement.id)
      if (pending && pending.state.epoch === acknowledgement.epoch && pending.state.enabled === acknowledgement.enabled) {
        this.mcpAcknowledgements.delete(acknowledgement.id)
        pending.resolve()
      }
      return
    }
    const previewAck = parsePreviewStateAck(raw) ?? parsePreviewAllocateAck(raw) ?? parsePreviewLeaseAck(raw)
    if (previewAck) {
      this.previewAcks.get(previewAck.id)?.(previewAck)
      return
    }
    const preview = parsePreviewRequest(raw)
    if (preview) {
      const controller = new AbortController()
      this.inFlight.set(preview.id, controller)
      void this.handlePreviewRequest(preview, controller)
      return
    }
    const mcp = parseMcpRequest(raw)
    if (mcp && this.options.mcp) {
      const controller = new AbortController()
      this.inFlight.set(mcp.id, controller)
      void this.handleMcpRequest(mcp, controller)
      return
    }
    // The transport already decoded the frame; re-encoding runs the shared parser
    // so no frame reaches the local server without contract validation.
    const parsed = parseRelayToAgentMessage(raw)
    if (!parsed.ok) {
      if (parsed.id !== undefined)
        void this.send(serializeResponse({ type: "response", id: parsed.id, ok: false, error: parsed.error }), this.connection)
      this.diagnostic(`${parsed.id === undefined ? "ignored an inbound frame" : "rejected an inbound request"}: ${parsed.error.code}`)
      return
    }
    if (parsed.value.type === "subscriptions") {
      this.subscriptions.apply(parsed.value.clientID, parsed.value.sessionIDs)
      this.retimeEvents()
      return
    }
    if (parsed.value.type === "priority") {
      this.subscriptions.setPriority(parsed.value.clientID, parsed.value.mode)
      this.retimeEvents()
      return
    }
    if (parsed.value.type === "cancel") { this.inFlight.get(parsed.value.id)?.abort(); return }
    if (parsed.value.type === "quota.result") {
      const key = quotaKey(parsed.value)
      const pending = this.quotas.get(key)
      if (!pending) return
      pending.sent = undefined
      if (parsed.value.status === "settled") {
        this.quotas.delete(key)
        this.settledQuotas.set(key, pending.quota.resetAt + 60_000)
        while (this.settledQuotas.size > maxPendingQuotas) this.settledQuotas.delete(this.settledQuotas.keys().next().value!)
      }
      return
    }
    if (parsed.value.type !== "request") return
    const controller = new AbortController()
    this.inFlight.set(parsed.value.id, controller)
    void this.handleRequest(parsed.value, controller)
  }

  private async handleRequest(request: RemoteRequest, controller: AbortController) {
    const owner = this.connection
    try {
      const started = this.now()
      const frames = await executeRemoteOperation({
        request,
        signal: controller.signal,
        uploads: this.uploads,
        sessions: this.registry,
        subscriptions: this.subscriptions,
        local: this.options.local,
        cache: this.cache,
      })
      const elapsed = this.now() - started
      if (elapsed >= slowRequestMs) this.diagnostic(`slow remote request ${request.operation} took ${elapsed}ms on this device`)
      if (this.connection !== owner || controller.signal.aborted) return
      const live = this.live(owner)
      if (live === undefined) return
      const active = () => !controller.signal.aborted && live()
      await Promise.all(frames.map((frame) =>
        frame.ok && frame.chunk !== undefined
          ? this.scheduler.bulk(request, serializeResponse(frame), active)
          : this.scheduler.control(serializeResponse(frame), active),
      ))
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

  private async sendMcpState(state: RemoteMcpPreference) {
    if (!state.enabled) await this.clearMcpApps()
    const id = crypto.randomUUID()
    const result = Promise.withResolvers<void>()
    const timeout = setTimeout(() => result.reject(new Error("Relay MCP acknowledgement timed out")), 5_000)
    this.mcpAcknowledgements.set(id, { state, resolve: () => result.resolve(), reject: () => result.reject(new Error("Remote disconnected")) })
    try {
      if (!await this.send(JSON.stringify({ type: "mcp.state", id, ...state }))) result.reject(new Error("Remote disconnected"))
      await result.promise
    } finally {
      clearTimeout(timeout)
      this.mcpAcknowledgements.delete(id)
    }
  }

  private clearMcpApps() {
    const server = this.mcpServer
    if (server === undefined) return this.mcpCleanup
    this.mcpCleanup = Promise.all([this.mcpCleanup, server.then((value) => value.clearApps())])
      .then(() => {}, () => this.diagnostic("Could not clear local app registrations"))
    return this.mcpCleanup
  }

  private async handleMcpRequest(request: McpRequest, controller: AbortController) {
    const owner = this.connection
    const mcp = this.options.mcp
    try {
      if (!mcp || request.input.principal.deviceID !== mcp.deviceID || !mcp.host.allowed(request.input.epoch)) {
        await this.send(serializeResponse({ type: "response", id: request.id, ok: false, error: { code: "forbidden", message: "Relay MCP is off or its authorization epoch changed" } }), owner)
        return
      }
      this.mcpServer ??= (async () => {
        const { createRemoteMcp } = await import("./remote-mcp")
        const { RemoteLocalApp } = await import("./remote-local-app")
        const { RemoteMcpApps } = await import("./remote-mcp-apps")
        const { RemoteAppPreviewHost } = await import("./remote-app-preview")
        const authorize = async (scope: McpEvents.Principal, signal: AbortSignal) => this.mcpEvents.check(scope, signal)
          .then((result) => !result.signal.aborted && result.expiresAt > this.now(), () => false)
        const registry = RemoteLocalApp.create({
          now: this.now,
          verifySession: async (sessionID) => await this.registry.renew(sessionID) !== undefined,
          authorize,
        })
        this.previewHost = mcp.appPreview === undefined ? undefined : RemoteAppPreviewHost.create({
          config: mcp.appPreview,
          registry,
          now: this.now,
          authorize,
          relay: {
            enabled: () => this.previewEnabled,
            allocate: async (input) => {
              const ack = await this.previewExchange({ type: "preview.allocate", ...input })
              if (ack?.type !== "preview.allocate.ack") return { reason: "rejected" }
              return "origin" in ack ? { origin: ack.origin } : { reason: ack.reason }
            },
            lease: async (lease) => {
              const ack = await this.previewExchange({ type: "preview.lease", ...lease })
              return ack?.type === "preview.lease.ack" && ack.ok
            },
            revoke: (target) => void this.send(JSON.stringify({ type: "preview.revoke", ...target })),
          },
        })
        const apps = RemoteMcpApps.create({
          registry,
          now: this.now,
          resolve: async (context, signal) => {
            const grant = await this.mcpEvents.resolve(context, signal)
            return { ...context.principal, grantID: grant.grantID, epoch: context.epoch }
          },
          ...(this.previewHost === undefined ? {} : { preview: this.previewHost.preview }),
        })
        return createRemoteMcp({ local: this.options.local, sessions: this.registry, subscriptions: this.subscriptions,
          cache: this.cache, home: mcp.home, resource: mcp.resource, apps, allowed: (epoch) => mcp.host.allowed(epoch) })
      })()
      const server = await this.mcpServer
      await this.mcpCleanup
      if (controller.signal.aborted || !mcp.host.allowed(request.input.epoch)) return
      const response = await server.fetch(new Request(mcp.resource, { method: "POST", body: request.input.body,
        headers: request.input.headers, signal: controller.signal }), { requestID: request.id, epoch: request.input.epoch, principal: request.input.principal })
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader) {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          bytes += next.value.byteLength
          if (bytes > RemoteLimits.maxAgentMessageChars * RemoteLimits.maxChunksPerResponse) {
            await reader.cancel()
            await this.send(serializeResponse({ type: "response", id: request.id, ok: false, error: { code: "message_too_large", message: "MCP response exceeds the relay response bound" } }), owner)
            return
          }
          chunks.push(next.value)
        }
      }
      if (this.connection !== owner || controller.signal.aborted || !mcp.host.allowed(request.input.epoch)) return
      const body = Buffer.concat(chunks).toString("utf8")
      for (const frame of successFrames(request.id, { status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body })) {
        if (controller.signal.aborted || this.connection !== owner) return
        await this.send(serializeResponse(frame), owner)
      }
    } catch {
      if (!controller.signal.aborted && this.connection === owner)
        await this.send(serializeResponse({ type: "response", id: request.id, ok: false, error: { code: "outcome_unknown", message: "MCP request outcome is unknown; inspect the Session before retrying" } }), owner)
    } finally {
      if (this.inFlight.get(request.id) === controller) this.inFlight.delete(request.id)
    }
  }

  private async advertisePreview(connection: RelayConnection) {
    const origins = this.options.mcp?.appPreview?.origins
    if (origins === undefined) return
    const ack = await this.previewExchange({ type: "preview.state", origins }, connection)
    if (this.connection === connection && this.connected) this.previewEnabled = ack?.type === "preview.state.ack" && ack.enabled
  }

  private previewExchange(frame: Record<string, unknown>, connection = this.connection) {
    const id = crypto.randomUUID()
    const result = Promise.withResolvers<PreviewStateAck | PreviewAllocateAck | PreviewLeaseAck | undefined>()
    const timeout = setTimeout(() => result.resolve(undefined), 5_000)
    this.previewAcks.set(id, result.resolve)
    void this.send(JSON.stringify({ ...frame, id }), connection).then((sent) => { if (!sent) result.resolve(undefined) })
    return result.promise.finally(() => {
      clearTimeout(timeout)
      this.previewAcks.delete(id)
    })
  }

  private async handlePreviewRequest(request: PreviewRequest, controller: AbortController) {
    const owner = this.connection
    try {
      const host = this.previewHost
      if (host === undefined || !this.previewEnabled) {
        await this.send(serializeResponse({ type: "response", id: request.id, ok: false, error: { code: "agent_unavailable", message: "App preview is unavailable on this machine" } }), owner)
        return
      }
      const result = await host.fetch(request.input, controller.signal)
      for (const frame of successFrames(request.id, result)) {
        if (controller.signal.aborted || this.connection !== owner) return
        await this.send(serializeResponse(frame), owner)
      }
    } catch {
      if (!controller.signal.aborted && this.connection === owner)
        await this.send(serializeResponse({ type: "response", id: request.id, ok: false, error: { code: "internal_error", message: "App preview request failed" } }), owner)
    } finally {
      if (this.inFlight.get(request.id) === controller) this.inFlight.delete(request.id)
    }
  }

  private send(frame: string, connection = this.connection) {
    const live = this.live(connection)
    return live === undefined ? Promise.resolve(false) : this.scheduler.control(frame, live)
  }

  private live(connection: RelayConnection | undefined) {
    const owner = this.statusOwner
    if (connection === undefined || owner === undefined || this.connection !== connection || this.state !== "live") return undefined
    return () => this.connection === connection && this.statusOwner === owner && this.state === "live"
  }

  private async transmit(frame: string) {
    const connection = this.connection
    if (connection === undefined) return false
    try {
      await connection.send(frame)
      return true
    } catch {
      // A dropped relay connection makes the outcome indeterminate; the client
      // owns that decision and the agent never replays the request.
      this.diagnostic("the relay connection dropped before the frame was delivered")
      return false
    }
  }

  private retimeEvents() {
    this.scheduler.retime((sessionID) => this.coalesceMs(sessionID))
  }

  private coalesceMs(sessionID: string) {
    return this.subscriptions.interactive(sessionID) ? interactiveCoalesceMs : backgroundCoalesceMs
  }

  private advertise() {
    if (this.state !== "live") return
    if (this.advertiseTimer !== undefined) {
      this.advertiseDirty = true
      return
    }
    void this.send(serializeSessions({ type: "sessions" }))
    this.advertiseTimer = setTimeout(() => {
      this.advertiseTimer = undefined
      if (!this.advertiseDirty) return
      this.advertiseDirty = false
      this.advertise()
    }, this.options.advertiseCoalesceMs ?? defaults.advertiseCoalesceMs)
  }

  private resetAdvertise() {
    if (this.advertiseTimer !== undefined) clearTimeout(this.advertiseTimer)
    this.advertiseTimer = undefined
    this.advertiseDirty = false
  }

  private scheduleStatus() {
    this.cache.listStatus = undefined
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
    const hydration = this.failuresHydrated ? undefined : this.failureGeneration
    try {
      const sessions = this.registry.snapshot()
      const status = await sessionStatus(this.options.local, sessions, this.attentionStatus,
        hydration === undefined ? this.failedRoots : undefined)
      if (this.connection !== connection || this.statusOwner !== owner || this.state !== "live") return
      this.statusRetryAttempt = 0
      if (hydration !== undefined) {
        this.failedRoots = new Set(status.failed)
        for (const [root, failed] of this.failureChanges) {
          if (failed) this.failedRoots.add(root)
          else this.failedRoots.delete(root)
        }
        if (hydration === this.failureGeneration) {
          this.failureChanges.clear()
          this.failuresHydrated = true
        }
      }
      if (generation === this.attentionGeneration) this.attentionStatus = status.requestNeeds
      const attention = [...new Set([...status.requestAttention, ...this.failedRoots, ...(status.lost ?? [])])].sort()
      if (attention.length > RemoteLimits.maxStatusSessions) throw new Error("Session status exceeds the bounded root count")
      const lost = lossOnly(status)
      const failed = [...this.failedRoots].filter((root) => !status.requestAttention.includes(root) && !lost.includes(root)).sort()
      const details = attentionDetails(sessions, attention, status.requestNeeds)
      const frame = serializeStatus({ type: "status", running: status.running, attention,
        ...(status.outstanding === undefined ? {} : { outstanding: status.outstanding }),
        ...(failed.length === 0 ? {} : { failed }),
        ...(lost.length === 0 ? {} : { lost }),
        ...(details.length === 0 ? {} : { details }) })
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

  private scheduleCompletions() {
    if (this.state !== "live" || this.statusOwner === undefined) return
    if (this.completionReading === this.statusOwner) {
      this.completionDirty = true
      return
    }
    if (this.completionTimer !== undefined) return
    this.completionTimer = setTimeout(() => {
      this.completionTimer = undefined
      void this.sendCompletions()
    }, 250)
  }

  private async sendCompletions() {
    const connection = this.connection
    const owner = this.statusOwner
    if (connection === undefined || owner === undefined || this.state !== "live") return
    if (this.completionReading === owner) {
      this.completionDirty = true
      return
    }
    this.completionReading = owner
    try {
      let after: string | undefined
      for (;;) {
        const page = await this.options.local.completions({ limit: RemoteLimits.maxCompletionBatch, ...(after === undefined ? {} : { after }) })
        if (this.connection !== connection || this.statusOwner !== owner || this.state !== "live") return
        if (page.next !== undefined && (page.next !== page.data.at(-1)?.sessionID || (after !== undefined && page.next <= after)))
          throw new Error("Completion pagination did not advance")
        const titles = new Map(this.registry.snapshot().map((session) => [session.id, session.title]))
        const data = page.data.map((item) => {
          const title = alertTitle(titles.get(item.sessionID) ?? "")
          return title === undefined ? item : { ...item, title }
        })
        if (!await this.send(serializeCompletions({ type: "completions", data, more: page.next !== undefined }), connection))
          throw new Error("Completion receipt delivery interrupted")
        if (page.next === undefined) break
        after = page.next
      }
      this.completionBaselineOwner = owner
      this.completionRetryAttempt = 0
    } catch (error) {
      if (this.connection !== connection || this.statusOwner !== owner || this.state !== "live") return
      this.diagnostic(`could not synchronize work completions: ${describe(error)}`)
      const delay = Math.min(this.eventRetryInitialMs * 2 ** this.completionRetryAttempt, this.eventRetryMaxMs)
      if (delay < this.eventRetryMaxMs) this.completionRetryAttempt++
      const timer = setTimeout(() => {
        if (this.completionTimer !== timer) return
        this.completionTimer = undefined
        if (this.statusOwner === owner) void this.sendCompletions()
      }, delay)
      this.completionTimer = timer
    } finally {
      if (this.completionReading === owner && this.statusOwner === owner) {
        this.completionReading = undefined
        if (this.completionDirty) {
          this.completionDirty = false
          this.scheduleCompletions()
        }
      }
    }
  }

  private async sendCompletion(event: object, streamGeneration: number) {
    const connection = this.connection
    const owner = this.statusOwner
    if (connection === undefined || owner === undefined || this.state !== "live" || this.eventStreamGeneration !== streamGeneration) return
    if (this.completionBaselineOwner !== owner) {
      this.scheduleCompletions()
      return
    }
    const data = Reflect.get(event, "data")
    const durable = Reflect.get(event, "durable")
    const receipt = Schema.decodeUnknownOption(SessionWorkCompletion.Receipt)({
      id: Reflect.get(event, "id"),
      created: Reflect.get(event, "created"),
      seq: typeof durable === "object" && durable !== null ? Reflect.get(durable, "seq") : undefined,
      sessionID: typeof data === "object" && data !== null ? Reflect.get(data, "sessionID") : undefined,
      inputID: typeof data === "object" && data !== null ? Reflect.get(data, "inputID") : undefined,
      assistantMessageID: typeof data === "object" && data !== null ? Reflect.get(data, "assistantMessageID") : undefined,
    })
    if (receipt._tag === "None" || typeof durable !== "object" || durable === null || Reflect.get(durable, "aggregateID") !== receipt.value.sessionID) {
      this.scheduleCompletions()
      return
    }
    try {
      const session = await this.registry.verify(receipt.value.sessionID)
      if (this.connection !== connection || this.statusOwner !== owner || this.state !== "live" || this.eventStreamGeneration !== streamGeneration) return
      if (session === undefined || session.parentID !== undefined) return
      const title = alertTitle(session.title)
      if (!await this.send(serializeCompletions({ type: "completions", data: [{ ...receipt.value, ...(title === undefined ? {} : { title }) }], more: false }), connection))
        throw new Error("Completion receipt delivery interrupted")
    } catch (error) {
      if (this.connection !== connection || this.statusOwner !== owner || this.state !== "live" || this.eventStreamGeneration !== streamGeneration) return
      this.diagnostic(`could not deliver work completion: ${describe(error)}`)
      this.scheduleCompletions()
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
        this.eventsMayBeMissed()
        if (this.eventStreamFailed) {
          this.eventStreamFailed = false
          this.advertise()
        }
        this.eventRetryAttempt = 0
        this.scheduleCompletions()
      }
    } catch (error) {
      this.onEventStreamEnd(error, streamGeneration)
    } finally {
      this.eventStarting = false
      if (this.state === "live" && this.eventStop === undefined && this.retryTimer === undefined) this.scheduleEventRetry()
    }
  }

  /** The local event stream has no resume cursor, so a restart loses the gap: cached captured summaries and Location verifications stop being trusted. */
  private eventsMayBeMissed() {
    resetSessionActivity(this.cache)
    this.registry.invalidateAll()
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
    this.eventsMayBeMissed()
    this.eventStreamFailed = true
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
    this.observeSessionChange(event)
    const connection = this.connection
    if (connection === undefined || this.state !== "live") return
    if (typeof event === "object" && event !== null) {
      const type = Reflect.get(event, "type")
      if (type === "provider.quota.pace") {
        if (this.eventStreamGeneration !== streamGeneration) return
        const alert = Schema.decodeUnknownOption(ProviderUsage.QuotaPaceAlert)(Reflect.get(event, "data"))
        if (alert._tag === "None" || alert.value.resetAt <= this.now()) return
        const frame = parseAgentMessage(JSON.stringify({ type: "quota", providerID: alert.value.providerID,
          windowID: alert.value.windowID, milestone: alert.value.milestone, resetAt: alert.value.resetAt }))
        if (!frame.ok || frame.value.type !== "quota") return
        const key = quotaKey(frame.value)
        if (this.quotas.has(key) || (this.settledQuotas.get(key) ?? 0) > this.now()) return
        if (this.quotas.size >= maxPendingQuotas) return
        this.quotas.set(key, { quota: frame.value })
        void this.sendQuotas()
        return
      }
      if (typeof type === "string" && type.startsWith("session.review.")) this.advertise()
      if (type === "shell.deleted") {
        if (this.eventStreamGeneration === streamGeneration) {
          this.advertise()
          this.scheduleStatus()
        }
        return
      }
      if (type === "session.work.completed") void this.sendCompletion(event, streamGeneration)
      if (typeof type === "string" && (type.startsWith("session.step.") || type.startsWith("session.execution.") ||
        type.startsWith("session.task.") || type.startsWith("session.shell.") || type.startsWith("shell.") ||
        type.startsWith("session.input.") || type.startsWith("permission.") || type.startsWith("form.") || type.startsWith("guardrail."))) {
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
        if (type.startsWith("permission.") || type.startsWith("form.") || type.startsWith("guardrail.") ||
          type.startsWith("session.execution.succeeded") || type.startsWith("session.execution.failed") ||
          type.startsWith("session.execution.interrupted")) {
          this.attentionStatus = undefined
          this.attentionGeneration++
        }
        if (type.startsWith("guardrail.decided")) this.reportBlock(Reflect.get(event, "data"))
        this.scheduleStatus()
      }
      if (isSessionActivityEvent(event)) {
        const sessionID = eventSessionID(event)
        if (sessionID !== undefined) void this.registry.renew(sessionID).catch((error) =>
          this.diagnostic(`could not refresh Session activity: ${describe(error)}`),
        )
      }
    }
    if (isSessionInventoryEvent(event)) this.refreshInventory(event)
    this.enqueueEvent(event, connection, streamGeneration)
  }

  private async sendQuotas(retry = false) {
    const connection = this.connection
    const owner = this.statusOwner
    if (connection === undefined || owner === undefined || this.state !== "live") return
    for (const [key, expiresAt] of this.settledQuotas) if (expiresAt <= this.now()) this.settledQuotas.delete(key)
    for (const [key, pending] of this.quotas) {
      if (this.connection !== connection || this.statusOwner !== owner || this.state !== "live") return
      if (pending.quota.resetAt <= this.now()) {
        this.quotas.delete(key)
        continue
      }
      if (pending.attempt === owner || !retry && pending.sent === owner) continue
      pending.attempt = owner
      pending.sent = owner
      const sent = await this.send(JSON.stringify({ type: "quota", providerID: pending.quota.providerID,
        windowID: pending.quota.windowID, milestone: pending.quota.milestone, resetAt: pending.quota.resetAt }), connection)
      if (pending.attempt === owner) pending.attempt = undefined
      if (!sent && pending.sent === owner) pending.sent = undefined
    }
  }

  /** Runs for every local event, connected or not, so a later cached read never trusts a Session that changed while the relay was away. */
  private observeSessionChange(event: unknown) {
    const sessionID = eventSessionID(event)
    if (sessionID === undefined) return
    const inventory = isSessionInventoryEvent(event)
    if (inventory) this.registry.invalidate(sessionID)
    if (inventory || isSessionActivityEvent(event)) markSessionActivity(this.cache, sessionID)
  }

  /** A created Session is read alone at the Location its event names; a move or delete reads the whole inventory. */
  private refreshInventory(event: unknown) {
    const sessionID = eventSessionID(event)
    const location = createdLocation(event)
    const refreshed = sessionID !== undefined && location !== undefined ? this.registry.add(sessionID, location) : this.registry.refresh()
    void refreshed.catch((error) => this.diagnostic(`could not refresh remote Sessions: ${describe(error)}`))
  }

  private enqueueEvent(event: unknown, connection: RelayConnection, streamGeneration: number) {
    const sessionID = eventSessionID(event)
    const live = this.live(connection)
    if (sessionID === undefined || live === undefined || this.eventStreamGeneration !== streamGeneration || !this.subscriptions.has(sessionID)) return
    if (this.scheduler.queuedEvents >= maxPendingEvents) {
      this.scheduler.reset()
      this.diagnostic("the remote event authorization queue filled; closing for client reconciliation")
      void this.recycleConnection("Remote event authorization queue exceeded its bound")
      return
    }
    const chars = JSON.stringify(event).length
    const frameLength = RemoteScheduler.eventsFrameLength(sessionID, chars)
    const bounded = frameLength > RemoteLimits.maxAgentMessageChars ? oversizedMarker(event, sessionID, frameLength) : event
    if (bounded !== event) this.diagnostic(`forwarding a bounded invalidation for an oversized ${sessionID} event frame`)
    this.scheduler.event(
      sessionID,
      bounded,
      bounded === event ? chars : JSON.stringify(bounded).length,
      streamGeneration,
      () => live() && this.eventStreamGeneration === streamGeneration && this.subscriptions.has(sessionID),
      this.coalesceMs(sessionID),
    )
  }

  private scheduleRefresh() {
    if (this.state !== "live") return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      if (this.state !== "live") return
      const rotate = this.accessExpiresAt - this.now() < defaults.rotateBeforeExpiryMs
      void (rotate ? this.rotateConnection() : this.republish())
        .then(() => { this.scheduleStatus(); this.scheduleCompletions(); this.scheduleRefresh() })
        .catch((error: unknown) => this.stopForTerminal(error))
    }, this.refreshIntervalMs)
  }

  private onConnectionClosed(code: number | undefined, reason?: string) {
    if (this.state !== "live") return
    const opened = this.connected
    this.setConnected(false)
    if (!opened && code !== undefined && terminalCloseCodes.includes(code)) {
      this.terminal("The relay rejected the device credential; enroll this device again")
      return
    }
    this.statusOwner = undefined
    this.resetStatusRetry()
    this.resetCompletionRetry()
    const conflict = code === RemoteCloseCode.agentConflict
    const reconnect = code === undefined || !terminalCloseCodes.includes(code) ||
      this.now() - this.lastAuthAttempt >= this.authRetryWindowMs
    this.diagnostic(`relay connection closed (code ${code ?? "unreported"}${reason ? `, reason: ${reason}` : ""}); ${conflict
      ? `another connector is live for this device; retrying in ${Math.round((this.options.conflictRetryMs ?? defaults.conflictRetryMs) / 1_000)} s`
      : reconnect ? "reconnecting" : "not reconnecting"}`)
    this.subscriptions.clear()
    this.scheduler.reset()
    this.uploads.clear()
    this.abortRequests()
    if (code !== undefined && terminalCloseCodes.includes(code)) void this.rotateConnection()
    if (conflict) void this.deferConnection()
  }

  private reportBlock(data: unknown) {
    if (typeof data !== "object" || data === null || Reflect.get(data, "decision") !== "deny") return
    const sessionID = Reflect.get(data, "sessionID")
    const root = typeof sessionID === "string" ? this.registry.root(sessionID) : undefined
    if (root === undefined) return
    const title = alertTitle(this.registry.snapshot().find((session) => session.id === root)?.title ?? "")
    void this.send(serializeBlocked({ type: "blocked", sessionID: root, ...(title === undefined ? {} : { title }) }))
  }

  private async deferConnection() {
    if (this.state !== "live") return
    const previous = this.connection
    this.connection = undefined
    try {
      await previous?.disconnect(RemoteCloseCode.normal, "Another connector is live")
    } catch (error) {
      this.diagnostic(`could not close the conflicting relay connection: ${describe(error)}`)
    }
    if (this.conflictTimer !== undefined) return
    this.conflictTimer = setTimeout(() => {
      this.conflictTimer = undefined
      if (this.state !== "live" || this.connection !== undefined) return
      void this.openConnection().catch((error: unknown) => this.stopForTerminal(error))
    }, this.options.conflictRetryMs ?? defaults.conflictRetryMs)
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
    this.resetCompletionRetry()
    this.connection = undefined
    this.uploads.clear()
    this.scheduler.reset()
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
    this.resetCompletionRetry()
    this.connection = undefined
    this.uploads.clear()
    this.scheduler.reset()
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

  private terminal(message: string, retryable = false) {
    if (this.state === "terminal" || this.state === "closed") return
    this.state = "terminal"
    this.generation++
    this.lifetime.abort()
    this.setConnected(false)
    this.terminalReason = message
    this.clearTimers()
    this.scheduler.reset()
    this.uploads.clear()
    this.abortRequests()
    void this.stopEventStream().catch((error) =>
      this.diagnostic(`could not stop the local event stream: ${describe(error)}`),
    )
    const connection = this.connection
    this.connection = undefined
    if (connection !== undefined)
      void connection
        .disconnect(retryable ? RemoteCloseCode.normal : RemoteCloseCode.unauthorized, retryable ? "Remote connection failed" : "Device credential rejected")
        .catch((error) => this.diagnostic(`could not close the rejected relay connection: ${describe(error)}`))
    this.options.onTerminal?.(message, retryable)
    this.diagnostic(message)
  }

  private stopForTerminal(error: unknown) {
    this.options.onDiagnostic?.("remote connector recovery failed", {
      cause: error instanceof DeviceAuthorizationError ? "authorization_rejected" : error instanceof RemoteSetupError ? "setup_failed" : "recovery_failed",
      ...(error instanceof DeviceAuthorizationError ? { status: error.status, ...(error.operation === undefined ? {} : { operation: error.operation }) } : {}),
    })
    if (error instanceof DeviceAuthorizationError || error instanceof RemoteSetupError) this.terminal(error.message)
    else {
      this.diagnostic(`could not rotate the device credential: ${describe(error)}`)
      this.terminal("Could not reconnect to the relay; retrying", true)
    }
  }

  private clearTimers() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.resetAdvertise()
    if (this.conflictTimer) clearTimeout(this.conflictTimer)
    this.conflictTimer = undefined
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.statusOwner = undefined
    this.resetStatusRetry()
    this.resetCompletionRetry()
    this.refreshTimer = undefined
    this.retryTimer = undefined
  }

  private resetStatusRetry() {
    if (this.statusTimer !== undefined) clearTimeout(this.statusTimer)
    this.statusTimer = undefined
    this.statusRetryAttempt = 0
  }

  private resetCompletionRetry() {
    if (this.completionTimer !== undefined) clearTimeout(this.completionTimer)
    this.completionTimer = undefined
    this.completionRetryAttempt = 0
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

function createdLocation(event: unknown) {
  if (typeof event !== "object" || event === null || Reflect.get(event, "type") !== "session.created") return undefined
  const data = Reflect.get(event, "data")
  const location = typeof data === "object" && data !== null ? Reflect.get(data, "location") : undefined
  const directory = typeof location === "object" && location !== null ? Reflect.get(location, "directory") : undefined
  const workspaceID = typeof location === "object" && location !== null ? Reflect.get(location, "workspaceID") : undefined
  if (typeof directory !== "string" || (workspaceID !== undefined && typeof workspaceID !== "string")) return undefined
  return { directory, ...(workspaceID === undefined ? {} : { workspaceID }) }
}

function oversizedMarker(event: unknown, sessionID: string, omittedChars: number) {
  const data = typeof event === "object" && event !== null ? Reflect.get(event, "data") : undefined
  const originalID = typeof event === "object" && event !== null ? Reflect.get(event, "id") : undefined
  const eventID = typeof originalID === "string" && /^evt_[A-Za-z0-9_-]+$/.test(originalID) && originalID.length <= 128 ? originalID : undefined
  const candidates = data && typeof data === "object" ? [Reflect.get(data, "messageID"), Reflect.get(data, "assistantMessageID"), Reflect.get(data, "inputID")] : []
  const messageID = candidates.find((value): value is string => typeof value === "string" && /^msg_[A-Za-z0-9_-]+$/.test(value) && value.length <= 128)
  const durable = typeof event === "object" && event !== null ? Reflect.get(event, "durable") : undefined
  const seq: unknown = durable && typeof durable === "object" ? Reflect.get(durable, "seq") : undefined
  const version: unknown = durable && typeof durable === "object" ? Reflect.get(durable, "version") : undefined
  const markerDurable = durable && typeof durable === "object" && Reflect.get(durable, "aggregateID") === sessionID &&
    typeof seq === "number" && Number.isSafeInteger(seq) && typeof version === "number" && Number.isSafeInteger(version)
    ? { aggregateID: sessionID, seq, version }
    : undefined
  return {
    type: "session.remote.oversized", ...(eventID === undefined ? {} : { id: eventID }),
    ...(markerDurable === undefined ? {} : { durable: markerDurable }),
    data: { sessionID, ...(messageID === undefined ? {} : { messageID }), truncated: true, omittedChars },
  }
}

function isSessionActivityEvent(event: unknown) {
  if (typeof event !== "object" || event === null) return false
  const type = Reflect.get(event, "type")
  return typeof type === "string" && (type.startsWith("session.step.ended") || type.startsWith("session.step.failed") ||
    type.startsWith("session.execution.succeeded") || type.startsWith("session.execution.failed") || type.startsWith("session.execution.interrupted") ||
    type.startsWith("session.compaction.ended") || type.startsWith("session.revert.committed"))
}

function isSessionInventoryEvent(event: unknown) {
  if (typeof event !== "object" || event === null) return false
  const type = Reflect.get(event, "type")
  return type === "session.created" || type === "session.moved" || type === "session.deleted"
}

function describe(error: unknown) {
  return error instanceof Error || typeof error === "string" ? "operation failed" : "unknown error"
}
