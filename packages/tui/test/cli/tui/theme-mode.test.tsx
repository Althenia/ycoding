/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { DEFAULT_THEMES } from "../../../src/theme"
import { ConfigProvider } from "../../../src/config"
import { ThemeProvider, useTheme } from "../../../src/context/theme"

async function wait(fn: () => boolean) {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > 2000) throw new Error("timed out waiting for theme mode")
    await Bun.sleep(10)
  }
}

test("uses an available mode while retaining the pinned preference", async () => {
  const dual = structuredClone(DEFAULT_THEMES.ycoding)
  const lightOnly = { version: 2 as const, standalone: true, light: structuredClone(dual.light!) }
  const darkOnly = { version: 2 as const, standalone: true, dark: structuredClone(dual.dark!) }
  let theme: ReturnType<typeof useTheme> | undefined

  function Probe() {
    const value = useTheme()
    theme = value
    return <text>{value.mode()}</text>
  }

  function current() {
    if (!theme) throw new Error("Theme provider is not mounted")
    return theme
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "light-only", mode: "dark" } })}>
        <ThemeProvider
          mode="dark"
          source={{ discover: () => Promise.resolve({ "light-only": lightOnly, "dark-only": darkOnly, dual }) }}
        >
          <Probe />
        </ThemeProvider>
      </ConfigProvider>
    ),
    { width: 20, height: 2 },
  )
  app.renderer.start()

  try {
    await wait(() => theme?.ready === true)
    expect(current().mode()).toBe("light")
    expect(current().modes()).toEqual(["light"])
    expect(current().supports("dark")).toBeFalse()
    expect(current().setMode("dark")).toBeFalse()
    expect(current().set("dark-only")).toBeTrue()
    await wait(() => current().mode() === "dark")
    expect(current().modes()).toEqual(["dark"])
    expect(current().set("light-only")).toBeTrue()
    await wait(() => current().mode() === "light")
    expect(current().set("dual")).toBeTrue()
    await wait(() => current().mode() === "dark")
    expect(current().modes()).toEqual(["light", "dark"])
  } finally {
    app.renderer.destroy()
  }
})
