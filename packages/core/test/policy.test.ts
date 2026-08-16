import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Policy } from "@ycoding-ai/core/policy"

test("uses the last matching wildcard statement and preserves fallback", async () => {
  const policy = Policy.make()
  await Effect.runPromise(
    policy.load([
      new Policy.Info({ action: "provider.*", resource: "*", effect: "deny" }),
      new Policy.Info({ action: "provider.use", resource: "openai", effect: "allow" }),
    ]),
  )

  expect(await Effect.runPromise(policy.evaluate("provider.use", "openai", "deny"))).toBe("allow")
  expect(await Effect.runPromise(policy.evaluate("provider.use", "anthropic", "allow"))).toBe("deny")
  expect(await Effect.runPromise(policy.evaluate("tool.use", "bash", "allow"))).toBe("allow")
  expect(policy.hasStatements()).toBe(true)
})

test("reloading replaces previous statements", async () => {
  const policy = Policy.make()
  await Effect.runPromise(policy.load([new Policy.Info({ action: "provider.use", resource: "*", effect: "deny" })]))
  await Effect.runPromise(policy.load([]))

  expect(await Effect.runPromise(policy.evaluate("provider.use", "openai", "allow"))).toBe("allow")
  expect(policy.hasStatements()).toBe(false)
})
