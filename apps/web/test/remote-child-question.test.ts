import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayHandlerOutcome } from "./relay-double"

const waiting = { sessionID: "ses_child", parentID: "ses_a", description: "Scoped child", agent: "builder", background: true, state: "waiting", revision: 1, question: { id: "qst_1", text: "Which scope?", time: 2 }, time: { created: 1, updated: 2 } }

test("Team and Conversation cannot concurrently send two answers for the same owned child question", async () => {
  const held = Promise.withResolvers<RelayHandlerOutcome>()
  const relay = await startRelayDouble({ handler: (request) => request.operation === "session.subagent.list"
    ? { ok: true, value: { data: [waiting], summary: { total: 1, active: 1 }, cursor: {} } }
    : request.operation === "session.subagent.answer" ? held.promise : "default" })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }), batchMs: 1 })
  try {
    await store.load()
    await waitFor(() => store.state().sessions.length > 0)
    store.watchTeam(true)
    await store.selectSession("ses_a")
    await waitFor(() => store.state().team?.status === "ready")
    const first = store.answerSubagent("ses_child", "qst_1", "Focused tests")
    await waitFor(() => relay.requests.some((request) => request.operation === "session.subagent.answer"))
    const duplicate = store.answerSubagent("ses_child", "qst_1", "Different answer")
    await Promise.resolve()
    held.resolve({ ok: true, value: { data: { ...waiting, question: undefined, state: "running", revision: 2 } } })
    expect(await first).toMatchObject({ status: "ok" })
    expect(store.state().team?.tasks[0]?.question).toBeUndefined()
    expect(await duplicate).toMatchObject({ status: "failed", message: "An answer to this subagent question is already being sent." })
    expect(relay.requests.filter((request) => request.operation === "session.subagent.answer")).toHaveLength(1)
    expect(await store.answerSubagent("ses_child", "qst_1", "After settlement")).toMatchObject({ status: "failed" })
    expect(relay.requests.filter((request) => request.operation === "session.subagent.answer")).toHaveLength(1)
  } finally { held.resolve("default"); store.dispose(); await relay.stop() }
})
