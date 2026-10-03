import { describe, expect, test } from "bun:test"
import { activeGuardrail } from "../../../src/routes/session/guardrail"

type Request = { id: string }

const first: Request = { id: "grq_first" }
const second: Request = { id: "grq_second" }

describe("activeGuardrail", () => {
  test("returns first pending request when no selection", () => {
    expect(activeGuardrail([first, second], undefined)).toEqual(first)
  })

  test("returns explicitly selected pending request when valid", () => {
    expect(activeGuardrail([first, second], "grq_second")).toEqual(second)
  })

  test("falls back to first pending when selection is stale", () => {
    expect(activeGuardrail([first, second], "grq_missing")).toEqual(first)
  })

  test("returns undefined when no requests pending", () => {
    expect(activeGuardrail([], undefined)).toBeUndefined()
    expect(activeGuardrail([], "grq_missing")).toBeUndefined()
  })
})
