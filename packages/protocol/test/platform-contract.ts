import { SchemaAST } from "effect"
import { domainLabel, wireContract, wireSharedSet, withDomainLiteral } from "./wire-contract.js"
import { enumNumbers, messageTags, reservedLine, wireAllocation, type WireAllocation } from "./wire-allocation.js"
import { middlewareErrors, allEndpoints } from "./resources-source.js"
import { resourceSharedSet, resourceContract, resourceFieldConstraints, resourceProto } from "./resources-contract.js"
import { platformRpcEndpoints, platformExclusions, assetSource } from "./platform-source.js"
import type { WireField } from "./wire-contract.js"
import { connectorRoles } from "./connector-source.js"

export const platformIDs = {
  "browser.action": 3000,
  "browser.close": 3001,
  "browser.control": 3002,
  "browser.forget": 3003,
  "browser.observe": 3004,
  "browser.open": 3005,
  "browser.release": 3006,
  "browser.start": 3007,
  "browser.status": 3008,
  "browser.stop": 3009,
  "browser.tabs": 3010,
  "debug.location": 3011,
  "debug.location.evict": 3012,
  "fs.find": 3013,
  "fs.list": 3014,
  "fs.read": 3015,
  "health.get": 3016,
  "health.stop": 3017,
  "isolatedBrowser.action": 3018,
  "isolatedBrowser.control": 3019,
  "isolatedBrowser.observe": 3020,
  "isolatedBrowser.start": 3021,
  "isolatedBrowser.status": 3022,
  "isolatedBrowser.stop": 3023,
  "isolatedBrowser.tabs": 3024,
  "keepAwake.get": 3025,
  "keepAwake.set": 3026,
  "projectCopy.create": 3027,
  "projectCopy.refresh": 3028,
  "projectCopy.remove": 3029,
  "pty.connectToken": 3030,
  "pty.control": 3031,
  "pty.create": 3032,
  "pty.get": 3033,
  "pty.list": 3034,
  "pty.remove": 3035,
  "pty.update": 3036,
  "remote.get": 3037,
  "remote.set": 3038,
  "server.get": 3039,
  "shell.create": 3040,
  "shell.get": 3041,
  "shell.list": 3042,
  "shell.output": 3043,
  "shell.remove": 3044,
  "shell.timeout": 3045,
  "telemetry.append": 3046,
  "telemetry.consent.get": 3047,
  "telemetry.consent.set": 3048,
  "telemetry.list": 3049,
  "vcs.branch": 3050,
  "vcs.diff": 3051,
  "vcs.status": 3052,
} as const

export const platformResultNames = {
  "browser.action": "browser_action_Reply",
  "isolatedBrowser.action": "isolatedBrowser_action_Reply",
} as const

export function platformSourceIdentity(ast: SchemaAST.AST, hint: string): string {
  const name = String(ast.annotations?.identifier ?? hint)
  const module = name.split(/[._]/)[0]
  if (name.startsWith("Pty.OwnedLocationQuery") || name.startsWith("Pty_OwnedLocationQuery"))
    return "packages/protocol/src/groups/pty.ts#OwnedLocationQuery"
  const modules: Record<string, string> = {
    Browser: "browser",
    IsolatedBrowser: "isolated-browser",
    KeepAwake: "keep-awake",
    FileSystem: "filesystem",
    Vcs: "vcs",
    FileDiff: "file-diff",
    ProjectCopy: "project-copy",
    Pty: "pty",
    PtyTicket: "pty-ticket",
    Shell: "shell",
    Telemetry: "telemetry",
    Remote: "remote",
    Location: "location",
  }
  if (module === "Pty" && (name === "Pty" || /^[a-z]/.test(name.split(/[._]/)[1] ?? "")))
    return "packages/schema/src/pty.ts#Pty.Info"
  if (modules[module]) return `packages/schema/src/${modules[module]}.ts#${module}.${name.split(/[._]/)[1] ?? "Info"}`
  if (module.endsWith("Error"))
    return `packages/protocol/src/${module === "ProjectCopyError" ? "groups/project-copy.ts" : "errors.ts"}#${module}`
  if (module === "Platform") return assetSource
  if (name === "ServiceHealth" || name === "ServiceStopRequest" || name === "ServiceStopResponse")
    return `packages/protocol/src/groups/health.ts#ServiceStatus.${name.replace("Service", "")}`
  if (name === "LocationQuery") return "packages/protocol/src/groups/location.ts#LocationQuery"
  const operation = platformRpcEndpoints().find(({ endpoint }) =>
    hint.startsWith(endpoint.identifier.replace(/[^a-zA-Z0-9]/g, "_") + "_"),
  )
  if (!operation) throw new Error(`no platform source owner: ${name}`)
  const group = operation.group.slice(7)
  const file = group.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
  const symbol: Record<string, string> = {
    browser: "makeBrowserGroup",
    isolatedBrowser: "makeIsolatedBrowserGroup",
    fs: "FileSystemGroup",
    vcs: "VcsGroup",
    pty: "PtyGroup",
    shell: "ShellGroup",
    server: "ServerGroup",
    health: "HealthGroup",
    debug: "DebugGroup",
    keepAwake: "KeepAwakeGroup",
    remote: "RemoteGroup",
    projectCopy: "ProjectCopyGroup",
  }
  return `packages/protocol/src/groups/${file}.ts#${symbol[group]}`
}

export function platformContract(endpoints = platformRpcEndpoints(), allocation: WireAllocation = wireAllocation) {
  const contract = wireContract(
    [...endpoints].sort((a, b) => a.endpoint.identifier.localeCompare(b.endpoint.identifier)),
    platformIDs,
    platformSourceIdentity,
    middlewareErrors,
    platformResultNames,
    [],
    allocation,
  )
  const path = contract.messages.get("Platform_AssetPath")!.fields[0]
  path.source = assetSource
  contract.messages
    .get("FileSystem_Entry")!
    .fields.push({ name: "uri", type: "LosslessString", presence: "optional", constraints: [] })
  for (const name of ["fs_find_Result", "shell_output_Result"])
    contract.messages.get(name)!.fields.find((field) => field.name === "location")!.presence = "optional"
  return contract
}

export function platformFieldConstraints(field: WireField) {
  return resourceFieldConstraints(field)
}

export function platformPolicy(name: string, method: string) {
  const session = name.startsWith("browser.") || name.startsWith("isolatedBrowser.")
  const machine =
    name.startsWith("health.") ||
    name.startsWith("server.") ||
    name.startsWith("telemetry.") ||
    name.startsWith("keepAwake.") ||
    name.startsWith("remote.") ||
    name === "debug.location"
  return {
    scope: session ? "SESSION" : machine ? "MACHINE" : "LOCATION",
    mutation: method === "GET" ? "READ" : "MUTATION",
    paging: name === "telemetry.list" ? "CURSOR" : name === "shell.output" ? "OFFSET" : "UNPAGED",
    streaming: name === "fs.read" ? "ASSET_BULK" : "TYPED_BULK",
    sensitivity: ["browser.start", "pty.connectToken", "shell.create"].includes(name) ? "SECRET" : "PRIVATE",
  }
}

export function platformSharedSet() {
  return wireSharedSet(
    platformContract(),
    allEndpoints()
      .filter((endpoint) => !(endpoint.identifier in platformIDs) && !(endpoint.identifier in platformExclusions))
      .map((endpoint) => ({ group: "", endpoint })),
    middlewareErrors,
  )
}

export function sharedSet() {
  return new Set([...resourceSharedSet(), ...platformSharedSet()])
}

export function sharedProto(allocation: WireAllocation = wireAllocation) {
  const contract = platformContract(undefined, allocation)
  const moved = new Set([...platformSharedSet()].filter((name) => !resourceSharedSet().has(name)))
  return (
    resourceProto(true, allocation).trimEnd() +
    "\n\n" +
    platformDeclarations(contract, moved, allocation).trimEnd() +
    "\n"
  )
}

function platformDeclarations(
  contract: ReturnType<typeof platformContract>,
  names: ReadonlySet<string>,
  allocation: WireAllocation,
) {
  return (
    [...contract.enums]
      .filter(([name]) => names.has(name))
      .map(
        ([name, values]) =>
          `enum ${name} {\n${values
            .map(
              (value, index) =>
                `  ${name.toUpperCase()}_${String(value)
                  .replace(/[^a-zA-Z0-9]/g, "_")
                  .toUpperCase()} = ${enumNumbers(name, values, allocation)[index]}${domainLabel(value)};`,
            )
            .join("\n")}\n${reservedLine("enum", name, allocation)}}`,
      )
      .join("\n\n") +
    "\n\n" +
    [...contract.messages]
      .filter(([name]) => names.has(name))
      .map(
        ([name, message]) =>
          `message ${name} {\n${message.oneof ? "  oneof kind {\n" : ""}${message.fields.map((field, index) => `  ${message.oneof ? "  " : ""}${field.presence === "oneof" ? "" : field.presence + " "}${field.type} ${field.name} = ${messageTags(name, message.fields, allocation)[index]}${withDomainLiteral(platformFieldOption(field), message, field)};`).join("\n")}\n${message.oneof ? "  }\n" : ""}${reservedLine("message", name, allocation)}}`,
      )
      .join("\n\n")
  )
}

function platformFieldOption(field: WireField) {
  const entries = Object.entries(platformFieldConstraints(field)).flatMap(([name, value]) =>
    value === undefined
      ? []
      : Array.isArray(value)
        ? value.map((source) => `domain_obligations: ${JSON.stringify(source)}`)
        : [`${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}: ${JSON.stringify(value)}`],
  )
  return entries.length ? ` [(ycoding.v5.constraints) = { ${entries.join(" ")} }]` : ""
}

export function platformProto(
  endpoints = platformRpcEndpoints(),
  moveShared = true,
  allocation: WireAllocation = wireAllocation,
) {
  const contract = platformContract(endpoints, allocation)
  const shared = moveShared ? sharedSet() : resourceSharedSet()
  const resources = resourceContract()
  for (const name of [...contract.messages.keys(), ...contract.enums.keys()]) {
    if ((resources.messages.has(name) || resources.enums.has(name)) && !shared.has(name))
      throw new Error(`resource-owned declaration is not shared: ${name}`)
  }
  return (
    (
      'syntax = "proto2";\npackage ycoding.v5;\nimport "ycoding/v5/foundation.proto";\nimport "ycoding/v5/operations.proto";\nimport "ycoding/v5/shared.proto";\n\noption (ycoding.v5.operation_range) = { first: 3000 last: 3052 };\n\n' +
      platformDeclarations(
        contract,
        new Set([...contract.enums.keys(), ...contract.messages.keys()].filter((name) => !shared.has(name))),
        allocation,
      ) +
      "\n\n" +
      [...new Set(contract.operations.map((operation) => operation.group))]
        .map(
          (group) =>
            `service ${group.replace(/[^a-zA-Z0-9]/g, "_")} {\n${contract.operations
              .filter((operation) => operation.group === group)
              .map((operation) => {
                const policy = platformPolicy(operation.name, operation.method)
                return `  rpc ${operation.rpc}(${operation.request}) returns (${operation.result}) {\n    option (ycoding.v5.operation) = {\n      operation_id: ${operation.id}\n      diagnostic_name: ${JSON.stringify(operation.name)}\n${operation.errors.map((name) => `      error_types: "ycoding.v5.${name}"`).join("\n")}\n      roles: LOCAL_CLIENT\n${connectorRoles(operation.name)}      scope: ${policy.scope}\n      mutation: ${policy.mutation}\n      settlement: COMPLETED\n      paging: ${policy.paging}\n      streaming: ${policy.streaming}\n      sensitivity: ${policy.sensitivity}\n    };\n  }`
              })
              .join("\n")}\n}`,
        )
        .join("\n\n")
    ).trimEnd() + "\n"
  )
}
