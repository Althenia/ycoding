import { expect, test } from "bun:test"
import { mapEvent } from "../src/mcp-events/capture"

const pendingActions = ["inspect", "respond"] as const
const tool = { messageID: "msg_1", callID: "call_1" }
const toolOrigin = (eventID: string) => ({ type: "tool" as const, source_event_id: eventID, message_id: "msg_1", call_id: "call_1" })
const guardrail = (data: Record<string, unknown>, id = "evt_g") =>
  mapEvent({ type: "guardrail.asked", id, data: { id: "grq_1", sessionID: "ses_a", ...data } })

test("guardrail attention classifies hard, custom, ordinary and unreported reviews", () => {
  const review = (data: Record<string, unknown>) => guardrail(data)?.attention?.review
  expect(review({ hardReview: true, standard: true })).toBe("hard")
  expect(review({ hardReview: true, standard: false })).toBe("hard")
  expect(review({ standard: false })).toBe("custom")
  expect(review({ hardReview: false, standard: false })).toBe("custom")
  expect(review({ standard: true })).toBe("ordinary")
  expect(review({ hardReview: false, standard: true })).toBe("ordinary")
  expect(review({})).toBe("unreported")
  expect(review({ standard: "true", hardReview: "true" })).toBe("unreported")
  const value = guardrail({ standard: true })
  expect(value).toMatchObject({ name: "session.guardrail.changed", state: "pending", requestID: "grq_1" })
  expect(value?.attention).toEqual({
    kind: "guardrail",
    origin: { type: "unreported", source_event_id: "evt_g" },
    review: "ordinary",
    actions: pendingActions,
  })
})

test("guardrail origin takes only a validated tool source from data.source or metadata", () => {
  expect(guardrail({ standard: true, source: tool })?.attention?.origin).toEqual(toolOrigin("evt_g"))
  expect(guardrail({ standard: true, metadata: { source: tool } })?.attention?.origin).toEqual(toolOrigin("evt_g"))
  expect(guardrail({ standard: true, metadata: { tool } })?.attention?.origin).toEqual(toolOrigin("evt_g"))
  expect(guardrail({ standard: true, source: tool, metadata: { source: { messageID: "msg_x", callID: "call_x" } } })?.attention?.origin).toEqual(toolOrigin("evt_g"))
  for (const bad of [
    { messageID: "msg_1" },
    { callID: "call_1" },
    { messageID: "bad id", callID: "call_1" },
    { messageID: "msg_1", callID: "call/1" },
    { messageID: "m".repeat(129), callID: "call_1" },
    { messageID: 1, callID: "call_1" },
    "msg_1/call_1",
  ]) expect(guardrail({ standard: true, source: bad })?.attention?.origin).toEqual({ type: "unreported", source_event_id: "evt_g" })
  expect(guardrail({ standard: true, reason: "Run call_1 from msg_1" })?.attention?.origin.type).toBe("unreported")
})

test("guardrail assessment escalation waits for the native pending request event", () => {
  expect(mapEvent({ type: "session.guardrail.escalated", id: "evt_esc", data: { sessionID: "ses_a", requestID: "grq_2", source: tool, grades: [{ evidence: "private evidence" }] } })).toBeUndefined()
})

test("permission asked attention uses the typed tool source and no review class", () => {
  const value = mapEvent({ type: "permission.asked", id: "evt_p", data: { id: "per_1", sessionID: "ses_a", action: "shell", resources: ["rm -rf /private"], metadata: { command: "secret" }, source: { type: "tool", ...tool } } })
  expect(value).toMatchObject({ name: "session.permission.changed", state: "pending", requestID: "per_1", category: "shell" })
  expect(value?.attention).toEqual({ kind: "permission", origin: toolOrigin("evt_p"), actions: pendingActions })
  expect(JSON.stringify(value)).not.toContain("rm -rf")
  expect(JSON.stringify(value)).not.toContain("secret")
  for (const source of [undefined, { type: "plugin", ...tool }, { type: "tool", messageID: "msg 1", callID: "call_1" }, { type: "tool", messageID: "msg_1" }, "tool"])
    expect(mapEvent({ type: "permission.asked", id: "evt_p2", data: { id: "per_2", sessionID: "ses_a", action: "shell", source } })?.attention?.origin)
      .toEqual({ type: "unreported", source_event_id: "evt_p2" })
})

test("native question asked is native attention without question content", () => {
  const value = mapEvent({ type: "question.asked", id: "evt_q", data: { id: "que_1", sessionID: "ses_a", questions: [{ question: "Private question?", options: [] }] } })
  expect(value).toMatchObject({ name: "session.question.changed", state: "pending", requestID: "que_1" })
  expect(value?.attention).toEqual({ kind: "question", origin: { type: "native", source_event_id: "evt_q" }, actions: pendingActions })
  expect(JSON.stringify(value)).not.toContain("Private question")
  expect(mapEvent({ type: "question.asked", id: "evt_q2", data: { id: "que_2", sessionID: "ses_a", tool } })?.attention?.origin).toEqual(toolOrigin("evt_q2"))
  expect(mapEvent({ type: "question.asked", id: "evt_q3", data: { id: "que_3", sessionID: "ses_a", tool: { messageID: "bad id", callID: "call_1" } } })?.attention?.origin)
    .toEqual({ type: "native", source_event_id: "evt_q3" })
})

test("form created stays a form even when its metadata says question", () => {
  const form = (metadata: unknown) => mapEvent({ type: "form.created", id: "evt_f", data: { form: { id: "frm_1", sessionID: "ses_a", title: "Private title", metadata, fields: [] } } })
  const asQuestion = form({ kind: "question", tool, prompt: "Private prompt" })
  expect(asQuestion).toMatchObject({ name: "session.form.changed", state: "pending", requestID: "frm_1" })
  expect(asQuestion?.attention).toEqual({ kind: "form", origin: toolOrigin("evt_f"), actions: pendingActions })
  expect(JSON.stringify(asQuestion)).not.toContain("Private")
  expect(form({ kind: "question" })?.attention).toEqual({ kind: "form", origin: { type: "native", source_event_id: "evt_f" }, actions: pendingActions })
  expect(form(undefined)?.attention?.origin).toEqual({ type: "native", source_event_id: "evt_f" })
  expect(form({ tool: { messageID: "msg_1", callID: "call/1" } })?.attention?.origin).toEqual({ type: "native", source_event_id: "evt_f" })
})

test("deferred lifecycle events carry review-origin attention", () => {
  const cases = [
    ["guardrail.deferred", "session.guardrail.changed", "guardrail", { requestID: "grq_1", itemID: "rev_1" }],
    ["permission.deferred", "session.permission.changed", "permission", { requestID: "per_1", itemID: "rev_1" }],
    ["question.deferred", "session.question.changed", "question", { requestID: "que_1", itemID: "rev_1" }],
    ["form.deferred", "session.form.changed", "form", { id: "frm_1", itemID: "rev_1" }],
  ] as const
  for (const [type, name, kind, data] of cases) {
    const value = mapEvent({ type, id: "evt_d", data: { sessionID: "ses_a", ...data } })
    expect(value).toMatchObject({ name, state: "deferred", itemID: "rev_1" })
    expect(value?.attention).toEqual({
      kind,
      origin: { type: "review", source_event_id: "evt_d" },
      ...(kind === "guardrail" ? { review: "unreported" } : {}),
      actions: pendingActions,
    })
  }
})

test("session review deferral preserves direct tool origin and falls back to the review lifecycle event", () => {
  const deferred = (data: Record<string, unknown>, id = "evt_r") => mapEvent({ type: "session.review.deferred", id, data: { sessionID: "ses_a", itemID: "rev_1", ...data } })
  const guardrailPayload = (hardReview: boolean) => ({ type: "guardrail", action: "shell", resources: ["/private"], ruleIDs: [], reason: "private reason", hardReview, directories: [], requestID: "grq_1" })
  const hard = deferred({ kind: "guardrail", origin: tool, payload: guardrailPayload(true) })
  expect(hard?.attention).toEqual({ kind: "guardrail", origin: toolOrigin("evt_r"), review: "hard", actions: pendingActions })
  expect(JSON.stringify(hard)).not.toContain("private")
  expect(deferred({ kind: "guardrail", origin: { requestID: "grq_1" }, payload: guardrailPayload(false) })?.attention)
    .toEqual({ kind: "guardrail", origin: { type: "review", source_event_id: "evt_r" }, review: "unreported", actions: pendingActions })
  expect(deferred({ kind: "guardrail", origin: { messageID: "bad id", callID: "call_1" }, payload: guardrailPayload(false) })?.attention?.origin)
    .toEqual({ type: "review", source_event_id: "evt_r" })
  expect(deferred({ kind: "permission", origin: tool, payload: { type: "permission", requestID: "per_1" } })?.attention)
    .toEqual({ kind: "permission", origin: toolOrigin("evt_r"), actions: pendingActions })
  expect(deferred({ kind: "question", origin: { questionID: "que_1" }, payload: { type: "question", questions: [] } })?.attention)
    .toEqual({ kind: "question", origin: { type: "review", source_event_id: "evt_r" }, actions: pendingActions })
  expect(deferred({ kind: "question", origin: tool, payload: { type: "form", title: "Private", fields: [] } })).toMatchObject({ name: "session.form.changed" })
  expect(deferred({ kind: "question", origin: tool, payload: { type: "form", title: "Private", fields: [] } })?.attention?.kind).toBe("form")
  expect(deferred({ kind: "subagent_question", origin: { questionID: "que_1" }, payload: { type: "subagent_question", text: "Private child text" } })?.attention)
    .toEqual({ kind: "subagent_question", origin: { type: "review", source_event_id: "evt_r" }, actions: pendingActions })
  expect(deferred({ kind: "recovery", payload: { type: "recovery", tools: [] } })).toMatchObject({ name: "session.question.changed", state: "deferred", itemID: "rev_1", attention: {
    kind: "recovery", origin: { type: "review", source_event_id: "evt_r" }, actions: pendingActions,
  } })
})

test("an invalid event identifier omits attention instead of forging a source", () => {
  for (const id of ["", "bad id", "a/b", "e".repeat(129)]) {
    const value = mapEvent({ type: "question.asked", id, data: { id: "que_1", sessionID: "ses_a" } })
    expect(value).toMatchObject({ name: "session.question.changed", state: "pending", requestID: "que_1" })
    expect(value?.attention).toBeUndefined()
    expect(value).not.toHaveProperty("attention")
  }
  expect(mapEvent({ type: "session.review.deferred", id: "bad id", data: { sessionID: "ses_a", itemID: "rev_1", kind: "permission", payload: { type: "permission" } } })?.attention).toBeUndefined()
})

test("attention is attached only to pending or deferred request lifecycle events", () => {
  const sid = { sessionID: "ses_a" }
  const none: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["guardrail.replied", { ...sid, requestID: "grq_1", reply: "once" }],
    ["guardrail.decided", { ...sid, requestID: "grq_1", decision: "ask" }],
    ["guardrail.decided", { ...sid, decision: "allow" }],
    ["permission.replied", { ...sid, requestID: "per_1", reply: "reject" }],
    ["question.replied", { ...sid, requestID: "que_1" }],
    ["question.rejected", { ...sid, requestID: "que_1" }],
    ["question.timed_out", { ...sid, requestID: "que_1" }],
    ["form.replied", { ...sid, id: "frm_1" }],
    ["form.cancelled", { ...sid, id: "frm_1" }],
    ["form.timed_out", { ...sid, id: "frm_1" }],
    ["session.guardrail.decided", { ...sid, requestID: "grq_1", reply: "once" }],
    ["session.guardrail.approved", sid],
    ["session.guardrail.dismissed", { ...sid, ruleID: "standard.review.x" }],
    ["session.review.decided", { ...sid, itemID: "rev_1", kind: "guardrail", decision: { reply: "once" } }],
    ["session.review.withdrawn", { ...sid, itemID: "rev_1", kind: "guardrail", reason: "revert" }],
    ["session.execution.started", sid],
    ["session.execution.failed", { ...sid, error: { type: "provider.transport" } }],
    ["session.work.completed", { ...sid, inputID: "msg_1" }],
    ["session.task.updated", { ...sid, change: { type: "completed" } }],
    ["session.dots.report.recorded", { ...sid, envelope: { kind: "decision_request", replyToMessageID: "msg_input" } }],
  ]
  for (const [type, data] of none) {
    const value = mapEvent({ type, id: "evt_n", data })
    expect(value).toBeDefined()
    expect(value).not.toHaveProperty("attention")
  }
})

test("attention carries metadata only: no prompts, resources, evidence or answers", () => {
  const values = [
    guardrail({ standard: false, resources: ["/private/path"], reason: "private reason", ruleIDs: ["custom.rule"], metadata: { command: "private command", tool } }),
    mapEvent({ type: "permission.asked", id: "evt_p", data: { id: "per_1", sessionID: "ses_a", action: "shell", resources: ["/private/path"], source: { type: "tool", ...tool } } }),
    mapEvent({ type: "form.created", id: "evt_f", data: { form: { id: "frm_1", sessionID: "ses_a", title: "Private title", fields: [{ key: "secret" }], metadata: { tool, answer: "private answer" } } } }),
  ]
  for (const value of values) {
    expect(Object.keys(value?.attention ?? {}).sort().every((key) => ["actions", "kind", "origin", "review"].includes(key))).toBe(true)
    expect(JSON.stringify(value?.attention)).not.toMatch(/private|secret|rm -rf/)
    expect(value?.attention?.actions).toEqual(pendingActions)
    expect(value?.attention).not.toHaveProperty("human_required")
  }
})

const childTask = (change: Record<string, unknown>, id = "evt_t") => mapEvent({ type: "session.task.updated", id, data: { sessionID: "ses_child", change } })

test("managed child question asked is pending subagent attention owned by the child", () => {
  const value = childTask({ type: "question_asked", question: { id: "que_child_1", text: "Private child question?", time: 1, data: { secret: "private data" } } })
  expect(value).toEqual({
    name: "session.question.changed",
    sessionID: "ses_child",
    state: "pending",
    sourceID: "evt_t",
    requestID: "que_child_1",
    taskID: "ses_child",
    attention: { kind: "subagent_question", origin: { type: "managed_task", source_event_id: "evt_t" }, actions: pendingActions },
  })
  expect(JSON.stringify(value)).not.toMatch(/Private|private/)
})

test("managed child question answered and timed out settle without attention or content", () => {
  const answered = childTask({ type: "question_answered", answer: { questionID: "que_child_1", text: "Private answer", data: { secret: "private data" } } })
  expect(answered).toEqual({ name: "session.question.changed", sessionID: "ses_child", state: "resolved", sourceID: "evt_t", requestID: "que_child_1", taskID: "ses_child" })
  const timedOut = childTask({ type: "question_timed_out", questionID: "que_child_1" })
  expect(timedOut).toEqual({ name: "session.question.changed", sessionID: "ses_child", state: "cancelled", sourceID: "evt_t", requestID: "que_child_1", taskID: "ses_child", reason: "timed_out" })
  for (const value of [answered, timedOut]) {
    expect(value).not.toHaveProperty("attention")
    expect(JSON.stringify(value)).not.toMatch(/Private|private/)
  }
})

test("managed child question with an invalid identifier omits the request id without inventing one", () => {
  for (const id of ["", "bad id", "q/1", "q".repeat(129), 7, undefined]) {
    const asked = childTask({ type: "question_asked", question: { id, text: "x", time: 1 } })
    expect(asked).toMatchObject({ name: "session.question.changed", state: "pending", taskID: "ses_child", sourceID: "evt_t" })
    expect(asked?.requestID).toBeUndefined()
    expect(asked?.attention).toMatchObject({ kind: "subagent_question", origin: { type: "managed_task", source_event_id: "evt_t" } })
    expect(childTask({ type: "question_answered", answer: { questionID: id, text: "x" } })?.requestID).toBeUndefined()
    expect(childTask({ type: "question_timed_out", questionID: id })?.requestID).toBeUndefined()
  }
  expect(childTask({ type: "question_asked" })?.requestID).toBeUndefined()
  expect(mapEvent({ type: "session.task.updated", id: "evt_t", data: { change: { type: "question_asked", question: { id: "que_1" } } } })).toBeUndefined()
})

test("managed child question attention is omitted when the event identifier is invalid and progress carries no text", () => {
  expect(childTask({ type: "question_asked", question: { id: "que_child_1" } }, "bad id")).not.toHaveProperty("attention")
  expect(childTask({ type: "progressed", progress: { text: "Private progress", time: 1 } })).toEqual({ name: "session.progress", state: "running", sessionID: "ses_child", taskID: "ses_child", sourceID: "evt_t" })
  expect(childTask({ type: "completed", excerpt: "private" })).toMatchObject({ name: "session.progress", state: "completed" })
})
