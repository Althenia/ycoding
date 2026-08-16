import { describe, expect, test } from "bun:test"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { SessionGuardrailMatch } from "@ycoding-ai/core/session/guardrail-match"

const custom = (input: Partial<Guardrail.Rule> & Pick<Guardrail.Rule, "id" | "decision" | "actions" | "resources">): Guardrail.Rule => ({
  source: "custom",
  reason: input.id,
  priority: 0,
  ...input,
})

describe("SessionGuardrailMatch", () => {
  test("hard denies catastrophic shell commands", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["rm -rf /"] })).toMatchObject({
      decision: "deny",
      standard: true,
      ruleIDs: ["standard.catastrophic.rm-root"],
    })
  })

  test("requires approval for high-impact shell commands", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["git reset --hard HEAD~1"] })).toMatchObject({
      decision: "ask",
      standard: true,
      ruleIDs: ["standard.review.git-destructive"],
    })
  })

  test("lets custom deny beat standard approval and custom allow", () => {
    const result = SessionGuardrailMatch.evaluate({
      action: "shell",
      resources: ["npm publish"],
      custom: [
        custom({ id: "allow-publish", decision: "allow", actions: ["shell"], resources: ["npm publish*"] }),
        custom({ id: "deny-publish", decision: "deny", actions: ["shell"], resources: ["npm publish*"] }),
      ],
    })
    expect(result).toMatchObject({ decision: "deny", ruleIDs: ["deny-publish"] })
  })

  test("uses priority then source path and rule order for equal decisions", () => {
    const result = SessionGuardrailMatch.evaluate({
      action: "shell",
      resources: ["echo safe"],
      custom: [
        custom({ id: "lower", decision: "ask", actions: ["shell"], resources: ["echo *"], priority: 1 }),
        custom({ id: "higher", decision: "ask", actions: ["shell"], resources: ["echo *"], priority: 10 }),
      ],
    })
    expect(result).toMatchObject({ decision: "ask", ruleIDs: ["higher"] })
  })

  test("fails closed for mutations when custom configuration is invalid", () => {
    expect(
      SessionGuardrailMatch.evaluate({ action: "file_mutation", resources: ["/workspace/a.ts"], invalidFiles: ["invalid.md"] }),
    ).toMatchObject({ decision: "ask", ruleIDs: ["configuration.invalid"] })
    expect(
      SessionGuardrailMatch.evaluate({ action: "read", resources: ["/workspace/a.ts"], invalidFiles: ["invalid.md"] }),
    ).toMatchObject({ decision: "allow" })
  })
})
