import { expect, test } from "bun:test"
import { Decision } from "@ycoding-ai/core/decision"
import { DecisionTool } from "@ycoding-ai/core/tool/decision"
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
