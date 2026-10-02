/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type {
  SessionInfo,
  SessionMessageInfo,
  SessionMessageAssistantTool,
  SessionOrchestrationTask,
  YCodingEvent,
} from "@ycoding-ai/client"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const parentID = "ses_capture_recovery"
const childIDs = ["ses_capture_good", "ses_capture_failed"]
const location = {
  directory: "/tmp/ycoding/capture-recovery",
  project: { id: "proj_capture_recovery", directory: "/tmp/ycoding/capture-recovery" },
}
const model = { providerID: "openai", id: "gpt-6.1-sol" }
const files = (name: string) => ({
  files: [
    {
      file: `src/${name}.ts`,
      patch: `--- a/src/${name}.ts\n+++ b/src/${name}.ts\n@@ -1 +1 @@\n-old\n+new`,
      additions: 1,
      deletions: 1,
    },
  ],
})

function edit(name: string, status: "running" | "completed" = "completed"): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: `call_${name}`,
    name: "edit",
    state: {
      status,
      input: { path: `src/${name}.ts` },
      structured: status === "completed" ? files(name) : {},
      content: [],
    },
    time: { created: 2, ran: 2, ...(status === "completed" ? { completed: 3 } : {}) },
  }
}

function assistant(id: string, content: SessionMessageAssistantTool[]): SessionMessageInfo {
  return { id, type: "assistant", agent: "general", model, content, finish: "stop", time: { created: 2, completed: 3 } }
}

function session(id: string): SessionInfo {
  return {
    id,
    parentID: childIDs.includes(id) ? parentID : undefined,
    title: "Patch recovery",
    projectID: location.project.id,
    location,
    agent: "general",
    model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 3 },
  }
}

function fixture(input?: { secondPrompt?: boolean; noRootEdit?: boolean; live?: "root" | "child" }) {
  const failures = new Set<string>()
  const gates = new Map<string, Promise<void>>()
  const requests: string[] = []
  const tasks: SessionOrchestrationTask[] = childIDs.map((sessionID) => ({
    sessionID,
    parentID,
    description: sessionID,
    agent: "general",
    model,
    background: true,
    state: "running",
    revision: 1,
    time: { created: 1, updated: 3 },
  }))
  const launch = (sessionID: string): SessionMessageAssistantTool => ({
    type: "tool",
    id: `call_launch_${sessionID}`,
    name: "subagent",
    state: { status: "running", input: {}, structured: { sessionID, status: "running" }, content: [] },
    time: { created: 2, ran: 2 },
  })
  const root: SessionMessageInfo[] = [
    { id: "msg_root_user", type: "user", text: "First prompt", time: { created: 1 } },
    assistant(
      "msg_root",
      input?.live === "root"
        ? [edit("root"), edit("two", "running"), edit("three", "running")]
        : [...(input?.noRootEdit ? [] : [edit("root")]), ...childIDs.map(launch)],
    ),
    ...(input?.secondPrompt
      ? [
          { id: "msg_second_user", type: "user" as const, text: "Second prompt", time: { created: 4 } },
          assistant("msg_second", [edit("second")]),
        ]
      : []),
  ]
  const transcripts = new Map(
    childIDs.map((id) => [
      id,
      [
        { id: `msg_user_${id}`, type: "user" as const, text: "Child work", time: { created: 1 } },
        assistant(
          `msg_${id}`,
          input?.live === "child" && id === childIDs[0]
            ? [edit("child"), edit("two", "running"), edit("three", "running")]
            : [edit(id === childIDs[0] ? "good" : "recovered")],
        ),
      ],
    ]),
  )
  return {
    failures,
    gates,
    requests,
    reads(id: string) {
      return requests.filter((request) => request === `GET /api/session/${id}/message`).length
    },
    async route(this: void, url: URL, request: Request) {
      requests.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session")
        return json({ data: [session(parentID), ...childIDs.map(session)], cursor: {} })
      if ([parentID, ...childIDs].some((id) => url.pathname === `/api/session/${id}`))
        return json({ data: session(url.pathname.split("/").at(-1)!) })
      if (url.pathname === `/api/session/${parentID}/message`) return json({ data: root, cursor: {} })
      for (const id of childIDs) {
        if (url.pathname !== `/api/session/${id}/message`) continue
        await gates.get(id)
        return failures.has(id)
          ? json({ message: "Transcript unavailable" }, { status: 500 })
          : json({ data: transcripts.get(id), cursor: {} })
      }
      if (url.pathname === `/api/session/${parentID}/subagent`)
        return json({
          data: input?.live === "root" ? [] : tasks,
          summary: {
            total: input?.live === "root" ? 0 : 2,
            active: input?.live === "root" ? 0 : 2,
            running: input?.live === "root" ? 0 : 2,
            waiting: 0,
          },
          cursor: {},
        })
      if (url.pathname.endsWith("/subagent"))
        return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
      if (/\/(pending|todo|skills|permission)$/.test(url.pathname)) return json({ data: [] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              ...model,
              modelID: model.id,
              name: "GPT Sol",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
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
              request: { headers: {}, body: {} },
              mode: "primary",
              hidden: false,
              permissions: [],
            },
          ],
        })
      return undefined
    },
  }
}

async function mount(state: ReturnType<typeof fixture>, settle = "Captured changes") {
  const screen = await renderScreen({
    width: 140,
    height: 60,
    args: { sessionID: parentID },
    route: state.route,
    settle,
  })
  await screen.waitForEventStream()
  return screen
}

function updated(childID: string, seq: number): YCodingEvent {
  return {
    id: `evt_task_${childID}_${seq}`,
    created: seq + 4,
    durable: { aggregateID: childID, seq, version: 1 },
    type: "session.task.updated",
    data: { sessionID: childID, change: { type: "progressed", progress: { text: "Progress", time: seq + 4 } } },
  }
}

async function text(screen: Awaited<ReturnType<typeof renderScreen>>, value: string) {
  if (screen.frame().includes(value)) return
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      screen.renderer.off("frame", check)
    }
    const check = () => {
      if (!screen.frame().includes(value)) return
      cleanup()
      resolve()
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Missing ${value}:\n${screen.frame()}`))
    }, 4000)
    screen.renderer.on("frame", check)
    screen.renderer.requestRender()
  })
}

test("keeps partial child successes, labels only the affected prompt incomplete, and explicitly retries failed reads", async () => {
  const state = fixture({ secondPrompt: true })
  state.failures.add(childIDs[1])
  const screen = await mount(state)
  try {
    await text(screen, "Captured changes 2 known files · incomplete")
    await text(screen, "1 child unavailable")
    expect(screen.frame()).toContain("Captured changes 1 file")
    const initialReads = childIDs.map((id) => state.reads(id))
    const beforeToggle = state.requests.length
    await screen.mouse.click(
      12,
      screen.lines().findIndex((line) => line.includes("2 known files")),
    )
    await text(screen, "src/good.ts")
    expect(state.requests.slice(beforeToggle)).toEqual([])
    expect(screen.frame()).not.toContain("src/second.ts")
    state.failures.clear()
    await screen.mouse.click(
      12,
      screen.lines().findIndex((line) => line.includes("Retry child changes")),
    )
    await text(screen, "Captured changes 3 files")
    expect(screen.frame()).toContain("Captured changes 1 file")
    expect(screen.frame()).not.toContain("incomplete")
    expect(state.reads(childIDs[0])).toBe(initialReads[0])
    expect(state.reads(childIDs[1])).toBe(initialReads[1] + 1)
    expect(state.requests.some((request) => request.startsWith("POST"))).toBe(false)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("retries on the failed child's task update and coalesces duplicate updates while preserving successful reads", async () => {
  const state = fixture()
  state.failures.add(childIDs[1])
  const screen = await mount(state)
  let release!: () => void
  try {
    await text(screen, "1 child unavailable")
    const initialReads = childIDs.map((id) => state.reads(id))
    screen.events.emit(updated(childIDs[0], 1))
    await screen.renderOnce()
    expect(state.reads(childIDs[1])).toBe(initialReads[1])
    state.failures.clear()
    state.gates.set(
      childIDs[1],
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    screen.events.emit(updated(childIDs[1], 1))
    await text(screen, "Child changes loading")
    screen.events.emit(updated(childIDs[1], 2))
    screen.events.emit(updated(childIDs[1], 3))
    await screen.renderOnce()
    expect(state.reads(childIDs[1])).toBe(initialReads[1] + 1)
    expect(state.reads(childIDs[0])).toBe(initialReads[0])
    release()
    await text(screen, "Captured changes 3 files")
    expect(screen.frame()).not.toContain("incomplete")
    expect(state.reads(childIDs[1])).toBe(initialReads[1] + 1)
  } finally {
    release?.()
    await screen.dispose()
  }
}, 30_000)

test("shows an incomplete placeholder when no completed file is yet known", async () => {
  const state = fixture({ noRootEdit: true })
  childIDs.forEach((id) => state.failures.add(id))
  const screen = await mount(state, "Message YCoding…")
  try {
    await text(screen, "Captured changes 0 known files · incomplete")
    await text(screen, "2 children unavailable")
    expect(screen.frame()).toContain("Retry child changes")
  } finally {
    await screen.dispose()
  }
}, 30_000)

test("keyboard command retries failed captured reads in a narrow Session without refetching successes", async () => {
  const state = fixture()
  state.failures.add(childIDs[1])
  const screen = await renderScreen({
    width: 80,
    height: 30,
    args: { sessionID: parentID },
    route: state.route,
    settle: "1 child unavailable",
  })
  try {
    await text(screen, "Retry child changes")
    const initialReads = childIDs.map((id) => state.reads(id))
    screen.input.pressKey("p", { ctrl: true })
    await text(screen, "Commands")
    await screen.input.typeText("Retry captured changes")
    await screen.renderOnce()
    expect(screen.frame()).toContain("Retry captured changes")
    state.failures.clear()
    screen.input.pressEnter()
    await text(screen, "Captured changes 3 files")
    expect(screen.frame()).not.toContain("incomplete")
    expect(state.reads(childIDs[0])).toBe(initialReads[0])
    expect(state.reads(childIDs[1])).toBe(initialReads[1] + 1)
  } finally {
    await screen.dispose()
  }
}, 30_000)

test.each(["root", "child"] as const)(
  "healthy %s live edits update a collapsed summary before toggling and toggling fetches nothing",
  async (live) => {
    const state = fixture({ live })
    const screen = await mount(state, live === "root" ? "Captured changes 1 file" : "Captured changes 3 files")
    try {
      for (const [seq, name] of ["two", "three"].entries()) {
        const sessionID = live === "root" ? parentID : childIDs[0]
        screen.events.emit({
          id: `evt_edit_${live}_${name}`,
          created: 10 + seq,
          durable: { aggregateID: sessionID, seq: 10 + seq, version: 1 },
          type: "session.tool.success",
          data: {
            sessionID,
            assistantMessageID: live === "root" ? "msg_root" : `msg_${childIDs[0]}`,
            callID: `call_${name}`,
            structured: files(name),
            content: [],
            executed: true,
          },
        })
      }
      await text(screen, live === "root" ? "Captured changes 3 files" : "Captured changes 5 files")
      expect(screen.frame()).not.toContain("src/three.ts")
      await screen.renderOnce()
      const beforeToggle = state.requests.length
      await screen.mouse.click(
        12,
        screen.lines().findIndex((line) => line.includes("Captured changes")),
      )
      await text(screen, "src/three.ts")
      expect(state.requests.slice(beforeToggle)).toEqual([])
    } finally {
      await screen.dispose()
    }
  },
  30_000,
)

test("reopens a Session whose captured transcript is still resident without crashing", async () => {
  const state = fixture()
  const screen = await mount(state)
  try {
    await text(screen, "Captured changes")
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("n")
    await Bun.sleep(500)
    screen.input.pressKey("x", { ctrl: true })
    screen.input.pressKey("l")
    await Bun.sleep(500)
    screen.input.pressEnter()
    await text(screen, "Captured changes")
    expect(screen.frame()).not.toContain("YCoding crashed")
  } finally {
    await screen.dispose()
  }
}, 30_000)
