import { expect, test } from "bun:test"
import { create, toBinary } from "@bufbuild/protobuf"
import { pair, send, receive, machine, health, healthRequest, healthResult } from "./connection-fixtures.js"
import {
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  FrameSchema,
  LedgerClass,
  ContentKind,
  EmptySchema,
  TypedPayloadSchema,
  InvalidRequestErrorSchema,
  LosslessStringSchema,
} from "../src/generated/v5/index.js"
import type { Frame } from "../src/generated/v5/index.js"

function bulkFrames(requestID = "1") {
  const result = healthResult(requestID)
  if (result.case !== "result" || result.value.outcome.case !== "success") throw new Error("fixture")
  const payload = result.value.outcome.value.payload
  const start = create(BulkStartSchema, {
    requestId: requestID,
    transferId: "transfer-1",
    operationId: health.operationId,
    typeName: health.resultType,
    contentKind: ContentKind.TYPED_MESSAGE,
    byteCount: BigInt(payload.length),
    chunkCount: 2,
  })
  const first = create(BulkPieceSchema, {
    transferId: start.transferId,
    index: 0,
    offset: 0n,
    data: payload.subarray(0, 10),
  })
  const second = create(BulkPieceSchema, {
    transferId: start.transferId,
    index: 1,
    offset: 10n,
    data: payload.subarray(10),
  })
  const end = create(BulkEndSchema, {
    transferId: start.transferId,
    byteCount: start.byteCount,
    outcome: { case: "success", value: create(EmptySchema) },
  })
  return { start, first, second, end, payload }
}

function requested() {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  send(endpoints.client, endpoints.server)
  return endpoints
}

function envelope(body: Frame["body"], ordinal: bigint, ledger = LedgerClass.NORMAL) {
  return create(FrameSchema, { revision: 5, connectionEpoch: "connection-1", deliveryOrdinal: ordinal, ledger, body })
}

test("typed bulk settles only after exact contiguous complete bytes and descriptor validation", () => {
  const endpoints = requested()
  const frames = bulkFrames()
  expect(
    receive(endpoints.client, envelope({ case: "bulkStart", value: frames.start }, 1n)).some(
      (decision) => decision.type === "settled",
    ),
  ).toBe(false)
  receive(endpoints.client, envelope({ case: "bulkPiece", value: frames.first }, 1n, LedgerClass.BULK))
  receive(endpoints.client, envelope({ case: "bulkPiece", value: frames.second }, 2n, LedgerClass.BULK))
  const decisions = receive(endpoints.client, envelope({ case: "bulkEnd", value: frames.end }, 2n))
  expect(decisions).toContainEqual(
    expect.objectContaining({ type: "settled", requestID: "1", status: "success", settlement: health.settlement }),
  )
  expect(decisions).toContainEqual(
    expect.objectContaining({ type: "bulkComplete", transferID: "transfer-1", data: frames.payload }),
  )
  expect(endpoints.client.bulkRetainedBytes).toBe(frames.payload.length)
  endpoints.client.releaseBulk("transfer-1")
  expect(endpoints.client.bulkRetainedBytes).toBe(0)
})

test.each(["index", "offset", "total", "early", "count", "type", "size"])(
  "bulk %s mismatch never partially succeeds",
  (variant) => {
    const endpoints = requested()
    const frames = bulkFrames()
    if (variant === "count") frames.start.chunkCount = 1025
    if (variant === "type") frames.start.typeName = "ycoding.v5.Empty"
    if (variant === "size") frames.start.byteCount = 67108865n
    const decisions = receive(endpoints.client, envelope({ case: "bulkStart", value: frames.start }, 1n))
    if (endpoints.client.state === "closed") {
      expect(decisions).toContainEqual(expect.objectContaining({ type: "closed" }))
      expect(endpoints.client.bulkRetainedBytes).toBe(0)
      return
    }
    if (variant === "index") frames.first.index = 1
    if (variant === "offset") frames.first.offset = 1n
    if (variant === "total") frames.end.byteCount++
    const piece = receive(endpoints.client, envelope({ case: "bulkPiece", value: frames.first }, 1n, LedgerClass.BULK))
    const terminal = piece.some((decision) => decision.type === "closed")
      ? piece
      : receive(endpoints.client, envelope({ case: "bulkEnd", value: frames.end }, 2n))
    expect(terminal).toContainEqual(expect.objectContaining({ type: "closed" }))
    expect(terminal.some((decision) => decision.type === "settled" && decision.status === "success")).toBe(false)
    expect(endpoints.client.bulkRetainedBytes).toBe(0)
  },
)

test("premature connection replacement yields unknown and releases typed reassembly", () => {
  const endpoints = requested()
  const frames = bulkFrames()
  receive(endpoints.client, envelope({ case: "bulkStart", value: frames.start }, 1n))
  receive(endpoints.client, envelope({ case: "bulkPiece", value: frames.first }, 1n, LedgerClass.BULK))
  expect(endpoints.client.restart(0)).toContainEqual({ type: "settled", requestID: "1", status: "unknown" })
  expect(endpoints.client.reservation.used).toBe(0)
})

test("a typed stream error settles rejection and frees partial content without a completed message", () => {
  const endpoints = requested()
  const frames = bulkFrames()
  receive(endpoints.client, envelope({ case: "bulkStart", value: frames.start }, 1n))
  receive(endpoints.client, envelope({ case: "bulkPiece", value: frames.first }, 1n, LedgerClass.BULK))
  frames.end.byteCount = BigInt(frames.first.data.length)
  const payload = toBinary(
    InvalidRequestErrorSchema,
    create(InvalidRequestErrorSchema, {
      Tag: 1,
      message: create(LosslessStringSchema, { encoding: { case: "utf8", value: "bounded-error" } }),
    }),
  )
  frames.end.outcome = {
    case: "error",
    value: create(TypedPayloadSchema, { typeName: InvalidRequestErrorSchema.typeName, payload }),
  }
  const decisions = receive(endpoints.client, envelope({ case: "bulkEnd", value: frames.end }, 2n))
  expect(decisions).toContainEqual(expect.objectContaining({ type: "settled", status: "rejected" }))
  expect(decisions.some((decision) => decision.type === "bulkComplete")).toBe(false)
  expect(endpoints.client.bulkRetainedBytes).toBe(0)
})

test("Cancel frees its transfer slot immediately; orphan pieces/end are ledgered late drops", () => {
  const endpoints = requested()
  const frames = bulkFrames()
  receive(endpoints.client, envelope({ case: "bulkStart", value: frames.start }, 1n))
  const cancellation = endpoints.client.cancelTransfer("transfer-1", 0)
  expect(cancellation).toContainEqual({ type: "settled", requestID: "1", status: "unknown" })
  expect(endpoints.client.bulkRetainedBytes).toBe(0)
  expect(
    receive(endpoints.client, envelope({ case: "bulkPiece", value: frames.first }, 1n, LedgerClass.BULK)),
  ).toContainEqual({ type: "dropped", reason: "late" })
  expect(receive(endpoints.client, envelope({ case: "bulkEnd", value: frames.end }, 2n))).toContainEqual({
    type: "dropped",
    reason: "late",
  })
  expect(endpoints.client.counters.transfers).toBe(2)
  expect(endpoints.client.ledger(LedgerClass.BULK)).toMatchObject({
    receivedOrdinal: 1n,
    consumed: 1n,
    receivedBytes: 0,
  })
  endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  const next = bulkFrames("2")
  next.start.transferId = "transfer-2"
  expect(receive(endpoints.client, envelope({ case: "bulkStart", value: next.start }, 3n))).toContainEqual(
    expect.objectContaining({ type: "closed" }),
  )
})

test("a new transfer can start after cancelled ownership without exceeding the transfer cap", () => {
  const endpoints = requested()
  const first = bulkFrames()
  receive(endpoints.client, envelope({ case: "bulkStart", value: first.start }, 1n))
  endpoints.client.cancelTransfer("transfer-1", 0)
  send(endpoints.client, endpoints.server)
  const admission = endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  send(endpoints.client, endpoints.server)
  const next = bulkFrames(admission.requestID)
  next.start.transferId = "transfer-2"
  const decisions = receive(endpoints.client, envelope({ case: "bulkStart", value: next.start }, 2n))
  expect(decisions.some((decision) => decision.type === "closed")).toBe(false)
  expect(endpoints.client.bulkRetainedBytes).toBe(next.payload.length)
})

test("all bulk metadata remains normal and End cannot overtake queued pieces", () => {
  const endpoints = requested()
  const frames = bulkFrames()
  endpoints.server.enqueue({ case: "bulkStart", value: frames.start }, 512, 0)
  endpoints.server.enqueue({ case: "bulkPiece", value: frames.first }, 512, 0)
  endpoints.server.enqueue({ case: "bulkPiece", value: frames.second }, 512, 0)
  endpoints.server.enqueue({ case: "bulkEnd", value: frames.end }, 512, 0)
  const bodies = Array.from({ length: 4 }, () => send(endpoints.server, endpoints.client).frame.body.case)
  expect(bodies).toEqual(["bulkStart", "bulkPiece", "bulkPiece", "bulkEnd"])
})
