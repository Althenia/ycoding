import { describe, expect, test } from "bun:test"
import path from "node:path"
import { messages } from "../src/generated/v5/contract.js"
import { publicEvents } from "../src/generated/v5/events.js"
import {
  MutationClass,
  operations,
  Paging,
  PeerRole,
  ScopeKind,
  Sensitivity,
  Settlement,
  Streaming,
} from "../src/v5/index.js"
import { coordinationIDs, coordinationProto } from "./coordination-contract.js"
import { connectorOperations } from "./connector-source.js"

const descriptors = path.resolve(import.meta.dir, "../../../protocol/ycoding/v5")
const read = (file: string) => Bun.file(path.join(descriptors, file)).text()
const operation = (name: string) => operations.find((candidate) => candidate.diagnosticName === name)
const fields = (message: string) =>
  (messages as Record<string, { fields: readonly { tag: number; name: string }[] }>)[`ycoding.v5.${message}`]?.fields

describe("coordination wire contract", () => {
  test("the eight Project operations hold IDs 6000-6007 inside their own declared range", async () => {
    expect(await read("coordination.proto")).toContain("option (ycoding.v5.operation_range) = { first: 6000 last: 6099 };")
    for (const [name, id] of Object.entries(coordinationIDs)) {
      const descriptor = operation(name)
      expect(descriptor, name).toBeDefined()
      expect(descriptor!.operationId).toBe(id)
      expect(descriptor!.requestType).toBe(`ycoding.v5.${name.replaceAll(".", "_")}_Request`)
      expect(descriptor!.resultType).toBe(`ycoding.v5.${name.replaceAll(".", "_")}_${name === "coordination.attach" ? "Reply" : "Result"}`)
    }
    expect(
      operations
        .filter((descriptor) => descriptor.diagnosticName.startsWith("coordination."))
        .map((descriptor) => descriptor.operationId)
        .sort(),
    ).toEqual([6000, 6001, 6002, 6003, 6004, 6005, 6006, 6007])
  })

  test("Project operations are machine-scoped private reads and mutations for local, remote and relay peers", () => {
    const mutations = { settings: "READ", list: "READ", get: "READ", create: "MUTATION", update: "MUTATION", delete: "MUTATION" }
    for (const [suffix, mutation] of Object.entries(mutations)) {
      const descriptor = operation(`coordination.${suffix}`)!
      expect(descriptor.roles).toEqual([PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY])
      expect(descriptor.roleScopes).toEqual([])
      expect(descriptor.scope).toBe(ScopeKind.MACHINE)
      expect(descriptor.mutation).toBe(MutationClass[mutation as keyof typeof MutationClass])
      expect(descriptor.settlement).toBe(Settlement.COMPLETED)
      expect(descriptor.paging).toBe(Paging.UNPAGED)
      expect(descriptor.streaming).toBe(Streaming.TYPED_BULK)
      expect(descriptor.sensitivity).toBe(Sensitivity.PRIVATE)
      expect([...descriptor.errorTypes].sort()).toEqual(
        ["CoordinationError", "InvalidRequestError", "UnauthorizedError"].map((name) => `ycoding.v5.${name}`),
      )
    }
  })

  test("typed failures carry the Core reason tag and message", () => {
    expect(fields("CoordinationError")?.map((field) => [field.tag, field.name])).toEqual([
      [1, "_tag"],
      [2, "reason"],
      [3, "message"],
    ])
  })

  test("remote callers reach the same descriptors under the same operation names", () => {
    for (const [name, id] of Object.entries(coordinationIDs))
      expect<readonly unknown[] | undefined>(Object.entries(connectorOperations).find(([source]) => source === name)?.[1]).toEqual([
        id,
        name,
        "A",
        operation(name)!.mutation === MutationClass.READ ? "READ" : "MUTATION",
      ])
  })

  test("Project invalidations and durable group facts are public events", () => {
    const events = new Map<string, { durable: boolean }>(publicEvents.map((event) => [event.name, event]))
    expect(events.get("coordination.updated")?.durable).toBe(false)
    for (const name of ["coordination.group.created", "coordination.group.changed", "coordination.group.deleted"])
      expect(events.get(name)?.durable, name).toBe(true)
  })

  test("the checked-in descriptor equals the live Protocol projection", async () => {
    expect(coordinationProto()).toBe(await read("coordination.proto"))
  })
})
