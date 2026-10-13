import { Buffer } from "node:buffer"
import {
  schemas,
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  decodeLossless,
  LosslessStringSchema,
  WireLimit,
} from "@ycoding-ai/protocol/v5"
import { enumLabels, unionLiterals } from "./generated/domain.js"

type Schema = (typeof schemas)[number]
type Field = Schema["fields"][number]
type EncodingBudget = { maximumBytes: number; bytes: number; fields: number }
const registry = new Map(schemas.map((schema) => [schema.typeName, schema]))

export function schemaFor(name: string) {
  const schema = registry.get(name)
  if (!schema) throw new Error("Unknown v5 message type")
  return schema
}

export function encodeDomain(name: string, value: unknown, maximumBytes: number = WireLimit.BULK_MESSAGE_BYTES) {
  const schema = schemaFor(name)
  const message = toMessage(schema, value, 0, { maximumBytes, bytes: 0, fields: 0 })
  if (encodedBytes(schema, message) > maximumBytes) throw new Error("Encoded domain byte limit")
  return encodeStrict(schema, message)
}

export function decodeDomain(name: string, bytes: Uint8Array): unknown {
  const schema = schemaFor(name)
  return fromMessage(schema, decodeStrict(schema, bytes))
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected domain object")
  return value as Record<string, unknown>
}

function toMessage(
  schema: Schema,
  value: unknown,
  depth: number,
  work: EncodingBudget,
): ReturnType<typeof create<Schema>> {
  if (depth > 200) throw new Error("Domain depth limit")
  if (
    schema.typeName === "ycoding.v5.Scope" &&
    typeof value === "object" &&
    value !== null &&
    "$typeName" in value &&
    value.$typeName === schema.typeName
  )
    return value as ReturnType<typeof create<Schema>>
  if (schema.typeName === "ycoding.v5.LosslessString") {
    if (typeof value !== "string") throw new Error("Expected domain string")
    if (value.length > work.maximumBytes - work.bytes) throw new Error("Domain byte limit")
    const encoded = encodeLossless(value)
    charge(work, encoded.encoding.case === "utf16LeUnits" ? encoded.encoding.value.length : Buffer.byteLength(value))
    if (++work.fields > WireLimit.TOTAL_FIELDS) throw new Error("Domain field limit")
    return encoded
  }
  if (schema.typeName === "ycoding.v5.Value") {
    const branch =
      value === null ? "null" : value instanceof Uint8Array ? "bytes" : Array.isArray(value) ? "list" : typeof value
    const field = schema.fields.find((field) => field.name === branch)
    if (!field) throw new Error("Unsupported open value")
    return create(schema, {
      kind: { case: field.localName, value: toField(field, branch === "null" ? {} : value, depth + 1, work) },
    })
  }
  if (schema.fields.length === 1 && schema.fields[0].fieldKind === "list") {
    const field = schema.fields[0]
    if (field.name === "entries" && field.listKind === "message") {
      const entries = Object.entries(record(value))
      if (entries.length > WireLimit.TOTAL_FIELDS - work.fields) throw new Error("Domain field limit")
      return create(schema, {
        [field.localName]: entries.map(([key, value]) => toField(field, { key, value }, depth + 1, work)),
      })
    }
    if (!Array.isArray(value)) throw new Error("Expected domain list")
    if (value.length > WireLimit.TOTAL_FIELDS - work.fields) throw new Error("Domain field limit")
    return create(schema, { [field.localName]: value.map((item) => toField(field, item, depth + 1, work)) })
  }
  if (schema.oneofs.length === 1 && schema.fields.every((field) => field.oneof)) {
    const matches = schema.fields.flatMap((field) => {
      if (field.name === "clear")
        return value === null ? [{ field, value: create(field.message!), bytes: 0, fields: 1 }] : []
      const literal = unionLiterals[schema.typeName]?.[field.localName]
      if (literal !== undefined && value !== literal) return []
      if (
        field.fieldKind === "message" &&
        field.message.typeName !== "ycoding.v5.LosslessString" &&
        field.message.typeName !== "ycoding.v5.Value" &&
        field.message.oneofs.length === 0 &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        if (Object.keys(value).some((key) => !field.message.fields.some((item) => item.name === key))) return []
      }
      const before = { bytes: work.bytes, fields: work.fields }
      try {
        const converted = toField(field, value, depth + 1, work)
        const message = create(schema, { [schema.oneofs[0].localName]: { case: field.localName, value: converted } })
        if (encodedBytes(schema, message) > work.maximumBytes) throw new Error("Encoded domain byte limit")
        encodeStrict(schema, message)
        return [{ field, value: converted, bytes: work.bytes - before.bytes, fields: work.fields - before.fields }]
      } catch {
        return []
      } finally {
        work.bytes = before.bytes
        work.fields = before.fields
      }
    })
    if (!matches.length) throw new Error("Domain union has no v5 branch")
    work.bytes += matches[0].bytes
    work.fields += matches[0].fields
    return create(schema, {
      [schema.oneofs[0].localName]: { case: matches[0].field.localName, value: matches[0].value },
    })
  }
  const input = record(value)
  const output: Record<string, unknown> = {}
  schema.fields.forEach((field) => {
    if (!Object.hasOwn(input, field.name) || input[field.name] === undefined) {
      if (field.proto.label === 2) throw new Error("Missing required domain field")
      return
    }
    output[field.localName] = toField(field, input[field.name], depth + 1, work)
  })
  return create(schema, output)
}

function toField(field: Field, value: unknown, depth: number, work: EncodingBudget): unknown {
  if (++work.fields > WireLimit.TOTAL_FIELDS) throw new Error("Domain field limit")
  if (field.fieldKind === "message" || (field.fieldKind === "list" && field.listKind === "message"))
    return toMessage(field.message, value, depth, work)
  if (field.fieldKind === "enum" || (field.fieldKind === "list" && field.listKind === "enum")) {
    const match = Object.entries(enumLabels[field.enum.typeName] ?? {}).find((entry) => entry[1] === value)
    if (!match) throw new Error("Unknown domain enum value")
    return Number(match[0])
  }
  if (field.fieldKind !== "scalar" && field.fieldKind !== "list") throw new Error("Unsupported v5 field")
  if ([3, 4, 6, 16, 18].includes(field.scalar ?? 0)) {
    if (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value)))
      throw new Error("Unsafe domain integer")
    const integer = typeof value === "bigint" ? value : BigInt(value as number)
    const unsigned = [4, 6].includes(field.scalar ?? 0)
    if (integer < (unsigned ? 0n : -(1n << 63n)) || integer > (unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n))
      throw new Error("Domain integer range")
    return integer
  }
  if (field.scalar === 12) {
    if (!(value instanceof Uint8Array)) throw new Error("Expected domain bytes")
    charge(work, value.length)
    return value
  }
  if (typeof value !== (field.scalar === 8 ? "boolean" : field.scalar === 9 ? "string" : "number"))
    throw new Error("Domain scalar type mismatch")
  if (
    [5, 7, 13, 15, 17].includes(field.scalar ?? 0) &&
    (typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < ([7, 13].includes(field.scalar ?? 0) ? 0 : -2147483648) ||
      value > ([7, 13].includes(field.scalar ?? 0) ? 4294967295 : 2147483647))
  )
    throw new Error("Domain integer range")
  if (typeof value === "string") charge(work, Buffer.byteLength(value))
  return value
}

function charge(work: EncodingBudget, bytes: number) {
  if (bytes > work.maximumBytes - work.bytes) throw new Error("Domain byte limit")
  work.bytes += bytes
}

function fromMessage(schema: Schema, value: unknown): unknown {
  const input = record(value)
  if (schema.typeName === "ycoding.v5.LosslessString")
    return decodeLossless(value as ReturnType<typeof create<typeof LosslessStringSchema>>)
  if (schema.typeName === "ycoding.v5.Value") {
    const selected = record(input.kind)
    if (selected.case === "null") return null
    const field = schema.fields.find((field) => field.localName === selected.case)
    if (!field) throw new Error("Missing open value branch")
    return fromField(field, selected.value)
  }
  if (schema.fields.length === 1 && schema.fields[0].fieldKind === "list") {
    const field = schema.fields[0]
    const items = input[field.localName]
    if (!Array.isArray(items)) throw new Error("Missing v5 collection")
    if (field.name === "entries" && field.listKind === "message") {
      const entries = items.map((item) => record(fromMessage(field.message, item)))
      if (new Set(entries.map((entry) => entry.key)).size !== entries.length)
        throw new Error("Duplicate domain object key")
      return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]))
    }
    return items.map((item) => fromField(field, item))
  }
  if (schema.oneofs.length === 1 && schema.fields.every((field) => field.oneof)) {
    const selected = record(input[schema.oneofs[0].localName])
    if (selected.case === "none") return undefined
    if (selected.case === "clear") return null
    const field = schema.fields.find((field) => field.localName === selected.case)
    if (!field) throw new Error("Missing domain union branch")
    return fromField(field, selected.value)
  }
  return Object.fromEntries(
    schema.fields.flatMap((field) => {
      if (!Object.hasOwn(input, field.localName) || input[field.localName] === undefined) return []
      const decoded = fromField(field, input[field.localName])
      return decoded === undefined ? [] : [[field.name, decoded]]
    }),
  )
}

function fromField(field: Field, value: unknown): unknown {
  if (field.fieldKind === "message" || (field.fieldKind === "list" && field.listKind === "message"))
    return fromMessage(field.message, value)
  if (field.fieldKind === "enum" || (field.fieldKind === "list" && field.listKind === "enum")) {
    const label = enumLabels[field.enum.typeName]?.[Number(value)]
    if (label === undefined) throw new Error("Unknown v5 domain enum")
    return label
  }
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      throw new Error("Unsafe v5 domain integer")
    return Number(value)
  }
  return value
}

function encodedBytes(schema: Schema, value: unknown): number {
  const input = record(value)
  return schema.fields.reduce((total, field) => {
    const selected = field.oneof ? record(input[field.oneof.localName]) : undefined
    if (selected && selected.case !== field.localName) return total
    if (!selected && !Object.hasOwn(input, field.localName)) return total
    const value = selected ? selected.value : input[field.localName]
    if (value === undefined) return total
    const values = field.fieldKind === "list" ? (value as unknown[]) : [value]
    return (
      total +
      values.reduce<number>((sum, value) => {
        const tag = varintBytes(BigInt(field.number * 8))
        if (field.fieldKind === "message" || (field.fieldKind === "list" && field.listKind === "message")) {
          const bytes = encodedBytes(field.message, value)
          return sum + tag + varintBytes(BigInt(bytes)) + bytes
        }
        if (field.fieldKind === "enum" || (field.fieldKind === "list" && field.listKind === "enum"))
          return sum + tag + varintBytes(BigInt(Number(value)))
        if (field.scalar === 9 || field.scalar === 12) {
          const bytes = field.scalar === 9 ? Buffer.byteLength(value as string) : (value as Uint8Array).length
          return sum + tag + varintBytes(BigInt(bytes)) + bytes
        }
        if ([1, 6, 16].includes(field.scalar ?? 0)) return sum + tag + 8
        if ([2, 7, 15].includes(field.scalar ?? 0)) return sum + tag + 4
        if (field.scalar === 8) return sum + tag + 1
        const integer = BigInt(value as number | bigint)
        return (
          sum +
          tag +
          varintBytes(
            [17, 18].includes(field.scalar ?? 0) ? (integer < 0n ? -integer * 2n - 1n : integer * 2n) : integer,
          )
        )
      }, 0)
    )
  }, 0)
}

function varintBytes(value: bigint) {
  if (value < 0n) return 10
  return Math.max(1, Math.ceil(value.toString(2).length / 7))
}
