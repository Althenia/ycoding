import { expect, test } from "bun:test"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_palette_coverage"
const directory = "/tmp/ycoding/palette-coverage"
const location = { directory, project: { id: "proj_palette_coverage", directory } }
const session = {
  id: sessionID,
  title: "Palette coverage",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model: { providerID: "test", id: "test-model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

function fixture(options: { running?: boolean } = {}) {
  const posts: string[] = []
  const route = (url: URL, request: Request) => {
    if (request.method === "POST") posts.push(url.pathname)
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (request.method === "POST" && /\/(compact|interrupt|background)$/.test(url.pathname))
      return new Response(null, { status: 204 })
    if (url.pathname === "/api/session/active") return json({ data: options.running ? { [sessionID]: {} } : {} })
    if (url.pathname === "/api/command")
      return json({
        location,
        data: [{ name: "review", template: "Review $ARGUMENTS", description: "Review the working tree" }],
      })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/subagent`)
      return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (/^\/api\/session\/[^/]+\/(pending|permission|form|todo|skills|guardrail\/request)$/.test(url.pathname))
      return json({ data: [] })
    if (url.pathname === "/api/model")
      return json({
        location,
        data: [
          {
            id: "test-model",
            modelID: "test-model",
            providerID: "test",
            name: "Test Model",
            family: "",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 100_000, output: 10_000 },
          },
        ],
      })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "test", name: "Test" }] })
    if (url.pathname === "/api/agent")
      return json({
        location,
        data: [
          { id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] },
        ],
      })
    return undefined
  }
  return { posts, route }
}

async function openPalette(screen: Awaited<ReturnType<typeof renderScreen>>) {
  screen.input.pressKey("p", { ctrl: true })
  await waitFor(screen, (frame) => frame.includes("Commands") && frame.includes("Search"))
}

async function waitFor(screen: Awaited<ReturnType<typeof renderScreen>>, predicate: (frame: string) => boolean) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (predicate(screen.frame())) return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for frame:\n${screen.frame()}`)
}

async function search(screen: Awaited<ReturnType<typeof renderScreen>>, query: string) {
  await screen.input.typeText(query)
  await Bun.sleep(150)
}

test("the landing palette finds commands by slash name and alias and lists configured commands", async () => {
  const { route } = fixture()
  const screen = await renderScreen({ width: 110, height: 50, kittyKeyboard: true, settle: "Message YCoding…", route })
  try {
    await openPalette(screen)
    await search(screen, "/resume")
    expect(screen.frame()).toContain("Switch session")
    expect(screen.frame()).not.toContain("Open settings")
    for (let index = 0; index < "/resume".length; index++) screen.input.pressBackspace()
    await search(screen, "/docs")
    expect(screen.frame()).toContain("Open documentation")
    for (let index = 0; index < "/docs".length; index++) screen.input.pressBackspace()
    await search(screen, "/review")
    expect(screen.frame()).toContain("/review")
    expect(screen.frame()).toContain("Review the working tree")
    expect(screen.frame()).toContain("Commands")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("the landing palette offers cycles and display toggles that were keybind-only", async () => {
  const { route } = fixture()
  const screen = await renderScreen({ width: 110, height: 50, kittyKeyboard: true, settle: "Message YCoding…", route })
  try {
    await openPalette(screen)
    for (const [query, title] of [
      ["Model cycle", "Model cycle"],
      ["Agent cycle", "Agent cycle"],
      ["Favorite cycle", "Favorite cycle"],
      ["animations", "animations"],
      ["diff wrapping", "diff wrapping"],
      ["paste summary", "paste summary"],
      ["theme mode", "theme mode"],
    ] as const) {
      await search(screen, query)
      expect(screen.frame().toLowerCase()).toContain(title.toLowerCase())
      for (let index = 0; index < query.length; index++) screen.input.pressBackspace()
      await Bun.sleep(50)
    }
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("a configured command selected in the palette fills the prompt", async () => {
  const { route } = fixture()
  const screen = await renderScreen({ width: 110, height: 50, kittyKeyboard: true, settle: "Message YCoding…", route })
  try {
    await openPalette(screen)
    await search(screen, "/review")
    screen.input.pressEnter()
    await waitFor(screen, (frame) => !frame.includes("Search") && frame.includes("/review "))
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("the Session palette matches /compact and runs compaction", async () => {
  const { posts, route } = fixture()
  const screen = await renderScreen({ width: 110, height: 50, kittyKeyboard: true, args: { sessionID }, settle: "Message YCoding…", route })
  try {
    await openPalette(screen)
    await search(screen, "/compact")
    expect(screen.frame()).toContain("Compact session")
    expect(screen.frame()).not.toContain("Rename session")
    screen.input.pressEnter()
    const deadline = Date.now() + 10_000
    while (!posts.includes(`/api/session/${sessionID}/compact`) && Date.now() < deadline) await Bun.sleep(25)
    expect(posts).toContain(`/api/session/${sessionID}/compact`)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("a running Session palette interrupts directly without prompt focus", async () => {
  const { posts, route } = fixture({ running: true })
  const screen = await renderScreen({ width: 110, height: 50, kittyKeyboard: true, args: { sessionID }, settle: "Message YCoding…", route })
  try {
    await openPalette(screen)
    await search(screen, "Interrupt session")
    expect(screen.frame()).toContain("Interrupt session")
    screen.input.pressEnter()
    const deadline = Date.now() + 10_000
    while (!posts.includes(`/api/session/${sessionID}/interrupt`) && Date.now() < deadline) await Bun.sleep(25)
    expect(posts).toContain(`/api/session/${sessionID}/interrupt`)
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("an idle Session palette hides the commands that need a running step", async () => {
  const { route } = fixture()
  const screen = await renderScreen({ width: 110, height: 50, kittyKeyboard: true, args: { sessionID }, settle: "Message YCoding…", route })
  try {
    await openPalette(screen)
    await search(screen, "Interrupt")
    expect(screen.frame()).not.toContain("Interrupt session")
    for (let index = 0; index < "Interrupt".length; index++) screen.input.pressBackspace()
    await search(screen, "Background")
    expect(screen.frame()).not.toContain("Background blocking tools")
    for (let index = 0; index < "Background".length; index++) screen.input.pressBackspace()
    for (const title of ["Page up", "Line up", "Switch to session in quick slot 1", "Show command palette"]) {
      await search(screen, title)
      expect(screen.frame().split(title)).toHaveLength(2)
      for (let index = 0; index < title.length; index++) screen.input.pressBackspace()
    }
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("a running Session palette backgrounds blocking tools once and lists the Session display toggles", async () => {
  const { posts, route } = fixture({ running: true })
  const screen = await renderScreen({ width: 110, height: 50, kittyKeyboard: true, args: { sessionID }, settle: "Message YCoding…", route })
  try {
    await openPalette(screen)
    await search(screen, "Collapse thinking")
    expect(screen.frame()).toContain("thinking")
    for (let index = 0; index < "Collapse thinking".length; index++) screen.input.pressBackspace()
    await search(screen, "scrollbar")
    expect(screen.frame()).toContain("Toggle session scrollbar")
    for (let index = 0; index < "scrollbar".length; index++) screen.input.pressBackspace()
    await search(screen, "Background")
    expect(screen.frame().split("\n").filter((line) => line.includes("Background blocking tools"))).toHaveLength(1)
    screen.input.pressEnter()
    const deadline = Date.now() + 10_000
    while (!posts.includes(`/api/session/${sessionID}/background`) && Date.now() < deadline) await Bun.sleep(25)
    expect(posts).toContain(`/api/session/${sessionID}/background`)
  } finally {
    await screen.dispose()
  }
}, 60_000)
