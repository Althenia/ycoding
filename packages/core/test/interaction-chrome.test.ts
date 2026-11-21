import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { chromeCloseBusy, chromeCloseRejected, chromeConnectPath, chromeExtensionID, chromeMatchCode, makeChromeTransport } from "../src/interaction/chrome"
import { captureIsolatedPreview, makeChromeIsolatedDriver } from "../src/interaction/chrome-isolated"
import { connectChromePipe } from "../src/interaction/chrome-isolated-pipe"
import type { InteractionDriver, InventoryRequest, NativeInteraction } from "../src/interaction/driver"
import type { IsolatedStop } from "../src/interaction/macos"

const origin = "http://127.0.0.1:40007"
const peerInfo = { url: `${origin}${chromeConnectPath}`, origin: `chrome-extension://${chromeExtensionID}`, peerAddress: "127.0.0.1" }

function nativeStop(candidateID: Interaction.ID, properties: Partial<IsolatedStop> = {}): IsolatedStop {
  return { candidateID, signal: new AbortController().signal, bind: async () => true, close: () => {}, ...properties }
}

function nativeStub(overrides: Partial<NativeInteraction> = {}): NativeInteraction {
  return { pending: () => [], onPending: () => () => {}, inventory: async () => [], approve: async () => false, reject: () => false,
    stop: () => false, pause: () => false, resume: () => false, capture: async () => false, disconnect: () => {}, ...overrides }
}

async function profileFixture(confirm: (input: { profileLabel: string; matchCode: string }, signal: AbortSignal) => Promise<boolean>,
  register: (driver: InteractionDriver) => NativeInteraction = () => nativeStub()) {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-chrome-profiles-"))
  const profiles = join(directory, "state", "interaction-chrome-profiles.json")
  const transport = makeChromeTransport({ origin, register, confirm, profiles })
  const socket = () => {
    const sent: Record<string, unknown>[] = []
    const closed: number[] = []
    const peer = transport.connect({ ...peerInfo, send: (text) => { sent.push(JSON.parse(text)); return true }, close: (code) => { closed.push(code) } })
    return { sent, closed, receive: (frame: unknown) => peer.receive(JSON.stringify(frame)), disconnect: peer.disconnect }
  }
  return { transport, profiles, socket, async [Symbol.asyncDispose]() {
    transport.close()
    await rm(directory, { recursive: true, force: true })
  } }
}

const profileA = "A".repeat(43)
const profileB = "B".repeat(43)

test("Chrome enrollment asks the Mac only with a match code and profile label the native panel accepts", async () => {
  const asked: { profileLabel: string; matchCode: string }[] = []
  await using f = await profileFixture(async (input) => { asked.push(input); return false })
  for (const profileLabel of ["", " Chrome", "Chrome ", "Chrome\u0007", "Chrome\u0085", "Chrome\u200b", "Chrome\u202e", "C".repeat(65)]) {
    const peer = f.socket()
    await peer.receive({ type: "enroll", version: 1, profileID: profileA, profileLabel })
    expect(peer.sent).toEqual([])
    expect(peer.closed).toHaveLength(1)
  }
  expect(asked).toEqual([])
  const peer = f.socket()
  await peer.receive({ type: "enroll", version: 1, profileID: profileA, profileLabel: "Chrome 155 · Work" })
  expect(asked).toEqual([{ profileLabel: "Chrome 155 · Work", matchCode: chromeMatchCode(profileA) }])
  expect(asked[0]?.matchCode).toMatch(/^[A-Za-z0-9-]{4,32}$/)
})

test("Chrome checks loopback and manifest identity before any profile handshake", async () => {
  const manifest = await Bun.file(new URL("../../../extensions/interaction-chrome/manifest.json", import.meta.url)).json()
  const expected = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
    .replace(/./g, (value) => String.fromCharCode(97 + Number.parseInt(value, 16)))
  expect(chromeExtensionID).toBe(expected)
  await using f = await profileFixture(async () => true)
  expect(f.transport.admit({ ...peerInfo, url: `${peerInfo.url}?not-allowed` })).toBe(false)
  expect(f.transport.admit({ ...peerInfo, origin: "https://localhost" })).toBe(false)
  expect(f.transport.admit({ ...peerInfo, peerAddress: "10.0.0.1" })).toBe(false)
  expect(f.transport.admit(peerInfo)).toBe(true)
  const legacy = f.socket()
  await legacy.receive({ type: "authenticate", version: 1, extensionID: chromeExtensionID, code: "x".repeat(43) })
  expect(legacy.sent).toEqual([])
  expect(legacy.closed).toEqual([chromeCloseRejected])
})

test("the match code is a stable short digest of the profile ID", () => {
  expect(chromeMatchCode(profileA)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  expect(chromeMatchCode(profileA)).toBe(chromeMatchCode(profileA))
  expect(chromeMatchCode(profileA)).not.toBe(chromeMatchCode(profileB))
})

test("first-time enrollment issues a credential only after native Allow and stores only its digest", async () => {
  const decisions = [false, true]
  const asked: unknown[] = []
  let registrations = 0
  let disconnects = 0
  await using f = await profileFixture(async (input) => { asked.push(input); return decisions.shift() ?? false },
    () => { registrations++; return nativeStub({ disconnect: () => { disconnects++ } }) })
  const enroll = { type: "enroll", version: 1, profileID: profileA, profileLabel: "Chrome 152" }
  const denied = f.socket()
  await denied.receive(enroll)
  expect(asked).toEqual([{ profileLabel: "Chrome 152", matchCode: chromeMatchCode(profileA) }])
  expect(denied.sent).toEqual([])
  expect(denied.closed).toEqual([chromeCloseRejected])
  expect(await Bun.file(f.profiles).exists()).toBe(false)
  expect(registrations).toBe(0)

  const allowed = f.socket()
  await allowed.receive(enroll)
  const credential = allowed.sent[0]?.credential
  if (typeof credential !== "string") throw new Error("Missing issued credential")
  expect(allowed.sent).toEqual([{ type: "authenticated", version: 1, credential }])
  expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const stored = await Bun.file(f.profiles).text()
  expect(stored).not.toContain(credential)
  expect(stored).toContain(createHash("sha256").update(credential).digest("hex"))
  expect((await stat(f.profiles)).mode & 0o777).toBe(0o600)
  expect(registrations).toBe(1)

  const auth = { type: "authenticate", version: 1, extensionID: chromeExtensionID, profileID: profileA, credential }
  for (const forged of [{ ...auth, credential: "c".repeat(43) }, { ...auth, profileID: profileB }, { ...auth, extensionID: "x".repeat(32) }]) {
    const peer = f.socket()
    await peer.receive(forged)
    expect(peer.sent).toEqual([])
    expect(peer.closed).toEqual([chromeCloseRejected])
  }
  expect({ registrations, disconnects }).toEqual({ registrations: 1, disconnects: 0 })
  const reconnected = f.socket()
  await reconnected.receive(auth)
  expect(reconnected.sent).toEqual([{ type: "authenticated", version: 1 }])
  expect({ registrations, disconnects }).toEqual({ registrations: 2, disconnects: 1 })
  expect(asked).toHaveLength(2)

  const forget = f.socket()
  await forget.receive({ ...auth, type: "forget" })
  expect(forget.closed).toEqual([chromeCloseRejected])
  expect(await Bun.file(f.profiles).text()).not.toContain(profileA)
  const forgotten = f.socket()
  await forgotten.receive(auth)
  expect(forgotten.closed).toEqual([chromeCloseRejected])
  expect(asked).toHaveLength(2)
})

test("one enrollment waits at a time, a disconnect withdraws it, and another profile cannot displace the connected one", async () => {
  const decision = Promise.withResolvers<boolean>()
  const signals: AbortSignal[] = []
  await using f = await profileFixture(async (_input, signal) => { signals.push(signal); return decision.promise })
  const first = f.socket()
  const waiting = first.receive({ type: "enroll", version: 1, profileID: profileA, profileLabel: "Chrome" })
  const second = f.socket()
  await second.receive({ type: "enroll", version: 1, profileID: profileB, profileLabel: "Chrome" })
  expect(second.closed).toEqual([chromeCloseBusy])
  first.disconnect()
  expect(signals[0]?.aborted).toBe(true)
  decision.resolve(true)
  await waiting
  expect(first.sent).toEqual([])
  expect(await Bun.file(f.profiles).exists()).toBe(false)

  const enrolled = async (profileID: string) => {
    const peer = f.socket()
    await peer.receive({ type: "enroll", version: 1, profileID, profileLabel: "Chrome" })
    return { peer, credential: String(peer.sent[0]?.credential) }
  }
  const a = await enrolled(profileA)
  const b = f.socket()
  await b.receive({ type: "enroll", version: 1, profileID: profileB, profileLabel: "Chrome" })
  expect(b.closed).toEqual([chromeCloseBusy])
  const again = f.socket()
  await again.receive({ type: "authenticate", version: 1, extensionID: chromeExtensionID, profileID: profileA, credential: a.credential })
  expect(again.sent).toEqual([{ type: "authenticated", version: 1 }])
  expect(a.peer.closed).toEqual([1008])
})

test("only the bound Chrome peer receives the challenge and only its matching approval reaches native authority", async () => {
  const candidate: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), sessionLabel: "Fixture Session",
    expiresAt: Date.now() + 10_000, purpose: "attach", selection: { platform: "chrome" } }
  const target = { kind: "chrome-tab", id: Interaction.ID.create(), label: "Test tab", origin: "https://example.test", pathname: "/form" }
  const approved: unknown[] = []
  const sent: Record<string, unknown>[] = []
  const inventoried = Promise.withResolvers<void>()
  let driver: InteractionDriver | undefined
  await using f = await profileFixture(async () => true, (registered) => {
    driver = registered
    return nativeStub({ pending: () => [candidate], inventory: async () => {
      const targets = await registered.inventory(candidate)
      inventoried.resolve()
      return targets
    }, approve: async (proof) => { approved.push(proof); return true } })
  })
  {
    const peer = f.transport.connect({ ...peerInfo, send: (text) => { sent.push(JSON.parse(text)); return true }, close: () => {} })
    await peer.receive(JSON.stringify({ type: "enroll", version: 1, profileID: profileA, profileLabel: "Chrome" }))
    expect(driver?.platform).toBe("chrome")
    expect(sent[1]).toEqual({ type: "pending", input: candidate })
    expect(sent[2]).toMatchObject({ type: "request", op: "inventory", input: candidate })
    await peer.receive(JSON.stringify({ type: "result", id: sent[2]?.id, result: [target] }))
    await inventoried.promise
    const proof = { candidateID: candidate.candidateID, sessionID: candidate.sessionID, targetID: target.id, authorization: "local-proof" }
    await peer.receive(JSON.stringify({ type: "approved", proof: { ...proof, sessionID: SessionID.create() } }))
    expect(approved).toEqual([])
    await peer.receive(JSON.stringify({ type: "approved", proof }))
    await peer.receive(JSON.stringify({ type: "approved", proof }))
    expect(approved).toEqual([proof])

    if (!driver) throw new Error("Chrome driver did not register")
    const signal = new AbortController().signal
    const reply = (result: unknown) => peer.receive(JSON.stringify({ type: "result", id: sent.at(-1)?.id, result }))
    const leaseID = Interaction.ID.create()
    const leasePromise = driver.attach({ ...target, kind: "chrome-tab" }, proof, signal)
    await reply({ sessionID: proof.sessionID, targetID: proof.targetID, pathname: target.pathname, leaseID, epoch: 1, revision: 1 })
    const lease = await leasePromise
    const wrongPath = driver.observe(lease, signal).catch((error: unknown) => error)
    await reply({ revision: 2, pathname: "/redirected", elements: [] })
    expect(await wrongPath).toMatchObject({ code: "stale" })
    const accepted = driver.observe(lease, signal)
    const observation = { revision: 2, pathname: target.pathname, elements: [] }
    await reply(observation)
    expect(await accepted).toEqual(observation)

    const navigating = driver.perform(lease, 2, { callID: Interaction.ID.create(),
      action: { platform: "chrome", type: "navigate", url: "https://example.test/form" } }, signal)
    await reply({ outcome: "applied" })
    expect(await navigating).toEqual({ outcome: "applied" })
    const frameCount = sent.length
    const stale = driver.perform(lease, 2, { callID: Interaction.ID.create(), action: { platform: "chrome", type: "scroll", deltaY: 1 } }, signal)
    if (sent.length !== frameCount) await reply({ outcome: "applied" })
    expect(await stale).toEqual({ outcome: "refused", reason: "stale" })
    expect(sent).toHaveLength(frameCount)
  }
})

test("pause, resume and capture frames reach native authority only for the live lease epoch", async () => {
  const candidate: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), sessionLabel: "Fixture Session",
    expiresAt: Date.now() + 10_000, purpose: "attach", selection: { platform: "chrome" } }
  const target = { kind: "chrome-tab" as const, id: Interaction.ID.create(), label: "Test tab", origin: "https://example.test", pathname: "/form" }
  const calls: unknown[] = []
  const captured = Promise.withResolvers<void>()
  let driver: InteractionDriver | undefined
  const sent: Record<string, unknown>[] = []
  await using f = await profileFixture(async () => true, (registered) => {
    driver = registered
    return nativeStub({
      pause: (leaseID, reason) => { calls.push(["pause", leaseID, reason]); return true },
      resume: (leaseID) => { calls.push(["resume", leaseID]); return true },
      capture: async (leaseID, capture) => { calls.push(["capture", leaseID, capture]); captured.resolve(); return true },
    })
  })
  const peer = f.transport.connect({ ...peerInfo, send: (text) => { sent.push(JSON.parse(text)); return true }, close: () => {} })
  const frame = (value: unknown) => peer.receive(JSON.stringify(value))
  await frame({ type: "enroll", version: 1, profileID: profileA, profileLabel: "Chrome" })
  if (!driver) throw new Error("Chrome driver did not register")
  const signal = new AbortController().signal
  const proof = { candidateID: candidate.candidateID, sessionID: candidate.sessionID, targetID: target.id, authorization: "local-proof" }
  const reply = (result: unknown) => frame({ type: "result", id: sent.at(-1)?.id, result })
  const leaseID = Interaction.ID.create()
  const attaching = driver.attach(target, proof, signal)
  await reply({ sessionID: proof.sessionID, targetID: proof.targetID, pathname: target.pathname, leaseID, epoch: 3, revision: 1 })
  const lease = await attaching
  await frame({ type: "ping" })
  await frame({ type: "paused", leaseID, epoch: 2, reason: "dialog" })
  await frame({ type: "paused", leaseID: Interaction.ID.create(), epoch: 3, reason: "dialog" })
  expect(calls).toEqual([])
  await frame({ type: "paused", leaseID, epoch: 3, reason: "dialog" })
  await frame({ type: "resumed", leaseID, epoch: 3 })
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2X8AAAAASUVORK5CYII="
  const image = { mimeType: "image/png", base64: png, width: 1, height: 1 }
  await frame({ type: "capture", leaseID, epoch: 3, capture: { frame: { ...image, width: 2 } } })
  await frame({ type: "capture", leaseID, epoch: 3, capture: { frame: image, title: "Form", url: "https://example.test/form" } })
  await captured.promise
  expect(calls).toEqual([["pause", leaseID, "dialog"], ["resume", leaseID],
    ["capture", leaseID, { frame: image, title: "Form", url: "https://example.test/form" }]])

  const resuming = driver.resume(lease, signal)
  expect(sent.at(-1)).toMatchObject({ type: "request", op: "resume", input: { leaseID, epoch: 3 } })
  await reply(true)
  expect(await resuming).toBe(true)
  const observing = driver.observe(lease, signal)
  await reply({ revision: 2, pathname: target.pathname, elements: [] })
  await observing
  const performing = driver.perform(lease, 2, { callID: Interaction.ID.create(), action: { platform: "chrome", type: "scroll", deltaY: 1 } }, signal)
  await reply({ outcome: "paused", reason: "file_chooser" })
  expect(await performing).toEqual({ outcome: "paused", reason: "file_chooser" })
  expect(calls.at(-1)).toEqual(["pause", leaseID, "file_chooser"])
  expect(await driver.perform(lease, 2, { callID: Interaction.ID.create(), action: { platform: "chrome", type: "scroll", deltaY: 1 } }, signal))
    .toEqual({ outcome: "refused", reason: "stale" })
  await frame({ type: "paused", leaseID, epoch: 3, reason: "not-a-reason" })
  expect(sent.at(-1)).not.toMatchObject({ type: "authenticated" })
  const lost = await driver.observe(lease, signal).catch((error: unknown) => error)
  expect(lost).toMatchObject({ code: "target_lost" })
})

function runOf(frame: Record<string, unknown> | undefined) {
  const input = frame?.input
  return input && typeof input === "object" && "runID" in input ? input.runID : undefined
}

test("a Chrome script run is one consumed action with its own deadline, and an aborted run sends cancelRun and still settles", async () => {
  const candidate: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), sessionLabel: "Fixture Session",
    expiresAt: Date.now() + 10_000, purpose: "attach", selection: { platform: "chrome" } }
  const target = { kind: "chrome-tab" as const, id: Interaction.ID.create(), label: "Test tab", origin: "https://example.test", pathname: "/form" }
  const paused: unknown[] = []
  let driver: InteractionDriver | undefined
  const sent: Record<string, unknown>[] = []
  await using f = await profileFixture(async () => true, (registered) => {
    driver = registered
    return nativeStub({ pause: (leaseID, reason) => { paused.push([leaseID, reason]); return true } })
  })
  const peer = f.transport.connect({ ...peerInfo, send: (text) => { sent.push(JSON.parse(text)); return true }, close: () => {} })
  const frame = (value: unknown) => peer.receive(JSON.stringify(value))
  await frame({ type: "enroll", version: 1, profileID: profileA, profileLabel: "Chrome" })
  if (!driver?.run) throw new Error("Chrome driver has no run")
  const proof = { candidateID: candidate.candidateID, sessionID: candidate.sessionID, targetID: target.id, authorization: "local-proof" }
  const reply = (id: unknown, result: unknown) => frame({ type: "result", id, result })
  const leaseID = Interaction.ID.create()
  const attaching = driver.attach(target, proof, new AbortController().signal)
  await reply(sent.at(-1)?.id, { sessionID: proof.sessionID, targetID: proof.targetID, pathname: target.pathname, leaseID, epoch: 3, revision: 1 })
  const lease = await attaching

  const before = Date.now()
  const running = driver.run(lease, { mode: "code", source: "1 + 1", timeoutMs: 30_000 }, new AbortController().signal)
  const request = sent.at(-1)
  expect(request).toMatchObject({ type: "request", op: "run",
    input: { leaseID, epoch: 3, sessionID: proof.sessionID, revision: 1, mode: "code", source: "1 + 1", timeoutMs: 30_000 } })
  expect(Number(request?.deadline)).toBeGreaterThanOrEqual(before + 30_000)
  const runID = runOf(request)
  expect(runID).toMatch(/^[0-9a-f-]{36}$/)
  await reply(request?.id, { outcome: "completed", value: 2, logs: [{ level: "log", text: "two" }] })
  expect(await running).toEqual({ outcome: "completed", value: 2, logs: [{ level: "log", text: "two" }] })
  expect(await driver.run(lease, { mode: "code", source: "1", timeoutMs: 1000 }, new AbortController().signal))
    .toEqual({ outcome: "refused", reason: "stale" })

  const observing = driver.observe(lease, new AbortController().signal)
  await reply(sent.at(-1)?.id, { revision: 2, pathname: target.pathname, elements: [] })
  await observing
  const stop = new AbortController()
  const stopping = driver.run(lease, { mode: "script", source: "await new Promise(() => {})", timeoutMs: 1000 }, stop.signal)
  const second = sent.at(-1)
  stop.abort()
  expect(sent.at(-1)).toMatchObject({ type: "request", op: "cancelRun",
    input: { leaseID, epoch: 3, sessionID: proof.sessionID, runID: runOf(second) } })
  await reply(sent.at(-1)?.id, true)
  await reply(second?.id, { outcome: "stopped", logs: [] })
  expect(await stopping).toEqual({ outcome: "stopped", logs: [] })

  const third = await (async () => {
    const observed = driver.observe(lease, new AbortController().signal)
    await reply(sent.at(-1)?.id, { revision: 3, pathname: target.pathname, elements: [] })
    await observed
    const pending = driver.run?.(lease, { mode: "script", source: "alert(1)", timeoutMs: 1000 }, new AbortController().signal)
    await reply(sent.at(-1)?.id, { outcome: "paused", reason: "dialog" })
    return pending
  })()
  expect(third).toEqual({ outcome: "paused", reason: "dialog" })
  expect(paused).toEqual([[leaseID, "dialog"]])
})

test("a missing, corrupt, malformed or version-mismatched profile store authenticates nobody and a new Allow rewrites it", async () => {
  const credentialFor = async (f: Awaited<ReturnType<typeof profileFixture>>) => {
    const peer = f.socket()
    await peer.receive({ type: "enroll", version: 1, profileID: profileA, profileLabel: "Chrome" })
    const credential = peer.sent[0]?.credential
    if (typeof credential !== "string") throw new Error("Missing issued credential")
    return credential
  }
  const asked: unknown[] = []
  await using f = await profileFixture(async (input) => { asked.push(input); return true })
  const credential = await credentialFor(f)
  const valid = await Bun.file(f.profiles).text()
  const auth = { type: "authenticate", version: 1, extensionID: chromeExtensionID, profileID: profileA, credential }
  const stored = JSON.parse(valid)
  for (const broken of [undefined, "", "{", "null", JSON.stringify({ ...stored, version: 2 }), JSON.stringify({ version: 1 }),
    JSON.stringify({ ...stored, profiles: [{ ...stored.profiles[0], digest: "z".repeat(64) }] }),
    JSON.stringify({ ...stored, profiles: Array.from({ length: 33 }, () => stored.profiles[0]) })]) {
    if (broken === undefined) await rm(f.profiles)
    else await Bun.write(f.profiles, broken)
    const peer = f.socket()
    await peer.receive(auth)
    expect(peer.sent).toEqual([])
    expect(peer.closed).toEqual([chromeCloseRejected])
  }
  expect(asked).toHaveLength(1)
  await Bun.write(f.profiles, JSON.stringify({ ...stored, version: 2 }))
  const fresh = await credentialFor(f)
  expect(asked).toHaveLength(2)
  const rewritten = JSON.parse(await Bun.file(f.profiles).text())
  expect(rewritten).toMatchObject({ version: 1, profiles: [{ profileID: profileA, digest: createHash("sha256").update(fresh).digest("hex") }] })
  expect((await stat(f.profiles)).mode & 0o777).toBe(0o600)
  const peer = f.socket()
  await peer.receive({ ...auth, credential: fresh })
  expect(peer.sent).toEqual([{ type: "authenticated", version: 1 }])
})

test("isolated Chrome binds the exact private start URL and rejects forged, expired, and cross-Session proof before launch", async () => {
  let closes = 0
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async ({ candidateID }) => nativeStop(candidateID, {
    close: () => { closes++ },
  }) })
  const driver = isolated.driver
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), sessionLabel: "Fixture Session", expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url: "https://example.test/private?q=synthetic" } }
  const [target] = await driver.inventory(request)
  expect(target).toMatchObject({ kind: "chrome-isolated", origin: "https://example.test", pathname: "/private", url: "https://example.test/private?q=synthetic" })
  if (target.kind !== "chrome-isolated") throw new Error("Missing isolated target")
  const identity = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }
  const signal = new AbortController().signal
  expect(await isolated.approve({ ...identity, sessionID: SessionID.create() }, signal)).toBeUndefined()
  const proof = await isolated.approve(identity, signal)
  if (!proof) throw new Error("Missing local approval")
  expect(await isolated.approve(identity, signal)).toBeUndefined()
  expect(await driver.attach(target, { ...proof, authorization: "forged" }, signal).catch((error: unknown) => error))
    .toMatchObject({ message: "Isolated Chrome consent unavailable" })
  expect(closes).toBe(0)
  expect(await driver.attach({ ...target, pathname: "/admin" }, proof, signal).catch((error: unknown) => error))
    .toMatchObject({ message: "Isolated Chrome consent unavailable" })
  expect(closes).toBe(1)
  expect(await driver.attach(target, proof, signal).catch((error: unknown) => error)).toMatchObject({ message: "Isolated Chrome consent unavailable" })
  expect(await driver.inventory({ ...request, candidateID: Interaction.ID.create(), expiresAt: Date.now() - 1 })).toEqual([])
})

test("isolated Chrome cannot mint a proof when the native confirmation denies the exact launch", async () => {
  const confirmed: unknown[] = []
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async (request) => {
    confirmed.push(request)
    return undefined
  } })
  const url = "https://example.test/private?scope=one#details"
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), sessionLabel: "Fixture Session", expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url } }
  const [target] = await isolated.driver.inventory(request)
  const identity = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }
  const signal = new AbortController().signal
  expect(await isolated.approve(identity, signal)).toBeUndefined()
  expect(await isolated.approve(identity, signal)).toBeUndefined()
  expect(confirmed).toEqual([{ candidateID: request.candidateID, sessionID: request.sessionID, expiresAt: request.expiresAt, url }])
})

test("isolation discards an approval after cancellation and never substitutes the launch prompt for action consent", async () => {
  const controller = new AbortController()
  const decision = Promise.withResolvers<IsolatedStop>()
  const closed = Promise.withResolvers<void>()
  let confirmations = 0
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async () => {
    confirmations++
    return decision.promise
  } })
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), sessionLabel: "Fixture Session", expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url: "https://example.test/one" } }
  const [target] = await isolated.driver.inventory(request)
  const identity = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }
  const approval = isolated.approve(identity, controller.signal)
  expect(await isolated.approve(identity, new AbortController().signal)).toBeUndefined()
  expect(confirmations).toBe(1)
  controller.abort()
  expect(await approval).toBeUndefined()
  decision.resolve(nativeStop(request.candidateID, { close: () => closed.resolve() }))
  await closed.promise
  expect(await isolated.driver.inventory(request)).toEqual([])
  expect(await isolated.driver.inventory({ candidateID: Interaction.ID.create(), sessionID: request.sessionID, sessionLabel: "Fixture Session", targetID: target.id,
    expiresAt: request.expiresAt, purpose: "confirm", revision: 1,
    action: { platform: "chrome", type: "click", elementID: Interaction.ID.create(), destructive: true } })).toEqual([])
  expect(confirmations).toBe(1)
})

test("isolated Chrome refuses a destructive action before dispatch even with its valid launch proof", async () => {
  const elementID = Interaction.ID.create()
  const url = "https://example.test/one"
  const dispatched: Interaction.ChromeAction[] = []
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async ({ candidateID }) => nativeStop(candidateID) },
    async (destination) => ({
      alive: () => true,
      observe: async () => ({ pathname: new URL(destination).pathname, elements: [{ id: elementID, role: "button", label: "Open", editable: false }] }),
      perform: async (action, _signal, dispatch) => {
        dispatch()
        dispatched.push(action)
        return { outcome: "applied" }
      },
      preview: async () => undefined,
      script: async () => ({ result: { outcome: "completed" as const, logs: [] }, verified: true }),
      close: async () => {},
    }))
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), sessionLabel: "Fixture Session", expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url } }
  const [target] = await isolated.driver.inventory(request)
  const signal = new AbortController().signal
  const launchProof = await isolated.approve({ candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }, signal)
  if (!launchProof) throw new Error("Missing signed native approval")
  const lease = await isolated.driver.attach(target, launchProof, signal)
  try {
    const observed = await isolated.driver.observe(lease, signal)
    const action = { platform: "chrome", type: "click", elementID } as const
    const destructive = { ...action, destructive: true } as const
    expect(await isolated.driver.inventory({ candidateID: Interaction.ID.create(), sessionID: request.sessionID, sessionLabel: "Fixture Session", targetID: target.id,
      expiresAt: request.expiresAt, purpose: "confirm", revision: observed.revision, action: destructive })).toEqual([])
    expect(await isolated.driver.perform(lease, observed.revision, { callID: Interaction.ID.create(), action: destructive, consent: launchProof }, signal))
      .toEqual({ outcome: "refused", reason: "unsupported" })
    expect(dispatched).toEqual([])
    expect(await isolated.driver.perform(lease, observed.revision, { callID: Interaction.ID.create(), action }, signal)).toEqual({ outcome: "applied" })
    expect(dispatched).toEqual([action])
  } finally {
    await isolated.driver.detach(lease, "stopped")
  }
})

test("isolated Chrome runs a script as one consumed action and revokes the lease when the run leaves the approved page", async () => {
  const lost: unknown[] = []
  const runs: unknown[] = []
  let verified = true
  let closed = 0
  const url = "https://example.test/one"
  const isolated = makeChromeIsolatedDriver({ lost: (...args) => { lost.push(args) }, confirmIsolated: async ({ candidateID }) => nativeStop(candidateID) },
    async (destination) => ({
      alive: () => true,
      observe: async () => ({ pathname: new URL(destination).pathname, elements: [] }),
      perform: async () => ({ outcome: "applied" as const }),
      preview: async () => undefined,
      script: async (request: unknown, signal: AbortSignal) => {
        runs.push([request, signal.aborted])
        return { result: { outcome: "completed" as const, value: 3, logs: [] }, verified }
      },
      close: async () => { closed++ },
    }))
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), sessionLabel: "Fixture Session", expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url } }
  const [target] = await isolated.driver.inventory(request)
  const signal = new AbortController().signal
  const proof = await isolated.approve({ candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }, signal)
  if (!proof || !isolated.driver.run) throw new Error("Missing isolated run")
  const lease = await isolated.driver.attach(target, proof, signal)
  const script = { mode: "script" as const, source: "return 3", timeoutMs: 1000 }
  expect(await isolated.driver.run(lease, script, signal)).toEqual({ outcome: "completed", value: 3, logs: [] })
  expect(runs).toEqual([[script, false]])
  expect(await isolated.driver.run(lease, script, signal)).toEqual({ outcome: "refused", reason: "stale" })
  await isolated.driver.observe(lease, signal)
  verified = false
  expect(await isolated.driver.run(lease, script, signal)).toEqual({ outcome: "completed", value: 3, logs: [] })
  expect(lost).toEqual([[lease.id, "target_lost"]])
  await Bun.sleep(0)
  expect(closed).toBe(1)
  expect(await isolated.driver.run(lease, script, signal)).toEqual({ outcome: "refused", reason: "stale" })
})

test("isolated Chrome closes a mismatched or already stopped handle without binding a lease", async () => {
  let closes = 0
  for (const stale of [false, true]) {
    const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async ({ candidateID }) => nativeStop(
      stale ? candidateID : Interaction.ID.create(), { signal: stale ? AbortSignal.abort() : new AbortController().signal,
        close: () => { closes++ } },
    ) })
    const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), sessionLabel: "Fixture Session", expiresAt: Date.now() + 10_000,
      purpose: "attach", selection: { platform: "chrome", mode: "isolated", url: "https://example.test/one" } }
    const [target] = await isolated.driver.inventory(request)
    const identity = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }
    expect(await isolated.approve(identity, new AbortController().signal)).toBeUndefined()
    expect(await isolated.driver.inventory(request)).toEqual([])
  }
  expect(closes).toBe(2)
})

test("isolation binds the exact new lease to the signed Stop handle before launch and closes a failed bind", async () => {
  const seen: string[] = []
  const stop = new AbortController()
  let closes = 0
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async (request) => ({
    candidateID: request.candidateID,
    signal: stop.signal,
    bind: async (id: Interaction.ID) => { seen.push(id); return false },
    close: () => { closes++ },
  }) })
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), sessionLabel: "Fixture Session", expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url: "https://example.test/one" } }
  const [target] = await isolated.driver.inventory(request)
  const identity = { candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }
  const signal = new AbortController().signal
  const approved = await isolated.approve(identity, signal)
  expect(approved).toMatchObject(identity)
  if (!approved) throw new Error("Missing signed native approval")
  expect(await isolated.driver.attach(target, approved, signal).catch((error: unknown) => error))
    .toMatchObject({ message: "Isolated Chrome Stop binding unavailable" })
  expect(seen).toHaveLength(1)
  expect(seen[0]).not.toBe(identity.targetID)
  expect(closes).toBe(1)
})

test("signed Stop aborts an in-flight lease bind and closes once before Chrome can launch", async () => {
  const stop = new AbortController()
  const binding = Promise.withResolvers<boolean>()
  const dispatch = Promise.withResolvers<AbortSignal>()
  let closes = 0
  const isolated = makeChromeIsolatedDriver({ lost: () => {}, confirmIsolated: async ({ candidateID }) => nativeStop(candidateID, {
    signal: stop.signal,
    bind: (_, signal) => { dispatch.resolve(signal); return binding.promise },
    close: () => { closes++ },
  }) })
  const request: InventoryRequest = { candidateID: Interaction.ID.create(), sessionID: SessionID.create(), sessionLabel: "Fixture Session", expiresAt: Date.now() + 10_000,
    purpose: "attach", selection: { platform: "chrome", mode: "isolated", url: "https://example.test/one" } }
  const [target] = await isolated.driver.inventory(request)
  const signal = new AbortController().signal
  const approved = await isolated.approve({ candidateID: request.candidateID, sessionID: request.sessionID, targetID: target.id }, signal)
  if (!approved) throw new Error("Missing signed native approval")
  const attaching = isolated.driver.attach(target, approved, signal).catch((error: unknown) => error)
  const attachingSignal = await dispatch.promise
  stop.abort("stopped")
  expect(attachingSignal.aborted).toBe(true)
  expect(await attaching).toMatchObject({ message: "Chrome operation interrupted" })
  binding.resolve(true)
  expect(await isolated.driver.inventory(request)).toEqual([])
  expect(closes).toBe(1)
})

test("isolated preview only returns a frame from an unchanged, inspected CDP target", async () => {
  const data = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, ...Array<number>(9).fill(0), 255, 217]).toString("base64")
  const tree = { nodeName: "#document", nodeType: 9, childNodeCount: 1, children: [{ nodeName: "HTML", nodeType: 1, childNodeCount: 0 }] }
  for (const state of ["steady", "permission-before", "frame-during", "uninspected-after"]) {
    const checks: string[] = []
    let valid = true
    let captured = false
    const frame = await captureIsolatedPreview({
      current: () => valid,
      verify: async () => { checks.push("scope") },
      inspect: async (input) => {
        checks.push(input.keep ? "protect" : input.ticket ? "settle" : "inspect")
        if (input.ticket) expect(input.ticket).toBe("private-document")
        return { safe: true, ticket: "private-document" }
      },
      page: async (method) => {
        checks.push(method)
        if (method === "DOM.getDocument") return { root: captured && state === "uninspected-after" ? { ...tree, children: undefined } : tree }
        if (method === "Page.getLayoutMetrics") {
          if (state === "permission-before") valid = false
          return { cssVisualViewport: { clientWidth: 1, clientHeight: 1, pageX: 0, pageY: 0 } }
        }
        expect(method).toBe("Page.captureScreenshot")
        captured = true
        if (state === "frame-during") valid = false
        return { data }
      },
    })
    if (state === "steady") {
      expect(frame).toEqual({ mimeType: "image/jpeg", base64: data, width: 1, height: 1 })
      expect(checks).toEqual(["scope", "inspect", "DOM.getDocument", "Page.getLayoutMetrics", "scope", "protect", "Page.captureScreenshot",
        "scope", "DOM.getDocument", "settle"])
    } else {
      expect(frame).toBeUndefined()
      expect(captured).toBe(state !== "permission-before")
      expect(checks).not.toContain("settle")
    }
  }
})

test("private Chrome pipe correlates fragmented replies and rejects pending work on transport loss without replay", async () => {
  const inbound = new PassThrough()
  const outbound = new PassThrough()
  const frames: string[] = []
  outbound.on("data", (data: Buffer) => frames.push(data.toString()))
  const pipe = connectChromePipe(inbound, outbound)
  const signal = new AbortController().signal
  const first = pipe.command("Browser.getVersion", {}, signal)
  inbound.write(Buffer.from('{"id":1,"res'))
  inbound.write(Buffer.from('ult":{"product":"fixture"}}\0'))
  expect(await first).toEqual({ product: "fixture" })
  const second = pipe.command("Browser.getVersion", {}, signal)
  pipe.close()
  expect(await second.catch((error: unknown) => error)).toMatchObject({ message: "Chrome pipe closed" })
  inbound.write(Buffer.from('{"id":2,"result":{}}\0'))
  expect(await pipe.command("Browser.getVersion", {}, signal).catch((error: unknown) => error)).toMatchObject({ message: "Chrome pipe unavailable" })
  expect(frames).toHaveLength(2)
  expect(frames.every((frame) => frame.endsWith("\0"))).toBe(true)
})
