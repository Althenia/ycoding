/** @jsxImportSource @opentui/solid */
import { TextRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { CommandPaletteDialog } from "../../../src/component/command-palette"
import { ClipboardProvider, useClipboard } from "../../../src/context/clipboard"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { Selection } from "../../../src/util/selection"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("Escape dismisses the command palette when terminal text is selected", async () => {
  let selectedText!: TextRenderable

  function SelectionKeys() {
    const renderer = useRenderer()
    const keymap = Keymap.use()
    const toast = useToast()
    const clipboard = useClipboard()
    const off = keymap.intercept(
      "key",
      ({ event }) => Selection.handleSelectionKey(renderer, toast, event, clipboard, process.platform),
      { priority: 1 },
    )
    onCleanup(off)
    return null
  }

  function Commands() {
    const dialog = useDialog()
    Keymap.createLayer(() => ({
      commands: [
        {
          id: "command.palette.show",
          title: "Show command palette",
          run: () => dialog.replace(() => <CommandPaletteDialog />),
        },
      ],
    }))
    return (
      <text selectable ref={(value) => (selectedText = value)}>
        Ready
      </text>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ClipboardProvider value={{}}>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <Keymap.Provider>
              <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                <ToastProvider>
                  <DialogProvider>
                    <SelectionKeys />
                    <Commands />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 20, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("Ready"))
    app.mockInput.pressKey("p", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("Commands"))
    app.renderer.startSelection(selectedText, selectedText.x, selectedText.y)
    app.renderer.updateSelection(selectedText, selectedText.x + 4, selectedText.y, { finishDragging: true })
    expect(app.renderer.getSelection()?.getSelectedText()).toBeTruthy()

    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("Commands"))
    expect(app.captureCharFrame()).not.toContain("Commands")
  } finally {
    app.renderer.destroy()
  }
})
