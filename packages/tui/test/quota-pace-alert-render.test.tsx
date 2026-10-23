import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import type { YCodingEvent } from "@ycoding-ai/client"
import type { Context } from "@ycoding-ai/plugin/tui/context"
import { createTuiAttention } from "../src/attention"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { createNotifications } from "../src/feature-plugins/system/notifications"
import { Toast, ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createTuiPluginContext } from "./fixture/tui-plugin"
import { DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "./viewport"

const alert = (id: string, title: string, body: string): Extract<YCodingEvent, { type: "provider.quota.pace" }> => ({
  id,
  created: 0,
  type: "provider.quota.pace",
  data: { providerID: "anthropic", windowID: "seven-day", milestone: "will-run-out", resetAt: 1_000, title, body },
})

test.each([
  { mode: "dark" as const, viewport: NARROW_VIEWPORT },
  { mode: "dark" as const, viewport: DESIGN_VIEWPORT_WIDE },
  { mode: "light" as const, viewport: NARROW_VIEWPORT },
  { mode: "light" as const, viewport: DESIGN_VIEWPORT_WIDE },
])("a quota pace event paints one warning toast through the app slot in $mode at $viewport.width columns", async (input) => {
  const handlers = new Map<string, ((event: YCodingEvent) => void)[]>()
  const slots: Array<Parameters<Context["ui"]["slot"]>[1]> = []
  const attention = createTuiAttention({
    renderer: { isDestroyed: false, on() {}, off() {}, triggerNotification: () => true },
    config: { attention: { enabled: true, notifications: true, sound: false, volume: 0.4, sound_pack: "ycoding.default", sounds: {}, coordination: { scope: "all" } } },
  })
  const context = createTuiPluginContext({
      attention,
      data: {
        on: ((type: string, handler: (event: YCodingEvent) => void) => {
          handlers.set(type, [...(handlers.get(type) ?? []), handler])
          return () => handlers.set(type, (handlers.get(type) ?? []).filter((item) => item !== handler))
        }) as Context["data"]["on"],
      },
      ui: { slot: (_name, render) => { slots.push(render); return () => {} } },
  })
  const cleanup = await createNotifications().setup({ ...context, attention })
  const emit = (event: YCodingEvent) => (handlers.get(event.type) ?? []).forEach((handler) => handler(event))
  const [mounted, setMounted] = createSignal(false)
  emit(alert("quota-a", "Anthropic 7 day", "Projected to run out before reset"))

  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode={input.mode} source={{ discover: () => Promise.resolve({}) }}>
      <ToastProvider><Toast /><Show when={mounted()}>{slots[0]!({}) as never}</Show></ToastProvider>
    </ThemeProvider></ConfigProvider></TestTuiContexts>
  ), input.viewport)
  try {
    app.renderer.start()
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Anthropic 7 day")
    setMounted(true)
    await app.waitForFrame((frame) => frame.includes("Anthropic 7 day"))
    const frame = app.captureCharFrame().replace(/\s+/g, " ")
    expect(frame).toContain("Warning")
    expect(frame).toContain("Projected to run out")

    emit(alert("quota-b", "Anthropic 5 hour", "Pace is cutting it close"))
    await app.waitForFrame((value) => value.includes("Anthropic 5 hour"))
    setMounted(false)
    await app.renderOnce()
    setMounted(true)
    emit(alert("quota-a", "Anthropic 7 day", "Projected to run out before reset"))
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Anthropic 5 hour")
    expect(app.captureCharFrame()).not.toContain("Anthropic 7 day")
  } finally {
    app.renderer.destroy()
    await cleanup?.()
  }
}, 30_000)
