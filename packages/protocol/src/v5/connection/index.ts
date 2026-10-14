import { create, isFieldSet } from "@bufbuild/protobuf"
import {
  CONTRACT_DIGEST,
  FrameSchema,
  HelloSchema,
  ReadySchema,
  ReceiveWindowsSchema,
  PeerRole,
  LedgerClass,
  FailureCategory,
  ControlSchema,
  PingSchema,
  PongSchema,
  CreditSchema,
  SenderMask,
  RequestSchema,
  CancelSchema,
  MutationClass,
  ScopeKind,
  Streaming,
  ContentKind,
  TypedPayloadSchema,
  EventBatchSchema,
  ResyncRequiredSchema,
  ScopeSchema,
  WireLimit,
} from "../../generated/v5/index.js"
import type {
  Frame,
  OperationDescriptor,
  Scope,
  TypedPayload,
  Request,
  Result,
  Settlement,
  BulkStart,
  BulkPiece,
  EventBatch,
  EventRecord,
  AssetMetadataResult,
  SubscriptionSnapshot,
} from "../../generated/v5/index.js"
import { validateBinary } from "../validate.js"
import { validateAssetMetadata } from "../asset.js"
import { defaultBudgets, ReservationBudget } from "./budgets.js"
import type { Budgets, ConfigurableBudgets } from "./budgets.js"
import { Ledger } from "./ledger.js"
import type { Transfer } from "./bulk.js"
import { sameScope } from "./subscription.js"
import type { Subscription } from "./subscription.js"
import { eventReservationBytes, resyncReservationBytes, subscriptionSnapshotBytes, utf8Bytes } from "./events.js"
export { eventFrameBytes, eventReservationBytes, lateHeaderReservation } from "./events.js"

export { defaultBudgets, ReservationBudget } from "./budgets.js"
export type { Budgets, ConfigurableBudgets } from "./budgets.js"

export type Options = {
  role: PeerRole
  peer: PeerRole
  operations: readonly OperationDescriptor[]
  eventTypes: readonly string[]
  now: number
  epoch?: string
  sourceEpoch?: string
  budgets?: Partial<ConfigurableBudgets>
  reservation?: ReservationBudget
}

export type Decision =
  | { type: "ready"; epoch: string; sourceEpoch: string }
  | { type: "closed"; code: number; category: FailureCategory }
  | { type: "control"; frame: Frame }
  | { type: "dropped"; reason: "late" | "duplicate" | "unknown" }
  | { type: "dispatch"; requestID: string; request: Request; operation: OperationDescriptor; ordinal: bigint }
  | {
      type: "settled"
      requestID: string
      status: "unsent" | "unavailable" | "unknown" | "success" | "rejected"
      settlement?: Settlement
      payload?: TypedPayload
    }
  | { type: "cancelled"; requestID: string; mutation: boolean }
  | { type: "assetMetadata"; requestID: string; metadata: AssetMetadataResult; frame: Frame; ordinal: bigint }
  | { type: "eventBatchReleased"; ticket: bigint; consumed: boolean }
  | { type: "relayInterestRejected"; sessionID: string }
  | { type: "httpBulkStart"; start: BulkStart; metadata?: AssetMetadataResult }
  | { type: "httpBulkReleased"; transferID: string; through: bigint; consumed: boolean }
  | {
      type: "bulkComplete"
      transferID: string
      data: Uint8Array
      start: BulkStart
      metadata?: undefined
      result?: undefined
    }
  | {
      type: "bulkComplete"
      transferID: string
      data: Uint8Array
      start: BulkStart
      metadata: AssetMetadataResult
      result: TypedPayload
    }
  | { type: "bulkForward"; frame: Frame }
  | { type: "transferCancelled"; transferID: string }
  | { type: "events"; subscriptionID: string; batch: EventBatch; ordinal?: bigint }
  | { type: "resync"; subscriptionID?: string; scope: Scope; sourceEpoch: string; messageID?: string }
  | { type: "streamEnded"; subscriptionID: string }

type Queued = {
  frame: Frame
  bytes: number
  available: number
  key: string
  count: number
  open?: boolean
  ticket?: bigint
  forwarded?: boolean
  eventFence?: bigint
  eventKey?: string
}
type Pending = {
  operation: OperationDescriptor
  scope: Scope
  transmitted: boolean
  asset?: AssetMetadataResult
  assetCount?: bigint
  assetCharge?: number
  http?: boolean
}
export type Prepared = { frame: Frame; reservedBytes: number }
export type Incoming = { readonly byteLength: number; readonly authority: number }
export type EventMetadata = {
  subscriptionID: string
  scope: Scope
  sourceEpoch: string
  messageID?: string
  background?: boolean
}

export class Connection {
  readonly budgets: Readonly<Budgets>
  readonly reservation: ReservationBudget
  private phase: "hello" | "ready" | "confirm" | "established" | "closed"
  private epoch = ""
  private sourceEpoch = ""
  private deadline: number
  private now: number
  private started = false
  private queue: Queued[] = []
  private prepared?: { token: Prepared; record: Queued; authority: number }
  private incoming = new Set<Incoming>()
  private notifications: Decision[] = []
  private ledgers: Map<LedgerClass, Ledger>
  private sendWindows: Map<LedgerClass, number>
  private rates: { direction: "send" | "receive"; tiny: boolean; bytes: number; time: number }[] = []
  private lastEvent = ""
  private lastBulk = ""
  private eventRun = 0
  private lastPing = -Infinity
  private pingID = 0n
  private outstandingPing?: bigint
  private peerPing = 0n
  private tinyReceiptSent = 0n
  private readyHanded = false
  private helloHanded = false
  private requestOrdinal = 0n
  private pending = new Map<string, Pending>()
  private inbound = new Map<string, Pending>()
  private awaitingSubscription = new Map<string, Pending>()
  private authority = 0
  private transfers = new Map<string, Transfer>()
  private outgoingTransfers = new Map<string, Transfer>()
  private httpSending = new Map<string, { through: bigint; handed: { index: bigint; bytes: number; time: number }[] }>()
  private httpCredits = new Map<string, bigint>()
  private subscriptions = new Map<string, Subscription>()
  private sendingSubscriptions = new Map<string, Subscription>()
  private dropped = { results: 0, transfers: 0, events: 0, oversizedInvalidations: 0 }
  private eventTicket = 0n
  private relayClients = new Map<string, { snapshot: SubscriptionSnapshot; bytes: number }>()
  private relayIdentities = new Map<string, { id: string; bytes: number }>()

  constructor(readonly options: Options) {
    if (!Number.isFinite(options.now)) throw new Error("time")
    const client = [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.AGENT].includes(options.role)
    const clientRole = client ? options.role : options.peer
    const serverRole = client ? options.peer : options.role
    if (
      !(
        (clientRole === PeerRole.LOCAL_CLIENT && serverRole === PeerRole.SERVER) ||
        ([PeerRole.REMOTE_CLIENT, PeerRole.AGENT].includes(clientRole) && serverRole === PeerRole.RELAY)
      )
    )
      throw new Error("peer roles")
    this.budgets = Object.freeze({ ...defaultBudgets, ...options.budgets })
    if (
      (
        [
          "clientFrameBytes",
          "serverFrameBytes",
          "handshakeBytes",
          "handshakeRetainedBytes",
          "handshakeTimeoutMs",
        ] as const
      ).some((key) => !Object.is(this.budgets[key], defaultBudgets[key]))
    )
      throw new Error("fixed wire limits")
    if (Object.values(this.budgets).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new Error("budgets")
    this.reservation =
      options.reservation ??
      new ReservationBudget(
        this.budgets.normalWindowBytes +
          this.budgets.normalQueueBytes +
          this.budgets.eventWindowBytes +
          this.budgets.eventQueueBytes +
          this.budgets.bulkWindowBytes * 2 +
          this.budgets.tinyBytes * 2 +
          this.budgets.handshakeRetainedBytes +
          this.budgets.messageBytes,
      )
    this.ledgers = new Map([
      [LedgerClass.NORMAL, new Ledger(LedgerClass.NORMAL, this.budgets.normalWindowBytes)],
      [LedgerClass.EVENT, new Ledger(LedgerClass.EVENT, this.budgets.eventWindowBytes)],
      [LedgerClass.BULK, new Ledger(LedgerClass.BULK, this.budgets.bulkWindowBytes)],
      [LedgerClass.TINY, new Ledger(LedgerClass.TINY, this.budgets.tinyBytes)],
    ])
    this.sendWindows = new Map([...this.ledgers].map((entry) => [entry[0], entry[1].window]))
    this.phase = client ? "ready" : "hello"
    if (!client && (!options.epoch || !options.sourceEpoch)) throw new Error("server epochs")
    this.now = options.now
    this.deadline = options.now + this.budgets.handshakeTimeoutMs
  }

  get state() {
    return this.phase
  }
  get connectionEpoch() {
    return this.epoch
  }
  get httpHandedBytes() {
    return [...this.httpSending.values()]
      .flatMap((owner) => owner.handed)
      .reduce((total, piece) => total + piece.bytes, 0)
  }
  get counters() {
    return { ...this.dropped, retainedBytes: this.retainedBytes }
  }
  get retainedBytes() {
    return (
      this.assetMetadataRetainedBytes +
      this.httpHandedBytes +
      this.httpSending.size * 256 +
      this.relayInterestRetainedBytes +
      [...this.incoming].reduce((total, token) => total + token.byteLength, 0) +
      this.queue.reduce((total, record) => total + record.bytes, 0) +
      (this.prepared?.record.bytes ?? 0) +
      [...this.ledgers.values()].reduce((total, ledger) => total + ledger.handedBytes + ledger.receivedBytes, 0) +
      this.bulkRetainedBytes +
      this.hydrationBytes
    )
  }
  get hydrationBytes() {
    return [...this.subscriptions.values()]
      .flatMap((subscription) => subscription.buffered)
      .reduce((total, record) => total + record.bytes, 0)
  }

  acceptSubscription(
    requestID: string,
    subscriptionID: string,
    scope: Scope,
    now: number,
    direction: "send" | "receive" = "receive",
    canonicalSourceEpoch?: string,
  ): Decision[] {
    const decisions = this.check(now)
    if (this.phase === "closed") return decisions
    const key = direction === "receive" ? requestID : `sent:${requestID}`
    const pending = this.awaitingSubscription.get(key)
    const subscriptions = direction === "receive" ? this.subscriptions : this.sendingSubscriptions
    if (
      !pending ||
      !subscriptionID ||
      !(scope.target.case === "session" || scope.target.case === "global") ||
      (pending.scope.target.case === "session" && !sameScope(pending.scope, scope))
    )
      return this.close(FailureCategory.MALFORMED)
    if (
      (this.options.role === PeerRole.REMOTE_CLIENT || this.options.peer === PeerRole.REMOTE_CLIENT) &&
      scope.target.case !== "session"
    )
      return this.close(FailureCategory.DIRECTION)
    if (this.options.role === PeerRole.RELAY && !canonicalSourceEpoch) return this.close(FailureCategory.DIRECTION)
    const existing = subscriptions.get(subscriptionID)
    if (existing) {
      if (
        !canonicalSourceEpoch ||
        !(this.options.role === PeerRole.RELAY || (this.options.role === PeerRole.AGENT && direction === "send")) ||
        !sameScope(existing.scope, scope) ||
        existing.sourceEpoch !== canonicalSourceEpoch ||
        existing.eventTypes.length !== pending.operation.eventTypes.length ||
        !existing.eventTypes.every((type) => pending.operation.eventTypes.includes(type))
      )
        return this.close(FailureCategory.MALFORMED)
      this.awaitingSubscription.delete(key)
      return decisions
    }
    if (subscriptions.size >= this.budgets.subscriptions) return this.close(FailureCategory.LIMIT)
    this.awaitingSubscription.delete(key)
    subscriptions.set(subscriptionID, {
      scope,
      eventTypes: pending.operation.eventTypes,
      sourceEpoch:
        this.options.role === PeerRole.RELAY ? canonicalSourceEpoch! : (canonicalSourceEpoch ?? this.sourceEpoch),
      hydrating: false,
      invalidated: false,
      ending: false,
      resyncRequired: false,
      buffered: [],
    })
    return decisions
  }

  beginHydration(subscriptionID: string) {
    const subscription = this.subscriptions.get(subscriptionID)
    if (!subscription) throw new Error("subscription owner")
    this.clearHydration(subscription)
    subscription.hydrating = true
    subscription.invalidated = false
  }

  completeHydration(subscriptionID: string, canonicalSourceEpoch: string, now: number): Decision[] {
    const subscription = this.subscriptions.get(subscriptionID)
    if (!subscription) throw new Error("subscription owner")
    if (!canonicalSourceEpoch) throw new Error("canonical source epoch")
    const decisions = this.check(now)
    if (this.phase === "closed") return decisions
    const buffered = subscription.buffered
    this.clearHydration(subscription)
    subscription.hydrating = false
    subscription.sourceEpoch = canonicalSourceEpoch
    if (subscription.invalidated)
      return [
        ...decisions,
        { type: "resync", subscriptionID, scope: subscription.scope, sourceEpoch: canonicalSourceEpoch },
      ]
    const batches = buffered.map(
      (record): Decision =>
        record.batch.sourceEpoch === canonicalSourceEpoch
          ? { type: "events", subscriptionID, batch: record.batch }
          : { type: "resync", subscriptionID, scope: subscription.scope, sourceEpoch: record.batch.sourceEpoch },
    )
    subscription.resyncRequired = batches.some((decision) => decision.type === "resync")
    return [...decisions, ...batches]
  }

  releaseSubscription(subscriptionID: string, now: number, direction: "send" | "receive" = "receive"): Decision[] {
    const decisions = this.check(now)
    const subscriptions = direction === "receive" ? this.subscriptions : this.sendingSubscriptions
    const subscription = subscriptions.get(subscriptionID)
    if (!subscription) return decisions
    this.clearHydration(subscription)
    subscriptions.delete(subscriptionID)
    if (direction === "send")
      for (const [sessionID, identity] of this.relayIdentities) {
        if (identity.id !== subscriptionID) continue
        this.reservation.release(identity.bytes)
        this.relayIdentities.delete(sessionID)
      }
    if (direction === "send")
      this.removeQueued(
        (frame) =>
          (frame.body.case === "eventBatch" || frame.body.case === "streamEnd") &&
          frame.body.value.subscriptionId === subscriptionID,
      )
    return decisions
  }
  get bulkRetainedBytes() {
    return [...this.transfers.values()].reduce((total, transfer) => total + (transfer.data?.length ?? 0), 0)
  }
  forwardEventBatch(batch: EventBatch, now: number) {
    const decisions = this.check(now)
    if (this.phase === "closed") return { ticket: undefined, decisions }
    if (
      this.options.role !== PeerRole.RELAY ||
      this.options.peer !== PeerRole.REMOTE_CLIENT ||
      this.phase !== "established"
    )
      return { ticket: undefined, decisions: this.close(FailureCategory.DIRECTION) }
    const queued = this.queueFrame({ case: "eventBatch", value: batch }, eventReservationBytes(batch, this.epoch), now)
    if (this.state === "closed") return { ticket: undefined, decisions: queued }
    const record = this.queue[this.queue.length - 1]
    if (!record) return { ticket: undefined, decisions: this.close(FailureCategory.MALFORMED) }
    this.eventTicket++
    record.ticket = this.eventTicket
    record.forwarded = true
    record.open = false
    record.available = now
    return { ticket: record.ticket, decisions: [...decisions, ...queued] }
  }
  get assetMetadataRetainedBytes() {
    return (
      [...this.pending.values()].reduce((bytes, pending) => bytes + (pending.assetCharge ?? 0), 0) +
      [...this.transfers.values()].reduce((bytes, transfer) => bytes + (transfer.assetCharge ?? 0), 0)
    )
  }
  get relayInterestRetainedBytes() {
    return (
      [...this.relayClients.values()].reduce((bytes, entry) => bytes + entry.bytes, 0) +
      [...this.relayIdentities.values()].reduce((bytes, entry) => bytes + entry.bytes, 0)
    )
  }
  relaySubscriptionID(sessionID: string) {
    return this.relayIdentities.get(sessionID)?.id
  }
  updateRelayInterests(snapshot: SubscriptionSnapshot, now: number) {
    const decisions = this.check(now)
    const empty = { added: [] as string[], removed: [] as string[], decisions }
    if (this.state === "closed") return empty
    if (
      this.options.role !== PeerRole.AGENT ||
      this.options.peer !== PeerRole.RELAY ||
      !snapshot.clientId ||
      snapshot.sessionIds.some((id) => !id) ||
      new Set(snapshot.sessionIds).size !== snapshot.sessionIds.length
    )
      return { ...empty, decisions: this.close(FailureCategory.DIRECTION) }
    const before = new Set([...this.relayClients.values()].flatMap((entry) => entry.snapshot.sessionIds))
    const after = new Set(
      [...this.relayClients]
        .filter(([id]) => id !== snapshot.clientId)
        .flatMap(([, entry]) => entry.snapshot.sessionIds)
        .concat(snapshot.sessionIds),
    )
    const previous = this.relayClients.get(snapshot.clientId)
    const bytes = subscriptionSnapshotBytes(snapshot)
    if (
      snapshot.sessionIds.length > this.budgets.subscriptions ||
      after.size > this.budgets.subscriptions ||
      (!previous && snapshot.sessionIds.length && this.relayClients.size >= WireLimit.RELAY_PEERS) ||
      bytes > this.budgets.serverFrameBytes ||
      (snapshot.sessionIds.length && !this.reservation.reserve(bytes))
    )
      return { ...empty, decisions: this.close(FailureCategory.LIMIT) }
    if (snapshot.sessionIds.length) this.relayClients.set(snapshot.clientId, { snapshot, bytes })
    if (!snapshot.sessionIds.length) this.relayClients.delete(snapshot.clientId)
    if (previous) this.reservation.release(previous.bytes)
    const removed = [...before].filter((id) => !after.has(id)).sort()
    for (const id of removed) {
      const identity = this.relayIdentities.get(id)
      if (identity) decisions.push(...this.releaseSubscription(identity.id, now, "send"))
      this.relayIdentities.delete(id)
    }
    return { added: [...after].filter((id) => !before.has(id)).sort(), removed, decisions }
  }
  releaseRelayClient(clientID: string, now: number) {
    return this.updateRelayInterests(
      { $typeName: "ycoding.v5.SubscriptionSnapshot", clientId: clientID, sessionIds: [] },
      now,
    )
  }
  registerRelayInterest(sessionID: string, subscriptionID: string, sourceEpoch: string, now: number): Decision[] {
    const decisions = this.check(now)
    if (this.state === "closed") return decisions
    if (
      this.options.role !== PeerRole.AGENT ||
      this.options.peer !== PeerRole.RELAY ||
      this.state !== "established" ||
      !sourceEpoch ||
      !subscriptionID ||
      ![...this.relayClients.values()].some((entry) => entry.snapshot.sessionIds.includes(sessionID)) ||
      this.relayIdentities.has(sessionID) ||
      this.sendingSubscriptions.has(subscriptionID)
    )
      return [...decisions, { type: "relayInterestRejected", sessionID }]
    if (this.sendingSubscriptions.size >= this.budgets.subscriptions) return this.close(FailureCategory.LIMIT)
    const operation = this.options.operations.find((operation) => operation.diagnosticName === "event.subscribe")
    if (!operation) return [...decisions, { type: "relayInterestRejected", sessionID }]
    const bytes = utf8Bytes(sessionID) + utf8Bytes(subscriptionID) + utf8Bytes(sourceEpoch)
    if (bytes > this.budgets.serverFrameBytes || !this.reservation.reserve(bytes))
      return this.close(FailureCategory.LIMIT)
    this.sendingSubscriptions.set(subscriptionID, {
      scope: create(ScopeSchema, { target: { case: "session", value: sessionID } }),
      eventTypes: operation.eventTypes,
      sourceEpoch,
      hydrating: false,
      invalidated: false,
      ending: false,
      resyncRequired: false,
      buffered: [],
    })
    this.relayIdentities.set(sessionID, { id: subscriptionID, bytes })
    return decisions
  }

  releaseBulk(transferID: string) {
    const transfer = this.transfers.get(transferID)
    if (!transfer?.complete) throw new Error("bulk owner")
    this.reservation.release((transfer.data?.length ?? 0) + (transfer.assetCharge ?? 0))
    this.transfers.delete(transferID)
  }

  expectHttpBulk(requestID: string) {
    const pending = this.pending.get(requestID)
    if (
      this.options.role !== PeerRole.REMOTE_CLIENT ||
      !pending ||
      pending.http ||
      ![Streaming.TYPED_BULK, Streaming.ASSET_BULK].includes(pending.operation.streaming) ||
      [...this.transfers.values()].some((transfer) => transfer.start.requestId === requestID)
    )
      throw new Error("HTTP request owner")
    pending.http = true
  }

  beginHttpBody(transferID: string, epoch: string, now: number): Decision[] {
    const decisions = this.check(now)
    if (this.phase === "closed") return decisions
    const transfer = this.transfers.get(transferID)
    if (!transfer?.http || transfer.http.bound || epoch !== this.epoch) throw new Error("HTTP body owner")
    transfer.http.bound = true
    return transfer.start.byteCount === 0n
      ? decisions
      : [...decisions, ...this.consume(LedgerClass.NORMAL, transfer.http.ordinal, now)]
  }

  receiveHttpPiece(transferID: string, data: Uint8Array, now: number): Decision[] {
    const decisions = this.check(now)
    if (this.phase === "closed") return decisions
    const transfer = this.transfers.get(transferID)
    if (
      !transfer?.http?.bound ||
      !transfer.data ||
      transfer.complete ||
      transfer.index >= transfer.start.chunkCount ||
      data.length !==
        Number(
          transfer.start.byteCount - transfer.offset < 65536n ? transfer.start.byteCount - transfer.offset : 65536n,
        )
    )
      return this.close(FailureCategory.MALFORMED)
    transfer.data.set(data, Number(transfer.offset))
    transfer.offset += BigInt(data.length)
    transfer.index++
    if (transfer.offset === transfer.start.byteCount) return decisions
    return [...decisions, ...this.httpCredit(transfer, now)]
  }

  completeHttpBody(transferID: string, now: number): Decision[] {
    const decisions = this.check(now)
    if (this.phase === "closed") return decisions
    const transfer = this.transfers.get(transferID)
    if (!transfer?.http?.bound || transfer.http.finished || transfer.offset !== transfer.start.byteCount)
      throw new Error("HTTP completion owner")
    transfer.http.finished = true
    return [
      ...decisions,
      ...(transfer.start.byteCount === 0n
        ? this.consume(LedgerClass.NORMAL, transfer.http.ordinal, now)
        : this.httpCredit(transfer, now)),
    ]
  }

  private httpCredit(transfer: Transfer, now: number) {
    this.httpCredits.set(transfer.start.transferId, BigInt(transfer.index))
    return this.flushHttpCredits(now)
  }

  private flushHttpCredits(now: number) {
    const decisions: Decision[] = []
    for (const [transferID, through] of this.httpCredits) {
      if (!this.transfers.has(transferID)) {
        this.httpCredits.delete(transferID)
        continue
      }
      const queued = this.queue.find(
        (record) =>
          record.frame.body.case === "control" &&
          record.frame.body.value.kind.case === "credit" &&
          record.frame.body.value.kind.value.transferId === transferID,
      )?.frame.body
      if (queued?.case === "control" && queued.value.kind.case === "credit") {
        queued.value.kind.value.consumedThrough = through
        this.httpCredits.delete(transferID)
        continue
      }
      const before = this.queue.length
      decisions.push(
        ...this.queueFrame(
          {
            case: "control",
            value: create(ControlSchema, {
              kind: {
                case: "credit",
                value: create(CreditSchema, {
                  ledger: LedgerClass.BULK,
                  transferId: transferID,
                  consumedThrough: through,
                }),
              },
            }),
          },
          this.budgets.tinyFrameBytes,
          now,
          false,
          true,
        ),
      )
      if (this.queue.length > before) this.httpCredits.delete(transferID)
      if (this.phase === "closed") break
    }
    return decisions
  }

  attachHttpBulk(transferID: string, now: number): Decision[] {
    const decisions = this.check(now)
    if (this.phase === "closed") return decisions
    const transfer = this.outgoingTransfers.get(transferID)
    if (
      this.options.role !== PeerRole.RELAY ||
      this.options.peer !== PeerRole.REMOTE_CLIENT ||
      !transfer ||
      transfer.startHanded === undefined ||
      !this.ledgers.get(LedgerClass.NORMAL)!.sent.some((record) => record.ordinal === transfer.startHanded) ||
      transfer.complete ||
      transfer.index !== 0 ||
      this.httpSending.has(transferID) ||
      transfer.start.chunkCount !== Number((transfer.start.byteCount + 65535n) / 65536n)
    )
      throw new Error("HTTP sender owner")
    if (!this.reservation.reserve(256)) return this.close(FailureCategory.LIMIT)
    this.httpSending.set(transferID, { through: 0n, handed: [] })
    return decisions
  }

  get httpWindowAvailable() {
    return Math.min(
      this.sendWindows.get(LedgerClass.BULK)! - this.ledgers.get(LedgerClass.BULK)!.handedBytes - this.httpHandedBytes,
      this.options.peer === PeerRole.REMOTE_CLIENT ? this.budgets.relayPeerBytes - this.eventBulkBytes() : Infinity,
    )
  }

  handoffHttpPiece(piece: BulkPiece, now: number) {
    const decisions = this.check(now)
    if (this.phase === "closed") return { accepted: false, decisions }
    const transfer = this.outgoingTransfers.get(piece.transferId)
    const owner = this.httpSending.get(piece.transferId)
    if (
      !transfer ||
      !owner ||
      transfer.complete ||
      piece.index !== transfer.index ||
      piece.offset !== transfer.offset ||
      piece.index >= transfer.start.chunkCount ||
      piece.data.length !==
        Number(
          transfer.start.byteCount - transfer.offset < 65536n ? transfer.start.byteCount - transfer.offset : 65536n,
        )
    )
      return { accepted: false, decisions: this.close(FailureCategory.MALFORMED) }
    if (
      piece.data.length > this.httpWindowAvailable ||
      (this.prepared && this.classify(this.prepared.record.frame) === LedgerClass.BULK)
    )
      return { accepted: false, decisions }
    if (!this.reservation.reserve(piece.data.length))
      return { accepted: false, decisions: this.close(FailureCategory.LIMIT) }
    transfer.index++
    transfer.offset += BigInt(piece.data.length)
    owner.handed.push({ index: BigInt(transfer.index), bytes: piece.data.length, time: now })
    return { accepted: true, decisions }
  }

  httpBulkConsumed(transferID: string) {
    const owner = this.httpSending.get(transferID)
    const transfer = this.outgoingTransfers.get(transferID)
    return (
      !!owner &&
      !!transfer &&
      transfer.startHanded !== undefined &&
      !this.ledgers.get(LedgerClass.NORMAL)!.sent.some((record) => record.ordinal === transfer.startHanded) &&
      owner.handed.length === 0 &&
      owner.through === BigInt(transfer.index)
    )
  }

  private releaseHttpBulk(transferID: string): Decision[] {
    const owner = this.httpSending.get(transferID)
    if (!owner) return []
    this.reservation.release(256 + owner.handed.reduce((total, piece) => total + piece.bytes, 0))
    this.httpSending.delete(transferID)
    return [
      { type: "httpBulkReleased", transferID, through: owner.handed.at(-1)?.index ?? owner.through, consumed: false },
    ]
  }

  start(now: number): Decision[] {
    const decisions = this.advance(now)
    if (this.phase !== "ready" || this.started) return decisions
    this.started = true
    const frame = create(FrameSchema, {
      revision: 5,
      body: {
        case: "hello",
        value: create(HelloSchema, {
          revision: 5,
          contractDigest: digest(),
          role: this.options.role,
          receiveWindows: this.windows(),
        }),
      },
    })
    if (
      this.retainedBytes + this.budgets.handshakeBytes > this.budgets.handshakeRetainedBytes ||
      !this.reservation.reserve(this.budgets.handshakeBytes)
    )
      return this.close(FailureCategory.LIMIT)
    this.queue.push({ frame, bytes: this.budgets.handshakeBytes, available: now, key: "", count: 0 })
    return decisions
  }

  admitIncoming(byteLength: number): Incoming | undefined {
    if (this.phase === "closed") return undefined
    const cap = this.frameCap(this.options.peer)
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > cap ||
      ((this.phase === "hello" || this.phase === "ready") && byteLength > this.budgets.handshakeBytes) ||
      ((this.phase === "hello" || this.phase === "ready") &&
        this.retainedBytes + byteLength > this.budgets.handshakeRetainedBytes) ||
      !this.reservation.reserve(byteLength)
    ) {
      this.notifications.push(...this.close(FailureCategory.LIMIT))
      return undefined
    }
    const token = Object.freeze({ byteLength, authority: this.authority })
    this.incoming.add(token)
    return token
  }

  rejectIncoming(token: Incoming): Decision[] {
    this.releaseIncoming(token)
    return this.close(FailureCategory.MALFORMED)
  }

  acceptIncoming(token: Incoming, frame: Frame, now: number): Decision[] {
    if (!this.incoming.has(token)) throw new Error("incoming reservation")
    if (token.authority !== this.authority) return this.close(FailureCategory.DIRECTION, 4403)
    const decisions = this.advance(now)
    if (this.phase === "closed") return decisions
    if (this.phase === "established" || this.phase === "confirm") return this.established(token, frame, now)
    this.releaseIncoming(token)
    if (frame.revision !== 5) return this.close(FailureCategory.INCOMPATIBLE)
    if (frame.body.case !== "hello" && frame.body.case !== "ready") return this.close(FailureCategory.MALFORMED)
    if (["ledger", "deliveryOrdinal", "tinyConsumedThrough"].some((name) => has(frame, name)))
      return this.close(FailureCategory.MALFORMED)
    if (token.byteLength > this.budgets.handshakeBytes) return this.close(FailureCategory.LIMIT)
    const body = frame.body.value
    if (body.revision !== 5 || hex(body.contractDigest) !== CONTRACT_DIGEST || body.role !== this.options.peer)
      return this.close(FailureCategory.INCOMPATIBLE)
    if (!body.receiveWindows || !this.validWindows(body.receiveWindows)) return this.close(FailureCategory.LIMIT)
    for (const entry of [
      [LedgerClass.NORMAL, body.receiveWindows.normalBytes],
      [LedgerClass.EVENT, body.receiveWindows.eventBytes],
      [LedgerClass.BULK, body.receiveWindows.bulkBytes],
    ] as const) {
      const ledger = this.ledgers.get(entry[0])!
      if (frame.body.case === "ready" && entry[1] > BigInt(ledger.window)) return this.close(FailureCategory.LIMIT)
      ledger.window = Math.min(ledger.window, Number(entry[1]))
      this.sendWindows.set(entry[0], ledger.window)
    }
    if (frame.body.case === "hello") {
      if (this.phase !== "hello" || has(frame, "connectionEpoch")) return this.close(FailureCategory.EPOCH)
      this.epoch = this.options.epoch!
      this.sourceEpoch = this.options.sourceEpoch!
      const ready = create(FrameSchema, {
        revision: 5,
        connectionEpoch: this.epoch,
        body: {
          case: "ready",
          value: create(ReadySchema, {
            revision: 5,
            contractDigest: digest(),
            role: this.options.role,
            receiveWindows: this.windows(),
            connectionEpoch: this.epoch,
            sourceEpoch: this.sourceEpoch,
          }),
        },
      })
      if (!this.reservation.reserve(this.budgets.handshakeBytes)) return this.close(FailureCategory.LIMIT)
      this.queue.push({ frame: ready, bytes: this.budgets.handshakeBytes, available: now, key: "", count: 0 })
      this.phase = "confirm"
      this.deadline = now + this.budgets.handshakeTimeoutMs
      return []
    }
    if (
      this.phase !== "ready" ||
      !this.helloHanded ||
      !frame.body.value.connectionEpoch ||
      frame.connectionEpoch !== frame.body.value.connectionEpoch ||
      !frame.body.value.sourceEpoch
    )
      return this.close(FailureCategory.EPOCH)
    this.epoch = frame.body.value.connectionEpoch
    this.sourceEpoch = frame.body.value.sourceEpoch
    this.phase = "established"
    this.deadline = Infinity
    const generated = this.ping(now)
    return [...generated, { type: "ready", epoch: this.epoch, sourceEpoch: this.sourceEpoch }]
  }

  enqueue(body: Frame["body"], reserveBytes: number, now: number): Decision[] {
    if (body.case === "eventBatch") return this.close(FailureCategory.MALFORMED)
    return this.queueFrame(body, reserveBytes, now)
  }

  enqueueEvent(event: EventRecord, metadata: EventMetadata, now: number): Decision[] {
    const decisions = this.check(now)
    if (this.phase === "closed") return decisions
    const subscription = this.sendingSubscriptions.get(metadata.subscriptionID)
    if (!subscription || subscription.ending || !metadata.sourceEpoch || !sameScope(subscription.scope, metadata.scope))
      return this.close(FailureCategory.DIRECTION)
    const single = create(EventBatchSchema, {
      subscriptionId: metadata.subscriptionID,
      scope: subscription.scope,
      sourceEpoch: metadata.sourceEpoch,
      events: [event],
    })
    const cap = Math.min(this.budgets.eventBatchBytes, this.sendWindows.get(LedgerClass.EVENT)!)
    if (eventReservationBytes(single, this.epoch) > cap) {
      this.queue.forEach((record) => {
        if (
          record.frame.body.case !== "eventBatch" ||
          record.frame.body.value.subscriptionId !== metadata.subscriptionID
        )
          return
        record.open = false
        record.available = now
      })
      const queued = this.queueFrame(
        {
          case: "control",
          value: create(ControlSchema, {
            kind: {
              case: "resyncRequired",
              value: create(ResyncRequiredSchema, {
                scope: metadata.scope,
                sourceEpoch: metadata.sourceEpoch,
                messageId: metadata.messageID,
              }),
            },
          }),
        },
        resyncReservationBytes(metadata.scope, metadata.sourceEpoch, metadata.messageID, this.epoch),
        now,
      )
      if (this.state === "closed") return queued
      const marker = this.queue[this.queue.length - 1]
      if (!marker) return this.close(FailureCategory.MALFORMED)
      marker.eventFence = this.eventTicket
      marker.eventKey = this.subscriptionKey(metadata.subscriptionID)
      this.dropped.oversizedInvalidations++
      return [
        ...queued,
        {
          type: "resync",
          subscriptionID: metadata.subscriptionID,
          scope: metadata.scope,
          sourceEpoch: metadata.sourceEpoch,
          messageID: metadata.messageID,
        },
      ]
    }
    if (!this.validEvents(single, "send")) return this.close(FailureCategory.MALFORMED)
    const open = this.queue.find(
      (record) =>
        record.open &&
        record.frame.body.case === "eventBatch" &&
        record.frame.body.value.subscriptionId === metadata.subscriptionID,
    )
    const delay = metadata.background ? this.budgets.backgroundCoalesceMs : this.budgets.interactiveCoalesceMs
    if (open && open.frame.body.case === "eventBatch") {
      const batch = open.frame.body.value
      const merged = create(EventBatchSchema, { ...batch, events: [...batch.events, event] })
      const bytes = eventReservationBytes(merged, this.epoch)
      if (
        open.available > now &&
        batch.sourceEpoch === metadata.sourceEpoch &&
        merged.events.length <= this.budgets.eventBatchCount &&
        bytes <= cap
      ) {
        const added = bytes - open.bytes
        const prepared =
          this.prepared && this.classify(this.prepared.record.frame) === LedgerClass.EVENT
            ? this.prepared.record
            : undefined
        const queued = this.queue
          .filter((record) => this.classify(record.frame) === LedgerClass.EVENT)
          .reduce((total, record) => total + record.bytes, prepared?.bytes ?? 0)
        const count = this.queue
          .filter((record) => this.classify(record.frame) === LedgerClass.EVENT)
          .reduce((total, record) => total + record.count, prepared?.count ?? 0)
        if (
          queued + added > this.budgets.eventQueueBytes ||
          count + 1 > this.budgets.eventQueueCount ||
          (this.options.peer === PeerRole.REMOTE_CLIENT &&
            this.eventBulkBytes() + added > this.budgets.relayPeerBytes) ||
          !this.reservation.reserve(added)
        )
          return this.close(FailureCategory.LIMIT)
        open.frame.body.value = merged
        open.bytes = bytes
        open.count++
        open.available = Math.min(open.available, now + delay)
        if (open.count === this.budgets.eventBatchCount) {
          open.open = false
          open.available = now
        }
        return decisions
      }
      open.open = false
      open.available = now
    }
    subscription.sourceEpoch = metadata.sourceEpoch
    const queued = this.queueFrame(
      { case: "eventBatch", value: single },
      eventReservationBytes(single, this.epoch),
      now,
      metadata.background,
    )
    const record = this.queue[this.queue.length - 1]
    if (this.state !== "closed" && record?.frame.body.case === "eventBatch") {
      this.eventTicket++
      record.ticket = this.eventTicket
      record.open = this.budgets.eventBatchCount > 1
      if (!record.open) record.available = now
    }
    return [...decisions, ...queued]
  }

  private queueFrame(
    body: Frame["body"],
    reserveBytes: number,
    now: number,
    background = false,
    flow = false,
  ): Decision[] {
    const decisions = this.check(now)
    if (this.phase === "closed") return decisions
    if (this.phase !== "established") return this.close(FailureCategory.EPOCH)
    const frame = create(FrameSchema, { revision: 5, body })
    const ending = body.case === "streamEnd" ? body.value.subscriptionId : undefined
    if (body.case === "streamEnd") {
      if (!allowed(frame, this.options.role)) return this.close(FailureCategory.DIRECTION)
      const subscription = this.sendingSubscriptions.get(body.value.subscriptionId)
      if (!subscription || subscription.ending) return this.close(FailureCategory.MALFORMED)
      this.queue.forEach((record) => {
        if (record.frame.body.case !== "eventBatch" || record.frame.body.value.subscriptionId !== ending) return
        record.available = now
        record.open = false
      })
    }
    if (this.classify(frame) === LedgerClass.TINY && !flow) return this.close(FailureCategory.DIRECTION)
    if (body.case === "request" && !this.pending.has(body.value.requestId)) return this.close(FailureCategory.MALFORMED)
    if (body.case === "eventBatch") {
      const subscription = this.sendingSubscriptions.get(body.value.subscriptionId)
      if (
        !subscription ||
        !sameScope(subscription.scope, body.value.scope) ||
        body.value.sourceEpoch !== subscription.sourceEpoch
      )
        return this.close(FailureCategory.DIRECTION)
      if (!this.validEvents(body.value, "send")) return this.close(FailureCategory.MALFORMED)
    }
    if (body.case === "result") {
      const pending = this.inbound.get(body.value.requestId)
      if (!pending || !this.validResult(body.value, pending.operation)) return this.close(FailureCategory.MALFORMED)
      if (
        (body.value.outcome.case === "assetMetadata" && pending.assetCount !== undefined) ||
        this.queue.some(
          (record) => record.frame.body.case === "result" && record.frame.body.value.requestId === body.value.requestId,
        ) ||
        (this.prepared?.record.frame.body.case === "result" &&
          this.prepared.record.frame.body.value.requestId === body.value.requestId) ||
        [...this.outgoingTransfers.values()].some((transfer) => transfer.start.requestId === body.value.requestId)
      )
        return this.close(FailureCategory.MALFORMED)
    }
    if (body.case === "bulkStart" || body.case === "bulkPiece" || body.case === "bulkEnd") {
      const failure = this.validateOutgoingBulk(frame)
      if (failure) return this.close(failure)
    }
    const kind = this.classify(frame)
    if (!kind || !allowed(frame, this.options.role)) return this.close(FailureCategory.DIRECTION)
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 1 || reserveBytes > this.frameCap(this.options.role))
      return this.close(FailureCategory.LIMIT)
    if (reserveBytes > this.sendWindows.get(kind)!) return this.close(FailureCategory.LIMIT)
    const queued = this.queue.filter((record) => this.classify(record.frame) === kind)
    const prepared = this.prepared && this.classify(this.prepared.record.frame) === kind ? [this.prepared.record] : []
    const records = [...queued, ...prepared]
    const bytes = records.reduce((total, record) => total + record.bytes, 0)
    const ledger = this.ledgers.get(kind)!
    const count = frame.body.case === "eventBatch" ? frame.body.value.events.length : 0
    const over =
      kind === LedgerClass.NORMAL
        ? bytes + reserveBytes > this.budgets.normalQueueBytes
        : kind === LedgerClass.EVENT
          ? bytes + reserveBytes > this.budgets.eventQueueBytes ||
            records.reduce((total, record) => total + record.count, 0) + count > this.budgets.eventQueueCount ||
            reserveBytes > this.budgets.eventBatchBytes ||
            count > this.budgets.eventBatchCount
          : kind === LedgerClass.BULK
            ? bytes + reserveBytes > this.budgets.bulkWindowBytes
            : reserveBytes > this.budgets.tinyFrameBytes ||
              bytes + reserveBytes + ledger.handedBytes > this.budgets.tinyBytes ||
              records.length + ledger.sent.length >= this.budgets.tinyCount
    if (over) {
      if (kind === LedgerClass.TINY) return []
      return this.close(FailureCategory.LIMIT)
    }
    if (this.options.peer === PeerRole.REMOTE_CLIENT && (kind === LedgerClass.EVENT || kind === LedgerClass.BULK)) {
      if (this.eventBulkBytes() + reserveBytes > this.budgets.relayPeerBytes) return this.close(FailureCategory.LIMIT)
    }
    if (!this.reservation.reserve(reserveBytes)) return this.close(FailureCategory.LIMIT)
    this.queue.push({
      frame,
      bytes: reserveBytes,
      count,
      available:
        now +
        (body.case === "eventBatch"
          ? background
            ? this.budgets.backgroundCoalesceMs
            : this.budgets.interactiveCoalesceMs
          : 0),
      key: ending ? this.subscriptionKey(ending) : streamKey(frame),
    })
    if (body.case === "streamEnd") this.sendingSubscriptions.get(body.value.subscriptionId)!.ending = true
    if (body.case === "result" && body.value.outcome.case === "assetMetadata")
      this.inbound.get(body.value.requestId)!.assetCount = body.value.outcome.value.byteCount
    return decisions
  }

  request(operationID: number, scope: Scope, payload: Uint8Array, reserveBytes: number, now: number) {
    const decisions = this.check(now)
    if (this.phase === "closed") return { requestID: undefined, decisions }
    const operation = this.options.operations.find((operation) => operation.operationId === operationID)
    if (
      this.phase !== "established" ||
      !operation ||
      !this.validRequest(operation, scope, payload, this.options.role) ||
      this.pending.size + this.awaitingSubscription.size >= this.budgets.pendingRequests ||
      this.requestOrdinal === (1n << 64n) - 1n
    )
      return {
        requestID: undefined,
        decisions: [{ type: "settled", requestID: "", status: "unavailable" } satisfies Decision],
      }
    this.requestOrdinal++
    const requestID = this.requestOrdinal.toString()
    this.pending.set(requestID, { operation, scope, transmitted: false })
    return {
      requestID,
      decisions: this.enqueue(
        {
          case: "request",
          value: create(RequestSchema, {
            requestId: requestID,
            operationId: operationID,
            scope,
            payload,
          }),
        },
        reserveBytes,
        now,
      ),
    }
  }

  cancel(requestID: string, now: number): Decision[] {
    const decisions = this.check(now)
    if (this.phase === "closed") return decisions
    const pending = this.pending.get(requestID)
    if (!pending) return []
    this.pending.delete(requestID)
    this.reservation.release(pending.assetCharge ?? 0)
    this.removeQueued((frame) => frame.body.case === "request" && frame.body.value.requestId === requestID)
    this.transfers.forEach((transfer) => {
      if (transfer.start.requestId !== requestID) return
      this.reservation.release((transfer.data?.length ?? 0) + (transfer.assetCharge ?? 0))
      this.transfers.delete(transfer.start.transferId)
    })
    if (pending.transmitted)
      decisions.push(
        ...this.queueFrame(
          {
            case: "control",
            value: create(ControlSchema, {
              kind: {
                case: "cancel",
                value: create(CancelSchema, { target: { case: "requestId", value: requestID } }),
              },
            }),
          },
          this.budgets.tinyFrameBytes,
          now,
          false,
          true,
        ),
      )
    return [...decisions, { type: "settled", requestID, status: pending.transmitted ? "unknown" : "unsent" }]
  }

  expireRequest(requestID: string, now: number): Decision[] {
    return this.cancel(requestID, now)
  }

  cancelTransfer(transferID: string, now: number): Decision[] {
    const decisions = this.check(now)
    if (this.phase === "closed") return decisions
    const incoming = this.transfers.get(transferID)
    if (incoming?.complete) {
      this.releaseBulk(transferID)
      return [...decisions, { type: "transferCancelled", transferID }]
    }
    if (incoming) {
      this.httpCredits.delete(transferID)
      this.reservation.release((incoming.data?.length ?? 0) + (incoming.assetCharge ?? 0))
      this.transfers.delete(transferID)
      this.pending.delete(incoming.start.requestId)
      decisions.push(
        ...this.queueFrame(
          {
            case: "control",
            value: create(ControlSchema, {
              kind: {
                case: "cancel",
                value: create(CancelSchema, { target: { case: "transferId", value: transferID } }),
              },
            }),
          },
          this.budgets.tinyFrameBytes,
          now,
          false,
          true,
        ),
      )
      return [
        ...decisions,
        { type: "settled", requestID: incoming.start.requestId, status: "unknown" },
        { type: "transferCancelled", transferID },
      ]
    }
    const outgoing = this.outgoingTransfers.get(transferID)
    if (!outgoing) return decisions
    this.removeQueued((frame) => streamKey(frame) === transferID)
    this.outgoingTransfers.delete(transferID)
    this.inbound.delete(outgoing.start.requestId)
    return [...decisions, ...this.releaseHttpBulk(transferID), { type: "transferCancelled", transferID }]
  }

  prepareHandoff(now = this.now): Prepared | undefined {
    this.notifications.push(...this.advance(now))
    if (this.phase === "closed" || this.prepared) return undefined
    const index = this.pick(now)
    if (index < 0) return undefined
    const record = this.queue.splice(index, 1)[0]
    if (!record) return undefined
    const kind = this.classify(record.frame)
    if (kind && this.ledgers.get(kind)!.sentOrdinal === (1n << 64n) - 1n) {
      this.queue.unshift(record)
      this.notifications.push(...this.close(FailureCategory.LIMIT))
      return undefined
    }
    const frame = kind
      ? create(FrameSchema, {
          revision: 5,
          body: record.frame.body,
          connectionEpoch: this.epoch,
          ledger: kind,
          deliveryOrdinal: this.ledgers.get(kind)!.sentOrdinal + 1n,
          tinyConsumedThrough: this.ledgers.get(LedgerClass.TINY)!.consumed,
        })
      : record.frame
    const token = { frame, reservedBytes: record.bytes }
    this.prepared = { token, record, authority: this.authority }
    return token
  }

  abortPrepared(token: Prepared) {
    if (this.prepared?.token !== token) throw new Error("prepared ownership")
    this.queue.unshift(this.prepared.record)
    this.prepared = undefined
  }

  handoff(token: Prepared, exactBytes: number, now: number): Decision[] {
    if (this.prepared?.token !== token) throw new Error("prepared ownership")
    if (this.prepared.authority !== this.authority) return this.close(FailureCategory.DIRECTION, 4403)
    const decisions = this.advance(now)
    if (this.phase === "closed") return decisions
    if (!Number.isSafeInteger(exactBytes) || exactBytes < 1 || exactBytes > token.reservedBytes)
      return this.close(FailureCategory.MALFORMED)
    const kind = this.classify(token.frame)
    if (kind && (!this.rate("send", kind, exactBytes, now) || exactBytes > this.frameCap(this.options.role)))
      return this.close(FailureCategory.LIMIT)
    if (kind) {
      this.tinyReceiptSent = token.frame.tinyConsumedThrough
      const ledger = this.ledgers.get(kind)!
      ledger.sentOrdinal++
      ledger.sent.push({
        ordinal: ledger.sentOrdinal,
        bytes: exactBytes,
        charge: exactBytes,
        time: now,
        consumed: false,
        key: this.prepared.record.key,
        ticket: this.prepared.record.ticket,
        forwarded: this.prepared.record.forwarded,
        resyncScope:
          token.frame.body.case === "control" && token.frame.body.value.kind.case === "resyncRequired"
            ? token.frame.body.value.kind.value.scope
            : undefined,
      })
      this.reservation.release(token.reservedBytes - exactBytes)
      if (kind === LedgerClass.EVENT) {
        this.lastEvent = this.prepared.record.key
        this.eventRun = Math.min(this.budgets.eventToBulkRatio, this.eventRun + 1)
      }
      if (kind === LedgerClass.BULK) {
        this.lastBulk = this.prepared.record.key
        this.eventRun = 0
      }
    }
    if (!kind) this.reservation.release(token.reservedBytes)
    if (token.frame.body.case === "hello") this.helloHanded = true
    if (token.frame.body.case === "ready") {
      this.readyHanded = true
      this.deadline = now + this.budgets.handshakeTimeoutMs
    }
    if (token.frame.body.case === "request") this.pending.get(token.frame.body.value.requestId)!.transmitted = true
    if (token.frame.body.case === "result") {
      const pending = this.inbound.get(token.frame.body.value.requestId)!
      if (pending.operation.streaming === Streaming.EVENTS && token.frame.body.value.outcome.case === "success")
        this.awaitingSubscription.set(`sent:${token.frame.body.value.requestId}`, pending)
      if (token.frame.body.value.outcome.case !== "assetMetadata") this.inbound.delete(token.frame.body.value.requestId)
    }
    if (token.frame.body.case === "bulkStart")
      this.outgoingTransfers.get(token.frame.body.value.transferId)!.startHanded = token.frame.deliveryOrdinal
    if (token.frame.body.case === "bulkEnd") {
      const transfer = this.outgoingTransfers.get(token.frame.body.value.transferId)!
      this.inbound.delete(transfer.start.requestId)
      this.outgoingTransfers.delete(transfer.start.transferId)
      this.releaseHttpBulk(transfer.start.transferId)
    }
    if (token.frame.body.case === "streamEnd") this.sendingSubscriptions.delete(token.frame.body.value.subscriptionId)
    this.prepared = undefined
    return decisions
  }

  advance(now: number): Decision[] {
    const decisions = this.check(now)
    if (this.phase === "closed") return decisions
    if (this.phase === "established") {
      const httpCredits = this.flushHttpCredits(now)
      const credits = this.flushCredits(now)
      const heartbeat =
        now - this.lastPing >= this.budgets.pingIntervalMs && this.outstandingPing === undefined ? this.ping(now) : []
      return [...decisions, ...httpCredits, ...credits, ...heartbeat]
    }
    return decisions
  }

  private check(now: number): Decision[] {
    if (!Number.isFinite(now) || now < this.now) throw new Error("monotonic time")
    this.now = now
    if (this.phase === "closed") return []
    if (now >= this.deadline) return this.close(FailureCategory.INCOMPATIBLE)
    if ([...this.ledgers.values()].some((ledger) => ledger.stalled(now, this.budgets)))
      return this.close(FailureCategory.LIMIT)
    if (
      [...this.httpSending.values()].some(
        (owner) => owner.handed[0] && now - owner.handed[0].time >= this.budgets.deliveryTimeoutMs,
      )
    )
      return this.close(FailureCategory.LIMIT)
    return []
  }

  close(category: FailureCategory = FailureCategory.EPOCH, closeCode?: number): Decision[] {
    if (this.phase === "closed") return []
    const code = closeCode ?? (this.phase === "established" ? 1002 : 1008)
    const forwarded = [
      ...this.queue,
      ...(this.prepared ? [this.prepared.record] : []),
      ...[...this.ledgers.values()].flatMap((ledger) => ledger.sent),
    ]
      .filter((record) => record.forwarded)
      .map((record): Decision => ({ type: "eventBatchReleased", ticket: record.ticket!, consumed: false }))
    const httpReleased = [...this.httpSending.keys()].flatMap((id) => this.releaseHttpBulk(id))
    this.reservation.release(this.assetMetadataRetainedBytes + this.relayInterestRetainedBytes)
    this.phase = "closed"
    this.httpCredits.clear()
    this.incoming.forEach((token) => this.reservation.release(token.byteLength))
    this.incoming.clear()
    this.queue.forEach((record) => this.reservation.release(record.bytes))
    this.queue = []
    if (this.prepared) this.reservation.release(this.prepared.record.bytes)
    this.prepared = undefined
    this.ledgers.forEach((ledger) => {
      this.reservation.release(ledger.handedBytes + ledger.receivedBytes)
      ledger.sent.length = 0
      ledger.received.length = 0
    })
    const settled = [...this.pending].map(
      (entry): Decision => ({
        type: "settled",
        requestID: entry[0],
        status: entry[1].transmitted ? "unknown" : "unsent",
      }),
    )
    this.pending.clear()
    this.inbound.clear()
    this.awaitingSubscription.clear()
    this.reservation.release(this.bulkRetainedBytes)
    this.transfers.clear()
    this.relayClients.clear()
    this.relayIdentities.clear()
    this.outgoingTransfers.clear()
    this.subscriptions.forEach((subscription) => this.clearHydration(subscription))
    this.subscriptions.clear()
    this.sendingSubscriptions.clear()
    return [...httpReleased, ...forwarded, ...settled, { type: "closed", code, category }]
  }

  takeDecisions() {
    return this.notifications.splice(0)
  }

  updateAuthority(version: number, authorized: boolean, now: number, code: 4401 | 4403 = 4403): Decision[] {
    const decisions = this.check(now)
    if (!Number.isSafeInteger(version) || version <= this.authority) throw new Error("authority version")
    this.authority = version
    return authorized ? decisions : [...decisions, ...this.close(FailureCategory.DIRECTION, code)]
  }

  restart(now: number): Decision[] {
    const decisions = this.check(now)
    return [...decisions, ...this.close(FailureCategory.EPOCH, 1012)]
  }

  consume(kind: LedgerClass, ordinal: bigint, now: number): Decision[] {
    const decisions = this.advance(now)
    if (this.phase === "closed") return decisions
    const bytes = this.ledgers.get(kind)?.consume(ordinal, now)
    if (bytes === undefined) return this.close(FailureCategory.MALFORMED)
    this.reservation.release(bytes)
    return [...decisions, ...this.flushCredits(now)]
  }

  ledger(kind: LedgerClass) {
    const ledger = this.ledgers.get(kind)!
    return {
      handedBytes: ledger.handedBytes,
      receivedBytes: ledger.receivedBytes,
      outstandingBytes: ledger.outstandingBytes,
      handedCount: ledger.sent.length,
      receivedCount: ledger.received.length,
      queuedBytes:
        this.queue
          .filter((record) => this.classify(record.frame) === kind)
          .reduce((total, record) => total + record.bytes, 0) +
        (this.prepared && this.classify(this.prepared.record.frame) === kind ? this.prepared.record.bytes : 0),
      sentOrdinal: ledger.sentOrdinal,
      receivedOrdinal: ledger.receivedOrdinal,
      consumed: ledger.consumed,
    }
  }

  private established(token: Incoming, frame: Frame, now: number): Decision[] {
    if (frame.revision !== 5) return this.close(FailureCategory.INCOMPATIBLE)
    if (!has(frame, "connectionEpoch") || frame.connectionEpoch !== this.epoch) return this.close(FailureCategory.EPOCH)
    const kind = this.classify(frame)
    if (!kind || !allowed(frame, this.options.peer)) return this.close(FailureCategory.DIRECTION)
    if (!has(frame, "ledger") || frame.ledger !== kind || !has(frame, "deliveryOrdinal"))
      return this.close(FailureCategory.MALFORMED)
    if (this.phase === "confirm") {
      if (
        !this.readyHanded ||
        !(frame.body.case === "request" || (frame.body.case === "control" && frame.body.value.kind.case === "ping"))
      )
        return this.close(FailureCategory.EPOCH)
      this.phase = "established"
      this.deadline = Infinity
      this.lastPing = now
    }
    const ledger = this.ledgers.get(kind)!
    if (frame.deliveryOrdinal !== ledger.receivedOrdinal + 1n) return this.close(FailureCategory.MALFORMED)
    if (
      token.byteLength > ledger.window - ledger.outstandingBytes ||
      (kind === LedgerClass.TINY &&
        (token.byteLength > this.budgets.tinyFrameBytes || ledger.received.length >= this.budgets.tinyCount)) ||
      !this.rate("receive", kind, token.byteLength, now)
    )
      return this.close(FailureCategory.LIMIT)
    if (has(frame, "tinyConsumedThrough")) {
      const freed = this.ledgers.get(LedgerClass.TINY)!.credit(frame.tinyConsumedThrough, true)
      if (freed === undefined) return this.close(FailureCategory.MALFORMED)
      this.reservation.release(freed)
    }
    this.incoming.delete(token)
    ledger.receivedOrdinal++
    ledger.received.push({
      ordinal: frame.deliveryOrdinal,
      bytes: token.byteLength,
      charge: token.byteLength,
      time: now,
      consumed: false,
    })
    if (frame.body.case === "streamEnd") {
      const subscriptionID = frame.body.value.subscriptionId
      const subscription = this.subscriptions.get(subscriptionID)
      if (!subscription || subscription.hydrating || subscription.invalidated || subscription.resyncRequired)
        return this.close(FailureCategory.MALFORMED)
      const decisions = this.options.role === PeerRole.RELAY ? [] : this.consume(kind, frame.deliveryOrdinal, now)
      if (this.state === "closed") return decisions
      return [...decisions, ...this.releaseSubscription(subscriptionID, now), { type: "streamEnded", subscriptionID }]
    }
    if (frame.body.case === "eventBatch")
      return this.applyEvents(frame.body.value, frame.deliveryOrdinal, token.byteLength, now)
    if (frame.body.case === "request") {
      const request = frame.body.value
      const operation = this.options.operations.find((operation) => operation.operationId === request.operationId)
      if (
        !request.requestId ||
        !operation ||
        !this.validRequest(operation, request.scope, request.payload, this.options.peer)
      )
        return this.close(FailureCategory.MALFORMED)
      if (this.inbound.has(request.requestId)) return this.close(FailureCategory.MALFORMED)
      if (
        this.inbound.size + [...this.awaitingSubscription.keys()].filter((key) => key.startsWith("sent:")).length >=
        this.budgets.pendingRequests
      )
        return this.close(FailureCategory.LIMIT)
      this.inbound.set(request.requestId, { operation, scope: request.scope!, transmitted: true })
      return [{ type: "dispatch", requestID: request.requestId, request, operation, ordinal: frame.deliveryOrdinal }]
    }
    if (frame.body.case === "result") {
      const result = frame.body.value
      const pending = this.pending.get(result.requestId)
      if (!pending) {
        if (
          !/^[1-9][0-9]*$/.test(result.requestId) ||
          result.requestId.length > 20 ||
          BigInt(result.requestId) > this.requestOrdinal
        )
          return this.close(FailureCategory.MALFORMED)
        const consumed = this.consume(kind, frame.deliveryOrdinal, now)
        this.dropped.results++
        return [...consumed, { type: "dropped", reason: "late" }]
      }
      if (!pending.transmitted || !this.validResult(result, pending.operation))
        return this.close(FailureCategory.MALFORMED)
      if ([...this.transfers.values()].some((transfer) => transfer.start.requestId === result.requestId))
        return this.close(FailureCategory.MALFORMED)
      if (result.outcome.case === "assetMetadata") {
        if (pending.assetCount !== undefined) return this.close(FailureCategory.MALFORMED)
        const charge = this.options.role === PeerRole.RELAY ? 0 : token.byteLength
        if (charge && !this.reservation.reserve(charge)) return this.close(FailureCategory.LIMIT)
        pending.assetCount = result.outcome.value.byteCount
        pending.asset = this.options.role === PeerRole.RELAY ? undefined : result.outcome.value
        pending.assetCharge = charge
        return [
          ...(charge ? this.consume(LedgerClass.NORMAL, frame.deliveryOrdinal, now) : []),
          {
            type: "assetMetadata",
            requestID: result.requestId,
            metadata: result.outcome.value,
            frame,
            ordinal: frame.deliveryOrdinal,
          },
        ]
      }
      this.reservation.release(pending.assetCharge ?? 0)
      this.pending.delete(result.requestId)
      if (pending.operation.streaming === Streaming.EVENTS && result.outcome.case === "success")
        this.awaitingSubscription.set(result.requestId, pending)
      return [
        {
          type: "settled",
          requestID: result.requestId,
          status: result.outcome.case === "success" ? "success" : "rejected",
          settlement: pending.operation.settlement,
          payload: result.outcome.value,
        },
      ]
    }
    if (frame.body.case === "bulkStart" || frame.body.case === "bulkPiece" || frame.body.case === "bulkEnd")
      return this.applyBulk(frame, now)
    if (frame.body.case !== "control") return [{ type: "control", frame }]
    const control = frame.body.value.kind
    if (control.case === "failure") return this.close(control.value.category)
    if (control.case === "resyncRequired") {
      if (!control.value.scope) return this.close(FailureCategory.MALFORMED)
      this.subscriptions.forEach((subscription) => {
        if (!sameScope(subscription.scope, control.value.scope)) return
        this.clearHydration(subscription)
        subscription.invalidated = true
        subscription.resyncRequired = true
      })
      const consumed = this.consume(LedgerClass.NORMAL, frame.deliveryOrdinal, now)
      return [
        ...consumed,
        {
          type: "resync",
          scope: control.value.scope,
          sourceEpoch: control.value.sourceEpoch,
          messageID: control.value.messageId || undefined,
        },
      ]
    }
    const forwarded: Decision[] = []
    if (control.case === "credit") {
      if (control.value.ledger === LedgerClass.TINY || !this.ledgers.has(control.value.ledger))
        return this.close(FailureCategory.MALFORMED)
      if (isFieldSet(control.value, CreditSchema.fields.find((field) => field.localName === "transferId")!)) {
        const owner = this.httpSending.get(control.value.transferId)
        if (
          control.value.ledger !== LedgerClass.BULK ||
          !owner ||
          control.value.consumedThrough <= owner.through ||
          !owner.handed.some((piece) => piece.index === control.value.consumedThrough)
        )
          return this.close(FailureCategory.MALFORMED)
        const released = owner.handed
          .filter((piece) => piece.index <= control.value.consumedThrough)
          .reduce((total, piece) => total + piece.bytes, 0)
        owner.handed = owner.handed.filter((piece) => piece.index > control.value.consumedThrough)
        owner.through = control.value.consumedThrough
        this.reservation.release(released)
        forwarded.push({
          type: "httpBulkReleased",
          transferID: control.value.transferId,
          through: owner.through,
          consumed: true,
        })
      } else {
        const ledger = this.ledgers.get(control.value.ledger)!
        const tickets = ledger.sent
          .filter((record) => record.forwarded && record.ordinal <= control.value.consumedThrough && !record.consumed)
          .map((record) => record.ticket!)
        const freed = ledger.credit(control.value.consumedThrough, false)
        if (freed === undefined) return this.close(FailureCategory.MALFORMED)
        this.reservation.release(freed)
        forwarded.push(...tickets.map((ticket): Decision => ({ type: "eventBatchReleased", ticket, consumed: true })))
      }
    }
    if (control.case === "ping" && control.value.id > this.peerPing) {
      this.peerPing = control.value.id
      const generated = this.queueFrame(
        {
          case: "control",
          value: create(ControlSchema, {
            kind: { case: "pong", value: create(PongSchema, { id: control.value.id }) },
          }),
        },
        this.budgets.tinyFrameBytes,
        now,
        false,
        true,
      )
      if (this.state === "closed") return generated
    }
    if (control.case === "pong" && control.value.id === this.outstandingPing) this.outstandingPing = undefined
    const cancellations: Decision[] = []
    if (control.case === "cancel" && control.value.target.case === "requestId") {
      const requestID = control.value.target.value
      const pending = this.inbound.get(requestID)
      if (pending) {
        this.inbound.delete(requestID)
        this.removeQueued((frame) => frame.body.case === "result" && frame.body.value.requestId === requestID)
        this.outgoingTransfers.forEach((transfer, transferID) => {
          if (transfer.start.requestId !== requestID) return
          this.removeQueued((frame) => streamKey(frame) === transferID)
          this.outgoingTransfers.delete(transferID)
          cancellations.push(...this.releaseHttpBulk(transferID))
        })
        cancellations.push({
          type: "cancelled",
          requestID,
          mutation: pending.operation.mutation === MutationClass.MUTATION,
        })
      }
    }
    if (control.case === "cancel" && control.value.target.case === "transferId") {
      const transferID = control.value.target.value
      const transfer = this.outgoingTransfers.get(transferID)
      if (transfer) {
        this.removeQueued((frame) => streamKey(frame) === transferID)
        this.outgoingTransfers.delete(transferID)
        cancellations.push(...this.releaseHttpBulk(transferID))
        this.inbound.delete(transfer.start.requestId)
        cancellations.push({ type: "transferCancelled", transferID })
      }
    }
    if (kind === LedgerClass.TINY) {
      const bytes = ledger.consume(frame.deliveryOrdinal, now)!
      this.reservation.release(bytes)
      const receipt =
        forwarded.some((entry) => entry.type === "httpBulkReleased" && entry.consumed) &&
        this.outstandingPing === undefined &&
        ledger.consumed - this.tinyReceiptSent >= BigInt(Math.max(1, Math.floor(this.budgets.tinyCount / 2)))
          ? this.ping(now)
          : []
      return [...cancellations, ...forwarded, ...receipt]
    }
    return [...forwarded, { type: "control", frame }]
  }

  private validRequest(operation: OperationDescriptor, scope: Scope | undefined, payload: Uint8Array, role: PeerRole) {
    const expected = scope?.target.case?.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()
    if (
      !scope ||
      !operation.roles.includes(role) ||
      !(operation.roleScopes.find((rule) => rule.role === role)?.scopes ?? [operation.scope]).some(
        (kind) => ScopeKind[kind] === expected,
      ) ||
      payload.length > this.budgets.inlineBytes
    )
      return false
    return validPayload(operation.requestType, payload)
  }

  private clearHydration(subscription: Subscription) {
    subscription.buffered.forEach((record) => this.reservation.release(record.bytes))
    subscription.buffered = []
  }

  private applyEvents(batch: EventBatch, ordinal: bigint, bytes: number, now: number): Decision[] {
    if (!this.validEvents(batch)) return this.close(FailureCategory.MALFORMED)
    const subscription = this.subscriptions.get(batch.subscriptionId)
    if (!subscription) {
      const consumed = this.consume(LedgerClass.EVENT, ordinal, now)
      this.dropped.events++
      return [...consumed, { type: "dropped", reason: "unknown" }]
    }
    if (!sameScope(subscription.scope, batch.scope)) return this.close(FailureCategory.DIRECTION)
    if (bytes > this.budgets.eventBatchBytes || batch.events.length > this.budgets.eventBatchCount)
      return this.close(FailureCategory.LIMIT)
    if (!subscription.hydrating && batch.sourceEpoch !== subscription.sourceEpoch) {
      this.clearHydration(subscription)
      subscription.resyncRequired = true
      const consumed = this.consume(LedgerClass.EVENT, ordinal, now)
      return [
        ...consumed,
        {
          type: "resync",
          subscriptionID: batch.subscriptionId,
          scope: subscription.scope,
          sourceEpoch: batch.sourceEpoch,
        },
      ]
    }
    if (subscription.invalidated) {
      const consumed = this.consume(LedgerClass.EVENT, ordinal, now)
      this.dropped.events++
      return [...consumed, { type: "dropped", reason: "late" }]
    }
    if (!subscription.hydrating) return [{ type: "events", subscriptionID: batch.subscriptionId, batch, ordinal }]
    const count = [...this.subscriptions.values()]
      .flatMap((subscription) => subscription.buffered)
      .reduce((total, record) => total + record.batch.events.length, 0)
    if (
      this.hydrationBytes + bytes > this.budgets.eventQueueBytes ||
      count + batch.events.length > this.budgets.eventQueueCount ||
      !this.reservation.reserve(bytes)
    ) {
      this.clearHydration(subscription)
      subscription.invalidated = true
      subscription.resyncRequired = true
      const consumed = this.consume(LedgerClass.EVENT, ordinal, now)
      return [
        ...consumed,
        {
          type: "resync",
          subscriptionID: batch.subscriptionId,
          scope: subscription.scope,
          sourceEpoch: subscription.sourceEpoch,
        },
      ]
    }
    subscription.buffered.push({ batch, bytes })
    return this.consume(LedgerClass.EVENT, ordinal, now)
  }

  private validEvents(batch: EventBatch, direction: "receive" | "send" = "receive") {
    const subscription = (direction === "receive" ? this.subscriptions : this.sendingSubscriptions).get(
      batch.subscriptionId,
    )
    return batch.events.every(
      (record) =>
        !!record.eventId &&
        !!record.event &&
        this.options.eventTypes.includes(record.event.typeName) &&
        (!subscription || subscription.eventTypes.includes(record.event.typeName)) &&
        validPayload(record.event.typeName, record.event.payload),
    )
  }

  private validStart(start: BulkStart, operation: OperationDescriptor, assetCount?: bigint) {
    return (
      !!start.transferId &&
      start.operationId === operation.operationId &&
      start.typeName === operation.resultType &&
      ((operation.streaming === Streaming.TYPED_BULK && start.contentKind === ContentKind.TYPED_MESSAGE) ||
        (operation.streaming === Streaming.ASSET_BULK && start.contentKind === ContentKind.ASSET)) &&
      start.byteCount >= 0n &&
      start.byteCount <= BigInt(this.budgets.messageBytes) &&
      (start.chunkCount >= 1 || (start.contentKind === ContentKind.ASSET && start.byteCount === 0n)) &&
      start.chunkCount <= this.budgets.pieces &&
      start.byteCount <= BigInt(start.chunkCount * this.budgets.pieceBytes) &&
      (start.contentKind !== ContentKind.ASSET ||
        (assetCount === start.byteCount && start.chunkCount === Number((start.byteCount + 65535n) / 65536n)))
    )
  }

  private validateOutgoingBulk(frame: Frame) {
    if (frame.body.case === "bulkStart") {
      const start = frame.body.value
      const pending = this.inbound.get(start.requestId)
      if (
        !pending ||
        !this.validStart(start, pending.operation, pending.assetCount) ||
        this.outgoingTransfers.has(start.transferId) ||
        [...this.outgoingTransfers.values()].some((transfer) => transfer.start.requestId === start.requestId)
      )
        return FailureCategory.MALFORMED
      if (this.outgoingTransfers.size >= this.budgets.transfers) return FailureCategory.LIMIT
      this.outgoingTransfers.set(start.transferId, { start, index: 0, offset: 0n, complete: false })
      return undefined
    }
    if (frame.body.case !== "bulkPiece" && frame.body.case !== "bulkEnd") return FailureCategory.MALFORMED
    const transfer = this.outgoingTransfers.get(frame.body.value.transferId)
    if (!transfer || transfer.complete) return FailureCategory.MALFORMED
    if (frame.body.case === "bulkPiece") {
      if (this.httpSending.has(frame.body.value.transferId)) return FailureCategory.DIRECTION
      const piece = frame.body.value
      if (
        piece.index !== transfer.index ||
        piece.offset !== transfer.offset ||
        piece.data.length > this.budgets.pieceBytes ||
        transfer.index >= transfer.start.chunkCount ||
        transfer.offset + BigInt(piece.data.length) > transfer.start.byteCount ||
        (transfer.start.contentKind === ContentKind.ASSET &&
          piece.data.length !==
            Number(
              transfer.start.byteCount - transfer.offset < 65536n ? transfer.start.byteCount - transfer.offset : 65536n,
            ))
      )
        return FailureCategory.MALFORMED
      transfer.index++
      transfer.offset += BigInt(piece.data.length)
      return undefined
    }
    if (
      frame.body.value.byteCount !== transfer.offset ||
      (this.httpSending.has(frame.body.value.transferId) && !this.httpBulkConsumed(frame.body.value.transferId)) ||
      (frame.body.value.outcome.case === "success" &&
        (transfer.index !== transfer.start.chunkCount || transfer.offset !== transfer.start.byteCount))
    )
      return FailureCategory.MALFORMED
    transfer.complete = true
    return undefined
  }

  private applyBulk(frame: Frame, now: number): Decision[] {
    if (frame.body.case === "bulkStart") {
      const start = frame.body.value
      const pending = this.pending.get(start.requestId)
      if (
        !pending?.transmitted ||
        !this.validStart(start, pending.operation, pending.assetCount) ||
        this.transfers.has(start.transferId) ||
        [...this.transfers.values()].some((transfer) => transfer.start.requestId === start.requestId)
      )
        return this.close(FailureCategory.MALFORMED)
      if (
        this.transfers.size >= this.budgets.transfers ||
        this.bulkRetainedBytes + Number(start.byteCount) > this.budgets.messageBytes
      )
        return this.close(FailureCategory.LIMIT)
      const assemble = this.options.role !== PeerRole.RELAY
      if (assemble && !this.reservation.reserve(Number(start.byteCount))) return this.close(FailureCategory.LIMIT)
      this.transfers.set(start.transferId, {
        start,
        index: 0,
        offset: 0n,
        complete: false,
        data: assemble ? new Uint8Array(Number(start.byteCount)) : undefined,
        metadata: pending.asset,
        assetCharge: pending.assetCharge,
        http: pending.http ? { ordinal: frame.deliveryOrdinal, bound: false, finished: false } : undefined,
      })
      pending.assetCharge = 0
      if (pending.http) {
        if (start.chunkCount !== Number((start.byteCount + 65535n) / 65536n))
          return this.close(FailureCategory.MALFORMED)
        return [{ type: "httpBulkStart", start, metadata: pending.asset }]
      }
      if (!assemble) return [{ type: "bulkForward", frame }]
      return this.consume(LedgerClass.NORMAL, frame.deliveryOrdinal, now)
    }
    if (frame.body.case !== "bulkPiece" && frame.body.case !== "bulkEnd") return this.close(FailureCategory.MALFORMED)
    const transferID = frame.body.value.transferId
    const transfer = this.transfers.get(transferID)
    if (!transfer) {
      const consumed = this.consume(frame.ledger, frame.deliveryOrdinal, now)
      this.dropped.transfers++
      return [...consumed, { type: "dropped", reason: "late" }]
    }
    if (transfer.complete) return this.close(FailureCategory.MALFORMED)
    if (frame.body.case === "bulkPiece") {
      if (transfer.http) return this.close(FailureCategory.DIRECTION)
      const piece = frame.body.value
      if (
        piece.index !== transfer.index ||
        piece.offset !== transfer.offset ||
        piece.data.length > this.budgets.pieceBytes ||
        transfer.index >= transfer.start.chunkCount ||
        transfer.offset + BigInt(piece.data.length) > transfer.start.byteCount ||
        (transfer.start.contentKind === ContentKind.ASSET &&
          piece.data.length !==
            Number(
              transfer.start.byteCount - transfer.offset < 65536n ? transfer.start.byteCount - transfer.offset : 65536n,
            ))
      )
        return this.close(FailureCategory.MALFORMED)
      transfer.index++
      transfer.offset += BigInt(piece.data.length)
      if (!transfer.data) return [{ type: "bulkForward", frame }]
      transfer.data.set(piece.data, Number(piece.offset))
      return this.consume(LedgerClass.BULK, frame.deliveryOrdinal, now)
    }
    const pending = this.pending.get(transfer.start.requestId)!
    const end = frame.body.value
    if (
      end.byteCount !== transfer.offset ||
      (transfer.http && end.outcome.case === "success" && !transfer.http.finished) ||
      (end.outcome.case === "success" &&
        (transfer.offset !== transfer.start.byteCount || transfer.index !== transfer.start.chunkCount))
    )
      return this.close(FailureCategory.MALFORMED)
    if (
      end.outcome.case === "error" &&
      (!pending.operation.errorTypes.includes(end.outcome.value.typeName) ||
        !validPayload(end.outcome.value.typeName, end.outcome.value.payload))
    )
      return this.close(FailureCategory.MALFORMED)
    if (end.outcome.case !== "success" && end.outcome.case !== "error") return this.close(FailureCategory.MALFORMED)
    if (
      end.outcome.case === "success" &&
      transfer.start.contentKind === ContentKind.TYPED_MESSAGE &&
      transfer.data &&
      !validPayload(transfer.start.typeName, transfer.data)
    )
      return this.close(FailureCategory.MALFORMED)
    if (transfer.data && transfer.start.contentKind === ContentKind.ASSET && !transfer.metadata?.metadata)
      return this.close(FailureCategory.MALFORMED)
    transfer.complete = true
    this.pending.delete(transfer.start.requestId)
    const decisions: Decision[] = [
      {
        type: "settled",
        requestID: transfer.start.requestId,
        status: end.outcome.case === "success" ? "success" : "rejected",
        settlement: pending.operation.settlement,
        payload:
          end.outcome.case === "error"
            ? end.outcome.value
            : transfer.data && transfer.start.contentKind === ContentKind.TYPED_MESSAGE
              ? create(TypedPayloadSchema, { typeName: transfer.start.typeName, payload: transfer.data })
              : transfer.metadata?.metadata,
      },
    ]
    if (!transfer.data) {
      this.transfers.delete(transferID)
      return [...decisions, { type: "bulkForward", frame }]
    }
    decisions.push(...this.consume(LedgerClass.NORMAL, frame.deliveryOrdinal, now))
    if (end.outcome.case === "error") {
      this.releaseBulk(transferID)
      return decisions
    }
    if (!transfer.metadata?.metadata)
      return [...decisions, { type: "bulkComplete", transferID, data: transfer.data, start: transfer.start }]
    return [
      ...decisions,
      {
        type: "bulkComplete",
        transferID,
        data: transfer.data,
        start: transfer.start,
        metadata: transfer.metadata,
        result: transfer.metadata.metadata,
      },
    ]
  }

  private validResult(result: Result, operation: OperationDescriptor) {
    if (result.operationId !== operation.operationId || result.settlement !== operation.settlement) return false
    if (result.outcome.case === "assetMetadata") {
      if (operation.streaming !== Streaming.ASSET_BULK) return false
      try {
        validateAssetMetadata(result.outcome.value, operation.resultType, this.options.role === PeerRole.RELAY)
        return true
      } catch {
        return false
      }
    }
    if (operation.streaming === Streaming.ASSET_BULK && result.outcome.case === "success") return false
    const payload = result.outcome.value
    if (
      result.operationId !== operation.operationId ||
      result.settlement !== operation.settlement ||
      !payload ||
      payload.payload.length > this.budgets.inlineBytes ||
      (result.outcome.case === "success"
        ? payload.typeName !== operation.resultType
        : result.outcome.case !== "error" || !operation.errorTypes.includes(payload.typeName))
    )
      return false
    return validPayload(payload.typeName, payload.payload)
  }

  private removeQueued(predicate: (frame: Frame) => boolean) {
    this.queue = this.queue.filter((record) => {
      if (!predicate(record.frame)) return true
      if (record.forwarded)
        this.notifications.push({ type: "eventBatchReleased", ticket: record.ticket!, consumed: false })
      this.reservation.release(record.bytes)
      return false
    })
    if (!this.prepared || !predicate(this.prepared.record.frame)) return
    if (this.prepared.record.forwarded)
      this.notifications.push({ type: "eventBatchReleased", ticket: this.prepared.record.ticket!, consumed: false })
    this.reservation.release(this.prepared.record.bytes)
    this.prepared = undefined
  }

  private ping(now: number): Decision[] {
    const before = this.queue.length
    const id = this.pingID + 1n
    const decisions = this.queueFrame(
      {
        case: "control",
        value: create(ControlSchema, {
          kind: { case: "ping", value: create(PingSchema, { id }) },
        }),
      },
      this.budgets.tinyFrameBytes,
      now,
      false,
      true,
    )
    if (this.queue.length === before) return decisions
    this.pingID = id
    this.outstandingPing = id
    this.lastPing = now
    return decisions
  }

  private flushCredits(now: number): Decision[] {
    const decisions: Decision[] = []
    for (const ledger of this.ledgers.values()) {
      if (
        ledger.kind === LedgerClass.TINY ||
        ledger.consumed === ledger.grantSent ||
        !ledger.grantBytes ||
        (ledger.grantBytes < this.budgets.creditBytes && now - ledger.grantTime! < this.budgets.creditDelayMs)
      )
        continue
      const before = this.queue.length
      decisions.push(
        ...this.queueFrame(
          {
            case: "control",
            value: create(ControlSchema, {
              kind: {
                case: "credit",
                value: create(CreditSchema, { ledger: ledger.kind, consumedThrough: ledger.consumed }),
              },
            }),
          },
          this.budgets.tinyFrameBytes,
          now,
          false,
          true,
        ),
      )
      if (this.state === "closed") return decisions
      if (this.queue.length === before) continue
      ledger.grantSent = ledger.consumed
      ledger.grantBytes = 0
      ledger.grantTime = undefined
    }
    return decisions
  }

  private pick(now: number) {
    const eligible = (record: Queued) => {
      const kind = this.classify(record.frame)
      if (!kind) return true
      if (record.frame.body.case === "streamEnd") {
        const subscription = this.sendingSubscriptions.get(record.frame.body.value.subscriptionId)!
        if (
          this.queue.some(
            (other) =>
              other.frame.body.case === "control" &&
              other.frame.body.value.kind.case === "resyncRequired" &&
              sameScope(subscription.scope, other.frame.body.value.kind.value.scope),
          ) ||
          this.ledgers
            .get(LedgerClass.NORMAL)!
            .sent.some((other) => other.resyncScope && sameScope(subscription.scope, other.resyncScope))
        )
          return false
      }
      if (
        record.eventFence !== undefined &&
        (this.queue.some(
          (other) => other.key === record.eventKey && other.ticket !== undefined && other.ticket <= record.eventFence!,
        ) ||
          this.ledgers
            .get(LedgerClass.EVENT)!
            .sent.some(
              (other) =>
                other.key === record.eventKey && other.ticket !== undefined && other.ticket <= record.eventFence!,
            ))
      )
        return false
      if (
        record.frame.body.case === "bulkEnd" &&
        this.queue.some(
          (other) =>
            other !== record &&
            streamKey(other.frame) === streamKey(record.frame) &&
            other.frame.body.case !== "bulkEnd",
        )
      )
        return false
      return (
        record.available <= now &&
        record.bytes <=
          this.sendWindows.get(kind)! -
            this.ledgers.get(kind)!.handedBytes -
            (kind === LedgerClass.BULK ? this.httpHandedBytes : 0)
      )
    }
    const tiny = this.queue.findIndex((record) => this.classify(record.frame) === LedgerClass.TINY && eligible(record))
    if (tiny >= 0) return tiny
    const normal = this.queue.findIndex(
      (record) =>
        (this.classify(record.frame) === LedgerClass.NORMAL || !this.classify(record.frame)) && eligible(record),
    )
    if (normal >= 0) return normal
    const event = this.rotate(LedgerClass.EVENT, this.lastEvent, eligible)
    const bulk = this.rotate(LedgerClass.BULK, this.lastBulk, eligible)
    return event >= 0 && (bulk < 0 || this.eventRun < this.budgets.eventToBulkRatio) ? event : bulk
  }

  private rotate(kind: LedgerClass, last: string, eligible: (record: Queued) => boolean) {
    const keys = [
      ...new Set(this.queue.filter((record) => this.classify(record.frame) === kind).map((record) => record.key)),
    ]
    const start = (keys.indexOf(last) + 1) % keys.length
    for (const offset of keys.keys()) {
      const key = keys[(start + offset) % keys.length]
      const index = this.queue.findIndex((record) => this.classify(record.frame) === kind && record.key === key)
      const record = this.queue[index]
      if (record && eligible(record)) return index
    }
    return -1
  }

  private classify(frame: Frame) {
    if (frame.body.case === "hello" || frame.body.case === "ready") return undefined
    if (frame.body.case === "eventBatch" || frame.body.case === "streamEnd") return LedgerClass.EVENT
    if (frame.body.case === "bulkPiece") return LedgerClass.BULK
    if (
      frame.body.case === "control" &&
      ["ping", "pong", "credit", "cancel"].includes(frame.body.value.kind.case ?? "")
    )
      return LedgerClass.TINY
    if (["request", "result", "control", "bulkStart", "bulkEnd"].includes(frame.body.case ?? ""))
      return LedgerClass.NORMAL
    return undefined
  }

  private eventBulkBytes() {
    return (
      this.queue.reduce(
        (total, record) =>
          [LedgerClass.EVENT, LedgerClass.BULK].includes(this.classify(record.frame)!) ? total + record.bytes : total,
        0,
      ) +
      (this.prepared && [LedgerClass.EVENT, LedgerClass.BULK].includes(this.classify(this.prepared.record.frame)!)
        ? this.prepared.record.bytes
        : 0) +
      this.ledgers.get(LedgerClass.EVENT)!.handedBytes +
      this.ledgers.get(LedgerClass.BULK)!.handedBytes +
      this.httpHandedBytes
    )
  }

  private subscriptionKey(subscriptionID: string) {
    const scope = this.sendingSubscriptions.get(subscriptionID)!.scope
    return scope.target.case === "session" ? scope.target.value : subscriptionID
  }

  private rate(direction: "send" | "receive", kind: LedgerClass, bytes: number, now: number) {
    if (kind !== LedgerClass.TINY && kind !== LedgerClass.NORMAL) return true
    this.rates = this.rates.filter((record) => now - record.time < this.budgets.rateWindowMs)
    const tiny = kind === LedgerClass.TINY
    const records = this.rates.filter((record) => record.direction === direction && record.tiny === tiny)
    const role = direction === "send" ? this.options.role : this.options.peer
    const limit = tiny
      ? this.budgets.tinyRate
      : role === PeerRole.REMOTE_CLIENT
        ? this.budgets.clientRate
        : this.budgets.agentRate
    if (
      records.length >= limit ||
      (tiny && records.reduce((total, record) => total + record.bytes, 0) + bytes > this.budgets.tinyRateBytes)
    )
      return false
    this.rates.push({ direction, tiny, bytes, time: now })
    return true
  }

  private releaseIncoming(token: Incoming) {
    if (!this.incoming.delete(token)) throw new Error("incoming reservation")
    this.reservation.release(token.byteLength)
  }

  private frameCap(sender: PeerRole) {
    return sender === PeerRole.AGENT ||
      (sender !== this.options.role
        ? [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT].includes(this.options.role)
        : [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT].includes(this.options.peer))
      ? this.budgets.serverFrameBytes
      : this.budgets.clientFrameBytes
  }

  private windows() {
    return create(ReceiveWindowsSchema, {
      normalBytes: BigInt(this.ledgers.get(LedgerClass.NORMAL)!.window),
      eventBytes: BigInt(this.ledgers.get(LedgerClass.EVENT)!.window),
      bulkBytes: BigInt(this.ledgers.get(LedgerClass.BULK)!.window),
    })
  }

  private validWindows(windows: ReturnType<Connection["windows"]>) {
    return (
      windows.normalBytes > 0n &&
      windows.normalBytes <= BigInt(defaultBudgets.normalWindowBytes) &&
      windows.eventBytes > 0n &&
      windows.eventBytes <= BigInt(defaultBudgets.eventWindowBytes) &&
      windows.bulkBytes > 0n &&
      windows.bulkBytes <= BigInt(defaultBudgets.bulkWindowBytes)
    )
  }
}

function digest() {
  return Uint8Array.from(CONTRACT_DIGEST.match(/../g)!, (byte) => Number.parseInt(byte, 16))
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function has(frame: Frame, name: string) {
  return isFieldSet(frame, FrameSchema.fields.find((field) => field.localName === name)!)
}

function allowed(frame: Frame, role: PeerRole) {
  const name =
    frame.body.case === "control"
      ? frame.body.value.kind.case === "failure"
        ? "protocolFailure"
        : frame.body.value.kind.case
      : frame.body.case
  if (!name) return false
  const key = `${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_SENDERS`
  const mask = Object.entries(SenderMask).find((entry) => entry[0] === key)?.[1]
  return typeof mask === "number" && !!(mask & (1 << (role - 1)))
}

function streamKey(frame: Frame) {
  if (frame.body.case === "eventBatch") {
    const scope = frame.body.value.scope?.target
    return scope?.case === "session" ? scope.value : frame.body.value.subscriptionId
  }
  if (frame.body.case === "bulkPiece" || frame.body.case === "bulkStart" || frame.body.case === "bulkEnd")
    return frame.body.value.transferId
  return ""
}

function validPayload(name: string, payload: Uint8Array) {
  try {
    validateBinary(name, payload)
    return true
  } catch {
    return false
  }
}
