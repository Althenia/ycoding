import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_mention_ranking"
const directory = "/tmp/ycoding/mention-ranking"
const location = { directory, project: { id: "proj_mention_ranking", directory } }
const model = { providerID: "openai", id: "fixture" }
const session = {
  id: sessionID,
  title: "Mention ranking",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const finds: Array<{ query: string | null; type: string | null; limit: string | null }> = []

function route(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (
    ["pending", "permission", "todo", "skills"].some(
      (resource) => url.pathname === `/api/session/${sessionID}/${resource}`,
    )
  )
    return json({ data: [] })
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
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [
        {
          ...model,
          modelID: model.id,
          name: "Fixture",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200000, output: 32000 },
        },
      ],
    })
  if (url.pathname === "/api/fs/find") {
    const query = url.searchParams.get("query")
    const type = url.searchParams.get("type")
    finds.push({ query, type, limit: url.searchParams.get("limit") })
    return json({
      location,
      data:
        query === "agents"
          ? type === "directory"
            ? [
                { path: "packages/containers/", type: "directory" },
                { path: "packages/client/", type: "directory" },
              ]
            : [
                { path: "AGENTS.md", type: "file" },
                { path: "docs/AGENTS.md", type: "file" },
              ]
          : [],
    })
  }
  return undefined
}

function composer(node: Renderable): TextareaRenderable | undefined {
  if (node instanceof TextareaRenderable) return node
  return node.getChildren().map(composer).find(Boolean)
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Expected file mention transition did not occur")
}

test.each([
  [80, 24],
  [100, 40],
])(
  "@agents shows and selects AGENTS.md before weak folder matches at %i×%i",
  async (width, height) => {
    finds.length = 0
    const screen = await renderScreen({
      width,
      height,
      args: { sessionID },
      route,
      config: { animations: false },
      settle: "Message YCoding…",
    })
    try {
      const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
      await screen.mouse.click(3, row)
      await screen.input.typeText("@agents")
      await until(() => screen.frame().includes("packages/containers/") && screen.frame().includes("AGENTS.md"))
      await screen.renderOnce()
      const lines = screen.lines()
      const file = lines.findIndex((line) => line.includes("AGENTS.md") && !line.includes("docs/"))
      const folder = lines.findIndex((line) => line.includes("packages/containers/"))
      const rest = lines.findIndex((line) => line.includes("docs/AGENTS.md"))
      expect(file).toBeGreaterThanOrEqual(0)
      expect(file).toBeLessThan(folder)
      expect(folder).toBeLessThan(rest)
      expect(finds.filter((entry) => entry.query === "agents").map((entry) => [entry.type, entry.limit])).toEqual([
        ["directory", "8"],
        ["file", "20"],
      ])
      screen.input.pressEnter()
      await until(() => composer(screen.renderer.root)?.plainText.startsWith("@AGENTS.md") === true)
      expect(composer(screen.renderer.root)?.plainText).toBe("@AGENTS.md ")
    } finally {
      await screen.dispose()
    }
  },
  30000,
)

test("the folder row after the best match still drills with one trailing separator", async () => {
  const screen = await renderScreen({
    width: 100,
    height: 40,
    args: { sessionID },
    route,
    config: { animations: false },
    settle: "Message YCoding…",
  })
  try {
    const row = screen.lines().findIndex((line) => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    await screen.input.typeText("@agents")
    await until(() => screen.frame().includes("packages/containers/") && screen.frame().includes("AGENTS.md"))
    screen.input.pressKey("ARROW_DOWN")
    screen.input.pressKey("TAB")
    await until(() => composer(screen.renderer.root)?.plainText === "@packages/containers/")
    expect(composer(screen.renderer.root)?.plainText).not.toContain("//")
  } finally {
    await screen.dispose()
  }
}, 30000)
