/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createEffect } from "solid-js"
import path from "node:path"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { RouteProvider, useRoute } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { ShellRows } from "../../src/routes/session/composer/shell-tab"
import type { ShellInfo } from "@ycoding-ai/client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "../viewport"

const renders = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
const parentID = "ses_0085fc701a"
const sessionID = parentID
const childID = "ses_docs_sync"
const directory = `${process.env.HOME}/Workspace/Personal/YCoding`
const location = { directory, project: { id: "project", directory } }
const now = Date.now()
const model = {
  id: "claude-opus-5",
  modelID: "claude-opus-5",
  providerID: "anthropic",
  name: "Claude Opus 5",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "max" }],
  time: { released: 0 },
  cost: [],
  status: "active" as const,
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
}
const parent = session(parentID, "Provider cache audit", "build")
const child = { ...session(childID, "Sync provider docs", "docs-sync"), parentID }
const shells = [
  shell("sh_main_test", parentID, "bun test provider", "running", now - 68_000, 48_213),
  shell("sh_main_dev", parentID, "bun run dev", "running", now - 862_000, 47_990),
  shell("sh_docs_diff", childID, "git diff --check", "running", now - 3_000, 48_307, `${directory}/docs`),
  shell("sh_orphan", undefined, "bench cache-warm", "timeout", now - 300_000, undefined),
]
const tasks = [
  {
    sessionID: childID,
    parentID,
    description: "Sync provider docs",
    agent: "docs-sync",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    background: true,
    state: "running" as const,
    revision: 1,
    time: { created: 1, updated: 4 },
  },
  {
    sessionID: "ses_cache_review",
    parentID,
    description: "Review provider cache",
    agent: "docs-sync",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    background: true,
    state: "running" as const,
    revision: 1,
    time: { created: 2, updated: 4 },
  },
]

test("accepts shell-output route navigation", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <RouteProvider initialRoute={{ type: "session", sessionID }}>
          <NavigateToShellOutput />
        </RouteProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 4 },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes(`Route:shell-output:${parentID}:sh_main_test`))
  } finally {
    app.renderer.destroy()
  }
})

function NavigateToShellOutput() {
  const route = useRoute()
  createEffect(() => route.navigate({ type: "shell-output", sessionID: parentID, shellID: "sh_main_test" }))
  const data = route.data
  return <text>Route:{data.type === "shell-output" ? `${data.type}:${data.sessionID}:${data.shellID}` : data.type}</text>
}

test("captures the Shell tab owner rows with populated groups", async () => {
  for (const viewport of [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT]) {
    let selected: string | undefined
    const app = await testRender(
      () => (
        <TestTuiContexts directory={directory}>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <Keymap.Provider>
                <ShellRows
                  groups={shellGroups()}
                  now={now}
                  selected="sh_main_test"
                  onSelect={(shell) => (selected = shell.id)}
                  designLabels
                />
              </Keymap.Provider>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      viewport,
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("UNKNOWN SESSION"))

    try {
      const frame = app.captureCharFrame()
      expect(frame).toContain("MAIN CHAT · THIS SESSION")
      expect(frame).toContain("SUBAGENT · DOCS-SYNC · SYNC PROVIDER DOCS")
      expect(frame).toContain("UNKNOWN SESSION")
      if (viewport.width === NARROW_VIEWPORT.width) expect(frame).toContain("running         bun test provider")
      await app.mockMouse.moveTo(3, 4)
      expect(selected).toBe("sh_main_dev")
      await Bun.write(path.join(renders, `shells-tab-${viewport.width}x${viewport.height}.txt`), frame)
    } finally {
      app.renderer.destroy()
    }
  }
}, 120_000)

function shellGroups() {
  return [
    { owner: { label: "Main chat" }, shells: shells.slice(0, 2) },
    { owner: { label: "docs-sync · Sync provider docs" }, shells: [shells[2]] },
    { owner: { label: "Unknown session" }, shells: [shells[3]] },
  ]
}

function session(id: string, title: string, agent: string) {
  return { id, title, projectID: "project", location: { directory }, agent, model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" }, cost: 0, tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } }, time: { created: 1, updated: 4 } }
}

function shell(id: string, sessionID: string | undefined, command: string, status: ShellInfo["status"], started: number, pid?: number, cwd = directory) {
  return { id, command, status, cwd, shell: "bash", file: `/tmp/${id}`, ...(pid === undefined ? {} : { pid }), metadata: sessionID ? { sessionID } : {}, time: status === "running" ? { started } : { started, completed: now } }
}
