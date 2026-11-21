import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  encodeLossless,
  ControlSchema,
  ScopeSchema,
  ResultSchema,
  operations,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
} from "../../../packages/protocol/src/v5"
import type { Frame } from "../../../packages/protocol/src/v5"
import type { Connection } from "../../../packages/protocol/src/v5/connection"
import { frameReservation } from "../../../packages/remote/src/index"
import { harness } from "./support/relay"

test.each(["status", "inventoryInvalidated", "resyncRequired", "streamEnd"] as const)(
  "%s rechecks each recipient inside the authority cache interval",
  async (kind) => {
    const revoked = new Set<string>()
    const checks: string[] = []
    const h = await harness({
      authorize: async (id) => {
        checks.push(id)
        return revoked.has(id) ? { ok: false, reason: "revoked_session" } : { ok: true, ownerID: "owner" }
      },
    })
    const agent = await h.attach("agent", "agent")
    const denied = await h.attach("denied")
    const valid = await h.attach("valid")
    const scope = create(ScopeSchema, { target: { case: "session", value: "ses_1" } })
    const subscriptionID = "authority-observer"
    async function subscribe(client: Connection, id: string) {
      const operation = operations.find((item) => item.diagnosticName === "event.subscribe")!
      const request = client.request(
        operation.operationId,
        scope,
        encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope })),
        512,
        h.now(),
      ).requestID!
      await h.send(id)
      const dispatch = h
        .receive("agent")
        .flatMap((entry) => entry.decisions)
        .find((entry) => entry.type === "dispatch")!
      if (dispatch.type !== "dispatch") throw new Error("Missing subscription dispatch")
      const epoch: Frame["body"] = {
        case: "control",
        value: create(ControlSchema, { kind: { case: "resyncRequired", value: { scope, sourceEpoch: "backend" } } }),
      }
      if (id === "denied") {
        agent.enqueue(epoch, frameReservation(epoch), h.now())
        await h.send("agent")
      }
      agent.enqueue(
        {
          case: "result",
          value: create(ResultSchema, {
            requestId: dispatch.requestID,
            operationId: operation.operationId,
            settlement: operation.settlement,
            outcome: {
              case: "success",
              value: {
                typeName: operation.resultType,
                payload: encodeStrict(
                  event_subscribe_ResultSchema,
                  create(event_subscribe_ResultSchema, { subscriptionId: encodeLossless(subscriptionID) }),
                ),
              },
            },
          }),
        },
        512,
        h.now(),
      )
      await h.send("agent")
      expect(agent.acceptSubscription(dispatch.requestID, subscriptionID, scope, h.now(), "send", "backend")).toEqual(
        [],
      )
      expect(h.receive(id).flatMap((entry) => entry.decisions)).toContainEqual(
        expect.objectContaining({ type: "settled", requestID: request, status: "success" }),
      )
      expect(client.acceptSubscription(request, subscriptionID, scope, h.now(), "receive", "backend")).toEqual([])
    }
    if (kind === "resyncRequired" || kind === "streamEnd") {
      await subscribe(denied, "denied")
      await subscribe(valid, "valid")
      h.at(25)
      h.relay.sweep()
      h.receive("agent")
    }
    h.receive("denied")
    h.receive("valid")
    checks.length = 0
    revoked.add("denied")
    const body: Frame["body"] =
      kind === "streamEnd"
        ? { case: "streamEnd", value: { $typeName: "ycoding.v5.StreamEnd", subscriptionId: subscriptionID } }
        : {
            case: "control",
            value: create(ControlSchema, {
              kind:
                kind === "status"
                  ? { case: "status", value: { running: ["ses_1"], attention: [] } }
                  : kind === "inventoryInvalidated"
                    ? { case: "inventoryInvalidated", value: {} }
                    : { case: "resyncRequired", value: { scope, sourceEpoch: "backend" } },
            }),
          }
    agent.enqueue(body, frameReservation(body), h.now())
    await h.send("agent")
    expect(checks.sort()).toEqual(["denied", "valid"])
    expect(h.close).toEqual([{ id: "denied", code: 4401, reason: "DIRECTION" }])
    for (const id of ["denied", "valid"]) {
      const delivered = h
        .receive(id)
        .some((entry) =>
          kind === "streamEnd"
            ? entry.frame?.body.case === "streamEnd" && entry.frame.body.value.subscriptionId === subscriptionID
            : entry.frame?.body.case === "control" && entry.frame.body.value.kind.case === kind,
        )
      expect(delivered).toBe(id === "valid")
    }
    h.relay.closeDevice()
    expect(h.relay.reservation.used).toBe(0)
  },
)

test.each(["valid", "revoked"] as const)("cached status replay rechecks a %s joining recipient", async (authority) => {
  let revoked = false
  const h = await harness({
    authorize: async () => (revoked ? { ok: false, reason: "revoked_session" } : { ok: true, ownerID: "owner" }),
  })
  const agent = await h.attach("agent", "agent")
  const body: Frame["body"] = {
    case: "control",
    value: create(ControlSchema, { kind: { case: "status", value: { running: ["ses_private"], attention: [] } } }),
  }
  agent.enqueue(body, frameReservation(body), h.now())
  await h.send("agent")
  const joining = await h.attach("joining", "client", {}, undefined, false)
  joining.start(h.now())
  await h.send("joining")
  h.receive("joining")
  revoked = authority === "revoked"
  await h.send("joining")
  const statuses = h
    .receive("joining")
    .flatMap((entry) =>
      entry.frame?.body.case === "control" && entry.frame.body.value.kind.case === "status"
        ? [entry.frame.body.value.kind.value.running]
        : [],
    )
  expect(statuses).toEqual(authority === "valid" ? [["ses_private"]] : [])
  expect(h.close).toEqual(authority === "valid" ? [] : [{ id: "joining", code: 4401, reason: "DIRECTION" }])
  h.relay.closeDevice()
  expect(h.relay.reservation.used).toBe(0)
})

test("a joining recipient without cached status does not repeat the upgrade authority read", async () => {
  const checks: string[] = []
  const h = await harness({
    authorize: async (id) => {
      checks.push(id)
      return { ok: true, ownerID: "owner" }
    },
  })
  await h.attach("client")
  expect(checks).toEqual(["client"])
  h.relay.closeDevice()
})

test("fresh recipient authority leaves independent same-Session reads concurrent", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let held = false
  let checks = 0
  const h = await harness({
    authorize: async () => {
      checks++
      if (held) {
        held = false
        entered.resolve()
        await release.promise
      }
      return { ok: true, ownerID: "owner" }
    },
  })
  await h.attach("agent", "agent")
  const client = await h.attach("client")
  checks = 0
  held = true
  const first = h.request(client)
  const admitting = h.send("client")
  await entered.promise
  const second = h.request(client)
  await h.send("client")
  const forwarded = h
    .receive("agent")
    .flatMap((entry) => entry.decisions)
    .filter((entry) => entry.type === "dispatch")
  expect(first).not.toBe(second)
  expect(forwarded).toHaveLength(1)
  expect(checks).toBe(2)
  release.resolve()
  await admitting
  expect(
    h
      .receive("agent")
      .flatMap((entry) => entry.decisions)
      .filter((entry) => entry.type === "dispatch"),
  ).toHaveLength(1)
  expect(h.close).toEqual([])
  h.relay.closeDevice()
  expect(h.relay.reservation.used).toBe(0)
})
