import { expect, test } from "bun:test"
import { Connection } from "../src/v5/connection/index.js"
import { defaultBudgets } from "../src/v5/connection/budgets.js"
import { LedgerClass, PeerRole, operations } from "../src/generated/v5/index.js"
import { batch, health, healthRequest, machine, pair as handshaken, send, session, subscribed } from "./connection-fixtures.js"

function observe(connection: Connection, time: number) {
  const decisions = connection.advance(time)
  const prepared = connection.prepareHandoff(time)
  if (prepared) connection.abortPrepared(prepared)
  return { closed: decisions.some((decision) => decision.type === "closed"), frame: prepared?.frame.body.case }
}

function drain(a: Connection, b: Connection, time: number) {
  for (let moved = true; moved; ) {
    moved = false
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const prepared = from.prepareHandoff(time)
      if (!prepared) continue
      from.abortPrepared(prepared)
      send(from, to, time)
      moved = true
    }
  }
}

function pair() {
  const endpoints = handshaken()
  drain(endpoints.client, endpoints.server, 0)
  return endpoints
}

function expectQuietThenDue(connection: Connection, deadline: number, due: (observed: ReturnType<typeof observe>) => boolean) {
  expect(connection.nextDeadline()).toBe(deadline)
  const before = observe(connection, deadline - 1)
  expect(before.closed).toBe(false)
  expect(before.frame).toBeUndefined()
  expect(connection.nextDeadline()).toBe(deadline)
  expect(due(observe(connection, deadline))).toBe(true)
}

test("a connection that has not completed the handshake is due at the handshake timeout", () => {
  const client = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: [],
    now: 0,
  })
  client.start(0)
  const prepared = client.prepareHandoff(0)!
  client.abortPrepared(prepared)
  const timeout = 5000
  expect(client.nextDeadline()).toBe(timeout)
  expect(observe(client, timeout - 1).closed).toBe(false)
  expect(observe(client, timeout).closed).toBe(true)
  expect(client.nextDeadline()).toBeUndefined()
})

test("an idle established connection is due at its heartbeat and never earlier", () => {
  const { server } = pair()
  expectQuietThenDue(server, defaultBudgets.pingIntervalMs, (observed) => observed.frame === "control")
})

test("an unacknowledged heartbeat is due at the delivery timeout and the connection stays quiet until then", () => {
  const { client, server } = pair()
  client.advance(defaultBudgets.pingIntervalMs)
  send(client, server, defaultBudgets.pingIntervalMs)
  const stall = defaultBudgets.pingIntervalMs + defaultBudgets.deliveryTimeoutMs
  expect(client.nextDeadline()).toBe(stall)
  expect(observe(client, stall - 1)).toEqual({ closed: false, frame: undefined })
  expect(observe(client, stall).closed).toBe(true)
  expect(client.nextDeadline()).toBeUndefined()
})

test("a pending credit grant is due after the credit delay", () => {
  const { client, server } = pair()
  client.request(health.operationId, machine(), healthRequest(), 512, 100)
  const dispatch = send(client, server, 100).decisions.find((decision) => decision.type === "dispatch")!
  if (dispatch.type !== "dispatch") throw new Error("Missing dispatch")
  drain(client, server, 100)
  server.consume(LedgerClass.NORMAL, dispatch.ordinal, 100)
  expectQuietThenDue(server, 100 + defaultBudgets.creditDelayMs, (observed) => observed.frame === "control")
})

test("a coalescing event batch is due when its window opens", () => {
  const { server } = subscribed()
  server.enqueueEvent(batch().events[0], { subscriptionID: "subscription-1", scope: session(), sourceEpoch: "source-1" }, 0)
  expectQuietThenDue(server, defaultBudgets.interactiveCoalesceMs, (observed) => observed.frame === "eventBatch")
})
