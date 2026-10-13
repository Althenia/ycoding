import { expect, test } from "bun:test"
import { operations, operationIDsByRole, PeerRole, MutationClass } from "../src/generated/v5/index.js"
import { connectorOperations, noticeOperations } from "./connector-source.js"
import { connectorContract, connectorProto, connectorFieldConstraints } from "./connector-contract.js"
import { messages } from "../src/generated/v5/contract.js"
import type { Constraints } from "../src/v5/constraints.js"
import path from "node:path"

test("the closed remote surface contains exactly 70 connector and four relay notice operations", () => {
  const expected = [...Object.values(connectorOperations), ...Object.values(noticeOperations)]
  expect(expected).toHaveLength(74)
  expect(new Set(expected.map(([id]) => id)).size).toBe(74)
  const actual = operations.filter((item) => item.roles.includes(PeerRole.REMOTE_CLIENT))
  expect(actual).toHaveLength(74)
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
  expect(operationIDsByRole[PeerRole.REMOTE_CLIENT]).toHaveLength(74)
  expect(operationIDsByRole[PeerRole.RELAY]).toHaveLength(70)
})

test("the connector contract adds no descriptor fields", () => {
  expect(messages["ycoding.v5.OperationDescriptor"].fields.map((field) => field.tag)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
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
  const primitives: Record<string, number> = { bool: 8, double: 1, int64: 3, uint64: 4, string: 9 }
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
  for (const source of [...sources].filter(
    (item) => item.startsWith("packages/remote/") || item.startsWith("packages/cli/"),
  )) {
    const [file, symbol] = source.split("#")
    expect(await Bun.file(path.resolve(import.meta.dir, "../../..", file!)).text(), source).toContain(symbol!)
  }
})

test("relay forwards exactly the connector set; agents and servers send no operation requests", () => {
  const actual = operations.filter((item) => item.roles.includes(PeerRole.RELAY))
  expect(actual).toHaveLength(70)
  expect(actual.map((item) => item.operationId).sort()).toEqual(
    Object.values(connectorOperations)
      .map(([id]) => id)
      .sort(),
  )
  for (const role of [PeerRole.AGENT, PeerRole.SERVER])
    expect(operations.filter((item) => item.roles.includes(role))).toEqual([])
})

test("no local-only operation gains remote authority and all shared IDs retain local authority", () => {
  const remoteIDs = new Set<number>(
    [...Object.values(connectorOperations), ...Object.values(noticeOperations)].map(([id]) => id),
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
