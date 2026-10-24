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
const decisions: NonNullable<GuardrailStatusOutput["decisions"]> = [
  { sessionID, requestID: "grq_audit_0", created: 10, reply: "once", authority: "baseline", choice: "allow", confidence: 0.92 },
  { sessionID, requestID: "grq_audit_1", created: 11, reply: "always", authority: "yolo", choice: "allow", confidence: 0.99 },
  { sessionID, requestID: "grq_audit_2", created: 12, reply: "once", authority: "yolo", choice: "allow", confidence: 0.94 },
  { sessionID, requestID: "grq_audit_3", created: 13, reply: "reject", authority: "yolo", choice: "deny", confidence: 0.93 },
  { sessionID, requestID: "grq_audit_4", created: 14, reply: "reject", authority: "baseline", choice: "deny", confidence: 0.9 },
]
const dismissals: NonNullable<GuardrailStatusOutput["dismissals"]> = [0.98, 0.94, 0.98, 0.99, 0.98, 0.99].map((confidence, index) => ({
  sessionID, eventID: `evt_audit_dismissal_${index}`, created: 3 + index,
  ruleID: "standard.review.outside-repo", confidence,
}))
const pending = {
  id: "grq_audit_pending", rootSessionID: sessionID, sessionID, action: "shell", resources: ["fixture action"],
  ruleIDs: ["custom.review.fixture"], reason: "CURRENT PENDING HARD REVIEW", standard: false, hardReview: true,
}
const covered: SessionMessageInfo = { type: "user", id: "msg_audit_covered", text: "COVERED CHAT", time: { created: 1 } }
const retained: SessionMessageInfo = { type: "user", id: "msg_audit_retained", text: "RETAINED CHAT", time: { created: 100 } }
const checkpoint: SessionMessageInfo = {
  type: "synthetic", id: "msg_audit_checkpoint", text: "Summary", metadata: { compactionCheckpoint: { through: 40 } },
  time: { created: 150 },
}

test("queued input predating a checkpoint cannot restore covered audit rows", () => {
  const rows = reduceSessionRows([
    checkpoint,
    { type: "user", id: "msg_audit_queued", text: "Earlier queued input", time: { created: 1 } },
    retained,
  ], new Set(["msg_audit_queued"]), false, { sessionID, decisions, pending: [pending] })
  expect(rows.map((row) => row.type === "message" ? row.messageID : row.type === "guardrail" ? row.requestID : row.type))
    .toEqual([retained.id, "msg_audit_queued", pending.id])
  expect(decisions).toHaveLength(5)
})

function routeFor(input: { messages: () => SessionMessageInfo[]; decisions?: () => NonNullable<GuardrailStatusOutput["decisions"]>; snapshot?: () => Promise<void>; onSnapshot?: () => void; mutations: string[] }) {
  return async (url: URL, request: Request) => {
    if (request.method !== "GET") input.mutations.push(url.pathname)
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if ([`/api/session/${sessionID}/permission`, `/api/session/${sessionID}/todo`].includes(url.pathname)) return json({ location, data: [] })
    if (url.pathname === `/api/session/${sessionID}/snapshot`) {
      input.onSnapshot?.()
      await input.snapshot?.()
      return sessionSnapshot(sessionID, input.messages(), { session })
    }
    if (url.pathname === `/api/session/${sessionID}/guardrail/request`) return json({ data: [pending] })
    if (url.pathname === `/api/session/${sessionID}/guardrail`) return json({ data: {
      rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 3, blocked: 2, counters: [], invalidFiles: [], decisions: input.decisions?.() ?? decisions, dismissals,
    } })
    return undefined
  }
}

function assertAutomaticHistoryHidden(frame: string) {
  expect(frame).not.toContain("match verifier")
  expect(frame).not.toContain("not a real match")
  expect(frame).not.toContain("approved once")
  expect(frame).not.toContain("approved for this session")
  expect(frame).toContain("CURRENT PENDING HARD REVIEW")
}

test.each([false, true])("settled automatic history stays out of compacted rendering through hydration and reconnect: %s", async (hydrated) => {
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
        if (messages.some((message) => message.id === retained.id) && !messages.some((message) => message.id === covered.id)) pruned.resolve()
        if (messages.some((message) => message.id === checkpoint.id) && value.session.message.history(sessionID)?.status === "ready" && snapshots > 1) reloaded.resolve()
      })
    },
    route: routeFor({ messages: () => compacted ? [checkpoint, retained] : [covered, retained], onSnapshot: () => snapshots++, mutations }),
  })
  const assertAudits = (rejectionsVisible: boolean) => {
    const frame = screen.frame()
    assertAutomaticHistoryHidden(frame)
    expect(frame.match(/!!\+\s+guardrail/g) ?? []).toHaveLength(rejectionsVisible ? 2 : 0)
    expect(frame.includes("YOLO decision model rejected · 0.93")).toBe(rejectionsVisible)
    expect(frame.includes("baseline decision model rejected · 0.9")).toBe(rejectionsVisible)
    expect(data!.session.guardrail.decided(sessionID)).toEqual(decisions)
    expect(data!.session.guardrail.list(sessionID)).toEqual([pending])
    expect(mutations).toEqual([])
  }
  try {
    assertAudits(!hydrated)
    if (!hydrated) {
      const frame = screen.frame()
      expect(frame.indexOf("COVERED CHAT")).toBeLessThan(frame.indexOf("YOLO decision model rejected · 0.93"))
      expect(frame.indexOf("baseline decision model rejected · 0.9")).toBeLessThan(frame.indexOf("RETAINED CHAT"))
      expect(frame.indexOf("RETAINED CHAT")).toBeLessThan(frame.indexOf("CURRENT PENDING HARD REVIEW"))
    }
    await screen.waitForEventStream()
    if (!hydrated) {
      compacted = true
      screen.events.emit({ id: "evt_audit_compacted", created: 150, type: "session.compaction.ended",
        durable: { aggregateID: sessionID, seq: 60, version: 2 }, data: {
          sessionID, jobID: "cmp_audit", revision: 1, boundary: { messageID: covered.id, seq: 40 },
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

test("cold open never shows settled history ahead of chat, and live or replayed automatic outcomes stay hidden", async () => {
  const gate = Promise.withResolvers<void>()
  let snapshots = 0
  let data: ReturnType<typeof useData> | undefined
  const reloaded = Promise.withResolvers<void>()
  const mutations: string[] = []
  const recorded = [...decisions]
  const screen = await renderScreen({
    width: 200, height: 80, args: { sessionID },
    settle: (frame) => frame.captureCharFrame().includes("CURRENT PENDING HARD REVIEW") && data?.session.guardrail.decided(sessionID).length === decisions.length,
    data: (value) => {
      data = value
      createEffect(() => {
        if (value.session.message.history(sessionID)?.status === "ready" && snapshots > 1) reloaded.resolve()
      })
    },
    route: routeFor({ messages: () => [covered, retained], decisions: () => recorded, snapshot: () => gate.promise, onSnapshot: () => snapshots++, mutations }),
  })
  try {
    await screen.renderOnce()
    const loading = screen.frame()
    expect(data!.session.message.list(sessionID)).toEqual([])
    expect(loading).toContain("Loading session")
    expect(loading).not.toContain("COVERED CHAT")
    assertAutomaticHistoryHidden(loading)
    expect(loading).not.toContain("rejected")
    expect(loading.match(/!!\+\s+guardrail/g) ?? []).toHaveLength(0)
    gate.resolve()
    const deadline = Date.now() + 5000
    while (!screen.frame().includes("RETAINED CHAT") && Date.now() < deadline) await Bun.sleep(10)
    await screen.renderOnce()
    const hydratedFrame = screen.frame()
    assertAutomaticHistoryHidden(hydratedFrame)
    expect(hydratedFrame.indexOf("COVERED CHAT")).toBeLessThan(hydratedFrame.indexOf("YOLO decision model rejected · 0.93"))
    expect(hydratedFrame.indexOf("baseline decision model rejected · 0.9")).toBeLessThan(hydratedFrame.indexOf("RETAINED CHAT"))
    expect(hydratedFrame.indexOf("RETAINED CHAT")).toBeLessThan(hydratedFrame.indexOf("CURRENT PENDING HARD REVIEW"))

    await screen.waitForEventStream()
    recorded.push(
      { sessionID, requestID: "grq_live_allow", created: 120, reply: "once", authority: "yolo", choice: "allow", confidence: 0.96 },
      { sessionID, requestID: "grq_live_reject", created: 130, reply: "reject", authority: "yolo", choice: "deny", confidence: 0.97 },
    )
    screen.events.emit({ id: "evt_live_allow", created: 120, type: "guardrail.replied", data: {
      rootSessionID: sessionID, sessionID, requestID: "grq_live_allow", reply: "once", decidedBy: "decision-model", authority: "yolo", choice: "allow", confidence: 0.96,
    } } satisfies YCodingEvent)
    screen.events.emit({ id: "evt_live_dismissal", created: 121, type: "session.guardrail.dismissed",
      durable: { aggregateID: sessionID, seq: 121, version: 1 },
      data: { sessionID, reviewSessionID: sessionID, ruleID: "standard.review.git-destructive", confidence: 0.95 },
    } satisfies YCodingEvent)
    screen.events.emit({ id: "evt_live_reject", created: 130, type: "guardrail.replied", data: {
      rootSessionID: sessionID, sessionID, requestID: "grq_live_reject", reply: "reject", decidedBy: "decision-model", authority: "yolo", choice: "deny", confidence: 0.97,
    } } satisfies YCodingEvent)
    const liveDeadline = Date.now() + 5000
    while (!screen.frame().includes("rejected · 0.97") && Date.now() < liveDeadline) await Bun.sleep(10)
    await screen.renderOnce()
    const live = screen.frame()
    expect(live).toContain("rejected · 0.97")
    expect(data!.session.guardrail.decided(sessionID).map((item) => item.requestID)).toContain("grq_live_allow")
    assertAutomaticHistoryHidden(live)
    expect(live.indexOf("RETAINED CHAT")).toBeLessThan(live.indexOf("rejected · 0.97"))
    expect(live.indexOf("rejected · 0.97")).toBeLessThan(live.indexOf("CURRENT PENDING HARD REVIEW"))

    screen.events.disconnect()
    await reloaded.promise
    await screen.renderOnce()
    assertAutomaticHistoryHidden(screen.frame())
    expect(screen.frame()).toContain("YOLO decision model rejected · 0.93")
    expect(mutations).toEqual([])
  } finally {
    gate.resolve()
    await screen.dispose()
  }
}, 30_000)
