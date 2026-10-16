import { expect, test } from "bun:test"
import { guardrailHeading } from "./guardrail-label"

test("a pending guardrail request names its tier without claiming who decides it or when sleep delegates", () => {
  expect(guardrailHeading(false)).toBe("Guardrail review")
  expect(guardrailHeading(true)).toBe("Guardrail review (hard review)")
  for (const heading of [guardrailHeading(false), guardrailHeading(true)]) expect(heading).not.toMatch(/human|sleep|unless|toggle/i)
})
