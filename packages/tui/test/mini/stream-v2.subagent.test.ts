import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { YCoding, type EventSubscribeOutput, type MessageListOutput } from "@ycoding-ai/client/promise"
import { createSessionTransport } from "../../src/mini/stream-v2.transport"
import { createFooterApiFixture } from "./fixture/footer-api"

type RunV2Event = EventSubscribeOutput

function feed() {
  const values: RunV2Event[] = []
  let closed = false
  let wake: (() => void) | undefined
  const stream = (async function* (): AsyncGenerator<RunV2Event, void, unknown> {
    while (!closed || values.length > 0) {
      if (values.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      const value = values.shift()
      if (value) yield value
    }
  })()
  return {
    stream,
    push(value: RunV2Event) {
      values.push(value)
      wake?.()
      wake = undefined
    },
    close() {
      closed = true
      wake?.()
      wake = undefined
    },
  }
}

function ok<T>(data: T) {
  return Promise.resolve(data)
}

function connected(id = "evt_connected") {
  return { id, type: "server.connected", data: {} } satisfies RunV2Event
}

function durable(sessionID: string, seq = 0) {
  return { aggregateID: sessionID, seq, version: 1 as const }
}

type SessionMessages = MessageListOutput["data"]

function sdk(input: {
  streams: ReturnType<typeof feed>[]
  active?: () => Record<string, { type: "running" }>
  messages?: Record<string, SessionMessages>
  sessions?: Array<{ id: string; parentID?: string; title?: string; agent?: string; time: { updated: number } }>
  // Reachable through `session.get` discovery only, never through `session.list`.
  discovered?: { id: string; parentID?: string; title?: string; agent?: string; time: { updated: number } }
}) {
  const client = YCoding.make({ baseUrl: "https://ycoding.test" })
  let subscription = 0
  spyOn(client.event, "subscribe").mockImplementation(() => input.streams[subscription++]?.stream ?? feed().stream)
  spyOn(client.message, "list").mockImplementation((request) =>
    ok({ data: input.messages?.[request.sessionID] ?? [], cursor: {} }),
  )
  spyOn(client.permission, "list").mockImplementation(() => ok([]))
  spyOn(client.form, "list").mockImplementation(() => ok([]))
  spyOn(client.form.request, "list").mockImplementation(() =>
    ok({
      location: { directory: "/tmp", workspaceID: undefined, project: { id: "proj_1", directory: "/tmp" } },
      data: [],
    }),
  )
  spyOn(client.session, "active").mockImplementation(() => ok(input.active?.() ?? {}))
  spyOn(client.session, "message").mockImplementation(() => Promise.reject(new Error("no message")))
  spyOn(client.session, "get").mockImplementation((request) =>
    input.discovered && request.sessionID === input.discovered.id
      ? (ok(input.discovered) as never)
      : Promise.reject(new Error("no session")),
  )
  spyOn(client.session, "list").mockImplementation((request) => {
    const parentID = request?.parentID
    return ok({
      location: { directory: "/tmp", project: { id: "proj_1", directory: "/tmp" } },
      data:
        input.sessions?.filter((session) =>
          parentID === undefined
            ? true
            : parentID === null
              ? session.parentID === undefined
              : session.parentID === parentID,
        ) ?? [],
    }) as never
  })
  spyOn(client.model, "default").mockImplementation(
    () =>
      ok({ location: { directory: "/tmp", project: { id: "proj_1", directory: "/tmp" } }, data: undefined }) as never,
  )
  return client
}

const MESSAGE_ID = "msg_parent"
const CALL_ID = "call_sub"

function subagentInputStarted() {
  return {
    id: "evt_sub_input",
    created: 1,
    type: "session.tool.input.started",
    durable: durable("ses_1", 0),
    data: { sessionID: "ses_1", assistantMessageID: MESSAGE_ID, callID: CALL_ID, name: "subagent" },
  } satisfies RunV2Event
}

function subagentCalled(background = false) {
  return {
    id: "evt_sub_called",
    created: 2,
    type: "session.tool.called",
    durable: durable("ses_1", 1),
    data: {
      sessionID: "ses_1",
      assistantMessageID: MESSAGE_ID,
      callID: CALL_ID,
      input: { agent: "explore", description: "Inspect auth", prompt: "go", ...(background ? { background } : {}) },
      executed: true,
    },
  } satisfies RunV2Event
}

function subagentProgress(childID: string) {
  return {
    id: "evt_sub_progress",
    created: 3,
    type: "session.tool.progress",
    durable: durable("ses_1", 2),
    data: {
      sessionID: "ses_1",
      assistantMessageID: MESSAGE_ID,
      callID: CALL_ID,
      structured: { sessionID: childID, status: "running" },
      content: [],
    },
  } satisfies RunV2Event
}

function subagentBackgrounded(childID: string) {
  return {
    id: "evt_sub_backgrounded",
    created: 4,
    type: "session.tool.success",
    durable: durable("ses_1", 3),
    data: {
      sessionID: "ses_1",
      assistantMessageID: MESSAGE_ID,
      callID: CALL_ID,
      structured: { sessionID: childID, status: "running", output: "" },
      content: [],
      executed: true,
    },
  } satisfies RunV2Event
}

function subagentToolFailed() {
  return {
    id: "evt_sub_failed",
    created: 9,
    type: "session.tool.failed",
    durable: durable("ses_1", 4),
    data: {
      sessionID: "ses_1",
      assistantMessageID: MESSAGE_ID,
      callID: CALL_ID,
      error: { type: "unknown", message: "Subagent cancelled" },
      executed: true,
    },
  } satisfies RunV2Event
}

function parentInterrupted() {
  return {
    id: "evt_parent_interrupted",
    created: 9,
    type: "session.execution.interrupted",
    durable: durable("ses_1", 4),
    data: { sessionID: "ses_1", reason: "user" },
  } satisfies RunV2Event
}

function launchLiveSubagent(events: ReturnType<typeof feed>, background = false, childID = "ses_child") {
  events.push(subagentInputStarted())
  events.push(subagentCalled(background))
  events.push(subagentProgress(childID))
}

function familySessions(count: number, running: string[] = []) {
  return Array.from({ length: count }, (_, index) => ({
    id: `ses_old_${index}`,
    parentID: "ses_1",
    title: `Historical ${index}`,
    agent: "explore",
    // Ascending, so ses_old_0 is the oldest settled entry.
    time: { updated: index + 1 },
  })).concat(
    running.map((id, index) => ({
      id,
      parentID: "ses_1",
      title: `Live ${id}`,
      agent: "explore",
      time: { updated: count + index + 1 },
    })),
  )
}

afterEach(() => {
  mock.restore()
})

describe("mini subagent tracker", () => {
  test("keeps a live running child when an in-place hydrate sees a stale active map", async () => {
    const events = feed()
    events.push(connected())
    // The subagent job is alive but has no in-flight child execution at the
    // moment the resize replay re-reads session.active.
    const client = sdk({ streams: [events], active: () => ({ ses_1: { type: "running" } }) })
    const ui = createFooterApiFixture()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
      replay: true,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    launchLiveSubagent(events)
    while (!states().some((state) => state.tabs.length > 0)) await Bun.sleep(0)

    await transport.replayOnResize({ reset: async () => {}, localRows: () => [] })

    expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "running" }])
    await transport.close()
  })

  test("keeps a live running child when hydration replays a still-running projected subagent call", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      active: () => ({ ses_1: { type: "running" } }),
      messages: {
        ses_1: [
          {
            id: MESSAGE_ID,
            type: "assistant" as const,
            agent: "build",
            model: { providerID: "test", id: "model" },
            time: { created: 1 },
            content: [
              {
                type: "tool" as const,
                id: CALL_ID,
                name: "subagent",
                state: {
                  status: "running" as const,
                  input: { agent: "explore", description: "Inspect auth", prompt: "go" },
                  structured: { sessionID: "ses_child", status: "running" },
                  content: [],
                },
                time: { created: 1, ran: 1 },
              },
            ],
          },
        ],
      },
    })
    const ui = createFooterApiFixture()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
      replay: true,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    launchLiveSubagent(events)
    while (!states().some((state) => state.tabs.length > 0)) await Bun.sleep(0)

    await transport.replayOnResize({ reset: async () => {}, localRows: () => [] })

    expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "running" }])
    await transport.close()
  })

  test("settles a live running child on reconnect when the active map no longer lists it", async () => {
    const first = feed()
    const second = feed()
    first.push(connected("evt_connected_1"))
    second.push(connected("evt_connected_2"))
    const client = sdk({ streams: [first, second], active: () => ({ ses_1: { type: "running" } }) })
    const ui = createFooterApiFixture()
    const transport = await createSessionTransport({
      sdk: client,
      sessionID: "ses_1",
      thinking: false,
      footer: ui.api,
    })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    launchLiveSubagent(first)
    while (!states().some((state) => state.tabs.some((tab) => tab.status === "running"))) await Bun.sleep(0)

    first.close()
    while (states().at(-1)?.tabs.some((tab) => tab.status === "running")) await Bun.sleep(0)

    expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "completed" }])
    await transport.close()
  })

  test("settles the child when its subagent tool call fails", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = createFooterApiFixture()
    const transport = await createSessionTransport({ sdk: client, sessionID: "ses_1", thinking: false, footer: ui.api })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    launchLiveSubagent(events)
    while (!states().some((state) => state.tabs.some((tab) => tab.status === "running"))) await Bun.sleep(0)

    events.push(subagentToolFailed())
    while (states().at(-1)?.tabs.some((tab) => tab.status === "running")) await Bun.sleep(0)

    expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "error" }])
    await transport.close()
  })

  test("settles a foreground child when the parent execution is interrupted", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = createFooterApiFixture()
    const transport = await createSessionTransport({ sdk: client, sessionID: "ses_1", thinking: false, footer: ui.api })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    launchLiveSubagent(events)
    while (!states().some((state) => state.tabs.some((tab) => tab.status === "running"))) await Bun.sleep(0)

    events.push(parentInterrupted())
    while (states().at(-1)?.tabs.some((tab) => tab.status === "running")) await Bun.sleep(0)

    expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "cancelled" }])
    await transport.close()
  })

  test("keeps a backgrounded child running when the parent execution is interrupted", async () => {
    const events = feed()
    events.push(connected())
    const client = sdk({ streams: [events] })
    const ui = createFooterApiFixture()
    const transport = await createSessionTransport({ sdk: client, sessionID: "ses_1", thinking: false, footer: ui.api })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    launchLiveSubagent(events, true)
    events.push(subagentBackgrounded("ses_child"))
    while (!states().some((state) => state.tabs.some((tab) => tab.background === true))) await Bun.sleep(0)

    events.push(parentInterrupted())
    await Bun.sleep(0)
    await Bun.sleep(0)
    await Bun.sleep(0)

    expect(states().at(-1)?.tabs).toMatchObject([{ sessionID: "ses_child", status: "running", background: true }])
    await transport.close()
  })
})

describe("mini subagent tracker family cap", () => {
  const CAP = 100

  async function boot(input: {
    sessions: ReturnType<typeof familySessions>
    active?: Record<string, { type: "running" }>
    discovered?: ReturnType<typeof familySessions>[number]
  }) {
    const events = feed()
    events.push(connected())
    const client = sdk({
      streams: [events],
      sessions: input.sessions,
      discovered: input.discovered,
      active: () => ({ ses_1: { type: "running" }, ...(input.active ?? {}) }),
    })
    const ui = createFooterApiFixture()
    const transport = await createSessionTransport({ sdk: client, sessionID: "ses_1", thinking: false, footer: ui.api })
    const states = () => ui.events.flatMap((event) => (event.type === "stream.subagent" ? [event.state] : []))
    return { client, events, transport, states }
  }

  const foundSession = { id: "ses_found", parentID: "ses_1", title: "Found", agent: "explore", time: { updated: 1 } }

  function foundStep() {
    return {
      id: "evt_found_step",
      created: 5,
      type: "session.step.started",
      durable: durable("ses_found", 0),
      data: {
        sessionID: "ses_found",
        assistantMessageID: "msg_found",
        agent: "explore",
        model: { providerID: "test", id: "model" },
      },
    } satisfies RunV2Event
  }

  test("admits a new subagent once the family cap is already full", async () => {
    const { events, transport, states } = await boot({ sessions: familySessions(CAP) })
    expect(states().at(-1)?.tabs).toHaveLength(CAP)

    launchLiveSubagent(events, false, "ses_new")
    while (!states().at(-1)?.tabs.some((tab) => tab.sessionID === "ses_new")) await Bun.sleep(0)

    const tabs = states().at(-1)?.tabs ?? []
    expect(tabs).toHaveLength(CAP)
    expect(tabs.find((tab) => tab.sessionID === "ses_new")).toMatchObject({ status: "running" })
    // Oldest settled entry sheds first.
    expect(tabs.some((tab) => tab.sessionID === "ses_old_0")).toBe(false)
    expect(tabs.some((tab) => tab.sessionID === `ses_old_${CAP - 1}`)).toBe(true)
    await transport.close()
  })

  test("never evicts a running child while settled children remain", async () => {
    const { events, transport, states } = await boot({
      sessions: familySessions(CAP - 1, ["ses_live"]),
      active: { ses_live: { type: "running" } },
    })
    expect(states().at(-1)?.tabs.find((tab) => tab.sessionID === "ses_live")).toMatchObject({ status: "running" })

    launchLiveSubagent(events, false, "ses_new")
    while (!states().at(-1)?.tabs.some((tab) => tab.sessionID === "ses_new")) await Bun.sleep(0)

    const tabs = states().at(-1)?.tabs ?? []
    expect(tabs).toHaveLength(CAP)
    // ses_live is the oldest-updated entry overall, but it is running, so the
    // oldest settled entry is shed instead.
    expect(tabs.find((tab) => tab.sessionID === "ses_live")).toMatchObject({ status: "running" })
    expect(tabs.some((tab) => tab.sessionID === "ses_old_0")).toBe(false)
    await transport.close()
  })

  test("grows past the cap rather than dropping a live child when every entry is running", async () => {
    const running = Array.from({ length: CAP }, (_, index) => `ses_live_${index}`)
    const { events, transport, states } = await boot({
      sessions: familySessions(0, running),
      active: Object.fromEntries(running.map((id) => [id, { type: "running" as const }])),
    })
    expect(states().at(-1)?.tabs).toHaveLength(CAP)

    launchLiveSubagent(events, false, "ses_new")
    while (!states().at(-1)?.tabs.some((tab) => tab.sessionID === "ses_new")) await Bun.sleep(0)

    const tabs = states().at(-1)?.tabs ?? []
    expect(tabs).toHaveLength(CAP + 1)
    expect(tabs.filter((tab) => tab.status === "running")).toHaveLength(CAP + 1)
    await transport.close()
  })

  test("keeps the selected child when the cap sheds a settled entry", async () => {
    const { events, transport, states } = await boot({ sessions: familySessions(CAP) })
    transport.selectSubagent("ses_old_0")
    while (!states().at(-1)?.details.ses_old_0) await Bun.sleep(0)

    launchLiveSubagent(events, false, "ses_new")
    while (!states().at(-1)?.tabs.some((tab) => tab.sessionID === "ses_new")) await Bun.sleep(0)

    const tabs = states().at(-1)?.tabs ?? []
    expect(tabs).toHaveLength(CAP)
    expect(tabs.some((tab) => tab.sessionID === "ses_old_0")).toBe(true)
    expect(tabs.some((tab) => tab.sessionID === "ses_old_1")).toBe(false)
    await transport.close()
  })

  test("discovers an indirect child at the cap by shedding a settled entry", async () => {
    const { events, transport, states } = await boot({ sessions: familySessions(CAP), discovered: foundSession })
    expect(states().at(-1)?.tabs).toHaveLength(CAP)

    events.push(foundStep())
    // Bounded: a skipped discovery emits nothing, so the assertions must fail.
    for (let tick = 0; tick < 50 && !states().at(-1)?.tabs.some((tab) => tab.sessionID === "ses_found"); tick++)
      await Bun.sleep(0)

    const tabs = states().at(-1)?.tabs ?? []
    expect(tabs).toHaveLength(CAP)
    expect(tabs.find((tab) => tab.sessionID === "ses_found")).toMatchObject({ status: "running" })
    expect(tabs.some((tab) => tab.sessionID === "ses_old_0")).toBe(false)
    await transport.close()
  })

  test("skips discovery at the cap when every entry is running", async () => {
    const running = Array.from({ length: CAP }, (_, index) => `ses_live_${index}`)
    const { client, events, transport, states } = await boot({
      sessions: familySessions(0, running),
      active: Object.fromEntries(running.map((id) => [id, { type: "running" as const }])),
      discovered: foundSession,
    })
    expect(states().at(-1)?.tabs).toHaveLength(CAP)
    const lookups = (client.session.get as ReturnType<typeof spyOn>).mock.calls.length

    events.push(foundStep())
    for (let tick = 0; tick < 50; tick++) await Bun.sleep(0)

    // No slot can be won, so the lookup is never issued and the list stays capped.
    expect((client.session.get as ReturnType<typeof spyOn>).mock.calls).toHaveLength(lookups)
    expect(states().at(-1)?.tabs).toHaveLength(CAP)
    expect(states().at(-1)?.tabs.some((tab) => tab.sessionID === "ses_found")).toBe(false)
    await transport.close()
  })
})
