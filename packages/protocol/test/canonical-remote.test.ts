import { expect, test } from "bun:test"
import {
  MutationClass,
  operations,
  Paging,
  PeerRole,
  ScopeKind,
  Sensitivity,
  Settlement,
  Streaming,
} from "../src/generated/v5/index.js"
import { connectorOperations, noticeOperations, relayOperations } from "./connector-source.js"
import { messages } from "../src/generated/v5/contract.js"

test("REQ-WIRE-001/006 canonical replacements are shared and preserve local IDs without remote split descriptors", () => {
  expect(
    operations.filter((operation) => operation.diagnosticName.startsWith("remote.") && operation.operationId >= 5000),
  ).toEqual([])
  for (const [name, id] of Object.entries({
    "event.subscribe": 4000,
    "event.unsubscribe": 4001,
    "fs.find": 3013,
    "session.autonomy.set": 4012,
    "shell.output": 3043,
    "providerUsage.list": 2055,
    "usage.get": 2058,
    "keepAwake.get": 3025,
    "keepAwake.set": 3026,
    "telemetry.consent.get": 3047,
    "telemetry.consent.set": 3048,
    "telemetry.append": 3046,
    "telemetry.list": 3049,
    "session.message": 4040,
    "session.guardrail.request.reply": 4032,
  })) {
    const operation = operations.find((item) => item.diagnosticName === name)!
    expect(operation.operationId, name).toBe(id)
    expect(operation.roles, name).toEqual([PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY])
  }
  const canonical = new Set<string>(Object.values(connectorOperations).map(([, name]) => name))
  expect(canonical.size).toBe(83)
  expect(operations.filter((operation) => operation.roles.includes(PeerRole.RELAY))).toHaveLength(84)
  expect(operations.filter((operation) => operation.roles.includes(PeerRole.REMOTE_CLIENT))).toHaveLength(87)
  expect(operations.find((operation) => operation.diagnosticName === "catalog.get")!.operationId).toBe(5043)
  for (const [, [id]] of Object.entries(noticeOperations))
    expect(operations.find((operation) => operation.operationId === id)!.roles).toEqual([PeerRole.REMOTE_CLIENT])
  for (const [, [id, name]] of Object.entries(relayOperations))
    expect(operations.find((operation) => operation.operationId === id)).toMatchObject({
      diagnosticName: name,
      roles: [PeerRole.RELAY],
    })
  const relayOnly = new Set<string>(Object.values(relayOperations).map(([, name]) => name))
  for (const operation of operations.filter((item) => item.roles.includes(PeerRole.RELAY)))
    expect(canonical.has(operation.diagnosticName) !== relayOnly.has(operation.diagnosticName), operation.diagnosticName).toBe(true)
})

test.each([
  ["local.app.register", 5047, MutationClass.MUTATION],
  ["local.app.list", 5048, MutationClass.READ],
  ["local.app.revoke", 5049, MutationClass.MUTATION],
  ["local.app.open", 5050, MutationClass.MUTATION],
  ["local.app.status", 5051, MutationClass.READ],
  ["local.app.http", 5052, MutationClass.MUTATION],
] as const)("%s remains a secret Session operation for remote and relay peers only", (name, id, mutation) => {
  expect(operations.find((operation) => operation.operationId === id)).toMatchObject({
    diagnosticName: name,
    roles: [PeerRole.REMOTE_CLIENT, PeerRole.RELAY],
    scope: ScopeKind.SESSION,
    mutation,
    settlement: Settlement.COMPLETED,
    paging: Paging.UNPAGED,
    streaming: Streaming.TYPED_BULK,
    sensitivity: Sensitivity.SECRET,
    errorTypes: ["ycoding.v5.Connector_Error"],
    roleScopes: [],
    eventTypes: [],
  })
})

test("REQ-WIRE-006 remote scopes are backend-resolved and cannot carry arbitrary Locations or global event feeds", () => {
  for (const name of [
    "event.subscribe",
    "event.unsubscribe",
    "shell.output",
    "fs.find",
    "catalog.get",
    "session.create",
  ]) {
    const operation = operations.find((item) => item.diagnosticName === name)!
    const remote = operation.roleScopes.find((item) => item.role === PeerRole.REMOTE_CLIENT)!
    expect(remote.scopes, name).not.toContain(ScopeKind.LOCATION)
    expect(remote.scopes, name).not.toContain(ScopeKind.GLOBAL)
    expect(operation.roleScopes.find((item) => item.role === PeerRole.RELAY)!.scopes).toEqual(remote.scopes)
  }
  expect(operations.find((item) => item.diagnosticName === "event.subscribe")!.roleScopes[0].scopes).toEqual([
    ScopeKind.SESSION,
  ])
  expect(operations.find((item) => item.diagnosticName === "fs.find")!.roleScopes[0].scopes).toEqual([
    ScopeKind.SESSION,
    ScopeKind.WORKSPACE,
  ])
})

test("REQ-WIRE-012 attachments are raw bytes and full messages use the canonical typed bulk result", () => {
  const upload = operations.find((item) => item.diagnosticName === "session.attachment.upload")!
  expect(upload.operationId).toBe(5023)
  const piece = messages["ycoding.v5.session_attachment_upload_Request_payload"].fields
  expect(piece.find((field) => field.name === "data")).toMatchObject({ tag: 4, type: 12, required: true })
  expect(piece.find((field) => field.name === "offset")).toMatchObject({ tag: 5, required: true })
  expect(operations.find((item) => item.diagnosticName === "session.attachment.read")!.streaming).toBe(
    Streaming.ASSET_BULK,
  )
  expect(messages["ycoding.v5.SessionAssetMetadata"].fields.map((field) => field.name)).toEqual(["mime", "bytes"])
  expect(operations.find((item) => item.diagnosticName === "session.message")!.streaming).toBe(Streaming.TYPED_BULK)
})
