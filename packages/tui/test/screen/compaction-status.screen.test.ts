import { expect, test } from "bun:test"
import type { YCodingEvent } from "@ycoding-ai/client"
import { directory, json, sessionSnapshot } from "../fixture/tui-client"
import { DESIGN_VIEWPORT } from "../viewport"
import { renderScreen } from "./harness"

test("shows Summarizing only while a compaction job runs and keeps live usage current", async () => {
  const sessionID = "ses_context_pressure"
  const tokens = { input: 81_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const model = { providerID: "openai", id: "test-model" }
  const session = {
    id: sessionID, title: "Context pressure", projectID: "proj_test", location: { directory }, agent: "build",
    model, cost: 1, tokens, time: { created: 1, updated: 1 },
  }
  let cost = 1
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    sessionReady: true,
    settle: "$1.00",
    route(url) {
      if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, [], { session })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/usage`) return json({ data: {
        logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens, cost,
      } })
    },
  })
  async function frame(predicate: (value: string) => boolean) {
    const deadline = Date.now() + 5_000
    do {
      await screen.renderOnce()
      if (predicate(screen.frame())) return screen.frame()
      await new Promise<void>((resolve) => setImmediate(resolve))
    } while (Date.now() < deadline)
    throw new Error(`Expected compaction frame:\n${screen.frame()}`)
  }
  let seq = 0
  type CompactionEvent = Extract<YCodingEvent, { type: `session.compaction.${"admitted" | "started" | "ended" | "failed"}` }>
  type Lifecycle = { [Type in CompactionEvent["type"]]: Pick<Extract<CompactionEvent, { type: Type }>, "type" | "data"> }[CompactionEvent["type"]]
  function emit(event: Lifecycle) {
    seq++
    screen.events.emit({ ...event, id: `evt_context_pressure_${seq}`, created: seq, location: { directory },
      durable: { aggregateID: sessionID, seq, version: 2 } })
  }

  try {
    await screen.waitForEventStream()
    screen.events.emit({ id: "evt_context_warning", created: 1, type: "session.diagnostics.updated",
      location: { directory }, data: { sessionID, diagnostics: {
        model, context: { total: 81_000, limit: 100_000, remaining: 19_000, percent: 81 },
        tokens: { uncachedInput: 81_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cache: { eligible: 0, mechanism: "none", readReported: false, writeReported: false },
      } } })
    expect(await frame((value) => value.includes("81,000 / 100,000"))).not.toContain("Summarizing")
    for (const outcome of ["completed", "failed", "skipped"] as const) {
      const jobID = `cmp_${outcome}`
      const data = { sessionID, jobID }
      const pressure = { estimatedInputTokens: 81_000, safeInputTokens: 100_000 }
      emit({ type: "session.compaction.admitted", data: { ...data, pressure } })
      expect(await frame((value) => value.includes("81,000 / 100,000 est"))).not.toContain("Summarizing")
      if (outcome !== "skipped") {
        emit({ type: "session.compaction.started", data })
        await frame((value) => value.includes("Summarizing"))
      }
      if (outcome === "completed") emit({ type: "session.compaction.ended", data: {
        ...data, revision: 1, boundary: { messageID: "msg_checkpoint_boundary", seq: 1 },
        metrics: { excludedMessages: 3, excludedParts: 5, inputTokens: 81_000, retainedTokens: 40_000 },
      } })
      else emit({ type: "session.compaction.failed", data: {
        ...data, code: outcome === "skipped" ? "superseded" : "context_limit_unresolved",
        error: { type: "compaction", message: "Compaction did not activate a checkpoint" },
      } })
      await frame((value) => !value.includes("Summarizing") && !value.includes("81,000 / 100,000 est"))
    }
    cost = 12.34
    screen.events.emit({ id: "evt_context_usage", created: seq + 1, type: "session.usage.updated",
      location: { directory }, data: { sessionID, cost, tokens } })
    await frame((value) => value.includes("$12.34"))
  } finally {
    await screen.dispose()
  }
}, 40_000)
