import { expect, test } from "bun:test"
import { createEffect } from "solid-js"
import type { GuardrailStatusOutput, SessionMessageInfo, YCodingEvent } from "@ycoding-ai/client"
import type { useData } from "../src/context/data"
import { reduceSessionRows } from "../src/routes/session/rows"
import { json, sessionSnapshot } from "./fixture/tui-client"
import { renderScreen } from "./screen/harness"

const sessionID = "ses_guardrail_compaction_audit"
const directory = "/tmp/ycoding/guardrail-compaction-audit"
const location = { directory, project: { id: "proj_guardrail_audit", directory } }
const session = {
  id: sessionID, title: "Guardrail audit history", projectID: location.project.id, location: { directory },
  agent: "build", model: { providerID: "openai", id: "fixture" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 100 },
}
const decisions: NonNullable<GuardrailStatusOutput["decisions"]> = [0.92, 0.99, 0.94, 0.93, 0.9].map((confidence, index) => ({
  sessionID, requestID: `grq_audit_${index}`, created: 10 + index, reply: "once",
  authority: index === 3 ? "yolo" : "baseline", choice: "allow", confidence,
}))
const dismissals: NonNullable<GuardrailStatusOutput["dismissals"]> = [0.98, 0.94, 0.98, 0.99, 0.98, 0.99].map((confidence, index) => ({
  sessionID, eventID: `evt_audit_dismissal_${index}`, created: 3 + index,
  ruleID: "standard.review.outside-repo", confidence,
}))
const pending = {
  id: "grq_audit_pending", rootSessionID: sessionID, sessionID, action: "shell", resources: ["fixture action"],
  ruleIDs: ["custom.review.fixture"], reason: "CURRENT PENDING HARD REVIEW", standard: false, hardReview: true,
}
const retained: SessionMessageInfo = { type: "user", id: "msg_audit_retained", text: "RETAINED CHAT", time: { created: 100 } }
const checkpoint: SessionMessageInfo = {
  type: "synthetic", id: "msg_audit_checkpoint", text: "Summary", metadata: { compactionCheckpoint: { through: 40 } },
  time: { created: 150 },
}

test("queued input predating a checkpoint cannot restore covered mixed audit rows", () => {
  const rows = reduceSessionRows([
    checkpoint,
    { type: "user", id: "msg_audit_queued", text: "Earlier queued input", time: { created: 1 } },
    retained,
  ], new Set(["msg_audit_queued"]), false, { sessionID, decisions, dismissals, pending: [pending] })
  expect(rows.map((row) => row.type === "message" ? row.messageID : row.type === "guardrail" ? row.requestID : row.type))
    .toEqual([retained.id, "msg_audit_queued", pending.id])
  expect(decisions).toHaveLength(5)
  expect(dismissals).toHaveLength(6)
})

test.each([false, true])("mixed audit history stays outside compacted rendering through hydration and reconnect: %s", async (hydrated) => {
  let compacted = hydrated
  let snapshots = 0
  let data: ReturnType<typeof useData> | undefined
  const pruned = Promise.withResolvers<void>()
  const reloaded = Promise.withResolvers<void>()
  const mutations: string[] = []
  const screen = await renderScreen({
    width: 200, height: 120, args: { sessionID }, settle: "CURRENT PENDING HARD REVIEW", sessionReady: true,
    data: (value) => {
      data = value
      createEffect(() => {
        const messages = value.session.message.list(sessionID)
        if (messages.some((message) => message.id === retained.id) && !messages.some((message) => message.id === "msg_audit_covered")) pruned.resolve()
        if (messages.some((message) => message.id === checkpoint.id) && value.session.message.history(sessionID)?.status === "ready" && snapshots > 1) reloaded.resolve()
      })
    },
    route: (url, request) => {
      if (request.method !== "GET") mutations.push(url.pathname)
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if ([`/api/session/${sessionID}/permission`, `/api/session/${sessionID}/todo`].includes(url.pathname)) return json({ location, data: [] })
      if (url.pathname === `/api/session/${sessionID}/snapshot`) {
        snapshots++
        return sessionSnapshot(sessionID, compacted ? [checkpoint, retained] : [
          { type: "user", id: "msg_audit_covered", text: "COVERED CHAT", time: { created: 1 } }, retained,
        ], { session })
      }
      if (url.pathname === `/api/session/${sessionID}/guardrail/request`) return json({ data: [pending] })
      if (url.pathname === `/api/session/${sessionID}/guardrail`) return json({ data: {
        rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [], decisions, dismissals,
      } })
      return undefined
    },
  })
  const assertAudits = (visible: boolean) => {
    expect(screen.frame().match(/!!\+\s+guardrail/g) ?? []).toHaveLength(visible ? 11 : 0)
    expect(screen.frame().includes("match verifier · not a real match")).toBe(visible)
    expect(screen.frame().includes("baseline decision model approved once")).toBe(visible)
    expect(screen.frame().includes("YOLO decision model approved once")).toBe(visible)
    expect(screen.frame()).toContain("CURRENT PENDING HARD REVIEW")
    expect(data!.session.guardrail.decided(sessionID)).toEqual(decisions)
    expect(data!.session.guardrail.dismissed(sessionID)).toEqual(dismissals)
    expect(data!.session.guardrail.list(sessionID)).toEqual([pending])
    expect(mutations).toEqual([])
  }
  try {
    assertAudits(!hydrated)
    await screen.waitForEventStream()
    if (!hydrated) {
      compacted = true
      screen.events.emit({ id: "evt_audit_compacted", created: 150, type: "session.compaction.ended",
        durable: { aggregateID: sessionID, seq: 60, version: 2 }, data: {
          sessionID, jobID: "cmp_audit", revision: 1, boundary: { messageID: "msg_audit_covered", seq: 40 },
          metrics: { excludedMessages: 264, excludedParts: 0, inputTokens: 900_000, retainedTokens: 110_000 },
        },
      } satisfies YCodingEvent)
      await pruned.promise
      await screen.renderOnce()
      assertAudits(false)
    }
    data!.session.guardrail.invalidate(sessionID)
    await data!.session.guardrail.sync(sessionID)
    await screen.renderOnce()
    assertAudits(false)
    screen.events.disconnect()
    await reloaded.promise
    await screen.renderOnce()
    expect(snapshots).toBeGreaterThan(1)
    assertAudits(false)
  } finally {
    await screen.dispose()
  }
}, 30_000)
