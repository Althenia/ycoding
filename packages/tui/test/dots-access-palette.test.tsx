/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { DotsAccess } from "@ycoding-ai/client"
import { CommandPaletteDialog } from "../src/component/command-palette"
import { ConfigProvider } from "../src/config"
import { Keymap, type KeymapLayer } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { createDotsAccess, dotsAccessCommand } from "../src/prompt/dots-access"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test.each(["dark", "light"] as const)("%s palette renders one reported access toggle through pending settlement", async (mode) => {
  let state!: ReturnType<typeof createDotsAccess>
  let finish!: (value: DotsAccess) => void
  let writes = 0
  const initial: DotsAccess = { sessionID: "ses_root", rootSessionID: "ses_root", enabled: false, revision: 2, configured: true, inherited: false }
  function Probe() {
    const dialog = useDialog()
    state = createDotsAccess({
      sessionID: () => "ses_root", rootSessionID: () => "ses_root", location: () => "location",
      connected: () => true, paletteOpen: () => dialog.size === "command-palette",
      get: async () => initial,
      set: () => { writes++; return new Promise((resolve) => { finish = resolve }) },
      error: (error) => { throw error },
    })
    Keymap.createLayer(() => {
      const { name, category, ...command } = dotsAccessCommand(state)
      return { mode: "global", commands: [{ ...command, palette: command.palette ? true : undefined, id: name, group: category }] } satisfies KeymapLayer
    })
    return <CommandPaletteDialog />
  }
  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><Keymap.Provider>
      <ToastProvider><ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
        <DialogProvider><Probe /></DialogProvider>
      </ThemeProvider></ToastProvider>
    </Keymap.Provider></ConfigProvider></TestTuiContexts>
  ), { width: 80, height: 24 })
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("Dots access · Off"))
    const pending = state.toggle()
    await app.waitForFrame((frame) => frame.includes("Updating access"))
    expect(app.captureCharFrame().match(/Dots access/g)).toHaveLength(1)
    expect(app.captureCharFrame()).toContain("Dots access · Off")
    for (const retired of ["destination", "Coordinator bindings", "Unbind", "profile"])
      expect(app.captureCharFrame()).not.toContain(retired)
    await state.toggle()
    expect(writes).toBe(1)
    finish({ ...initial, enabled: true, revision: 3 })
    await pending
    await app.waitForFrame((frame) => frame.includes("Dots access · On"))
  } finally { app.renderer.destroy() }
})
