import { expect, test } from "bun:test"
import { formInputState, safeFormLink } from "./view-model"
import type { FormView } from "./projection"

const form: FormView = {id: "frm_inputs", sessionID: "ses_a", title: "Inputs", fields: [
  {key: "mode", type: "string", options: [{value: "on", label: "On"}, {value: "off", label: "Off"}], default: "on", required: true},
  {key: "tags", type: "multiselect", options: [], custom: true, default: ["ready"], minItems: 1, maxItems: 2, when: [{key: "mode", op: "eq", value: "on"}]},
  {key: "count", type: "integer", minimum: 1, maximum: 3, default: 2, required: true, when: [{key: "tags", op: "eq", value: "ready"}]},
  {key: "enabled", type: "boolean", default: false, required: true},
  {key: "done", type: "external", url: "https://example.invalid/confirm"},
]}

test("native defaults preserve false, arrays and numbers; external steps require acknowledgement", () => {
  expect(formInputState(form, {}).answer).toEqual({mode: "on", tags: ["ready"], count: 2, enabled: false})
  expect(formInputState(form, {}).valid).toBe(false)
  expect(formInputState(form, {done: true}).valid).toBe(true)
})

test("hidden answers and dependent defaults are omitted transitively", () => {
  const state = formInputState(form, {mode: "off", tags: ["ready"], count: 3, done: true})
  expect(state.fields.map(field => field.key)).toEqual(["mode", "enabled", "done"])
  expect(state.answer).toEqual({mode: "off", enabled: false, done: true})
  expect(state.valid).toBe(true)
  expect(formInputState(form, {mode: undefined}).fields.map(field => field.key)).toEqual(["mode", "enabled", "done"])
})

test("invalid typed or bounded answers cannot submit; clearing a default does not turn blank into zero", () => {
  for (const count of [0, 4, 1.5, Number.NaN, undefined]) expect(formInputState(form, {count, done: true}).valid).toBe(false)
  expect(formInputState(form, {tags: ["a", "b", "c"], done: true}).valid).toBe(false)
  expect(formInputState(form, {mode: "unknown", done: true}).valid).toBe(false)
  expect(formInputState(form, {count: undefined}).answer).not.toHaveProperty("count")
})

test("unanswered conditions fail for neq too and multiselect membership controls visibility", () => {
  const conditional: FormView = {...form, fields: [
    {key: "source", type: "multiselect", options: [] , custom: true},
    {key: "later", type: "string", required: true, when: [{key: "source", op: "neq", value: "skip"}]},
  ]}
  expect(formInputState(conditional, {}).fields.map(field => field.key)).toEqual(["source"])
  expect(formInputState(conditional, {source: ["skip"]}).fields.map(field => field.key)).toEqual(["source"])
  expect(formInputState(conditional, {source: []}).valid).toBe(false)
})

test("native constraints accept substring patterns, integer bounds and Unicode email without HTML-only restrictions", () => {
  expect(formInputState({...form, fields: [
    {key: "pattern", type: "string", pattern: "a", default: "ba", required: true},
    {key: "integer", type: "integer", minimum: 0.5, default: 1, required: true},
    {key: "email", type: "string", format: "email", default: "δοκιμή@example.com", required: true},
  ]}, {})).toMatchObject({valid: true, answer: {pattern: "ba", integer: 1, email: "δοκιμή@example.com"}})
})

test("external links permit only absolute HTTP(S) navigation", () => {
  expect(safeFormLink("https://example.invalid/confirm")).toBe("https://example.invalid/confirm")
  for (const value of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/a", "/relative", "not a URL"]) expect(safeFormLink(value)).toBeUndefined()
})
