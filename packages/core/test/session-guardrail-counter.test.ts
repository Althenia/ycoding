import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionGuardrailCounter } from "@ycoding-ai/core/session/guardrail-counter"
import { Session } from "@ycoding-ai/schema/session"

const root = Session.ID.descending("ses_root")

describe("SessionGuardrailCounter", () => {
  test("enforces a family cap and releases idempotently", async () => {
    const counter = SessionGuardrailCounter.make({ shells: 1, subagents: 1, reviews: 1 })
    const first = await Effect.runPromise(counter.reserve(root, "shell"))
    expect(await Effect.runPromise(counter.snapshot(root))).toContainEqual({ id: "shells", current: 1, limit: 1, scope: "family" })
    await expect(Effect.runPromise(counter.reserve(root, "shell"))).rejects.toMatchObject({ _tag: "Guardrail.CapExceededError" })
    await Effect.runPromise(first.release)
    await Effect.runPromise(first.release)
    expect(await Effect.runPromise(counter.snapshot(root))).toContainEqual({ id: "shells", current: 0, limit: 1, scope: "family" })
  })

  test("tracks shell, subagent, and review reservations independently", async () => {
    const counter = SessionGuardrailCounter.make({ shells: 2, subagents: 3, reviews: 4 })
    const shell = await Effect.runPromise(counter.reserve(root, "shell"))
    const subagent = await Effect.runPromise(counter.reserve(root, "subagent"))
    const review = await Effect.runPromise(counter.reserve(root, "review"))
    expect(await Effect.runPromise(counter.snapshot(root))).toEqual([
      { id: "shells", current: 1, limit: 2, scope: "family" },
      { id: "subagents", current: 1, limit: 3, scope: "family" },
      { id: "reviews", current: 1, limit: 4, scope: "family" },
    ])
    await Effect.runPromise(Effect.all([shell.release, subagent.release, review.release], { discard: true }))
  })
})
