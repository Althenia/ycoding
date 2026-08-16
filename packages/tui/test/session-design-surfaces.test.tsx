/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { ConfigProvider } from "../src/config"
import { ThemeProvider } from "../src/context/theme"
import { ShellOutputFooter } from "../src/routes/shell-output/footer"
import { ShellOutputHeader } from "../src/routes/shell-output/header"
import { ShellOutputMetadata } from "../src/routes/shell-output/metadata"
import { SubagentBlockedSurface } from "../src/routes/session/subagent-blocked"
import { subagentSwitcherLabel } from "../src/routes/session/subagent-sibling-switcher"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const now = 200_000
const shell = {
  id: "sh_0f21…",
  status: "running" as const,
  command: "bun test provider",
  cwd: "/workspace",
  shell: "bash",
  file: "~/.ycoding/shell/sh_0f21.log",
  pid: 48_213,
  metadata: {},
  time: { started: now - 68_000 },
}

test("shell output uses the design header, metadata columns, and footer labels", async () => {
  const app = await render(() => (
    <box width={189} height={17} flexDirection="column">
      <ShellOutputHeader shell={shell} owner="Main chat" now={now} />
      <ShellOutputMetadata shell={shell} owner="Main chat" now={now} />
      <ShellOutputFooter shell={shell} owner="Main chat" onKill={() => {}} onBack={() => {}} />
    </box>
  ))
  const lines = frame(app)

  expect(lines[1]).toContain("y. ycoding bun test provider · Main chat · pid 48213")
  expect(lines[1]?.indexOf("y. ycoding")).toBe(3)
  expect(lines.join("\n")).toContain("Owner")
  expect(lines.join("\n")).not.toContain("Owner:")
  expect(lines.join("\n")).toContain("⌃x k kill · Esc back")
  expect(lines.find((line) => line.includes("sh_0f21…"))?.indexOf("sh_0f21…")).toBe(3)

  app.renderer.destroy()
})

test("blocked subagent keeps status, task, result, and question on their design rows", async () => {
  const app = await render(() => (
    <box width={189}>
      <SubagentBlockedSurface
        title="test-triage"
        body="Two provider tests fail on main before my changes."
        activity="git stash · verify baseline   2 failing"
        blockedAt={Date.now() - 221_000}
        question="Should I fix them?"
      />
    </box>
  ))
  const output = frame(app).join("\n")

  expect(output).toContain("TEST-TRIAGE SUBAGENT")
  expect(output).toContain("ok     git stash · verify baseline")
  expect(output).toContain("2 failing")
  expect(output).toContain("?     awaiting decision")
  expect(output).toContain("blocked")
  expect(output).not.toContain("task\n")

  app.renderer.destroy()
})

test("subagent sibling labels preserve lowercase names and blocked status", () => {
  expect(subagentSwitcherLabel({ agent: "docs-sync", state: "running" })).toBe("◦ docs-sync")
  expect(
    subagentSwitcherLabel({
      agent: "test-triage",
      state: "waiting",
      question: { id: "qst_1", text: "Fix the failures?", time: 1 },
    }),
  ).toBe("? test-triage")
  expect(subagentSwitcherLabel({ agent: "keymap-audit", state: "completed" })).toBe("◦ keymap-audit")
})

async function render(component: () => JSX.Element) {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            {component()}
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 189, height: 20 },
  )
  app.renderer.start()
  await app.waitForFrame((value) => value.trim().length > 0)
  return app
}

function frame(app: Awaited<ReturnType<typeof testRender>>) {
  return app.captureCharFrame().split("\n").map((line) => line.trimEnd())
}
