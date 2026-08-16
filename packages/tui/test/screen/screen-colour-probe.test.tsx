/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { json } from "../fixture/tui-client"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"
import { renderScreen } from "./harness"

const viewports = [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE] as const
const chrome = [15, 17, 21, 255] satisfies [number, number, number, number]
const rail = [29, 33, 40, 255] satisfies [number, number, number, number]
const border = [59, 66, 77, 255] satisfies [number, number, number, number]
const accent = [103, 215, 170, 255] satisfies [number, number, number, number]
const subdued = [152, 162, 179, 255] satisfies [number, number, number, number]

const directory = "/tmp/ycoding/screen-colour-probe"
const location = { directory, project: { id: "proj_screen_colour_probe", directory } }
const sessionID = "ses_screen_colour_probe"
const session = {
  id: sessionID,
  title: "Colour probe session",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

function landingRoute(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main" } })
  if (url.pathname === "/api/agent")
    return json({ location, data: [{ id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }] })
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
  if (url.pathname === "/api/provider") return json({ location, data: [] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname)) return json({ location, data: [] })
  return undefined
}

function sessionRoute(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
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
    return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`)
    return json({
      data: {
        model: { providerID: "anthropic", id: "claude-opus-5" },
        context: { total: 0, percent: 0 },
        tokens: { uncachedInput: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, hitRatio: 0, mechanism: "none", readReported: false, writeReported: false },
        requests: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      },
    })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model") return landingRoute(url)
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent")
    return json({ location, data: [{ id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/permission/request", "/api/form/request"].includes(url.pathname))
    return json({ location, data: [] })
  return undefined
}

describe("screen chrome colour probes", () => {
  test("probes the landing header and footer at canonical viewports", async () => {
    for (const viewport of viewports) {
      const screen = await renderScreen({ ...viewport, route: landingRoute, settle: "Claude Opus 5" })
      try {
        await waitFor(screen, "Enter send")
        const headerBand = screen.spans().lines[1]?.spans ?? []
        const footerBand = screen.spans().lines[viewport.height - 2]?.spans ?? []
        expect(headerBand).not.toHaveLength(0)
        expect(headerBand.every((span) => span.bg.toInts().every((value, index) => value === chrome[index]))).toBe(true)
        expect(footerBand).not.toHaveLength(0)
        expect(footerBand.every((span) => span.bg.toInts().every((value, index) => value === chrome[index]))).toBe(true)
        expect(screen.colorOf("y. ycoding")).toEqual(accent)
        expect(screen.colorOf("ready")).toEqual(subdued)
        expect(screen.colorOf("subagents 0")).toEqual(subdued)
      } finally {
        await screen.dispose()
      }
    }
  }, 60_000)

  test("probes the session rail at canonical viewports", async () => {
    for (const viewport of viewports) {
      const screen = await renderScreen({ ...viewport, args: { sessionID }, route: sessionRoute, settle: "SESSION" })
      try {
        await waitFor(screen, "YCoding v")
        const railBand = railSpans(screen.spans().lines[4]?.spans ?? [], viewport.width)
        const railFooter = screen.spans().lines.findIndex((line) => line.spans.some((span) => span.text.includes("YCoding v")))
        const edgeBand = railSpans(screen.spans().lines[railFooter - 3]?.spans ?? [], viewport.width)
        expect(railBand).not.toHaveLength(0)
        expect(railBand.every((span) => span.bg.toInts().every((value, index) => value === rail[index]))).toBe(true)
        expect(edgeBand).not.toHaveLength(0)
        const railEdge = edgeBand.find((span) => span.text.includes("─"))
        if (!railEdge) throw new Error("Rail footer border did not render")
        expect(railEdge.fg.toInts()).toEqual(border)
        expect(screen.colorOf("SESSION")).toEqual(accent)
        expect(screen.colorOf("YCoding v")).toEqual(subdued)
      } finally {
        await screen.dispose()
      }
    }
  }, 60_000)
})

async function waitFor(screen: Awaited<ReturnType<typeof renderScreen>>, text: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (screen.frame().includes(text)) return
    await Bun.sleep(20)
  }
  throw new Error(`Screen did not render ${text}`)
}

function railSpans<T extends { width: number }>(spans: ReadonlyArray<T>, width: number) {
  const start = spans.findIndex((_, index) => spans.slice(0, index + 1).reduce((total, span) => total + span.width, 0) > width - 50)
  return start < 0 ? [] : spans.slice(start)
}
