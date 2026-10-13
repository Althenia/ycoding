import { expect, test } from "bun:test"
import { create, toBinary } from "@bufbuild/protobuf"
import { pair, send, receive, health, machine, healthRequest, ping } from "./connection-fixtures.js"
import {
  FrameSchema,
  LedgerClass,
  FailureCategory,
  ControlSchema,
  StatusSchema,
  PongSchema,
} from "../src/generated/v5/index.js"

function peerPing(ordinal: bigint) {
  return create(FrameSchema, {
    revision: 5,
    connectionEpoch: "connection-1",
    ledger: LedgerClass.TINY,
    deliveryOrdinal: ordinal,
    tinyConsumedThrough: 1n,
    body: ping(ordinal),
  })
}

test("handoff refusal beyond reserved bytes is terminal and frees queue, prepared and ledgers", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  endpoints.client.request(health.operationId, machine(), healthRequest(), 64, 0)
  const prepared = endpoints.client.prepareHandoff(0)!
  expect(endpoints.client.handoff(prepared, 65, 0)).toContainEqual(
    expect.objectContaining({ type: "closed", category: FailureCategory.MALFORMED }),
  )
  expect(endpoints.client.reservation.used).toBe(0)
})

test("normal control, not just requests, remains handed until exact consumption credit", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  endpoints.server.enqueue(
    { case: "control", value: create(ControlSchema, { kind: { case: "status", value: create(StatusSchema) } }) },
    512,
    0,
  )
  const status = send(endpoints.server, endpoints.client)
  expect(status.frame.ledger).toBe(LedgerClass.NORMAL)
  expect(endpoints.server.ledger(LedgerClass.NORMAL).handedBytes).toBe(status.bytes)
  expect(endpoints.server.advance(29999)).toEqual([])
  expect(endpoints.server.advance(30000)).toContainEqual(
    expect.objectContaining({ type: "closed", category: FailureCategory.LIMIT }),
  )
})

test("unrelated Pong never resets the normal-ledger no-consumption deadline", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  send(endpoints.client, endpoints.server)
  endpoints.client.advance(20000)
  const pingFrame = send(endpoints.client, endpoints.server, 20000)
  send(endpoints.server, endpoints.client, 20000)
  expect(pingFrame.frame.body.case).toBe("control")
  expect(endpoints.client.advance(30000)).toContainEqual(expect.objectContaining({ type: "closed" }))
})

test.each(["future", "backward", "epoch"])("invalid tiny %s receipt never refunds", (variant) => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  const frame = create(FrameSchema, {
    revision: 5,
    connectionEpoch: variant === "epoch" ? "old" : "connection-1",
    ledger: LedgerClass.TINY,
    deliveryOrdinal: 2n,
    tinyConsumedThrough: variant === "future" ? 9n : 0n,
    body: {
      case: "control",
      value: create(ControlSchema, { kind: { case: "pong", value: create(PongSchema, { id: 999n }) } }),
    },
  })
  expect(receive(endpoints.client, frame)).toContainEqual(expect.objectContaining({ type: "closed" }))
  expect(endpoints.client.reservation.used).toBe(0)
})

test("tiny occupancy pauses generation, elapsed rate windows never release handed ownership", () => {
  const endpoints = pair({ tinyCount: 2 })
  send(endpoints.server, endpoints.client)
  receive(endpoints.server, peerPing(2n))
  receive(endpoints.server, peerPing(3n))
  const handed = send(endpoints.server, endpoints.client)
  const countBefore = endpoints.server.ledger(LedgerClass.TINY).queuedBytes
  receive(endpoints.server, peerPing(4n))
  expect(endpoints.server.ledger(LedgerClass.TINY).queuedBytes).toBe(countBefore)
  expect(endpoints.server.advance(10000)).toEqual([])
  expect(endpoints.server.ledger(LedgerClass.TINY).handedBytes).toBe(handed.bytes)
  expect(endpoints.server.advance(30000)).toContainEqual(expect.objectContaining({ type: "closed" }))
})

test("tiny generated rolling rate closes without an acknowledgment cycle", () => {
  const endpoints = pair({ tinyRate: 2 })
  send(endpoints.server, endpoints.client)
  receive(endpoints.server, peerPing(2n))
  send(endpoints.server, endpoints.client)
  endpoints.server.advance(20000)
  const prepared = endpoints.server.prepareHandoff(20000)!
  expect(endpoints.server.handoff(prepared, toBinary(FrameSchema, prepared.frame).length, 20000)).toEqual([])
  receive(endpoints.server, peerPing(3n), 20000)
  const pong = endpoints.server.prepareHandoff(20000)!
  endpoints.server.handoff(pong, toBinary(FrameSchema, pong.frame).length, 20000)
  receive(endpoints.server, peerPing(4n), 20000)
  const last = endpoints.server.prepareHandoff(20000)!
  expect(endpoints.server.handoff(last, toBinary(FrameSchema, last.frame).length, 20000)).toContainEqual(
    expect.objectContaining({ type: "closed", category: FailureCategory.LIMIT }),
  )
})

test("caller cannot manufacture Ping, Pong, Credit or Cancel outside their live-work causes", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  expect(endpoints.client.enqueue(ping(100n), 512, 0)).toContainEqual(
    expect.objectContaining({ type: "closed", category: FailureCategory.DIRECTION }),
  )
})

test("consume out of order grants only the contiguous prefix and uses exact summed bytes", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  ;[1, 2].forEach(() => endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0))
  const first = send(endpoints.client, endpoints.server)
  const second = send(endpoints.client, endpoints.server)
  endpoints.server.consume(LedgerClass.NORMAL, second.frame.deliveryOrdinal, 0)
  endpoints.server.advance(25)
  expect(endpoints.server.prepareHandoff(25)).toBeUndefined()
  endpoints.server.consume(LedgerClass.NORMAL, first.frame.deliveryOrdinal, 25)
  const credit = send(endpoints.server, endpoints.client, 25)
  expect(credit.frame.body.case === "control" && credit.frame.body.value.kind.case).toBe("credit")
  expect(endpoints.client.ledger(LedgerClass.NORMAL).handedBytes).toBe(0)
  expect(first.bytes + second.bytes).toBeGreaterThan(0)
})

test("receive credit bounds metadata even when later records are consumed before an unconsumed prefix", () => {
  const endpoints = pair({ normalWindowBytes: 90 })
  send(endpoints.server, endpoints.client)
  const status = (ordinal: bigint) =>
    create(FrameSchema, {
      revision: 5,
      connectionEpoch: "connection-1",
      ledger: LedgerClass.NORMAL,
      deliveryOrdinal: ordinal,
      body: {
        case: "control",
        value: create(ControlSchema, { kind: { case: "status", value: create(StatusSchema) } }),
      },
    })
  receive(endpoints.client, status(1n))
  for (const ordinal of [2n, 3n]) {
    receive(endpoints.client, status(ordinal))
    endpoints.client.consume(LedgerClass.NORMAL, ordinal, 0)
  }
  const decisions = receive(endpoints.client, status(4n))
  expect(decisions).toContainEqual(expect.objectContaining({ type: "closed", category: FailureCategory.LIMIT }))
})

test("authority change during decode denies stale delivery and revocation settles transmitted work unknown", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  const reservation = endpoints.server.admitIncoming(40)!
  endpoints.server.updateAuthority(1, true, 0)
  expect(endpoints.server.acceptIncoming(reservation, create(FrameSchema), 0)).toContainEqual(
    expect.objectContaining({ type: "closed", code: 4403 }),
  )
  expect(endpoints.server.reservation.used).toBe(0)
  endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  const prepared = endpoints.client.prepareHandoff(0)!
  endpoints.client.handoff(prepared, toBinary(FrameSchema, prepared.frame).length, 0)
  expect(endpoints.client.updateAuthority(1, false, 0, 4401)).toEqual([
    { type: "settled", requestID: "1", status: "unknown" },
    { type: "closed", code: 4401, category: FailureCategory.DIRECTION },
  ])
})

test("authority changes fence a prepared outbound delivery before it is handed", () => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  endpoints.client.request(health.operationId, machine(), healthRequest(), 512, 0)
  const prepared = endpoints.client.prepareHandoff(0)!
  endpoints.client.updateAuthority(1, true, 0)
  expect(endpoints.client.handoff(prepared, toBinary(FrameSchema, prepared.frame).length, 0)).toContainEqual(
    expect.objectContaining({ type: "closed", code: 4403 }),
  )
  expect(endpoints.client.retainedBytes).toBe(0)
})
