import { expect, test } from "bun:test"
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { SessionID } from "@ycoding-ai/schema/session-id"
import { makeAuthority } from "../src/interaction/authority"
import type { NativeInteraction } from "../src/interaction/driver"
import { makeMacOSAdapter, makeMacOSInteraction } from "../src/interaction/macos"

type StubMode = "exit" | "dialog" | "foreground" | "sensitive" | "observe-paused" | "resumed-in-panel" | "stopped-in-panel" | "invalid-reason" | "allow" | "deny" |
  "malformed" | "hang"

const pauseReasons: Partial<Record<StubMode, string>> = { foreground: "foreground_required", sensitive: "sensitive", "invalid-reason": "bogus" }

function stubHelper(mode: StubMode, lease: string, log: string) {
  return `#!${process.execPath}
const { appendFileSync } = require("node:fs")
const window = { pid: 4100, started: "100:21", bundleID: "local.synthetic.Example", windowID: 72 }
let buffer = ""
let observed = 0
if (${JSON.stringify(mode)} === "exit") process.exit(3)
const line = (value) => JSON.stringify(value) + "\\n"
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (let index = buffer.indexOf("\\n"); index >= 0; index = buffer.indexOf("\\n")) {
    const command = JSON.parse(buffer.slice(0, index))
    buffer = buffer.slice(index + 1)
    appendFileSync(${JSON.stringify(log)}, command.operation + "\\n")
    const ok = { id: command.id, generation: command.generation, state: "ok" }
    const paused = { ...ok, state: "paused", lease: ${JSON.stringify(lease)} }
    const notice = { generation: command.generation, lease: ${JSON.stringify(lease)} }
    if (command.operation === "inventory") process.stdout.write(line({ ...ok, targets: [{ target: window, label: "Synthetic" }] }))
    else if (command.operation === "attach" || command.operation === "resume") process.stdout.write(line({ ...ok, lease: ${JSON.stringify(lease)} }))
    else if (command.operation === "observe" && ${JSON.stringify(mode)} === "observe-paused" && observed++ > 0) process.stdout.write(line({ ...paused, reason: "sensitive" }))
    else if (command.operation === "observe") process.stdout.write(line({ ...ok, lease: ${JSON.stringify(lease)}, observation: { revision: "a".repeat(64), controls: [] } }))
    else if (command.operation === "perform" && ${JSON.stringify(mode)} === "resumed-in-panel") {
      process.stdout.write(line({ ...paused, reason: "foreground_required" }) + line({ ...notice, state: "resumed" }))
    } else if (command.operation === "perform" && ${JSON.stringify(mode)} === "stopped-in-panel") {
      process.stdout.write(line({ ...paused, reason: "sensitive" }) + line({ ...notice, state: "stopped" }))
    } else if (command.operation === "perform") process.stdout.write(line({ ...paused, reason: ${JSON.stringify(pauseReasons[mode] ?? "dialog")} }))
    else if (command.operation === "confirmChromeProfile" && ${JSON.stringify(mode)} === "hang") continue
    else if (command.operation === "confirmChromeProfile" && ${JSON.stringify(mode)} === "malformed") process.stdout.write(line(ok))
    else if (command.operation === "confirmChromeProfile") process.stdout.write(line({ ...ok, consent: ${JSON.stringify(mode)} === "allow" ? "approved" : "denied" }))
    else process.stdout.write(line(ok))
  }
})
`
}

async function stubAdapter(mode: StubMode, verified = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-macos-stub-"))
  const lease = Interaction.ID.create()
  const log = path.join(directory, "operations.log")
  const executable = path.join(directory, "helper")
  await Bun.write(executable, stubHelper(mode, lease, log))
  await chmod(executable, 0o755)
  const adapter = makeMacOSAdapter({ application: directory, executable, verify: async () => verified })
  return {
    adapter, lease, directory,
    operations: async () => await Bun.file(log).exists() ? (await Bun.file(log).text()).trim().split("\n") : [],
    async cleanup() {
      adapter.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function attachedStub(mode: StubMode) {
  const stub = await stubAdapter(mode)
  const calls: unknown[][] = []
  const request = {
    candidateID: Interaction.ID.create(), sessionID: SessionID.make("ses_mac_stub"), sessionLabel: "Stub Session",
    expiresAt: Date.now() + 30_000, purpose: "attach", selection: { platform: "macos" },
  } as const
  const targets = await stub.adapter.driver.inventory(request)
  const native: NativeInteraction = {
    pending: () => [request],
    onPending: () => () => {},
    inventory: async () => targets,
    approve: async (proof) => {
      await stub.adapter.driver.attach(targets[0], proof, new AbortController().signal)
      return true
    },
    reject: () => true,
    stop: (leaseID, reason) => { calls.push(["stop", leaseID, reason]); return true },
    pause: (leaseID, reason) => { calls.push(["pause", leaseID, reason]); return true },
    resume: (leaseID) => { calls.push(["resume", leaseID]); return true },
    capture: async () => false,
    disconnect: () => {},
  }
  expect(targets).toHaveLength(1)
  expect(await stub.adapter.approve(native, request.candidateID, targets[0].id)).toBe(true)
  return { ...stub, calls, lease: { id: stub.lease } }
}

const scroll = { callID: Interaction.ID.create(), action: { platform: "macos", type: "scroll", deltaY: 120 } } as const

async function authorityStub(mode: StubMode) {
  const stub = await stubAdapter(mode)
  const authority = makeAuthority()
  const native = authority.register(stub.adapter.driver)
  const sessionID = SessionID.make("ses_mac_authority")
  const pending = await authority.request(sessionID, { platform: "macos" })
  if (pending.state !== "pending") throw new Error("Expected a pending macOS request")
  const candidate = native.pending()[0]
  const targets = await native.inventory(candidate.candidateID)
  expect(await stub.adapter.approve(native, candidate.candidateID, targets[0].id)).toBe(true)
  expect(authority.status(sessionID)).toMatchObject({ state: "active", platform: "macos", generation: pending.generation })
  const observed = await authority.observe(sessionID, pending.generation)
  return {
    ...stub, authority, sessionID, generation: pending.generation, observed,
    perform: () => authority.perform(sessionID, pending.generation, observed.revision, Interaction.ID.create(), scroll.action),
    async cleanup() {
      authority.shutdown()
      await stub.cleanup()
    },
  }
}

test.each([["foreground", "foreground_required"], ["sensitive", "sensitive"]] as const)(
  "a %s pause from the helper sets the Session status to paused until an authority resume", async (mode, reason) => {
    const stub = await authorityStub(mode)
    try {
      expect(await stub.perform()).toEqual({ outcome: "paused", reason })
      expect(stub.authority.status(stub.sessionID)).toMatchObject({ state: "paused", platform: "macos", generation: stub.generation, reason })
      expect(await stub.authority.observe(stub.sessionID, stub.generation).catch((error: unknown) => error)).toMatchObject({ code: "paused" })
      expect(await stub.perform()).toEqual({ outcome: "paused", reason })
      expect((await stub.operations()).filter((operation) => operation === "perform")).toHaveLength(1)

      expect(await stub.authority.resume(stub.sessionID, stub.generation)).toBe(true)
      expect(stub.authority.status(stub.sessionID)).toMatchObject({ state: "active", generation: stub.generation })
      expect((await stub.authority.observe(stub.sessionID, stub.generation)).revision).toBeGreaterThan(stub.observed.revision)
      expect((await stub.operations()).slice(-2)).toEqual(["resume", "observe"])
    } finally { await stub.cleanup() }
  },
)

test("the Session status follows a helper-panel Resume and a Stop while paused", async () => {
  const panel = await authorityStub("resumed-in-panel")
  try {
    expect(await panel.perform()).toEqual({ outcome: "refused", reason: "stale" })
    expect(panel.authority.status(panel.sessionID)).toMatchObject({ state: "active", generation: panel.generation })
    expect((await panel.authority.observe(panel.sessionID, panel.generation)).revision).toBeGreaterThan(panel.observed.revision)
  } finally { await panel.cleanup() }

  const stopped = await authorityStub("sensitive")
  try {
    await stopped.perform()
    expect(stopped.authority.status(stopped.sessionID)).toMatchObject({ state: "paused", reason: "sensitive" })
    expect(stopped.authority.stop(stopped.sessionID, stopped.generation)).toBe(true)
    expect(stopped.authority.status(stopped.sessionID)).toMatchObject({ state: "stopped", reason: "stopped" })
    for (let attempt = 0; attempt < 100 && !(await stopped.operations()).includes("detach"); attempt++) await Bun.sleep(10)
    expect((await stopped.operations()).at(-1)).toBe("detach")
    expect(await stopped.authority.resume(stopped.sessionID, stopped.generation)).toBe(false)
  } finally { await stopped.cleanup() }
})

test("a pause reported while observing keeps the lease and sets the Session status to paused", async () => {
  const stub = await authorityStub("observe-paused")
  try {
    expect(await stub.authority.observe(stub.sessionID, stub.generation).catch((error: unknown) => error)).toMatchObject({ code: "paused" })
    expect(stub.authority.status(stub.sessionID)).toMatchObject({ state: "paused", generation: stub.generation, reason: "sensitive" })
    expect(await stub.authority.resume(stub.sessionID, stub.generation)).toBe(true)
    expect(stub.authority.status(stub.sessionID)).toMatchObject({ state: "active", generation: stub.generation })
  } finally { await stub.cleanup() }
})

test("macOS helper pause reaches authority once and holds work until a server resume", async () => {
  const stub = await attachedStub("dialog")
  const signal = new AbortController().signal
  try {
    expect((await stub.adapter.driver.observe(stub.lease, signal)).revision).toBe(1)
    expect(await stub.adapter.driver.perform(stub.lease, 1, scroll, signal)).toEqual({ outcome: "paused", reason: "dialog" })
    expect(stub.calls).toEqual([["pause", stub.lease.id, "dialog"]])
    expect(await stub.adapter.driver.perform(stub.lease, 1, scroll, signal)).toEqual({ outcome: "paused", reason: "dialog" })
    expect(await stub.adapter.driver.observe(stub.lease, signal).catch((error: unknown) => error)).toMatchObject({ code: "paused" })
    expect(await stub.adapter.driver.preview(stub.lease, signal)).toBeUndefined()
    expect((await stub.operations()).filter((operation) => operation === "perform" || operation === "observe" || operation === "preview"))
      .toEqual(["observe", "perform"])

    expect(await stub.adapter.driver.resume(stub.lease, signal)).toBe(true)
    expect(stub.calls).toEqual([["pause", stub.lease.id, "dialog"]])
    expect((await stub.adapter.driver.observe(stub.lease, signal)).revision).toBe(2)
    expect((await stub.operations()).slice(-2)).toEqual(["resume", "observe"])
  } finally { await stub.cleanup() }
})

test("a resume clicked in the helper panel right after the pause leaves the lease active", async () => {
  const stub = await attachedStub("resumed-in-panel")
  const signal = new AbortController().signal
  try {
    await stub.adapter.driver.observe(stub.lease, signal)
    expect(await stub.adapter.driver.perform(stub.lease, 1, scroll, signal)).toEqual({ outcome: "refused", reason: "stale" })
    expect(stub.calls).toEqual([["pause", stub.lease.id, "foreground_required"], ["resume", stub.lease.id]])
    expect((await stub.adapter.driver.observe(stub.lease, signal)).revision).toBe(2)
  } finally { await stub.cleanup() }
})

test("Stop revokes a paused macOS lease from either side", async () => {
  const panel = await attachedStub("stopped-in-panel")
  const signal = new AbortController().signal
  try {
    await panel.adapter.driver.observe(panel.lease, signal)
    expect(await panel.adapter.driver.perform(panel.lease, 1, scroll, signal)).toEqual({ outcome: "paused", reason: "sensitive" })
    expect(panel.calls).toEqual([["pause", panel.lease.id, "sensitive"], ["stop", panel.lease.id, "stopped"]])
    expect(await panel.adapter.driver.resume(panel.lease, signal)).toBe(false)
  } finally { await panel.cleanup() }

  const server = await attachedStub("dialog")
  try {
    await server.adapter.driver.observe(server.lease, signal)
    await server.adapter.driver.perform(server.lease, 1, scroll, signal)
    await server.adapter.driver.detach(server.lease, "stopped")
    expect((await server.operations()).at(-1)).toBe("detach")
    expect(await server.adapter.driver.observe(server.lease, signal).catch((error: unknown) => error)).toMatchObject({ code: "targetChanged" })
    expect(await server.adapter.driver.resume(server.lease, signal)).toBe(false)
  } finally { await server.cleanup() }
})

test("an unknown pause reason from the helper is an uncertain outcome, not a pause", async () => {
  const stub = await attachedStub("invalid-reason")
  const signal = new AbortController().signal
  try {
    await stub.adapter.driver.observe(stub.lease, signal)
    expect(await stub.adapter.driver.perform(stub.lease, 1, scroll, signal)).toEqual({ outcome: "uncertain" })
    expect(stub.calls.filter((call) => call[0] === "pause")).toEqual([])
  } finally { await stub.cleanup() }
})

test.each([["allow", true], ["deny", false], ["malformed", false]] as const)(
  "Chrome profile consent maps a %s panel reply to %p", async (mode, expected) => {
    const stub = await stubAdapter(mode)
    try {
      expect(await stub.adapter.confirmChromeProfile({ profileLabel: "Work", matchCode: "K7Q2-M9" }, new AbortController().signal)).toBe(expected)
      expect(await stub.operations()).toEqual(["hello", "confirmChromeProfile"])
    } finally { await stub.cleanup() }
  },
)

test("Chrome profile consent defaults to Deny on abort and never shows invalid values", async () => {
  const stub = await stubAdapter("hang")
  try {
    for (const input of [
      { profileLabel: "", matchCode: "K7Q2-M9" }, { profileLabel: " Work", matchCode: "K7Q2-M9" },
      { profileLabel: "Work\u202e", matchCode: "K7Q2-M9" }, { profileLabel: "W".repeat(129), matchCode: "K7Q2-M9" },
      { profileLabel: "Work", matchCode: "K7Q" }, { profileLabel: "Work", matchCode: "K7Q2 M9" },
    ]) expect(await stub.adapter.confirmChromeProfile(input, new AbortController().signal)).toBe(false)
    expect(await stub.adapter.confirmChromeProfile({ profileLabel: "Work", matchCode: "K7Q2-M9" }, AbortSignal.abort())).toBe(false)
    expect(await stub.operations()).toEqual([])

    const controller = new AbortController()
    const decision = stub.adapter.confirmChromeProfile({ profileLabel: "Work", matchCode: "K7Q2-M9" }, controller.signal)
    for (let attempt = 0; attempt < 200 && !(await stub.operations()).includes("confirmChromeProfile"); attempt++) await Bun.sleep(10)
    controller.abort()
    expect(await decision).toBe(false)
    expect(await stub.operations()).toEqual(["hello", "confirmChromeProfile"])
  } finally { await stub.cleanup() }
})

test("helper availability resolves true only after a verified helper completes its handshake", async () => {
  const ready = await stubAdapter("dialog")
  try {
    expect(await ready.adapter.available(new AbortController().signal)).toBe(true)
    expect(await ready.operations()).toEqual(["hello"])
    expect(await ready.adapter.available(AbortSignal.abort())).toBe(false)
  } finally { await ready.cleanup() }

  const unverified = await stubAdapter("dialog", false)
  const exited = await stubAdapter("exit")
  try {
    expect(await unverified.adapter.available(new AbortController().signal)).toBe(false)
    expect(await unverified.operations()).toEqual([])
    expect(await exited.adapter.available(new AbortController().signal)).toBe(false)
  } finally {
    await unverified.cleanup()
    await exited.cleanup()
  }
})

test.skipIf(process.platform !== "darwin")("a missing signed helper is unavailable", async () => {
  const adapter = makeMacOSInteraction({ application: "/synthetic/YCoding Interaction.app", certificateSHA1: "a".repeat(40) })
  try {
    expect(await adapter.available(new AbortController().signal)).toBe(false)
  } finally { adapter.close() }
})

test.skipIf(process.platform !== "darwin")("macOS Chrome profile consent refuses without a signed helper", async () => {
  const adapter = makeMacOSInteraction({ application: "/synthetic/YCoding Interaction.app", certificateSHA1: "a".repeat(40) })
  try {
    expect(await adapter.confirmChromeProfile({ profileLabel: "Work", matchCode: "K7Q2-M9" }, new AbortController().signal)).toBe(false)
  } finally { adapter.close() }
})

test.skipIf(process.platform !== "darwin")("macOS attach refuses a fabricated proof before touching the helper", async () => {
  const adapter = makeMacOSInteraction({ application: "/synthetic/YCoding Interaction.app", certificateSHA1: "a".repeat(40) })
  const target = { kind: "macos-window", id: Interaction.ID.create(), label: "Synthetic", bundleID: "local.synthetic.Example" } as const
  try {
    const result = await adapter.driver.attach(target, {
      candidateID: Interaction.ID.create(), sessionID: SessionID.make("ses_mac_fixture"), targetID: target.id,
      authorization: crypto.randomUUID(),
    }, new AbortController().signal).catch((error: unknown) => error)
    expect(result).toMatchObject({ code: "notAuthorized" })
  } finally { adapter.close() }
})

test.skipIf(process.platform !== "darwin")("isolated Chrome cannot obtain a Stop handle without a current signed presenter", async () => {
  const adapter = makeMacOSInteraction({ application: "/synthetic/YCoding Interaction.app", certificateSHA1: "a".repeat(40) })
  const request = { candidateID: Interaction.ID.create(), sessionID: SessionID.make("ses_isolated_fixture"),
    url: "https://example.test/", expiresAt: Date.now() + 30_000 }
  const signal = new AbortController().signal
  try {
    expect(await adapter.confirmIsolated({ ...request, expiresAt: 1 }, signal)).toBeUndefined()
    expect(await adapter.confirmIsolated(request, AbortSignal.abort())).toBeUndefined()
    expect(await adapter.confirmIsolated(request, signal)).toBeUndefined()
  } finally { adapter.close() }
})

const focusStealing = [
  { symbol: "application activation", pattern: /\.activate\(\s*(?:\)|options\s*:|ignoringOtherApps\s*:|from\s*:)/, example: "NSApp.activate(ignoringOtherApps: true)" },
  { symbol: "unhide", pattern: /unhide/i, example: "NSRunningApplication(processIdentifier: pid)?.unhide()" },
  { symbol: "AXRaise", pattern: /AXRaise|kAXRaiseAction/, example: "AXUIElementPerformAction(window, kAXRaiseAction as CFString)" },
  { symbol: "cursor warp", pattern: /CGWarpMouseCursorPosition/, example: "CGWarpMouseCursorPosition(point)" },
  { symbol: "HID event tap", pattern: /cghidEventTap|kCGHIDEventTap/, example: "event.post(tap: .cghidEventTap)" },
  { symbol: "open -b", pattern: /\bopen\s+-\w*b\b|["'`]open["'`]\s*,\s*\[?\s*["'`]-\w*b/, example: 'spawn("open", ["-b", bundleID])' },
  { symbol: "osascript", pattern: /osascript/, example: 'Bun.spawn(["osascript", "-e", script])' },
  { symbol: "NSWorkspace open", pattern: /NSWorkspace\.shared\.open/, example: "NSWorkspace.shared.openApplication(at: url, configuration: configuration)" },
]

test("the macOS adapter and helper sources never call an API that moves focus, raises a window or warps the cursor", async () => {
  expect(focusStealing.filter((entry) => !entry.pattern.test(entry.example)).map((entry) => entry.symbol)).toEqual([])
  const helper = path.join(import.meta.dir, "../interaction-macos")
  const sources = [path.join(import.meta.dir, "../src/interaction/macos.ts"),
    ...(await readdir(helper, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => path.join(helper, entry.name))]
  expect(sources.map((file) => path.basename(file)).toSorted()).toEqual(["ControlPanel.swift", "Fence.swift", "Service.swift", "WindowHost.swift", "macos.ts"])
  const hits = await Promise.all(sources.map(async (file) => (await Bun.file(file).text()).split("\n").flatMap((line, index) =>
    focusStealing.filter((entry) => entry.pattern.test(line)).map((entry) => `${path.basename(file)}:${index + 1} ${entry.symbol}`))))
  expect(hits.flat()).toEqual([])
})
