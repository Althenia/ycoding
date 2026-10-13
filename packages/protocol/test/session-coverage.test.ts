import { expect, test } from "bun:test"
import { frontendBoundaryBaselineFields } from "./frontend-boundary-baseline.js"
import path from "node:path"
import { generateManifest } from "../../../script/rust-parity/manifest.js"
import { ClientApi } from "../src/client.js"
import { operations } from "../src/generated/v5/index.js"
import { resourceIDs } from "./resources-contract.js"
import { platformIDs } from "./platform-contract.js"
import { platformExclusions } from "./platform-source.js"
import { Schema, SchemaAST } from "effect"
import { descriptorSet } from "./descriptor-set.js"
import { messages } from "../src/generated/v5/contract.js"
import {
  PeerRole,
  Paging,
  Streaming,
  ScopeKind,
  MutationClass,
  Settlement,
  Sensitivity,
} from "../src/generated/v5/index.js"
import { sessionContract, sessionIDs, sessionProto, sessionPolicy, sessionResultNames } from "./session-contract.js"
import { sessionRpcEndpoints, sessionEndpoints, sessionInventoryAdditions } from "./session-source.js"
import { resourceFieldConstraints } from "./resources-contract.js"
import { sharedSet } from "./platform-contract.js"
import { requireConstraintCoverage } from "../src/v5/constraint-coverage.js"
import type { Constraints } from "../src/v5/constraints.js"
import { rustTypeName } from "../src/v5/codec-names.js"
import { isWireSse } from "./wire-contract.js"
import { SessionLogItem } from "../src/groups/session.js"
import { connectorRoles } from "./connector-source.js"

test("session slice completes the 198 endpoints without overlap and adds only inventory unsubscribe", async () => {
  const manifest = await generateManifest(path.resolve(import.meta.dir, "../../.."))
  expect(manifest.members.filter((member) => member.kind !== "endpoint").map((member) => member.name).sort()).toEqual(operations.filter((operation) => operation.roles.includes(PeerRole.REMOTE_CLIENT)).map((operation) => operation.diagnosticName).sort())
  const endpoints = manifest.members.filter((member) => member.kind === "endpoint")
  const excluded = [...Object.keys(resourceIDs), ...Object.keys(platformIDs), ...Object.keys(platformExclusions)]
  expect(excluded).toHaveLength(115)
  expect(new Set(excluded).size).toBe(115)
  const remaining = endpoints.filter((member) => !excluded.includes(member.name))
  expect(remaining).toHaveLength(83)
  const live = Object.values(ClientApi.groups).flatMap((group) =>
    Object.values(group.endpoints).map((endpoint) => endpoint.identifier),
  )
  expect(live.filter((name) => !excluded.includes(name)).sort((a, b) => a.localeCompare(b))).toEqual(
    remaining.map((member) => member.name).sort((a, b) => a.localeCompare(b)),
  )
  expect([...excluded, ...remaining.map((member) => member.name)].sort()).toEqual(
    endpoints.map((member) => member.name).sort(),
  )
  expect(
    remaining
      .filter((member) => member.disposition === "STREAM")
      .map((member) => member.name)
      .sort(),
  ).toEqual(["event.subscribe", "session.attachment.read", "session.log", "session.message", "session.messages"])
  expect(remaining.filter((member) => member.disposition === "RPC")).toHaveLength(78)
  expect(remaining.filter((member) => member.disposition === "EXTERNAL")).toEqual([])
  const actual = operations.filter((operation) => operation.operationId >= 4000 && operation.operationId <= 4199)
  expect(actual).toHaveLength(84)
  expect(actual.map((operation) => operation.diagnosticName).sort()).toEqual(
    [...remaining.map((member) => member.name), "event.unsubscribe"].sort(),
  )
  expect(
    actual.filter((operation) => !live.includes(operation.diagnosticName)).map((operation) => operation.diagnosticName),
  ).toEqual(["event.unsubscribe"])
  expect(actual.some((operation) => operation.diagnosticName === "session.attachment.upload")).toBe(false)
  expect(actual.map((operation) => operation.operationId)).toEqual(Object.values(sessionIDs))
  expect(sessionInventoryAdditions).toEqual({ "event.unsubscribe": "protocol.md:227 / operation-inventory.md:94" })
})

test("all session fields, tags, presence, enums and obligations match live source projection", async () => {
  const contract = sessionContract()
  const actual: Readonly<
    Record<
      string,
      {
        oneofs: number
        fields: readonly {
          tag: number
          name: string
          type: number
          required: boolean
          repeated: boolean
          target?: string
          group?: number
          constraints?: Constraints
        }[]
      }
    >
  > = messages
  const primitives: Record<string, number> = { bool: 8, double: 1, int64: 3, uint64: 4, string: 9 }
  for (const [name, message] of contract.messages) {
    const value = actual[`ycoding.v5.${name}`]
    expect(value, name).toBeDefined()
    expect(value.oneofs, name).toBe(message.oneof ? 1 : 0)
    expect(
      frontendBoundaryBaselineFields(name, value.fields).map((field) => ({
        tag: field.tag,
        name: field.name,
        type: field.type,
        required: field.required,
        repeated: field.repeated,
        target: field.target || undefined,
        group: field.group,
      })),
      name,
    ).toEqual(
      message.fields.map((field, index) => ({
        tag: index + 1,
        name: field.name,
        type: primitives[field.type] ?? (contract.enums.has(field.type) ? 14 : 11),
        required: field.presence === "required",
        repeated: field.presence === "repeated",
        target: primitives[field.type] ? undefined : `ycoding.v5.${field.type}`,
        group: field.presence === "oneof" ? 0 : undefined,
      })),
    )
    for (const field of message.fields) {
      const metadata = value.fields.find((item) => item.name === field.name)?.constraints
      expect(metadata ?? {}, `${name}.${field.name}`).toEqual(
        Object.fromEntries(
          Object.entries(resourceFieldConstraints(field)).filter(
            ([, value]) => value !== undefined && (!Array.isArray(value) || value.length),
          ),
        ),
      )
      const visit = (ast: SchemaAST.AST) => {
        expect(
          requireConstraintCoverage(Schema.make(ast), field.source ?? `${name}.${field.name}`, metadata).enforced,
        ).toBe(false)
        if (ast._tag === "Union" && !contract.messages.get(field.type)?.oneof) ast.types.forEach(visit)
        if (ast._tag === "Declaration") ast.typeParameters.forEach(visit)
      }
      if (field.ast) visit(field.ast)
    }
  }
  const set = descriptorSet()
  const enums = new Map(set.file.flatMap((file) => file.enumType.map((item) => [item.name, item.value] as const)))
  for (const [name, values] of contract.enums) {
    expect(
      enums.get(name)?.map((value) => value.name),
      name,
    ).toEqual(
      values.map(
        (value) =>
          `${name.toUpperCase()}_${String(value)
            .replace(/[^a-zA-Z0-9]/g, "_")
            .toUpperCase()}`,
      ),
    )
    expect(
      enums.get(name)?.map((value) => value.number),
      name,
    ).toEqual(values.map((_, index) => index + 1))
  }
  const file = set.file.find((file) => file.name === "ycoding/v5/session.proto")!
  const shared = sharedSet()
  expect(file.messageType.map((message) => message.name).sort()).toEqual(
    [...contract.messages.keys()].filter((name) => !shared.has(name)).sort(),
  )
  expect(file.enumType.map((item) => item.name).sort()).toEqual(
    [...contract.enums.keys()].filter((name) => !shared.has(name)).sort(),
  )
})

test("session descriptors preserve IDs, typed associations, middleware errors and delivery policies", () => {
  for (const operation of sessionContract().operations) {
    const descriptor = operations.find((item) => item.operationId === operation.id)!
    expect(descriptor, operation.name).toBeDefined()
    expect(descriptor.diagnosticName).toBe(operation.name)
    expect(descriptor.requestType).toBe(`ycoding.v5.${operation.request}`)
    expect(descriptor.resultType).toBe(`ycoding.v5.${operation.result}`)
    expect(descriptor.errorTypes).toEqual(operation.errors.map((name) => `ycoding.v5.${name}`))
    expect(descriptor.errorTypes).toContain("ycoding.v5.UnauthorizedError")
    expect(descriptor.errorTypes).toContain("ycoding.v5.InvalidRequestError")
    const policy = sessionPolicy(operation.name, operation.method)
    expect(descriptor.scope).toBe(ScopeKind[policy.scope])
    expect(descriptor.mutation).toBe(MutationClass[policy.mutation])
    expect(descriptor.paging).toBe(Paging[policy.paging])
    expect(descriptor.streaming).toBe(Streaming[policy.streaming])
    expect(descriptor.settlement).toBe(Settlement[policy.settlement])
    expect(descriptor.sensitivity).toBe(Sensitivity[policy.sensitivity])
    expect(descriptor.roles).toEqual(
      connectorRoles(operation.name)
        ? [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY]
        : [PeerRole.LOCAL_CLIENT],
    )
  }
  expect(operations.find((operation) => operation.diagnosticName === "session.prompt")!.settlement).toBe(
    Settlement.DURABLY_ADMITTED,
  )
  expect(operations.find((operation) => operation.diagnosticName === "session.usageReport")!.paging).toBe(Paging.OFFSET)
  expect(operations.find((operation) => operation.diagnosticName === "session.log")!.paging).toBe(Paging.UNPAGED)
  expect(operations.find((operation) => operation.diagnosticName === "session.completions")!.paging).toBe(
    Paging.UNPAGED,
  )
  expect(operations.find((operation) => operation.diagnosticName === "session.wait")!.mutation).toBe(MutationClass.READ)
})

test("typed subscriptions preserve log items and finite StreamEnd without SSE or synchronous prompt execution", () => {
  const contract = sessionContract()
  expect(contract.messages.get("event_subscribe_Request")!.fields.map((field) => [field.name, field.type])).toEqual([
    ["scope", "Scope"],
  ])
  expect(contract.messages.get("event_subscribe_Result")!.fields.map((field) => field.name)).toEqual([
    "subscription_id",
  ])
  expect(contract.messages.get("session_log_Result")!.fields.map((field) => field.name)).toEqual(["subscription_id"])
  expect(contract.messages.get("session_log_Request_query")!.fields.map((field) => field.name)).toEqual([
    "after",
    "follow",
  ])
  expect(contract.messages.has("SessionLogItem")).toBe(true)
  const log = sessionEndpoints().find(({ endpoint }) => endpoint.identifier === "session.log")!.endpoint
  const source = [...log.success][0]
  expect(isWireSse(source)).toBe(true)
  if (!isWireSse(source)) throw new Error("log source is not SSE")
  const data = Schema.toType(source.events).ast
  expect(data._tag).toBe("Objects")
  if (data._tag !== "Objects") throw new Error("SSE event fields absent")
  const sourceItems = data.propertySignatures.find((field) => field.name === "data")!.type
  const declaredItems = Schema.toType(SessionLogItem).ast
  if (sourceItems._tag !== "Union" || declaredItems._tag !== "Union") throw new Error("log union absent")
  expect(sourceItems.types).toEqual(declaredItems.types)
  expect(contract.messages.get("session_prompt_Result")!.fields.map((field) => field.type)).toEqual([
    "SessionPending_User",
  ])
  expect(contract.messages.get("SessionAssetMetadata")!.fields.map((field) => [field.name, field.type])).toEqual([
    ["mime", "LosslessString"],
    ["bytes", "uint64"],
  ])
  expect(contract.messages.get("session_attachment_read_Request_params")!.fields.map((field) => field.name)).toEqual([
    "sessionID",
    "digest",
  ])
  expect(contract.messages.get("event_unsubscribe_Request")!.fields.map((field) => field.name)).toEqual([
    "subscription_id",
  ])
  expect(contract.messages.get("event_unsubscribe_Result")!.fields.map((field) => field.type)).toEqual(["Empty"])
  expect(sessionPolicy("session.log", "GET").streamEnd).toBe(true)
  expect(sessionPolicy("event.subscribe", "GET").streamEnd).toBe(false)
  expect(
    contract.operations
      .filter((operation) => sessionPolicy(operation.name, operation.method).streamEnd)
      .map((operation) => operation.name),
  ).toEqual(["session.log"])
})

test("source reordering preserves canonical bytes and frozen materialization rejects overwrite", async () => {
  expect(sessionProto([...sessionRpcEndpoints()].reverse())).toBe(sessionProto())
  const actual = await Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/session.proto")).text()
  expect(actual).toBe(sessionProto())
  expect(actual.endsWith("\n") && !actual.endsWith("\n\n")).toBe(true)
  const result = Bun.spawnSync(["bun", "run", path.resolve(import.meta.dir, "session-materialize.ts"), "--write-new"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("canonical IDs and tags are frozen")
})

test("every session domain obligation names a live source owner", async () => {
  const sources = new Set(
    [...sessionContract().messages.values()].flatMap((message) =>
      message.fields.flatMap((field) => resourceFieldConstraints(field).domainObligations ?? []),
    ),
  )
  const files = new Map<string, string>()
  for (const source of sources) {
    const [file, name] = source.split("#")
    if (!files.has(file)) files.set(file, await Bun.file(path.resolve(import.meta.dir, "../../..", file)).text())
    expect(new RegExp(`(?:const|class|function) ${name.split(".").at(-1)!}\\b`).test(files.get(file)!), source).toBe(
      true,
    )
  }
})

test("session result wrapper overrides cannot grow or become stale without a real collision", () => {
  const contract = sessionContract()
  expect(sessionResultNames).toEqual({})
  const collisions = contract.operations.filter((operation) => {
    const original = `${operation.name.replace(/[^a-zA-Z0-9]/g, "_")}_Result`
    return [...contract.messages.keys(), ...contract.enums.keys()].some(
      (name) => name !== operation.result && rustTypeName(name) === rustTypeName(original),
    )
  })
  expect(collisions.map((operation) => operation.name)).toEqual(Object.keys(sessionResultNames))
})
