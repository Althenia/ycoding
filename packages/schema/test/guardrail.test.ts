import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Guardrail } from "../src/guardrail.js"

test("Guardrail.Reply accepts reusable approvals", () => {
  expect(Schema.decodeUnknownSync(Guardrail.Reply)("always")).toBe("always")
})

test("Guardrail.Request accepts only JSON metadata used by exact approvals", () => {
  const decode = Schema.decodeUnknownSync(Guardrail.Request)
  const request = {
    id: "grq_metadata",
    rootSessionID: "ses_root",
    sessionID: "ses_child",
    action: "shell",
    resources: ["echo exact"],
    ruleIDs: ["review"],
    reason: "Review",
    standard: false,
  }
  expect(decode({ ...request, metadata: { identity: { workdir: "/repo" } } }).metadata).toEqual({
    identity: { workdir: "/repo" },
  })
  expect(() => decode({ ...request, metadata: { identity: undefined } })).toThrow()
  expect(() => decode({ ...request, metadata: { identity: Number.NaN } })).toThrow()
})
