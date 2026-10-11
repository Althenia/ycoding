/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionMessageInfo, YCodingEvent } from "@ycoding-ai/client"
import { testRender } from "@opentui/solid"
import { onMount, type ParentProps } from "solid-js"
import {
  DataProvider,
  estimateResidentSessionMemory,
  formatMemoryBytes,
  sessionMemoryLines,
  useData,
} from "../../../src/context/data"
import { ClientProvider } from "../../../src/context/client"
import { createApi, createEventStream, createFetch, json, sessionSnapshot } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"

const sessionID = "ses_history"

test("loads a short transcript with one bounded canonical snapshot request", async () => {
  const messages = Array.from({ length: 60 }, (_, index) => user(index + 1))
  const searches: string[] = []
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/snapshot`) return
    searches.push(url.search)
    return sessionSnapshot(sessionID, messages)
  })

  try {
    await mounted.data.session.message.sync(sessionID)

    expect(searches).toEqual(["?limit=100"])
    expect(mounted.data.session.message.list(sessionID).map((message) => message.id)).toEqual(
      messages.map((message) => message.id),
    )
  } finally {
    mounted.destroy()
  }
})

test("estimates all resident message payloads without claiming exact heap attribution", () => {
  const message = user(1)
  const estimate = estimateResidentSessionMemory({
    messages: [message],
    residentSessions: 1,
    process: { heapUsed: 1024, heapTotal: 2 * 1024 * 1024, rss: 3 * 1024 * 1024 },
  })

  expect(estimate.counts).toEqual({ messages: 1, residentSessions: 1 })
  expect(estimate.estimated.total).toBeGreaterThan(0)
  expect(sessionMemoryLines(estimate)).toContain("Messages 1 · Resident sessions 1")
  expect(sessionMemoryLines(estimate).at(-1)).toContain("not exact per-session heap attribution")
  expect(formatMemoryBytes(2 * 1024 * 1024)).toBe("2.0 MiB")
})

test("global events retain transcripts only for resident or loading Sessions", async () => {
  const canonical = Promise.withResolvers<Response>()
  const mounted = await mount((url) =>
    url.pathname === `/api/session/${sessionID}/snapshot`
      ? canonical.promise.then((response) => response.clone())
      : undefined,
  )
  const observed = (id: string, owner: string, text: string) => ({
    id: `evt_${id}`,
    created: 1,
    type: "session.context.observed" as const,
    durable: { aggregateID: owner, seq: 1, version: 1 as const },
    data: { sessionID: owner, source: "session-state" as const, text },
  })
  const deliver = async (event: YCodingEvent) => {
    const received = Promise.withResolvers<void>()
    const unsubscribe = mounted.data.on(event.type, (update) => {
      if (update.id === event.id) received.resolve()
    })
    mounted.events.emit(event)
    await received.promise
    unsubscribe()
  }
  try {
    await deliver(observed("unopened", "ses_unopened", "Do not retain unopened history"))
    expect(mounted.data.session.message.list("ses_unopened")).toEqual([])
    expect(mounted.data.session.message.memory(sessionID).counts.residentSessions).toBe(0)
    const load = mounted.data.session.message.sync(sessionID)
    await deliver(observed("loading", sessionID, "Live during canonical read"))
    canonical.resolve(sessionSnapshot(sessionID, [user(1)]))
    await load
    expect(mounted.data.session.message.get(sessionID, "msg_loading")).toMatchObject({
      text: "Live during canonical read",
    })
    expect(mounted.data.session.message.list(sessionID)).toHaveLength(2)
    mounted.data.session.message.evict(sessionID)
    await deliver(observed("evicted", sessionID, "Do not resurrect evicted history"))
    await deliver({
      id: "evt_evicted_compaction",
      created: 2,
      type: "session.compaction.admitted",
      durable: { aggregateID: sessionID, seq: 2, version: 2 },
      data: { sessionID, jobID: "cmp_evicted" },
    })
    expect(mounted.data.session.message.list(sessionID)).toEqual([])
    expect(mounted.data.session.message.memory(sessionID).counts.residentSessions).toBe(0)
    await mounted.data.session.message.sync(sessionID)
    expect(mounted.data.session.message.list(sessionID).map((message) => message.id)).toEqual([user(1).id])
  } finally {
    canonical.resolve(sessionSnapshot(sessionID, []))
    mounted.destroy()
  }
}, 30000)

function user(index: number): SessionMessageInfo {
  const digest = index.toString(16).padStart(64, "0")
  return {
    id: `msg_${index.toString().padStart(6, "0")}`,
    type: "user",
    text: `message ${index}`,
    files: [
      {
        content: {
          type: "managed",
          digest,
          bytes: Buffer.byteLength(`payload ${index}`),
          path: `attachments/sha256/${digest.slice(0, 2)}/${digest}`,
        },
        mime: "text/plain",
        name: `${index}.txt`,
      },
    ],
    time: { created: index },
  }
}

test("rehydrates cached pending inputs when a transcript becomes resident again", async () => {
  const pending = {
    id: "msg_pending_residency",
    sessionID,
    admittedSeq: 1,
    timeCreated: 1,
    type: "user",
    data: { text: "Keep the admitted steer visible" },
    delivery: "steer",
  }
  const mounted = await mount((url) => {
    if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, [])
    if (url.pathname === `/api/session/${sessionID}/pending`) return json({ data: [pending] })
    return undefined
  })
  try {
    await mounted.data.session.pending.sync(sessionID)
    expect(mounted.data.session.message.list(sessionID)).toEqual([])
    await mounted.data.session.message.sync(sessionID)
    expect(mounted.data.session.message.get(sessionID, pending.id)).toMatchObject({ text: pending.data.text })
    mounted.data.session.message.evict(sessionID)
    await Promise.all([mounted.data.session.pending.sync(sessionID), mounted.data.session.message.sync(sessionID)])
    expect(mounted.data.session.message.get(sessionID, pending.id)).toMatchObject({ text: pending.data.text })
    expect(mounted.data.session.message.list(sessionID)).toHaveLength(1)
  } finally {
    mounted.destroy()
  }
})

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
