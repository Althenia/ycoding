/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionInfo, SessionOrchestrationTask } from "@ycoding-ai/client"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const parentID = "ses_answer_parent"
const childID = "ses_answer_child"
const questionID = "qst_answer"
const location = { directory: "/tmp/ycoding/answer", project: { id: "proj_answer", directory: "/tmp/ycoding/answer" } }
const model = { providerID: "openai", id: "gpt-6.1-sol" }

function fixture(input?: {
  waiting?: boolean
  review?: "guardrail" | "permission" | "form"
  fail?: boolean
  gate?: Promise<void>
}) {
  let task: SessionOrchestrationTask = {
    sessionID: childID,
    parentID,
    description: "Check the boundary",
    agent: "general",
    model,
    background: true,
    state: input?.waiting === false ? "running" : "waiting",
    revision: 1,
    question: input?.waiting === false ? undefined : { id: questionID, text: "Should I continue the check?", time: 1 },
    time: { created: 1, updated: 1 },
  }
  const sessions = [session(parentID), session(childID, parentID)]
  const writes: { path: string; body: unknown }[] = []
  let subagentReads = 0
  return {
    writes,
    get reads() {
      return subagentReads
    },
    update(question?: string) {
      task = {
        ...task,
        revision: task.revision + 1,
        state: question ? "waiting" : "running",
        question: question ? { id: questionID, text: question, time: 2 } : undefined,
      }
    },
    async route(this: void, url: URL, request: Request) {
      if (!["GET", "HEAD"].includes(request.method)) {
        writes.push({ path: url.pathname, body: await request.json() })
        if (!url.pathname.endsWith(`/question/${questionID}/answer`))
          return json({ message: "Unexpected mutation" }, { status: 500 })
        await input?.gate
        if (input?.fail) return json({ message: "Question is not open" }, { status: 409 })
        task = { ...task, state: "running", question: undefined }
        return json({ data: task })
      }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
      if (url.pathname === "/api/session/active") return json({ data: {} })
      const info = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
      if (info) return json({ data: info })
      if (url.pathname === `/api/session/${parentID}/subagent`) {
        subagentReads++
        return json({
          data: [task],
          summary: {
            total: 1,
            active: 1,
            running: task.state === "running" ? 1 : 0,
            waiting: task.state === "waiting" ? 1 : 0,
          },
          cursor: {},
        })
      }
      if (url.pathname === `/api/session/${childID}/subagent`)
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (url.pathname.endsWith("/message")) return json({ data: [], cursor: {} })
      if (url.pathname.endsWith("/guardrail/request"))
        return json({
          data:
            input?.review === "guardrail"
              ? [
                  {
                    id: "grd_answer",
                    rootSessionID: parentID,
                    sessionID: childID,
                    action: "shell",
                    resources: ["review-target"],
                    reason: "Human review required",
                    ruleIDs: ["standard.review.shell"],
                    standard: true,
                    hardReview: true,
                  },
                ]
              : [],
        })
      if (url.pathname.endsWith("/permission"))
        return json({
          data:
            input?.review === "permission" && url.pathname.includes(childID)
              ? [
                  {
                    id: "per_answer",
                    sessionID: childID,
                    action: "shell",
                    resources: ["review-target"],
                    metadata: {},
                    save: [],
                  },
                ]
              : [],
        })
      if (url.pathname.endsWith("/form"))
        return json({
          data:
            input?.review === "form" && url.pathname.includes(childID)
              ? [
                  {
                    id: "frm_answer",
                    sessionID: childID,
                    title: "Required input",
                    fields: [{ key: "answer", type: "string", title: "Human form answer", required: true }],
                  },
                ]
              : [],
        })
      if (/\/(pending|todo|skills)$/.test(url.pathname)) return json({ data: [] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              ...model,
              modelID: model.id,
              name: "GPT Sol",
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
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "openai", name: "OpenAI" }] })
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [
            {
              id: "general",
              name: "General",
              mode: "primary",
              hidden: false,
              permissions: [],
              request: { headers: {}, body: {} },
            },
          ],
        })
      return undefined
    },
  }
}

function session(id: string, parentID?: string): SessionInfo {
  return {
    id,
    parentID,
    title: parentID ? "Boundary child" : "Boundary parent",
    projectID: "proj_answer",
    location,
    agent: "general",
    model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
}

async function frame(screen: Awaited<ReturnType<typeof renderScreen>>, predicate: (value: string) => boolean) {
  for (let attempt = 0; attempt < 150; attempt++) {
    await screen.renderer.idle()
    if (predicate(screen.frame())) return
    screen.renderer.requestRender()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`Expected screen state did not render:\n${screen.frame()}`)
}

test("subagent answer Enter submits the owned question once, never a prompt or command", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const state = fixture({ gate })
  const screen = await renderScreen({
    width: 100,
    height: 36,
    args: { sessionID: childID },
    route: state.route,
    settle: "Enter answer",
  })
  try {
    await screen.mouse.click(
      3,
      screen.lines().findIndex((line) => line.includes("Enter answer")),
    )
    await screen.input.typeText("continue safely")
    screen.input.pressKey("RETURN")
    await frame(screen, () => state.writes.length > 0)
    expect(state.writes).toEqual([
      {
        path: `/api/session/${parentID}/subagent/${childID}/question/${questionID}/answer`,
        body: { text: "continue safely" },
      },
    ])
    screen.input.pressKey("RETURN")
    await screen.renderer.idle()
    expect(state.writes).toHaveLength(1)
    release()
    await frame(screen, (value) => !value.includes("continue safely"))
    expect(state.writes).toHaveLength(1)
  } finally {
    release()
    await screen.dispose()
  }
}, 30_000)

test("a rejected resolved question retains the answer for inspection and retry", async () => {
  const state = fixture({ fail: true })
  const screen = await renderScreen({
    width: 100,
    height: 36,
    args: { sessionID: childID },
    route: state.route,
    settle: "Enter answer",
  })
  try {
    await screen.input.typeText("Keep this answer")
    screen.input.pressKey("RETURN")
    await frame(screen, (value) => value.includes("Answer not sent"))
    expect(screen.frame()).toContain("Keep this answer")
    expect(state.writes).toHaveLength(1)
    expect(state.writes[0]?.path).toContain(`/question/${questionID}/answer`)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("parent shows the waiting child question on live update and reconnect without a permission request", async () => {
  const state = fixture({ waiting: false })
  const screen = await renderScreen({
    width: 100,
    height: 36,
    args: { sessionID: parentID },
    route: state.route,
    settle: "Message YCoding…",
  })
  try {
    await screen.waitForEventStream()
    state.update("Should I continue after the live update?")
    screen.events.emit({
      id: "evt_answer_waiting",
      created: 2,
      durable: { aggregateID: childID, seq: 1, version: 1 },
      type: "session.task.updated",
      data: {
        sessionID: childID,
        change: {
          type: "question_asked",
          question: { id: questionID, text: "Should I continue after the live update?", time: 2 },
        },
      },
    })
    await frame(screen, (value) => value.includes("Should I continue after the live update?"))
    expect(screen.frame()).toContain("awaiting input")
    expect(screen.frame()).not.toContain("Permission required")
    state.update("Should I continue after reconnect?")
    screen.events.disconnect()
    await frame(screen, (value) => value.includes("Should I continue after reconnect?"))
    expect(state.writes).toEqual([])
    expect(screen.frame()).not.toContain("Permission required")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("a cold parent at narrow width opens its waiting child to answer without queuing input", async () => {
  const state = fixture()
  const screen = await renderScreen({
    width: 80,
    height: 24,
    args: { sessionID: parentID },
    route: state.route,
    settle: "Should I continue the check?",
  })
  try {
    expect(screen.frame()).toContain("general awaiting input")
    expect(screen.frame()).toContain("subagents")
    expect(screen.frame()).not.toContain("Permission required")
    await screen.mouse.click(
      5,
      screen.lines().findIndex((line) => line.includes("general awaiting input")),
    )
    await frame(screen, (value) => value.includes("Enter answer"))
    await screen.input.typeText("Continue from parent navigation")
    screen.input.pressKey("RETURN")
    await frame(screen, () => state.writes.length > 0)
    expect(state.writes).toEqual([
      {
        path: `/api/session/${parentID}/subagent/${childID}/question/${questionID}/answer`,
        body: { text: "Continue from parent navigation" },
      },
    ])
    expect(screen.frame()).not.toContain("Queued:")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test.each(["guardrail", "permission", "form"] as const)(
  "waiting child question does not hide its pending %s review",
  async (review) => {
    const state = fixture({ review })
    const screen = await renderScreen({
      width: 100,
      height: 36,
      args: { sessionID: childID },
      route: state.route,
      settle:
        review === "guardrail"
          ? "Guardrail blocked"
          : review === "permission"
            ? "Permission required"
            : "Human form answer",
    })
    try {
      await frame(screen, (value) =>
        value.includes(
          review === "guardrail"
            ? "Guardrail blocked"
            : review === "permission"
              ? "Permission required"
              : "Human form answer",
        ),
      )
      expect(screen.frame()).not.toContain("Enter answer")
      expect(state.writes).toEqual([])
    } finally {
      await screen.dispose()
    }
  },
  30_000,
)
