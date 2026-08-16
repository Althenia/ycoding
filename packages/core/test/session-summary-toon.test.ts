import { describe, expect, test } from "bun:test"
import { SessionSummaryToon } from "@ycoding-ai/core/session/summary-toon"

const options: SessionSummaryToon.ParseOptions = { throughSequence: 42, maxSummaryBytes: 100000 }

const sample: SessionSummaryToon.Memory = {
  version: 1,
  through_sequence: 42,
  objective: 'Fix the "quote" bug: done, mostly',
  current_state: "In progress\nwith a second line",
  facts: [
    { text: 'Uses TOON, with "quotes" and \\backslash', confidence: "confirmed" },
    { text: "日本語 émojis ✓ and 中文", confidence: "uncertain" },
    { text: "Third", confidence: "likely" },
  ],
  decisions: [
    { text: "Keep snake_case", status: "accepted" },
    { text: "Drop legacy", status: "superseded" },
  ],
  preferences: ["drafts: on", "wip"],
  constraints: ["no new deps"],
  completed: ["module", "tests"],
  pending: ["review", "Don't stop now"],
  blockers: [],
  unresolved: ["cache eviction"],
  important_identifiers: ["sum-1"],
  continuation: "Next: write docs. Then ship.",
}

describe("SessionSummaryToon", () => {
  test("round trips a full memory through encode and parse", () => {
    const result = SessionSummaryToon.parse(SessionSummaryToon.encode(sample), options)
    expect(result).toEqual(sample)
    expect(result).not.toBeInstanceOf(SessionSummaryToon.InvalidToonError)
  })

  test("rejects input that is not valid TOON", () => {
    const result = SessionSummaryToon.parse('conversation_memory:\n  objective: "unterminated', options)
    expect(result).toBeInstanceOf(SessionSummaryToon.InvalidToonError)
  })

  test("rejects a root key that is not conversation_memory", () => {
    const result = SessionSummaryToon.parse("memory:\n  version: 1", options)
    expect(result).toBeInstanceOf(SessionSummaryToon.WrongRootError)
  })

  test("rejects an unsupported version", () => {
    const input = SessionSummaryToon.encode(sample).replace("version: 1", "version: 2")
    const result = SessionSummaryToon.parse(input, options)
    expect(result).toBeInstanceOf(SessionSummaryToon.UnsupportedVersionError)
  })

  test("rejects a through_sequence that is not the expected boundary", () => {
    const result = SessionSummaryToon.parse(SessionSummaryToon.encode(sample), { ...options, throughSequence: 43 })
    expect(result).toBeInstanceOf(SessionSummaryToon.SequenceMismatchError)
  })

  test("rejects missing required scalar fields", () => {
    const input = SessionSummaryToon.encode(sample)
      .split("\n")
      .filter((line) => !line.includes("objective"))
      .join("\n")
    const result = SessionSummaryToon.parse(input, options)
    expect(result).toBeInstanceOf(SessionSummaryToon.MissingFieldError)
    if (result instanceof SessionSummaryToon.MissingFieldError) expect(result.fields).toContain("objective")
  })

  test("rejects collection fields with wrong element types", () => {
    const input = [
      "conversation_memory:",
      "  version: 1",
      "  through_sequence: 42",
      '  objective: "o"',
      '  current_state: "s"',
      "  facts: []",
      "  decisions: []",
      "  preferences[2]: 1,2",
      "  constraints: []",
      "  completed: []",
      "  pending: []",
      "  blockers: []",
      "  unresolved: []",
      "  important_identifiers: []",
      '  continuation: "c"',
    ].join("\n")
    const result = SessionSummaryToon.parse(input, options)
    expect(result).toBeInstanceOf(SessionSummaryToon.InvalidElementError)
  })

  test("rejects an empty summary with no meaningful content", () => {
    const input = [
      "conversation_memory:",
      "  version: 1",
      "  through_sequence: 42",
      '  objective: ""',
      '  current_state: ""',
      "  facts: []",
      "  decisions: []",
      "  preferences: []",
      "  constraints: []",
      "  completed: []",
      "  pending: []",
      "  blockers: []",
      "  unresolved: []",
      "  important_identifiers: []",
      '  continuation: ""',
    ].join("\n")
    const result = SessionSummaryToon.parse(input, options)
    expect(result).toBeInstanceOf(SessionSummaryToon.EmptySummaryError)
  })

  test("rejects input above maxSummaryBytes", () => {
    const result = SessionSummaryToon.parse(SessionSummaryToon.encode(sample), { ...options, maxSummaryBytes: 64 })
    expect(result).toBeInstanceOf(SessionSummaryToon.SummaryTooLargeError)
  })

  test("rejects Markdown code fences anywhere in the input", () => {
    const input = "```\n" + SessionSummaryToon.encode(sample) + "\n```"
    const result = SessionSummaryToon.parse(input, options)
    expect(result).toBeInstanceOf(SessionSummaryToon.CodeFenceError)
  })

  test("accepts decoder-valid TOON comments", () => {
    const input = "# durable checkpoint\n" + SessionSummaryToon.encode(sample)
    expect(SessionSummaryToon.parse(input, options)).toEqual(sample)
  })

  test("rejects leading prose outside the TOON document", () => {
    const input = "Here is the conversation memory:\n" + SessionSummaryToon.encode(sample)
    const result = SessionSummaryToon.parse(input, options)
    expect(result).toBeInstanceOf(SessionSummaryToon.ProseError)
  })

  test("rejects trailing prose outside the TOON document", () => {
    const input = SessionSummaryToon.encode(sample) + "\nThat's all folks"
    const result = SessionSummaryToon.parse(input, options)
    expect(result).toBeInstanceOf(SessionSummaryToon.ProseError)
  })
})
