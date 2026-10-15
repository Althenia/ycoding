import { expect, test } from "bun:test"
import { Schema } from "effect"
import { KeepAwake } from "../src/groups/keep-awake.js"

test("keep-awake status remains additive for manual preference, lid control, and sleeping-family holds", () => {
  const decode = Schema.decodeUnknownSync(KeepAwake.Status)
  expect(decode({ state: "on" })).toEqual({ state: "on" })
  expect(decode({ state: "on", manual: false, lid: "error", sleepHold: true })).toEqual({
    state: "on",
    manual: false,
    lid: "error",
    sleepHold: true,
  })
  expect(() => decode({ state: "on", sleepHold: "true" })).toThrow()
  expect(() => decode({ state: "on", lid: "unknown" })).toThrow()
})
