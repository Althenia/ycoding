import { expect, test } from "bun:test"
import { SessionID } from "../src/session-id.js"
import { Schema } from "effect"
import { McpEvents } from "../src/mcp-events.js"

const valid = {
  kind: "guardrail",
  origin: { type: "tool", source_event_id: "evt_1", message_id: "msg_1", call_id: "call_1" },
  review: "hard",
  actions: ["inspect", "respond"],
} as const

const decode = (value: unknown) => Schema.decodeUnknownSync(McpEvents.Attention)(value, { onExcessProperty: "error" })
const accepts = (value: unknown) => {
  try {
    decode(value)
    return true
  } catch {
    return false
  }
}

test("attention accepts every kind, origin type, review class and action set", () => {
  expect(decode(valid)).toEqual(valid)
  for (const kind of ["guardrail", "permission", "question", "form", "subagent_question", "recovery"])
    expect(accepts({ ...valid, kind })).toBe(true)
  for (const type of ["tool", "native", "managed_task", "review", "unreported"])
    expect(accepts({ ...valid, origin: { type, source_event_id: "evt_1" } })).toBe(true)
  for (const review of ["ordinary", "hard", "custom", "unreported"]) expect(accepts({ ...valid, review })).toBe(true)
  for (const actions of [[], ["inspect"], ["respond"], ["inspect", "respond"]]) expect(accepts({ ...valid, actions })).toBe(true)
  const { review: _review, ...withoutReview } = valid
  expect(accepts(withoutReview)).toBe(true)
  expect(accepts({ ...valid, origin: { type: "native", source_event_id: "evt_1" } })).toBe(true)
})

test("attention is closed and excludes person-specific fields and actions", () => {
  for (const bad of [
    { ...valid, extra: true },
    { ...valid, prompt: "private" },
    { ...valid, origin: { ...valid.origin, resource: "x" } },
    { ...valid, kind: "unknown" },
    { ...valid, kind: "Guardrail" },
    { ...valid, review: "standard" },
    { ...valid, origin: { type: "human", source_event_id: "evt_1" } },
    { ...valid, origin: { type: "tool" } },
    { ...valid, human_required: true },
    { ...valid, human_required: false },
    { ...valid, actions: ["notify_human"] },
    { ...valid, actions: ["inspect", "respond", "notify_human"] },
    { ...valid, actions: undefined },
    { ...valid, actions: ["approve"] },
    { ...valid, actions: ["inspect", "answer"] },
    { ...valid, actions: ["reply"] },
    { ...valid, actions: "inspect" },
    null,
    "guardrail",
  ]) expect(accepts(bad)).toBe(false)
})

test("attention identifiers share the 128-character ASCII identifier bound", () => {
  const id = (length: number) => "a".repeat(length)
  expect(accepts({ ...valid, origin: { type: "tool", source_event_id: id(128), message_id: id(128), call_id: id(128) } })).toBe(true)
  for (const field of ["source_event_id", "message_id", "call_id"])
    for (const bad of [id(129), "", "-leading", "has space", "with/slash", "new\nline", "ünicode"])
      expect(accepts({ ...valid, origin: { ...valid.origin, [field]: bad } })).toBe(false)
})

test("event data carries attention optionally and still rejects unknown keys", () => {
  const data = { session_id: SessionID.make("ses_a"), root_session_id: SessionID.make("ses_a"), state: "pending" as const }
  expect(Schema.decodeUnknownSync(McpEvents.EventData)(data, { onExcessProperty: "error" })).toEqual(data)
  expect(Schema.decodeUnknownSync(McpEvents.EventData)({ ...data, attention: valid }, { onExcessProperty: "error" }).attention).toEqual(valid)
  expect(() => Schema.decodeUnknownSync(McpEvents.EventData)({ ...data, attention: { ...valid, actions: ["approve"] } })).toThrow()
  expect(() => Schema.decodeUnknownSync(McpEvents.EventData)({ ...data, attention: { ...valid, extra: 1 } }, { onExcessProperty: "error" })).toThrow()
  expect(() => Schema.decodeUnknownSync(McpEvents.EventData)({ ...data, answer: "x" }, { onExcessProperty: "error" })).toThrow()
})

const record = (value: unknown) => Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value)
const strings = (value: unknown) => Schema.decodeUnknownSync(Schema.Array(Schema.String))(value)

test("advertised payload schema includes the closed attention shape and keeps the required fields", () => {
  for (const definition of McpEvents.Definitions) {
    const payload = definition.payloadSchema
    expect(payload.required).toEqual(["session_id", "root_session_id", "state"])
    expect(payload.additionalProperties).toBe(false)
    const attention = record(record(payload.properties).attention)
    const properties = record(attention.properties)
    expect(attention.type).toBe("object")
    expect(attention.additionalProperties).toBe(false)
    expect(strings(attention.required).toSorted()).toEqual(["actions", "kind", "origin"])
    expect(record(properties.kind).enum).toEqual(["guardrail", "permission", "question", "form", "subagent_question", "recovery"])
    expect(record(properties.review).enum).toEqual(["ordinary", "hard", "custom", "unreported"])
    expect(properties).not.toHaveProperty("human_required")
    const actions = record(properties.actions)
    expect(actions.type).toBe("array")
    expect(record(actions.items).enum).toEqual(["inspect", "respond"])
    const origin = record(properties.origin)
    const originProperties = record(origin.properties)
    expect(origin.additionalProperties).toBe(false)
    expect(strings(origin.required).toSorted()).toEqual(["source_event_id", "type"])
    expect(record(originProperties.type).enum).toEqual(["tool", "native", "managed_task", "review", "unreported"])
    for (const key of ["source_event_id", "message_id", "call_id"]) expect(record(originProperties[key]).type).toBe("string")
    expect(Object.keys(properties).toSorted()).toEqual(["actions", "kind", "origin", "review"])
  }
})
