/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { IncidentReportInput, ModelIncidentItem, ModelIncidentRecent, ModelIncidentReport, ModelIncidentReportRow } from "@ycoding-ai/client"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { ProviderUsageScreenContent } from "../src/routes/session/provider-usage"
import type { ModelIncidentLoaders } from "../src/routes/session/model-incidents"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const now = Date.UTC(2026, 8, 22, 12)
const DAY = 24 * 60 * 60 * 1_000

type ReportInput = Parameters<ModelIncidentLoaders["report"]>[0]
type RecentInput = Parameters<ModelIncidentLoaders["recent"]>[0]
type GuidanceInput = Parameters<ModelIncidentLoaders["guidance"]>[0]

type IncidentGroup = IncidentReportInput["group"]

const rows = (group: IncidentGroup): ModelIncidentReportRow[] =>
  [
    { providerID: "openai", modelID: "gpt-x", fallbacks: 3, escalated: 2, rejected: 1, last: Date.UTC(2026, 8, 22, 11, 30) },
    { providerID: "anthropic", modelID: "claude-y", fallbacks: 0, escalated: 1, rejected: 0, last: Date.UTC(2026, 8, 20, 9, 5) },
  ].map((row) => (group === "agent" ? { ...row, agent: "build" } : row))

const report = (group: IncidentGroup, groups = 2): ModelIncidentReport => ({ rows: rows(group), groups })

const items = (count: number): ModelIncidentRecent => ({
  items: Array.from({ length: count }, (_, index): ModelIncidentItem => ({
    id: `inc_${index}`,
    time: Date.UTC(2026, 8, 22, 11, 30) - index * 60_000,
    kind: index % 3 === 0 ? "fallback" : index % 3 === 1 ? "guardrail-escalated" : "guardrail-rejected",
    category: index % 3 === 0 ? "rate_limit" : "outside_repository",
    ruleIDs: index % 3 === 0 ? [] : [`standard.review.rule-${index}`],
    agent: "build",
    ...(index % 3 === 0 ? { target: { id: "claude-y", providerID: "anthropic", variant: "high" } } : {}),
  })),
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((pass, fail) => {
    resolve = pass
    reject = fail
  })
  return { promise, resolve, reject }
}

function loaders(override: Partial<ModelIncidentLoaders> = {}) {
  const calls = { report: [] as ReportInput[], recent: [] as RecentInput[], guidance: [] as GuidanceInput[], clear: [] as GuidanceInput[] }
  const value: ModelIncidentLoaders = {
    report: async (input) => {
      calls.report.push(input)
      return report(input.group)
    },
    recent: async (input) => {
      calls.recent.push(input)
      return items(20)
    },
    guidance: async (input) => {
      calls.guidance.push(input)
      return { text: "Prefer a smaller model after repeated rate limits.", enabled: true }
    },
    clear: async (input) => {
      calls.clear.push(input)
      return { clearedAt: now, enabled: true }
    },
    ...override,
  }
  return { value, calls }
}

async function renderIncidents(input: { load: ModelIncidentLoaders; width?: number; height?: number; tab?: "incidents" | "overview"; onRefresh?: () => void }) {
  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <Keymap.Provider config={config}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <ProviderUsageScreenContent
                    snapshots={() => []}
                    now={() => now}
                    initialTab={input.tab ?? "incidents"}
                    incidents={input.load}
                    onRefresh={input.onRefresh}
                  />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 160, height: input.height ?? 60 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Usage"))
  return app
}

async function waitFor(app: Awaited<ReturnType<typeof renderIncidents>>, predicate: (frame: string) => boolean, label: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const frame = app.captureCharFrame()
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}\n${app.captureCharFrame()}`)
}

test("is reachable from the usage views and reports exact counts with the newest incident time per group", async () => {
  const { value, calls } = loaders()
  const app = await renderIncidents({ load: value, tab: "overview" })
  try {
    app.mockInput.pressKey("ARROW_LEFT")
    const frame = await waitFor(app, (text) => text.includes("FALLBACKS") && text.includes("openai/gpt-x"), "the incident report")
    expect(calls.report[0]).toEqual({ group: "model", offset: 0, limit: 100 })
    for (const column of ["MODEL", "FALLBACKS", "ESCALATED", "REJECTED", "LAST"]) expect(frame).toContain(column)
    const first = frame.split("\n").find((line) => line.includes("openai/gpt-x")) ?? ""
    expect(first).toMatch(/\s3\s+2\s+1\s+2026-09-22 11:30/)
    const second = frame.split("\n").find((line) => line.includes("anthropic/claude-y")) ?? ""
    expect(second).toMatch(/\s0\s+1\s+0\s+2026-09-20 09:05/)
    expect(frame).toContain("Group model")
    expect(frame).toContain("Range: All retained history")
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("states an empty range and keeps load failures recoverable with ctrl+r", async () => {
  let attempt = 0
  const { value, calls } = loaders({
    report: async (input) => {
      attempt++
      if (attempt === 1) throw new Error("unavailable")
      if (attempt === 2) return { rows: [], groups: 0 }
      return report(input.group)
    },
  })
  const app = await renderIncidents({ load: value })
  try {
    await waitFor(app, (frame) => frame.includes("Incident report could not be loaded."), "the failure")
    expect(app.captureCharFrame()).toContain("ctrl+r retry")
    app.mockInput.pressKey("r", { ctrl: true })
    await waitFor(app, (frame) => frame.includes("No incidents recorded in this range."), "the empty state")
    expect(app.captureCharFrame()).not.toContain("Incident report could not be loaded.")
    expect(calls.recent).toHaveLength(0)
    app.mockInput.pressKey("r", { ctrl: true })
    await waitFor(app, (frame) => frame.includes("openai/gpt-x") && !frame.includes("No incidents recorded"), "recovered rows")
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("shows the twenty recent incidents, exact guidance, and moves with the selected row", async () => {
  const { value, calls } = loaders({
    recent: async (input) => {
      calls.recent.push(input)
      return { items: input.model === "claude-y" ? items(2).items : items(20).items }
    },
    guidance: async (input) => {
      calls.guidance.push(input)
      return input.model === "claude-y" ? { enabled: true } : { text: "Prefer a smaller model after repeated rate limits.", enabled: true }
    },
  })
  const app = await renderIncidents({ load: value })
  try {
    let frame = await waitFor(app, (text) => text.includes("Prefer a smaller model after repeated rate limits."), "first model detail")
    expect(calls.recent[0]).toEqual({ provider: "openai", model: "gpt-x", limit: 20 })
    expect(calls.guidance[0]).toEqual({ provider: "openai", model: "gpt-x" })
    expect(frame.split("\n").filter((line) => /^\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2} · (fallback|escalated|rejected) /.test(line))).toHaveLength(20)
    expect(frame).toContain("2026-09-22 11:30 · fallback · rate_limit · → anthropic/claude-y#high")
    expect(frame).toContain("2026-09-22 11:29 · escalated · outside_repository · standard.review.rule-1")
    expect(frame).toContain("2026-09-22 11:28 · rejected · outside_repository · standard.review.rule-2")

    app.mockInput.pressKey("ARROW_DOWN")
    frame = await waitFor(app, (text) => text.includes("No guidance for this model"), "second model detail")
    expect(calls.recent.at(-1)).toEqual({ provider: "anthropic", model: "claude-y", limit: 20 })
    expect(frame.split("\n").filter((line) => /^\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2} · /.test(line))).toHaveLength(2)
    expect(frame).not.toContain("Prefer a smaller model")
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("states that guidance is disabled by the Location's capabilities", async () => {
  const { value } = loaders({ guidance: async () => ({ text: "Keep prompts short.", enabled: false }) })
  const app = await renderIncidents({ load: value })
  try {
    const frame = await waitFor(app, (text) => text.includes("Keep prompts short."), "stored guidance")
    expect(frame).toContain("Guidance disabled · this Location's capabilities turn model guidance off")
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("clears guidance only on a second ctrl+d and leaves the incident counts unchanged", async () => {
  const { value, calls } = loaders()
  const app = await renderIncidents({ load: value })
  try {
    await waitFor(app, (text) => text.includes("Prefer a smaller model"), "guidance")
    app.mockInput.pressKey("d", { ctrl: true })
    await waitFor(app, (text) => text.includes("Press ctrl+d again to clear guidance for openai/gpt-x"), "the confirmation")
    expect(calls.clear).toHaveLength(0)

    app.mockInput.pressKey("ARROW_DOWN")
    await waitFor(app, (text) => !text.includes("Press ctrl+d again"), "cancelled confirmation")
    app.mockInput.pressKey("ARROW_UP")
    await waitFor(app, (text) => text.includes("Prefer a smaller model"), "first row again")
    app.mockInput.pressKey("d", { ctrl: true })
    await waitFor(app, (text) => text.includes("Press ctrl+d again"), "a fresh confirmation")
    expect(calls.clear).toHaveLength(0)

    app.mockInput.pressKey("d", { ctrl: true })
    const frame = await waitFor(app, (text) => text.includes("No guidance for this model") && !text.includes("Prefer a smaller model"), "cleared guidance")
    expect(calls.clear).toEqual([{ provider: "openai", model: "gpt-x" }])
    expect(frame).not.toContain("Press ctrl+d again")
    expect(frame.split("\n").find((line) => line.includes("openai/gpt-x"))).toMatch(/\s3\s+2\s+1\s+2026-09-22 11:30/)
    expect(calls.report).toHaveLength(1)

    app.mockInput.pressKey("d", { ctrl: true })
    await Bun.sleep(50)
    expect(app.captureCharFrame()).not.toContain("Press ctrl+d again")
    expect(calls.clear).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("keeps guidance and offers a retry when clearing fails", async () => {
  let fail = true
  const { value, calls } = loaders({
    clear: async (input) => {
      calls.clear.push(input)
      if (fail) throw new Error("denied")
      return { clearedAt: now, enabled: true }
    },
  })
  const app = await renderIncidents({ load: value })
  try {
    await waitFor(app, (text) => text.includes("Prefer a smaller model"), "guidance")
    app.mockInput.pressKey("d", { ctrl: true })
    app.mockInput.pressKey("d", { ctrl: true })
    const frame = await waitFor(app, (text) => text.includes("Guidance could not be cleared"), "the failure")
    expect(frame).toContain("Prefer a smaller model")
    fail = false
    app.mockInput.pressKey("d", { ctrl: true })
    app.mockInput.pressKey("d", { ctrl: true })
    await waitFor(app, (text) => text.includes("No guidance for this model"), "the retry")
    expect(calls.clear).toHaveLength(2)
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("groups by agent, narrows recent incidents to the agent, and applies the selected range", async () => {
  const { value, calls } = loaders()
  const app = await renderIncidents({ load: value })
  try {
    await waitFor(app, (text) => text.includes("openai/gpt-x"), "model rows")
    app.mockInput.pressKey("b")
    await waitFor(app, (text) => text.includes("Incident grouping"), "the grouping chooser")
    await app.mockInput.typeText("Agent")
    app.mockInput.pressEnter()
    const frame = await waitFor(app, (text) => calls.report.at(-1)?.group === "agent" && text.includes("openai/gpt-x · build"), "agent rows")
    expect(frame).toContain("Group agent")
    expect(calls.recent.at(-1)).toEqual({ provider: "openai", model: "gpt-x", agent: "build", limit: 20 })

    app.mockInput.pressKey("f")
    await waitFor(app, (text) => text.includes("Usage range"), "the range chooser")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    await waitFor(app, (text) => text.includes("Range: Last 7 days"), "the 7 day range")
    const tomorrow = Date.UTC(2026, 8, 23)
    expect(calls.report.at(-1)).toEqual({ group: "agent", from: tomorrow - 7 * DAY, to: tomorrow, offset: 0, limit: 100 })

    app.mockInput.pressKey("f")
    await waitFor(app, (text) => text.includes("Usage range"), "the range chooser again")
    app.mockInput.pressKey("ARROW_DOWN")
    app.mockInput.pressEnter()
    await waitFor(app, () => calls.report.at(-1)?.from === tomorrow - 30 * DAY, "the 30 day range")
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("pages the grouped report in bounded server pages", async () => {
  const { value, calls } = loaders({
    report: async (input) => {
      calls.report.push(input)
      return { rows: rows("model"), groups: 250 }
    },
  })
  const app = await renderIncidents({ load: value })
  try {
    const frame = await waitFor(app, (text) => text.includes("openai/gpt-x"), "the first page")
    expect(frame).toContain("Rows 1–2 of 250")
    app.mockInput.pressKey("]")
    await waitFor(app, () => calls.report.at(-1)?.offset === 100, "the second page")
    expect(calls.report.every((query) => (query.limit ?? 0) <= 200)).toBe(true)
    app.mockInput.pressKey("[")
    await waitFor(app, () => calls.report.at(-1)?.offset === 0, "the first page again")
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("ignores a late report or detail from a superseded query", async () => {
  const pending: Array<{ input: ReportInput; result: ReturnType<typeof deferred<ModelIncidentReport>> }> = []
  const { value } = loaders({
    report: (input) => {
      const result = deferred<ModelIncidentReport>()
      pending.push({ input, result })
      return result.promise
    },
  })
  const app = await renderIncidents({ load: value })
  try {
    await waitFor(app, () => pending.length === 1, "the first report request")
    app.mockInput.pressKey("b")
    await waitFor(app, (text) => text.includes("Incident grouping"), "the grouping chooser")
    await app.mockInput.typeText("Agent")
    app.mockInput.pressEnter()
    await waitFor(app, () => pending.length === 2, "the agent request")
    pending[1]!.result.resolve(report("agent"))
    await waitFor(app, (text) => text.includes("openai/gpt-x · build"), "agent rows")
    pending[0]!.result.resolve(report("model"))
    await Bun.sleep(50)
    const frame = app.captureCharFrame()
    expect(frame).toContain("openai/gpt-x · build")
    expect(frame).toContain("Group agent")
  } finally {
    app.renderer.destroy()
  }
}, 30_000)

test("ignores late work after the screen unmounts", async () => {
  const result = deferred<ModelIncidentReport>()
  const { value, calls } = loaders({ report: () => result.promise })
  const app = await renderIncidents({ load: value })
  app.renderer.destroy()
  result.resolve(report("model"))
  await Bun.sleep(30)
  expect(calls.recent).toHaveLength(0)
})

test("reflows rows into labelled two-line entries on narrow terminals", async () => {
  const { value } = loaders()
  const app = await renderIncidents({ load: value, width: 70, height: 50 })
  try {
    const frame = await waitFor(app, (text) => text.includes("3 fallbacks · 2 escalated · 1 rejected · last 2026-09-22 11:30"), "compact rows")
    expect(frame).not.toContain("FALLBACKS")
    expect(frame).toContain("0 fallbacks · 1 escalated · 0 rejected · last 2026-09-20 09:05")
  } finally {
    app.renderer.destroy()
  }
}, 30_000)
