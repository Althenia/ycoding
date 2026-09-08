/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type {
  ProviderRequestSummary,
  SessionMessageInfo,
  YCodingEvent,
  SessionOrchestrationTask,
} from "@ycoding-ai/client"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { EventV2 } from "@ycoding-ai/core/event"
import { createEffect, onMount, type ParentProps } from "solid-js"
import { ClientProvider, useClient } from "../../../src/context/client"
import { DataProvider as DataProviderBase, useData } from "../../../src/context/data"
import { LocationProvider, useLocation } from "../../../src/context/location"
import { createSessionRows, type SessionRow } from "../../../src/routes/session/rows"
import { createApi, createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"

type KeyedSessionRow = SessionRow & { key: string }

const formFields = [{ key: "authorization", type: "external", url: "https://example.com" }] satisfies [
  {
    key: string
    type: "external"
    url: string
  },
]

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function emitEvent(events: ReturnType<typeof createEventStream>, event: YCodingEvent) {
  events.emit({ ...event, location: { directory } })
}

function DataProvider(props: ParentProps) {
  return (
    <DataProviderBase>
      <LocationProvider>
        <SyncLocation />
        {props.children}
      </LocationProvider>
    </DataProviderBase>
  )
}

function ProjectProvider(props: ParentProps) {
  return props.children
}

function SyncLocation() {
  const data = useData()
  const location = useLocation()
  createEffect(() => location.set(data.location.default()))
  return null
}

function durable(sessionID: string, seq?: number): { aggregateID: string; seq: number; version: 1 }
function durable<const Version extends number>(
  sessionID: string,
  seq: number,
  version: Version,
): { aggregateID: string; seq: number; version: Version }
function durable(sessionID: string, seq = 0, version = 1) {
  return { aggregateID: sessionID, seq, version }
}

function subagentPage(data: SessionOrchestrationTask[], cursor: { previous?: string; next?: string } = {}) {
  return {
    data,
    summary: {
      total: data.length,
      active: data.filter((task) => ["starting", "running", "waiting", "cancelling"].includes(task.state)).length,
      running: data.filter((task) => task.state === "running").length,
      waiting: data.filter((task) => task.state === "waiting").length,
    },
    cursor,
  }
}

test("releases rows through a completed V2 compaction boundary after each canonical reconcile", async () => {
  const sessionID = "session-v2-compaction-resident"
  const resident: SessionMessageInfo[] = [
    {
      id: "msg_original",
      type: "user",
      text: "Keep this resident message",
      files: [],
      agents: [],
      time: { created: 1 },
    },
  ]
  const canonical: SessionMessageInfo[] = [
    ...resident,
    {
      id: "msg_boundary",
      type: "user",
      text: "Release this boundary message too",
      files: [],
      agents: [],
      time: { created: 2 },
    },
    {
      id: "msg_compaction_job",
      type: "compaction",
      jobID: "cmp_resident",
      trigger: "advised",
      status: "completed",
      revision: 1,
      boundary: { messageID: "msg_boundary", seq: 2 },
      metrics: { excludedMessages: 2, excludedParts: 0, inputTokens: 1_000, retainedTokens: 400 },
      time: { created: 3 },
    },
  ]
  const events = createEventStream()
  let messageRequests = 0
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) {
      messageRequests++
      // A fresh process receives complete durable history plus the projected
      // compaction marker; resident pruning must happen in the same publication.
      return json({ data: canonical, cursor: {} })
    }
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  const publications: string[][] = []

  function Probe() {
    data = useData()
    createEffect(() => publications.push(data.session.message.list(sessionID).map((message) => message.id)))
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  app.renderer.start()
  await app.waitForFrame((frame) => frame.length > 0)

  try {
    await data.session.message.sync(sessionID)
    const residentMessageIDs = () => data.session.message.list(sessionID).map((message) => message.id)
    const compaction = () => data.session.compaction.get(sessionID, "cmp_resident")
    expect(residentMessageIDs()).toEqual(["msg_compaction_job"])
    expect(publications).not.toContainEqual(resident.map((message) => message.id))
    expect(compaction()).toMatchObject({
      jobID: "cmp_resident",
      messageID: "msg_compaction_job",
      trigger: "advised",
      status: "completed",
    })

    publications.length = 0
    data.session.message.invalidate(sessionID)
    await data.session.message.sync(sessionID)
    expect(residentMessageIDs()).toEqual(["msg_compaction_job"])
    expect(publications).toEqual([["msg_compaction_job"]])
    expect(data.session.message.list(sessionID).filter((message) => message.type === "compaction")).toHaveLength(1)
    expect(compaction()).toMatchObject({ status: "completed" })
    expect(messageRequests).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("preloads root sessions before applying the session limit", async () => {
  const events = createEventStream()
  let request: URL | undefined
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") request = url
    return undefined
  }, events)

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <box />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => request !== undefined)
    expect(request?.searchParams.get("project")).toBe("proj_test")
    expect(request?.searchParams.get("limit")).toBe("50")
    expect(request?.searchParams.get("parentID")).toBe("null")
  } finally {
    app.renderer.destroy()
  }
})

test("bootstraps MCP data for the TUI location", async () => {
  const events = createEventStream()
  const requests: URL[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/api/mcp" || url.pathname === "/api/mcp/resource") requests.push(url)
    return undefined
  }, events)

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <box />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => requests.length === 2)
    expect(requests.map((url) => url.searchParams.get("location[directory]"))).toEqual([directory, directory])
  } finally {
    app.renderer.destroy()
  }
})

test("syncs MCP status when a connection settles during bootstrap", async () => {
  const events = createEventStream()
  let mcpRequests = 0
  let resolveModels!: (response: Response) => void
  const calls = createFetch((url) => {
    if (url.pathname === "/api/mcp") {
      mcpRequests++
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: [
          {
            name: "context7",
            status: { status: mcpRequests === 1 ? "pending" : "connected" },
          },
        ],
      })
    }
    if (url.pathname === "/api/model")
      return new Promise<Response>((resolve) => {
        resolveModels = resolve
      })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => data.location.mcp.server.list()?.[0]?.status.status === "pending")
    emitEvent(events, {
      id: "evt_mcp_connected",
      created: 1,
      type: "mcp.status.changed",
      data: { server: "context7" },
    })
    await wait(() => data.location.mcp.server.list()?.[0]?.status.status === "connected")
    expect(mcpRequests).toBe(2)
    resolveModels(
      json({
        location: { directory, project: { id: "proj_test", directory } },
        data: [],
      }),
    )
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes resources into reactive getters", async () => {
  const events = createEventStream()
  const location = {
    directory,
    project: { id: "proj_test", directory },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_test")
      return json({
        data: {
          id: "ses_test",
          projectID: "proj_test",
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: { created: 0, updated: 0 },
          title: "Test session",
          location: { directory },
        },
      })
    if (url.pathname === "/api/session/ses_test/message")
      return json({
        data: [
          {
            id: "msg_second",
            created: 0,
            type: "user",
            text: "Second",
            time: { created: 2 },
          },
          {
            id: "msg_first",
            created: 0,
            type: "user",
            text: "First",
            time: { created: 1 },
          },
        ],
        cursor: {},
      })
    if (url.pathname === "/api/agent")
      return json({
        location,
        data: [
          {
            id: "build",
            request: { headers: {}, body: {} },
            mode: "primary",
            hidden: false,
            permissions: [],
          },
        ],
      })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <text>{data.session.message.get("ses_test", "msg_second")?.id ?? "missing"}</text>
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    expect(data.location.default()).toEqual({ directory: process.cwd() })
    expect(data.session.get("ses_test")).toBeUndefined()
    expect(data.location.agent.list(location)).toBeUndefined()

    await data.session.sync("ses_test")
    await data.session.message.sync("ses_test")
    await data.location.agent.sync()

    expect(data.session.get("ses_test")?.title).toBe("Test session")
    expect(data.session.message.list("ses_test").map((message) => message.id)).toEqual(["msg_second", "msg_first"])
    expect(data.session.message.get("ses_test", "msg_second")?.id).toBe("msg_second")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("msg_second")
    expect(data.location.default()).toEqual({
      directory,
      workspaceID: undefined,
    })
    expect(data.location.agent.list(location)?.map((agent) => agent.id)).toEqual(["build"])
  } finally {
    app.renderer.destroy()
  }
})

test("applies absolute usage events to session info", async () => {
  const events = createEventStream()
  const sessionID = "ses_usage_refresh"
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "proj_test",
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: { created: 0, updated: 0 },
          title: "Usage",
          location: { directory },
        },
      })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await data.session.sync(sessionID)
    emitEvent(events, {
      id: "evt_usage_2",
      created: 2,
      type: "session.usage.updated",
      data: {
        sessionID,
        cost: 0.5,
        tokens: {
          input: 5,
          output: 2,
          reasoning: 1,
          cache: { read: 1, write: 1 },
        },
      },
    })
    await wait(() => data.session.get(sessionID)?.cost === 0.5)
    expect(data.session.get(sessionID)?.tokens).toEqual({
      input: 5,
      output: 2,
      reasoning: 1,
      cache: { read: 1, write: 1 },
    })

    emitEvent(events, {
      id: "evt_usage_3",
      created: 3,
      type: "session.usage.updated",
      data: {
        sessionID,
        cost: 1,
        tokens: {
          input: 10,
          output: 4,
          reasoning: 1,
          cache: { read: 1, write: 1 },
        },
      },
    })
    await wait(() => data.session.get(sessionID)?.cost === 1)
    expect(data.session.get(sessionID)?.title).toBe("Usage")

    emitEvent(events, {
      id: "evt_usage_deleted",
      created: 9,
      type: "session.deleted",
      durable: durable(sessionID, 9, 2),
      data: { sessionID },
    })
    await wait(() => data.session.get(sessionID) === undefined)
  } finally {
    app.renderer.destroy()
  }
})

test("truncates committed revert messages without changing lifetime usage", async () => {
  const events = createEventStream()
  const sessionID = "ses_revert_usage"
  let cost = 0
  let tokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
    if (url.pathname !== `/api/session/${sessionID}`) return
    return json({
      data: {
        id: sessionID,
        projectID: "proj_test",
        cost,
        tokens,
        time: { created: 0, updated: 0 },
        title: "Revert usage",
        location: { directory },
      },
    })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await data.session.sync(sessionID)
    emitEvent(events, {
      id: "evt_revert_boundary_started",
      created: 1,
      type: "session.step.started",
      durable: durable(sessionID, 1),
      data: {
        sessionID,
        assistantMessageID: "msg_revert_boundary",
        agent: "build",
        model: { providerID: "provider", id: "model" },
      },
    })
    cost = 0.5
    tokens = {
      input: 5,
      output: 2,
      reasoning: 1,
      cache: { read: 1, write: 1 },
    }
    emitEvent(events, {
      id: "evt_revert_boundary_ended",
      created: 2,
      type: "session.step.ended",
      durable: durable(sessionID, 2),
      data: {
        sessionID,
        assistantMessageID: "msg_revert_boundary",
        finish: "stop",
        cost: 0.5,
        tokens,
      },
    })
    emitEvent(events, {
      id: "evt_revert_boundary_usage",
      created: 2,
      type: "session.usage.updated",
      data: { sessionID, cost, tokens },
    })
    await wait(() => data.session.get(sessionID)?.cost === 0.5)

    emitEvent(events, {
      id: "evt_revert_later_started",
      created: 3,
      type: "session.step.started",
      durable: durable(sessionID, 3),
      data: {
        sessionID,
        assistantMessageID: "msg_revert_later",
        agent: "build",
        model: { providerID: "provider", id: "model" },
      },
    })
    cost = 0.75
    tokens = {
      input: 8,
      output: 3,
      reasoning: 1,
      cache: { read: 1, write: 1 },
    }
    emitEvent(events, {
      id: "evt_revert_later_ended",
      created: 4,
      type: "session.step.ended",
      durable: durable(sessionID, 4),
      data: {
        sessionID,
        assistantMessageID: "msg_revert_later",
        finish: "stop",
        cost: 0.25,
        tokens: {
          input: 3,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    })
    emitEvent(events, {
      id: "evt_revert_later_usage",
      created: 4,
      type: "session.usage.updated",
      data: { sessionID, cost, tokens },
    })
    await wait(() => data.session.get(sessionID)?.cost === 0.75)
    emitEvent(events, {
      id: "evt_revert_staged",
      created: 5,
      type: "session.revert.staged",
      durable: durable(sessionID, 5),
      data: { sessionID, revert: { messageID: "msg_revert_later" } },
    })
    await wait(() => data.session.get(sessionID)?.revert?.messageID === "msg_revert_later")

    emitEvent(events, {
      id: "evt_revert_committed",
      created: 6,
      type: "session.revert.committed",
      durable: durable(sessionID, 6),
      data: { sessionID, to: "msg_revert_later" },
    })
    await wait(() => data.session.message.list(sessionID).length === 1)
    expect(data.session.get(sessionID)?.cost).toBe(0.75)
    expect(data.session.message.list(sessionID).map((message) => message.id)).toEqual(["msg_revert_boundary"])
    expect(data.session.get(sessionID)?.revert).toBeUndefined()
    expect(data.session.get(sessionID)?.tokens).toEqual(tokens)
  } finally {
    app.renderer.destroy()
  }
})

test("projects live archive and unarchive without changing session activity", async () => {
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_test")
      return json({
        data: {
          id: "ses_test",
          projectID: "proj_test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 100 },
          title: "Test session",
          location: { directory },
        },
      })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  let client!: ReturnType<typeof useClient>
  function Probe() {
    data = useData()
    client = useClient()
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  try {
    await wait(() => client.connection.status() === "connected")
    await data.session.sync("ses_test")
    const updated = data.session.get("ses_test")?.time.updated
    expect(data.session.get("ses_test")).toBeDefined()
    emitEvent(events, {
      id: "evt_archived",
      created: 1_000,
      type: "session.archived",
      durable: durable("ses_test", 1, 2),
      data: { sessionID: "ses_test" },
    })
    await wait(() => data.session.get("ses_test")?.time.archived === 1_000)
    expect(data.session.get("ses_test")?.time.updated).toBe(updated)
    emitEvent(events, {
      id: "evt_unarchived",
      created: 2_000,
      type: "session.unarchived",
      durable: durable("ses_test", 2, 2),
      data: { sessionID: "ses_test" },
    })
    await wait(() => data.session.get("ses_test")?.time.archived === undefined)
    expect(data.session.get("ses_test")?.time.updated).toBe(updated)
  } finally {
    app.renderer.destroy()
  }
})

test("updates session location when moved", async () => {
  const events = createEventStream()
  const destination = "/tmp/ycoding-moved"
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_test")
      return json({
        data: {
          id: "ses_test",
          projectID: "proj_test",
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: { created: 0, updated: 0 },
          title: "Test session",
          location: { directory },
        },
      })
  }, events)
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

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await data.session.sync("ses_test")
    emitEvent(events, {
      id: "evt_moved_1",
      created: 1,
      type: "session.moved",
      durable: durable("ses_test"),
      data: {
        sessionID: "ses_test",
        location: { directory: destination },
        projectID: "project-moved",
        subpath: "packages/cli",
      },
    })
    await wait(() => data.session.get("ses_test")?.location.directory === destination)
    expect(data.session.get("ses_test")?.projectID).toBe("project-moved")
    expect(data.session.get("ses_test")?.subpath).toBe("packages/cli")
  } finally {
    app.renderer.destroy()
  }
})

test("reconnects the event stream and resyncs active data", async () => {
  const events = createEventStream()
  const requests = { active: 0, event: 0, message: 0, model: 0 }
  let resolveActive!: (response: Response) => void
  let resolveMessages!: (response: Response) => void
  const calls = createFetch((url) => {
    if (url.pathname === "/api/event") {
      requests.event++
      return events.v2()
    }
    if (url.pathname === "/api/session/active") {
      requests.active++
      if (requests.active === 1) return json({ data: { "session-stale": { type: "running" } } })
      return new Promise<Response>((resolve) => {
        resolveActive = resolve
      })
    }
    if (url.pathname === "/api/session/session-stale/message") {
      requests.message++
      if (requests.message === 1)
        return json({
          data: [
            {
              id: "message-stale",
              type: "user",
              text: "Stale",
              time: { created: 1 },
            },
          ],
          cursor: {},
        })
      return new Promise<Response>((resolve) => {
        resolveMessages = resolve
      })
    }
    if (url.pathname !== "/api/model") return
    requests.model++
    return json({
      location: { directory, project: { id: "proj_test", directory } },
      data: [
        {
          id: `model-${requests.model}`,
          providerID: "provider",
          name: `Model ${requests.model}`,
          api: { type: "native" },
          capabilities: { tools: false, input: [], output: [] },
          cost: [],
          limit: { context: 1, output: 1 },
          request: { headers: {}, body: {} },
          status: "active",
          time: { released: 0 },
          variants: [],
        },
      ],
    })
  }, events)
  let data!: ReturnType<typeof useData>
  let client!: ReturnType<typeof useClient>

  function Probe() {
    data = useData()
    client = useClient()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => data.location.model.list()?.[0]?.id === "model-1")
    await wait(() => data.session.status("session-stale") === "running")
    await data.session.message.sync("session-stale")
    expect(data.session.message.get("session-stale", "message-stale")?.id).toBe("message-stale")
    expect(client.connection.status()).toBe("connected")
    expect(client.connection.attempt()).toBe(0)

    events.disconnect()
    await wait(() => client.connection.status() === "reconnecting")
    expect(client.connection.attempt()).toBe(1)
    expect(client.connection.error()).toBe("Event stream disconnected")

    await wait(() => requests.active === 2 && client.connection.status() === "connected", 4000)
    resolveActive(json({ data: { "session-new": { type: "running" } } }))
    void data.session.message.sync("session-stale")

    await wait(() => data.location.model.list()?.[0]?.id === "model-2", 4000)
    await wait(() => data.session.status("session-stale") === "idle")
    await wait(() => requests.message === 2)
    expect(data.session.message.get("session-stale", "message-stale")?.id).toBe("message-stale")
    resolveMessages(
      json({
        data: [
          {
            id: "message-fresh",
            type: "user",
            text: "Fresh",
            time: { created: 2 },
          },
        ],
        cursor: {},
      }),
    )
    await wait(() => data.session.message.get("session-stale", "message-fresh") !== undefined)
    expect(data.session.message.get("session-stale", "message-stale")).toBeUndefined()
    await wait(() => data.session.status("session-new") === "running")
    expect(requests.event).toBe(2)
    expect(requests.message).toBe(2)
    expect(client.connection.status()).toBe("connected")
    expect(client.connection.attempt()).toBe(0)
    expect(client.connection.error()).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("completes exploration when a queued prompt is promoted", async () => {
  const events = createEventStream()
  const sessionID = "session-promotion"
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  }, events)
  let rows!: ReturnType<typeof createSessionRows>
  let client!: ReturnType<typeof useClient>
  let data!: ReturnType<typeof useData>

  function Probe() {
    client = useClient()
    data = useData()
    rows = createSessionRows(() => sessionID)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => client.connection.status() === "connected")
    emitEvent(events, {
      id: "evt_execution_started",
      created: 0,
      type: "session.execution.started",
      durable: durable(sessionID),
      data: { sessionID },
    })
    await wait(() => data.session.status(sessionID) === "running")
    emitEvent(events, {
      id: "evt_step_started",
      created: 1,
      type: "session.step.started",
      durable: durable(sessionID),
      data: {
        sessionID,
        assistantMessageID: "message-assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    emitEvent(events, {
      id: "evt_tool_started",
      created: 2,
      type: "session.tool.input.started",
      durable: durable(sessionID, 1),
      data: {
        sessionID,
        assistantMessageID: "message-assistant",
        callID: "call-read",
        name: "read",
      },
    })
    await wait(() => rows.some((row) => row.type === "group" && !row.completed))

    emitEvent(events, {
      id: "evt_prompt_admitted",
      created: 3,
      type: "session.input.admitted",
      durable: durable(sessionID, 2),
      data: {
        sessionID,
        inputID: "message-user",
        input: { type: "user", data: { text: "Continue" }, delivery: "steer" },
      },
    })
    await wait(() => rows.at(-1)?.type === "message")
    expect(rows.find((row) => row.type === "group")?.completed).toBe(false)

    emitEvent(events, {
      id: "evt_prompt_promoted",
      created: 4,
      type: "session.input.promoted",
      durable: durable(sessionID, 3),
      data: { sessionID, inputID: "message-user" },
    })
    await wait(() => rows.find((row) => row.type === "group")?.completed === true)
    expect(rows.at(-1) as KeyedSessionRow).toEqual({
      type: "message",
      messageID: "message-user",
      key: "message:message-user",
    })

    emitEvent(events, {
      id: "evt_prompt_consumed",
      created: 5,
      type: "session.input.consumed",
      durable: durable(sessionID, 4),
      data: { sessionID, inputIDs: ["message-user"] },
    })
    await wait(() => {
      const message = data.session.message.get(sessionID, "message-user")
      return message?.type === "user" && message.time.consumed === 5
    })
  } finally {
    app.renderer.destroy()
  }
})

test("classifies live tool rows independently of their call ID", async () => {
  const events = createEventStream()
  const sessionID = "session-tool-call-id"
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  }, events)
  let rows!: ReturnType<typeof createSessionRows>
  let client!: ReturnType<typeof useClient>

  function Probe() {
    client = useClient()
    rows = createSessionRows(() => sessionID)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => client.connection.status() === "connected")
    emitEvent(events, {
      id: "evt_tool_started",
      created: 1,
      type: "session.tool.input.started",
      durable: durable(sessionID),
      data: {
        sessionID,
        assistantMessageID: "message-assistant",
        callID: "reasoning:0",
        name: "bash",
      },
    })

    await wait(() => rows.length > 0)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: "part",
      ref: { messageID: "message-assistant", partID: "reasoning:0" },
    })
    expect(Reflect.get(rows[0] ?? {}, "key")).toBe("part:message-assistant:reasoning:0")
  } finally {
    app.renderer.destroy()
  }
})

test("removes committed revert messages from local state", async () => {
  const events = createEventStream()
  const sessionID = "session-revert"
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    for (const [seq, inputID] of ["msg_001", "msg_002", "msg_003"].entries()) {
      emitEvent(events, {
        id: EventV2.ID.create(),
        created: seq,
        type: "session.input.admitted",
        durable: durable(sessionID, seq),
        data: {
          sessionID,
          inputID,
          input: { type: "user", data: { text: inputID }, delivery: "steer" },
        },
      })
    }
    await wait(() => data.session.message.list(sessionID).length === 3)

    emitEvent(events, {
      id: EventV2.ID.create(),
      created: 3,
      type: "session.revert.committed",
      durable: durable(sessionID, 3),
      data: { sessionID, to: "msg_002" },
    })

    await wait(() => data.session.message.list(sessionID).length === 1)
    expect(data.session.message.list(sessionID).map((message) => message.id)).toEqual(["msg_001"])
    expect(data.session.message.get(sessionID, "msg_002")).toBeUndefined()
    expect(data.session.message.get(sessionID, "msg_003")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("distinguishes initial connection from reconnection", async () => {
  const encoder = new TextEncoder()
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const eventResponse = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  const connect = () =>
    stream?.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ id: "evt_connected", created: 0, type: "server.connected", data: {} })}\n\n`,
      ),
    )
  const disconnect = () => {
    stream?.close()
    stream = undefined
  }

  const calls = createFetch((url) => {
    if (url.pathname === "/api/event") return eventResponse()
  })
  let client!: ReturnType<typeof useClient>

  function Probe() {
    client = useClient()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => stream !== undefined)
    expect(client.connection.status()).toBe("connecting")

    connect()
    await wait(() => client.connection.status() === "connected")

    disconnect()
    await wait(() => client.connection.status() === "reconnecting")
  } finally {
    app.renderer.destroy()
  }
})

test("tracks session status from active sessions and execution events", async () => {
  const events = createEventStream()
  let settled = false
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/active") return json({ data: { "session-active": { type: "running" } } })
    if (url.pathname === "/api/session/session-live")
      return json({
        data: {
          id: "session-live",
          projectID: "proj_test",
          cost: settled ? 0.75 : 0,
          tokens: settled
            ? {
                input: 10,
                output: 4,
                reasoning: 2,
                cache: { read: 3, write: 1 },
              }
            : {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
          time: { created: 0, updated: 0 },
          title: "Live session",
          location: { directory },
        },
      })
    if (url.pathname === "/api/session/session-failed")
      return json({
        data: {
          id: "session-failed",
          projectID: "proj_test",
          cost: 0.25,
          tokens: {
            input: 5,
            output: 1,
            reasoning: 1,
            cache: { read: 1, write: 0 },
          },
          time: { created: 0, updated: 0 },
          title: "Failed session",
          location: { directory },
        },
      })
  }, events)
  let data!: ReturnType<typeof useData>
  let rows!: SessionRow[]

  function Probe() {
    data = useData()
    rows = createSessionRows(() => "session-retry")
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => data.session.status("session-active") === "running")
    expect(data.session.status("session-idle")).toBe("idle")
    await data.session.sync("session-live")

    settled = true
    emitEvent(events, {
      id: "evt_execution_started",
      created: 0,
      type: "session.execution.started",
      durable: durable("session-live"),
      data: { sessionID: "session-live" },
    })
    await wait(() => data.session.status("session-live") === "running")

    emitEvent(events, {
      id: "evt_step_started",
      created: 0,
      type: "session.step.started",
      durable: durable("session-live"),
      data: {
        sessionID: "session-live",
        assistantMessageID: "message-live",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    emitEvent(events, {
      id: "evt_live_retry_scheduled",
      created: 0,
      type: "session.retry.scheduled",
      durable: durable("session-live", 1),
      data: {
        sessionID: "session-live",
        assistantMessageID: "message-live",
        attempt: 2,
        at: 2_000,
        error: { type: "provider.transport", message: "Disconnected" },
      },
    })
    await wait(() => {
      const assistant = data.session.message.get("session-live", "message-live")
      return assistant?.type === "assistant" && assistant.retry?.attempt === 2
    })
    emitEvent(events, {
      id: "evt_step_ended",
      created: 3_000,
      type: "session.step.ended",
      durable: durable("session-live", 1),
      data: {
        sessionID: "session-live",
        assistantMessageID: "message-live",
        finish: "stop",
        cost: 0.75,
        tokens: {
          input: 10,
          output: 4,
          reasoning: 2,
          cache: { read: 3, write: 1 },
        },
      },
    })
    emitEvent(events, {
      id: "evt_step_usage",
      created: 0,
      type: "session.usage.updated",
      data: {
        sessionID: "session-live",
        cost: 0.75,
        tokens: {
          input: 10,
          output: 4,
          reasoning: 2,
          cache: { read: 3, write: 1 },
        },
      },
    })
    await wait(() => {
      const assistant = data.session.message.get("session-live", "message-live")
      return assistant?.type === "assistant" && assistant.finish === "stop"
    })
    await wait(() => data.session.get("session-live")?.cost === 0.75)
    expect(data.session.status("session-live")).toBe("running")
    expect(data.session.get("session-live")).toMatchObject({
      cost: 0.75,
      tokens: {
        input: 10,
        output: 4,
        reasoning: 2,
        cache: { read: 3, write: 1 },
      },
    })

    emitEvent(events, {
      id: "evt_execution_succeeded",
      created: 4_000,
      type: "session.execution.succeeded",
      durable: durable("session-live", 1),
      data: { sessionID: "session-live" },
    })
    await wait(() => data.session.status("session-live") === "idle")
    const retried = data.session.message.get("session-live", "message-live")
    expect(retried).not.toHaveProperty("retry")
    expect(retried).toMatchObject({
      cost: 0.75,
      tokens: {
        input: 10,
        output: 4,
        reasoning: 2,
        cache: { read: 3, write: 1 },
      },
    })

    await data.session.sync("session-failed")
    emitEvent(events, {
      id: "evt_failed_execution_started",
      created: 0,
      type: "session.execution.started",
      durable: durable("session-failed"),
      data: { sessionID: "session-failed" },
    })
    await wait(() => data.session.status("session-failed") === "running")

    emitEvent(events, {
      id: "evt_failed_step_started",
      created: 0,
      type: "session.step.started",
      durable: durable("session-failed"),
      data: {
        sessionID: "session-failed",
        assistantMessageID: "message-failed",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    emitEvent(events, {
      id: "evt_step_failed",
      created: 0,
      type: "session.step.failed",
      durable: durable("session-failed", 1),
      data: {
        sessionID: "session-failed",
        assistantMessageID: "message-failed",
        error: {
          type: "provider.content-filter",
          message: "Provider blocked the response",
        },
        cost: 0.25,
        tokens: {
          input: 5,
          output: 1,
          reasoning: 1,
          cache: { read: 1, write: 0 },
        },
      },
    })
    emitEvent(events, {
      id: "evt_failed_step_usage",
      created: 0,
      type: "session.usage.updated",
      data: {
        sessionID: "session-failed",
        cost: 0.25,
        tokens: {
          input: 5,
          output: 1,
          reasoning: 1,
          cache: { read: 1, write: 0 },
        },
      },
    })
    await wait(() => {
      const assistant = data.session.message.get("session-failed", "message-failed")
      return (
        assistant?.type === "assistant" &&
        assistant.finish === "error" &&
        assistant.error?.type === "provider.content-filter"
      )
    })
    await wait(() => data.session.get("session-failed")?.cost === 0.25)
    expect(data.session.get("session-failed")?.tokens).toEqual({
      input: 5,
      output: 1,
      reasoning: 1,
      cache: { read: 1, write: 0 },
    })
    expect(data.session.status("session-failed")).toBe("running")

    emitEvent(events, {
      id: "evt_failed_execution_failed",
      created: 0,
      type: "session.execution.failed",
      durable: durable("session-failed", 1),
      data: {
        sessionID: "session-failed",
        error: {
          type: "provider.content-filter",
          message: "Provider blocked the response",
        },
      },
    })
    await wait(() => data.session.status("session-failed") === "idle")

    emitEvent(events, {
      id: "evt_retry_execution_started",
      created: 0,
      type: "session.execution.started",
      durable: durable("session-retry"),
      data: { sessionID: "session-retry" },
    })
    emitEvent(events, {
      id: "evt_retry_step_started",
      created: 0,
      type: "session.step.started",
      durable: durable("session-retry", 1),
      data: {
        sessionID: "session-retry",
        assistantMessageID: "message-retry",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    emitEvent(events, {
      id: "evt_retry_scheduled",
      created: 0,
      type: "session.retry.scheduled",
      durable: durable("session-retry", 1),
      data: {
        sessionID: "session-retry",
        assistantMessageID: "message-retry",
        attempt: 2,
        at: 2_000,
        error: { type: "provider.transport", message: "Disconnected" },
      },
    })
    await wait(() => {
      const assistant = data.session.message.get("session-retry", "message-retry")
      return assistant?.type === "assistant" && assistant.retry?.attempt === 2
    })
    await wait(() => rows.some((row) => row.type === "assistant-footer" && row.messageID === "message-retry"))
    emitEvent(events, {
      id: "evt_retry_next_step",
      created: 2_000,
      type: "session.step.started",
      durable: durable("session-retry", 1),
      data: {
        sessionID: "session-retry",
        assistantMessageID: "message-retry",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    await wait(() => {
      const assistant = data.session.message.get("session-retry", "message-retry")
      return assistant?.type === "assistant" && assistant.retry === undefined
    })
    await wait(() => !rows.some((row) => row.type === "assistant-footer" && row.messageID === "message-retry"))
    expect(data.session.message.list("session-retry").filter((message) => message.type === "assistant")).toHaveLength(1)
    emitEvent(events, {
      id: "evt_retry_scheduled_again",
      created: 2_000,
      type: "session.retry.scheduled",
      durable: durable("session-retry", 1),
      data: {
        sessionID: "session-retry",
        assistantMessageID: "message-retry",
        attempt: 3,
        at: 6_000,
        error: { type: "provider.transport", message: "Disconnected again" },
      },
    })
    await wait(() => {
      const assistant = data.session.message.get("session-retry", "message-retry")
      return assistant?.type === "assistant" && assistant.retry?.attempt === 3
    })
    emitEvent(events, {
      id: "evt_retry_interrupted",
      created: 2_000,
      type: "session.execution.interrupted",
      durable: durable("session-retry", 1),
      data: { sessionID: "session-retry", reason: "shutdown" },
    })
    await wait(() => data.session.status("session-retry") === "idle")
    expect(data.session.message.get("session-retry", "message-retry")).not.toHaveProperty("retry")
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes integrations after integration updates", async () => {
  const events = createEventStream()
  const requests = { integration: 0, model: 0, provider: 0 }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/model") {
      requests.model++
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: [],
      })
    }
    if (url.pathname === "/api/provider") {
      requests.provider++
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: [],
      })
    }
    if (url.pathname !== "/api/integration") return
    requests.integration++
    return json({
      location: { directory, project: { id: "proj_test", directory } },
      data:
        requests.integration === 1
          ? []
          : [
              {
                id: "openai",
                name: "OpenAI",
                methods: [{ type: "key" }],
              },
            ],
    })
  }, events)
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

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await wait(() => data.location.integration.list() !== undefined)
    expect(data.location.integration.list()).toEqual([])
    const before = { ...requests }

    emitEvent(events, {
      id: "evt_integration",
      created: 0,
      type: "integration.updated",
      data: {},
    })
    await wait(() => data.location.integration.list()?.length === 1)
    await wait(() => requests.model > before.model && requests.provider > before.provider)
    expect(data.location.integration.list()?.[0]).toMatchObject({
      id: "openai",
      name: "OpenAI",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes MCP resources after catalog updates", async () => {
  const events = createEventStream()
  let requests = 0
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/mcp/resource") return
    requests++
    return json({
      location: { directory, project: { id: "proj_test", directory } },
      data: {
        resources:
          requests === 1
            ? []
            : [
                {
                  server: "docs",
                  name: "API reference",
                  uri: "https://example.com/api",
                  description: "API docs",
                },
              ],
        templates: [],
      },
    })
  }, events)
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

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await wait(() => data.location.mcp.resource.list() !== undefined)
    expect(data.location.mcp.resource.list()).toEqual([])

    emitEvent(events, {
      id: "evt_mcp_resources",
      created: 0,
      type: "mcp.resources.changed",
      data: { server: "docs" },
    })
    await wait(() => data.location.mcp.resource.list()?.length === 1)
    expect(data.location.mcp.resource.list()?.[0]).toEqual({
      server: "docs",
      name: "API reference",
      uri: "https://example.com/api",
      description: "API docs",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes effective catalog data after catalog updates", async () => {
  const events = createEventStream()
  const requests = { model: 0, provider: 0 }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/model") {
      requests.model++
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: [],
      })
    }
    if (url.pathname === "/api/provider") {
      requests.provider++
      return json({
        location: { directory, project: { id: "proj_test", directory } },
        data: [],
      })
    }
  }, events)

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <box />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => requests.model > 0 && requests.provider > 0)
    const before = { ...requests }
    emitEvent(events, {
      id: "evt_catalog",
      created: 0,
      type: "catalog.updated",
      data: {},
    })
    await wait(() => requests.model > before.model && requests.provider > before.provider)
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes agents after agent updates", async () => {
  const events = createEventStream()
  let requests = 0
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/agent") return
    requests++
    return json({
      location: { directory, project: { id: "proj_test", directory } },
      data: [
        {
          id: requests === 1 ? "build" : "reviewer",
          request: { headers: {}, body: {} },
          mode: "primary",
          hidden: false,
          permissions: [],
        },
      ],
    })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => data.location.agent.list()?.[0]?.id === "build")
    emitEvent(events, {
      id: "evt_agent",
      created: 0,
      type: "agent.updated",
      data: {},
    })
    await wait(() => data.location.agent.list()?.[0]?.id === "reviewer")
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes references after updates", async () => {
  const events = createEventStream()
  let requests = 0
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/reference") return
    requests++
    return json({
      location: { directory, project: { id: "proj_test", directory } },
      data:
        requests === 1
          ? []
          : [
              {
                name: "docs",
                path: "/docs",
                source: { type: "local", path: "/docs" },
              },
            ],
    })
  }, events)
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

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await wait(() => requests === 1)
    emitEvent(events, {
      id: "evt_reference_1",
      created: 0,
      type: "reference.updated",
      data: {},
    })
    await wait(() => data.location.reference.list()?.length === 1)
    expect(data.location.reference.list()?.[0]?.name).toBe("docs")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps shell state scoped to location", async () => {
  const events = createEventStream()
  const other = "/tmp/ycoding/other"
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/shell") return
    const requestDirectory = url.searchParams.get("location[directory]")
    return json({
      location: {
        directory: requestDirectory ?? directory,
        project: { id: "proj_test", directory: requestDirectory ?? directory },
      },
      data: [
        {
          id: requestDirectory === other ? "sh_other" : "sh_default",
          status: "running",
          command: requestDirectory === other ? "pnpm dev" : "bun test",
          cwd: requestDirectory ?? directory,
          shell: "/bin/sh",
          file: "/tmp/ycoding-shell",
          metadata: {
            sessionID: requestDirectory === other ? "ses_other" : "ses_default",
          },
          time: { started: 1 },
        },
      ],
    })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => data.shell.list().some((shell) => shell.id === "sh_default"))
    await data.shell.sync({ directory: other })

    expect(data.shell.list().map((shell) => shell.id)).toEqual(["sh_default"])
    expect(data.shell.list({ directory: other }).map((shell) => shell.id)).toEqual(["sh_other"])

    events.emit({
      id: "evt_shell_created",
      created: 0,
      type: "shell.created",
      location: { directory: other },
      data: {
        info: {
          id: "sh_live_other",
          status: "running",
          command: "npm run watch",
          cwd: other,
          shell: "/bin/sh",
          file: "/tmp/ycoding-shell-live",
          metadata: { sessionID: "ses_other" },
          time: { started: 2 },
        },
      },
    })
    await wait(() => data.shell.list({ directory: other }).some((shell) => shell.id === "sh_live_other"))
    expect(data.shell.list().map((shell) => shell.id)).toEqual(["sh_default"])
  } finally {
    app.renderer.destroy()
  }
})

test("adds and dismisses permission requests from live events", async () => {
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  let data!: ReturnType<typeof useData>
  let client!: ReturnType<typeof useClient>

  function Probe() {
    data = useData()
    client = useClient()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => client.connection.status() === "connected")
    emitEvent(events, {
      id: "evt_permission_asked_1",
      created: 0,
      type: "permission.v2.asked",
      data: {
        id: "per_1",
        sessionID: "ses_1",
        action: "bash",
        resources: ["bun test"],
      },
    })
    emitEvent(events, {
      id: "evt_permission_asked_2",
      created: 0,
      type: "permission.v2.asked",
      data: {
        id: "per_2",
        sessionID: "ses_1",
        action: "read",
        resources: [".env"],
      },
    })
    await wait(() => data.session.permission.list("ses_1")?.length === 2)

    emitEvent(events, {
      id: "evt_permission_replied_1",
      created: 0,
      type: "permission.v2.replied",
      data: { sessionID: "ses_1", requestID: "per_1", reply: "once" },
    })
    await wait(() => data.session.permission.list("ses_1")?.length === 1)
    expect(data.session.permission.list("ses_1")?.[0]?.id).toBe("per_2")

    emitEvent(events, {
      id: "evt_permission_replied_2",
      created: 0,
      type: "permission.v2.replied",
      data: { sessionID: "ses_1", requestID: "per_2", reply: "reject" },
    })
    await wait(() => data.session.permission.list("ses_1")?.length === 0)
  } finally {
    app.renderer.destroy()
  }
})

test("hydrates and updates root-family guardrail reviews", async () => {
  const events = createEventStream()
  const initial = {
    id: "grq_initial",
    rootSessionID: "ses_root",
    sessionID: "ses_child",
    action: "shell",
    resources: ["git reset --hard"],
    ruleIDs: ["standard.review.git-destructive"],
    reason: "Destructive Git operation",
    standard: true,
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_root/guardrail/request") return json({ data: [initial] })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  let client!: ReturnType<typeof useClient>

  function Probe() {
    data = useData()
    client = useClient()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => client.connection.status() === "connected")
    await data.session.guardrail.sync("ses_root")
    expect(data.session.guardrail.list("ses_root")).toEqual([initial])

    emitEvent(events, {
      id: "evt_guardrail_asked_1",
      created: 0,
      type: "guardrail.asked",
      data: {
        id: "grq_live",
        rootSessionID: "ses_root",
        sessionID: "ses_child_2",
        action: "shell",
        resources: ["npm publish"],
        ruleIDs: ["standard.review.release"],
        reason: "Package publishing",
        standard: true,
      },
    })
    await wait(() => data.session.guardrail.list("ses_root").length === 2)

    emitEvent(events, {
      id: "evt_guardrail_replied_1",
      created: 0,
      type: "guardrail.replied",
      data: {
        rootSessionID: "ses_root",
        sessionID: "ses_child",
        requestID: "grq_initial",
        reply: "once",
      },
    })
    await wait(() => data.session.guardrail.list("ses_root").length === 1)
    expect(data.session.guardrail.list("ses_root")[0]?.id).toBe("grq_live")
  } finally {
    app.renderer.destroy()
  }
})

test("reconciles active session permissions when the event stream reconnects", async () => {
  const events = createEventStream()
  let requests = [
    {
      id: "per_old",
      sessionID: "ses_active",
      action: "read",
      resources: ["old.txt"],
    },
    {
      id: "per_keep",
      sessionID: "ses_active",
      action: "shell",
      resources: ["bun test"],
    },
  ]
  let calls = 0
  const fetch = createFetch((url) => {
    if (url.pathname !== "/api/session/ses_active/permission") return
    calls++
    return json({ data: requests })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    const client = useClient()
    createEffect(() => {
      if (client.connection.status() !== "connected") return
      void data.session.permission.sync("ses_active")
    })
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(fetch.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => data.session.permission.list("ses_active")?.length === 2)

    requests = [
      {
        id: "per_new",
        sessionID: "ses_active",
        action: "edit",
        resources: ["new.txt"],
      },
    ]
    events.disconnect()

    await wait(() => calls === 2 && data.session.permission.list("ses_active")?.[0]?.id === "per_new")
  } finally {
    app.renderer.destroy()
  }
})

test("adds, dismisses, and refreshes form requests", async () => {
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/session/ses_1/form") return
    return json({
      data: [
        {
          id: "frm_remote",
          sessionID: "ses_1",
          title: "Input requested",
          fields: formFields,
        },
      ],
    })
  }, events)
  let data!: ReturnType<typeof useData>
  let client!: ReturnType<typeof useClient>

  function Probe() {
    data = useData()
    client = useClient()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => client.connection.status() === "connected")
    emitEvent(events, {
      id: "evt_form_created_1",
      created: 0,
      type: "form.created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "ses_1",
          title: "Input requested",
          fields: formFields,
        },
      },
    })
    emitEvent(events, {
      id: "evt_form_created_duplicate",
      created: 1,
      type: "form.created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "ses_1",
          title: "Input requested",
          fields: formFields,
        },
      },
    })
    await wait(() => data.session.form.list("ses_1")?.length === 1)

    emitEvent(events, {
      id: "evt_form_replied_1",
      created: 2,
      type: "form.replied",
      data: { sessionID: "ses_1", id: "frm_1", answer: {} },
    })
    await wait(() => data.session.form.list("ses_1")?.length === 0)

    emitEvent(events, {
      id: "evt_form_created_2",
      created: 3,
      type: "form.created",
      data: {
        form: {
          id: "frm_2",
          sessionID: "ses_1",
          title: "Input requested",
          fields: formFields,
        },
      },
    })
    emitEvent(events, {
      id: "evt_form_cancelled_2",
      created: 4,
      type: "form.cancelled",
      data: { sessionID: "ses_1", id: "frm_2" },
    })
    await wait(() => data.session.form.list("ses_1")?.length === 0)

    await data.session.form.sync("ses_1")
    expect(data.session.form.list("ses_1")?.map((form) => form.id)).toEqual(["frm_remote"])
  } finally {
    app.renderer.destroy()
  }
})

test("tracks global forms by location", async () => {
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  const other = { directory: "/tmp/ycoding-other", workspaceID: "wrk_other" }
  let data!: ReturnType<typeof useData>
  let client!: ReturnType<typeof useClient>

  function Probe() {
    data = useData()
    client = useClient()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => client.connection.status() === "connected")
    events.emit({
      id: "evt_form_created_global_other",
      created: 0,
      location: other,
      type: "form.created",
      data: {
        form: {
          id: "frm_other",
          sessionID: "global",
          title: "Input requested",
          fields: formFields,
        },
      },
    })

    await wait(() => data.session.form.list("global", other)?.length === 1)
    expect(data.session.form.list("global", { directory }) ?? []).toEqual([])

    events.emit({
      id: "evt_form_created_global_default",
      created: 1,
      location: { directory },
      type: "form.created",
      data: {
        form: {
          id: "frm_default",
          sessionID: "global",
          title: "Input requested",
          fields: formFields,
        },
      },
    })
    await wait(() => data.session.form.list("global", { directory })?.length === 1)

    events.emit({
      id: "evt_form_replied_global_other",
      created: 2,
      location: other,
      type: "form.replied",
      data: { id: "frm_other", sessionID: "global", answer: {} },
    })
    await wait(() => data.session.form.list("global", other)?.length === 0)
    expect(data.session.form.list("global", { directory })?.map((form) => form.id)).toEqual(["frm_default"])
  } finally {
    app.renderer.destroy()
  }
})

test("syncs global forms once for each requested location", async () => {
  const events = createEventStream()
  const requests: URL[] = []
  const other = { directory: "/tmp/ycoding-other", workspaceID: "wrk_other" }
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/form/request") return
    requests.push(url)
    const requestedDirectory = url.searchParams.get("location[directory]") ?? directory
    const requestedWorkspace = url.searchParams.get("location[workspace]") ?? undefined
    return json({
      location: {
        directory: requestedDirectory,
        workspaceID: requestedWorkspace,
        project: { id: "proj_test", directory: requestedDirectory },
      },
      data: [
        {
          id: requestedDirectory === other.directory ? "frm_other" : "frm_default",
          sessionID: "global",
          title: "Input requested",
          fields: formFields,
        },
      ],
    })
  }, events)
  let data!: ReturnType<typeof useData>
  let client!: ReturnType<typeof useClient>

  function Probe() {
    data = useData()
    client = useClient()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => client.connection.status() === "connected" && requests.length > 0)
    requests.length = 0

    await data.session.form.sync("global", { directory })
    await data.session.form.sync("global", other)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.searchParams.get("location[directory]")).toBe(other.directory)
    expect(requests[0]?.searchParams.get("location[workspace]")).toBe(other.workspaceID)
    expect(data.session.form.list("global", other)?.map((form) => form.id)).toEqual(["frm_other"])
    expect(data.session.form.list("global", { directory })?.map((form) => form.id)).toEqual(["frm_default"])

    data.session.form.invalidate("global", other)
    await data.session.form.sync("global", other)
    expect(requests).toHaveLength(2)
  } finally {
    app.renderer.destroy()
  }
})

test("resyncs global forms only for the active location after reconnect", async () => {
  const events = createEventStream()
  const requests: URL[] = []
  const counts = new Map<string, number>()
  const home = { directory: process.cwd() }
  const other = { directory: "/tmp/ycoding-other", workspaceID: "wrk_other" }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location")
      return json({
        ...home,
        project: { id: "proj_test", directory: home.directory },
      })
    if (url.pathname === "/api/session")
      return json({
        data: [
          {
            id: "ses_default",
            title: "Default",
            location: home,
            time: { created: 0, updated: 0 },
          },
          {
            id: "ses_other_1",
            title: "Other one",
            location: other,
            time: { created: 0, updated: 0 },
          },
          {
            id: "ses_other_2",
            title: "Other two",
            location: other,
            time: { created: 0, updated: 0 },
          },
        ],
        cursor: {},
      })
    if (url.pathname !== "/api/form/request") return
    requests.push(url)
    const requestedDirectory = url.searchParams.get("location[directory]") ?? home.directory
    const requestedWorkspace = url.searchParams.get("location[workspace]") ?? undefined
    const count = (counts.get(requestedDirectory) ?? 0) + 1
    counts.set(requestedDirectory, count)
    return json({
      location: {
        directory: requestedDirectory,
        workspaceID: requestedWorkspace,
        project: { id: "proj_test", directory: requestedDirectory },
      },
      data: [
        {
          id: `frm_${requestedDirectory === other.directory ? "other" : "default"}_${count}`,
          sessionID: "global",
          title: "Input requested",
          fields: formFields,
        },
      ],
    })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => data.session.form.list("global", home)?.[0]?.id === "frm_default_1")
    await data.session.form.sync("global", other)
    expect(data.session.form.list("global", other)?.[0]?.id).toBe("frm_other_1")
    expect(requests).toHaveLength(2)
    requests.length = 0

    events.disconnect()

    await wait(() => data.session.form.list("global", home)?.[0]?.id === "frm_default_2", 4000)
    expect(data.session.form.list("global", other)?.[0]?.id).toBe("frm_other_1")
    expect(requests).toHaveLength(1)
    expect(
      requests.map((url) => [
        url.searchParams.get("location[directory]") ?? directory,
        url.searchParams.get("location[workspace]") ?? undefined,
      ]),
    ).toEqual([[home.directory, undefined]])
  } finally {
    app.renderer.destroy()
  }
})

test("reconciles active session forms when the event stream reconnects", async () => {
  const events = createEventStream()
  let requests = [
    {
      id: "frm_old",
      sessionID: "ses_active",
      title: "Input requested",
      fields: formFields,
    },
    {
      id: "frm_keep",
      sessionID: "ses_active",
      title: "Input requested",
      fields: [
        {
          key: "authorization",
          type: "external" as const,
          url: "https://example.com",
        },
      ],
    },
  ]
  let calls = 0
  const fetch = createFetch((url) => {
    if (url.pathname !== "/api/session/ses_active/form") return
    calls++
    return json({ data: requests })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    const client = useClient()
    createEffect(() => {
      if (client.connection.status() !== "connected") return
      void data.session.form.sync("ses_active")
    })
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(fetch.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => data.session.form.list("ses_active")?.length === 2)

    requests = [
      {
        id: "frm_new",
        sessionID: "ses_active",
        title: "Input requested",
        fields: formFields,
      },
    ]
    events.disconnect()

    await wait(() => calls === 2 && data.session.form.list("ses_active")?.[0]?.id === "frm_new")
  } finally {
    app.renderer.destroy()
  }
})

test("settles pending tools when a live failure arrives", async () => {
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/session-1/message/msg_model_1")
      return json({
        data: {
          id: "msg_model_1",
          type: "model-switched",
          previous: {
            id: "model-1",
            providerID: "provider-1",
            variant: "medium",
          },
          model: { id: "model-1", providerID: "provider-1", variant: "high" },
          time: { created: 0 },
        },
      })
  }, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitEvent(events, {
      id: "evt_agent_1",
      created: 0,
      type: "session.agent.selected",
      durable: durable("session-1"),
      data: { sessionID: "session-1", agent: "build" },
    })
    emitEvent(events, {
      id: "evt_model_1",
      created: 0,
      type: "session.model.selected",
      durable: durable("session-1", 1),
      data: {
        sessionID: "session-1",
        model: { id: "model-1", providerID: "provider-1", variant: "high" },
      },
    })
    emitEvent(events, {
      id: "evt_step_started_1",
      created: 0,
      type: "session.step.started",
      durable: durable("session-1", 2),
      data: {
        sessionID: "session-1",
        assistantMessageID: "msg_explicit_assistant_9",
        agent: "build",
        model: { id: "model-1", providerID: "provider-1" },
      },
    })
    emitEvent(events, {
      id: "evt_input_1",
      created: 0,
      type: "session.tool.input.started",
      durable: durable("session-1", 3),
      data: {
        sessionID: "session-1",
        assistantMessageID: "msg_explicit_assistant_9",
        callID: "call-1",
        name: "bash",
      },
    })
    emitEvent(events, {
      id: "evt_called_1",
      created: 0,
      type: "session.tool.called",
      durable: durable("session-1", 4),
      data: {
        sessionID: "session-1",
        assistantMessageID: "msg_explicit_assistant_9",
        callID: "call-1",
        input: {},
        executed: false,
        state: { call: true },
      },
    })
    emitEvent(events, {
      id: "evt_progress_1",
      created: 0,
      type: "session.tool.progress",
      durable: durable("session-1", 5),
      data: {
        sessionID: "session-1",
        assistantMessageID: "msg_explicit_assistant_9",
        callID: "call-1",
        structured: { sessionID: "session-child", status: "running" },
        content: [],
      },
    })

    await wait(() => {
      const assistant = sync.session.message.get("session-1", "msg_explicit_assistant_9")
      return (
        assistant?.type === "assistant" &&
        assistant.content[0]?.type === "tool" &&
        assistant.content[0].state.status === "running" &&
        assistant.content[0].state.structured.sessionID === "session-child"
      )
    })

    emitEvent(events, {
      id: "evt_failed_1",
      created: 0,
      type: "session.tool.failed",
      durable: durable("session-1", 6),
      data: {
        sessionID: "session-1",
        assistantMessageID: "msg_explicit_assistant_9",
        callID: "call-1",
        error: { type: "unknown", message: "aborted" },
        executed: false,
        resultState: { result: true },
      },
    })

    await wait(() => {
      const assistant = sync.session.message.get("session-1", "msg_explicit_assistant_9")
      return (
        assistant?.type === "assistant" &&
        assistant.content[0]?.type === "tool" &&
        assistant.content[0].state.status === "error"
      )
    })

    const assistant = sync.session.message.get("session-1", "msg_explicit_assistant_9")
    expect(assistant?.type).toBe("assistant")
    if (assistant?.type !== "assistant") return
    expect(assistant.id).toBe("msg_explicit_assistant_9")
    const tool = assistant.content[0]
    expect(tool?.type).toBe("tool")
    if (tool?.type !== "tool") return
    expect(tool.state.status).toBe("error")
    if (tool.state.status !== "error") return
    expect(tool.state.error).toEqual({ type: "unknown", message: "aborted" })
    expect(tool.state.input).toEqual({})
    expect(tool.state.structured).toEqual({
      sessionID: "session-child",
      status: "running",
    })
    expect(tool.state.content).toEqual([])
    expect(tool.executed).toBe(false)
    expect(tool.providerState).toEqual({ call: true })
    expect(tool.providerResultState).toEqual({ result: true })
    expect(sync.session.message.list("session-1").map((message) => message.type)).toEqual([
      "agent-switched",
      "model-switched",
      "assistant",
    ])
    expect(sync.session.message.get("session-1", "msg_model_1")).toMatchObject({
      type: "model-switched",
      previous: { id: "model-1", providerID: "provider-1", variant: "medium" },
      model: { id: "model-1", providerID: "provider-1", variant: "high" },
    })
  } finally {
    app.renderer.destroy()
  }
})

test("renders admitted prompts immediately and tracks them until promoted", async () => {
  const events = createEventStream()
  const sessionID = "session-1"
  const messageID = "msg_user_1"
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`)
      return json({
        data: [{ id: messageID, type: "user", text: "hello", time: { created: 0 } }],
        cursor: {},
      })
  }, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    const received: string[] = []
    const unsubscribe = sync.listen((event) => received.push(event.name))
    emitEvent(events, {
      id: "evt_admitted_1",
      created: 0,
      type: "session.input.admitted",
      durable: durable(sessionID),
      data: {
        sessionID,
        inputID: messageID,
        input: { type: "user", data: { text: "hello" }, delivery: "steer" },
      },
    })
    await wait(() => sync.session.message.list(sessionID)?.length === 1)
    const admitted = sync.session.message.list(sessionID)?.[0]
    expect(admitted).toMatchObject({
      id: messageID,
      type: "user",
      text: "hello",
    })
    expect(admitted?.metadata).toBeUndefined()
    expect(sync.session.pending.list(sessionID)).toEqual([
      {
        id: messageID,
        sessionID,
        admittedSeq: 0,
        timeCreated: 0,
        type: "user",
        data: { text: "hello" },
        delivery: "steer",
      },
    ])
    expect(sync.session.input.list(sessionID)).toEqual([messageID])

    await sync.session.message.sync(sessionID)
    expect(sync.session.message.list(sessionID)?.[0]?.metadata).toBeUndefined()

    emitEvent(events, {
      id: "evt_prompted_1",
      created: 0,
      type: "session.input.promoted",
      durable: durable(sessionID, 1),
      data: {
        sessionID,
        inputID: messageID,
      },
    })

    await wait(() => received.at(-1) === "session.input.promoted")
    expect(received.slice(-2)).toEqual(["session.input.admitted", "session.input.promoted"])
    unsubscribe()
    const message = sync.session.message.list(sessionID)?.[0]
    expect(message?.type).toBe("user")
    if (message?.type !== "user") return
    expect(message).toMatchObject({ id: messageID, text: "hello" })
    expect(message.metadata).toBeUndefined()
    expect(sync.session.pending.list(sessionID)).toEqual([])
    expect(sync.session.input.list(sessionID)).toEqual([])
    expect(sync.session.message.list(sessionID).map((message) => message.id)).toEqual([messageID])
    expect(sync.session.message.list("missing")).toEqual([])
    expect(sync.session.message.get(sessionID, messageID)).toBe(message)
    expect(sync.session.message.get(sessionID, "missing")).toBeUndefined()
    expect(received).toHaveLength(3)
  } finally {
    app.renderer.destroy()
  }
})

test("does not remove a resident promoted user message when canonical projection is stale", async () => {
  const events = createEventStream()
  const sessionID = "session-race"
  const messageID = "msg-user-race"
  let requests = 0
  const calls = createFetch((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    requests++
    if (requests === 1) return json({ data: [], cursor: {} })
    return json({ data: [{ id: messageID, type: "user", text: "stay visible", time: { created: 1 } }], cursor: {} })
  }, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitEvent(events, {
      id: "evt-race-admitted",
      created: 1,
      type: "session.input.admitted",
      durable: durable(sessionID),
      data: {
        sessionID,
        inputID: messageID,
        input: { type: "user", data: { text: "stay visible" }, delivery: "steer" },
      },
    })
    emitEvent(events, {
      id: "evt-race-promoted",
      created: 2,
      type: "session.input.promoted",
      durable: durable(sessionID, 1),
      data: { sessionID, inputID: messageID },
    })
    await wait(
      () =>
        sync.session.message.get(sessionID, messageID) !== undefined &&
        sync.session.input.list(sessionID).length === 0,
    )
    expect(sync.session.message.get(sessionID, messageID)).toBeDefined()

    await sync.session.message.sync(sessionID)
    expect(sync.session.message.get(sessionID, messageID)).toBeDefined()

    sync.session.message.invalidate(sessionID)
    await sync.session.message.sync(sessionID)
    expect(sync.session.message.get(sessionID, messageID)).toMatchObject({ type: "user", text: "stay visible" })
  } finally {
    app.renderer.destroy()
  }
})

test("restores a pending steer after leaving and reopening a child session", async () => {
  const events = createEventStream()
  const childID = "session-child"
  const messageID = "msg-child-steer"
  const pending = {
    id: messageID,
    sessionID: childID,
    admittedSeq: 0,
    timeCreated: 100,
    type: "user" as const,
    data: { text: "Keep this steer visible" },
    delivery: "steer" as const,
  }
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${childID}/pending`) return json({ data: [pending] })
    if (url.pathname === `/api/session/${childID}/message`) return json({ data: [], cursor: {} })
  }, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitEvent(events, {
      id: "evt-child-steer",
      created: 100,
      type: "session.input.admitted",
      durable: durable(childID),
      data: {
        sessionID: childID,
        inputID: messageID,
        input: { type: "user", data: pending.data, delivery: "steer" },
      },
    })
    await wait(() => sync.session.message.get(childID, messageID) !== undefined)
    sync.session.message.evict(childID)
    expect(sync.session.message.list(childID)).toEqual([])

    sync.session.pending.invalidate(childID)
    await Promise.all([sync.session.pending.sync(childID), sync.session.message.sync(childID)])

    expect(sync.session.input.list(childID)).toEqual([messageID])
    expect(sync.session.message.get(childID, messageID)).toMatchObject({
      id: messageID,
      type: "user",
      text: "Keep this steer visible",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("skips initial instruction state and projects later updates with their message ID", async () => {
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitEvent(events, {
      id: "evt_instructions_1",
      created: 0,
      type: "session.instructions.updated",
      durable: durable("session-1", 0, 2),
      metadata: { instructions: { initial: true } },
      data: {
        sessionID: "session-1",
        delta: { "core/date": "0".repeat(64) },
      },
    })
    emitEvent(events, {
      id: "evt_instructions_2",
      created: 1,
      type: "session.instructions.updated",
      durable: durable("session-1", 1, 2),
      data: {
        sessionID: "session-1",
        delta: { "core/date": "1".repeat(64) },
      },
    })

    await wait(() => sync.session.message.list("session-1")?.some((message) => message.time.created === 1))
    expect(sync.session.message.list("session-1")).toHaveLength(1)
    expect(sync.session.message.list("session-1")?.[0]).toMatchObject({
      id: SessionMessage.ID.fromEvent(EventV2.ID.make("evt_instructions_2")),
      type: "system",
      text: "Instructions updated: core/date",
      time: { created: 1 },
    })
  } finally {
    app.renderer.destroy()
  }
})

function sessionInfo(id: string, parentID: string | undefined, cost = 0) {
  return {
    id,
    parentID,
    projectID: "proj_test",
    cost,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    title: id,
    location: { directory },
  }
}

// Mounts a DataProvider whose `/api/session/:id` responses are driven by the
// given parent map (sessionID -> parentID). Roots omit the entry. Reused across
// the family-index tests below.
async function mountData(parents: Record<string, string>, costs: Record<string, number> = {}) {
  const calls = createFetch((url) => {
    const match = url.pathname.match(/^\/api\/session\/([^/]+)$/)
    if (match && match[1] !== "active")
      return json({
        data: sessionInfo(match[1], parents[match[1]], costs[match[1]]),
      })
  })
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
  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  await mounted
  return { data, app }
}

test("groups an orphan child under its missing parent until the root arrives", async () => {
  const { data, app } = await mountData({ child: "root" })
  try {
    await data.session.sync("child")
    // Parent info is absent, so the missing parent is the furthest-known ancestor.
    expect(data.session.root("child")).toBe("root")
    expect(data.session.family("child")).toEqual(["child"])
    expect(data.session.family("root")).toEqual(["child"])

    await data.session.sync("root")
    expect(data.session.root("root")).toBe("root")
    // The tentative root entry folds into the now-known root's family.
    expect(data.session.family("child")).toEqual(["child", "root"])
    expect(data.session.family("root")).toEqual(["child", "root"])
  } finally {
    app.renderer.destroy()
  }
})

test("indexes arbitrarily deep nesting under a single root", async () => {
  const { data, app } = await mountData({ grandchild: "child", child: "root" })
  try {
    await data.session.sync("grandchild")
    expect(data.session.root("grandchild")).toBe("child")
    expect(data.session.family("grandchild")).toEqual(["grandchild"])

    await data.session.sync("child")
    // grandchild's tentative family (keyed by the missing "child") merges up
    // toward the still-missing "root".
    expect(data.session.root("child")).toBe("root")
    expect(data.session.family("grandchild")).toEqual(["grandchild", "child"])

    await data.session.sync("root")
    expect(data.session.root("grandchild")).toBe("root")
    expect(data.session.root("child")).toBe("root")
    expect(data.session.family("root")).toEqual(["grandchild", "child", "root"])
  } finally {
    app.renderer.destroy()
  }
})

test("totals family cost for roots and keeps subagent cost scoped", async () => {
  const { data, app } = await mountData({ grandchild: "child", child: "root" }, { root: 1, child: 2, grandchild: 3 })
  try {
    await data.session.sync("grandchild")
    await data.session.sync("child")
    await data.session.sync("root")

    expect(data.session.cost("root")).toBe(6)
    expect(data.session.cost("child")).toBe(2)
    expect(data.session.cost("grandchild")).toBe(3)
  } finally {
    app.renderer.destroy()
  }
})

test("re-registering an existing session is idempotent", async () => {
  const { data, app } = await mountData({ grandchild: "child", child: "root" })
  try {
    await data.session.sync("grandchild")
    await data.session.sync("child")
    await data.session.sync("root")
    const before = data.session.family("root")
    expect(before).toEqual(["grandchild", "child", "root"])

    await data.session.sync("child")
    await data.session.sync("root")
    await data.session.sync("grandchild")
    expect(data.session.family("root")).toEqual(before)
    expect(data.session.family("root")).toHaveLength(3)
  } finally {
    app.renderer.destroy()
  }
})

test("loads and refreshes normalized session diagnostics", async () => {
  const events = createEventStream()
  let hitRatio = 0.5
  let diagnosticRequests = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_test")
      return json({
        data: {
          id: "ses_test",
          projectID: "proj_test",
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: { created: 0, updated: 0 },
          title: "Test session",
          location: { directory },
        },
      })
    if (url.pathname === "/api/session/ses_test/diagnostics") {
      diagnosticRequests++
      return json({
        data: {
          model: { id: "model", providerID: "openai" },
          context: { total: 1_030, limit: 2_000, remaining: 970, percent: 52 },
          tokens: {
            uncachedInput: 100,
            output: 20,
            reasoning: 10,
            cacheRead: 900,
            cacheWrite: 0,
          },
          cache: {
            eligible: 1_000,
            hitRatio,
            mechanism: "openai-prefix-cache",
            readReported: true,
            writeReported: false,
          },
          estimatedCost: 0,
        },
      })
    }
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await data.session.sync("ses_test")
    await data.session.diagnostics.sync("ses_test")
    expect(data.session.diagnostics.get("ses_test")?.cache.hitRatio).toBe(0.5)

    emitEvent(events, {
      id: "evt_diagnostics_live",
      created: 1,
      type: "session.diagnostics.updated",
      data: {
        sessionID: "ses_test",
        diagnostics: {
          model: { id: "model", providerID: "openai" },
          context: { total: 1_030, limit: 2_000, remaining: 970, percent: 52 },
          tokens: {
            uncachedInput: 100,
            output: 20,
            reasoning: 10,
            cacheRead: 900,
            cacheWrite: 0,
          },
          cache: {
            eligible: 1_000,
            hitRatio: 0.9,
            mechanism: "openai-prefix-cache",
            readReported: true,
            writeReported: false,
          },
          estimatedCost: 0,
        },
      },
    })
    await wait(() => data.session.diagnostics.get("ses_test")?.cache.hitRatio === 0.9)
    expect(diagnosticRequests).toBe(1)

    emitEvent(events, {
      id: "evt_diagnostics_started",
      created: 2,
      type: "session.step.started",
      durable: durable("ses_test", 1),
      data: {
        sessionID: "ses_test",
        assistantMessageID: "msg_assistant",
        agent: "build",
        model: { providerID: "openai", id: "model" },
      },
    })
    hitRatio = 0.95
    emitEvent(events, {
      id: "evt_diagnostics",
      created: 3,
      type: "session.step.ended",
      durable: durable("ses_test", 2),
      data: {
        sessionID: "ses_test",
        assistantMessageID: "msg_assistant",
        finish: "stop",
        cost: 0,
        tokens: {
          input: 100,
          output: 20,
          reasoning: 10,
          cache: { read: 900, write: 0 },
        },
        contextLimit: 2_000,
      },
    })

    await wait(() => data.session.message.get("ses_test", "msg_assistant")?.type === "assistant")
    expect(data.session.message.get("ses_test", "msg_assistant")).toMatchObject({
      diagnostics: { contextLimit: 2_000 },
    })
    await wait(() => data.session.diagnostics.get("ses_test")?.cache.hitRatio === 0.95)
    expect(diagnosticRequests).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("caches durable session usage independently from diagnostics", async () => {
  const events = createEventStream()
  let usageRequests = 0
  const usage: ProviderRequestSummary = {
    logical: 1,
    physical: 1,
    helpers: 0,
    continued: 0,
    fallback: 0,
    cost: 0.42,
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 50, write: 10 } },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_usage/usage") {
      usageRequests++
      return json({ data: usage })
    }
    if (url.pathname === "/api/session/ses_usage/diagnostics") return json({ data: null })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await data.session.usage.sync("ses_usage")
    expect(data.session.usage.get("ses_usage")).toEqual(usage)
    expect(data.session.diagnostics.get("ses_usage")).toBeUndefined()
    expect(usageRequests).toBe(1)

    await data.session.usage.sync("ses_usage")
    expect(usageRequests).toBe(1)

    data.session.usage.invalidate("ses_usage")
    await data.session.usage.sync("ses_usage")
    expect(usageRequests).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes the resident parent ledger after a durable child file-change event", async () => {
  const events = createEventStream()
  const sessionID = "ses_file_change_parent"
  const childID = "ses_file_change_child"
  let requests = 0
  let files = [{ path: "src/first.ts", patch: "--- a/src/first.ts\n+++ b/src/first.ts", additions: 1, deletions: 0 }]
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/subagent`)
      return json(
        subagentPage([
          {
            sessionID: childID,
            parentID: sessionID,
            description: "Edit a file",
            agent: "build",
            model: { providerID: "anthropic", id: "claude-opus-5" },
            background: true,
            state: "completed",
            revision: 1,
            time: { created: 0, updated: 0 },
          },
        ]),
      )
    if (url.pathname !== `/api/session/${sessionID}/file-change`) return undefined
    requests++
    return json({ data: files })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await data.session.subagent.sync(sessionID)
    await data.session.fileChange.sync(sessionID)
    expect(data.session.fileChange.list(sessionID)).toEqual(files)

    files = [
      ...files,
      { path: "src/second.ts", patch: "--- a/src/second.ts\n+++ b/src/second.ts", additions: 1, deletions: 0 },
    ]
    emitEvent(events, {
      id: "evt_file_change",
      created: 1,
      type: "session.file-change.recorded",
      durable: durable(childID, 1),
      data: {
        sessionID: childID,
        change: files[1],
      },
    } as YCodingEvent)

    await wait(() => data.session.fileChange.list(sessionID).length === 2)
    expect(data.session.fileChange.list(sessionID)).toEqual(files)
    expect(requests).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("syncs durable subagent tasks and refreshes them from task events", async () => {
  const events = createEventStream()
  let requests = 0
  let state: SessionOrchestrationTask["state"] = "waiting"
  const task = (): SessionOrchestrationTask => ({
    sessionID: "ses_child",
    parentID: "ses_parent",
    description: "Review implementation",
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
    background: true,
    state,
    question: state === "waiting" ? { id: "qst_review", text: "Proceed?", data: { risk: "low" }, time: 1 } : undefined,
    revision: requests,
    time: { created: 1, updated: requests + 1 },
  })
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/session/ses_parent/subagent") return undefined
    requests++
    return json(subagentPage([task()]))
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await data.session.subagent.sync("ses_parent")
    const waiting = data.session.subagent.page("ses_parent")?.data[0]
    expect(waiting?.sessionID).toBe("ses_child")
    expect(waiting?.state).toBe("waiting")
    expect(waiting?.question?.text).toBe("Proceed?")

    state = "failed"
    emitEvent(events, {
      id: "evt_task_failed",
      created: 3,
      type: "session.task.updated",
      durable: durable("ses_child", 3),
      data: {
        sessionID: "ses_child",
        change: { type: "failed", error: "review failed", excerpt: "failed" },
      },
    })

    await wait(() => data.session.subagent.page("ses_parent")?.data[0]?.state === "failed")
    expect(requests).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("replaces bounded subagent pages instead of appending them", async () => {
  const events = createEventStream()
  const tasks = Array.from(
    { length: 12 },
    (_, index): SessionOrchestrationTask => ({
      sessionID: `ses_child_${index}`,
      parentID: "ses_parent",
      description: `Child ${index}`,
      agent: "reviewer",
      model: { providerID: "openai", id: "gpt-5.6" },
      background: true,
      state: index === 0 ? "waiting" : "completed",
      revision: index,
      time: { created: index, updated: 12 - index },
    }),
  )
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/session/ses_parent/subagent") return undefined
    if (url.searchParams.get("cursor") === "older")
      return json({
        data: tasks.slice(10),
        summary: { total: 12, active: 1, running: 0, waiting: 1 },
        cursor: { previous: "top" },
      })
    if (url.searchParams.get("cursor") === "top")
      return json({
        data: tasks.slice(0, 10),
        summary: { total: 12, active: 1, running: 0, waiting: 1 },
        cursor: { next: "older" },
      })
    return json({
      data: tasks.slice(0, 10),
      summary: { total: 12, active: 1, running: 0, waiting: 1 },
      cursor: { next: "older" },
    })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await data.session.subagent.sync("ses_parent")
    const top = data.session.subagent.page("ses_parent")!
    expect({
      data: [...top.data],
      summary: { ...top.summary },
      cursor: { ...top.cursor },
      offset: top.offset,
      position: top.position,
    }).toEqual({
      data: tasks.slice(0, 10),
      summary: { total: 12, active: 1, running: 0, waiting: 1 },
      cursor: { next: "older" },
      position: "top",
      offset: 0,
    })
    await data.session.subagent.loadOlder("ses_parent")
    const older = data.session.subagent.page("ses_parent")!
    expect({
      data: [...older.data],
      summary: { ...older.summary },
      cursor: { ...older.cursor },
      offset: older.offset,
      position: older.position,
    }).toEqual({
      data: tasks.slice(10),
      summary: { total: 12, active: 1, running: 0, waiting: 1 },
      cursor: { previous: "top" },
      position: "older",
      offset: 10,
    })
    expect(older.data).toHaveLength(2)
    expect(older.offset + older.data.findIndex((task) => task.sessionID === "ses_child_11") + 1).toBe(12)
    await data.session.subagent.loadNewer("ses_parent")
    const newer = data.session.subagent.page("ses_parent")!
    expect({
      data: [...newer.data],
      summary: { ...newer.summary },
      cursor: { ...newer.cursor },
      offset: newer.offset,
      position: newer.position,
    }).toEqual({
      data: tasks.slice(0, 10),
      summary: { total: 12, active: 1, running: 0, waiting: 1 },
      cursor: { next: "older" },
      position: "top",
      offset: 0,
    })
  } finally {
    app.renderer.destroy()
  }
})

test("resolves an evicted task parent before restoring its top page", async () => {
  const events = createEventStream()
  let page = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_evicted") return json({ data: sessionInfo("ses_evicted", "ses_parent") })
    if (url.pathname !== "/api/session/ses_parent/subagent") return undefined
    page++
    return json({
      data:
        page === 1
          ? Array.from({ length: 10 }, (_, index) => ({
              sessionID: `ses_terminal_${index}`,
              parentID: "ses_parent",
              description: `Terminal ${index}`,
              agent: "reviewer",
              model: { providerID: "openai", id: "gpt-5.6" },
              background: true,
              state: "completed" as const,
              revision: index,
              time: { created: index, updated: index },
            }))
          : [
              {
                sessionID: "ses_evicted",
                parentID: "ses_parent",
                description: "Needs input",
                agent: "reviewer",
                model: { providerID: "openai", id: "gpt-5.6" },
                background: true,
                state: "waiting" as const,
                question: { id: "qst_evicted", text: "Proceed?", time: 2 },
                revision: 2,
                time: { created: 2, updated: 2 },
              },
            ],
      summary: { total: 11, active: 1, running: 0, waiting: 1 },
      cursor: { next: "older" },
    })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await data.session.subagent.sync("ses_parent")
    emitEvent(events, {
      id: "evt_evicted_waiting",
      created: 2,
      type: "session.task.updated",
      durable: durable("ses_evicted", 2),
      data: {
        sessionID: "ses_evicted",
        change: { type: "question_asked", question: { id: "qst_evicted", text: "Proceed?", time: 2 } },
      },
    })
    await wait(() => data.session.subagent.page("ses_parent")?.data[0]?.sessionID === "ses_evicted")
    expect(data.session.get("ses_evicted")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("keeps a refreshed top page when an older request settles late", async () => {
  const events = createEventStream()
  let release!: () => void
  const older = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  const calls = createFetch(async (url) => {
    if (url.pathname !== "/api/session/ses_parent/subagent") return undefined
    requests++
    if (url.searchParams.get("cursor") === "older") {
      await older
      return json({ data: [], summary: { total: 11, active: 1, running: 1, waiting: 0 }, cursor: { previous: "top" } })
    }
    return json({
      data: [
        {
          sessionID: `ses_top_${requests}`,
          parentID: "ses_parent",
          description: "top",
          agent: "reviewer",
          model: { providerID: "openai", id: "gpt-5.6" },
          background: true,
          state: "running",
          revision: requests,
          time: { created: requests, updated: requests },
        },
      ],
      summary: { total: 11, active: 1, running: 1, waiting: 0 },
      cursor: { next: "older" },
    })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await data.session.subagent.sync("ses_parent")
    const pendingOlder = data.session.subagent.loadOlder("ses_parent")
    await wait(() => requests === 2)
    await data.session.subagent.sync("ses_parent")
    release()
    await pendingOlder
    expect(data.session.subagent.page("ses_parent")?.position).toBe("top")
    expect(data.session.subagent.page("ses_parent")?.offset).toBe(0)
    expect(data.session.subagent.page("ses_parent")?.data[0]?.sessionID).toBe("ses_top_3")
  } finally {
    app.renderer.destroy()
  }
})

test("stops at the last non-repeating ancestor on a parent cycle", async () => {
  const { data, app } = await mountData({ x: "y", y: "x" })
  try {
    await data.session.sync("x")
    await data.session.sync("y")
    // Does not hang; walking up from "y" stops before re-entering "x".
    expect(data.session.root("y")).toBe("x")
    expect(data.session.family("y")).toEqual(["x", "y"])
  } finally {
    app.renderer.destroy()
  }
})

// Mirrors the prompt footer indicator: family members other than the viewed
// session that the live status map reports as running.
function runningSubagents(data: ReturnType<typeof useData>, sessionID: string) {
  return data.session.family(sessionID).filter((id) => id !== sessionID && data.session.status(id) === "running")
}

test("indexes a launched subagent before its session fetch resolves", async () => {
  const events = createEventStream()
  const calls = createFetch((url) => {
    // The child's own record never arrives: the family link has to come from
    // the creation event, which already carries the parent.
    if (url.pathname === "/api/session/ses_child") return new Promise<Response>(() => {})
    if (url.pathname === "/api/session/ses_parent") return json({ data: sessionInfo("ses_parent", undefined) })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await data.session.sync("ses_parent")
    emitEvent(events, {
      id: "evt_child_created",
      created: 1,
      type: "session.created",
      durable: durable("ses_child", 0, 2),
      data: {
        sessionID: "ses_child",
        projectID: "proj_test",
        location: { directory },
        parentID: "ses_parent",
        agent: "reviewer",
        title: "Review implementation",
        created: 1,
      },
    })
    emitEvent(events, {
      id: "evt_child_started",
      created: 2,
      type: "session.execution.started",
      durable: durable("ses_child", 1),
      data: { sessionID: "ses_child" },
    })

    await wait(() => data.session.status("ses_child") === "running")
    expect(data.session.get("ses_child")?.parentID).toBe("ses_parent")
    expect(data.session.family("ses_parent")).toEqual(["ses_parent", "ses_child"])
    expect(runningSubagents(data, "ses_parent")).toEqual(["ses_child"])
  } finally {
    app.renderer.destroy()
  }
})

test("rehydrates durable subagent tasks for active families when the stream connects", async () => {
  const events = createEventStream()
  let requests = 0
  const task: SessionOrchestrationTask = {
    sessionID: "ses_child",
    parentID: "ses_parent",
    description: "Review implementation",
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
    background: true,
    state: "waiting",
    question: { id: "qst_review", text: "Proceed?", time: 1 },
    revision: 1,
    time: { created: 1, updated: 2 },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/active") return json({ data: { ses_child: { type: "running" } } })
    if (url.pathname === "/api/session/ses_child") return json({ data: sessionInfo("ses_child", "ses_parent") })
    if (url.pathname === "/api/session/ses_parent/subagent") {
      requests++
      return json(subagentPage([task]))
    }
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => requests === 1)
    await wait(() => data.session.subagent.page("ses_parent")?.data.length === 1)
    expect(data.session.subagent.page("ses_parent")?.data[0]?.state).toBe("waiting")
    expect(requests).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("indexes subagents that are already running when the stream connects", async () => {
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/active") return json({ data: { ses_child: { type: "running" } } })
    const match = url.pathname.match(/^\/api\/session\/([^/]+)$/)
    if (match && match[1] !== "active")
      return json({
        data: sessionInfo(match[1], match[1] === "ses_child" ? "ses_parent" : undefined),
      })
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => data.session.status("ses_child") === "running")
    // The root-only preload never loads children, so an already-running
    // subagent has to be adopted from the active map.
    await wait(() => runningSubagents(data, "ses_parent").length === 1)
    expect(data.session.family("ses_parent")).toEqual(["ses_child"])
  } finally {
    app.renderer.destroy()
  }
})

test("refetches durable subagent tasks changed during an in-flight sync", async () => {
  const events = createEventStream()
  let requests = 0
  let state: SessionOrchestrationTask["state"] = "running"
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const task = (): SessionOrchestrationTask => ({
    sessionID: "ses_child",
    parentID: "ses_parent",
    description: "Review implementation",
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
    background: true,
    state,
    revision: requests,
    time: { created: 1, updated: requests + 1 },
  })
  const calls = createFetch(async (url) => {
    if (url.pathname === "/api/session/ses_child") return new Promise<Response>(() => {})
    if (url.pathname !== "/api/session/ses_parent/subagent") return undefined
    requests++
    if (requests > 1) return json(subagentPage([task()]))
    const snapshot = task()
    await gate
    return json(subagentPage([snapshot]))
  }, events)
  let data!: ReturnType<typeof useData>

  function Probe() {
    data = useData()
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    const first = data.session.subagent.sync("ses_parent")
    await wait(() => requests === 1)

    emitEvent(events, {
      id: "evt_child_created",
      created: 1,
      type: "session.created",
      durable: durable("ses_child", 0, 2),
      data: {
        sessionID: "ses_child",
        projectID: "proj_test",
        location: { directory },
        parentID: "ses_parent",
        agent: "reviewer",
        title: "Review implementation",
        created: 1,
      },
    })
    emitEvent(events, {
      id: "evt_child_completed",
      created: 2,
      type: "session.task.updated",
      durable: durable("ses_child", 1),
      data: {
        sessionID: "ses_child",
        change: { type: "completed", excerpt: "done" },
      },
    })
    // Ordered delivery: once this marker landed the two events above were
    // applied, and the list request above is still gated.
    emitEvent(events, {
      id: "evt_child_started",
      created: 3,
      type: "session.execution.started",
      durable: durable("ses_child", 2),
      data: { sessionID: "ses_child" },
    })
    await wait(() => data.session.status("ses_child") === "running")
    expect(data.session.get("ses_child")?.parentID).toBe("ses_parent")
    await wait(() => requests === 2)

    state = "completed"
    release()
    await first
    expect(data.session.subagent.page("ses_parent")?.data[0]?.state).toBe("running")

    // The task event restored the top page while the first request was in
    // flight. The stale response cannot replace that newer page.
    await data.session.subagent.sync("ses_parent")
    expect(requests).toBe(3)
    expect(data.session.subagent.page("ses_parent")?.data[0]?.state).toBe("completed")
  } finally {
    app.renderer.destroy()
  }
})
