import { expect, test } from "bun:test"
import { Projection } from "../src/dots/native-projection"
import type { Answers } from "../src/dots/native"

const answers = (value: Record<string, string>): Answers => Object.fromEntries(Object.entries(value).map(([key, value]) => [key, { answers: [value] }]))
const next = <A>(result: Projection.Result<A>) => {
  if (result.type !== "next") throw new Error("Expected another native input stage")
  return result.stage
}

test("single choices preserve labels, values, and explicit custom entries", () => {
  const stage = Projection.form("Choice", [{ type: "string", key: "choice", required: true, custom: true, options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Alpha" }] }])
  expect(stage.questions[0]!.options?.map((item) => item.label)).toEqual(["1. Alpha", "2. Alpha"])
  expect(stage.read(answers({ value: "2. Alpha", action: "Continue" }))).toEqual({ type: "answer", value: { choice: "b" } })
  const custom = next(stage.read(answers({ action: "Custom answer" })))
  expect(custom.questions[0]!.options).toBeNull()
  expect(custom.read(answers({ value: "Alpha (1)", action: "Continue" }))).toEqual({ type: "answer", value: { choice: "Alpha (1)" } })
})

test("multiselect requires every binary answer and enforces original bounds and uniqueness", () => {
  const stage = Projection.form("Selection", [{ type: "multiselect", key: "selection", required: true, minItems: 1, maxItems: 2, custom: true, options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] }])
  expect(() => stage.read(answers({ "option:0": "Select", action: "Continue" }))).toThrow()
  expect(() => stage.read(answers({ "option:0": "Do not select", "option:1": "Do not select", action: "Continue" }))).toThrow()
  expect(stage.read(answers({ "option:0": "Select", "option:1": "Do not select", action: "Continue" }))).toEqual({ type: "answer", value: { selection: ["a"] } })
  const custom = next(stage.read(answers({ "option:0": "Select", "option:1": "Do not select", action: "Custom answer" })))
  expect(() => custom.read(answers({ value: "a", action: "Add value" }))).toThrow()
  const added = next(custom.read(answers({ value: "custom", action: "Add value" })))
  expect(added.read(answers({ action: "Finish" }))).toEqual({ type: "answer", value: { selection: ["a", "custom"] } })
  const tooMany = next(added.read(answers({ value: "third", action: "Add value" })))
  expect(() => tooMany.read(answers({ action: "Finish" }))).toThrow()
})

test("conditional fields follow typed answers and optional skips remain absent", () => {
  const first = Projection.form("Conditional", [
    { type: "boolean", key: "enabled", required: true },
    { type: "integer", key: "count", required: true, minimum: 2, maximum: 4, when: [{ key: "enabled", op: "eq", value: true }] },
    { type: "string", key: "note", minLength: 2 },
  ])
  const number = next(first.read(answers({ value: "True", action: "Continue" })))
  for (const value of ["1", "5", "2.5", "Infinity", ""]) expect(() => number.read(answers({ value, action: "Continue" }))).toThrow()
  const note = next(number.read(answers({ value: "3", action: "Continue" })))
  expect(() => note.read(answers({ value: "x", action: "Continue" }))).toThrow()
  expect(note.read(answers({ action: "Skip field" }))).toEqual({ type: "answer", value: { enabled: true, count: 3 } })
  expect(next(first.read(answers({ value: "False", action: "Continue" }))).questions[0]!.header).toBe("note")
})

test("external acknowledgement, string formats, and explicit cancellation stay distinct", () => {
  const external = Projection.form("External", [{ type: "external", key: "visit", url: "https://example.com" }])
  expect(external.questions[0]!.question).toContain("https://example.com")
  expect(() => external.read(answers({ action: "Skip field" }))).toThrow()
  expect(external.read(answers({ value: "Acknowledged", action: "Continue" }))).toEqual({ type: "answer", value: { visit: true } })
  const email = Projection.form("Email", [{ type: "string", key: "email", format: "email", pattern: "@example\\.com$", maxLength: 30, required: true }])
  expect(() => email.read(answers({ value: "not-an-email", action: "Continue" }))).toThrow()
  expect(() => email.read(answers({ value: "sample@other.com", action: "Continue" }))).toThrow()
  expect(email.read(answers({ action: "Cancel request" }))).toEqual({ type: "cancel" })
  expect(() => email.read({})).toThrow()
  expect(() => email.read(answers({ action: "Cancel request", unknown: "value" }))).toThrow()
})

test("question projections preserve single, multiple, custom, and skipped answers", () => {
  const first = Projection.questions([
    { header: "Single", question: "Choose one", options: [{ label: "A", description: "Alpha" }], custom: false },
    { header: "Multiple", question: "Choose several", options: [{ label: "B", description: "Beta" }, { label: "C", description: "Gamma" }], multiple: true, custom: false },
  ])
  const second = next(first.read(answers({ action: "Skip field" })))
  expect(second.read(answers({ "option:0": "Select", "option:1": "Select", action: "Continue" }))).toEqual({ type: "answer", value: [[], ["B", "C"]] })
})

test("child questions keep cancellation separate and reserve JSON for actual data", () => {
  const first = Projection.child("Explain the blocker")
  expect(first.read(answers({ action: "Cancel request" }))).toEqual({ type: "cancel" })
  const data = next(first.read(answers({ value: "Synthetic explanation", action: "Continue" })))
  expect(data.read(answers({ action: "Skip field" }))).toEqual({ type: "answer", value: { text: "Synthetic explanation" } })
  const onlyData = next(first.read(answers({ action: "Skip field" })))
  expect(onlyData.read(answers({ value: '{"answer":true}', action: "Continue" }))).toEqual({ type: "answer", value: { data: { answer: true } } })
  expect(() => onlyData.read(answers({ action: "Skip field" }))).toThrow()
  expect(() => onlyData.read(answers({ value: "not json", action: "Continue" }))).toThrow()
})

test("trimmed controller input retains unique options, empty values, and exact whitespace", () => {
  const choices = Projection.form("Collision", [{ type: "string", key: "choice", options: [{ value: "a", label: " Alpha " }, { value: "b", label: "Alpha" }, { value: "c", label: "Alpha (1)" }] }])
  const labels = choices.questions[0]!.options!.map((item) => item.label.trim())
  expect(new Set(labels).size).toBe(3)
  for (const [index, label] of labels.entries()) expect(choices.read(answers({ value: label, action: "Continue" }))).toEqual({ type: "answer", value: { choice: ["a", "b", "c"][index] } })
  const text = Projection.form("Exact string", [{ type: "string", key: "text" }])
  expect(text.read(answers({ action: "Empty value" }))).toEqual({ type: "answer", value: { text: "" } })
  expect(text.read(answers({ action: "Skip field" }))).toEqual({ type: "answer", value: {} })
  const exact = next(text.read(answers({ action: "Exact text" })))
  expect(exact.read(answers({ value: "\\scontent\\t\\n", action: "Continue" }))).toEqual({ type: "answer", value: { text: " content\t\n" } })
  expect(() => exact.read(answers({ value: " content ", action: "Continue" }))).toThrow()
  const required = Projection.form("Required", [{ type: "string", key: "text", required: true }])
  expect(() => required.read(answers({ action: "Empty value" }))).toThrow()
  const free = Projection.questions([{ header: "Free text", question: "Explain", options: [] }])
  expect(free.questions[0]!.options).toBeNull()
  expect(free.read(answers({ value: "Answer", action: "Continue" }))).toEqual({ type: "answer", value: [["Answer"]] })
})
