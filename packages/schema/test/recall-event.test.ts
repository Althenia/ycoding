import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { DurableEventManifest } from "../src/durable-event-manifest.js"
import { EventManifest } from "../src/event-manifest.js"
import { SessionEvent } from "../src/session-event.js"
import { SessionID } from "../src/session-id.js"

const sessionID = SessionID.make("ses_recall")
const item = {
  kind: "memory",
  id: "decisions/cobalt",
  stage: "injected",
  method: "rrf",
  scores: { bm25: 1.5, semantic: 0.25, rrf: 0.03, rank: 0 },
  reason: "matched cue",
  source: { id: "memory:repository/decisions/cobalt", revision: "sha256:abc" },
  okf: { type: "Decision", trust: "trusted", freshness: "fresh", lifecycle: "active" },
  tokens: 120,
}
const recorded = {
  sessionID,
  key: "k1",
  trigger: "cue",
  cueID: "c1",
  methods: ["cue", "rrf"],
  outcome: "injected",
  items: [item],
  elapsedMs: 3,
  injectedTokens: 120,
}
const decodes = (definition: { data: Schema.Top }, input: unknown) =>
  Schema.decodeUnknownOption(definition.data as never)(input)._tag === "Some"

describe("cue and recall events", () => {
  test("are public durable Session events on the sessionID aggregate", () => {
    for (const definition of [SessionEvent.CueDetected, SessionEvent.RecallRecorded]) {
      expect(definition.durable?.aggregate).toBe("sessionID")
      expect(definition.durable?.version).toBe(1)
      expect(EventManifest.Server.get(definition.type)).toBe(definition)
      expect(DurableEventManifest.Durable.get(`${definition.type}.1`)).toBe(definition)
      expect(SessionEvent.PublicDurableDefinitions).toContain(definition)
    }
  })

  test("cue detection accepts only trusted cue kinds", () => {
    expect(decodes(SessionEvent.CueDetected, { sessionID, cueID: "c1", kind: "command", subject: "cargo check" })).toBe(true)
    expect(decodes(SessionEvent.CueDetected, { sessionID, cueID: "c1", kind: "prompt-text" })).toBe(false)
    expect(decodes(SessionEvent.CueDetected, { sessionID, cueID: "", kind: "command" })).toBe(false)
    expect(decodes(SessionEvent.CueDetected, { sessionID, cueID: "c1", kind: "path", subject: "a".repeat(513) })).toBe(false)
  })

  test("recall record separates candidate, rejected, selected, injected and restored items", () => {
    for (const stage of ["candidate", "rejected", "selected", "injected", "restored"]) {
      expect(decodes(SessionEvent.RecallRecorded, { ...recorded, items: [{ ...item, stage }] })).toBe(true)
    }
    expect(decodes(SessionEvent.RecallRecorded, { ...recorded, items: [{ ...item, stage: "approved" }] })).toBe(false)
    expect(
      decodes(SessionEvent.RecallRecorded, { ...recorded, items: [{ ...item, stage: "rejected", rejection: "stale" }] }),
    ).toBe(true)
  })

  test("recall record supports abstention and restoration with bounded fields", () => {
    expect(
      decodes(SessionEvent.RecallRecorded, {
        ...recorded,
        outcome: "abstained",
        abstention: "no_match",
        items: [],
        budgetTokens: 2048,
      }),
    ).toBe(true)
    expect(decodes(SessionEvent.RecallRecorded, { ...recorded, trigger: "compaction", outcome: "restored" })).toBe(true)
    expect(decodes(SessionEvent.RecallRecorded, { ...recorded, abstention: "because" })).toBe(false)
    expect(decodes(SessionEvent.RecallRecorded, { ...recorded, items: Array.from({ length: 65 }, () => item) })).toBe(false)
    expect(decodes(SessionEvent.RecallRecorded, { ...recorded, injectedTokens: -1 })).toBe(false)
    expect(decodes(SessionEvent.RecallRecorded, { ...recorded, items: [{ ...item, okf: { ...item.okf, trust: "admin" } }] })).toBe(false)
  })
})
