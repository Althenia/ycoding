import assert from "node:assert/strict"
import { createInterface } from "node:readline"
import { testRender } from "@opentui/solid"
import { make, type V5Client } from "@ycoding-ai/client/v5"
import { createEffect } from "solid-js"
import { ClientProvider, useClient } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { createSessionRows } from "../src/routes/session/rows"
import { TestTuiContexts } from "../test/fixture/tui-environment"

const sessionID = "ses_wire_view"
const assistantID = "msg_wire_view"
const endpoint = process.env.YCODING_TEST_WIRE_ENDPOINT
assert(endpoint, "the Rust socket test must supply its real endpoint")
const client = make({
  endpoint: { url: endpoint, auth: { type: "basic", username: "ycoding", password: "secret" } },
  location: { directory: "/project" },
})
const connected = Promise.withResolvers<void>()
const reloadReady = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const deltaSeen = Promise.withResolvers<void>()
const input = createInterface({ input: process.stdin })
input.on("line", (line) => {
  assert.equal(line, "release")
  release.resolve()
})
const observations = { snapshots: 0, dropped: 0, deltas: 0 }
const api = {
  ...client,
  session: {
    ...client.session,
    async snapshot(request, options) {
      const snapshot = await client.session.snapshot(request, options)
      observations.snapshots++
      assert.equal(snapshot.session.id, sessionID)
      assert.equal(snapshot.watermark.aggregateID, sessionID)
      if (observations.snapshots === 2) {
        assert.equal(snapshot.watermark.seq, 2)
        const assistant = snapshot.messages.find((message) => message.id === assistantID)
        assert(assistant?.type === "assistant")
        assert.deepEqual(
          assistant.content.map((part) => (part.type === "text" ? part.text : part.type)),
          ["base", "recovered missing part"],
        )
        process.stdout.write("WIRE_VIEW reload-held\n")
        await release.promise
      }
      return snapshot
    },
  },
  event: {
    ...client.event,
    async *subscribe(options) {
      for await (const event of client.event.subscribe(options)) {
        if (
          event.type === "session.renamed" &&
          event.data.sessionID === sessionID &&
          event.data.title === "lost gap event"
        ) {
          observations.dropped++
          continue
        }
        yield event
      }
    },
  },
} satisfies V5Client
let data!: ReturnType<typeof useData>
let rows: ReturnType<typeof createSessionRows> = []
function Probe() {
  data = useData()
  rows = createSessionRows(() => sessionID)
  const connection = useClient()
  createEffect(() => {
    const status = data.session.message.history(sessionID)?.status
    if (connection.connection.status() === "connected") connected.resolve()
    if (observations.snapshots === 2 && status === "ready") reloadReady.resolve()
  })
  data.on("session.text.delta", (event) => {
    if (event.data.sessionID !== sessionID) return
    observations.deltas++
    deltaSeen.resolve()
  })
  return <box />
}

const app = await testRender(() => (
  <TestTuiContexts paths={{ home: process.env.YCODING_TEST_HOME, state: process.env.XDG_STATE_HOME }}>
    <ClientProvider api={api}>
      <DataProvider>
        <Probe />
      </DataProvider>
    </ClientProvider>
  </TestTuiContexts>
))
try {
  await connected.promise
  await data.session.message.sync(sessionID)
  assert.equal(observations.snapshots, 1)
  assert.equal(data.session.message.history(sessionID)?.watermark, 0)
  assert.deepEqual(texts(), ["base"])
  process.stdout.write("WIRE_VIEW hydrated\n")
  await deltaSeen.promise
  assert.equal(data.session.message.history(sessionID)?.status, "loading")
  assert.deepEqual(texts(), ["base live"])
  process.stdout.write("WIRE_VIEW delta-seen\n")
  await reloadReady.promise
  assert.equal(observations.snapshots, 2, "the sequence gap must issue exactly one canonical reload")
  assert.equal(observations.dropped, 1)
  assert.equal(observations.deltas, 1)
  assert.deepEqual(texts(), ["base live", "recovered missing part"])
  assert.equal(data.session.message.history(sessionID)?.watermark, 2)
  assert.equal(data.session.message.list(sessionID).filter((message) => message.id === assistantID).length, 1)
  assert.deepEqual(
    rows.filter((row) => row.type === "part").map((row) => row.ref),
    [
      { messageID: assistantID, partID: "text:0" },
      { messageID: assistantID, partID: "text:1" },
    ],
  )
  process.stdout.write("WIRE_VIEW done\n")
} finally {
  release.resolve()
  app.renderer.destroy()
  client.transport.close()
  input.close()
}

function texts() {
  const message = data.session.message.get(sessionID, assistantID)
  assert(message?.type === "assistant", "the resident view must contain the canonical assistant")
  return message.content.map((part) => {
    assert.equal(part.type, "text")
    assert("text" in part)
    return part.text
  })
}
