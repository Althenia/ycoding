import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MeetingIntelligence } from "../src/intelligence"
import { MeetingStore } from "../src/store"
import type { Finding, TranscriptSegment } from "../src/types"

const resources: { directory: string; stores: MeetingStore[] }[] = []
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.stores.forEach((store) => store.close())
    rmSync(resource.directory, { recursive: true, force: true })
  }
})

function fixture(generate: ConstructorParameters<typeof MeetingIntelligence>[0]["generate"]) {
  const directory = mkdtempSync(path.join(tmpdir(), "meeting-intelligence-state-"))
  const file = path.join(directory, "meetings.sqlite")
  const store = new MeetingStore(file)
  const resource = { directory, stores: [store] }
  resources.push(resource)
  store.createMeeting({ id: "meeting", title: "Meeting", sessionID: "analysis-session" })
  const intelligence = new MeetingIntelligence({
    store,
    generate,
    mcp: {
      tools: async () => [],
      callTool: async () => {
        throw new Error("Unexpected MCP operation")
      },
    },
    bindings: [],
    maxCharacters: 32000,
    retrievalTTL: 300000,
  })
  return { file, store, resource, intelligence }
}

function segment(id: string, sequence: number, text: string): TranscriptSegment {
  return {
    id,
    meetingID: "meeting",
    sequence,
    source: "remote",
    speakerID: "remote-unknown",
    startMs: sequence * 1000,
    endMs: sequence * 1000 + 900,
    rawText: text,
    text,
    state: "final",
    model: "test-model",
    createdAt: new Date().toISOString(),
  }
}

function extraction(summary: string, findings: unknown[] = []) {
  return JSON.stringify({ summary, findings, proposals: [] })
}

describe("MeetingIntelligence real SQLite state regressions", () => {
  test.each([
    { field: "owner" as const, before: "Bob", after: "Alice" },
    { field: "deadline" as const, before: "Monday", after: "Friday" },
  ])("changed $field requires fresh human confirmation", async ({ field, before, after }) => {
    let current: Pick<Finding, "sourceSegmentIds" | "owner" | "deadline"> = {
      sourceSegmentIds: ["first"],
      [field]: before,
    }
    const { store, intelligence } = fixture(async () =>
      extraction("Delivery", [
        {
          kind: "decision",
          summary: "Delivery assignment",
          confidence: 1,
          ...current,
        },
      ]),
    )
    store.putSegment(segment("first", 1, `Delivery assignment ${before}`))
    await intelligence.analyze("meeting")
    const original = store.findings("meeting")[0]
    if (!original) throw new Error("Initial finding was not extracted")
    store.transaction(() => {
      store.putFinding({ ...original, status: "confirmed" })
      store.putApproval({
        id: "confirmation",
        meetingID: "meeting",
        targetID: original.id,
        decision: "approve",
        detail: before,
        createdAt: new Date().toISOString(),
      })
    })
    store.putSegment(segment("second", 2, `Delivery assignment ${after}`))
    current = { sourceSegmentIds: ["second"], [field]: after }
    await intelligence.analyze("meeting")
    const changed = store.findings("meeting").find((finding) => finding[field] === after)
    expect(changed).toBeDefined()
    expect(changed?.status).toBe("unconfirmed")
    expect(store.approvals("meeting")).toMatchObject([{ targetID: original.id, detail: before, decision: "approve" }])
  })

  test("a coalesced incremental request consumes evidence finalized during generation", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let first = true
    const { store, intelligence } = fixture(async () => {
      if (first) {
        first = false
        entered.resolve()
        await release.promise
        return extraction("First statement")
      }
      return extraction("First statement and second statement")
    })
    store.putSegment(segment("first", 1, "First statement"))
    const initial = intelligence.analyze("meeting")
    const pending: Promise<void>[] = [initial]
    try {
      await entered.promise
      store.putSegment(segment("second", 2, "Second statement"))
      pending.push(intelligence.analyze("meeting"))
      release.resolve()
      await Promise.all(pending)
      expect(store.checkpoints("meeting").at(-1)?.throughSequence).toBe(2)
      expect(store.checkpoints("meeting").at(-1)?.summary).toContain("second statement")
    } finally {
      release.resolve()
      await Promise.allSettled(pending)
    }
  })

  test("concurrent final requests retain one generation owner and settle all final evidence", async () => {
    const initialEntered = Promise.withResolvers<void>()
    const initialRelease = Promise.withResolvers<void>()
    const finalEntered = Promise.withResolvers<void>()
    const finalRelease = Promise.withResolvers<void>()
    let first = true
    let active = 0
    let maximum = 0
    const { store, intelligence } = fixture(async () => {
      active++
      maximum = Math.max(maximum, active)
      try {
        if (first) {
          first = false
          initialEntered.resolve()
          await initialRelease.promise
          return extraction("First statement")
        }
        finalEntered.resolve()
        await finalRelease.promise
        return extraction("Both statements")
      } finally {
        active--
      }
    })
    store.putSegment(segment("first", 1, "First statement"))
    const pending = [intelligence.analyze("meeting")]
    try {
      await initialEntered.promise
      store.putSegment(segment("second", 2, "Second statement"))
      pending.push(intelligence.analyze("meeting", true), intelligence.analyze("meeting", true))
      initialRelease.resolve()
      await finalEntered.promise
      finalRelease.resolve()
      await Promise.all(pending)
      expect(maximum).toBe(1)
      expect(store.checkpoints("meeting").at(-1)).toMatchObject({ throughSequence: 2, final: true })
    } finally {
      initialRelease.resolve()
      finalRelease.resolve()
      await Promise.allSettled(pending)
    }
  })

  test("cached canonical references persist for every requesting meeting across restart", async () => {
    const { file, store, resource, intelligence } = fixture(async () => extraction("Summary"))
    store.createMeeting({ id: "second-meeting", title: "Second meeting", sessionID: "second-session" })
    intelligence.options.bindings = [{ server: "wiki", search: "search", read: "read" }]
    intelligence.options.mcp = {
      tools: async () => [
        { server: "wiki", name: "search" },
        { server: "wiki", name: "read" },
      ],
      callTool: async (input) => ({
        isError: false,
        content: [],
        structured:
          input.name === "search"
            ? { documents: [{ id: "page" }] }
            : { id: "page", revision: "revision-1", content: "Canonical requirement" },
      }),
    }
    const first = await intelligence.retrieve("meeting", "same requirement")
    expect(await intelligence.retrieve("second-meeting", "same requirement")).toEqual(first)
    store.close()
    const reopened = new MeetingStore(file)
    resource.stores.push(reopened)
    expect(reopened.references("second-meeting")).toEqual(first)
    expect(reopened.references("meeting")).toEqual(first)
    expect(reopened.proposals("second-meeting")).toEqual([])
  })
})
