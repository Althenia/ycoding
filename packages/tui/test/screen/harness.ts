import { mock } from "bun:test"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"
import { createEventStream, createFetch, type FetchHandler } from "../fixture/tui-client"
import type { TuiPluginStatus } from "../../src/plugin/host-api"
import type { ClipboardService } from "../../src/context/clipboard"

/**
 * Boots the REAL application against a deterministic fixture server and returns
 * the rendered frame.
 *
 * Component-level render tests cannot establish design fidelity: a test that
 * mounts an extracted sub-component and feeds it its own text proves only that
 * the test agrees with itself. The landing placeholder shipped wrong for exactly
 * this reason — the real `Prompt` wraps it in another template, and no test
 * rendered the real route. Screen assertions belong here.
 */
export async function renderScreen(input: {
  width: number
  height: number
  route?: FetchHandler
  args?: { sessionID?: string }
  pluginStatus?: ReadonlyArray<TuiPluginStatus>
  clipboard?: ClipboardService
  /** Frame is stable once this appears; avoids asserting a half-painted screen. */
  settle: string
}) {
  const setup = await createTestRenderer({ width: input.width, height: input.height, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  // A module mock persists for the whole Bun process, so installing it only when a caller asks for
  // plugin status leaks that status into every file loaded afterwards and makes optional rail
  // sections appear where later tests assert their absence. Always install a freshly seeded runtime.
  const runtime = await import("../../src/plugin/runtime")
  const pluginRuntime = runtime.createPluginRuntime()
  pluginRuntime.update({ status: input.pluginStatus ?? [] })
  mock.module("../../src/plugin/runtime", () => ({ ...runtime, createPluginRuntime: () => pluginRuntime }))
  if (input.clipboard) {
    mock.module("../../src/context/clipboard", () => ({
      ClipboardProvider: (props: { children: unknown }) => props.children,
      useClipboard: () => input.clipboard,
    }))
  }

  const events = createEventStream()
  const calls = createFetch(input.route, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request), idleTimeout: 30 })
  const { run } = await import("../../src/app")

  const task = Effect.runPromise(
    run({
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({}), update: async () => ({}) },
      packages: { resolve: async () => undefined },
      args: input.args ?? {},
      log: () => {},
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
  )

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (setup.renderer.isDestroyed) break
    if (setup.captureCharFrame().includes(input.settle)) break
  }

  return {
    events,
    frame: () => setup.captureCharFrame(),
    lines: () => setup.captureCharFrame().split("\n"),
    spans: () => setup.captureSpans(),
    scrollbox: () => findScrollBox(setup.renderer.root),
    input: setup.mockInput,
    mouse: setup.mockMouse,
    /** Foreground ints of the first span containing `text`, or undefined. */
    colorOf: (text: string) =>
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes(text))
        ?.fg.toInts(),
    async dispose() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task.catch(() => {})
      await server.stop()
      mock.restore()
    },
  }
}

function findScrollBox(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable) return root
  return root.getChildren().map(findScrollBox).find(Boolean)
}
