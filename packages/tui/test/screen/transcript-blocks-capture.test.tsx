/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { InlineDiff } from "../../src/routes/session/inline-diff"
import { InlineCommand } from "../../src/routes/session/inline-command"
import { transcriptToolPresentation } from "../../src/routes/session"
import { captureRoute } from "./capture"
import { json, type FetchHandler } from "../fixture/tui-client"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"

const renders = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
const viewports = [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE] as const

const DIFF_FIXTURE = [
  "--- a/packages/core/src/provider/usage.ts",
  "+++ b/packages/core/src/provider/usage.ts",
  "@@ -10,5 +10,7 @@",
  "   const cache = stats.cache",
  "+  const cacheHit = cache.hitRatio",
  "+  const cacheWrite = cache.writeReported",
  "+  const cacheRead = cache.readReported",
  "   return {",
  "-    total: stats.input + stats.output,",
  "   }",
  " }",
].join("\n")

const sessionID = "ses_0085fc701_capture"
const directory = "~/Workspace/Personal/YCoding"
const now = Date.now()
const location = { directory, project: { id: "proj_transcript_blocks", directory } }
const session = {
  id: sessionID,
  title: "Provider cache audit",
  projectID: "proj_transcript_blocks",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 9.08,
  tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
  time: { created: 1, updated: 4 },
}
const children = [
  { ...session, id: "ses_docs_sync", parentID: sessionID, title: "Sync provider docs", cost: 1.24 },
  { ...session, id: "ses_cache_audit", parentID: sessionID, title: "Audit provider cache", cost: 0 },
]
const diff = [
  "--- packages/core/src/provider/usage.ts",
  "+++ packages/core/src/provider/usage.ts",
  "@@ -86,3 +86,4 @@",
  "   const read = usage.cacheRead ?? 0",
  "-  return read / total",
  "+  if (total === 0) return undefined",
  "+  return read / total",
  " }",
].join("\n")

const route: FetchHandler = (url) => {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session, ...children], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({
      data: [
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" },
          content: [
            { type: "text", text: "Applied the cache accounting fix." },
            {
              type: "tool",
              id: "call_edit",
              name: "edit",
              state: {
                status: "completed",
                input: {
                  path: "packages/core/src/provider/usage.ts",
                  oldString: "  return read / total",
                  newString: "  if (total === 0) return undefined\n  return read / total",
                },
                structured: {
                  files: [
                    {
                      file: "packages/core/src/provider/usage.ts",
                      patch: diff,
                      additions: 3,
                      deletions: 1,
                      status: "modified",
                    },
                  ],
                  replacements: 1,
                },
                content: [{ type: "text", text: "Edited file successfully: packages/core/src/provider/usage.ts" }],
                result: { files: [] },
              },
              time: { created: now - 7_900, ran: now - 7_800, completed: now - 7_700 },
            },
            {
              type: "tool",
              id: "call_test",
              name: "shell",
              state: {
                status: "completed",
                input: { command: "bun test provider" },
                structured: {},
                content: [{ type: "text", text: "14 pass · 0 fail" }],
                result: { exitCode: 0 },
              },
              time: { created: now - 7_600, ran: now - 7_500, completed: now - 7_400 },
            },
            {
              type: "tool",
              id: "call_typecheck",
              name: "shell",
              state: {
                status: "completed",
                input: { command: "bun typecheck" },
                structured: {},
                content: [{ type: "text", text: "2 errors" }],
                result: { exitCode: 1 },
              },
              time: { created: now - 7_300, ran: now - 7_200, completed: now - 7_100 },
            },
          ],
          time: { created: now - 8_400 },
        },
      ],
      cursor: {},
    })
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/guardrail/request`,
      `/api/session/${sessionID}/form`,
    ].includes(url.pathname)
  )
    return json({ data: [] })
  if (/^\/api\/session\/ses_(docs_sync|cache_audit)\/(permission|form)$/.test(url.pathname)) return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/autonomy`) return json({ data: { mode: "normal", yolo: false } })
  if (url.pathname === `/api/session/${sessionID}/todo`)
    return json({
      data: [
        { content: "Verify baseline", status: "completed", priority: "medium" },
        { content: "Fix cache accounting", status: "in_progress", priority: "high" },
      ],
    })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({
      data: children.map((child, index) => ({
        sessionID: child.id,
        parentID: sessionID,
        description: index === 0 ? "docs-sync" : "cache-audit",
        agent: index === 0 ? "docs-sync" : "build",
        model: { providerID: "anthropic", id: "claude-opus-5" },
        background: true,
        state: "running",
        revision: 1,
        time: { created: now - (index + 1) * 60_000, updated: now },
      })),
    })
  if (url.pathname === `/api/session/${sessionID}/skills`)
    return json({
      data: ["review", "cache-audit"].map((id) => ({
        id,
        name: id,
        activatedBy: "tool",
        activationMessageID: "msg_assistant",
        content: "",
        conflicts: [],
        declarations: {},
        state: "active",
      })),
    })
  if (url.pathname === "/api/shell")
    return json({
      location,
      data: ["sh_main_test", "sh_main_dev", "sh_docs_diff"].map((id) => ({
        id,
        status: "running",
        command: "bun test provider",
        cwd: directory,
        shell: "/bin/sh",
        file: `/tmp/${id}`,
        metadata: { sessionID },
        time: { started: now - 4_000 },
      })),
    })
  if (url.pathname === "/api/mcp")
    return json({
      location,
      data: ["context7", "filesystem", "git"].map((name) => ({ name, status: { status: "connected" } })),
    })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === `/api/session/${sessionID}/guardrail`)
    return json({
      data: {
        rootSessionID: sessionID,
        profile: "standard",
        customRules: 0,
        approvals: 0,
        blocked: 0,
        counters: [],
        invalidFiles: [],
      },
    })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`)
    return json({
      data: {
        model: { providerID: "anthropic", id: "claude-opus-5" },
        context: { total: 1_464, percent: 56 },
        tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 },
        cache: {
          eligible: 220_672,
          hitRatio: 0.71,
          mechanism: "anthropic-cache-control",
          readReported: true,
          writeReported: true,
        },
        requests: {
          logical: 1,
          physical: 1,
          helpers: 0,
          continued: 0,
          fallback: 0,
          tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
          latestInvalidation: "stable-hit",
        },
      },
    })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [
        {
          id: "claude-opus-5",
          modelID: "claude-opus-5",
          providerID: "anthropic",
          name: "Claude Opus 5",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [{ id: "max" }],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 32_000 },
        },
      ],
    })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        { id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } },
      ],
    })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
    return json({ location, data: [] })
  return undefined
}

test("captures the product transcript block primitives at canonical terminal dimensions", async () => {
  for (const viewport of viewports) {
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <TranscriptBlocksFixture width={viewport.width} />
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      viewport,
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("bun typecheck"))

    try {
      const rows = rowsOf(app.captureCharFrame())
      expect(rows).toHaveLength(viewport.height)
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(viewport.width)

      const text = rows.join("\n")

      // High: structured inline diff renders file path header with +N/-N counts
      expect(text).toContain("packages/core/src/provider/usage.ts")
      expect(text).toContain("+3")
      expect(text).toContain("−1")
      // Numbered context rows show line numbers
      expect(text).toContain("10")
      expect(text).toContain("11")
      expect(text).toContain("12")
      expect(text).toContain("13")
      expect(text).toContain("14")
      // Removed and added lines present in content
      expect(text).toContain("cacheHit = cache.hitRatio")
      expect(text).toContain("cacheWrite = cache.writeReported")
      expect(text).toContain("cacheRead = cache.readReported")
      expect(text).toContain("total: stats.input + stats.output")
      // No generic Read row when structured diff data exists
      expect(text).not.toContain("Read packages/core/src/provider/usage.ts")

      // Medium: command result rows show right-aligned statuses
      expect(text).toContain("bun test provider")
      expect(text).toContain("14 pass · 0 fail")
      expect(text).toContain("bun typecheck")
      expect(text).toContain("2 errors")

      for (const [command, status] of [
        ["bun test provider", "14 pass · 0 fail"],
        ["bun typecheck", "2 errors"],
      ] as const) {
        const row = rows.find((item) => item.includes(command))
        expect(row).toBeDefined()
        expect(row!.indexOf(status)).toBe(viewport.width - 3 - status.length)
      }

      await mkdir(renders, { recursive: true })
      await Bun.write(path.join(renders, `transcript-blocks-components-${viewport.width}x${viewport.height}.txt`), rows.join("\n"))
    } finally {
      app.renderer.destroy()
    }
  }
}, 60_000)

test("captures transcript blocks through the real session route", async () => {
  for (const viewport of viewports) {
    const lines = await captureRoute({
      ...viewport,
      route,
      args: { sessionID },
      pluginStatus: [{ id: "audit-tools", source: "file", spec: "audit-tools", target: "audit-tools", enabled: true, active: true }],
      settle: "Claude Opus 5",
      stable: ["SESSION", "CONTEXT", "TODO LIST", "SUBAGENTS", "SHELLS", "SKILLS", "MCP"],
    })
    const text = lines.join("\n")

    expect(lines).toHaveLength(viewport.height)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(viewport.width)
    expect(text).toContain("Applied the cache accounting fix.")
    expect(text).toContain("Edited 1 file")
    expect(text).toContain("packages/core/src/provider/usage.ts")
    expect(text).toContain("+3")
    expect(text).toContain("−1")
    expect(text).toContain("bun test provider")
    expect(text).toContain("14 pass · 0 fail")
    expect(text).toContain("bun typecheck")
    expect(text).toContain("2 errors")
    expect(text).toContain("goal off")
    expect(text).toContain("YOLO off")


    await mkdir(renders, { recursive: true })
    await Bun.write(path.join(renders, `transcript-blocks-${viewport.width}x${viewport.height}.txt`), lines.join("\n"))
  }
}, 120_000)

test("truncates command text without displacing its status at 80 columns", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            {/* Explicit width: the row fills 100% of its parent, which an auto-sized box reports
                as zero. */}
            <box width={80}>
              <box width={74} marginLeft={3}>
                <InlineCommand
                  icon="✓"
                  command="bun test provider with the focused transcript command-result regression suite"
                  pass={14}
                  fail={0}
                  width={74}
                />
              </box>
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("14 pass · 0 fail"))

  try {
    const rows = rowsOf(app.captureCharFrame())
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(80)
    const status = "14 pass · 0 fail"
    const row = rows.find((item) => item.includes(status))
    expect(row).toBeDefined()
    expect(row!.indexOf(status)).toBe(80 - 3 - status.length)
    expect(rows.join("\n")).toContain("bun test provider with ...result regression suite")
  } finally {
    app.renderer.destroy()
  }
})

test("selects structured transcript blocks only for matching tool message data", () => {
  expect(
    transcriptToolPresentation({
      tool: "read",
      input: { path: "packages/core/src/provider/usage.ts" },
      output: DIFF_FIXTURE,
    }),
  ).toEqual({ type: "diff", diff: DIFF_FIXTURE })
  expect(
    transcriptToolPresentation({
      tool: "shell",
      input: { command: "bun test provider" },
      output: "14 pass · 0 fail",
    }),
  ).toEqual({ type: "command", command: "bun test provider", result: { pass: 14, fail: 0 } })
  expect(
    transcriptToolPresentation({
      tool: "read",
      input: { path: "packages/core/src/provider/usage.ts" },
      output: "export const usage = stats.cache",
    }),
  ).toBeUndefined()
  expect(transcriptToolPresentation({ tool: "plugin_tool", input: {}, output: "done" })).toBeUndefined()
})

function TranscriptBlocksFixture(props: { width: number }) {
  return (
    <box width={props.width} flexDirection="column">
      <box width={props.width - 6} marginLeft={3} flexDirection="column">
        <text>YCODING</text>
        <text>Applied the cache accounting fix.</text>
        <InlineDiff path="packages/core/src/provider/usage.ts" additions={3} deletions={1} files={[{ diff: DIFF_FIXTURE }]} />
        <InlineCommand icon="✓" command="bun test provider" pass={14} fail={0} width={props.width - 6} />
        <InlineCommand icon="!" command="bun typecheck" errors={2} failed={true} width={props.width - 6} />
      </box>
    </box>
  )
}

function rowsOf(frame: string) {
  return (frame.endsWith("\n") ? frame.slice(0, -1) : frame).split("\n")
}
