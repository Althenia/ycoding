import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
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
