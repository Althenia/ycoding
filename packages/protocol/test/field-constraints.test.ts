import { expect, test } from "bun:test"
import { validateConstraints } from "../src/v5/constraints.js"
import { requireConstraintCoverage } from "../src/v5/constraint-coverage.js"
import { Schema } from "effect"

test("integer constraints preserve signed and uint64 boundaries", () => {
  expect(() =>
    validateConstraints({ integerMin: "-9007199254740991", integerMax: "9007199254740991" }, -9007199254740991n),
  ).not.toThrow()
  expect(() => validateConstraints({ integerMax: "9007199254740991" }, 9007199254740992n)).toThrow("integer constraint")
  expect(() => validateConstraints({ integerMax: "18446744073709551615" }, 18446744073709551615n)).not.toThrow()
})

test("text constraints distinguish UTF-16, codepoints, UTF-8 and lone units", () => {
  expect(() => validateConstraints({ utf16Max: 1 }, undefined, "😀")).toThrow("text constraint")
  expect(() => validateConstraints({ codepointsMax: 1, utf8BytesMax: 4 }, undefined, "😀")).not.toThrow()
  expect(() => validateConstraints({ utf8BytesMax: 3 }, undefined, "😀")).toThrow("text constraint")
  expect(() =>
    validateConstraints({ utf16Max: 1, codepointsMax: 1, utf8BytesMax: 3 }, undefined, "\ud800"),
  ).not.toThrow()
})

test("count bounds do not claim to enforce domain obligations", () => {
  expect(() => validateConstraints({ countMin: 1, countMax: 2 }, undefined, undefined, 0)).toThrow("count constraint")
  expect(() => validateConstraints({ countMin: 1, countMax: 2 }, undefined, undefined, 2)).not.toThrow()
  expect(() =>
    validateConstraints(
      { domainObligations: ["packages/schema/src/browser.ts#Browser.Tab"] },
      undefined,
      "unvalidated-domain-value",
    ),
  ).not.toThrow()
})

test("live Effect checks require source-bound obligations without claiming enforcement", () => {
  const source = "packages/schema/src/browser.ts#Browser.Tab"
  const schema = Schema.String.check(Schema.isPattern(/^[a-p]{32}$/))
  expect(() => requireConstraintCoverage(schema, source, undefined)).toThrow("uncovered source constraints")
  expect(() =>
    requireConstraintCoverage(schema, source, { domainObligations: ["packages/schema/src/browser.ts#Browser.Status"] }),
  ).toThrow("uncovered source constraints")
  expect(requireConstraintCoverage(schema, source, { domainObligations: [source] }).enforced).toBe(false)
  const custom = Schema.String.check(Schema.makeFilter(() => true, { meta: { _tag: "isMaxLength", maxLength: 5 } }))
  expect(() => requireConstraintCoverage(custom, source, { utf16Max: 5 })).toThrow("uncovered source constraints")
})
