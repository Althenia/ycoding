import { expect, test } from "bun:test"
import { create, fromBinary, toBinary, isFieldSet, clearField } from "@bufbuild/protobuf"
import { Connection, defaultBudgets, ReservationBudget } from "../src/v5/connection/index.js"
import {
  FrameSchema,
  PeerRole,
  operations,
  FailureCategory,
  LedgerClass,
  RequestSchema,
  health_stop_RequestSchema,
  ServiceStopRequestSchema,
  LosslessStringSchema,
} from "../src/generated/v5/index.js"
import { pair, send, receive, testOnlyEventTypes, machine, stop } from "./connection-fixtures.js"

test("initiator queues exactly one Hello without established headers", () => {
  const connection = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
  })
  connection.start(0)
  const prepared = connection.prepareHandoff()
  expect(prepared).toBeDefined()
  if (!prepared) throw new Error("Hello missing")
  const frame = fromBinary(FrameSchema, toBinary(FrameSchema, create(FrameSchema, prepared.frame)))
  expect(frame.body.case).toBe("hello")
  for (const name of ["connectionEpoch", "ledger", "deliveryOrdinal", "tinyConsumedThrough"])
    expect(isFieldSet(frame, FrameSchema.fields.find((field) => field.localName === name)!)).toBe(false)
  expect(connection.start(1)).toEqual([])
})

test("Ready establishes epoch and initiator confirms it with one bounded Ping", () => {
  const endpoints = pair()
  expect(endpoints.client.state).toBe("established")
  expect(endpoints.server.state).toBe("established")
  const pong = send(endpoints.server, endpoints.client)
  expect(pong.frame.body.case).toBe("control")
  expect(endpoints.client.prepareHandoff(0)).toBeUndefined()
})

test("handshake timeout is driven by caller time and releases all reservations", () => {
  const connection = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 10,
  })
  connection.start(10)
  expect(connection.advance(5009)).toEqual([])
  expect(connection.advance(5010)).toEqual([{ type: "closed", code: 1008, category: FailureCategory.INCOMPATIBLE }])
  expect(connection.reservation.used).toBe(0)
})

test("Ready receipt deadline starts at Ready handoff, not at Hello receipt", () => {
  const client = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
  })
  const server = new Connection({
    role: PeerRole.SERVER,
    peer: PeerRole.LOCAL_CLIENT,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
    epoch: "connection-1",
    sourceEpoch: "source-1",
  })
  client.start(0)
  send(client, server)
  send(server, client, 4999)
  expect(server.advance(5000)).toEqual([])
  expect(server.advance(9999)).toContainEqual(expect.objectContaining({ type: "closed" }))
})

test("the first permitted request can confirm Ready with an ordinary frame larger than a handshake message", () => {
  const client = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
  })
  const server = new Connection({
    role: PeerRole.SERVER,
    peer: PeerRole.LOCAL_CLIENT,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
    epoch: "connection-1",
    sourceEpoch: "source-1",
  })
  client.start(0)
  send(client, server)
  send(server, client)
  const payload = toBinary(
    health_stop_RequestSchema,
    create(health_stop_RequestSchema, {
      payload: create(ServiceStopRequestSchema, {
        instanceID: create(LosslessStringSchema, { encoding: { case: "utf8", value: "x".repeat(20000) } }),
      }),
    }),
  )
  const request = create(FrameSchema, {
    revision: 5,
    connectionEpoch: "connection-1",
    ledger: LedgerClass.NORMAL,
    deliveryOrdinal: 1n,
    body: {
      case: "request",
      value: create(RequestSchema, { requestId: "opaque", operationId: stop.operationId, scope: machine(), payload }),
    },
  })
  expect(receive(server, request)[0]).toMatchObject({ type: "dispatch", requestID: "opaque" })
  expect(server.state).toBe("established")
})

test("native length admission refuses oversize without decoding and releases sibling reservations", () => {
  const shared = new ReservationBudget(33554432)
  const connection = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    now: 0,
    eventTypes: testOnlyEventTypes,
    reservation: shared,
  })
  expect(connection.admitIncoming(10)).toBeDefined()
  const decode = () => {
    throw new Error("decode must not run")
  }
  const token = connection.admitIncoming(1048577)
  expect(token).toBeUndefined()
  if (token) decode()
  expect(connection.state).toBe("closed")
  expect(shared.used).toBe(0)
})

test("decode rejection releases its pre-decode reservation", () => {
  const connection = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
  })
  const token = connection.admitIncoming(12)!
  expect(connection.rejectIncoming(token)[0]).toMatchObject({ type: "closed", category: FailureCategory.MALFORMED })
  expect(connection.reservation.used).toBe(0)
})

test("retained handshake reservation is bounded across concurrent pre-decode admissions", () => {
  const connection = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
  })
  connection.start(0)
  expect(connection.admitIncoming(16384)).toBeDefined()
  expect(connection.retainedBytes).toBe(32768)
  expect(connection.admitIncoming(1)).toBeUndefined()
  expect(connection.retainedBytes).toBe(0)
})

test("Hello windows over the canonical cap reject; valid proposals cannot raise Ready windows", () => {
  const client = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
  })
  const server = new Connection({
    role: PeerRole.SERVER,
    peer: PeerRole.LOCAL_CLIENT,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
    epoch: "connection-1",
    sourceEpoch: "source-1",
    budgets: { normalWindowBytes: 1024, eventWindowBytes: 2048, bulkWindowBytes: 4096 },
  })
  client.start(0)
  send(client, server)
  const ready = send(server, client)
  expect(ready.frame.body.case).toBe("ready")
  if (ready.frame.body.case !== "ready") throw new Error("Ready missing")
  expect(ready.frame.body.value.receiveWindows).toMatchObject({
    normalBytes: 1024n,
    eventBytes: 2048n,
    bulkBytes: 4096n,
  })
  send(client, server)
  expect(server.state).toBe("established")
  const other = new Connection({
    role: PeerRole.SERVER,
    peer: PeerRole.LOCAL_CLIENT,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
    epoch: "connection-2",
    sourceEpoch: "source-1",
  })
  const initiating = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
  })
  initiating.start(0)
  const hello = initiating.prepareHandoff()!.frame
  if (hello.body.case !== "hello") throw new Error("Hello missing")
  hello.body.value.receiveWindows!.normalBytes = 1048577n
  expect(receive(other, hello)).toEqual([{ type: "closed", code: 1008, category: FailureCategory.LIMIT }])
})

test.each(["wrong", "missing", "hello", "ready"])("established %s epoch/handshake fails before dispatch", (variant) => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  const frame = create(FrameSchema, {
    revision: 5,
    connectionEpoch: variant === "wrong" ? "old" : "connection-1",
    ledger: 4,
    deliveryOrdinal: 2n,
    body: { case: "control", value: { kind: { case: "ping", value: { id: 2n } } } },
  })
  if (variant === "missing")
    clearField(frame, FrameSchema.fields.find((field) => field.localName === "connectionEpoch")!)
  if (variant === "hello" || variant === "ready") {
    const fresh = new Connection({
      role: PeerRole.LOCAL_CLIENT,
      peer: PeerRole.SERVER,
      operations,
      eventTypes: testOnlyEventTypes,
      now: 0,
    })
    fresh.start(0)
    if (variant === "hello") frame.body = fresh.prepareHandoff()!.frame.body
    if (variant === "ready") {
      const freshServer = new Connection({
        role: PeerRole.SERVER,
        peer: PeerRole.LOCAL_CLIENT,
        operations,
        eventTypes: testOnlyEventTypes,
        now: 0,
        epoch: "connection-2",
        sourceEpoch: "source-1",
      })
      send(fresh, freshServer)
      frame.body = freshServer.prepareHandoff()!.frame.body
    }
  }
  expect(receive(endpoints.server, frame)).toContainEqual(expect.objectContaining({ type: "closed" }))
})

test("all connection defaults are pinned to the plan, including timing and scheduling", () => {
  expect(defaultBudgets).toEqual({
    clientFrameBytes: 131072,
    serverFrameBytes: 1048576,
    handshakeBytes: 16384,
    handshakeRetainedBytes: 32768,
    handshakeTimeoutMs: 5000,
    inlineBytes: 65536,
    pieceBytes: 65536,
    messageBytes: 67108864,
    pieces: 1024,
    transfers: 2,
    eventBatchCount: 64,
    eventBatchBytes: 262144,
    eventQueueCount: 4096,
    eventQueueBytes: 4194304,
    eventWindowBytes: 1048576,
    bulkWindowBytes: 524288,
    normalWindowBytes: 1048576,
    normalQueueBytes: 131072,
    tinyFrameBytes: 512,
    tinyCount: 32,
    tinyBytes: 16384,
    deliveryTimeoutMs: 30000,
    relayPeerBytes: 1048576,
    pendingRequests: 32,
    subscriptions: 64,
    clientRate: 120,
    agentRate: 500,
    rateWindowMs: 10000,
    tinyRate: 500,
    tinyRateBytes: 262144,
    creditBytes: 65536,
    creditDelayMs: 25,
    pingIntervalMs: 20000,
    interactiveCoalesceMs: 40,
    backgroundCoalesceMs: 750,
    eventToBulkRatio: 2,
  })
})

test.each(["epoch", "revision", "digest", "role", "ledger"])("fabricated Hello %s fails before dispatch", (variant) => {
  const client = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
  })
  const server = new Connection({
    role: PeerRole.SERVER,
    peer: PeerRole.LOCAL_CLIENT,
    operations,
    now: 0,
    epoch: "connection-1",
    sourceEpoch: "source-1",
    eventTypes: testOnlyEventTypes,
  })
  client.start(0)
  const frame = client.prepareHandoff()!.frame
  if (variant === "epoch") frame.connectionEpoch = "forged"
  if (variant === "revision") frame.revision = 4
  if (variant === "ledger") frame.deliveryOrdinal = 1n
  if (frame.body.case === "hello") {
    if (variant === "digest") frame.body.value.contractDigest = new Uint8Array(32)
    if (variant === "role") frame.body.value.role = PeerRole.REMOTE_CLIENT
  }
  expect(receive(server, frame)).toContainEqual(expect.objectContaining({ type: "closed", code: 1008 }))
  expect(server.reservation.used).toBe(0)
})
