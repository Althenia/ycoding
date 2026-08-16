/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { YCodingEvent, SessionMessageAssistant, SessionMessageInfo } from "@ycoding-ai/client"
import { testRender } from "@opentui/solid"
import { createSignal, onMount, type ParentProps } from "solid-js"
import { ClientProvider } from "../../../src/context/client"
import {
  DataProvider,
  MESSAGE_HOT_LIMIT,
  boundHotMessages,
  estimateResidentSessionMemory,
  formatMemoryBytes,
  isMessageComplete,
  sessionMemoryLines,
  useData,
} from "../../../src/context/data"
import { createSessionRows, resolveMessageJump } from "../../../src/routes/session/rows"
import { createApi, createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"

const sessionID = "ses_history"

test("estimates UTF-8 resident payload categories without claiming exact heap attribution", () => {
  const tool = assistant(2, "completed")
  tool.id = "msg_a"
  tool.agent = "a"
  tool.model = { id: "m", providerID: "p" }
  tool.content = [
    { type: "text", text: "é" },
    { type: "reasoning", text: "🙂", time: { created: 2, completed: 3 } },
    {
      type: "tool",
      id: "c",
      name: "n",
      state: {
        status: "completed",
        input: { prompt: "é" },
        structured: { ok: true },
        content: [
          { type: "text", text: "out" },
          { type: "file", uri: "u", mime: "文", name: "f" },
        ],
        result: { payload: "結果" },
      },
      time: { created: 2, completed: 3 },
    },
  ]
  const message: SessionMessageInfo = {
    id: "msg_é",
    type: "user",
    text: "🙂",
    files: [{ data: "é", mime: "文", source: { type: "inline" }, name: "n" }],
    time: { created: 1 },
  }
  const estimate = estimateResidentSessionMemory({
    hot: [message, tool],
    page: [],
    placeholders: 2,
    residentSessions: 1,
    process: { heapUsed: 1024, heapTotal: 2 * 1024 * 1024, rss: 3 * 1024 * 1024 },
  })

  expect(estimate.estimated.categories).toEqual({
    message: 90,
    toolInput: 2,
    toolOutput: 7,
    toolStructured: 4,
    toolResult: 33,
    toolAttachments: 9,
    userFiles: 12,
    shellOutput: 0,
    other: 0,
  })
  expect(estimate.estimated.total).toBe(157)
  expect(sessionMemoryLines(estimate)).toContain("heapUsed  1.0 KiB")
  expect(sessionMemoryLines(estimate).at(-1)).toContain("not exact per-session heap attribution")
  expect(formatMemoryBytes(2 * 1024 * 1024)).toBe("2.0 MiB")
})

test("estimator traversal is cycle-safe and bounded", () => {
  const cycle: Record<string, unknown> = { payload: "é" }
  cycle.self = cycle
  const tool = assistant(3, "completed")
  const part = tool.content.find((item) => item.type === "tool")
  if (!part || part.type !== "tool" || part.state.status !== "completed") throw new Error("missing fixture tool")
  part.state.result = cycle as unknown as NonNullable<typeof part.state.result>
  const estimate = estimateResidentSessionMemory({
    hot: [tool],
    page: [],
    placeholders: 0,
    residentSessions: 1,
    process: { heapUsed: 0, heapTotal: 0, rss: 0 },
    maxNodes: 100,
  })
  expect(estimate.estimated.truncated).toBe(false)
  expect(estimate.estimated.categories.toolResult).toBeGreaterThan(0)
})

test("estimator stops a very wide object at the node budget without bulk expansion", () => {
  let reads = 0
  const result: Record<string, string> = {}
  for (let index = 0; index < 100_000; index++)
    Object.defineProperty(result, `field_${index}`, {
      enumerable: true,
      get() {
        reads++
        return `value_${index}`
      },
    })
  const tool = assistant(4, "completed")
  const part = tool.content.find((item) => item.type === "tool")
  if (!part || part.type !== "tool" || part.state.status !== "completed") throw new Error("missing fixture tool")
  part.state.result = result
  for (let index = 0; index < 5; index++) Bun.gc(true)
  const before = process.memoryUsage().heapUsed
  const estimate = estimateResidentSessionMemory({
    hot: [tool],
    page: [],
    placeholders: 0,
    residentSessions: 1,
    process: { heapUsed: 0, heapTotal: 0, rss: 0 },
    maxNodes: 100,
  })
  for (let index = 0; index < 5; index++) Bun.gc(true)
  expect(estimate.estimated.truncated).toBe(true)
  expect(reads).toBeLessThanOrEqual(100)
  expect(process.memoryUsage().heapUsed - before).toBeLessThanOrEqual(4 * 1024 * 1024)
})

test("20 lazy estimator refresh cycles retain less than 4 MiB", async () => {
  const messages = Array.from({ length: 250 }, (_, index) => user(index))
  for (let index = 0; index < 5; index++) Bun.gc(true)
  const before = process.memoryUsage().heapUsed
  for (let index = 0; index < 20; index++)
    estimateResidentSessionMemory({
      hot: messages.slice(-50),
      page: messages.slice(0, 200),
      placeholders: 4,
      residentSessions: 1,
      process: { heapUsed: 0, heapTotal: 0, rss: 0 },
    })
  await Bun.sleep(0)
  for (let index = 0; index < 5; index++) Bun.gc(true)
  expect(process.memoryUsage().heapUsed - before).toBeLessThanOrEqual(4 * 1024 * 1024)
})

test("retains the latest 50 completed messages and every live boundary without flattening", () => {
  const completed = Array.from({ length: 80 }, (_, index) => user(index))
  const running = assistant(10_000, "running")
  const messages = [running, ...completed]
  const result = boundHotMessages(messages, new Set())

  expect(MESSAGE_HOT_LIMIT).toBe(50)
  expect(result).toHaveLength(51)
  expect(result[0]).toBe(running)
  expect(result.slice(1)).toEqual(completed.slice(-50))
  expect(result.flatMap(payloads)).toEqual(completed.slice(-50).flatMap(payloads))
  expect(result.flatMap(payloads)).not.toContain(payloads(completed[0])[0])
})

test("never collapses incomplete shell, compaction, reasoning, or tool boundaries", () => {
  const shell: SessionMessageInfo = {
    id: "msg_shell_live",
    type: "shell",
    shellID: "sh_live",
    command: "sleep 1",
    status: "running",
    time: { created: 1 },
  }
  const compaction: SessionMessageInfo = {
    id: "msg_compaction_live",
    type: "compaction",
    status: "running",
    reason: "auto",
    summary: "",
    recent: "",
    time: { created: 2 },
  }
  const liveAssistant = assistant(3, "running")
  const result = boundHotMessages(
    [shell, compaction, liveAssistant, ...Array.from({ length: 60 }, (_, index) => user(index))],
    new Set(),
  )
  expect(result.slice(0, 3)).toEqual([shell, compaction, liveAssistant])
  expect(result.filter(isMessageComplete)).toHaveLength(50)
})

test("loads one canonical older page and collapse releases all historical payload references", async () => {
  const pages = historyPages()
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    const cursor = url.searchParams.get("cursor")
    if (!cursor) return response(pages.hot, "cursor-1")
    if (cursor === "cursor-1") return response(pages.first, "cursor-2")
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    expect(mounted.data.session.message.list(sessionID)).toHaveLength(50)
    expect(mounted.data.session.message.history(sessionID)).toMatchObject([
      { sessionID, cursor: "cursor-1", state: "collapsed" },
    ])

    await mounted.data.session.message.expand(sessionID, "cursor-1")
    expect(mounted.data.session.message.hot(sessionID)).toHaveLength(50)
    expect(mounted.data.session.message.page(sessionID)).toHaveLength(200)
    expect(mounted.data.session.message.list(sessionID)).toHaveLength(250)
    expect(mounted.data.session.message.page(sessionID)[0]).toEqual(pages.first.at(-1)!)
    expect(mounted.data.session.message.history(sessionID)).toContainEqual(
      expect.objectContaining({ cursor: "cursor-1", count: 200, state: "expanded" }),
    )

    mounted.data.session.message.collapse(sessionID)
    expect(mounted.data.session.message.page(sessionID)).toEqual([])
    expect(mounted.data.session.message.list(sessionID)).toHaveLength(50)
    expect(mounted.data.session.message.list(sessionID).flatMap(payloads)).toHaveLength(50)
    mounted.events.emit({
      id: "evt_deleted",
      created: 2000,
      type: "session.deleted",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 2000, version: 2 },
      data: { sessionID },
    })
    await wait(() => mounted.data.session.message.list(sessionID).length === 0)
    expect(mounted.data.session.message.history(sessionID)).toEqual([])
  } finally {
    mounted.destroy()
  }
})

test("expands 1000 archived messages, preserves the collapsed archive, and renders the same page after re-expansion", async () => {
  const hot = descending(1001, 1050)
  const archived = descending(1, 1000)
  const limits: string[] = []
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    const cursor = url.searchParams.get("cursor")
    if (!cursor) return response(hot, "cursor-archive")
    if (cursor !== "cursor-archive") return
    const limit = Number(url.searchParams.get("limit"))
    limits.push(String(limit))
    return response(archived.slice(0, limit))
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    expect(mounted.data.session.message.history(sessionID)).toMatchObject([
      { sessionID, cursor: "cursor-archive", state: "collapsed" },
    ])

    await mounted.data.session.message.expand(sessionID, "cursor-archive")
    expect(limits).toEqual(["1000"])
    expect(mounted.data.session.message.page(sessionID)).toHaveLength(1000)
    expect(mounted.data.session.message.history(sessionID)).toContainEqual(
      expect.objectContaining({ cursor: "cursor-archive", count: 1000, state: "expanded" }),
    )
    const expandedIDs = mounted.data.session.message.page(sessionID).map((message) => message.id)

    mounted.data.session.message.collapse(sessionID)
    expect(mounted.data.session.message.page(sessionID)).toEqual([])
    expect(mounted.data.session.message.history(sessionID)).toContainEqual(
      expect.objectContaining({ cursor: "cursor-archive", count: 1000, state: "collapsed" }),
    )

    await mounted.data.session.message.expand(sessionID, "cursor-archive")
    expect(limits).toEqual(["1000", "1000"])
    expect(mounted.data.session.message.page(sessionID).map((message) => message.id)).toEqual(expandedIDs)
  } finally {
    mounted.destroy()
  }
})

test("sync pages far enough to retain 50 completed messages plus every live boundary", async () => {
  const complete = descending(956, 1000)
  const running = Array.from({ length: 5 }, (_, index) => assistant(1001 + index, "running"))
  const limits: string[] = []
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    limits.push(url.searchParams.get("limit") ?? "")
    if (!url.searchParams.get("cursor")) return response([...running.toReversed(), ...complete], "cursor-fill")
    return response(descending(951, 955), "cursor-old")
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    expect(mounted.data.session.message.hot(sessionID)).toHaveLength(55)
    expect(mounted.data.session.message.hot(sessionID).filter((message) => !boundComplete(message))).toHaveLength(5)
    expect(mounted.data.session.message.history(sessionID)[0]?.cursor).toBe("cursor-old")
    expect(limits).toEqual(["50", "5"])
  } finally {
    mounted.destroy()
  }
})

test("preserves canonical API aggregate order for equal timestamps, nonlexical IDs, duplicates, and cursors", async () => {
  const canonical = Array.from({ length: 50 }, (_, index) =>
    userWithID(index === 10 ? "msg_caller-z" : `msg_${["z", "10", "a"][index % 3]}_${index}`, `old ${index}`),
  )
  const duplicate = userWithID("msg_caller-z", "new duplicate")
  const older = [
    userWithID("msg_page-z", "page z"),
    userWithID("msg_page-10", "page 10"),
    userWithID("msg_page-a", "page a"),
  ]
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    if (!url.searchParams.get("cursor")) return response([duplicate, ...canonical.toReversed()], "cursor-order")
    return response(older.toReversed())
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    expect(mounted.data.session.message.hot(sessionID).map((message) => message.id)).toEqual(
      canonical.map((message) => message.id),
    )
    expect((mounted.data.session.message.get(sessionID, "msg_caller-z") as { text?: string }).text).toBe("new duplicate")
    await mounted.data.session.message.expand(sessionID, "cursor-order")
    expect(mounted.data.session.message.page(sessionID).map((message) => message.id)).toEqual(
      older.map((message) => message.id),
    )
  } finally {
    mounted.destroy()
  }
})

test("promotion removes the active marker before rebounding to 50 completed messages", async () => {
  const mounted = await mount((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) return response(historyPages().hot)
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    mounted.events.emit({
      id: "evt_admitted_bound",
      created: 1001,
      type: "session.input.admitted",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: {
        sessionID,
        inputID: "msg_promoted_bound",
        input: { type: "user", data: { text: "promoted", metadata: {} }, delivery: "steer" },
      },
    })
    await wait(() => mounted.data.session.message.hot(sessionID).length === 51)
    mounted.events.emit({
      id: "evt_promoted_bound",
      created: 1002,
      type: "session.input.promoted",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 2, version: 1 },
      data: { sessionID, inputID: "msg_promoted_bound" },
    })
    await wait(() => !mounted.data.session.input.has(sessionID, "msg_promoted_bound"))
    expect(mounted.data.session.message.hot(sessionID).filter((message) => boundComplete(message))).toHaveLength(50)
  } finally {
    mounted.destroy()
  }
})

test("keeps reactive message lookup aligned when archive eviction shifts resident indices", async () => {
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) return response(historyPages().hot)
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <text>{data.session.message.get(sessionID, "msg_000952")?.id ?? "missing"}</text>
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await data.session.message.sync(sessionID)
    await app.waitForFrame((frame) => frame.includes("msg_000952"))
    events.emit({
      id: "evt_admitted_lookup",
      created: 1001,
      type: "session.input.admitted",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: {
        sessionID,
        inputID: "msg_promoted_lookup",
        input: { type: "user", data: { text: "promoted", metadata: {} }, delivery: "steer" },
      },
    })
    await wait(() => data.session.message.hot(sessionID).length === 51)
    events.emit({
      id: "evt_promoted_lookup",
      created: 1002,
      type: "session.input.promoted",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 2, version: 1 },
      data: { sessionID, inputID: "msg_promoted_lookup" },
    })
    await wait(() => data.session.message.hot(sessionID).length === 50)
    await app.renderOnce()

    const frame = app.captureCharFrame()
    expect(frame).toContain("msg_000952")
    expect(frame).not.toContain("msg_000953")
  } finally {
    app.renderer.destroy()
  }
})

test("empty terminal continuation removes its placeholder and never retains an empty expanded page", async () => {
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    if (!url.searchParams.get("cursor")) return response(historyPages().hot, "cursor-empty")
    return response([])
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    expect(await mounted.data.session.message.expand(sessionID, "cursor-empty")).toBe(false)
    expect(mounted.data.session.message.page(sessionID)).toEqual([])
    expect(mounted.data.session.message.history(sessionID)).toEqual([])
  } finally {
    mounted.destroy()
  }
})

test("failed expansion is retryable and never exposes a partial page", async () => {
  const pages = historyPages()
  let initial = 0
  let attempts = 0
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    const cursor = url.searchParams.get("cursor")
    if (!cursor) {
      initial++
      return response(pages.hot, initial === 1 ? "cursor-1" : "cursor-fresh")
    }
    attempts++
    if (cursor === "cursor-1") return json({ message: "expired" }, { status: 500 })
    if (cursor === "cursor-fresh") return response(pages.first, "cursor-2")
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    await expect(mounted.data.session.message.expand(sessionID, "cursor-1")).rejects.toBeDefined()
    expect(mounted.data.session.message.page(sessionID)).toEqual([])
    expect(mounted.data.session.message.history(sessionID)[0]?.state).toBe("error")

    await mounted.data.session.message.expand(sessionID, "cursor-1")
    expect(mounted.data.session.message.page(sessionID)).toHaveLength(200)
    expect(attempts).toBe(2)
  } finally {
    mounted.destroy()
  }
})

test("expanded pages preserve every canonical typed transcript structure", async () => {
  const page = richPage()
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    if (!url.searchParams.get("cursor")) return response(historyPages().hot, "cursor-rich")
    return response(page)
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    await mounted.data.session.message.expand(sessionID, "cursor-rich")
    expect(mounted.data.session.message.page(sessionID)).toEqual(page.toReversed())
  } finally {
    mounted.destroy()
  }
})

test("new events bound the hot window and invalidate history until canonical reload", async () => {
  const pages = historyPages()
  let initial = 0
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    const cursor = url.searchParams.get("cursor")
    if (cursor === "cursor-1") return response(pages.first, "cursor-2")
    initial++
    return response(pages.hot, initial === 1 ? undefined : "cursor-1")
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    mounted.events.emit(event("evt_agent_1", 1001))
    mounted.events.emit(event("evt_agent_2", 1002))
    await wait(() => mounted.data.session.message.history(sessionID).length === 1)
    expect(mounted.data.session.message.hot(sessionID)).toHaveLength(50)
    expect(mounted.data.session.message.history(sessionID)[0]?.state).toBe("collapsed")
    expect(mounted.data.session.message.history(sessionID)[0]?.cursor).toBeUndefined()

    await mounted.data.session.message.expand(sessionID)
    expect(initial).toBe(2)
    expect(mounted.data.session.message.page(sessionID)).toHaveLength(200)
  } finally {
    mounted.destroy()
  }
})

test("navigation eviction prevents an in-flight canonical load from repopulating history", async () => {
  let resolve!: (response: Response) => void
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    return new Promise<Response>((done) => {
      resolve = done
    })
  })

  try {
    const syncing = mounted.data.session.message.sync(sessionID)
    await wait(() => resolve !== undefined)
    mounted.data.session.message.evict(sessionID)
    resolve(response(historyPages().hot, "cursor-1"))
    await syncing
    expect(mounted.data.session.message.hot(sessionID)).toEqual([])
    expect(mounted.data.session.message.history(sessionID)).toEqual([])
  } finally {
    mounted.destroy()
  }
})

test("deferred sync cannot overwrite post-request shell, tool, reasoning, promotion, or append events", async () => {
  let resolve!: (response: Response) => void
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    return new Promise<Response>((done) => {
      resolve = done
    })
  })
  const emit = (event: object) => mounted.events.emit(event as unknown as YCodingEvent)

  try {
    emit({
      id: "evt_shell_race",
      created: 1,
      type: "session.shell.started",
      location: { directory },
      data: { sessionID, shell: { id: "sh_race", command: "printf race", status: "running" } },
    })
    emit({
      id: "evt_step_race",
      created: 2,
      type: "session.step.started",
      location: { directory },
      data: {
        sessionID,
        assistantMessageID: "msg_assistant_race",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    emit({
      id: "evt_reasoning_race",
      created: 3,
      type: "session.reasoning.started",
      location: { directory },
      data: { sessionID, assistantMessageID: "msg_assistant_race", state: {} },
    })
    emit({
      id: "evt_tool_input_race",
      created: 4,
      type: "session.tool.input.started",
      location: { directory },
      data: { sessionID, assistantMessageID: "msg_assistant_race", callID: "call_race", name: "skill" },
    })
    emit({
      id: "evt_tool_called_race",
      created: 5,
      type: "session.tool.called",
      location: { directory },
      data: {
        sessionID,
        assistantMessageID: "msg_assistant_race",
        callID: "call_race",
        input: { id: "skill" },
        executed: true,
        state: {},
      },
    })
    emit({
      id: "evt_input_race",
      created: 6,
      type: "session.input.admitted",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 6, version: 1 },
      data: {
        sessionID,
        inputID: "msg_user_race",
        input: { type: "user", data: { text: "race user", metadata: {} }, delivery: "steer" },
      },
    })
    await wait(() => mounted.data.session.message.hot(sessionID).length === 3)
    const syncing = mounted.data.session.message.sync(sessionID)
    await wait(() => resolve !== undefined)

    emit({
      id: "evt_shell_end_race",
      created: 7,
      type: "session.shell.ended",
      location: { directory },
      data: {
        sessionID,
        shell: { id: "sh_race", status: "exited", exit: 0 },
        output: { output: "done", cursor: 4, size: 4, truncated: false },
      },
    })
    emit({
      id: "evt_reasoning_end_race",
      created: 8,
      type: "session.reasoning.ended",
      location: { directory },
      data: { sessionID, assistantMessageID: "msg_assistant_race", text: "final reasoning", state: {} },
    })
    emit({
      id: "evt_tool_success_race",
      created: 9,
      type: "session.tool.success",
      location: { directory },
      data: {
        sessionID,
        assistantMessageID: "msg_assistant_race",
        callID: "call_race",
        structured: { ok: true },
        content: [{ type: "text", text: "tool done" }],
        result: { value: "done" },
        executed: true,
        resultState: {},
      },
    })
    emit({
      id: "evt_step_end_race",
      created: 10,
      type: "session.step.ended",
      location: { directory },
      data: {
        sessionID,
        assistantMessageID: "msg_assistant_race",
        finish: "stop",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
      },
    })
    emit({
      id: "evt_promote_race",
      created: 11,
      type: "session.input.promoted",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 11, version: 1 },
      data: { sessionID, inputID: "msg_user_race" },
    })
    emit({
      id: "evt_agent_race",
      created: 12,
      type: "session.agent.selected",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 12, version: 1 },
      data: { sessionID, agent: "review" },
    })
    await wait(() => {
      const assistant = mounted.data.session.message.get(sessionID, "msg_assistant_race")
      return (
        assistant?.type === "assistant" &&
        assistant.finish === "stop" &&
        mounted.data.session.message.hot(sessionID).some((message) => message.type === "agent-switched")
      )
    })
    resolve(response([]))
    await syncing

    const shell = mounted.data.session.message.hot(sessionID).find((message) => message.type === "shell")
    expect(shell).toMatchObject({ status: "exited", output: { output: "done" } })
    const assistant = mounted.data.session.message.get(sessionID, "msg_assistant_race")
    expect(assistant).toMatchObject({ type: "assistant", finish: "stop", time: { completed: 10 } })
    if (assistant?.type !== "assistant") throw new Error("missing assistant")
    expect(assistant.content.find((item) => item.type === "reasoning")).toMatchObject({
      text: "final reasoning",
      time: { completed: 8 },
    })
    expect(assistant.content.find((item) => item.type === "tool")).toMatchObject({
      state: { status: "completed", result: { value: "done" } },
    })
    expect(mounted.data.session.message.get(sessionID, "msg_user_race")).toMatchObject({ text: "race user" })
    expect(mounted.data.session.message.hot(sessionID).some((message) => message.type === "agent-switched")).toBe(true)
  } finally {
    mounted.destroy()
  }
})

test("committed reverts invalidate a captured list response before canonical refresh", async () => {
  const runningShell: SessionMessageInfo = {
    id: "msg_000980",
    type: "shell",
    shellID: "sh_revert_race",
    command: "printf race",
    status: "running",
    time: { created: 980 },
  }
  const completedShell: SessionMessageInfo = {
    ...runningShell,
    status: "exited",
    exit: 0,
    output: { output: "done", cursor: 4, size: 4, truncated: false },
    time: { created: 980, completed: 1003 },
  }
  const appended: SessionMessageInfo = {
    id: "msg_after_revert",
    type: "agent-switched",
    agent: "review",
    time: { created: 1004 },
  }
  const initial = historyPages().hot.map((message) => (message.id === runningShell.id ? runningShell : message))
  let requests = 0
  let settle!: (response: Response) => void
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    requests++
    if (requests === 1) return response(initial)
    if (requests === 2)
      return new Promise<Response>((resolve) => {
        settle = resolve
      })
    return response([appended, user(989), completedShell])
  })
  const emit = (value: object) => mounted.events.emit(value as YCodingEvent)

  try {
    await mounted.data.session.message.sync(sessionID)
    mounted.data.session.message.invalidate(sessionID)
    const syncing = mounted.data.session.message.sync(sessionID)
    await wait(() => settle !== undefined)

    for (const [seq, to] of ["msg_000995", "msg_000990"].entries())
      emit({
        id: `evt_revert_race_${seq}`,
        created: 1001 + seq,
        type: "session.revert.committed",
        location: { directory },
        durable: { aggregateID: sessionID, seq: seq + 1, version: 1 },
        data: { sessionID, to },
      })
    emit({
      id: "evt_shell_end_after_revert",
      created: 1003,
      type: "session.shell.ended",
      location: { directory },
      data: {
        sessionID,
        shell: { id: runningShell.shellID, status: "exited", exit: 0 },
        output: completedShell.output,
      },
    })
    emit({
      id: "evt_after_revert",
      created: 1004,
      type: "session.agent.selected",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 4, version: 1 },
      data: { sessionID, agent: "review" },
    })
    await wait(() => {
      const shell = mounted.data.session.message.get(sessionID, runningShell.id)
      return (
        mounted.data.session.message.get(sessionID, "msg_000990") === undefined &&
        shell?.type === "shell" &&
        shell.status === "exited" &&
        mounted.data.session.message.get(sessionID, "msg_after_revert") !== undefined
      )
    })

    settle(response(initial))
    await syncing
    const reverted = new Set(initial.filter((message) => message.id >= "msg_000990").map((message) => message.id))
    expect(mounted.data.session.message.hot(sessionID).some((message) => reverted.has(message.id))).toBe(false)
    expect(mounted.data.session.message.get(sessionID, runningShell.id)).toEqual(completedShell)
    expect(mounted.data.session.message.get(sessionID, appended.id)).toEqual(appended)

    expect(await mounted.data.session.message.expand(sessionID)).toBe(false)
    expect(requests).toBe(3)
    expect(mounted.data.session.message.hot(sessionID).map((message) => message.id)).toEqual([
      completedShell.id,
      "msg_000989",
      appended.id,
    ])
  } finally {
    mounted.destroy()
  }
})

test("timeline jump is immediate for resident targets", async () => {
  const calls: string[] = []
  const result = await resolveMessageJump({
    resident: () => true,
    load: async () => {
      calls.push("load")
      return false
    },
    settled: async () => {
      calls.push("settled")
    },
    jump: () => calls.push("jump"),
  })

  expect(result).toBe("resident")
  expect(calls).toEqual(["jump"])
})

test("timeline finds collapsed targets without retaining traversed pages", async () => {
  const pages = historyPages()
  const cursors: string[] = []
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    const cursor = url.searchParams.get("cursor")
    if (!cursor) return response(pages.hot, "cursor-1")
    cursors.push(cursor)
    if (cursor === "cursor-1") return response(pages.first, "cursor-2")
    if (cursor === "cursor-2") return response(pages.second)
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    const target = pages.second[100]!.id
    const jumped: string[] = []
    const result = await resolveMessageJump({
      resident: () => mounted.data.session.message.get(sessionID, target) !== undefined,
      load: () => mounted.data.session.message.find(sessionID, target),
      settled: async () => {},
      jump: () => jumped.push(target),
    })

    expect(result).toBe("loaded")
    expect(jumped).toEqual([target])
    expect(cursors).toEqual(["cursor-1", "cursor-2"])
    expect(mounted.data.session.message.page(sessionID)).toHaveLength(200)
    expect(mounted.data.session.message.page(sessionID).some((message) => message.id === pages.first[0]?.id)).toBe(false)
  } finally {
    mounted.destroy()
  }
})

test("timeline missing targets leave retryable history without a partial page", async () => {
  const pages = historyPages()
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    const cursor = url.searchParams.get("cursor")
    if (!cursor) return response(pages.hot, "cursor-1")
    if (cursor === "cursor-1") return response(pages.first, "cursor-2")
    if (cursor === "cursor-2") return response(pages.second)
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    const result = await resolveMessageJump({
      resident: () => false,
      load: () => mounted.data.session.message.find(sessionID, "msg_missing"),
      settled: async () => {},
      jump: () => {
        throw new Error("must not jump")
      },
    })

    expect(result).toBe("missing")
    expect(mounted.data.session.message.page(sessionID)).toEqual([])
    expect(mounted.data.session.message.history(sessionID).some((item) => item.state === "error")).toBe(true)
  } finally {
    mounted.destroy()
  }
})

test("exact target search ignores adversarial lexical IDs and always traverses from newest history", async () => {
  const first = [
    userWithID("msg_z_boundary", "first start"),
    userWithID("msg_a_target", "first target"),
    userWithID("msg_y_boundary", "first end"),
  ]
  const second = [
    userWithID("msg_0_boundary", "second start"),
    userWithID("msg_m_target", "second target"),
    userWithID("msg_zz_boundary", "second end"),
  ]
  const cursors: string[] = []
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    const cursor = url.searchParams.get("cursor")
    if (!cursor) return response(historyPages().hot, "cursor-1")
    cursors.push(cursor)
    if (cursor === "cursor-1") return response(first.toReversed(), "cursor-2")
    if (cursor === "cursor-2") return response(second.toReversed())
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    expect(await mounted.data.session.message.find(sessionID, "msg_m_target")).toBe(true)
    cursors.length = 0
    expect(await mounted.data.session.message.find(sessionID, "msg_a_target")).toBe(true)
    expect(cursors).toEqual(["cursor-1"])
  } finally {
    mounted.destroy()
  }
})

test("repeated cross-page jumps retain one page and stay bounded across 20 cycles", async () => {
  const pages = historyPages()
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    const cursor = url.searchParams.get("cursor")
    if (!cursor) return response(pages.hot, "cursor-1")
    if (cursor === "cursor-1") return response(pages.first, "cursor-2")
    if (cursor === "cursor-2") return response(pages.second)
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    for (let index = 0; index < 20; index++) {
      const page = index % 2 === 0 ? pages.first : pages.second
      const target = page[100]!.id
      expect(await mounted.data.session.message.find(sessionID, target)).toBe(true)
      expect(mounted.data.session.message.hot(sessionID)).toHaveLength(50)
      expect(mounted.data.session.message.page(sessionID)).toHaveLength(200)
      expect(mounted.data.session.message.list(sessionID)).toHaveLength(250)
      expect(mounted.data.session.message.list(sessionID).flatMap(payloads)).toHaveLength(250)
    }
    mounted.data.session.message.collapse(sessionID)
    expect(mounted.data.session.message.page(sessionID).flatMap(payloads)).toEqual([])
  } finally {
    mounted.destroy()
  }
})

test("placeholder metadata grows only by discovered cursors and retains no transcript payload", async () => {
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    const cursor = url.searchParams.get("cursor")
    if (!cursor) return response(historyPages().hot, "cursor-0")
    const page = Number(cursor.slice("cursor-".length))
    return response(
      [userWithID(`msg_page_${page}_new`, `new ${page}`), userWithID(`msg_page_${page}_old`, `old ${page}`)],
      page < 4 ? `cursor-${page + 1}` : undefined,
    )
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    expect(await mounted.data.session.message.find(sessionID, "msg_absent")).toBe(false)
    const placeholders = mounted.data.session.message.history(sessionID)
    expect(placeholders).toHaveLength(5)
    placeholders.forEach((placeholder) =>
      expect(Object.keys(placeholder).sort()).toEqual(
        expect.arrayContaining(["count", "cursor", "newestID", "oldestID", "sessionID", "state"]),
      ),
    )
    expect(JSON.stringify(placeholders)).not.toContain("new 0")
    expect(mounted.data.session.message.page(sessionID)).toEqual([])
  } finally {
    mounted.destroy()
  }
})

test("Solid proxy page payloads become unreachable after collapse", async () => {
  const pages = historyPages()
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    if (!url.searchParams.get("cursor")) return response(pages.hot, "cursor-1")
    return response(pages.first)
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    await mounted.data.session.message.expand(sessionID, "cursor-1")
    const weak = weakPagePayload(mounted.data)
    mounted.data.session.message.collapse(sessionID)
    await Bun.sleep(0)
    for (let index = 0; index < 5; index++) Bun.gc(true)
    expect(weak.message.deref()).toBeUndefined()
    expect(weak.file.deref()).toBeUndefined()
  } finally {
    mounted.destroy()
  }
})

test("revert, family navigation eviction, and disconnect release only affected resident history", async () => {
  const childID = "ses_history_child"
  const mounted = await mount((url) => {
    const match = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (!match) return
    if (!url.searchParams.get("cursor")) return response(historyPages().hot, `cursor-${match[1]}`)
    return response(historyPages().first)
  })

  try {
    await mounted.data.session.message.sync(sessionID)
    await mounted.data.session.message.sync(childID)
    await mounted.data.session.message.expand(sessionID, `cursor-${sessionID}`)
    await mounted.data.session.message.expand(childID, `cursor-${childID}`)
    mounted.events.emit({
      id: "evt_revert_history",
      created: 2000,
      type: "session.revert.staged",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: { sessionID, revert: { messageID: "msg_000990" } },
    })
    await wait(() => mounted.data.session.message.page(sessionID).length === 0)
    expect(mounted.data.session.message.page(childID)).toHaveLength(200)
    mounted.data.session.message.evict(sessionID)
    expect(mounted.data.session.message.hot(sessionID)).toEqual([])
    expect(mounted.data.session.message.page(childID)).toHaveLength(200)
    mounted.events.disconnect()
    await wait(() => mounted.data.session.message.page(childID).length === 0)
  } finally {
    mounted.destroy()
  }
})

test("changing the mounted family session evicts the previous transcript immediately", async () => {
  const childID = "ses_rows_child"
  const [current, setCurrent] = createSignal(sessionID)
  const mounted = await mountRows((url) => {
    const match = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (!match) return
    if (!url.searchParams.get("cursor")) return response(historyPages().hot, `cursor-${match[1]}`)
    return response(historyPages().first)
  }, current)

  try {
    await wait(() => mounted.data.session.message.hot(sessionID).length === 50)
    await mounted.data.session.message.expand(sessionID, `cursor-${sessionID}`)
    setCurrent(childID)
    await wait(
      () =>
        mounted.data.session.message.hot(sessionID).length === 0 &&
        mounted.data.session.message.hot(childID).length === 50,
    )
    expect(mounted.data.session.message.page(sessionID)).toEqual([])
  } finally {
    mounted.destroy()
  }
})

test("concurrent collapse, navigation, and events prevent stale expansion settlement", async () => {
  const sessions = ["ses_expand_collapse", "ses_expand_navigation", "ses_expand_event"]
  const pending = new Map<string, (response: Response) => void>()
  const mounted = await mount((url) => {
    const match = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (!match) return
    const id = match[1]!
    if (!url.searchParams.get("cursor")) return response(historyPages().hot, `cursor-${id}`)
    return new Promise<Response>((resolve) => pending.set(id, resolve))
  })

  try {
    for (const id of sessions) await mounted.data.session.message.sync(id)
    const expansions = sessions.map((id) => mounted.data.session.message.expand(id, `cursor-${id}`))
    await wait(() => pending.size === 3)
    mounted.data.session.message.collapse(sessions[0]!)
    mounted.data.session.message.evict(sessions[1]!)
    mounted.events.emit({
      id: "evt_expand_event",
      created: 2001,
      type: "session.agent.selected",
      location: { directory },
      durable: { aggregateID: sessions[2]!, seq: 1, version: 1 },
      data: { sessionID: sessions[2]!, agent: "review" },
    })
    pending.forEach((resolve) => resolve(response(historyPages().first)))
    expect(await Promise.all(expansions)).toEqual([false, false, false])
    sessions.forEach((id) => expect(mounted.data.session.message.page(id)).toEqual([]))
  } finally {
    mounted.destroy()
  }
})

function historyPages() {
  return {
    hot: descending(951, 1000),
    first: descending(751, 950),
    second: descending(551, 750),
  }
}

function richPage(): SessionMessageInfo[] {
  const rich = assistant(900, "completed")
  rich.content.push({
    type: "tool",
    id: "call_error_900",
    name: "subagent",
    state: {
      status: "error",
      input: { prompt: "delegate" },
      structured: { task: "ses_child" },
      content: [{ type: "file", uri: "file:///tmp/result.txt", mime: "text/plain", name: "result.txt" }],
      error: { type: "FixtureError", message: "failed" },
      result: { payload: "error result" },
    },
    time: { created: 900, completed: 901 },
  })
  return [
    user(899),
    rich,
    { id: "msg_000898", type: "synthetic", text: "synthetic", description: "visible", time: { created: 898 } },
    {
      id: "msg_000897",
      type: "shell",
      shellID: "sh_897",
      command: "printf output",
      status: "exited",
      exit: 0,
      output: { output: "shell output", cursor: 12, size: 12, truncated: false },
      time: { created: 897, completed: 898 },
    },
    {
      id: "msg_000896",
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "summary",
      recent: "recent",
      time: { created: 896 },
    },
    {
      id: "msg_000895",
      type: "skill",
      skill: "skill_fixture",
      name: "fixture",
      text: "skill body",
      conflicts: { skills: ["other"], instructions: ["AGENTS.md"] },
      time: { created: 895 },
    },
  ]
}

function descending(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => user(to - index))
}

function user(index: number): SessionMessageInfo {
  return {
    id: `msg_${index.toString().padStart(6, "0")}`,
    type: "user",
    text: `message ${index}`,
    files: [
      {
        data: Buffer.from(`payload ${index}`).toString("base64"),
        mime: "text/plain",
        source: { type: "inline" },
        name: `${index}.txt`,
      },
    ],
    agents: [{ name: "subagent" }],
    time: { created: index },
  }
}

function userWithID(id: string, text: string): SessionMessageInfo {
  return { id, type: "user", text, time: { created: 1 } }
}

function assistant(index: number, status: "running" | "completed"): SessionMessageAssistant {
  return {
    id: `msg_${index}`,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [
      { type: "text", text: "text" },
      { type: "reasoning", text: "reasoning", time: { created: index } },
      {
        type: "tool",
        id: `call_${index}`,
        name: "skill",
        state:
          status === "running"
            ? { status: "running", input: {}, structured: {}, content: [] }
            : { status: "completed", input: {}, structured: {}, content: [], result: { payload: `result ${index}` } },
        time: { created: index },
      },
    ],
    time: status === "running" ? { created: index } : { created: index, completed: index + 1 },
  }
}

function boundComplete(message: SessionMessageInfo) {
  if (message.type !== "assistant") return true
  return message.time.completed !== undefined
}

function payloads(message: SessionMessageInfo) {
  if (message.type === "user") return message.files?.map((file) => file.data) ?? []
  if (message.type === "shell") return message.output ? [message.output] : []
  if (message.type !== "assistant") return []
  return message.content.flatMap((content) => {
    if (content.type !== "tool") return []
    return "result" in content.state && content.state.result ? [content.state.result] : []
  })
}

function response(data: SessionMessageInfo[], next?: string) {
  return json({ data, cursor: { next } })
}

function weakPagePayload(data: ReturnType<typeof useData>) {
  const message = data.session.message.page(sessionID)[0]
  if (!message || message.type !== "user" || !message.files?.[0]) throw new Error("missing page payload")
  return { message: new WeakRef(message), file: new WeakRef(message.files[0]) }
}

function event(id: string, created: number): YCodingEvent {
  return {
    id,
    created,
    type: "session.agent.selected",
    location: { directory },
    durable: { aggregateID: sessionID, seq: created, version: 1 },
    data: { sessionID, agent: "build" },
  }
}

async function wait(condition: () => boolean) {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > 2000) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

async function mount(handler: Parameters<typeof createFetch>[0]) {
  const events = createEventStream()
  const calls = createFetch(handler, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  function Providers(props: ParentProps) {
    return (
      <TestTuiContexts>
        <ClientProvider api={createApi(calls.fetch)}>
          <DataProvider>{props.children}</DataProvider>
        </ClientProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => (
    <Providers>
      <Probe />
    </Providers>
  ))
  await mounted
  return { data, events, destroy: () => app.renderer.destroy() }
}

async function mountRows(handler: Parameters<typeof createFetch>[0], session: () => string) {
  const events = createEventStream()
  const calls = createFetch(handler, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    createSessionRows(session)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  return { data, destroy: () => app.renderer.destroy() }
}
