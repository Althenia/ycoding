import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  decodeLossless,
  SessionAutonomySetSchema,
  SessionAutonomySetValue1_goalSchema,
  fs_find_Request_querySchema,
  fs_find_ResultSchema,
  session_family_activity_Result_dataItem_activitySchema,
  session_form_list_ResultSchema,
  ConnectorNoticePageSchema,
  ConnectorNoticeSettlementSchema,
  ConnectorNoticeIDsSchema,
  provider_auth_key_ResultSchema,
  provider_auth_complete_ResultSchema,
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
    const scopes = descriptor.roleScopes.find((rule) => rule.role === PeerRole.REMOTE_CLIENT)?.scopes ?? [
      descriptor.scope,
    ]
    if (requireSession(source))
      expect(scopes.some((scope) => [ScopeKind.SESSION, ScopeKind.FORM].includes(scope))).toBe(true)
    if (!requireSession(source))
      expect(scopes.some((scope) => [ScopeKind.MACHINE, ScopeKind.WORKSPACE, ScopeKind.GLOBAL].includes(scope))).toBe(
        true,
      )
  }
})

test("every generated connector mutation class equals the live ordered-lane classification", () => {
  const actual = operations.filter((item) => item.roles.includes(PeerRole.RELAY))
  expect(actual).toHaveLength(66)
  for (const operation of remoteOperations) {
    const [id] = connectorOperations[operation]
    expect(operations.find((item) => item.operationId === id)?.mutation, operation).toBe(
      remoteOperationAccess[operation] === "read" ? MutationClass.READ : MutationClass.MUTATION,
    )
  }
})

test("Rust/TS remote goal start, resume and stop use the shared autonomy branches", () => {
  for (const kind of [
    { case: "value1", value: encodeLossless("finish") },
    { case: "value2", value: true },
    { case: "clear", value: {} },
  ] as const) {
    const value = create(SessionAutonomySetSchema, {
      kind: { case: "value1", value: { goal: { kind }, maxNoProgress: 1n } },
    })
    const bytes = encodeStrict(SessionAutonomySetSchema, value)
    expect(encodeStrict(SessionAutonomySetSchema, decodeStrict(SessionAutonomySetSchema, bytes))).toEqual(bytes)
  }
  expect(() => decodeStrict(SessionAutonomySetValue1_goalSchema, new Uint8Array([16, 1, 26, 0]))).toThrow(
    "duplicate oneof",
  )
  expect(operations.find((item) => item.diagnosticName === "session.autonomy.set")!.operationId).toBe(4012)
})

test("Rust/TS canonical file matches retain URI and file type without remote Location leakage", () => {
  const bytes = new Uint8Array(Buffer.from("12160a140a030a017810011a0b0a0966696c653a2f2f2f78", "hex"))
  const value = create(fs_find_ResultSchema, {
    data: { items: [{ path: encodeLossless("x"), uri: encodeLossless("file:///x"), type: 1 }] },
  })
  expect(encodeStrict(fs_find_ResultSchema, value)).toEqual(bytes)
  const decoded = decodeStrict(fs_find_ResultSchema, bytes)
  expect(decodeLossless(decoded.data!.items[0]!.uri!)).toBe("file:///x")
  expect(decoded.data!.items[0]!.type).toBe(1)
  expect(decoded.location).toBeUndefined()
  const request = create(fs_find_Request_querySchema, { query: encodeLossless("x"), limit: 50n })
  expect(() => encodeStrict(fs_find_Request_querySchema, request)).not.toThrow()
  request.limit = 0n
  expect(() => encodeStrict(fs_find_Request_querySchema, request)).toThrow("integer constraint")
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

test("Rust/TS remote form arrays use the shared result while derived auth retains result markers", () => {
  const form = create(session_form_list_ResultSchema, { data: { items: [] } })
  expect(encodeStrict(session_form_list_ResultSchema, form)).toEqual(new Uint8Array([10, 0]))
  expect(decodeStrict(session_form_list_ResultSchema, new Uint8Array([10, 0])).data?.items).toEqual([])
  expect(() => decodeStrict(session_form_list_ResultSchema, new Uint8Array())).toThrow("required presence")
  for (const schema of [provider_auth_key_ResultSchema, provider_auth_complete_ResultSchema]) {
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
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toHaveLength(70)
  expect(operationIDsByRole[PeerRole.RELAY]).toHaveLength(66)
  expect(operationIDsByRole[PeerRole.AGENT]).toEqual([])
  expect(operationIDsByRole[PeerRole.SERVER]).toEqual([])
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toEqual(
    operations
      .filter((operation) => operation.roles.includes(PeerRole.REMOTE_CLIENT))
      .map((operation) => operation.operationId),
  )
})
