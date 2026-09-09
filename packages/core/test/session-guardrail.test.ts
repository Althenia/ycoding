import { describe, expect, test } from "bun:test"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { SessionGuardrailMatch } from "@ycoding-ai/core/session/guardrail-match"

const custom = (
  input: Partial<Guardrail.Rule> & Pick<Guardrail.Rule, "id" | "decision" | "actions" | "resources">,
): Guardrail.Rule => ({
  source: "custom",
  reason: input.id,
  priority: 0,
  ...input,
})

const layer = (rules: Guardrail.Ruleset, invalidFiles: ReadonlyArray<string> = []) => ({ rules, invalidFiles })

describe("SessionGuardrailMatch", () => {
  const paths = { workdir: "/workspace/project", project: "/workspace/project", home: "/home/user" }

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

  test.each([
    ["rm -rf .", "current project"],
    ['/bin/rm -fr -- "/workspace/project"', "quoted project path"],
    ["rm --recursive --force /workspace", "project ancestor"],
    ['echo ready && rm -r -f "$PWD"', "compound command"],
    ["rm -rf packages/one packages/two", "multiple recursive targets"],
  ])("requires hard review for broad deletion via %s (%s)", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "ask",
      hardReview: true,
      standard: true,
      ruleIDs: ["standard.review.broad-deletion"],
    })
  })

  test("tracks a supported cd across newline-separated compound commands", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["cd ..\nrm -rf ."],
        paths: { ...paths, workdir: "/workspace/project/src" },
      }),
    ).toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.broad-deletion"] })
  })

  test.each([
    "cd /tmp; rm -rf .",
    "cd /tmp\nrm -rf .",
    "cd /tmp || rm -rf .",
    "cd /tmp | rm -rf .",
    "cd /tmp & rm -rf .",
  ])("keeps the original workdir reachable when a compound cd cannot guarantee relocation for %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "ask",
      hardReview: true,
      ruleIDs: ["standard.review.broad-deletion"],
    })
  })

  test("uses the relocated workdir when && guarantees that deletion follows a successful cd", () => {
    expect(
      SessionGuardrailMatch.evaluate({ action: "shell", resources: ["cd /tmp && rm -rf ."], paths }),
    ).toMatchObject({ decision: "allow", hardReview: false })
  })

  test.each([
    "sudo rm --recursive --force /",
    'rm -rf "$HOME"',
    "rm -r -f /home/user",
    "cd && rm -rf .",
    "cd -- && rm -rf .",
  ])("keeps recognized root and home deletion denied for %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "deny",
      hardReview: false,
      standard: true,
      ruleIDs: ["standard.catastrophic.rm-root"],
    })
  })

  test.each([
    "rm -rf /workspace/project/build",
    "rm -f /workspace/project/file.txt",
    "rm -rf src/tmp",
    "rm -- --recursive .",
    "echo rm -rf .",
  ])("allows safe narrow deletion form %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "allow",
      hardReview: false,
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

  test("does not let a custom allow weaken standard hard review", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["rm -rf ."],
        paths,
        custom: [layer([custom({ id: "allow-all", decision: "allow", actions: ["shell"], resources: ["*"] })])],
      }),
    ).toMatchObject({
      decision: "ask",
      hardReview: true,
      standard: true,
      ruleIDs: ["standard.review.broad-deletion"],
    })
  })

  test("lets custom hard review override ordinary allows across source layers while preserving an effective deny", () => {
    const hard = custom({
      id: "human-review-aws-close",
      decision: "hard_review",
      actions: ["shell"],
      resources: ["aws account close-account*"],
    })
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["aws account close-account --account-id 111122223333"],
        custom: [
          layer([custom({ id: "nearest-allow", decision: "allow", actions: ["shell"], resources: ["aws *"] })]),
          layer([hard]),
        ],
      }),
    ).toMatchObject({ decision: "ask", hardReview: true, standard: false, ruleIDs: [hard.id] })
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["aws account close-account --account-id 111122223333"],
        custom: [
          layer([custom({ id: "nearest-deny", decision: "deny", actions: ["shell"], resources: ["aws *"] })]),
          layer([hard]),
        ],
      }),
    ).toMatchObject({ decision: "deny", hardReview: false, ruleIDs: ["nearest-deny"] })
  })

  test("applies the synthetic AWS hard-review rule only to configured destructive operations", () => {
    const rules = layer([
      custom({
        id: "protect-aws-account-deletion",
        decision: "hard_review",
        actions: ["shell"],
        resources: ["aws organizations delete-organization*", "aws account close-account*"],
      }),
    ])
    for (const resource of [
      "aws organizations delete-organization",
      "aws account close-account --account-id 111122223333",
    ])
      expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [resource], custom: [rules] })).toMatchObject(
        {
          decision: "ask",
          hardReview: true,
          ruleIDs: ["protect-aws-account-deletion"],
        },
      )
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["aws organizations describe-organization"],
        custom: [rules],
      }),
    ).toMatchObject({ decision: "allow", hardReview: false })
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
