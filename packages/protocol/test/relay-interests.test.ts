import { expect, test } from "bun:test"
import { Connection } from "../src/v5/connection/index.js"
import {
  create,
  operations,
  PeerRole,
  PublicEventSchema,
  SubscriptionSnapshotSchema,
  EventRecordSchema,
  ScopeSchema,
  EventBatchSchema,
  LedgerClass,
  ResultSchema,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
  encodeStrict,
  encodeLossless,
} from "../src/v5/index.js"
import { send } from "./connection-fixtures.js"

function connected() {
  const agent = new Connection({
    role: PeerRole.AGENT,
    peer: PeerRole.RELAY,
    operations,
    eventTypes: [PublicEventSchema.typeName],
    now: 0,
  })
  const relay = new Connection({
    role: PeerRole.RELAY,
    peer: PeerRole.AGENT,
    operations,
    eventTypes: [PublicEventSchema.typeName],
    now: 0,
    epoch: "connection-1",
    sourceEpoch: "relay-source",
  })
  agent.start(0)
  send(agent, relay)
  send(relay, agent)
  send(agent, relay)
  send(relay, agent)
  return { agent, relay }
}
const snapshot = (clientId: string, sessionIds: string[]) =>
  create(SubscriptionSnapshotSchema, { clientId, sessionIds })
function status(id: string) {
  return create(EventRecordSchema, {
    eventId: id,
    createdMs: 0n,
    event: {
      typeName: PublicEventSchema.typeName,
      payload: encodeStrict(
        PublicEventSchema,
        create(PublicEventSchema, {
          kind: {
            case: "sessionStatus",
            value: {
              id: encodeLossless(id),
              created: 0,
              type: 1,
              data: { sessionID: encodeLossless("ses_a"), status: { kind: { case: "value1", value: { type: 1 } } } },
            },
          },
        }),
      ),
    },
  })
}

test("AC-WIRE-011 connector union retains a shared accepted identity until its last client releases", () => {
  const { agent } = connected()
  expect(agent.updateRelayInterests(snapshot("one", ["ses_a"]), 0)).toMatchObject({ added: ["ses_a"], removed: [] })
  expect(agent.updateRelayInterests(snapshot("two", ["ses_a", "ses_b"]), 0)).toMatchObject({
    added: ["ses_b"],
    removed: [],
  })
  expect(agent.registerRelayInterest("ses_a", "accepted-a", "backend-source", 0)).toEqual([])
  expect(agent.registerRelayInterest("ses_b", "accepted-b", "backend-source", 0)).toEqual([])
  expect(agent.registerRelayInterest("ses_a", "duplicate-a", "backend-source", 0)).toEqual([
    { type: "relayInterestRejected", sessionID: "ses_a" },
  ])
  expect(agent.state).toBe("established")
  expect(agent.relaySubscriptionID("ses_a")).toBe("accepted-a")
  expect(agent.releaseRelayClient("one", 0)).toMatchObject({ removed: [] })
  expect(agent.relaySubscriptionID("ses_a")).toBe("accepted-a")
  expect(agent.releaseRelayClient("two", 0)).toMatchObject({ removed: ["ses_a", "ses_b"] })
  expect(agent.relaySubscriptionID("ses_a")).toBeUndefined()
  expect(agent.relayInterestRetainedBytes).toBe(0)
})

test("AC-WIRE-011 accepted connector interest sends canonical EventBatch identity and releases queued delivery", () => {
  const { agent, relay } = connected()
  agent.updateRelayInterests(snapshot("one", ["ses_a"]), 0)
  agent.registerRelayInterest("ses_a", "accepted-a", "backend-source", 0)
  const scope = create(ScopeSchema, { target: { case: "session", value: "ses_a" } })
  const event = status("evt_a")
  agent.enqueueEvent(event, { subscriptionID: "accepted-a", scope, sourceEpoch: "backend-source" }, 0)
  const prepared = agent.prepareHandoff(40)!
  expect(prepared.frame.body.case).toBe("eventBatch")
  if (prepared.frame.body.case !== "eventBatch") throw new Error("event batch")
  expect(prepared.frame.body.value.subscriptionId).toBe("accepted-a")
  agent.abortPrepared(prepared)
  agent.releaseRelayClient("one", 40)
  expect(agent.prepareHandoff(40)).toBeUndefined()
  expect(agent.registerRelayInterest("ses_a", "stale", "backend-source", 40)).toContainEqual({
    type: "relayInterestRejected",
    sessionID: "ses_a",
  })
  expect(agent.state).toBe("established")
  expect(relay.state).toBe("established")
})

test("AC-WIRE-011 reconstruction clears connection-owned client snapshots and accepted interests", () => {
  const { agent } = connected()
  agent.updateRelayInterests(snapshot("one", ["ses_a"]), 0)
  agent.registerRelayInterest("ses_a", "accepted-a", "backend-source", 0)
  expect(agent.relayInterestRetainedBytes).toBeGreaterThan(0)
  agent.restart(0)
  expect(agent.relayInterestRetainedBytes).toBe(0)
  expect(agent.relaySubscriptionID("ses_a")).toBeUndefined()
  expect(agent.reservation.used).toBe(0)
})
function forwarding(canonical = true) {
  const client = new Connection({
    role: PeerRole.REMOTE_CLIENT,
    peer: PeerRole.RELAY,
    operations,
    eventTypes: [PublicEventSchema.typeName],
    now: 0,
  })
  const relay = new Connection({
    role: PeerRole.RELAY,
    peer: PeerRole.REMOTE_CLIENT,
    operations,
    eventTypes: [PublicEventSchema.typeName],
    now: 0,
    epoch: "connection-1",
    sourceEpoch: "relay-process-source",
  })
  client.start(0)
  send(client, relay)
  send(relay, client)
  send(client, relay)
  send(relay, client)
  const scope = create(ScopeSchema, { target: { case: "session", value: "ses_a" } })
  const operation = operations.find((operation) => operation.diagnosticName === "event.subscribe")!
  const request = client.request(
    operation.operationId,
    scope,
    encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope })),
    512,
    0,
  )
  send(client, relay)
  relay.enqueue(
    {
      case: "result",
      value: create(ResultSchema, {
        requestId: request.requestID,
        operationId: operation.operationId,
        settlement: operation.settlement,
        outcome: {
          case: "success",
          value: {
            typeName: operation.resultType,
            payload: encodeStrict(
              event_subscribe_ResultSchema,
              create(event_subscribe_ResultSchema, { subscriptionId: encodeLossless("accepted-a") }),
            ),
          },
        },
      }),
    },
    512,
    0,
  )
  send(relay, client)
  const registration = relay.acceptSubscription(
    request.requestID!,
    "accepted-a",
    scope,
    0,
    "send",
    canonical ? "backend-source" : undefined,
  )
  client.acceptSubscription(request.requestID!, "accepted-a", scope, 0, "receive", "backend-source")
  return {
    relay,
    client,
    registration,
    batch: create(EventBatchSchema, {
      subscriptionId: "accepted-a",
      scope,
      sourceEpoch: "backend-source",
      events: [status("evt_one"), status("evt_two")],
    }),
  }
}
test("AC-WIRE-011 complete forwarded batch keeps identity and accounting until downstream consumption", () => {
  const { relay, client, batch } = forwarding()
  const forwarded = relay.forwardEventBatch(batch, 0)
  expect(forwarded.ticket).toBeDefined()
  if (forwarded.ticket === undefined) throw new Error("forwarding ticket")
  const delivery = send(relay, client, 0)
  expect(delivery.frame.body).toEqual({ case: "eventBatch", value: batch })
  expect(relay.ledger(LedgerClass.EVENT).handedBytes).toBeGreaterThan(0)
  client.consume(LedgerClass.EVENT, delivery.frame.deliveryOrdinal, 0)
  client.advance(25)
  const receipt = send(client, relay, 25)
  expect(receipt.decisions).toContainEqual({ type: "eventBatchReleased", ticket: forwarded.ticket, consumed: true })
  expect(relay.ledger(LedgerClass.EVENT).handedBytes).toBe(0)
})
test.each(["queued", "handed"])("AC-WIRE-011 restart releases %s forwarding tickets once", (phase) => {
  const { relay, client, batch } = forwarding()
  const forwarded = relay.forwardEventBatch(batch, 0)
  if (forwarded.ticket === undefined) throw new Error("forwarding ticket")
  if (phase === "handed") send(relay, client, 0)
  expect(relay.restart(0)).toContainEqual({ type: "eventBatchReleased", ticket: forwarded.ticket, consumed: false })
  expect(relay.restart(0)).toEqual([])
  expect(relay.reservation.used).toBe(0)
})

test("relay forwarding rejects a noncanonical backend epoch instead of trusting Ready or a batch", () => {
  const { relay, batch } = forwarding()
  batch.sourceEpoch = "relay-process-source"
  expect(relay.forwardEventBatch(batch, 0).decisions).toContainEqual(expect.objectContaining({ type: "closed" }))
})

test("relay send registration refuses a missing canonical epoch", () => {
  expect(forwarding(false).registration).toContainEqual(expect.objectContaining({ type: "closed" }))
})

test("relay receive registration accepts the canonical backend epoch and holds finite completion for forwarding", () => {
  const { agent, relay } = connected()
  const scope = create(ScopeSchema, { target: { case: "session", value: "ses_a" } })
  const operation = operations.find((item) => item.diagnosticName === "event.subscribe")!
  const request = relay.request(
    operation.operationId,
    scope,
    encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope })),
    512,
    0,
  )
  send(relay, agent)
  agent.updateRelayInterests(snapshot("one", ["ses_a"]), 0)
  agent.registerRelayInterest("ses_a", "accepted-a", "backend-source", 0)
  agent.enqueue(
    {
      case: "result",
      value: create(ResultSchema, {
        requestId: request.requestID,
        operationId: operation.operationId,
        settlement: operation.settlement,
        outcome: {
          case: "success",
          value: {
            typeName: operation.resultType,
            payload: encodeStrict(
              event_subscribe_ResultSchema,
              create(event_subscribe_ResultSchema, { subscriptionId: encodeLossless("accepted-a") }),
            ),
          },
        },
      }),
    },
    512,
    0,
  )
  send(agent, relay)
  expect(agent.acceptSubscription(request.requestID!, "accepted-a", scope, 0, "send", "backend-source")).toEqual([])
  expect(relay.acceptSubscription(request.requestID!, "accepted-a", scope, 0, "receive", "backend-source")).toEqual([])
  agent.enqueue(
    { case: "streamEnd", value: { $typeName: "ycoding.v5.StreamEnd", subscriptionId: "accepted-a" } },
    512,
    0,
  )
  const ending = send(agent, relay)
  expect(ending.decisions).toContainEqual({ type: "streamEnded", subscriptionID: "accepted-a" })
  expect(relay.ledger(LedgerClass.EVENT).receivedBytes).toBeGreaterThan(0)
  relay.consume(LedgerClass.EVENT, ending.frame.deliveryOrdinal, 0)
  expect(relay.ledger(LedgerClass.EVENT).receivedBytes).toBe(0)
})
