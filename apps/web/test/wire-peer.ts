import {
  createRelayConnection,
  PeerRole,
  ReservationBudget,
  receiveBinary,
  FrameSchema,
  frameReservation,
  create,
  ResultSchema,
  TypedPayloadSchema,
  ScopeSchema,
  ControlSchema,
  PublicEventSchema,
  SessionLogItemSchema,
  EventRecordSchema,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  ContentKind,
  LedgerClass,
  Streaming,
  encodeStrict,
  encodeLossless,
  FailureCategory,
  remotePayloadCodecs,
  type Connection,
  type Decision,
  type Frame,
  type BulkStart,
} from "@ycoding-ai/remote"
import { readWireMessage, writeWireMessage } from "../src/remote/wire"
import type { RelayRequestView } from "../src/remote/wire-views"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteHttp } from "../src/remote/http"
import {
  createRemoteTransport,
  type RemoteRequestOutcome,
  type RemoteTransportHandlers,
  type RemoteTransportOptions,
  type RemoteTransportStatus,
} from "../src/remote/transport"

export const fixtureSourceEpoch = "fixture-source"
export const fixtureTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
export function fixtureSession(id: string) {
  return {
    id,
    title: id,
    projectID: "prj_fixture",
    location: { directory: "/work" },
    time: { created: 1, updated: 1 },
    tokens: fixtureTokens,
    cost: 0,
  }
}
export function fixtureSnapshot(id: string) {
  return {
    data: {
      sourceEpoch: fixtureSourceEpoch,
      session: fixtureSession(id),
      messages: [],
      watermark: { type: "log.synced", aggregateID: id, seq: 0 },
    },
  }
}

export function requestView(dispatch: Extract<Decision, { type: "dispatch" }>): RelayRequestView {
  const codec = remotePayloadCodecs.get(dispatch.operation.diagnosticName)!
  const value = readWireMessage(codec.request.schema, codec.request.decode(dispatch.request.payload))
  const decoded = (Array.isArray(value) ? { [codec.request.schema.fields[0]!.name]: value } : value) as Record<
    string,
    unknown
  >
  const input = Object.fromEntries(
    Object.entries(decoded).flatMap(([key, value]) =>
      key === "scope"
        ? []
        : ["params", "query", "payload"].includes(key)
          ? Object.entries(value as Record<string, unknown>).filter(
              ([name]) => key !== "params" || (name !== "sessionID" && name !== "parentID"),
            )
          : [[key, value]],
    ),
  )
  return {
    id: dispatch.requestID,
    operation: dispatch.operation.diagnosticName,
    ...(dispatch.request.scope?.target.case === "session" || dispatch.request.scope?.target.case === "form"
      ? { sessionID: dispatch.request.scope.target.value }
      : {}),
    ...(dispatch.request.scope?.target.case === "workspace"
      ? { workspaceID: dispatch.request.scope.target.value }
      : {}),
    ...(Object.keys(input).length ? { input } : {}),
  }
}

export class BinarySocket extends EventTarget {
  readyState = 0
  binaryType = "arraybuffer"
  readonly CLOSED = 3
  readonly sent: Frame[] = []
  readonly closes: { code?: number; reason?: string }[] = []
  readonly callbacks = new Map<string, EventListener>()
  readonly dispatches: Extract<Decision, { type: "dispatch" }>[] = []
  readonly failures: Error[] = []
  readonly cancelled = new Set<string>()
  readonly connection: Connection
  quiet = false
  holdMessages = false
  private readonly heldMessages: (string | ArrayBuffer)[] = []
  private readonly heldBodies: Frame["body"][] = []
  private readonly subscriptions = new Map<string, string>()
  private readonly transfers: {
    readonly start: BulkStart
    readonly data: Uint8Array
    offset: number
    index: number
  }[] = []

  constructor(
    readonly now: () => number,
    readonly handler?: (
      request: RelayRequestView,
      dispatch: Extract<Decision, { type: "dispatch" }>,
      socket: BinarySocket,
    ) => void,
    readonly backendEpoch = fixtureSourceEpoch,
    connection?: Connection,
  ) {
    super()
    this.connection =
      connection ??
      createRelayConnection(
        PeerRole.REMOTE_CLIENT,
        crypto.randomUUID(),
        backendEpoch,
        now(),
        new ReservationBudget(32 * 1024 * 1024),
      )
  }
  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (typeof callback === "function") this.callbacks.set(type, callback)
    super.addEventListener(type, callback, options)
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event("open"))
  }
  close(code?: number, reason?: string) {
    this.readyState = 3
    this.transfers.length = 0
    this.heldBodies.length = 0
    this.closes.push({ code, reason })
    this.connection.close(5)
    this.dispatchEvent(Object.assign(new Event("close"), { code: code ?? 1000, reason: reason ?? "" }))
  }
  drop(code = 1006, reason = "") {
    this.close(code, reason)
  }
  message(data: string | ArrayBuffer) {
    if (this.holdMessages) {
      this.heldMessages.push(data)
      return
    }
    this.dispatchEvent(new MessageEvent("message", { data }))
  }
  releaseMessages() {
    this.holdMessages = false
    for (const data of this.heldMessages.splice(0)) this.message(data)
  }
  send(data: Uint8Array) {
    this.receive(data.slice().buffer)
  }
  receive(data: string | ArrayBuffer) {
    if (this.quiet) return
    const incoming = receiveBinary(this.connection, data, this.now())
    if (incoming.frame) this.sent.push(incoming.frame)
    for (const decision of incoming.decisions) {
      if (decision.type === "closed") {
        this.failures.push(new Error(`Fixture peer closed: ${decision.category}`))
        return
      }
      if (decision.type === "cancelled") {
        this.cancelled.add(decision.requestID)
        const index = this.transfers.findIndex((transfer) => transfer.start.requestId === decision.requestID)
        if (index !== -1) this.transfers.splice(index, 1)
      }
      if (decision.type !== "dispatch") continue
      this.dispatches.push(decision)
      const request = requestView(decision)
      this.handler?.(request, decision, this)
    }
    if (
      incoming.frame?.ledger === LedgerClass.NORMAL &&
      ["request", "result", "control"].includes(incoming.frame.body.case ?? "") &&
      !incoming.decisions.some(
        (decision) => decision.type === "dropped" || decision.type === "resync" || decision.type === "assetMetadata",
      ) &&
      this.connection.state !== "closed"
    )
      this.connection.consume(LedgerClass.NORMAL, incoming.frame.deliveryOrdinal, this.now())
    this.releaseBodies()
    this.flush()
  }
  flush() {
    if (this.quiet || this.readyState !== 1 || this.connection.state === "closed") return
    for (;;) {
      const prepared = this.connection.prepareHandoff(this.now())
      if (!prepared) {
        const transfer = this.transfers[0]
        if (!transfer || this.heldBodies.length || this.connection.state !== "established") return
        const piece = transfer.data.subarray(transfer.offset, transfer.offset + 65536)
        const body: Frame["body"] =
          transfer.offset === transfer.data.byteLength
            ? {
                case: "bulkEnd",
                value: create(BulkEndSchema, {
                  transferId: transfer.start.transferId,
                  byteCount: transfer.start.byteCount,
                  outcome: { case: "success", value: {} },
                }),
              }
            : {
                case: "bulkPiece",
                value: create(BulkPieceSchema, {
                  transferId: transfer.start.transferId,
                  index: transfer.index,
                  offset: BigInt(transfer.offset),
                  data: piece,
                }),
              }
        if (
          body.case === "bulkPiece" &&
          this.connection.ledger(LedgerClass.BULK).handedBytes + frameReservation(body) >
            this.connection.budgets.bulkWindowBytes
        )
          return
        const decisions = this.connection.enqueue(body, frameReservation(body), this.now())
        const rejected = decisions.find((decision) => decision.type === "closed")
        if (rejected) throw new Error(`Fixture bulk producer was rejected: ${FailureCategory[rejected.category]}`)
        if (body.case === "bulkEnd") this.transfers.shift()
        if (body.case === "bulkPiece") {
          transfer.offset += piece.byteLength
          transfer.index++
        }
        continue
      }
      if (!this.connection.reservation.reserve(prepared.reservedBytes))
        throw new Error("Fixture send ownership exhausted")
      try {
        const bytes = encodeStrict(FrameSchema, prepared.frame)
        const closed = this.connection
          .handoff(prepared, bytes.byteLength, this.now())
          .find((decision) => decision.type === "closed")
        if (closed) {
          this.failures.push(new Error(`Fixture send closed: ${closed.category}`))
          return
        }
        this.message(bytes.slice().buffer)
      } finally {
        this.connection.reservation.release(prepared.reservedBytes)
      }
    }
  }
  body(body: Frame["body"]) {
    if (this.connection.state === "closed") throw new Error("Fixture peer is closed")
    // The connection closes on a body sent before establishment; hold bodies in order until a receive establishes it.
    if (this.connection.state !== "established" || this.heldBodies.length) {
      this.heldBodies.push(body)
      return
    }
    this.enqueueBody(body)
    this.flush()
  }
  private releaseBodies() {
    while (this.heldBodies.length && this.connection.state === "established") this.enqueueBody(this.heldBodies.shift()!)
  }
  private enqueueBody(body: Frame["body"]) {
    const rejected = this.connection
      .enqueue(body, frameReservation(body), this.now())
      .find((decision) => decision.type === "closed")
    if (rejected) throw new Error(`Fixture body was rejected: ${FailureCategory[rejected.category]}`)
  }
  // A reply to a request whose connection has closed is dropped; only pushes report a closed peer.
  result(dispatch: Extract<Decision, { type: "dispatch" }>, value: unknown) {
    if (this.connection.state === "closed") return
    const codec = remotePayloadCodecs.get(dispatch.operation.diagnosticName)!
    const payload = codec.result.encode(writeWireMessage(codec.result.schema, value))
    if (payload.byteLength > this.connection.budgets.inlineBytes) {
      this.bulk(dispatch, payload, ContentKind.TYPED_MESSAGE)
      return
    }
    this.body({
      case: "result",
      value: create(ResultSchema, {
        requestId: dispatch.requestID,
        operationId: dispatch.operation.operationId,
        settlement: dispatch.operation.settlement,
        outcome: {
          case: "success",
          value: create(TypedPayloadSchema, { typeName: dispatch.operation.resultType, payload }),
        },
      }),
    })
    if (dispatch.operation.diagnosticName === "event.unsubscribe") {
      const input = requestView(dispatch).input
      if (typeof input?.subscription_id !== "string")
        throw new Error("Fixture unsubscribe requires its subscription identity")
      this.connection.releaseSubscription(input.subscription_id, this.now(), "send")
      for (const [sessionID, subscriptionID] of this.subscriptions)
        if (subscriptionID === input.subscription_id) this.subscriptions.delete(sessionID)
    }
    if (dispatch.operation.streaming === Streaming.EVENTS) {
      const fields = value as { subscription_id: string }
      this.connection.acceptSubscription(
        dispatch.requestID,
        fields.subscription_id,
        dispatch.request.scope!,
        this.now(),
        "send",
        this.backendEpoch,
      )
      if (dispatch.operation.diagnosticName === "event.subscribe")
        this.subscriptions.set(dispatch.request.scope!.target.value as string, fields.subscription_id)
    }
  }
  error(dispatch: Extract<Decision, { type: "dispatch" }>, typeName: string, value: unknown) {
    if (this.connection.state === "closed") return
    const codec = remotePayloadCodecs.get(dispatch.operation.diagnosticName)!.errors.get(typeName)
    if (!codec) throw new Error("Fixture error type does not belong to the operation")
    this.body({
      case: "result",
      value: create(ResultSchema, {
        requestId: dispatch.requestID,
        operationId: dispatch.operation.operationId,
        settlement: dispatch.operation.settlement,
        outcome: {
          case: "error",
          value: create(TypedPayloadSchema, { typeName, payload: codec.encode(writeWireMessage(codec.schema, value)) }),
        },
      }),
    })
  }
  malformedResult(dispatch: Extract<Decision, { type: "dispatch" }>, payload: Uint8Array) {
    const request = this.sent.findLast(
      (frame) => frame.body.case === "request" && frame.body.value.requestId === dispatch.requestID,
    )
    if (!request) throw new Error("Malformed result fixture requires its observed request frame")
    this.message(
      encodeStrict(
        FrameSchema,
        create(FrameSchema, {
          revision: 5,
          connectionEpoch: request.connectionEpoch,
          ledger: LedgerClass.NORMAL,
          deliveryOrdinal: this.connection.ledger(LedgerClass.NORMAL).sentOrdinal + 1n,
          tinyConsumedThrough: this.connection.ledger(LedgerClass.TINY).consumed,
          body: {
            case: "result",
            value: create(ResultSchema, {
              requestId: dispatch.requestID,
              operationId: dispatch.operation.operationId,
              settlement: dispatch.operation.settlement,
              outcome: {
                case: "success",
                value: create(TypedPayloadSchema, { typeName: dispatch.operation.resultType, payload }),
              },
            }),
          },
        }),
      ).slice().buffer,
    )
  }
  asset(dispatch: Extract<Decision, { type: "dispatch" }>, data: Uint8Array, mime = "image/png") {
    if (this.connection.state === "closed") return
    const codec = remotePayloadCodecs.get(dispatch.operation.diagnosticName)!
    this.body({
      case: "result",
      value: create(ResultSchema, {
        requestId: dispatch.requestID,
        operationId: dispatch.operation.operationId,
        settlement: dispatch.operation.settlement,
        outcome: {
          case: "assetMetadata",
          value: {
            metadata: {
              typeName: codec.operation.resultType,
              payload: codec.result.encode(
                writeWireMessage(codec.result.schema, { data: { mime, bytes: data.byteLength } }),
              ),
            },
            mime: encodeLossless(mime),
            byteCount: BigInt(data.byteLength),
          },
        },
      }),
    })
    this.bulk(dispatch, data, ContentKind.ASSET)
  }
  private bulk(dispatch: Extract<Decision, { type: "dispatch" }>, data: Uint8Array, contentKind: ContentKind) {
    const transferId = `fixture-${dispatch.requestID}`
    const start = create(BulkStartSchema, {
      requestId: dispatch.requestID,
      transferId,
      operationId: dispatch.operation.operationId,
      typeName: dispatch.operation.resultType,
      contentKind,
      byteCount: BigInt(data.byteLength),
      chunkCount: Math.ceil(data.byteLength / 65536),
    })
    this.body({ case: "bulkStart", value: start })
    this.transfers.push({ start, data, offset: 0, index: 0 })
    this.flush()
  }
  events(sessionID: string, events: readonly unknown[]) {
    const subscriptionID = this.subscriptions.get(sessionID)
    if (!subscriptionID) return
    for (const event of events) {
      const value = readWireMessage(PublicEventSchema, writeWireMessage(PublicEventSchema, event)) as {
        id: string
        created: number
        durable?: { aggregateID: string; seq: number; version: number }
      }
      const decisions = this.connection.enqueueEvent(
        create(EventRecordSchema, {
          eventId: value.id,
          createdMs: BigInt(value.created),
          ...(value.durable
            ? {
                durable: {
                  aggregateId: value.durable.aggregateID,
                  sequence: BigInt(value.durable.seq),
                  version: value.durable.version,
                },
              }
            : {}),
          event: {
            typeName: PublicEventSchema.typeName,
            payload: encodeStrict(PublicEventSchema, writeWireMessage(PublicEventSchema, event)),
          },
        }),
        {
          scope: create(ScopeSchema, { target: { case: "session", value: sessionID } }),
          subscriptionID,
          sourceEpoch: this.backendEpoch,
        },
        this.now(),
      )
      if (decisions.some((decision) => decision.type === "closed")) throw new Error("Fixture event was rejected")
    }
    this.flush()
  }
  log(sessionID: string, subscriptionID: string, events: readonly unknown[], after: number) {
    if (this.connection.state === "closed") return
    const records = events.map((event, index) => {
      if (typeof event !== "object" || event === null) throw new Error("Expected a log event object")
      return {
        id: `log-${index}`,
        created: 1,
        sourceEpoch: this.backendEpoch,
        ...event,
      }
    })
    const watermark = Math.max(after, ...records.map((event) => Reflect.get(event, "durable")?.seq ?? 0))
    for (const event of [
      ...records,
      { type: "log.synced", aggregateID: sessionID, sourceEpoch: this.backendEpoch, seq: watermark },
    ]) {
      const durable = Reflect.get(event, "durable")
      this.connection.enqueueEvent(
        create(EventRecordSchema, {
          eventId: Reflect.get(event, "id") ?? `log-synced-${watermark}`,
          createdMs: BigInt(Reflect.get(event, "created") ?? 1),
          durable: {
            aggregateId: sessionID,
            sequence: BigInt(durable?.seq ?? watermark),
            version: durable?.version ?? 1,
          },
          event: {
            typeName: SessionLogItemSchema.typeName,
            payload: encodeStrict(SessionLogItemSchema, writeWireMessage(SessionLogItemSchema, event)),
          },
        }),
        {
          scope: create(ScopeSchema, { target: { case: "session", value: sessionID } }),
          subscriptionID,
          sourceEpoch: this.backendEpoch,
        },
        this.now(),
      )
    }
    this.flush()
    this.body({ case: "streamEnd", value: { $typeName: "ycoding.v5.StreamEnd", subscriptionId: subscriptionID } })
  }
  control(kind: NonNullable<Parameters<typeof create<typeof ControlSchema>>[1]>["kind"]) {
    this.body({ case: "control", value: create(ControlSchema, { kind }) })
  }
  requests() {
    return this.dispatches.map(requestView)
  }
}

export function imageStoreFixture(
  read: (
    request: Parameters<import("../src/remote/transport").RemoteTransport["request"]>[1],
  ) => Promise<RemoteRequestOutcome>,
  deviceID = "dev_image",
) {
  let handlers: RemoteTransportHandlers | undefined
  const store = createRemoteStore({
    http: createRemoteHttp(),
    batchMs: 0,
    createTransport: (_deviceID, callbacks) => {
      handlers = callbacks
      return {
        connect: () => callbacks.onStatus?.({ kind: "open" }),
        close: () => {},
        setPriority: () => {},
        status: () => ({ kind: "open" }),
        request: async (operation, request) => {
          if (operation === "session.attachment.read") return read(request)
          if (operation === "session.snapshot")
            return { status: "ok", value: fixtureSnapshot(request?.sessionID ?? "ses_image") }
          if (operation === "session.get")
            return { status: "ok", value: { data: fixtureSession(request?.sessionID ?? "ses_image") } }
          if (operation === "event.subscribe")
            return { status: "ok", value: { subscription_id: `sub-${request?.sessionID}` } }
          if (operation === "session.list") return { status: "ok", value: { data: { data: [], cursor: {} } } }
          if (operation === "session.status") return { status: "ok", value: { running: [], attention: [] } }
          if (operation === "session.autonomy.get")
            return { status: "ok", value: { data: { mode: "normal", yolo: 0 } } }
          return { status: "ok", value: { data: [] } }
        },
      }
    },
  })
  store.connect(deviceID)
  return { store, handlers: () => handlers! }
}

class Signals extends EventTarget {
  hidden = false
  readonly listeners = new Set<string>()
  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    this.listeners.add(type)
    super.addEventListener(type, callback, options)
  }
  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    this.listeners.delete(type)
    super.removeEventListener(type, callback, options)
  }
  change(hidden: boolean) {
    this.hidden = hidden
    this.dispatchEvent(new Event("visibilitychange"))
  }
}

export function transportFixture(
  options: Partial<RemoteTransportOptions> & {
    readonly open?: boolean
    readonly quiet?: boolean
    readonly handler?: BinarySocket["handler"]
  } = {},
) {
  const document = new Signals()
  const window = new Signals()
  const sockets: BinarySocket[] = []
  const statuses: RemoteTransportStatus[] = []
  const batches: { readonly sessionID: string; readonly events: readonly unknown[] }[] = []
  const clock = { now: 0 }
  const tasks: { readonly at: number; readonly callback: () => void; cancelled: boolean }[] = []
  const schedule = (callback: () => void, ms: number) => {
    const task = { at: clock.now + ms, callback, cancelled: false }
    tasks.push(task)
    return () => {
      task.cancelled = true
    }
  }
  const advance = (ms: number) => {
    const end = clock.now + ms
    for (;;) {
      const task = tasks
        .filter((task) => !task.cancelled && task.at <= end)
        .sort((left, right) => left.at - right.at)[0]
      if (!task) break
      task.cancelled = true
      clock.now = task.at
      task.callback()
      sockets.forEach((socket) => socket.flush())
    }
    clock.now = end
    sockets.forEach((socket) => socket.flush())
  }
  const transport = createRemoteTransport({
    url: "wss://fixture.invalid/ws/v5/client",
    document,
    window,
    now: () => clock.now,
    schedule,
    resetDelayMs: 2,
    random: () => 0,
    pingIntervalMs: 600_000,
    ...options,
    handlers: {
      onStatus: (status) => statuses.push(status),
      onEvents: (sessionID, events) => batches.push({ sessionID, events }),
      ...options.handlers,
    },
    createSocket: () => {
      const socket = new BinarySocket(() => clock.now, options.handler)
      socket.quiet = options.quiet ?? false
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
  })
  transport.connect()
  if (options.open !== false) sockets[0]!.open()
  return { transport, sockets, statuses, batches, document, window, advance, clock, tasks }
}

export async function fillWindow(fixture: ReturnType<typeof transportFixture>, count: number) {
  for (let index = 0; index < count; index++) {
    const request = fixture.transport.request("session.list", { timeoutMs: 0 })
    fixture.sockets[0]!.result(fixture.sockets[0]!.dispatches.at(-1)!, { data: { data: [], cursor: {} } })
    await request
  }
}
