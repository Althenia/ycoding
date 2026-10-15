import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import type { useData } from "../../src/context/data"
import { checkpointSummary, compactionCheckpointMessage, sessionHistoryFixture } from "../fixture/session-history"
import { json } from "../fixture/tui-client"
import { renderScreen } from "./harness"

const prunedWording = "Message removed by compaction; use a later message."

async function open(options: { prunedRoutes?: boolean; stage?: () => Promise<Response> } = {}) {
  const fixture = sessionHistoryFixture(6)
  fixture.messages.forEach((message) => {
    if (message.type === "assistant")
      message.content = [{ type: "text", text: `Synthetic response ${Number(message.id.slice(-6))}` }]
  })
  fixture.messages.unshift(compactionCheckpointMessage())
  fixture.release()
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
      if (options.stage && url.pathname === `/api/session/${fixture.sessionID}/revert/stage`) {
        stages.push(url.pathname)
        return options.stage()
      }
      if (
        options.prunedRoutes &&
        request.method === "POST" &&
        [`/api/session/${fixture.sessionID}/fork`, `/api/session/${fixture.sessionID}/revert/stage`].includes(
          url.pathname,
        )
      ) {
        stages.push(url.pathname)
        return json(
          {
            _tag: "HistoryPrunedError",
            sessionID: fixture.sessionID,
            messageID: "msg_000004",
            message: "server pruned wording",
          },
          { status: 410 },
        )
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

test.each(["undo", "dialog"] as const)(
  "%s fills the composer only after successful revert staging",
  async (action) => {
    const requested = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    const { screen, stages } = await open({
      stage: () => {
        requested.resolve()
        return response.promise
      },
    })
    try {
      await screen.input.typeText(action === "undo" ? "/undo" : "/timeline")
      screen.input.pressKey("RETURN")
      if (action === "dialog") {
        await waitFor(screen, () => screen.frame().includes("Session timeline"), "timeline dialog")
        screen.input.pressKey("RETURN")
        await waitFor(screen, () => screen.frame().includes("Revert to here"), "message dialog")
        await screen.input.typeText("Revert to here")
        await screen.renderOnce()
        screen.input.pressKey("RETURN")
      }
      await requested.promise
      expect(stages).toHaveLength(1)
      expect(composer(screen.renderer.root)?.plainText).toBe("")
      response.resolve(json({ data: { messageID: "msg_000004" } }))
      await waitFor(
        screen,
        () => composer(screen.renderer.root)?.plainText === "Inspect synthetic module 4",
        "restored composer",
      )
      expect(screen.frame()).toContain("Inspect synthetic module 4")
    } finally {
      response.resolve(json({ data: { messageID: "msg_000004" } }))
      await screen.dispose()
    }
  },
  30000,
)

test("the checkpoint message is resident but never a chat row, timeline option, or fork option", async () => {
  const { fixture, screen, data } = await open()
  try {
    expect(data().session.message.get(fixture.sessionID, "msg_compaction_digest")).toMatchObject({ type: "synthetic" })
    screen.scrollbox()?.scrollTo(0)
    await screen.renderOnce()
    await waitFor(screen, () => screen.frame().includes("Inspect synthetic module 0"), "oldest retained prompt")
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
  const { screen, stages } = await open({ prunedRoutes: true })
  try {
    await screen.input.typeText("/fork")
    screen.input.pressKey("RETURN")
    await waitFor(screen, () => screen.frame().includes("From latest"), "fork dialog")
    screen.input.pressKey("DOWN")
    screen.input.pressKey("RETURN")
    await waitFor(
      screen,
      () => screen.frame().includes(prunedWording) || screen.frame().includes("server pruned wording"),
      "pruned fork toast",
    )
    expect(stages).toHaveLength(1)
    expect(screen.frame()).toContain(prunedWording)
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
    await waitFor(
      screen,
      () => screen.frame().includes(prunedWording) || screen.frame().includes("server pruned wording"),
      "pruned undo toast",
    )
    expect(stages).toHaveLength(1)
    expect(composer(screen.renderer.root)?.plainText).toBe("")
    expect(screen.frame()).toContain(prunedWording)
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
    await waitFor(
      screen,
      () => screen.frame().includes(prunedWording) || screen.frame().includes("server pruned wording"),
      "pruned revert toast",
    )
    expect(stages).toHaveLength(1)
    expect(composer(screen.renderer.root)?.plainText).toBe("")
    expect(screen.frame()).toContain(prunedWording)
  } finally {
    await screen.dispose()
  }
}, 30000)
