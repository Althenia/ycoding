import { describe, expect, test } from "bun:test"
import {
  isGoalSteerAdmission,
  readTeamCue,
  noticeSummary,
  formatPartDuration,
  sessionStatusLabel,
  sessionStatusTimed,
  toolSummary,
  toolTone,
  classifySyntheticNotice,
  transcriptMessageVisible,
  transcriptPartVisible,
  visibleTranscriptMessages,
  appendShellOutputPage,
  applySessionEvent,
  contextWindowDisplay,
  generationSpeedDisplay,
  boundedText,
  createSessionView,
  mergeFileChanges,
  mergeShellOutputSnapshot,
  previewText,
  readAutonomy,
  readCompactionHistory,
  readCapturedChangesPage,
  readFileChangeEvent,
  readFileChangeList,
  readMessageList,
  readSnapshot,
  readForms,
  readShellOutputPage,
  readSnapshotParts,
  readToolContent,
  sealedPartKeys,
  shellOutputFetchFor,
  shellOutputFor,
  shellOutputNotice,
  toolShellID,
  withShellOutputFetch,
  withShellOutputPage,
  type ShellOutputView,
  type SessionView,
} from "./projection"

test("projects managed user files without exposing their storage path", () => {
  const digest = "a".repeat(64)
  const message = readMessageList({ data: [{ id: "msg_files", type: "user", text: "Look", files: [
    { name: "chart.png", mime: "image/png", content: { type: "managed", digest, bytes: 1_234, path: `attachments/sha256/aa/${digest}` } },
    { name: "notes.pdf", mime: "application/pdf", content: { type: "managed", digest: "b".repeat(64), bytes: 42, path: `attachments/sha256/bb/${"b".repeat(64)}` } },
    { name: "untrusted", mime: "image/svg+xml", content: { type: "managed", digest: "not-a-digest", bytes: 10, path: "local" } },
  ], time: { created: 1 } }] })
  expect(message).toEqual([{
    kind: "user", id: "msg_files", text: "Look", state: "promoted", created: 1,
    attachments: [
      { name: "chart.png", mime: "image/png", bytes: 1_234, digest },
      { name: "notes.pdf", mime: "application/pdf", bytes: 42, digest: "b".repeat(64) },
    ],
  }])
})

test("accepts only a complete captured summary whose grouped counts match its patch entries", () => {
  const patch = { path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" } as const
  const page = { mode: "transcript", placementMessageID: "msg_reply", data: [{ path: "src/a.ts", additions: 2, deletions: 2, status: "modified", files: [patch, patch] }], cursor: { next: "page_2" } } as const
  expect(readCapturedChangesPage(page)).toEqual(page)
  expect(readCapturedChangesPage({ ...page, data: [{ ...page.data[0], additions: 65 }] })).toBeUndefined()
  expect(readCapturedChangesPage({ ...page, data: [{ ...page.data[0], additions: 3, files: [{ ...patch, additions: 2 }, patch] }] })).toBeUndefined()
  expect(readCapturedChangesPage({ ...page, data: [{ ...page.data[0], files: [{ ...patch, path: "src/foreign.ts" }] }] })).toBeUndefined()
  expect(readCapturedChangesPage({ mode: "recovery", placementMessageID: "msg_compact", data: [{ path: "src/large.ts", additions: 0, deletions: 0, status: "modified", files: [{ path: "src/large.ts", diff: "", additions: 0, deletions: 0, status: "modified", unavailable: true }] }] })).toBeDefined()
})

test("keeps attached images on an admitted live prompt until its snapshot arrives", () => {
  const digest = "c".repeat(64)
  const view = applySessionEvent(createSessionView("ses_a"), { type: "session.input.admitted", data: {
    sessionID: "ses_a", inputID: "msg_live", input: { type: "user", delivery: "steer", data: { text: "Picture", files: [
      { name: "live.webp", mime: "image/webp", content: { type: "managed", digest, bytes: 75, path: `attachments/sha256/cc/${digest}` } },
    ] } },
  } }, 2)
  expect(view.messages[0]).toMatchObject({ kind: "user", id: "msg_live", attachments: [{ name: "live.webp", mime: "image/webp", digest, bytes: 75 }] })
})

test("allows only image data URIs with matching supported MIME types in tool output", () => {
  const png = "data:image/png;base64,iVBORw0KGgo="
  expect(readToolContent([
    { type: "file", mime: "image/png", uri: png, name: "plot.png" },
    { type: "file", mime: "image/jpeg", uri: "data:image/png;base64,AAAA", name: "mismatch" },
    { type: "file", mime: "image/svg+xml", uri: "data:image/svg+xml;base64,PHN2Zz4=" },
    { type: "file", mime: "image/gif", uri: "javascript:alert(1)" },
    { type: "file", mime: "image/webp", uri: "data:image/webp;base64,AQID" },
  ])).toEqual([
    { kind: "image", uri: png, mime: "image/png", name: "plot.png" },
    { kind: "other", type: "file", summary: expect.any(String) },
    { kind: "other", type: "file", summary: expect.any(String) },
    { kind: "other", type: "file", summary: expect.any(String) },
    { kind: "image", uri: "data:image/webp;base64,AQID", mime: "image/webp" },
  ])
})

test("keeps a large canonical inline tool image", () => {
  const uri = `data:image/png;base64,${Buffer.alloc(8 * 1024 * 1024, 42).toString("base64")}`
  expect(readToolContent([{ type: "file", mime: "image/png", uri }])).toEqual([{ kind: "image", uri, mime: "image/png" }])
})

test("extracts only durable live subagent delegation and terminal notification identities", () => {
  expect(readTeamCue({ id: "evt_1", type: "session.tool.progress", durable: { aggregateID: "ses_root", seq: 1 }, data: {
    sessionID: "ses_root", assistantMessageID: "msg_1", callID: "call_1", structured: { sessionID: "ses_child", status: "running" },
  } })).toEqual({ id: "msg_1:call_1:ses_child", kind: "delegated", childID: "ses_child" })
  expect(readTeamCue({ id: "evt_success", type: "session.tool.success", durable: { aggregateID: "ses_root", seq: 2 }, data: {
    sessionID: "ses_root", assistantMessageID: "msg_1", callID: "call_1", structured: { sessionID: "ses_child", status: "running" },
  } })).toEqual({ id: "msg_1:call_1:ses_child", kind: "delegated", childID: "ses_child" })
  expect(readTeamCue({ id: "evt_2", type: "session.synthetic", durable: { aggregateID: "ses_root", seq: 2 }, data: {
    sessionID: "ses_root", metadata: { source: "subagent_notification", childID: "ses_child", type: "completed", revision: 3 },
  } })).toEqual({ id: "evt_2:3:ses_child", kind: "reported", childID: "ses_child", outcome: "completed" })
  expect(readTeamCue({ id: "evt_3", type: "session.synthetic", data: { sessionID: "ses_root", metadata: { source: "subagent_notification", childID: "ses_child", type: "completed", revision: 3 } } })).toBeUndefined()
  expect(readTeamCue({ id: "evt_4", type: "session.synthetic", durable: { aggregateID: "ses_root", seq: 4 }, data: { sessionID: "ses_root", metadata: { source: "other", childID: "ses_child", type: "completed", revision: 4 } } })).toBeUndefined()
})

test("recognizes only the admitted synthetic goal steer as the durable fact that a goal is active", () => {
  const admitted = (input: unknown) => ({ type: "session.input.admitted", data: { sessionID: "ses_a", inputID: "msg_1", input } })
  const steer = { type: "synthetic", data: { text: "Continue", description: "Goal · steer", metadata: { autonomy: { yolo: 0, goal: true, iteration: 0 } } }, delivery: "steer" }
  expect(isGoalSteerAdmission(admitted(steer))).toBe(true)
  expect(isGoalSteerAdmission(admitted({ type: "user", data: { text: "Continue", metadata: { autonomy: { goal: true } } }, delivery: "steer" }))).toBe(false)
  expect(isGoalSteerAdmission(admitted({ ...steer, data: { ...steer.data, metadata: { autonomy: { yolo: 2, goal: false } } } }))).toBe(false)
  expect(isGoalSteerAdmission(admitted({ ...steer, data: { ...steer.data, metadata: { source: "subagent_notification" } } }))).toBe(false)
  expect(isGoalSteerAdmission(admitted("not a record"))).toBe(false)
  expect(isGoalSteerAdmission({ type: "session.synthetic", data: { metadata: { autonomy: { goal: true } } } })).toBe(false)
  expect(isGoalSteerAdmission(undefined)).toBe(false)
})

const event = (type: string, data: Record<string, unknown>) => ({ id: `evt_${type}`, type, data })

function apply(view: SessionView, type: string, data: Record<string, unknown>, now = 1) {
  return applySessionEvent(view, event(type, data), now)
}

test("tracks live execution and part timings for the transcript and status bar", () => {
  let view = apply(createSessionView("ses_a"), "session.execution.started", {}, 1_000)
  expect(view.executionStarted).toBe(1_000)
  view = apply(view, "session.step.started", { assistantMessageID: "msg_a" }, 1_100)
  view = apply(view, "session.reasoning.started", { assistantMessageID: "msg_a", ordinal: 0 }, 1_200)
  view = apply(view, "session.reasoning.ended", { assistantMessageID: "msg_a", ordinal: 0, text: "thinking" }, 3_200)
  view = apply(view, "session.tool.input.started", { assistantMessageID: "msg_a", callID: "call_a", name: "shell" }, 3_300)
  view = apply(view, "session.tool.called", { assistantMessageID: "msg_a", callID: "call_a", input: { command: "bun test" } }, 3_500)
  view = apply(view, "session.tool.success", { assistantMessageID: "msg_a", callID: "call_a", content: [] }, 3_637)
  expect(view.messages[0]).toMatchObject({ created: 1_100, parts: [
    { kind: "reasoning", started: 1_200, completed: 3_200 },
    { kind: "tool", started: 3_300, ran: 3_500, completed: 3_637 },
  ] })
  view = apply(view, "session.execution.succeeded", {}, 4_000)
  expect(view.executionStarted).toBeUndefined()
})

test("terminal step and run events use durable creation time for activity, not local receipt time", () => {
  let view = createSessionView("ses_a")
  for (const type of ["session.step.ended", "session.step.failed", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
    const created = (view.activeAt ?? 0) + 100
    view = applySessionEvent(view, { type, created, data: { sessionID: "ses_a", assistantMessageID: "msg_a" } }, created + 900)
    expect(view.activeAt).toBe(created)
  }
  view = apply(view, "session.renamed", { title: "New title" }, 9_000)
  expect(view.activeAt).toBe(500)
  expect(applySessionEvent(view, { type: "session.execution.succeeded", created: 400, data: { sessionID: "ses_a" } }, 10_000).activeAt).toBe(500)
})

test("live diagnostics replace selected-Session speed and context, then clear on compaction or unreported values", () => {
  const selected = { id: "gpt-6", providerID: "openai", variant: "high" }
  const first = { model: selected, tokens: 12, durationNs: 2_000_000, tokensPerSecond: 6_000 }
  const second = { model: selected, tokens: 15, durationNs: 3_000_000, tokensPerSecond: 5_000 }
  const diagnostics = (speed?: unknown, limit?: number) => ({
    model: selected, context: { total: 74_000, ...(limit === undefined ? {} : { limit }), remaining: 184_000, percent: 29 },
    tokens: { uncachedInput: 60_000, output: 10_000, reasoning: 2_000, cacheRead: 2_000, cacheWrite: 0 },
    cache: { eligible: 62_000, mechanism: "openai-prefix-cache", readReported: true, writeReported: false },
    ...(speed === undefined ? {} : { generationSpeed: speed }),
  })
  const initial = apply(createSessionView("ses_a"), "session.diagnostics.updated", {
    sessionID: "ses_a", diagnostics: diagnostics({ latest: first, recent: [first] }, 258_000),
  })
  expect(generationSpeedDisplay(initial, selected)?.label).toBe("6,000 tok/s")
  expect(contextWindowDisplay(initial, selected)?.usedPercent).toBe(29)
  const updated = apply(initial, "session.diagnostics.updated", {
    sessionID: "ses_a", diagnostics: diagnostics({ latest: second, recent: [first, second] }, 258_000),
  }, 2)
  expect(generationSpeedDisplay(updated, selected)).toMatchObject({ label: "5,000 tok/s", trend: expect.any(String) })
  expect(updated.generationSpeed?.recent).toHaveLength(2)
  const switched = apply(updated, "session.model.selected", { sessionID: "ses_a", model: { ...selected, variant: "low" } })
  expect(generationSpeedDisplay(switched, switched.model)).toBeUndefined()
  expect(contextWindowDisplay(switched, switched.model)).toBeUndefined()
  const unreported = apply(updated, "session.diagnostics.updated", {
    sessionID: "ses_a", diagnostics: diagnostics(undefined, undefined),
  }, 3)
  expect(generationSpeedDisplay(unreported, selected)).toBeUndefined()
  expect(contextWindowDisplay(unreported, selected)).toBeUndefined()
  const compacted = apply(updated, "session.compaction.ended", { sessionID: "ses_a", jobID: "cmp_1",
    boundary: { messageID: "msg_before", seq: 1 }, metrics: { excludedMessages: 1, excludedParts: 0, inputTokens: 100, retainedTokens: 40 } }, 4)
  expect(generationSpeedDisplay(compacted, selected)).toBeUndefined()
  expect(contextWindowDisplay(compacted, selected)).toBeUndefined()
})

test("ends the elapsed clock on an idle status before the next execution starts", () => {
  const started = apply(createSessionView("ses_a"), "session.execution.started", {}, 1_000)
  const retry = apply(apply(started, "session.step.started", { assistantMessageID: "msg_a" }, 1_100), "session.retry.scheduled", { assistantMessageID: "msg_a", attempt: 2, at: 6_000, error: { code: "rate_limit", message: "Slow down" } }, 2_000)
  const idle = apply(retry, "session.status", { status: { type: "idle" } }, 4_000)
  expect(idle).toMatchObject({ status: "idle" })
  expect(idle.executionStarted).toBeUndefined()
  expect(idle.messages.find((message) => message.kind === "assistant")?.retry).toBeUndefined()
  const next = apply(idle, "session.execution.started", {}, 10_000)
  expect(next.executionStarted).toBe(10_000)
  expect(sessionStatusLabel(next, 11_000)).toBe("cooking · 1.0s")
})

test("starts a fresh elapsed clock when the previous terminal event was missed", () => {
  const started = apply(createSessionView("ses_a"), "session.execution.started", {}, 1_000)
  const next = apply(started, "session.execution.started", {}, 10_000)
  expect(next.executionStarted).toBe(10_000)
  expect(sessionStatusLabel(next, 11_000)).toBe("cooking · 1.0s")
})

test("retry belongs to the latest unfinished assistant step and yields to progress", () => {
  let view = apply(createSessionView("ses_a"), "session.execution.started", {}, 1_000)
  view = apply(view, "session.step.started", { assistantMessageID: "msg_first" }, 1_100)
  view = apply(view, "session.retry.scheduled", { assistantMessageID: "msg_first", attempt: 2, at: 6_000, error: { code: "rate_limit", message: "Slow down" } }, 2_000)
  expect(sessionStatusLabel(view, 4_000)).toBe("1 failed · retry 2 · in 2s")
  expect(sessionStatusLabel(view, 6_000)).toBe("retrying · attempt 2")
  const failedStep = apply(view, "session.step.failed", { assistantMessageID: "msg_first", error: { code: "rate_limit", message: "Stopped" } }, 6_020)
  expect(sessionStatusLabel(failedStep, 6_030)).toBe("cooking · 5.0s")
  expect(failedStep.messages.find((message) => message.id === "msg_first")).toMatchObject({ kind: "assistant", retry: undefined })
  view = apply(view, "session.text.started", { assistantMessageID: "msg_first", ordinal: 0 }, 6_050)
  expect(sessionStatusLabel(view, 6_050)).toBe("retrying · attempt 2")
  view = apply(view, "session.text.delta", { assistantMessageID: "msg_first", ordinal: 0, delta: "Recovered" }, 6_100)
  expect(sessionStatusLabel(view, 6_200)).toBe("cooking · 5.2s")
  view = apply(view, "session.step.ended", { assistantMessageID: "msg_first" }, 6_300)
  view = apply(view, "session.step.started", { assistantMessageID: "msg_next" }, 6_400)
  expect(sessionStatusLabel(view, 6_500)).toBe("cooking · 5.5s")
  for (const [part, label] of [
    [{ kind: "reasoning" as const, ordinal: 0, text: "", started: 6_000 }, "thinking · 5.5s"],
    [{ kind: "tool" as const, callID: "call_a", name: "shell", status: "running" as const, content: [], started: 6_000 }, "tool running · 5.5s"],
  ] as const) {
    const active = { ...view, messages: [...view.messages.slice(0, -1), { kind: "assistant" as const, id: "msg_next", created: 6_400, parts: [part], retry: { attempt: 2, at: 6_000, code: "rate_limit" } }] }
    expect(sessionStatusLabel(active, 6_500)).toBe(label)
  }
})

test("retry from a status frame does not survive idle or an execution failure", () => {
  let view = apply(createSessionView("ses_a"), "session.execution.started", {}, 1_000)
  view = apply(view, "session.step.started", { assistantMessageID: "msg_a" }, 1_100)
  view = apply(view, "session.status", { status: { type: "retry", attempt: 2, next: 5_000, message: "Slow down" } }, 2_000)
  expect(sessionStatusLabel(view, 3_000)).toBe("1 failed · retry 2 · in 2s")
  const idle = apply(view, "session.status", { status: { type: "idle" } }, 4_000)
  expect(sessionStatusLabel(idle, 6_000)).toBe("ready")
  expect(idle.messages.find((message) => message.id === "msg_a")).toMatchObject({ kind: "assistant", retry: undefined })
  const failed = apply(view, "session.execution.failed", { error: { code: "provider_error", message: "Stopped" } }, 4_000)
  expect(sessionStatusLabel(failed, 6_000)).toBe("provider error")
  expect(failed.messages.find((message) => message.id === "msg_a")).toMatchObject({ kind: "assistant", retry: undefined })
})

test("a projected assistant retry is scoped to its unfinished step after reconnect", () => {
  const snapshot = readSnapshot({ session: { id: "ses_a" }, watermark: { seq: 5 }, messages: [{
    id: "msg_a", type: "assistant", agent: "gsd", model: { providerID: "openai", id: "gpt-5" }, content: [],
    retry: { attempt: 2, at: 6_000, error: { code: "rate_limit", message: "Slow down" } }, time: { created: 2_000 },
  }] })
  expect(snapshot?.messages[0]).toMatchObject({ kind: "assistant", retry: { attempt: 2, at: 6_000, code: "rate_limit" } })
  const active = { ...createSessionView("ses_a"), status: "running" as const, messages: snapshot?.messages ?? [] }
  expect(sessionStatusLabel(active, 4_000)).toBe("1 failed · retry 2 · in 2s")
  expect(sessionStatusLabel({ ...active, status: "idle" }, 6_000)).toBe("ready")
})

test("a durable retry establishes running status when the start event was missed", () => {
  const view = apply(createSessionView("ses_a"), "session.retry.scheduled", { assistantMessageID: "msg_a", attempt: 2, at: 5_000, error: { code: "rate_limit", message: "Slow down" } }, 2_000)
  expect(view.status).toBe("running")
  expect(sessionStatusLabel(view, 3_000)).toBe("1 failed · retry 2 · in 2s")
})

test("keeps short row durations precise without changing live one-decimal elapsed", () => {
  expect(formatPartDuration(137)).toBe("137ms")
  expect(formatPartDuration(2_000)).toBe("2s")
  expect(formatPartDuration(134_000)).toBe("2m14s")
})

test("derives operational status and elapsed from active work and retry state", () => {
  const base = { ...createSessionView("ses_a"), status: "running" as const, executionStarted: 1_000 }
  expect(sessionStatusLabel(base, 47_700)).toBe("cooking · 46.7s")
  expect(sessionStatusLabel({ ...base, autonomy: { mode: "yolo", yolo: 3 } }, 47_700)).toBe("YOLO 3 · auto-approve · cooking · 46.7s")
  expect(sessionStatusLabel({ ...base, messages: [{ kind: "assistant", id: "a", created: 2_000, parts: [{ kind: "reasoning", ordinal: 0, text: "…", started: 3_000 }] }] }, 49_700)).toBe("thinking · 48.7s")
  expect(sessionStatusLabel({ ...base, messages: [{ kind: "assistant", id: "a", created: 2_000, parts: [{ kind: "tool", callID: "c", name: "shell", status: "running", content: [], started: 3_000 }] }] }, 135_000)).toBe("tool running · 2m14s")
  expect(sessionStatusLabel({ ...base, messages: [{ kind: "assistant", id: "msg_retry", created: 2_000, parts: [], retry: { attempt: 2, at: 6_000, code: "rate_limit" } }] }, 4_000)).toBe("1 failed · retry 2 · in 2s")
  expect(sessionStatusLabel({ ...base, requests: [{ kind: "permission", id: "p", action: "read", resources: [], askedAt: 2_000 }] }, 3_000)).toBe("? awaiting input · 2.0s")
  expect(sessionStatusLabel(base, 3_000, 2)).toBe("waiting · 2 subagents")
  expect(sessionStatusTimed(base, 2)).toBe(false)
  expect(sessionStatusTimed(base, 0)).toBe(true)
  expect(sessionStatusLabel({ ...base, status: "failed" }, 3_000)).toBe("provider error")
  expect(sessionStatusLabel(createSessionView("ses_a"), 3_000)).toBe("ready")
})

test("summarizes runtime observations without exposing raw JSON inline", () => {
  const session = "Authoritative current Session state (JSON):\n{\"autonomy\":{\"mode\":\"goal\",\"yolo\":2},\"todos\":[{}]}"
  expect(noticeSummary("session-state", session)).toBe("Session state · goal · YOLO 2 · 1 task")
  expect(noticeSummary("team-view", "Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n{\"children\":[{\"state\":\"running\"},{\"state\":\"running\"}]}" )).toBe("TeamView · 2 running")
  expect(noticeSummary("session-state", "Authoritative current Session state (JSON):\n{" )).toBe("Session state · unavailable")
  expect(noticeSummary(undefined, session)).toBeUndefined()
  const view = apply(createSessionView("ses_a"), "session.context.observed", { source: "session-state", text: session })
  expect(view.messages[0]).toMatchObject({ kind: "system", source: "session-state" })
  const snapshot = readMessageList({ data: [{ id: "msg_observed", type: "system", text: session, metadata: { contextSource: "session-state" }, time: { created: 1 } }] })
  expect(snapshot[0]).toMatchObject({ kind: "system", source: "session-state" })
  const synthetic = apply(createSessionView("ses_a"), "session.synthetic", { text: session, metadata: { contextSource: "session-state" } })
  expect(synthetic.messages[0]).toMatchObject({ source: "session-state" })
})

test("keeps synthetic notification identity and metadata across admission and snapshot hydration", () => {
  const metadata = { source: "subagent_notification", childID: "ses_child", type: "completed", revision: 2, excerpt: "Verified the repair" }
  const text = `Subagent notification:\n${JSON.stringify(metadata)}`
  const admitted = apply(createSessionView("ses_a"), "session.input.admitted", { inputID: "msg_notify", input: { type: "synthetic", data: { text, description: "Subagent notification", metadata }, delivery: "steer" } })
  expect(admitted.messages[0]).toMatchObject({ kind: "synthetic", metadata, description: "Subagent notification" })
  expect(classifySyntheticNotice(admitted.messages[0]!)).toEqual({ kind: "subagent", label: "ses_child", status: "completed", excerpt: "Verified the repair" })
  const hydrated = readMessageList({ data: [{ id: "msg_notify", type: "synthetic", text, description: "Subagent notification", metadata, time: { created: 1 } }] })
  expect(classifySyntheticNotice(hydrated[0]!)).toEqual({ kind: "subagent", label: "ses_child", status: "completed", excerpt: "Verified the repair" })
  expect(apply(createSessionView("ses_a"), "session.input.admitted", { inputID: "msg_user", input: { type: "user", data: { text: "Ordinary prompt" } } }).messages[0]).toMatchObject({ kind: "user", text: "Ordinary prompt" })
})

test("classifies terminal synthetic statuses without inventing raw-text user messages", () => {
  for (const [type, status] of [["completed", "completed"], ["failed", "failed"], ["waiting", "waiting"], ["unrecognized", "updated"]] as const) {
    expect(classifySyntheticNotice({ kind: "synthetic", id: "n", text: "raw", metadata: { source: "subagent_notification", type, childID: "ses_1" }, created: 1 })).toEqual({ kind: "subagent", label: "ses_1", status })
  }
  expect(classifySyntheticNotice({ kind: "synthetic", id: "n", text: "done", description: "Background finished", metadata: { source: "shell", state: "completed" }, created: 1 })).toEqual({ kind: "completion", label: "Shell", status: "finished", description: "Background finished" })
  expect(classifySyntheticNotice({ kind: "synthetic", id: "n", text: "Keep going", metadata: { autonomy: { goal: true } }, created: 1 })).toEqual({ kind: "goal", text: "Keep going" })
})

test("hides internal observations, empty synthetic rows, and non-display compactions", () => {
  expect(transcriptMessageVisible({ kind: "system", id: "s", text: "state", source: "session-state", created: 1 })).toBe(false)
  expect(transcriptMessageVisible({ kind: "synthetic", id: "t", text: "team", source: "team-view", description: "TeamView update", created: 2 })).toBe(false)
  expect(transcriptMessageVisible({ kind: "synthetic", id: "e", text: "raw", description: "  ", created: 3 })).toBe(false)
  expect(transcriptMessageVisible({ kind: "synthetic", id: "n", text: "notification", description: "Subagent notification", metadata: { source: "subagent_notification", type: "completed" }, created: 4 })).toBe(true)
  expect(transcriptMessageVisible({ kind: "compaction", id: "c", status: "completed", jobID: "cmp_1" })).toBe(true)
  expect(transcriptMessageVisible({ kind: "compaction", id: "r", status: "running", jobID: "cmp_1" })).toBe(true)
  expect(transcriptMessageVisible({ kind: "compaction", id: "p", status: "pending", jobID: "cmp_1" })).toBe(false)
  expect(transcriptMessageVisible({ kind: "compaction", id: "x", status: "failed", jobID: "cmp_1", failureCode: "cancelled" })).toBe(true)
  expect(transcriptMessageVisible({ kind: "compaction", id: "x", status: "failed", jobID: "cmp_1", failureCode: "provider_failed" })).toBe(false)
  expect(transcriptMessageVisible({ kind: "compaction", id: "f", status: "failed", failureCode: "provider_failed" })).toBe(false)
  expect(transcriptMessageVisible({ kind: "compaction", id: "a", status: "failed", failureCode: "aborted" })).toBe(true)
  expect(transcriptMessageVisible({ kind: "compaction", id: "l", status: "completed" })).toBe(true)
})

test("reads a bounded compaction history without exposing totals for malformed or unsupported responses", () => {
  const metrics = { excludedMessages: 11, excludedParts: 1, inputTokens: 1_000, retainedTokens: 400 }
  expect(readCompactionHistory({ data: [{ jobID: "cmp_1", trigger: "manual", status: "completed", metrics, created: 12 }], truncated: false, completedBefore: 0, completedCount: 1, totalSavedTokens: 600 })).toEqual({
    data: [{ jobID: "cmp_1", trigger: "manual", status: "completed", metrics, created: 12 }], truncated: false, completedBefore: 0, completedCount: 1, totalSavedTokens: 600,
  })
  expect(readCompactionHistory({ data: [], truncated: false, completedBefore: 0, completedCount: 1, totalSavedTokens: 600 })).toBeUndefined()
  expect(readCompactionHistory({ data: [{ jobID: "cmp_1", trigger: "manual", status: "completed", metrics: { ...metrics, retainedTokens: "400" }, created: 12 }], truncated: false, completedBefore: 0, completedCount: 1, totalSavedTokens: 600 })).toBeUndefined()
})

test("keeps one live compaction row and its metrics through start and completion", () => {
  const started = applySessionEvent(createSessionView("ses_a"), { type: "session.compaction.started", data: { sessionID: "ses_a", jobID: "cmp_1" }, created: 12 }, 12)
  expect(started.messages).toMatchObject([{ kind: "compaction", id: "cmp_1", status: "running", created: 12 }])
  const completed = applySessionEvent(started, { type: "session.compaction.ended", data: { sessionID: "ses_a", jobID: "cmp_1", metrics: { excludedMessages: 11, excludedParts: 1, inputTokens: 1_000, retainedTokens: 400 }, boundary: { messageID: "msg_before", seq: 1 } }, created: 15 }, 15)
  expect(completed.messages).toMatchObject([{ kind: "compaction", id: "cmp_1", status: "completed", created: 12, metrics: { inputTokens: 1_000, retainedTokens: 400 } }])
})

test("hides whitespace parts, goal tools, and completed duplicate skill loads", () => {
  expect(transcriptPartVisible({ kind: "text", ordinal: 0, text: "  \n " })).toBe(false)
  expect(transcriptPartVisible({ kind: "reasoning", ordinal: 1, text: "\t" })).toBe(false)
  expect(transcriptPartVisible({ kind: "tool", callID: "g", name: "goal", status: "running", content: [] })).toBe(false)
  expect(transcriptPartVisible({ kind: "tool", callID: "s", name: "skill", status: "completed", content: [], structured: { alreadyActive: true } })).toBe(false)
  expect(transcriptPartVisible({ kind: "tool", callID: "s", name: "skill", status: "running", content: [], structured: { alreadyActive: true } })).toBe(true)
  expect(transcriptPartVisible({ kind: "text", ordinal: 0, text: "Visible" })).toBe(true)
})

test("orders visible pending compactions and user inputs last without inventing rows", () => {
  const rows = visibleTranscriptMessages([
    { kind: "user", id: "pending", text: "Later", state: "pending", created: 1 },
    { kind: "assistant", id: "answer", parts: [{ kind: "text", ordinal: 0, text: "Answer" }], created: 2 },
    { kind: "compaction", id: "compact", status: "running" },
    { kind: "synthetic", id: "team", text: "raw", description: "TeamView update", source: "team-view", created: 3 },
  ])
  expect(rows.map((row) => row.id)).toEqual(["answer", "compact", "pending"])
})

test("uses tool-specific one-line input summaries", () => {
  const part = { kind: "tool" as const, callID: "c", status: "completed" as const, content: [], name: "shell", input: { command: "bun test" } }
  expect(toolSummary(part)).toBe("bun test")
  expect(toolSummary({ ...part, input: { command: `prefix-${"x".repeat(100)}-suffix` } })).toMatch(/^prefix-.+….+-suffix$/)
  expect(toolSummary({ ...part, name: "read", input: { path: "src/main.ts" } })).toBe("Read src/main.ts")
  expect(toolSummary({ ...part, name: "grep", input: { pattern: "TODO" } })).toBe('Grep "TODO"')
  expect(toolSummary({ ...part, name: "subagent", input: { agent: "Explore", description: "Find callers" } })).toBe("Explore Subagent — Find callers")
  expect(toolSummary({ ...part, name: "skill", input: { id: "ycoding" } })).toBe('Skill "ycoding"')
})

test("distinguishes failed tools from interrupted or cancelled work needing attention", () => {
  expect(toolTone({ kind: "tool", callID: "a", name: "shell", status: "completed", content: [] })).toBe("success")
  expect(toolTone({ kind: "tool", callID: "a", name: "shell", status: "failed", content: [], error: "Permission denied" })).toBe("error")
  expect(toolTone({ kind: "tool", callID: "a", name: "shell", status: "failed", content: [], error: "Step interrupted" })).toBe("attention")
  expect(toolTone({ kind: "tool", callID: "a", name: "subagent", status: "completed", content: [], structured: { status: "running" } })).toBe("running")
})

function completedCompaction(id: string, jobID: string, messageID: string, seq: number, created: number) {
  return {
    id, type: "compaction", jobID, trigger: "manual", status: "completed", revision: 1,
    boundary: { messageID, seq },
    metrics: { excludedMessages: seq, excludedParts: 0, inputTokens: 100, retainedTokens: 40 },
    time: { created },
  }
}

describe("assistant streaming", () => {
  test("accumulates text deltas and replaces them with the durable boundary", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.step.started", { assistantMessageID: "msg_1", agent: "god", model: "openai/gpt-5" })
    view = apply(view, "session.text.started", { assistantMessageID: "msg_1", ordinal: 0 })
    view = apply(view, "session.text.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "Hel" })
    view = apply(view, "session.text.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "lo" })
    view = apply(view, "session.text.ended", { assistantMessageID: "msg_1", ordinal: 0, text: "Hello there", phase: "final_answer" })
    view = apply(view, "session.step.ended", { assistantMessageID: "msg_1", finish: "stop" }, 5)

    expect(view.messages).toHaveLength(1)
    const message = view.messages[0]
    if (message?.kind !== "assistant") throw new Error("expected an assistant message")
    expect(message.agent).toBe("god")
    expect(message.parts).toEqual([{ kind: "text", ordinal: 0, text: "Hello there", phase: "final_answer" }])
    expect(message.completed).toBe(5)
  })

  test("keeps reasoning and tool parts separate and tracks the tool lifecycle", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.reasoning.started", { assistantMessageID: "msg_1", ordinal: 0 })
    view = apply(view, "session.reasoning.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "thinking" })
    view = apply(view, "session.tool.input.started", { assistantMessageID: "msg_1", callID: "call_1", name: "execute" })
    view = apply(view, "session.tool.input.delta", { assistantMessageID: "msg_1", callID: "call_1", delta: '{"code"' })
    view = apply(view, "session.tool.input.ended", { assistantMessageID: "msg_1", callID: "call_1", text: '{"code":"1"}' })
    view = apply(view, "session.tool.success", {
      assistantMessageID: "msg_1",
      callID: "call_1",
      content: [{ type: "text", text: "done" }],
    })

    const message = view.messages[0]
    if (message?.kind !== "assistant") throw new Error("expected an assistant message")
    expect(message.parts).toEqual([
      { kind: "reasoning", ordinal: 0, text: "thinking", started: 1 },
      {
        kind: "tool",
        callID: "call_1",
        name: "execute",
        status: "completed",
        started: 1,
        ran: 1,
        completed: 1,
        input: undefined,
        structured: undefined,
        inputText: '{"code":"1"}',
        content: [{ kind: "text", text: "done" }],
      },
    ])
  })
})

describe("user input lifecycle", () => {
  test("marks admitted, promoted, and consumed states", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.input.admitted", {
      inputID: "msg_9",
      input: { type: "user", data: { text: "Run the tests" }, delivery: "queue" },
    })
    expect(view.messages[0]).toMatchObject({ kind: "user", text: "Run the tests", delivery: "queue", state: "pending" })
    view = apply(view, "session.input.promoted", { inputID: "msg_9" })
    expect(view.messages[0]).toMatchObject({ state: "promoted" })
    view = apply(view, "session.input.consumed", { inputIDs: ["msg_9"] })
    expect(view.messages[0]).toMatchObject({ state: "consumed" })
  })
})

describe("requests", () => {
  test("reads native question-tool Form.Info fields", () => {
    expect(
      readForms([
        {
          id: "frm_question",
          sessionID: "ses_a",
          title: "Question",
          metadata: { kind: "question" },
          fields: [
            { key: "q0", type: "string", title: "Which module?", required: true, options: [{ value: "core", label: "Core" }] },
            { key: "followup", type: "boolean", title: "Continue?", when: [{ key: "q0", op: "eq", value: "core" }] },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "frm_question",
        sessionID: "ses_a",
        title: "Question",
        metadata: { kind: "question" },
        fields: [
          { key: "q0", type: "string", title: "Which module?", required: true, options: [{ value: "core", label: "Core" }] },
          { key: "followup", type: "boolean", title: "Continue?", when: [{ key: "q0", op: "eq", value: "core" }] },
        ],
      },
    ])
  })

  test("tracks permission, guardrail, and native form asks and their replies", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "permission.v2.asked", { id: "per_1", action: "edit", resources: ["src/**"] })
    view = apply(view, "guardrail.asked", {
      id: "grq_1",
      action: "rm -rf build",
      resources: ["build"],
      reason: "Deletion needs review",
      hardReview: true,
    })
    view = apply(view, "form.created", {
      form: {
        id: "frm_1",
        sessionID: "ses_a",
        title: "Question",
        metadata: { kind: "question" },
        fields: [{ key: "q0", type: "string", title: "Which module?", options: [{ value: "core", label: "Core" }] }],
      },
    })
    expect(view.requests.map((request) => request.kind)).toEqual(["permission", "guardrail", "form"])
    const guardrail = view.requests.find((request) => request.kind === "guardrail")
    expect(guardrail).toMatchObject({ hardReview: true, reason: "Deletion needs review" })

    view = apply(view, "permission.v2.replied", { requestID: "per_1", reply: "once" })
    view = apply(view, "guardrail.replied", { requestID: "grq_1", reply: "reject" })
    view = apply(view, "form.replied", { id: "frm_1", sessionID: "ses_a", answer: { q0: "core" } })
    expect(view.requests).toHaveLength(0)
    expect(view.activity.some((item) => item.kind === "approval")).toBe(true)
  })

  test("ignores a reply for an unknown request instead of inventing one", () => {
    const view = apply(createSessionView("ses_a"), "permission.v2.replied", { requestID: "per_missing", reply: "once" })
    expect(view.requests).toHaveLength(0)
  })
})

describe("session state", () => {
  test("tracks execution status, retries, and errors", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.execution.started", {})
    expect(view.status).toBe("running")
    view = apply(view, "session.retry.scheduled", { assistantMessageID: "msg_1", attempt: 2, at: 10, error: { code: "rate_limited", message: "slow down" } })
    expect(view.messages.find((message) => message.kind === "assistant")?.retry).toEqual({ attempt: 2, at: 10, code: "rate_limited" })
    view = apply(view, "session.execution.failed", { error: { code: "provider_error", message: "boom" } })
    expect(view.status).toBe("failed")
    expect(view.lastError).toEqual({ code: "provider_error", message: "boom" })
  })

  test("records tool calls in the activity stream with their lifecycle status", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.tool.input.started", { assistantMessageID: "msg_1", callID: "call_1", name: "shell" })
    view = apply(view, "session.tool.success", {
      assistantMessageID: "msg_1",
      callID: "call_1",
      content: [{ type: "text", text: "ok" }],
    })
    const tool = view.activity.find((item) => item.id === "tool-call_1")
    expect(tool).toMatchObject({ kind: "tool", title: "shell", status: "completed" })

    view = apply(view, "session.tool.failed", { assistantMessageID: "msg_1", callID: "call_2", error: { message: "no" } })
    expect(view.activity.find((item) => item.id === "tool-call_2")).toMatchObject({ status: "failed" })
  })

  test("records shell output bounded and file changes as activity", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.shell.started", {
      shell: { id: "sh_1", status: "running", command: "bun test", cwd: "/repo" },
    })
    view = apply(view, "session.shell.ended", {
      shell: { id: "sh_1", status: "exited", command: "bun test", exit: 0 },
      output: { output: "ok", cursor: 2, size: 2 },
    })
    const shell = view.messages.find((message) => message.kind === "shell")
    expect(shell).toMatchObject({
      command: "bun test",
      status: "exited",
      exit: 0,
      output: { text: "ok", cursor: 2, size: 2, truncated: false },
    })
    view = apply(view, "session.file-change.recorded", { change: { path: "src/a.ts", patch: "@@", additions: 3, deletions: 1 } })
    expect(view.activity.find((item) => item.kind === "file")).toMatchObject({ title: "src/a.ts", detail: "+3 −1" })
  })
})

describe("unknown and ignored events", () => {
  test("counts genuinely unknown events", () => {
    const view = apply(createSessionView("ses_a"), "session.future.thing", { value: 1 })
    expect(view.unhandledEvents).toBe(1)
  })

  test("does not count events the client intentionally does not project", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.context.observed", { source: "session-state", text: "…" })
    view = apply(view, "session.instructions.updated", { delta: {} })
    expect(view.unhandledEvents).toBe(0)
  })

  test("counts malformed payloads rather than guessing fields", () => {
    const view = applySessionEvent(createSessionView("ses_a"), { type: "session.text.delta", data: {} }, 1)
    expect(view.unhandledEvents).toBe(1)
    expect(view.messages).toHaveLength(0)
  })
})

describe("snapshot readers", () => {
  test("reads bounded speed and the latest post-compaction assistant context from the declared fields", () => {
    const selected = { id: "gpt-6", providerID: "openai", variant: "high" }
    const sample = { model: selected, tokens: 12, durationNs: 2_000_000, tokensPerSecond: 6_000 }
    const assistant = { id: "msg_current", type: "assistant", agent: "build", model: selected,
      content: [], tokens: { input: 60_000, output: 10_000, reasoning: 2_000, cache: { read: 2_000, write: 0 } },
      diagnostics: { contextLimit: 258_000 }, time: { created: 3, completed: 4 } }
    const snapshot = readSnapshot({ session: { model: selected }, messages: [assistant],
      generationSpeed: { latest: sample, recent: [sample] } })
    expect(snapshot?.generationSpeed).toEqual({ latest: sample, recent: [sample] })
    expect(snapshot?.contextWindow).toEqual({ model: selected, used: 74_000, limit: 258_000 })
    expect(generationSpeedDisplay({ ...createSessionView("ses_a"), generationSpeed: snapshot?.generationSpeed }, selected))
      .toMatchObject({ label: "6,000 tok/s" })
    expect(contextWindowDisplay({ ...createSessionView("ses_a"), contextWindow: snapshot?.contextWindow }, selected))
      .toMatchObject({ usedPercent: 29, leftPercent: 71, tokens: "74K / 258K tokens", fraction: 74_000 / 258_000 })
    expect(generationSpeedDisplay({ ...createSessionView("ses_a"), generationSpeed: snapshot?.generationSpeed },
      { ...selected, variant: "low" })).toBeUndefined()
    expect(contextWindowDisplay({ ...createSessionView("ses_a"), contextWindow: snapshot?.contextWindow },
      { ...selected, variant: "low" })).toBeUndefined()
    expect(contextWindowDisplay({ ...createSessionView("ses_a"), contextWindow: { model: selected, used: 0, limit: 258_000 } }, selected)).toBeUndefined()
    expect(generationSpeedDisplay(createSessionView("ses_a"), selected)).toBeUndefined()
    expect(readSnapshot({ session: { model: selected }, messages: [assistant],
      generationSpeed: { latest: { ...sample, tokensPerSecond: 0 }, recent: [sample] } })?.generationSpeed).toBeUndefined()

    const compacted = readSnapshot({ session: { model: selected }, messages: [assistant,
      completedCompaction("msg_compaction", "cmp_1", "msg_current", 4, 5)],
      generationSpeed: { latest: sample, recent: [sample] } })
    expect(compacted?.contextWindow).toBeUndefined()
    expect(compacted?.generationSpeed).toBeUndefined()
  })

  test("keeps only the latest compaction lifecycle without discarding uncompleted history", () => {
    const messages = [
      { id: "msg_before", type: "user", text: "keep", time: { created: 1 } },
      { id: "msg_failed", type: "compaction", jobID: "cmp_failed", trigger: "manual", status: "failed", code: "provider_failed", error: { type: "compaction.failed", message: "Failed" }, time: { created: 2 } },
      { id: "msg_pending", type: "compaction", jobID: "cmp_pending", trigger: "manual", status: "pending", time: { created: 3 } },
    ]
    expect(readSnapshot({ session: {}, messages })?.messages.map((message) => message.id)).toEqual(["msg_before", "msg_pending"])
    const initial = { ...createSessionView("ses_a"), messages: readMessageList({ data: messages.slice(0, 2) }) }
    const admitted = apply(initial, "session.compaction.admitted", { sessionID: "ses_a", jobID: "cmp_pending" })
    expect(admitted.messages.map((message) => message.id)).toEqual(["msg_before", "cmp_pending"])
    const failed = apply(admitted, "session.compaction.failed", { sessionID: "ses_a", jobID: "cmp_pending", code: "provider_failed", error: { type: "compaction.failed", message: "Retry failed" } })
    expect(failed.messages).toMatchObject([{ id: "msg_before" }, { id: "cmp_pending", status: "failed", error: "Retry failed" }])
  })

  test("keeps only post-boundary content and the latest completed compaction on reconnect", () => {
    const messages = [
      { id: "msg_old", type: "assistant", content: [{ type: "text", text: "old" }], time: { created: 1 } },
      { id: "msg_boundary", type: "user", text: "covered", time: { created: 2 } },
      completedCompaction("msg_compaction", "cmp_1", "msg_boundary", 2, 3),
      { id: "msg_new", type: "assistant", content: [{ type: "text", text: "new" }], time: { created: 4 } },
      completedCompaction("msg_compaction_2", "cmp_2", "msg_new", 4, 5),
      { id: "msg_after", type: "user", text: "after", time: { created: 6, consumed: 7 } },
    ]
    expect(readSnapshot({ session: {}, messages, watermark: { seq: 8 } })?.messages.map((message) => message.id)).toEqual([
      "msg_compaction_2", "msg_after",
    ])
    expect(readSnapshot({ session: {}, messages, watermark: { seq: 8 } })?.messages.at(-1)).toMatchObject({ state: "consumed" })
  })

  test("keeps the completed checkpoint behind a newer running row but renders only that newer row", () => {
    const messages = [
      { id: "msg_before", type: "user", text: "covered", time: { created: 1 } },
      completedCompaction("msg_complete", "cmp_done", "msg_before", 1, 2),
      { id: "msg_retained", type: "user", text: "retained", time: { created: 3 } },
      { id: "msg_running", type: "compaction", jobID: "cmp_new", trigger: "manual", status: "running", time: { created: 4 } },
      { id: "msg_after", type: "user", text: "after", time: { created: 5 } },
    ]
    const snapshot = readSnapshot({ session: {}, messages: messages.slice(1), before: "older" })!
    expect(snapshot.messages.map((message) => message.id)).toEqual(["msg_complete", "msg_retained", "msg_running", "msg_after"])
    expect(visibleTranscriptMessages(snapshot.messages).map((message) => message.id)).toEqual(["msg_retained", "msg_running", "msg_after"])
    expect(readSnapshot({ session: {}, messages })?.messages.map((message) => message.id)).toEqual(["msg_complete", "msg_retained", "msg_running", "msg_after"])
  })

  test("replaces the older compaction row with the new job and retains that job key on completion", () => {
    const initial = readSnapshot({ session: {}, messages: [
      { id: "msg_before", type: "user", text: "covered", time: { created: 1 } },
      completedCompaction("msg_complete", "cmp_done", "msg_before", 1, 2),
      { id: "msg_retained", type: "user", text: "retained", time: { created: 3 } },
    ] })!.messages
    const running = applySessionEvent({ ...createSessionView("ses_a"), messages: initial }, { type: "session.compaction.started", data: { sessionID: "ses_a", jobID: "cmp_new" }, created: 4 }, 4)
    expect(visibleTranscriptMessages(running.messages).filter((message) => message.kind === "compaction").map((message) => message.jobID)).toEqual(["cmp_new"])
    const completed = applySessionEvent(running, { type: "session.compaction.ended", data: { sessionID: "ses_a", jobID: "cmp_new", boundary: { messageID: "msg_retained", seq: 3 }, metrics: { excludedMessages: 1, excludedParts: 0, inputTokens: 100, retainedTokens: 40 } }, created: 5 }, 5)
    expect(completed.messages.map((message) => message.id)).toEqual(["cmp_new"])
    expect(visibleTranscriptMessages(completed.messages).map((message) => message.id)).toEqual(["cmp_new"])
    expect(completed.messages[0]).toMatchObject({ jobID: "cmp_new", status: "completed", created: 4 })
  })

  test("retains history when completion has no resident boundary or compaction is pending or failed", () => {
    const base = [
      { id: "msg_before", type: "user", text: "keep", time: { created: 1 } },
      { id: "msg_running", type: "compaction", jobID: "cmp_1", trigger: "manual", status: "running", time: { created: 2 } },
      { id: "msg_failed", type: "compaction", jobID: "cmp_2", trigger: "manual", status: "failed", code: "provider_failed", error: { type: "compaction.failed", message: "Failed" }, time: { created: 3 } },
    ]
    expect(readSnapshot({ session: {}, messages: base })?.messages.map((message) => message.id)).toContain("msg_before")
    expect(readSnapshot({ session: {}, messages: [...base, completedCompaction("msg_bad", "cmp_3", "msg_missing", 4, 4)] })?.messages.map((message) => message.id)).toContain("msg_before")
    expect(readSnapshot({ session: {}, messages: [completedCompaction("msg_bad", "cmp_3", "msg_before", 4, 0), ...base] })?.messages.map((message) => message.id)).toContain("msg_before")
    const live = { ...createSessionView("ses_a"), messages: readMessageList({ data: base }) }
    expect(apply(live, "session.compaction.ended", { jobID: "cmp_missing", boundary: { messageID: "msg_absent", seq: 4 } }).messages.map((message) => message.id)).toContain("msg_before")
  })

  test("bounds only successfully covered old content at a large synthetic history", () => {
    const messages = Array.from({ length: 3_000 }, (_, index) => ({
      id: `msg_${index}`, type: "assistant", content: [{ type: "reasoning", text: "x".repeat(600) }, { type: "text", text: "y".repeat(600) }], time: { created: index },
    }))
    const compacted = [...messages.slice(0, 2_700), completedCompaction("msg_compaction", "cmp_1", "msg_2699", 2_700, 2_700), ...messages.slice(2_700)]
    const snapshot = readSnapshot({ session: {}, messages: compacted })
    const retained = snapshot?.messages ?? []
    expect(retained).toHaveLength(301)
    expect(retained.filter((message) => message.kind === "assistant").flatMap((message) => message.kind === "assistant" ? message.parts : [])).toHaveLength(600)
    expect(snapshot?.coveredAssistantIDs).toHaveLength(2_700)
    expect(snapshot?.coveredAssistantIDs.at(0)).toBe("msg_0")
    expect(snapshot?.coveredAssistantIDs.at(-1)).toBe("msg_2699")
    expect(sealedPartKeys(retained)).toHaveLength(600)
    expect(retained.at(-1)?.id).toBe("msg_2999")
    const uncompleted = readSnapshot({ session: {}, messages })
    expect(uncompleted?.messages).toHaveLength(3_000)
    expect(uncompleted?.coveredAssistantIDs).toHaveLength(0)
  })

  test("consumed is the only snapshot read receipt; promoted and pending are not read", () => {
    expect(readMessageList({ data: [
      { id: "msg_sent", type: "user", text: "sent", time: { created: 1 } },
      { id: "msg_read", type: "user", text: "read", time: { created: 2, consumed: 3 } },
    ] }).map((message) => message.kind === "user" ? message.state : undefined)).toEqual(["promoted", "consumed"])
  })
  test("reads projected messages and rejects unknown shapes", () => {
    const messages = readMessageList({
      data: [
        { id: "msg_1", type: "user", text: "hello", time: { created: 3 } },
        { id: "msg_2", type: "system", text: "notice", time: { created: 4 } },
        { id: "msg_3", type: "assistant", content: [{ type: "text", text: "hi" }], time: { created: 5, completed: 6 }, agent: "god" },
        { id: "msg_4", type: "unknown-future-type" },
        { type: "user", text: "no id" },
      ],
    })
    expect(messages.map((message) => message.id)).toEqual(["msg_1", "msg_2", "msg_3"])
    expect(messages[2]).toMatchObject({ kind: "assistant", agent: "god", completed: 6 })
    expect(readMessageList(undefined)).toHaveLength(0)
    // A bare array is not the Protocol envelope, so it is refused rather than guessed.
    expect(readMessageList([{ id: "msg_1", type: "user", text: "bare" }])).toHaveLength(0)
  })

  test("reads assistant snapshot parts including tool completion", () => {
    const parts = readSnapshotParts([
      { type: "reasoning", text: "why" },
      { type: "text", text: "answer" },
      { type: "tool", id: "call_1", name: "read", state: { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "file body" }] } },
      { type: "tool", id: "call_2", name: "edit", state: { status: "error", error: { message: "denied" } } },
    ])
    expect(parts[0]).toEqual({ kind: "reasoning", ordinal: 0, text: "why" })
    expect(parts[2]).toMatchObject({ kind: "tool", callID: "call_1", status: "completed" })
    expect(parts[3]).toMatchObject({ kind: "tool", callID: "call_2", status: "failed", error: "denied" })
  })

  test("reads autonomy from a set response", () => {
    expect(
      readAutonomy({
        data: { mode: "normal", yolo: 3, goal: { text: "Ship it", status: "active", iteration: 2, noProgress: 1, maxNoProgress: 5 } },
      }),
    ).toEqual({ mode: "goal", yolo: 3, goal: { text: "Ship it", status: "active", iteration: 2, noProgress: 1, maxNoProgress: 5 } })
    expect(readAutonomy({ data: { mode: "normal", yolo: false } })).toEqual({ mode: "normal", yolo: 0 })
    expect(readAutonomy({ data: {} })).toEqual({ mode: "normal", yolo: 0 })
    expect(readAutonomy(null)).toBeUndefined()
  })

  test("drops malformed Form.Info values", () => {
    expect(
      readForms([
        { id: "frm_bad_option", sessionID: "ses_a", title: "Question", fields: [{ key: "q0", type: "string", options: [{ value: "a", label: "A" }, { nope: true }] }] },
        { id: "frm_bad_fields", sessionID: "ses_a", title: "Missing fields" },
      ]),
    ).toEqual([])
  })
})

describe("boundedText", () => {
  test("keeps short values intact and truncates long ones", () => {
    expect(boundedText("short")).toEqual({ text: "short", truncated: false })
    const long = boundedText("x".repeat(10), 4)
    expect(long).toEqual({ text: "xxxx", truncated: true })
  })
})

describe("shell output contract", () => {
  test("keeps the device's available page and its source cursor metadata", () => {
    const page = "line\n".repeat(1_500)
    let view = createSessionView("ses_a")
    view = apply(view, "session.shell.started", {
      shell: { id: "sh_1", status: "running", command: "bun test", cwd: "/repo" },
    })
    view = apply(view, "session.shell.ended", {
      shell: { id: "sh_1", status: "exited", command: "bun test", exit: 0 },
      output: { output: page, cursor: 8_192, size: 65_536, truncated: false },
    })

    const shell = view.messages.find((message) => message.kind === "shell")
    if (shell?.kind !== "shell") throw new Error("expected a shell message")
    // The 6 000-character page survives intact: no local display cap drops device output.
    expect(shell.output).toEqual({ text: page, cursor: 8_192, size: 65_536, truncated: false })
  })

  test("keeps the source metadata from a snapshot message and refuses a page without it", () => {
    const messages = readMessageList({
      data: [
        {
          id: "msg_shell",
          type: "shell",
          shellID: "sh_1",
          command: "bun test",
          status: "exited",
          output: { output: "ok", cursor: 2, size: 10, truncated: true },
          time: { created: 1, completed: 2 },
        },
        {
          id: "msg_shell_incomplete",
          type: "shell",
          shellID: "sh_2",
          command: "bun test",
          status: "exited",
          output: { output: "no metadata" },
          time: { created: 1 },
        },
      ],
    })
    expect(messages[0]).toMatchObject({ kind: "shell", output: { text: "ok", cursor: 2, size: 10, truncated: true } })
    const incomplete = messages[1]
    if (incomplete?.kind !== "shell") throw new Error("expected a shell message")
    expect(incomplete.output).toBeUndefined()
  })

  test("states the device limit separately from the collapsed preview", () => {
    expect(shellOutputNotice({ text: "ok", cursor: 2, size: 2, truncated: false })).toBeUndefined()
    expect(shellOutputNotice({ text: "ok", cursor: 2, size: 10, truncated: false })).toContain("2 of 10 bytes")
    expect(shellOutputNotice({ text: "ok", cursor: 10, size: 10, truncated: true })).toContain("truncated")
  })
})

describe("shell output paging", () => {
  const page = (text: string, cursor: number, size: number): ShellOutputView => ({ text, cursor, size, truncated: false })
  const shellView = (...shellIDs: readonly string[]): SessionView =>
    shellIDs.reduce(
      (view, shellID, index) =>
        apply(view, "session.shell.ended", {
          shell: { id: shellID, status: "exited", command: `command ${index}` },
          output: { output: "", cursor: 0, size: 0, truncated: false },
        }),
      createSessionView("ses_a"),
    )

  test("appends a fetched continuation page to the text already held", () => {
    const first = mergeShellOutputSnapshot(undefined, page("first", 5, 11))
    expect(appendShellOutputPage(first, page("second", 11, 11), 5)).toEqual(page("firstsecond", 11, 11))
  })

  test("keeps the longer text when a device page only repeats a fetched prefix", () => {
    const held = appendShellOutputPage(
      mergeShellOutputSnapshot(undefined, page("first", 5, 11)),
      page("second", 11, 11),
      5,
    )
    // The re-sent durable page covers bytes [0, 5) only, so the fetched text stays.
    expect(mergeShellOutputSnapshot(held, page("first", 5, 11))).toEqual(page("firstsecond", 11, 11))
  })

  test("drops a fetched page whose bytes a durable update already covered", () => {
    const held = mergeShellOutputSnapshot(undefined, page("first", 5, 20))
    // The durable page advanced the client to 12 while the page still described bytes from 5.
    const durable = mergeShellOutputSnapshot(held, page("firstsecond", 12, 20))
    expect(durable).toEqual(page("firstsecond", 12, 20))
    expect(appendShellOutputPage(durable, page("cond", 15, 20), 5)).toEqual(durable)
  })

  test("never rewinds the cursor when a page reports a smaller device capture", () => {
    const held = page("firstsecond", 11, 11)
    // The service clamps a cursor past its own capture, so a late page can name fewer bytes.
    expect(appendShellOutputPage(held, page("", 4, 4), 11)).toEqual(page("firstsecond", 11, 11))
  })

  test("reads a page from the operation response envelope and refuses an unreadable one", () => {
    expect(readShellOutputPage({ data: { output: "ok", cursor: 2, size: 9, truncated: false } })).toEqual(page("ok", 2, 9))
    expect(readShellOutputPage({ data: { output: "ok", cursor: 2, size: 9, truncated: true } })).toMatchObject({
      truncated: true,
    })
    expect(readShellOutputPage({ data: { output: "ok" } })).toBeUndefined()
    expect(readShellOutputPage(null)).toBeUndefined()
  })

  test("finds one shell's capture in the transcript and in the tool call that ran it", () => {
    const view = shellView("sh_1", "sh_2")
    const paged = withShellOutputPage(view, "sh_1", page("hello", 5, 5), 0, { state: "idle" })
    expect(shellOutputFor(paged, "sh_1")).toEqual(page("hello", 5, 5))
    expect(shellOutputFor(paged, "sh_2")).toEqual(page("", 0, 0))

    const toolView = apply(createSessionView("ses_a"), "session.tool.success", {
      assistantMessageID: "msg_1",
      callID: "call_1",
      name: "shell",
      content: [{ type: "text", text: "The command was moved to the background." }],
      structured: { shellID: "sh_9", truncated: false },
    })
    expect(shellOutputFor(toolView, "sh_9")).toBeUndefined()
    const toolPaged = withShellOutputPage(toolView, "sh_9", page("tail", 4, 40), 0, { state: "idle" })
    expect(shellOutputFor(toolPaged, "sh_9")).toEqual(page("tail", 4, 40))
  })

  test("applies a fetched page only to the shell it names", () => {
    const view = shellView("sh_1", "sh_2")
    const paged = withShellOutputPage(view, "sh_2", page("only two", 8, 8), 0, { state: "idle" })
    expect(shellOutputFor(paged, "sh_1")).toEqual(page("", 0, 0))
    expect(shellOutputFor(paged, "sh_2")).toEqual(page("only two", 8, 8))
    // The untouched shell keeps its identity, so nothing else in the transcript is rebuilt.
    expect(paged.messages[0]).toBe(view.messages[0])
  })

  test("records the client page-request state without touching device data", () => {
    const view = shellView("sh_1")
    const loading = withShellOutputFetch(view, "sh_1", { state: "loading" })
    expect(shellOutputFor(loading, "sh_1")).toEqual(page("", 0, 0))
    const message = loading.messages[0]
    if (message?.kind !== "shell") throw new Error("expected a shell message")
    expect(message.outputFetch).toEqual({ state: "loading" })

    // A running shell has no page yet, so the request state is all the client holds.
    const running = apply(createSessionView("ses_a"), "session.shell.started", {
      shell: { id: "sh_3", status: "running", command: "tail -f log" },
    })
    const loadingRunning = withShellOutputFetch(running, "sh_3", { state: "loading" })
    const runningMessage = loadingRunning.messages.find((entry) => entry.kind === "shell")
    if (runningMessage?.kind !== "shell") throw new Error("expected a shell message")
    expect(runningMessage.output).toBeUndefined()
    expect(runningMessage.outputFetch).toEqual({ state: "loading" })
  })

  test("leaves a view with no such shell unchanged", () => {
    const view = shellView("sh_1")
    expect(withShellOutputFetch(view, "sh_missing", { state: "loading" })).toBe(view)
    expect(withShellOutputPage(view, "sh_missing", page("x", 1, 1), 0, { state: "idle" })).toBe(view)
  })

  test("reads back the client request state wherever the client holds that shell", () => {
    const view = shellView("sh_1")
    expect(shellOutputFetchFor(view, "sh_1")).toBeUndefined()
    const loading = withShellOutputFetch(view, "sh_1", { state: "loading" })
    expect(shellOutputFetchFor(loading, "sh_1")).toEqual({ state: "loading" })
    expect(shellOutputFetchFor(loading, "sh_missing")).toBeUndefined()

    const toolView = apply(createSessionView("ses_a"), "session.tool.success", {
      assistantMessageID: "msg_1",
      callID: "call_1",
      name: "shell",
      content: [{ type: "text", text: "The command was moved to the background." }],
      structured: { shellID: "sh_9", truncated: false },
    })
    expect(shellOutputFetchFor(withShellOutputFetch(toolView, "sh_9", { state: "stalled" }), "sh_9")).toEqual({
      state: "stalled",
    })
  })

  test("accepts only a device-reported shell id on a tool part", () => {
    const part = { kind: "tool" as const, callID: "call_1", name: "shell", status: "completed" as const, content: [] }
    expect(toolShellID({ ...part, structured: { shellID: "sh_abc123" } })).toBe("sh_abc123")
    expect(toolShellID({ ...part, structured: { shellID: "/tmp/shell.out" } })).toBeUndefined()
    expect(toolShellID({ ...part, structured: { shellID: "sh_1/../../etc" } })).toBeUndefined()
    expect(toolShellID({ ...part, structured: {} })).toBeUndefined()
    expect(toolShellID(part)).toBeUndefined()
  })

  test("keeps the fetched text when a durable page arrives while it is held", () => {
    const paged = withShellOutputPage(shellView("sh_1"), "sh_1", page("firstsecond", 11, 20), 0, { state: "idle" })
    const durable = apply(paged, "session.shell.ended", {
      shell: { id: "sh_1", status: "exited", command: "command 0" },
      output: { output: "first", cursor: 5, size: 20, truncated: false },
    })
    expect(shellOutputFor(durable, "sh_1")).toEqual(page("firstsecond", 11, 20))
  })
})

describe("previewText", () => {
  test("returns text that already fits unchanged", () => {
    expect(previewText("short", { lines: 12, chars: 2_000 })).toEqual({ text: "short", hasMore: false })
    expect(previewText("x".repeat(2_000), { lines: 12, chars: 2_000 })).toEqual({
      text: "x".repeat(2_000),
      hasMore: false,
    })
  })

  test("cuts to the line budget and reports that more is available", () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n")
    const preview = previewText(text, { lines: 3, chars: 10_000 })
    expect(preview.text).toBe("line 1\nline 2\nline 3")
    expect(preview.hasMore).toBe(true)
  })

  test("cuts a single long line to the character budget", () => {
    const preview = previewText("y".repeat(5_000), { lines: 12, chars: 2_000 })
    expect(preview.text.length).toBe(2_000)
    expect(preview.hasMore).toBe(true)
  })

  test("keeps the default collapsed preview small", () => {
    const preview = previewText(Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n"))
    expect(preview.hasMore).toBe(true)
    expect(preview.text.split("\n").length).toBeLessThanOrEqual(12)
    expect(previewText("z".repeat(50_000)).text.length).toBeLessThanOrEqual(2_000)
  })
})

describe("tool structured metadata", () => {
  test("removes device-local capture paths from projected tool text without discarding other output", () => {
    const text = "before\n... output truncated; full content saved to /private/fixture/a file.txt ...\nafter\n[output truncated; full output saved to: C:\\fixture\\shell.log]"
    const parts = readSnapshotParts([
      { type: "tool", id: "call_1", name: "read", state: { status: "completed", content: [{ type: "text", text }] } },
    ])
    const part = parts[0]
    if (part?.kind !== "tool") throw new Error("expected a tool part")
    expect(part.content[0]).toMatchObject({ kind: "text", sourceTruncated: true })
    if (part.content[0]?.kind !== "text") throw new Error("expected text")
    expect(part.content[0].text).toContain("before")
    expect(part.content[0].text).toContain("after")
    expect(part.content[0].text).toContain("retained on the device")
    expect(part.content[0].text).not.toContain("/private/fixture/")
    expect(part.content[0].text).not.toContain("C:\\fixture\\")
  })

  test("hides a capture marker cut short by the device output limit", () => {
    const parts = readSnapshotParts([
      { type: "tool", id: "call_1", name: "read", state: { status: "completed", content: [{ type: "text", text: "... output truncated; full content saved to /private/fixture/partial" }] } },
    ])
    const part = parts[0]
    if (part?.kind !== "tool") throw new Error("expected a tool part")
    expect(part.content[0]).toEqual({ kind: "text", text: "[full output retained on the device]", sourceTruncated: true })
  })

  test("keeps the structured record the device sent, live and from a snapshot", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.tool.success", {
      assistantMessageID: "msg_1",
      callID: "call_1",
      content: [{ type: "text", text: "ok" }],
      structured: { shellID: "sh_1", truncated: true, exit: 1 },
    })
    const message = view.messages[0]
    if (message?.kind !== "assistant") throw new Error("expected an assistant message")
    const tool = message.parts.find((part) => part.kind === "tool")
    expect(tool).toMatchObject({ structured: { shellID: "sh_1", truncated: true, exit: 1 } })
    // The bounded text stays exactly what the device sent: no rewriting, no path stripping.
    expect(tool).toMatchObject({ content: [{ kind: "text", text: "ok" }] })

    const parts = readSnapshotParts([
      {
        type: "tool",
        id: "call_2",
        name: "shell",
        state: { status: "completed", input: {}, content: [], structured: { shellID: "sh_2", truncated: false } },
      },
    ])
    expect(parts[0]).toMatchObject({ kind: "tool", structured: { shellID: "sh_2", truncated: false } })
  })
})

describe("recorded file changes", () => {
  test("keeps a patch per path and replaces the same path on a later record", () => {
    let view = createSessionView("ses_a")
    view = apply(view, "session.file-change.recorded", {
      change: { path: "src/a.ts", patch: "@@ one", additions: 3, deletions: 1 },
    })
    view = apply(view, "session.file-change.recorded", {
      change: { path: "src/a.ts", patch: "@@ two", additions: 5, deletions: 2 },
    })
    view = apply(view, "session.file-change.recorded", {
      change: { path: "src/b.ts", patch: "@@ b", additions: 1, deletions: 0 },
    })
    expect(view.fileChanges).toEqual([
      { path: "src/a.ts", patch: "@@ two", additions: 5, deletions: 2 },
      { path: "src/b.ts", patch: "@@ b", additions: 1, deletions: 0 },
    ])
    expect(view.activity.filter((item) => item.kind === "file").map((item) => item.id)).toEqual(["file-src/a.ts", "file-src/b.ts"])
  })

  test("reads the ledger envelope and drops entries without a path", () => {
    expect(
      readFileChangeList({
        data: [
          { path: "src/a.ts", patch: "@@", additions: 1, deletions: 1 },
          { patch: "no path", additions: 0, deletions: 0 },
        ],
      }),
    ).toEqual([{ path: "src/a.ts", patch: "@@", additions: 1, deletions: 1 }])
    expect(readFileChangeList(null)).toHaveLength(0)
  })

  test("merges latest per path with the live record winning", () => {
    expect(
      mergeFileChanges(
        [
          { path: "src/a.ts", patch: "ledger", additions: 1, deletions: 0 },
          { path: "src/b.ts", patch: "b", additions: 2, deletions: 0 },
        ],
        [{ path: "src/a.ts", patch: "live", additions: 3, deletions: 1 }],
      ),
    ).toEqual([
      { path: "src/a.ts", patch: "live", additions: 3, deletions: 1 },
      { path: "src/b.ts", patch: "b", additions: 2, deletions: 0 },
    ])
  })

  test("reads a live record from its event envelope only", () => {
    expect(
      readFileChangeEvent({ type: "session.file-change.recorded", data: { change: { path: "src/a.ts", patch: "@@" } } }),
    ).toEqual({ path: "src/a.ts", patch: "@@", additions: 0, deletions: 0 })
    expect(readFileChangeEvent({ type: "session.tool.success", data: { change: { path: "src/a.ts" } } })).toBeUndefined()
    expect(readFileChangeEvent({ type: "session.file-change.recorded", data: {} })).toBeUndefined()
  })

  test("counts a record without a path instead of inventing one", () => {
    const view = apply(createSessionView("ses_a"), "session.file-change.recorded", { change: { patch: "@@" } })
    expect(view.unhandledEvents).toBe(1)
    expect(view.fileChanges).toHaveLength(0)
    expect(view.activity).toHaveLength(0)
  })
})
