import {
  create,
  encodeStrict,
  decodeStrict,
  decodeLossless,
  encodeLossless,
  FrameSchema,
  ControlSchema,
  ResultSchema,
  TypedPayloadSchema,
  Connector_ErrorSchema,
  Connector_Error_code,
  ConnectorNoticeBeforeSchema,
  ConnectorNoticeIDsSchema,
  ConnectorNoticePageSchema,
  ConnectorNoticeSettlementSchema,
  NoticeSchema,
  NoticeRecordSchema,
  PresentationSchema,
  NoticeCategory,
  MutationClass,
  LedgerClass,
  FailureCategory,
  PeerRole,
  ContentKind,
  AttentionNeed,
  Streaming,
  WireLimit,
  SubscriptionSnapshotSchema,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
  event_unsubscribe_RequestSchema,
  event_unsubscribe_ResultSchema,
  session_log_ResultSchema,
  session_message_RequestSchema,
  session_attachment_read_RequestSchema,
  McpStateAckSchema,
  QuotaPaceResultSchema,
  QuotaPaceStatus,
  ScopeSchema,
  RequestSchema,
  operations,
} from "../../../../packages/protocol/src/v5"
import type {
  Frame,
  Notice,
  Presentation,
  Scope,
  OperationDescriptor,
  BulkStart,
  QuotaPace,
} from "../../../../packages/protocol/src/v5"
import type { Connection, Decision } from "../../../../packages/protocol/src/v5/connection"
import { ReservationBudget } from "../../../../packages/protocol/src/v5/connection"
import {
  McpLimits,
  RelayLimits,
  RemoteLimits,
  decodeMcpResponse,
  noticeSequence,
  quotaKey,
  quotaFromWire,
  quotaToWire,
  remoteErrorCodes,
  createRelayConnection,
  receiveBinary,
  frameReservation,
} from "../../../../packages/remote/src/index"
import type {
  RemoteNotice,
  RemoteAlertDetail,
  RemoteErrorCode,
  RemoteQuota,
} from "../../../../packages/remote/src/index"
import type { NoticeEvent, NoticeStore } from "./notice-store"
import type { PushEvent, PushOutcome, QuotaPushEvent } from "../push/send"
import type { PushSubscription } from "../push/store"
import type { QuotaReservation } from "./quota-claims"
import { McpRelayError, createMcpRelay } from "./mcp"
import type { McpOutcome, McpRelayDeps, McpRelayRequest } from "./mcp"
import type { AuthorizationContext, AuthorizationRequest, AuthorizationResponse } from "./mcp-events"

export type RelayConnection = {
  readonly connectionID: string
  readonly role: "agent" | "client"
  readonly ownerID: string
  readonly deviceID: string
  readonly browserSessionID: string
  readonly credentialExpiresAt: number
}
export type OfflineCheck = { readonly ownerID: string; readonly deviceID: string; readonly closedAt: number }
export type RelayAuthority =
  | { readonly ok: true; readonly ownerID: string }
  | { readonly ok: false; readonly reason: string }
export type QuotaDelivery = {
  readonly subscriptions: (ownerID: string) => Promise<readonly PushSubscription[]>
  readonly reserve: (
    ownerID: string,
    key: string,
    until: number,
    members: readonly string[],
  ) => Promise<QuotaReservation>
  readonly release: (ownerID: string, key: string, members: readonly string[]) => Promise<void>
  readonly push: (
    ownerID: string,
    event: QuotaPushEvent,
    subscriptions: readonly PushSubscription[],
  ) => Promise<readonly PushOutcome[]>
}
export type RelayDeps = {
  readonly now: () => number
  readonly monotonic: () => number
  readonly newID: () => string
  readonly send: (connectionID: string, message: Uint8Array) => void
  readonly close: (connectionID: string, code: number, reason: string) => void
  readonly notices: NoticeStore
  readonly authorizeClientCommand: (sessionID: string, deviceID: string) => Promise<RelayAuthority>
  readonly authorizeAgentCommand: (deviceID: string) => Promise<RelayAuthority>
  readonly loadOfflineCheck: () => Promise<OfflineCheck | undefined>
  readonly saveOfflineCheck: (check: OfflineCheck | undefined) => Promise<void>
  readonly notifyPush?: (ownerID: string, event: PushEvent) => Promise<readonly PushOutcome[]>
  readonly mcp?: Omit<McpRelayDeps, "now" | "reservation">
  readonly quota?: QuotaDelivery
}
type Peer = {
  identity: RelayConnection
  connection: Connection
  seenAt: number
  notices: boolean
  requests: Map<string, Admission>
  subscriptions: Map<string, { scope: Scope; epoch: string; operation: OperationDescriptor; requestID: string }>
}
type Admission = {
  peer: Peer
  dispatch: Extract<Decision, { type: "dispatch" }>
  cancelled: boolean
  agentID?: string
  agent?: Peer
  transferID?: string
  clientTransferID?: string
  interest?: boolean
  subscription?: { id: string; scope: Scope; epoch: string }
  start?: BulkStart
  mime?: string
}
type Forward = {
  from: Peer
  ledger: LedgerClass
  ordinal: bigint
  to: Peer
  key: string
  requestID?: string
  handed?: bigint
  handedLedger?: LedgerClass
  ticket?: bigint
  httpIndex?: bigint
}
type HttpRead = {
  admission: Admission
  controller: ReadableStreamDefaultController<Uint8Array>
  signal: AbortSignal
  abort: () => void
  closed: boolean
  bodyEnded: boolean
}

export function createRelay(deps: RelayDeps) {
  const budget = new ReservationBudget(RelayLimits.applicationBytes)
  const sourceEpoch = deps.newID()
  const peers = new Map<string, Peer>()
  const agentRequests = new Map<string, Admission>()
  const forwards = new Set<Forward>()
  const heldInputs = new Set<string>()
  const lanes = new Map<string, Promise<void>>()
  const deliveries = new Set<Promise<void>>()
  const backendEpochs = new Map<string, { epoch: string; bytes: number }>()
  const acceptedInterests = new Map<string, Scope>()
  const httpReads = new Map<Admission, HttpRead>()
  const bulkWaiters = new Set<() => void>()
  let agent: Peer | undefined
  let identity: { ownerID: string; deviceID: string } | undefined
  let statusBytes: Uint8Array | undefined
  let offline: OfflineCheck | undefined
  let offlineLoaded = false
  let noticeFault = deps.notices.unavailable()
  let pushWindow = deps.monotonic()
  let pushCount = 0
  const summarized = new Set<PushEvent["category"]>()
  const mcp = deps.mcp && createMcpRelay({ ...deps.mcp, now: deps.now, reservation: budget })
  const mcpTransfers = new Map<string, McpTransfer>()

  function alive(peer: Peer) {
    return peers.get(peer.identity.connectionID) === peer && peer.connection.state !== "closed"
  }
  function decisions(peer: Peer, entries: readonly Decision[]) {
    for (const entry of entries) {
      if (entry.type === "eventBatchReleased") {
        for (const forward of forwards)
          if (forward.to === peer && forward.ticket === entry.ticket) releaseForward(forward)
      }
      if (entry.type === "closed") drop(peer, entry.code, FailureCategory[entry.category])
      if (entry.type === "httpBulkReleased") {
        for (const forward of forwards)
          if (
            forward.to === peer &&
            forward.key.startsWith(`http:${entry.transferID}:`) &&
            forward.httpIndex !== undefined &&
            forward.httpIndex <= entry.through
          )
            releaseForward(forward)
        notifyBulk()
      }
    }
  }
  function consume(peer: Peer, ledger: LedgerClass, ordinal: bigint) {
    if (alive(peer)) decisions(peer, peer.connection.consume(ledger, ordinal, deps.monotonic()))
  }
  function releaseForward(forward: Forward) {
    if (!forwards.delete(forward)) return
    budget.release(RelayLimits.forwardingMetadataBytes)
    if (
      !heldInputs.has(inputKey(forward.from, forward.ledger, forward.ordinal)) &&
      ![...forwards].some(
        (item) => item.from === forward.from && item.ledger === forward.ledger && item.ordinal === forward.ordinal,
      )
    )
      consume(forward.from, forward.ledger, forward.ordinal)
    notifyBulk()
  }
  function receipts() {
    for (const forward of forwards) {
      if (!alive(forward.to)) {
        releaseForward(forward)
        continue
      }
      if (forward.handed === undefined || forward.handedLedger === undefined) continue
      if (forward.ticket !== undefined) continue
      const ledger = forward.to.connection.ledger(forward.handedLedger)
      if (forward.handed <= ledger.sentOrdinal - BigInt(ledger.handedCount)) releaseForward(forward)
    }
  }
  function flush(peer: Peer) {
    if (!alive(peer)) return
    const entries: Decision[] = []
    while (alive(peer)) {
      const now = deps.monotonic()
      const prepared = peer.connection.prepareHandoff(now)
      entries.push(...peer.connection.takeDecisions())
      if (!prepared) break
      if (!peer.connection.reservation.reserve(prepared.reservedBytes)) {
        peer.connection.abortPrepared(prepared)
        entries.push(...peer.connection.close(FailureCategory.LIMIT))
        break
      }
      try {
        const frame = prepared.frame
        const bytes = encodeStrict(FrameSchema, frame)
        entries.push(...peer.connection.handoff(prepared, bytes.byteLength, now))
        if (peer.connection.state === "closed") break
        const key = frameKey(frame)
        const forward = [...forwards].find((item) => item.to === peer && item.key === key && item.handed === undefined)
        if (forward) {
          forward.handed = frame.deliveryOrdinal
          forward.handedLedger = frame.ledger
        }
        if (frame.body.case === "result" && frame.body.value.outcome.case === "success") {
          const requestID = frame.body.value.requestId
          const subscription = [...peer.subscriptions].find(([, item]) => item.requestID === requestID)
          if (subscription)
            decisions(
              peer,
              peer.connection.acceptSubscription(
                frame.body.value.requestId,
                subscription[0],
                subscription[1].scope,
                deps.monotonic(),
                "send",
                subscription[1].epoch,
              ),
            )
        }
        deps.send(peer.identity.connectionID, bytes)
      } finally {
        peer.connection.reservation.release(prepared.reservedBytes)
      }
    }
    decisions(peer, entries)
  }
  function flushAll() {
    receipts()
    for (const peer of peers.values()) flush(peer)
  }
  function finish(admission: Admission) {
    if (!admission.peer.requests.delete(admission.dispatch.requestID)) return
    if (admission.agentID !== undefined) agentRequests.delete(admission.agentID)
    budget.release(RelayLimits.forwardingMetadataBytes)
  }
  function notifyBulk() {
    for (const waiter of bulkWaiters) waiter()
  }
  function waitBulk(predicate: () => boolean) {
    if (predicate()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!predicate()) return
        bulkWaiters.delete(check)
        resolve()
      }
      bulkWaiters.add(check)
    })
  }
  function startConsumed(admission: Admission) {
    return (
      !!admission.clientTransferID &&
      ![...forwards].some(
        (forward) => forward.to === admission.peer && forward.key === `bulkStart:${admission.clientTransferID}`,
      )
    )
  }
  function stopHttp(admission: Admission, error?: Error) {
    const read = httpReads.get(admission)
    if (!read || read.closed) return
    read.closed = true
    httpReads.delete(admission)
    read.signal.removeEventListener("abort", read.abort)
    budget.release(RelayLimits.peerMetadataBytes)
    sealHttp(read, error)
    notifyBulk()
  }
  function sealHttp(read: HttpRead, error?: Error) {
    if (read.bodyEnded) return
    read.bodyEnded = true
    if (error) read.controller.error(error)
    else read.controller.close()
  }
  function cancelHttp(admission: Admission) {
    if (admission.cancelled) return
    admission.cancelled = true
    stopHttp(admission, new Error("HTTP transfer cancelled"))
    if (admission.clientTransferID)
      decisions(admission.peer, admission.peer.connection.cancelTransfer(admission.clientTransferID, deps.monotonic()))
    if (admission.agent && admission.agentID)
      decisions(admission.agent, admission.agent.connection.cancel(admission.agentID, deps.monotonic()))
    for (const forward of forwards)
      if (forward.to === admission.peer && forward.requestID === admission.dispatch.requestID) releaseForward(forward)
    finish(admission)
    notifyBulk()
    flushAll()
  }
  function interestSessions(peer: Peer) {
    return [
      ...new Set([
        ...[...peer.subscriptions.values()].flatMap((item) =>
          item.scope.target.case === "session" ? [item.scope.target.value] : [],
        ),
        ...[...peer.requests.values()].flatMap((item) =>
          item.interest && !item.cancelled && item.dispatch.request.scope?.target.case === "session"
            ? [item.dispatch.request.scope.target.value]
            : [],
        ),
      ]),
    ]
  }
  function sendInterestSnapshot(peer: Peer, released = false) {
    const current = agent
    if (!current || !alive(current) || current.connection.state !== "established") return
    const sessionIds = released ? [] : interestSessions(peer)
    const union = new Set(
      [...peers.values()]
        .filter((item) => item.identity.role === "client" && item !== peer)
        .flatMap(interestSessions)
        .concat(sessionIds),
    )
    if (sessionIds.length > WireLimit.SUBSCRIPTIONS || union.size > WireLimit.SUBSCRIPTIONS) {
      drop(peer, 1009, "LIMIT")
      return
    }
    queued(current, {
      case: "control",
      value: create(ControlSchema, {
        kind: {
          case: "subscriptionSnapshot",
          value: create(SubscriptionSnapshotSchema, { clientId: peer.identity.connectionID, sessionIds }),
        },
      }),
    })
    for (const [id, entry] of backendEpochs) {
      if (union.has(id)) continue
      budget.release(entry.bytes)
      backendEpochs.delete(id)
    }
    for (const [id, scope] of acceptedInterests) {
      if (scope.target.case === "session" && union.has(scope.target.value)) continue
      decisions(current, current.connection.releaseSubscription(id, deps.monotonic()))
      acceptedInterests.delete(id)
      budget.release(RelayLimits.forwardingMetadataBytes)
    }
  }
  function drop(peer: Peer, code: number, reason: string) {
    if (peers.get(peer.identity.connectionID) !== peer) return
    if (peer.identity.role === "client") sendInterestSnapshot(peer, true)
    budget.release(peer.subscriptions.size * RelayLimits.forwardingMetadataBytes)
    peer.subscriptions.clear()
    peers.delete(peer.identity.connectionID)
    peer.connection.close(FailureCategory.EPOCH, code)
    budget.release(RelayLimits.peerMetadataBytes)
    for (const admission of peer.requests.values()) {
      admission.cancelled = true
      stopHttp(admission, new Error("HTTP owning connection closed"))
      if (admission.agent && alive(admission.agent) && admission.agentID !== undefined)
        decisions(admission.agent, admission.agent.connection.cancel(admission.agentID, deps.monotonic()))
      finish(admission)
    }
    for (const forward of forwards) if (forward.from === peer || forward.to === peer) releaseForward(forward)
    deps.close(peer.identity.connectionID, code, reason)
    if (agent === peer) {
      agent = undefined
      for (const transfer of mcpTransfers.values()) budget.release(transfer.data.length)
      mcpTransfers.clear()
      mcp?.clearAgent(peer.identity.connectionID)
      for (const admission of [...agentRequests.values()]) drop(admission.peer, 1012, "EPOCH")
      agentRequests.clear()
      for (const entry of backendEpochs.values()) budget.release(entry.bytes)
      backendEpochs.clear()
      budget.release(acceptedInterests.size * RelayLimits.forwardingMetadataBytes)
      acceptedInterests.clear()
    }
    notifyBulk()
  }
  async function authorize(peer: Peer) {
    if (!alive(peer)) return false
    if (deps.now() >= peer.identity.credentialExpiresAt) {
      drop(peer, 4401, "DIRECTION")
      return false
    }
    const authority =
      peer.identity.role === "agent"
        ? await deps.authorizeAgentCommand(peer.identity.deviceID)
        : await deps.authorizeClientCommand(peer.identity.browserSessionID, peer.identity.deviceID)
    if (!alive(peer)) return false
    if (deps.now() >= peer.identity.credentialExpiresAt) {
      drop(peer, 4401, "DIRECTION")
      return false
    }
    if (!authority.ok || authority.ownerID !== peer.identity.ownerID) {
      drop(
        peer,
        !authority.ok && ["revoked_session", "expired_session"].includes(authority.reason) ? 4401 : 4403,
        "DIRECTION",
      )
      return false
    }
    return true
  }
  function queued(peer: Peer, body: Frame["body"]) {
    if (!alive(peer)) return false
    const copyReservation = WireLimit.SERVER_FRAME_BYTES + 256
    if (!budget.reserve(copyReservation)) {
      drop(peer, 1009, "LIMIT")
      return false
    }
    try {
      decisions(peer, peer.connection.enqueue(body, frameReservation(body), deps.monotonic()))
    } finally {
      budget.release(copyReservation)
    }
    return alive(peer)
  }
  function forward(from: Peer, frame: Frame, to: Peer, body: Frame["body"], requestID?: string) {
    if (!budget.reserve(RelayLimits.forwardingMetadataBytes)) {
      drop(to, 1009, "LIMIT")
      if (
        !heldInputs.has(inputKey(from, frame.ledger, frame.deliveryOrdinal)) &&
        ![...forwards].some(
          (item) => item.from === from && item.ledger === frame.ledger && item.ordinal === frame.deliveryOrdinal,
        )
      )
        consume(from, frame.ledger, frame.deliveryOrdinal)
      return false
    }
    const record: Forward = {
      from,
      ledger: frame.ledger,
      ordinal: frame.deliveryOrdinal,
      to,
      key: frameKey(create(FrameSchema, { body })),
      requestID: requestID ?? (body.case === "result" ? body.value.requestId : undefined),
    }
    forwards.add(record)
    if (!queued(to, body)) {
      releaseForward(record)
      return false
    }
    return true
  }
  function reply(admission: Admission, typeName: string, payload: Uint8Array, error = false) {
    const operation = admission.dispatch.operation
    queued(admission.peer, {
      case: "result",
      value: create(ResultSchema, {
        requestId: admission.dispatch.requestID,
        operationId: operation.operationId,
        settlement: operation.settlement,
        outcome: { case: error ? "error" : "success", value: create(TypedPayloadSchema, { typeName, payload }) },
      }),
    })
    consume(admission.peer, LedgerClass.NORMAL, admission.dispatch.ordinal)
    finish(admission)
  }
  function noticeError(admission: Admission) {
    reply(
      admission,
      Connector_ErrorSchema.typeName,
      encodeStrict(
        Connector_ErrorSchema,
        create(Connector_ErrorSchema, {
          code: Connector_Error_code.CONNECTOR_ERROR_CODE_INTERNAL_ERROR,
          message: encodeLossless("Notification storage is unavailable"),
        }),
      ),
      true,
    )
  }
  function inLane(key: string, operation: () => Promise<void>) {
    const current = (lanes.get(key) ?? Promise.resolve()).then(operation, operation)
    const settled = current.then(
      () => undefined,
      () => undefined,
    )
    lanes.set(key, settled)
    void settled.then(() => {
      if (lanes.get(key) === settled) lanes.delete(key)
    })
    return current
  }
  async function noticeToClients(notice: Notice) {
    await Promise.all(
      [...peers.values()]
        .filter((peer) => peer.notices)
        .map(async (peer) => {
          if (await authorize(peer))
            queued(peer, { case: "control", value: create(ControlSchema, { kind: { case: "notice", value: notice } }) })
        }),
    )
    flushAll()
  }
  async function answerNotice(admission: Admission) {
    if (!budget.reserve(32 * 1024)) {
      drop(admission.peer, 1009, "LIMIT")
      return
    }
    try {
      const name = admission.dispatch.operation.diagnosticName
      if (name === "notice.list" || name === "notice.subscribe") {
        const before =
          name === "notice.list"
            ? decodeLossless(decodeStrict(ConnectorNoticeBeforeSchema, admission.dispatch.request.payload).before!)
            : undefined
        const page = deps.notices.page(before ? noticeSequence(before) : undefined)
        if (name === "notice.subscribe") admission.peer.notices = true
        reply(
          admission,
          ConnectorNoticePageSchema.typeName,
          encodeStrict(
            ConnectorNoticePageSchema,
            create(ConnectorNoticePageSchema, {
              notice: added(page.notices, page.total),
              next: page.next,
              unavailable: noticeFault,
            }),
          ),
        )
        return
      }
      const notification =
        name === "notice.readAll"
          ? create(NoticeSchema, { kind: { case: "cleared", value: {} } })
          : (() => {
              const input = decodeStrict(ConnectorNoticeIDsSchema, admission.dispatch.request.payload)
              const removed = deps.notices.remove(input.ids.flatMap((id) => noticeSequence(id) ?? []))
              return create(NoticeSchema, {
                kind: { case: "removed", value: { ids: [...removed.ids], total: BigInt(removed.total) } },
              })
            })()
      if (name === "notice.readAll") {
        deps.notices.clear()
        noticeFault = false
      }
      reply(
        admission,
        ConnectorNoticeSettlementSchema.typeName,
        encodeStrict(
          ConnectorNoticeSettlementSchema,
          create(ConnectorNoticeSettlementSchema, { data: {}, notification }),
        ),
      )
      await noticeToClients(notification)
    } catch {
      noticeFault = true
      noticeError(admission)
    } finally {
      budget.release(32 * 1024)
    }
  }
  async function admit(admission: Admission) {
    const peer = admission.peer
    if (!(await authorize(peer)) || admission.cancelled || !alive(peer)) {
      finish(admission)
      return
    }
    const operation = admission.dispatch.operation
    if (operation.diagnosticName.startsWith("notice.")) {
      await answerNotice(admission)
      return
    }
    const current = agent
    if (!current || current.connection.state !== "established") {
      drop(peer, 1012, "EPOCH")
      return
    }
    if (!(await authorize(current)) || agent !== current) {
      if (alive(peer) && !admission.cancelled) drop(peer, 1012, "EPOCH")
      finish(admission)
      return
    }
    if (!alive(peer) || admission.cancelled) {
      finish(admission)
      return
    }
    if (operation.diagnosticName === "event.unsubscribe") {
      const id = decodeStrict(event_unsubscribe_RequestSchema, admission.dispatch.request.payload).subscriptionId
      const subscription = peer.subscriptions.get(id)
      if (
        !subscription ||
        subscription.scope.target.case !== "session" ||
        admission.dispatch.request.scope?.target.case !== "session" ||
        subscription.scope.target.value !== admission.dispatch.request.scope.target.value
      ) {
        drop(peer, 4403, "DIRECTION")
        return
      }
      peer.subscriptions.delete(id)
      budget.release(RelayLimits.forwardingMetadataBytes)
      decisions(peer, peer.connection.releaseSubscription(id, deps.monotonic(), "send"))
      decisions(peer, peer.connection.takeDecisions())
      sendInterestSnapshot(peer)
      reply(
        admission,
        event_unsubscribe_ResultSchema.typeName,
        encodeStrict(event_unsubscribe_ResultSchema, create(event_unsubscribe_ResultSchema, { data: {} })),
      )
      return
    }
    if (operation.streaming === Streaming.EVENTS) {
      const scope = admission.dispatch.request.scope
      if (scope?.target.case !== "session") {
        drop(peer, 4403, "DIRECTION")
        return
      }
      if (operation.diagnosticName === "event.subscribe") {
        const target = decodeStrict(event_subscribe_RequestSchema, admission.dispatch.request.payload).scope
        if (target?.target.case !== "session" || target.target.value !== scope.target.value) {
          drop(peer, 4403, "DIRECTION")
          return
        }
      }
      admission.interest = true
      sendInterestSnapshot(peer)
      if (!alive(peer)) return
    }
    if (!budget.reserve(RelayLimits.forwardingMetadataBytes)) {
      drop(peer, 1009, "LIMIT")
      return
    }
    const request = admission.dispatch.request
    const record: Forward = {
      from: peer,
      ledger: LedgerClass.NORMAL,
      ordinal: admission.dispatch.ordinal,
      to: current,
      key: "",
    }
    forwards.add(record)
    const copyReservation = WireLimit.CLIENT_FRAME_BYTES + 256
    if (!budget.reserve(copyReservation)) {
      releaseForward(record)
      drop(peer, 1009, "LIMIT")
      return
    }
    const reserved = frameReservation({ case: "request", value: { ...request, requestId: "18446744073709551615" } })
    budget.release(copyReservation)
    const outgoing = current.connection.request(
      request.operationId,
      request.scope!,
      request.payload,
      reserved,
      deps.monotonic(),
    )
    decisions(current, outgoing.decisions)
    if (!outgoing.requestID || !alive(current)) {
      releaseForward(record)
      drop(peer, 1012, "EPOCH")
      return
    }
    admission.agentID = outgoing.requestID
    admission.agent = current
    record.key = `request:${outgoing.requestID}`
    agentRequests.set(outgoing.requestID, admission)
    flushAll()
  }
  function rollPushWindow() {
    if (deps.monotonic() - pushWindow >= 60_000) {
      pushWindow = deps.monotonic()
      pushCount = 0
      summarized.clear()
    }
  }
  async function alerts(
    ownerID: string,
    events: readonly { event: Exclude<PushEvent, QuotaPushEvent>; presentation: Presentation }[],
  ) {
    rollPushWindow()
    for (const item of events) {
      const bounded = pushCount < 20
      const overflow = !bounded && !summarized.has(item.event.category)
      if (overflow) summarized.add(item.event.category)
      if (bounded) pushCount++
      const event: Exclude<PushEvent, QuotaPushEvent> =
        bounded || item.event.category === "machine-offline"
          ? item.event
          : { category: item.event.category, deviceID: item.event.deviceID, overflow: events.length }
      const reservation = 32 * 1024
      if (!budget.reserve(reservation)) {
        for (const peer of peers.values())
          if (peer.notices && peer.identity.ownerID === ownerID) drop(peer, 1009, "LIMIT")
        continue
      }
      const delivery = Promise.resolve()
        .then(async () => {
          const outcomes =
            deps.notifyPush && (bounded || overflow) ? await deps.notifyPush(ownerID, event).catch(() => []) : []
          const presented = new Set<string>()
          for (const peer of peers.values()) {
            if (
              !peer.notices ||
              presented.has(peer.identity.browserSessionID) ||
              outcomes.some(
                (outcome) => outcome.owner === peer.identity.browserSessionID && outcome.outcome === "accepted",
              )
            )
              continue
            if (!(await authorize(peer))) continue
            presented.add(peer.identity.browserSessionID)
            queued(peer, {
              case: "control",
              value: create(ControlSchema, {
                kind: { case: "notice", value: { kind: { case: "present", value: { items: [item.presentation] } } } },
              }),
            })
          }
          flushAll()
        })
        .finally(() => {
          deliveries.delete(delivery)
          budget.release(reservation)
        })
      deliveries.add(delivery)
    }
  }
  async function recordNotices(
    owner: Peer,
    events: readonly NoticeEvent[],
    detailOf?: (sessionID: string) => RemoteAlertDetail,
  ) {
    const appended = deps.notices.append(events)
    const repeated = deps.notices.repeat(
      events.filter((event) => !appended.notices.some((notice) => notice.sessionID === event.sessionID)),
    )
    for (let start = 0; start < appended.notices.length; start += RemoteLimits.maxNoticeBatch)
      await noticeToClients(added(appended.notices.slice(start, start + RemoteLimits.maxNoticeBatch), appended.total))
    await alerts(
      owner.identity.ownerID,
      [...appended.notices, ...repeated].map((notice) => {
        const need = events.find((event) => event.sessionID === notice.sessionID)?.need
        const detail = {
          ...detailOf?.(notice.sessionID),
          ...(need === undefined ? {} : { need }),
          ...(repeated.includes(notice) ? { repeat: true as const } : {}),
        }
        return {
          event: {
            category: notice.category,
            sessionID: notice.sessionID,
            deviceID: owner.identity.deviceID,
            noticeID: notice.id,
            ...detail,
          },
          presentation: create(PresentationSchema, {
            kind: { case: "notice", value: { notice: noticeRecord(notice), detail: wireDetail(detail) } },
          }),
        }
      }),
    )
  }
  async function agentControl(peer: Peer, frame: Frame, byteLength: number) {
    if (frame.body.case !== "control" || !(await authorize(peer))) return
    const control = frame.body.value.kind
    const key = inputKey(peer, frame.ledger, frame.deliveryOrdinal)
    heldInputs.add(key)
    const materializationBytes =
      (control.case === "status"
        ? control.value.attention.length
        : control.case === "completions"
          ? control.value.items.length
          : control.case === "blocked"
            ? 1
            : 0) * 1024
    if (!budget.reserve(materializationBytes)) {
      heldInputs.delete(key)
      drop(peer, 1009, "LIMIT")
      return
    }
    try {
      if (control.case === "status") {
        const status = control.value
        if (!budget.reserve(byteLength)) {
          heldInputs.delete(key)
          drop(peer, 1009, "LIMIT")
          return
        }
        const prior = statusBytes ? decodeStrict(ControlSchema, statusBytes).kind : undefined
        const oldAttention = prior?.case === "status" ? new Set(prior.value.attention) : undefined
        const bytes = encodeStrict(ControlSchema, frame.body.value)
        budget.release(byteLength - bytes.length)
        if (statusBytes) budget.release(statusBytes.length)
        statusBytes = bytes
        await Promise.all(
          [...peers.values()]
            .filter((client) => client.identity.role === "client" && client.connection.state === "established")
            .map(async (client) => {
              if (await authorize(client)) forward(peer, frame, client, frame.body)
            }),
        )
        flushAll()
        if (oldAttention)
          await recordNotices(
            peer,
            status.attention
              .filter((sessionID) => !oldAttention.has(sessionID))
              .map((sessionID): NoticeEvent => {
                const detail = status.details?.items.find((item) => item.sessionId === sessionID)
                return {
                  category: "approval-requested",
                  sessionID,
                  createdAt: deps.now(),
                  need: status.lost?.items.includes(sessionID)
                    ? "lost"
                    : status.failed?.items.includes(sessionID)
                      ? "failed"
                      : attentionNeed(detail?.need),
                }
              }),
            (sessionID) => {
              const title = status.details?.items.find((item) => item.sessionId === sessionID)?.title
              return title === undefined ? {} : { title: decodeLossless(title) }
            },
          )
        heldInputs.delete(key)
        if (![...forwards].some((entry) => entry.from === peer && entry.ordinal === frame.deliveryOrdinal))
          consume(peer, frame.ledger, frame.deliveryOrdinal)
        return
      }
      if (control.case === "completions") {
        if (
          control.value.items.some(
            (item) =>
              item.sequence > BigInt(Number.MAX_SAFE_INTEGER) ||
              item.createdMs > BigInt(Number.MAX_SAFE_INTEGER) ||
              item.createdMs < BigInt(Number.MIN_SAFE_INTEGER),
          )
        ) {
          heldInputs.delete(key)
          drop(peer, 1009, "LIMIT")
          return
        }
        const recorded = deps.notices.complete(
          control.value.items.map((item) => ({
            id: item.id,
            seq: Number(item.sequence),
            created: Number(item.createdMs),
            sessionID: item.sessionId,
          })),
          control.value.more,
        )
        for (let start = 0; start < recorded.notices.length; start += RemoteLimits.maxNoticeBatch)
          await noticeToClients(
            added(recorded.notices.slice(start, start + RemoteLimits.maxNoticeBatch), recorded.total),
          )
        await alerts(
          peer.identity.ownerID,
          recorded.notices.map((notice) => {
            const title = control.value.items.find((item) => item.sessionId === notice.sessionID)?.title
            const detail = title === undefined ? {} : { title: decodeLossless(title) }
            return {
              event: {
                category: notice.category,
                sessionID: notice.sessionID,
                deviceID: peer.identity.deviceID,
                noticeID: notice.id,
                ...detail,
              },
              presentation: create(PresentationSchema, {
                kind: { case: "notice", value: { notice: noticeRecord(notice), detail: wireDetail(detail) } },
              }),
            }
          }),
        )
      }
      if (control.case === "blocked")
        await recordNotices(
          peer,
          [
            {
              category: "approval-requested",
              sessionID: control.value.sessionId,
              createdAt: deps.now(),
              need: "blocked",
            },
          ],
          () => (control.value.title === undefined ? {} : { title: decodeLossless(control.value.title) }),
        )
      if (control.case === "inventoryInvalidated")
        await Promise.all(
          [...peers.values()]
            .filter((client) => client.identity.role === "client" && client.connection.state === "established")
            .map(async (client) => {
              if (await authorize(client)) forward(peer, frame, client, frame.body)
            }),
        )
    } catch {
      noticeFault = true
      deps.notices.markUnavailable()
      await noticeToClients(create(NoticeSchema, { kind: { case: "unavailable", value: {} } }))
    } finally {
      budget.release(materializationBytes)
    }
    heldInputs.delete(key)
    if (![...forwards].some((entry) => entry.from === peer && entry.ordinal === frame.deliveryOrdinal))
      consume(peer, frame.ledger, frame.deliveryOrdinal)
  }
  async function forwardBulk(peer: Peer, frame: Frame, admission: Admission) {
    if (frame.body.case !== "bulkStart") {
      await waitBulk(
        () =>
          admission.cancelled ||
          !alive(peer) ||
          !alive(admission.peer) ||
          startConsumed(admission) ||
          httpReads.has(admission),
      )
    }
    if (
      admission.cancelled ||
      admission.agent !== peer ||
      !(await authorize(peer)) ||
      !(await authorize(admission.peer))
    ) {
      consume(peer, frame.ledger, frame.deliveryOrdinal)
      return
    }
    if (!alive(peer) || !alive(admission.peer)) return
    if (frame.body.case === "bulkStart") {
      forward(
        peer,
        frame,
        admission.peer,
        {
          case: "bulkStart",
          value: {
            ...frame.body.value,
            requestId: admission.dispatch.requestID,
            transferId: admission.clientTransferID!,
          },
        },
        admission.dispatch.requestID,
      )
    }
    if (frame.body.case === "bulkPiece")
      if (httpReads.has(admission)) {
        const piece = frame.body.value
        for (;;) {
          await waitBulk(
            () =>
              admission.cancelled ||
              !alive(peer) ||
              !alive(admission.peer) ||
              admission.peer.connection.httpWindowAvailable >= piece.data.length,
          )
          if (admission.cancelled || !(await authorize(peer)) || !(await authorize(admission.peer))) {
            consume(peer, frame.ledger, frame.deliveryOrdinal)
            return
          }
          const read = httpReads.get(admission)
          if (!read || read.closed || admission.cancelled) {
            consume(peer, frame.ledger, frame.deliveryOrdinal)
            return
          }
          if (!budget.reserve(RelayLimits.forwardingMetadataBytes)) {
            drop(admission.peer, 1009, "LIMIT")
            consume(peer, frame.ledger, frame.deliveryOrdinal)
            return
          }
          const handed = admission.peer.connection.handoffHttpPiece(
            { ...piece, transferId: admission.clientTransferID! },
            deps.monotonic(),
          )
          decisions(admission.peer, handed.decisions)
          if (!handed.accepted) {
            budget.release(RelayLimits.forwardingMetadataBytes)
            if (!alive(admission.peer)) {
              consume(peer, frame.ledger, frame.deliveryOrdinal)
              return
            }
            continue
          }
          forwards.add({
            from: peer,
            to: admission.peer,
            ledger: frame.ledger,
            ordinal: frame.deliveryOrdinal,
            key: `http:${admission.clientTransferID}:${piece.index}`,
            httpIndex: BigInt(piece.index + 1),
            requestID: admission.dispatch.requestID,
          })
          read.controller.enqueue(piece.data.slice())
          return
        }
      } else
        forward(
          peer,
          frame,
          admission.peer,
          { case: "bulkPiece", value: { ...frame.body.value, transferId: admission.clientTransferID! } },
          admission.dispatch.requestID,
        )
    if (frame.body.case === "bulkEnd") {
      if (httpReads.has(admission)) {
        sealHttp(
          httpReads.get(admission)!,
          frame.body.value.outcome.case === "error" ? new Error("HTTP transfer failed") : undefined,
        )
        await waitBulk(
          () =>
            admission.cancelled ||
            !alive(peer) ||
            !alive(admission.peer) ||
            admission.peer.connection.httpBulkConsumed(admission.clientTransferID!),
        )
        if (admission.cancelled || !(await authorize(peer)) || !(await authorize(admission.peer))) {
          consume(peer, frame.ledger, frame.deliveryOrdinal)
          return
        }
        stopHttp(admission, frame.body.value.outcome.case === "error" ? new Error("HTTP transfer failed") : undefined)
      }
      forward(
        peer,
        frame,
        admission.peer,
        { case: "bulkEnd", value: { ...frame.body.value, transferId: admission.clientTransferID! } },
        admission.dispatch.requestID,
      )
      finish(admission)
    }
    flushAll()
  }
  function registerResult(peer: Peer, frame: Frame, admission: Admission) {
    const operation = admission.dispatch.operation
    if (
      frame.body.case === "result" &&
      operation.streaming === Streaming.EVENTS &&
      frame.body.value.outcome.case === "success"
    ) {
      const scope = admission.dispatch.request.scope!
      if (scope.target.case !== "session") {
        drop(admission.peer, 4403, "DIRECTION")
        return
      }
      const epoch = backendEpochs.get(scope.target.value)?.epoch
      if (!epoch) {
        drop(admission.peer, 1012, "EPOCH")
        consume(peer, frame.ledger, frame.deliveryOrdinal)
        return
      }
      const payload = frame.body.value.outcome.value.payload
      const id = decodeLossless(
        operation.diagnosticName === "session.log"
          ? decodeStrict(session_log_ResultSchema, payload).subscriptionId!
          : decodeStrict(event_subscribe_ResultSchema, payload).subscriptionId!,
      )
      const charge = acceptedInterests.has(id) ? 0 : RelayLimits.forwardingMetadataBytes
      if (!budget.reserve(charge)) {
        drop(admission.peer, 1009, "LIMIT")
        consume(peer, frame.ledger, frame.deliveryOrdinal)
        return
      }
      decisions(
        peer,
        peer.connection.acceptSubscription(admission.agentID!, id, scope, deps.monotonic(), "receive", epoch),
      )
      if (!alive(peer)) {
        budget.release(charge)
        return
      }
      acceptedInterests.set(id, scope)
      admission.subscription = { id, scope, epoch }
    }
  }
  async function result(peer: Peer, frame: Frame, admission: Admission) {
    if (
      !(await authorize(peer)) ||
      !(await authorize(admission.peer)) ||
      admission.cancelled ||
      admission.peer.requests.get(admission.dispatch.requestID) !== admission ||
      frame.body.case !== "result"
    ) {
      consume(peer, frame.ledger, frame.deliveryOrdinal)
      return
    }
    const subscription = admission.subscription
    if (subscription) {
      if (!admission.peer.subscriptions.has(subscription.id) && !budget.reserve(RelayLimits.forwardingMetadataBytes)) {
        drop(admission.peer, 1009, "LIMIT")
        consume(peer, frame.ledger, frame.deliveryOrdinal)
        return
      }
      admission.peer.subscriptions.set(subscription.id, {
        scope: subscription.scope,
        epoch: subscription.epoch,
        operation: admission.dispatch.operation,
        requestID: admission.dispatch.requestID,
      })
    }
    forward(peer, frame, admission.peer, {
      case: "result",
      value: { ...frame.body.value, requestId: admission.dispatch.requestID },
    })
    finish(admission)
    sendInterestSnapshot(admission.peer)
    flushAll()
  }
  function canonicalEpoch(peer: Peer, scope: Scope, epoch: string) {
    if (peer.identity.role !== "agent" || !alive(peer) || scope.target.case !== "session") return
    const sessionID = scope.target.value
    if (![...peers.values()].some((item) => interestSessions(item).includes(sessionID))) {
      drop(peer, 1002, "DIRECTION")
      return
    }
    const previous = backendEpochs.get(scope.target.value)
    if (previous && previous.epoch !== epoch) {
      for (const client of [...peers.values()])
        if (client.identity.role === "client" && interestSessions(client).includes(scope.target.value))
          drop(client, 1012, "EPOCH")
      return
    }
    if (previous) return
    const bytes = epoch.length * 3 + RelayLimits.forwardingMetadataBytes
    if (!budget.reserve(bytes)) {
      drop(peer, 1009, "LIMIT")
      return
    }
    backendEpochs.set(scope.target.value, { epoch, bytes })
  }
  async function events(peer: Peer, entry: Extract<Decision, { type: "events" }>) {
    if (!(await authorize(peer)) || entry.ordinal === undefined) return
    const key = inputKey(peer, LedgerClass.EVENT, entry.ordinal)
    heldInputs.add(key)
    for (const client of peers.values()) {
      const accepted = client.subscriptions.get(entry.subscriptionID)
      if (!accepted || accepted.epoch !== entry.batch.sourceEpoch || !(await authorize(client))) continue
      if (!budget.reserve(RelayLimits.forwardingMetadataBytes)) {
        drop(client, 1009, "LIMIT")
        continue
      }
      const record: Forward = {
        from: peer,
        ledger: LedgerClass.EVENT,
        ordinal: entry.ordinal,
        to: client,
        key: `events:${entry.subscriptionID}`,
      }
      forwards.add(record)
      const forwarded = client.connection.forwardEventBatch(entry.batch, deps.monotonic())
      record.ticket = forwarded.ticket
      decisions(client, forwarded.decisions)
      if (forwarded.ticket === undefined) releaseForward(record)
    }
    heldInputs.delete(key)
    if (
      ![...forwards].some(
        (item) => item.from === peer && item.ledger === LedgerClass.EVENT && item.ordinal === entry.ordinal,
      )
    )
      consume(peer, LedgerClass.EVENT, entry.ordinal)
    flushAll()
  }
  function mcpPort(peer: Peer) {
    const operation = operations.find((item) => item.diagnosticName === "mcp.request")!
    const scope = create(ScopeSchema, { target: { case: "machine", value: {} } })
    return {
      request: (payload: Uint8Array) => {
        if (!alive(peer) || peer.connection.state !== "established") return undefined
        const outgoing = peer.connection.request(
          operation.operationId,
          scope,
          payload,
          frameReservation({
            case: "request",
            value: create(RequestSchema, {
              requestId: "18446744073709551615",
              operationId: operation.operationId,
              scope,
              payload,
            }),
          }),
          deps.monotonic(),
        )
        decisions(peer, outgoing.decisions)
        if (!outgoing.requestID || !alive(peer)) return undefined
        flushAll()
        return outgoing.requestID
      },
      cancel: (requestID: string) => {
        releaseMcpTransfer(requestID)
        if (!alive(peer)) return "unknown" as const
        const cancelled = peer.connection.cancel(requestID, deps.monotonic())
        decisions(peer, cancelled)
        flushAll()
        return cancelled.some((entry) => entry.type === "settled" && entry.status === "unsent")
          ? ("unsent" as const)
          : ("unknown" as const)
      },
      acknowledge: (state: { readonly id: string; readonly enabled: boolean; readonly epoch: string }) => {
        queued(peer, {
          case: "control",
          value: create(ControlSchema, {
            kind: {
              case: "mcpStateAck",
              value: create(McpStateAckSchema, { id: state.id, enabled: state.enabled, epoch: state.epoch }),
            },
          }),
        })
        flushAll()
      },
    }
  }
  function releaseMcpTransfer(requestID: string) {
    for (const [transferID, transfer] of mcpTransfers) {
      if (transfer.requestID !== requestID) continue
      mcpTransfers.delete(transferID)
      budget.release(transfer.data.length)
    }
  }
  function mcpBulk(peer: Peer, frame: Frame) {
    const relay = mcp!
    const connectionID = peer.identity.connectionID
    consume(peer, frame.ledger, frame.deliveryOrdinal)
    if (frame.body.case === "bulkStart") {
      const start = frame.body.value
      if (start.byteCount > BigInt(McpLimits.responseBytes) || !budget.reserve(Number(start.byteCount))) {
        relay.complete(connectionID, start.requestId, {
          type: "violation",
          code: "message_too_large",
          message: "MCP response exceeds the relay bound",
        })
        return
      }
      mcpTransfers.set(start.transferId, {
        requestID: start.requestId,
        data: new Uint8Array(Number(start.byteCount)),
      })
      return
    }
    if (frame.body.case !== "bulkPiece" && frame.body.case !== "bulkEnd") return
    const transfer = mcpTransfers.get(frame.body.value.transferId)
    if (!transfer) return
    if (frame.body.case === "bulkPiece") {
      transfer.data.set(frame.body.value.data, Number(frame.body.value.offset))
      return
    }
    mcpTransfers.delete(frame.body.value.transferId)
    budget.release(transfer.data.length)
    const settled = transfer.settled
    relay.complete(
      connectionID,
      transfer.requestID,
      mcpOutcome(settled?.status, settled?.status === "success" ? transfer.data : settled?.payload?.payload),
    )
  }
  async function mcpControl(peer: Peer, frame: Frame, state: { id: string; enabled: boolean; epoch: string }) {
    if (!(await authorize(peer))) return
    await mcp?.handleState(peer.identity.connectionID, { id: state.id, enabled: state.enabled, epoch: state.epoch })
    consume(peer, frame.ledger, frame.deliveryOrdinal)
    flushAll()
  }
  async function quotaControl(peer: Peer, frame: Frame, pace: QuotaPace) {
    if (!(await authorize(peer))) return
    const quota = quotaFromWire(pace)
    if (!quota) {
      drop(peer, 1002, "MALFORMED")
      return
    }
    const quotaReservation = 32 * 1024
    if (!budget.reserve(quotaReservation)) {
      drop(peer, 1009, "LIMIT")
      return
    }
    try {
      const status = await deliverQuota(peer, quota)
      if (agent === peer && alive(peer))
        queued(peer, {
          case: "control",
          value: create(ControlSchema, {
            kind: {
              case: "quotaPaceResult",
              value: create(QuotaPaceResultSchema, {
                quota: quotaToWire(quota),
                status: status === "settled" ? QuotaPaceStatus.SETTLED : QuotaPaceStatus.PENDING,
              }),
            },
          }),
        })
    } finally {
      budget.release(quotaReservation)
    }
    consume(peer, frame.ledger, frame.deliveryOrdinal)
    flushAll()
  }
  async function deliverQuota(peer: Peer, quota: RemoteQuota): Promise<"settled" | "pending"> {
    if (quota.resetAt <= deps.now()) return "settled"
    const delivery = deps.quota
    if (!delivery) return "pending"
    rollPushWindow()
    if (pushCount >= 20) return "pending"
    pushCount++
    const windowStart = pushWindow
    const refund = () => {
      if (pushWindow === windowStart && pushCount > 0) pushCount--
    }
    const ownerID = peer.identity.ownerID
    const subscriptions = await delivery.subscriptions(ownerID).catch(() => undefined)
    if (!subscriptions) {
      refund()
      return "pending"
    }
    const owned = new Set(subscriptions.map((subscription) => subscription.browserSessionID))
    const targets = subscriptions.filter((subscription) => subscription.categories["quota-pace"])
    const subscribed = [
      ...new Set([...peers.values()].filter((item) => item.notices).map((item) => item.identity.browserSessionID)),
    ]
    const viewers = subscribed.filter((browserSessionID) => !owned.has(browserSessionID))
    const key = quotaKey(quota)
    const claim = await delivery
      .reserve(ownerID, key, quota.resetAt + quotaClaimGraceMs, [
        ...subscribed.map(noticeMember),
        ...targets.map((subscription) => browserMember(subscription.browserSessionID)),
        ...viewers.map(browserMember),
      ])
      .catch(() => undefined)
    if (claim?.status !== "reserved") {
      refund()
      return "pending"
    }
    const granted = new Set(claim.granted)
    const pushed = targets.filter((subscription) => granted.has(browserMember(subscription.browserSessionID)))
    if (pushed.length === 0) refund()
    const wire = quotaToWire(quota)
    const noticed = new Set(subscribed.filter((browserSessionID) => granted.has(noticeMember(browserSessionID))))
    const presented = new Set(viewers.filter((browserSessionID) => granted.has(browserMember(browserSessionID))))
    const shown = new Set<string>()
    for (const client of [...peers.values()]) {
      if (!client.notices) continue
      const browserSessionID = client.identity.browserSessionID
      const present = presented.has(browserSessionID) && !shown.has(browserSessionID)
      if (!noticed.has(browserSessionID) && !present) continue
      if (!(await authorize(client))) continue
      if (noticed.has(browserSessionID))
        queued(client, {
          case: "control",
          value: create(ControlSchema, {
            kind: {
              case: "notice",
              value: create(NoticeSchema, {
                kind: { case: "quotaPace", value: { quota: wire, at: BigInt(deps.now()) } },
              }),
            },
          }),
        })
      if (!present) continue
      shown.add(browserSessionID)
      queued(client, {
        case: "control",
        value: create(ControlSchema, {
          kind: {
            case: "notice",
            value: create(NoticeSchema, {
              kind: {
                case: "present",
                value: { items: [create(PresentationSchema, { kind: { case: "quotaPace", value: wire } })] },
              },
            }),
          },
        }),
      })
    }
    flushAll()
    if (pushed.length === 0) return "settled"
    const sent = await delivery
      .push(ownerID, { category: "quota-pace", deviceID: peer.identity.deviceID, ...quota }, pushed)
      .then(
        () => true,
        () => false,
      )
    if (sent) return "settled"
    refund()
    await delivery
      .release(
        ownerID,
        key,
        pushed.map((subscription) => browserMember(subscription.browserSessionID)),
      )
      .catch(() => undefined)
    return "pending"
  }
  async function message(connectionID: string, data: string | ArrayBuffer) {
    const peer = peers.get(connectionID)
    if (!peer) return
    peer.seenAt = deps.monotonic()
    const established = peer.connection.state === "established"
    const received = receiveBinary(peer.connection, data, deps.monotonic())
    decisions(peer, received.decisions)
    if (
      !established &&
      peer.identity.role === "client" &&
      peer.connection.state === "established" &&
      statusBytes &&
      (await authorize(peer))
    ) {
      queued(peer, { case: "control", value: decodeStrict(ControlSchema, statusBytes) })
    }
    if (
      !established &&
      peer.identity.role === "agent" &&
      agent === peer &&
      peer.connection.state === "established"
    )
      mcp?.setAgent(
        { agentID: connectionID, ownerID: peer.identity.ownerID, deviceID: peer.identity.deviceID },
        mcpPort(peer),
      )
    receipts()
    const tasks: Promise<void>[] = []
    for (const entry of received.decisions) {
      if (!alive(peer)) break
      if (entry.type === "dispatch") {
        if (peer.identity.role !== "client" || !budget.reserve(RelayLimits.forwardingMetadataBytes)) {
          drop(peer, 1009, "LIMIT")
          break
        }
        const admission: Admission = { peer, dispatch: entry, cancelled: false }
        peer.requests.set(entry.requestID, admission)
        const scope = entry.request.scope?.target
        const lane = entry.operation.diagnosticName.startsWith("notice.")
          ? `${connectionID}:notice`
          : entry.operation.mutation === MutationClass.MUTATION
            ? scope?.case === "session"
              ? `session:${scope.value}`
              : `${connectionID}:mutation`
            : undefined
        tasks.push(lane === undefined ? admit(admission) : inLane(lane, () => admit(admission)))
      }
      if (entry.type === "cancelled") {
        for (const item of forwards)
          if (item.to === peer && item.requestID === entry.requestID && item.handed === undefined) releaseForward(item)
        const admission = peer.requests.get(entry.requestID)
        if (!admission) continue
        admission.cancelled = true
        stopHttp(admission, new Error("HTTP request cancelled"))
        if (admission.agent && admission.agentID !== undefined && (await authorize(peer)))
          decisions(admission.agent, admission.agent.connection.cancel(admission.agentID, deps.monotonic()))
        const forwarded = [...forwards].filter(
          (item) =>
            item.from === peer && item.ledger === LedgerClass.NORMAL && item.ordinal === admission.dispatch.ordinal,
        )
        if (!forwarded.length && admission.agentID === undefined)
          consume(peer, LedgerClass.NORMAL, admission.dispatch.ordinal)
        for (const item of forwarded) if (item.handed === undefined) releaseForward(item)
        finish(admission)
        sendInterestSnapshot(peer)
        notifyBulk()
      }
      if (entry.type === "transferCancelled" && peer.identity.role === "client") {
        const admission = [...peer.requests.values()].find((item) => item.clientTransferID === entry.transferID)
        if (admission) cancelHttp(admission)
      }
      if (
        entry.type === "settled" &&
        peer.identity.role === "agent" &&
        received.frame &&
        mcp?.owns(connectionID, entry.requestID)
      ) {
        if (received.frame.body.case === "result") {
          consume(peer, received.frame.ledger, received.frame.deliveryOrdinal)
          mcp.complete(connectionID, entry.requestID, mcpOutcome(entry.status, entry.payload?.payload))
          continue
        }
        const transfer = [...mcpTransfers.values()].find((item) => item.requestID === entry.requestID)
        if (transfer) transfer.settled = entry
        continue
      }
      if (
        entry.type === "bulkForward" &&
        peer.identity.role === "agent" &&
        mcp &&
        (entry.frame.body.case === "bulkStart"
          ? mcp.owns(connectionID, entry.frame.body.value.requestId)
          : (entry.frame.body.case === "bulkPiece" || entry.frame.body.case === "bulkEnd") &&
            mcpTransfers.has(entry.frame.body.value.transferId))
      ) {
        mcpBulk(peer, entry.frame)
        continue
      }
      if (entry.type === "settled" && peer.identity.role === "agent" && received.frame?.body.case === "result") {
        const admission = agentRequests.get(entry.requestID)
        if (!admission || admission.agent !== peer) {
          consume(peer, received.frame.ledger, received.frame.deliveryOrdinal)
          continue
        }
        if (
          admission.cancelled ||
          !alive(peer) ||
          admission.peer.requests.get(admission.dispatch.requestID) !== admission
        ) {
          consume(peer, received.frame.ledger, received.frame.deliveryOrdinal)
          continue
        }
        const frame = received.frame
        const scope = admission.dispatch.request.scope?.target
        registerResult(peer, frame, admission)
        tasks.push(
          admission.dispatch.operation.streaming === Streaming.EVENTS && scope?.case === "session"
            ? inLane(`${connectionID}:events:${scope.value}`, () => result(peer, frame, admission))
            : result(peer, frame, admission),
        )
      }
      if (entry.type === "assetMetadata") {
        const admission = agentRequests.get(entry.requestID)
        if (!admission || admission.agent !== peer) {
          consume(peer, entry.frame.ledger, entry.ordinal)
          continue
        }
        tasks.push(
          inLane(`${connectionID}:asset:${entry.requestID}`, async () => {
            if (!(await authorize(peer)) || !(await authorize(admission.peer)) || admission.cancelled) {
              consume(peer, entry.frame.ledger, entry.ordinal)
              return
            }
            if (entry.frame.body.case === "result")
              if (entry.frame.body.value.outcome.case === "assetMetadata") {
                admission.mime = decodeLossless(entry.frame.body.value.outcome.value.mime!)
                forward(peer, entry.frame, admission.peer, {
                  case: "result",
                  value: { ...entry.frame.body.value, requestId: admission.dispatch.requestID },
                })
              }
            flushAll()
          }),
        )
      }
      if (
        entry.type === "resync" &&
        received.frame?.body.case === "control" &&
        received.frame.body.value.kind.case === "resyncRequired" &&
        entry.scope.target.case === "session"
      ) {
        const scope = entry.scope
        const target = scope.target
        if (target.case === "session") {
          canonicalEpoch(peer, scope, entry.sourceEpoch)
          tasks.push(
            inLane(`${connectionID}:events:${target.value}`, async () => {
              if (!(await authorize(peer))) return
              if (!alive(peer) || backendEpochs.get(target.value)?.epoch !== entry.sourceEpoch) return
              const subscriptions = [...acceptedInterests]
                .filter(([, accepted]) => accepted.target.case === "session" && accepted.target.value === target.value)
                .map(([id]) => id)
              for (const id of subscriptions) {
                peer.connection.beginHydration(id)
                decisions(peer, peer.connection.completeHydration(id, entry.sourceEpoch, deps.monotonic()))
              }
              for (const client of peers.values()) {
                if (
                  client.identity.role !== "client" ||
                  client.connection.state !== "established" ||
                  !subscriptions.some((id) => client.subscriptions.has(id)) ||
                  !(await authorize(client))
                )
                  continue
                queued(client, received.frame!.body)
              }
            }),
          )
        }
      }
      if (entry.type === "events") {
        const target = entry.batch.scope?.target
        if (target?.case === "session")
          tasks.push(inLane(`${connectionID}:events:${target.value}`, () => events(peer, entry)))
      }
      if (entry.type === "resync" && received.frame?.body.case === "eventBatch") drop(peer, 1002, "EPOCH")
      if (entry.type === "streamEnded" && received.frame?.body.case === "streamEnd") {
        const frame = received.frame
        const scope = acceptedInterests.get(entry.subscriptionID)
        const target = scope?.target
        if (target?.case === "session")
          tasks.push(
            inLane(`${connectionID}:events:${target.value}`, async () => {
              if (!(await authorize(peer))) return
              const key = inputKey(peer, LedgerClass.EVENT, frame.deliveryOrdinal)
              heldInputs.add(key)
              for (const client of peers.values()) {
                if (!client.subscriptions.has(entry.subscriptionID) || !(await authorize(client))) continue
                forward(peer, frame, client, frame.body)
                client.subscriptions.delete(entry.subscriptionID)
                budget.release(RelayLimits.forwardingMetadataBytes)
                sendInterestSnapshot(client)
              }
              heldInputs.delete(key)
              if (
                ![...forwards].some(
                  (item) =>
                    item.from === peer && item.ledger === LedgerClass.EVENT && item.ordinal === frame.deliveryOrdinal,
                )
              )
                consume(peer, LedgerClass.EVENT, frame.deliveryOrdinal)
              flushAll()
            }),
          )
      }
      if (entry.type === "bulkForward") {
        const frame = entry.frame
        const admission =
          frame.body.case === "bulkStart"
            ? agentRequests.get(frame.body.value.requestId)
            : [...agentRequests.values()].find(
                (item) =>
                  item.transferID ===
                  (frame.body.case === "bulkPiece" || frame.body.case === "bulkEnd"
                    ? frame.body.value.transferId
                    : undefined),
              )
        if (!admission || admission.agent !== peer) {
          consume(peer, frame.ledger, frame.deliveryOrdinal)
          continue
        }
        if (frame.body.case === "bulkStart") {
          admission.transferID = frame.body.value.transferId
          admission.clientTransferID = deps.newID()
          admission.start = frame.body.value
        }
        tasks.push(inLane(`${connectionID}:asset:${admission.agentID}`, () => forwardBulk(peer, frame, admission)))
      }
      if (entry.type === "control" && received.frame) {
        if (peer.identity.role === "agent") {
          if (!budget.reserve(RelayLimits.forwardingMetadataBytes)) {
            drop(peer, 1009, "LIMIT")
            continue
          }
          const byteLength = typeof data === "string" ? 0 : data.byteLength
          const frame = received.frame
          const kind = frame.body.case === "control" ? frame.body.value.kind : undefined
          tasks.push(
            (kind?.case === "mcpState"
              ? inLane(`${connectionID}:mcp`, () => mcpControl(peer, frame, kind.value))
              : kind?.case === "quotaPace"
                ? inLane(`${connectionID}:quota`, () => quotaControl(peer, frame, kind.value))
                : inLane(`${connectionID}:control`, () => agentControl(peer, frame, byteLength))
            ).finally(() => budget.release(RelayLimits.forwardingMetadataBytes)),
          )
        } else {
          if (!(await authorize(peer))) continue
          consume(peer, received.frame.ledger, received.frame.deliveryOrdinal)
        }
      }
    }
    flushAll()
    await Promise.all(tasks)
    flushAll()
  }

  return {
    reservation: budget,
    requestMcp: (input: McpRelayRequest) =>
      mcp ? mcp.request(input) : Promise.reject(new McpRelayError("agent_unavailable", "Relay MCP is not ready")),
    authorizeMcpEvent: (
      trusted: AuthorizationContext,
      request: AuthorizationRequest,
    ): Promise<AuthorizationResponse> =>
      mcp
        ? mcp.authorizeEvent(trusted, request)
        : Promise.reject(new McpRelayError("agent_unavailable", "Relay MCP is not ready")),
    mcpGate: () => mcp?.gate(),
    connection: (connectionID: string) => peers.get(connectionID)?.connection,
    async readContent(request: Request, message: boolean) {
      const epoch = request.headers.get("x-ycoding-connection-epoch")
      const requestID = request.headers.get("x-ycoding-request-id")
      const transferID = request.headers.get("x-ycoding-transfer-id")
      const peer = [...peers.values()].find(
        (peer) =>
          peer.identity.role === "client" &&
          peer.identity.ownerID === request.headers.get("x-ycoding-owner") &&
          peer.identity.deviceID === request.headers.get("x-ycoding-device") &&
          peer.identity.browserSessionID === request.headers.get("x-ycoding-browser-session") &&
          peer.connection.connectionEpoch === epoch,
      )
      const admission = requestID ? peer?.requests.get(requestID) : undefined
      const start = admission?.start
      if (
        !peer ||
        !admission ||
        !start ||
        admission.cancelled ||
        admission.clientTransferID !== transferID ||
        httpReads.has(admission) ||
        startConsumed(admission) ||
        !(await authorize(peer))
      )
        return new Response("HTTP transfer is not owned by this connection", { status: 409 })
      const scope = admission.dispatch.request.scope?.target
      const operation = admission.dispatch.operation.diagnosticName
      if (
        scope?.case !== "session" ||
        scope.value !== request.headers.get("x-ycoding-target-session") ||
        operation !== (message ? "session.message" : "session.attachment.read")
      )
        return new Response("Invalid HTTP transfer target", { status: 400 })
      const messageParams = message
        ? decodeStrict(session_message_RequestSchema, admission.dispatch.request.payload).params
        : undefined
      const attachmentParams = message
        ? undefined
        : decodeStrict(session_attachment_read_RequestSchema, admission.dispatch.request.payload).params
      const target = decodeLossless(messageParams ? messageParams.messageID! : attachmentParams!.digest!)
      if (
        decodeLossless((messageParams ?? attachmentParams)!.sessionID!) !== scope.value ||
        target !== request.headers.get(message ? "x-ycoding-target-message" : "x-ycoding-target-digest")
      )
        return new Response("Invalid HTTP transfer target", { status: 400 })
      if (
        !alive(peer) ||
        admission.cancelled ||
        request.signal.aborted ||
        httpReads.has(admission) ||
        startConsumed(admission)
      )
        return new Response("HTTP transfer is unavailable", { status: 409 })
      if (start.chunkCount !== Number((start.byteCount + 65535n) / 65536n))
        return new Response("Invalid HTTP piece declaration", { status: 400 })
      if (!budget.reserve(RelayLimits.peerMetadataBytes))
        return new Response("HTTP reservation exceeded", { status: 503 })
      decisions(peer, peer.connection.attachHttpBulk(transferID!, deps.monotonic()))
      if (!alive(peer)) {
        budget.release(RelayLimits.peerMetadataBytes)
        return new Response(null, { status: 503 })
      }
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
        },
        cancel() {
          cancelHttp(admission)
        },
      })
      const abort = () => cancelHttp(admission)
      httpReads.set(admission, {
        admission,
        controller,
        signal: request.signal,
        abort,
        closed: false,
        bodyEnded: false,
      })
      request.signal.addEventListener("abort", abort, { once: true })
      notifyBulk()
      return new Response(body, {
        headers: {
          "content-type": admission.mime ?? "application/x-protobuf",
          "content-length": String(start.byteCount),
          "cache-control": "no-store, no-transform",
          "content-encoding": "identity",
          "x-ycoding-connection-epoch": epoch!,
          "x-ycoding-transfer-id": transferID!,
        },
      })
    },
    agentConnected: () => agent?.connection.state === "established",
    async attach(connection: RelayConnection) {
      if (identity && (identity.ownerID !== connection.ownerID || identity.deviceID !== connection.deviceID)) {
        deps.close(connection.connectionID, 4403, "DIRECTION")
        return
      }
      if (peers.has(connection.connectionID)) return
      if (
        (connection.role === "client" &&
          [...peers.values()].filter((peer) => peer.identity.role === "client").length >= RelayLimits.browserPeers) ||
        !budget.reserve(RelayLimits.peerMetadataBytes)
      ) {
        deps.close(connection.connectionID, 1009, "LIMIT")
        return
      }
      identity ??= { ownerID: connection.ownerID, deviceID: connection.deviceID }
      const peer: Peer = {
        identity: connection,
        connection: createRelayConnection(
          connection.role === "agent" ? PeerRole.AGENT : PeerRole.REMOTE_CLIENT,
          deps.newID(),
          sourceEpoch,
          deps.monotonic(),
          budget,
        ),
        seenAt: deps.monotonic(),
        notices: false,
        requests: new Map(),
        subscriptions: new Map(),
      }
      peers.set(connection.connectionID, peer)
      if (!(await authorize(peer))) return
      if (connection.role === "agent") {
        if (agent && deps.monotonic() - agent.seenAt < RemoteLimits.agentOfflineConfirmMs) {
          drop(peer, 4409, "DIRECTION")
          return
        }
        if (agent) drop(agent, 1012, "EPOCH")
        agent = peer
        offline = undefined
        offlineLoaded = true
        await deps.saveOfflineCheck(undefined)
      }
    },
    handleClientMessage: message,
    handleAgentMessage: message,
    detach(connectionID: string) {
      const peer = peers.get(connectionID)
      if (peer) drop(peer, 1000, "EPOCH")
      flushAll()
    },
    async agentClosed(connection: RelayConnection) {
      const peer = peers.get(connection.connectionID)
      if (!peer || agent !== peer) return
      drop(peer, 1012, "EPOCH")
      offline = { ownerID: connection.ownerID, deviceID: connection.deviceID, closedAt: deps.now() }
      offlineLoaded = true
      await deps.saveOfflineCheck(offline)
    },
    async restore(connections: readonly RelayConnection[]) {
      for (const connection of connections) deps.close(connection.connectionID, 1012, "EPOCH")
    },
    async revokeSession(sessionID: string) {
      for (const peer of peers.values()) if (peer.identity.browserSessionID === sessionID) drop(peer, 4401, "DIRECTION")
      flushAll()
    },
    closeDevice() {
      for (const peer of peers.values()) drop(peer, 4403, "DIRECTION")
      if (statusBytes) budget.release(statusBytes.length)
      statusBytes = undefined
    },
    sweep() {
      for (const peer of peers.values()) {
        if (deps.now() >= peer.identity.credentialExpiresAt) drop(peer, 4401, "DIRECTION")
        else decisions(peer, peer.connection.advance(deps.monotonic()))
      }
      flushAll()
    },
    nextDeadline() {
      return peers.size ? deps.now() + 25 : offline ? offline.closedAt + RemoteLimits.agentOfflineConfirmMs : undefined
    },
    async confirmOffline() {
      if (!offlineLoaded) {
        offline = await deps.loadOfflineCheck()
        offlineLoaded = true
      }
      const check = offline
      if (!check || agent || deps.now() < check.closedAt + RemoteLimits.agentOfflineConfirmMs) return
      const authority = await deps.authorizeAgentCommand(check.deviceID)
      if (offline !== check || agent) return
      offline = undefined
      await deps.saveOfflineCheck(undefined)
      if (!authority.ok || authority.ownerID !== check.ownerID) return
      await noticeToClients(
        create(NoticeSchema, { kind: { case: "offline", value: { atMs: BigInt(check.closedAt) } } }),
      )
      await alerts(check.ownerID, [
        {
          event: { category: "machine-offline", deviceID: check.deviceID, offlineAt: check.closedAt },
          presentation: {
            $typeName: "ycoding.v5.Presentation",
            kind: { case: "offline", value: { $typeName: "ycoding.v5.Offline", atMs: BigInt(check.closedAt) } },
          },
        },
      ])
      flushAll()
    },
    async settleDeliveries() {
      while (deliveries.size) await Promise.all([...deliveries])
      flushAll()
    },
  }
}

type McpTransfer = {
  readonly requestID: string
  readonly data: Uint8Array
  settled?: Extract<Decision, { type: "settled" }>
}
const quotaClaimGraceMs = 120_000
function browserMember(browserSessionID: string) {
  return `browser:${browserSessionID}`
}
function noticeMember(browserSessionID: string) {
  return `notice:${browserSessionID}`
}
function mcpOutcome(status: string | undefined, payload: Uint8Array | undefined): McpOutcome {
  if (status === "success") {
    const response = payload && decodeMcpResponse(payload)
    return response
      ? { type: "response", response }
      : { type: "violation", code: "internal_error", message: "Agent returned an invalid MCP response" }
  }
  const error = status === "rejected" && payload ? connectorError(payload) : undefined
  return error
    ? { type: "error", ...error }
    : { type: "violation", code: "internal_error", message: "Agent returned an invalid MCP response" }
}
function connectorError(payload: Uint8Array): { code: RemoteErrorCode; message: string } | undefined {
  try {
    const error = decodeStrict(Connector_ErrorSchema, payload)
    const label = Connector_Error_code[error.code]?.replace("CONNECTOR_ERROR_CODE_", "").toLowerCase()
    const code = remoteErrorCodes.find((item) => item === label)
    return code && { code, message: decodeLossless(error.message!) }
  } catch {
    return undefined
  }
}
function frameKey(frame: Frame) {
  const body = frame.body
  if (body.case === "request" || body.case === "result") return `${body.case}:${body.value.requestId}`
  if (body.case === "bulkStart" || body.case === "bulkEnd") return `${body.case}:${body.value.transferId}`
  if (body.case === "bulkPiece") return `${body.case}:${body.value.transferId}:${body.value.index}`
  if (body.case === "streamEnd") return `${body.case}:${body.value.subscriptionId}`
  if (body.case === "control") return `control:${body.value.kind.case}`
  return body.case ?? ""
}
function inputKey(peer: Peer, ledger: LedgerClass, ordinal: bigint) {
  return `${peer.identity.connectionID}:${ledger}:${ordinal}`
}
function noticeRecord(notice: RemoteNotice) {
  return create(NoticeRecordSchema, {
    id: notice.id,
    sessionId: notice.sessionID,
    createdMs: BigInt(notice.createdAt),
    category:
      notice.category === "agent-completed" ? NoticeCategory.AGENT_COMPLETED : NoticeCategory.APPROVAL_REQUESTED,
  })
}
function added(notices: readonly RemoteNotice[], total: number) {
  return create(NoticeSchema, {
    kind: { case: "added", value: { notices: notices.map(noticeRecord), total: BigInt(total) } },
  })
}
function attentionNeed(need: AttentionNeed | undefined): RemoteAlertDetail["need"] {
  return need === undefined
    ? undefined
    : (
        {
          [AttentionNeed.PERMISSION]: "permission",
          [AttentionNeed.QUESTION]: "question",
          [AttentionNeed.REVIEW]: "review",
          [AttentionNeed.FAILED]: "failed",
          [AttentionNeed.BLOCKED]: "blocked",
        } as const
      )[need]
}
function wireDetail(detail: RemoteAlertDetail) {
  return {
    title: detail.title === undefined ? undefined : encodeLossless(detail.title),
    need:
      detail.need === undefined || detail.need === "lost"
        ? undefined
        : {
            permission: AttentionNeed.PERMISSION,
            question: AttentionNeed.QUESTION,
            review: AttentionNeed.REVIEW,
            failed: AttentionNeed.FAILED,
            blocked: AttentionNeed.BLOCKED,
          }[detail.need],
    repeat: detail.repeat,
  }
}
