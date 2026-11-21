import { expect, test } from "bun:test"
import { makeAuthority } from "@ycoding-ai/core/interaction/authority"
import { Interaction } from "@ycoding-ai/core/interaction/index"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Effect } from "effect"
import { mkdtempDisposable } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromeConnectPath, chromeExtensionID, chromeMatchCode } from "@ycoding-ai/core/interaction/chrome"
import { mountChromeTransport, mountNativeConsent } from "../src/interaction-platform"

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
      resume: async () => false,
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
      const pending = await authority.request(sessionID, selection)
      if (pending.state !== "pending") throw new Error("Expected first pending grant")
      try {
        const signal = await first.entered.promise
        expect(authority.stop(sessionID, Interaction.Generation.create())).toBe(false)
        expect(signal.aborted).toBe(false)
        expect(authority.stop(sessionID, pending.generation)).toBe(true)
        expect(signal.aborted).toBe(true)
        const replacement = await authority.request(sessionID, selection)
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

test("the Chrome route mounts only with the signed helper and enrolls through its native profile confirmation", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), "ycoding-chrome-mount-"))
  const origin = "http://127.0.0.1:40009"
  const profiles = join(scratch.path, "profiles.json")
  const peer = { url: `${origin}${chromeConnectPath}`, origin: `chrome-extension://${chromeExtensionID}`, peerAddress: "127.0.0.1" }
  const asked: unknown[] = []
  const helper = (available: boolean) => ({
    available: async () => available,
    confirmChromeProfile: async (input: { profileLabel: string; matchCode: string }) => { asked.push(input); return true },
  })
  const authority = makeAuthority()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    expect(yield* mountChromeTransport(authority, helper(false), origin, profiles)).toBeUndefined()
    const transport = yield* mountChromeTransport(authority, helper(true), origin, profiles)
    if (!transport) throw new Error("Chrome transport did not mount")
    expect(transport.admit(peer)).toBe(true)
    const sent: Record<string, unknown>[] = []
    const channel = transport.connect({ ...peer, send: (text) => { sent.push(JSON.parse(text)); return true }, close: () => {} })
    const profileID = "P".repeat(43)
    yield* Effect.promise(() => channel.receive(JSON.stringify({ type: "enroll", version: 1, profileID, profileLabel: "Chrome 152" })))
    expect(asked).toEqual([{ profileLabel: "Chrome 152", matchCode: chromeMatchCode(profileID) }])
    expect(sent[0]).toMatchObject({ type: "authenticated", version: 1 })
    expect(typeof sent[0]?.credential).toBe("string")
  })))
})
