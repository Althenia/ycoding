import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { startBridge } from "../src/bridge"
import { sendControl } from "../src/bridge-client"
import { meetingConfigSchema } from "../src/config"
import type { MeetingMemoryAdapter, MeetingMemoryDocument } from "../src/intelligence"
import { createMeetingQuestions, createOwnerSettings } from "../src/plugin"
import { MeetingRuntime } from "../src/runtime"
import { MeetingStore } from "../src/store"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

const revisionOf = (content: string) => createHash("sha256").update(content).digest("hex")

class MemoryFake implements MeetingMemoryAdapter {
  docs = new Map<string, MeetingMemoryDocument>()
  async search(input: { scope?: "repository" | "knowledge"; query: string; limit?: number }) {
    return [...this.docs.values()].filter((doc) => doc.scope === (input.scope ?? "repository")).slice(0, input.limit ?? 3)
  }
  async read(input: { scope?: "repository" | "knowledge"; id: string }) {
    return this.docs.get(`${input.scope ?? "repository"}:${input.id}`)
  }
  async apply(input: {
    scope: "repository" | "knowledge"
    id: string
    operation: "create" | "replace"
    content: string
    expectedRevision: string
  }) {
    const key = `${input.scope}:${input.id}`
    const existing = this.docs.get(key)
    if (input.operation === "create" && existing) return { status: "stale" as const, error: "exists" }
    if (input.operation === "replace" && (!existing || existing.revision !== input.expectedRevision))
      return { status: "stale" as const, error: "stale" }
    const doc = { scope: input.scope, id: input.id, revision: revisionOf(input.content), content: input.content }
    this.docs.set(key, doc)
    return { status: "applied" as const, revision: doc.revision, content: doc.content }
  }
}

const suggested =
  "---\ntype: reference\ntitle: Design Sync\ntags: [meeting]\n---\n# Design Sync\n\nChat and speech agreed.\n"

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "google-meet-assistant-"))
  const store = new MeetingStore(path.join(directory, "meetings.sqlite"))
  const memory = new MemoryFake()
  const prompts: string[] = []
  const runtime = new MeetingRuntime({
    directory,
    store,
    config: meetingConfigSchema.parse({ analysis: { incremental: true }, transcription: { chunkSeconds: 1, overlapSeconds: 0 } }),
    createSession: async () => "analysis-session",
    generate: async (_sessionID, prompt) => {
      prompts.push(prompt)
      if (prompt.startsWith("Summarize this meeting"))
        return JSON.stringify({
          suggestedContent: suggested,
          explanation: "From meeting evidence",
          sourceSegmentIds: store.segments(store.listMeetings()[0]!.id).map((segment) => segment.id),
          confidence: 0.9,
        })
      if (prompt.startsWith("Analyze meeting evidence"))
        return JSON.stringify({ summary: "Summary", findings: [], proposals: [] })
      return "Catch-up answer based on evidence"
    },
    mcp: {
      tools: async () => [],
      callTool: async () => {
        throw new Error("unused")
      },
    },
    providerFactory: (config) => ({
      id: config.provider,
      initialize: async () => undefined,
      healthCheck: async () => ({ healthy: true, initialized: true, metrics: { device: "test" } }),
      dispose: async () => undefined,
      transcribe: async () => [],
    }),
    memory,
  })
  const questions = createMeetingQuestions(runtime, {
    retriever: {
      retrieve: async () => ({
        skills: [{ id: "skill-1", name: "Skill One", excerpt: "Skill excerpt" }],
        documents: [],
        knowledge: [],
        sources: [{ kind: "skill", id: "skill-1", label: "Skill One" }],
      }),
    },
  })
  const ownerSettings = createOwnerSettings(runtime, async () => [{ providerID: "p", id: "m1", variants: [] }], {
    listOpenAIKeyProfiles: async () => ["work"],
  })
  return { directory, store, runtime, questions, ownerSettings, memory, prompts }
}

async function bridgeFor(f: ReturnType<typeof fixture>) {
  const bridge = await startBridge({
    controlToken: "google-meet-assistant-test-controller-credential",
    onControl: (input) => f.runtime.control(input),
    onCapture: (input) => f.runtime.capture(input),
    onView: () => f.questions.state(),
    onAsk: (question, askOptions) => f.questions.ask(question, askOptions),
    onViewMeet: (meet) => f.runtime.setMeet(meet),
    onViewChatNote: (note) => f.runtime.addChatNote(note),
    onOwnerRead: () => f.ownerSettings.read(),
    onOwnerUpdate: (input) => f.ownerSettings.update(input),
  })
  cleanups.push(async () => {
    await bridge.close()
    await f.runtime.close()
    rmSync(f.directory, { recursive: true, force: true })
  })
  const view = await sendControl(bridge.url, "google-meet-assistant-test-controller-credential", { action: "view" })
  const ownerView = await sendControl(bridge.url, "google-meet-assistant-test-controller-credential", {
    action: "owner-view",
  })
  const urlOf = (value: unknown) => {
    if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string")
      throw new Error("Missing bridge URL")
    return new URL(value.url)
  }
  const key = new URLSearchParams(urlOf(view).hash.slice(1)).get("key")!
  const ownerKey = new URLSearchParams(urlOf(ownerView).hash.slice(1)).get("owner")!
  const post = (route: string, body: unknown, token = key) =>
    fetch(`${bridge.url}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: bridge.url },
      body: JSON.stringify(body),
    })
  return { bridge, key, ownerKey, post }
}

describe("Google Meet assistant integration", () => {
  test("start with a bare Meet domain, chat notes, catch-up, summarize, owner settings and stop", async () => {
    const f = fixture()
    const { bridge, post, ownerKey } = await bridgeFor(f)
    const started = await f.runtime.control({ action: "start", meet: "meet.google.com/abc-defg-hij" })
    expect(started.meeting?.title).toBe("Google Meet (abc-defg-hij)")
    expect(started.meeting?.meet).toEqual({ code: "abc-defg-hij", url: "https://meet.google.com/abc-defg-hij" })
    await expect(f.runtime.control({ action: "set-meet", meet: "https://example.com/abc-defg-hij" })).rejects.toThrow(
      "Invalid Google Meet code or URL",
    )
    expect((await post("/view/meet", { meet: "not-a-meet" })).status).toBe(400)
    expect((await post("/view/meet", { meet: "xyz-abcd-xyz" })).status).toBe(200)
    expect(f.store.getMeeting(started.meeting!.id)?.meet?.code).toBe("xyz-abcd-xyz")

    const noted = await post("/view/chat-note", { sender: "Alice", text: "  Chat decision noted  ", consent: true })
    expect(noted.status).toBe(200)
    const chat = f.store.segments(started.meeting!.id).find((segment) => segment.source === "chat")
    expect(chat).toMatchObject({ speakerID: "chat:Alice", text: "Chat decision noted", state: "final", model: "google-meet-chat" })
    expect((await post("/view/chat-note", { text: "missing consent" })).status).toBe(400)

    await f.runtime.settled()
    const caught = await post("/view/ask", { mode: "catchup" })
    expect(caught.status).toBe(200)
    const entry = f.questions.state().ask.history.at(-1)
    expect(entry?.mode).toBe("catchup")
    expect(entry?.status).toBe("answered")
    expect(entry?.sources).toContainEqual({ kind: "skill", id: "skill-1", label: "Skill One" })
    expect(entry?.sources?.some((source) => source.kind === "chat")).toBe(true)
    expect(f.prompts.at(-1)).toContain("Catch-Up")
    expect(f.prompts.at(-1)).toContain("Skill excerpt")

    const summarized = await f.runtime.control({ action: "knowledge-summarize" })
    expect(summarized.proposals.at(-1)).toMatchObject({
      operation: "create",
      server: "ycoding.memory",
      target: "meetings/xyz-abcd-xyz",
      status: "pending",
      expectedRevision: "new",
    })

    const ownerRead = await (
      await fetch(`${bridge.url}/view/owner/settings`, {
        headers: { authorization: `Bearer ${ownerKey}`, origin: bridge.url },
      })
    ).json()
    expect(ownerRead).toMatchObject({
      knowledge: { memoryEnabled: true },
      transcription: { provider: "huggingface", openaiKeyProfiles: ["work"] },
    })
    const updated = await post(
      "/view/owner/settings",
      {
        knowledge: { mcpEnabled: true, memoryEnabled: false, bindings: [] },
        transcription: { provider: "openai", model: "gpt-transcribe", openaiProfile: "work" },
      },
      ownerKey,
    )
    expect(updated.status).toBe(200)
    expect(f.runtime.config.knowledge.memoryEnabled).toBe(false)
    expect(f.runtime.intelligence.options.memoryEnabled).toBe(false)
    expect(f.runtime.config.transcription).toMatchObject({ provider: "openai", model: "gpt-transcribe", openaiProfile: "work" })
    expect(
      (await post("/view/owner/settings", { knowledge: { mcpEnabled: true, autoApply: true, bindings: [] } }, ownerKey)).status,
    ).toBe(400)

    await f.runtime.control({ action: "stop" })
    await f.runtime.settled()
    expect((await post("/view/chat-note", { text: "too late", consent: true })).status).toBe(409)
  })

  test("bridge ask preserves one-argument calls when mode is omitted", async () => {
    const calls: unknown[][] = []
    const bridge = await startBridge({
      controlToken: "google-meet-assistant-test-controller-credential",
      onControl: async () => null,
      onCapture: async () => null,
      onAsk: async (...args: unknown[]) => {
        calls.push(args)
        return { status: "answered", answer: "ok" }
      },
    })
    cleanups.push(async () => {
      await bridge.close()
    })
    const view = await sendControl(bridge.url, "google-meet-assistant-test-controller-credential", { action: "view" })
    if (typeof view !== "object" || view === null || !("url" in view) || typeof view.url !== "string")
      throw new Error("Missing view URL")
    const key = new URLSearchParams(new URL(view.url).hash.slice(1)).get("key")!
    const post = (body: unknown) =>
      fetch(`${bridge.url}/view/ask`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", origin: bridge.url },
        body: JSON.stringify(body),
      })
    expect((await post({ question: " What changed? " })).status).toBe(200)
    expect(calls.at(-1)).toEqual(["What changed?"])
    expect((await post({ question: "What changed?", mode: "ask" })).status).toBe(200)
    expect(calls.at(-1)).toEqual(["What changed?", { mode: "ask" }])
    expect((await post({ mode: "catchup" })).status).toBe(200)
    expect(calls.at(-1)?.[1]).toEqual({ mode: "catchup" })
    expect((await post({ question: "x", mode: "bogus" })).status).toBe(400)
  })
})
