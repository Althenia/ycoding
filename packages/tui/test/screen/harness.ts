import { mock } from "bun:test"
import { createComponent } from "solid-js"
import type { useData } from "../../src/context/data"
import { ScrollBoxRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { FrontendPaths } from "../../src/frontend-paths"
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
  settle:
    | string
    | ((screen: Pick<Awaited<ReturnType<typeof createTestRenderer>>, "captureCharFrame" | "captureSpans">) => boolean)
  settlementTimeoutMS?: number
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
  // A module mock persists for the whole Bun process, so installing it only when a caller asks for
  // plugin status leaks that status into every file loaded afterwards and makes optional rail
  // sections appear where later tests assert their absence. Always install a freshly seeded runtime.
  const runtime = await import("../../src/plugin/runtime")
  const originalRuntime = { ...runtime }
  const pluginRuntime = runtime.createPluginRuntime()
  pluginRuntime.update({ status: input.pluginStatus ?? [] })
  mock.module("../../src/plugin/runtime", () => ({ ...originalRuntime, createPluginRuntime: () => pluginRuntime }))
  let restoreClipboard: (() => void) | undefined
  if (input.clipboard) {
    const clipboard = await import("../../src/context/clipboard")
    const original = { ...clipboard }
    mock.module("../../src/context/clipboard", () => ({
      ClipboardProvider: (props: { children: unknown }) => props.children,
      useClipboard: () => input.clipboard,
    }))
    restoreClipboard = () => {
      mock.module("../../src/context/clipboard", () => original)
    }
  }

  const events = createEventStream()
  let restoreData: (() => void) | undefined
  if (input.data || input.sessionReady) {
    const data = await import("../../src/context/data")
    const original = { ...data }
    function Probe() {
      observedData = data.useData()
      if (input.sessionReady) observedRoute = useRoute()
      input.data?.(observedData)
      return null
    }
    mock.module("../../src/context/data", () => ({
      ...data,
      DataProvider: (props: Parameters<typeof data.DataProvider>[0]) => {
        let content: Array<typeof props.children> | undefined
        return createComponent(original.DataProvider, {
          get recordTelemetry() {
            return props.recordTelemetry
          },
          get selectedSessionID() {
            return props.selectedSessionID
          },
          get children() {
            return (content ??= [createComponent(Probe, {}), props.children])
          },
        })
      },
    }))
    restoreData = () => {
      mock.module("../../src/context/data", () => original)
    }
  }
  const calls = createFetch(input.route, events)
  let restoreBuiltins: (() => void) | undefined
  if (input.builtins) {
    const builtinModule = await import("../../src/plugin/builtins")
    const original = { ...builtinModule }
    mock.module("../../src/plugin/builtins", () => ({ builtins: input.builtins }))
    restoreBuiltins = () => {
      mock.module("../../src/plugin/builtins", () => original)
    }
  }
  const server = calls.listen()
  const { run } = await import("../../src/app")

  const task = Effect.runPromise(
    run({
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => input.config ?? {}, update: async () => ({}) },
      packages: input.packages ?? { resolve: async () => undefined },
      args: input.args ?? {},
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: null, complete: () => {} }),
      log: () => {},
      remote: input.remote,
      keepAwake: input.keepAwake,
    }).pipe(
      Effect.provide(input.state ? FrontendPaths.layerWith({ state: input.state }) : FrontendPaths.layer),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  ).then(
    () => ({ status: "completed" as const }),
    (error: unknown) => ({ status: "failed" as const, error }),
  )

  async function dispose() {
    try {
      try {
        if (!setup.renderer.isDestroyed) setup.renderer.destroy()
        const outcome = await task
        if (outcome.status === "failed") throw outcome.error
      } finally {
        await server.stop()
      }
    } finally {
      restoreData?.()
      restoreBuiltins?.()
      restoreClipboard?.()
      mock.module("../../src/plugin/runtime", () => originalRuntime)
    }
  }

  const sessionReady = () => {
    if (!input.sessionReady) return true
    if (
      !sessionID ||
      !observedData ||
      observedRoute?.data.type !== "session" ||
      observedRoute.data.sessionID !== sessionID
    )
      return false
    const session = observedData.session.get(sessionID)
    if (
      !session ||
      !observedData.location.info(session.location) ||
      observedData.session.message.history(sessionID)?.status !== "ready"
    )
      return false
    if (!findScrollBox(setup.renderer.root)) return false
    const header =
      setup
        .captureCharFrame()
        .split("\n")
        .find((line) => line.trim()) ?? ""
    return !/Loading session|Connecting…|Reconnecting…/.test(header)
  }
  let frame = setup.captureCharFrame()
  const settled = () => {
    frame = setup.captureCharFrame()
    const requestedFrame = typeof input.settle === "string"
      ? frame.includes(input.settle) &&
          (!input.settle.startsWith("Message ") || setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      : input.settle(setup)
    return requestedFrame && sessionReady()
  }
  let ready = false
  try {
    const deadline = Date.now() + (input.settlementTimeoutMS ?? 25_000)
    while (Date.now() < deadline) {
      await Bun.sleep(50)
      if (setup.renderer.isDestroyed) break
      if (!settled()) continue
      if (setup.renderer.isDestroyed) break
      await setup.renderOnce()
      if (settled() && !setup.renderer.isDestroyed) {
        ready = true
        break
      }
    }
    if (!ready)
      throw new Error(
        `Screen did not settle on ${typeof input.settle === "string" ? JSON.stringify(input.settle) : input.settle.name || "settlement predicate"} (renderer destroyed: ${setup.renderer.isDestroyed})\nFinal frame:\n${frame}`,
      )
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Screen settlement and cleanup failed", { cause: error })
    }
    throw error
  }
  if (input.sessionReady && !settled()) {
    const frame = setup.captureCharFrame()
    await dispose()
    throw new Error(`Session ${sessionID} did not reach the requested ready frame:\n${frame}`)
  }

  return {
    events,
    waitForSettlement: calls.waitForSettlement,
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
