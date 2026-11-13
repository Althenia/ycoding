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

const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }

test("detach and removal accept an optional exact target receipt and nothing else", () => {
  for (const schema of [Dots.ComputerDetach, Dots.ComputerRemove]) {
    const decode = Schema.decodeUnknownSync(schema)
    expect(decode({})).toEqual({})
    expect(decode({ expectedTarget: target })).toEqual({ expectedTarget: target })
    for (const value of [{ replaceOthers: false }, { expectedTarget: { ...target, revision: "short" } }, { expectedTarget: { ...target, environmentID: "" } }, { expectedTarget: target, extra: true }])
      expect(() => decode(value)).toThrow()
  }
})

test("computer status carries readiness, task usability and the Dot environment, and the removed state", () => {
  const status = { access: { enabled: true, revision: 1 }, configuration: { ready: true }, connection: { state: "connected" as const } }
  const decode = Schema.decodeUnknownSync(Dots.NativeStatus)
  const computer = {
    state: "attached" as const, target, readiness: "connected" as const, usableForTasks: true,
    dotEnvironment: { status: "offline", capabilities: [{ type: "remote_desktop", status: "starting" }] },
  }
  expect(decode({ ...status, computer })).toEqual({ ...status, computer })
  expect(decode({ ...status, computer: { state: "removed" } })).toEqual({ ...status, computer: { state: "removed" } })
  for (const invalid of [{ readiness: "ready" }, { usableForTasks: "yes" }, { dotEnvironment: { status: "offline" } },
    { dotEnvironment: { status: "OFFLINE", capabilities: [] } }, { dotEnvironment: { status: "offline", capabilities: [{ type: "remote_desktop" }] } },
    { dotEnvironment: { status: "offline", capabilities: Array.from({ length: 17 }, () => ({ type: "a", status: "b" })) } }])
    expect(() => decode({ ...status, computer: { state: "attached", ...invalid } })).toThrow()
})
