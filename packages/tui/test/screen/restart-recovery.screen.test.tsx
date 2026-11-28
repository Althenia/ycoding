/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createEffect } from "solid-js"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_restart_recovery"
const directory = "/tmp/ycoding/restart-recovery"
const location = { directory, project: { id: "proj_restart_recovery", directory } }
const session = {
  id: sessionID,
  title: "Restart recovery",
  projectID: "proj_restart_recovery",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}

const messages = ["prior", "latest"].map((id, index) => ({
  id: `msg_${id}`,
  type: "assistant",
  agent: "build",
  model: session.model,
  time: { created: index + 1, completed: index + 2 },
  content: [{
    type: "tool",
    id: `call_${id}`,
    name: "question",
    state: { status: "error", input: {}, structured: {}, content: [], error: { type: id === "prior" ? "aborted" : "error", message: "Question interrupted" } },
    time: { created: index + 1, ran: index + 1, completed: index + 2 },
  }],
}))
const forms = ["prior", "latest"].map((id) => ({
  id: `frm_${id}`,
  sessionID,
  title: "Questions",
  metadata: { kind: "question", tool: { messageID: `msg_${id}`, callID: `call_${id}` } },
  fields: [{ key: "q0", type: "string", title: `Stale ${id} question`, options: [{ value: "stale", label: `Stale ${id} option` }] }],
}))

test("reconnect does not reopen aborted or errored questions from older and newer tool parts", async () => {
  let reconnected = false
  const formRead = Promise.withResolvers<void>()
  const snapshotRead = Promise.withResolvers<void>()
  const hydrated = Promise.withResolvers<void>()
  const screen = await renderScreen({
    width: 110, height: 40, args: { sessionID }, sessionReady: true, settle: "Message YCoding…",
    data: (data) => createEffect(() => {
      if (data.session.form.list(sessionID)?.length === 2 && data.session.message.list(sessionID).some((item) => item.id === "msg_latest")) hydrated.resolve()
    }),
    route: (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/snapshot`) {
        if (reconnected) snapshotRead.resolve()
        return sessionSnapshot(sessionID, reconnected ? messages : [], { session })
      }
      if (url.pathname === `/api/session/${sessionID}/form`) {
        if (reconnected) formRead.resolve()
        return json({ data: reconnected ? forms : [] })
      }
    },
  })
  try {
    await screen.waitForEventStream()
    reconnected = true
    screen.events.disconnect()
    await Promise.all([formRead.promise, snapshotRead.promise, hydrated.promise])
    await screen.renderOnce()
    await screen.renderOnce()
    expect(screen.frame()).not.toContain("Stale prior option")
    expect(screen.frame()).not.toContain("Stale latest option")
    expect(screen.frame()).not.toContain("Composer paused: form input")
    expect(screen.frame()).toContain("Message YCoding…")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test.each(["running", "unknown"] as const)("a question with %s tool state stays answerable", async (state) => {
  const form = {
    id: "frm_live",
    sessionID,
    title: "Questions",
    metadata: { kind: "question", tool: { messageID: "msg_live", callID: "call_live" } },
    fields: [{ key: "q0", type: "string", title: "Live question", options: [{ value: "continue", label: "Continue option" }] }],
  }
  const live = state === "running" ? [{
    id: "msg_live",
    type: "assistant",
    agent: "build",
    model: session.model,
    time: { created: 1 },
    content: [{ type: "tool", id: "call_live", name: "question", state: { status: "running", input: {}, structured: {}, content: [] }, time: { created: 1, ran: 2 } }],
  }] : []
  const screen = await renderScreen({
    width: 110, height: 40, args: { sessionID }, settle: "Continue option",
    route: (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, live, { session })
      if (url.pathname === `/api/session/${sessionID}/form`) return json({ data: [form] })
    },
  })
  try {
    expect(screen.frame()).toContain("Continue option")
    expect(screen.frame()).toContain("Composer paused: form input")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("store unavailability during restart appears in status without an error toast and clears on reconnect", async () => {
  let unavailable = false
  let failedRead = Promise.withResolvers<void>()
  let recoveredRead = Promise.withResolvers<void>()
  const unavailableState = Promise.withResolvers<void>()
  const recoveredState = Promise.withResolvers<void>()
  let sawUnavailable = false
  const screen = await renderScreen({
    width: 110, height: 40, args: { sessionID }, sessionReady: true, settle: "Message YCoding…",
    data: (data) => createEffect(() => {
      const status = data.session.message.history(sessionID)?.status
      if (status === "error") {
        sawUnavailable = true
        unavailableState.resolve()
      }
      if (sawUnavailable && !unavailable && status === "ready") recoveredState.resolve()
    }),
    route: (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/snapshot`) {
        if (unavailable) {
          failedRead.resolve()
          return json({ _tag: "InvalidRequestError", kind: "unavailable", message: "Session store unavailable" }, { status: 400 })
        }
        recoveredRead.resolve()
        return sessionSnapshot(sessionID, [], { session })
      }
    },
  })
  try {
    await screen.waitForEventStream()
    unavailable = true
    failedRead = Promise.withResolvers<void>()
    screen.events.disconnect()
    await Promise.all([failedRead.promise, unavailableState.promise])
    await screen.renderOnce()
    await screen.renderOnce()
    expect(screen.frame()).toContain("Session store unavailable")
    expect(screen.frame()).not.toContain("✗ Error")
    unavailable = false
    recoveredRead = Promise.withResolvers<void>()
    screen.events.disconnect()
    await Promise.all([recoveredRead.promise, recoveredState.promise])
    await screen.renderOnce()
    await screen.renderOnce()
    expect(screen.frame()).not.toContain("Session store unavailable")
    expect(screen.frame()).toContain("Message YCoding…")
  } finally {
    await screen.dispose()
  }
}, 30_000)
