import { expect, test } from "bun:test"
import {
  operations,
  operationIDsByRole,
  PeerRole,
  MutationClass,
  ScopeKind,
  Settlement,
  Paging,
  Streaming,
  Sensitivity,
} from "../src/generated/v5/index.js"
import { connectorOperations, noticeOperations, relayOperations } from "./connector-source.js"
import { connectorContract, connectorProto, connectorFieldConstraints } from "./connector-contract.js"
import { messages } from "../src/generated/v5/contract.js"
import type { Constraints } from "../src/v5/constraints.js"
import path from "node:path"

test("fixed demo operations have empty machine reads and closed typed results", () => {
  for (const [id, name] of [
    [5045, "artifact.demo.preview"],
    [5046, "artifact.demo.export"],
  ] as const) {
    const descriptor = operations.find((item) => item.operationId === id)!
    expect(descriptor.diagnosticName).toBe(name)
    expect(descriptor.roles).toEqual([PeerRole.REMOTE_CLIENT, PeerRole.RELAY])
    expect(descriptor.mutation).toBe(MutationClass.READ)
    expect(descriptor.scope).toBe(ScopeKind.MACHINE)
    expect(descriptor.settlement).toBe(Settlement.COMPLETED)
    expect(descriptor.paging).toBe(Paging.UNPAGED)
    expect(descriptor.streaming).toBe(Streaming.TYPED_BULK)
    expect(descriptor.sensitivity).toBe(Sensitivity.PRIVATE)
    expect(descriptor.errorTypes).toEqual(["ycoding.v5.Connector_Error"])
    expect(Object.entries(messages).find(([name]) => name === descriptor.requestType)?.[1].fields).toEqual([])
  }
  expect(messages["ycoding.v5.artifact_demo_preview_Result"]!.fields.map((field) => field.name)).toEqual([
    "variants",
    "hostVerification",
  ])
  expect(messages["ycoding.v5.artifact_demo_export_Result"]!.fields.map((field) => field.name)).toEqual([
    "id",
    "filename",
    "mime",
    "size",
    "sha256",
    "expiresAt",
    "delivery",
  ])
  expect(messages["ycoding.v5.Connector_McpRequest"]!.fields[0]!.constraints).toEqual({ utf16Min: 1, utf16Max: 32768 })
})

test("87 live source names resolve to 83 canonical connector and four relay notice operations", () => {
  const expected = [
    ...new Map(
      [...Object.values(connectorOperations), ...Object.values(noticeOperations)].map((item) => [item[0], item]),
    ).values(),
  ]
  expect(expected).toHaveLength(87)
  expect(new Set(expected.map(([id]) => id)).size).toBe(87)
  const actual = operations.filter((item) => item.roles.includes(PeerRole.REMOTE_CLIENT))
  expect(actual).toHaveLength(87)
  expect(actual.map((item) => [item.operationId, item.diagnosticName]).sort()).toEqual(
    expected.map(([id, name]) => [id, name]).sort(),
  )
  for (const [id, name, , mutation] of expected)
    expect(operations.find((item) => item.operationId === id)?.mutation, name).toBe(MutationClass[mutation])
})

test("generated per-role allowlists equal descriptor roles including empty agent and server sets", () => {
  for (const role of [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY, PeerRole.AGENT, PeerRole.SERVER])
    expect(operationIDsByRole[role]).toEqual(
      operations.filter((item) => item.roles.includes(role)).map((item) => item.operationId),
    )
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toHaveLength(87)
  expect(operationIDsByRole[PeerRole.RELAY]).toHaveLength(84)
})

test("descriptor role-scope and event payload metadata append fresh fields", () => {
  expect(messages["ycoding.v5.OperationDescriptor"].fields.map((field) => field.tag)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  ])
})

test("all connector fields, presence, associations and constraints match the bounded remote source projection", async () => {
  const contract = connectorContract()
  const actual: Readonly<
    Record<
      string,
      {
        oneofs: number
        fields: readonly {
          tag: number
          name: string
          required: boolean
          repeated: boolean
          type: number
          target?: string
          constraints?: Constraints
        }[]
      }
    >
  > = messages
  const primitives: Record<string, number> = { bool: 8, double: 1, int64: 3, uint64: 4, string: 9, bytes: 12 }
  for (const [name, message] of contract.messages) {
    if (!(name.startsWith("Connector") || contract.operations.some((item) => name.startsWith(item.rpc)))) continue
    expect(actual[`ycoding.v5.${name}`]?.oneofs, name).toBe(message.oneof ? 1 : 0)
    expect(
      actual[`ycoding.v5.${name}`]?.fields.map((field) => [field.tag, field.name, field.required, field.repeated]),
      name,
    ).toEqual(
      message.fields.map((field, index) => [
        index + 1,
        field.name,
        field.presence === "required",
        field.presence === "repeated",
      ]),
    )
    expect(
      actual[`ycoding.v5.${name}`]?.fields.map((field) => [field.type, field.target || undefined]),
      name,
    ).toEqual(
      message.fields.map((field) => [
        primitives[field.type] ?? (contract.enums.has(field.type) ? 14 : 11),
        primitives[field.type] ? undefined : `ycoding.v5.${field.type}`,
      ]),
    )
    message.fields.forEach((field, index) =>
      expect(actual[`ycoding.v5.${name}`]!.fields[index]!.constraints ?? {}, `${name}.${field.name}`).toEqual(
        Object.fromEntries(
          Object.entries(connectorFieldConstraints(field)).filter(
            ([, value]) => value !== undefined && (!Array.isArray(value) || value.length),
          ),
        ),
      ),
    )
  }
  for (const item of contract.operations) {
    const descriptor = operations.find((operation) => operation.operationId === item.id)!
    expect(descriptor.requestType).toBe(`ycoding.v5.${item.request}`)
    expect(descriptor.resultType).toBe(`ycoding.v5.${item.result}`)
  }
  expect(await Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/connector.proto")).text()).toBe(
    connectorProto(),
  )
  const sources = new Set(
    Object.values(actual).flatMap((message) =>
      message.fields.flatMap((field) => field.constraints?.domainObligations ?? []),
    ),
  )
  const rustObligations: Record<string, readonly (readonly [string, string])[]> = {
    "packages/cli/src/remote-operations.ts#run": [
      ["rust/crates/runtime/src/dispatch.rs", "pub async fn invoke_remote"],
      ["rust/crates/runtime/src/dispatch.rs", "crate::connector::operations::authorize"],
      ["rust/crates/runtime/src/connector/operations.rs", "pub(crate) fn authorize"],
    ],
    "packages/cli/src/remote-operations.ts#boundedActivity": [
      ["rust/crates/runtime/src/remote_derived/session.rs", "fn bounded(value: &str, maximum: usize)"],
      ["rust/crates/runtime/src/remote_derived/session.rs", "bounded(&text, 80)"],
    ],
  }
  for (const source of [...sources].filter(
    (item) => item.startsWith("packages/remote/") || item.startsWith("packages/cli/"),
  )) {
    const successors = rustObligations[source]
    expect(successors, source).toBeDefined()
    for (const [file, symbol] of successors)
      expect(await Bun.file(path.resolve(import.meta.dir, "../../..", file)).text(), source).toContain(symbol)
  }
})

test("spec admission table matches the connector inventory, descriptor roles and mutation classes", async () => {
  const spec = await Bun.file(path.resolve(import.meta.dir, "../../../specs/wire-connector.md")).text()
  const rows = spec.split("\n").flatMap((line) => {
    const cells = line.split("|").map((cell) => cell.trim())
    if (cells.length !== 8) return []
    const source = cells[1]
    const name = cells[2]
    const id = cells[3]
    const admissionClass = cells[4]
    const roles = cells[5]
    const mutation = cells[6]
    if (!source || !name || !id || !admissionClass || !roles || !mutation) return []
    if (!/^\d+$/.test(id) || !["S", "C", "N"].includes(roles)) return []
    if (mutation !== "READ" && mutation !== "MUTATION") return []
    return [{ source, name, id: Number(id), admissionClass, roles, mutation }]
  })
  const inventory: Record<string, readonly [number, string, string, string]> = {
    ...connectorOperations,
    ...noticeOperations,
  }
  expect(rows).toHaveLength(Object.keys(inventory).length)
  const rolesByCode: Record<string, PeerRole[]> = {
    S: [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY],
    C: [PeerRole.REMOTE_CLIENT, PeerRole.RELAY],
    N: [PeerRole.REMOTE_CLIENT],
  }
  for (const row of rows) {
    expect(inventory[row.source], row.source).toEqual([row.id, row.name, row.admissionClass, row.mutation])
    const descriptor = operations.find((item) => item.operationId === row.id)!
    expect(descriptor.diagnosticName, row.source).toBe(row.name)
    expect(descriptor.mutation, row.source).toBe(row.mutation === "READ" ? MutationClass.READ : MutationClass.MUTATION)
    expect(descriptor.roles, row.source).toEqual(rolesByCode[row.roles])
  }
})

test("relay forwards exactly the connector set plus the relay-only raw MCP request; agents and servers send none", () => {
  const actual = operations.filter((item) => item.roles.includes(PeerRole.RELAY))
  expect(actual).toHaveLength(84)
  expect(actual.map((item) => item.operationId).sort()).toEqual(
    [...new Set([...Object.values(connectorOperations), ...Object.values(relayOperations)].map(([id]) => id))].sort(),
  )
  for (const [id, name, , mutation] of Object.values(relayOperations))
    expect(operations.find((item) => item.operationId === id)).toMatchObject({
      diagnosticName: name,
      roles: [PeerRole.RELAY],
      mutation: MutationClass[mutation],
    })
  for (const role of [PeerRole.AGENT, PeerRole.SERVER])
    expect(operations.filter((item) => item.roles.includes(role))).toEqual([])
})

test("no local-only operation gains remote authority and all shared IDs retain local authority", () => {
  const remoteIDs = new Set<number>(
    [...Object.values(connectorOperations), ...Object.values(noticeOperations), ...Object.values(relayOperations)].map(
      ([id]) => id,
    ),
  )
  for (const operation of operations) {
    if (!remoteIDs.has(operation.operationId))
      expect(operation.roles, operation.diagnosticName).toEqual([PeerRole.LOCAL_CLIENT])
    if (remoteIDs.has(operation.operationId) && operation.operationId < 5000)
      expect(operation.roles, operation.diagnosticName).toEqual([
        PeerRole.LOCAL_CLIENT,
        PeerRole.REMOTE_CLIENT,
        PeerRole.RELAY,
      ])
  }
})
