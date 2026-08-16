/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionCacheDiagnostics, SessionInfo } from "@ycoding-ai/client"
import { Keymap } from "../../../src/context/keymap"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const module = await import("../../../src/routes/session/subagent-footer")

test("derives agent and session model fallback when diagnostics are unavailable", () => {
  const session = {
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
    cost: 0,
  } satisfies Pick<SessionInfo, "agent" | "model" | "cost">
  const diagnostics: SessionCacheDiagnostics = {
    model: { providerID: "anthropic", id: "claude-sonnet" },
    context: { total: 1, percent: 1 },
    tokens: { uncachedInput: 1, output: 1, reasoning: 1, cacheRead: 0, cacheWrite: 0 },
    cache: { eligible: 0, mechanism: "none", readReported: false, writeReported: false },
    estimatedCost: 0,
  }

  expect(module.subagentFooterData).toBeDefined()
  expect(module.subagentFooterData(session, undefined)).toMatchObject({
    title: "Reviewer",
    usage: { model: "openai/gpt-5.6-terra#high" },
  })
  expect(module.subagentFooterData(session, diagnostics).usage).toMatchObject({
    model: "anthropic/claude-sonnet",
    cache: "Prompt n/a · not reported read · not reported write · 1 uncached",
  })
})

async function renderFooter(
  input: {
    title?: string
    usage?: {
      model?: string
      context?: string
      cache?: string
      cost?: string
    }
    width?: number
  } = {},
) {
  expect(module.SubagentFooterContent).toBeDefined()

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
              <module.SubagentFooterContent title={input.title ?? "Reviewer"} usage={() => input.usage} />
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 180, height: 6 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(input.title ?? "Reviewer"))
  return app
}

test("renders subagent diagnostics with model variant, context, and provider cache totals", async () => {
  const app = await renderFooter({
    usage: {
      model: "openai/gpt-5.6-terra#high",
      context: "Context 1.0k/2.0k (52%; includes cached)",
      cache: "Prompt 90% · 900 read · 12 write · 100 uncached",
    },
  })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Reviewer")
    expect(frame).toContain("openai/gpt-5.6-terra#high")
    expect(frame).toContain("Context 1.0k/2.0k (52%; includes cached)")
    expect(frame).toContain("Prompt 90% · 900 read · 12 write · 100 uncached")
    expect(frame).not.toContain("App reuse")
    expect(frame).not.toContain("Replay success")
  } finally {
    app.renderer.destroy()
  }
})

test("renders available diagnostics without a model", async () => {
  const app = await renderFooter({
    usage: {
      context: "Context 5 (includes cached)",
      cache: "Prompt n/a · not reported read · not reported write · 100 uncached",
    },
  })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Reviewer")
    expect(frame).toContain("Context 5 (includes cached)")
    expect(frame).toContain("Prompt n/a · not reported read · not reported write · 100 uncached")
    expect(frame).not.toContain("undefined")
  } finally {
    app.renderer.destroy()
  }
})

test("preserves navigation in compact width without diagnostics", async () => {
  const app = await renderFooter({ width: 48 })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Reviewer")
    expect(frame).toContain("↖")
    expect(frame).toContain("←")
    expect(frame).toContain("→")
  } finally {
    app.renderer.destroy()
  }
})
