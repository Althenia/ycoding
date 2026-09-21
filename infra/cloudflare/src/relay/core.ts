/**
 * Relay core: the transport state machine that both WebSocket peers are routed
 * through.
 *
 * It is deliberately free of Cloudflare imports so the security-relevant behavior
 * (role separation, correlation translation, allowlist enforcement, limits,
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
  parseAgentMessage,
  parseClientMessage,
  serializeError,
  serializeRequest,
  serializeSessions,
  type RemoteErrorCode,
  type RemoteOperation,
  type RemoteResponse,
} from "../../../../packages/remote/src/index"
export type RelayConnection = {
  readonly connectionID: string
  readonly role: "agent" | "client"
  readonly ownerID: string
  readonly deviceID: string
  readonly browserSessionID: string
  readonly credentialExpiresAt: number
  readonly subscriptions: readonly string[]
  readonly pending: readonly { readonly relayID: string; readonly clientID: string }[]
}

export type RelayAuthority = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export type RelayDeps = {
  readonly now: () => number
  readonly newID: () => string
  readonly send: (connectionID: string, message: string) => void
  readonly close: (connectionID: string, code: number, reason: string) => void
  readonly saveSubscriptions: (connectionID: string, subscriptions: readonly string[]) => void
  readonly savePending: (connectionID: string, pending: readonly { relayID: string; clientID: string }[]) => void
  readonly loadAdvertisement: () => Promise<readonly string[]>
  readonly saveAdvertisement: (sessionIDs: readonly string[]) => Promise<void>
  readonly authorizeClientCommand: (sessionID: string, deviceID: string) => Promise<RelayAuthority>
  readonly authorizeAgentCommand: (deviceID: string) => Promise<RelayAuthority>
  /**
   * How long a successful authority check may be reused before a client is
   * re-validated. Bounds D1 reads while still failing closed on revocation and
   * expiry during event delivery.
   */
  readonly authorityTtlMs: number
}

export type Relay = ReturnType<typeof createRelay>

type ClientState = {
  readonly connectionID: string
  readonly deviceID: string
  readonly browserSessionID: string
  readonly credentialExpiresAt: number
  subscriptions: string[]
  windowStart: number
  windowCount: number
  authorityCheckedAt: number
}

type AgentState = {
  readonly connectionID: string
  readonly deviceID: string
  readonly credentialExpiresAt: number
  violations: number
  windowStart: number
  windowCount: number
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
const forbiddenMessage = "Connection is not permitted"
const invalidFrameMessage = "Frame is not valid for this connection"
const sizeMessage = "Frame exceeds the size bound"
const policyMessage = "Agent violated the relay policy"

export function createRelay(deps: RelayDeps) {
  const clients = new Map<string, ClientState>()
  const pending = new Map<string, PendingRequest>()
  let agent: AgentState | undefined
  let advertisement: readonly string[] = []
  let advertisementLoaded = false

  /**
   * Per-connection frame queues. A connection's frames are processed strictly in
   * arrival order, so a frame that awaits authority can never let a later frame
   * from the same peer overtake it. Each connection owns its queue and they drain
   * concurrently; unrelated devices live in different objects entirely.
   *
   * The queue entry lives exactly as long as the queued frames: it is released
   * when the queue drains, and a frame that fails does not poison later frames.
   */
  const frameQueues = new Map<string, Promise<void>>()

  const inArrivalOrder = (connectionID: string, process: () => Promise<void>): Promise<void> => {
    const previous = frameQueues.get(connectionID) ?? Promise.resolve()
    const current = previous.then(process, process)
    const drained = current.then(
      () => undefined,
      () => undefined,
    )
    frameQueues.set(connectionID, drained)
    void drained.then(() => {
      if (frameQueues.get(connectionID) === drained) frameQueues.delete(connectionID)
    })
    return current
  }

  const loadAdvertisement = async () => {
    if (advertisementLoaded) return
    advertisement = await deps.loadAdvertisement()
    advertisementLoaded = true
  }

  const dropPendingForConnection = (connectionID: string) => {
    for (const [relayID, entry] of Array.from(pending)) if (entry.connectionID === connectionID) pending.delete(relayID)
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
    clients.delete(connectionID)
    failPendingForConnection(connectionID, "outcome_unknown", outcomeUnknownMessage)
    deps.close(connectionID, code, reason)
  }

  const detachAgent = (code: number, reason: string) => {
    if (!agent) return
    const connectionID = agent.connectionID
    agent = undefined
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

  const relay = {
    advertisedSessions: () => advertisement,

    nextDeadline: () => {
      const deadlines = Array.from(clients.values()).map((client) => client.credentialExpiresAt)
      if (agent) deadlines.push(agent.credentialExpiresAt)
      return deadlines.length === 0 ? undefined : Math.min(...deadlines)
    },

    async attach(connection: RelayConnection) {
      await loadAdvertisement()
      if (deps.now() >= connection.credentialExpiresAt) {
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
        if (agent && agent.connectionID !== connection.connectionID) detachAgent(RemoteCloseCode.serviceRestart, "Agent connection replaced")
        agent = {
          connectionID: connection.connectionID,
          deviceID: connection.deviceID,
          credentialExpiresAt: connection.credentialExpiresAt,
          violations: 0,
          windowStart: deps.now(),
          windowCount: 0,
        }
        return
      }

      const authority = await deps.authorizeClientCommand(connection.browserSessionID, connection.deviceID)
      if (!authority.ok) {
        if (connection.pending.length > 0) {
          for (const entry of connection.pending)
            deps.send(connection.connectionID, serializeError(entry.clientID, "outcome_unknown", outcomeUnknownMessage))
          deps.savePending(connection.connectionID, [])
        }
        deps.close(connection.connectionID, closeCodeFor(authority.reason), closeReasonFor(authority.reason))
        return
      }

      const client: ClientState = {
        connectionID: connection.connectionID,
        deviceID: connection.deviceID,
        browserSessionID: connection.browserSessionID,
        credentialExpiresAt: connection.credentialExpiresAt,
        subscriptions: [...connection.subscriptions],
        windowStart: deps.now(),
        windowCount: 0,
        authorityCheckedAt: deps.now(),
      }
      clients.set(client.connectionID, client)
      deps.send(client.connectionID, serializeSessions({ type: "sessions", sessionIDs: advertisement }))
      if (connection.pending.length > 0) {
        for (const entry of connection.pending)
          deps.send(client.connectionID, serializeError(entry.clientID, "outcome_unknown", outcomeUnknownMessage))
        deps.savePending(client.connectionID, [])
      }
    },

    detach(connectionID: string) {
      if (agent?.connectionID === connectionID) {
        agent = undefined
        failAllPending("outcome_unknown", outcomeUnknownMessage)
        return
      }
      if (clients.has(connectionID)) {
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
      await admitRequest(client, message)
    },

    async handleAgentMessage(connectionID: string, raw: string) {
      const current = agent
      if (!current || current.connectionID !== connectionID) {
        deps.close(connectionID, RemoteCloseCode.unsupported, invalidFrameMessage)
        return
      }
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
        advertisement = message.sessionIDs
        advertisementLoaded = true
        await deps.saveAdvertisement(message.sessionIDs)
        for (const client of clients.values())
          deps.send(client.connectionID, serializeSessions({ type: "sessions", sessionIDs: message.sessionIDs }))
        return
      }
      if (message.type === "event") {
        if (!advertisement.includes(message.sessionID)) {
          if (raiseViolation(connectionID)) return
          return
        }
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
      deliverResponse(current.connectionID, message)
    },

    async revokeSession(sessionID: string) {
      for (const client of Array.from(clients.values()))
        if (client.browserSessionID === sessionID)
          removeClient(client.connectionID, RemoteCloseCode.unauthorized, sessionUnauthorizedMessage)
    },

    closeDevice() {
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
    handleClientMessage: (connectionID: string, raw: string) =>
      inArrivalOrder(connectionID, () => relay.handleClientMessage(connectionID, raw)),
    handleAgentMessage: (connectionID: string, raw: string) =>
      inArrivalOrder(connectionID, () => relay.handleAgentMessage(connectionID, raw)),
  }

  async function admitRequest(
    client: ClientState,
    request: { readonly id: string; readonly operation: RemoteOperation; readonly sessionID?: string; readonly input?: Readonly<Record<string, unknown>> },
  ) {
    if (request.sessionID !== undefined && !advertisement.includes(request.sessionID)) {
      respond(client.connectionID, request.id, "session_not_allowed", "Session is not served by the connected agent")
      return
    }
    if (request.operation === "session.subscribe") {
      const sessionID = request.sessionID ?? ""
      if (!client.subscriptions.includes(sessionID) && client.subscriptions.length >= RemoteLimits.maxSubscriptionsPerClient) {
        respond(client.connectionID, request.id, "rate_limited", "Subscription limit reached")
        return
      }
    }

    const authority = await checkClientAuthority(client)
    if (!authority.ok) {
      const unauthorized = authority.reason === "revoked_session" || authority.reason === "expired_session"
      respond(client.connectionID, request.id, unauthorized ? "unauthorized" : "forbidden", unauthorized ? sessionUnauthorizedMessage : forbiddenMessage)
      removeClient(
        client.connectionID,
        unauthorized ? RemoteCloseCode.unauthorized : RemoteCloseCode.forbidden,
        unauthorized ? sessionUnauthorizedMessage : forbiddenMessage,
      )
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

  /** Re-validates a client at most once per `authorityTtlMs`. Callers decide the close. */
  async function checkClientAuthority(client: ClientState): Promise<RelayAuthority> {
    const current = deps.now()
    if (current - client.authorityCheckedAt < deps.authorityTtlMs) return { ok: true }
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
      }
      if (entry.operation === "session.unsubscribe") {
        client.subscriptions = client.subscriptions.filter((sessionID) => sessionID !== entry.sessionID)
        deps.saveSubscriptions(client.connectionID, client.subscriptions)
      }
    }
    savePending(client)
  }
}
