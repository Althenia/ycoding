/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"
import { renderScreen } from "./harness"

const sessionID = "ses_chrome_design_match"
const directory = "/tmp/ycoding/session-chrome-design-match"
const location = { directory, project: { id: "proj_session_chrome_design_match", directory } }
const session = {
  id: sessionID,
  title: "Chrome design match",
  projectID: "proj_session_chrome_design_match",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

function route(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({ data: [], cursor: {} })
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
      "/api/integration",
      "/api/command",
      "/api/skill",
      "/api/reference",
      "/api/permission/request",
      "/api/form/request",
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
        model: session.model,
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 0, mechanism: "unreported", readReported: false, writeReported: false },
        requests: {
          logical: 0,
          physical: 0,
          helpers: 0,
          continued: 0,
          fallback: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
  return undefined
}

async function expectChrome(viewport: typeof DESIGN_VIEWPORT) {
  const screen = await renderScreen({ ...viewport, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    const lines = screen.lines()
    expect(lines.findIndex((line) => line.includes("─") && line.indexOf("─") < viewport.width / 2)).toBe(57)
    expect(lines.findIndex((line) => line.includes("Message YCoding…"))).toBe(59)
    expect(lines.findIndex((line) => line.includes("Enter send"))).toBe(61)
    expect(lines[59]?.indexOf("Message YCoding…")).toBe(3)
    expect(lines[61]?.indexOf("Enter send")).toBe(3)
    expect(lines[60]).not.toContain("Build")
    expect(lines.findIndex((line) => line.includes("goal off") && line.includes("YOLO off"))).toBe(67)
    expect(lines[67]).toContain("subagents 0")
    expect(lines.slice(68).join("\n")).not.toContain(directory)
    const header = lines.find((line) => line.includes("y. ycoding") && line.includes("ready"))
    expect(header).toContain("Build · Claude Opus 5 · max")
    expect(header?.indexOf("ready")).toBe(viewport.width - 3 - "ready".length)
  } finally {
    await screen.dispose()
  }
}

describe("active-session chrome Penpot design match", () => {
  test("matches the 189x69 chrome rows", () => expectChrome(DESIGN_VIEWPORT), 60_000)
  test("matches the 220x69 chrome rows", () => expectChrome(DESIGN_VIEWPORT_WIDE), 60_000)
})
