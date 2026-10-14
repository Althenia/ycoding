import {
  create,
  encodeStrict,
  encodeLossless,
  decodeLossless,
  encodeRemoteRequest,
  remotePayloadCodecs,
  ScopeSchema,
  ScopeKind,
  LosslessStringSchema,
} from "@ycoding-ai/remote"
import { enumLabels, unionLiterals } from "../../../../packages/client/src/v5/generated/domain"

export type WireSchema = NonNullable<ReturnType<typeof remotePayloadCodecs.get>>["request"]["schema"]
type Field = WireSchema["fields"][number]

export function prepareRemoteRequest(
  operation: string,
  request: {
    readonly sessionID?: string
    readonly workspaceID?: string
    readonly input?: Readonly<Record<string, unknown>>
  },
) {
  const codec = remotePayloadCodecs.get(operation)
  if (!codec) throw new Error("Unknown remote operation")
  const input = request.input ?? {}
  const scope = create(ScopeSchema, {
    target:
      request.sessionID !== undefined
        ? { case: codec.operation.scope === ScopeKind.FORM ? "form" : "session", value: request.sessionID }
        : request.workspaceID !== undefined
          ? { case: "workspace", value: request.workspaceID }
          : { case: "machine", value: {} },
  })
  const fields = Object.fromEntries(
    codec.request.schema.fields.map((field) => {
      if (field.name === "scope") return [field.name, scope]
      if (field.name === "params")
        return [
          field.name,
          Object.fromEntries(
            field.message!.fields.map((parameter) => [
              parameter.name,
              parameter.name === "sessionID" || parameter.name === "parentID"
                ? request.sessionID
                : input[parameter.name],
            ]),
          ),
        ]
      if (field.name === "query" || field.name === "payload") return [field.name, input]
      return [field.name, input[field.name]]
    }),
  )
  const value =
    codec.request.schema.fields.length === 1 && codec.request.schema.fields[0]!.fieldKind === "list"
      ? fields[codec.request.schema.fields[0]!.name]
      : fields
  return { codec, scope, payload: encodeRemoteRequest(operation, writeWireMessage(codec.request.schema, value)) }
}

export function writeWireMessage<T extends WireSchema>(
  schema: T,
  value: unknown,
  depth?: number,
): ReturnType<typeof create<T>>
export function writeWireMessage(schema: WireSchema, value: unknown, depth = 0): ReturnType<typeof create<WireSchema>> {
  if (depth > 200) throw new Error("Domain depth limit")
  if (schema.typeName === ScopeSchema.typeName && object(value).$typeName === ScopeSchema.typeName)
    return value as ReturnType<typeof create<WireSchema>>
  if (schema.typeName === LosslessStringSchema.typeName) {
    if (typeof value !== "string") throw new Error("Expected domain string")
    return encodeLossless(value)
  }
  if (schema.typeName === "ycoding.v5.Value") {
    const kind =
      value === null ? "null" : value instanceof Uint8Array ? "bytes" : Array.isArray(value) ? "list" : typeof value
    const field = schema.fields.find((field) => field.name === kind)
    if (!field) throw new Error("Unsupported open value")
    return create(schema, {
      kind: { case: field.localName, value: writeField(field, kind === "null" ? {} : value, depth + 1) },
    })
  }
  if (schema.fields.length === 1 && schema.fields[0]!.fieldKind === "list") {
    const field = schema.fields[0]!
    if (field.name === "entries" && field.listKind === "message")
      return create(schema, {
        [field.localName]: Object.entries(object(value)).map(([key, value]) =>
          writeFieldItem(field, { key, value }, depth + 1),
        ),
      })
    return create(schema, { [field.localName]: writeField(field, value, depth + 1) })
  }
  if (schema.oneofs.length === 1 && schema.fields.every((field) => field.oneof)) {
    for (const field of schema.fields) {
      if (field.name === "clear" && value === null)
        return create(schema, {
          [schema.oneofs[0]!.localName]: { case: field.localName, value: create(field.message!) },
        })
      const literal = unionLiterals[schema.typeName]?.[field.localName]
      if (literal !== undefined && value !== literal) continue
      if (
        field.fieldKind === "message" &&
        ![LosslessStringSchema.typeName, "ycoding.v5.Value"].includes(field.message.typeName) &&
        !field.message.oneofs.length &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).some((key) => !field.message.fields.some((item) => item.name === key))
      )
        continue
      try {
        const result = create(schema, {
          [schema.oneofs[0]!.localName]: { case: field.localName, value: writeField(field, value, depth + 1) },
        })
        encodeStrict(schema, result)
        return result
      } catch {
        continue
      }
    }
    throw new Error("Domain union has no v5 branch")
  }
  const input = object(value)
  return create(
    schema,
    Object.fromEntries(
      schema.fields.flatMap((field) => {
        if (input[field.name] === undefined) {
          if (field.proto.label === 2)
            throw new Error(`Missing required domain field: ${schema.typeName}.${field.name}`)
          return []
        }
        return [[field.localName, writeField(field, input[field.name], depth + 1)]]
      }),
    ),
  )
}

function writeField(field: Field, value: unknown, depth: number): unknown {
  if (field.fieldKind !== "list") return writeFieldItem(field, value, depth)
  if (!Array.isArray(value)) throw new Error("Expected domain list")
  return value.map((item) => writeFieldItem(field, item, depth))
}

function writeFieldItem(field: Field, value: unknown, depth: number): unknown {
  if (field.fieldKind === "message" || (field.fieldKind === "list" && field.listKind === "message"))
    return writeWireMessage(field.message, value, depth)
  if (field.fieldKind === "enum" || (field.fieldKind === "list" && field.listKind === "enum")) {
    const entry = field.enum.values.find(
      (entry) =>
        (enumLabels[field.enum.typeName]?.[entry.number] ?? presentationEnums[field.enum.typeName]?.[entry.number]) ===
          value ||
        (typeof value === "string" &&
          entry.name === `${field.enum.name.toUpperCase()}_${value.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`),
    )
    if (!entry) throw new Error("Unknown domain enum value")
    return entry.number
  }
  if (field.fieldKind !== "scalar" && field.fieldKind !== "list") throw new Error("Unsupported v5 field")
  if ([3, 4, 6, 16, 18].includes(field.scalar ?? 0)) {
    if (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value)))
      throw new Error("Unsafe domain integer")
    return typeof value === "bigint" ? value : BigInt(value as number)
  }
  if (field.scalar === 12) {
    if (!(value instanceof Uint8Array)) throw new Error("Expected domain bytes")
    return value
  }
  if (typeof value !== (field.scalar === 8 ? "boolean" : field.scalar === 9 ? "string" : "number"))
    throw new Error("Domain scalar type mismatch")
  return value
}

export function readWireMessage(schema: WireSchema, value: unknown): unknown {
  const input = object(value)
  if (schema.typeName === LosslessStringSchema.typeName)
    return decodeLossless(value as ReturnType<typeof create<typeof LosslessStringSchema>>)
  if (schema.typeName === "ycoding.v5.Value") {
    const kind = object(input.kind)
    if (kind.case === "null") return null
    const field = schema.fields.find((field) => field.localName === kind.case)
    if (!field) throw new Error("Missing open value branch")
    return readField(field, kind.value)
  }
  if (schema.fields.length === 1 && schema.fields[0]!.fieldKind === "list") {
    const field = schema.fields[0]!
    const decoded = readField(field, input[field.localName])
    if (field.name !== "entries" || !Array.isArray(decoded)) return decoded
    const entries = decoded.map(object)
    if (new Set(entries.map((entry) => entry.key)).size !== entries.length)
      throw new Error("Duplicate domain object key")
    return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]))
  }
  if (schema.oneofs.length === 1 && schema.fields.every((field) => field.oneof)) {
    const kind = object(input[schema.oneofs[0]!.localName])
    if (kind.case === "none") return undefined
    if (kind.case === "clear") return null
    const field = schema.fields.find((field) => field.localName === kind.case)
    if (!field) throw new Error("Missing domain union branch")
    return readField(field, kind.value)
  }
  return Object.fromEntries(
    schema.fields.flatMap((field) => {
      if (!Object.hasOwn(input, field.localName) || input[field.localName] === undefined) return []
      const decoded = readField(field, input[field.localName])
      return decoded === undefined ? [] : [[field.name, decoded]]
    }),
  )
}

function readField(field: Field, value: unknown): unknown {
  if (field.fieldKind !== "list") return readFieldItem(field, value)
  if (!Array.isArray(value)) throw new Error("Missing v5 collection")
  return value.map((item) => readFieldItem(field, item))
}

function readFieldItem(field: Field, value: unknown): unknown {
  if (field.fieldKind === "message" || (field.fieldKind === "list" && field.listKind === "message"))
    return readWireMessage(field.message, value)
  if (field.fieldKind === "enum" || (field.fieldKind === "list" && field.listKind === "enum"))
    return enumLabel(field, Number(value))
  if (typeof value !== "bigint") return value
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
    throw new Error("Unsafe v5 domain integer")
  return Number(value)
}

function enumLabel(field: Field, number: number) {
  if (field.fieldKind !== "enum" && !(field.fieldKind === "list" && field.listKind === "enum"))
    throw new Error("Expected enum")
  const known = enumLabels[field.enum.typeName]?.[number] ?? presentationEnums[field.enum.typeName]?.[number]
  if (known !== undefined) return known
  if (
    !field.enum.typeName.startsWith("ycoding.v5.Connector_") &&
    !field.enum.typeName.startsWith("ycoding.v5.provider_auth_") &&
    !field.enum.typeName.startsWith("ycoding.v5.session_family_activity_")
  )
    throw new Error(`Missing presentation enum: ${field.enum.typeName}`)
  const entry = field.enum.values.find((entry) => entry.number === number)
  if (!entry) throw new Error("Unknown v5 enum")
  return entry.name.slice(field.enum.name.length + 1).toLowerCase()
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected domain object")
  return value as Record<string, unknown>
}

const presentationEnums: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  "ycoding.v5.SessionsQuery_order": { 3: "pinned" },
  "ycoding.v5.SessionsQuery_searchFields": { 1: "title", 2: "summary" },
}
