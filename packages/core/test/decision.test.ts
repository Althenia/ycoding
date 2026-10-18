import { expect, test } from "bun:test"
import { Decision } from "@ycoding-ai/core/decision"
import { DecisionAgent } from "@ycoding-ai/core/decision-agent"
import { DecisionTool } from "@ycoding-ai/core/tool/decision"
import { DecisionFailure } from "@ycoding-ai/schema/decision-failure"
import { Schema } from "effect"

test("decision input accepts only the validated agent request", () => {
  const request = { provider: "agent", request: { state: { task: "review" }, questions: [
    { type: "choice", name: "decision", instructions: "Choose", choices: [{ value: "yes" }, { value: "no" }] },
  ] } } as const
  expect(Schema.decodeUnknownSync(Decision.Input)(request)).toEqual(request)
  for (const provider of [["open", "ai"].join(""), ["type", "safe"].join("")])
    expect(Schema.is(Decision.Input)({ ...request, provider })).toBe(false)
  expect(Schema.is(Decision.Input)({ provider: "agent", request: { state: {}, questions: [] } })).toBe(false)
  expect(DecisionTool.Input).toBe(Decision.Input)
})

test("decision errors share the typed failure reasons and describe JSON output failures", () => {
  for (const reason of Schema.decodeUnknownSync(Schema.Array(DecisionFailure.Reason))([
    "unavailable", "invalid-request", "provider-failed", "timeout", "input-too-large",
    "invalid-output", "refused", "truncated-output", "unsupported-output",
  ])) {
    expect(new Decision.Error({ reason }).reason).toBe(reason)
    expect(new DecisionAgent.Error({ reason }).reason).toBe(reason)
    expect(new Decision.Error({ reason }).message.length).toBeGreaterThan(0)
  }
  expect(new Decision.Error({ reason: "invalid-output" }).message).toContain("JSON")
  expect(new Decision.Error({ reason: "invalid-output" }).message).not.toContain("TOON")
  expect(new Decision.Error({ reason: "unsupported-output" }).message).toContain("strict")
  expect(new Decision.Error({ reason: "refused" }).message).toContain("refus")
  expect(new Decision.Error({ reason: "truncated-output" }).message).toContain("truncated")
})
