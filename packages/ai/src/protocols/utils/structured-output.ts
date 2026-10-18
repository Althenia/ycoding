import type { JsonSchema, LLMRequest } from "../../schema"
import { isRecord } from "../../utils/record"

const unenforcedKeys = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
])
const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"])
const dataKeys = new Set(["enum", "const", "default", "examples", "required"])

const node = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(node)
  if (!isRecord(schema)) return schema
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (unenforcedKeys.has(key)) return []
      if (key === "minItems") return typeof value === "number" && value > 1 ? [] : [[key, value]]
      if (dataKeys.has(key)) return [[key, value]]
      if (schemaMaps.has(key) && isRecord(value))
        return [[key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, node(child)]))]]
      return [[key, node(value)]]
    }),
  )
}

const schema = (input: JsonSchema): JsonSchema => {
  const projected = node(input)
  return isRecord(projected) ? projected : {}
}

const requestSchema = (request: LLMRequest) =>
  request.responseFormat?.type === "json" ? schema(request.responseFormat.schema) : undefined

export const StructuredOutput = {
  name: "response",
  requestSchema,
  schema,
} as const
