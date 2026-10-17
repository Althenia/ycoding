/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { UsageFilterDialog, UsageGroupDialog, type UsageGroupPresentation } from "../src/routes/session/usage-filters"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

function Filters() {
  const dialog = useDialog()
  const [group, setGroup] = createSignal<UsageGroupPresentation>("model")
  const [effort, setEffort] = createSignal<string>()
  Keymap.createLayer(() => ({ mode: "base", commands: [
    { id: "fixture.group", title: "Choose group", bind: "b", run: () => dialog.replace(() => <UsageGroupDialog current={group()} onSelect={setGroup} />) },
    { id: "fixture.effort", title: "Selected effort", bind: "e", run: () => dialog.replace(() => <UsageFilterDialog label="Selected effort" value={effort()} onSelect={setEffort} />) },
  ] }))
  return <box flexDirection="column"><text>Group {group()}</text><text>Selected effort {effort() ?? "all"}</text></box>
}

test("usage grouping and selected-effort selectors retain keyboard selection and cancellation", async () => {
  const config = createTuiResolvedConfig()
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={config}><Keymap.Provider config={config}><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><ToastProvider><DialogProvider><Filters /></DialogProvider></ToastProvider></ThemeProvider></Keymap.Provider></ConfigProvider></TestTuiContexts>, { width: 80, height: 30 })
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Group model"))
    app.mockInput.pressKey("b")
    await app.waitForFrame((frame) => frame.includes("Usage group"))
    await app.mockInput.typeText("Prompts")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Group prompt"))
    expect(app.captureCharFrame()).toContain("Group prompt")
    app.mockInput.pressKey("e")
    await app.waitForFrame((frame) => frame.includes("Leave empty for all"))
    await app.mockInput.typeText("high")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Selected effort high"))
    app.mockInput.pressKey("b")
    await app.waitForFrame((frame) => frame.includes("Usage group"))
    await app.mockInput.typeText("Tasks")
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("Usage group"))
    expect(app.captureCharFrame()).toContain("Group prompt")
    expect(app.captureCharFrame()).toContain("Selected effort high")
  } finally { app.renderer.destroy() }
})
