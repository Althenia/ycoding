import ts from "typescript"
import { operations, schemas, PeerRole, Streaming } from "@ycoding-ai/protocol/v5"

const sourcePath = `${import.meta.dir}/../src/promise/generated/client.ts`
const boundaryPath = `${import.meta.dir}/../src/v5/frontend-boundary.ts`
const program = ts.createProgram([sourcePath, boundaryPath], {
  strict: true,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ESNext,
  skipLibCheck: true,
})
const checker = program.getTypeChecker()
const source = program.getSourceFile(sourcePath)!
const messages = new Map(schemas.map((schema) => [schema.typeName, schema]))
const labels: Record<string, Record<number, string>> = {}
const literals: Record<string, Record<string, string | number | boolean>> = {}
const visited = new Set<string>()
const aliases = new Map<string, ts.Type>()
const stringLiterals = new Set<string>()
const types = program.getSourceFile(`${import.meta.dir}/../src/promise/generated/types.ts`)!
const collect = (node: ts.Node) => {
  if (ts.isStringLiteral(node)) stringLiterals.add(node.text)
  node.forEachChild(collect)
}
for (const declarations of [types, program.getSourceFile(boundaryPath)!]) {
  declarations.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node))
      aliases.set(node.name.text.replaceAll("_", ""), checker.getTypeAtLocation(node))
  })
  collect(declarations)
}
const normalize = (value: string) => value.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()
const members = (type: ts.Type): ts.Type[] =>
  type.isUnion() ? type.types.filter((item) => !(item.flags & ts.TypeFlags.Undefined)) : [type]
const values = (type: ts.Type): (string | number | boolean)[] =>
  members(type).flatMap<string | number | boolean>((item) => {
    if (item.isStringLiteral() || item.isNumberLiteral()) return [item.value]
    if (item.flags & ts.TypeFlags.BooleanLiteral) return [checker.typeToString(item) === "true"]
    return []
  })
const propertyType = (type: ts.Type, name: string) => {
  const symbol = type.getProperty(name)
  return symbol ? checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? source) : undefined
}
type Schema = (typeof schemas)[number]
type Field = Schema["fields"][number]

function enumLabel(field: Field, type: ts.Type) {
  if (field.fieldKind !== "enum" && !(field.fieldKind === "list" && field.listKind === "enum")) return
  const candidates = values(type).filter((value): value is string => typeof value === "string")
  const prefix = field.enum.name.toUpperCase() + "_"
  for (const value of field.enum.values) {
    const matches = candidates.filter((candidate) => normalize(candidate) === value.name.slice(prefix.length))
    if (matches.length !== 1) continue
    const previous = labels[field.enum.typeName]?.[value.number]
    if (previous !== undefined && previous !== matches[0])
      throw new Error(`conflicting enum label: ${field.enum.typeName}`)
    ;(labels[field.enum.typeName] ??= {})[value.number] = matches[0]
  }
}

function compatible(schema: Schema, type: ts.Type, depth = 0): boolean {
  if (depth > 20) return true
  if (schema.typeName === "ycoding.v5.LosslessString")
    return !!(type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any))
  if (schema.typeName === "ycoding.v5.Value") return true
  if (schema.typeName === "ycoding.v5.Empty")
    return !!(type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Object | ts.TypeFlags.Void))
  if (schema.fields.length === 1 && schema.fields[0].fieldKind === "list")
    return !!type.getNumberIndexType() || !!type.getStringIndexType()
  if (schema.oneofs.length) return true
  if (
    type.flags &
    (ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.Null |
      ts.TypeFlags.Void)
  )
    return false
  if (
    type
      .getProperties()
      .some(
        (property) =>
          !(property.flags & ts.SymbolFlags.Optional) && !schema.fields.some((field) => field.name === property.name),
      )
  )
    return false
  return schema.fields.every((field) => {
    const property = propertyType(type, field.name)
    if (!property) return field.proto.label !== 2
    if (field.fieldKind === "enum") {
      const allowed = values(property).filter((value): value is string => typeof value === "string")
      return (
        !allowed.length ||
        allowed.some((value) =>
          field.enum.values.some((item) => item.name === field.enum.name.toUpperCase() + "_" + normalize(value)),
        )
      )
    }
    if (field.fieldKind === "message")
      return members(property).some((item) => compatible(field.message, item, depth + 1))
    return true
  })
}

function associate(schema: Schema, type: ts.Type) {
  const key = schema.typeName + ":" + checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
  if (visited.has(key)) return
  visited.add(key)
  if (["ycoding.v5.Value", "ycoding.v5.LosslessString", "ycoding.v5.Empty"].includes(schema.typeName)) return
  if (schema.fields.length === 1 && schema.fields[0].fieldKind === "list") {
    const field = schema.fields[0]
    const item = type.getNumberIndexType()
    if (field.name === "entries" && field.listKind === "message") {
      const value = type.getStringIndexType()
      const valueField = field.message.fields.find((item) => item.name === "value")
      if (value && valueField) associateField(valueField, value)
      return
    }
    if (item) associateField(field, item)
    return
  }
  if (schema.oneofs.length === 1 && schema.fields.every((field) => field.oneof)) {
    const choices = members(type)
    schema.fields.forEach((field) => {
      const matching = choices.filter((item) => {
        if (field.name === "clear") return !!(item.flags & ts.TypeFlags.Null)
        if (field.fieldKind === "message") return compatible(field.message, item)
        if (field.fieldKind === "scalar")
          return !!(
            item.flags &
            (field.scalar === 8
              ? ts.TypeFlags.BooleanLike
              : field.scalar === 9
                ? ts.TypeFlags.StringLike
                : ts.TypeFlags.NumberLike)
          )
        return true
      })
      matching.forEach((item) => associateField(field, item))
      const only = matching.length === 1 ? values(matching[0]) : []
      if (only.length === 1 && field.fieldKind === "scalar")
        (literals[schema.typeName] ??= {})[field.localName] = only[0]
    })
    return
  }
  for (const candidate of members(type)) {
    if (!compatible(schema, candidate)) continue
    schema.fields.forEach((field) => {
      const property = propertyType(candidate, field.name)
      if (property) associateField(field, property)
    })
  }
}

function associateField(field: Field, type: ts.Type) {
  enumLabel(field, type)
  if (field.fieldKind === "message" || (field.fieldKind === "list" && field.listKind === "message"))
    associate(field.message, type)
}

const renames: Record<string, string> = {
  "message.list": "session.messages",
  "message.capturedInputs": "session.capturedInputs",
  "pty.connect.token": "pty.connectToken",
  "projectArtifact.artifact.global.confirm": "artifact.confirmGlobal",
  "session.file-change.list": "session.fileChange.list",
  "debug.location.list": "debug.location",
}
function operationName(method: string) {
  if (renames[method]) return renames[method]
  if (method.startsWith("server.telemetry.")) return method.slice("server.".length)
  if (method.startsWith("projectArtifact.artifact.")) return method.slice("projectArtifact.".length)
  if (method.startsWith("file.")) return "fs." + method.slice("file.".length)
  if (
    [
      "permission.create",
      "permission.get",
      "permission.list",
      "permission.reply",
      "question.list",
      "question.reply",
      "question.reject",
      "form.create",
      "form.get",
      "form.state",
      "form.list",
      "form.reply",
      "form.cancel",
      "guardrail.status",
      "guardrail.request.list",
      "guardrail.request.reply",
    ].includes(method)
  )
    return "session." + method
  return method
}
const coverage: { method: string; operation: string; operationID?: number; reason?: string }[] = []
const imports = new Set<string>()
const make = source.statements.find(
  (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "make",
)!
const result = make.body!.statements.find((node): node is ts.ReturnStatement => ts.isReturnStatement(node))!.expression!
if (!ts.isObjectLiteralExpression(result)) throw new Error("client surface")

function emit(object: ts.ObjectLiteralExpression, path: string[] = []): string {
  return (
    "{\n" +
    object.properties
      .map((property) => {
        if (!ts.isPropertyAssignment(property)) throw new Error("surface property")
        const name = ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(source)
        const keys = [...path, name]
        if (ts.isObjectLiteralExpression(property.initializer))
          return `${JSON.stringify(name)}: ${emit(property.initializer, keys)}`
        if (!ts.isArrowFunction(property.initializer)) throw new Error("surface method")
        const arrow = property.initializer
        const method = keys.join(".")
        const operation = operations.find(
          (item) => item.diagnosticName === operationName(method) && item.roles.includes(PeerRole.LOCAL_CLIENT),
        )
        coverage.push({
          method,
          operation: operationName(method),
          operationID: operation?.operationId,
          ...(!operation ? { reason: "No LocalClient operation descriptor" } : {}),
        })
        arrow.parameters.forEach((parameter) => {
          if (parameter.type && ts.isTypeReferenceNode(parameter.type))
            imports.add(parameter.type.typeName.getText(source))
        })
        const params = arrow.parameters.map((parameter) => parameter.getText(source)).join(", ")
        const clientType = "Client" + keys.map((key) => `[${JSON.stringify(key)}]`).join("")
        if (!operation) throw new Error(`No LocalClient operation descriptor: ${method}`)
        const request = messages.get(operation.requestType)!
        const signature = checker.getSignatureFromDeclaration(arrow)!
        const returned = checker.getReturnTypeOfSignature(signature)
        const output =
          operation.streaming === Streaming.EVENTS
            ? checker.getTypeArguments(returned as ts.TypeReference)[0]
            : checker.getAwaitedType(returned)
        const input = arrow.parameters.find((parameter) => parameter.name.getText(source) === "input")
        const parts: Record<string, ts.Expression> = {}
        const visit = (node: ts.Node) => {
          if (
            ts.isObjectLiteralExpression(node) &&
            node.properties.some(
              (property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "method",
            )
          ) {
            node.properties.forEach((property) => {
              if (ts.isPropertyAssignment(property)) parts[property.name.getText(source)] = property.initializer
            })
          }
          node.forEachChild(visit)
        }
        visit(arrow.body)
        const data = request.fields
          .map((field) => {
            if (field.name === "scope") return "scope: transport.globalScope()"
            if (field.name === "params" && field.fieldKind === "message") {
              if (input) associate(field.message, checker.getTypeAtLocation(input))
              return `params: { ${field.message.fields.map((item) => `${JSON.stringify(item.name)}: input[${JSON.stringify(item.name)}]`).join(", ")} }`
            }
            const expression = parts[field.name === "payload" ? "body" : field.name]
            if (expression && field.fieldKind === "message")
              associate(field.message, checker.getTypeAtLocation(expression))
            if (field.name === "headers" && expression && ts.isObjectLiteralExpression(expression))
              return `headers: { ${expression.properties
                .map((property) => {
                  if (!ts.isPropertyAssignment(property)) throw new Error("header property")
                  const key = ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(source)
                  return `${JSON.stringify(key.replaceAll("-", "_"))}: ${property.initializer.getText(source)}`
                })
                .join(", ")} }`
            return `${JSON.stringify(field.name)}: ${expression?.getText(source) ?? "{}"}`
          })
          .join(", ")
        const response = messages.get(operation.resultType)!
        const resultPath: string[] = []
        const empty = parts.empty?.getText(source) === "true"
        if (
          output &&
          operation.streaming !== Streaming.EVENTS &&
          operation.streaming !== Streaming.ASSET_BULK &&
          !empty
        ) {
          let selected = response
          while (!members(output).some((type) => compatible(selected, type))) {
            const data = selected.fields.find((field) => field.name === "data")
            if (selected.fields.length !== 1 || data?.fieldKind !== "message")
              throw new Error(`result association: ${method}`)
            resultPath.push("data")
            selected = data.message
          }
          associate(selected, output)
        }
        if (output && operation.streaming !== Streaming.EVENTS && operation.streaming !== Streaming.ASSET_BULK) {
          const logical =
            response.fields.length === 1 && response.fields[0].name === "data" ? response.fields[0] : undefined
          if (logical?.fieldKind === "message") associate(logical.message, output)
          else associate(response, output)
        }
        const type =
          operation.streaming === Streaming.EVENTS
            ? `StreamValue<ReturnType<${clientType}>>`
            : `Awaited<ReturnType<${clientType}>>`
        const binding = `{ method: ${JSON.stringify(method)}, operationID: ${operation.operationId}, resultPath: ${JSON.stringify(resultPath)}, empty: ${empty} }`
        const identity = input ? "input" : "undefined"
        return `${JSON.stringify(name)}: (${params}) => transport.${operation.streaming === Streaming.EVENTS ? "stream" : "call"}<${type}>(${binding}, { ${data} }, ${identity}, requestOptions)`
      })
      .join(",\n") +
    "\n}"
  )
}
const surface = emit(result)
const familyMethods = [
  ["capturedChanges", "list", "CapturedChanges"],
  ["team", "economics", "TeamEconomics"],
  ["family", "activity", "FamilyActivity"],
] as const
function familyDomainType(schema: Schema): string {
  if (schema.typeName === "ycoding.v5.LosslessString") return "string"
  if (schema.oneofs.length) throw new Error(`Unsupported family union: ${schema.typeName}`)
  const fields = schema.fields.map((field) => {
    const type =
      field.fieldKind === "message" || (field.fieldKind === "list" && field.listKind === "message")
        ? familyDomainType(field.message)
        : field.fieldKind === "enum" || (field.fieldKind === "list" && field.listKind === "enum")
          ? field.enum.values
              .map((value) => {
                const label = value.name.slice(field.enum.name.length + 1).toLowerCase()
                ;(labels[field.enum.typeName] ??= {})[value.number] = label
                return JSON.stringify(label)
              })
              .join(" | ")
          : field.scalar === 8
            ? "boolean"
            : field.scalar === 9
              ? "string"
              : "number"
    return { field, type: field.fieldKind === "list" ? `(${type})[]` : type }
  })
  if (fields.length === 1 && fields[0].field.fieldKind === "list") return fields[0].type
  return `{ ${fields.map(({ field, type }) => `${field.name}${field.proto.label === 2 || field.fieldKind === "list" ? "" : "?"}: ${type}`).join("; ")} }`
}
const familyTypes: string[] = []
const familySurface = familyMethods.map(([group, method, type]) => {
  const name = `session.${group}.${method}`
  const operation = operations.find((item) => item.diagnosticName === name)!
  if (!operation?.roles.includes(PeerRole.LOCAL_CLIENT)) throw new Error(`Missing local family operation: ${name}`)
  const request = messages.get(operation.requestType)!
  const payload = request.fields.find((field) => field.name === "payload")!.message!
  familyTypes.push(`export type ${type}Input = { sessionID: string } & ${familyDomainType(payload)}`)
  familyTypes.push(`export type ${type}Output = ${familyDomainType(messages.get(operation.resultType)!)}`)
  const data = payload.fields.map((field) => `${field.name}: input.${field.name}`).join(", ")
  return `${group}: { ${method}: (input: ${type}Input, requestOptions?: RequestOptions) => transport.call<${type}Output>({ method: ${JSON.stringify(name)}, operationID: ${operation.operationId}, resultPath: [], empty: false }, { payload: { ${data} } }, input, requestOptions) }`
})
familyTypes.push(`export type FamilyOperationError = ${familyDomainType(messages.get("ycoding.v5.Connector_Error")!)}`)
const boundaryMethods = [
  ["provider", "configure", "ProviderConfigureInput", "ProviderConfigureOutput", true],
  ["mcp", "configure", "McpConfigureInput", "McpConfigureOutput", true],
  ["frontendPackage", "resolve", "FrontendPackageResolveInput", "FrontendPackageResolveOutput", true],
  ["remote", "enroll", "RemoteEnrollInput", "RemoteEnrollOutput", false],
] as const
const boundarySurface = boundaryMethods.map(([group, method, input, output, query]) => {
  const operation = operations.find((item) => item.diagnosticName === `${group}.${method}`)!
  if (!operation || operation.roles.length !== 1 || operation.roles[0] !== PeerRole.LOCAL_CLIENT)
    throw new Error(`Missing local-only frontend operation: ${group}.${method}`)
  const request = messages.get(operation.requestType)!
  associate(request.fields.find((field) => field.name === "payload")!.message!, aliases.get(input)!)
  associate(messages.get(operation.resultType)!.fields[0].message!, aliases.get(output)!)
  for (const error of operation.errorTypes) {
    const type = aliases.get(error.slice("ycoding.v5.".length).replaceAll("_", ""))
    if (type) associate(messages.get(error)!, type)
  }
  const payload = request.fields
    .find((field) => field.name === "payload")!
    .message!.fields.map((field) => `${field.name}: input.${field.name}`)
    .join(", ")
  const binding = `{ method: "${group}.${method}", operationID: ${operation.operationId}, resultPath: ["data"], empty: false }`
  return `${group}: { ${group === "frontendPackage" ? "" : `...client.${group},`} ${method}: (input: ${input}, requestOptions?: RequestOptions) => transport.call<${output}>(${binding}, { ${query ? "query: { location: input.location }, " : ""}payload: { ${payload} } }, input, requestOptions) ${group === "remote" ? `, get: (requestOptions?: RequestOptions) => client.remote.get(requestOptions) as Promise<RemoteStatusOutput>` : ""} }`
})
associate(messages.get("ycoding.v5.remote_get_Result_data")!, aliases.get("RemoteStatusOutput")!)
associate(messages.get("ycoding.v5.Location_Info")!, aliases.get("BackendLocationOutput")!)
associate(messages.get("ycoding.v5.skill_list_Result")!, aliases.get("BackendSkillListOutput")!)
const boundaryImports = [
  ...boundaryMethods.flatMap(([, , input, output]) => [input, output]),
  "FrontendBoundaryClient",
  "RemoteStatusOutput",
  "BackendLocationOutput",
  "BackendSkillListOutput",
]
await Bun.write(
  `${import.meta.dir}/../src/v5/generated/frontend-boundary.ts`,
  `import type { YCodingClient } from "../../promise/index.js"\nimport type { RequestOptions } from "../../promise/generated/client.js"\nimport type { LocationGetInput, SkillListInput } from "../../promise/generated/types.js"\nimport type { ${boundaryImports.join(", ")} } from "../frontend-boundary.js"\nimport type { LocalTransport } from "../socket.js"\n${familyTypes.join("\n")}\nfunction bindFamily(transport: LocalTransport, session: YCodingClient["session"]) { return { ...session, ${familySurface.join(",\n")} } }\nexport function bindFrontendBoundary(transport: LocalTransport, client: YCodingClient): Omit<YCodingClient, keyof FrontendBoundaryClient | "session"> & { session: ReturnType<typeof bindFamily> } & { [K in keyof FrontendBoundaryClient]: K extends keyof YCodingClient ? Omit<YCodingClient[K], keyof FrontendBoundaryClient[K]> & FrontendBoundaryClient[K] : FrontendBoundaryClient[K] } { return { ...client, session: bindFamily(transport, client.session), ${boundarySurface.join(",\n")}, location: { ...client.location, get: (input?: LocationGetInput, requestOptions?: RequestOptions) => client.location.get(input, requestOptions) as Promise<BackendLocationOutput> }, skill: { ...client.skill, list: (input?: SkillListInput, requestOptions?: RequestOptions) => client.skill.list(input, requestOptions) as Promise<BackendSkillListOutput> } } }\n`,
)
associate(messages.get("ycoding.v5.PublicEvent")!, aliases.get("ServerEvent")!)
for (const schema of schemas) {
  const logical = aliases.get(schema.name.replaceAll("_", ""))
  if (logical) associate(schema, logical)
}
for (const operation of operations.filter((item) => item.roles.includes(PeerRole.LOCAL_CLIENT))) {
  for (const name of operation.errorTypes) {
    const logical = aliases.get(name.slice("ycoding.v5.".length).replaceAll("_", ""))
    if (logical) associate(messages.get(name)!, logical)
  }
}
const unmapped = schemas.flatMap((schema) =>
  schema.fields.flatMap((field) => {
    if (field.fieldKind !== "enum" && !(field.fieldKind === "list" && field.listKind === "enum")) return []
    if (["foundation", "operations", "connector"].some((name) => schema.file.name.endsWith(name))) return []
    for (const value of field.enum.values) {
      if (labels[field.enum.typeName]?.[value.number] !== undefined) continue
      const matches = [...stringLiterals].filter(
        (literal) => value.name === field.enum.name.toUpperCase() + "_" + normalize(literal),
      )
      if (matches.length === 1) (labels[field.enum.typeName] ??= {})[value.number] = matches[0]
    }
    return field.enum.values
      .filter((value) => labels[field.enum.typeName]?.[value.number] === undefined)
      .map((value) => `${field.enum.typeName}:${value.name}`)
  }),
)
await Bun.write(
  `${import.meta.dir}/../src/v5/generated/surface.ts`,
  `import type { YCodingClient } from "../../promise/index.js"\nimport type { ${[...imports]
    .filter((name) => name !== "RequestOptions")
    .sort()
    .join(
      ", ",
    )} } from "../../promise/generated/types.js"\nimport type { RequestOptions } from "../../promise/generated/client.js"\nimport type { LocalTransport } from "../socket.js"\ntype Client = YCodingClient\ntype StreamValue<T> = T extends AsyncIterable<infer A> ? A : never\nexport const methodCoverage = ${JSON.stringify(coverage, null, 2)} as const\nexport function bind(transport: LocalTransport): Client { return ${surface} }\n`,
)
await Bun.write(
  `${import.meta.dir}/../src/v5/generated/domain.ts`,
  `export const enumLabels: Readonly<Record<string, Readonly<Record<number, string>>>> = ${JSON.stringify(labels, null, 2)}\nexport const unionLiterals: Readonly<Record<string, Readonly<Record<string, string | number | boolean>>>> = ${JSON.stringify(literals, null, 2)}\n`,
)
const formatted = Bun.spawnSync(
  [
    `${import.meta.dir}/../../../node_modules/.bin/prettier`,
    "--write",
    `${import.meta.dir}/../src/v5/generated/surface.ts`,
    `${import.meta.dir}/../src/v5/generated/domain.ts`,
    `${import.meta.dir}/../src/v5/generated/frontend-boundary.ts`,
  ],
  { stdout: "ignore", stderr: "inherit" },
)
if (formatted.exitCode !== 0) throw new Error("Generated v5 formatting failed")
console.log(
  JSON.stringify(
    {
      methods: coverage.length,
      mapped: coverage.filter((item) => item.operationID !== undefined).length,
      unsupported: coverage.filter((item) => item.reason),
      unmappedEnums: [...new Set(unmapped)],
    },
    null,
    2,
  ),
)
