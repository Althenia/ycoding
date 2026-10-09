import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Session } from "@ycoding-ai/schema/session"

const decodeRule = Schema.decodeUnknownSync(Guardrail.Rule)

describe("Guardrail schema", () => {
  test("risk has a stable unique identifier and encodes on requests and asked events", () => {
    const risk = { level: 3, label: "irreversible", score: 0.84, metric: "confidence" as const }
    expect(Schema.encodeSync(Guardrail.Risk)(risk)).toEqual(risk)
    const identifiers = [Guardrail.Risk, Guardrail.Rule, Guardrail.RuleDecision, Guardrail.Decision, Guardrail.Reply]
      .map((schema) => schema.ast.annotations?.identifier)
    expect(identifiers[0]).toBe("Guardrail.Risk")
    expect(new Set(identifiers).size).toBe(identifiers.length)
    const request = new Guardrail.Request({ id: Guardrail.RequestID.create(),
      rootSessionID: Session.ID.descending("ses_root"), sessionID: Session.ID.descending("ses_root"),
      action: "shell", resources: ["task-runner execute"], ruleIDs: ["semantic.review.risk"],
      reason: "Risk: irreversible (3) · model confidence 0.84, uncalibrated", standard: false, risk,
    })
    expect(Schema.encodeSync(Guardrail.Request)(request).risk).toEqual(risk)
    expect(Schema.encodeSync(Guardrail.Event.Asked.data)(request).risk).toEqual(risk)
  })
  test("decodes a custom rule with deterministic optional defaults", () => {
    const rule = decodeRule({
      id: "protect-production",
      source: "custom",
      decision: "ask",
      actions: ["shell"],
      resources: ["kubectl * -n production*"],
      reason: "Production infrastructure modification",
      priority: 100,
    })

    expect(rule).toEqual({
      id: "protect-production",
      source: "custom",
      decision: "ask",
      actions: ["shell"],
      resources: ["kubectl * -n production*"],
      reason: "Production infrastructure modification",
      priority: 100,
    })
  })

  test("decodes a custom mandatory human-review rule", () => {
    expect(
      decodeRule({
        id: "protect-aws-account-deletion",
        source: "custom",
        decision: "hard_review",
        actions: ["shell"],
        resources: ["aws account close-account*"],
        reason: "AWS account deletion",
        priority: 200,
      }),
    ).toMatchObject({ decision: "hard_review" })
  })

  test("rejects empty action and resource sets", () => {
    expect(() =>
      decodeRule({
        id: "invalid",
        source: "custom",
        decision: "ask",
        actions: [],
        resources: [],
        reason: "Invalid rule",
        priority: 0,
      }),
    ).toThrow()
  })

  test("encodes pending requests without undefined optional keys", () => {
    const request = new Guardrail.Request({
      id: Guardrail.RequestID.create("grq_test"),
      rootSessionID: Session.ID.descending("ses_root"),
      sessionID: Session.ID.descending("ses_child"),
      action: "shell",
      resources: ["git reset --hard"],
      ruleIDs: ["git-destructive"],
      reason: "Destructive git operation",
      standard: true,
    })
    expect(Schema.encodeSync(Guardrail.Request)(request)).toEqual({
      id: "grq_test",
      rootSessionID: "ses_root",
      sessionID: "ses_child",
      action: "shell",
      resources: ["git reset --hard"],
      ruleIDs: ["git-destructive"],
      reason: "Destructive git operation",
      standard: true,
    })
  })
})
