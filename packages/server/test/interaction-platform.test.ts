import { expect, test } from "bun:test"
import { makeAuthority } from "@ycoding-ai/core/interaction/authority"
import { Interaction } from "@ycoding-ai/core/interaction/index"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Effect } from "effect"
import { mountNativeConsent } from "../src/interaction-platform"

test.each(["macos", "chrome-isolated"] as const)("matching Stop aborts a %s prompt and rejects a late approval", async (key) => {
  const authority = makeAuthority()
  const sessionID = SessionSchema.ID.create()
  const id = Interaction.ID.create()
  const selection: Interaction.Request = key === "macos" ? { platform: "macos" } : { platform: "chrome", mode: "isolated", url: "https://example.test/approved" }
  const target: Interaction.Target = selection.platform === "macos"
    ? { kind: "macos-window", id, label: "Fixture", bundleID: "com.example.fixture" }
    : { kind: "chrome-isolated", id, label: "Fixture", url: "https://example.test/approved", origin: "https://example.test", pathname: "/approved" }
  const prompts = Array.from({ length: 2 }, () => ({
    entered: Promise.withResolvers<AbortSignal>(), answered: Promise.withResolvers<void>(), settled: Promise.withResolvers<boolean>(),
  }))
  const [first, second] = prompts
  let attached = 0
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* mountNativeConsent(authority, {
      platform: selection.platform,
      inventory: async () => [target],
      attach: async () => { attached++; return { id: Interaction.ID.create() } },
      observe: async () => ({ revision: 1, elements: [] }),
      perform: async () => ({ outcome: "refused", reason: "unsupported" }),
      preview: async () => undefined,
      detach: async () => {},
    }, key, async (native, request, _targets, signal) => {
      const prompt = prompts.shift()!
      prompt.entered.resolve(signal)
      await prompt.answered.promise
      const approved = await native.approve({ candidateID: request.candidateID, sessionID, targetID: target.id, authorization: "fixture-consent" })
      prompt.settled.resolve(approved)
      return approved
    })
    yield* Effect.promise(async () => {
      const pending = authority.request(sessionID, selection)
      if (pending.state !== "pending") throw new Error("Expected first pending grant")
      try {
        const signal = await first.entered.promise
        expect(authority.stop(sessionID, Interaction.Generation.create())).toBe(false)
        expect(signal.aborted).toBe(false)
        expect(authority.stop(sessionID, pending.generation)).toBe(true)
        expect(signal.aborted).toBe(true)
        const replacement = authority.request(sessionID, selection)
        if (replacement.state !== "pending") throw new Error("Expected replacement pending grant")
        const replacementSignal = await second.entered.promise
        first.answered.resolve()
        expect(await first.settled.promise).toBe(false)
        expect(attached).toBe(0)
        expect(replacementSignal.aborted).toBe(false)
        expect(authority.status(sessionID)).toEqual(replacement)
        second.answered.resolve()
        expect(await second.settled.promise).toBe(true)
        expect(attached).toBe(1)
        expect(authority.status(sessionID)).toMatchObject({ state: "active", generation: replacement.generation })
      } finally {
        first.answered.resolve()
        second.answered.resolve()
      }
    })
  })))
})
