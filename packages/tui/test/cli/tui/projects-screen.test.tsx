import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { useRoute } from "../../../src/context/route"
import { backend, docsID, leadID } from "../../fixture/coordination-backend"
import { json, sessionSnapshot } from "../../fixture/tui-client"
import { renderScreen } from "../../screen/harness"

async function mount(width = 120) {
  const server = backend()
  let router!: ReturnType<typeof useRoute>
  const route = async (url: URL, request: Request) => {
    if (/^\/api\/session\/[^/]+\/todo$/.test(url.pathname)) return json({ data: [] })
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? server.state.sessions[leadID]!.directory
      return json({ directory, project: { id: "proj_test", directory } })
    }
    const match = /^\/api\/session\/([^/]+)(\/snapshot)?$/.exec(url.pathname)
    if (request.method === "GET" && match && server.state.sessions[match[1]!]) {
      const source = server.state.sessions[match[1]!]!
      const session = {
        id: match[1]!,
        title: source.title,
        location: { directory: source.directory },
        projectID: "proj_test",
        agent: "build",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      }
      const messages = [
        {
          id: "msg_instruction",
          type: "user",
          text: "Draft the release notes and report the result.",
          files: [],
          agents: [],
          time: { created: 10, consumed: 11 },
        },
        ...(session.id === leadID
          ? [
              {
                id: "msg_notification",
                type: "synthetic",
                description: "Project notification",
                text: "Project notification",
                metadata: {
                  source: "project_notification",
                  memberSessionID: docsID,
                  title: "Docs worker",
                  event: "completed",
                  excerpt: "Release notes drafted.",
                },
                time: { created: 20 },
              },
            ]
          : []),
      ]
      return match[2] ? sessionSnapshot(session.id, messages, { session }) : json({ data: session })
    }
    return server.route(url, request)
  }
  const screen = await renderScreen({
    width,
    height: width < 100 ? 24 : 40,
    args: { sessionID: leadID },
    route,
    config: { animations: false },
    data: () => {
      router = useRoute()
    },
    settle: "Master of Release train",
    sessionReady: true,
    kittyKeyboard: true,
  })
  return { screen, server, router: () => router }
}
async function waitFor(screen: Awaited<ReturnType<typeof mount>>["screen"], text: string) {
  for (let i = 0; i < 250; i++) {
    await screen.renderOnce()
    if (screen.frame().includes(text) && !screen.frame().includes("Loading session…")) return
    await Bun.sleep(10)
  }
  throw new Error(`Missing ${text}:\n${screen.frame()}`)
}
async function capture(screen: Awaited<ReturnType<typeof mount>>["screen"], name: string) {
  if (!process.env.PROJECTS_CAPTURE_DIR) return
  const directory = path.resolve(process.env.PROJECTS_CAPTURE_DIR)
  await mkdir(directory, { recursive: true })
  await Bun.write(path.join(directory, `${name}.txt`), screen.frame())
  const spans = screen.spans()
  await Bun.write(
    path.join(directory, `${name}.json`),
    JSON.stringify({
      cols: spans.cols,
      rows: spans.rows,
      lines: spans.lines.map((line) =>
        line.spans.map((span) => ({
          text: span.text,
          width: span.width,
          fg: span.fg.toInts(),
          bg: span.bg.toInts(),
          attributes: span.attributes,
        })),
      ),
    }),
  )
}
test("real Session navigation opens member chat and empty Up returns to Master", async () => {
  const { screen, router } = await mount()
  try {
    expect(screen.frame()).toContain("MASTER")
    expect(screen.frame()).toContain("Docs worker finished")
    expect(screen.frame()).toContain("[o] Open")
    await capture(screen, "master-120x40")
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await waitFor(screen, "esc chat")
    screen.input.pressArrow("down")
    screen.input.pressKey("o")
    await waitFor(screen, "Member of Release train")
    expect(router().data).toMatchObject({ type: "session", sessionID: docsID })
    await capture(screen, "member-120x40")
    screen.input.pressArrow("up")
    await waitFor(screen, "Master of Release train")
    expect(router().data).toMatchObject({ type: "session", sessionID: leadID })
  } finally {
    await screen.dispose()
  }
}, 30_000)
test("real Projects route list, creation and Settings render", async () => {
  const { screen, router } = await mount()
  try {
    router().navigate({ type: "projects", sessionID: leadID })
    await waitFor(screen, "preview")
    await capture(screen, "list-120x40")
    screen.input.pressKey("n")
    await waitFor(screen, "NEW PROJECT")
    for (let i = 0; i < 100 && !(screen.renderer.currentFocusedEditor instanceof InputRenderable); i++) {
      await screen.renderOnce()
      await Bun.sleep(10)
    }
    expect(screen.renderer.currentFocusedEditor).toBeInstanceOf(InputRenderable)
    await capture(screen, "create-120x40")
    screen.input.pressEscape()
    await waitFor(screen, "↑↓ field")
    screen.input.pressEscape()
    await waitFor(screen, "preview")
    screen.input.pressKey("s")
    await waitFor(screen, "GENERAL")
    await capture(screen, "settings-120x40")
  } finally {
    await screen.dispose()
  }
}, 30_000)
test("80-column Session collapses into chips and a keyboard-operated members tray", async () => {
  const { screen } = await mount(80)
  try {
    expect(screen.frame()).toContain("ctrl+x p members")
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await waitFor(screen, "MEMBERS 4")
    expect(screen.frame()).toContain("Design review")
    expect(screen.frame()).toContain("[o] Open")
    await capture(screen, "tray-80x24")
    screen.input.pressEscape()
    await waitFor(screen, "ctrl+x p members")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("60-column Project chat keeps both footer rows without the chips", async () => {
  const { screen } = await mount(60)
  try {
    expect(screen.frame()).toContain("subagents")
    expect(screen.frame()).toContain("commands")
    expect(screen.frame()).not.toContain("MASTER Lead")
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("p")
    await waitFor(screen, "MEMBERS 4")
    expect(screen.frame()).not.toContain("Workspace/")
    await capture(screen, "tray-60x24")
  } finally {
    await screen.dispose()
  }
}, 30_000)
