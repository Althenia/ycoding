import { expect, test } from "bun:test"
import type { YCodingEvent } from "@ycoding-ai/client"
import type { useData } from "../../src/context/data"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const sessionID = "ses_instruction_notice"
const directory = "/tmp/ycoding-tui-instruction-notice/workspace"
const location = { directory, project: { id: "proj_instruction_notice", directory } }
const session = {
  id: sessionID,
  title: "Instruction notice order",
  projectID: location.project.id,
  location: { directory },
  agent: "build",
  model: { providerID: "fixture", id: "fixture" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
}
const user = { id: "msg_user", type: "user" as const, text: "Update the date guidance", time: { created: 2 } }
const assistant = {
  id: "msg_assistant",
  type: "assistant" as const,
  agent: "build",
  model: session.model,
  content: [{ type: "text" as const, text: "Streaming answer" }],
  time: { created: 8 },
}
const notice = {
  id: "msg_instruction_date",
  type: "system" as const,
  text: "Instructions updated: core/date",
  time: { created: 3 },
}
const later = {
  id: "msg_later",
  type: "synthetic" as const,
  text: "Later transcript note",
  description: "Later transcript note",
  time: { created: 12 },
}

test("an instruction notice stays before the assistant that consumed it", async () => {
  let phase: "open" | "omit" | "canonical" = "open"
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 80,
    height: 28,
    args: { sessionID },
    settle: "Update the date guidance",
    state: "/tmp/ycoding-tui-instruction-notice/state",
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
    },
    route: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/snapshot`) {
        const messages =
          phase === "open" ? [user] : phase === "omit" ? [user, assistant] : [user, notice, assistant, later]
        const seq = phase === "open" ? 1 : 12
        return sessionSnapshot(sessionID, messages, {
          session,
          watermark: { type: "log.synced", aggregateID: sessionID, seq },
        })
      }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
        })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "fixture", name: "Fixture" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              id: "fixture",
              modelID: "fixture",
              providerID: "fixture",
              name: "Fixture",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              variants: [],
              time: { released: 0 },
              cost: [],
              status: "active",
              enabled: true,
              limit: { context: 200000, output: 32000 },
            },
          ],
        })
      if (url.pathname === `/api/session/${sessionID}/subagent`)
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (["pending", "permission", "todo", "skills"].some((suffix) => url.pathname === `/api/session/${sessionID}/${suffix}`))
        return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}/guardrail`)
        return json({
          data: {
            rootSessionID: sessionID,
            profile: "standard",
            customRules: 0,
            approvals: 0,
            blocked: 0,
            counters: [],
            invalidFiles: [],
          },
        })
      return undefined
    },
  })
  const emit = (event: YCodingEvent) => {
    screen.events.emit(event)
  }
  const wait = async (ready: () => boolean) => {
    const end = Date.now() + 5000
    while (!ready() && Date.now() < end) {
      await screen.renderOnce()
      await Bun.sleep(20)
    }
    expect(ready(), screen.frame()).toBe(true)
  }
  const order = () => {
    const lines = screen.lines()
    return {
      notice: lines.findIndex((line) => line.includes("Instructions updated: core/date")),
      answer: lines.findIndex((line) => line.includes("Streaming answer")),
      later: lines.findIndex((line) => line.includes("Later transcript note")),
    }
  }

  try {
    await screen.waitForEventStream()
    emit({
      id: "evt_step",
      created: 8,
      type: "session.step.started",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 8, version: 1 },
      data: { sessionID, assistantMessageID: assistant.id, agent: "build", model: assistant.model },
    } as YCodingEvent)
    emit({
      id: "evt_text",
      created: 9,
      type: "session.text.started",
      location: { directory },
      data: { sessionID, assistantMessageID: assistant.id, ordinal: 0 },
    } as YCodingEvent)
    emit({
      id: "evt_text_end",
      created: 10,
      type: "session.text.ended",
      location: { directory },
      data: { sessionID, assistantMessageID: assistant.id, ordinal: 0, text: "Streaming answer" },
    } as YCodingEvent)
    await wait(() => screen.frame().includes("Streaming answer"))
    emit({
      id: "evt_instruction_date",
      created: 3,
      type: "session.instructions.updated",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 3, version: 2 },
      data: { sessionID, delta: { "core/date": "1".repeat(64) } },
    } as YCodingEvent)
    await wait(() => {
      const positions = order()
      return positions.notice >= 0 && positions.answer >= 0 && positions.notice < positions.answer
    })

    emit({
      id: "evt_later",
      created: 12,
      type: "session.synthetic",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 12, version: 1 },
      data: { sessionID, text: "Later transcript note", description: "Later transcript note" },
    } as YCodingEvent)
    await wait(() => {
      const positions = order()
      return positions.later > positions.answer && positions.notice < positions.answer
    })

    phase = "omit"
    data.session.message.invalidate(sessionID)
    await data.session.message.sync(sessionID)
    await screen.renderOnce()
    await wait(() => {
      const positions = order()
      return positions.notice >= 0 && positions.notice < positions.answer && positions.later > positions.answer
    })

    phase = "canonical"
    data.session.message.invalidate(sessionID)
    await data.session.message.sync(sessionID)
    await screen.renderOnce()
    await wait(() => {
      const positions = order()
      return positions.notice >= 0 && positions.notice < positions.answer && positions.later > positions.answer
    })
  } finally {
    await screen.dispose()
  }
}, 30000)
