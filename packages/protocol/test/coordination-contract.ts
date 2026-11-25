import { HttpApiEndpoint } from "effect/unstable/httpapi"
import { SchemaAST } from "effect"
import { ClientApi } from "../src/client.js"
import { domainLabel, wireContract, withDomainLiteral } from "./wire-contract.js"
import { enumNumbers, messageTags, reservedLine, wireAllocation, type WireAllocation } from "./wire-allocation.js"
import { middlewareErrors } from "./resources-source.js"
import { fieldOption } from "./resources-contract.js"
import { sharedSet } from "./platform-contract.js"

export const coordinationIDs = {
  "coordination.settings": 6000,
  "coordination.list": 6001,
  "coordination.create": 6002,
  "coordination.get": 6003,
  "coordination.update": 6004,
  "coordination.delete": 6005,
  "coordination.attach": 6006,
  "coordination.detach": 6007,
  "coordination.board": 6008,
} as const

export const coordinationRange = { first: 6000, last: 6099 } as const

const identifier = (value: string) => value.replace(/[^a-zA-Z0-9]/g, "_")

type Endpoint = Pick<HttpApiEndpoint.Top, "identifier" | "method" | "params" | "query" | "payload" | "success" | "error">

export function coordinationEndpoints() {
  const group = ClientApi.groups["server.coordination"]
  return Object.values<Endpoint>(group.endpoints).map((endpoint) => ({ group: group.identifier, endpoint }))
}

export function coordinationSourceIdentity(ast: SchemaAST.AST, hint: string) {
  const named = ast.annotations?.identifier
  const checked = ast.checks?.flatMap((check) =>
    typeof check.annotations?.identifier === "string"
      ? [check.annotations.identifier]
      : Array.isArray(check.annotations?.brands)
        ? check.annotations.brands.filter((brand): brand is string => typeof brand === "string")
        : [],
  )[0]
  const name = String(checked ?? named ?? hint)
  if (name.startsWith("Coordination.") || name.startsWith("Coordination_"))
    return `packages/schema/src/coordination.ts#${name.replace("_", ".").split(/[._]/).slice(0, 2).join(".")}`
  if (name.startsWith("SessionID")) return "packages/schema/src/session-id.ts#SessionID"
  if (name.startsWith("Location")) return "packages/schema/src/location.ts#Location.Ref"
  return "packages/protocol/src/groups/coordination.ts#CoordinationGroup"
}

export function coordinationContract(allocation: WireAllocation = wireAllocation) {
  return wireContract(
    coordinationEndpoints(),
    coordinationIDs,
    coordinationSourceIdentity,
    middlewareErrors,
    { "coordination.attach": "coordination_attach_Reply" },
    [],
    allocation,
  )
}

export function coordinationProto(allocation: WireAllocation = wireAllocation) {
  const contract = coordinationContract(allocation)
  const shared = sharedSet()
  const enums = Array.from(contract.enums).filter(([name]) => !shared.has(name))
  const messages = Array.from(contract.messages).filter(([name]) => !shared.has(name))
  return (
    'syntax = "proto2";\npackage ycoding.v5;\nimport "ycoding/v5/foundation.proto";\nimport "ycoding/v5/operations.proto";\nimport "ycoding/v5/shared.proto";\n' +
    `\noption (ycoding.v5.operation_range) = { first: ${coordinationRange.first} last: ${coordinationRange.last} };\n\n` +
    enums
      .map(
        ([name, values]) =>
          `enum ${name} {\n${values.map((value, index) => `  ${name.toUpperCase()}_${identifier(String(value)).toUpperCase()} = ${enumNumbers(name, values, allocation)[index]}${domainLabel(value)};`).join("\n")}\n${reservedLine("enum", name, allocation)}}`,
      )
      .join("\n\n") +
    "\n\n" +
    messages
      .map(
        ([name, message]) =>
          `message ${name} {\n${message.oneof ? "  oneof kind {\n" : ""}${message.fields.map((field, index) => `  ${message.oneof ? "  " : ""}${field.presence === "oneof" ? "" : field.presence + " "}${field.type} ${field.name} = ${messageTags(name, message.fields, allocation)[index]}${withDomainLiteral(fieldOption(field), message, field)};`).join("\n")}\n${message.oneof ? "  }\n" : ""}${reservedLine("message", name, allocation)}}`,
      )
      .join("\n\n") +
    "\n\n" +
    Array.from(
      new Set(contract.operations.map((operation) => operation.group)),
      (group) =>
        `service ${identifier(group)} {\n${contract.operations
          .filter((operation) => operation.group === group)
          .map(
            (operation) =>
              `  rpc ${operation.rpc}(${operation.request}) returns (${operation.result}) {\n    option (ycoding.v5.operation) = {\n      operation_id: ${operation.id}\n      diagnostic_name: ${JSON.stringify(operation.name)}\n${operation.errors.map((error) => `      error_types: "ycoding.v5.${error}"`).join("\n")}\n      roles: LOCAL_CLIENT\n      roles: REMOTE_CLIENT\n      roles: RELAY\n      scope: MACHINE\n      mutation: ${operation.method === "GET" ? "READ" : "MUTATION"}\n      settlement: COMPLETED\n      paging: UNPAGED\n      streaming: TYPED_BULK\n      sensitivity: PRIVATE\n    };\n  }`,
          )
          .join("\n")}\n}`,
    ).join("\n\n") +
    "\n"
  )
}
