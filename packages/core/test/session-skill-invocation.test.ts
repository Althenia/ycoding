import { describe, expect, test } from "bun:test"
import { SessionSkill } from "@ycoding-ai/core/session/skill"

const skills = [
  { id: "audit", name: "Audit" },
  { id: "audit-long", name: "Long audit" },
  { id: "audit.v2", name: "Audit v2" },
]

describe("explicit skill syntax", () => {
  test.each(["$audit", "Use $audit, then report", "\n$audit!", "$audit)", "$audit'", '$audit"', "$audit`"])(
    "activates the known whitespace-delimited token %s",
    (text) => {
      expect(SessionSkill.mentions(text, skills)).toEqual([skills[0]])
    },
  )

  test.each([
    "costs $10",
    "$VAR",
    "$unknown",
    "path/$audit",
    "`$audit`",
    "'$audit'",
    "\\$audit",
    "$$audit",
    "$audit_extra",
    "$audit-longer",
    "$audit}",
  ])("does not infer an invocation from %s", (text) => {
    expect(SessionSkill.mentions(text, skills)).toEqual([])
  })

  test("matches exact escaped IDs and deduplicates repeated references", () => {
    expect(SessionSkill.mentions("$audit-long, $audit.v2 $audit $audit", skills)).toEqual(skills)
  })
})
