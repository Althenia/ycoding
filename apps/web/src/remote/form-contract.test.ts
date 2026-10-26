import { expect, test } from "bun:test"
import type { Form } from "../../../../packages/schema/src/form"
import { applySessionEvent, createSessionView, readFormAssessment, readFormReplySource, readForms, type FormReplySourceView, type FormView } from "./projection"

test("native form readers retain validation, input hints and multiselect constraints", () => {
  const form = { id: "frm_native", sessionID: "ses_a", title: "Inputs", fields: [
    { key: "name", type: "string", required: true, minLength: 2, maxLength: 20, pattern: "[a-z]+", format: "email", placeholder: "Your email" },
    { key: "tags", type: "multiselect", options: [], custom: true, minItems: 1, maxItems: 3, default: ["first"] },
  ] } satisfies FormView
  expect(readForms([form])).toEqual([form])
})

test("created forms cannot fabricate a request from malformed or other-Session data", () => {
  const view = createSessionView("ses_a")
  for (const form of [null, { id: "frm_other", sessionID: "ses_b", title: "Other", fields: [{key: "x", type: "string"}] }]) {
    expect(applySessionEvent(view, {type: "form.created", data: {form}}, 1).requests).toEqual([])
  }
})

test("one malformed field rejects the form rather than silently dropping an answer requirement", () => {
  expect(readForms([{ id: "frm_bad", sessionID: "ses_a", title: "Bad", fields: [
    {key: "valid", type: "string"}, {key: "unknown", type: "unsupported", required: true},
  ] }])).toEqual([])
})

test("question assessments survive reads and live updates without reviving settled or other-Session forms", () => {
  const assessment = { mode: "yolo" as const, sourceSessionID: "ses_parent", fields: [{ key: "q0", status: "assessed" as const, reason: "One compatible set.",
    grades: [{ choice: "local", confidence: 0.91, evidence: "Fits local-only work." }], recommendation: ["local"],
  }] }
  const form = { id: "frm_assessment", sessionID: "ses_a", title: "Question", fields: [{ key: "q0", type: "string", options: [{ value: "local", label: "Local" }] }], assessment } satisfies FormView
  expect(readForms([form])).toEqual([form])
  const pending = applySessionEvent(createSessionView("ses_a"), { type: "form.created", data: { form: { ...form, assessment: undefined } } }, 1)
  const updated = applySessionEvent(pending, { type: "form.assessed", data: { id: form.id, sessionID: "ses_a", assessment } }, 2)
  expect(updated.requests).toMatchObject([{ kind: "form", form: { assessment } }])
  expect(applySessionEvent(pending, { type: "form.assessed", data: { id: form.id, sessionID: "ses_other", assessment } }, 2)).toEqual(pending)
  const settled = applySessionEvent(updated, { type: "form.replied", data: { id: form.id, sessionID: "ses_a", answer: { q0: "local" } } }, 3)
  expect(applySessionEvent(settled, { type: "form.assessed", data: { id: form.id, sessionID: "ses_a", assessment } }, 4).requests).toEqual([])
})

test("assessment readers reject malformed bounded grades rather than displaying invented values", () => {
  const grade = { choice: "a", confidence: 0.9, evidence: "Reported evidence." }
  const field: Form.FieldAssessment = { key: "q0", status: "assessed", reason: "Supported.", grades: [grade], recommendation: ["a"] }
  const assessment: Form.Assessment = { mode: "yolo", sourceSessionID: "ses_source", fields: [field] }
  for (const invalid of [null, { ...assessment, mode: "enabled" }, { ...assessment, sourceSessionID: 42 },
    ...[{ ...field, status: "allowed" }, { ...field, reason: " " }, { ...field, reason: "x".repeat(501) }, { ...field, grades: {} }, { ...field, recommendation: [1] },
      ...[-0.1, 1.1, Infinity, NaN].map(confidence => ({ ...field, grades: [{ ...grade, confidence }] })),
      ...["", " ", "x".repeat(501)].map(evidence => ({ ...field, grades: [{ ...grade, evidence }] })),
    ].map(field => ({ ...assessment, fields: [field] })),
  ]) expect(readFormAssessment(invalid)).toBeUndefined()
  expect(readFormAssessment(assessment)).toEqual(assessment)
})

test("native coordinator reply sources preserve the closed public attribution shape", () => {
  const source: FormReplySourceView = { kind: "coordinator", coordinatorSessionID: "ses_coord", groupID: "cgrp_one", via: "yolo", confidence: 0.93, rationale: "Assigned work." }
  expect(readFormReplySource(source)).toEqual(source)
  for (const invalid of [null, { ...source, kind: "human" }, { ...source, coordinatorSessionID: 4 }, { ...source, via: "approved" }, { ...source, confidence: Infinity }, { ...source, confidence: -0.1 }, { ...source, rationale: " " }, { ...source, rationale: "x".repeat(501) }])
    expect(readFormReplySource(invalid)).toBeUndefined()
})

test("Dots delegated reply sources keep their exact external attribution without a coordinator identity", () => {
  const source: FormReplySourceView = { kind: "dots-delegation", anchorSessionID: "ses_anchor", delegationID: "delegation_one", revision: 3, exchangeID: "exchange_one" }
  expect(readFormReplySource(source)).toEqual(source)
  for (const invalid of [null, { ...source, kind: "human" }, { ...source, anchorSessionID: 4 }, { ...source, anchorSessionID: "" }, { ...source, anchorSessionID: "usr_anchor" },
    { ...source, delegationID: 4 }, { ...source, delegationID: "" }, { ...source, delegationID: "d".repeat(257) },
    { ...source, exchangeID: undefined }, { ...source, exchangeID: "" }, { ...source, exchangeID: "e".repeat(257) },
    { ...source, revision: 0 }, { ...source, revision: -1 }, { ...source, revision: 1.5 }, { ...source, revision: "3" }])
    expect(readFormReplySource(invalid)).toBeUndefined()
})
