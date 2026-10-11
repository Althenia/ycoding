import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import type { YCodingEvent } from "@ycoding-ai/client"
import type { useData } from "../../src/context/data"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_prediction_screen"
const otherID = "ses_other_prediction"
const directory = "/tmp/ycoding/prediction-screen"
const location = { directory, project: { id: "proj_prediction_screen", directory } }
const model = { providerID: "openai", id: "fixture" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const suggestion = "Run the focused tests"
const completePrompt = "Please review the changes we just made, run the focused regression tests, explain any remaining risks, and summarize the exact files changed without committing or submitting anything until I have reviewed the results."

async function fixture(width = 120, height = 36, accept = "right") {
  const posts: string[] = []
  const predictions: { path: string; body: unknown }[] = []
  const pendingPredictions: Array<() => void> = []
  let predictionResult: unknown = { data: { status: "suggested", text: "Suggested from the response" } }
  const releasePrediction = () => {
    for (const resolve of pendingPredictions.splice(0)) resolve()
  }
  const sessions = [sessionID, otherID].map(id => ({
    id, title: id === sessionID ? "Prediction" : "Other prediction", projectID: location.project.id,
    location: { directory }, agent: "build", model, cost: 0, tokens, time: { created: 1, updated: 2 },
  }))
  let data!: ReturnType<typeof useData>
  let sequence = 0
  let eventID = 0
  const projected = new Map<string, unknown>()
  const screen = await renderScreen({
    width, height, kittyKeyboard: true, args: { sessionID }, settle: "Message YCoding…",
    data: value => { data = value },
    config: { animations: false, session: { sidebar: "hide" }, keybinds: { "prompt.prediction.accept": accept } },
    route: async (url, request) => {
      if (url.pathname.endsWith("/wait")) return new Response(null, { status: 204 })
      if (request.method === "POST" && url.pathname.endsWith("/prediction")) {
        predictions.push({ path: url.pathname, body: await request.json() })
        await new Promise<void>((resolve) => pendingPredictions.push(resolve))
        return json(predictionResult)
      }
      if (request.method === "POST") { posts.push(url.pathname); return json({}) }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/command") return json({ location, data: [{ name: "predict-audit", description: "Prediction audit fixture", template: "Review the prediction" }] })
      if (url.pathname === "/api/skill") return json({ location, data: [{ id: "predict-audit", name: "Prediction audit fixture", description: "Review the prediction", location: directory }] })
      if (url.pathname === "/api/fs/find") return json({ location, data: url.searchParams.get("type") === "file" ? [{ path: "review.ts", type: "file" }] : [] })
      if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
      const session = sessions.find(value => url.pathname.startsWith(`/api/session/${value.id}`))
      if (session) {
        if (url.pathname.startsWith(`/api/session/${session.id}/message/`)) return json({ data: projected.get(url.pathname.split("/").at(-1)!) })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname.endsWith("/snapshot")) return sessionSnapshot(session.id, [{
          type: "assistant", id: session.id === sessionID ? "msg_reply" : "msg_other_reply", agent: "build", model,
          content: [{ type: "text", text: session.id === sessionID ? "The build is fixed." : "The other reply is ready." }],
          time: { created: 1, completed: 2 }, finish: "stop",
        }], { session })
        if (url.pathname.endsWith("/subagent")) return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
        if (["pending", "permission", "todo", "skills"].some(resource => url.pathname.endsWith(`/${resource}`))) return json({ data: [] })
      }
      if (url.pathname === "/api/agent") return json({ location, data: ["build", "review"].map(id => ({ id, name: id === "build" ? "Build" : "Review", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] })) })
      if (url.pathname === "/api/model") return json({ location, data: [{ ...model, modelID: model.id, name: "Fixture", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 200000, output: 32000 } }] })
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
    throw new Error(`Prediction transition did not occur:\n${screen.frame()}`)
  }
  const emit = async (event: YCodingEvent) => {
    if (event.type === "session.model.selected") {
      const id = event.id.replace(/^evt_/, "msg_")
      projected.set(id, { id, type: "model-switched", model: event.data.model, time: { created: event.created } })
    }
    const received = Promise.withResolvers<void>()
    const unsubscribe = data.on(event.type, details => { if (details.id === event.id) received.resolve() })
    try {
      screen.events.emit(event)
      await received.promise
      await screen.renderOnce()
    } finally { unsubscribe() }
  }
  const escape = async () => {
    const pressed = Promise.withResolvers<void>()
    const handler = (event: { name: string }) => { if (event.name === "escape") pressed.resolve() }
    screen.renderer.keyInput.prependListener("keypress", handler)
    try {
      screen.input.pressEscape()
      await pressed.promise
      await screen.renderOnce()
    } finally { screen.renderer.keyInput.off("keypress", handler) }
  }
  const predict = (sourceMessageID = "msg_reply", text = suggestion, target = sessionID) => emit({
    id: `evt_prediction_${++eventID}`, created: 3, location: { directory }, type: "session.prediction.updated",
    data: { sessionID: target, sourceMessageID, text },
  })
  const durable = () => ({ aggregateID: sessionID, seq: ++sequence, version: 1 as const })
  const startReply = async (assistantMessageID: string) => {
    await emit({ id: `evt_execution_${++eventID}`, created: 4, location: { directory }, type: "session.execution.started", durable: durable(), data: { sessionID } })
    await emit({ id: `evt_step_${++eventID}`, created: 5, location: { directory }, type: "session.step.started", durable: durable(), data: { sessionID, assistantMessageID, agent: "build", model } })
  }
  const finishReply = async (assistantMessageID: string) => {
    await emit({ id: `evt_text_${++eventID}`, created: 6, location: { directory }, type: "session.text.started", durable: durable(), data: { sessionID, assistantMessageID, ordinal: 0 } })
    await emit({ id: `evt_text_done_${++eventID}`, created: 7, location: { directory }, type: "session.text.ended", durable: durable(), data: { sessionID, assistantMessageID, ordinal: 0, text: "The new reply is ready." } })
    await emit({ id: `evt_step_done_${++eventID}`, created: 8, location: { directory }, type: "session.step.ended", durable: durable(), data: { sessionID, assistantMessageID, finish: "stop", cost: 0, tokens } })
    await emit({ id: `evt_execution_done_${++eventID}`, created: 9, location: { directory }, type: "session.execution.succeeded", durable: durable(), data: { sessionID } })
  }
  await screen.waitForEventStream()
  await screen.mouse.click(3, screen.lines().findIndex(line => line.includes("Message YCoding…")))
  screen.renderer.clearSelection()
  const editor = screen.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Prediction composer is not focused")
  return {
    screen, data, editor, posts, predictions, releasePrediction, wait, emit, escape, predict, durable, startReply, finishReply,
    setPredictionResult: (value: unknown) => { predictionResult = value },
  }
}

async function openSuggest(view: Awaited<ReturnType<typeof fixture>>, text: string) {
  await view.screen.input.typeText(text)
  view.screen.input.pressEnter()
  const opened = () => view.screen.frame().includes("[ ] Project memory (this repository)")
  await view.wait(() => opened() || view.editor.plainText === "/suggest ")
  if (opened()) return
  view.screen.input.pressEnter()
  await view.wait(opened)
}

test.each([[80, 24], [120, 36]])("Tab accepts the complete visible next prompt without sending at %ix%i", async (width, height) => {
  const view = await fixture(width, height)
  try {
    await view.predict("msg_old")
    expect(view.screen.frame()).not.toContain(suggestion)
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    expect(view.editor.plainText).toBe("")
    view.screen.input.pressTab()
    await view.wait(() => view.editor.plainText === suggestion)
    expect(view.screen.frame()).toContain("Build")
    expect(view.screen.renderer.currentFocusedEditor).toBe(view.editor)
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test.each(["right", "ctrl+r"])("Right/configured %s acceptance fills only; absent suggestion retains Tab agent cycling", async key => {
  const view = await fixture(120, 36, key)
  try {
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    expect(view.screen.frame()).toContain(key === "right" ? "→ use suggestion" : "⌃r use suggestion")
    if (key === "ctrl+r") {
      view.screen.input.pressArrow("right")
      await view.screen.renderOnce()
      expect(view.editor.plainText).toBe("")
      view.screen.input.pressKey("r", { ctrl: true })
    }
    if (key === "right") view.screen.input.pressArrow("right")
    await view.wait(() => view.editor.plainText === suggestion)
    view.editor.setText("")
    await view.screen.renderOnce()
    view.screen.input.pressTab()
    await view.wait(() => view.screen.frame().includes("Review"))
    expect(view.editor.plainText).toBe("")
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test.each(["typing", "Escape"])("%s before delayed prediction latches the source; only a genuine new reply is eligible", async action => {
  const view = await fixture(action === "typing" ? 80 : 120, action === "typing" ? 24 : 36)
  try {
    if (action === "typing") {
      await view.screen.input.typeText("My draft")
      await view.wait(() => view.editor.plainText === "My draft")
      view.screen.input.pressArrow("right")
      await view.screen.renderOnce()
      expect(view.editor.plainText).toBe("My draft")
      for (let index = 0; index < "My draft".length; index++) view.screen.input.pressBackspace()
      await view.wait(() => view.editor.plainText === "")
    }
    if (action === "Escape") await view.escape()
    await view.predict()
    expect(view.screen.frame()).not.toContain(suggestion)
    expect(view.editor.plainText).toBe("")
    await view.startReply("msg_new_reply")
    await view.predict("msg_new_reply", "Wait for the reply")
    expect(view.screen.frame()).not.toContain("Wait for the reply")
    await view.finishReply("msg_new_reply")
    await view.predict("msg_reply", "Stale old source")
    expect(view.screen.frame()).not.toContain("Stale old source")
    await view.predict("msg_new_reply", "Inspect the new result")
    await view.wait(() => view.screen.frame().includes("Inspect the new result"))
    await view.escape()
    await view.predict("msg_new_reply", "Dismissed source retry")
    expect(view.screen.frame()).not.toContain("Dismissed source retry")
    expect(view.screen.renderer.currentFocusedEditor).toBe(view.editor)
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test.each([[80, 24], [120, 36]])("full next-prompt ghost renders, wraps, and preserves the draft through disconnect at %ix%i", async (width, height) => {
  const view = await fixture(width, height)
  try {
    await view.predict("msg_reply", completePrompt)
    await view.wait(() => view.screen.frame().replace(/\s+/g, " ").includes(completePrompt))
    console.log(`Prediction ${width}x${height} actual frame:\n${view.screen.frame()}`)
    view.screen.input.pressTab()
    await view.wait(() => view.editor.plainText === completePrompt)
    view.screen.events.disconnect()
    await view.wait(() => view.screen.frame().includes("Reconnecting"))
    expect(view.editor.plainText).toBe(completePrompt)
    expect(view.screen.renderer.currentFocusedEditor).toBe(view.editor)
    await view.screen.waitForEventStream()
    expect(view.editor.plainText).toBe(completePrompt)
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("prediction validation accepts 400 characters and rejects over-limit and control text", async () => {
  const view = await fixture()
  try {
    const maximum = `Review ${"x".repeat(393)}`
    await view.predict("msg_reply", maximum)
    expect(view.data.session.prediction.get(sessionID)?.text).toBe(maximum)
    expect(view.screen.frame().replace(/\s/g, "")).toContain(maximum.replace(/\s/g, ""))
    for (const text of [`${maximum}x`, "Review\nchanges", "Review\u001bchanges", "Review\u202echanges"]) {
      await view.predict("msg_reply", text)
      expect(view.data.session.prediction.get(sessionID)?.text).toBe(maximum)
    }
    expect(view.editor.plainText).toBe("")
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("new input activity hides predictions and pending input blocks late same-source ghosts", async () => {
  const view = await fixture()
  try {
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    await view.emit({ id: "evt_admission", created: 4, type: "session.input.admitted", location: { directory }, durable: view.durable(), data: { sessionID, inputID: "msg_input", input: { type: "user", data: { text: "Next task" }, delivery: "steer" } } })
    expect(view.screen.frame()).not.toContain(suggestion)
    await view.predict("msg_reply", "Late pending suggestion")
    expect(view.screen.frame()).not.toContain("Late pending suggestion")
    expect(view.editor.plainText).toBe("")
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("shell Escape and mention autocomplete retain ownership over prediction acceptance", async () => {
  const view = await fixture()
  try {
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    view.screen.input.pressKey("!")
    await view.screen.renderOnce()
    expect(view.screen.frame()).not.toContain(suggestion)
    expect(view.editor.plainText).toBe("")
    await view.escape()
    await view.wait(() => view.screen.frame().includes(suggestion))
    await view.screen.input.typeText("@rev")
    await view.wait(() => view.screen.frame().includes("review"))
    view.screen.input.pressTab()
    await view.wait(() => view.editor.plainText === "@review.ts ")
    expect(view.screen.frame()).not.toContain(suggestion)
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("session switch and reconnect hide stale ghosts without replacing the composer draft", async () => {
  const view = await fixture()
  try {
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    await view.emit({ id: "evt_select_other", created: 4, type: "tui.session.select", location: { directory }, data: { sessionID: otherID } })
    await view.wait(() => view.screen.frame().includes("The other reply is ready."))
    expect(view.screen.frame()).not.toContain(suggestion)
    await view.predict("msg_reply", "Late previous session")
    expect(view.screen.frame()).not.toContain("Late previous session")
    await view.predict("msg_other_reply", "Review the other result", otherID)
    await view.wait(() => view.screen.frame().includes("Review the other result"))
    const editor = view.screen.renderer.currentFocusedEditor
    view.screen.events.disconnect()
    await view.wait(() => view.screen.frame().includes("Reconnecting"))
    expect(view.screen.frame()).not.toContain("Review the other result")
    expect(view.screen.renderer.currentFocusedEditor).toBe(editor)
    await view.screen.waitForEventStream()
    expect(view.screen.frame()).not.toContain("Review the other result")
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("source dismissal survives A to B typing and a remount back to A", async () => {
  const view = await fixture()
  try {
    await view.screen.input.typeText("A")
    view.screen.input.pressBackspace()
    await view.wait(() => view.editor.plainText === "")
    await view.emit({ id: "evt_select_B", created: 4, type: "tui.session.select", location: { directory }, data: { sessionID: otherID } })
    await view.wait(() => view.screen.frame().includes("The other reply is ready."))
    const otherEditor = view.screen.renderer.currentFocusedEditor
    expect(otherEditor).toBeInstanceOf(TextareaRenderable)
    await view.screen.input.typeText("B")
    view.screen.input.pressBackspace()
    await view.wait(() => otherEditor instanceof TextareaRenderable && otherEditor.plainText === "")
    await view.emit({ id: "evt_select_A", created: 5, type: "tui.session.select", location: { directory }, data: { sessionID } })
    await view.wait(() => view.screen.frame().includes("The build is fixed."))
    await view.predict()
    expect(view.screen.frame()).not.toContain(suggestion)
    expect(view.screen.renderer.currentFocusedEditor?.plainText).toBe("")
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test.each(["tab", "right"])("%s acceptance clears prediction, places cursor at end, and restores placeholder after erase", async key => {
  const view = await fixture(80, 24)
  try {
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    expect(view.editor.plainText).toBe("")
    expect(view.screen.frame()).not.toContain("Message YCoding…")
    if (key === "tab") view.screen.input.pressTab()
    if (key === "right") view.screen.input.pressArrow("right")
    await view.wait(() => view.editor.plainText === suggestion)
    expect(view.editor.cursorOffset).toBe(suggestion.length)
    expect(view.editor.height).toBe(1)
    expect(view.screen.renderer.currentFocusedEditor).toBe(view.editor)
    expect(view.data.session.prediction.get(sessionID)).toBeUndefined()
    expect(view.screen.frame()).not.toContain("use suggestion")
    await view.screen.input.typeText("!")
    await view.wait(() => view.editor.plainText === `${suggestion}!`)
    for (let index = 0; index <= suggestion.length; index++) view.screen.input.pressBackspace()
    await view.wait(() => view.editor.plainText === "" && view.screen.frame().includes("Message YCoding…"))
    await view.predict("msg_reply", "Late accepted source")
    expect(view.screen.frame()).not.toContain("Late accepted source")
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("typing over a visible ghost and erasing never resurrects that source", async () => {
  const view = await fixture()
  try {
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    await view.screen.input.typeText("My draft")
    await view.wait(() => view.editor.plainText === "My draft")
    expect(view.screen.frame()).not.toContain(suggestion)
    await view.predict("msg_reply", "Late nonempty prediction")
    expect(view.editor.plainText).toBe("My draft")
    for (let index = 0; index < "My draft".length; index++) view.screen.input.pressBackspace()
    await view.wait(() => view.editor.plainText === "" && view.screen.frame().includes("Message YCoding…"))
    expect(view.screen.frame()).not.toContain("Late nonempty prediction")
    expect(view.data.session.prediction.get(sessionID)).toBeUndefined()
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test.each([[40, 24], [60, 24], [80, 24], [120, 36]])("wrapped ghost preserves transcript and editor after Right acceptance at %ix%i", async (width, height) => {
  const view = await fixture(width, height)
  try {
    await view.predict("msg_reply", completePrompt)
    await view.wait(() => view.screen.frame().replace(/\s+/g, " ").includes(completePrompt))
    expect(view.editor.plainText).toBe("")
    expect(view.screen.frame()).toContain("The build is fixed.")
    const ghostLines = view.screen.lines().filter(line => /Please review|focused regression|have reviewed/.test(line))
    expect(ghostLines.length).toBeGreaterThan(1)
    view.screen.input.pressArrow("right")
    await view.wait(() => view.editor.plainText === completePrompt)
    expect(view.editor.cursorOffset).toBe(completePrompt.length)
    expect(view.editor.height).toBeLessThanOrEqual(6)
    expect(view.screen.frame()).toContain("The build is fixed.")
    expect(view.screen.frame()).not.toContain("use suggestion")
    expect(view.screen.renderer.currentFocusedEditor).toBe(view.editor)
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test.each([
  ["/predict-a", "/predict-audit "],
  ["@rev", "@review.ts "],
  ["$predict-a", "$predict-audit "],
])("Tab completes %s autocomplete rather than accepting a prediction or cycling agent", async (draft, expected) => {
  const view = await fixture()
  try {
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    await view.screen.input.typeText(draft)
    await view.wait(() => view.screen.frame().includes(draft[0] === "@" ? "review.ts" : "predict-audit"))
    view.screen.input.pressTab()
    await view.wait(() => view.editor.plainText === expected)
    expect(view.screen.frame()).not.toContain(suggestion)
    expect(view.screen.frame()).toContain("Build")
    expect(view.screen.renderer.currentFocusedEditor).toBe(view.editor)
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("late prediction for an older assistant cannot erase a newer visible suggestion", async () => {
  const view = await fixture()
  try {
    await view.predict()
    await view.startReply("msg_new_reply")
    await view.finishReply("msg_new_reply")
    await view.predict("msg_new_reply", "Inspect the new result")
    await view.wait(() => view.screen.frame().includes("Inspect the new result"))
    await view.predict("msg_reply", "Inspect the old result")
    expect(view.screen.frame()).toContain("Inspect the new result")
    expect(view.screen.frame()).not.toContain("Inspect the old result")
    view.screen.input.pressTab()
    await view.wait(() => view.editor.plainText === "Inspect the new result")
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test.each(["", "   ", "Review", Array.from({ length: 41 }, () => "word").join(" "), "Review\u200e changes", "Review\u200f changes", "Review\u061c changes", "Review\u2028changes", "Review\u2029changes"])("invalid prediction %j cannot replace a valid ghost", async text => {
  const view = await fixture()
  try {
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    await view.predict("msg_reply", text)
    expect(view.screen.frame()).toContain(suggestion)
    expect(view.data.session.prediction.get(sessionID)?.text).toBe(suggestion)
    expect(view.editor.plainText).toBe("")
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("two- and forty-word predictions remain eligible", async () => {
  const view = await fixture(80, 24)
  try {
    for (const text of ["Review changes", Array.from({ length: 40 }, (_, index) => `w${index + 1}`).join(" ")]) {
      await view.predict("msg_reply", text)
      await view.wait(() => view.screen.frame().replace(/\s+/g, " ").includes(text))
      expect(view.data.session.prediction.get(sessionID)?.text).toBe(text)
      expect(view.editor.plainText).toBe("")
    }
    view.screen.input.pressTab()
    await view.wait(() => view.editor.plainText.startsWith("w1 w2 "))
    expect(view.editor.plainText.split(" ")).toHaveLength(40)
    expect(view.editor.cursorOffset).toBe(view.editor.plainText.length)
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("Escape dismissal after showing a ghost survives navigation and composer remount", async () => {
  const view = await fixture()
  try {
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    await view.escape()
    expect(view.screen.frame()).not.toContain(suggestion)
    await view.emit({ id: "evt_dismissed_select_B", created: 4, type: "tui.session.select", location: { directory }, data: { sessionID: otherID } })
    await view.wait(() => view.screen.frame().includes("The other reply is ready."))
    await view.predict("msg_other_reply", "Review the other result", otherID)
    await view.wait(() => view.screen.frame().includes("Review the other result"))
    await view.emit({ id: "evt_dismissed_select_A", created: 5, type: "tui.session.select", location: { directory }, data: { sessionID } })
    await view.wait(() => view.screen.frame().includes("The build is fixed."))
    await view.predict("msg_reply", "Late dismissed session")
    expect(view.screen.frame()).not.toContain("Late dismissed session")
    expect(view.screen.renderer.currentFocusedEditor?.plainText).toBe("")
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test.each(["agent", "model", "profile"])("%s selection dismisses the source before a late prediction arrives", async selection => {
  const view = await fixture()
  try {
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    if (selection === "agent") await view.emit({
      id: "evt_prediction_agent_selection", created: 4, location: { directory }, durable: view.durable(),
      type: "session.agent.selected", data: { sessionID, agent: "review" },
    })
    if (selection !== "agent") await view.emit({
      id: "evt_prediction_model_selection", created: 4, location: { directory }, durable: view.durable(),
      type: "session.model.selected", data: { sessionID, model: { ...model, ...(selection === "profile" ? { profile: "fixture-profile" } : { variant: "high" }) } },
    })
    expect(view.screen.frame()).not.toContain(suggestion)
    await view.predict("msg_reply", "Late selected source")
    expect(view.screen.frame()).not.toContain("Late selected source")
    expect(view.data.session.prediction.get(sessionID)).toBeUndefined()
    expect(view.editor.plainText).toBe("")
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)

test("/suggest with a hint toggles project memory and requests that scope", async () => {
  const view = await fixture()
  try {
    await openSuggest(view, "/suggest focus on tests")
    expect(view.editor.plainText).toBe("")
    expect(view.screen.frame()).toContain("[ ] Project memory (this repository)")
    expect(view.screen.frame()).toContain("[ ] Global memory (shared knowledge)")
    expect(view.screen.frame()).not.toContain("[x]")
    view.screen.input.pressKey(" ")
    await view.wait(() => view.screen.frame().includes("[x] Project memory (this repository)"))
    expect(view.screen.frame()).toContain("[ ] Global memory (shared knowledge)")
    view.screen.input.pressEnter()
    await view.wait(() => view.predictions.length === 1)
    expect(view.predictions).toEqual([{ path: `/api/session/${sessionID}/prediction`, body: { memory: ["repository"], hint: "focus on tests" } }])
    expect(view.screen.frame()).toContain("Generating suggestion…")
    expect(view.screen.frame()).not.toContain("Suggested from the response")
    view.releasePrediction()
    await view.wait(() => !view.screen.frame().includes("Suggest next message"))
    expect(view.screen.frame()).not.toContain("Suggested from the response")
  } finally {
    view.releasePrediction()
    await view.screen.dispose()
  }
}, 30000)

test("bare /suggest confirms with no memory scopes and no hint", async () => {
  const view = await fixture()
  try {
    await openSuggest(view, "/suggest")
    expect(view.screen.frame()).toContain("[ ] Project memory (this repository)")
    expect(view.screen.frame()).toContain("[ ] Global memory (shared knowledge)")
    view.screen.input.pressEnter()
    await view.wait(() => view.predictions.length === 1)
    expect(view.predictions).toEqual([{ path: `/api/session/${sessionID}/prediction`, body: { memory: [] } }])
    view.releasePrediction()
  } finally {
    view.releasePrediction()
    await view.screen.dispose()
  }
}, 30000)

test("a requested prediction shows the ghost for a source that was already dismissed", async () => {
  const view = await fixture()
  try {
    await view.predict()
    await view.wait(() => view.screen.frame().includes(suggestion))
    await view.escape()
    expect(view.screen.frame()).not.toContain(suggestion)
    await openSuggest(view, "/suggest")
    view.screen.input.pressEnter()
    await view.wait(() => view.predictions.length === 1)
    await view.predict("msg_reply", "Inspect the published suggestion")
    expect(view.screen.frame()).not.toContain("Suggested from the response")
    view.releasePrediction()
    await view.wait(() => view.screen.frame().includes("Inspect the published suggestion"))
    expect(view.screen.frame()).not.toContain("Suggested from the response")
    expect(view.editor.plainText).toBe("")
  } finally {
    view.releasePrediction()
    await view.screen.dispose()
  }
}, 30000)

test("an unavailable suggestion tells the user none is available", async () => {
  const view = await fixture()
  try {
    view.setPredictionResult({ data: { status: "unavailable" } })
    await openSuggest(view, "/suggest")
    view.screen.input.pressEnter()
    await view.wait(() => view.predictions.length === 1)
    expect(view.screen.frame()).toContain("Generating suggestion…")
    view.releasePrediction()
    await view.wait(() => view.screen.frame().includes("No suggestion available for the latest reply"))
  } finally {
    view.releasePrediction()
    await view.screen.dispose()
  }
}, 30000)

test("escape cancels suggest without requesting a prediction", async () => {
  const view = await fixture()
  try {
    await openSuggest(view, "/suggest focus on tests")
    await view.escape()
    await view.wait(() => !view.screen.frame().includes("Suggest next message"))
    expect(view.predictions).toEqual([])
    expect(view.posts).toEqual([])
  } finally { await view.screen.dispose() }
}, 30000)
