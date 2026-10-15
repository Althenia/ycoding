import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

test.each([
  [80, 24],
  [100, 40],
])(
  "the first real draft survives delayed Session context and history at %d by %d",
  async (width, height) => {
    const context = Promise.withResolvers<void>()
    const history = Promise.withResolvers<void>()
    const writes: string[] = []
    const sessionID = `ses_context_readiness_${width}`
    const directory = "/tmp/ycoding/context-readiness"
    const location = { directory, project: { id: "proj_readiness", directory } }
    const model = { providerID: "fixture", id: "fixture" }
    const session = {
      id: sessionID,
      title: "Context readiness",
      projectID: location.project.id,
      location: { directory },
      agent: "build",
      model,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    }
    const screen = await renderScreen({
      width,
      height,
      args: { sessionID },
      settle: "Loading session",
      config: { session: { sidebar: "hide" } },
      route: async (url, request) => {
        if (request.method === "POST") writes.push(url.pathname)
        if (url.pathname === "/api/location") return json(location)
        if (url.pathname === "/api/session") {
          await context.promise
          return json({ data: [session], cursor: {} })
        }
        if (url.pathname === `/api/session/${sessionID}`) {
          await context.promise
          return json({ data: session })
        }
        if (url.pathname === `/api/session/${sessionID}/snapshot`) {
          await history.promise
          return sessionSnapshot(
            sessionID,
            [
              {
                id: "msg_history_ready",
                type: "assistant",
                agent: "build",
                model,
                content: [{ type: "text", text: "History delivered" }],
                time: { created: 2, completed: 3 },
              },
            ],
            { session },
          )
        }
        if (url.pathname === `/api/session/${sessionID}/subagent`)
          return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
        if (
          ["pending", "permission", "form", "todo", "skills", "guardrail/request"].some(
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
                limit: { context: 200_000, output: 32_000 },
              },
            ],
          })
        return undefined
      },
    })
    try {
      expect(screen.frame()).toContain("Loading session")
      expect(screen.frame()).not.toContain("Message YCoding")
      expect(screen.renderer.currentFocusedEditor).toBeNull()
      context.resolve()
      await until(
        screen,
        () =>
          screen.renderer.currentFocusedEditor instanceof TextareaRenderable &&
          screen.frame().includes("Message YCoding"),
      )
      const editor = screen.renderer.currentFocusedEditor
      if (!(editor instanceof TextareaRenderable)) throw new Error(screen.frame())
      expect(screen.frame()).toContain("Message YCoding")
      expect(screen.frame()).toContain("Loading session")
      await screen.input.typeText("first retained draft")
      screen.input.pressKey("RETURN")
      expect(editor.plainText).toBe("first retained draft")
      expect(writes).toEqual([])
      history.resolve()
      await until(
        screen,
        () => screen.frame().includes("History delivered") && !screen.frame().includes("Loading session"),
      )
      expect(screen.renderer.currentFocusedEditor).toBe(editor)
      expect(editor.plainText).toBe("first retained draft")
      expect(screen.frame()).toContain("first retained draft")
      expect(writes).toEqual([])
    } finally {
      context.resolve()
      history.resolve()
      await screen.dispose()
    }
  },
  30_000,
)

async function until(screen: Awaited<ReturnType<typeof renderScreen>>, ready: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!ready() && Date.now() < deadline) {
    await screen.renderOnce()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  expect(ready()).toBe(true)
}
