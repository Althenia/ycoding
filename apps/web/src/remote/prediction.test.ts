import { expect, test } from "bun:test"
import { applySessionEvent, createSessionView } from "./projection"
import { nextMessagePrediction, acceptNextMessagePrediction } from "./view-model"
import { createRemoteHttp } from "./http"
import { createRemoteStore } from "./store"
import type { RemoteTransportHandlers } from "./transport"

const event = {
  type: "session.prediction.updated",
  data: { sessionID: "ses_prediction", sourceMessageID: "msg_reply", text: "Run the focused tests" },
}
const base = {
  ...createSessionView("ses_prediction"),
  messages: [{ kind: "assistant" as const, id: "msg_reply", parts: [], created: 1, completed: 1 }],
}

test("prediction stays outside messages and only displays for the latest reply and an empty draft", () => {
  const view = applySessionEvent(base, event, 2)
  expect(view.messages).toEqual(base.messages)
  expect(nextMessagePrediction(view, "")).toEqual(event.data)
  expect(nextMessagePrediction(view, "My draft")).toBeUndefined()
  expect(nextMessagePrediction(view, "", "msg_reply")).toBeUndefined()
  expect(
    nextMessagePrediction(
      { ...view, messages: [...view.messages, { kind: "assistant", id: "msg_new", parts: [], created: 3 }] },
      "",
    ),
  ).toBeUndefined()
  expect(nextMessagePrediction({ ...view, status: "running" }, "")).toBeUndefined()
  expect(
    nextMessagePrediction(
      {
        ...view,
        autonomy: {
          mode: "goal",
          yolo: 0,
          goal: { text: "Finish", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 },
        },
      },
      "",
    ),
  ).toBeUndefined()
})

test("keyboard and touch acceptance fill only and never overwrite a draft", () => {
  const view = applySessionEvent(base, event, 2)
  expect(acceptNextMessagePrediction(view, "")).toBe("Run the focused tests")
  expect(acceptNextMessagePrediction(view, "Keep this draft")).toBe("Keep this draft")
  expect(acceptNextMessagePrediction(view, "", "msg_reply")).toBe("")
})

test("new admission and execution activity discard ephemeral prediction", () => {
  const view = applySessionEvent(base, event, 2)
  for (const type of [
    "session.input.admitted",
    "session.execution.started",
    "session.step.started",
    "session.moved",
    "session.archived",
    "session.model.selected",
  ])
    expect(
      applySessionEvent(
        view,
        { type, data: { sessionID: view.id, inputID: "msg_new", assistantMessageID: "msg_new" } },
        3,
      ).prediction,
    ).toBeUndefined()
  expect(
    applySessionEvent(base, { ...event, data: { ...event.data, sessionID: "ses_other" } }, 2).prediction,
  ).toBeUndefined()
})

test("prediction accepts 400 characters and rejects longer or unsafe output without replacing it", () => {
  const text = `${Array.from({ length: 40 }, () => "abcdefghi").join(" ")}j`
  const view = applySessionEvent(base, { ...event, data: { ...event.data, text } }, 2)
  expect(view.prediction?.text).toBe(text)
  expect(nextMessagePrediction(view, "")?.text).toBe(text)
  for (const rejected of [
    text + "x",
    "Line\nbreak",
    "Tab\there",
    "Null\u0000byte",
    "Hidden\u202edirection",
    "Hidden\u2066isolate",
    "Control\u0085text",
  ])
    expect(applySessionEvent(view, { ...event, data: { ...event.data, text: rejected } }, 3).prediction).toEqual(
      view.prediction,
    )
})

test("a replacement connection drops the old prediction and ignores late old-transport prediction events", async () => {
  const handlers = new Map<string, RemoteTransportHandlers>()
  const store = createRemoteStore({
    http: createRemoteHttp(),
    batchMs: 0,
    createTransport: (deviceID, callbacks) => {
      handlers.set(deviceID, callbacks)
      return {
        connect: () => callbacks.onStatus?.({ kind: "open" }),
        close: () => {},
        setPriority: () => {},
        status: () => ({ kind: "open" }),
        request: async (operation) =>
          operation === "session.snapshot"
            ? {
                status: "ok",
                value: {
                  data: {
                    sourceEpoch: "epoch_prediction",
                    session: { id: base.id, title: "Prediction", time: { created: 1, updated: 1 } },
                    messages: [],
                    watermark: { type: "log.synced", aggregateID: base.id, seq: 0 },
                  },
                },
              }
            : operation === "event.subscribe"
              ? { status: "ok", value: { subscription_id: `sub-${deviceID}` } }
              : {
                  status: "ok",
                  value: { data: operation === "session.autonomy.get" ? { mode: "normal", yolo: 0 } : [] },
                },
      }
    },
  })
  try {
    store.connect("dev_old")
    await store.selectSession(base.id)
    store.container.setState((state) => ({ ...state, view: applySessionEvent(base, event, 2) }))
    expect(store.state().view?.prediction?.text).toBe(event.data.text)
    const generation = store.state().generation
    store.connect("dev_new")
    expect(store.state().view).toBeUndefined()
    expect(store.state().generation).toBeGreaterThan(generation)
    await store.selectSession(base.id)
    handlers.get("dev_old")!.onEvents!(base.id, [event])
    expect(store.state().view?.prediction).toBeUndefined()
    const received = Promise.withResolvers<void>()
    const unsubscribe = store.subscribe(() => {
      if (store.state().view?.prediction?.text === "Review the fresh connection") received.resolve()
    })
    handlers.get("dev_new")!.onEvents!(base.id, [
      { ...event, data: { ...event.data, text: "Review the fresh connection" } },
    ])
    await received.promise
    unsubscribe()
    expect(store.state().view?.prediction?.text).toBe("Review the fresh connection")
  } finally {
    store.dispose()
  }
})

test("session.prediction sends memory and hint, clears only that Session's dismissed source, and ignores response text", async () => {
  const requests: { operation: string; sessionID?: string; input?: Readonly<Record<string, unknown>> }[] = []
  const store = predictionStore(requests, async (operation) =>
    operation === "session.prediction"
      ? { status: "ok", value: { status: "suggested", text: "Do not render this response" } }
      : undefined,
  )
  try {
    expect(await store.requestPrediction({ memory: ["repository"] })).toBe(false)
    expect(requests.some((request) => request.operation === "session.prediction")).toBe(false)
    store.connect("dev_1")
    await store.selectSession("ses_prediction")
    store.container.setState((state) => ({
      ...state,
      view: applySessionEvent(base, event, 2),
      drafts: { ses_prediction: "" },
    }))
    store.dismissPrediction("ses_prediction", "scope-a", "msg_reply")
    store.dismissPrediction("ses_other", "scope-b", "msg_keep")
    const notice = store.state().notice
    expect(await store.requestPrediction({ memory: ["repository", "knowledge"], hint: "focus the tests" })).toBe(true)
    expect(requests.filter((request) => request.operation === "session.prediction")).toEqual([
      {
        operation: "session.prediction",
        sessionID: "ses_prediction",
        input: { memory: ["repository", "knowledge"], hint: "focus the tests" },
      },
    ])
    expect(store.state().dismissedPredictions).toEqual([
      { sessionID: "ses_other", scope: "scope-b", source: "msg_keep" },
    ])
    expect(store.state().view?.prediction?.text).toBe("Run the focused tests")
    expect(store.state().drafts.ses_prediction).toBe("")
    expect(store.state().notice).toBe(notice)
    expect(store.state().mutationToasts ?? []).toEqual([])
    await store.requestPrediction({ memory: [], hint: "   " })
    await store.requestPrediction({ memory: ["repository"], hint: "h".repeat(2001) })
    const sent = requests.filter((request) => request.operation === "session.prediction")
    expect(sent[1]?.input).toEqual({ memory: [] })
    expect(sent[2]?.input).toEqual({ memory: ["repository"], hint: "h".repeat(2000) })
  } finally {
    store.dispose()
  }
})

test("an unavailable suggestion is a notice, and failed or unknown outcomes stay mutation toasts", async () => {
  const answers: (
    | { status: "ok"; value: { status: "unavailable" } }
    | { status: "failed" | "unknown"; error: { code: "internal_error" | "outcome_unknown"; message: string } }
  )[] = []
  const store = predictionStore([], async (operation) => {
    if (operation !== "session.prediction") return undefined
    const answer = answers.shift()
    if (!answer) throw new Error("missing prediction answer")
    return answer
  })
  try {
    store.connect("dev_1")
    await store.selectSession("ses_prediction")
    store.dismissPrediction("ses_prediction", "scope-a", "msg_reply")
    answers.push({ status: "ok", value: { status: "unavailable" } })
    expect(await store.requestPrediction({ memory: ["knowledge"] })).toBe(false)
    expect(store.state().dismissedPredictions).toEqual([])
    expect(store.state().notice).toBe("No suggestion available for the latest reply")
    expect(store.state().mutationToasts ?? []).toEqual([])
    answers.push({ status: "failed", error: { code: "internal_error", message: "prediction failed" } })
    expect(await store.requestPrediction({ memory: [] })).toBe(false)
    expect(store.state().mutationToasts).toMatchObject([
      { label: "Suggest next message", state: "failed", detail: "prediction failed", sessionID: "ses_prediction" },
    ])
    answers.push({ status: "unknown", error: { code: "outcome_unknown", message: "prediction unsettled" } })
    expect(await store.requestPrediction({ memory: [] })).toBe(false)
    expect(
      store
        .state()
        .mutationToasts?.some(
          (toast) =>
            toast.state === "unknown" &&
            toast.detail === "Outcome unknown: prediction unsettled. Retry only if you want to send it again.",
        ),
    ).toBe(true)
    expect(store.state().view?.prediction).toBeUndefined()
  } finally {
    store.dispose()
  }
})

test("a suggestion settled after the Session changes does not publish that outcome notice", async () => {
  let release: (outcome: { status: "ok"; value: { status: "unavailable" } }) => void = () => {}
  const store = predictionStore([], (operation) =>
    operation === "session.prediction"
      ? new Promise((resolve) => {
          release = resolve
        })
      : undefined,
  )
  try {
    store.connect("dev_1")
    await store.selectSession("ses_prediction")
    const pending = store.requestPrediction({ memory: ["knowledge"] })
    await store.selectSession("ses_other")
    release({ status: "ok", value: { status: "unavailable" } })
    await pending
    expect(store.state().activeSessionID).toBe("ses_other")
    expect(store.state().notice).not.toBe("No suggestion available for the latest reply")
  } finally {
    store.dispose()
  }
})

function predictionStore(
  requests: { operation: string; sessionID?: string; input?: Readonly<Record<string, unknown>> }[],
  prediction: (
    operation: string,
  ) =>
    | Promise<
        | { status: "ok"; value: unknown }
        | { status: "failed" | "unknown"; error: { code: "internal_error" | "outcome_unknown"; message: string } }
        | undefined
      >
    | { status: "ok"; value: unknown }
    | { status: "failed" | "unknown"; error: { code: "internal_error" | "outcome_unknown"; message: string } }
    | undefined,
) {
  return createRemoteStore({
    http: createRemoteHttp(),
    batchMs: 0,
    createTransport: (_deviceID, callbacks) => ({
      connect: () => callbacks.onStatus?.({ kind: "open" }),
      close: () => {},
      setPriority: () => {},
      status: () => ({ kind: "open" as const }),
      request: async (operation, request) => {
        requests.push({ operation, sessionID: request?.sessionID, input: request?.input })
        const answered = operation === "session.prediction" ? await prediction(operation) : undefined
        if (answered)
          return answered.status === "ok" ? { ...answered, value: { data: { data: answered.value } } } : answered
        if (operation === "event.subscribe")
          return { status: "ok" as const, value: { subscription_id: `sub-${request?.sessionID}` } }
        if (operation === "session.snapshot")
          return {
            status: "ok" as const,
            value: {
              data: {
                sourceEpoch: "epoch_prediction",
                session: { id: request?.sessionID, title: "Prediction", time: { created: 1, updated: 1 } },
                messages: [],
                watermark: { type: "log.synced", aggregateID: request?.sessionID ?? "ses_prediction", seq: 0 },
              },
            },
          }
        if (operation === "session.autonomy.get")
          return { status: "ok" as const, value: { data: { mode: "normal", yolo: 0 } } }
        return { status: "ok" as const, value: { data: [] } }
      },
    }),
  })
}
