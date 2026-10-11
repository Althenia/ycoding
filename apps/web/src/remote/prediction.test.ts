import { expect, test } from "bun:test"
import { applySessionEvent, createSessionView } from "./projection"
import { nextMessagePrediction, acceptNextMessagePrediction } from "./view-model"
import { createRemoteHttp } from "./http"
import { createRemoteStore } from "./store"
import type { RemoteTransportHandlers } from "./transport"

const event = { type: "session.prediction.updated", data: { sessionID: "ses_prediction", sourceMessageID: "msg_reply", text: "Run the focused tests" } }
const base = { ...createSessionView("ses_prediction"), messages: [{ kind: "assistant" as const, id: "msg_reply", parts: [], created: 1, completed: 1 }] }

test("prediction stays outside messages and only displays for the latest reply and an empty draft", () => {
  const view = applySessionEvent(base, event, 2)
  expect(view.messages).toEqual(base.messages)
  expect(nextMessagePrediction(view, "")).toEqual(event.data)
  expect(nextMessagePrediction(view, "My draft")).toBeUndefined()
  expect(nextMessagePrediction(view, "", "msg_reply")).toBeUndefined()
  expect(nextMessagePrediction({ ...view, messages: [...view.messages, { kind: "assistant", id: "msg_new", parts: [], created: 3 }] }, "")).toBeUndefined()
  expect(nextMessagePrediction({ ...view, status: "running" }, "")).toBeUndefined()
  expect(nextMessagePrediction({ ...view, autonomy: { mode: "goal", yolo: 0, goal: { text: "Finish", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } } }, "")).toBeUndefined()
})

test("keyboard and touch acceptance fill only and never overwrite a draft", () => {
  const view = applySessionEvent(base, event, 2)
  expect(acceptNextMessagePrediction(view, "")).toBe("Run the focused tests")
  expect(acceptNextMessagePrediction(view, "Keep this draft")).toBe("Keep this draft")
  expect(acceptNextMessagePrediction(view, "", "msg_reply")).toBe("")
})

test("new admission and execution activity discard ephemeral prediction", () => {
  const view = applySessionEvent(base, event, 2)
  for (const type of ["session.input.admitted", "session.execution.started", "session.step.started", "session.moved", "session.archived", "session.model.selected"])
    expect(applySessionEvent(view, { type, data: { sessionID: view.id, inputID: "msg_new", assistantMessageID: "msg_new" } }, 3).prediction).toBeUndefined()
  expect(applySessionEvent(base, { ...event, data: { ...event.data, sessionID: "ses_other" } }, 2).prediction).toBeUndefined()
})

test("prediction accepts 400 characters and rejects longer or unsafe output without replacing it", () => {
  const text = `${Array.from({ length: 40 }, () => "abcdefghi").join(" ")}j`
  const view = applySessionEvent(base, { ...event, data: { ...event.data, text } }, 2)
  expect(view.prediction?.text).toBe(text)
  expect(nextMessagePrediction(view, "")?.text).toBe(text)
  for (const rejected of [text + "x", "Line\nbreak", "Tab\there", "Null\u0000byte", "Hidden\u202edirection", "Hidden\u2066isolate", "Control\u0085text"])
    expect(applySessionEvent(view, { ...event, data: { ...event.data, text: rejected } }, 3).prediction).toEqual(view.prediction)
})

test("a replacement connection drops the old prediction and ignores late old-transport prediction events", async () => {
  const handlers = new Map<string, RemoteTransportHandlers>()
  const store = createRemoteStore({
    http: createRemoteHttp(), batchMs: 0,
    createTransport: (deviceID, callbacks) => {
      handlers.set(deviceID, callbacks)
      return {
        connect: () => callbacks.onStatus?.({ kind: "open" }), close: () => {}, setPriority: () => {}, status: () => ({ kind: "open" }),
        request: async (operation) => operation === "session.snapshot"
          ? { status: "ok", value: { sourceEpoch: "epoch_prediction", session: { id: base.id, title: "Prediction", time: { created: 1, updated: 1 } }, messages: [], watermark: { type: "log.synced", aggregateID: base.id, seq: 0 } } }
          : { status: "ok", value: { data: operation === "session.autonomy.get" ? { mode: "normal", yolo: 0 } : [] } },
      }
    },
  })
  try {
    store.connect("dev_old")
    await store.selectSession(base.id)
    store.container.setState(state => ({ ...state, view: applySessionEvent(base, event, 2) }))
    expect(store.state().view?.prediction?.text).toBe(event.data.text)
    const generation = store.state().generation
    store.connect("dev_new")
    expect(store.state().view).toBeUndefined()
    expect(store.state().generation).toBeGreaterThan(generation)
    await store.selectSession(base.id)
    handlers.get("dev_old")!.onEvents!(base.id, [event])
    expect(store.state().view?.prediction).toBeUndefined()
    const received = Promise.withResolvers<void>()
    const unsubscribe = store.subscribe(() => { if (store.state().view?.prediction?.text === "Review the fresh connection") received.resolve() })
    handlers.get("dev_new")!.onEvents!(base.id, [{ ...event, data: { ...event.data, text: "Review the fresh connection" } }])
    await received.promise
    unsubscribe()
    expect(store.state().view?.prediction?.text).toBe("Review the fresh connection")
  } finally { store.dispose() }
})
