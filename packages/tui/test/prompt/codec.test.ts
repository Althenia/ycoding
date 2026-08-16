import { describe, expect, test } from "bun:test"
import { projectedPromptInput } from "../../src/prompt/codec"

describe("prompt codec", () => {
  test("projects durable managed attachments to opaque attachment URIs without mutation", () => {
    const digest = "a".repeat(64)
    const input = {
      text: "Review @note.ts with @scan",
      files: [
        {
          content: {
            type: "managed",
            digest,
            bytes: 42,
            path: `attachments/sha256/${digest.slice(0, 2)}/${digest}`,
          },
          mime: "text/plain",
          name: "note.ts",
          mention: { start: 7, end: 15, text: "@note.ts" },
          description: "screenshot",
        },
      ],
      agents: [{ name: "scan", mention: { start: 21, end: 26, text: "@scan" } }],
    }
    const before = structuredClone(input)

    const output = projectedPromptInput(input as never)

    expect(output).toEqual({
      text: input.text,
      files: [
        {
          uri: `ycoding-attachment://sha256/${digest}`,
          name: "note.ts",
          description: "screenshot",
          mention: { start: 7, end: 15, text: "@note.ts" },
        },
      ],
      agents: [{ name: "scan", mention: { start: 21, end: 26, text: "@scan" } }],
    })
    expect(input).toEqual(before)
    expect(output.files?.[0]?.mention).not.toBe(input.files[0].mention)
    expect(output.agents?.[0]?.mention).not.toBe(input.agents[0].mention)
  })

  test("retains empty attachment keys for editable prompt replacement", () => {
    expect(projectedPromptInput({ text: "plain" })).toEqual({
      text: "plain",
      files: undefined,
      agents: undefined,
    })
  })
})
