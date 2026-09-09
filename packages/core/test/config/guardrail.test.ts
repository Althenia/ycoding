import { describe, expect, test } from "bun:test"
import { ConfigGuardrail } from "@ycoding-ai/core/config/guardrail"

describe("ConfigGuardrail", () => {
  test("parses enabled Markdown rules and preserves the explanation", () => {
    expect(
      ConfigGuardrail.parse(
        "/config/guardrails/production.md",
        `---
id: protect-production
enabled: true
decision: ask
actions:
  - shell
resources:
  - "kubectl * -n production*"
reason: Production infrastructure modification
priority: 100
---
Confirm the account, cluster, namespace, and change plan.
`,
      ),
    ).toEqual({
      path: "/config/guardrails/production.md",
      enabled: true,
      explanation: "Confirm the account, cluster, namespace, and change plan.\n",
      rule: {
        id: "protect-production",
        source: "custom",
        decision: "ask",
        actions: ["shell"],
        resources: ["kubectl * -n production*"],
        reason: "Production infrastructure modification",
        priority: 100,
      },
    })
  })

  test("defaults enabled and priority", () => {
    expect(
      ConfigGuardrail.parse(
        "/config/guardrails/defaults.md",
        `---
id: review-publish
decision: ask
actions: [shell]
resources: ["npm publish*"]
reason: Package publication
---
Review the target package.
`,
      ),
    ).toMatchObject({ enabled: true, rule: { priority: 0 } })
  })

  test("parses an AWS mandatory human-review rule", () => {
    expect(
      ConfigGuardrail.parse(
        "/config/guardrails/aws-account-deletion.md",
        `---
id: protect-aws-account-deletion
decision: hard_review
actions: [shell]
resources:
  - "aws organizations delete-organization*"
  - "aws account close-account*"
reason: AWS organization or account deletion
priority: 200
---
Verify the authenticated AWS account and require one-time human approval.
`,
      ),
    ).toMatchObject({
      enabled: true,
      rule: {
        id: "protect-aws-account-deletion",
        decision: "hard_review",
        actions: ["shell"],
        resources: ["aws organizations delete-organization*", "aws account close-account*"],
        reason: "AWS organization or account deletion",
        priority: 200,
      },
    })
  })

  test("rejects malformed enabled rules with the source path", () => {
    expect(() =>
      ConfigGuardrail.parse(
        "/config/guardrails/invalid.md",
        `---
id: invalid
decision: ask
actions: []
resources: []
reason: Invalid rule
---
`,
      ),
    ).toThrow("/config/guardrails/invalid.md")
  })

  test("retains a disabled malformed rule as disabled", () => {
    expect(
      ConfigGuardrail.parse(
        "/config/guardrails/disabled.md",
        `---
id: disabled
enabled: false
decision: ask
actions: []
resources: []
reason: Disabled invalid rule
---
`,
      ),
    ).toEqual({
      path: "/config/guardrails/disabled.md",
      enabled: false,
      explanation: "",
    })
  })
})
