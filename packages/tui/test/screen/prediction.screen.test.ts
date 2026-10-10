import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_prediction_screen"
const directory = "/tmp/ycoding/prediction-screen"
const location = { directory, project: { id: "proj_prediction_screen", directory } }
const model = { providerID: "openai", id: "fixture" }
const session = { id: sessionID, title: "Prediction", projectID: location.project.id, location: { directory }, agent: "build", model,
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } }
let sends = 0
function route(url: URL, request: Request) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [{ type: "assistant", id: "msg_reply", agent: "build", model, content: [{ type: "text", text: "The build is fixed." }], time: { created: 1, completed: 2 }, finish: "stop" }], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/subagent`) return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (["pending", "permission", "todo", "skills"].some(resource => url.pathname === `/api/session/${sessionID}/${resource}`)) return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/prompt` && request.method === "POST") { sends++; return json({}) }
  if (url.pathname === "/api/agent") return json({ location, data: ["build", "review"].map(id => ({ id, name: id === "build" ? "Build" : "Review", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] })) })
  if (url.pathname === "/api/model") return json({ location, data: [{ ...model, modelID: model.id, name: "Fixture", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200000, output: 32000 } }] })
  return undefined
}
function composer(node: Renderable): TextareaRenderable | undefined {
  if (node instanceof TextareaRenderable) return node
  return node.getChildren().map(composer).find(Boolean)
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (predicate()) return; await new Promise<void>(resolve => setImmediate(resolve)) }
  throw new Error("Prediction transition did not occur")
}

test.each(["right", "ctrl+r"])("ghost prediction fills only with %s; typing/Escape/activity dismiss and Tab cycles agents", async (key) => {
  sends = 0
  const screen = await renderScreen({ width: 110, height: 36, args: { sessionID }, route, config: { animations: false, keybinds: { "prompt.prediction.accept": key } }, settle: "Message YCoding…" })
  const emit = (sourceMessageID: string, text = "Run the focused tests") => screen.events.emit({ id: "evt_prediction", created: 3, location: { directory }, type: "session.prediction.updated", data: { sessionID, sourceMessageID, text } })
  try {
    await screen.waitForEventStream()
    const row = screen.lines().findIndex(line => line.includes("Message YCoding…"))
    await screen.mouse.click(3, row)
    emit("msg_old")
    await screen.renderOnce()
    expect(screen.frame()).not.toContain("Run the focused tests")
    emit("msg_reply")
    await until(() => screen.frame().includes("Run the focused tests"))
    expect(composer(screen.renderer.root)?.plainText).toBe("")
    if (key === "right") screen.input.pressArrow("right")
    if (key === "ctrl+r") {
      screen.input.pressArrow("right")
      await screen.renderOnce()
      expect(composer(screen.renderer.root)?.plainText).toBe("")
      screen.input.pressKey("r", { ctrl: true })
    }
    await until(() => composer(screen.renderer.root)?.plainText === "Run the focused tests")
    expect(sends).toBe(0)
    composer(screen.renderer.root)!.setText("")
    emit("msg_reply", "Inspect the test results")
    await until(() => screen.frame().includes("Inspect the test results"))
    await screen.input.typeText("My draft")
    await until(() => composer(screen.renderer.root)?.plainText === "My draft")
    emit("msg_reply", "Do not overwrite me")
    await screen.renderOnce()
    expect(composer(screen.renderer.root)?.plainText).toBe("My draft")
    screen.input.pressArrow("right")
    await screen.renderOnce()
    expect(composer(screen.renderer.root)?.plainText).toBe("My draft")
    expect(screen.frame()).not.toContain("Do not overwrite me")
    composer(screen.renderer.root)!.setText("")
    await screen.renderOnce()
    expect(screen.frame()).not.toContain("Do not overwrite me")
    emit("msg_reply", "Review the changes")
    await until(() => screen.frame().includes("Review the changes"))
    screen.input.pressEscape()
    await until(() => !screen.frame().includes("Review the changes"))
    emit("msg_reply", "Try the new behavior")
    await until(() => screen.frame().includes("Try the new behavior"))
    screen.input.pressTab()
    await until(() => screen.frame().includes("Review"))
    expect(composer(screen.renderer.root)?.plainText).toBe("")
    expect(sends).toBe(0)
    screen.events.emit({ id: "evt_admission", created: 4, type: "session.input.admitted", location: { directory }, durable: { aggregateID: sessionID, seq: 1, version: 1 }, data: { sessionID, inputID: "msg_input", input: { type: "user", data: { text: "Next task" }, delivery: "steer" } } })
    await until(() => !screen.frame().includes("Try the new behavior"))
    emit("msg_reply", "Check the final result")
    await until(() => screen.frame().includes("Check the final result"))
    screen.events.disconnect()
    await until(() => !screen.frame().includes("Check the final result"))
    await screen.waitForEventStream()
    expect(screen.frame()).not.toContain("Check the final result")
  } finally { await screen.dispose() }
}, 30000)
