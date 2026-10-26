import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionID } from "../src/session-id.js"
import { Form } from "../src/form.js"

describe("Form reply source attribution", () => {
  test("existing replied events keep an absent source and are never relabeled", () => {
    const decoded = Schema.decodeUnknownSync(Form.Event.Replied.data)({ id: "frm_one", sessionID: "ses_worker", answer: { choice: "a" } })
    expect(decoded).toEqual({ id: Form.ID.make("frm_one"), sessionID: "ses_worker", answer: { choice: "a" } })
    expect("source" in decoded).toBe(false)
    expect(Schema.encodeSync(Form.Event.Replied.data)(decoded)).toEqual({ id: "frm_one", sessionID: "ses_worker", answer: { choice: "a" } })
  })

  test("coordinator replies carry a closed optional source with native answer provenance", () => {
    const input = {
      id: "frm_one",
      sessionID: "ses_worker",
      answer: { choice: "a" },
      source: { kind: "coordinator", coordinatorSessionID: "ses_coord", groupID: "cgrp_one", via: "coordination", rationale: "Assigned routine work." } as const,
    }
    const decoded = Schema.decodeUnknownSync(Form.Event.Replied.data)(input)
    expect(Schema.encodeSync(Form.Event.Replied.data)(decoded)).toEqual(input)
    expect(() => Schema.decodeUnknownSync(Form.Event.Replied.data)({ ...input, source: { kind: "human", coordinatorSessionID: "ses_coord" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Form.Event.Replied.data)({ ...input, source: { kind: "coordinator" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Form.Event.Replied.data)({ ...input, source: { ...input.source, via: "manual" } })).toThrow()
  })
})

describe("Form question assessments", () => {
  const assessment: Form.Assessment = { mode: "yolo", sourceSessionID: "ses_source", fields: [{ key: "q0", status: "assessed", reason: "A bounded recommendation.",
    grades: [{ choice: "local", confidence: 0.8, evidence: "Matches the stated scope." }], recommendation: ["local"], confidence: 0.8,
  }] }

  test("assessment events and pending snapshots retain the same canonical optional contract", () => {
    const decoded = Schema.decodeUnknownSync(Form.Assessment)(assessment)
    expect(Schema.encodeSync(Form.Assessment)(decoded)).toEqual(assessment)
    const form = Schema.decodeUnknownSync(Form.Info)({ id: "frm_assessed", sessionID: "ses_owner", title: "Question", fields: [{ key: "q0", type: "string" }], assessment })
    const event = Schema.decodeUnknownSync(Form.Event.Assessed.data)({ id: form.id, sessionID: form.sessionID, assessment })
    expect(event.assessment).toEqual(Schema.decodeUnknownSync(Form.Assessment)(form.assessment))
    expect(Form.Event.Definitions).toContain(Form.Event.Assessed)
    expect(Schema.encodeSync(Form.FieldAssessment)(Schema.decodeUnknownSync(Form.FieldAssessment)({ key: "q0", status: "not_assessed", reason: "Manual is human-only." }))).toEqual({ key: "q0", status: "not_assessed", reason: "Manual is human-only." })
  })

  for (const confidence of [-0.01, 1.01, NaN, Infinity]) test(`rejects invalid confidence ${confidence}`, () => {
    expect(() => Schema.decodeUnknownSync(Form.OptionGrade)({ choice: "a", confidence, evidence: "Evidence." })).toThrow()
  })
  for (const evidence of ["", " ", "x".repeat(501)]) test(`rejects invalid grade evidence of length ${evidence.length}`, () => {
    expect(() => Schema.decodeUnknownSync(Form.OptionGrade)({ choice: "a", confidence: 0.9, evidence })).toThrow()
  })
})

describe("delegated reply source", () => {
  test("decodes the existing coordinator member and the dots-delegation member distinctly", () => {
    const decode = (value: unknown) => Schema.decodeUnknownSync(Form.ReplySource)(value, { onExcessProperty: "error" })
    const coordinator = { kind: "coordinator", coordinatorSessionID: "ses_coord", groupID: "cgrp_1", via: "coordination", rationale: "Assigned in the task." } satisfies Form.ReplySource
    expect(decode(coordinator)).toEqual(coordinator)
    const delegated = { kind: "dots-delegation", anchorSessionID: SessionID.make("ses_anchor"), delegationID: "proposal_1", revision: 1, exchangeID: "exchange_1" } satisfies Form.DelegatedReplySource
    expect(Schema.decodeUnknownSync(Form.DelegatedReplySource)(delegated, { onExcessProperty: "error" })).toEqual(delegated)
    expect(decode(delegated)).toEqual(delegated)
    for (const invalid of [
      { ...delegated, revision: 0 }, { ...delegated, delegationID: "" }, { ...delegated, exchangeID: "" },
      { ...delegated, coordinatorSessionID: "ses_coord" }, { ...coordinator, delegationID: "proposal_1" },
      { kind: "human", anchorSessionID: "ses_anchor", delegationID: "proposal_1", revision: 1, exchangeID: "exchange_1" },
    ] as unknown[]) expect(() => decode(invalid)).toThrow()
  })
})
