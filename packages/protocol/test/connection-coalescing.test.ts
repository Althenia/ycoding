import { expect, test } from "bun:test"
import { create, toBinary } from "@bufbuild/protobuf"
import {
  subscribed,
  batch,
  send,
  session,
  health,
  healthRequest,
  healthResult,
  machine,
} from "./connection-fixtures.js"
import { eventFrameBytes, eventReservationBytes, lateHeaderReservation } from "../src/v5/connection/events.js"
import {
  FrameSchema,
  LedgerClass,
  EventBatchSchema,
  EventRecordSchema,
  TypedPayloadSchema,
  health_stop_RequestSchema,
  ServiceStopRequestSchema,
  LosslessStringSchema,
  DurablePositionSchema,
} from "../src/generated/v5/index.js"
import { ControlSchema, StatusSchema } from "../src/generated/v5/index.js"
import { BulkStartSchema, BulkPieceSchema, ContentKind } from "../src/generated/v5/index.js"
import { validateBinary } from "../src/v5/validate.js"

const maximum = (1n << 64n) - 1n

function event(units = 0, id = "event-1") {
  return create(EventRecordSchema, {
    eventId: id,
    createdMs: -1n,
    durable: create(DurablePositionSchema, { aggregateId: "session-1", sequence: maximum, version: 1 }),
    event: create(TypedPayloadSchema, {
      typeName: health_stop_RequestSchema.typeName,
      payload: toBinary(
        health_stop_RequestSchema,
        create(health_stop_RequestSchema, {
          payload: create(ServiceStopRequestSchema, {
            instanceID: create(LosslessStringSchema, { encoding: { case: "utf8", value: "x".repeat(units) } }),
          }),
        }),
      ),
    }),
  })
}

function filled(events: ReturnType<typeof event>[]) {
  return create(EventBatchSchema, { ...batch(), events })
}

test.each([0n, 1n, 127n, 128n, 16384n, maximum])(
  "arithmetic Frame size matches the real generated codec at ordinal %s",
  (ordinal) => {
    const value = filled([event(130), event(0, "😀")])
    const frame = create(FrameSchema, {
      revision: 5,
      connectionEpoch: "connection-1",
      ledger: LedgerClass.EVENT,
      deliveryOrdinal: ordinal,
      tinyConsumedThrough: ordinal,
      body: { case: "eventBatch", value },
    })
    expect(eventFrameBytes(value, "connection-1", ordinal, ordinal)).toBe(toBinary(FrameSchema, frame).length)
  },
)

test("late-header reservation derives the maximum versus minimum width of both uint64 fields", () => {
  const value = filled([event()])
  expect(lateHeaderReservation).toBe(
    eventFrameBytes(value, "connection-1", maximum, maximum) - eventFrameBytes(value, "connection-1", 1n, 0n),
  )
  expect(lateHeaderReservation).toBe(18)
})

test("individual events coalesce, interactive priority shortens an open background window", () => {
  const endpoints = subscribed()
  endpoints.server.enqueueEvent(
    batch().events[0],
    { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1", background: true },
    0,
  )
  expect(endpoints.server.prepareHandoff(100)).toBeUndefined()
  endpoints.server.enqueueEvent(
    batch().events[0],
    { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" },
    100,
  )
  expect(endpoints.server.prepareHandoff(139)).toBeUndefined()
  const delivery = send(endpoints.server, endpoints.client, 140)
  expect(delivery.frame.body.case === "eventBatch" && delivery.frame.body.value.events.length).toBe(2)
})

test("64 events flush one complete batch and the next event starts a new bounded batch", () => {
  const endpoints = subscribed()
  for (const index of Array.from({ length: 65 }, (_, index) => index))
    endpoints.server.enqueueEvent(
      create(EventRecordSchema, { ...batch().events[0], eventId: `event-${index}` }),
      { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" },
      0,
    )
  const first = send(endpoints.server, endpoints.client)
  const second = send(endpoints.server, endpoints.client, 40)
  expect(first.frame.body.case === "eventBatch" && first.frame.body.value.events.length).toBe(64)
  expect(second.frame.body.case === "eventBatch" && second.frame.body.value.events.length).toBe(1)
})

test("merging includes the outstanding prepared batch in the producer count budget", () => {
  const endpoints = subscribed({ eventQueueCount: 2, eventBatchCount: 2 })
  const metadata = { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" }
  endpoints.server.enqueueEvent(batch().events[0], metadata, 0)
  expect(endpoints.server.prepareHandoff(40)).toBeDefined()
  endpoints.server.enqueueEvent(batch().events[0], metadata, 40)
  expect(endpoints.server.enqueueEvent(batch().events[0], metadata, 40)).toContainEqual(
    expect.objectContaining({ type: "closed", category: 3 }),
  )
  expect(endpoints.server.retainedBytes).toBe(0)
})

test("reserved 256 KiB boundary validates at maximum ordinals; another event splits and an oversized event fails", () => {
  const search = (low: number, high: number): number => {
    if (low === high) return low
    const middle = Math.ceil((low + high) / 2)
    return eventReservationBytes(filled([event(middle)]), "connection-1") <= 262144
      ? search(middle, high)
      : search(low, middle - 1)
  }
  const units = search(0, 262144)
  const value = filled([event(units)])
  expect(eventReservationBytes(value, "connection-1")).toBe(262144)
  const bytes = toBinary(
    FrameSchema,
    create(FrameSchema, {
      revision: 5,
      connectionEpoch: "connection-1",
      ledger: LedgerClass.EVENT,
      deliveryOrdinal: maximum,
      tinyConsumedThrough: maximum,
      body: { case: "eventBatch", value },
    }),
  )
  expect(bytes.length).toBe(262144)
  expect(() => validateBinary(FrameSchema.typeName, bytes)).not.toThrow()
  const endpoints = subscribed()
  endpoints.server.enqueueEvent(
    event(units),
    { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" },
    0,
  )
  endpoints.server.enqueueEvent(
    event(0),
    { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" },
    0,
  )
  expect(send(endpoints.server, endpoints.client).frame.body.case).toBe("eventBatch")
  expect(send(endpoints.server, endpoints.client, 40).frame.body.case).toBe("eventBatch")
  expect(
    endpoints.server.enqueueEvent(
      event(units + 1),
      { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1", messageID: "message-1" },
      40,
    ),
  ).toContainEqual(expect.objectContaining({ type: "resync", messageID: "message-1" }))
})

test("oversized invalidation carries only metadata, delivers earlier events, and permits later events", () => {
  const endpoints = subscribed()
  const metadata = {
    subscriptionID: "subscription-1",
    scope: session(),
    sourceEpoch: "source-1",
    messageID: "message-1",
  }
  endpoints.server.enqueueEvent(batch().events[0], metadata, 0)
  const decisions = endpoints.server.enqueueEvent(event(262144), metadata, 0)
  expect(decisions).toEqual([{ type: "resync", ...metadata }])
  expect(endpoints.server.counters.oversizedInvalidations).toBe(1)
  const earlier = send(endpoints.server, endpoints.client)
  expect(earlier.frame.body.case).toBe("eventBatch")
  endpoints.client.consume(LedgerClass.EVENT, earlier.frame.deliveryOrdinal, 0)
  endpoints.client.advance(25)
  send(endpoints.client, endpoints.server, 25)
  const invalidation = send(endpoints.server, endpoints.client, 25)
  expect(invalidation.frame.body.case === "control" && invalidation.frame.body.value.kind.case).toBe("resyncRequired")
  expect(invalidation.decisions).toContainEqual(
    expect.objectContaining({ type: "resync", scope: session(), sourceEpoch: "source-1", messageID: "message-1" }),
  )
  endpoints.client.beginHydration("subscription-1")
  endpoints.client.completeHydration("subscription-1", "source-1", 25)
  endpoints.server.enqueueEvent(batch().events[0], metadata, 25)
  expect(send(endpoints.server, endpoints.client, 65).decisions.some((decision) => decision.type === "events")).toBe(
    true,
  )
})

test("oversized invalidation closes with LIMIT when its bounded normal queue is full", () => {
  const endpoints = subscribed({ normalQueueBytes: 512 })
  endpoints.server.enqueue(
    { case: "control", value: create(ControlSchema, { kind: { case: "status", value: create(StatusSchema) } }) },
    512,
    0,
  )
  const decisions = endpoints.server.enqueueEvent(
    event(262144),
    { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" },
    0,
  )
  expect(decisions).toContainEqual(expect.objectContaining({ type: "closed", category: 3 }))
})

test("source change flushes an open batch and events after an elapsed window start a new batch", () => {
  const endpoints = subscribed()
  const metadata = { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" }
  endpoints.server.enqueueEvent(batch().events[0], metadata, 0)
  endpoints.server.enqueueEvent(batch().events[0], { ...metadata, sourceEpoch: "source-2" }, 10)
  const first = send(endpoints.server, endpoints.client, 10)
  expect(first.frame.body.case === "eventBatch" && first.frame.body.value.sourceEpoch).toBe("source-1")
  endpoints.server.enqueueEvent(batch().events[0], { ...metadata, sourceEpoch: "source-2" }, 60)
  const second = send(endpoints.server, endpoints.client, 60)
  expect(second.frame.body.case === "eventBatch" && second.frame.body.value.events.length).toBe(1)
  const third = send(endpoints.server, endpoints.client, 100)
  expect(third.frame.body.case === "eventBatch" && third.frame.body.value.events.length).toBe(1)
})

test("scheduling rotates transfers and sends two event batches per bulk piece while both wait", () => {
  const endpoints = subscribed({ eventBatchCount: 1 })
  const result = healthResult("unused")
  if (result.case !== "result" || result.value.outcome.case !== "success") throw new Error("fixture")
  const payload = result.value.outcome.value.payload
  for (const transferID of ["transfer-a", "transfer-b"]) {
    const admission = endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0)
    send(endpoints.client, endpoints.server)
    endpoints.server.enqueue(
      {
        case: "bulkStart",
        value: create(BulkStartSchema, {
          requestId: admission.requestID,
          transferId: transferID,
          operationId: health.operationId,
          typeName: health.resultType,
          contentKind: ContentKind.TYPED_MESSAGE,
          byteCount: BigInt(payload.length),
          chunkCount: 3,
        }),
      },
      512,
      0,
    )
    send(endpoints.server, endpoints.client)
    for (const index of [0, 1])
      endpoints.server.enqueue(
        {
          case: "bulkPiece",
          value: create(BulkPieceSchema, {
            transferId: transferID,
            index,
            offset: BigInt(index * 10),
            data: payload.subarray(index * 10, (index + 1) * 10),
          }),
        },
        512,
        0,
      )
  }
  for (const index of [0, 1, 2, 3])
    endpoints.server.enqueueEvent(
      create(EventRecordSchema, {
        ...batch().events[0],
        eventId: `event-${index}`,
      }),
      { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" },
      0,
    )
  const deliveries = Array.from({ length: 8 }, () => send(endpoints.server, endpoints.client).frame)
  expect(deliveries.map((frame) => frame.body.case)).toEqual([
    "eventBatch",
    "eventBatch",
    "bulkPiece",
    "eventBatch",
    "eventBatch",
    "bulkPiece",
    "bulkPiece",
    "bulkPiece",
  ])
  expect(deliveries.flatMap((frame) => (frame.body.case === "bulkPiece" ? [frame.body.value.transferId] : []))).toEqual(
    ["transfer-a", "transfer-b", "transfer-a", "transfer-b"],
  )
})
