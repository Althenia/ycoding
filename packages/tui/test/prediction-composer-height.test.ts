import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import type { SessionInfo, YCodingEvent } from "@ycoding-ai/client"
import type { useData } from "../src/context/data"
import { json, sessionSnapshot } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

const sessionID = "ses_prediction_composer_height"
const directory = "/tmp/ycoding/prediction-composer-height"
const location = { directory, project: { id: "proj_prediction_composer_height", directory } }
const model = { providerID: "openai", id: "fixture" }
const reply = "The build is fixed."
const suggestion = "Run the focused tests"
const session = {
  id: sessionID,
  title: "Prediction composer height",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
} satisfies SessionInfo

test.each([[80, 24], [120, 36]])(
  "Tab acceptance keeps a one-line composer and visible transcript at %ix%i",
  async (width, height) => {
    const posts: string[] = []
    let data!: ReturnType<typeof useData>
    const screen = await renderScreen({
      width,
      height,
      kittyKeyboard: true,
      args: { sessionID },
      settle: "Message YCoding…",
      data: value => { data = value },
      config: { animations: false, session: { sidebar: "hide" } },
      route: (url, request) => {
        if (url.pathname.endsWith("/wait")) return new Response(null, { status: 204 })
        if (request.method === "POST") {
          posts.push(url.pathname)
          return json({})
        }
        if (url.pathname === "/api/location") return json(location)
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
        if (url.pathname === `/api/session/${sessionID}/snapshot`)
          return sessionSnapshot(sessionID, [{
            type: "assistant",
            id: "msg_prediction_height_reply",
            agent: "build",
            model,
            content: [{ type: "text", text: reply }],
            time: { created: 1, completed: 2 },
            finish: "stop",
          }], { session })
        if (url.pathname === `/api/session/${sessionID}/subagent`)
          return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
        if (["pending", "permission", "todo", "skills"].some(resource => url.pathname === `/api/session/${sessionID}/${resource}`))
          return json({ data: [] })
        if (url.pathname === "/api/agent")
          return json({ location, data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }] })
        if (url.pathname === "/api/model")
          return json({ location, data: [{
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
          }] })
        return undefined
      },
    })
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        await screen.renderOnce()
        if (predicate()) return
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      throw new Error(`Composer transition did not occur:\n${screen.frame()}`)
    }
    try {
      await screen.waitForEventStream()
      await screen.mouse.click(3, screen.lines().findIndex(line => line.includes("Message YCoding…")))
      screen.renderer.clearSelection()
      const editor = screen.renderer.currentFocusedEditor
      if (!(editor instanceof TextareaRenderable)) throw new Error("Composer is not focused")
      expect(editor.height).toBe(1)
      expect(screen.frame()).toContain(reply)
      const event = {
        id: "evt_prediction_composer_height",
        created: 3,
        location: { directory },
        type: "session.prediction.updated",
        data: { sessionID, sourceMessageID: "msg_prediction_height_reply", text: suggestion },
      } satisfies YCodingEvent
      const received = Promise.withResolvers<void>()
      const unsubscribe = data.on(event.type, details => {
        if (details.id === event.id) received.resolve()
      })
      try {
        screen.events.emit(event)
        await received.promise
      } finally {
        unsubscribe()
      }
      await wait(() => screen.frame().includes(suggestion))
      expect(editor.plainText).toBe("")
      expect(screen.frame()).toContain(reply)
      screen.input.pressTab()
      await wait(() => editor.plainText === suggestion)
      expect(screen.renderer.currentFocusedEditor).toBe(editor)
      expect(editor.plainText.split("\n")).toHaveLength(1)
      expect(posts).toEqual([])
      expect(editor.height, screen.frame()).toBe(1)
      expect(screen.frame()).toContain(reply)
      expect(screen.frame()).toContain(suggestion)
    } finally {
      await screen.dispose()
    }
  },
  30000,
)
