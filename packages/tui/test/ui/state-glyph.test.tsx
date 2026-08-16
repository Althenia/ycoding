/** @jsxImportSource @opentui/solid */
import { BoxRenderable, RGBA, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogSelect } from "../../src/ui/dialog-select"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("renders state glyphs in an aligned leading column with selected-row contrast", async () => {
  function DialogFixture() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogSelect
          title="Service status"
          options={[
            { title: "Connected service", value: "connected", state: "connected" },
            { title: "Plain service", value: "plain" },
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
              <ToastProvider>
                <DialogProvider>
                  <DialogFixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 20 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Connected service"))

  try {
    const frame = app.captureCharFrame()
    const connected = frame.split("\n").find((line) => line.includes("Connected service"))!
    const plain = frame.split("\n").find((line) => line.includes("Plain service"))!
    const glyph = descendants(app.renderer.root).find(
      (item): item is TextRenderable => item instanceof TextRenderable && item.plainText.includes("✓"),
    )
    const selection = descendants(app.renderer.root).find(
      (item): item is BoxRenderable =>
        item instanceof BoxRenderable && item.backgroundColor.toInts().every((value, index) => value === RGBA.fromHex("#79B8FF").toInts()[index]),
    )

    expect(frame).toContain("✓")
    expect(connected.indexOf("Connected service")).toBe(plain.indexOf("Plain service"))
    expect(glyph?.fg.toInts()).toEqual(RGBA.fromHex("#0F1115").toInts())
    expect(selection).toBeDefined()
  } finally {
    app.renderer.destroy()
  }
})

function descendants(root: { getChildren(): readonly unknown[] }): unknown[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child as { getChildren(): readonly unknown[] })])
}
