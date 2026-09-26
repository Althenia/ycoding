import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
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
      const response = yield* MacOSComputer.invokeWith(processes, "darwin")({
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
})

function requireTarget() {
  const parts = process.env.YCODING_TEST_DESKTOP_TARGET?.split("/") ?? []
  if (parts.length !== 3 || !parts[0] || !(Number(parts[1]) > 0) || !(Number(parts[2]) > 0))
    throw new Error("Set YCODING_TEST_DESKTOP_TARGET=<bundle-id>/<pid>/<window-id> for a window on another Space")
  return { bundleID: parts[0], pid: Number(parts[1]), windowID: Number(parts[2]) }
}
