import { expect, test } from "bun:test"
import { Connection, ReservationBudget } from "@ycoding-ai/protocol/v5/connection"
import {
  create,
  FrameSchema,
  PeerRole,
  operations,
  LedgerClass,
  CONTRACT_DIGEST,
  toBinary,
  ControlSchema,
  ScopeSchema,
  ConnectorNoticeIDsSchema,
  EventBatchSchema,
} from "@ycoding-ai/protocol/v5"
import { createRelayConnection, receiveBinary, handoffBinary, remoteEventTypes, frameReservation } from "../src/index"

function endpoints(role: PeerRole.AGENT | PeerRole.REMOTE_CLIENT = PeerRole.REMOTE_CLIENT) {
  const reservation = new ReservationBudget(32 * 1024 * 1024)
  const server = createRelayConnection(role, "epoch", "source", 0, reservation)
  const peer = new Connection({ role, peer: PeerRole.RELAY, operations, eventTypes: remoteEventTypes, now: 0 })
  const send = (from: Connection, to: Connection, now = 0) => {
    const delivered: ReturnType<typeof receiveBinary>[] = []
    handoffBinary(from, (bytes) => delivered.push(receiveBinary(to, bytes.slice().buffer, now)), now)
    return delivered
  }
  peer.start(0)
  send(peer, server)
  send(server, peer)
  send(peer, server)
  send(server, peer)
  return { server, peer, reservation, send }
}

test.each([PeerRole.AGENT, PeerRole.REMOTE_CLIENT])(
  "Hello/Ready establishes the authenticated role %s and a fresh relay epoch",
  (role) => {
    const pair = endpoints(role)
    expect(pair.peer.state).toBe("established")
    expect(pair.server.state).toBe("established")
    expect(pair.reservation.used).toBeGreaterThan(0)
  },
)

test.each(["revision", "digest", "role", "epoch", "request", "text"])(
  "pre-Ready %s rejects without application dispatch",
  (change) => {
    const server = createRelayConnection(
      PeerRole.REMOTE_CLIENT,
      "epoch",
      "source",
      0,
      new ReservationBudget(32 * 1024 * 1024),
    )
    const frame = create(FrameSchema, {
      revision: 5,
      body: {
        case: "hello",
        value: {
          revision: 5,
          contractDigest: new Uint8Array(Buffer.from(CONTRACT_DIGEST, "hex")),
          role: PeerRole.REMOTE_CLIENT,
          receiveWindows: { normalBytes: 1048576n, eventBytes: 1048576n, bulkBytes: 524288n },
        },
      },
    })
    if (change === "revision" && frame.body.case === "hello") frame.body.value.revision = 4
    if (change === "digest" && frame.body.case === "hello") frame.body.value.contractDigest = new Uint8Array(32)
    if (change === "role" && frame.body.case === "hello") frame.body.value.role = PeerRole.AGENT
    if (change === "epoch") frame.connectionEpoch = "forged"
    if (change === "request")
      frame.body = { case: "control", value: create(ControlSchema, { kind: { case: "ping", value: { id: 1n } } }) }
    const received = receiveBinary(server, change === "text" ? "{}" : toBinary(FrameSchema, frame).slice().buffer, 0)
    expect(received.decisions.some((item) => item.type === "dispatch")).toBe(false)
    expect(received.decisions).toContainEqual(expect.objectContaining({ type: "closed", code: 1008 }))
  },
)

test("application admission refuses over-cap native buffers without decoding or retaining them", () => {
  const server = createRelayConnection(
    PeerRole.REMOTE_CLIENT,
    "epoch",
    "source",
    0,
    new ReservationBudget(32 * 1024 * 1024),
  )
  expect(receiveBinary(server, new ArrayBuffer(128 * 1024 + 1), 0).decisions).toContainEqual(
    expect.objectContaining({ type: "closed" }),
  )
  expect(server.retainedBytes).toBe(0)
})

test("complete encoded requests stay handed until real consumption Credit; restart settles unknown without replay", () => {
  const pair = endpoints()
  const payload = toBinary(ConnectorNoticeIDsSchema, create(ConnectorNoticeIDsSchema, { ids: ["ntc_1"] }))
  const operation = operations.find((item) => item.diagnosticName === "notice.read")!
  const request = pair.peer.request(
    operation.operationId,
    create(ScopeSchema, { target: { case: "machine", value: {} } }),
    payload,
    512,
    0,
  )
  const delivered = pair.send(pair.peer, pair.server)[0]!
  const dispatch = delivered.decisions.find((entry) => entry.type === "dispatch")!
  expect(dispatch.type).toBe("dispatch")
  const charge = pair.peer.ledger(LedgerClass.NORMAL).handedBytes
  expect(charge).toBeGreaterThan(payload.length)
  expect(pair.server.ledger(LedgerClass.NORMAL).receivedBytes).toBe(charge)
  expect(pair.peer.ledger(LedgerClass.NORMAL).handedBytes).toBe(charge)
  pair.server.consume(LedgerClass.NORMAL, delivered.frame!.deliveryOrdinal, 0)
  expect(pair.peer.ledger(LedgerClass.NORMAL).handedBytes).toBe(charge)
  pair.server.advance(25)
  pair.send(pair.server, pair.peer, 25)
  expect(pair.peer.ledger(LedgerClass.NORMAL).handedBytes).toBe(0)
  expect(pair.peer.restart(25)).toContainEqual(
    expect.objectContaining({ type: "settled", requestID: request.requestID, status: "unknown" }),
  )
  expect(pair.peer.prepareHandoff(25)).toBeUndefined()
})

test("queued cancellation is unsent and never hands a mutation", () => {
  const pair = endpoints()
  const operation = operations.find((item) => item.diagnosticName === "notice.read")!
  const request = pair.peer.request(
    operation.operationId,
    create(ScopeSchema, { target: { case: "machine", value: {} } }),
    toBinary(ConnectorNoticeIDsSchema, create(ConnectorNoticeIDsSchema, { ids: ["ntc_1"] })),
    512,
    0,
  )
  expect(pair.peer.cancel(request.requestID!, 0)).toContainEqual({
    type: "settled",
    requestID: request.requestID!,
    status: "unsent",
  })
  expect(
    pair
      .send(pair.peer, pair.server)
      .flatMap((item) => item.decisions)
      .some((item) => item.type === "dispatch"),
  ).toBe(false)
})

test("phase-B event batch forwarding cannot be emulated with enqueue", () => {
  const pair = endpoints()
  const body = {
    case: "eventBatch",
    value: create(EventBatchSchema, {
      subscriptionId: "subscription",
      scope: create(ScopeSchema, { target: { case: "session", value: "ses_1" } }),
      sourceEpoch: "source",
      events: [],
    }),
  } as const
  expect(pair.server.enqueue(create(FrameSchema, { body }).body, 512, 0)).toContainEqual(
    expect.objectContaining({ type: "closed" }),
  )
  expect(
    frameReservation({
      case: "control",
      value: create(ControlSchema, { kind: { case: "inventoryInvalidated", value: {} } }),
    }),
  ).toBeGreaterThan(64)
})
