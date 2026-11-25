import { expect, test } from "bun:test"
import { LedgerClass } from "../../../packages/protocol/src/v5"
import { defaultBudgets } from "../../../packages/protocol/src/v5/connection"
import { frameReservation, RemoteLimits } from "../../../packages/remote/src/index"
import { harness } from "./support/relay"

test("an idle peer waits for its heartbeat instead of re-arming a short alarm", async () => {
  const h = await harness()
  await h.attach("client")
  expect(h.relay.nextDeadline()).toBe(defaultBudgets.pingIntervalMs)
  for (let time = 25; time < defaultBudgets.pingIntervalMs; time += 25 * 97) {
    h.at(time)
    h.relay.sweep()
    expect(h.relay.nextDeadline()).toBe(defaultBudgets.pingIntervalMs)
  }
  expect(h.close).toEqual([])
})

test("an unacknowledged delivery sets the deadline and closes the peer on time", async () => {
  const h = await harness()
  await h.attach("client")
  h.at(defaultBudgets.pingIntervalMs)
  h.relay.sweep()
  const stall = defaultBudgets.deliveryTimeoutMs
  expect(h.relay.nextDeadline()).toBe(stall)
  h.at(stall - 1)
  h.relay.sweep()
  expect(h.close).toEqual([])
  h.at(stall)
  h.relay.sweep()
  expect(h.close).toEqual([{ id: "client", code: 1002, reason: "LIMIT" }])
  expect(h.relay.nextDeadline()).toBeUndefined()
})

test("credential expiry sets the deadline and drops the peer exactly when it passes", async () => {
  const h = await harness()
  await h.attach("client", "client", { credentialExpiresAt: 5_000 })
  expect(h.relay.nextDeadline()).toBe(5_000)
  h.at(4_999)
  h.relay.sweep()
  expect(h.close).toEqual([])
  h.at(5_000)
  h.relay.sweep()
  expect(h.close).toEqual([{ id: "client", code: 4401, reason: "DIRECTION" }])
})

test("a pending credit grant keeps its prompt deadline and settles after the sweep", async () => {
  const h = await harness()
  const agent = await h.attach("agent", "agent")
  const client = await h.attach("client")
  h.at(100)
  h.request(client)
  await h.send("client")
  const dispatch = h
    .receive("agent")
    .flatMap((entry) => entry.decisions)
    .find((entry) => entry.type === "dispatch")!
  if (dispatch.type !== "dispatch") throw new Error("Missing dispatch")
  const result = h.result(dispatch)
  agent.enqueue(result, frameReservation(result), h.now())
  await h.send("agent")
  for (const item of h.receive("client")) {
    if (item.frame?.ledger === LedgerClass.NORMAL) client.consume(LedgerClass.NORMAL, item.frame.deliveryOrdinal, h.now())
  }
  expect(h.relay.nextDeadline()).toBe(defaultBudgets.pingIntervalMs)
  h.at(125)
  client.advance(125)
  await h.send("client")
  expect(h.relay.nextDeadline()).toBe(125 + defaultBudgets.creditDelayMs)
  h.at(125 + defaultBudgets.creditDelayMs)
  h.relay.sweep()
  expect(h.relay.nextDeadline()).toBe(defaultBudgets.pingIntervalMs)
})

test("the offline confirmation deadline competes with connected peers", async () => {
  const h = await harness()
  await h.attach("agent", "agent")
  await h.relay.agentClosed({
    connectionID: "agent",
    role: "agent",
    ownerID: "owner",
    deviceID: "device",
    browserSessionID: "agent",
    credentialExpiresAt: 1_000_000,
  })
  h.at(15_000)
  await h.attach("client")
  h.at(35_000)
  h.relay.sweep()
  expect(h.relay.nextDeadline()).toBe(RemoteLimits.agentOfflineConfirmMs)
})
