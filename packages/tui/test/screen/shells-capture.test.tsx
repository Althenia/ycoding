/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createEffect } from "solid-js"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { RouteProvider, useRoute } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { ShellRows } from "../../src/routes/session/composer/shell-tab"
import type { ShellInfo } from "@ycoding-ai/client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "../viewport"

const renders = await mkdtemp(path.join(tmpdir(), "ycoding-shell-sections-"))
const parentID = "ses_0085fc701a"
const sessionID = parentID
const childID = "ses_docs_sync"
const directory = "/workspace/ycoding"
const location = { directory, project: { id: "project", directory } }
const now = 1_800_000_000_000
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
  shell("sh_archived", parentID, "bun test settled", "exited", now - 30_000),
  shell("sh_timeout", childID, "node timed-task", "timeout", now - 40_000),
  shell("sh_killed", parentID, "node stopped-task", "killed", now - 50_000),
  shell("sh_memory", childID, "node memory-task", "memory-limit", now - 60_000),
  shell("sh_multiline", childID, `bun inspect ${"long-argument ".repeat(40)}\nSECOND_LINE_MUST_NOT_WRAP\r\nEOF`, "exited", now - 70_000),
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

test("captures dense status sections with inline owners at narrow and wide widths in both themes", async () => {
  const commands = shells.map((shell) => shell.command)
  for (const viewport of [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT]) for (const mode of ["dark", "light"] as const) {
    let selected: string | undefined
    const app = await testRender(
      () => (
        <TestTuiContexts directory={directory}>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
              <Keymap.Provider>
                <ShellRows
                  groups={shellGroups()}
                  now={now}
                  selected="sh_main_test"
                  onSelect={(shell) => (selected = shell.id)}
                />
              </Keymap.Provider>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      viewport,
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("bun inspect"))

    try {
      const frame = app.captureCharFrame()
      const lines = frame.split("\n").map((line) => line.trimEnd())
      const populated = lines.filter((line) => line.trim())
      expect(populated.filter((line) => /^(Running|Archived)$/.test(line))).toEqual(["Running", "Archived"])
      expect(populated).toHaveLength(10)
      expect(lines.find((line) => line.includes("bun test provider"))).toContain("Main chat")
      expect(lines.find((line) => line.includes("git diff --check"))).toContain("docs-sync ·")
      expect(lines.find((line) => line.includes("bun inspect"))).toContain("…")
      expect(Bun.stringWidth(lines.find((line) => line.includes("bun inspect"))?.match(/bun inspect [^…]*…/)?.[0] ?? "")).toBeGreaterThan(0)
      expect(Bun.stringWidth(lines.find((line) => line.includes("bun inspect"))?.match(/bun inspect [^…]*…/)?.[0] ?? "")).toBeLessThanOrEqual(72)
      expect(shells.map((shell) => shell.command)).toEqual(commands)
      expect(frame).not.toContain("SECOND_LINE_MUST_NOT_WRAP")
      expect(frame).not.toContain(directory)
      expect(frame).not.toContain("pid ")
      expect(frame).not.toContain("UNKNOWN SESSION")
      expect(frame).not.toContain("bench cache-warm")
      expect(lines.every((line) => line.length <= viewport.width)).toBe(true)
      const color = (label: string) => app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === label)?.fg.toInts()
      expect(color("running")).toBeDefined()
      expect(color("running")).toEqual(color("exited"))
      expect(color("memory-limit")).toEqual(color("killed"))
      expect(color("killed")).not.toEqual(color("running"))
      await app.mockMouse.moveTo(3, lines.findIndex((line) => line.includes("git diff --check")))
      expect(selected).toBe("sh_docs_diff")
      await Bun.write(path.join(renders, `shells-tab-${mode}-${viewport.width}x${viewport.height}.txt`), frame)
      await Bun.write(path.join(renders, `shells-tab-${mode}-${viewport.width}x${viewport.height}.json`), JSON.stringify(app.captureSpans().lines.map((line) => line.spans.map((span) => ({ text: span.text, fg: span.fg.toInts(), bg: span.bg.toInts() }))), null, 2))
    } finally {
      app.renderer.destroy()
    }
  }
}, 120_000)

test("short rows preserve distinct child agent starts instead of a generic attribution prefix", async () => {
  for (const width of [40, 60]) for (const mode of ["dark", "light"] as const) {
    const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
      <ShellRows groups={[
        { owner: { label: "docs-sync · Sync provider docs" }, shells: [shell("sh_short_docs", childID, "alpha", "running", now - 3_000)] },
        { owner: { label: "qa-review · Verify results" }, shells: [shell("sh_short_qa", "ses_qa", "beta", "running", now - 4_000)] },
      ]} now={now} selected={undefined} onSelect={() => {}} />
    </ThemeProvider></ConfigProvider></TestTuiContexts>, { width, height: 8 })
    app.renderer.start()
    try {
      await app.waitForFrame((frame) => frame.includes("alpha") && frame.includes("beta"))
      const frame = app.captureCharFrame()
      const lines = frame.split("\n").filter((line) => line.trim())
      expect(lines).toHaveLength(3)
      expect(lines.find((line) => line.includes("alpha"))).toContain("docs-sync")
      expect(lines.find((line) => line.includes("beta"))).toContain("qa-review")
      expect(frame).not.toContain("Subagent")
      await Bun.write(path.join(renders, `shells-tab-${mode}-${width}x8.txt`), frame)
    } finally { app.renderer.destroy() }
  }
})

function shellGroups() {
  return [
    { owner: { label: "Main chat" }, shells: shells.filter((shell) => shell.metadata.sessionID === parentID) },
    { owner: { label: "docs-sync · Sync provider docs" }, shells: shells.filter((shell) => shell.metadata.sessionID === childID) },
  ]
}

function session(id: string, title: string, agent: string) {
  return { id, title, projectID: "project", location: { directory }, agent, model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" }, cost: 0, tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } }, time: { created: 1, updated: 4 } }
}

function shell(id: string, sessionID: string | undefined, command: string, status: ShellInfo["status"], started: number, pid?: number, cwd = directory) {
  return { id, command, status, cwd, shell: "bash", file: `/tmp/${id}`, ...(pid === undefined ? {} : { pid }), metadata: sessionID ? { sessionID } : {}, time: status === "running" ? { started } : { started, completed: now } }
}
