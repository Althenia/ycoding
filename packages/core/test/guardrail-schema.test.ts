import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Session } from "@ycoding-ai/schema/session"

const decodeRule = Schema.decodeUnknownSync(Guardrail.Rule)

describe("Guardrail schema", () => {
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
