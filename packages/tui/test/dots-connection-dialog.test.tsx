/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Dots } from "@ycoding-ai/schema/dots"
import { DialogDotsConnection } from "../src/component/dialog-dots-connection"
import { createDotsConnection } from "../src/dots-connection"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

for (const mode of ["dark", "light"] as const) for (const width of [60, 100]) {
  test(`${mode} ${width}-column Dots dialog separates permission, connection, and pending state`, async () => {
    const initial: Dots.NativeStatus = { access: { enabled: true, revision: 4 }, configuration: { ready: true, profile: "fixture-profile" }, connection: { state: "connecting", hostname: "fixture-computer" } }
    let current = initial
    let connection!: ReturnType<typeof createDotsConnection>
    let finish!: (value: Dots.NativeStatus) => void
    let writes = 0
    function Probe() {
      connection = createDotsConnection({
        connected: () => true, owner: () => "fixture",
        get: async () => current,
        set: () => { writes++; return new Promise((resolve) => { finish = resolve }) },
        error: (error) => { throw error },
      })
      return <DialogDotsConnection connection={connection} />
    }
    const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><Keymap.Provider>
      <ToastProvider><ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
        <DialogProvider><Probe /></DialogProvider>
      </ThemeProvider></ToastProvider>
    </Keymap.Provider></ConfigProvider></TestTuiContexts>, { width, height: 30 })
    app.renderer.start()
    try {
      await app.waitForFrame((frame) => frame.includes("Connection: Connecting"))
      expect(app.captureCharFrame()).toContain("Access: On")
      expect(app.captureCharFrame()).toContain("Disconnect")
      expect(app.captureCharFrame()).not.toContain("Connection: Connected")
      const pending = connection.toggle()
      await app.waitForFrame((frame) => frame.includes("Updating access"))
      expect(app.captureCharFrame()).toContain("Access: On")
      expect(app.captureCharFrame()).toContain("Disconnect")
      await connection.toggle()
      expect(writes).toBe(1)
      current = { ...initial, access: { enabled: false, revision: 5 }, connection: { state: "off", hostname: "fixture-computer" } }
      finish(current)
      await pending
      await app.waitForFrame((frame) => frame.includes("Access: Off") && frame.includes("Connection: Off"))
      expect(app.captureCharFrame()).toContain("Connect")
    } finally { app.renderer.destroy() }
  })
}
