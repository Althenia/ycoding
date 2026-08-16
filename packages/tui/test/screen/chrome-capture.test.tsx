/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import { For } from "solid-js"
import { PromptFooterIdentity } from "../../src/component/prompt"
import { ModeChips } from "../../src/component/prompt/mode-chips"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { Header, type SessionHeaderState } from "../../src/routes/session/header"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"

const renders = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
const viewports = [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE] as const

const headers: Array<[string, SessionHeaderState, boolean]> = [
  ["resting", { type: "working", elapsed: 4.1 }, false],
  ["ready", { type: "ready" }, false],
  ["awaiting", { type: "awaiting-input", count: 1 }, false],
  ["error", { type: "provider-error", code: 429 }, false],
  ["focused", { type: "working", elapsed: 4.1 }, true],
]

test("captures the product chrome variants at canonical terminal dimensions", async () => {
  for (const viewport of viewports) {
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <Keymap.Provider>
                <ChromeFixture />
              </Keymap.Provider>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      viewport,
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("guardrail blocked"))

    try {
      const rows = rowsOf(app.captureCharFrame())
      expect(rows).toHaveLength(viewport.height)
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(viewport.width)
      await Bun.write(path.join(renders, `chrome-components-${viewport.width}x${viewport.height}.txt`), rows.join("\n"))
    } finally {
      app.renderer.destroy()
    }
  }
}, 60_000)

function ChromeFixture() {
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      { id: "model.list", run: () => {} },
      { id: "agent.list", run: () => {} },
      { id: "variant.cycle", run: () => {} },
      { id: "session.move", run: () => {} },
    ],
  }))

  return (
    <box flexDirection="column">
      <For each={headers}>
        {([name, state, focused]) => (
          <box flexDirection="column">
            <text>{name}</text>
            <Header
              path="~/Workspace/Personal/YCoding"
              branch="main"
              agent="Build"
              model="Claude Opus 5"
              variant="max"
              state={state}
              focused={focused ? "model" : undefined}
            />
          </box>
        )}
      </For>
      <box flexDirection="row" gap={3} paddingLeft={3} paddingRight={3} height={3} alignItems="center">
        <PromptFooterIdentity branch="main" sessionID="ses_0085fc701234567" />
        <ModeChips autonomy={{ mode: "normal" }} />
        <text flexGrow={1} />
        <text>⌃p commands</text>
      </box>
      <box flexDirection="row" gap={3} paddingLeft={3} paddingRight={3} height={3} alignItems="center">
        <PromptFooterIdentity branch="main" sessionID="ses_0085fc701234567" />
        <ModeChips
          autonomy={{ mode: "goal", goal: { text: "ship", status: "active", iteration: 3, noProgress: 3, maxNoProgress: 5 } }}
        />
        <text flexGrow={1} />
        <text>⌃p commands</text>
      </box>
      <box flexDirection="row" gap={3} paddingLeft={3} paddingRight={3} height={3} alignItems="center">
        <PromptFooterIdentity branch="main" sessionID="ses_0085fc701234567" />
        <ModeChips autonomy={{ mode: "yolo" }} />
        <text flexGrow={1} />
        <text>⌃x y disable</text>
      </box>
      <box flexDirection="row" gap={3} paddingLeft={3} paddingRight={3} height={3} alignItems="center">
        <PromptFooterIdentity branch="main" sessionID="ses_0085fc701234567" />
        <ModeChips
          autonomy={{ mode: "yolo", goal: { text: "ship", status: "active", iteration: 3, noProgress: 3, maxNoProgress: 5 } }}
          guardrailPending={true}
        />
        <text flexGrow={1} />
        <text>Enter approve</text>
      </box>
    </box>
  )
}

function rowsOf(frame: string) {
  return (frame.endsWith("\n") ? frame.slice(0, -1) : frame).split("\n")
}
