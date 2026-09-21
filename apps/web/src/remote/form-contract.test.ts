import { expect, test } from "bun:test"
import { applySessionEvent, createSessionView, readForms, type FormView } from "./projection"

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
