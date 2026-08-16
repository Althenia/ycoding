/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { railWidth } from "../../src/routes/session/rail"
import { json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"
import { renderScreen } from "./harness"

const sessionID = "ses_rail_design_match"
const directory = "/tmp/ycoding/rail-design-match"
const location = { directory, project: { id: "proj_rail_design_match", directory } }
const session = {
  id: sessionID,
  title: "Provider cache audit",
  projectID: "proj_rail_design_match",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 9.08,
  tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
  time: { created: 1, updated: 4 },
}

function route(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({
      data: [
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" },
          content: [{ type: "text", text: "Two places record it." }],
          time: { created: 2, completed: 3 },
        },
        { id: "msg_user", type: "user", text: "Where is provider cache telemetry recorded?", time: { created: 1 } },
      ],
      cursor: {},
    })
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/subagent`,
      `/api/session/${sessionID}/todo`,
      `/api/session/${sessionID}/skills`,
      `/api/session/${sessionID}/guardrail/request`,
      "/api/shell",
      "/api/mcp",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
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
        context: { total: 1_464, limit: 200_000, percent: 56 },
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
      data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
    })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
    return json({ location, data: [] })
  if (url.pathname === "/api/permission/request" || url.pathname === "/api/form/request") return json({ location, data: [] })
  return undefined
}

async function expectRailDesign(viewport: typeof DESIGN_VIEWPORT) {
  const screen = await renderScreen({ ...viewport, args: { sessionID }, route, settle: "Claude Opus 5" })
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (screen.frame().includes("Writes") && screen.frame().includes("CONTEXT")) break
      await Bun.sleep(20)
    }
    const lines = screen.lines()
    const railStart = viewport.width - railWidth(viewport.width)

    expect(lines[4]?.indexOf("−") - railStart).toBe(3)
    expect(lines[4]?.indexOf("SESSION") - railStart).toBe(6)
    const rowOf = (label: string) => lines.findIndex((line) => line.includes(label))
    expect(rowOf("Provider cache audit")).toBe(7)
    expect(lines[9]?.slice(railStart)).not.toContain("ses_")
    expect(rowOf("CONTEXT")).toBe(10)
    expect(rowOf("Model")).toBe(12)
    expect(rowOf("Context")).toBe(13)
    const cache = rowOf("Cache")
    expect(cache).toBe(14)
    expect(rowOf("SPEND")).toBe(16)
    expect(rowOf("Total")).toBe(17)
    expect(rowOf("CACHE")).toBe(19)
    expect(rowOf("Prefix")).toBe(20)
    expect(rowOf("Reads")).toBe(21)
    expect(rowOf("Writes")).toBe(22)
    expect(rowOf("TODO LIST")).toBe(-1)
    expect(rowOf("SUBAGENTS")).toBe(-1)
    expect(rowOf("SHELLS")).toBe(-1)
    expect(rowOf("SKILLS")).toBe(-1)
    expect(rowOf("MCP")).toBe(-1)
    expect(rowOf("PLUGINS")).toBe(-1)
    const cacheEnd = (lines[cache]?.indexOf("71%") ?? -Infinity) + "71%".length
    expect(cacheEnd).toBeGreaterThanOrEqual(viewport.width - 4)
    expect(cacheEnd).toBeLessThanOrEqual(viewport.width - 3)
  } finally {
    await screen.dispose()
  }
}

describe("active-session rail Penpot design match", () => {
  test("matches the 189x69 rail measurements", () => expectRailDesign(DESIGN_VIEWPORT), 60_000)
  test("matches the 220x69 rail measurements", () => expectRailDesign(DESIGN_VIEWPORT_WIDE), 60_000)
})
