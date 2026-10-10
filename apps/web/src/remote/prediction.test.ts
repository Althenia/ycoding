import { expect, test } from "bun:test"
import { applySessionEvent, createSessionView } from "./projection"
import { nextMessagePrediction, acceptNextMessagePrediction } from "./view-model"

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
