import { expect, test } from "bun:test"
import { makeAuthority } from "@ycoding-ai/core/interaction/authority"
import { Interaction } from "@ycoding-ai/core/interaction/index"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { Effect, Logger } from "effect"
import { mkdtempDisposable } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromeConnectPath, chromeExtensionID, chromeMatchCode } from "@ycoding-ai/core/interaction/chrome"
import { mountChromeTransport, mountNativeConsent } from "../src/interaction-platform"
import type { InteractionDriver, InteractionDriverKey, InventoryRequest, NativeInteraction } from "@ycoding-ai/core/interaction/driver"

type Consent = (native: NativeInteraction, request: InventoryRequest, targets: readonly Interaction.Target[], signal: AbortSignal) => Promise<true | string>

function fixtureTarget(key: InteractionDriverKey): Interaction.Target {
  const id = Interaction.ID.create()
  return key === "macos" ? { kind: "macos-window", id, label: "Fixture", bundleID: "com.example.fixture" }
    : { kind: "chrome-isolated", id, label: "Fixture", url: "https://example.test/approved", origin: "https://example.test", pathname: "/approved" }
}

function fixtureSelection(key: InteractionDriverKey): Interaction.Request {
  return key === "macos" ? { platform: "macos" } : { platform: "chrome", mode: "isolated", url: "https://example.test/approved" }
}

function fixtureDriver(key: InteractionDriverKey, inventory: (request: InventoryRequest) => Promise<readonly Interaction.Target[]>): InteractionDriver & { inventories: InventoryRequest[] } {
  const inventories: InventoryRequest[] = []
  return {
    inventories,
    platform: key === "macos" ? "macos" : "chrome",
    inventory: async (request) => { inventories.push(request); return inventory(request) },
    attach: async () => ({ id: Interaction.ID.create() }),
    observe: async () => ({ revision: 1, elements: [{ id: Interaction.ID.create(), role: "AXButton", label: "Increment", editable: false }] }),
    perform: async () => ({ outcome: "applied" }),
    preview: async () => undefined,
    resume: async () => false,
    detach: async () => {},
  }
}

async function withConsent(key: InteractionDriverKey, driver: InteractionDriver, consent: Consent,
  run: (authority: ReturnType<typeof makeAuthority>, rejected: () => Promise<Record<string, unknown>>) => Promise<void>) {
  const authority = makeAuthority()
  const warnings: Record<string, unknown>[] = []
  const waiting: ((warning: Record<string, unknown>) => void)[] = []
  const logger = Logger.make((options) => {
    const message: unknown[] = Array.isArray(options.message) ? options.message : [options.message]
    const fields = message[1]
    if (message[0] !== "Native interaction consent was rejected" || typeof fields !== "object" || fields === null) return
    const warning = { level: options.logLevel, ...fields }
    warnings.push(warning)
    waiting.shift()?.(warning)
  })
  const rejected = () => warnings.length ? Promise.resolve(warnings.shift()!) : new Promise<Record<string, unknown>>((resolve) => {
    waiting.push((warning) => { warnings.splice(warnings.indexOf(warning), 1); resolve(warning) })
  })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* mountNativeConsent(authority, driver, key, consent)
    yield* Effect.promise(() => run(authority, rejected))
  })).pipe(Effect.provide(Logger.layer([logger]))))
}

const approveFirst: Consent = async (native, request, targets) => {
  const approved = await native.approve({ candidateID: request.candidateID, sessionID: request.sessionID, targetID: targets[0].id, authorization: "fixture-consent" })
  return approved || "authority_declined"
}

test.each(["macos", "chrome-isolated"] as const)("a %s attach whose inventory stays empty is rejected and logged after bounded retries", async (key) => {
  const driver = fixtureDriver(key, async () => [])
  let asked = 0
  await withConsent(key, driver, async () => { asked++; return true }, async (authority, rejected) => {
    const sessionID = SessionSchema.ID.create()
    const pending = await authority.request(sessionID, fixtureSelection(key))
    if (pending.state !== "pending") throw new Error("Expected a pending grant")
    const started = Date.now()
    expect(await rejected()).toEqual({ level: "Warn", driver: key, purpose: "attach", sessionID, reason: "inventory_empty" })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(driver.inventories.length).toBe(5)
    expect(asked).toBe(0)
    expect(authority.status(sessionID)).toMatchObject({ state: "stopped", generation: pending.generation, reason: "rejected" })
  })
})

test.each(["macos", "chrome-isolated"] as const)("a %s attach whose inventory is empty once and then ready is offered for consent", async (key) => {
  const target = fixtureTarget(key)
  const driver = fixtureDriver(key, async () => driver.inventories.length === 1 ? [] : [target])
  await withConsent(key, driver, approveFirst, async (authority) => {
    const sessionID = SessionSchema.ID.create()
    const pending = await authority.request(sessionID, fixtureSelection(key))
    if (pending.state !== "pending") throw new Error("Expected a pending grant")
    for (const deadline = Date.now() + 5_000; authority.status(sessionID).state === "pending" && Date.now() < deadline;) await Bun.sleep(10)
    expect(driver.inventories.length).toBe(2)
    expect(authority.status(sessionID)).toMatchObject({ state: "active", generation: pending.generation })
  })
})

test("a declined consent is rejected with its reason logged", async () => {
  const driver = fixtureDriver("macos", async () => [fixtureTarget("macos")])
  await withConsent("macos", driver, async () => "unverified", async (authority, rejected) => {
    const sessionID = SessionSchema.ID.create()
    const pending = await authority.request(sessionID, { platform: "macos" })
    if (pending.state !== "pending") throw new Error("Expected a pending grant")
    expect(await rejected()).toEqual({ level: "Warn", driver: "macos", purpose: "attach", sessionID, reason: "unverified" })
    expect(authority.status(sessionID)).toMatchObject({ state: "stopped", reason: "rejected" })
  })
})

test("a confirmation whose consent never arrives is rejected and logged, so the next confirmation is not held busy", async () => {
  const target = fixtureTarget("macos")
  const driver = fixtureDriver("macos", async (request) => request.purpose === "attach" ? [target] : [])
  await withConsent("macos", driver, approveFirst, async (authority, rejected) => {
    const sessionID = SessionSchema.ID.create()
    const pending = await authority.request(sessionID, { platform: "macos" })
    if (pending.state !== "pending") throw new Error("Expected a pending grant")
    for (const deadline = Date.now() + 5_000; authority.status(sessionID).state === "pending" && Date.now() < deadline;) await Bun.sleep(10)
    const observed = await authority.observe(sessionID, pending.generation)
    const press = { platform: "macos", type: "press", elementID: observed.elements[0].id, destructive: true } as const
    expect(authority.confirmation(sessionID, pending.generation, observed.revision, press)).toBeUndefined()
    expect(await rejected()).toEqual({ level: "Warn", driver: "macos", purpose: "confirm", sessionID, reason: "inventory_empty" })
    expect(await authority.perform(sessionID, pending.generation, observed.revision, Interaction.ID.create(), press))
      .toEqual({ outcome: "refused", reason: "confirmation_required" })
    expect(authority.confirmation(sessionID, pending.generation, observed.revision, press)).toBeUndefined()
  })
})

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
      return approved || "authority_declined"
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
