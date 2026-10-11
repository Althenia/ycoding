import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AudioProcessor } from "../src/audio"
import { MeetingIntelligence } from "../src/intelligence"
import { MeetingStore } from "../src/store"

test("one hour of repeatable packet input stays bounded and preserves its terminal timestamp", async () => {
  const samples = new Float32Array(16000).fill(0.1)
  const windows: Array<{ start: number; end: number }> = []
  const processor = new AudioProcessor({
    chunkSeconds: 15,
    overlapSeconds: 2,
    maxBufferedSeconds: 60,
    onChunk: async (chunk) => {
      windows.push({ start: chunk.startMs, end: chunk.startMs + chunk.samples.length / 16 })
    },
    onGap: () => {
      throw new Error("Unexpected gap")
    },
  })
  for (let sequence = 0; sequence < 3600; sequence++) {
    await processor.push({
      captureID: "hour",
      source: "remote",
      sequence,
      startMs: sequence * 1000,
      sampleRate: 16000,
      samples,
    })
    expect(processor.stats().bufferedSeconds).toBeLessThanOrEqual(60)
  }
  await processor.close()
  expect(windows[0]?.start).toBe(0)
  expect(windows.at(-1)?.end).toBe(3600000)
  expect(windows.every((window, index) => index === 0 || window.start <= windows[index - 1].end)).toBe(true)
  expect(processor.stats().backlog).toBe(0)
})

test("long-meeting checkpoints consume each finalized segment once with bounded model inputs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-long-"))
  const store = new MeetingStore(path.join(directory, "meeting.sqlite"))
  store.createMeeting({ id: "long", title: "long", sessionID: "analysis" })
  for (let sequence = 1; sequence <= 120; sequence++)
    store.putSegment({
      id: `segment-${sequence}`,
      meetingID: "long",
      sequence,
      source: "remote",
      speakerID: "remote-unknown",
      startMs: sequence * 15000,
      endMs: (sequence + 1) * 15000,
      rawText: "ก".repeat(400),
      text: "ก".repeat(400),
      state: "final",
      model: "deterministic-text-fixture",
      createdAt: new Date().toISOString(),
    })
  const seen: string[] = []
  const intelligence = new MeetingIntelligence({
    store,
    bindings: [],
    maxCharacters: 8000,
    retrievalTTL: 0,
    mcp: {
      tools: async () => [],
      callTool: async () => {
        throw new Error("Unexpected retrieval")
      },
    },
    generate: async (_sessionID, prompt) => {
      expect(prompt.length).toBeLessThanOrEqual(8000)
      const data = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)) as { transcript: Array<{ id: string }> }
      seen.push(...data.transcript.map((segment) => segment.id))
      return JSON.stringify({ summary: "Rolling summary", findings: [], proposals: [] })
    },
  })
  try {
    await intelligence.analyze("long", true)
    expect(seen).toHaveLength(120)
    expect(new Set(seen).size).toBe(120)
    expect(store.checkpoints("long").at(-1)).toMatchObject({ throughSequence: 120, final: true })
    await intelligence.analyze("long", true)
    expect(seen).toHaveLength(120)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
