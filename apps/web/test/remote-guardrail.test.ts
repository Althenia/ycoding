import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { guardrailContextAvailable, readGuardrailRequests } from "../src/remote/projection"
import { startRelayDouble, waitFor } from "./relay-double"

const review = { id: "grq_child", sessionID: "ses_child", rootSessionID: "ses_a", action: "shell", resources: ["rm -rf fixture/trash"], reason: "Deletion requires review", hardReview: true, metadata: { workdir: "/fixture/project" } }

test("preserves inspectable guardrail metadata in the family read", () => {
  expect(readGuardrailRequests({ data: [review] }, 1)[0]).toMatchObject({ resources: review.resources, metadata: review.metadata })
  const parsed = readGuardrailRequests({ data: [{ ...review, resources: [], metadata: { command: "rm fixture/trash", workdir: "/fixture/project" } }] }, 1)[0]!
  if (parsed.kind !== "guardrail") throw new Error("Expected a guardrail request")
  expect(guardrailContextAvailable(parsed)).toBe(true)
  expect(guardrailContextAvailable({ ...parsed, resources: [" "], metadata: { workdir: "/fixture/project" } })).toBe(false)
})

test("a human can reject a review with missing targets but cannot approve it blindly", async () => {
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a"], guardrailRequests: [{ ...review, resources: [], metadata: {} }] })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load(); await waitFor(() => store.state().sessions.length > 0); await store.selectSession("ses_a")
    await store.replyGuardrail(review.id, "once")
    expect(relay.requests.filter((request) => request.operation === "session.guardrail.reply")).toHaveLength(0)
    expect(store.state().notice).toContain("targets")
    await store.replyGuardrail(review.id, "reject")
    expect(relay.requests.filter((request) => request.operation === "session.guardrail.reply")).toMatchObject([{ input: { requestID: review.id, reply: "reject" } }])
  } finally { store.dispose(); await relay.stop() }
})

for (const outcome of ["failed", "unknown"] as const) test(`${outcome} human replies remain explicit and pending without automatic resend`, async () => {
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a"], guardrailRequests: [review], handler: (request) => request.operation === "session.guardrail.reply" ? outcome === "unknown" ? "silent" : { ok: false, code: "invalid_message", message: "Review is no longer pending" } : "default" })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers, requestTimeoutMs: 30 }) })
  try {
    await store.load(); await waitFor(() => store.state().sessions.length > 0); await store.selectSession("ses_a")
    await store.replyGuardrail(review.id, "once")
    expect(store.state().view?.requests.some((request) => request.id === review.id)).toBe(true)
    expect(store.state().mutations.find((entry) => entry.kind === "guardrail")?.state).toBe(outcome)
    expect(store.state().mutationToasts?.[0]?.state).toBe(outcome)
    expect(relay.requests.filter((request) => request.operation === "session.guardrail.reply")).toHaveLength(1)
  } finally { store.dispose(); await relay.stop() }
})

for (const reply of ["once", "reject"] as const) test(`a human ${reply} answers a child's hard review through the selected parent`, async () => {
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a"], guardrailRequests: [review] })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().sessions.length > 0)
    await store.selectSession("ses_a")
    await store.replyGuardrail(review.id, reply)
    expect(relay.requests.filter((request) => request.operation === "session.guardrail.reply")).toMatchObject([{ sessionID: "ses_a", input: { requestID: review.id, reply } }])
    expect(store.state().view?.requests).toHaveLength(0)
  } finally { store.dispose(); await relay.stop() }
})

test("hard Always and absent requests cannot send, and duplicate in-flight replies cannot send", async () => {
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a"], guardrailRequests: [review], handler: async (request) => { if (request.operation === "session.guardrail.reply" && request.input?.requestID === review.id && request.input?.reply !== "always") await held; return "default" as const } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load(); await waitFor(() => store.state().sessions.length > 0); await store.selectSession("ses_a")
    await store.replyGuardrail(review.id, "always")
    await store.replyGuardrail("grq_missing", "once")
    expect(relay.requests.filter((request) => request.operation === "session.guardrail.reply")).toHaveLength(0)
    const pending = store.replyGuardrail(review.id, "once")
    await waitFor(() => relay.requests.some((request) => request.operation === "session.guardrail.reply"))
    await store.replyGuardrail(review.id, "reject")
    expect(relay.requests.filter((request) => request.operation === "session.guardrail.reply")).toHaveLength(1)
    release?.(); await pending
  } finally { release?.(); store.dispose(); await relay.stop() }
})

for (const replacement of ["selection", "connection"] as const) test(`a late reply cannot clear the pending card after ${replacement} replacement`, async () => {
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a", "ses_b"], guardrailRequests: [{ ...review, sessionID: "ses_a" }], handler: async (request) => { if (request.operation === "session.guardrail.reply" && request.input?.reply === "once") await held; return "default" as const } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load(); await waitFor(() => store.state().sessions.length > 0); await store.selectSession("ses_a")
    const pending = store.replyGuardrail(review.id, "once")
    await waitFor(() => relay.requests.some((request) => request.operation === "session.guardrail.reply"))
    if (replacement === "connection") { store.disconnect(); store.connect("dev_1"); await waitFor(() => store.state().transport.kind === "open") }
    await store.selectSession(replacement === "selection" ? "ses_b" : "ses_a")
    relay.pushEvent(store.state().activeSessionID!, { type: "guardrail.asked", data: { ...review, sessionID: store.state().activeSessionID, rootSessionID: store.state().activeSessionID } })
    await waitFor(() => store.state().view?.requests.some((request) => request.id === review.id) === true)
    if (replacement === "selection") {
      await store.replyGuardrail(review.id, "reject")
      expect(relay.requests.filter((request) => request.operation === "session.guardrail.reply")).toHaveLength(1)
    }
    release?.(); await pending
    expect(store.state().view?.requests.some((request) => request.id === review.id)).toBe(true)
  } finally { release?.(); store.dispose(); await relay.stop() }
})
