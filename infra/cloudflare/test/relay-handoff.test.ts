import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  FrameSchema,
  ControlSchema,
  LedgerClass,
  ScopeSchema,
  ResultSchema,
  Session_Info_scope,
  operations,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
  session_create_RequestSchema,
  session_create_ResultSchema,
} from "../../../packages/protocol/src/v5"
import { frameReservation } from "../../../packages/remote/src/index"
import type { RelayAuthority } from "../src/relay/binary-core"
import { harness } from "./support/relay"

test("the binary listener closes a text peer without a JSON reply", async () => {
  const h = await harness()
  await h.attach("client", "client", {}, undefined, false)
  await h.relay.handleClientMessage("client", '{"type":"ping"}')
  expect(h.close).toEqual([{ id: "client", code: 1008, reason: "MALFORMED" }])
  expect(h.receive("client")).toEqual([])
  expect(h.relay.reservation.used).toBe(0)
})

test.each(["wrong role", "sequence gap"] as const)("the binary relay closes a peer after a %s", async (fault) => {
  const h = await harness()
  const agent = await h.attach("agent", "agent")
  const client = await h.attach("client")
  if (fault === "wrong role") {
    const status = create(FrameSchema, {
      revision: 5,
      connectionEpoch: client.connectionEpoch,
      ledger: LedgerClass.NORMAL,
      deliveryOrdinal: client.ledger(LedgerClass.NORMAL).sentOrdinal + 1n,
      body: { case: "control", value: create(ControlSchema, { kind: { case: "status", value: {} } }) },
    })
    await h.relay.handleClientMessage("client", encodeStrict(FrameSchema, status).slice().buffer)
    expect(h.close).toEqual([{ id: "client", code: 1002, reason: "DIRECTION" }])
  } else {
    const status = create(FrameSchema, {
      revision: 5,
      connectionEpoch: agent.connectionEpoch,
      ledger: LedgerClass.NORMAL,
      deliveryOrdinal: agent.ledger(LedgerClass.NORMAL).sentOrdinal + 2n,
      body: { case: "control", value: create(ControlSchema, { kind: { case: "status", value: {} } }) },
    })
    await h.relay.handleAgentMessage("agent", encodeStrict(FrameSchema, status).slice().buffer)
    expect(h.close).toEqual([{ id: "agent", code: 1002, reason: "MALFORMED" }])
    expect(h.receive("client")).toEqual([])
  }
  h.relay.closeDevice()
  expect(h.relay.reservation.used).toBe(0)
})

test.each(["authorized", "revoked"])(
  "an epoch advertisement precedes an overlapping subscription result for a %s client",
  async (access) => {
    const entered = Promise.withResolvers<void>()
    const authority = Promise.withResolvers<RelayAuthority>()
    let hold = false
    const h = await harness({
      authorize: async () => {
        if (!hold) return { ok: true, ownerID: "owner" }
        entered.resolve()
        return authority.promise
      },
    })
    const agent = await h.attach("agent", "agent")
    const client = await h.attach("client")
    const connectionEpoch = client.connectionEpoch
    const creation = operations.find((item) => item.diagnosticName === "session.create")!
    const session = {
      id: encodeLossless("ses_created"),
      projectID: encodeLossless("prj_test"),
      scope: Session_Info_scope.SESSION_INFO_SCOPE_BOUND,
      title: encodeLossless("Created Session"),
      location: { directory: encodeLossless("/workspace") },
      time: { created: 1, updated: 1 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const createID = client.request(
      creation.operationId,
      create(ScopeSchema, { target: { case: "workspace", value: "wsp_test" } }),
      encodeStrict(session_create_RequestSchema, create(session_create_RequestSchema, { payload: { id: session.id } })),
      512,
      h.now(),
    ).requestID!
    await h.send("client")
    const createInput = h
      .receive("agent")
      .flatMap((entry) => entry.decisions)
      .find((entry) => entry.type === "dispatch")!
    if (createInput.type !== "dispatch") throw new Error("Missing creation dispatch")
    const scope = create(ScopeSchema, { target: { case: "session", value: "ses_1" } })
    const operation = operations.find((item) => item.diagnosticName === "event.subscribe")!
    const requestID = client.request(
      operation.operationId,
      scope,
      encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope })),
      512,
      h.now(),
    ).requestID!
    await h.send("client")
    const input = h
      .receive("agent")
      .flatMap((entry) => entry.decisions)
      .find((entry) => entry.type === "dispatch")!
    if (input.type !== "dispatch") throw new Error("Missing subscription dispatch")
    const epoch = {
      case: "control" as const,
      value: create(ControlSchema, {
        kind: { case: "resyncRequired", value: { scope, sourceEpoch: "backend-epoch" } },
      }),
    }
    hold = true
    agent.enqueue(epoch, frameReservation(epoch), h.now())
    const advertising = h.send("agent")
    agent.enqueue(
      {
        case: "result",
        value: create(ResultSchema, {
          requestId: input.requestID,
          operationId: operation.operationId,
          settlement: operation.settlement,
          outcome: {
            case: "success",
            value: {
              typeName: operation.resultType,
              payload: encodeStrict(
                event_subscribe_ResultSchema,
                create(event_subscribe_ResultSchema, { subscriptionId: encodeLossless("accepted") }),
              ),
            },
          },
        }),
      },
      512,
      h.now(),
    )
    const replying = h.send("agent")
    expect(h.close).toEqual([])
    await entered.promise
    expect(
      h
        .receive("client")
        .flatMap((entry) => entry.decisions)
        .filter((entry) => entry.type === "settled"),
    ).toEqual([])
    authority.resolve(
      access === "authorized" ? { ok: true, ownerID: "owner" } : { ok: false, reason: "revoked_session" },
    )
    await Promise.all([advertising, replying])
    if (access === "revoked") {
      expect(h.close).toEqual([{ id: "client", code: 4401, reason: "DIRECTION" }])
      expect(
        h
          .receive("client")
          .flatMap((entry) => entry.decisions)
          .filter((entry) => entry.type === "settled"),
      ).toEqual([])
      return
    }
    expect(h.close).toEqual([])
    expect(h.receive("client").flatMap((entry) => entry.decisions)).toContainEqual(
      expect.objectContaining({ type: "settled", requestID, status: "success" }),
    )
    expect(client.connectionEpoch).toBe(connectionEpoch)
    agent.enqueue(
      {
        case: "result",
        value: create(ResultSchema, {
          requestId: createInput.requestID,
          operationId: creation.operationId,
          settlement: creation.settlement,
          outcome: {
            case: "success",
            value: {
              typeName: creation.resultType,
              payload: encodeStrict(
                session_create_ResultSchema,
                create(session_create_ResultSchema, { data: session }),
              ),
            },
          },
        }),
      },
      1024,
      h.now(),
    )
    await h.send("agent")
    const settled = h
      .receive("client")
      .flatMap((entry) => entry.decisions)
      .filter((entry) => entry.type === "settled")
    expect(settled).toEqual([expect.objectContaining({ type: "settled", requestID: createID, status: "success" })])
    const payload = settled[0]?.payload
    if (!payload) throw new Error("Missing creation result")
    expect(decodeStrict(session_create_ResultSchema, payload.payload).data).toMatchObject(session)
    expect(
      h.collected
        .get("agent")!
        .flatMap((entry) => entry.decisions)
        .filter((entry) => entry.type === "dispatch" && entry.operation.operationId === creation.operationId),
    ).toHaveLength(1)
    expect(h.close).toEqual([])
  },
)

test("subscription handoff preserves increasing time through synchronous registration", async () => {
  let time = 0
  const h = await harness({ monotonic: () => ++time })
  const agent = await h.attach("agent", "agent")
  const client = await h.attach("client")
  const scope = create(ScopeSchema, { target: { case: "session", value: "ses_1" } })
  const operation = operations.find((item) => item.diagnosticName === "event.subscribe")!
  const requestID = client.request(
    operation.operationId,
    scope,
    encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope })),
    512,
    h.now(),
  ).requestID!
  await h.send("client")
  const input = h
    .receive("agent")
    .flatMap((entry) => entry.decisions)
    .find((entry) => entry.type === "dispatch")!
  if (input.type !== "dispatch") throw new Error("Missing subscription dispatch")
  const epoch = {
    case: "control" as const,
    value: create(ControlSchema, {
      kind: { case: "resyncRequired", value: { scope, sourceEpoch: "backend-epoch" } },
    }),
  }
  agent.enqueue(epoch, frameReservation(epoch), h.now())
  await h.send("agent")
  agent.enqueue(
    {
      case: "result",
      value: create(ResultSchema, {
        requestId: input.requestID,
        operationId: operation.operationId,
        settlement: operation.settlement,
        outcome: {
          case: "success",
          value: {
            typeName: operation.resultType,
            payload: encodeStrict(
              event_subscribe_ResultSchema,
              create(event_subscribe_ResultSchema, { subscriptionId: encodeLossless("accepted") }),
            ),
          },
        },
      }),
    },
    512,
    h.now(),
  )
  await h.send("agent")
  expect(h.receive("client").flatMap((entry) => entry.decisions)).toContainEqual(
    expect.objectContaining({ type: "settled", requestID, status: "success" }),
  )
  expect(h.close).toEqual([])
})

test("a re-entrant native send can advance the peer and enqueue another frame in the same wake", async () => {
  let time = 0
  const h = await harness({
    monotonic: () => ++time,
    send: (id, bytes) => {
      if (id !== "client" || decodeStrict(FrameSchema, bytes).body.case !== "result") return
      const peer = h.relay.connection(id)!
      peer.advance(++time)
      const status = {
        case: "control" as const,
        value: create(ControlSchema, {
          kind: {
            case: "status",
            value: { running: ["ses_2"], attention: [] },
          },
        }),
      }
      peer.enqueue(status, frameReservation(status), ++time)
    },
  })
  const agent = await h.attach("agent", "agent")
  const client = await h.attach("client")
  const requestID = h.request(client)
  await h.send("client")
  const input = h
    .receive("agent")
    .flatMap((entry) => entry.decisions)
    .find((entry) => entry.type === "dispatch")!
  if (input.type !== "dispatch") throw new Error("Missing request dispatch")
  agent.enqueue(h.result(input), 512, h.now())
  await h.send("agent")
  const received = h.receive("client")
  expect(received.flatMap((entry) => entry.decisions)).toContainEqual(
    expect.objectContaining({ type: "settled", requestID, status: "success" }),
  )
  expect(received.map((entry) => entry.frame?.body.case)).toEqual(["result", "control"])
  const [result, status] = received.map((entry) => entry.frame)
  if (!result || !status) throw new Error("Missing result or status frame")
  expect(status.body).toMatchObject({
    case: "control",
    value: {
      kind: {
        case: "status",
        value: { running: ["ses_2"] },
      },
    },
  })
  expect(status.deliveryOrdinal).toBe(result.deliveryOrdinal + 1n)
  expect(h.close).toEqual([])
})

test("relay handoff preserves the rejection of a genuinely regressing clock", async () => {
  let time = 100
  const h = await harness({ monotonic: () => time })
  await h.attach("client")
  time--
  expect(() => h.relay.sweep()).toThrow("monotonic time")
})
