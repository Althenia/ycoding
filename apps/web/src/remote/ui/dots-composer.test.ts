import { describe, expect, test } from "bun:test"
import { submission } from "./composer-logic"

describe("Dots slash intent", () => {
  test("bare command requests target selection rather than a user prompt", () => {
    expect(submission("/dots", [], undefined, "steer")).toEqual({ kind: "dots", input: { text: "" } })
  })

  test("keeps text and explicitly selected files without local model controls", () => {
    const part = {
      kind: "file" as const,
      uri: "data:text/plain;base64,eA==",
      name: "chosen.txt",
      mention: { start: 12, end: 23, text: "@chosen.txt" },
    }
    expect(
      submission("/dots hello", [part], undefined, "queue", "coordinator", { providerID: "test", id: "model" }),
    ).toEqual({
      kind: "dots",
      input: {
        text: "hello",
        files: [{ uri: part.uri, name: part.name, description: undefined, mention: part.mention }],
      },
    })
  })

  test("pasted text remains the current payload", () => {
    expect(submission("/dots pasted\ntext", [], undefined, "steer")).toEqual({
      kind: "dots",
      input: { text: "pasted\ntext" },
    })
  })

  test("agent and skill mentions cannot silently become external instructions", () => {
    expect(
      submission(
        "/dots hello",
        [{ kind: "agent", name: "worker", mention: { start: 12, end: 19, text: "@worker" } }],
        undefined,
        "steer",
      ).kind,
    ).toBe("invalid")
    expect(
      submission(
        "/dots hello",
        [{ kind: "skill", id: "skill", mention: { start: 12, end: 18, text: "$skill" } }],
        undefined,
        "steer",
      ).kind,
    ).toBe("invalid")
  })

  test("does not register an at-mention alias", () => {
    expect(submission("@dots hello", [], undefined, "steer").kind).toBe("prompt")
  })
})
