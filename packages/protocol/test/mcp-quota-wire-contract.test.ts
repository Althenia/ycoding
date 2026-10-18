import { expect, test } from "bun:test"
import { getOption, hasOption } from "@bufbuild/protobuf"
import type { DescExtension, DescMessage } from "@bufbuild/protobuf"
import { messages } from "../src/generated/v5/contract.js"
import {
  CodePointLimit,
  FieldTextPolicy,
  LedgerClass,
  MutationClass,
  Paging,
  PeerRole,
  ScopeKind,
  SenderMask,
  Sensitivity,
  Settlement,
  Streaming,
  WireConnection,
  create,
  encodeLossless,
  encodeStrict,
  operationIDsByRole,
  operations,
  publicEvents,
  schemas,
  toBinary,
} from "../src/v5/index.js"

type Rule = {
  tag: number
  name: string
  type: number
  required: boolean
  repeated: boolean
  target?: string
  maxCodepoints?: number
  textPolicy?: number
  constraints?: Record<string, unknown>
}
const rules: Readonly<Record<string, { oneofs: number; fields: readonly Rule[] }>> = messages
const shape = (name: string) =>
  rules[`ycoding.v5.${name}`]?.fields.map((field) => [
    field.tag,
    field.name,
    field.type,
    field.required,
    field.repeated,
    field.target || undefined,
    field.constraints ?? {},
  ])
const schema = (name: string) => {
  const found = schemas.find((item) => item.typeName === `ycoding.v5.${name}`)
  if (!found) throw new Error(`missing schema ${name}`)
  return found
}
const STRING = 9
const MESSAGE = 11
const BOOL = 8
const ENUM = 14
const UINT32 = 13
const UINT64 = 4
const DOUBLE = 1
const LOSSLESS = "ycoding.v5.LosslessString"
const option = (name: string) => {
  const found = schema("OperationOptions").file.extensions.find((item: DescExtension) => item.name === name)
  if (!found) throw new Error(`missing option ${name}`)
  return found
}
const operation = (id: number) => operations.find((item) => item.operationId === id)

test("operation inventory adds two local relay-MCP controls and one relay-only raw MCP request by identity", () => {
  expect(operations).toHaveLength(242)
  expect(
    [3053, 3054, 3055].map((id) => [operation(id)?.diagnosticName, operation(id)?.roles, operation(id)?.scope]),
  ).toEqual([
    ["remote.enroll", [PeerRole.LOCAL_CLIENT], ScopeKind.MACHINE],
    ["remote.mcp.get", [PeerRole.LOCAL_CLIENT], ScopeKind.MACHINE],
    ["remote.mcp.set", [PeerRole.LOCAL_CLIENT], ScopeKind.MACHINE],
  ])
  expect([operation(3054)?.mutation, operation(3055)?.mutation]).toEqual([MutationClass.READ, MutationClass.MUTATION])
  expect([operation(3054)?.requestType, operation(3054)?.resultType]).toEqual([
    "ycoding.v5.remote_mcp_get_Request",
    "ycoding.v5.remote_mcp_get_Result",
  ])
  expect([operation(3055)?.requestType, operation(3055)?.resultType]).toEqual([
    "ycoding.v5.remote_mcp_set_Request",
    "ycoding.v5.remote_mcp_set_Result",
  ])
  const mcp = operation(5044)
  expect(mcp && {
    name: mcp.diagnosticName,
    roles: mcp.roles,
    scope: mcp.scope,
    mutation: mcp.mutation,
    settlement: mcp.settlement,
    paging: mcp.paging,
    streaming: mcp.streaming,
    sensitivity: mcp.sensitivity,
    request: mcp.requestType,
    result: mcp.resultType,
    errors: mcp.errorTypes,
    roleScopes: mcp.roleScopes,
    events: mcp.eventTypes,
  }).toEqual({
    name: "mcp.request",
    roles: [PeerRole.RELAY],
    scope: ScopeKind.MACHINE,
    mutation: MutationClass.MUTATION,
    settlement: Settlement.COMPLETED,
    paging: Paging.UNPAGED,
    streaming: Streaming.TYPED_BULK,
    sensitivity: Sensitivity.SECRET,
    request: "ycoding.v5.mcp_request_Request",
    result: "ycoding.v5.mcp_request_Result",
    errors: ["ycoding.v5.Connector_Error"],
    roleScopes: [],
    events: [],
  })
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toHaveLength(87)
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).not.toContain(5044)
  expect(operationIDsByRole[PeerRole.RELAY]).toHaveLength(84)
  expect(operationIDsByRole[PeerRole.RELAY]).toContain(5044)
  expect(operationIDsByRole[PeerRole.LOCAL_CLIENT]).toEqual(expect.arrayContaining([3053, 3054, 3055]))
  expect(operationIDsByRole[PeerRole.LOCAL_CLIENT]).not.toContain(5044)
  expect([operationIDsByRole[PeerRole.AGENT], operationIDsByRole[PeerRole.SERVER]]).toEqual([[], []])
  expect([operation(2067)?.diagnosticName, operation(2067)?.roles]).toEqual([
    "incident.guidance.clear",
    [PeerRole.LOCAL_CLIENT],
  ])
})

test("raw MCP request and response messages bound headers, principal, epoch and bodies", () => {
  expect(shape("mcp_request_Request")).toEqual([[1, "payload", MESSAGE, true, false, "ycoding.v5.Connector_McpRequest", {}]])
  expect(shape("Connector_McpRequest")).toEqual([
    [1, "body", MESSAGE, true, false, LOSSLESS, { utf16Min: 1, utf16Max: 32768 }],
    [2, "headers", MESSAGE, false, true, "ycoding.v5.Connector_McpHeader", { countMax: 5 }],
    [3, "principal", MESSAGE, true, false, "ycoding.v5.Connector_McpPrincipal", {}],
    [4, "epoch", STRING, true, false, undefined, { utf16Min: 1, utf16Max: 64 }],
  ])
  expect(shape("Connector_McpHeader")).toEqual([
    [1, "name", STRING, true, false, undefined, { utf16Min: 1, utf16Max: 64 }],
    [2, "value", MESSAGE, true, false, LOSSLESS, { utf16Max: 1024 }],
  ])
  expect(shape("Connector_McpPrincipal")).toEqual([
    [1, "ownerID", STRING, true, false, undefined, { utf16Min: 1, utf16Max: 64 }],
    [2, "deviceID", STRING, true, false, undefined, { utf16Min: 1, utf16Max: 64 }],
    [3, "clientID", MESSAGE, true, false, LOSSLESS, { utf16Min: 1, utf16Max: 2048 }],
  ])
  expect(shape("mcp_request_Result")).toEqual([[1, "data", MESSAGE, true, false, "ycoding.v5.Connector_McpResponse", {}]])
  expect(shape("Connector_McpResponse")).toEqual([
    [1, "status", UINT32, true, false, undefined, { integerMin: "200", integerMax: "599" }],
    [2, "contentType", STRING, true, false, undefined, { utf16Min: 1, utf16Max: 256 }],
    [3, "body", MESSAGE, true, false, LOSSLESS, { utf16Max: 2097152 }],
  ])
  const request = (headers: number, body: string) =>
    create(schema("Connector_McpRequest"), {
      body: encodeLossless(body),
      headers: Array.from({ length: headers }, () => ({ name: "accept", value: encodeLossless("application/json") })),
      principal: { ownerID: "owner", deviceID: "device", clientID: encodeLossless("https://client.example/metadata") },
      epoch: "epoch",
    })
  expect(() => encodeStrict(schema("Connector_McpRequest"), request(5, "{}"))).not.toThrow()
  expect(() => encodeStrict(schema("Connector_McpRequest"), request(6, "{}"))).toThrow()
  expect(() => encodeStrict(schema("Connector_McpRequest"), request(1, ""))).toThrow("text constraint")
  expect(() => encodeStrict(schema("Connector_McpRequest"), request(1, "x".repeat(32769)))).toThrow("text constraint")
})

test("relay MCP local controls reuse the remote connection state vocabulary", () => {
  expect(shape("remote_mcp_get_Request")).toEqual([])
  expect(shape("remote_mcp_get_Result")).toEqual([[1, "data", MESSAGE, true, false, "ycoding.v5.RemoteMcpStatus", {}]])
  expect(shape("remote_mcp_set_Request")).toEqual([
    [1, "payload", MESSAGE, true, false, "ycoding.v5.remote_mcp_set_Request_payload", {}],
  ])
  expect(shape("remote_mcp_set_Request_payload")).toEqual([[1, "enabled", BOOL, true, false, undefined, {}]])
  expect(shape("remote_mcp_set_Result")).toEqual(shape("remote_mcp_get_Result"))
  expect(shape("RemoteMcpStatus")).toEqual([
    [1, "state", ENUM, true, false, "ycoding.v5.remote_get_Result_data_state", {}],
    [2, "message", MESSAGE, false, false, LOSSLESS, {}],
    [3, "url", MESSAGE, false, false, LOSSLESS, {}],
  ])
  for (const id of [3054, 3055])
    expect(operation(id)?.errorTypes).toEqual(["ycoding.v5.UnauthorizedError", "ycoding.v5.InvalidRequestError"])
  const state = schema("RemoteMcpStatus").fields.find((field) => field.name === "state")
  expect(
    state?.fieldKind === "enum"
      ? state.enum.values.map((value) => [value.number, getOption(value, option("domain_label"))])
      : [],
  ).toEqual([
    [1, "off"],
    [2, "connecting"],
    [3, "on"],
    [4, "error"],
  ])
})

test("foundation controls carry relay MCP state and quota pace with fixed sender directions", () => {
  const field = (message: string, tag: number) => {
    const item = schema(message).fields.find((field) => field.number === tag)
    return item && [item.localName, item.fieldKind === "message" ? item.message.typeName : undefined]
  }
  expect([14, 15, 16, 17].map((tag) => field("Control", tag))).toEqual([
    ["mcpState", "ycoding.v5.McpState"],
    ["mcpStateAck", "ycoding.v5.McpStateAck"],
    ["quotaPace", "ycoding.v5.QuotaPace"],
    ["quotaPaceResult", "ycoding.v5.QuotaPaceResult"],
  ])
  expect(field("Notice", 7)).toEqual(["quotaPace", "ycoding.v5.QuotaPaceNotice"])
  expect(field("Presentation", 3)).toEqual(["quotaPace", "ycoding.v5.QuotaPace"])
  expect(shape("McpState")).toEqual([
    [1, "id", STRING, true, false, undefined, {}],
    [2, "enabled", BOOL, true, false, undefined, {}],
    [3, "epoch", STRING, true, false, undefined, {}],
  ])
  expect(shape("McpStateAck")).toEqual(shape("McpState"))
  expect(
    rules["ycoding.v5.QuotaPace"]?.fields.map((field) => [
      field.tag,
      field.name,
      field.type,
      field.required,
      field.target || undefined,
      field.maxCodepoints,
      field.textPolicy,
    ]),
  ).toEqual([
    [1, "provider_id", MESSAGE, true, LOSSLESS, 64, 7],
    [2, "window_id", MESSAGE, true, LOSSLESS, 64, 7],
    [3, "milestone", ENUM, true, "ycoding.v5.QuotaPaceMilestone", undefined, undefined],
    [4, "reset_at", UINT64, true, undefined, undefined, undefined],
  ])
  expect(shape("QuotaPaceResult")).toEqual([
    [1, "quota", MESSAGE, true, false, "ycoding.v5.QuotaPace", {}],
    [2, "status", ENUM, true, false, "ycoding.v5.QuotaPaceStatus", {}],
  ])
  expect(shape("QuotaPaceNotice")).toEqual([
    [1, "quota", MESSAGE, true, false, "ycoding.v5.QuotaPace", {}],
    [2, "at", UINT64, true, false, undefined, {}],
  ])
  const sender = SenderMask as unknown as Record<string, number>
  expect(
    ["MCP_STATE_SENDERS", "MCP_STATE_ACK_SENDERS", "QUOTA_PACE_SENDERS", "QUOTA_PACE_RESULT_SENDERS"].map(
      (key) => sender[key],
    ),
  ).toEqual([8, 4, 8, 4])
  const limits = { ...(CodePointLimit as unknown as Record<string, number>), ...(FieldTextPolicy as unknown as Record<string, number>) }
  expect(
    [
      "QUOTA_PACE_PROVIDER_ID_MAX_CODEPOINTS",
      "QUOTA_PACE_WINDOW_ID_MAX_CODEPOINTS",
      "QUOTA_PACE_PROVIDER_ID_TEXT_POLICY",
      "QUOTA_PACE_WINDOW_ID_TEXT_POLICY",
    ].map((key) => limits[key]),
  ).toEqual([64, 64, 7, 7])
})

test("quota pace text is nonempty, trim-stable, control-free and at most 64 code points", () => {
  const pace = (providerId: string, windowId = "weekly") =>
    create(schema("QuotaPace"), {
      providerId: encodeLossless(providerId),
      windowId: encodeLossless(windowId),
      milestone: 1,
      resetAt: 1_800_000_000_000n,
    })
  expect(() => encodeStrict(schema("QuotaPace"), pace("anthropic"))).not.toThrow()
  expect(() => encodeStrict(schema("QuotaPace"), pace("😀".repeat(64)))).not.toThrow()
  for (const invalid of ["", " anthropic", "a".repeat(65), "a\u0000b", "a\u202eb"])
    expect(() => encodeStrict(schema("QuotaPace"), pace(invalid)), JSON.stringify(invalid)).toThrow("title constraint")
  expect(() => encodeStrict(schema("QuotaPace"), pace("anthropic", "w".repeat(65)))).toThrow("title constraint")
})

test("only the agent sends MCP state and quota pace; only the relay acknowledges and settles them", () => {
  const frame = (kind: { case: string; value: unknown }) =>
    toBinary(
      schema("Frame"),
      create(schema("Frame"), {
        revision: 5,
        connectionEpoch: "epoch",
        ledger: LedgerClass.NORMAL,
        deliveryOrdinal: 1n,
        body: { case: "control", value: create(schema("Control"), { kind }) },
      } as never),
    )
  const quota = { providerId: encodeLossless("openai"), windowId: encodeLossless("weekly"), milestone: 2, resetAt: 1n }
  const cases = [
    [{ case: "mcpState", value: { id: "state", enabled: true, epoch: "epoch" } }, PeerRole.AGENT],
    [{ case: "mcpStateAck", value: { id: "state", enabled: true, epoch: "epoch" } }, PeerRole.RELAY],
    [{ case: "quotaPace", value: quota }, PeerRole.AGENT],
    [{ case: "quotaPaceResult", value: { quota, status: 1 } }, PeerRole.RELAY],
  ] as const
  for (const [kind, allowed] of cases) {
    const forbidden = allowed === PeerRole.AGENT ? PeerRole.RELAY : PeerRole.AGENT
    expect(() => new WireConnection(PeerRole.AGENT, PeerRole.RELAY).observe(frame(kind), forbidden, 0), kind.case).toThrow(
      "direction",
    )
    expect(() => new WireConnection(PeerRole.AGENT, PeerRole.RELAY).observe(frame(kind), allowed, 0), kind.case).toThrow(
      "handshake order",
    )
  }
})

test("relay MCP state identifiers and quota pace instants are bounded before handshake ordering", () => {
  const frame = (kind: { case: string; value: unknown }) =>
    toBinary(
      schema("Frame"),
      create(schema("Frame"), {
        revision: 5,
        connectionEpoch: "epoch",
        ledger: LedgerClass.NORMAL,
        deliveryOrdinal: 1n,
        body: { case: "control", value: create(schema("Control"), { kind }) },
      } as never),
    )
  const quota = (resetAt: bigint) => ({
    providerId: encodeLossless("openai"),
    windowId: encodeLossless("weekly"),
    milestone: 1,
    resetAt,
  })
  const cases = [
    [{ case: "mcpState", value: { id: "A".repeat(64), enabled: true, epoch: "epoch_1-2" } }, PeerRole.AGENT, true],
    [{ case: "mcpState", value: { id: "", enabled: true, epoch: "e" } }, PeerRole.AGENT, false],
    [{ case: "mcpState", value: { id: "A".repeat(65), enabled: true, epoch: "e" } }, PeerRole.AGENT, false],
    [{ case: "mcpStateAck", value: { id: "s", enabled: false, epoch: "e.1" } }, PeerRole.RELAY, false],
    [{ case: "quotaPace", value: quota(9_007_199_254_740_991n) }, PeerRole.AGENT, true],
    [{ case: "quotaPace", value: quota(0n) }, PeerRole.AGENT, false],
    [{ case: "quotaPace", value: quota(9_007_199_254_740_992n) }, PeerRole.AGENT, false],
    [{ case: "quotaPaceResult", value: { quota: quota(0n), status: 1 } }, PeerRole.RELAY, false],
  ] as const
  for (const [kind, sender, valid] of cases)
    expect(() => new WireConnection(PeerRole.AGENT, PeerRole.RELAY).observe(frame(kind), sender, 0), kind.case).toThrow(
      valid ? "handshake order" : "control bounds",
    )
})

test("every domain enum value carries its canonical label and literal branches carry JSON literals", () => {
  const unlabeled = schemas
    .filter((item) => !["ycoding/v5/foundation.proto", "ycoding/v5/operations.proto"].includes(item.file.proto.name ?? ""))
    .flatMap((item) =>
      item.fields.flatMap((field) =>
        field.fieldKind === "enum" || (field.fieldKind === "list" && field.listKind === "enum")
          ? field.enum.values.filter((value) => !hasOption(value, option("domain_label"))).map((value) => value.name)
          : [],
      ),
    )
  expect(unlabeled).toEqual([])
  const labels = (message: string, name: string) => {
    const item = schema(message).fields.find((field) => field.name === name)
    return item?.fieldKind === "enum" ? item.enum.values.map((value) => getOption(value, option("domain_label"))) : undefined
  }
  expect(labels("UsageForecast_Pace", "verdict")).toEqual(["ahead", "cutting-it-close", "will-run-out"])
  expect(labels("PublicEvent_provider_quota_pace_data", "milestone")).toEqual([
    "almost-out",
    "cutting-it-close",
    "will-run-out",
  ])
  expect(labels("Connector_Error", "code")?.slice(0, 2)).toEqual(["invalid_message", "message_too_large"])
  expect(labels("PublicEvent_todo_updated", "type")).toEqual(["todo.updated"])
  const literals = (schemas as readonly DescMessage[])
    .flatMap((item) =>
      item.fields
        .filter((field) => hasOption(field, option("domain_literal")))
        .map((field) => [item.typeName, field.name, getOption(field, option("domain_literal"))]),
    )
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  expect(literals).toEqual([
    ["ycoding.v5.Mcp_RemoteConfig_oauth", "value_2", "false"],
    ["ycoding.v5.SessionAutonomySetValue1_goal", "value_2", "true"],
  ])
})

test("forecast quotas append an optional pace verdict and the quota pace event is ephemeral", () => {
  expect(shape("UsageForecast_Quota")?.at(-1)).toEqual([
    17,
    "pace",
    MESSAGE,
    false,
    false,
    "ycoding.v5.UsageForecast_Pace",
    {},
  ])
  expect(shape("UsageForecast_Pace")?.map((field) => field.slice(0, 6))).toEqual([
    [1, "verdict", ENUM, true, false, "ycoding.v5.UsageForecast_Pace_verdict"],
    [2, "projectedUsedAtReset", DOUBLE, true, false, undefined],
    [3, "exhaustionAt", UINT64, false, false, undefined],
  ])
  expect(publicEvents.find((event) => event.name === "provider.quota.pace")).toEqual({
    name: "provider.quota.pace",
    durable: false,
    tag: 117,
    type: "ycoding.v5.PublicEvent_provider_quota_pace",
  })
  expect(rules["ycoding.v5.PublicEvent_provider_quota_pace_data"]?.fields.map((field) => field.name)).toEqual([
    "providerID",
    "windowID",
    "milestone",
    "resetAt",
    "title",
    "body",
  ])
})
