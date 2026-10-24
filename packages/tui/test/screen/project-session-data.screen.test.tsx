import { expect, test } from "bun:test"
import type { SessionTodoInfo } from "@ycoding-ai/client"
import { groupID, infraID, leadID, scratchID } from "../fixture/coordination-backend"
import { mountCoordination, waitForFrame } from "../fixture/coordination-screen"
import { json } from "../fixture/tui-client"

const todos: SessionTodoInfo[] = [{ content: "Draft release notes", status: "in_progress", priority: "high" }]
const usage = (logical: number) => ({
  logical,
  physical: logical,
  helpers: 0,
  continued: 0,
  fallback: 0,
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
})
const respond = (state: { logical: number }) => (url: URL) => {
  if (/^\/api\/session\/[^/]+\/todo$/.test(url.pathname)) return json({ data: todos })
  if (/^\/api\/session\/[^/]+\/usage$/.test(url.pathname)) return json({ data: usage(state.logical) })
}
const count = (requests: string[], path: string) => requests.filter((request) => request === `GET ${path}`).length
async function until(screen: Awaited<ReturnType<typeof mountCoordination>>["screen"], check: () => boolean, label: string) {
  for (let i = 0; i < 300 && !check(); i++) {
    await screen.renderOnce()
    await Bun.sleep(10)
  }
  if (!check()) throw new Error(`Timed out waiting for ${label}:\n${screen.frame()}`)
}

test("a Project Master chat hydrates todos and usage once, then follows live updates", async () => {
  const state = { logical: 3 }
  const { screen, requests, data } = await mountCoordination({ respond: respond(state) })
  try {
    await until(screen, () => data().session.todo.get(leadID).length === 1 && data().session.usage.get(leadID) !== undefined, "hydrated todo and usage")
    expect(data().session.todo.get(leadID)).toEqual(todos)
    expect(data().session.usage.get(leadID)?.logical).toBe(3)
    expect(count(requests, `/api/session/${leadID}/todo`)).toBe(1)
    expect(count(requests, `/api/session/${leadID}/usage`)).toBe(1)
    await screen.waitForEventStream()
    screen.events.emit({
      id: "evt_todo",
      created: 1,
      type: "todo.updated",
      data: { sessionID: leadID, todos: [{ content: "Review results", status: "pending", priority: "low" }] },
    } as never)
    await until(screen, () => data().session.todo.get(leadID)[0]?.content === "Review results", "live todo")
    state.logical = 4
    screen.events.emit({
      id: "evt_usage",
      created: 2,
      type: "session.usage.updated",
      data: { sessionID: leadID, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    } as never)
    await until(screen, () => data().session.usage.get(leadID)?.logical === 4, "live usage")
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("a Project member chat hydrates its own todos and usage", async () => {
  const { screen, requests, data, router } = await mountCoordination({ respond: respond({ logical: 2 }) })
  try {
    router().navigate({ type: "session", sessionID: infraID })
    await waitForFrame(screen, "Member of Release train")
    await until(screen, () => data().session.todo.get(infraID).length === 1 && data().session.usage.get(infraID) !== undefined, "member hydration")
    expect(count(requests, `/api/session/${infraID}/todo`)).toBe(1)
    expect(count(requests, `/api/session/${infraID}/usage`)).toBe(1)
  } finally {
    await screen.dispose()
  }
}, 40_000)

test("an ordinary Session with its sidebar mounted requests todos and usage once", async () => {
  const { screen, requests, data, router } = await mountCoordination({ respond: respond({ logical: 1 }) })
  try {
    router().navigate({ type: "session", sessionID: scratchID })
    await until(screen, () => data().session.todo.get(scratchID).length === 1 && data().session.usage.get(scratchID) !== undefined, "ordinary hydration")
    await Bun.sleep(300)
    expect(count(requests, `/api/session/${scratchID}/todo`)).toBe(1)
    expect(count(requests, `/api/session/${scratchID}/usage`)).toBe(1)
  } finally {
    await screen.dispose()
  }
}, 40_000)

const escalated = {
  id: "msg_escalated",
  type: "synthetic",
  description: "Project notification",
  text: `Project notification:\n{"source":"project_notification"}`,
  metadata: {
    source: "project_notification",
    groupID,
    memberSessionID: infraID,
    title: "Infra worker",
    event: "escalated",
    requestID: "perm_one",
    kind: "permission",
    excerpt: "Needs approval to install the toolchain.",
    escalatedBy: { sessionID: "ses_owner0000001", title: "Infra owner" },
  },
  time: { created: 30 },
}

test("an escalated request shows a compact notification with Open member, not raw JSON", async () => {
  const { screen, router } = await mountCoordination({ leadMessages: [escalated] })
  try {
    await waitForFrame(screen, "Infra worker")
    const frame = screen.frame()
    expect(frame).toContain("Infra worker escalates a permission request via Infra owner")
    expect(frame).toContain("Needs approval to install the toolchain.")
    expect(frame).not.toContain("project_notification")
    expect(frame).not.toContain('"event"')
    const lines = frame.split("\n")
    const y = lines.findIndex((line) => line.includes("escalates a permission request"))
    const x = lines[y]!.indexOf("[o] Open")
    expect(x).toBeGreaterThan(0)
    await screen.mouse.click(x + 1, y)
    await until(screen, () => {
      const route = router().data
      return route.type === "session" && route.sessionID === infraID
    }, "Open member")
    expect(leadID).not.toBe(infraID)
  } finally {
    await screen.dispose()
  }
}, 40_000)
