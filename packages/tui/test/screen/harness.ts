import { createPluginRuntime } from "../../src/plugin/runtime"
import type { useData } from "../../src/context/data"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"
import { createEventStream, createFetch, type FetchHandler } from "../fixture/tui-client"
import type { TuiPluginStatus } from "../../src/plugin/host-api"
import type { ClipboardService } from "../../src/context/clipboard"
import type { KeepAwakeStatus } from "../../src/keep-awake"
import type { RemoteStatus } from "../../src/remote-connector"
import type { PackageResolver } from "../../src/plugin/context"
import type { Plugin } from "@ycoding-ai/plugin/tui"
import { useRoute } from "../../src/context/route"

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
  args?: { sessionID?: string; model?: string }
  pluginStatus?: ReadonlyArray<TuiPluginStatus>
  clipboard?: ClipboardService
  /** The real renderer enables the kitty keyboard protocol; modifier sequences need it. */
  kittyKeyboard?: boolean
  /** Frame is stable once this appears; avoids asserting a half-painted screen. */
  settle: string | ((screen: Pick<Awaited<ReturnType<typeof createTestRenderer>>, "captureCharFrame" | "captureSpans">) => boolean)
  sessionReady?: boolean
  config?: Record<string, unknown>
  remote?: { get: () => Promise<RemoteStatus>; set: (enabled: boolean) => Promise<RemoteStatus> }
  keepAwake?: { get: () => Promise<KeepAwakeStatus>; set: (enabled: boolean) => Promise<KeepAwakeStatus> }
  state?: string
  data?: (value: ReturnType<typeof useData>) => void
  packages?: PackageResolver
  builtins?: readonly Plugin.Definition[]
}) {
  const sessionID = input.args?.sessionID
  if (input.sessionReady && !sessionID) throw new Error("Session readiness requires args.sessionID")
  let observedData: ReturnType<typeof useData> | undefined
  let observedRoute: ReturnType<typeof useRoute> | undefined
  const { resetRailExpansion } = await import("../../src/routes/session/rail-section")
  resetRailExpansion()
  const setup = await createTestRenderer({
    width: input.width,
    height: input.height,
    useThread: false,
    kittyKeyboard: input.kittyKeyboard ?? false,
  })
  const pluginRuntime = createPluginRuntime()
  pluginRuntime.update({ status: input.pluginStatus ?? [] })

  const events = createEventStream()
  const calls = createFetch(input.route, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request), idleTimeout: 30 })
  const { run } = await import("../../src/app")

  const task = Effect.runPromise(
    run({
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => input.config ?? {}, update: async () => ({}) },
      packages: input.packages ?? { resolve: async () => undefined },
      pluginRuntime,
      clipboard: input.clipboard,
      onData: (data) => { observedData = data; if (input.sessionReady) observedRoute = useRoute(); input.data?.(data) },
      builtins: input.builtins,
      args: input.args ?? {},
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: null, complete: () => {} }),
      log: () => {},
      remote: input.remote,
      keepAwake: input.keepAwake,
    }).pipe(
      Effect.provide(input.state ? Global.layerWith({ state: input.state }) : AppNodeBuilder.build(Global.node)),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  )

  async function dispose() {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await task.catch(() => {})
    await server.stop()
  }
  const requestedFrame = () => typeof input.settle === "string"
    ? setup.captureCharFrame().includes(input.settle)
    : input.settle(setup)
  const sessionReady = () => {
    if (!input.sessionReady) return true
    if (!sessionID || !observedData || observedRoute?.data.type !== "session" || observedRoute.data.sessionID !== sessionID) return false
    const session = observedData.session.get(sessionID)
    if (!session || !observedData.location.info(session.location) || observedData.session.message.history(sessionID)?.status !== "ready") return false
    if (!findScrollBox(setup.renderer.root)) return false
    const header = setup.captureCharFrame().split("\n").find((line) => line.trim()) ?? ""
    return !/Loading session|Connecting…|Reconnecting…/.test(header)
  }
  const settled = () => requestedFrame() && sessionReady()
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await Bun.sleep(50)
    if (setup.renderer.isDestroyed) break
    if (!settled()) continue
    // Commit pending layout and hit-grid work before callers inspect or click the frame.
    await setup.renderOnce()
    if (settled()) break
  }
  if (input.sessionReady && !settled()) {
    const frame = setup.captureCharFrame()
    await dispose()
    throw new Error(`Session ${sessionID} did not reach the requested ready frame:\n${frame}`)
  }

  return {
    events,
    renderer: setup.renderer,
    /**
     * Waits for a stable live-event subscription before a test emits into the stream. Emitting
     * before the app attaches (or during a reconnect gap) can lose the payload, because the event
     * channel is volatile by contract.
     */
    async waitForEventStream() {
      const deadline = Date.now() + 5_000
      let previous = -1
      let stable = 0
      while (Date.now() < deadline) {
        const subscriptions = events.subscriptions()
        stable = subscriptions > 0 && subscriptions === previous ? stable + 1 : 0
        previous = subscriptions
        if (stable >= 10) return
        await Bun.sleep(20)
      }
      throw new Error("the app never attached a stable live-event subscription")
    },
    frame: () => setup.captureCharFrame(),
    renderOnce: setup.renderOnce,
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
    dispose,
  }
}

function findScrollBox(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable) return root
  return root.getChildren().map(findScrollBox).find(Boolean)
}
