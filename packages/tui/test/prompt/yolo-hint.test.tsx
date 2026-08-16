/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../src/config"
import { PromptYoloHint } from "../../src/component/prompt"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

function Hint() {
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      { id: "session.interrupt", title: "Interrupt session", run: () => {} },
      { id: "session.autonomy.normal", title: "Disable YOLO", run: () => {} },
    ],
  }))
  return <PromptYoloHint />
}

test("renders the restored disable-YOLO composer hint", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <box flexDirection="row" gap={2}>
                <Hint />
              </box>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 2 },
  )
  app.renderer.start()
  await app.waitForFrame((value) => value.trim().length > 0)

  expect(app.captureCharFrame()).toContain("⌃x y disable YOLO")

  app.renderer.destroy()
})
