/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { createSlots } from "../../src/plugin/slots"
import { DEFAULT_THEMES, resolveTheme } from "../../src/theme"
import type { TuiTheme } from "../../src/plugin/host-api"

test("replace slot mounts plugin content once", async () => {
  let mounts = 0
  const slots = createSlots()
  const theme: TuiTheme = {
    current: resolveTheme(DEFAULT_THEMES.ycoding, "dark"),
    selected: "ycoding",
    has: () => true,
    set: () => true,
    install: async () => {},
    mode: () => "dark",
    ready: true,
  }

  const Probe = () => {
    onMount(() => {
      mounts += 1
    })
    return <text>Plugin prompt</text>
  }

  const App = () => {
    const host = slots.setup({ renderer: useRenderer(), theme })
    onCleanup(host.dispose)
    host.register({ id: "plugin", slots: { prompt: () => <Probe /> } })

    return (
      <slots.Slot name="prompt" mode="replace">
        <text>Fallback prompt</text>
      </slots.Slot>
    )
  }

  const app = await testRender(() => <App />)
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Plugin prompt") || frame.includes("Fallback prompt"))
  try {
    expect(app.captureCharFrame()).toContain("Plugin prompt")
    expect(mounts).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
