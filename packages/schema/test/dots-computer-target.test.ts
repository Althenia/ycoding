import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Dots } from "../src/dots.js"

test("attachment accepts optional exact target receipts without altering legacy consent", () => {
  const decode = Schema.decodeUnknownSync(Dots.ComputerAttach)
  const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }
  expect(decode({ replaceOthers: true })).toEqual({ replaceOthers: true })
  expect(decode({ replaceOthers: true, expectedTarget: target })).toEqual({ replaceOthers: true, expectedTarget: target })
  for (const expectedTarget of [{ ...target, revision: "short" }, { ...target, environmentID: "" }, { ...target, token: "extra" }])
    expect(() => decode({ replaceOthers: true, expectedTarget })).toThrow()
})
