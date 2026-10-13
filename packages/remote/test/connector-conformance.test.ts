import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  decodeLossless,
  remote_session_autonomy_set_Request_payloadSchema,
  remote_session_goal_set_Request_payloadSchema,
  remote_session_fs_find_Request_payloadSchema,
  Connector_FileFindSchema,
  session_family_activity_Result_dataItem_activitySchema,
  remote_session_form_list_ResultSchema,
  session_form_list_ResultSchema,
  ConnectorNoticePageSchema,
  ConnectorNoticeSettlementSchema,
  ConnectorNoticeIDsSchema,
  remote_provider_auth_key_ResultSchema,
  remote_provider_auth_complete_ResultSchema,
  operations,
  operationIDsByRole,
  PeerRole,
  MutationClass,
  ScopeKind,
} from "@ycoding-ai/protocol/v5"
import { remoteOperations, remoteNoticeOperations, remoteOperationAccess, requireSession } from "../src/index.ts"
import { connectorOperations, noticeOperations } from "../../protocol/test/connector-source.js"

test("live remote membership equals the frozen connector and relay notice allocations", () => {
  expect(Object.keys(connectorOperations).sort()).toEqual([...remoteOperations].sort())
  expect(Object.keys(noticeOperations).sort()).toEqual([...remoteNoticeOperations].sort())
})

test("session requirement and workspace placement use existing scope metadata", () => {
  for (const source of remoteOperations) {
    const [id] = connectorOperations[source]
    const descriptor = operations.find((item) => item.operationId === id)!
    if (requireSession(source)) expect([ScopeKind.SESSION, ScopeKind.FORM]).toContain(descriptor.scope)
    if (!requireSession(source))
      expect([ScopeKind.MACHINE, ScopeKind.WORKSPACE, ScopeKind.GLOBAL]).toContain(descriptor.scope)
  }
})

test("every generated connector mutation class equals the live ordered-lane classification", () => {
  const actual = operations.filter((item) => item.roles.includes(PeerRole.RELAY))
  expect(actual).toHaveLength(70)
  for (const operation of remoteOperations) {
    const [id] = connectorOperations[operation]
    expect(operations.find((item) => item.operationId === id)?.mutation, operation).toBe(
      remoteOperationAccess[operation] === "read" ? MutationClass.READ : MutationClass.MUTATION,
    )
  }
})

test("Rust/TS connector autonomy preserves zero, nullable budgets and boolean YOLO", () => {
  for (const [hex, budget] of [
    ["0a02080012020800", { case: "value1", value: 0n }],
    ["0a02080012021200", { case: "clear", value: {} }],
  ] as const) {
    const bytes = new Uint8Array(Buffer.from(hex, "hex"))
    const value = create(remote_session_autonomy_set_Request_payloadSchema, {
      yolo: { kind: { case: "value1", value: 0n } },
      maxNoProgress: { kind: budget },
    })
    expect(encodeStrict(remote_session_autonomy_set_Request_payloadSchema, value)).toEqual(bytes)
    expect(
      encodeStrict(
        remote_session_autonomy_set_Request_payloadSchema,
        decodeStrict(remote_session_autonomy_set_Request_payloadSchema, bytes),
      ),
    ).toEqual(bytes)
  }
  const value = create(remote_session_autonomy_set_Request_payloadSchema, {
    yolo: { kind: { case: "value2", value: false } },
  })
  expect(encodeStrict(remote_session_autonomy_set_Request_payloadSchema, value)).toEqual(new Uint8Array([10, 2, 16, 0]))
  value.maxNoProgress = {
    $typeName: "ycoding.v5.remote_session_autonomy_set_Request_payload_maxNoProgress",
    kind: { case: "value1", value: 1001n },
  }
  expect(() => encodeStrict(remote_session_autonomy_set_Request_payloadSchema, value)).toThrow("integer constraint")
  expect(() => decodeStrict(remote_session_goal_set_Request_payloadSchema, new Uint8Array([8, 1]))).toThrow("wire type")
})

test("Rust/TS distinct file matches retain URI and kind rather than local filesystem envelopes", () => {
  const bytes = new Uint8Array(Buffer.from("0a160a140a030a0178120b0a0966696c653a2f2f2f781801", "hex"))
  const value = create(Connector_FileFindSchema, {
    files: { items: [{ path: encodeLossless("x"), uri: encodeLossless("file:///x"), kind: 1 }] },
  })
  expect(encodeStrict(Connector_FileFindSchema, value)).toEqual(bytes)
  const decoded = decodeStrict(Connector_FileFindSchema, bytes)
  expect(decodeLossless(decoded.files!.items[0]!.uri!)).toBe("file:///x")
  expect(decoded.files!.items[0]!.kind).toBe(1)
  const request = create(remote_session_fs_find_Request_payloadSchema, { query: encodeLossless("x"), limit: 50n })
  expect(() => encodeStrict(remote_session_fs_find_Request_payloadSchema, request)).not.toThrow()
  request.limit = 51n
  expect(() => encodeStrict(remote_session_fs_find_Request_payloadSchema, request)).toThrow("integer constraint")
})

test("family activity preserves the producer's 80-code-point boundary rather than an 80-unit boundary", () => {
  const value = create(session_family_activity_Result_dataItem_activitySchema, {
    kind: 1,
    room: 1,
    text: encodeLossless("😀".repeat(80)),
  })
  expect(() => encodeStrict(session_family_activity_Result_dataItem_activitySchema, value)).not.toThrow()
  value.text = encodeLossless("😀".repeat(81))
  expect(() => encodeStrict(session_family_activity_Result_dataItem_activitySchema, value)).toThrow("text constraint")
})

test("Rust/TS bare remote form arrays and auth result markers keep distinct logical shapes", () => {
  expect(
    encodeStrict(remote_session_form_list_ResultSchema, create(remote_session_form_list_ResultSchema, { items: [] })),
  ).toEqual(new Uint8Array())
  expect(decodeStrict(remote_session_form_list_ResultSchema, new Uint8Array()).items).toEqual([])
  expect(() => decodeStrict(session_form_list_ResultSchema, new Uint8Array())).toThrow("required presence")
  for (const schema of [remote_provider_auth_key_ResultSchema, remote_provider_auth_complete_ResultSchema]) {
    const bytes = new Uint8Array([10, 2, 8, 1])
    expect(encodeStrict(schema, decodeStrict(schema, bytes))).toEqual(bytes)
    expect(() => decodeStrict(schema, new Uint8Array([10, 0]))).toThrow("required presence")
  }
})

test("Rust/TS notice pages reuse foundation Notice while mutation settlement remains no-content", () => {
  const bytes = new Uint8Array([10, 4, 10, 2, 16, 0, 24, 0])
  const value = create(ConnectorNoticePageSchema, {
    notice: { kind: { case: "added", value: { notices: [], total: 0n } } },
    unavailable: false,
  })
  expect(encodeStrict(ConnectorNoticePageSchema, value)).toEqual(bytes)
  expect(encodeStrict(ConnectorNoticePageSchema, decodeStrict(ConnectorNoticePageSchema, bytes))).toEqual(bytes)
  expect(encodeStrict(ConnectorNoticeSettlementSchema, create(ConnectorNoticeSettlementSchema, { data: {} }))).toEqual(
    new Uint8Array([10, 0]),
  )
  expect(() => encodeStrict(ConnectorNoticeIDsSchema, create(ConnectorNoticeIDsSchema, { ids: [] }))).toThrow(
    "count constraint",
  )
  expect(() =>
    encodeStrict(
      ConnectorNoticeIDsSchema,
      create(ConnectorNoticeIDsSchema, { ids: Array.from({ length: 101 }, (_, index) => `ntc_${index + 1}`) }),
    ),
  ).toThrow("collection limit")
})

test("remote bindings expose the same closed generated per-role operation allowlists", () => {
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toHaveLength(74)
  expect(operationIDsByRole[PeerRole.RELAY]).toHaveLength(70)
  expect(operationIDsByRole[PeerRole.AGENT]).toEqual([])
  expect(operationIDsByRole[PeerRole.SERVER]).toEqual([])
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toEqual(
    operations
      .filter((operation) => operation.roles.includes(PeerRole.REMOTE_CLIENT))
      .map((operation) => operation.operationId),
  )
})
