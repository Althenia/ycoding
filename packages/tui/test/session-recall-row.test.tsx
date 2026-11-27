/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { foldRecallEvents } from "@ycoding-ai/client/cue-recall"
import { SessionRecallRow } from "../src/routes/session/recall-row"
import { reduceSessionRows } from "../src/routes/session/rows"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const injected = {
  kind: "memory",
  id: "build/linker",
  stage: "injected",
  method: "rrf",
  scores: { bm25: 1.5, semantic: 0.25, rrf: 0.03, rank: 0 },
  reason: "matched cue",
  source: { id: "memory:repository/build/linker", revision: "sha256:abc" },
  okf: { type: "Decision", trust: "trusted", freshness: "fresh", lifecycle: "active" },
}
const rejected = { ...injected, id: "old/note", stage: "rejected", rejection: "stale" }
const recorded = (id: string, created: number, data: Record<string, unknown> = {}) => ({
  type: "session.recall.recorded",
  id,
  created,
  data: { sessionID: "ses_a", key: id, trigger: "cue", cueID: "c1", methods: ["cue", "rrf"], outcome: "injected", items: [injected, rejected], elapsedMs: 18, injectedTokens: 340, ...data },
})
const cue = { type: "session.cue.detected", id: "evt_c", created: 10, data: { sessionID: "ses_a", cueID: "c1", kind: "command", subject: "cargo build" } }
const entry = foldRecallEvents([cue, recorded("recall_1", 20)]).entries[0]!

async function render(inspected: unknown[] = []) {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([import("../src/config"), import("../src/context/theme")])
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <SessionRecallRow entry={entry} onInspect={(target) => inspected.push(target)} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Recalled 1 memory"))
  return app
}

test("recall row starts collapsed with the summary, elapsed time and injected tokens", async () => {
  const app = await render()
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("↺")
    expect(frame).toContain("+")
    expect(frame).toContain("Recalled 1 memory")
    expect(frame).toContain("18 ms · ~340 tokens")
    expect(frame).not.toContain("matched cue")
  } finally {
    app.renderer.destroy()
  }
})

test("expanding shows cue, method, relevance, provenance and OKF state; diagnostics stay folded", async () => {
  const inspected: unknown[] = []
  const app = await render(inspected)
  try {
    const line = app.captureCharFrame().split("\n").findIndex((text) => text.includes("Recalled 1 memory"))
    await app.mockMouse.click(4, line)
    await app.waitForFrame((frame) => frame.includes("matched cue"))
    const frame = app.captureCharFrame()
    for (const text of ["cue command · cargo build", "method cue, rrf", "relevance bm25 1.5 · semantic 0.25", "source memory:repository/build/linker @ sha256:abc", "trust trusted", "freshness fresh", "lifecycle active"])
      expect(frame).toContain(text)
    expect(frame).toContain("1 not injected")
    expect(frame).not.toContain("rejected · stale")
    const diagnostics = frame.split("\n").findIndex((text) => text.includes("1 not injected"))
    await app.mockMouse.click(10, diagnostics)
    await app.waitForFrame((next) => next.includes("rejected · stale"))
    const inspect = app.captureCharFrame().split("\n").findIndex((text) => text.includes("inspect"))
    await app.mockMouse.click(app.captureCharFrame().split("\n")[inspect]!.indexOf("inspect") + 1, inspect)
    expect(inspected).toEqual([{ kind: "memory", id: "build/linker", sourceID: "memory:repository/build/linker", revision: "sha256:abc" }])
  } finally {
    app.renderer.destroy()
  }
})

test("recall rows interleave chronologically and drop entries with nothing injected", () => {
  const messages = [
    { type: "user", id: "first", text: "Q", time: { created: 10 } },
    { type: "assistant", id: "reply", agent: "build", model: { providerID: "p", id: "m" }, content: [{ type: "text", text: "Answer", time: { created: 30 } }], time: { created: 30 } },
  ] as never
  const abstained = recorded("recall_2", 21, { outcome: "abstained", abstention: "no_match", items: [{ ...injected, stage: "candidate" }], injectedTokens: 0 })
  const rows = reduceSessionRows(messages, new Set(), false, undefined, foldRecallEvents([recorded("recall_1", 20), abstained]).entries)
  expect(rows.map((row) => (row.type === "recall" ? row.entry.id : row.type === "message" ? row.messageID : row.type))).toEqual([
    "first",
    "recall_1",
    "part",
  ])
})
