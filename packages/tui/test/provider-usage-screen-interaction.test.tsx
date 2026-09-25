import { expect, test } from "bun:test"
import { json } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

const sessionID = "ses_provider_usage_interaction"
const directory = "/tmp/ycoding/provider-usage-interaction"
const location = { directory, project: { id: "proj_provider_usage", directory } }
const model = {
  id: "gpt-5.6",
  modelID: "gpt-5.6",
  providerID: "openai",
  name: "GPT 5.6",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 32_000 },
}
const session = {
  id: sessionID,
  title: "Usage round trip",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model: { providerID: "openai", id: "gpt-5.6" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

const prompts: string[] = []
let quotaReads = 0
let quotaGetReads = 0
let usageReads = 0
const reportCalls: URLSearchParams[] = []

async function route(url: URL, request: Request) {
  if (url.pathname.endsWith("/prompt") && request.method === "POST") prompts.push(await request.text())
  if (url.pathname === "/api/usage") {
    usageReads++
    const tokens = { input: 3_000, output: 600, reasoning: 300, cache: { read: 900, write: 150 } }
    return json({ data: {
      logical: 30, physical: 60, helpers: 0, continued: 0, fallback: 0,
      tokens, cost: 0.3, cacheReadReported: true,
      models: [{ model: { providerID: "openai", id: "Backend-wide model" }, requests: 30, tokens, cost: 0.3, costProvenance: "recorded", cacheReadReported: true }],
    } })
  }
  if (url.pathname === "/api/usage/report") {
    reportCalls.push(new URLSearchParams(url.searchParams))
    const group = url.searchParams.get("group") ?? "model"
    const metrics = {
      logical: 1, physical: 2, helpers: 0, continued: 0, fallback: 0,
      tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 30, write: 5 } },
      cost: 0.01, costProvenance: "recorded", cacheReadReported: true,
    }
    const day = new Date().toISOString().slice(0, 10)
    const rows = group === "model"
      ? Array.from({ length: 30 }, (_, index) => ({
          key: `model-${String(index + 1).padStart(2, "0")}`,
          label: `Keyboard Model ${String(index + 1).padStart(2, "0")}`,
          ...metrics,
        }))
      : [{ key: group === "day" ? day : group, label: group === "day" ? day : `Keyboard ${group}`, ...metrics }]
    return json({ data: { group, rows, total: {
      ...metrics, logical: rows.length, physical: rows.length * 2,
      tokens: { input: rows.length * 100, output: rows.length * 20, reasoning: rows.length * 10, cache: { read: rows.length * 30, write: rows.length * 5 } },
      cost: rows.length * 0.01,
    }, rowCount: rows.length } })
  }
  if (url.pathname === "/api/provider/usage") {
    quotaReads++
    return json({
      location,
      data: [
        {
          providerID: "openai",
          label: "OpenAI",
          status: "available",
          source: "provider_api",
          stability: "stable",
          updatedAt: 1,
          windows: Array.from({ length: 40 }, (_, index) => ({
            id: `window-${index + 1}`,
            label: `Quota window ${String(index + 1).padStart(2, "0")}`,
            unit: "percent", used: index + 1,
          })),
        },
        {
          providerID: "openrouter",
          label: "OpenRouter",
          status: "unsupported",
          source: "provider_api",
          stability: "stable",
          updatedAt: 1,
          windows: [],
          message: "Connected, but quota reporting is not available",
        },
      ],
    })
  }
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`)
    return json({
      data: {
        model: session.model,
        context: { total: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, mechanism: "none", readReported: false, writeReported: false },
      },
    })
  if (url.pathname === `/api/session/${sessionID}/usage`)
    return json({ data: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens } })
  if (url.pathname === "/api/provider/openai/usage") {
    quotaGetReads++
    return json({
      data: {
        providerID: "openai",
        label: "OpenAI",
        status: "available",
        source: "provider_api",
        stability: "stable",
        updatedAt: 1,
        windows: Array.from({ length: 40 }, (_, index) => ({
          id: `window-${index + 1}`,
          label: `Quota window ${String(index + 1).padStart(2, "0")}`,
          unit: "percent", used: index + 1,
        })),
      },
    })
  }
  if (url.pathname === "/api/model") return json({ location, data: [model] })
  if (url.pathname === "/api/provider") return json({
    location,
    data: [
      { id: "openai", name: "OpenAI" },
      { id: "openrouter", name: "OpenRouter" },
    ],
  })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [
        {
          id: "build",
          name: "Build",
          request: { headers: {}, body: {} },
          mode: "primary",
          hidden: false,
          permissions: [],
        },
      ],
    })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/path")
    return json({ home: process.env.HOME, state: "", config: "", worktree: directory, directory })
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/todo`,
      `/api/session/${sessionID}/skills`,
      `/api/session/${sessionID}/subagent`,
      "/api/shell",
      "/api/mcp",
      "/api/integration",
      "/api/command",
      "/api/reference",
      "/api/skill",
      "/api/mcp/resource",
      "/api/permission/request",
      "/api/form/request",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
  return undefined
}

async function waitFor(screen: Awaited<ReturnType<typeof renderScreen>>, text: string) {
  for (let i = 0; i < 100; i++) {
    if (screen.frame().includes(text)) return
    await Bun.sleep(20)
  }
  expect(screen.frame()).toContain(text)
}

test("opens provider usage without submitting a draft and returns by keyboard or mouse", async () => {
  const screen = await renderScreen({ width: 120, height: 40, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    for (const key of "keep this draft") await screen.input.pressKey(key)
    await screen.input.pressKey("x", { ctrl: true })
    await screen.input.pressKey("u")
    await waitFor(screen, "Nothing to undo")
    expect(screen.frame()).toContain("keep this draft")
    await screen.input.pressKey("x", { ctrl: true })
    await screen.input.pressKey("u", { shift: true })
    await waitFor(screen, "Overview")
    await waitFor(screen, "Backend-wide model")
    const reads = { quota: quotaReads, usage: usageReads }
    await screen.input.pressKey("r")
    for (let i = 0; i < 100 && (quotaReads <= reads.quota || usageReads <= reads.usage); i++) await Bun.sleep(20)
    expect(quotaReads).toBeGreaterThan(reads.quota)
    expect(usageReads).toBeGreaterThan(reads.usage)
    await screen.input.pressKey("ESCAPE")
    await waitFor(screen, "keep this draft")
    const usageRow = screen.lines().findLastIndex((line) => line.includes("usage"))
    expect(usageRow).toBeGreaterThanOrEqual(0)
    await screen.renderer.idle()
    await screen.mouse.click(screen.lines()[usageRow]!.indexOf("usage") + 1, usageRow)
    await waitFor(screen, "Overview")
    await waitFor(screen, "Backend-wide model")
    const backRow = screen.lines().findIndex((line) => line.includes(" back"))
    expect(backRow).toBeGreaterThanOrEqual(0)
    await screen.renderer.idle()
    await screen.mouse.click(screen.lines()[backRow]!.indexOf("back") + 1, backRow)
    await waitFor(screen, "keep this draft")
    expect(prompts).toEqual([])
    await screen.input.pressKey("p", { ctrl: true })
    await waitFor(screen, "Switch model")
    expect(screen.frame().toLowerCase()).not.toContain("provider usage")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("keeps the failed Overview free of scrollbar strips and makes padded navigation cells clickable", async () => {
  const screen = await renderScreen({
    width: 189, height: 69, args: { sessionID }, settle: "Message YCoding…",
    route: (url, request) => url.pathname === "/api/usage"
      ? new Response("Usage unavailable", { status: 500 })
      : route(url, request),
  })
  try {
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("u", { shift: true })
    await waitFor(screen, "YCoding backend usage could not be loaded.")
    expect(screen.scrollbox()?.horizontalScrollBar.visible).toBe(false)
    expect(screen.scrollbox()?.verticalScrollBar.visible).toBe(false)
    const bottom = screen.spans().lines[65].spans
    expect(bottom.every((span) => span.bg.toInts().join(",") === "21,24,29,255")).toBe(true)
    const navigationRow = screen.lines().findIndex((line) => line.includes("Overview"))
    const navigation = screen.lines()[navigationRow]
    expect(navigation).toMatch(/Overview {2,}│ {2,}Usage/)
    await screen.renderer.idle()
    await screen.mouse.click(navigation.indexOf("Usage") - 1, navigationRow)
    await waitFor(screen, "Quota window 01")
    expect(quotaGetReads).toBe(0)
    expect(screen.scrollbox()?.horizontalScrollBar.visible).toBe(false)
    expect(screen.scrollbox()?.verticalScrollBar.visible).toBe(true)
    screen.input.pressKey("END")
    await waitFor(screen, "Quota window 40")
    expect(screen.frame()).not.toContain("OpenRouter")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test.each([80, 189])("uses Tokscale-style keyboard navigation through the real Usage route at %i columns", async (width) => {
  reportCalls.length = 0
  const screen = await renderScreen({ width, height: width === 80 ? 24 : 69, args: { sessionID }, route, settle: "Message YCoding…" })
  const waitForGroup = async (group: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (reportCalls.at(-1)?.get("group") === group) return
      await Bun.sleep(20)
    }
    expect(reportCalls.at(-1)?.get("group")).toBe(group)
  }
  try {
    await screen.waitForEventStream()
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("retain keyboard draft")
    await screen.input.pressKey("x", { ctrl: true })
    await screen.input.pressKey("u", { shift: true })
    await waitFor(screen, "Overview")
    await screen.input.pressKey("ARROW_RIGHT")
    await waitFor(screen, "OpenAI")
    await waitFor(screen, "Quota window 01")
    expect(screen.frame()).not.toContain("Quota window 40")
    await screen.input.pressKey("END")
    await waitFor(screen, "Quota window 40")
    await screen.input.pressKey("HOME")
    await waitFor(screen, "Quota window 01")
    await screen.input.pressKey("TAB")
    await waitForGroup("model")
    await waitFor(screen, "Keyboard Model 01")
    if (width === 80) expect(screen.frame()).not.toContain("Keyboard Model 30")
    await screen.input.pressKey("END")
    await waitFor(screen, "Keyboard Model 30")
    await screen.input.pressKey("HOME")
    await waitFor(screen, "Keyboard Model 01")
    await screen.input.pressKey("ARROW_DOWN")
    await screen.input.pressKey("RETURN")
    await waitFor(screen, "Usage details")
    expect(screen.frame()).toContain("Keyboard Model 02")
    await screen.input.pressKey("ESCAPE")
    for (let attempt = 0; attempt < 100 && screen.frame().includes("Usage details"); attempt++) await Bun.sleep(20)
    expect(screen.frame()).not.toContain("Usage details")
    expect(screen.frame()).not.toContain("retain keyboard draft")

    await screen.input.pressKey("c")
    for (let attempt = 0; attempt < 100 && reportCalls.at(-1)?.get("sort") !== "cost"; attempt++) await Bun.sleep(20)
    expect(reportCalls.at(-1)?.get("sort")).toBe("cost")
    await screen.input.pressKey("t")
    for (let attempt = 0; attempt < 100 && reportCalls.at(-1)?.get("sort") !== "tokens"; attempt++) await Bun.sleep(20)
    expect(reportCalls.at(-1)?.get("sort")).toBe("tokens")

    for (const group of ["day", "hour", "month", "session", "project"]) {
      await screen.input.pressKey("ARROW_RIGHT")
      await waitForGroup(group)
    }
    await screen.input.pressKey("TAB")
    await waitFor(screen, "Activity graph")
    await screen.input.pressKey("ARROW_RIGHT")
    await waitForGroup("agent")
    await waitFor(screen, "Keyboard agent")
    await screen.input.pressKey("TAB", { shift: true })
    await waitFor(screen, "Activity graph")
    await screen.input.pressKey("ARROW_LEFT")
    await waitForGroup("project")
    const reads = reportCalls.length
    await screen.input.pressKey("r")
    for (let attempt = 0; attempt < 100 && reportCalls.length === reads; attempt++) await Bun.sleep(20)
    expect(reportCalls.length).toBeGreaterThan(reads)
    expect(screen.lines().every((line) => line.length <= width)).toBe(true)
    await screen.input.pressKey("ESCAPE")
    await waitFor(screen, "retain keyboard draft")
    expect(prompts).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 60_000)
