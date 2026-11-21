import { operations, PeerRole, ScopeKind, Streaming } from "@ycoding-ai/protocol/v5"
import { schemaFor } from "./codec.js"
import { methodCoverage } from "./generated/surface.js"
import { globalScope } from "./surface.js"

type Schema = ReturnType<typeof schemaFor>
type Field = Schema["fields"][number]

export function namedOperation(
  name: string,
  params: Readonly<Record<string, string>>,
  body: string | undefined,
  headers: Headers,
) {
  const method = methodCoverage.find((item) => item.method === name || ("cliAlias" in item && item.cliAlias === name))
  const operation = operations.find(
    (item) => item.diagnosticName === (method?.operation ?? name) && item.roles.includes(PeerRole.LOCAL_CLIENT),
  )
  if (!operation) throw new Error(`Operation not found: ${name}`)
  const coverage = method ?? methodCoverage.find((item) => item.operationID === operation.operationId)
  const data: Record<string, unknown> = {}
  const schema = schemaFor(operation.requestType)
  const section = (name: string) => schema.fields.find((field) => field.name === name)?.message
  const path = section("params")
  const query = section("query")
  const pathValues: Record<string, unknown> = {}
  const queryValues: Record<string, unknown> = {}
  const consumed = new Set<string>()
  if (path) {
    for (const field of path.fields) {
      const text = Object.hasOwn(params, field.name) ? params[field.name] : undefined
      if (text === undefined) throw new Error(`Missing path parameter: ${field.name}`)
      pathValues[field.name] = parameter(field, text, field.name)
      consumed.add(field.name)
    }
    data.params = pathValues
  }
  for (const [name, value] of Object.entries(params)) {
    if (consumed.has(name)) continue
    const direct = schema.fields.find((field) => field.name === name && !["params", "query", "payload", "headers", "scope"].includes(name))
    if (direct) {
      data[name] = parameter(direct, value, name)
      continue
    }
    const key = /^([\w-]+)(?:\[([\w-]+)\])?$/.exec(name)
    const field = key ? query?.fields.find((field) => field.name === key[1]) : undefined
    if (!field || !key) throw new Error(`Unknown query parameter: ${name}`)
    if (key[2] !== undefined) {
      const child = field.message?.fields.find((child) => child.name === key[2])
      const current = queryValues[field.name]
      if (!child || (current !== undefined && !isRecord(current))) throw new Error(`Invalid query parameter: ${name}`)
      queryValues[field.name] = { ...current, [child.name]: parameter(child, value, name) }
    } else {
      if (Object.hasOwn(queryValues, field.name)) throw new Error(`Conflicting query parameter: ${name}`)
      queryValues[field.name] = parameter(field, value, name)
    }
  }
  const selector = readLocation(headers)
  if (selector && operation.scope === ScopeKind.SESSION)
    throw new Error("Use sessionID or parentID to select the Session; v5 does not accept Location overrides for Session operations")
  if (query) {
    if (selector && query.fields.some((field) => field.name === "location")) {
      const requested = queryValues.location
      if (requested !== undefined && !isRecord(requested)) throw new Error("Invalid Location query")
      queryValues.location = locationWithSelector(requested, selector)
    }
    data.query = queryValues
  }
  const payload = schema.fields.find((field) => field.name === "payload")
  if (payload) {
    data.payload = body === undefined ? {} : json(body, "Invalid JSON request body")
    if (operation.diagnosticName === "session.create" && selector && isRecord(data.payload) && data.payload.location !== undefined) {
      const selected = data.payload.location
      if (!isRecord(selected)) throw new Error("Invalid Session Location")
      const location = locationWithSelector({ directory: selected.directory, workspace: selected.workspaceID }, selector)
      data.payload = { ...data.payload, location: { directory: location.directory, workspaceID: location.workspace } }
    }
  } else if (body !== undefined) {
    throw new Error(`Operation does not accept a request body: ${name}`)
  }
  const headerFields = section("headers")
  if (headerFields) {
    data.headers = Object.fromEntries(headerFields.fields.map((field) => {
      const name = field.name.replaceAll("_", "-")
      const value = headers.get(name)
      if (value === null) throw new Error(`Missing request header: ${name}`)
      return [field.name, parameter(field, value, name)]
    }))
  }
  for (const field of schema.fields) {
    if (field.name === "scope" && field.message?.typeName === "ycoding.v5.Scope") data.scope = globalScope()
  }
  const binding = {
    method: operation.diagnosticName,
    operationID: operation.operationId,
    resultPath: coverage && "cliResultPath" in coverage ? coverage.cliResultPath : [],
    empty: coverage && "empty" in coverage ? coverage.empty : false,
  }
  return { binding, data, stream: operation.streaming === Streaming.EVENTS }
}

function readLocation(headers: Headers) {
  const directory = headers.get("x-ycoding-directory")
  const workspace = headers.get("x-ycoding-workspace")
  if (directory === null && workspace === null) return undefined
  return { directory: directory === null ? undefined : decodeURIComponent(directory), workspace: workspace ?? undefined }
}

function locationWithSelector(location: Record<string, unknown> | undefined, selector: NonNullable<ReturnType<typeof readLocation>>) {
  for (const key of ["directory", "workspace"] as const) {
    if (location?.[key] !== undefined && selector[key] !== undefined && location[key] !== selector[key])
      throw new Error(`Conflicting Location ${key} selectors`)
  }
  return { directory: location?.directory ?? selector.directory, workspace: location?.workspace ?? selector.workspace }
}

function parameter(field: Field, text: string, name: string): unknown {
  const invalid = () => new Error(`Invalid parameter: ${name}`)
  if (field.fieldKind === "list") {
    if (!text.startsWith("[")) return [parameterValue(field, text, invalid)]
    const list = json(text, invalid().message)
    if (Array.isArray(list)) return list
    throw invalid()
  }
  return parameterValue(field, text, invalid)
}

function parameterValue(field: Field, text: string, invalid: () => Error): unknown {
  if (field.fieldKind === "enum" || field.fieldKind === "list" && field.listKind === "enum") return text
  if (field.message) {
    if (field.message.typeName === "ycoding.v5.LosslessString") return text
    if (field.message.oneofs.length === 1 && field.message.fields.every((branch) => branch.oneof)) {
      if (text === "null" && field.message.fields.some((branch) => branch.name === "clear")) return null
      for (const branch of field.message.fields) {
        if (branch.name === "none" || branch.name === "clear") continue
        try {
          return parameterValue(branch, text, invalid)
        } catch {
          continue
        }
      }
      throw invalid()
    }
    return json(text, invalid().message)
  }
  const scalar = Number(field.scalar)
  if (scalar === 9) return text
  if (scalar === 8) {
    if (text === "true" || text === "false") return text === "true"
    throw invalid()
  }
  if (field.scalar !== undefined && scalar !== 12 && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    const value = Number(text)
    if (Number.isFinite(value)) return value
  }
  throw invalid()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function json(text: string, message: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(message)
  }
}
