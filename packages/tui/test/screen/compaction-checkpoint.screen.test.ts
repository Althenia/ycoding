import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import type { useData } from "../../src/context/data"
import { checkpointSummary, compactionCheckpointMessage, sessionHistoryFixture } from "../fixture/session-history"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

// The toast box shows one line of text, so the wording must fit its 54-column text width.
const prunedWording = "Message removed by compaction; use a later message."

function compactedFixture() {
  const fixture = sessionHistoryFixture(6)
  fixture.messages.forEach((message) => {
    if (message.type === "assistant") message.content = [{ type: "text", text: `Synthetic response ${Number(message.id.slice(-6))}` }]
  })
  fixture.messages.unshift(compactionCheckpointMessage())
  fixture.release()
  return fixture
}

function pruned(sessionID: string) {
  return json(
    { _tag: "HistoryPrunedError", sessionID, messageID: "msg_000004", message: "server pruned wording" },
    { status: 410 },
  )
}

async function open(options: { prunedRoutes?: boolean } = {}) {
  const fixture = compactedFixture()
  const stages: string[] = []
  let data!: ReturnType<typeof useData>
  const screen = await renderScreen({
    width: 120,
    height: 36,
    args: { sessionID: fixture.sessionID },
    settle: "Synthetic response 5",
    state: "/tmp/ycoding-tui-perf/state",
    config: { session: { sidebar: "hide" } },
    data: (value) => {
      data = value
    },
    route: (url, request) => {
      if (options.prunedRoutes && request.method === "POST" && url.pathname === `/api/session/${fixture.sessionID}/fork`)
        return pruned(fixture.sessionID)
      if (options.prunedRoutes && request.method === "POST" && url.pathname === `/api/session/${fixture.sessionID}/revert/stage`) {
        stages.push(url.pathname)
        return pruned(fixture.sessionID)
      }
      return fixture.route(url, request)
    },
  })
  return { fixture, screen, stages, data: () => data }
}

async function waitFor(screen: Awaited<ReturnType<typeof renderScreen>>, ready: () => boolean, label: string) {
  const deadline = Date.now() + 5000
  while (!ready() && Date.now() < deadline) {
    await screen.renderOnce()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  if (!ready()) throw new Error(`timed out waiting for ${label}:\n${screen.frame()}`)
}

function composer(node: Renderable): TextareaRenderable | undefined {
  if (node instanceof TextareaRenderable) return node
  return node.getChildren().map(composer).find(Boolean)
}

test("the checkpoint message is resident but never a chat row, timeline option, or fork option", async () => {
  const { fixture, screen, data } = await open()
  try {
    expect(data().session.message.get(fixture.sessionID, "msg_compaction_digest")).toMatchObject({ type: "synthetic" })
    expect(screen.frame()).toContain("Inspect synthetic module 2")
    expect(screen.frame()).not.toContain("Compaction checkpoint")
    expect(screen.frame()).not.toContain(checkpointSummary)
    expect(screen.scrollbox()?.getRenderable("msg_compaction_digest")).toBeUndefined()

    await screen.input.typeText("/timeline")
    screen.input.pressKey("RETURN")
    await waitFor(screen, () => screen.frame().includes("Session timeline"), "timeline dialog")
    expect(screen.frame()).toContain("Inspect synthetic module 4")
    expect(screen.frame()).not.toContain("Compaction checkpoint")
    expect(screen.frame()).not.toContain(checkpointSummary)
    screen.input.pressKey("ESCAPE")
    await waitFor(screen, () => !screen.frame().includes("Session timeline"), "timeline closed")

    await screen.input.typeText("/fork")
    screen.input.pressKey("RETURN")
    await waitFor(screen, () => screen.frame().includes("From latest"), "fork dialog")
    expect(screen.frame()).toContain("Inspect synthetic module 4")
    expect(screen.frame()).not.toContain("Compaction checkpoint")
    expect(screen.frame()).not.toContain(checkpointSummary)
  } finally {
    await screen.dispose()
  }
}, 30000)

test("forking from a message removed by compaction shows the compaction wording", async () => {
  const { screen } = await open({ prunedRoutes: true })
  try {
    await screen.input.typeText("/fork")
    screen.input.pressKey("RETURN")
    await waitFor(screen, () => screen.frame().includes("From latest"), "fork dialog")
    screen.input.pressKey("DOWN")
    screen.input.pressKey("RETURN")
    await waitFor(screen, () => screen.frame().includes(prunedWording), "pruned fork toast")
    expect(screen.frame()).not.toContain("server pruned wording")
  } finally {
    await screen.dispose()
  }
}, 30000)

test("undo of a message removed by compaction shows the wording and leaves the composer unchanged", async () => {
  const { screen, stages } = await open({ prunedRoutes: true })
  try {
    await screen.input.typeText("/undo")
    screen.input.pressKey("RETURN")
    await waitFor(screen, () => screen.frame().includes(prunedWording), "pruned undo toast")
    expect(stages).toHaveLength(1)
    expect(composer(screen.renderer.root)?.plainText).toBe("")
  } finally {
    await screen.dispose()
  }
}, 30000)

test("revert from the message dialog of a message removed by compaction leaves the composer unchanged", async () => {
  const { screen, stages } = await open({ prunedRoutes: true })
  try {
    await screen.input.typeText("/timeline")
    screen.input.pressKey("RETURN")
    await waitFor(screen, () => screen.frame().includes("Session timeline"), "timeline dialog")
    screen.input.pressKey("RETURN")
    await waitFor(screen, () => screen.frame().includes("Revert to here"), "message dialog")
    await screen.input.typeText("Revert to here")
    await screen.renderOnce()
    screen.input.pressKey("RETURN")
    await waitFor(screen, () => screen.frame().includes(prunedWording), "pruned revert toast")
    expect(stages).toHaveLength(1)
    expect(composer(screen.renderer.root)?.plainText).toBe("")
  } finally {
    await screen.dispose()
  }
}, 30000)
