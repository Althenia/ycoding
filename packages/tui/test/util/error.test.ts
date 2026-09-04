import { describe, expect, test } from "bun:test"
import { errorData, errorFormat, errorMessage } from "../../src/util/error"

describe("util.error", () => {
  test("formats native Error instances", () => {
    const err = new Error("boom")
    expect(errorMessage(err)).toBe("boom")
    expect(errorFormat(err)).toContain("boom")

    const data = errorData(err)
    expect(data.type).toBe("Error")
    expect(data.message).toBe("boom")
    expect(String(data.formatted)).toContain("boom")
  })

  test("extracts message from record-like values", () => {
    const err = { message: "bad input", code: "E_BAD" }
    expect(errorMessage(err)).toBe("bad input")

    const data = errorData(err)
    expect(data.message).toBe("bad input")
    expect(data.code).toBe("E_BAD")
  })

  test("never returns bare {} for opaque object errors", () => {
    expect(errorFormat({})).not.toBe("{}")
    expect(errorFormat({})).toContain("no message")

    class OpaqueError {}
    const opaque = new OpaqueError()
    Object.defineProperty(opaque, "secret", { value: "hidden", enumerable: false })
    expect(errorFormat(opaque)).not.toBe("{}")
    expect(errorFormat(opaque)).toContain("OpaqueError")
  })

  test("handles opaque throwables with custom toString", () => {
    const err = {
      toString() {
        return "ResolveMessage: Cannot resolve module"
      },
    }

    expect(errorMessage(err)).toBe("ResolveMessage: Cannot resolve module")

    const data = errorData(err)
    expect(data.message).toBe("ResolveMessage: Cannot resolve module")
    expect(String(data.formatted)).toContain("ResolveMessage")
  })

  test("bare-brace prompt error surfaces diagnostic, not bare brace", () => {
    expect(errorMessage("{")).not.toBe("{")
    expect(errorFormat("{")).not.toBe("{")
  })

  test("formats ModelSwitchBlockedError with token counts and no bare brace", () => {
    const blocked = {
      _tag: "ModelSwitchBlockedError",
      status: "blocked",
      currentModel: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
      targetModel: { providerID: "openai", id: "gpt-5.6-terra", variant: "low" },
      currentContextTokens: 120000,
      targetSafeInputTokens: 80000,
      requiredReductionTokens: 40000,
      maximumSafeSummaryBoundary: "msg_boundary_1",
      reason: "context-window-exceeded",
    }
    const message = errorMessage(blocked)
    expect(message).toContain("120000")
    expect(message).toContain("80000")
    expect(message).toContain("40000")
    expect(message).toContain("msg_boundary_1")
    expect(message).not.toContain("{")

    const wrapped = new Error("{", { cause: { body: blocked } })
    expect(errorMessage(wrapped)).toBe(message)
  })

  test("bare-brace wrapper does not bypass nested ConflictError message", () => {
    const failure = new Error("{", {
      cause: {
        body: {
          _tag: "ConflictError",
          message: "Prompt message ID conflicts with an existing durable record: msg_123",
          resource: "msg_123",
        },
      },
    })
    expect(errorMessage(failure)).toContain("conflicts with an existing durable")
  })
})
