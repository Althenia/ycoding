import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MeetingIntelligence } from "../src/intelligence"
import type { MeetingMemoryAdapter, MeetingMemoryDocument } from "../src/intelligence"
import { MeetingStore } from "../src/store"
import type { TranscriptSegment } from "../src/types"

const resources: { directory: string; stores: MeetingStore[] }[] = []
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.stores.forEach((store) => store.close())
    rmSync(resource.directory, { recursive: true, force: true })
  }
})

const revisionOf = (content: string) => createHash("sha256").update(content).digest("hex")

class MemoryFake implements MeetingMemoryAdapter {
  docs = new Map<string, MeetingMemoryDocument>()
  writes: Array<{ id: string; operation: string; content: string }> = []
  key(scope: string, id: string) {
    return `${scope}:${id}`
  }
  seed(scope: "repository" | "knowledge", id: string, content: string) {
    const doc: MeetingMemoryDocument = { scope, id, revision: revisionOf(content), content }
    this.docs.set(this.key(scope, id), doc)
    return doc
  }
  async search(input: { scope?: "repository" | "knowledge"; query: string; limit?: number }) {
    const scope = input.scope ?? "repository"
    return [...this.docs.values()].filter((doc) => doc.scope === scope).slice(0, input.limit ?? 3)
  }
  async read(input: { scope?: "repository" | "knowledge"; id: string }) {
    return this.docs.get(this.key(input.scope ?? "repository", input.id))
  }
  async apply(input: {
    scope: "repository" | "knowledge"
    id: string
    operation: "create" | "replace"
    content: string
    expectedRevision: string
  }) {
    const existing = this.docs.get(this.key(input.scope, input.id))
    if (input.operation === "create" && existing) return { status: "stale" as const, error: "already exists" }
    if (input.operation === "replace" && (!existing || existing.revision !== input.expectedRevision))
      return { status: "stale" as const, error: "revision mismatch" }
    const doc: MeetingMemoryDocument = {
      scope: input.scope,
      id: input.id,
      revision: revisionOf(input.content),
      content: input.content,
    }
    this.docs.set(this.key(input.scope, input.id), doc)
    this.writes.push({ id: input.id, operation: input.operation, content: input.content })
    return { status: "applied" as const, revision: doc.revision, content: doc.content }
  }
}

const validContent =
  "---\ntype: reference\ntitle: Design Sync\ntags: [meeting, design]\n---\n# Design Sync\n\nWe agreed to use SQLite and noted the chat link.\n"

function segment(id: string, sequence: number, source: TranscriptSegment["source"], text: string): TranscriptSegment {
  return {
    id,
    meetingID: "meeting",
    sequence,
    source,
    speakerID: source === "chat" ? "chat" : `${source}-unknown`,
    startMs: sequence * 1000,
    endMs: sequence * 1000 + 900,
    rawText: text,
    text,
    state: "final",
    model: "test-model",
    createdAt: new Date().toISOString(),
  }
}

function fixture(generate: ConstructorParameters<typeof MeetingIntelligence>[0]["generate"], memory?: MemoryFake) {
  const directory = mkdtempSync(path.join(tmpdir(), "meeting-knowledge-"))
  const store = new MeetingStore(path.join(directory, "meetings.sqlite"))
  resources.push({ directory, stores: [store] })
  store.createMeeting({
    id: "meeting",
    title: "Design Sync",
    sessionID: "session",
    meet: { code: "abc-defg-hij", url: "https://meet.google.com/abc-defg-hij" },
  })
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
    memory,
    memoryEnabled: true,
    memoryScope: "repository",
  })
  return { store, intelligence }
}

function seedSegments(store: MeetingStore) {
  store.putSegment(segment("seg-remote", 1, "remote", "We agreed to use SQLite for storage"))
  store.putSegment(segment("seg-mic", 2, "microphone", "I will verify the local setup"))
  store.putSegment(segment("seg-chat", 3, "chat", "Chat note: design doc link shared"))
}

describe("knowledge summarize and memory review", () => {
  test("store persists meet association and chat segments alongside audio sources", () => {
    const { store } = fixture(async () => "{}", new MemoryFake())
    seedSegments(store)
    expect(store.getMeeting("meeting")?.meet).toEqual({
      code: "abc-defg-hij",
      url: "https://meet.google.com/abc-defg-hij",
    })
    expect(store.segments("meeting").map((item) => item.source)).toEqual(["remote", "microphone", "chat"])
    store.updateMeeting("meeting", { meet: { code: "abc-defg-hij", url: "https://meet.google.com/abc-defg-hij" } })
    expect(store.getMeeting("meeting")?.meet?.code).toBe("abc-defg-hij")
  })

  test("extract retrieves from memory and cites both spoken and chat segments", async () => {
    const memory = new MemoryFake()
    memory.seed("repository", "meetings/existing", "---\ntype: reference\ntitle: Existing\n---\nPrior context\n")
    const { store, intelligence } = fixture(async () => {
      return JSON.stringify({
        summary: "Discussed storage and chat note",
        findings: [
          {
            kind: "decision",
            summary: "Use SQLite and keep chat note",
            sourceSegmentIds: ["seg-remote", "seg-chat"],
            confidence: 0.9,
          },
        ],
        proposals: [],
      })
    }, memory)
    seedSegments(store)
    await intelligence.extract("meeting", false)
    expect(store.references("meeting").some((ref) => ref.server === "ycoding.memory")).toBe(true)
    const finding = store.findings("meeting")[0]
    expect(finding?.sourceSegmentIds).toEqual(["seg-remote", "seg-chat"])
  })

  test("summarizeKnowledge creates a pending create proposal when concept does not exist", async () => {
    const memory = new MemoryFake()
    const { store, intelligence } = fixture(async () =>
      JSON.stringify({
        suggestedContent: validContent,
        explanation: "Summarized meeting",
        sourceSegmentIds: ["seg-remote", "seg-chat"],
        confidence: 0.9,
      }),
    memory)
    seedSegments(store)
    const proposal = await intelligence.summarizeKnowledge("meeting")
    expect(proposal.status).toBe("pending")
    expect(proposal.operation).toBe("create")
    expect(proposal.expectedRevision).toBe("new")
    expect(proposal.server).toBe("ycoding.memory")
    expect(proposal.target).toBe("meetings/abc-defg-hij")
    expect(store.proposals("meeting")).toHaveLength(1)
  })

  test("summarizeKnowledge creates a replace proposal when concept exists", async () => {
    const memory = new MemoryFake()
    const existingContent = "---\ntype: reference\ntitle: Old\ntags: [meeting]\n---\nOld body\n"
    const existing = memory.seed("repository", "meetings/abc-defg-hij", existingContent)
    const { intelligence } = fixture(async () =>
      JSON.stringify({
        suggestedContent: validContent,
        explanation: "Updated",
        sourceSegmentIds: ["seg-remote"],
        confidence: 0.8,
      }),
    memory)
    seedSegments(intelligence.options.store)
    const proposal = await intelligence.summarizeKnowledge("meeting")
    expect(proposal.operation).toBe("replace")
    expect(proposal.expectedRevision).toBe(existing.revision)
    expect(proposal.expectedRevision).toMatch(/^[a-f0-9]{64}$/)
    expect(proposal.existingContent).toBe(existingContent)
    expect(proposal.references).toHaveLength(1)
  })

  test("summarizeKnowledge rejects invalid frontmatter and unevidenced segment IDs", async () => {
    const badYaml = fixture(async () =>
      JSON.stringify({
        suggestedContent: "# No frontmatter\nBody",
        explanation: "bad",
        sourceSegmentIds: ["seg-remote"],
        confidence: 0.5,
      }),
    new MemoryFake())
    seedSegments(badYaml.store)
    await expect(badYaml.intelligence.summarizeKnowledge("meeting")).rejects.toThrow()

    const badEvidence = fixture(async () =>
      JSON.stringify({
        suggestedContent: validContent,
        explanation: "bad evidence",
        sourceSegmentIds: ["invented"],
        confidence: 0.5,
      }),
    new MemoryFake())
    seedSegments(badEvidence.store)
    await expect(badEvidence.intelligence.summarizeKnowledge("meeting")).rejects.toThrow()
  })

  test("review applies create and replace, marks concurrent change stale without writing, and records rejection", async () => {
    const memory = new MemoryFake()
    let version = 0
    const generate = async () => {
      version++
      return JSON.stringify({
        suggestedContent: validContent.replace("# Design Sync", `# Design Sync v${version}`),
        explanation: "Summarized",
        sourceSegmentIds: ["seg-remote", "seg-chat"],
        confidence: 0.9,
      })
    }
    const { store, intelligence } = fixture(generate, memory)
    seedSegments(store)
    const created = await intelligence.summarizeKnowledge("meeting")
    await intelligence.review("meeting", created.id, true)
    expect(store.proposals("meeting").find((item) => item.id === created.id)?.status).toBe("applied")
    expect(memory.docs.get("repository:meetings/abc-defg-hij")?.content).toContain("Design Sync v1")
    expect(memory.writes).toHaveLength(1)

    const replacement = await intelligence.summarizeKnowledge("meeting")
    expect(replacement.operation).toBe("replace")
    await intelligence.review("meeting", replacement.id, true)
    expect(store.proposals("meeting").find((item) => item.id === replacement.id)?.status).toBe("applied")

    const staleProposal = await intelligence.summarizeKnowledge("meeting")
    memory.seed("repository", "meetings/abc-defg-hij", "---\ntype: reference\ntitle: Concurrent\n---\nChanged elsewhere\n")
    const writesBefore = memory.writes.length
    await intelligence.review("meeting", staleProposal.id, true)
    expect(store.proposals("meeting").find((item) => item.id === staleProposal.id)?.status).toBe("stale")
    expect(memory.writes.length).toBe(writesBefore)
    expect(memory.docs.get("repository:meetings/abc-defg-hij")?.content).toContain("Changed elsewhere")

    const rejected = await intelligence.summarizeKnowledge("meeting", { target: "meetings/rejected-note" })
    await intelligence.review("meeting", rejected.id, false)
    expect(store.proposals("meeting").find((item) => item.id === rejected.id)?.status).toBe("rejected")
  })
})
