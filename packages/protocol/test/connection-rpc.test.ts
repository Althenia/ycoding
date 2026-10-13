import { expect, test } from "bun:test"
import { create, toBinary } from "@bufbuild/protobuf"
import { pair, send, receive, health, stop, machine, healthRequest, healthResult } from "./connection-fixtures.js"
import {
  LedgerClass,
  FailureCategory,
  RequestSchema,
  FrameSchema,
  ScopeSchema,
  health_stop_RequestSchema,
  ServiceStopRequestSchema,
  LosslessStringSchema,
  ControlSchema,
  CreditSchema,
  CancelSchema,
} from "../src/generated/v5/index.js"

test("descriptor-correlated success settles once and complete handed bytes wait for consumption", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  const admission = endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  expect(admission.requestID).toBe("1")
  const request = send(endpoints.client, endpoints.server)
  expect(request.decisions).toContainEqual(
    expect.objectContaining({ type: "dispatch", requestID: "1", operation: health }),
  )
  endpoints.server.enqueue(healthResult("1"), 512, 0)
  const result = send(endpoints.server, endpoints.client)
  expect(result.decisions).toContainEqual(
    expect.objectContaining({ type: "settled", requestID: "1", status: "success", settlement: health.settlement }),
  )
  expect(endpoints.server.ledger(LedgerClass.NORMAL).handedBytes).toBe(result.bytes)
  endpoints.client.consume(LedgerClass.NORMAL, result.frame.deliveryOrdinal, 0)
  expect(endpoints.server.ledger(LedgerClass.NORMAL).handedBytes).toBe(result.bytes)
  endpoints.client.advance(25)
  send(endpoints.client, endpoints.server, 25)
  expect(endpoints.server.ledger(LedgerClass.NORMAL).handedBytes).toBe(0)
  const duplicate = create(FrameSchema, {
    revision: 5,
    connectionEpoch: "connection-1",
    ledger: LedgerClass.NORMAL,
    deliveryOrdinal: result.frame.deliveryOrdinal + 1n,
    body: healthResult("1"),
  })
  expect(receive(endpoints.client, duplicate, 25)).toContainEqual({ type: "dropped", reason: "late" })
})

test.each(["operation", "settlement", "type", "future", "scope", "payload"])(
  "rejects mismatched %s before effects",
  (variant) => {
    const endpoints = pair()
    send(endpoints.server, endpoints.client)
    endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0)
    const request = send(endpoints.client, endpoints.server)
    if (variant === "scope" || variant === "payload") {
      const invalid = create(RequestSchema, {
        requestId: "new",
        operationId: health.operationId,
        scope:
          variant === "scope" ? create(ScopeSchema, { target: { case: "session", value: "session-1" } }) : machine(),
        payload:
          variant === "payload"
            ? toBinary(
                health_stop_RequestSchema,
                create(health_stop_RequestSchema, {
                  payload: create(ServiceStopRequestSchema, {
                    instanceID: create(LosslessStringSchema, { encoding: { case: "utf8", value: "instance" } }),
                  }),
                }),
              )
            : healthRequest(),
      })
      const decisions = receive(
        endpoints.server,
        create(FrameSchema, {
          revision: 5,
          connectionEpoch: "connection-1",
          ledger: LedgerClass.NORMAL,
          deliveryOrdinal: request.frame.deliveryOrdinal + 1n,
          body: { case: "request", value: invalid },
        }),
      )
      expect(decisions).toContainEqual(expect.objectContaining({ type: "closed" }))
      expect(decisions.some((decision) => decision.type === "dispatch")).toBe(false)
      return
    }
    const body = healthResult(variant === "future" ? "2" : "1")
    if (body.case !== "result") throw new Error("result fixture")
    if (variant === "operation") body.value.operationId++
    if (variant === "settlement") body.value.settlement++
    if (variant === "type" && body.value.outcome.case === "success")
      body.value.outcome.value.typeName = "ycoding.v5.Empty"
    expect(
      receive(
        endpoints.client,
        create(FrameSchema, {
          revision: 5,
          connectionEpoch: "connection-1",
          ledger: LedgerClass.NORMAL,
          deliveryOrdinal: 1n,
          body,
        }),
      ),
    ).toContainEqual(expect.objectContaining({ type: "closed" }))
    expect(endpoints.client.reservation.used).toBe(0)
  },
)

test("unsent cancellation never dispatches; transmitted mutation cancellation is unknown without replay", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  const first = endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  expect(endpoints.client.cancel(first.requestID!, 0)).toContainEqual(
    expect.objectContaining({ type: "settled", status: "unsent" }),
  )
  expect(endpoints.client.prepareHandoff(0)).toBeUndefined()
  const payload = toBinary(
    health_stop_RequestSchema,
    create(health_stop_RequestSchema, {
      payload: create(ServiceStopRequestSchema, {
        instanceID: create(LosslessStringSchema, { encoding: { case: "utf8", value: "instance-1" } }),
      }),
    }),
  )
  const second = endpoints.client.request(stop.operationId, machine(), payload, 512, 0)
  send(endpoints.client, endpoints.server)
  expect(endpoints.client.cancel(second.requestID!, 0)).toContainEqual(
    expect.objectContaining({ type: "settled", status: "unknown" }),
  )
  const cancellation = send(endpoints.client, endpoints.server)
  expect(cancellation.decisions).toContainEqual(
    expect.objectContaining({ type: "cancelled", requestID: second.requestID, mutation: true }),
  )
  expect(endpoints.client.cancel(second.requestID!, 0)).toEqual([])
  expect(endpoints.client.prepareHandoff(0)).toBeUndefined()
})

test("concurrent peer IDs reject but post-settlement arbitrary peer ID reuse is new work", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  const request = create(RequestSchema, {
    requestId: "opaque-peer-id",
    operationId: health.operationId,
    scope: machine(),
    payload: healthRequest(),
  })
  const frame = (ordinal: bigint) =>
    create(FrameSchema, {
      revision: 5,
      connectionEpoch: "connection-1",
      ledger: LedgerClass.NORMAL,
      deliveryOrdinal: ordinal,
      body: { case: "request", value: request },
    })
  expect(receive(endpoints.server, frame(1n))[0]).toMatchObject({ type: "dispatch" })
  endpoints.server.enqueue(healthResult("opaque-peer-id"), 512, 0)
  const prepared = endpoints.server.prepareHandoff(0)!
  endpoints.server.handoff(prepared, toBinary(FrameSchema, prepared.frame).length, 0)
  expect(receive(endpoints.server, frame(2n))[0]).toMatchObject({ type: "dispatch" })
  expect(receive(endpoints.server, frame(3n))).toContainEqual(expect.objectContaining({ type: "closed" }))
})

test("exact credit is derived from known handed records and duplicate grants fail", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  const request = send(endpoints.client, endpoints.server)
  const credit = (ordinal: bigint) =>
    create(FrameSchema, {
      revision: 5,
      connectionEpoch: "connection-1",
      ledger: LedgerClass.TINY,
      deliveryOrdinal: ordinal,
      body: {
        case: "control",
        value: create(ControlSchema, {
          kind: {
            case: "credit",
            value: create(CreditSchema, {
              ledger: LedgerClass.NORMAL,
              consumedThrough: request.frame.deliveryOrdinal,
            }),
          },
        }),
      },
    })
  receive(endpoints.client, credit(2n))
  expect(endpoints.client.ledger(LedgerClass.NORMAL).handedBytes).toBe(0)
  expect(receive(endpoints.client, credit(3n))).toContainEqual(
    expect.objectContaining({ type: "closed", category: FailureCategory.MALFORMED }),
  )
})

test("pending RPC count is bounded and a failed local preflight allocates no request ID", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  for (const index of Array.from({ length: 32 }, (_, index) => index)) {
    expect(endpoints.client.request(health.operationId, machine(), healthRequest(), 128, 0).requestID).toBe(
      String(index + 1),
    )
  }
  expect(endpoints.client.request(health.operationId, machine(), healthRequest(), 128, 0)).toEqual({
    requestID: undefined,
    decisions: [{ type: "settled", requestID: "", status: "unavailable" }],
  })
  endpoints.client.cancel("1", 0)
  expect(endpoints.client.request(health.operationId, machine(), healthRequest(), 128, 0).requestID).toBe("33")
})

test("queue exhaustion closes only its recipient and distinguishes queued from transmitted work", () => {
  const stalled = pair({ normalQueueBytes: 512 })
  const healthy = pair()
  send(stalled.server, stalled.client)
  send(healthy.server, healthy.client)
  stalled.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  send(stalled.client, stalled.server)
  stalled.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  const rejected = stalled.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  expect(rejected.decisions).toContainEqual({ type: "settled", requestID: "1", status: "unknown" })
  expect(rejected.decisions).toContainEqual({ type: "settled", requestID: "2", status: "unsent" })
  expect(stalled.client.retainedBytes).toBe(0)
  healthy.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  send(healthy.client, healthy.server)
  healthy.server.enqueue(healthResult("1"), 512, 0)
  expect(send(healthy.server, healthy.client).decisions).toContainEqual(
    expect.objectContaining({ type: "settled", status: "success" }),
  )
})

test("validated Requests and their Cancel decisions retain exact connection arrival order", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  const mutation = toBinary(
    health_stop_RequestSchema,
    create(health_stop_RequestSchema, {
      payload: create(ServiceStopRequestSchema, {
        instanceID: create(LosslessStringSchema, { encoding: { case: "utf8", value: "instance-1" } }),
      }),
    }),
  )
  const request = (requestID: string, ordinal: bigint, write: boolean) =>
    create(FrameSchema, {
      revision: 5,
      connectionEpoch: "connection-1",
      ledger: LedgerClass.NORMAL,
      deliveryOrdinal: ordinal,
      body: {
        case: "request",
        value: create(RequestSchema, {
          requestId: requestID,
          operationId: write ? stop.operationId : health.operationId,
          scope: machine(),
          payload: write ? mutation : healthRequest(),
        }),
      },
    })
  const cancellation = create(FrameSchema, {
    revision: 5,
    connectionEpoch: "connection-1",
    ledger: LedgerClass.TINY,
    deliveryOrdinal: 2n,
    body: {
      case: "control",
      value: create(ControlSchema, {
        kind: { case: "cancel", value: create(CancelSchema, { target: { case: "requestId", value: "mutation-z" } }) },
      }),
    },
  })
  const decisions = [
    request("mutation-z", 1n, true),
    request("read-a", 2n, false),
    cancellation,
    request("mutation-b", 3n, true),
    request("read-c", 4n, false),
  ].flatMap((frame) => receive(endpoints.server, frame))
  expect(
    decisions.map((decision) => ("requestID" in decision ? [decision.type, decision.requestID] : [decision.type])),
  ).toEqual([
    ["dispatch", "mutation-z"],
    ["dispatch", "read-a"],
    ["cancelled", "mutation-z"],
    ["dispatch", "mutation-b"],
    ["dispatch", "read-c"],
  ])
  expect(decisions[2]).toEqual({ type: "cancelled", requestID: "mutation-z", mutation: true })
  expect(decisions.flatMap((decision) => (decision.type === "dispatch" ? [decision.ordinal] : []))).toEqual([
    1n,
    2n,
    3n,
    4n,
  ])
})

test("incoming request backpressure preserves every accepted dispatch and rejects overflow explicitly", () => {
  const endpoints = pair({ pendingRequests: 3 })
  send(endpoints.server, endpoints.client)
  const request = (requestID: string, ordinal: bigint) =>
    create(FrameSchema, {
      revision: 5,
      connectionEpoch: "connection-1",
      ledger: LedgerClass.NORMAL,
      deliveryOrdinal: ordinal,
      body: {
        case: "request",
        value: create(RequestSchema, {
          requestId: requestID,
          operationId: health.operationId,
          scope: machine(),
          payload: healthRequest(),
        }),
      },
    })
  const accepted = ["peer-z", "peer-a", "peer-m"].flatMap((requestID, index) =>
    receive(endpoints.server, request(requestID, BigInt(index + 1))),
  )
  expect(accepted.map((decision) => (decision.type === "dispatch" ? decision.requestID : decision.type))).toEqual([
    "peer-z",
    "peer-a",
    "peer-m",
  ])
  const overflow = receive(endpoints.server, request("peer-overflow", 4n))
  expect(overflow).toContainEqual(expect.objectContaining({ type: "closed", category: FailureCategory.LIMIT }))
  expect(overflow.some((decision) => decision.type === "dispatch")).toBe(false)
  expect(endpoints.server.retainedBytes).toBe(0)
})
