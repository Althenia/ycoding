import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Guardrail } from "../src/guardrail.js"

test("Guardrail.Reply accepts reusable approvals", () => {
  expect(Schema.decodeUnknownSync(Guardrail.Reply)("always")).toBe("always")
})

test("Guardrail.RuleDecision accepts mandatory human review", () => {
  expect(Schema.decodeUnknownSync(Guardrail.RuleDecision)("hard_review")).toBe("hard_review")
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

test("Guardrail.Request carries the additive hard-review capability", () => {
  const request = Schema.decodeUnknownSync(Guardrail.Request)({
    id: "grq_hard_review",
    rootSessionID: "ses_root",
    sessionID: "ses_child",
    action: "shell",
    resources: ["rm -rf ."],
    ruleIDs: ["standard.review.broad-deletion"],
    reason: "Broad deletion",
    standard: true,
    hardReview: true,
  })
  expect(request.hardReview).toBe(true)
})
