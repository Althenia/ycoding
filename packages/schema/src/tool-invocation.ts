export * as ToolInvocation from "./tool-invocation.js"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema.js"

export const Settled = Schema.Struct({
  id: Schema.String,
  index: NonNegativeInt,
  name: Schema.String,
  tool: Schema.String,
  status: Schema.Literals(["completed", "error"]),
  input: Schema.optionalKey(Schema.Unknown),
  structured: Schema.optionalKey(Schema.Unknown),
}).annotate({ identifier: "ToolInvocation.Settled" })
export type Settled = typeof Settled.Type
export const isSettled = Schema.is(Settled)

export interface Invocation {
  readonly id?: string
  readonly outerCallID?: string
  readonly name: string
  readonly status?: string
  readonly input?: unknown
  readonly structured?: unknown
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function mergeStructured(previous: unknown, next: unknown): Record<string, unknown> {
  const before = record(previous) ? previous : {}
  const after = record(next) ? next : {}
  const held = new Map<string, Settled>()
  if (Array.isArray(before.toolCalls)) {
    for (const call of before.toolCalls) if (isSettled(call)) held.set(call.id, call)
  }
  const incoming: unknown[] = Array.isArray(after.toolCalls) ? after.toolCalls : []
  const seen = new Set<string>()
  const calls = incoming.map((call) => {
    if (!record(call) || typeof call.id !== "string") return call
    seen.add(call.id)
    return held.get(call.id) ?? call
  })
  for (const [id, call] of held) if (!seen.has(id)) calls.push(call)
  const ordered = calls.filter(isSettled).toSorted((left, right) => left.index - right.index)
  let index = 0
  return { ...after, toolCalls: calls.map((call) => (isSettled(call) ? ordered[index++]! : call)) }
}

export function settle(structured: unknown, invocation: Settled): Record<string, unknown> {
  const value = record(structured) ? structured : {}
  const calls = Array.isArray(value.toolCalls) ? value.toolCalls : []
  const found = calls.some((call) => record(call) && call.id === invocation.id)
  return mergeStructured(undefined, {
    ...value,
    toolCalls: found
      ? calls.map((call) => (record(call) && call.id === invocation.id ? invocation : call))
      : [...calls, invocation],
  })
}

export function list(part: unknown): Invocation[] {
  if (!record(part) || part.type !== "tool" || typeof part.name !== "string" || !record(part.state)) return []
  const outerCallID = typeof part.id === "string" ? part.id : undefined
  if (part.name !== "execute")
    return [
      {
        ...(outerCallID === undefined ? {} : { id: outerCallID, outerCallID }),
        name: part.name,
        ...(typeof part.state.status === "string" ? { status: part.state.status } : {}),
        ...(part.state.input === undefined ? {} : { input: part.state.input }),
        ...(part.state.structured === undefined ? {} : { structured: part.state.structured }),
      },
    ]
  const structured = part.state.structured
  if (outerCallID === undefined || !record(structured) || !Array.isArray(structured.toolCalls)) return []
  return structured.toolCalls.flatMap((call: unknown): Invocation[] => {
    if (
      !record(call) ||
      typeof call.id !== "string" ||
      typeof call.name !== "string" ||
      typeof call.status !== "string"
    )
      return []
    return [
      {
        id: call.id,
        outerCallID,
        name: call.name,
        status: call.status,
        ...(call.input === undefined ? {} : { input: call.input }),
        ...(call.structured === undefined ? {} : { structured: call.structured }),
      },
    ]
  })
}
