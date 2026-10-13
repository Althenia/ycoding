import { expect, test } from "bun:test"
import path from "node:path"
import { Schema, SchemaAST } from "effect"
import { generateManifest } from "../../../script/rust-parity/manifest.js"
import {
  platformEndpoints,
  platformRpcEndpoints,
  platformGroups,
  platformExclusions,
  assetSource,
} from "./platform-source.js"
import {
  platformContract,
  platformProto,
  platformIDs,
  platformFieldConstraints,
  platformPolicy,
  platformResultNames,
  sharedSet,
} from "./platform-contract.js"
import { messages } from "../src/generated/v5/contract.js"
import {
  operations,
  Paging,
  Streaming,
  ScopeKind,
  MutationClass,
  Sensitivity,
  Settlement,
  PeerRole,
} from "../src/generated/v5/index.js"
import { requireConstraintCoverage } from "../src/v5/constraint-coverage.js"
import type { Constraints } from "../src/v5/constraints.js"
import { rustTypeName } from "../src/v5/codec-names.js"
import { connectorRoles } from "./connector-source.js"
import { descriptorSet } from "./descriptor-set.js"
import { frontendBoundaryBaseline, frontendBoundaryBaselineFields } from "./frontend-boundary-baseline.js"

test("platform slice exactly matches all 55 baseline and live endpoint declarations", async () => {
  const live = platformEndpoints().map(({ endpoint }) => endpoint.identifier)
  expect(live).toHaveLength(55)
  const manifest = await generateManifest(path.resolve(import.meta.dir, "../../.."))
  expect(manifest.counts).toEqual({ endpoint: 198, connector: 66, notice: 4 })
  const baseline = manifest.members.filter((member) => member.kind === "endpoint" && platformGroups.has(member.group))
  expect(baseline.map((member) => member.name).sort()).toEqual([...live].sort())
  expect(
    baseline
      .filter((member) => member.disposition === "EXTERNAL")
      .map((member) => member.name)
      .sort(),
  ).toEqual(["browser.connect", "pty.connect"])
  expect(Object.keys(platformExclusions).sort()).toEqual(["browser.connect", "pty.connect"])
  expect(baseline.find((member) => member.name === "fs.read")?.disposition).toBe("STREAM")
  const actual = operations.filter((operation) => operation.operationId >= 3000 && operation.operationId <= 3052)
  expect(actual).toHaveLength(53)
  expect(actual.map((operation) => operation.diagnosticName).sort()).toEqual(
    platformRpcEndpoints()
      .map(({ endpoint }) => endpoint.identifier)
      .sort(),
  )
  expect(actual.map((operation) => operation.operationId)).toEqual(Object.values(platformIDs))
  expect(
    new Set([...actual.map((operation) => operation.diagnosticName), ...Object.keys(platformExclusions)]).size,
  ).toBe(55)
})

test("every platform field, presence, enum and typed error matches the live Effect contract", async () => {
  const contract = platformContract()
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
          constraints?: Constraints
        }[]
      }
    >
  > = messages
  const primitives: Record<string, number> = { bool: 8, double: 1, int64: 3, uint64: 4 }
  for (const [name, message] of contract.messages) {
    const value = actual[`ycoding.v5.${name}`]
    expect(value, name).toBeDefined()
    expect(value.oneofs, name).toBe(message.oneof ? 1 : 0)
    expect(
      frontendBoundaryBaselineFields(name, value.fields).map((field) => ({
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
        type: primitives[field.type] ?? (contract.enums.has(field.type) ? 14 : 11),
        required: field.presence === "required",
        repeated: field.presence === "repeated",
        target: primitives[field.type] ? undefined : `ycoding.v5.${field.type}`,
        group: field.presence === "oneof" ? 0 : undefined,
      })),
    )
    for (const field of message.fields) {
      const metadata = value.fields.find((item) => item.name === field.name)?.constraints
      const expected = platformFieldConstraints(field)
      expect(metadata ?? {}, `${name}.${field.name}`).toEqual(
        Object.fromEntries(
          Object.entries(expected).filter(
            ([, value]) => value !== undefined && (!Array.isArray(value) || value.length),
          ),
        ),
      )
      const visit = (ast: SchemaAST.AST) => {
        expect(
          requireConstraintCoverage(Schema.make(ast), field.source ?? `${name}.${field.name}`, metadata).enforced,
        ).toBe(false)
        if (ast._tag === "Union") {
          const types = ast.types.filter((type) => type._tag !== "Undefined")
          if (types.length === 1) visit(types[0])
        }
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
  const platform = set.file.find((file) => file.name === "ycoding/v5/platform.proto")!
  const shared = sharedSet()
  expect(platform.messageType.map((message) => message.name).sort()).toEqual(
    [
      ...[...contract.messages.keys()].filter((name) => !shared.has(name)),
      "RemoteDevice",
      "RemoteEnrollmentError",
      "RemoteEnrollmentPartialFailure",
      "remote_enroll_Request",
      "remote_enroll_Request_payload",
      "remote_enroll_Result",
    ].sort(),
  )
  expect(platform.enumType.map((item) => item.name).sort()).toEqual(
    [
      ...[...contract.enums.keys()].filter((name) => !shared.has(name)),
      "RemoteDeviceCredentialState",
      "RemoteEnrollmentError__tag",
      "RemoteEnrollmentError_code",
      "RemoteEnrollmentPartialFailure__tag",
    ].sort(),
  )
  expect(platform.dependency).toContain("ycoding/v5/shared.proto")
})

test("canonical platform descriptors preserve IDs, associations, errors and delivery policies", () => {
  for (const operation of platformContract().operations) {
    const descriptor = operations.find((item) => item.operationId === operation.id)!
    expect(descriptor, operation.name).toBeDefined()
    expect(descriptor.diagnosticName).toBe(operation.name)
    expect(descriptor.requestType).toBe(`ycoding.v5.${operation.request}`)
    expect(descriptor.resultType).toBe(`ycoding.v5.${operation.result}`)
    expect(descriptor.errorTypes).toEqual(operation.errors.map((name) => `ycoding.v5.${name}`))
    expect(descriptor.errorTypes).toContain("ycoding.v5.UnauthorizedError")
    expect(descriptor.errorTypes).toContain("ycoding.v5.InvalidRequestError")
    const policy = platformPolicy(operation.name, operation.method)
    expect(descriptor.scope).toBe(ScopeKind[policy.scope as keyof typeof ScopeKind])
    expect(descriptor.mutation).toBe(MutationClass[policy.mutation as keyof typeof MutationClass])
    expect(descriptor.paging).toBe(Paging[policy.paging as keyof typeof Paging])
    expect(descriptor.streaming).toBe(Streaming[policy.streaming as keyof typeof Streaming])
    expect(descriptor.sensitivity).toBe(Sensitivity[policy.sensitivity as keyof typeof Sensitivity])
    expect(descriptor.settlement).toBe(Settlement.COMPLETED)
    expect(descriptor.roles).toEqual(
      connectorRoles(operation.name)
        ? [PeerRole.LOCAL_CLIENT, PeerRole.REMOTE_CLIENT, PeerRole.RELAY]
        : [PeerRole.LOCAL_CLIENT],
    )
  }
  expect(operations.find((operation) => operation.diagnosticName === "fs.read")?.streaming).toBe(Streaming.ASSET_BULK)
  expect(operations.find((operation) => operation.diagnosticName === "telemetry.list")?.paging).toBe(Paging.CURSOR)
  expect(operations.find((operation) => operation.diagnosticName === "shell.output")?.paging).toBe(Paging.OFFSET)
})

test("wildcard asset path, native ticket headers and metadata retain their source boundaries", async () => {
  const asset = platformEndpoints().find(({ endpoint }) => endpoint.identifier === "fs.read")!.endpoint
  expect(asset.path).toBe("/api/fs/read/*")
  const contract = platformContract()
  expect(contract.messages.get("Platform_AssetPath")!.fields.map((field) => field.name)).toEqual(["path"])
  expect(platformFieldConstraints(contract.messages.get("Platform_AssetPath")!.fields[0]).domainObligations).toEqual([
    assetSource,
  ])
  expect(contract.messages.get("Platform_AssetMetadata")!.fields.map((field) => [field.name, field.type])).toEqual([
    ["mime", "LosslessString"],
    ["byteCount", "uint64"],
  ])
  expect(contract.messages.get("pty_connectToken_Request")!.fields.map((field) => field.name)).toContain("headers")
  expect(contract.messages.get("pty_connectToken_Request_headers")!.fields.map((field) => field.name)).toEqual([
    "x_ycoding_ticket",
  ])
  const handler = await Bun.file(path.resolve(import.meta.dir, "../../server/src/handlers/fs.ts")).text()
  expect(handler).toContain("pathname.slice(13)")
  expect(handler).toContain("HttpServerResponse.uint8Array(file.content, { contentType: file.mime })")
})

test("source ordering cannot change canonical tags, operation IDs or projected bytes", async () => {
  expect(platformProto([...platformRpcEndpoints()].reverse())).toBe(platformProto())
  expect(
    frontendBoundaryBaseline(
      await Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/platform.proto")).text(),
    ),
  ).toBe(platformProto())
  const result = Bun.spawnSync(
    ["bun", "run", path.resolve(import.meta.dir, "platform-materialize.ts"), "--write-new"],
    { stdout: "pipe", stderr: "pipe" },
  )
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("canonical IDs and tags are frozen")
})

test("every platform domain obligation names a live source owner", async () => {
  const sources = new Set(
    [...platformContract().messages.values()].flatMap((message) =>
      message.fields.flatMap((field) => platformFieldConstraints(field).domainObligations ?? []),
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

test("result wrapper overrides are exactly the two verified prost collisions", () => {
  expect(platformResultNames).toEqual({
    "browser.action": "browser_action_Reply",
    "isolatedBrowser.action": "isolatedBrowser_action_Reply",
  })
  const contract = platformContract()
  for (const [name, replacement] of Object.entries(platformResultNames)) {
    const original = `${name.replace(/[^a-zA-Z0-9]/g, "_")}_Result`
    const conflicting = [...contract.messages.keys()].filter(
      (message) => message !== replacement && rustTypeName(message) === rustTypeName(original),
    )
    expect(conflicting).toHaveLength(1)
    expect(rustTypeName(replacement)).not.toBe(rustTypeName(original))
    expect(contract.operations.find((operation) => operation.name === name)!.result).toBe(replacement)
  }
})
