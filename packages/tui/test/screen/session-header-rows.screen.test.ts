import { expect, test } from "bun:test"
import { RenderableEvents, type Renderable } from "@opentui/core"
import { directory as defaultDirectory, json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_header_rows01"
const directory = `${process.env.HOME}/.agents`
const location = { directory, project: { id: "project", directory } }
const session = {
  id: sessionID,
  title: "Header rows",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 4 },
}
const subagents = Array.from({ length: 5 }, (_, index) => ({
  sessionID: `ses_child${index}`,
  parentID: sessionID,
  title: `Worker ${index}`,
  state: index < 3 ? "running" : "waiting",
  agent: "general",
  time: { created: 5 + index, updated: 6 + index },
}))

function route(mode: "waiting" | "tool") {
  return (url: URL) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === "/api/session/active") return json({ data: mode === "tool" ? { [sessionID]: {} } : {} })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/snapshot`)
      return sessionSnapshot(
        sessionID,
        [
          { id: "msg_user", type: "user", text: "Fan out the audit.", time: { created: 1 } },
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "anthropic", id: "claude-opus-5" },
            content:
              mode === "tool"
                ? [{ type: "tool", id: "call_shell", name: "bash", state: { status: "running", input: { command: "sleep 30" }, content: [], structured: {} }, time: { created: Date.now() - 10_000, ran: Date.now() - 9_900 } }]
                : [{ type: "text", text: "Waiting for the workers." }],
            time: mode === "tool" ? { created: Date.now() - 12_000 } : { created: 2, completed: 3 },
          },
        ],
        { session },
      )
    if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/subagent`)
      return json({ data: subagents, summary: { total: 5, active: 5, running: 3, waiting: 2 }, cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/skills`) return json({ data: [] })
    if (url.pathname === "/path")
      return json({ home: process.env.HOME, state: "", config: "", worktree: defaultDirectory, directory })
    return undefined
  }
}

function destroyListenerCounts(root: Renderable): number[] {
  return [root.listenerCount(RenderableEvents.DESTROYED), ...root.getChildren().flatMap(destroyListenerCounts)]
}

for (const width of [100, 120, 160])
  for (const mode of ["waiting", "tool"] as const)
    test(`${mode} Session at ${width} columns draws its header once and emits no process output`, async () => {
      const warnings: Error[] = []
      const collect = (warning: Error) => warnings.push(warning)
      process.on("warning", collect)
      const screen = await renderScreen({
        width,
        height: 30,
        args: { sessionID },
        settle: mode === "waiting" ? "waiting" : "tool running",
        route: route(mode),
      })
      try {
        await Bun.sleep(400)
        await screen.renderOnce()
        const frame = screen.frame()
        const lines = frame.split("\n")
        expect(lines.filter((line) => line.includes("Build · anthropic/Claude Opus 5"))).toHaveLength(1)
        expect(lines.slice(0, 5).filter((line) => line.includes("Build · anthropic/Claude Opus 5"))).toEqual([lines[1]!])
        expect(lines.filter((line) => line.includes(mode === "waiting" ? "waiting · 5 subagents" : "tool running ·"))).toHaveLength(1)
        expect(lines[1]).toContain(mode === "waiting" ? "waiting · 5 subagents" : "tool running ·")
        expect(Math.max(...destroyListenerCounts(screen.renderer.root))).toBeLessThanOrEqual(1)
        expect(warnings.map((warning) => `${warning.name}: ${warning.message}`)).toEqual([])
      } finally {
        process.off("warning", collect)
        await screen.dispose()
      }
    }, 60_000)
