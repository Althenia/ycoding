import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  FrameSchema,
  ControlSchema,
  ScopeSchema,
  ResultSchema,
  operations,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
} from "../../../packages/protocol/src/v5"
import { frameReservation } from "../../../packages/remote/src/index"
import { harness } from "./support/relay"

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
  expect(received[1].frame?.body).toMatchObject({
    case: "control",
    value: {
      kind: {
        case: "status",
        value: { running: ["ses_2"] },
      },
    },
  })
  expect(received[1].frame!.deliveryOrdinal).toBe(received[0].frame!.deliveryOrdinal + 1n)
  expect(h.close).toEqual([])
})

test("relay handoff preserves the rejection of a genuinely regressing clock", async () => {
  let time = 100
  const h = await harness({ monotonic: () => time })
  await h.attach("client")
  time--
  expect(() => h.relay.sweep()).toThrow("monotonic time")
})
