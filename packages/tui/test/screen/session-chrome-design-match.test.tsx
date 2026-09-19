/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"
import { railWidth } from "../../src/routes/session/rail"
import { renderScreen } from "./harness"

const sessionID = "ses_chrome_design_match"
const directory = "/tmp/ycoding/session-chrome-design-match"
const location = { directory, project: { id: "proj_session_chrome_design_match", directory } }
// A profile fixture uses a distinct directory: the client store keys location data by location, and
// reusing this one would serve the earlier empty integration list from its resident cache.
const profileDirectory = "/tmp/ycoding/session-chrome-profile"
const profileLocation = { directory: profileDirectory, project: { id: "proj_session_chrome_profile", directory: profileDirectory } }
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

const profileSession = {
  ...session,
  projectID: "proj_session_chrome_profile",
  location: { directory: profileDirectory },
  title: "Chrome profile match",
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
    const ruleRow = lines.findIndex((line) => line.includes("─") && line.indexOf("─") < viewport.width / 2)
    const footerRow = lines.findIndex((line) => line.includes("goal off") && line.includes("YOLO off"))
    // A resting chat composer occupies only its rule and input row.
    // Its surrounding surface is six rows tall, matching the landing composer before the shared footer row.
    expect(ruleRow).toBe(58)
    expect(footerRow - ruleRow).toBe(9)
    expect(lines.findIndex((line) => line.includes("Message YCoding…"))).toBe(61)
    expect(lines[61]?.indexOf("Message YCoding…")).toBe(3)
    expect(lines.some((line) => line.includes("Enter send"))).toBe(false)
    expect(lines[62]).not.toContain("Build")
    expect(footerRow).toBe(67)
    expect(lines[67]).toContain("subagents 0")
    expect(lines.slice(68).join("\n")).not.toContain(directory)
    const header = lines.find((line) => line.includes(`v${InstallationVersion}`) && line.includes("ready"))
    expect(header).toContain("Build · anthropic/Claude Opus 5 · max")
    expect(header?.indexOf("ready")).toBe(viewport.width - 3 - "ready".length)
  } finally {
    await screen.dispose()
  }
}

async function expectComposerSurface(viewport: typeof DESIGN_VIEWPORT) {
  const screen = await renderScreen({ ...viewport, args: { sessionID }, route, settle: "Message YCoding…" })
  try {
    const lines = screen.lines()
    const mainWidth = viewport.width - railWidth(viewport.width)
    const spans = screen.spans().lines
    const rule = [...(lines[58] ?? "")].flatMap((character, column) => (character === "─" ? [column] : []))
    const ruleBackground = spans[58]?.spans.find((span) => span.text.includes("─"))?.bg.toInts()
    const promptBackground = spans[61]?.spans.find((span) => span.text.includes("Message YCoding…"))?.bg.toInts()

    expect([rule[0], rule.at(-1)]).toEqual([0, mainWidth - 1])
    expect(promptBackground).toEqual(ruleBackground)
  } finally {
    await screen.dispose()
  }
}

/**
 * A provider with two stored profiles: the header must stay provider/model, and the Context rail
 * must carry the active profile above Provider. Every location-bearing endpoint answers with the
 * profile location so the client store keys this fixture separately from the shared one.
 */
function profileRoute(url: URL) {
  if (url.pathname === "/api/integration")
    return json({
      location: profileLocation,
      data: [
        {
          id: "anthropic",
          name: "Claude",
          methods: [],
          connections: [
            { type: "credential", id: "cred_work", label: "Work", active: true },
            { type: "credential", id: "cred_personal", label: "Personal", active: false },
          ],
        },
      ],
    })
  if (url.pathname === "/api/location") return json(profileLocation)
  if (url.pathname === "/api/provider") return json({ location: profileLocation, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/model")
    return json({
      location: profileLocation,
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
  if (url.pathname === "/api/fs/list") return json({ location: profileLocation, data: [] })
  if (url.pathname === "/api/session") return json({ data: [profileSession], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: profileSession })
  if (url.pathname === "/api/agent")
    return json({
      location: profileLocation,
      data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
    })
  return route(url)
}

async function expectProfilePlacement(viewport: typeof DESIGN_VIEWPORT) {
  // Rail expansion is process-global and shared across Session remounts, so a neighbouring file's
  // collapse of CONTEXT would hide the row. Reset it so this assertion measures placement, not
  // another test's leftover state.
  const { resetRailExpansion } = await import("../../src/routes/session/rail-section")
  resetRailExpansion()
  const screen = await renderScreen({
    ...viewport,
    args: { sessionID },
    route: profileRoute,
    settle: "Message YCoding…",
  })
  try {
    // The Context section fills from its own diagnostics fetch, which can land after the composer
    // settles. Wait for the rows to paint before measuring their order.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const painted = screen.frame()
      if (painted.includes("Profile") && painted.includes("Provider")) break
      await Bun.sleep(50)
    }
    const lines = screen.lines()
    const railStart = viewport.width - railWidth(viewport.width)
    const header = lines.find((line) => line.includes(`v${InstallationVersion}`) && line.includes("ready"))
    // The header names the model identity; credential identity lives in the rail.
    expect(header).toContain("Build · anthropic/Claude Opus 5 · max")
    expect(header).not.toContain("Work")
    const rail = lines.map((line) => line.slice(railStart))
    const profileRow = rail.findIndex((line) => line.includes("Profile"))
    const providerRow = rail.findIndex((line) => line.includes("Provider") && line.includes("anthropic"))
    expect(providerRow, rail.join("|")).toBeGreaterThan(-1)
    expect(profileRow).toBeGreaterThan(-1)
    expect(profileRow).toBeLessThan(providerRow)
    expect(rail[profileRow]).toContain("Work")
    // A narrow terminal hides the rail; the header still must not resurrect the profile.
    const narrow = await renderScreen({
      width: 80,
      height: 24,
      args: { sessionID },
      route: profileRoute,
      settle: "Message YCoding…",
    })
    try {
      const narrowHeader = narrow
        .lines()
        .find((line) => line.includes(`v${InstallationVersion}`) && line.includes("ready"))
      expect(narrowHeader).not.toContain("Work")
      expect(narrow.lines().some((line) => line.includes("Profile"))).toBe(false)
    } finally {
      await narrow.dispose()
    }
  } finally {
    await screen.dispose()
  }
}

describe("active-session chrome Penpot design match", () => {
  test("matches the 189x69 chrome rows", () => expectChrome(DESIGN_VIEWPORT), 60_000)
  test("matches the 220x69 chrome rows", () => expectChrome(DESIGN_VIEWPORT_WIDE), 60_000)
  test("fills the main column behind the composer at responsive widths", async () => {
    await expectComposerSurface(DESIGN_VIEWPORT)
    await expectComposerSurface(DESIGN_VIEWPORT_WIDE)
  }, 60_000)
  test("names the active profile in the Context rail and not the header", async () => {
    await expectProfilePlacement(DESIGN_VIEWPORT)
    await expectProfilePlacement(DESIGN_VIEWPORT_WIDE)
  }, 120_000)
})
