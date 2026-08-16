/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { InlineDiff } from "../../src/routes/session/inline-diff"
import { InlineCommand } from "../../src/routes/session/inline-command"
import { transcriptToolPresentation } from "../../src/routes/session"
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

test("captures the product transcript block primitives at canonical terminal dimensions", async () => {
  for (const viewport of viewports) {
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <TranscriptBlocksFixture />
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
        expect(row!.indexOf(status)).toBe(viewport.width - 4 - status.length)
      }

      await mkdir(renders, { recursive: true })
      await Bun.write(path.join(renders, `transcript-blocks-components-${viewport.width}x${viewport.height}.txt`), rows.join("\n"))
    } finally {
      app.renderer.destroy()
    }
  }
}, 60_000)

test("wraps command text without displacing its status at 80 columns", async () => {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <box paddingLeft={3} paddingRight={3}>
              <InlineCommand
                icon="✓"
                command="bun test provider with the focused transcript command-result regression suite"
                pass={14}
                fail={0}
              />
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
    expect(row!.indexOf(status)).toBe(80 - 4 - status.length)
    expect(rows.join("\n")).toContain("command-result regression suite")
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

function TranscriptBlocksFixture() {
  return (
    <box flexDirection="column" paddingLeft={3} paddingRight={3}>
      <text>YCODING</text>
      <text>Applied the cache accounting fix.</text>
      <InlineDiff diff={DIFF_FIXTURE} />
      <InlineCommand icon="✓" command="bun test provider" pass={14} fail={0} />
      <InlineCommand icon="!" command="bun typecheck" errors={2} failed={true} />
    </box>
  )
}

function rowsOf(frame: string) {
  return (frame.endsWith("\n") ? frame.slice(0, -1) : frame).split("\n")
}
