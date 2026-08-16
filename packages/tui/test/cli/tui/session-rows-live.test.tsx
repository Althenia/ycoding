/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { YCodingEvent } from "@ycoding-ai/client"
import { ClientProvider, useClient } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { createSessionRows, type SessionRow } from "../../../src/routes/session/rows"
import { createApi, createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function durable(sessionID: string, seq: number) {
  return { aggregateID: sessionID, seq, version: 2 as const }
}

async function mountRows(sessionID: string) {
  const events = createEventStream()
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
        <DataProvider>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  await wait(() => client.connection.status() === "connected")
  // Let the initial data.session.message.sync() settle so a later, unrelated
  // full reconcile does not incidentally mask a row appended for a message
  // that was never created.
  await data.session.message.sync(sessionID)
  return { rows, data, events, destroy: () => app.renderer.destroy() }
}

test("an initial instructions.updated event that never becomes a message never renders a row", async () => {
  const sessionID = "session-instructions-initial"
  const mounted = await mountRows(sessionID)

  try {
    // data.tsx skips creating a local message for this event when
    // metadata.instructions.initial === true (see data.tsx's
    // "session.instructions.updated" case), so no message for this ID ever exists.
    mounted.events.emit({
      id: "evt_instructions_initial",
      created: 1,
      type: "session.instructions.updated",
      location: { directory },
      durable: durable(sessionID, 0),
      metadata: { instructions: { initial: true } },
      data: { sessionID, delta: { "core/date": "0".repeat(64) } },
    } as YCodingEvent)
    await Bun.sleep(50)

    expect(mounted.data.session.message.get(sessionID, "msg_instructions_initial")).toBeUndefined()
    expect(mounted.rows.some((row: SessionRow) => row.type === "message")).toBe(false)
  } finally {
    mounted.destroy()
  }
})

