import { describe, expect, test } from "bun:test"
import { parseExtraction, assembleContext, planPrompt } from "../src/intelligence"
import type { Finding, TranscriptSegment } from "../src/types"

const segment: TranscriptSegment = {
  id: "seg-1",
  meetingID: "meeting-1",
  sequence: 1,
  source: "remote",
  speakerID: "remote-unknown",
  startMs: 0,
  endMs: 1000,
  rawText: "เราควร refactor authentication service",
  text: "เราควร refactor authentication service",
  state: "final",
  model: "biodatlab/whisper-th-large-v3-combined",
  createdAt: "2026-10-09T00:00:00.000Z",
}

const extraction = (overrides = {}) =>
  JSON.stringify({
    summary: "Discussed authentication",
    findings: [
      {
        kind: "proposal",
        summary: "Consider refactoring authentication",
        sourceSegmentIds: [segment.id],
        confidence: 0.8,
        ...overrides,
      },
    ],
    proposals: [],
  })

describe("meeting evidence boundary", () => {
  test("accepts one complete JSON fence without weakening evidence or approval validation", () => {
    expect(
      parseExtraction(`\`\`\`json\n${extraction()}\n\`\`\``, [segment], [], "meeting-1").findings[0],
    ).toMatchObject({
      kind: "proposal",
      status: "unconfirmed",
      sourceSegmentIds: [segment.id],
    })
    expect(() => parseExtraction(`prose\n\`\`\`json\n${extraction()}\n\`\`\``, [segment], [], "meeting-1")).toThrow()
    expect(() =>
      parseExtraction(`\`\`\`json\n${extraction({ status: "confirmed" })}\n\`\`\``, [segment], [], "meeting-1"),
    ).toThrow()
    expect(() =>
      parseExtraction(
        `\`\`\`json\n${extraction()}\n\`\`\`\n\`\`\`json\n${extraction()}\n\`\`\``,
        [segment],
        [],
        "meeting-1",
      ),
    ).toThrow()
  })
  test("keeps a tentative proposal unconfirmed and retains original Thai evidence", () => {
    const result = parseExtraction(extraction(), [segment], [], "meeting-1")
    expect(result.findings[0]?.kind).toBe("proposal")
    expect(result.findings[0]?.status).toBe("unconfirmed")
    expect(result.findings[0]?.sourceSegmentIds).toEqual([segment.id])
    expect(segment.rawText).toContain("เราควร")
  })
  test("rejects unknown or missing evidence and model-supplied confirmations", () => {
    expect(() => parseExtraction(extraction({ sourceSegmentIds: ["invented"] }), [segment], [], "meeting-1")).toThrow()
    expect(() => parseExtraction(extraction({ sourceSegmentIds: [] }), [segment], [], "meeting-1")).toThrow()
    expect(() => parseExtraction(extraction({ status: "confirmed" }), [segment], [], "meeting-1")).toThrow()
  })
  test("does not invent speaker identity or owner", () => {
    expect(parseExtraction(extraction(), [segment], [], "meeting-1").findings[0]?.owner).toBeUndefined()
    expect(() => parseExtraction(extraction({ speakerId: "Alice" }), [segment], [], "meeting-1")).toThrow()
    expect(() => parseExtraction(extraction({ owner: "Alice" }), [segment], [], "meeting-1")).toThrow()
  })
  test("has stable finding identity on repeated extraction", () => {
    expect(parseExtraction(extraction(), [segment], [], "meeting-1").findings[0]?.id).toBe(
      parseExtraction(extraction(), [segment], [], "meeting-1").findings[0]?.id,
    )
  })
  test("bounds context without splitting or reinterpreting transcript evidence", () => {
    const inputs = Array.from({ length: 80 }, (_, i) => ({
      ...segment,
      id: `seg-${i}`,
      sequence: i + 1,
      text: "ก".repeat(500),
    }))
    const context = assembleContext(inputs, "checkpoint", [], 4000)
    expect(context.prompt.length).toBeLessThanOrEqual(4000)
    expect(context.segments.length).toBeGreaterThan(0)
    expect(context.segments.length).toBeLessThan(80)
    expect(context.prompt).toContain("untrusted")
    expect(context.segments[0]?.id).toBe("seg-0")
  })
  test("rejects proposals without canonical read evidence", () => {
    const input = JSON.parse(extraction())
    input.proposals = [
      {
        target: "invented",
        server: "kb",
        suggestedContent: "overwrite",
        explanation: "heard",
        sourceSegmentIds: [segment.id],
        confidence: 1,
      },
    ]
    expect(() => parseExtraction(JSON.stringify(input), [segment], [], "meeting-1")).toThrow()
  })
  test("plans only confirmed decisions and states the source-code boundary", () => {
    const proposed = parseExtraction(extraction(), [segment], [], "meeting-1").findings[0]!
    expect(() => planPrompt([proposed], [], "")).toThrow("confirmed")
    const confirmed: Finding = { ...proposed, kind: "decision", status: "confirmed" }
    const prompt = planPrompt([confirmed], [], "")
    expect(prompt).toContain("acceptance criteria")
    expect(prompt).toContain("Do not modify source code")
    expect(prompt).toContain("uninspected")
  })
})
