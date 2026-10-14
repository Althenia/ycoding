import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  encodeLossless,
  ControlSchema,
  ScopeSchema,
  ResultSchema,
  PublicEventSchema,
  EventRecordSchema,
  operations,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
} from "../../../packages/protocol/src/v5"
import type { Connection } from "../../../packages/protocol/src/v5/connection"
import { frameReservation } from "../../../packages/remote/src/index"
import { harness } from "./support/relay"

test.each(["backend-epoch", "replacement-epoch"])(
  "scoped invalidation with %s preserves the established epoch rules",
  async (epoch) => {
    const h = await harness()
    const agent = await h.attach("agent", "agent")
    const first = await h.attach("first")
    const second = await h.attach("second")
    const source = "backend-epoch"
    const scope = (id: string) => create(ScopeSchema, { target: { case: "session", value: id } })
    const operation = operations.find((item) => item.diagnosticName === "event.subscribe")!
    const subscribe = async (peer: Connection, name: string, session: string, accepted: string, announce = true) => {
      const target = scope(session)
      const request = peer.request(
        operation.operationId,
        target,
        encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope: target })),
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
                payload: encodeStrict(
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
    ]) {
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
    h.at(50)
    agent.advance(50)
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
  },
)
