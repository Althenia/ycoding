/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
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
    const railStart = viewport.width - 50

    expect(lines[4]?.indexOf("−")).toBe(railStart + 7)
    expect(lines[4]?.indexOf("SESSION")).toBe(railStart + 10)
    const rowOf = (label: string) => lines.findIndex((line) => line.includes(label))
    expect(rowOf("Provider cache audit")).toBe(7)
    expect(rowOf("ses_rail_desi…")).toBe(9)
    expect(rowOf("CONTEXT")).toBe(12)
    const input = rowOf("Input")
    expect(input).toBe(15)
    expect(rowOf("Output")).toBe(17)
    expect(rowOf("Used")).toBe(19)
    expect(rowOf("Spent")).toBe(21)
    expect(rowOf("CACHE")).toBe(25)
    expect(rowOf("Hit ratio")).toBe(27)
    expect(rowOf("Prefix")).toBe(28)
    expect(rowOf("Reads")).toBe(30)
    expect(rowOf("Writes")).toBe(32)
    expect(rowOf("TODO LIST")).toBe(-1)
    expect(rowOf("SUBAGENTS")).toBe(-1)
    expect(rowOf("SHELLS")).toBe(-1)
    expect(rowOf("SKILLS")).toBe(-1)
    expect(rowOf("MCP")).toBe(-1)
    expect(rowOf("PLUGINS")).toBe(-1)
    const inputEnd = (lines[input]?.indexOf("1,411") ?? -Infinity) + "1,411".length
    expect(inputEnd).toBeGreaterThanOrEqual(viewport.width - 4)
    expect(inputEnd).toBeLessThanOrEqual(viewport.width - 3)
  } finally {
    await screen.dispose()
  }
}

describe("active-session rail Penpot design match", () => {
  test("matches the 189x69 rail measurements", () => expectRailDesign(DESIGN_VIEWPORT), 60_000)
  test("matches the 220x69 rail measurements", () => expectRailDesign(DESIGN_VIEWPORT_WIDE), 60_000)
})
