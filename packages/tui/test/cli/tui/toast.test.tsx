/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { Toast, ToastProvider, useToast } from "../../../src/ui/toast"
import { ConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("shows structured API error messages instead of an unknown-error fallback", async () => {
  let toast!: ReturnType<typeof useToast>

  function Probe() {
    toast = useToast()
    onMount(() => toast.error({ data: { message: "History request failed" } }))
    return <box />
  }

  const app = await testRender(() => (
    <ToastProvider>
      <Probe />
    </ToastProvider>
  ))

  try {
    await app.waitFor(() => toast.currentToast !== null)
    expect(toast.currentToast?.message).toBe("History request failed")
  } finally {
    app.renderer.destroy()
  }
})

test.each([40, 100])("wraps the complete typed error and recovery instruction at %i columns", async (width) => {
  const message = "shell dispatch rejected · Check the Session before retrying"
  function Probe() {
    const toast = useToast()
    onMount(() => toast.show({ title: "Shell submission failed", message, variant: "error" }))
    return <Toast />
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ToastProvider>
              <Probe />
            </ToastProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 20 },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("retrying"))
    const frame = app.captureCharFrame().replace(/│/g, "").replace(/\s+/g, " ")
    expect(frame).toContain("Shell submission failed")
    expect(frame).toContain(message)
  } finally {
    app.renderer.destroy()
  }
})
