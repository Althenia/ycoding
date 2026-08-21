import { describe, expect, test } from "bun:test"
import { SessionSummaryToon } from "@ycoding-ai/core/session/summary-toon"
import { encodeLines } from "@toon-format/toon"

const options: SessionSummaryToon.ParseOptions = { throughSequence: 42, maxSummaryBytes: 100000 }

const sample: SessionSummaryToon.Memory = {
  version: 2,
  through_sequence: 42,
  objective: 'Fix the "quote" bug: done, mostly',
  in_progress: ["Regression reproduced"],
  pending: ["review", "Don't stop now"],
  blocked: [],
  decision: [
    { text: "Keep snake_case", status: "accepted" },
    { text: "Drop legacy", status: "superseded" },
  ],
  skill: ["typescript-developer"],
  requirements: ["Preserve exact protected state"],
  acceptance_criteria: ["Focused tests pass"],
  current_state: "In progress\nwith a second line",
  facts: [
    { text: 'Uses TOON, with "quotes" and \\backslash', confidence: "confirmed" },
    { text: "日本語 émojis ✓ and 中文", confidence: "uncertain" },
    { text: "Third", confidence: "likely" },
  ],
  preferences: ["drafts: on", "wip"],
  constraints: ["no new deps"],
  completed: ["module", "tests"],
  unresolved: ["cache eviction"],
  important_identifiers: ["sum-1"],
  continuation: "Next: write docs. Then ship.",
}

describe("SessionSummaryToon", () => {
  test("round trips the structured V2 continuation handoff fields", () => {
    const memory = {
      version: 2,
      through_sequence: 42,
      objective: "Restore restart-stable compaction",
      in_progress: ["Project the completed compaction marker"],
      pending: ["Run the TUI regression test"],
      blocked: ["None"],
      decision: [{ text: "Keep durable source messages", status: "accepted" }],
      skill: ["typescript-developer"],
      requirements: ["Preserve durable history"],
      acceptance_criteria: ["Restart keeps compacted rows hidden"],
      current_state: "Implementation is active",
      facts: [{ text: "The TUI reloads canonical messages", confidence: "confirmed" }],
      preferences: [],
      constraints: ["V2 only"],
      completed: ["Root cause reproduced"],
      unresolved: [],
      important_identifiers: ["session.compaction.ended"],
      continuation: "Finish the projection and verify the TUI.",
    } satisfies SessionSummaryToon.Memory
    const encoded = Array.from(encodeLines({ conversation_memory: memory })).join("\n")

    expect(SessionSummaryToon.parse(encoded, options)).toEqual(memory)
  })

  test("round trips a full memory through encode and parse", () => {
    const result = SessionSummaryToon.parse(SessionSummaryToon.encode(sample), options)
    expect(result).toEqual(sample)
    expect(result).not.toBeInstanceOf(SessionSummaryToon.InvalidToonError)
  })

  test("encodes omitted advisor sections in canonical field order", () => {
    const encoded = SessionSummaryToon.encode({
      version: sample.version,
      through_sequence: sample.through_sequence,
      objective: sample.objective,
      in_progress: sample.in_progress,
      pending: sample.pending,
      blocked: sample.blocked,
      decision: sample.decision,
      current_state: sample.current_state,
      facts: sample.facts,
      preferences: sample.preferences,
      constraints: sample.constraints,
      completed: sample.completed,
      unresolved: sample.unresolved,
      important_identifiers: sample.important_identifiers,
      continuation: sample.continuation,
    })
    const parsed = SessionSummaryToon.parse(encoded, options)

    expect("_tag" in parsed).toBe(false)
    if ("_tag" in parsed) throw parsed
    expect(SessionSummaryToon.isCanonical(encoded)).toBe(true)
    expect(SessionSummaryToon.encode(parsed)).toBe(encoded)
  })

  test("requires the advisor checkpoint sections", () => {
    const input = SessionSummaryToon.encode(sample)
      .split("\n")
      .filter((line) => !line.includes("acceptance_criteria"))
      .join("\n")
    const result = SessionSummaryToon.parse(input, options)
    expect(result).toBeInstanceOf(SessionSummaryToon.MissingFieldError)
    if (result instanceof SessionSummaryToon.MissingFieldError) expect(result.fields).toContain("acceptance_criteria")
  })

  test("rejects input that is not valid TOON", () => {
    const result = SessionSummaryToon.parse('conversation_memory:\n  objective: "unterminated', options)
    expect(result).toBeInstanceOf(SessionSummaryToon.InvalidToonError)
  })

  test("rejects a root key that is not conversation_memory", () => {
    const result = SessionSummaryToon.parse("memory:\n  version: 2", options)
    expect(result).toBeInstanceOf(SessionSummaryToon.WrongRootError)
  })

  test("rejects an unsupported version", () => {
    const input = SessionSummaryToon.encode(sample).replace("version: 2", "version: 3")
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
      "  version: 2",
      "  through_sequence: 42",
      '  objective: "o"',
      "  in_progress: []",
      "  pending: []",
      "  blocked: []",
      "  decision: []",
      "  skill: []",
      "  requirements: []",
      "  acceptance_criteria: []",
      '  current_state: "s"',
      "  facts: []",
      "  preferences[2]: 1,2",
      "  constraints: []",
      "  completed: []",
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
      "  version: 2",
      "  through_sequence: 42",
      '  objective: ""',
      "  in_progress: []",
      "  pending: []",
      "  blocked: []",
      "  decision: []",
      "  skill: []",
      "  requirements: []",
      "  acceptance_criteria: []",
      '  current_state: ""',
      "  facts: []",
      "  preferences: []",
      "  constraints: []",
      "  completed: []",
      "  unresolved: []",
      "  important_identifiers: []",
      '  continuation: ""',
    ].join("\n")
    const result = SessionSummaryToon.parse(input, options)
    expect(result).toBeInstanceOf(SessionSummaryToon.EmptySummaryError)
  })

  test("accepts canonical TOON above the former byte target", () => {
    const result = SessionSummaryToon.parse(SessionSummaryToon.encode(sample), { ...options, maxSummaryBytes: 64 })
    expect(result).toEqual(sample)
  })

  test("round trips Markdown fences stored inside encoded field content", () => {
    const memory = { ...sample, current_state: "Inspect this source:\n```ts\nconst value = 1\n```" }
    const encoded = SessionSummaryToon.encode(memory)

    expect(SessionSummaryToon.parse(encoded, options)).toEqual(memory)
  })

  test("rejects a Markdown-fenced document wrapper", () => {
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
