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

describe("session index guardrail autosurface wiring", () => {
  test("index.tsx auto-surfaces pending guardrails at composer", async () => {
    const source = await Bun.file(
      new URL("../../../src/routes/session/index.tsx", import.meta.url),
    ).text()
    expect(source).toContain("activeGuardrail")
    expect(source).toContain("guardrails().length > 0")
    expect(source).toContain("Composer paused: guardrail review")
  })
})

describe("session rows guardrail visibility wiring", () => {
  test("rows.ts mounts pending guardrails without a compaction boundary", async () => {
    const source = await Bun.file(new URL("../../../src/routes/session/rows.ts", import.meta.url)).text()
    expect(source).toContain("activityRows()")
    expect(source).not.toContain("activityBoundary !== -1")
  })
})
