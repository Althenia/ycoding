import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Form } from "../src/form.js"
import { Guardrail } from "../src/guardrail.js"
import { Permission } from "../src/permission.js"
import { Question } from "../src/question.js"
import { SessionEvent } from "../src/session-event.js"
import { SessionOrchestration } from "../src/session-orchestration.js"
import { SessionReview } from "../src/session-review.js"
import { Agent } from "../src/agent.js"
import { SessionID } from "../src/session-id.js"
import { SessionMessage } from "../src/session-message.js"
import { EventManifest } from "../src/event-manifest.js"

const base = {
  itemID: SessionReview.ID.make("rvw_first"),
  sessionID: SessionID.make("ses_child"),
  rootSessionID: SessionID.make("ses_root"),
  sessionTitle: "Inspect changes",
  created: 1,
  reason: "sleep_entry",
  origin: { messageID: SessionMessage.ID.make("msg_ask"), callID: "call_ask" },
  child: { agent: Agent.ID.make("reviewer"), description: SessionOrchestration.DescriptionText.make("Inspect changes") },
} as const
const payloads = [
  {
    kind: "question",
    payload: { type: "form", title: "Questions", fields: [{ key: "choice", type: "string" }], questionTool: true },
  },
  {
    kind: "question",
    payload: { type: "question", questions: [{ header: "Plan", question: "Which plan?", options: [] }] },
  },
  {
    kind: "subagent_question",
    payload: { type: "subagent_question", text: SessionOrchestration.QuestionText.make("Which plan?"), data: { choices: ["A", "B"] } },
  },
  {
    kind: "guardrail",
    payload: {
      type: "guardrail",
      action: "shell",
      resources: ["echo [redacted]"],
      ruleIDs: ["review"],
      reason: "Review action",
      hardReview: true,
      directories: [],
      fingerprint: "a".repeat(64),
      requestID: Guardrail.RequestID.make("grq_review"),
    },
  },
  {
    kind: "permission",
    payload: {
      type: "permission",
      action: "shell",
      resources: ["echo [redacted]"],
      save: ["echo *"],
      fingerprint: "b".repeat(64),
      requestID: Permission.ID.make("per_review"),
    },
  },
] as const

test("review IDs have the exact ascending prefix and reject other ID domains", () => {
  expect(SessionReview.ID.create()).toMatch(/^rvw_/)
  for (const value of ["rvw_valid", "rvw_second"]) expect(Schema.decodeUnknownSync(SessionReview.ID)(value)).toBe(SessionReview.ID.make(value))
  for (const value of ["rvwbad", "grq_review", "per_review"])
    expect(() => Schema.decodeUnknownSync(SessionReview.ID)(value)).toThrow()
})

test("disabled automation reviews round-trip without helper attribution", () => {
  for (const variant of payloads.filter((value) => value.kind !== "permission")) {
    const item = Schema.decodeUnknownSync(SessionReview.Item)({ ...base, ...variant, reason: "disabled" })
    const encoded = Schema.encodeSync(SessionReview.Item)(item)
    expect(encoded.reason).toBe("disabled")
    expect(encoded).not.toHaveProperty("choice")
    expect(encoded).not.toHaveProperty("confidence")
    expect(encoded).not.toHaveProperty("grades")
    expect(Schema.decodeUnknownSync(SessionReview.Item)(encoded)).toEqual(item)
  }
})

test("review items cover the four kinds and preserve question input variants and child attribution", () => {
  for (const variant of payloads) {
    const item = { ...base, ...variant }
    expect(Schema.decodeUnknownSync(SessionReview.Item)(item)).toEqual(item)
    expect(() =>
      Schema.decodeUnknownSync(SessionReview.Item)({
        ...item,
        kind: variant.kind === "permission" ? "guardrail" : "permission",
      }),
    ).toThrow()
  }
  expect(() => Schema.decodeUnknownSync(SessionReview.Kind)("form")).toThrow()
})

test("review reasons, origins and optional helper evidence survive serialization without invented values", () => {
  for (const reason of ["free_text", "refused", "low_confidence", "escalated", "error", "timeout", "sleep_entry"] as const)
    expect(Schema.decodeUnknownSync(SessionReview.Reason)(reason)).toBe(reason)
  for (const origin of [
    { messageID: SessionMessage.ID.make("msg_ask"), callID: "call_ask" },
    { questionID: SessionOrchestration.QuestionID.make("qst_review") },
    { requestID: "per_review" },
  ])
    expect(Schema.decodeUnknownSync(SessionReview.Origin)(origin)).toEqual(origin)
  for (const origin of [{}, { messageID: "msg_ask" }, { questionID: "wrong" }])
    expect(() => Schema.decodeUnknownSync(SessionReview.Origin)(origin as SessionReview.Origin)).toThrow()
  const item = Schema.decodeUnknownSync(SessionReview.Item)({
    ...base,
    ...payloads[3],
    choice: "escalate",
    confidence: 0.799999,
  })
  expect(item.confidence).toBe(0.799999)
  const encoded = Schema.encodeSync(SessionReview.Item)(
    Schema.decodeUnknownSync(SessionReview.Item)({ ...base, ...payloads[0] }),
  )
  expect(encoded).not.toHaveProperty("choice")
  expect(encoded).not.toHaveProperty("confidence")
  for (const confidence of [-0.01, 1.01, Infinity, Number.NaN])
    expect(() => Schema.decodeUnknownSync(SessionReview.Item)({ ...base, ...payloads[0], confidence })).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(SessionReview.Item)({
      ...base,
      ...payloads[3],
      payload: { ...payloads[3].payload, fingerprint: "not-a-hash" },
    }),
  ).toThrow()
})

test("human decisions are kind-tagged and admit answers, dismissals, and live approval choices", () => {
  const decisions: SessionReview.Decision[] = [
    { kind: "question", answers: { choice: "A", enabled: true, count: 2 } },
    { kind: "question", answers: [["A"], ["B", "C"]] },
    { kind: "subagent_question", text: SessionOrchestration.ControlText.make("Proceed"), data: { plan: "A" } },
    ...(["question", "subagent_question"] as const).map((kind) => ({ kind, dismissed: true as const })),
    ...(["guardrail", "permission"] as const).flatMap((kind) =>
      (["once", "always", "reject"] as const).map((reply) => ({ kind, reply })),
    ),
  ]
  for (const decision of decisions)
    expect(Schema.decodeUnknownSync(SessionReview.Decision)(decision)).toEqual(decision)
  for (const decision of [
    { kind: "guardrail", reply: "approve" },
    { kind: "permission", dismissed: true },
    { kind: "question" },
    { kind: "subagent_question", answers: [] },
    { reply: "once" },
  ])
    expect(() => Schema.decodeUnknownSync(SessionReview.Decision)(decision as SessionReview.Decision)).toThrow()
})

test("review lifecycle events are public durable Session facts with canonical identities", () => {
  const deferred = {
    sessionID: SessionID.make("ses_child"),
    itemID: SessionReview.ID.make("rvw_first"),
    reason: "sleep_entry",
    origin: base.origin,
    ...payloads[3],
  }
  for (const [definition, data] of [
    [SessionEvent.Review.Deferred, deferred],
    [
      SessionEvent.Review.Decided,
      { sessionID: SessionID.make("ses_child"), itemID: SessionReview.ID.make("rvw_first"), decision: { kind: "guardrail", reply: "once" } },
    ],
    [SessionEvent.Review.Withdrawn, { sessionID: SessionID.make("ses_child"), itemID: SessionReview.ID.make("rvw_first"), reason: "reverted" }],
    [SessionEvent.Review.Consumed, { sessionID: SessionID.make("ses_child"), itemID: SessionReview.ID.make("rvw_first") }],
  ] as const) {
    expect(definition.durable).toEqual({ aggregate: "sessionID", version: 1 })
    expect(EventManifest.Durable.get(`${definition.type}.1`)).toBe(definition)
    expect(EventManifest.Server.get(definition.type)).toBe(definition)
    expect(Schema.decodeUnknownSync(definition.data)(data)).toEqual(data)
  }
  expect(SessionEvent.Review.Consumed.data.fields).not.toHaveProperty("fingerprint")
  expect(() =>
    Schema.decodeUnknownSync(SessionEvent.Review.Withdrawn.data)({
      sessionID: SessionID.make("ses_child"),
      itemID: SessionReview.ID.make("rvw_first"),
      reason: "timeout" as "reverted",
    }),
  ).toThrow()
})

test("deferred form settlement, orchestration state and ephemeral removal events carry the review item", () => {
  const state = { status: "deferred" as const, itemID: SessionReview.ID.make("rvw_first") }
  expect(Schema.decodeUnknownSync(Form.State)(state)).toEqual(state)
  expect(() => Schema.decodeUnknownSync(Form.State)({ status: "deferred" } as Form.State)).toThrow()
  const question = { id: SessionOrchestration.QuestionID.make("qst_review"), text: SessionOrchestration.QuestionText.make("Which plan?"), time: 1, deferred: true }
  expect(Schema.decodeUnknownSync(SessionOrchestration.Question)(question)).toEqual(question)
  expect(
    Schema.encodeSync(SessionOrchestration.Question)(
      Schema.decodeUnknownSync(SessionOrchestration.Question)({ id: SessionOrchestration.QuestionID.make("qst_review"), text: SessionOrchestration.QuestionText.make("Which plan?"), time: 1 }),
    ),
  ).not.toHaveProperty("deferred")
  for (const [definition, data] of [
    [Form.Event.Deferred, { id: Form.ID.make("frm_review"), sessionID: "ses_child", itemID: SessionReview.ID.make("rvw_first") }],
    [Question.Event.Deferred, { requestID: Question.ID.make("que_review"), sessionID: SessionID.make("ses_child"), itemID: SessionReview.ID.make("rvw_first") }],
    [
      Guardrail.Event.Deferred,
      { rootSessionID: SessionID.make("ses_root"), sessionID: SessionID.make("ses_child"), requestID: Guardrail.RequestID.make("grq_review"), itemID: SessionReview.ID.make("rvw_first") },
    ],
    [Permission.Event.Deferred, { sessionID: SessionID.make("ses_child"), requestID: Permission.ID.make("per_review"), itemID: SessionReview.ID.make("rvw_first") }],
  ] as const) {
    expect(definition.durability).toBe("ephemeral")
    expect(EventManifest.Server.get(definition.type)).toBe(definition)
    expect(EventManifest.Durable.has(`${definition.type}.1`)).toBe(false)
    expect(Schema.decodeUnknownSync(definition.data)(data)).toEqual(data)
  }
})

test("guardrail provenance decodes old rows and preserves grades, rule IDs and canonical tool identity", () => {
  const sessionID = SessionID.make("ses_root")
  const source = { messageID: SessionMessage.ID.make("msg_guardrail"), callID: "call_guardrail" }
  const grades = [{ choice: "approve_all", confidence: 0.9, evidence: "Scoped directory" }, { choice: "reject", confidence: 0.1, evidence: "No contrary evidence" }] as const
  for (const [definition, data] of [
    [SessionEvent.GuardrailDecided, { sessionID, reviewSessionID: sessionID, requestID: "grq_decided", reply: "once" }],
    [SessionEvent.GuardrailEscalated, { sessionID, requestID: "grq_escalated" }],
  ] as const) {
    expect(EventManifest.Server.get(definition.type)).toBe(definition)
    expect(EventManifest.Durable.get(`${definition.type}.1`)).toBe(definition)
    expect(Schema.encodeSync(definition.data)(Schema.decodeUnknownSync(definition.data)(data))).toEqual(data)
    const current = { ...data, ruleIDs: ["standard.review.outside-repo"], source, grades }
    expect(Schema.encodeSync(definition.data)(Schema.decodeUnknownSync(definition.data)(current))).toEqual(current)
    for (const field of ["action", "resources", "metadata", "evidence", "targets"])
      expect(definition.data.fields).not.toHaveProperty(field)
  }
  expect(Object.keys(Guardrail.Source.fields)).toEqual(["messageID", "callID"])
  const dismissal = { sessionID, reviewSessionID: sessionID, ruleID: "standard.review.outside-repo", confidence: 0.9 }
  expect(Schema.encodeSync(SessionEvent.GuardrailDismissed.data)(Schema.decodeUnknownSync(SessionEvent.GuardrailDismissed.data)(dismissal))).toEqual(dismissal)
  expect(Schema.decodeUnknownSync(SessionEvent.GuardrailDismissed.data)({ ...dismissal, source }).source).toEqual(source)
  expect(() => Schema.decodeUnknownSync(Guardrail.Source)({ callID: "call_guardrail" })).toThrow()
  const status = {
    rootSessionID: sessionID, profile: "standard", customRules: 0, invalidFiles: [], counters: [], blocked: 0, approvals: 0,
    decisions: [{ sessionID, created: 1, requestID: "grq_decided", reply: "always", choice: "approve_all", confidence: 0.9, grades, ruleIDs: ["review"], source }],
  } as const
  expect(Schema.decodeUnknownSync(Guardrail.Status)(status).decisions).toEqual(status.decisions)
  expect(Schema.decodeUnknownSync(Guardrail.Status)({ ...status, decisions: [{ sessionID, created: 1, requestID: "old", reply: "reject" }] }).decisions?.[0]).not.toHaveProperty("ruleIDs")
  expect(Schema.decodeUnknownSync(Guardrail.Escalation)({ choice: "approve_all", confidence: 0.9, grades }).grades).toEqual(grades)
  for (const evidence of ["", " ", "e".repeat(501)])
    expect(() => Schema.decodeUnknownSync(Guardrail.Grade)({ choice: "approve", confidence: 0.8, evidence })).toThrow()
  expect(() => Schema.decodeUnknownSync(Guardrail.Grade)({ choice: "approve", confidence: 1.01, evidence: "Bounded" })).toThrow()
  expect(Schema.decodeUnknownSync(SessionEvent.GuardrailDecided.data)({ sessionID, reviewSessionID: sessionID,
    requestID: "grq_always", reply: "always", choice: "approve_all", confidence: 0.9, grades }).grades).toEqual(grades)
})

test("numeric form fields and conditions use the same finite JSON values in every transport direction", () => {
  for (const type of ["number", "integer"] as const) {
    const field = { key: "count", type, minimum: 0, maximum: 10, default: 2, when: [{ key: "enabled", op: "eq" as const, value: 1 }] }
    expect(Schema.encodeSync(Form.Field)(Schema.decodeUnknownSync(Form.Field)(field))).toEqual(field)
    for (const value of [Infinity, -Infinity, Number.NaN]) {
      for (const property of ["minimum", "maximum", "default"])
        expect(() => Schema.decodeUnknownSync(Form.Field)({ ...field, [property]: value })).toThrow()
      expect(() => Schema.decodeUnknownSync(Form.When)({ key: "enabled", op: "eq", value })).toThrow()
    }
  }
})

test("restart recovery items list unsettled tool calls only and accept only a Continue or Stop decision", () => {
  const recovery = {
    ...base,
    kind: "recovery",
    reason: "restart",
    origin: { questionID: SessionOrchestration.QuestionID.make("qst_restart") },
    payload: {
      type: "recovery",
      tools: [{ messageID: SessionMessage.ID.make("msg_tool"), callID: "call_read", name: "read" }],
    },
  } as const
  expect(Schema.decodeUnknownSync(SessionReview.Item)(recovery)).toEqual(recovery)
  expect(() => Schema.decodeUnknownSync(SessionReview.Item)({ ...recovery, payload: { type: "recovery", tools: [] } })).toThrow()
  const withInput = Schema.decodeUnknownSync(SessionReview.Item)({
    ...recovery,
    payload: { type: "recovery", tools: [{ ...recovery.payload.tools[0], input: { path: "/secret" } }] },
  })
  expect(withInput.payload).toEqual(recovery.payload)
  for (const decision of [
    { kind: "recovery", choice: "continue" },
    { kind: "recovery", choice: "stop" },
  ] as const)
    expect(Schema.decodeUnknownSync(SessionReview.Decision)(decision)).toEqual(decision)
  for (const decision of [{ kind: "recovery", dismissed: true }, { kind: "recovery", choice: "retry" }, { kind: "recovery" }])
    expect(() => Schema.decodeUnknownSync(SessionReview.Decision)(decision as SessionReview.Decision)).toThrow()
})
