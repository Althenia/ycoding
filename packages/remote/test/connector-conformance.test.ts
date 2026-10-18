import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  toBinary,
  encodeLossless,
  decodeLossless,
  SessionAutonomySetSchema,
  SessionAutonomySetValue1_goalSchema,
  fs_find_Request_querySchema,
  fs_find_ResultSchema,
  session_family_activity_Result_dataItem_activitySchema,
  session_form_list_ResultSchema,
  session_team_shell_list_Result_dataItemSchema,
  session_status_ResultSchema,
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
import { remoteDescriptors, relayDescriptors } from "../src/index.ts"
import { connectorOperations, noticeOperations } from "../../protocol/test/connector-source.js"

test("remote membership equals the frozen connector and relay notice operation IDs without runtime aliases", () => {
  const ids = [
    ...new Set([...Object.values(connectorOperations), ...Object.values(noticeOperations)].map(([id]) => id)),
  ].sort((a, b) => a - b)
  expect(remoteDescriptors.map((item) => item.operationId).sort((a, b) => a - b)).toEqual(ids)
  expect(new Set(remoteDescriptors.map((item) => item.diagnosticName)).size).toBe(remoteDescriptors.length)
})

test("session requirement and workspace placement use existing scope metadata", () => {
  expect(remoteDescriptors.find((item) => item.diagnosticName === "session.prompt")!.scope).toBe(ScopeKind.SESSION)
  expect(
    remoteDescriptors
      .find((item) => item.diagnosticName === "fs.find")!
      .roleScopes.find((rule) => rule.role === PeerRole.REMOTE_CLIENT)!.scopes,
  ).toEqual([ScopeKind.SESSION, ScopeKind.WORKSPACE])
  expect(
    remoteDescriptors.filter((item) => item.diagnosticName.startsWith("notice.")).map((item) => item.scope),
  ).toEqual([ScopeKind.MACHINE, ScopeKind.MACHINE, ScopeKind.MACHINE, ScopeKind.MACHINE])
})

test("relay descriptors are the canonical ordered-lane authority and exclude relay-owned notices", () => {
  expect(relayDescriptors).toHaveLength(84)
  expect(
    relayDescriptors
      .filter((item) => !item.roles.includes(PeerRole.REMOTE_CLIENT))
      .map((item) => [item.operationId, item.diagnosticName, item.roles, item.scope]),
  ).toEqual([[5044, "mcp.request", [PeerRole.RELAY], ScopeKind.MACHINE]])
  expect(relayDescriptors.every((item) => [MutationClass.READ, MutationClass.MUTATION].includes(item.mutation))).toBe(
    true,
  )
  expect(relayDescriptors.some((item) => item.diagnosticName.startsWith("notice."))).toBe(false)
  expect(relayDescriptors.find((item) => item.diagnosticName === "session.prompt")!.mutation).toBe(
    MutationClass.MUTATION,
  )
  expect(relayDescriptors.find((item) => item.diagnosticName === "session.get")!.mutation).toBe(MutationClass.READ)
})

test("Incident reads preserve role scopes while guidance clearing stays local-only", () => {
  const expected = [
    [2064, "incident.report", ScopeKind.MACHINE, []],
    [2065, "incident.recent", ScopeKind.MACHINE, []],
    [
      2066,
      "incident.guidance.get",
      ScopeKind.LOCATION,
      [
        [PeerRole.REMOTE_CLIENT, [ScopeKind.SESSION]],
        [PeerRole.RELAY, [ScopeKind.SESSION]],
      ],
    ],
  ]
  for (const descriptors of [remoteDescriptors, relayDescriptors]) {
    const incidents = descriptors.filter((item) => item.diagnosticName.startsWith("incident."))
    expect(
      incidents.map((item) => [
        item.operationId,
        item.diagnosticName,
        item.scope,
        item.roleScopes.map((rule) => [rule.role, rule.scopes]),
      ]),
    ).toEqual(expected)
    expect(incidents.every((item) => item.mutation === MutationClass.READ)).toBe(true)
  }
  const clear = operations.find((item) => item.diagnosticName === "incident.guidance.clear")!
  expect([clear.operationId, clear.roles, clear.scope, clear.mutation, clear.roleScopes]).toEqual([
    2067,
    [PeerRole.LOCAL_CLIENT],
    ScopeKind.LOCATION,
    MutationClass.MUTATION,
    [],
  ])
})

test("Session status preserves absent, empty and populated lost-only classification", () => {
  const schema = session_status_ResultSchema
  expect(schema.fields.map((field) => [field.number, field.name])).toEqual([
    [1, "running"],
    [2, "attention"],
    [3, "outstanding"],
    [4, "failed"],
    [5, "lost"],
  ])
  for (const lost of [undefined, { items: [] }, { items: [encodeLossless("ses_lost")] }]) {
    const value = create(schema, {
      running: { items: [] },
      attention: { items: [encodeLossless("ses_lost")] },
      lost,
    })
    const decoded = decodeStrict(schema, encodeStrict(schema, value))
    expect(decoded).toEqual(value)
    expect(decoded.failed).toBeUndefined()
    expect(decoded.outstanding).toBeUndefined()
  }
})

test("team shell metadata preserves process fields and retires scheduler fields", () => {
  const schema = session_team_shell_list_Result_dataItemSchema
  expect(schema.fields.map((field) => [field.number, field.name])).toEqual([
    [1, "id"],
    [2, "ownerID"],
    [3, "command"],
    [4, "status"],
    [5, "startedAt"],
    [6, "completedAt"],
  ])
  expect(schema.proto.reservedRange.map(({ start, end }) => ({ start, end }))).toContainEqual({ start: 7, end: 8 })
  expect(schema.proto.reservedName).toContain("queuePosition")
  const value = create(schema, {
    id: encodeLossless("sh_child"),
    ownerID: encodeLossless("ses_child"),
    command: encodeLossless("echo ready"),
    status: encodeLossless("running"),
    startedAt: 0,
  })
  expect(decodeStrict(schema, encodeStrict(schema, value))).toEqual(value)
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
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toHaveLength(87)
  expect(operationIDsByRole[PeerRole.RELAY]).toHaveLength(84)
  expect(operationIDsByRole[PeerRole.RELAY]).toContain(5044)
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).not.toContain(5044)
  expect(operationIDsByRole[PeerRole.AGENT]).toEqual([])
  expect(operationIDsByRole[PeerRole.SERVER]).toEqual([])
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toEqual(
    operations
      .filter((operation) => operation.roles.includes(PeerRole.REMOTE_CLIENT))
      .map((operation) => operation.operationId),
  )
})
