import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  encodeLossless,
  ControlSchema,
  ScopeSchema,
  ResultSchema,
  StreamEndSchema,
  PublicEventSchema,
  EventRecordSchema,
  LedgerClass,
  WireLimit,
  operations,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
  session_log_RequestSchema,
  session_log_ResultSchema,
} from "../../../packages/protocol/src/v5"
import type { Connection } from "../../../packages/protocol/src/v5/connection"
import { defaultBudgets } from "../../../packages/protocol/src/v5/connection"
import { frameReservation } from "../../../packages/remote/src/index"
import { harness } from "./support/relay"

test.each([
  ["same epoch", "backend-epoch", false],
  ["replacement epoch", "replacement-epoch", false],
  ["same epoch after a finite session log ends", "backend-epoch", true],
] as const)(
  "scoped invalidation with %s preserves the established epoch rules",
  async (_name, epoch, finishedLog) => {
    const h = await harness()
    const agent = await h.attach("agent", "agent")
    const first = await h.attach("first")
    const second = await h.attach("second")
    const source = "backend-epoch"
    const scope = (id: string) => create(ScopeSchema, { target: { case: "session", value: id } })
    const subscribe = async (
      peer: Connection,
      name: string,
      session: string,
      accepted: string,
      announce = true,
      kind: "event.subscribe" | "session.log" = "event.subscribe",
    ) => {
      const target = scope(session)
      const operation = operations.find((item) => item.diagnosticName === kind)!
      const request = peer.request(
        operation.operationId,
        target,
        kind === "session.log"
          ? encodeStrict(
              session_log_RequestSchema,
              create(session_log_RequestSchema, {
                params: { sessionID: encodeLossless(session) },
                query: { follow: false },
              }),
            )
          : encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope: target })),
        512,
        h.now(),
      ).requestID!
      await h.send(name)
      const input = h
        .receive("agent")
        .flatMap((entry) => entry.decisions)
        .find((entry) => entry.type === "dispatch")!
      if (input.type !== "dispatch") throw new Error("Missing subscription request")
      if (announce) {
        const body = {
          case: "control" as const,
          value: create(ControlSchema, {
            kind: { case: "resyncRequired", value: { scope: target, sourceEpoch: source } },
          }),
        }
        agent.enqueue(body, frameReservation(body), h.now())
        await h.send("agent")
      }
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
                payload:
                  kind === "session.log"
                    ? encodeStrict(
                        session_log_ResultSchema,
                        create(session_log_ResultSchema, { subscriptionId: encodeLossless(accepted) }),
                      )
                    : encodeStrict(
                        event_subscribe_ResultSchema,
                        create(event_subscribe_ResultSchema, { subscriptionId: encodeLossless(accepted) }),
                      ),
              },
            },
          }),
        },
        512,
        h.now(),
      )
      await h.send("agent")
      expect(agent.acceptSubscription(input.requestID, accepted, target, h.now(), "send", source)).toEqual([])
      expect(h.receive(name).flatMap((entry) => entry.decisions)).toContainEqual(
        expect.objectContaining({ type: "settled", requestID: request, status: "success" }),
      )
      expect(peer.acceptSubscription(request, accepted, target, h.now(), "receive", source)).toEqual([])
    }
    await subscribe(first, "first", "ses_affected", "affected")
    await subscribe(first, "first", "ses_other", "other")
    await subscribe(second, "second", "ses_other", "other", false)
    if (finishedLog) {
      await subscribe(first, "first", "ses_affected", "finite-log", false, "session.log")
      h.at(defaultBudgets.creditDelayMs)
      h.relay.sweep()
      h.receive("agent")
      const end = { case: "streamEnd" as const, value: create(StreamEndSchema, { subscriptionId: "finite-log" }) }
      agent.enqueue(end, frameReservation(end), h.now())
      await h.send("agent")
      expect(h.receive("first").flatMap((entry) => entry.decisions)).toContainEqual({
        type: "streamEnded",
        subscriptionID: "finite-log",
      })
    }
    const epochs = [first.connectionEpoch, second.connectionEpoch]
    const body = {
      case: "control" as const,
      value: create(ControlSchema, {
        kind: {
          case: "resyncRequired",
          value: { scope: scope("ses_affected"), sourceEpoch: epoch, messageId: "msg_oversized" },
        },
      }),
    }
    agent.enqueue(body, frameReservation(body), h.now())
    await h.send("agent")
    if (epoch !== source) {
      expect(h.close).toEqual([{ id: "first", code: 1012, reason: "EPOCH" }])
      expect(h.relay.connection("second")!.state).toBe("established")
      return
    }
    expect(h.close).toEqual([])
    expect(
      h
        .receive("first")
        .flatMap((entry) => entry.decisions)
        .filter((entry) => entry.type === "resync"),
    ).toEqual([
      expect.objectContaining({
        type: "resync",
        scope: scope("ses_affected"),
        sourceEpoch: source,
        messageID: "msg_oversized",
      }),
    ])
    expect(h.receive("second")).toEqual([])
    first.beginHydration("affected")
    expect(first.completeHydration("affected", source, h.now())).toEqual([])
    for (const [subscriptionID, session] of [
      ["affected", "ses_affected"],
      ["other", "ses_other"],
    ] as const) {
      const event = create(EventRecordSchema, {
        eventId: `evt_${subscriptionID}`,
        createdMs: 1n,
        event: {
          typeName: PublicEventSchema.typeName,
          payload: encodeStrict(
            PublicEventSchema,
            create(PublicEventSchema, {
              kind: {
                case: "catalogUpdated",
                value: { id: encodeLossless(`evt_${subscriptionID}`), created: 1, type: 1, data: {} },
              },
            }),
          ),
        },
      })
      agent.enqueueEvent(event, { subscriptionID, scope: scope(session), sourceEpoch: source }, h.now())
    }
    h.at(h.now() + defaultBudgets.interactiveCoalesceMs)
    agent.advance(h.now())
    await h.send("agent")
    expect(
      h
        .receive("first")
        .flatMap((entry) => entry.decisions)
        .filter((entry) => entry.type === "events")
        .map((entry) => entry.subscriptionID)
        .sort(),
    ).toEqual(["affected", "other"])
    expect(
      h
        .receive("second")
        .flatMap((entry) => entry.decisions)
        .filter((entry) => entry.type === "events")
        .map((entry) => entry.subscriptionID),
    ).toEqual(["other"])
    expect([first.connectionEpoch, second.connectionEpoch]).toEqual(epochs)
    expect(h.close).toEqual([])
    expect(h.relay.agentConnected()).toBe(true)
    h.relay.closeDevice()
    expect(h.relay.reservation.used).toBe(0)
  },
)

test("resync fanout credit chain preserves connections after every recipient consumes", async () => {
  const h = await harness()
  const agent = await h.attach("agent", "agent")
  const healthy = await h.attach("healthy")
  const slow = await h.attach("slow")
  const source = "backend-epoch"
  const target = create(ScopeSchema, { target: { case: "session", value: "ses_credit_fence" } })
  const operation = operations.find((item) => item.diagnosticName === "event.subscribe")!
  const receive = (peer: Connection, name: string) => {
    const received = h.receive(name)
    for (const item of received)
      if (
        item.frame?.ledger === LedgerClass.NORMAL &&
        !(item.frame.body.case === "control" && item.frame.body.value.kind.case === "resyncRequired")
      )
        peer.consume(LedgerClass.NORMAL, item.frame.deliveryOrdinal, h.now())
    return received
  }
  const subscribe = async (peer: Connection, name: string, announce: boolean) => {
    const request = peer.request(
      operation.operationId,
      target,
      encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope: target })),
      512,
      h.now(),
    ).requestID!
    await h.send(name)
    const input = receive(agent, "agent")
      .flatMap((entry) => entry.decisions)
      .find((entry) => entry.type === "dispatch")!
    if (input.type !== "dispatch") throw new Error("Missing subscription request")
    if (announce) {
      const body = {
        case: "control" as const,
        value: create(ControlSchema, {
          kind: { case: "resyncRequired", value: { scope: target, sourceEpoch: source } },
        }),
      }
      agent.enqueue(body, frameReservation(body), h.now())
      await h.send("agent")
    }
    const body = {
      case: "result" as const,
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
              create(event_subscribe_ResultSchema, { subscriptionId: encodeLossless("shared") }),
            ),
          },
        },
      }),
    }
    agent.enqueue(body, frameReservation(body), h.now())
    await h.send("agent")
    expect(agent.acceptSubscription(input.requestID, "shared", target, h.now(), "send", source)).toEqual([])
    expect(receive(peer, name).flatMap((entry) => entry.decisions)).toContainEqual(
      expect.objectContaining({ type: "settled", requestID: request, status: "success" }),
    )
    expect(peer.acceptSubscription(request, "shared", target, h.now(), "receive", source)).toEqual([])
  }
  await subscribe(healthy, "healthy", true)
  await subscribe(slow, "slow", false)
  for (const time of [1, 2, 3].map((hop) => hop * defaultBudgets.creditDelayMs)) {
    h.at(time)
    for (const [name, peer] of [
      ["agent", agent],
      ["healthy", healthy],
      ["slow", slow],
    ] as const) {
      peer.advance(time)
      await h.send(name)
    }
    h.relay.sweep()
    receive(agent, "agent")
    receive(healthy, "healthy")
    receive(slow, "slow")
  }
  for (const name of ["agent", "healthy", "slow"])
    expect(h.relay.connection(name)!.ledger(LedgerClass.NORMAL).handedBytes).toBe(0)
  expect(agent.ledger(LedgerClass.NORMAL).handedBytes).toBe(0)
  const epochs = [agent.connectionEpoch, healthy.connectionEpoch, slow.connectionEpoch]
  const event = (id: string, delta: string) =>
    create(EventRecordSchema, {
      eventId: id,
      createdMs: 1n,
      event: {
        typeName: PublicEventSchema.typeName,
        payload: encodeStrict(
          PublicEventSchema,
          create(PublicEventSchema, {
            kind: {
              case: "sessionTextDelta",
              value: {
                id: encodeLossless(id),
                created: 1,
                type: 1,
                data: {
                  sessionID: encodeLossless("ses_credit_fence"),
                  assistantMessageID: encodeLossless("msg_credit_fence"),
                  ordinal: 0n,
                  delta: encodeLossless(delta),
                },
              },
            },
          }),
        ),
      },
    })
  const metadata = { subscriptionID: "shared", scope: target, sourceEpoch: source, messageID: "msg_credit_fence" }
  agent.enqueueEvent(event("evt_before_fence", "before invalidation"), metadata, h.now())
  h.at(h.now() + defaultBudgets.interactiveCoalesceMs)
  agent.advance(h.now())
  await h.send("agent")
  const one = receive(healthy, "healthy")
    .flatMap((item) => item.decisions)
    .find((item) => item.type === "events")!
  const two = receive(slow, "slow")
    .flatMap((item) => item.decisions)
    .find((item) => item.type === "events")!
  if (one.type !== "events" || two.type !== "events") throw new Error("Missing recipient event")
  expect(one.batch.events.map((item) => item.eventId)).toEqual(["evt_before_fence"])
  expect(two.batch.events.map((item) => item.eventId)).toEqual(["evt_before_fence"])
  expect(one.ordinal).toBeDefined()
  expect(two.ordinal).toBeDefined()
  const charge = agent.ledger(LedgerClass.EVENT).handedBytes
  expect(charge).toBeGreaterThan(0)
  agent.enqueueEvent(event("evt_oversized_fence", "x".repeat(WireLimit.EVENT_BATCH_BYTES)), metadata, h.now())
  expect(agent.counters.oversizedInvalidations).toBe(1)
  await h.send("agent")
  expect(
    receive(healthy, "healthy")
      .flatMap((item) => item.decisions)
      .filter((item) => item.type === "resync"),
  ).toEqual([])
  healthy.consume(LedgerClass.EVENT, one.ordinal!, h.now())
  h.at(h.now() + defaultBudgets.creditDelayMs)
  healthy.advance(h.now())
  await h.send("healthy")
  h.relay.sweep()
  receive(agent, "agent")
  expect(h.relay.connection("healthy")!.ledger(LedgerClass.EVENT).handedBytes).toBe(0)
  expect(h.relay.connection("slow")!.ledger(LedgerClass.EVENT).handedBytes).toBeGreaterThan(0)
  expect(h.relay.connection("agent")!.ledger(LedgerClass.EVENT).receivedBytes).toBeGreaterThan(0)
  expect(agent.ledger(LedgerClass.EVENT).handedBytes).toBe(charge)
  await h.send("agent")
  expect(
    receive(healthy, "healthy")
      .flatMap((item) => item.decisions)
      .filter((item) => item.type === "resync"),
  ).toEqual([])
  expect(h.close).toEqual([])
  slow.consume(LedgerClass.EVENT, two.ordinal!, h.now())
  h.at(h.now() + defaultBudgets.creditDelayMs)
  slow.advance(h.now())
  await h.send("slow")
  expect(h.relay.connection("agent")!.ledger(LedgerClass.EVENT).receivedBytes).toBe(0)
  h.at(h.now() + defaultBudgets.creditDelayMs)
  h.relay.sweep()
  receive(agent, "agent")
  expect(agent.state).toBe("established")
  expect(agent.ledger(LedgerClass.EVENT).handedBytes).toBe(0)
  await h.send("agent")
  expect(
    receive(healthy, "healthy")
      .flatMap((item) => item.decisions)
      .filter((item) => item.type === "resync"),
  ).toEqual([
    expect.objectContaining({ type: "resync", scope: target, sourceEpoch: source, messageID: "msg_credit_fence" }),
  ])
  expect(healthy.state).toBe("established")
  expect([agent.connectionEpoch, healthy.connectionEpoch]).toEqual(epochs.slice(0, 2))
  expect(h.close.filter((item) => item.id === "healthy" || item.id === "agent")).toEqual([])
  h.relay.closeDevice()
  expect(h.relay.reservation.used).toBe(0)
})
