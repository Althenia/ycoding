import { describe, expect, test } from "bun:test"
import { applySessionEvent, changesReviewItems, classifySyntheticNotice, createSessionView, readFormRequests, readGuardrailRequests, readPermissionRequests, readReviewItems, type SessionView } from "./projection"
import { projectEscalationLines, readProjectEscalation } from "./project-escalation"

const chain = { reasons: [
  { sessionID: "ses_driver", reason: "The driver cannot grant production credentials." },
  { sessionID: "ses_master", reason: "The Master has no authority outside the assigned worktree." },
] }
const view = [
  { sessionID: "ses_driver", reason: "The driver cannot grant production credentials." },
  { sessionID: "ses_master", reason: "The Master has no authority outside the assigned worktree." },
]
const apply = (state: SessionView, type: string, data: Record<string, unknown>) => applySessionEvent(state, { type, data }, 1)
const form = (extra: Record<string, unknown> = {}) => ({ id: "frm_1", sessionID: "ses_root", title: "Question", fields: [{ key: "q0", type: "string", title: "Which module?" }], ...extra })

describe("readProjectEscalation", () => {
  test("keeps up to four chronological reasons and nothing else", () => {
    expect(readProjectEscalation(chain)).toEqual(view)
    expect(readProjectEscalation({ reasons: Array.from({ length: 4 }, (_, index) => ({ sessionID: `ses_${index}`, reason: `Reason ${index}` })) })).toHaveLength(4)
  })

  test("refuses any malformed chain whole instead of showing part of it", () => {
    const entry = chain.reasons[0]!
    for (const value of [
      undefined, null, [], "reasons", {}, { reasons: [] }, { reasons: "none" },
      { reasons: Array.from({ length: 5 }, () => entry) },
      { reasons: [entry, { sessionID: "ses_master", reason: "   " }] },
      { reasons: [entry, { sessionID: "ses_master", reason: "x".repeat(501) }] },
      { reasons: [entry, { sessionID: "master", reason: "Not a Session id" }] },
      { reasons: [entry, { sessionID: "ses_master" }] },
      { reasons: [entry, { sessionID: "ses_master", reason: 4 }] },
      { reasons: [entry, "ses_master"] },
    ]) expect(readProjectEscalation(value)).toBeUndefined()
    expect(readProjectEscalation({ reasons: [{ sessionID: "ses_driver", reason: "x".repeat(500) }] })).toHaveLength(1)
  })

  test("lines name the Session by its known title and otherwise by its identifier, in reported order", () => {
    const titles = new Map([["ses_master", "Release lead"]])
    expect(projectEscalationLines(view, (id) => titles.get(id))).toEqual([
      { sessionID: "ses_driver", label: "ses_driver", reason: view[0]!.reason },
      { sessionID: "ses_master", label: "Release lead", reason: view[1]!.reason },
    ])
  })
})

describe("project escalation on pending requests", () => {
  test("permission, guardrail and form lists carry the chain beside any model escalation", () => {
    const modelEscalation = { reason: "low_confidence" }
    const permission = readPermissionRequests({ data: [{ id: "per_1", action: "edit", resources: ["src/**"], coordinationEscalation: chain, escalation: modelEscalation }, { id: "per_2", action: "edit", resources: [] }] }, 1)
    expect(permission[0]).toMatchObject({ kind: "permission", id: "per_1", projectEscalation: view, escalation: modelEscalation })
    expect(permission[1]).not.toHaveProperty("projectEscalation")
    const guardrail = readGuardrailRequests({ data: [{ id: "grq_1", sessionID: "ses_member", action: "write", resources: ["/tmp/x"], coordinationEscalation: chain }] }, 1)
    expect(guardrail[0]).toMatchObject({ kind: "guardrail", projectEscalation: view })
    expect(guardrail[0]).not.toHaveProperty("escalation")
    const forms = readFormRequests([form({ coordinationEscalation: chain }), form({ id: "frm_2" })], 1)
    expect(forms[0]).toMatchObject({ kind: "form", id: "frm_1", projectEscalation: view })
    expect(forms[1]).not.toHaveProperty("projectEscalation")
  })

  test("a malformed chain is dropped without dropping the request", () => {
    const bad = { reasons: [{ sessionID: "ses_driver", reason: "" }] }
    const [permission] = readPermissionRequests({ data: [{ id: "per_1", action: "edit", resources: [], coordinationEscalation: bad }] }, 1)
    expect(permission).toMatchObject({ kind: "permission", id: "per_1" })
    expect(permission).not.toHaveProperty("projectEscalation")
  })

  test("live asked events carry the chain onto the pending request", () => {
    let state = apply(createSessionView("ses_root"), "permission.asked", { id: "per_1", action: "edit", resources: [], coordinationEscalation: chain })
    state = apply(state, "guardrail.asked", { id: "grq_1", sessionID: "ses_member", action: "write", resources: ["/tmp/x"], reason: "Outside", hardReview: false, coordinationEscalation: chain })
    state = apply(state, "form.created", { form: form({ coordinationEscalation: chain }) })
    expect(state.requests.map((request) => [request.kind, request.projectEscalation])).toEqual([["permission", view], ["guardrail", view], ["form", view]])
  })

  test("the escalated event attaches to the matching request kind and identifier only", () => {
    let state = apply(createSessionView("ses_root"), "permission.asked", { id: "per_1", action: "edit", resources: [] })
    state = apply(state, "guardrail.asked", { id: "grq_1", sessionID: "ses_member", action: "write", resources: [], reason: "Outside", hardReview: false })
    state = apply(state, "form.created", { form: form() })
    state = apply(state, "coordination.request.escalated", { sessionID: "ses_member", kind: "permission", requestID: "per_1", coordinationEscalation: chain })
    state = apply(state, "coordination.request.escalated", { sessionID: "ses_member", kind: "review", requestID: "grq_1", coordinationEscalation: chain })
    state = apply(state, "coordination.request.escalated", { sessionID: "ses_member", kind: "question", requestID: "frm_1", coordinationEscalation: chain })
    expect(state.requests.map((request) => request.projectEscalation)).toEqual([view, view, view])

    let mismatched = apply(createSessionView("ses_root"), "permission.asked", { id: "per_1", action: "edit", resources: [] })
    mismatched = apply(mismatched, "coordination.request.escalated", { sessionID: "ses_member", kind: "question", requestID: "per_1", coordinationEscalation: chain })
    mismatched = apply(mismatched, "coordination.request.escalated", { sessionID: "ses_member", kind: "permission", requestID: "per_1", coordinationEscalation: { reasons: [] } })
    expect(mismatched.requests[0]).not.toHaveProperty("projectEscalation")
  })

  test("an escalated event that precedes its request still reaches it, and a settled request leaves nothing behind", () => {
    let state = apply(createSessionView("ses_root"), "coordination.request.escalated", { sessionID: "ses_member", kind: "permission", requestID: "per_1", coordinationEscalation: chain })
    state = apply(state, "permission.asked", { id: "per_1", action: "edit", resources: [] })
    expect(state.requests[0]).toMatchObject({ id: "per_1", projectEscalation: view })
    state = apply(state, "permission.replied", { requestID: "per_1", reply: "once" })
    state = apply(state, "permission.asked", { id: "per_1", action: "edit", resources: [] })
    expect(state.requests[0]).not.toHaveProperty("projectEscalation")
  })

  test("the escalated event refreshes the review box", () => {
    expect(changesReviewItems({ type: "coordination.request.escalated", data: {} })).toBe(true)
  })
})

describe("project escalation on review items", () => {
  const base = { sessionID: "ses_member", rootSessionID: "ses_root", sessionTitle: "Member", created: 1, reason: "sleep_entry" }
  test("permission, guardrail and form payloads carry the chain; the legacy question payload never does", () => {
    const items = readReviewItems({ data: [
      { ...base, itemID: "rvw_p", kind: "permission", payload: { type: "permission", action: "edit", resources: ["a"], coordinationEscalation: chain } },
      { ...base, itemID: "rvw_g", kind: "guardrail", payload: { type: "guardrail", action: "write", resources: ["a"], ruleIDs: [], reason: "Outside", hardReview: false, directories: [], coordinationEscalation: chain } },
      { ...base, itemID: "rvw_f", kind: "question", payload: { type: "form", title: "Question", fields: [{ key: "q0", type: "string", title: "Which?" }], coordinationEscalation: chain } },
      { ...base, itemID: "rvw_q", kind: "question", payload: { type: "question", questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }] }], coordinationEscalation: chain } },
      { ...base, itemID: "rvw_n", kind: "permission", payload: { type: "permission", action: "edit", resources: [] } },
    ] })
    expect(items?.map((item) => [item.itemID, item.projectEscalation])).toEqual([["rvw_p", view], ["rvw_g", view], ["rvw_f", view], ["rvw_q", undefined], ["rvw_n", undefined]])
  })
})

describe("escalated Project notification", () => {
  const notice = (metadata: Record<string, unknown>) => classifySyntheticNotice({ kind: "synthetic", id: "msg_project_notice_1", text: "Project notification", metadata: { source: "project_notification", groupID: "cgrp_1", memberSessionID: "ses_member", title: "Docs worker", ...metadata }, created: 1 })

  test("names the member, the escalating Session and the reason", () => {
    expect(notice({ event: "escalated", requestID: "per_1", kind: "permission", excerpt: "Needs production credentials.", escalatedBy: { sessionID: "ses_driver", title: "Migration agent" } }))
      .toEqual({ kind: "member", label: "Docs worker", event: "escalated", memberSessionID: "ses_member", requestID: "per_1", excerpt: "Needs production credentials.", escalatedBy: "Migration agent" })
  })

  test("falls back to the escalating Session id and drops a malformed escalator", () => {
    expect(notice({ event: "escalated", escalatedBy: { sessionID: "ses_driver", title: "" } })).toMatchObject({ event: "escalated", escalatedBy: "ses_driver" })
    expect(notice({ event: "escalated", escalatedBy: "ses_driver" })).not.toHaveProperty("escalatedBy")
    expect(notice({ event: "completed", escalatedBy: { sessionID: "ses_driver", title: "Migration agent" } })).not.toHaveProperty("escalatedBy")
    expect(notice({ event: "unknown" })).toBeUndefined()
  })
})
