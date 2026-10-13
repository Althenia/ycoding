import { wireContract } from "./wire-contract.js"
import { Schema, SchemaAST } from "effect"
import { resourceEndpoints, middlewareErrors, allEndpoints } from "./resources-source.js"
import type { Constraints } from "../src/v5/constraints.js"

export const resourceIDs = {
  "agent.list": 2000,
  "artifact.confirmGlobal": 2001,
  "artifact.create": 2002,
  "artifact.disable": 2003,
  "artifact.enable": 2004,
  "artifact.fork.confirm": 2005,
  "artifact.fork.preview": 2006,
  "artifact.get": 2007,
  "artifact.list": 2008,
  "artifact.metrics": 2009,
  "artifact.promotion.confirm": 2010,
  "artifact.promotion.preview": 2011,
  "artifact.purge": 2012,
  "artifact.remove": 2013,
  "artifact.restore": 2014,
  "artifact.revert": 2015,
  "artifact.shadow.confirm": 2016,
  "artifact.shadow.preview": 2017,
  "artifact.update": 2018,
  "command.list": 2019,
  "config.diagnostics": 2020,
  "credential.activate": 2021,
  "credential.remove": 2022,
  "credential.update": 2023,
  "integration.command.cancel": 2024,
  "integration.command.connect": 2025,
  "integration.command.status": 2026,
  "integration.connect.key": 2027,
  "integration.get": 2028,
  "integration.list": 2029,
  "integration.oauth.cancel": 2030,
  "integration.oauth.complete": 2031,
  "integration.oauth.connect": 2032,
  "integration.oauth.status": 2033,
  "integration.wellknown.add": 2034,
  "location.get": 2035,
  "mcp.add": 2036,
  "mcp.connect": 2037,
  "mcp.disconnect": 2038,
  "mcp.list": 2039,
  "mcp.remove": 2040,
  "mcp.resource.catalog": 2041,
  "model.default": 2042,
  "model.list": 2043,
  "plugin.list": 2044,
  "project.current": 2045,
  "project.directories": 2046,
  "project.forget": 2047,
  "project.inventory": 2048,
  "project.list": 2049,
  "provider.get": 2050,
  "provider.integrations": 2051,
  "provider.list": 2052,
  "provider.refresh": 2053,
  "providerUsage.get": 2054,
  "providerUsage.list": 2055,
  "reference.list": 2056,
  "skill.list": 2057,
  "usage.get": 2058,
  "usage.report": 2059,
} as const

export type ResourceField = {
  name: string
  type: string
  presence: "required" | "optional" | "repeated" | "oneof"
  constraints: readonly Schema.Annotations.Filter[]
  ast?: SchemaAST.AST
  source?: string
}
export type ResourceMessage = { fields: ResourceField[]; oneof: boolean }
const identifier = (value: string) => value.replace(/[^a-zA-Z0-9]/g, "_")

export function resourceSourceIdentity(ast: SchemaAST.AST, hint: string) {
  const named = ast.annotations?.identifier
  const checked = ast.checks?.flatMap((check) =>
    typeof check.annotations?.identifier === "string"
      ? [check.annotations.identifier]
      : Array.isArray(check.annotations?.brands)
        ? check.annotations.brands.filter((brand): brand is string => typeof brand === "string")
        : [],
  )[0]
  const name = String(checked ?? named ?? hint)
  const api: Record<string, string> = {
    ApiScope: "ArtifactScope",
    ApiListScope: "ArtifactListScope",
    ApiQuery: "ArtifactQuery",
    ApiMutation: "ArtifactMutation",
    ApiCreate: "ArtifactCreate",
    ApiExpectation: "ArtifactExpectation",
    ApiRevert: "ArtifactRevert",
    ApiGlobalMutationConfirmation: "GlobalMutationConfirmation",
    ApiMutationResult: "ArtifactMutationResult",
    ApiConfirmationPreview: "ConfirmationPreview",
    ApiTrashSummary: "ArtifactTrashSummary",
    ApiListItem: "ArtifactListItem",
    ApiMetrics: "MetricsResponse",
  }
  const parts = name.split(/[._]/)
  if (parts[0] === "ProjectArtifact" && parts[1]?.startsWith("Api"))
    return `packages/protocol/src/groups/project-artifact.ts#${api[parts[1]] ?? "ProjectArtifactGroup"}`
  if (parts[0].startsWith("Artifact") && parts[0].endsWith("Error") === false)
    return `packages/protocol/src/groups/project-artifact.ts#${parts[0]}`
  if (parts[0].endsWith("Error")) return `packages/protocol/src/errors.ts#${parts[0]}`
  if (parts[0] === "LocationQuery") return "packages/protocol/src/groups/location.ts#LocationQuery"
  if (parts[0] === "ProjectInventoryQuery") return "packages/protocol/src/groups/project.ts#ProjectInventoryQuery"
  if (parts[0] === "ProjectInventoryResponse") return "packages/protocol/src/groups/project.ts#ProjectGroup"
  const modules: Record<string, string> = {
    Agent: "agent",
    Command: "command",
    Config: "config",
    Connection: "connection",
    Integration: "integration",
    Location: "location",
    Mcp: "mcp",
    Model: "model",
    Money: "money",
    Permission: "permission",
    Plugin: "plugin",
    Project: "project",
    ProjectArtifact: "project-artifact",
    Provider: "provider",
    ProviderRequest: "provider-request",
    ProviderUsage: "provider-usage",
    Reference: "reference",
    Skill: "skill",
    TokenUsage: "token-usage",
  }
  if (modules[parts[0]]) return `packages/schema/src/${modules[parts[0]]}.ts#${parts[0]}.${parts[1] ?? "Info"}`
  const group = resourceEndpoints()
    .find(
      ({ endpoint }) =>
        identifier(endpoint.identifier) === hint.split("_Request")[0] ||
        identifier(endpoint.identifier) === hint.split("_Result")[0],
    )
    ?.group.slice(7)
  if (!group) throw new Error(`no source owner: ${hint}`)
  return `packages/protocol/src/groups/${group.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.ts#${group[0].toUpperCase() + group.slice(1)}Group`
}

export function resourceContract() {
  const contract = wireContract(resourceEndpoints(), resourceIDs, resourceSourceIdentity, middlewareErrors)
  const sources = contract.enums.get("ProviderUsage_Source")
  if (sources)
    contract.enums.set("ProviderUsage_Source", [
      ...sources.filter((source) => source !== "response_stream"),
      ...sources.filter((source) => source === "response_stream"),
    ])
  return contract
}

export function resourceSharedSet() {
  const contract = resourceContract()
  const names = new Set<string>()
  const seen = new Set<SchemaAST.AST>()
  const visit = (input: SchemaAST.AST) => {
    const ast = Schema.toType(Schema.make(input)).ast
    if (seen.has(ast)) return
    seen.add(ast)
    if (typeof ast.annotations?.identifier === "string") names.add(identifier(ast.annotations.identifier))
    if (ast._tag === "Declaration") ast.typeParameters.forEach(visit)
    if (ast._tag === "Objects") {
      ast.propertySignatures.forEach((property) => visit(property.type))
      ast.indexSignatures.forEach((signature) => {
        visit(signature.parameter)
        visit(signature.type)
      })
    }
    if (ast._tag === "Arrays") {
      ast.elements.forEach(visit)
      ast.rest.forEach(visit)
    }
    if (ast._tag === "Union") ast.types.forEach(visit)
    if (ast._tag === "Suspend") visit(ast.thunk())
  }
  for (const endpoint of allEndpoints().filter((endpoint) => !(endpoint.identifier in resourceIDs))) {
    if (endpoint.params) visit(endpoint.params.ast)
    if (endpoint.query) visit(endpoint.query.ast)
    for (const payload of endpoint.payload.values()) payload.schemas.forEach((schema) => visit(schema.ast))
    endpoint.success.forEach((schema) => visit(schema.ast))
    endpoint.error.forEach((schema) => visit(schema.ast))
  }
  middlewareErrors.forEach((error) => visit(error.ast))
  const shared = new Set<string>()
  const include = (name: string) => {
    if (shared.has(name) || (!contract.messages.has(name) && !contract.enums.has(name))) return
    shared.add(name)
    contract.messages.get(name)?.fields.forEach((field) => include(field.type))
  }
  names.forEach(include)
  return shared
}

export function resourceFieldConstraints(field: ResourceField): Constraints {
  const bounds: Constraints = { domainObligations: field.source ? [field.source] : [] }
  if (["int64", "uint64"].includes(field.type)) {
    bounds.integerMin = field.type === "uint64" ? "0" : "-9007199254740991"
    bounds.integerMax = "9007199254740991"
    if (field.ast) {
      const document = Schema.toJsonSchemaDocument(Schema.make(field.ast))
      const visit = (input: unknown): void => {
        if (typeof input !== "object" || input === null) return
        if ("minimum" in input && typeof input.minimum === "number") bounds.integerMin = String(input.minimum)
        if ("exclusiveMinimum" in input && typeof input.exclusiveMinimum === "number")
          bounds.integerMin = String(Math.floor(input.exclusiveMinimum) + 1)
        if ("maximum" in input && typeof input.maximum === "number") bounds.integerMax = String(input.maximum)
        if ("exclusiveMaximum" in input && typeof input.exclusiveMaximum === "number")
          bounds.integerMax = String(Math.ceil(input.exclusiveMaximum) - 1)
        if ("$ref" in input && typeof input.$ref === "string") visit(document.definitions[input.$ref.slice(8)])
        if ("allOf" in input && Array.isArray(input.allOf)) input.allOf.forEach(visit)
        if ("anyOf" in input && Array.isArray(input.anyOf)) input.anyOf.forEach(visit)
      }
      visit(document.schema)
    }
  }
  for (const constraint of field.constraints) {
    if (constraint["~structural"] !== true) continue
    const meta = constraint.meta
    if (typeof meta !== "object" || meta === null) continue
    const min = "minLength" in meta && typeof meta.minLength === "number" ? meta.minLength : undefined
    const max = "maxLength" in meta && typeof meta.maxLength === "number" ? meta.maxLength : undefined
    if (field.type === "LosslessString") {
      bounds.utf16Min = min ?? bounds.utf16Min
      bounds.utf16Max = max ?? bounds.utf16Max
    }
    if (field.presence === "repeated") {
      bounds.countMin = min ?? bounds.countMin
      bounds.countMax = max ?? bounds.countMax
    }
  }
  return bounds
}

function fieldOption(field: ResourceField) {
  const constraints = resourceFieldConstraints(field)
  const entries = Object.entries(constraints).flatMap(([name, value]) =>
    value === undefined
      ? []
      : Array.isArray(value)
        ? value.map((item) => `domain_obligations: ${JSON.stringify(item)}`)
        : [
            `${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}: ${typeof value === "string" ? JSON.stringify(value) : value}`,
          ],
  )
  return entries.length ? ` [(ycoding.v5.constraints) = { ${entries.join(" ")} }]` : ""
}

export function resourceProto(sharedFile = false) {
  const contract = resourceContract()
  const shared = resourceSharedSet()
  return (
    (
      'syntax = "proto2";\npackage ycoding.v5;\nimport "ycoding/v5/foundation.proto";\nimport "ycoding/v5/operations.proto";\n' +
      (sharedFile ? "" : 'import "ycoding/v5/shared.proto";\n') +
      (sharedFile ? "\n" : "\noption (ycoding.v5.operation_range) = { first: 2000 last: 2059 };\n\n") +
      Array.from(contract.enums)
        .filter(([name]) => shared.has(name) === sharedFile)
        .map(
          ([name, values]) =>
            `enum ${name} {\n${values.map((value, index) => `  ${name.toUpperCase()}_${typeof value === "string" ? identifier(value).toUpperCase() : String(value).replace("-", "MINUS_")} = ${index + 1};`).join("\n")}\n}`,
        )
        .join("\n\n") +
      "\n\n" +
      Array.from(contract.messages)
        .filter(([name]) => shared.has(name) === sharedFile)
        .map(
          ([name, message]) =>
            `message ${name} {\n${message.oneof ? "  oneof kind {\n" : ""}${message.fields.map((field, index) => `  ${message.oneof ? "  " : ""}${field.presence === "oneof" ? "" : field.presence + " "}${field.type} ${field.name} = ${index + 1}${fieldOption(field)};`).join("\n")}\n${message.oneof ? "  }\n" : ""}}`,
        )
        .join("\n\n") +
      "\n\n" +
      (sharedFile
        ? ""
        : Array.from(
            new Set(contract.operations.map((operation) => operation.group)),
            (group) =>
              `service ${identifier(group)} {\n${contract.operations
                .filter((operation) => operation.group === group)
                .map(
                  (operation) =>
                    `  rpc ${operation.rpc}(${operation.request}) returns (${operation.result}) {\n    option (ycoding.v5.operation) = {\n      operation_id: ${operation.id}\n      diagnostic_name: ${JSON.stringify(operation.name)}\n${operation.errors.map((error) => `      error_types: "ycoding.v5.${error}"`).join("\n")}\n      roles: LOCAL_CLIENT\n${connectorRoles(operation.name)}      scope: ${["usage.get", "usage.report", "project.list", "project.inventory", "project.forget"].includes(operation.name) ? "MACHINE" : "LOCATION"}\n      mutation: ${operation.method === "GET" ? "READ" : "MUTATION"}\n      settlement: COMPLETED\n      paging: ${operation.name === "usage.report" ? "OFFSET" : operation.name === "project.inventory" ? "CURSOR" : "UNPAGED"}\n      streaming: TYPED_BULK\n      sensitivity: ${["agent.list", "model.list", "model.default", "provider.list", "provider.get", "integration.connect.key", "integration.oauth.connect", "integration.oauth.complete"].includes(operation.name) ? "SECRET" : "PRIVATE"}\n    };\n  }`,
                )
                .join("\n")}\n}`,
          ).join("\n\n")) +
      "\n"
    ).trimEnd() + "\n"
  )
}
import { connectorRoles } from "./connector-source.js"
