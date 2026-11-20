import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Session } from "@ycoding-ai/schema/session"
import { SessionEvent } from "@ycoding-ai/schema/session-event"

const decodeRule = Schema.decodeUnknownSync(Guardrail.Rule)

describe("Guardrail schema", () => {
  test("risk has a stable unique identifier and encodes on requests and asked events", () => {
    const risk = { level: 3, label: "irreversible", score: 0.84, metric: "confidence" as const }
    expect(Schema.encodeSync(Guardrail.Risk)(risk)).toEqual(risk)
    const identifiers = [Guardrail.Risk, Guardrail.Rule, Guardrail.RuleDecision, Guardrail.Decision, Guardrail.Reply]
      .map((schema) => schema.ast.annotations?.identifier)
    expect(identifiers[0]).toBe("Guardrail.Risk")
    expect(new Set(identifiers).size).toBe(identifiers.length)
    const request = new Guardrail.Request({ id: Guardrail.RequestID.create(), created: 1,
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
      created: 1_000,
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
      created: 1_000,
      rootSessionID: "ses_root",
      sessionID: "ses_child",
      action: "shell",
      resources: ["git reset --hard"],
      ruleIDs: ["git-destructive"],
      reason: "Destructive git operation",
      standard: true,
    })
  })

  test("closed reviews carry an optional closed reason and the stale threshold is fifteen minutes", () => {
    expect(Guardrail.staleAfterMs).toBe(900_000)
    expect(Guardrail.ClosedReason.ast.annotations?.identifier).toBe("Guardrail.ClosedReason")
    const base = { rootSessionID: "ses_root", sessionID: "ses_child", requestID: "grq_test" }
    expect(Schema.encodeSync(Guardrail.Event.Cancelled.data)(Schema.decodeUnknownSync(Guardrail.Event.Cancelled.data)(base))).toEqual(base)
    expect(Schema.decodeUnknownSync(Guardrail.Event.Cancelled.data)({ ...base, reason: "expired" })).toMatchObject({ reason: "expired" })
    expect(() => Schema.decodeUnknownSync(Guardrail.Event.Cancelled.data)({ ...base, reason: "rejected" })).toThrow()
  })

  test("v0.12.2 shapes without created or reason decode and re-encode with every original field", () => {
    const request = {
      id: "grq_legacy", rootSessionID: "ses_root", sessionID: "ses_child", action: "shell", resources: ["git reset --hard"],
      ruleIDs: ["standard.review.git-destructive"], reason: "Destructive Git", standard: true, hardReview: true,
      metadata: { workdir: "/synthetic" }, source: { messageID: "msg_legacy", callID: "call_legacy" },
    }
    const decodedRequest = Schema.decodeUnknownSync(Guardrail.Request)(request)
    expect(decodedRequest.created).toBeUndefined()
    expect(Schema.encodeSync(Guardrail.Request)(Schema.decodeUnknownSync(Guardrail.Request)(request))).toEqual(request)
    expect(Schema.encodeSync(Guardrail.Event.Asked.data)(Schema.decodeUnknownSync(Guardrail.Event.Asked.data)(request))).toEqual(request)
    const cancelled = { rootSessionID: "ses_root", sessionID: "ses_child", requestID: "grq_legacy" }
    expect(Schema.encodeSync(Guardrail.Event.Cancelled.data)(Schema.decodeUnknownSync(Guardrail.Event.Cancelled.data)(cancelled))).toEqual(cancelled)
    const decided = {
      sessionID: "ses_root", reviewSessionID: "ses_child", requestID: "grq_legacy", reply: "reject",
      ruleIDs: ["standard.review.git-destructive"], source: { messageID: "msg_legacy", callID: "call_legacy" },
      actor: "coordinator", coordinatorSessionID: "ses_master", groupID: "cgrp_legacy", rationale: "Outside the assignment.",
    }
    expect<unknown>(Schema.encodeSync(SessionEvent.GuardrailDecided.data)(Schema.decodeUnknownSync(SessionEvent.GuardrailDecided.data)(decided))).toEqual(decided)
    const status = {
      rootSessionID: "ses_root", profile: "standard", customRules: 0, approvals: 1, blocked: 0, counters: [], invalidFiles: [],
      decisions: [{ sessionID: "ses_child", created: 5_000, requestID: "grq_legacy", reply: "once", authority: "baseline", choice: "approve", confidence: 0.95, ruleIDs: ["standard.review.outside-repo"], source: { messageID: "msg_legacy", callID: "call_legacy" } }],
    }
    expect<unknown>(Schema.encodeSync(Guardrail.Status)(Schema.decodeUnknownSync(Guardrail.Status)(status))).toEqual(status)
  })
})
