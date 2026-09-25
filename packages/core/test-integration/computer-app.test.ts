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
        expect(response.elements?.[0]?.role).toBe("AXWindow")
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
      }),
    60_000,
  )
})

function requireTarget() {
  const parts = process.env.YCODING_TEST_DESKTOP_TARGET?.split("/") ?? []
  if (parts.length !== 3 || !parts[0] || !(Number(parts[1]) > 0) || !(Number(parts[2]) > 0))
    throw new Error("Set YCODING_TEST_DESKTOP_TARGET=<bundle-id>/<pid>/<window-id> for a window on another Space")
  return { bundleID: parts[0], pid: Number(parts[1]), windowID: Number(parts[2]) }
}
