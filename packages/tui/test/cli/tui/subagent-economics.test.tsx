/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionCacheDiagnostics, SessionOrchestrationTask } from "@ycoding-ai/client"
import { Keymap } from "../../../src/context/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const [footer, picker, context] = await Promise.all([
  import("../../../src/routes/session/subagent-footer"),
  import("../../../src/routes/session/composer/subagents-tab"),
  import("../../../src/feature-plugins/sidebar/context"),
])

const tasks = [
  {
    sessionID: "ses_paid",
    parentID: "ses_parent",
    description: "Review the implementation",
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
    background: true,
    state: "running",
    revision: 1,
    time: { created: 1, updated: 1 },
  },
  {
    sessionID: "ses_empty",
    parentID: "ses_parent",
    description: "Wait for instructions",
    agent: "explore",
    model: { providerID: "anthropic", id: "claude-sonnet-4" },
    background: true,
    state: "waiting",
    revision: 1,
    time: { created: 2, updated: 2 },
  },
] satisfies SessionOrchestrationTask[]

const diagnostics: SessionCacheDiagnostics = {
  model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
  context: { total: 54_015, limit: 1_050_000, remaining: 995_985, percent: 5 },
  tokens: { uncachedInput: 100, output: 20, reasoning: 10, cacheRead: 900, cacheWrite: 12 },
  cache: {
    eligible: 1_012,
    hitRatio: 900 / 1_012,
    mechanism: "openai-prefix-cache",
    readReported: true,
    writeReported: true,
  },
}

async function renderEconomics(width = 120) {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
  ])
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>
              <box flexDirection="column">
                <footer.SubagentFooterContent
                  title="Reviewer"
                  usage={() => undefined}
                  siblings={tasks}
                  currentSessionID="ses_paid"
                  economics={{
                    summary: "1.6K (5%) · 74% hit · $0.13",
                    strip: [
                      "Context 54.0K/1.0M",
                      "74% hit",
                      "prefix 1.0K",
                      "900 read",
                      "12 write",
                      "$0.13",
                      "rolls up to Parent session",
                    ],
                  }}
                  siblingEconomics={{ ses_paid: "$0.13 · 1.6K" }}
                />
                <picker.SubagentMetadata
                  model="anthropic/claude-sonnet-4"
                  cacheHit="68% hit"
                  elapsed="4m02s"
                  status="Running"
                  active={false}
                />
                <context.SidebarCacheContent diagnostics={() => diagnostics} cost={() => 0} subagentCost={() => 1.24} />
              </box>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 32 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Reviewer"))
  return app
}

test("renders footer economics, picker telemetry, and parent subagent spend", async () => {
  const app = await renderEconomics()

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("1.6K (5%) · 74% hit · $0.13")
    expect(frame).toContain("Context 54.0K/1.0M")
    expect(frame).toContain("prefix 1.0K")
    expect(frame).toContain("rolls up to Parent session")
    expect(frame).toContain("◦ Reviewer $0.13 · 1.6K")
    expect(frame).toContain("anthropic/claude-sonnet-4")
    expect(frame).toContain("68% hit · 4m02s · Running")
    expect(frame).toContain("Input")
    expect(frame).toContain("100")
    expect(frame).toContain("Output")
    expect(frame).toContain("20")
    expect(frame).toContain("Used")
    expect(frame).toContain("5%")
    expect(frame).toContain("Spent")
    expect(frame).toContain("$0.00")
    expect(frame).toContain("· subagents")
    expect(frame).toContain("$1.24")
    expect(frame).toContain("CACHE")
    expect(frame).toContain("Hit ratio")
    expect(frame).toContain("89%")
    expect(frame).toContain("Reads")
    expect(frame).toContain("900")
    expect(frame).toContain("Writes")
    expect(frame).toContain("12")
    expect(frame).not.toContain("Prefix")
    expect(frame.indexOf("Input")).toBeLessThan(frame.indexOf("Output"))
    expect(frame.indexOf("Output")).toBeLessThan(frame.indexOf("Used"))
    expect(frame.indexOf("Used")).toBeLessThan(frame.indexOf("Spent"))
    expect(frame.indexOf("Spent")).toBeLessThan(frame.indexOf("· subagents"))
    expect(frame.indexOf("· subagents")).toBeLessThan(frame.indexOf("CACHE"))
    expect(frame.indexOf("CACHE")).toBeLessThan(frame.indexOf("Hit ratio"))
    expect(frame.indexOf("Hit ratio")).toBeLessThan(frame.indexOf("Reads"))
    expect(frame.indexOf("Reads")).toBeLessThan(frame.indexOf("Writes"))
  } finally {
    app.renderer.destroy()
  }
})

test("does not invent hit or prefix telemetry for a child with zero or missing usage", async () => {
  const app = await renderEconomics()

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("anthropic/claude-sonnet-4")
    expect(frame).not.toContain("0% hit")
    expect(frame).not.toContain("prefix 0")
  } finally {
    app.renderer.destroy()
  }
})

test("fits delegated economics in the 80-column band", async () => {
  const app = await renderEconomics(80)

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("1.6K (5%) · 74% hit · $0.13")
    expect(frame).toContain("Context 54.0K/1.0M")
    expect(frame.split("\n").every((line) => line.length <= 80)).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
