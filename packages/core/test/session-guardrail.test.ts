import { describe, expect, test } from "bun:test"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { SessionGuardrailMatch } from "@ycoding-ai/core/session/guardrail-match"
import { SessionGuardrailStandard } from "@ycoding-ai/core/session/guardrail-standard"

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

  test("desktop window access has no standard review and still honors custom policy", () => {
    const input = { action: "computer", resources: ["macos.bundle_id/app.synthetic/123/4"] }
    expect(SessionGuardrailMatch.evaluate(input)).toMatchObject({ decision: "allow", ruleIDs: [] })
    expect(
      SessionGuardrailMatch.evaluate({
        ...input,
        custom: [layer([custom({ id: "deny-computer", decision: "deny", actions: ["computer"], resources: ["*"] })])],
      }),
    ).toMatchObject({ decision: "deny", ruleIDs: ["deny-computer"] })
  })

  test.each(["browser_owned_open", "browser_profile_mutation"])(
    "%s has no standard review and still honors custom policy",
    (action) => {
      const input = { action, resources: ["https://example.test"] }
      expect(SessionGuardrailMatch.evaluate(input)).toMatchObject({ decision: "allow", ruleIDs: [] })
      expect(
        SessionGuardrailMatch.evaluate({
          ...input,
          custom: [layer([custom({ id: "deny-browser", decision: "deny", actions: [action], resources: ["*"] })])],
        }),
      ).toMatchObject({ decision: "deny", ruleIDs: ["deny-browser"] })
    },
  )

  test("profile reads have no standard review and still honor custom policy", () => {
    const input = { action: "browser_profile_access", resources: ["https://example.test"] }
    expect(SessionGuardrailMatch.evaluate(input)).toMatchObject({ decision: "allow", ruleIDs: [] })
    expect(SessionGuardrailMatch.evaluate({ ...input,
      custom: [layer([custom({ id: "deny-profile-read", decision: "deny", actions: [input.action],
        resources: ["*"] })])],
    })).toMatchObject({ decision: "deny", ruleIDs: ["deny-profile-read"] })
  })

  test.each([
    ["rm -rf .", "current project"],
    ['/bin/rm -fr -- "/workspace/project"', "quoted project path"],
    ["rm --recursive --force /workspace", "project ancestor"],
    ['echo ready && rm -r -f "$PWD"', "compound command"],
  ])("requires hard review for broad deletion via %s (%s)", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "ask",
      hardReview: true,
      standard: true,
      ruleIDs: ["standard.review.project-deletion"],
    })
  })

  test.each([
    "rm -rf packages/one packages/two",
    "rm -rf /tmp/cache-a /tmp/cache-b /tmp/cache-c",
  ])("allows multiple narrow recursive targets via %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "allow",
      hardReview: false,
      ruleIDs: [],
    })
  })

  test.each([
    "rm -rf /home/user/Documents",
    "rm -rf ~/Documents",
    'rm -rf "$HOME/Documents"',
    "rm -rf ~/Documents ~/Downloads",
  ])("requires ordinary review for recursive deletion one level below home via %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "ask",
      hardReview: false,
      standard: true,
      ruleIDs: ["standard.review.home-child"],
    })
  })

  test("tracks a supported cd across newline-separated compound commands", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["cd ..\nrm -rf ."],
        paths: { ...paths, workdir: "/workspace/project/src" },
      }),
    ).toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.project-deletion"] })
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
      ruleIDs: ["standard.review.project-deletion"],
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
      ruleIDs: [command.endsWith(" /") ? "standard.catastrophic.rm-root" : "standard.catastrophic.rm-user-home"],
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
      ruleIDs: ["standard.review.project-deletion"],
    })
  })

  test("lets a custom allow override ordinary home-child review", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["rm -rf ~/Documents"],
        paths,
        custom: [layer([custom({ id: "allow-all", decision: "allow", actions: ["shell"], resources: ["*"] })])],
      }),
    ).toMatchObject({
      decision: "allow",
      hardReview: false,
      standard: false,
      ruleIDs: ["allow-all"],
    })
  })

  test.each(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders/user/cache", "/scratch/temp", "$TMPDIR", "${TMPDIR}"])(
    "excludes temp root %s even when it contains the project or is a home child", (root) => {
      expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [`rm -rf ${root} ${root}/x`],
        paths: { workdir: "/scratch/temp/project", project: "/scratch/temp/project", home: "/scratch", tmpdir: "/scratch/temp" },
      })).toMatchObject({ decision: "allow", hardReview: false, ruleIDs: [] })
    },
  )

  test("evaluates only the project in mixed temp and project deletion", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["rm -rf /tmp/a /private/tmp/y ."], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.project-deletion"] })
  })

  test.each(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/scratch/temp"])(
    "temp %s overrides project and home deletion classification", (root) => {
      expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [`rm -rf ${root}`],
        paths: { workdir: `${root}/project`, project: `${root}/project`, home: root, tmpdir: "/scratch/temp" },
      })).toMatchObject({ decision: "allow", ruleIDs: [] })
    },
  )

  test.each([
    ["rm -rf /tmp/a /var/tmp/b build", ["rm -rf build"]],
    ['rm -rf "/tmp/path with spaces" "build output"', ['rm -rf "build output"']],
    ['rm -rf /tmp/a; env FLAG="two words" task-runner execute', ['env FLAG="two words" task-runner execute']],
    ["cd /tmp && rm -rf .", ["cd /tmp"]],
    ["cd /tmp || rm -rf .", ["cd /tmp || rm -rf ."]],
    ["rm -rf /tmp/a; git status", ["git status"]],
    ["rm -rf /tmp/a && npm publish", ["npm publish"]],
    ["rm -f $TMPDIR/a ${TMPDIR}/b", []],
  ])("sanitizes recognized temp deletion evidence for %s", (command, expected) => {
    expect(SessionGuardrailStandard.semanticResources("shell", [command], { ...paths, tmpdir: "/scratch/temp" })).toEqual(expected)
  })

  test("temp deletion exclusions preserve custom deny and unrelated standard review", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["rm -rf /tmp/a; npm publish"], paths }))
      .toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.publish"] })
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["rm -rf /tmp/a"], paths,
      custom: [layer([custom({ id: "deny-temp", decision: "deny", actions: ["shell"], resources: ["*"] })])],
    })).toMatchObject({ decision: "deny", ruleIDs: ["deny-temp"] })
  })

  test("temp workdirs do not erase non-path subagent or artifact resources from evidence", () => {
    const temporaryPaths = { ...paths, workdir: "/tmp/project" }
    expect(SessionGuardrailStandard.semanticResources("subagent", ["build"], temporaryPaths)).toEqual(["build"])
    expect(SessionGuardrailStandard.semanticResources("project_artifact_mutation", ["skill/example"], temporaryPaths))
      .toEqual(["skill/example"])
  })

  test.each(["/Users/other", "/home/other", "/Users/other/*"])("denies any user home %s", (target) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [`rm -rf ${target}`], paths }))
      .toMatchObject({ decision: "deny", hardReview: false, ruleIDs: ["standard.catastrophic.rm-user-home"] })
  })

  test.each(["/System", "/Library", "/usr", "/etc", "/bin", "/sbin", "/opt", "/Applications", "/var", "/var/log"])(
    "denies system deletion %s", (target) => {
      expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [`rm -rf ${target}`], paths }))
        .toMatchObject({ decision: "deny", hardReview: false, ruleIDs: ["standard.catastrophic.rm-system"] })
    },
  )

  test.each([
    ["shell", "git push origin main --force", "force-push"],
    ["shell", "npm publish", "publish"],
    ["shell", "terraform apply", "production"],
    ["shell", "DROP TABLE users", "database-destructive"],
    ["shell", "ufw disable", "security-mutation"],
    ["mcp_execute", "server command", "mcp-execute"],
  ])("preserves ordinary review for %s %s", (action, resource, id) => {
    expect(SessionGuardrailMatch.evaluate({ action, resources: [resource], paths }))
      .toMatchObject({ decision: "ask", hardReview: false, ruleIDs: [`standard.review.${id}`] })
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
