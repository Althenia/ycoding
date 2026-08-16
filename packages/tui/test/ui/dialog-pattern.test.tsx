/** @jsxImportSource @opentui/solid */
import { BoxRenderable, Renderable, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogSelect } from "../../src/ui/dialog-select"
import { Toast, ToastProvider, useToast } from "../../src/ui/toast"
import { RouteProvider } from "../../src/context/route"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("uses the responsive dialog-width table", async () => {
  for (const size of ["medium", "large", "xlarge"] as const) {
    const panel = await renderDialogPanel({ width: 80, height: 24 }, size)
    expect(panel.width).toBe(80)
  }

  const panel = await renderDialogPanel({ width: 120, height: 30 }, "medium")
  expect(panel.width).toBe(60)
})

test("renders a full dialog panel with its selected model", async () => {
  function DialogFixture() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogSelect
          title="Select model"
          options={[
            { title: "Claude Opus 5", value: "opus" },
            { title: "Claude Sonnet 5", value: "sonnet" },
          ]}
        />
      )),
    )
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <RouteProvider initialRoute={{ type: "home" }}><ToastProvider>
                <DialogProvider>
                  <DialogFixture />
                </DialogProvider>
              </ToastProvider></RouteProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 20 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Select model"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Select model")
    expect(frame).toContain("Claude Opus 5")
    expect(frame).toContain("Claude Sonnet 5")
  } finally {
    app.renderer.destroy()
  }
})

test("renders the variant glyph and label in toast titles", async () => {
  function ToastFixture() {
    const toast = useToast()
    onMount(() => toast.show({ variant: "success", title: "Copied", message: "Copied to clipboard" }))
    return <Toast />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <RouteProvider initialRoute={{ type: "home" }}><ToastProvider>
              <ToastFixture />
            </ToastProvider></RouteProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 20 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Copied to clipboard"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Success")
    expect(frame).toContain("Copied to clipboard")
  } finally {
    app.renderer.destroy()
  }
})

async function renderDialogPanel(
  dimensions: { width: number; height: number },
  size: "medium" | "large" | "xlarge",
) {
  function DialogFixture() {
    const dialog = useDialog()
    onMount(() => {
      dialog.replace(() => <text>Dialog width fixture</text>)
      dialog.setSize(size)
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <RouteProvider initialRoute={{ type: "home" }}><ToastProvider>
                <DialogProvider>
                  <DialogFixture />
                </DialogProvider>
              </ToastProvider></RouteProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    dimensions,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Dialog width fixture"))

  try {
    const panel = descendants(app.renderer.root).find(
      (item): item is BoxRenderable =>
        item instanceof BoxRenderable &&
        item.backgroundColor.toInts().every((value, index) => value === RGBA.fromHex("#1D2128").toInts()[index]),
    )
    if (!panel) throw new Error("Dialog panel not found")
    return panel
  } finally {
    app.renderer.destroy()
  }
}

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)])
}
