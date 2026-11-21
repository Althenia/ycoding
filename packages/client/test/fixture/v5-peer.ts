import { Connection } from "@ycoding-ai/protocol/v5/connection"
import type { Decision, ConfigurableBudgets } from "@ycoding-ai/protocol/v5/connection"
import {
  create,
  encodeStrict,
  decodeStrict,
  FrameSchema,
  PeerRole,
  operations,
  PublicEventSchema,
  SessionLogItemSchema,
  ResultSchema,
  TypedPayloadSchema,
  InvalidRequestErrorSchema,
  Streaming,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
  session_log_ResultSchema,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  ContentKind,
  encodeAssetMetadata,
  encodeLossless,
  session_attachment_read_ResultSchema,
  EventRecordSchema,
} from "@ycoding-ai/protocol/v5"
import type { Scope } from "@ycoding-ai/protocol/v5"
import type { Socket } from "../../src/v5/socket.js"

export type Dispatch = Extract<Decision, { type: "dispatch" }>

export class ScriptedSocket extends EventTarget implements Socket {
  readyState = 0
  binaryType = "arraybuffer"
  constructor(readonly peer: ScriptedPeer) {
    super()
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event("open"))
  }
  send(bytes: Uint8Array) {
    this.peer.receive(bytes)
  }
  deliver(bytes: Uint8Array) {
    this.dispatchEvent(
      new MessageEvent("message", { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }),
    )
  }
  close() {
    this.readyState = 3
    this.dispatchEvent(new Event("close"))
  }
}

export class ScriptedPeer {
  readonly connection: Connection
  readonly socket = new ScriptedSocket(this)
  readonly requests: Dispatch[] = []
  readonly cancellations: string[] = []
  readonly subscriptions = new Map<string, Scope>()
  onRequest?: (dispatch: Dispatch) => void
  transform?: (bytes: Uint8Array) => Uint8Array
  private time = performance.now()
  private waiters: ((dispatch: Dispatch) => void)[] = []

  constructor(epoch = "connection-1", budgets: Partial<ConfigurableBudgets> = {}) {
    this.connection = new Connection({
      role: PeerRole.SERVER,
      peer: PeerRole.LOCAL_CLIENT,
      operations,
      eventTypes: [PublicEventSchema.typeName, SessionLogItemSchema.typeName],
      epoch,
      sourceEpoch: "source-1",
      now: this.time,
      budgets,
    })
  }

  nextRequest() {
    return new Promise<Dispatch>((resolve) => this.waiters.push(resolve))
  }

  receive(bytes: Uint8Array) {
    this.time = Math.max(this.time, performance.now())
    const token = this.connection.admitIncoming(bytes.length)
    if (!token) throw new Error("peer input was refused")
    const frame = decodeStrict(FrameSchema, bytes)
    const decisions = this.connection.acceptIncoming(token, frame, this.time)
    for (const decision of decisions) {
      if (decision.type === "dispatch") {
        this.requests.push(decision)
        this.waiters.shift()?.(decision)
        this.onRequest?.(decision)
        this.connection.consume(frame.ledger, decision.ordinal, this.time)
      }
      if (decision.type === "cancelled") this.cancellations.push(decision.requestID)
    }
    this.flush()
  }

  reject(dispatch: Dispatch) {
    const payload = encodeStrict(
      InvalidRequestErrorSchema,
      create(InvalidRequestErrorSchema, {
        Tag: 1,
        message: { encoding: { case: "utf8", value: "Scripted rejection" } },
      }),
    )
    this.result(dispatch, { typeName: InvalidRequestErrorSchema.typeName, payload }, true)
  }

  result(dispatch: Dispatch, payload: { typeName: string; payload: Uint8Array }, rejected = false) {
    const body = create(ResultSchema, {
      requestId: dispatch.requestID,
      operationId: dispatch.operation.operationId,
      settlement: dispatch.operation.settlement,
      outcome: { case: rejected ? "error" : "success", value: create(TypedPayloadSchema, payload) },
    })
    this.connection.enqueue({ case: "result", value: body }, payload.payload.length + 512, this.time)
    this.flush()
  }

  subscribe(dispatch: Dispatch, id = "subscription-1") {
    const schema =
      dispatch.operation.diagnosticName === "event.subscribe" ? event_subscribe_ResultSchema : session_log_ResultSchema
    this.result(dispatch, {
      typeName: schema.typeName,
      payload: encodeStrict(schema, create(schema, { subscriptionId: { encoding: { case: "utf8", value: id } } })),
    })
  }

  bulk(dispatch: Dispatch, payload: Uint8Array) {
    const transferId = "transfer-1"
    this.connection.enqueue(
      {
        case: "bulkStart",
        value: create(BulkStartSchema, {
          requestId: dispatch.requestID,
          transferId,
          operationId: dispatch.operation.operationId,
          typeName: dispatch.operation.resultType,
          contentKind: ContentKind.TYPED_MESSAGE,
          byteCount: BigInt(payload.length),
          chunkCount: 2,
        }),
      },
      512,
      this.time,
    )
    const offset = Math.floor(payload.length / 2)
    this.connection.enqueue(
      {
        case: "bulkPiece",
        value: create(BulkPieceSchema, { transferId, index: 0, offset: 0n, data: payload.subarray(0, offset) }),
      },
      offset + 512,
      this.time,
    )
    this.connection.enqueue(
      {
        case: "bulkPiece",
        value: create(BulkPieceSchema, {
          transferId,
          index: 1,
          offset: BigInt(offset),
          data: payload.subarray(offset),
        }),
      },
      payload.length - offset + 512,
      this.time,
    )
    this.connection.enqueue(
      {
        case: "bulkEnd",
        value: create(BulkEndSchema, {
          transferId,
          byteCount: BigInt(payload.length),
          outcome: { case: "success", value: {} },
        }),
      },
      512,
      this.time,
    )
    this.flush()
  }

  events(id: string, payloads: { typeName: string; payload: Uint8Array }[], sourceEpoch = "source-1") {
    payloads.forEach((event, index) => {
      const decisions = this.connection.enqueueEvent(
        create(EventRecordSchema, { eventId: `evt_${index}`, createdMs: BigInt(index), event }),
        { subscriptionID: id, scope: this.subscriptions.get(id)!, sourceEpoch },
        this.time,
      )
      if (decisions.some((decision) => decision.type === "closed")) throw new Error("Peer event admission failed")
    })
    this.time += 50
    this.connection.advance(this.time)
    this.flush()
  }

  asset(dispatch: Dispatch, data: Uint8Array) {
    const metadata = encodeAssetMetadata(
      session_attachment_read_ResultSchema,
      create(session_attachment_read_ResultSchema, {
        data: { mime: encodeLossless("application/octet-stream"), bytes: BigInt(data.length) },
      }),
    )
    this.connection.enqueue(
      {
        case: "result",
        value: create(ResultSchema, {
          requestId: dispatch.requestID,
          operationId: dispatch.operation.operationId,
          settlement: dispatch.operation.settlement,
          outcome: { case: "assetMetadata", value: metadata },
        }),
      },
      1024,
      this.time,
    )
    const transferId = `asset-${dispatch.requestID}`
    this.connection.enqueue(
      {
        case: "bulkStart",
        value: create(BulkStartSchema, {
          requestId: dispatch.requestID,
          transferId,
          operationId: dispatch.operation.operationId,
          typeName: dispatch.operation.resultType,
          contentKind: ContentKind.ASSET,
          byteCount: BigInt(data.length),
          chunkCount: Math.ceil(data.length / 65536),
        }),
      },
      512,
      this.time,
    )
    for (let offset = 0; offset < data.length; offset += 65536) {
      const piece = data.subarray(offset, offset + 65536)
      this.connection.enqueue(
        {
          case: "bulkPiece",
          value: create(BulkPieceSchema, {
            transferId,
            index: offset / 65536,
            offset: BigInt(offset),
            data: piece,
          }),
        },
        piece.length + 512,
        this.time,
      )
    }
    this.connection.enqueue(
      {
        case: "bulkEnd",
        value: create(BulkEndSchema, {
          transferId,
          byteCount: BigInt(data.length),
          outcome: { case: "success", value: {} },
        }),
      },
      512,
      this.time,
    )
    this.flush()
  }

  end(id: string) {
    this.connection.enqueue(
      { case: "streamEnd", value: { $typeName: "ycoding.v5.StreamEnd", subscriptionId: id } },
      512,
      this.time,
    )
    this.flush()
  }

  flush() {
    for (;;) {
      const prepared = this.connection.prepareHandoff(this.time)
      if (!prepared) break
      const bytes = encodeStrict(FrameSchema, prepared.frame)
      const decisions = this.connection.handoff(prepared, bytes.length, this.time)
      if (decisions.some((decision) => decision.type === "closed")) throw new Error("peer handoff closed")
      const frame = prepared.frame
      if (frame.body.case === "result" && frame.body.value.outcome.case === "success") {
        const requestID = frame.body.value.requestId
        const request = this.requests.find((request) => request.requestID === requestID)!
        if (request.operation.streaming === Streaming.EVENTS) {
          const schema =
            request.operation.diagnosticName === "event.subscribe"
              ? event_subscribe_ResultSchema
              : session_log_ResultSchema
          const result = decodeStrict(schema, frame.body.value.outcome.value.payload)
          const id = result.subscriptionId!.encoding
          if (id.case !== "utf8") throw new Error("subscription fixture")
          const scope =
            request.operation.diagnosticName === "event.subscribe"
              ? decodeStrict(event_subscribe_RequestSchema, request.request.payload).scope!
              : request.request.scope!
          this.connection.acceptSubscription(request.requestID, id.value, scope, this.time, "send")
          this.subscriptions.set(id.value, scope)
        }
      }
      queueMicrotask(() => this.socket.deliver(this.transform ? this.transform(bytes) : bytes))
    }
  }
}
