import { expect, test } from "bun:test"
import path from "node:path"
import { resourceSources } from "./resources-source.js"
import { resourceContract, resourceSharedSet, resourceFieldConstraints } from "./resources-contract.js"
import { sharedSet } from "./platform-contract.js"
import { messages, enums } from "../src/generated/v5/contract.js"
import { descriptorSet } from "./descriptor-set.js"
import { generateManifest } from "../../../script/rust-parity/manifest.js"
import { requireConstraintCoverage } from "../src/v5/constraint-coverage.js"
import type { Constraints } from "../src/v5/constraints.js"
import { Schema, SchemaAST } from "effect"
import { operations, Paging, PeerRole } from "../src/generated/v5/index.js"
import { frontendBoundaryBaseline, frontendBoundaryBaselineFields } from "./frontend-boundary-baseline.js"

test("resource RPC membership equals the live 60-operation Protocol slice", async () => {
  const sources = resourceSources()
  expect(sources).toHaveLength(60)
  const proto = await Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/resources.proto")).text()
  const names = Array.from(frontendBoundaryBaseline(proto).matchAll(/rpc (\w+)\(/g), (match) => match[1])
  expect(names.sort()).toEqual(sources.map((source) => source.name.replace(/[^a-zA-Z0-9]/g, "_")).sort())
  const manifest = await generateManifest(path.resolve(import.meta.dir, "../../.."))
  expect(manifest.members.filter((member) => member.kind === "connector").map((member) => member.name).sort()).toEqual(operations.filter((operation) => operation.roles.includes(PeerRole.RELAY)).map((operation) => operation.diagnosticName).sort())
  const groups = new Set<string>(sources.map((source) => source.group))
  expect(
    manifest.members
      .filter((member) => member.kind === "endpoint" && groups.has(member.group))
      .map((member) => member.name)
      .sort(),
  ).toEqual(sources.map((source) => source.name).sort())
})

test("enum literal names match live Effect literals, including single-member tagged fields", async () => {
  const contract = resourceContract()
  const descriptor = descriptorSet()
  const actual = new Map(
    descriptor.file.flatMap((file) =>
      file.enumType.map((item) => [item.name, item.value.map((value) => value.name)] as const),
    ),
  )
  for (const [name, values] of contract.enums)
    expect(actual.get(name), name).toEqual(
      values.map(
        (value) =>
          `${name.toUpperCase()}_${String(value)
            .replace(/[^a-zA-Z0-9]/g, "_")
            .toUpperCase()}`,
      ),
    )
})

test("shared declarations are exactly those reached by live endpoints outside the resource slice", async () => {
  const shared = await Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/shared.proto")).text()
  const names = Array.from(frontendBoundaryBaseline(shared).matchAll(/^(?:message|enum) (\w+)/gm), (match) => match[1])
  expect(names.sort()).toEqual([...sharedSet()].sort())
  const resources = await Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/resources.proto")).text()
  const resourceNames = Array.from(
    frontendBoundaryBaseline(resources).matchAll(/^(?:message|enum) (\w+)/gm),
    (match) => match[1],
  )
  expect(names.filter((name) => resourceNames.includes(name))).toEqual([])
  const contract = resourceContract()
  expect([...names.filter((name) => resourceSharedSet().has(name)), ...resourceNames].sort()).toEqual(
    [...contract.messages.keys(), ...contract.enums.keys()].sort(),
  )
  for (const operation of contract.operations) {
    expect(operation.errors).toContain("UnauthorizedError")
    expect(operation.errors).toContain("InvalidRequestError")
  }
})

test("every request, result and typed error matches the live Effect field types and presence", () => {
  const contract = resourceContract()
  const primitiveTypes: Record<string, number> = { bool: 8, double: 1, int64: 3, uint64: 4 }
  const actual: Readonly<
    Record<
      string,
      {
        oneofs: number
        fields: readonly {
          name: string
          type: number
          required: boolean
          repeated: boolean
          target?: string
          group?: number
        }[]
      }
    >
  > = messages
  for (const [name, message] of contract.messages) {
    const descriptor = actual[`ycoding.v5.${name}`]
    expect(descriptor, name).toBeDefined()
    expect(descriptor.oneofs, name).toBe(message.oneof ? 1 : 0)
    expect(
      frontendBoundaryBaselineFields(name, descriptor.fields).map((field) => ({
        name: field.name,
        type: field.type,
        required: field.required,
        repeated: field.repeated,
        target: field.target || undefined,
        group: field.group,
      })),
      name,
    ).toEqual(
      message.fields.map((field) => ({
        name: field.name,
        type: primitiveTypes[field.type] ?? (contract.enums.has(field.type) ? 14 : 11),
        required: field.presence === "required",
        repeated: field.presence === "repeated",
        target: primitiveTypes[field.type] ? undefined : `ycoding.v5.${field.type}`,
        group: field.presence === "oneof" ? 0 : undefined,
      })),
    )
  }
  const actualEnums: Readonly<Record<string, readonly number[]>> = enums
  for (const [name, values] of contract.enums)
    expect(actualEnums[`ycoding.v5.${name}`], name).toEqual(values.map((_, index) => index + 1))
  const reachable = new Set(
    contract.operations.flatMap((operation) => [operation.request, operation.result, ...operation.errors]),
  )
  expect(reachable.size >= 120).toBe(true)
  expect(new Set(contract.operations.map((operation) => operation.id)).size).toBe(60)
  expect(contract.operations.every((operation) => operation.id >= 2000 && operation.id <= 2999)).toBe(true)
})

test("every checked live source field has exact structural metadata and an unenforced source obligation", () => {
  const actual: Readonly<Record<string, { fields: readonly { name: string; constraints?: Constraints }[] }>> = messages
  const visit = (ast: SchemaAST.AST, source: string, constraints?: Constraints) => {
    expect(requireConstraintCoverage(Schema.make(ast), source, constraints).enforced).toBe(false)
    if (ast._tag === "Union") {
      const types = ast.types.filter((type) => type._tag !== "Undefined")
      if (types.length === 1) visit(types[0], source, constraints)
    }
    if (ast._tag === "Declaration") ast.typeParameters.forEach((type) => visit(type, source, constraints))
  }
  for (const [name, message] of resourceContract().messages)
    for (const field of message.fields) {
      const metadata = actual[`ycoding.v5.${name}`].fields.find((item) => item.name === field.name)?.constraints
      const expected = resourceFieldConstraints(field)
      const normalized = Object.fromEntries(
        Object.entries(expected).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length)),
      )
      expect(metadata ?? {}, `${name}.${field.name}`).toEqual(normalized)
      if (field.ast) visit(field.ast, field.source ?? `${name}.${field.name}`, metadata)
    }
})

test("canonical operation descriptors have exact resource IDs, request/result associations and inherited errors", () => {
  const expected = resourceContract().operations
  expect(
    operations
      .filter((operation) => operation.operationId >= 2000 && operation.operationId <= 2059)
      .map((operation) => ({
        id: operation.operationId,
        name: operation.diagnosticName,
        request: operation.requestType,
        result: operation.resultType,
        errors: operation.errorTypes,
      })),
  ).toEqual(
    expected.map((operation) => ({
      id: operation.id,
      name: operation.name,
      request: `ycoding.v5.${operation.request}`,
      result: `ycoding.v5.${operation.result}`,
      errors: operation.errors.map((error) => `ycoding.v5.${error}`),
    })),
  )
})

test("every domain obligation names a live source schema owner", async () => {
  const sources = new Set(
    [...resourceContract().messages.values()].flatMap((message) =>
      message.fields.flatMap((field) => resourceFieldConstraints(field).domainObligations ?? []),
    ),
  )
  const text = new Map<string, string>()
  for (const source of sources) {
    const [file, name] = source.split("#")
    if (!text.has(file)) text.set(file, await Bun.file(path.resolve(import.meta.dir, "../../..", file)).text())
    const symbol = name.split(".").at(-1)!
    expect(new RegExp(`(?:const|class|function) ${symbol}\\b`).test(text.get(file)!), source).toBe(true)
  }
})

test("named integer schemas retain 64-bit integer wire types rather than ref-shaped double fallthrough", () => {
  const actual: Readonly<Record<string, { fields: readonly { name: string; type: number }[] }>> = messages
  for (const [name, message] of resourceContract().messages)
    for (const field of message.fields) {
      const integer = field.constraints.some(
        (constraint) =>
          typeof constraint.meta === "object" &&
          constraint.meta !== null &&
          "_tag" in constraint.meta &&
          constraint.meta._tag === "isInt",
      )
      if (integer)
        expect(
          [3, 4].includes(actual[`ycoding.v5.${name}`].fields.find((item) => item.name === field.name)!.type),
          `${name}.${field.name}`,
        ).toBe(true)
    }
})

test("numeric offset paging is distinct from opaque cursor paging", () => {
  expect(operations.find((operation) => operation.diagnosticName === "usage.report")!.paging).toBe(3)
  const contract = resourceContract()
  const numericNextOffset = (name: string): boolean => {
    const fields = contract.messages.get(name)?.fields ?? []
    return (
      fields.some((field) => field.name === "nextOffset" && ["int64", "uint64", "double"].includes(field.type)) ||
      fields.some((field) => field.type !== name && numericNextOffset(field.type))
    )
  }
  for (const operation of contract.operations) {
    const query = contract.messages.get(operation.request)?.fields.find((field) => field.name === "query")
    const fields = query ? (contract.messages.get(query.type)?.fields.map((field) => field.name) ?? []) : []
    if (fields.includes("offset") && fields.includes("limit") && numericNextOffset(operation.result))
      expect(operations.find((item) => item.operationId === operation.id)!.paging).toBe(Paging.OFFSET)
  }
})
