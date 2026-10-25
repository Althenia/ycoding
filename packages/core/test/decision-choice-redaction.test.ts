import { expect, test } from "bun:test"
import { DecisionChoice } from "../src/decision-choice"

test("redacts bearer values before authorization assignment redaction can detach them", () => {
  for (const value of [
    "Authorization: Bearer synthetic-token-123",
    "authorization=Bearer synthetic-token-123",
    'Authorization: "Bearer synthetic-token-123"',
    "Bearer synthetic-token-123",
  ]) {
    const redacted = DecisionChoice.redactText(value)
    expect(redacted).not.toContain("synthetic-token-123")
    expect(redacted).toContain("[redacted]")
  }
})

test("retains ordinary request text and existing non-bearer secret redaction", () => {
  expect(DecisionChoice.redactText("Read the assigned files")).toBe("Read the assigned files")
  expect(DecisionChoice.redactText("--token=synthetic-token-123")).toBe("--token=[redacted]")
})
