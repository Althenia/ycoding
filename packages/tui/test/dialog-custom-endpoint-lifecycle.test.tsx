/** @jsxImportSource @opentui/solid */
import { expect, jest, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { DialogCustomEndpoint } from "../src/component/dialog-custom-endpoint"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test.each(["initial", "model"] as const)("closing an endpoint dialog cancels deferred %s focus", async (target) => {
  const config = createTuiResolvedConfig()
  const [open, setOpen] = createSignal(false)
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <Keymap.Provider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <text>Ready</text>
                  <Show when={open()}>
                    <DialogCustomEndpoint />
                  </Show>
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 50, kittyKeyboard: true, useThread: false },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Ready"))
    jest.useFakeTimers()
    setOpen(true)
    await Promise.resolve()
    if (target === "model") {
      jest.advanceTimersByTime(1)
      expect(app.renderer.currentFocusedEditor).toBeInstanceOf(InputRenderable)
      app.mockInput.pressKey("n", { ctrl: true })
    }
    app.renderer.destroy()
    expect(() => jest.runOnlyPendingTimers()).not.toThrow()
    expect(jest.getTimerCount()).toBe(0)
    expect(app.renderer.isDestroyed).toBe(true)
  } finally {
    if (!app.renderer.isDestroyed) app.renderer.destroy()
    jest.useRealTimers()
  }
})
