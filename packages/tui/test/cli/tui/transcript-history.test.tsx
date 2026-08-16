/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ycoding-ai/client"
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
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"

const sessionID = "ses_history"

test("loads the complete transcript with one unpaged canonical request", async () => {
  const messages = Array.from({ length: 60 }, (_, index) => user(index + 1))
  const searches: string[] = []
  const mounted = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/message`) return
    searches.push(url.search)
    return json({ data: messages })
  })

  try {
    await mounted.data.session.message.sync(sessionID)

    expect(searches).toEqual([""])
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
    time: { created: index },
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
  return { data, destroy: () => app.renderer.destroy() }
}
