import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Guardrail } from "../src/guardrail.js"

test("decision choices add escalation without changing human reply choices", () => {
  for (const choice of ["approve", "reject", "escalate"] as const) expect(Schema.decodeUnknownSync(Guardrail.DecisionChoice)(choice)).toBe(choice)
  expect(() => Schema.decodeUnknownSync(Guardrail.Reply)("escalate")).toThrow()
})

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

test("decision provenance admits bounded confidence and omits unknown fields", () => {
  for (const confidence of [0, 0.79, 0.8, 1])
    expect(Schema.decodeUnknownSync(Guardrail.Confidence)(confidence)).toBe(confidence)
  for (const confidence of [Number.NaN, Infinity, -Infinity, -0.1, 1.1])
    expect(() => Schema.decodeUnknownSync(Guardrail.Confidence)(confidence)).toThrow()
  const encode = Schema.encodeSync(Guardrail.Event.Replied.data)
  expect(
    encode({
      rootSessionID: "ses_root",
      sessionID: "ses_root",
      requestID: "grq_model",
      reply: "reject",
      decidedBy: "decision-model",
    } as typeof Guardrail.Event.Replied.data.Type),
  ).not.toHaveProperty("confidence")
})
