import { expect, test } from "bun:test"
import { create } from "@bufbuild/protobuf"
import { send, receive, session, subscribed, batch, subscribeTo, globalScope, pair } from "./connection-fixtures.js"
import {
  FrameSchema,
  LedgerClass,
  ResyncRequiredSchema,
  ControlSchema,
  operations,
  ResultSchema,
  TypedPayloadSchema,
  session_log_RequestSchema,
  session_log_Request_paramsSchema,
  session_log_Request_querySchema,
  session_log_ResultSchema,
  LosslessStringSchema,
} from "../src/generated/v5/index.js"
import { toBinary } from "@bufbuild/protobuf"

function frame(ordinal: bigint, subscriptionID?: string, epoch?: string, sessionID?: string) {
  return create(FrameSchema, {
    revision: 5,
    connectionEpoch: "connection-1",
    ledger: LedgerClass.EVENT,
    deliveryOrdinal: ordinal,
    body: { case: "eventBatch", value: batch(subscriptionID, epoch, sessionID) },
  })
}

test("EVENTS identity is accepted only from a successful descriptor result and batches route by that identity", () => {
  const endpoints = subscribed()
  const decisions = receive(endpoints.client, frame(1n))
  expect(decisions).toContainEqual(
    expect.objectContaining({ type: "events", subscriptionID: "subscription-1", batch: batch() }),
  )
  expect(endpoints.client.acceptSubscription("missing", "forged", session(), 0)).toContainEqual(
    expect.objectContaining({ type: "closed" }),
  )
})

test("real event.subscribe codecs accept a global target independently of the outer RPC scope", () => {
  const endpoints = subscribed({}, globalScope())
  const input = frame(1n)
  if (input.body.case !== "eventBatch") throw new Error("fixture")
  input.body.value.scope = globalScope()
  expect(receive(endpoints.client, input)).toContainEqual(
    expect.objectContaining({ type: "events", subscriptionID: "subscription-1" }),
  )
})

test("Session-scoped EVENTS operations reject an accepted scope that differs from the outer RPC scope", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  const operation = operations.find((operation) => operation.diagnosticName === "session.log")!
  const text = (value: string) => create(LosslessStringSchema, { encoding: { case: "utf8", value } })
  const payload = toBinary(
    session_log_RequestSchema,
    create(session_log_RequestSchema, {
      params: create(session_log_Request_paramsSchema, { sessionID: text("session-1") }),
      query: create(session_log_Request_querySchema, { follow: false }),
    }),
  )
  const admission = endpoints.client.request(operation.operationId, session(), payload, 512, 0)
  send(endpoints.client, endpoints.server)
  endpoints.server.enqueue(
    {
      case: "result",
      value: create(ResultSchema, {
        requestId: admission.requestID,
        operationId: operation.operationId,
        settlement: operation.settlement,
        outcome: {
          case: "success",
          value: create(TypedPayloadSchema, {
            typeName: operation.resultType,
            payload: toBinary(
              session_log_ResultSchema,
              create(session_log_ResultSchema, { subscriptionId: text("log-1") }),
            ),
          }),
        },
      }),
    },
    512,
    0,
  )
  send(endpoints.server, endpoints.client)
  expect(endpoints.client.acceptSubscription(admission.requestID!, "log-1", session("session-2"), 0)).toContainEqual(
    expect.objectContaining({ type: "closed" }),
  )
})

test("an event payload outside the explicitly supplied public-event type list fails before routing", () => {
  const endpoints = subscribed()
  const input = frame(1n)
  if (input.body.case !== "eventBatch") throw new Error("fixture")
  input.body.value.events[0].event!.typeName = "ycoding.v5.Empty"
  const decisions = receive(endpoints.client, input)
  expect(decisions).toContainEqual(expect.objectContaining({ type: "closed" }))
  expect(decisions.some((decision) => decision.type === "events")).toBe(false)
  expect(endpoints.client.reservation.used).toBe(0)
})

test.each(["identity", "scope", "source"])("wrong EventBatch %s invalidates or drops without routing", (variant) => {
  const endpoints = subscribed()
  const decisions = receive(
    endpoints.client,
    frame(
      1n,
      variant === "identity" ? "another" : undefined,
      variant === "source" ? "source-2" : undefined,
      variant === "scope" ? "another-session" : undefined,
    ),
  )
  expect(decisions.some((decision) => decision.type === "events")).toBe(false)
  expect(
    decisions.some(
      (decision) => decision.type === "resync" || decision.type === "dropped" || decision.type === "closed",
    ),
  ).toBe(true)
})

test("hydration transfers consumption into a bounded owner and flushes ordered batches explicitly", () => {
  const endpoints = subscribed()
  endpoints.client.beginHydration("subscription-1")
  expect(receive(endpoints.client, frame(1n))).toEqual([])
  expect(receive(endpoints.client, frame(2n))).toEqual([])
  expect(endpoints.client.ledger(LedgerClass.EVENT).receivedBytes).toBe(0)
  const flushed = endpoints.client.completeHydration("subscription-1", "source-1", 0)
  expect(flushed.filter((decision) => decision.type === "events")).toHaveLength(2)
  expect(endpoints.client.hydrationBytes).toBe(0)
})

test("a hydrated batch cannot credit past an earlier unapplied live batch", () => {
  const endpoints = subscribed({ eventBatchCount: 1 })
  const metadata = { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" }
  endpoints.server.enqueueEvent(batch().events[0], metadata, 0)
  const live = send(endpoints.server, endpoints.client)
  expect(live.decisions).toContainEqual(expect.objectContaining({ type: "events", ordinal: 1n }))
  endpoints.client.beginHydration("subscription-1")
  endpoints.server.enqueueEvent(batch().events[0], metadata, 0)
  const hydrated = send(endpoints.server, endpoints.client)
  expect(hydrated.decisions).toEqual([])
  expect(endpoints.client.ledger(LedgerClass.EVENT)).toMatchObject({ consumed: 0n, receivedCount: 2 })
  endpoints.client.advance(25)
  expect(endpoints.client.prepareHandoff(25)).toBeUndefined()
  expect(endpoints.server.ledger(LedgerClass.EVENT).handedBytes).toBe(live.bytes + hydrated.bytes)
  endpoints.client.consume(LedgerClass.EVENT, live.frame.deliveryOrdinal, 25)
  const credit = send(endpoints.client, endpoints.server, 25)
  if (credit.frame.body.case !== "control" || credit.frame.body.value.kind.case !== "credit")
    throw new Error("event credit missing")
  expect(credit.frame.body.value.kind.value).toMatchObject({ ledger: LedgerClass.EVENT, consumedThrough: 2n })
  expect(endpoints.server.ledger(LedgerClass.EVENT).handedBytes).toBe(0)
  expect(endpoints.client.completeHydration("subscription-1", "source-1", 25)).toContainEqual(
    expect.objectContaining({ type: "events", batch: batch() }),
  )
})

test("hydration count overflow surfaces resync, frees owned records, and never silently drops", () => {
  const endpoints = subscribed({ eventQueueCount: 1 })
  endpoints.client.beginHydration("subscription-1")
  receive(endpoints.client, frame(1n))
  const decisions = receive(endpoints.client, frame(2n))
  expect(decisions).toContainEqual(expect.objectContaining({ type: "resync", subscriptionID: "subscription-1" }))
  expect(endpoints.client.hydrationBytes).toBe(0)
  expect(endpoints.client.completeHydration("subscription-1", "source-1", 0)).toContainEqual(
    expect.objectContaining({ type: "resync" }),
  )
})

test("hydration installs only the canonical snapshot epoch, preserving matching live batches during a source change", () => {
  const endpoints = subscribed()
  endpoints.client.beginHydration("subscription-1")
  expect(receive(endpoints.client, frame(1n, undefined, "source-1"))).toEqual([])
  expect(receive(endpoints.client, frame(2n, undefined, "source-2"))).toEqual([])
  const decisions = endpoints.client.completeHydration("subscription-1", "source-2", 0)
  expect(decisions).toContainEqual(expect.objectContaining({ type: "resync", sourceEpoch: "source-1" }))
  expect(decisions).toContainEqual(
    expect.objectContaining({ type: "events", batch: batch("subscription-1", "source-2") }),
  )
  expect(receive(endpoints.client, frame(3n, undefined, "source-2"))[0]).toMatchObject({ type: "events" })
  expect(receive(endpoints.client, frame(4n, undefined, "source-1"))[0]).toMatchObject({ type: "resync" })
  expect(endpoints.client.hydrationBytes).toBe(0)
  expect(() => endpoints.client.completeHydration("missing", "source-2", 0)).toThrow("subscription owner")
})

test("typed ResyncRequired exposes its scope and invalidates buffered delivery", () => {
  const endpoints = subscribed()
  endpoints.client.beginHydration("subscription-1")
  receive(endpoints.client, frame(1n))
  const resync = create(ResyncRequiredSchema, { scope: session(), sourceEpoch: "source-1", messageId: "message-1" })
  const decisions = receive(
    endpoints.client,
    create(FrameSchema, {
      revision: 5,
      connectionEpoch: "connection-1",
      ledger: LedgerClass.NORMAL,
      deliveryOrdinal: 2n,
      body: { case: "control", value: create(ControlSchema, { kind: { case: "resyncRequired", value: resync } }) },
    }),
  )
  expect(decisions).toContainEqual(
    expect.objectContaining({ type: "resync", scope: session(), messageID: "message-1" }),
  )
  expect(endpoints.client.hydrationBytes).toBe(0)
})

test("Session event queues rotate fairly and preserve contiguous ordinals after prepared abort", () => {
  const endpoints = subscribed({ eventBatchCount: 1 })
  for (const id of ["session-1", "session-2", "session-3"]) {
    if (id !== "session-1") {
      subscribeTo(endpoints, session(id), id)
    }
    for (const index of [0, 1])
      endpoints.server.enqueueEvent(
        batch(id === "session-1" ? "subscription-1" : id, "source-1", id, `${id}-${index}`).events[0],
        {
          subscriptionID: id === "session-1" ? "subscription-1" : id,
          scope: session(id),
          sourceEpoch: "source-1",
        },
        0,
      )
  }
  const first = endpoints.server.prepareHandoff(40)!
  expect(first.frame.deliveryOrdinal).toBe(1n)
  endpoints.server.abortPrepared(first)
  const deliveries = Array.from({ length: 6 }, () => send(endpoints.server, endpoints.client, 40).frame)
  expect(deliveries.map((frame) => frame.deliveryOrdinal)).toEqual([1n, 2n, 3n, 4n, 5n, 6n])
  expect(
    deliveries.map((frame) => (frame.body.case === "eventBatch" ? frame.body.value.scope!.target.value : "wrong")),
  ).toEqual(["session-1", "session-2", "session-3", "session-1", "session-2", "session-3"])
})
