import { describe, expect, test } from "bun:test"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { SessionGuardrailMatch } from "../src/session/guardrail-match"
import { SessionGuardrailStandard } from "../src/session/guardrail-standard"

const paths = { workdir: "/workspace/project", project: "/workspace/project", home: "/home/user" }

const custom = (
  input: Partial<Guardrail.Rule> & Pick<Guardrail.Rule, "id" | "decision" | "actions" | "resources">,
): Guardrail.Rule => ({
  source: "custom",
  reason: input.id,
  priority: 0,
  ...input,
})

describe("search guardrail regressions", () => {
  test.each([
    'rg -n "delete from" packages/core/src/session',
    "rg -n 'delete from' packages/core/src/session",
    'git grep -n "git reset --hard" -- docs',
    'git grep -n "git push --force" -- docs',
    'rg -n "run git reset --hard now" docs',
    'rg -n "avoid git clean -fd" docs',
    "rg -n mkfs packages",
    "rg -n ':(){ :|:& };:' docs",
    'rg -n "delete from users$" packages/core/src',
    'rg -n "drop table.*;$" schema.sql',
    'LC_ALL=C rg -n "delete from" packages/core/src/session',
    '/opt/homebrew/bin/rg -n "delete from" packages/core/src/session',
    'command rg -n "delete from" packages/core/src/session',
    'grep "delete from" < schema.sql',
    'rg -n "delete from" packages/core/src/session | head -20',
  ])("does not review destructive text that is only searched: %s", (command) => {
    expect(SessionGuardrailStandard.match("shell", command, paths)).toBeUndefined()
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "allow", ruleIDs: [] })
  })

  test.each([
    ["git reset --hard HEAD", "ask", "standard.review.git-destructive"],
    ["mkfs.ext4 /dev/sda1", "deny", "standard.catastrophic.format-disk"],
    [":(){ :|:& };:", "deny", "standard.catastrophic.fork-bomb"],
    ["dd if=/dev/zero of=/dev/disk0", "deny", "standard.catastrophic.block-device-write"],
    ['sqlite3 app.db "delete from users"', "ask", "standard.review.database-destructive"],
    ['echo "delete from users" | sqlite3 app.db', "ask", "standard.review.database-destructive"],
    ['rg --pre processor "delete from" packages', "ask", "standard.review.database-destructive"],
    ['rg -n "delete from" packages > matches.txt', "ask", "standard.review.database-destructive"],
    ['rg -n "delete from $(cat tables.txt)" packages', "ask", "standard.review.database-destructive"],
    ['rg -n "delete from" packages | sh', "ask", "standard.review.database-destructive"],
    ['git grep -n -O "delete from" -- packages', "ask", "standard.review.database-destructive"],
    ['rg -n "delete from" packages; git reset --hard HEAD', "ask", "standard.review.git-destructive"],
    ['env LC_ALL=C grep -rn "drop table" packages', "ask", "standard.review.database-destructive"],
    ['LD_PRELOAD=/tmp/evil.so rg -n "delete from" packages', "ask", "standard.review.database-destructive"],
    ['/tmp/tools/rg -n "delete from" packages', "ask", "standard.review.database-destructive"],
  ])("keeps genuine protection for %s", (command, decision, ruleID) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision, ruleIDs: [ruleID] })
  })

  test("keeps legacy dollar-bracket arithmetic classified while literal end-anchor dollars stay read-only", () => {
    const command = 'rg -n "delete from $[x=1] users" packages'
    expect(SessionGuardrailStandard.semanticResources("shell", [command], paths)).toEqual([command])
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", ruleIDs: ["standard.review.database-destructive"] })
    expect(SessionGuardrailStandard.semanticResources("shell", ['rg -n "delete from users$" packages/core/src'], paths)).toEqual([])
  })

  test("custom guardrails still classify a read-only search", () => {
    expect(SessionGuardrailMatch.evaluate({
      action: "shell",
      resources: ['rg -n "delete from" packages/core/src/session'],
      paths,
      custom: [{ rules: [custom({ id: "deny-search-text", decision: "deny", actions: ["shell"], resources: ["*delete from*"] })], invalidFiles: [] }],
    })).toMatchObject({ decision: "deny", standard: false, ruleIDs: ["deny-search-text"] })
  })
})
