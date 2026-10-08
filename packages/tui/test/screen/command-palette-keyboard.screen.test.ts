import { expect, test } from "bun:test"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_palette_keyboard"
const directory = "/tmp/ycoding/palette-keyboard"
const location = { directory, project: { id: "proj_palette_keyboard", directory } }
const session = {
  id: sessionID,
  title: "Palette keyboard",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model: { providerID: "test", id: "test-model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

const route = (url: URL) => {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/subagent`) return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (/^\/api\/session\/[^/]+\/(pending|permission|form|todo|skills|guardrail\/request)$/.test(url.pathname)) return json({ data: [] })
  if (url.pathname === "/api/model") return json({ location, data: [{ id: "test-model", modelID: "test-model", providerID: "test", name: "Test Model", family: "", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 100_000, output: 10_000 } }] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "test", name: "Test" }] })
  if (url.pathname === "/api/agent") return json({ location, data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }] })
  return undefined
}

test("Escape closes the palette and restores draft input ownership without dispatching an action", async () => {
  const posts: string[] = []
  const screen = await renderScreen({
    width: 110,
    height: 50,
    kittyKeyboard: true,
    args: { sessionID },
    settle: "Message YCoding…",
    route: (url, request) => {
      if (request.method === "POST") posts.push(url.pathname)
      return route(url)
    },
  })

  try {
    await screen.input.typeText("keep this draft")
    await screen.renderOnce()
    expect(screen.frame()).toContain("keep this draft")
    screen.input.pressKey("p", { ctrl: true })
    await screen.renderOnce()
    expect(screen.frame()).toContain("Commands")
    expect(screen.frame()).toContain("Search")
    screen.input.pressEscape()
    await screen.renderOnce()
    expect(screen.frame()).toContain("keep this draft")
    expect(screen.frame()).not.toContain("Search")
    await screen.input.typeText(" retained")
    await screen.renderOnce()
    expect(screen.frame()).toContain("keep this draft retained")
    expect(posts).toEqual([])
  } finally {
    await screen.dispose()
  }
}, 60_000)
