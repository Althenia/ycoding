import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { Connection } from "../src/v5/connection/index.js"
import type { Options, Decision } from "../src/v5/connection/index.js"
import {
  FrameSchema,
  PeerRole,
  operations,
  ControlSchema,
  PingSchema,
  ScopeSchema,
  ResultSchema,
  TypedPayloadSchema,
  health_get_RequestSchema,
  health_get_ResultSchema,
  ServiceHealthSchema,
  LosslessStringSchema,
  event_subscribe_RequestSchema,
  event_subscribe_ResultSchema,
} from "../src/generated/v5/index.js"
import { EventBatchSchema, EventRecordSchema } from "../src/generated/v5/index.js"
import type { Frame, Scope } from "../src/generated/v5/index.js"
import { decodeLossless } from "../src/v5/validate.js"

export function wire(frame: Frame) {
  const bytes = toBinary(FrameSchema, frame)
  return { frame: fromBinary(FrameSchema, bytes), bytes: bytes.length }
}

export function receive(connection: Connection, frame: Frame, now = 0): Decision[] {
  const encoded = wire(frame)
  const reservation = connection.admitIncoming(encoded.bytes)
  if (!reservation) return connection.takeDecisions()
  return connection.acceptIncoming(reservation, encoded.frame, now)
}

export function send(sender: Connection, receiver: Connection, now = 0) {
  const prepared = sender.prepareHandoff(now)
  if (!prepared) throw new Error("no prepared frame")
  const encoded = wire(prepared.frame)
  const sent = sender.handoff(prepared, encoded.bytes, now)
  return { frame: encoded.frame, bytes: encoded.bytes, decisions: [...sent, ...receive(receiver, encoded.frame, now)] }
}

export function pair(budgets: Options["budgets"] = {}) {
  const client = new Connection({
    role: PeerRole.LOCAL_CLIENT,
    peer: PeerRole.SERVER,
    operations,
    eventTypes: testOnlyEventTypes,
    now: 0,
    budgets,
  })
  const server = new Connection({
    role: PeerRole.SERVER,
    peer: PeerRole.LOCAL_CLIENT,
    operations,
    now: 0,
    epoch: "connection-1",
    sourceEpoch: "source-1",
    eventTypes: testOnlyEventTypes,
    budgets,
  })
  client.start(0)
  send(client, server)
  send(server, client)
  send(client, server)
  return { client, server }
}

export function ping(id = 1n): Frame["body"] {
  return {
    case: "control",
    value: create(ControlSchema, { kind: { case: "ping", value: create(PingSchema, { id }) } }),
  }
}

export function session(id = "session-1") {
  return create(ScopeSchema, { target: { case: "session", value: id } })
}

export function machine() {
  return create(ScopeSchema, { target: { case: "machine", value: {} } })
}

export function globalScope() {
  return create(ScopeSchema, { target: { case: "global", value: {} } })
}

export const health = operations.find((operation) => operation.diagnosticName === "health.get")!
export const stop = operations.find((operation) => operation.diagnosticName === "health.stop")!
export const subscribeOperation = operations.find((operation) => operation.diagnosticName === "event.subscribe")!
export const testOnlyEventTypes = ["ycoding.v5.health_get_Request", "ycoding.v5.health_stop_Request"]

export function healthRequest() {
  return toBinary(health_get_RequestSchema, create(health_get_RequestSchema))
}

export function healthResult(requestID: string): Frame["body"] {
  const text = (value: string) => create(LosslessStringSchema, { encoding: { case: "utf8", value } })
  return {
    case: "result",
    value: create(ResultSchema, {
      requestId: requestID,
      operationId: health.operationId,
      settlement: health.settlement,
      outcome: {
        case: "success",
        value: create(TypedPayloadSchema, {
          typeName: health.resultType,
          payload: toBinary(
            health_get_ResultSchema,
            create(health_get_ResultSchema, {
              data: create(ServiceHealthSchema, {
                healthy: true,
                version: text("test"),
                pid: 1n,
                sourceEpoch: text("source-1"),
              }),
            }),
          ),
        }),
      },
    }),
  }
}

export function subscribeRequest(scope: Scope) {
  return toBinary(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope }))
}

export function subscribeTo(endpoints: ReturnType<typeof pair>, scope: Scope, subscriptionID: string, now = 0) {
  const admission = endpoints.client.request(
    subscribeOperation.operationId,
    globalScope(),
    subscribeRequest(scope),
    512,
    now,
  )
  if (!admission.requestID) throw new Error("subscription request rejected")
  const request = send(endpoints.client, endpoints.server, now).decisions.find(
    (decision) => decision.type === "dispatch",
  )
  if (!request || request.type !== "dispatch") throw new Error("subscription dispatch missing")
  const decoded = fromBinary(event_subscribe_RequestSchema, request.request.payload)
  if (!decoded.scope) throw new Error("subscription scope missing")
  endpoints.server.enqueue(
    {
      case: "result",
      value: create(ResultSchema, {
        requestId: admission.requestID,
        operationId: subscribeOperation.operationId,
        settlement: subscribeOperation.settlement,
        outcome: {
          case: "success",
          value: create(TypedPayloadSchema, {
            typeName: event_subscribe_ResultSchema.typeName,
            payload: toBinary(
              event_subscribe_ResultSchema,
              create(event_subscribe_ResultSchema, {
                subscriptionId: create(LosslessStringSchema, { encoding: { case: "utf8", value: subscriptionID } }),
              }),
            ),
          }),
        },
      }),
    },
    512,
    now,
  )
  const result = send(endpoints.server, endpoints.client, now).decisions.find((decision) => decision.type === "settled")
  if (!result || result.type !== "settled" || !result.payload) throw new Error("subscription result missing")
  const identity = fromBinary(event_subscribe_ResultSchema, result.payload.payload).subscriptionId
  if (!identity) throw new Error("subscription identity missing")
  const id = decodeLossless(identity)
  endpoints.client.acceptSubscription(admission.requestID, id, decoded.scope, now)
  endpoints.server.acceptSubscription(admission.requestID, id, decoded.scope, now, "send")
}

export function subscribed(budgets: Options["budgets"] = {}, scope = session()) {
  const endpoints = pair(budgets)
  send(endpoints.server, endpoints.client)
  subscribeTo(endpoints, scope, "subscription-1")
  return endpoints
}

export function batch(
  subscriptionID = "subscription-1",
  sourceEpoch = "source-1",
  sessionID = "session-1",
  eventID = "event-1",
) {
  return create(EventBatchSchema, {
    subscriptionId: subscriptionID,
    sourceEpoch,
    scope: session(sessionID),
    events: [
      create(EventRecordSchema, {
        eventId: eventID,
        createdMs: 0n,
        event: create(TypedPayloadSchema, { typeName: "ycoding.v5.health_get_Request", payload: healthRequest() }),
      }),
    ],
  })
}
