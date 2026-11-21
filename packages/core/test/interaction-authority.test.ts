import { expect, test } from "bun:test"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { makeAuthority } from "../src/interaction/authority"
import type { InteractionDriver, InventoryRequest } from "../src/interaction/driver"

const target = { kind: "chrome-tab", id: Interaction.ID.create(), label: "Fixture", origin: "https://example.test", pathname: "/" } as const
const action = { platform: "chrome", type: "scroll", deltaY: 120 } as const
const png = { mimeType: "image/png", width: 1, height: 1,
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" } as const

type Captured = { sessionID: SessionID; generation: Interaction.Generation; capture: { label: string; frame: Interaction.Frame; title?: string; url?: string } }

function fixture(driver: Partial<InteractionDriver> = {}, options: Parameters<typeof makeAuthority>[0] = {}) {
  const changes: SessionID[] = []
  const captured: Captured[] = []
  const driverCalls: string[] = []
  const authority = makeAuthority({
    changed: (sessionID) => { changes.push(sessionID) },
    ...options,
  })
  authority.admitCaptures(async (sessionID, generation, capture) => { captured.push({ sessionID, generation, capture }) })
  let leases = 0
  let revision = 0
  const leaseIDs: Interaction.ID[] = []
  const native = authority.register({
    platform: "chrome",
    inventory: async () => [{ ...target, id: Interaction.ID.create() }],
    attach: async () => {
      const lease = { id: Interaction.ID.create() }
      leaseIDs[leases++] = lease.id
      return lease
    },
    observe: async () => { driverCalls.push("observe"); return { revision: ++revision, elements: [], pathname: target.pathname } },
    perform: async () => { driverCalls.push("perform"); return { outcome: "applied" } },
    preview: async () => png,
    resume: async () => { driverCalls.push("resume"); return true },
    detach: async () => {},
    ...driver,
  })
  return { authority, native, changes, captured, driverCalls, leaseIDs }
}

async function activate(f: ReturnType<typeof fixture>, sessionID: SessionID) {
  const pending = await f.authority.request(sessionID, { platform: "chrome" })
  if (pending.state !== "pending") throw new Error("Expected a pending native request")
  const candidate = f.native.pending().find((request) => request.sessionID === sessionID)
  if (!candidate) throw new Error("Expected a published candidate")
  const [offered] = await f.native.inventory(candidate.candidateID)
  expect(await f.native.approve({ candidateID: candidate.candidateID, sessionID, targetID: offered.id, authorization: "native-proof" })).toBe(true)
  return { generation: pending.generation, leaseID: f.leaseIDs.at(-1)!, candidate }
}

test("a paused grant refuses observe and perform without a driver call and resumes only for its exact lease", async () => {
  const f = fixture()
  const sessionID = SessionID.create()
  const { generation, leaseID } = await activate(f, sessionID)
  try {
    const observed = await f.authority.observe(sessionID, generation)
    f.driverCalls.length = 0
    const before = f.changes.length
    expect(f.native.pause(Interaction.ID.create(), "dialog")).toBe(false)
    expect(f.native.pause(leaseID, "file_chooser")).toBe(true)
    expect(f.authority.status(sessionID)).toEqual({ state: "paused", platform: "chrome", generation, label: "Selected Chrome tab", reason: "file_chooser" })
    expect(f.changes.length).toBe(before + 1)
    expect(await f.authority.perform(sessionID, generation, observed.revision, Interaction.ID.create(), action)).toEqual({ outcome: "paused", reason: "file_chooser" })
    expect(await f.authority.observe(sessionID, generation).catch((error: unknown) => error)).toMatchObject({ code: "paused" })
    expect(f.driverCalls).toEqual([])
    expect(f.native.resume(Interaction.ID.create())).toBe(false)
    expect(f.native.resume(leaseID)).toBe(true)
    expect(f.native.resume(leaseID)).toBe(false)
    expect(f.authority.status(sessionID)).toEqual({ state: "active", platform: "chrome", generation, label: "Selected Chrome tab" })
    expect(f.changes.length).toBe(before + 2)
    const fresh = await f.authority.observe(sessionID, generation)
    expect(await f.authority.perform(sessionID, generation, observed.revision, Interaction.ID.create(), action)).toEqual({ outcome: "refused", reason: "stale" })
    expect(await f.authority.perform(sessionID, generation, fresh.revision, Interaction.ID.create(), action)).toEqual({ outcome: "applied" })
  } finally {
    f.native.disconnect()
  }
})

test("a pause reported while observing keeps the lease, sets paused and resumes to a working observe", async () => {
  const pausing = { leaseID: undefined as Interaction.ID | undefined, native: undefined as ReturnType<typeof fixture>["native"] | undefined }
  let revision = 0
  const f = fixture({
    observe: async () => {
      if (pausing.leaseID && pausing.native) {
        pausing.native.pause(pausing.leaseID, "foreground_required")
        pausing.leaseID = undefined
        throw new Error("the window needs the foreground")
      }
      return { revision: ++revision, elements: [], pathname: target.pathname }
    },
  })
  const sessionID = SessionID.create()
  const { generation, leaseID } = await activate(f, sessionID)
  try {
    Object.assign(pausing, { leaseID, native: f.native })
    expect(await f.authority.observe(sessionID, generation).catch((error: unknown) => error)).toMatchObject({ code: "paused" })
    expect(f.authority.status(sessionID)).toEqual({ state: "paused", platform: "chrome", generation, label: "Selected Chrome tab", reason: "foreground_required" })
    expect(f.native.resume(leaseID)).toBe(true)
    expect(f.authority.status(sessionID)).toMatchObject({ state: "active", generation })
    const fresh = await f.authority.observe(sessionID, generation)
    expect(await f.authority.perform(sessionID, generation, fresh.revision, Interaction.ID.create(), action)).toEqual({ outcome: "applied" })
  } finally {
    f.native.disconnect()
  }
})

test("server resume calls the driver only for the exact paused generation", async () => {
  let accept = false
  const f = fixture({ resume: async () => { f.driverCalls.push("resume"); return accept } })
  const sessionID = SessionID.create()
  const other = SessionID.create()
  const { generation, leaseID } = await activate(f, sessionID)
  try {
    expect(await f.authority.resume(sessionID, generation)).toBe(false)
    expect(f.driverCalls).toEqual([])
    f.native.pause(leaseID, "user_takeover")
    expect(await f.authority.resume(sessionID, Interaction.Generation.create())).toBe(false)
    expect(await f.authority.resume(other, generation)).toBe(false)
    expect(f.driverCalls).toEqual([])
    expect(await f.authority.resume(sessionID, generation)).toBe(false)
    expect(f.authority.status(sessionID)).toMatchObject({ state: "paused", reason: "user_takeover" })
    accept = true
    const before = f.changes.length
    expect(await f.authority.resume(sessionID, generation)).toBe(true)
    expect(f.driverCalls).toEqual(["resume", "resume"])
    expect(f.authority.status(sessionID)).toMatchObject({ state: "active", generation })
    expect(f.changes.length).toBe(before + 1)
  } finally {
    f.native.disconnect()
  }
})

test("Stop and revocation work from paused and a stopped lease cannot pause or resume", async () => {
  const f = fixture()
  const stopped = SessionID.create()
  const revoked = SessionID.create()
  const first = await activate(f, stopped)
  const second = await activate(f, revoked)
  try {
    f.native.pause(first.leaseID, "captcha")
    f.native.pause(second.leaseID, "sensitive")
    expect(f.authority.stop(stopped, first.generation)).toBe(true)
    expect(f.authority.status(stopped)).toMatchObject({ state: "stopped", reason: "stopped" })
    f.authority.revoke(revoked)
    expect(f.authority.status(revoked)).toMatchObject({ state: "stopped", reason: "permission" })
    expect(f.native.pause(first.leaseID, "dialog")).toBe(false)
    expect(f.native.resume(second.leaseID)).toBe(false)
    expect(await f.authority.resume(stopped, first.generation)).toBe(false)
  } finally {
    f.native.disconnect()
  }
})

test("a paused driver result pauses the grant and the native Stop still applies", async () => {
  const f = fixture({ perform: async () => ({ outcome: "paused", reason: "foreground_required" }) })
  const sessionID = SessionID.create()
  const { generation, leaseID } = await activate(f, sessionID)
  try {
    const { revision } = await f.authority.observe(sessionID, generation)
    expect(await f.authority.perform(sessionID, generation, revision, Interaction.ID.create(), action))
      .toEqual({ outcome: "paused", reason: "foreground_required" })
    expect(f.authority.status(sessionID)).toMatchObject({ state: "paused", reason: "foreground_required" })
    expect(f.native.stop(leaseID)).toBe(true)
    expect(f.authority.status(sessionID)).toMatchObject({ state: "stopped", reason: "stopped" })
  } finally {
    f.native.disconnect()
  }
})

test("native consent requests carry a bounded control-free Session label", async () => {
  const title = `Fix\u0007 login\nflow\u0085 ${"x".repeat(400)}`
  const f = fixture({}, { sessionLabel: async () => title })
  const sessionID = SessionID.create()
  const offered: InventoryRequest[] = []
  const unsubscribe = f.native.onPending((request) => { offered.push(request) })
  try {
    const { generation, candidate } = await activate(f, sessionID)
    expect(candidate.sessionLabel.startsWith("Fix login flow x")).toBe(true)
    expect(candidate.sessionLabel).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u)
    expect(candidate.sessionLabel.length).toBeLessThanOrEqual(128)
    const { revision } = await f.authority.observe(sessionID, generation)
    f.authority.confirmation(sessionID, generation, revision, { platform: "chrome", type: "click", elementID: Interaction.ID.create(), destructive: true })
    expect(f.native.pending().at(-1)).toMatchObject({ purpose: "confirm", sessionLabel: candidate.sessionLabel })
    await Promise.resolve()
    expect(offered.map((request) => request.sessionLabel)).toEqual([candidate.sessionLabel, candidate.sessionLabel])
  } finally {
    unsubscribe()
    f.native.disconnect()
  }
})

test("an unreadable Session title withdraws the pending request", async () => {
  const f = fixture({}, { sessionLabel: async () => { throw new Error("store unavailable") } })
  const sessionID = SessionID.create()
  try {
    expect(await f.authority.request(sessionID, { platform: "chrome" })).toMatchObject({ state: "stopped", reason: "permission" })
    expect(f.native.pending()).toEqual([])
  } finally {
    f.native.disconnect()
  }
})

test("a capture admits one redacted frame only to the lease's owning Session", async () => {
  const f = fixture()
  const owner = SessionID.create()
  const bystander = SessionID.create()
  const { generation, leaseID } = await activate(f, owner)
  await activate(f, bystander)
  try {
    expect(await f.native.capture(leaseID, {
      frame: png, title: "Reset for alice@example.test", url: "https://example.test/reset?token=abc123&step=2#private",
    })).toBe(true)
    expect(f.captured).toHaveLength(1)
    const [admitted] = f.captured
    expect(admitted).toMatchObject({ sessionID: owner, generation, capture: { label: "Selected Chrome tab", frame: png } })
    expect(admitted.capture.title).not.toContain("alice@example.test")
    expect(admitted.capture.url).toStartWith("https://example.test/reset")
    expect(admitted.capture.url).not.toContain("abc123")
    expect(admitted.capture.url).not.toContain("#private")
    f.native.pause(leaseID, "user_takeover")
    expect(await f.native.capture(leaseID, { frame: png })).toBe(true)
    expect(f.captured.map((item) => item.sessionID)).toEqual([owner, owner])
  } finally {
    f.native.disconnect()
  }
})

test("unknown, stale, stopped, archived and malformed captures admit nothing", async () => {
  let usable = true
  const f = fixture({}, { currentlyUsable: async () => usable })
  const sessionID = SessionID.create()
  const archived = SessionID.create()
  const first = await activate(f, sessionID)
  try {
    expect(await f.native.capture(Interaction.ID.create(), { frame: png })).toBe(false)
    expect(await f.native.capture(first.leaseID, { frame: { ...png, width: 2 } })).toBe(false)
    expect(await f.native.capture(first.leaseID, { frame: { ...png, base64: "iVBORw0KGgo=" } })).toBe(false)
    f.authority.stop(sessionID, first.generation)
    expect(await f.native.capture(first.leaseID, { frame: png })).toBe(false)
    const cleaned = () => {
      const status = f.authority.status(sessionID)
      return status.state === "stopped" && status.cleanup === "complete"
    }
    for (let turn = 0; turn < 10 && !cleaned(); turn++) await Promise.resolve()
    expect(cleaned()).toBe(true)
    const second = await activate(f, sessionID)
    expect(await f.native.capture(first.leaseID, { frame: png })).toBe(false)
    const third = await activate(f, archived)
    usable = false
    expect(await f.native.capture(third.leaseID, { frame: png })).toBe(false)
    expect(f.authority.status(archived)).toMatchObject({ state: "stopped", reason: "permission" })
    expect(f.captured).toEqual([])
    expect(second.leaseID).not.toBe(first.leaseID)
  } finally {
    f.native.disconnect()
  }
})

test("a failed admission reports false and does not block the next capture", async () => {
  let fail = true
  const f = fixture()
  f.authority.admitCaptures(async () => { if (fail) throw new Error("admission failed") })
  const sessionID = SessionID.create()
  const { leaseID } = await activate(f, sessionID)
  try {
    expect(await f.native.capture(leaseID, { frame: png })).toBe(false)
    fail = false
    expect(await f.native.capture(leaseID, { frame: png })).toBe(true)
    expect(f.authority.status(sessionID).state).toBe("active")
  } finally {
    f.native.disconnect()
  }
})

const script = { mode: "script", source: "return document.title" } as const
const completed = { outcome: "completed", value: "Checkout", logs: [{ level: "log", text: "read title" }] } as const

test("a run reaches the driver only for the owning Session at the current revision and consumes that revision", async () => {
  const runs: unknown[] = []
  const f = fixture({ run: async (_lease, request) => { runs.push(request); return completed } })
  const owner = SessionID.create()
  const other = SessionID.create()
  const { generation } = await activate(f, owner)
  try {
    expect(await f.authority.run(owner, generation, 1, script)).toEqual({ outcome: "refused", reason: "stale" })
    const { revision } = await f.authority.observe(owner, generation)
    expect(await f.authority.run(other, generation, revision, script)).toEqual({ outcome: "refused", reason: "stale" })
    expect(await f.authority.run(owner, Interaction.Generation.create(), revision, script)).toEqual({ outcome: "refused", reason: "stale" })
    expect(runs).toEqual([])
    expect(await f.authority.run(owner, generation, revision, script)).toEqual(completed)
    expect(runs).toEqual([{ mode: "script", source: "return document.title", timeoutMs: 10_000 }])
    expect(await f.authority.run(owner, generation, revision, { mode: "code", source: "1" })).toEqual({ outcome: "refused", reason: "stale" })
    expect(await f.authority.perform(owner, generation, revision, Interaction.ID.create(), { platform: "chrome", type: "scroll", deltaY: 1 }))
      .toEqual({ outcome: "refused", reason: "stale" })
    expect(runs).toHaveLength(1)
    const next = await f.authority.observe(owner, generation)
    expect(await f.authority.run(owner, generation, next.revision, { mode: "code", source: "let x = 1; x", timeoutMs: 500 })).toEqual(completed)
    expect(runs.at(-1)).toEqual({ mode: "code", source: "let x = 1; x", timeoutMs: 500 })
  } finally {
    f.native.disconnect()
  }
})

test("no status, change notification or other Session can see script source, values or logs", async () => {
  const notified: unknown[][] = []
  const secret = "secret-source-marker"
  const f = fixture({ run: async () => ({ outcome: "completed", value: `${secret}-value`, logs: [{ level: "info", text: `${secret}-log` }] }) },
    { changed: (...args) => { notified.push(args) } })
  const owner = SessionID.create()
  const { generation } = await activate(f, owner)
  try {
    const { revision } = await f.authority.observe(owner, generation)
    const result = await f.authority.run(owner, generation, revision, { mode: "script", source: `return "${secret}"` })
    expect(JSON.stringify(result)).toContain(`${secret}-log`)
    expect(notified.length).toBeGreaterThan(0)
    expect(notified.every((args) => args.length === 2 && args[0] === owner && args[1] === generation)).toBe(true)
    expect(JSON.stringify(f.authority.status(owner))).not.toContain(secret)
    expect(JSON.stringify(f.native.pending())).not.toContain(secret)
  } finally {
    f.native.disconnect()
  }
})

test("a paused grant returns paused and a driver-reported pause pauses the grant, both without replay", async () => {
  let calls = 0
  const f = fixture({ run: async () => { calls++; return { outcome: "paused", reason: "dialog" } } })
  const sessionID = SessionID.create()
  const { generation, leaseID } = await activate(f, sessionID)
  try {
    const { revision } = await f.authority.observe(sessionID, generation)
    expect(await f.authority.run(sessionID, generation, revision, script)).toEqual({ outcome: "paused", reason: "dialog" })
    expect(f.authority.status(sessionID)).toMatchObject({ state: "paused", reason: "dialog" })
    expect(calls).toBe(1)
    expect(await f.authority.run(sessionID, generation, revision, script)).toEqual({ outcome: "paused", reason: "dialog" })
    f.native.resume(leaseID)
    f.native.pause(leaseID, "captcha")
    expect(await f.authority.run(sessionID, generation, revision, script)).toEqual({ outcome: "paused", reason: "captcha" })
    expect(calls).toBe(1)
  } finally {
    f.native.disconnect()
  }
})

test("a driver without run and a macOS target refuse as unsupported without dispatch", async () => {
  const f = fixture()
  const sessionID = SessionID.create()
  const { generation } = await activate(f, sessionID)
  const authority = makeAuthority()
  let macRuns = 0
  const windowTarget = { kind: "macos-window", id: Interaction.ID.create(), bundleID: "com.example.fixture", label: "Fixture" } as const
  const macOS = authority.register({
    platform: "macos", inventory: async () => [windowTarget], attach: async () => ({ id: Interaction.ID.create() }),
    observe: async () => ({ revision: 1, elements: [] }), perform: async () => ({ outcome: "applied" }),
    preview: async () => undefined, resume: async () => true, detach: async () => {},
    run: async () => { macRuns++; return completed },
  })
  try {
    const { revision } = await f.authority.observe(sessionID, generation)
    expect(await f.authority.run(sessionID, generation, revision, script)).toEqual({ outcome: "refused", reason: "unsupported" })
    expect(await f.authority.perform(sessionID, generation, revision, Interaction.ID.create(), { platform: "chrome", type: "scroll", deltaY: 1 }))
      .toEqual({ outcome: "applied" })
    const macSession = SessionID.create()
    const pending = await authority.request(macSession, { platform: "macos" })
    if (pending.state !== "pending") throw new Error("Expected a macOS candidate")
    const candidate = macOS.pending()[0]
    await macOS.inventory(candidate.candidateID)
    expect(await macOS.approve({ candidateID: candidate.candidateID, sessionID: macSession, targetID: windowTarget.id, authorization: "native-proof" })).toBe(true)
    const observed = await authority.observe(macSession, pending.generation)
    expect(await authority.run(macSession, pending.generation, observed.revision, script)).toEqual({ outcome: "refused", reason: "unsupported" })
    expect(macRuns).toBe(0)
  } finally {
    f.native.disconnect()
    macOS.disconnect()
  }
})

test("an invalid script request is refused by policy without dispatch or consuming the revision", async () => {
  let calls = 0
  const f = fixture({ run: async () => { calls++; return completed } })
  const sessionID = SessionID.create()
  const { generation } = await activate(f, sessionID)
  try {
    const { revision } = await f.authority.observe(sessionID, generation)
    for (const request of [{ mode: "script", source: "" }, { mode: "code", source: "1", timeoutMs: 60_001 }, { mode: "code", source: "1", timeoutMs: 2.5 }] as const)
      expect(await f.authority.run(sessionID, generation, revision, request)).toEqual({ outcome: "refused", reason: "policy" })
    expect(calls).toBe(0)
    expect(await f.authority.run(sessionID, generation, revision, script)).toEqual(completed)
  } finally {
    f.native.disconnect()
  }
})

test.each(["stop", "revoke"] as const)("%s during a run aborts the driver signal and returns the driver's stopped result", async (end) => {
  const entered = Promise.withResolvers<AbortSignal>()
  const stopped = { outcome: "stopped", logs: [{ level: "log", text: "partial" }] } as const
  const f = fixture({ run: async (_lease, _request, signal) => {
    entered.resolve(signal)
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
    return stopped
  } })
  const sessionID = SessionID.create()
  const { generation } = await activate(f, sessionID)
  try {
    const { revision } = await f.authority.observe(sessionID, generation)
    const running = f.authority.run(sessionID, generation, revision, script)
    const signal = await entered.promise
    expect(signal.aborted).toBe(false)
    if (end === "stop") expect(f.authority.stop(sessionID, generation)).toBe(true)
    else f.authority.revoke(sessionID)
    expect(signal.aborted).toBe(true)
    expect(await running).toEqual(stopped)
    expect(f.authority.status(sessionID)).toMatchObject({ state: "stopped", reason: end === "stop" ? "stopped" : "permission" })
  } finally {
    f.native.disconnect()
  }
})

test("an unreadable or failed run revokes the grant as uncertain and is never replayed", async () => {
  const results: Array<() => Promise<Interaction.ScriptResult>> = [
    async () => ({ outcome: "completed", logs: [{ level: "log", text: "x".repeat(2049) }] }),
    async () => { throw new Error("transport lost") },
  ]
  for (const settle of results) {
    let calls = 0
    const f = fixture({ run: async () => { calls++; return settle() } })
    const sessionID = SessionID.create()
    const { generation } = await activate(f, sessionID)
    try {
      const { revision } = await f.authority.observe(sessionID, generation)
      expect(await f.authority.run(sessionID, generation, revision, script).catch((error: unknown) => error)).toMatchObject({ code: "uncertain" })
      expect(f.authority.status(sessionID)).toMatchObject({ state: "stopped", reason: "uncertain" })
      expect(await f.authority.run(sessionID, generation, revision, script)).toEqual({ outcome: "refused", reason: "stale" })
      expect(calls).toBe(1)
    } finally {
      f.native.disconnect()
    }
  }
})
