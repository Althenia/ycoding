import { expect, test } from "bun:test"
import { create, toBinary } from "@bufbuild/protobuf"
import { subscribed, batch, session, send, receive } from "./connection-fixtures.js"
import {
  FrameSchema,
  StreamEndSchema,
  LedgerClass,
  FailureCategory,
  ControlSchema,
  ResyncRequiredSchema,
  EventRecordSchema,
  TypedPayloadSchema,
  health_stop_RequestSchema,
  ServiceStopRequestSchema,
  LosslessStringSchema,
} from "../src/generated/v5/index.js"

function end(subscriptionID = "subscription-1", ordinal = 1n) {
  return create(FrameSchema, {
    revision: 5,
    connectionEpoch: "connection-1",
    ledger: LedgerClass.EVENT,
    deliveryOrdinal: ordinal,
    body: { case: "streamEnd", value: create(StreamEndSchema, { subscriptionId: subscriptionID }) },
  })
}

test("canonical StreamEnd flushes earlier events and completes the finite subscription on the event ledger", () => {
  const endpoints = subscribed()
  endpoints.server.enqueueEvent(
    batch().events[0],
    { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" },
    0,
  )
  endpoints.server.enqueue(end().body, 512, 0)
  const prior = send(endpoints.server, endpoints.client)
  expect(prior.frame.body.case).toBe("eventBatch")
  const completed = send(endpoints.server, endpoints.client)
  expect(completed.frame.ledger).toBe(LedgerClass.EVENT)
  expect(completed.frame.deliveryOrdinal).toBe(2n)
  expect(completed.decisions).toContainEqual({ type: "streamEnded", subscriptionID: "subscription-1" })
  expect(() => endpoints.client.beginHydration("subscription-1")).toThrow("subscription owner")
  expect(endpoints.client.hydrationBytes).toBe(0)
})

test("StreamEnd for an unknown or already ended subscription is a protocol failure", () => {
  const unknown = subscribed()
  expect(receive(unknown.client, end("unknown"))).toContainEqual(
    expect.objectContaining({ type: "closed", category: FailureCategory.MALFORMED }),
  )
  const known = subscribed()
  expect(receive(known.client, end())).toContainEqual({ type: "streamEnded", subscriptionID: "subscription-1" })
  expect(receive(known.client, end("subscription-1", 2n))).toContainEqual(
    expect.objectContaining({ type: "closed", category: FailureCategory.MALFORMED }),
  )
})

test("StreamEnd from a client violates the canonical sender direction", () => {
  const endpoints = subscribed()
  expect(receive(endpoints.server, end())).toContainEqual(
    expect.objectContaining({ type: "closed", category: FailureCategory.DIRECTION }),
  )
})

test("releasing a producing subscription releases its queued StreamEnd", () => {
  const endpoints = subscribed()
  endpoints.server.enqueue(end().body, 512, 0)
  endpoints.server.releaseSubscription("subscription-1", 0, "send")
  expect(endpoints.server.prepareHandoff(0)).toBeUndefined()
  expect(endpoints.server.ledger(LedgerClass.EVENT).queuedBytes).toBe(0)
})

test("a producer rejects repeated StreamEnd before it can emit duplicate finite completion", () => {
  const endpoints = subscribed()
  endpoints.server.enqueue(end().body, 512, 0)
  expect(endpoints.server.enqueue(end().body, 512, 0)).toContainEqual(
    expect.objectContaining({ type: "closed", category: FailureCategory.MALFORMED }),
  )
  expect(endpoints.server.retainedBytes).toBe(0)
})

test.each(["hydration", "overflow", "source", "control"])("StreamEnd never succeeds with unresolved %s", (variant) => {
  const endpoints = subscribed({ eventQueueCount: 1 })
  if (variant === "hydration" || variant === "overflow") endpoints.client.beginHydration("subscription-1")
  if (variant === "overflow") {
    for (const ordinal of [1n, 2n])
      receive(
        endpoints.client,
        create(FrameSchema, {
          revision: 5,
          connectionEpoch: "connection-1",
          ledger: LedgerClass.EVENT,
          deliveryOrdinal: ordinal,
          body: { case: "eventBatch", value: batch() },
        }),
      )
  }
  if (variant === "source")
    receive(
      endpoints.client,
      create(FrameSchema, {
        revision: 5,
        connectionEpoch: "connection-1",
        ledger: LedgerClass.EVENT,
        deliveryOrdinal: 1n,
        body: { case: "eventBatch", value: batch("subscription-1", "source-2") },
      }),
    )
  if (variant === "control")
    receive(
      endpoints.client,
      create(FrameSchema, {
        revision: 5,
        connectionEpoch: "connection-1",
        ledger: LedgerClass.NORMAL,
        deliveryOrdinal: 2n,
        body: {
          case: "control",
          value: create(ControlSchema, {
            kind: {
              case: "resyncRequired",
              value: create(ResyncRequiredSchema, {
                scope: session(),
                sourceEpoch: "source-1",
              }),
            },
          }),
        },
      }),
    )
  const ordinal = variant === "overflow" ? 3n : variant === "source" ? 2n : 1n
  const decisions = receive(endpoints.client, end("subscription-1", ordinal))
  expect(decisions).toContainEqual(expect.objectContaining({ type: "closed", category: FailureCategory.MALFORMED }))
  expect(decisions.some((decision) => decision.type === "streamEnded")).toBe(false)
  expect(endpoints.client.retainedBytes).toBe(0)
})

test("a canonical hydration resolves resync before a finite stream can end", () => {
  const endpoints = subscribed()
  receive(
    endpoints.client,
    create(FrameSchema, {
      revision: 5,
      connectionEpoch: "connection-1",
      ledger: LedgerClass.EVENT,
      deliveryOrdinal: 1n,
      body: { case: "eventBatch", value: batch("subscription-1", "source-2") },
    }),
  )
  endpoints.client.beginHydration("subscription-1")
  expect(endpoints.client.completeHydration("subscription-1", "source-2", 0)).toEqual([])
  expect(receive(endpoints.client, end("subscription-1", 2n))).toContainEqual({
    type: "streamEnded",
    subscriptionID: "subscription-1",
  })
})

test("StreamEnd cannot overtake a scoped resync waiting for earlier event consumption", () => {
  const endpoints = subscribed()
  const metadata = { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" }
  endpoints.server.enqueueEvent(batch().events[0], metadata, 0)
  const payload = toBinary(
    health_stop_RequestSchema,
    create(health_stop_RequestSchema, {
      payload: create(ServiceStopRequestSchema, {
        instanceID: create(LosslessStringSchema, {
          encoding: { case: "utf8", value: "x".repeat(262144) },
        }),
      }),
    }),
  )
  expect(
    endpoints.server.enqueueEvent(
      create(EventRecordSchema, {
        eventId: "oversized",
        createdMs: 0n,
        event: create(TypedPayloadSchema, { typeName: health_stop_RequestSchema.typeName, payload }),
      }),
      metadata,
      0,
    ),
  ).toContainEqual(expect.objectContaining({ type: "resync" }))
  endpoints.server.enqueue(end().body, 512, 0)
  expect(send(endpoints.server, endpoints.client).frame.body.case).toBe("eventBatch")
  expect(endpoints.server.prepareHandoff(40)).toBeUndefined()
})
