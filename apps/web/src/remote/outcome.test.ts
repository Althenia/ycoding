import { expect, test } from "bun:test"
import { describeOutcome } from "./outcome"

test.each([
  ["not-connected", "Usage is unavailable while the relay connection is closed."],
  ["request-limit", "Usage is unavailable because the relay request limit was reached."],
  ["in-flight-limit", "Usage is unavailable because too many requests are already pending."],
  ["cancelled", "Usage is unavailable because the request was cancelled."],
] as const)("unavailable %s describes its actual cause", (reason, message) => {
  expect(describeOutcome({ status: "unavailable", reason }, "Usage")).toBe(message)
})
