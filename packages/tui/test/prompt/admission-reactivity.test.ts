import { expect, test } from "bun:test"
import { createRenderEffect, createRoot } from "solid-js"
import { createPromptSubmissions, type PromptSubmissionPayload } from "../../src/prompt/submission"
import { emptyPrompt } from "../../src/prompt/history"
import { retainSessionSubmission } from "../../src/util/session-autonomy"

test("a durable admission immediately updates reactive submission readers", async () => {
  const started = Promise.withResolvers<void>()
  const request = Promise.withResolvers<never>()
  const history = Promise.withResolvers<void>()
  const payload: PromptSubmissionPayload = {
    inputText: "fixture",
    mode: "normal",
    agentID: "build",
    model: { providerID: "fixture", id: "model" },
    modelSelectionPending: false,
    files: [],
    agents: [],
    metadata: undefined,
    history: { ...emptyPrompt(), text: "fixture" },
    cursor: 7,
  }
  const submission = retainSessionSubmission(undefined, "fixture", 0, payload, "ses_fixture")
  const api = { session: { get: async () => ({ agent: "build", model: payload.model }), prompt: () => { started.resolve(); return request.promise } } }
  const seen: boolean[] = []
  let dispose = () => {}
  const manager = createRoot((cleanup) => {
    dispose = cleanup
    const value = createPromptSubmissions({ api: () => api as never, admitted: () => {} })
    createRenderEffect(() => seen.push(value.list().some((entry) => entry.admitted !== undefined)))
    return value
  })
  try {
    manager.dispatch(submission, { location: { directory: "/fixture" }, cleanup: async () => {}, onAdmitted: () => history.promise })
    await started.promise
    manager.observe({
      id: "evt_fixture", type: "session.input.admitted", created: 1,
      durable: { aggregateID: submission.sessionID, seq: 1, version: 1 },
      data: { sessionID: submission.sessionID, inputID: submission.promptID, input: { type: "user", data: { text: "fixture" }, delivery: "steer" } },
    })
    expect(seen.at(-1)).toBe(true)
  } finally {
    history.resolve()
    manager.dispose()
    dispose()
  }
})

test("an admission response updates reactive readers before history persistence settles", async () => {
  const persisting = Promise.withResolvers<void>()
  const history = Promise.withResolvers<void>()
  const payload: PromptSubmissionPayload = {
    inputText: "fixture", mode: "normal", agentID: "build",
    model: { providerID: "fixture", id: "model" }, modelSelectionPending: false,
    files: [], agents: [], metadata: undefined, history: { ...emptyPrompt(), text: "fixture" }, cursor: 7,
  }
  const submission = retainSessionSubmission(undefined, "fixture", 0, payload, "ses_fixture")
  const receipt = { id: submission.promptID, sessionID: submission.sessionID, admittedSeq: 1, timeCreated: 1, type: "user" as const, data: { text: "fixture" }, delivery: "steer" as const }
  const api = { session: { get: async () => ({ agent: "build", model: payload.model }), prompt: async () => receipt } }
  const seen: boolean[] = []
  let dispose = () => {}
  const manager = createRoot((cleanup) => {
    dispose = cleanup
    const value = createPromptSubmissions({ api: () => api as never, admitted: () => {} })
    createRenderEffect(() => seen.push(value.list().some((entry) => entry.admitted !== undefined)))
    return value
  })
  try {
    manager.dispatch(submission, {
      location: { directory: "/fixture" }, cleanup: async () => {},
      onAdmitted: () => { persisting.resolve(); return history.promise },
    })
    await persisting.promise
    expect(seen.at(-1)).toBe(true)
  } finally {
    history.resolve()
    manager.dispose()
    dispose()
  }
})
