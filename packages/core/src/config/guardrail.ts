export * as ConfigGuardrail from "./guardrail"

import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Schema } from "effect"
import { ConfigMarkdown } from "./markdown"
import { PositiveInt } from "../schema"

const NonNegativeMoney = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export class Info extends Schema.Class<Info>("Config.Guardrail")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  max_concurrent_shells: PositiveInt.pipe(Schema.optional),
  max_concurrent_subagents: PositiveInt.pipe(Schema.optional),
  max_pending_reviews: PositiveInt.pipe(Schema.optional),
  max_cost_usd: NonNegativeMoney.pipe(Schema.optional),
  max_steps: PositiveInt.pipe(Schema.optional),
  max_tool_calls: PositiveInt.pipe(Schema.optional),
  max_file_mutations: PositiveInt.pipe(Schema.optional),
  max_network_actions: PositiveInt.pipe(Schema.optional),
}) {}

export interface Document {
  readonly path: string
  readonly enabled: boolean
  readonly explanation: string
  readonly rule?: Guardrail.Rule
}

const decodeRule = Schema.decodeUnknownSync(Guardrail.Rule)

export function parse(path: string, content: string): Document {
  const markdown = ConfigMarkdown.parse(content)
  const enabled = booleanProperty(markdown.data, "enabled") ?? true
  if (!enabled) return { path, enabled, explanation: markdown.content }
  try {
    return {
      path,
      enabled,
      explanation: markdown.content,
      rule: decodeRule({
        id: property(markdown.data, "id"),
        source: "custom",
        decision: property(markdown.data, "decision"),
        actions: property(markdown.data, "actions"),
        resources: property(markdown.data, "resources"),
        reason: property(markdown.data, "reason"),
        priority: numberProperty(markdown.data, "priority") ?? 0,
        ...(booleanProperty(markdown.data, "persistent") === undefined
          ? {}
          : { persistent: booleanProperty(markdown.data, "persistent") }),
      }),
    }
  } catch (cause) {
    throw new Error(`Invalid guardrail file: ${path}`, { cause })
  }
}

function property(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) return undefined
  return value[key as keyof typeof value]
}

function booleanProperty(value: unknown, key: string) {
  const result = property(value, key)
  return typeof result === "boolean" ? result : undefined
}

function numberProperty(value: unknown, key: string) {
  const result = property(value, key)
  return typeof result === "number" ? result : undefined
}
