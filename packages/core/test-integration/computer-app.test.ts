import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MacOSComputer } from "@ycoding-ai/core/computer/macos"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { AppProcess } from "@ycoding-ai/core/process"
import { testEffect } from "../test/lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))

// Requires the built development app; macOS asks for each missing grant and the call fails until the user allows it.
describe("macOS computer use app", () => {
  it.live("lists running apps and their layer-zero windows without changing the frontmost app", () =>
    Effect.gen(function* () {
      const processes = yield* AppProcess.Service
      const invoke = MacOSComputer.invokeWith(processes, "darwin")
      yield* Effect.addFinalizer(invoke.shutdown)
      const response = yield* invoke({
        action: "desktop.list", owner: { sessionID: "integration", callID: "list" },
      }, new AbortController().signal)
      expect(response.apps).toBeDefined()
      expect(response.apps?.length).toBeLessThanOrEqual(64)
      expect(response.apps?.every((app) => app.windows.length <= 32)).toBe(true)
    }), 60_000)

  it.live(
    "inspects a Finder path through the app's Automation grant",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(async () => realpath(await mkdtemp(path.join(os.tmpdir(), "ycoding-finder-"))))
        yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
        const file = path.join(directory, "file.txt")
        yield* Effect.promise(() => writeFile(file, "fixture\n"))
        const processes = yield* AppProcess.Service
        const response = yield* MacOSComputer.invokeWith(processes, "darwin")(
          {
            action: "finder.inspect",
            owner: { sessionID: "integration", callID: "finder-path" },
            target: { platform: "macos", application: "finder", path: file },
          },
          new AbortController().signal,
        )
        expect(response.action).toBe("finder.inspect")
        expect(response.revision).toMatch(/^[0-9a-f]{64}$/)
      }),
    60_000,
  )

  it.live(
    "inspects an explicitly identified window that is not on the current Space",
    () =>
      Effect.gen(function* () {
        const target = requireTarget()
        const processes = yield* AppProcess.Service
        const response = yield* MacOSComputer.invokeWith(processes, "darwin")(
          {
            action: "desktop.inspect",
            owner: { sessionID: "integration", callID: "off-space-window" },
            target: { platform: "macos", application: "desktop", ...target },
          },
          new AbortController().signal,
        )
        expect(response.action).toBe("desktop.inspect")
        expect(typeof response.accessible).toBe("boolean")
        if (response.accessible) expect(response.elements?.[0]?.role).toBe("AXWindow")
        else expect(response.elements).toEqual([])
      }),
    60_000,
  )

  it.live(
    "captures an explicitly identified window that is not on the current Space",
    () =>
      Effect.gen(function* () {
        const target = requireTarget()
        const processes = yield* AppProcess.Service
        const response = yield* MacOSComputer.invokeWith(processes, "darwin")(
          {
            action: "desktop.capture",
            owner: { sessionID: "integration", callID: "off-space-capture" },
            target: { platform: "macos", application: "desktop", ...target },
          },
          new AbortController().signal,
        )
        expect(response.action).toBe("desktop.capture")
        expect(Buffer.from(response.image ?? "", "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
        expect(response.width).toBeGreaterThan(0)
        expect(response.height).toBeGreaterThan(0)
        expect(response.scale).toBeGreaterThan(0)
      }),
    60_000,
  )

  it.live("clicks a caller-designated safe coordinate off-Space without changing the frontmost app", () =>
    Effect.gen(function* () {
      const target = requireTarget()
      const x = Number(process.env.YCODING_TEST_DESKTOP_CLICK_X)
      const y = Number(process.env.YCODING_TEST_DESKTOP_CLICK_Y)
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0)
        throw new Error("Set YCODING_TEST_DESKTOP_CLICK_X/Y to a safe clickable coordinate inside the target window")
      const processes = yield* AppProcess.Service
      const invoke = MacOSComputer.invokeWith(processes, "darwin")
      const before = yield* invoke({ action: "desktop.list", owner: { sessionID: "integration", callID: "before-click" } }, new AbortController().signal)
      const inspected = yield* invoke({ action: "desktop.inspect", owner: { sessionID: "integration", callID: "inspect-click" },
        target: { platform: "macos", application: "desktop", ...target } }, new AbortController().signal)
      const clicked = yield* invoke({ action: "desktop.click", owner: { sessionID: "integration", callID: "coordinate-click" },
        target: { platform: "macos", application: "desktop", ...target }, expectedRevision: inspected.revision,
        x, y }, new AbortController().signal)
      const after = yield* invoke({ action: "desktop.list", owner: { sessionID: "integration", callID: "after-click" } }, new AbortController().signal)
      expect(clicked.revision).toMatch(/^[0-9a-f]{64}$/)
      expect(clicked.effect).toBe("changed")
      expect(after.apps?.find((app) => app.is_active)?.pid).toBe(before.apps?.find((app) => app.is_active)?.pid)
    }), 60_000)
  for (const [name, activates] of [
    ["keeps foreground focus during a background fixture click", false],
    ["does not counter a background fixture's self-activation on click", true],
  ] as const) it.live(name, () => Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "ycoding-focus-fixture-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
    const application = path.join(directory, "Focus Fixture.app")
    const executable = path.join(application, "Contents/MacOS/fixture")
    yield* Effect.promise(() => mkdir(path.dirname(executable), { recursive: true }))
    const compiled = yield* Effect.promise(() => Bun.$`/usr/bin/xcrun swiftc ${path.join(import.meta.dir, "fixtures/computer-focus.swift")} -o ${executable}`.quiet())
    expect(compiled.exitCode).toBe(0)
    yield* Effect.promise(() => writeFile(path.join(application, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.ycoding.focus-fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`))
    const state = path.join(directory, "clicks")
    yield* Effect.promise(() => writeFile(state, "0"))
    const processes = yield* AppProcess.Service
    const invoke = MacOSComputer.invokeWith(processes, "darwin")
    yield* Effect.addFinalizer(invoke.shutdown)
    const before = yield* invoke({ action: "desktop.list", owner: { sessionID: "fixture", callID: "before" } }, new AbortController().signal)
    const foreground = before.apps?.find((entry) => entry.is_active)?.pid
    expect(foreground).toBeGreaterThan(0)
    const launch = yield* Effect.promise(() => Bun.$`/usr/bin/open -g -n -a ${application} --args ${state} ${activates ? "activate" : "plain"}`.quiet())
    expect(launch.exitCode).toBe(0)
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      const pid = Number(await readFile(`${state}.pid`, "utf8").catch(() => ""))
      if (Number.isInteger(pid) && pid > 0) await Bun.$`/bin/kill -TERM ${pid}`.quiet()
    }))
    const identity = yield* Effect.promise(async () => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const parts = (await readFile(`${state}.ready`, "utf8").catch(() => "")).split("/").map(Number)
        if (parts.length === 2 && parts.every((part) => Number.isInteger(part) && part > 0)) return parts
        await Bun.sleep(100)
      }
      throw new Error("Focus fixture window did not appear")
    })
    const target = { platform: "macos" as const, application: "desktop" as const,
      bundleID: "app.ycoding.focus-fixture", pid: identity[0], windowID: identity[1] }
    const inspected = yield* invoke({ action: "desktop.inspect", owner: { sessionID: "fixture", callID: "inspect" }, target }, new AbortController().signal)
    const click = yield* invoke({ action: "desktop.click", owner: { sessionID: "fixture", callID: "click" }, target,
      expectedRevision: inspected.revision, x: 100, y: 100, button: "left" }, new AbortController().signal)
    expect(click.action).toBe("desktop.click")
    const after = yield* invoke({ action: "desktop.list", owner: { sessionID: "fixture", callID: "after" } }, new AbortController().signal)
    // The sky route never defocuses the user's app; an app that activates itself in response to
    // the click is not counter-activated (documented impossible case), so it stays frontmost.
    expect(after.apps?.find((entry) => entry.is_active)?.pid).toBe(activates ? target.pid : foreground)
    expect(yield* Effect.promise(() => readFile(state, "utf8"))).toBe("1")
  }), 120_000)

  it.live("keeps the user's frontmost app while clicking, scrolling, and typing into a background fixture window", () => Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "ycoding-focus-fixture-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
    const application = path.join(directory, "Focus Fixture.app")
    const executable = path.join(application, "Contents/MacOS/fixture")
    yield* Effect.promise(() => mkdir(path.dirname(executable), { recursive: true }))
    const compiled = yield* Effect.promise(() => Bun.$`/usr/bin/xcrun swiftc ${path.join(import.meta.dir, "fixtures/computer-focus.swift")} -o ${executable}`.quiet())
    expect(compiled.exitCode).toBe(0)
    yield* Effect.promise(() => writeFile(path.join(application, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.ycoding.focus-fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`))
    const state = path.join(directory, "clicks")
    yield* Effect.promise(() => writeFile(state, "0"))
    const processes = yield* AppProcess.Service
    const invoke = MacOSComputer.invokeWith(processes, "darwin")
    yield* Effect.addFinalizer(invoke.shutdown)
    const before = yield* invoke({ action: "desktop.list", owner: { sessionID: "fixture", callID: "keys-before" } }, new AbortController().signal)
    const foreground = before.apps?.find((entry) => entry.is_active)?.pid
    expect(foreground).toBeGreaterThan(0)
    const launch = yield* Effect.promise(() => Bun.$`/usr/bin/open -g -n -a ${application} --args ${state} plain`.quiet())
    expect(launch.exitCode).toBe(0)
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      const pid = Number(await readFile(`${state}.pid`, "utf8").catch(() => ""))
      if (Number.isInteger(pid) && pid > 0) await Bun.$`/bin/kill -TERM ${pid}`.quiet()
    }))
    const identity = yield* Effect.promise(async () => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const parts = (await readFile(`${state}.ready`, "utf8").catch(() => "")).split("/").map(Number)
        if (parts.length === 2 && parts.every((part) => Number.isInteger(part) && part > 0)) return parts
        await Bun.sleep(100)
      }
      throw new Error("Focus fixture window did not appear")
    })
    const target = { platform: "macos" as const, application: "desktop" as const,
      bundleID: "app.ycoding.focus-fixture", pid: identity[0], windowID: identity[1] }
    expect(target.pid).not.toBe(foreground)
    let revision = (yield* invoke({ action: "desktop.inspect", owner: { sessionID: "fixture", callID: "keys-inspect" }, target }, new AbortController().signal)).revision
    revision = (yield* invoke({ action: "desktop.click", owner: { sessionID: "fixture", callID: "keys-click" }, target,
      expectedRevision: revision, x: 100, y: 100, button: "left" }, new AbortController().signal)).revision
    revision = (yield* invoke({ action: "desktop.scroll", owner: { sessionID: "fixture", callID: "keys-scroll" }, target,
      expectedRevision: revision, x: 100, y: 100, deltaX: 0, deltaY: 100 }, new AbortController().signal)).revision
    revision = (yield* invoke({ action: "desktop.type", owner: { sessionID: "fixture", callID: "keys-type" }, target,
      expectedRevision: revision, text: "ab" }, new AbortController().signal)).revision
    yield* invoke({ action: "desktop.key", owner: { sessionID: "fixture", callID: "keys-key" }, target,
      expectedRevision: revision, key: "c" }, new AbortController().signal)
    const after = yield* invoke({ action: "desktop.list", owner: { sessionID: "fixture", callID: "keys-after" } }, new AbortController().signal)
    // The key window belongs to the frontmost app; an unchanged frontmost pid means the user's
    // key window takeover/restore cycle never ran against their app.
    expect(after.apps?.find((entry) => entry.is_active)?.pid).toBe(foreground)
    expect(Number(yield* Effect.promise(() => readFile(state, "utf8")))).toBeGreaterThanOrEqual(1)
    expect((yield* Effect.promise(() => readFile(`${state}.scrolls`, "utf8").catch(() => ""))).length).toBeGreaterThanOrEqual(1)
    expect(yield* Effect.promise(() => readFile(`${state}.keys`, "utf8").catch(() => ""))).toContain("ab")
    expect(yield* Effect.promise(() => readFile(`${state}.keys`, "utf8").catch(() => ""))).toContain("c")
  }), 120_000)

  it.live("fails fast with window_off_space for an off-Space Chromium-class pixel click", () =>
    Effect.gen(function* () {
      const target = requireTarget("YCODING_TEST_OFFSPACE_CHROMIUM_TARGET")
      const processes = yield* AppProcess.Service
      const invoke = MacOSComputer.invokeWith(processes, "darwin")
      yield* Effect.addFinalizer(invoke.shutdown)
      const inspected = yield* invoke({ action: "desktop.inspect", owner: { sessionID: "integration", callID: "offspace-chromium-inspect" },
        target: { platform: "macos", application: "desktop", ...target } }, new AbortController().signal)
      const result = yield* invoke({ action: "desktop.click", owner: { sessionID: "integration", callID: "offspace-chromium-click" },
        target: { platform: "macos", application: "desktop", ...target }, expectedRevision: inspected.revision,
        x: 10, y: 10 }, new AbortController().signal).pipe(Effect.exit)
      expect(JSON.stringify(result)).toContain("window_off_space")
      expect(JSON.stringify(result)).toContain("not_started")
    }), 60_000)
})

function requireTarget(variable = "YCODING_TEST_DESKTOP_TARGET") {
  const parts = process.env[variable]?.split("/") ?? []
  if (parts.length !== 3 || !parts[0] || !(Number(parts[1]) > 0) || !(Number(parts[2]) > 0))
    throw new Error(`Set ${variable}=<bundle-id>/<pid>/<window-id> for a window on another Space`)
  return { bundleID: parts[0], pid: Number(parts[1]), windowID: Number(parts[2]) }
}
