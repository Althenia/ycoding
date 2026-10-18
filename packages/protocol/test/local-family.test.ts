import { expect, test } from "bun:test"
import {
  operations,
  operationIDsByRole,
  PeerRole,
  ScopeKind,
  MutationClass,
  Settlement,
  Paging,
  Streaming,
  create,
  encodeLossless,
  encodeStrict,
  session_capturedChanges_list_RequestSchema,
  session_team_economics_RequestSchema,
  session_family_activity_RequestSchema,
} from "../src/v5/index.js"
import { pair, send, session, machine } from "./connection-fixtures.js"

const cases = [
  {
    name: "session.capturedChanges.list",
    id: 5008,
    paging: Paging.CURSOR,
    payload: () =>
      encodeStrict(
        session_capturedChanges_list_RequestSchema,
        create(session_capturedChanges_list_RequestSchema, { payload: {} }),
      ),
  },
  {
    name: "session.team.economics",
    id: 5013,
    paging: Paging.UNPAGED,
    payload: () =>
      encodeStrict(
        session_team_economics_RequestSchema,
        create(session_team_economics_RequestSchema, {
          payload: { sessionIDs: { items: [encodeLossless("ses_root")] } },
        }),
      ),
  },
  {
    name: "session.family.activity",
    id: 5018,
    paging: Paging.UNPAGED,
    payload: () =>
      encodeStrict(
        session_family_activity_RequestSchema,
        create(session_family_activity_RequestSchema, { payload: { sessionIDs: { items: [] } } }),
      ),
  },
]

test.each(cases)("M7 $name admits the canonical local read through the connection", (item) => {
  const operation = operations.find((entry) => entry.diagnosticName === item.name)!
  expect(operation).toMatchObject({
    operationId: item.id,
    roles: [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY],
    scope: ScopeKind.SESSION,
    mutation: MutationClass.READ,
    settlement: Settlement.COMPLETED,
    paging: item.paging,
    streaming: Streaming.TYPED_BULK,
    errorTypes: ["ycoding.v5.Connector_Error"],
  })
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  const admission = endpoints.client.request(item.id, session("ses_root"), item.payload(), 512, 0)
  expect(admission.requestID).toBeDefined()
  expect(send(endpoints.client, endpoints.server).decisions).toContainEqual(
    expect.objectContaining({ type: "dispatch", operation: expect.objectContaining({ operationId: item.id }) }),
  )
})

test.each(cases)("M7 $name rejects an unrelated scope and server/agent request authority", (item) => {
  const endpoints = pair()
  send(endpoints.server, endpoints.client)
  expect(endpoints.client.request(item.id, machine(), item.payload(), 512, 0).requestID).toBeUndefined()
  for (const role of [PeerRole.SERVER, PeerRole.AGENT]) {
    expect(operationIDsByRole[role]).not.toContain(item.id)
  }
  expect(endpoints.server.request(item.id, session("ses_root"), item.payload(), 512, 0).requestID).toBeUndefined()
})

test("M7 keeps exactly three connector reads available to local clients", () => {
  expect(
    operations
      .filter((item) => item.operationId >= 5000 && item.roles.includes(PeerRole.LOCAL_CLIENT))
      .map((item) => item.operationId),
  ).toEqual([5008, 5013, 5018])
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toHaveLength(87)
  expect(operationIDsByRole[PeerRole.RELAY]).toHaveLength(84)
})
