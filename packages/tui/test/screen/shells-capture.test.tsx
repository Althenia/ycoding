/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { Effect, FileSystem } from "effect"
import { createEffect } from "solid-js"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { RouteProvider, useRoute } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { ShellRows } from "../../src/routes/session/composer/shell-tab"
import type { ShellInfo } from "@ycoding-ai/client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventStream, createFetch, json } from "../fixture/tui-client"
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

test("captures populated shell ownership and rail states at reference dimensions", async () => {
  for (const viewport of [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE]) {
    const capture = await boot(viewport)
    try {
      await waitFor(capture.frame, "y. ycoding vlocal")
      await waitFor(capture.frame, "Message YCoding…")
      await waitFor(capture.frame, "3 shells running")
      capture.input.pressKey("ARROW_DOWN")
      await waitFor(capture.frame, "Prompt")
      const composerRow = capture.rows().findIndex((row) => row.includes("Prompt") && row.includes("Shell"))
      expect(composerRow).toBeGreaterThanOrEqual(0)
      await capture.mouse.click(capture.rows()[composerRow].indexOf("Shell"), composerRow)
      await waitFor(capture.frame, "MAIN CHAT · THIS SESSION")
      expect(capture.frame()).toContain("Shell")

      const rows = capture.rows()
      expect(rows).toHaveLength(viewport.height)
      expect(rows.join("\n")).toContain("SHELLS")
      expect(rows.filter((row) => row.includes("SHELLS"))).toHaveLength(1)
      expect(rows.join("\n")).toMatch(/−\s+SHELLS\s+3 running/)
      const tabRow = rows.find((row) => row.includes("Prompt") && row.includes("Shell")) ?? ""
      expect(tabRow).toContain("Prompt")
      expect(tabRow.indexOf("Shell")).toBeGreaterThan(tabRow.indexOf("Prompt"))
      expect(tabRow.indexOf("Subagents")).toBeGreaterThan(tabRow.indexOf("Shell"))
      expect(tabRow).toContain("Shell 3")
      expect(rows.findIndex((row) => row.includes("Shell"))).toBeLessThan(Math.ceil(viewport.height / 2))
      expect(rows.findIndex((row) => row.includes("SHELLS"))).toBeLessThan(rows.findIndex((row) => row.includes("SESSION")))
      expect(rows.join("\n")).toContain("MAIN CHAT · THIS SESSION")
      expect(rows.join("\n")).toContain("SUBAGENT · DOCS-SYNC · SYNC PROVIDER DOCS")
      expect(rows.join("\n")).toContain("UNKNOWN SESSION")
      expect(rows.join("\n")).toContain("exit — · 5m00s")
      expect(rows[1]).toContain("3 shells running")
      if (viewport.width === DESIGN_VIEWPORT_WIDE.width) {
        expectAt(rows, 30, 3, "Prompt")
        expectAt(rows, 30, 14, "Shell")
        expectAt(rows, 30, 20, "3")
        expectAt(rows, 30, 25, "Subagents")
        expectAt(rows, 30, 36, "2")
        expectAt(rows, 49, 3, "Enter view output")
        expectAt(rows, 49, 23, "↑↓ move")
        expectAt(rows, 49, 34, "⌃x k kill")
        expectAt(rows, 49, 46, "Esc close")
      }

      await mkdir(renders, { recursive: true })
      await Bun.write(path.join(renders, `shells-${viewport.width}x${viewport.height}.txt`), rows.join("\n"))
    } finally {
      await capture.dispose()
    }
  }
}, 120_000)

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

async function boot(viewport: { width: number; height: number }) {
  const setup = await createTestRenderer({ ...viewport, useThread: false, kittyKeyboard: true })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventStream()
  const calls = createFetch(route, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../../src/app")
  const task = Effect.runPromise(
    run({
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({}), update: async () => ({}) },
      packages: { resolve: async () => undefined },
      args: { sessionID },
      log: () => {},
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
  )

  return {
    frame: () => setup.captureCharFrame(),
    rows: () => {
      const frame = setup.captureCharFrame()
      return (frame.endsWith("\n") ? frame.slice(0, -1) : frame).split("\n")
    },
    input: setup.mockInput,
    mouse: setup.mockMouse,
    async dispose() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task.catch(() => {})
      await server.stop()
      mock.restore()
    },
  }
}

async function waitFor(frame: () => string, text: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (frame().includes(text)) return
    await Bun.sleep(50)
  }
  throw new Error(`screen did not settle on ${text}`)
}

function expectAt(lines: string[], row: number, column: number, text: string) {
  expect(lines[row]?.slice(column, column + text.length)).toBe(text)
}

function route(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [parent, child], cursor: {} })
  if (url.pathname === `/api/session/${parentID}`) return json({ data: parent })
  if (url.pathname === `/api/session/${childID}`) return json({ data: child })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${parentID}/subagent`) return json({ data: tasks })
  if ([parentID, childID].flatMap((id) => [`/api/session/${id}/pending`, `/api/session/${id}/permission`, `/api/session/${id}/todo`, `/api/session/${id}/skills`, `/api/session/${id}/guardrail/request`]).includes(url.pathname)) return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/guardrail`) return json({ data: { rootSessionID: parentID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`) return json({ data: { model: { providerID: "anthropic", id: "claude-opus-5" }, context: { total: 1_464, percent: 56 }, tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 }, cache: { eligible: 220_672, hitRatio: 0.71, mechanism: "anthropic-cache-control", readReported: true, writeReported: true }, requests: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: child.tokens, latestInvalidation: "stable-hit" } } })
  if (url.pathname === "/api/shell") return json({ location, data: shells })
  if (url.pathname === "/api/shell/sh_main_test/output")
    return json({ location, data: { output: "bun test v1.3.14", cursor: 1, size: 16, truncated: false } })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model") return json({ location, data: [model] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent") return json({ location, data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }, { id: "docs-sync", name: "docs-sync", request: { headers: {}, body: {} }, mode: "subagent", hidden: false, permissions: [] }] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/mcp", "/api/permission/request", "/api/form/request"].includes(url.pathname)) return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/path") return json({ home: process.env.HOME, state: "", config: "", worktree: directory, directory })
  return undefined
}

function session(id: string, title: string, agent: string) {
  return { id, title, projectID: "project", location: { directory }, agent, model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" }, cost: 0, tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } }, time: { created: 1, updated: 4 } }
}

function shell(id: string, sessionID: string | undefined, command: string, status: ShellInfo["status"], started: number, pid?: number, cwd = directory) {
  return { id, command, status, cwd, shell: "bash", file: `/tmp/${id}`, ...(pid === undefined ? {} : { pid }), metadata: sessionID ? { sessionID } : {}, time: status === "running" ? { started } : { started, completed: now } }
}
