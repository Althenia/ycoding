import { expect, test } from "bun:test"
import type { useData } from "../../src/context/data"
import { checkpointSummary, compactionCheckpointMessage, sessionHistoryFixture } from "../fixture/session-history"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

function compactedFixture() {
  const fixture = sessionHistoryFixture(200)
  fixture.messages.splice(0, 50, compactionCheckpointMessage())
  fixture.release()
  return fixture
}

test("copy reads the retained canonical transcript explicitly, checkpoint first, without expanding resident history", async () => {
  const fixture = compactedFixture()
  const copied = Promise.withResolvers<string>()
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({ width: 120, height: 36, args: { sessionID: fixture.sessionID }, settle: "Synthetic response 199", route: fixture.route, state: "/tmp/ycoding-tui-perf/state", config: { session: { sidebar: "hide" } }, data: (value) => { data = value }, clipboard: { read: async () => undefined, write: async (value) => { copied.resolve(value) } } })
  try {
    await screen.input.typeText("/copy")
    screen.input.pressKey("RETURN")
    const text = await copied.promise
    expect(text).toContain(`## Compaction checkpoint\n\n${checkpointSummary}\n\n---\n\n## User\n\nInspect synthetic module 50`)
    expect(text.indexOf("## Compaction checkpoint")).toBeLessThan(text.indexOf("Inspect synthetic module 50"))
    expect(text).not.toContain("<conversation-checkpoint>")
    expect(text).not.toContain("Inspect synthetic module 48")
    expect(text).not.toContain("Synthetic response 49")
    expect(text).toContain("Synthetic response 199")
    expect(fixture.requests.filter((request) => request === `GET /api/session/${fixture.sessionID}/message`)).toHaveLength(1)
    expect(data.session.message.list(fixture.sessionID)).toHaveLength(100)
  } finally { await screen.dispose() }
}, 30000)

async function exported(format: "markdown" | "json") {
  const fixture = compactedFixture()
  const copied = Promise.withResolvers<string>()
  const screen = await renderScreen({ width: 120, height: 36, args: { sessionID: fixture.sessionID }, settle: "Synthetic response 199", route: fixture.route, state: "/tmp/ycoding-tui-perf/state", config: { session: { sidebar: "hide" } }, clipboard: { read: async () => undefined, write: async (value) => { copied.resolve(value) } } })
  try {
    await screen.input.typeText("/export")
    screen.input.pressKey("RETURN")
    const deadline = Date.now() + 5000
    while (!screen.frame().includes("Export") && Date.now() < deadline) await screen.renderOnce()
    if (format === "json") {
      screen.input.pressKey("TAB")
      screen.input.pressKey("RETURN")
      screen.input.pressKey("TAB")
      screen.input.pressKey("TAB")
    } else {
      screen.input.pressKey("TAB")
      screen.input.pressKey("TAB")
      screen.input.pressKey("TAB")
    }
    screen.input.pressKey("RETURN")
    return await copied.promise
  } finally { await screen.dispose() }
}

test("markdown export copies the checkpoint section first and nothing earlier", async () => {
  const text = await exported("markdown")
  expect(text).toContain(`## Compaction checkpoint\n\n${checkpointSummary}\n\n---\n\n## User\n\nInspect synthetic module 50`)
  expect(text).not.toContain("Inspect synthetic module 48")
  expect(text).not.toContain("<conversation-checkpoint>")
}, 30000)

test("json export keeps the checkpoint message as the first data message", async () => {
  const parsed = JSON.parse(await exported("json"))
  expect(parsed.messages[0]).toMatchObject({ type: "synthetic", description: "Compaction checkpoint", metadata: { compactionCheckpoint: { manifestDigest: "digest", through: 49 } } })
  expect(parsed.messages[1]).toMatchObject({ type: "user", text: "Inspect synthetic module 50" })
  expect(parsed.messages).toHaveLength(151)
}, 30000)

test("active skills outside the loaded window suppress duplicate pending skill loads", async () => {
  const fixture = sessionHistoryFixture(200)
  fixture.release()
  const last = fixture.messages.at(-1)
  if (last?.type !== "assistant") throw new Error("fixture needs a final assistant message")
  last.content.push({ type: "tool", id: "call_duplicate_outside", name: "skill", state: { status: "running", input: { id: "outside" }, content: [], structured: {} }, time: { created: 201, ran: 201 } })
  const skillRead = Promise.withResolvers<void>()
  const screen = await renderScreen({ width: 120, height: 36, args: { sessionID: fixture.sessionID }, settle: "Synthetic response 199", state: "/tmp/ycoding-tui-perf/state", config: { session: { sidebar: "hide" } }, route: (url, request) => {
    if (url.pathname === `/api/session/${fixture.sessionID}/skills`) { skillRead.resolve(); return json({ data: [{ id: "outside", state: "active" }] }) }
    return fixture.route(url, request)
  } })
  try {
    const end = performance.now() + 5000
    while (screen.frame().includes("Loading skill") && performance.now() < end) {
      await screen.renderOnce()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(screen.frame()).not.toContain("Loading skill")
    await skillRead.promise
  } finally { await screen.dispose() }
}, 30000)
