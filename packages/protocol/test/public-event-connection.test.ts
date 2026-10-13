import { expect, test } from "bun:test"
import { Connection } from "../src/v5/connection/index.js"
import {
  create,
  encodeStrict,
  operations,
  PeerRole,
  ScopeSchema,
  PublicEventSchema,
  SessionLogItemSchema,
  PublicEvent_catalog_updatedSchema,
  EventBatchSchema,
  EventRecordSchema,
  FrameSchema,
  LedgerClass,
  event_subscribe_RequestSchema,
} from "../src/v5/index.js"
import { send, receive, subscribeTo, globalScope, session } from "./connection-fixtures.js"

function realPair(role = PeerRole.LOCAL_CLIENT) {
  const eventTypes = [PublicEventSchema.typeName, SessionLogItemSchema.typeName]
  const peer = role === PeerRole.LOCAL_CLIENT ? PeerRole.SERVER : PeerRole.RELAY
  const client = new Connection({ role, peer, operations, eventTypes, now: 0 })
  const server = new Connection({
    role: peer,
    peer: role,
    operations,
    eventTypes,
    now: 0,
    epoch: "connection-1",
    sourceEpoch: "source-1",
  })
  client.start(0)
  send(client, server)
  send(server, client)
  send(client, server)
  send(server, client)
  return { client, server }
}

test("REQ-WIRE-005 event.subscribe accepts typed ephemerals and rejects Session log sync markers", () => {
  for (const typeName of [PublicEventSchema.typeName, SessionLogItemSchema.typeName]) {
    const endpoints = realPair()
    subscribeTo(endpoints, session(), "public-1")
    const payload =
      typeName === PublicEventSchema.typeName
        ? encodeStrict(
            PublicEventSchema,
            create(PublicEventSchema, {
              kind: {
                case: "catalogUpdated",
                value: create(PublicEvent_catalog_updatedSchema, {
                  id: { encoding: { case: "utf8", value: "evt_catalog" } },
                  created: 0,
                  type: 1,
                  data: {},
                }),
              },
            }),
          )
        : encodeStrict(
            SessionLogItemSchema,
            create(SessionLogItemSchema, {
              kind: {
                case: "value52",
                value: {
                  type: 1,
                  aggregateID: { encoding: { case: "utf8", value: "ses_a" } },
                  sourceEpoch: { encoding: { case: "utf8", value: "source-1" } },
                },
              },
            }),
          )
    const input = create(FrameSchema, {
      revision: 5,
      connectionEpoch: "connection-1",
      ledger: LedgerClass.EVENT,
      deliveryOrdinal: 1n,
      body: {
        case: "eventBatch",
        value: create(EventBatchSchema, {
          subscriptionId: "public-1",
          scope: session(),
          sourceEpoch: "source-1",
          events: [create(EventRecordSchema, { eventId: "evt_catalog", createdMs: 0n, event: { typeName, payload } })],
        }),
      },
    })
    const decisions = receive(endpoints.client, input)
    if (typeName === PublicEventSchema.typeName)
      expect(decisions).toContainEqual(expect.objectContaining({ type: "events" }))
    else expect(decisions).toContainEqual(expect.objectContaining({ type: "closed" }))
  }
})

test("REQ-WIRE-006 canonical remote event requests accept Session scope and deny global feed authority", () => {
  for (const scope of [
    session(),
    globalScope(),
    create(ScopeSchema, { target: { case: "location", value: { encoding: { case: "utf8", value: "/arbitrary" } } } }),
  ]) {
    const endpoints = realPair(PeerRole.REMOTE_CLIENT)
    const result = endpoints.client.request(
      4000,
      scope,
      encodeStrict(event_subscribe_RequestSchema, create(event_subscribe_RequestSchema, { scope })),
      512,
      0,
    )
    expect(!!result.requestID).toBe(scope.target.case === "session")
    if (result.requestID)
      expect(send(endpoints.client, endpoints.server).decisions).toContainEqual(
        expect.objectContaining({ type: "dispatch" }),
      )
  }
})
