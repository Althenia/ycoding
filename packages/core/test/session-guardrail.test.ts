import { describe, expect, test } from "bun:test"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { SessionGuardrailMatch } from "@ycoding-ai/core/session/guardrail-match"

const custom = (input: Partial<Guardrail.Rule> & Pick<Guardrail.Rule, "id" | "decision" | "actions" | "resources">): Guardrail.Rule => ({
  source: "custom",
  reason: input.id,
  priority: 0,
  ...input,
})

const layer = (rules: Guardrail.Ruleset, invalidFiles: ReadonlyArray<string> = []) => ({ rules, invalidFiles })

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

  test("keeps catastrophic standard denies unoverrideable", () => {
    const result = SessionGuardrailMatch.evaluate({
      action: "shell",
      resources: ["rm -rf /"],
      custom: [layer([custom({ id: "allow-all", decision: "allow", actions: ["shell"], resources: ["*"] })])],
    })
    expect(result).toMatchObject({
      decision: "deny",
      standard: true,
      ruleIDs: ["standard.catastrophic.rm-root"],
    })
  })

  test("takes the first matching custom source layer before broader repository and user layers", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["npm publish"],
        custom: [
          layer([custom({ id: "nearest-allow", decision: "allow", actions: ["shell"], resources: ["npm publish*"] })]),
          layer([custom({ id: "broader-deny", decision: "deny", actions: ["shell"], resources: ["npm publish*"] })]),
          layer([custom({ id: "user-deny", decision: "deny", actions: ["shell"], resources: ["npm publish*"] })]),
        ],
      }),
    ).toMatchObject({ decision: "allow", standard: false, ruleIDs: ["nearest-allow"] })
  })

  test("lets user custom decisions suppress standard review behavior", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["git reset --hard HEAD~1"],
        custom: [
          layer([
            custom({
              id: "user-allow-reset",
              decision: "allow",
              actions: ["shell"],
              resources: ["git reset --hard*"],
            }),
          ]),
        ],
      }),
    ).toMatchObject({ decision: "allow", standard: false, ruleIDs: ["user-allow-reset"] })
  })

  test("uses numeric priority then lexical file and rule order within one layer", () => {
    const rules = [
      custom({ id: "00-lexical-allow", decision: "allow", actions: ["shell"], resources: ["echo *"], priority: 10 }),
      custom({ id: "01-lexical-deny", decision: "deny", actions: ["shell"], resources: ["echo *"], priority: 10 }),
      custom({ id: "99-higher", decision: "ask", actions: ["shell"], resources: ["echo *"], priority: 20 }),
    ]
    expect(
      SessionGuardrailMatch.evaluate({ action: "shell", resources: ["echo safe"], custom: [layer(rules)] }),
    ).toMatchObject({ decision: "ask", ruleIDs: ["99-higher"] })
    expect(
      SessionGuardrailMatch.evaluate({ action: "shell", resources: ["echo safe"], custom: [layer(rules.slice(0, 2))] }),
    ).toMatchObject({ decision: "allow", ruleIDs: ["00-lexical-allow"] })
  })

  test("preserves invalid-file source priority and fails closed for mutations", () => {
    const result = SessionGuardrailMatch.evaluate({
      action: "shell",
      resources: ["echo mutate"],
      custom: [
        layer([], ["nearest-invalid.md"]),
        layer([custom({ id: "broader-allow", decision: "allow", actions: ["shell"], resources: ["echo *"] })]),
      ],
    })
    expect(result).toMatchObject({ decision: "ask", ruleIDs: ["configuration.invalid"] })
  })

  test("does not let an invalid file weaken a valid deny in the same source layer", () => {
    const result = SessionGuardrailMatch.evaluate({
      action: "shell",
      resources: ["npm publish"],
      custom: [
        layer(
          [custom({ id: "deny-publish", decision: "deny", actions: ["shell"], resources: ["npm publish*"] })],
          ["invalid.md"],
        ),
      ],
    })
    expect(result).toMatchObject({ decision: "deny", ruleIDs: ["deny-publish"] })
  })

  test("fails closed for mutations when custom configuration is invalid", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "file_mutation",
        resources: ["/workspace/a.ts"],
        custom: [layer([], ["invalid.md"])],
      }),
    ).toMatchObject({ decision: "ask", ruleIDs: ["configuration.invalid"] })
    expect(
      SessionGuardrailMatch.evaluate({
        action: "read",
        resources: ["/workspace/a.ts"],
        custom: [layer([], ["invalid.md"])],
      }),
    ).toMatchObject({ decision: "allow" })
  })
})
