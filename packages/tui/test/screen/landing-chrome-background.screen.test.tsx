/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { json, type FetchHandler } from "../fixture/tui-client"
import { renderScreen } from "./harness"
import type { useData } from "../../src/context/data"

const directory = "/tmp/ycoding/landing-chrome-background"
const location = { directory, project: { id: "proj_landing_chrome_background", directory } }
const row = (id: string, title: string, updated: number, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: updated, updated },
  ...extra,
})
const executor = row("ses_executor_newest", "Renamed arbitrarily", 30, { origin: "dots-executor" })
const ordinary = row("ses_ordinary_dots_title", "Dots · unattributed", 10)
const created = row("ses_created_for_chrome", "New session", 40)

function landingRoute(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main" } })
  if (url.pathname === "/api/agent")
    return json({ location, data: [{ id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }] })
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [{
        id: "claude-opus-5", modelID: "claude-opus-5", providerID: "anthropic", name: "Claude Opus 5",
        capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "max" }],
        time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 },
      }],
    })
  if (url.pathname === "/api/provider") return json({ location, data: [] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname)) return json({ location, data: [] })
  return undefined
}

async function connectChrome(sessions: readonly ReturnType<typeof row>[]) {
  const requests: string[] = []
  let data: ReturnType<typeof useData> | undefined
  const route: FetchHandler = (url, request) => {
    if (url.pathname === "/api/session" && request.method === "GET") return json({ data: sessions, cursor: {} })
    if (url.pathname === "/api/session" && request.method === "POST") {
      requests.push("create")
      return json({ data: created })
    }
    const status = /^\/api\/session\/(ses_[a-z_]+)\/browser$/.exec(url.pathname)
    if (status) {
      requests.push(`status ${status[1]}`)
      return json({ data: { state: "unavailable", paired: false } })
    }
    return landingRoute(url)
  }
  const screen = await renderScreen({ width: 100, height: 40, route, settle: "Message YCoding…", data: (value) => { data = value } })
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = data
      if (current?.location.info()?.directory === directory && sessions.every((item) => current.session.get(item.id) !== undefined)) break
      await Bun.sleep(20)
    }
    screen.input.pressKey("p", { ctrl: true })
    for (let attempt = 0; attempt < 100 && !screen.frame().includes("Commands"); attempt++) await Bun.sleep(20)
    await screen.input.typeText("Connect Chrome")
    screen.input.pressEnter()
    for (let attempt = 0; attempt < 100 && !screen.frame().includes("Chrome connection"); attempt++) await Bun.sleep(20)
    expect(screen.frame()).toContain("Chrome connection")
    return requests
  } finally {
    await screen.dispose()
  }
}

test("landing Chrome pairing reuses the ordinary Session in the directory and skips a newer executor Session", async () => {
  expect(await connectChrome([executor, ordinary])).toEqual([`status ${ordinary.id}`])
}, 30_000)

test("landing Chrome pairing creates a Session when only an executor Session matches the directory", async () => {
  expect(await connectChrome([executor])).toEqual(["create", `status ${created.id}`])
}, 30_000)
