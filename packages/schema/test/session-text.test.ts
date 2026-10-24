import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { SessionMessage } from "@ycoding-ai/schema/session-message"

test("legacy text round trips without adding timing or delivery boundaries", () => {
  const legacy = { type: "text", text: "Legacy text" }
  const decoded = Schema.decodeUnknownSync(SessionMessage.AssistantText)(legacy)
  const encoded: unknown = Schema.encodeSync(SessionMessage.AssistantText)(decoded)
  expect(encoded).toEqual(legacy)
})

test("text timing and delivery boundaries serialize as optional projection fields", () => {
  const wire = {
    type: "text",
    text: "AlphaBravo",
    time: { created: 1000, completed: 1040 },
    breaks: [{ offset: 5, after: "msg_notice" }],
  }
  const decoded = Schema.decodeUnknownSync(SessionMessage.AssistantText)(wire)
  expect(DateTime.toEpochMillis(decoded.time!.created)).toBe(1000)
  expect(DateTime.toEpochMillis(decoded.time!.completed!)).toBe(1040)
  const encoded: unknown = Schema.encodeSync(SessionMessage.AssistantText)(decoded)
  expect(encoded).toEqual(wire)
  const previous = Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
    phase: Schema.optional(Schema.Literals(["commentary", "final_answer"])),
  })
  expect(Schema.decodeUnknownSync(previous)(wire)).toEqual({ type: "text", text: "AlphaBravo" })
})
