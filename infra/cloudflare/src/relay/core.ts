/**
 * Relay core: the transport state machine that both WebSocket peers are routed
 * through.
 *
 * It is deliberately free of Cloudflare imports so the security-relevant behavior
 * (role separation, correlation translation, device ownership, limits,
 * chunk validation, disconnect and revocation semantics) is exercised directly.
 * The Durable Object adapter in `relay/durable-object.ts` supplies socket, storage,
 * and authority ports.
 *
 * The relay never interprets session payloads, never executes sessions, and never
 * persists transcripts.
 */

import {
  RemoteCloseCode,
  RemoteLimits,
  isNoticeRequest,
  remoteOperationAccess,
  isSessionID,
  noticePageValue,
  noticeSequence,
  parseAgentMessage,
  parseClientMessage,
  quotaKey,
  serializeError,
  serializeNoticeFrame,
  serializeRequest,
  serializeResponse,
  serializeCancel,
  serializePriority,
  serializeSessions,
  serializeSubscriptions,
  type RemoteAlertDetail,
  type RemoteErrorCode,
  type RemoteNotice,
  type RemoteNoticeCategory,
  type RemoteNoticePresentation,
  type RemoteNoticeRequest,
  type RemotePriorityMode,
  type RemoteOperation,
  type RemoteQuota,
  type RemoteResponse,
  type RemoteStatus,
} from "../../../../packages/remote/src/index"
import type { NoticeEvent, NoticeStore } from "./notice-store"
import type { PushEvent, PushOutcome, QuotaPushEvent } from "../push/send"
import type { PushSubscription } from "../push/store"
import type { QuotaReservation } from "./quota-claims"
export type RelayConnection = {
  readonly connectionID: string
  readonly role: "agent" | "client"
  readonly ownerID: string
  readonly deviceID: string
  readonly browserSessionID: string
  readonly credentialExpiresAt: number
  readonly subscriptions: readonly string[]
  readonly noticesSubscribed: boolean
  readonly priority?: RemotePriorityMode
  readonly pending: readonly { readonly relayID: string; readonly clientID: string }[]
}

export type OfflineCheck = { readonly ownerID: string; readonly deviceID: string; readonly closedAt: number }

export type RelayAuthority = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export type QuotaDelivery = {
  readonly subscriptions: (ownerID: string) => Promise<readonly PushSubscription[]>
  readonly reserve: (ownerID: string, key: string, until: number, members: readonly string[]) => Promise<QuotaReservation>
  readonly release: (ownerID: string, key: string, members: readonly string[]) => Promise<void>
  readonly push: (ownerID: string, event: QuotaPushEvent, subscriptions: readonly PushSubscription[]) => Promise<readonly PushOutcome[]>
}

export type RelayDeps = {
  readonly now: () => number
  readonly newID: () => string
  readonly send: (connectionID: string, message: string) => void
  readonly close: (connectionID: string, code: number, reason: string) => void
  readonly saveSubscriptions: (connectionID: string, subscriptions: readonly string[]) => void
  readonly savePending: (connectionID: string, pending: readonly { relayID: string; clientID: string }[]) => void
  readonly loadStatus: () => Promise<RemoteStatus | undefined>
  readonly saveStatus: (status: RemoteStatus) => Promise<void>
  readonly loadOfflineCheck: () => Promise<OfflineCheck | undefined>
  readonly saveOfflineCheck: (check: OfflineCheck | undefined) => Promise<void>
  readonly savePriority: (connectionID: string, mode: RemotePriorityMode) => void
  readonly notices: NoticeStore
  readonly saveNoticeSubscription: (connectionID: string, subscribed: boolean) => void
  readonly authorizeClientCommand: (sessionID: string, deviceID: string) => Promise<RelayAuthority>
  readonly authorizeAgentCommand: (deviceID: string) => Promise<RelayAuthority>
  /**
   * How long a successful authority check may be reused before a client is
   * re-validated. Bounds D1 reads while still failing closed on revocation and
   * expiry during event delivery.
   */
  readonly authorityTtlMs: number
  readonly notifyPush?: (accountID: string, event: PushEvent) => Promise<readonly PushOutcome[]>
  readonly agentHeartbeatAt?: (connectionID: string) => number | undefined
  readonly quota?: QuotaDelivery
}

type ClientState = {
  readonly connectionID: string
  readonly deviceID: string
  readonly browserSessionID: string
  readonly credentialExpiresAt: number
  subscriptions: string[]
  noticesSubscribed: boolean
  priority: RemotePriorityMode
  windowStart: number
  windowCount: number
  authorityCheckedAt: number
}

type AgentState = {
  readonly connectionID: string
  readonly ownerID: string
  readonly deviceID: string
  readonly credentialExpiresAt: number
  violations: number
  windowStart: number
  windowCount: number
  seenAt: number
}

type PendingRequest = {
  readonly connectionID: string
  readonly clientID: string
  readonly operation: RemoteOperation
  readonly sessionID?: string
  chunkIndex: number
  chunks: number
}
const outcomeUnknownMessage = "Agent disconnected before settling this request"
const forbiddenClientMessage = "Connection is not permitted"

function browserMember(browserSessionID: string) {
  return `browser:${browserSessionID}`
}

function noticeMember(browserSessionID: string) {
  return `notice:${browserSessionID}`
}

function closeCodeFor(reason: string): number {
  if (reason === "revoked_session" || reason === "expired_session") return RemoteCloseCode.unauthorized
  return RemoteCloseCode.forbidden
}

function closeReasonFor(reason: string): string {
  if (reason === "revoked_session" || reason === "expired_session") return sessionUnauthorizedMessage
  if (reason === "not_owner") return forbiddenClientMessage
  return deviceUnauthorizedMessage
}
const sessionUnauthorizedMessage = "Session is no longer authorized"
const deviceUnauthorizedMessage = "Device is no longer authorized"
const agentConflictMessage = "Another YCoding connector is connected for this device"
const forbiddenMessage = "Connection is not permitted"
const noticeStorageMessage = "Notification storage is unavailable"
const invalidFrameMessage = "Frame is not valid for this connection"
const sizeMessage = "Frame exceeds the size bound"
const policyMessage = "Agent violated the relay policy"
const pushBudgetPerMinute = 20
const quotaClaimGraceMs = 120_000

export function createRelay(deps: RelayDeps) {
  const clients = new Map<string, ClientState>()
  let latestStatus: string | undefined
  let previousStatus: RemoteStatus | undefined
  let pushWindowStart = deps.now()
  let pushWindowCount = 0
  const summarized = new Set<RemoteNoticeCategory>()
  let noticeFault = deps.notices.unavailable()
  let offlineCheck: OfflineCheck | undefined
  let offlineLoaded = false
  const pending = new Map<string, PendingRequest>()
  let agent: AgentState | undefined

  /**
   * Ordered frame lanes. Frames in one lane are processed strictly in arrival
   * order, so a frame that awaits authority can never let a later frame from the
   * same lane overtake it. Lanes drain concurrently: a connection's agent frames
   * other than responses share one lane, a browser's mutations share a lane per
   * Session (or per connection when sessionless), its notice requests share one
   * lane, and reads take no lane, so independent work never waits on another's
   * authorization.
   *
   * The lane entry lives exactly as long as the queued frames: it is released
   * when the lane drains, and a frame that fails does not poison later frames.
   */
  const frameQueues = new Map<string, Promise<void>>()
  const admissions = new Map<string, Promise<void>>()

  const inArrivalOrder = (lane: string, process: () => Promise<void>): Promise<void> => {
    const previous = frameQueues.get(lane) ?? Promise.resolve()
    const current = previous.then(process, process)
    const drained = current.then(
      () => undefined,
      () => undefined,
    )
    frameQueues.set(lane, drained)
    void drained.then(() => {
      if (frameQueues.get(lane) === drained) frameQueues.delete(lane)
    })
    return current
  }

  const mutationLane = (connectionID: string, message: { readonly sessionID?: string }) =>
    message.sessionID === undefined ? `${connectionID}\0mutation` : `${connectionID}\0session\0${message.sessionID}`

  const sendToClients = async (frame: string, noticesOnly = false, browsers?: ReadonlySet<string>) => {
    await Promise.all(Array.from(clients.values()).filter((client) => (!noticesOnly || client.noticesSubscribed) &&
      (browsers === undefined || browsers.has(client.browserSessionID))).map(async (client) => {
      if (await authorizeRecipient(client)) deps.send(client.connectionID, frame)
    }))
  }

  const recordNotices = async (operation: () => { readonly notices: readonly RemoteNotice[]; readonly total: number }): Promise<readonly RemoteNotice[] | undefined> => {
    try {
      const recorded = operation()
      for (let start = 0; start < recorded.notices.length; start += RemoteLimits.maxNoticeBatch)
        await sendToClients(serializeNoticeFrame({ type: "notice.added", notices: recorded.notices.slice(start, start + RemoteLimits.maxNoticeBatch), total: recorded.total }), true)
      return recorded.notices
    } catch {
      if (noticeFault) return undefined
      noticeFault = true
      try { deps.notices.markUnavailable() } catch { console.warn("Notification sync failure marker could not be stored") }
      await sendToClients(serializeNoticeFrame({ type: "notice.unavailable" }), true)
      return undefined
    }
  }

  const repeatNotices = (events: readonly NoticeEvent[]): readonly RemoteNotice[] => {
    if (events.length === 0) return []
    try {
      return deps.notices.repeat(events)
    } catch {
      console.warn("Repeated attention alert could not be recorded")
      return []
    }
  }

  const presenters = () => {
    const chosen = new Map<string, ClientState>()
    for (const client of clients.values()) if (client.noticesSubscribed && !chosen.has(client.browserSessionID)) chosen.set(client.browserSessionID, client)
    return chosen
  }

  const present = async (browserSessionID: string, items: readonly RemoteNoticePresentation[]) => {
    for (;;) {
      const client = presenters().get(browserSessionID)
      if (client === undefined) return
      if (!await authorizeRecipient(client)) continue
      for (let start = 0; start < items.length; start += RemoteLimits.maxNoticeBatch)
        deps.send(client.connectionID, serializeNoticeFrame({ type: "notice.present", items: items.slice(start, start + RemoteLimits.maxNoticeBatch) }))
      return
    }
  }

  const deliveries = new Set<Promise<void>>()

  const rollPushWindow = () => {
    if (deps.now() - pushWindowStart >= 60_000) { pushWindowStart = deps.now(); pushWindowCount = 0; summarized.clear() }
  }

  const deliverAlerts = async (ownerID: string, alerts: readonly { readonly event: Exclude<PushEvent, QuotaPushEvent>; readonly item?: RemoteNoticePresentation }[]) => {
    rollPushWindow()
    const admitted = Math.max(0, pushBudgetPerMinute - pushWindowCount)
    const notify = deps.notifyPush
    const immediate = new Map<string, RemoteNoticePresentation[]>()
    const overflow = new Map<RemoteNoticeCategory, { readonly deviceID: string; readonly items: readonly RemoteNoticePresentation[] }>()
    const dispatch = (send: NonNullable<RelayDeps["notifyPush"]>, event: PushEvent, items: readonly RemoteNoticePresentation[]) => {
      const browsers = Array.from(presenters().keys())
      const settle = async (outcomes: readonly PushOutcome[]) => {
        if (items.length === 0) return
        await Promise.all(browsers.filter((browserSessionID) => !outcomes.some((entry) => entry.owner === browserSessionID &&
          entry.outcome === "accepted")).map((browserSessionID) => present(browserSessionID, items)))
      }
      const delivery: Promise<void> = Promise.resolve().then(() => send(ownerID, event)).then(settle, () => settle([]))
        .finally(() => { deliveries.delete(delivery) })
      deliveries.add(delivery)
    }
    alerts.forEach((alert, index) => {
      const item = alert.item
      const category = alert.event.category
      if (notify !== undefined && index < admitted) {
        pushWindowCount += 1
        dispatch(notify, alert.event, item === undefined ? [] : [item])
        return
      }
      if (notify !== undefined && item !== undefined && category !== "machine-offline" && !summarized.has(category)) {
        overflow.set(category, { deviceID: alert.event.deviceID, items: [...overflow.get(category)?.items ?? [], item] })
        return
      }
      if (item !== undefined) for (const browserSessionID of presenters().keys()) immediate.set(browserSessionID, [...immediate.get(browserSessionID) ?? [], item])
    })
    for (const [category, entry] of overflow) {
      summarized.add(category)
      if (notify !== undefined) dispatch(notify, { category, deviceID: entry.deviceID, overflow: entry.items.length }, entry.items)
    }
    await Promise.all(Array.from(immediate, ([browserSessionID, items]) => present(browserSessionID, items)))
  }

  const answerQuota = async (current: AgentState, quota: RemoteQuota) => {
    const status = await deliverQuota(current, quota)
    if (agent?.connectionID !== current.connectionID) return
    deps.send(current.connectionID, JSON.stringify({ type: "quota.result", providerID: quota.providerID, windowID: quota.windowID,
      milestone: quota.milestone, resetAt: quota.resetAt, status }))
  }

  const deliverQuota = async (current: AgentState, quota: RemoteQuota): Promise<"settled" | "pending"> => {
    if (quota.resetAt <= deps.now()) return "settled"
    const delivery = deps.quota
    if (delivery === undefined) return "pending"
    rollPushWindow()
    if (pushWindowCount >= pushBudgetPerMinute) return "pending"
    pushWindowCount += 1
    const windowStart = pushWindowStart
    const refund = () => { if (pushWindowStart === windowStart && pushWindowCount > 0) pushWindowCount -= 1 }
    const subscriptions = await delivery.subscriptions(current.ownerID).catch(() => undefined)
    if (subscriptions === undefined) {
      refund()
      return "pending"
    }
    const owned = new Set(subscriptions.map((subscription) => subscription.browserSessionID))
    const targets = subscriptions.filter((subscription) => subscription.categories["quota-pace"])
    const subscribed = Array.from(presenters().keys())
    const viewers = subscribed.filter((browserSessionID) => !owned.has(browserSessionID))
    const key = quotaKey(quota)
    const reservation = await delivery.reserve(current.ownerID, key, quota.resetAt + quotaClaimGraceMs, [...subscribed.map(noticeMember),
      ...targets.map((subscription) => browserMember(subscription.browserSessionID)), ...viewers.map(browserMember)]).catch(() => undefined)
    if (reservation?.status !== "reserved") {
      refund()
      return "pending"
    }
    const granted = new Set(reservation.granted)
    const pushed = targets.filter((subscription) => granted.has(browserMember(subscription.browserSessionID)))
    if (pushed.length === 0) refund()
    const fields = { providerID: quota.providerID, windowID: quota.windowID, milestone: quota.milestone, resetAt: quota.resetAt }
    const noticed = new Set(subscribed.filter((browserSessionID) => granted.has(noticeMember(browserSessionID))))
    if (noticed.size > 0) await sendToClients(serializeNoticeFrame({ type: "notice.quota", ...fields, at: deps.now() }), true, noticed)
    await Promise.all(viewers.filter((browserSessionID) => granted.has(browserMember(browserSessionID)))
      .map((browserSessionID) => present(browserSessionID, [{ kind: "quota", ...fields }])))
    if (pushed.length === 0) return "settled"
    if (await delivery.push(current.ownerID, { category: "quota-pace", deviceID: current.deviceID, ...fields }, pushed).then(() => true, () => false))
      return "settled"
    refund()
    await delivery.release(current.ownerID, key, pushed.map((subscription) => browserMember(subscription.browserSessionID))).catch(() => undefined)
    return "pending"
  }

  const readOfflineCheck = async () => {
    if (!offlineLoaded) {
      offlineCheck = await deps.loadOfflineCheck()
      offlineLoaded = true
    }
    return offlineCheck
  }

  const writeOfflineCheck = async (check: OfflineCheck | undefined) => {
    offlineCheck = check
    offlineLoaded = true
    await deps.saveOfflineCheck(check)
  }

  const dropPendingForConnection = (connectionID: string) => {
    for (const [relayID, entry] of Array.from(pending)) if (entry.connectionID === connectionID) {
      pending.delete(relayID)
      if (agent) deps.send(agent.connectionID, serializeCancel(relayID))
    }
  }

  const failPendingForConnection = (connectionID: string, code: RemoteErrorCode, message: string) => {
    for (const [relayID, entry] of Array.from(pending)) {
      if (entry.connectionID !== connectionID) continue
      pending.delete(relayID)
      deps.send(entry.connectionID, serializeError(entry.clientID, code, message))
    }
    const client = clients.get(connectionID)
    if (client) savePending(client)
  }

  const failAllPending = (code: RemoteErrorCode, message: string) => {
    const affected = new Set<string>()
    for (const [relayID, entry] of Array.from(pending)) {
      pending.delete(relayID)
      affected.add(entry.connectionID)
      deps.send(entry.connectionID, serializeError(entry.clientID, code, message))
    }
    for (const connectionID of affected) {
      const client = clients.get(connectionID)
      if (client) savePending(client)
    }
  }

  const savePending = (client: ClientState) => {
    deps.savePending(client.connectionID, pendingEntriesFor(client.connectionID))
  }

  const pendingEntriesFor = (connectionID: string) =>
    Array.from(pending).flatMap(([relayID, entry]) =>
      entry.connectionID === connectionID ? [{ relayID, clientID: entry.clientID }] : [],
    )

  const removeClient = (connectionID: string, code: number, reason: string) => {
    sendSubscriptionSnapshot(connectionID, [])
    clients.delete(connectionID)
    failPendingForConnection(connectionID, "outcome_unknown", outcomeUnknownMessage)
    deps.close(connectionID, code, reason)
  }

  const agentLive = (current: AgentState) =>
    Math.max(current.seenAt, deps.agentHeartbeatAt?.(current.connectionID) ?? 0) > deps.now() - RemoteLimits.agentOfflineConfirmMs

  const detachAgent = (code: number, reason: string) => {
    if (!agent) return
    const connectionID = agent.connectionID
    agent = undefined
    latestStatus = undefined
    previousStatus = undefined
    failAllPending("outcome_unknown", outcomeUnknownMessage)
    deps.close(connectionID, code, reason)
  }

  const allow = (state: { windowStart: number; windowCount: number }, limit: number, windowMs: number) => {
    const current = deps.now()
    if (current - state.windowStart >= windowMs) {
      state.windowStart = current
      state.windowCount = 0
    }
    state.windowCount += 1
    return state.windowCount <= limit
  }

  const respond = (connectionID: string, clientID: string, code: RemoteErrorCode, message: string) => {
    deps.send(connectionID, serializeError(clientID, code, message))
  }

  const forwardsRequest = (connectionID: string, request: { readonly id: string; readonly operation: RemoteOperation; readonly sessionID?: string; readonly input?: Readonly<Record<string, unknown>> }) => {
    if (!agent) return false
    const relayID = deps.newID()
    pending.set(relayID, {
      connectionID,
      clientID: request.id,
      operation: request.operation,
      ...(request.sessionID === undefined ? {} : { sessionID: request.sessionID }),
      chunkIndex: 0,
      chunks: 0,
    })
    const client = clients.get(connectionID)
    if (client) savePending(client)
    deps.send(
      agent.connectionID,
      serializeRequest({
        type: "request",
        id: relayID,
        operation: request.operation,
        ...(request.sessionID === undefined ? {} : { sessionID: request.sessionID }),
        ...(request.input === undefined ? {} : { input: request.input }),
      }),
    )
    return true
  }

  const sendSubscriptionSnapshot = (clientID: string, sessionIDs: readonly string[]) => {
    if (!agent) return
    deps.send(agent.connectionID, serializeSubscriptions({ type: "subscriptions", clientID, sessionIDs }))
  }

  const sendPriority = (client: ClientState) => {
    if (!agent) return
    deps.send(agent.connectionID, serializePriority({ type: "priority", clientID: client.connectionID, mode: client.priority }))
  }

  const announceClient = (client: ClientState) => {
    sendSubscriptionSnapshot(client.connectionID, client.subscriptions)
    if (client.priority === "background") sendPriority(client)
  }

  const relay = {
    agentConnected: () => agent !== undefined,

    async restore(connections: readonly RelayConnection[]) {
      await readOfflineCheck()
      for (const connection of connections.toSorted((a, b) => Number(b.role === "agent") - Number(a.role === "agent"))) {
        await relay.attach(connection)
        if (agent?.connectionID === connection.connectionID) agent.seenAt = 0
      }
    },

    nextDeadline: () => {
      const deadlines = Array.from(clients.values()).map((client) => client.credentialExpiresAt)
      if (agent) deadlines.push(agent.credentialExpiresAt)
      if (offlineCheck) deadlines.push(offlineCheck.closedAt + RemoteLimits.agentOfflineConfirmMs)
      return deadlines.length === 0 ? undefined : Math.min(...deadlines)
    },

    async attach(connection: RelayConnection) {
      if (deps.now() >= connection.credentialExpiresAt) {
        if (connection.role === "client") sendSubscriptionSnapshot(connection.connectionID, [])
        deps.close(
          connection.connectionID,
          RemoteCloseCode.unauthorized,
          connection.role === "agent" ? deviceUnauthorizedMessage : sessionUnauthorizedMessage,
        )
        return
      }
      if (connection.role === "agent") {
        const authority = await deps.authorizeAgentCommand(connection.deviceID)
        if (!authority.ok) {
          deps.close(connection.connectionID, RemoteCloseCode.unauthorized, deviceUnauthorizedMessage)
          return
        }
        if (agent && agent.connectionID !== connection.connectionID) {
          if (agentLive(agent)) {
            deps.close(connection.connectionID, RemoteCloseCode.agentConflict, agentConflictMessage)
            return
          }
          detachAgent(RemoteCloseCode.serviceRestart, "Agent connection replaced")
        }
        agent = {
          connectionID: connection.connectionID,
          ownerID: connection.ownerID,
          deviceID: connection.deviceID,
          credentialExpiresAt: connection.credentialExpiresAt,
          violations: 0,
          windowStart: deps.now(),
          windowCount: 0,
          seenAt: deps.now(),
        }
        latestStatus = undefined
        if (await readOfflineCheck() !== undefined && agent?.connectionID === connection.connectionID) await writeOfflineCheck(undefined)
        const storedStatus = await deps.loadStatus()
        if (agent?.connectionID !== connection.connectionID) return
        previousStatus = storedStatus
        for (const client of Array.from(clients.values())) {
          if (deps.now() >= client.credentialExpiresAt) {
            removeClient(client.connectionID, RemoteCloseCode.unauthorized, sessionUnauthorizedMessage)
            continue
          }
          const clientAuthority = await checkClientAuthority(client)
          if (agent?.connectionID !== connection.connectionID) return
          if (clients.get(client.connectionID) !== client) continue
          if (!clientAuthority.ok) {
            removeClient(client.connectionID, closeCodeFor(clientAuthority.reason), closeReasonFor(clientAuthority.reason))
            continue
          }
          announceClient(client)
        }
        return
      }

      const authority = await deps.authorizeClientCommand(connection.browserSessionID, connection.deviceID)
      if (!authority.ok) {
        sendSubscriptionSnapshot(connection.connectionID, [])
        if (connection.pending.length > 0) {
          for (const entry of connection.pending)
            deps.send(connection.connectionID, serializeError(entry.clientID, "outcome_unknown", outcomeUnknownMessage))
          deps.savePending(connection.connectionID, [])
        }
        deps.close(connection.connectionID, closeCodeFor(authority.reason), closeReasonFor(authority.reason))
        return
      }

      const subscriptions = [...new Set(connection.subscriptions)]
      if (
        subscriptions.length > RemoteLimits.maxSubscriptionsPerClient ||
        subscriptions.some((sessionID) => !isSessionID(sessionID))
      ) {
        sendSubscriptionSnapshot(connection.connectionID, [])
        deps.close(connection.connectionID, RemoteCloseCode.policyViolation, "Stored subscriptions exceed the limit")
        return
      }
      const client: ClientState = {
        connectionID: connection.connectionID,
        deviceID: connection.deviceID,
        browserSessionID: connection.browserSessionID,
        credentialExpiresAt: connection.credentialExpiresAt,
        subscriptions,
        noticesSubscribed: connection.noticesSubscribed,
        priority: connection.priority ?? "interactive",
        windowStart: deps.now(),
        windowCount: 0,
        authorityCheckedAt: deps.now(),
      }
      clients.set(client.connectionID, client)
      deps.send(client.connectionID, serializeSessions({ type: "sessions" }))
      if (latestStatus !== undefined) deps.send(client.connectionID, latestStatus)
      announceClient(client)
      if (connection.pending.length > 0) {
        for (const entry of connection.pending)
          deps.send(client.connectionID, serializeError(entry.clientID, "outcome_unknown", outcomeUnknownMessage))
        deps.savePending(client.connectionID, [])
      }
    },

    async agentClosed(connection: RelayConnection) {
      const current = agent?.connectionID === connection.connectionID
      if (current) {
        agent = undefined
        failAllPending("outcome_unknown", outcomeUnknownMessage)
      }
      if (agent !== undefined || await readOfflineCheck() !== undefined) return
      await writeOfflineCheck({ ownerID: connection.ownerID, deviceID: connection.deviceID, closedAt: deps.now() })
    },

    async confirmOffline() {
      const check = await readOfflineCheck()
      if (check === undefined || deps.now() < check.closedAt + RemoteLimits.agentOfflineConfirmMs) return
      if (agent !== undefined) {
        await writeOfflineCheck(undefined)
        return
      }
      const authority = await deps.authorizeAgentCommand(check.deviceID)
      if (offlineCheck !== check || relay.agentConnected()) return
      await writeOfflineCheck(undefined)
      if (!authority.ok) return
      await sendToClients(serializeNoticeFrame({ type: "notice.offline", at: check.closedAt }), true)
      await deliverAlerts(check.ownerID, [{ event: { category: "machine-offline", deviceID: check.deviceID, offlineAt: check.closedAt }, item: { kind: "offline", at: check.closedAt } }])
    },

    detach(connectionID: string) {
      if (clients.has(connectionID)) {
        sendSubscriptionSnapshot(connectionID, [])
        clients.delete(connectionID)
        dropPendingForConnection(connectionID)
      }
    },

    async handleClientMessage(connectionID: string, raw: string) {
      const client = clients.get(connectionID)
      if (!client) return
      if (!allow(client, RemoteLimits.maxClientRequestsPerWindow, RemoteLimits.clientRateWindowMs)) {
        removeClient(connectionID, RemoteCloseCode.policyViolation, "Client request rate exceeded")
        return
      }
      if (deps.now() >= client.credentialExpiresAt) {
        removeClient(connectionID, RemoteCloseCode.unauthorized, sessionUnauthorizedMessage)
        return
      }

      const parsed = parseClientMessage(raw)
      if (!parsed.ok) {
        if (parsed.error.code === "message_too_large") {
          deps.close(connectionID, RemoteCloseCode.tooLarge, sizeMessage)
          return
        }
        if (parsed.id !== undefined) {
          respond(connectionID, parsed.id, parsed.error.code, parsed.error.message)
          return
        }
        deps.close(connectionID, RemoteCloseCode.unsupported, invalidFrameMessage)
        return
      }
      const message = parsed.value
      if (message.type === "ping") {
        deps.send(connectionID, '{"type":"pong"}')
        return
      }
      if (message.type === "pong") return
      if (message.type === "cancel") {
        await admissions.get(`${connectionID}\0${message.id}`)
        if (clients.get(connectionID) !== client) return
        const relayID = Array.from(pending).find(([, entry]) => entry.connectionID === connectionID && entry.clientID === message.id)?.[0]
        if (relayID === undefined) return
        pending.delete(relayID)
        savePending(client)
        if (agent) deps.send(agent.connectionID, serializeCancel(relayID))
        return
      }
      if (message.type === "priority") {
        client.priority = message.mode
        deps.savePriority(connectionID, message.mode)
        sendPriority(client)
        return
      }
      if (isNoticeRequest(message)) {
        await inArrivalOrder(`${connectionID}\0notice`, () => admitNoticeRequest(client, message))
        return
      }
      const lane = remoteOperationAccess[message.operation] === "mutation" ? mutationLane(connectionID, message) : undefined
      const key = `${connectionID}\0${message.id}`
      const admitted = lane === undefined ? admitRequest(client, message) : inArrivalOrder(lane, () => admitRequest(client, message))
      const settled = admitted.then(() => undefined, () => undefined)
      admissions.set(key, settled)
      void settled.then(() => {
        if (admissions.get(key) === settled) admissions.delete(key)
      })
      await admitted
    },

    async handleAgentMessage(connectionID: string, raw: string) {
      const current = agent
      if (!current || current.connectionID !== connectionID) {
        deps.close(connectionID, RemoteCloseCode.unsupported, invalidFrameMessage)
        return
      }
      current.seenAt = deps.now()
      if (!allow(current, RemoteLimits.maxAgentMessagesPerWindow, RemoteLimits.agentRateWindowMs)) {
        detachAgent(RemoteCloseCode.policyViolation, "Agent message rate exceeded")
        return
      }

      const parsed = parseAgentMessage(raw)
      if (!parsed.ok) {
        deps.close(
          connectionID,
          parsed.error.code === "message_too_large" ? RemoteCloseCode.tooLarge : RemoteCloseCode.unsupported,
          parsed.error.code === "message_too_large" ? sizeMessage : invalidFrameMessage,
        )
        return
      }
      const message = parsed.value
      if (message.type === "ping") {
        deps.send(connectionID, '{"type":"pong"}')
        return
      }
      if (message.type === "pong") return
      if (message.type === "sessions") {
        for (const client of clients.values())
          deps.send(client.connectionID, serializeSessions({ type: "sessions" }))
        return
      }
      if (message.type === "response") {
        deliverResponse(current.connectionID, message)
        return
      }
      if (message.type === "quota") return inArrivalOrder(`${connectionID}\0quota`, () => answerQuota(current, message))
      return inArrivalOrder(connectionID, async () => {
        if (message.type === "completions") {
          const recorded = await recordNotices(() => deps.notices.complete(message.data, message.more))
          await deliverAlerts(current.ownerID, (recorded ?? []).map((notice) => {
            const item = message.data.find((entry) => entry.sessionID === notice.sessionID)
            const detail = { ...(item?.title === undefined ? {} : { title: item.title }),
              ...(item?.coordinatorSessionIDs === undefined ? {} : { coordinatorSessionIDs: item.coordinatorSessionIDs }) }
            return { event: { category: "agent-completed", sessionID: notice.sessionID, deviceID: current.deviceID, noticeID: notice.id, ...detail },
              item: { kind: "notice", notice, ...(Object.keys(detail).length === 0 ? {} : { detail }) } }
          }))
          return
        }
        if (message.type === "blocked") {
          const event = { category: "approval-requested" as const, sessionID: message.sessionID, createdAt: deps.now(), need: "blocked" as const }
          const appended = await recordNotices(() => deps.notices.append([event]))
          const detail = { ...(message.title === undefined ? {} : { title: message.title }), need: "blocked" as const,
            ...(message.coordinatorSessionIDs === undefined ? {} : { coordinatorSessionIDs: message.coordinatorSessionIDs }) }
          if (appended === undefined) {
            await deliverAlerts(current.ownerID, [{ event: { category: event.category, sessionID: event.sessionID, deviceID: current.deviceID, ...detail } }])
            return
          }
          const repeated = appended.length === 0 ? repeatNotices([event]) : []
          await deliverAlerts(current.ownerID, [...appended, ...repeated].map((notice) => {
            const alert = { ...detail, ...(repeated.includes(notice) ? { repeat: true as const } : {}) }
            return { event: { category: notice.category, sessionID: notice.sessionID, deviceID: current.deviceID, noticeID: notice.id, ...alert },
              item: { kind: "notice", notice, detail: alert } }
          }))
          return
        }
        if (message.type === "status") {
          const before = previousStatus
          await deps.saveStatus(message)
          latestStatus = raw
          await sendToClients(raw)
          previousStatus = message
          if (before !== undefined) {
            const oldAttention = new Set(before.attention)
            const detailOf = (sessionID: string): RemoteAlertDetail => {
              const detail = message.details?.find((item) => item.sessionID === sessionID)
              const need = message.lost?.includes(sessionID) ? "lost" : message.failed?.includes(sessionID) ? "failed" : detail?.need
              return { ...(detail?.title === undefined ? {} : { title: detail.title }), ...(need === undefined ? {} : { need }),
                ...(detail?.coordinatorSessionIDs === undefined ? {} : { coordinatorSessionIDs: detail.coordinatorSessionIDs }) }
            }
            const events = message.attention.filter((sessionID) => !oldAttention.has(sessionID))
              .map((sessionID) => ({ category: "approval-requested" as const, sessionID, createdAt: deps.now(), need: detailOf(sessionID).need }))
            const appended = events.length === 0 ? [] : await recordNotices(() => deps.notices.append(events))
            const repeated = appended === undefined ? [] : repeatNotices(events.filter((event) => !appended.some((notice) => notice.sessionID === event.sessionID)))
            const recorded = appended === undefined ? undefined : [...appended, ...repeated]
            await deliverAlerts(current.ownerID, recorded === undefined
              ? events.map((event) => ({ event: { category: event.category, sessionID: event.sessionID, deviceID: current.deviceID, ...detailOf(event.sessionID) } }))
              : recorded.map((notice) => {
                const detail = { ...detailOf(notice.sessionID), ...(repeated.includes(notice) ? { repeat: true as const } : {}) }
                return { event: { category: notice.category, sessionID: notice.sessionID, deviceID: current.deviceID, noticeID: notice.id, ...detail },
                  item: { kind: "notice", notice, ...(Object.keys(detail).length === 0 ? {} : { detail }) } }
              }))
          }
          return
        }
        if (message.type === "event" || message.type === "events") {
          for (const client of Array.from(clients.values())) {
            if (!client.subscriptions.includes(message.sessionID)) continue
            if (deps.now() >= client.credentialExpiresAt) {
              removeClient(client.connectionID, RemoteCloseCode.unauthorized, sessionUnauthorizedMessage)
              continue
            }
            // Fail closed: a revoked or expired session never receives an event,
            // even when the revocation push never reached this object.
            const authority = await checkClientAuthority(client)
            if (!authority.ok) {
              removeClient(client.connectionID, closeCodeFor(authority.reason), closeReasonFor(authority.reason))
              continue
            }
            deps.send(client.connectionID, raw)
          }
          return
        }
      })
    },

    async revokeSession(sessionID: string) {
      for (const client of Array.from(clients.values()))
        if (client.browserSessionID === sessionID)
          removeClient(client.connectionID, RemoteCloseCode.unauthorized, sessionUnauthorizedMessage)
    },

    closeDevice() {
      noticeFault = false
      detachAgent(RemoteCloseCode.unauthorized, deviceUnauthorizedMessage)
      for (const client of Array.from(clients.values()))
        removeClient(client.connectionID, RemoteCloseCode.unauthorized, deviceUnauthorizedMessage)
    },

    sweep() {
      if (agent && deps.now() >= agent.credentialExpiresAt) detachAgent(RemoteCloseCode.unauthorized, deviceUnauthorizedMessage)
      for (const client of Array.from(clients.values()))
        if (deps.now() >= client.credentialExpiresAt)
          removeClient(client.connectionID, RemoteCloseCode.unauthorized, sessionUnauthorizedMessage)
    },
  }

  return {
    ...relay,
    settleDeliveries: async () => { while (deliveries.size > 0) await Promise.all(deliveries) },
  }

  async function admitRequest(
    client: ClientState,
    request: { readonly id: string; readonly operation: RemoteOperation; readonly sessionID?: string; readonly input?: Readonly<Record<string, unknown>> },
  ) {
    if (request.operation === "session.subscribe") {
      const sessionID = request.sessionID ?? ""
      if (!client.subscriptions.includes(sessionID) && client.subscriptions.length >= RemoteLimits.maxSubscriptionsPerClient) {
        respond(client.connectionID, request.id, "rate_limited", "Subscription limit reached")
        return
      }
    }

    const authority = await checkClientAuthority(client)
    if (!authority.ok) {
      rejectClient(client, request.id, authority.reason)
      return
    }

    if (agent) {
      const agentAuthority = await deps.authorizeAgentCommand(agent.deviceID)
      if (!agentAuthority.ok) detachAgent(RemoteCloseCode.unauthorized, deviceUnauthorizedMessage)
    }
    if (!agent) {
      respond(client.connectionID, request.id, "agent_unavailable", "No local agent is connected")
      return
    }
    // The connection can detach or be revoked while authority is read; a cancelled
    // frame must not be forwarded for a client that is no longer attached.
    if (!clients.has(client.connectionID)) return
    if (pendingEntriesFor(client.connectionID).length >= RemoteLimits.maxPendingRequestsPerClient) {
      respond(client.connectionID, request.id, "rate_limited", "Too many in-flight requests")
      return
    }
    forwardsRequest(client.connectionID, request)
  }

  async function admitNoticeRequest(client: ClientState, request: RemoteNoticeRequest) {
    const authority = await checkClientAuthority(client)
    if (!authority.ok) {
      rejectClient(client, request.id, authority.reason)
      return
    }
    if (clients.get(client.connectionID) !== client) return
    try {
      const value = await answerNotice(client, request)
      if (clients.get(client.connectionID) !== client) return
      deps.send(client.connectionID, serializeResponse({ type: "response", id: request.id, ok: true, value }))
    } catch {
      respond(client.connectionID, request.id, "internal_error", noticeStorageMessage)
    }
  }

  async function answerNotice(client: ClientState, request: RemoteNoticeRequest) {
    if (request.operation === "notice.subscribe") {
      const page = deps.notices.page()
      client.noticesSubscribed = true
      deps.saveNoticeSubscription(client.connectionID, true)
      return noticePageValue({ ...page, unavailable: noticeFault })
    }
    if (request.operation === "notice.list") {
      const before = request.input !== undefined && "before" in request.input ? noticeSequence(request.input.before) : undefined
      return noticePageValue({ ...deps.notices.page(before), unavailable: noticeFault })
    }
    if (request.operation === "notice.readAll") {
      deps.notices.clear()
      noticeFault = false
      await sendToClients(serializeNoticeFrame({ type: "notice.cleared" }), true)
      return null
    }
    const sequences = request.input !== undefined && "ids" in request.input ? request.input.ids.flatMap((id) => noticeSequence(id) ?? []) : []
    const removed = deps.notices.remove(sequences)
    if (removed.ids.length > 0) await sendToClients(serializeNoticeFrame({ type: "notice.removed", ids: removed.ids, total: removed.total }), true)
    return null
  }

  function rejectClient(client: ClientState, requestID: string, reason: string) {
    const unauthorized = reason === "revoked_session" || reason === "expired_session"
    respond(client.connectionID, requestID, unauthorized ? "unauthorized" : "forbidden", unauthorized ? sessionUnauthorizedMessage : forbiddenMessage)
    removeClient(
      client.connectionID,
      unauthorized ? RemoteCloseCode.unauthorized : RemoteCloseCode.forbidden,
      unauthorized ? sessionUnauthorizedMessage : forbiddenMessage,
    )
  }

  async function authorizeRecipient(client: ClientState): Promise<boolean> {
    if (deps.now() >= client.credentialExpiresAt) {
      removeClient(client.connectionID, RemoteCloseCode.unauthorized, sessionUnauthorizedMessage)
      return false
    }
    const authority = await checkClientAuthority(client, true).catch(() => undefined)
    if (clients.get(client.connectionID) !== client) return false
    if (authority === undefined) {
      removeClient(client.connectionID, 1011, "Session authorization is unavailable")
      return false
    }
    if (deps.now() >= client.credentialExpiresAt) {
      removeClient(client.connectionID, RemoteCloseCode.unauthorized, sessionUnauthorizedMessage)
      return false
    }
    if (!authority.ok) {
      removeClient(client.connectionID, closeCodeFor(authority.reason), closeReasonFor(authority.reason))
      return false
    }
    return true
  }

  async function checkClientAuthority(client: ClientState, fresh = false): Promise<RelayAuthority> {
    const current = deps.now()
    if (!fresh && current - client.authorityCheckedAt < deps.authorityTtlMs) return { ok: true }
    const authority = await deps.authorizeClientCommand(client.browserSessionID, client.deviceID)
    if (authority.ok) client.authorityCheckedAt = current
    return authority
  }

  function raiseViolation(connectionID: string): boolean {
    if (!agent || agent.connectionID !== connectionID) return false
    agent.violations += 1
    if (agent.violations >= RemoteLimits.maxAgentViolations) {
      detachAgent(RemoteCloseCode.policyViolation, policyMessage)
      return true
    }
    return false
  }

  function deliverResponse(connectionID: string, response: RemoteResponse) {
    const entry = pending.get(response.id)
    if (!entry) return
    if (response.ok && response.chunk !== undefined) {
      if (response.chunk.index !== entry.chunkIndex || entry.chunks >= RemoteLimits.maxChunksPerResponse) {
        raiseViolation(connectionID)
        return
      }
      entry.chunkIndex += 1
      entry.chunks += 1
      deps.send(
        entry.connectionID,
        JSON.stringify({
          type: "response",
          id: entry.clientID,
          ok: true,
          value: response.value,
          chunk: { index: response.chunk.index, last: response.chunk.last },
        }),
      )
      if (response.chunk.last) settle(entry, response)
      return
    }
    if (entry.chunks !== 0) {
      raiseViolation(connectionID)
      return
    }
    deps.send(entry.connectionID, JSON.stringify({ ...response, id: entry.clientID }))
    settle(entry, response)
  }

  function settle(entry: PendingRequest, response: RemoteResponse) {
    for (const [relayID, candidate] of Array.from(pending)) if (candidate === entry) pending.delete(relayID)
    const client = clients.get(entry.connectionID)
    if (!client) return
    if (response.ok && entry.sessionID !== undefined) {
      if (entry.operation === "session.subscribe" && !client.subscriptions.includes(entry.sessionID)) {
        client.subscriptions = [...client.subscriptions, entry.sessionID]
        deps.saveSubscriptions(client.connectionID, client.subscriptions)
        sendSubscriptionSnapshot(client.connectionID, client.subscriptions)
      }
      if (entry.operation === "session.unsubscribe") {
        client.subscriptions = client.subscriptions.filter((sessionID) => sessionID !== entry.sessionID)
        deps.saveSubscriptions(client.connectionID, client.subscriptions)
        sendSubscriptionSnapshot(client.connectionID, client.subscriptions)
      }
    }
    savePending(client)
  }
}
