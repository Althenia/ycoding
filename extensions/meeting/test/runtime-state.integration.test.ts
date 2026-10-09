import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { meetingConfigSchema } from "../src/config"
import { MeetingRuntime } from "../src/runtime"
import { MeetingStore } from "../src/store"
import type { TranscriptSegment } from "../src/types"

type RuntimeOptions = ConstructorParameters<typeof MeetingRuntime>[0]
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fixture(overrides: Partial<Omit<RuntimeOptions, "directory" | "store">> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "meeting-runtime-state-"))
  const file = path.join(directory, "meetings.sqlite")
  const store = new MeetingStore(file)
  const runtime = new MeetingRuntime({
    directory,
    store,
    config: meetingConfigSchema.parse({
      analysis: { incremental: false },
      transcription: { chunkSeconds: 1, overlapSeconds: 0 },
    }),
    createSession: async () => "analysis-session",
    generate: async () => JSON.stringify({ summary: "Summary", findings: [], proposals: [] }),
    mcp: {
      tools: async () => [],
      callTool: async () => {
        throw new Error("Unexpected MCP operation")
      },
    },
    providerFactory: (config) => ({
      id: config.provider,
      initialize: async () => undefined,
      healthCheck: async () => ({ healthy: true, initialized: true }),
      dispose: async () => undefined,
      transcribe: async () => [],
    }),
    ...overrides,
  })
  const resource = {
    directory,
    file,
    store,
    runtime,
    automaticClose: true,
    release: [] as (() => void)[],
    pending: [] as Promise<unknown>[],
    expectedCloseError: undefined as RegExp | undefined,
  }
  cleanups.push(async () => {
    resource.release.forEach((release) => release())
    await Promise.allSettled(resource.pending)
    try {
      if (resource.automaticClose) {
        const outcome = await runtime.close().then(
          () => undefined,
          (error: unknown) => error,
        )
        if (outcome !== undefined && !(outcome instanceof Error && resource.expectedCloseError?.test(outcome.message)))
          throw outcome
      }
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  return resource
}

function segment(meetingID: string, state: TranscriptSegment["state"] = "final"): TranscriptSegment {
  return {
    id: "evidence",
    meetingID,
    sequence: 1,
    source: "remote",
    speakerID: "remote-unknown",
    startMs: 0,
    endMs: 900,
    rawText: "Approve release",
    text: "Approve release",
    state,
    model: "test-model",
    createdAt: new Date().toISOString(),
  }
}

function packet() {
  const samples = new Float32Array(16000).fill(0.2)
  return {
    type: "audio" as const,
    captureID: "capture",
    source: "remote" as const,
    sequence: 0,
    startMs: 0,
    sampleRate: 16000,
    pcm: Buffer.from(samples.buffer).toString("base64"),
  }
}

async function arm(runtime: MeetingRuntime) {
  const view = await runtime.control({ action: "start" })
  const meeting = view.meeting
  if (!meeting) throw new Error("Arming did not create a meeting")
  await runtime.capture({ type: "start", captureID: "capture", tabID: 1, microphone: false, consent: true })
  return meeting.id
}

describe("MeetingRuntime real SQLite lifecycle regressions", () => {
  test("an explicitly selected replacement model recovers retained failed audio without discarding it", async () => {
    const resource = fixture({
      providerFactory: (config) => ({
        id: config.provider,
        initialize: async () => undefined,
        dispose: async () => undefined,
        healthCheck: async () => ({ healthy: true, initialized: true }),
        transcribe: async () => {
          if (config.model === "biodatlab/whisper-th-large-v3-combined")
            throw new Error("Permanent selected-model failure")
          return [{ startMs: 0, endMs: 1000, text: "Recovered retained speech" }]
        },
      }),
    })
    resource.expectedCloseError = /Permanent selected-model failure/
    const meetingID = await arm(resource.runtime)
    await resource.runtime.capture(packet())
    await resource.runtime.settled()
    expect(resource.store.jobs(meetingID).find((job) => job.kind === "transcription")?.status).toBe("failed")
    await resource.runtime.control({ action: "model-select", model: "openai/whisper-large-v3" })
    expect(resource.store.segments(meetingID)).toMatchObject([
      { rawText: "Recovered retained speech", model: "openai/whisper-large-v3" },
    ])
    expect(resource.runtime.status(meetingID).audio.backlog).toBe(0)
  })
  test("explicit retry replaces a crashed provider before processing its retained window", async () => {
    let failed = false
    let initializations = 0
    const resource = fixture({
      providerFactory: (config) => {
        let healthy = true
        return {
          id: config.provider,
          initialize: async () => {
            initializations++
          },
          dispose: async () => {
            healthy = false
          },
          healthCheck: async () => ({ healthy, initialized: healthy }),
          transcribe: async () => {
            if (!healthy) throw new Error("Provider process is gone")
            if (!failed) {
              failed = true
              healthy = false
              throw new Error("Provider process crashed")
            }
            return [{ startMs: 0, endMs: 1000, text: "Recovered speech" }]
          },
        }
      },
    })
    const meetingID = await arm(resource.runtime)
    await resource.runtime.capture(packet())
    await resource.runtime.settled()
    expect(resource.store.jobs(meetingID).find((job) => job.kind === "transcription")?.status).toBe("failed")
    await resource.runtime.control({ action: "retry", meetingID })
    expect(initializations).toBe(2)
    expect(resource.store.segments(meetingID)).toMatchObject([{ rawText: "Recovered speech" }])
  })
  test("a plan generated from corrected evidence cannot become the current proposed plan", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const resource = fixture({
      generate: async (_, prompt) => {
        if (prompt.startsWith("Create a proposed engineering plan")) {
          entered.resolve()
          await release.promise
          return "Implement the approved release"
        }
        return JSON.stringify({ summary: "Release rejected", findings: [], proposals: [] })
      },
    })
    resource.release.push(() => release.resolve())
    resource.store.createMeeting({ id: "meeting", title: "Meeting", sessionID: "analysis-session" })
    resource.store.updateMeeting("meeting", { status: "stopped" })
    resource.store.putSegment(segment("meeting"))
    resource.store.putFinding({
      id: "decision",
      meetingID: "meeting",
      kind: "decision",
      summary: "Approve release",
      sourceSegmentIds: ["evidence"],
      confidence: 1,
      status: "confirmed",
      createdAt: new Date().toISOString(),
    })
    const planning = resource.runtime.intelligence.plan("meeting")
    const planned = planning.then(
      () => undefined,
      (error: unknown) => error,
    )
    resource.pending.push(planned)
    await entered.promise
    await resource.runtime.control({
      action: "correct",
      meetingID: "meeting",
      segmentID: "evidence",
      text: "Reject release",
    })
    await resource.runtime.intelligence.running.get("meeting")
    release.resolve()
    await planned
    expect(resource.store.findings("meeting")[0]?.status).toBe("unconfirmed")
    expect(resource.store.plan("meeting")?.status).not.toBe("proposed")
    expect(resource.store.plan("meeting")?.status).not.toBe("approved")
    expect(resource.store.approvals("meeting")).toMatchObject([{ decision: "correct", targetID: "evidence" }])
  })

  test("duplicate delivery acknowledges retained failed audio without retrying inference", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let failing = true
    const resource = fixture({
      providerFactory: (config) => ({
        id: config.provider,
        initialize: async () => undefined,
        healthCheck: async () => ({ healthy: true, initialized: true }),
        dispose: async () => undefined,
        transcribe: async () => {
          entered.resolve()
          await release.promise
          if (failing) throw new Error("Controlled inference failure")
          return []
        },
      }),
    })
    resource.release.push(() => {
      failing = false
      release.resolve()
    })
    resource.expectedCloseError = /Controlled inference failure/
    const meetingID = await arm(resource.runtime)
    expect(await resource.runtime.capture(packet())).toMatchObject({ accepted: true, duplicate: false })
    await entered.promise
    const joined = resource.runtime.control({ action: "retry", meetingID })
    resource.pending.push(
      joined.then(
        () => undefined,
        () => undefined,
      ),
    )
    await resource.runtime.control({ action: "status", meetingID })
    release.resolve()
    await expect(joined).rejects.toThrow("Controlled inference failure")
    expect(resource.store.jobs(meetingID).find((job) => job.kind === "transcription")).toMatchObject({
      status: "failed",
      attempts: 1,
    })
    expect(await resource.runtime.capture(packet())).toMatchObject({ accepted: true, duplicate: true })
    expect(resource.store.jobs(meetingID).find((job) => job.kind === "transcription")?.attempts).toBe(1)
  })

  test("shutdown joins owned analysis before closing SQLite even when audio inference fails", async () => {
    const analysisEntered = Promise.withResolvers<void>()
    const analysisRelease = Promise.withResolvers<void>()
    const inferenceEntered = Promise.withResolvers<void>()
    const inferenceRelease = Promise.withResolvers<void>()
    const shutdownInferenceEntered = Promise.withResolvers<void>()
    const shutdownInferenceRelease = Promise.withResolvers<void>()
    let attempts = 0
    let analysisResponded = false
    const resource = fixture({
      generate: async () => {
        analysisEntered.resolve()
        await analysisRelease.promise
        analysisResponded = true
        return JSON.stringify({ summary: "Retained analysis result", findings: [], proposals: [] })
      },
      providerFactory: (config) => ({
        id: config.provider,
        initialize: async () => undefined,
        healthCheck: async () => ({ healthy: true, initialized: true }),
        dispose: async () => undefined,
        transcribe: async () => {
          attempts++
          if (attempts === 1) {
            inferenceEntered.resolve()
            await inferenceRelease.promise
          }
          if (attempts === 2) {
            shutdownInferenceEntered.resolve()
            await shutdownInferenceRelease.promise
          }
          throw new Error("Controlled inference failure")
        },
      }),
    })
    resource.release.push(
      () => analysisRelease.resolve(),
      () => inferenceRelease.resolve(),
      () => shutdownInferenceRelease.resolve(),
    )
    const meetingID = await arm(resource.runtime)
    resource.store.putSegment(segment(meetingID))
    await resource.runtime.control({ action: "summary", meetingID })
    await analysisEntered.promise
    const analysis = resource.runtime.intelligence.running.get(meetingID)
    if (!analysis) throw new Error("Requested analysis did not start")
    const analysisOutcome = analysis.then(
      () => undefined,
      (error: unknown) => error,
    )
    resource.pending.push(analysisOutcome)
    await resource.runtime.capture(packet())
    await inferenceEntered.promise
    const initialJoined = resource.runtime.control({ action: "retry", meetingID })
    resource.pending.push(
      initialJoined.then(
        () => undefined,
        () => undefined,
      ),
    )
    await resource.runtime.control({ action: "status", meetingID })
    inferenceRelease.resolve()
    await expect(initialJoined).rejects.toThrow("Controlled inference failure")
    resource.automaticClose = false
    const closing = resource.runtime.close().then(
      () => ({ analysisResponded }),
      () => ({ analysisResponded }),
    )
    resource.pending.push(closing)
    await shutdownInferenceEntered.promise
    const shutdownJoined = resource.runtime.control({ action: "retry", meetingID })
    resource.pending.push(
      shutdownJoined.then(
        () => undefined,
        () => undefined,
      ),
    )
    await resource.runtime.control({ action: "status", meetingID })
    shutdownInferenceRelease.resolve()
    await expect(shutdownJoined).rejects.toThrow("Controlled inference failure")
    analysisRelease.resolve()
    const outcome = await closing
    await analysisOutcome
    expect(outcome.analysisResponded).toBe(true)
    const reopened = new MeetingStore(resource.file)
    try {
      expect(reopened.checkpoints(meetingID).at(-1)?.summary).toBe("Retained analysis result")
    } finally {
      reopened.close()
    }
  })

  test("explicit stop and reconciliation finalize durable temporary evidence after restart without resuming capture", async () => {
    const prompts: string[] = []
    const resource = fixture({
      generate: async (_, prompt) => {
        expect(prompt).toContain("Approve release")
        prompts.push(prompt)
        return JSON.stringify({ summary: "Release was discussed", findings: [], proposals: [] })
      },
    })
    resource.store.createMeeting({ id: "meeting", title: "Meeting", sessionID: "analysis-session" })
    resource.store.updateMeeting("meeting", { status: "recording", captureID: "lost-capture" })
    resource.store.putSegment(segment("meeting", "temporary"))
    resource.automaticClose = false
    resource.store.close()
    const reopened = new MeetingStore(resource.file)
    const recovered = new MeetingRuntime({ ...resource.runtime.options, store: reopened })
    try {
      expect(reopened.getMeeting("meeting")?.status).toBe("interrupted")
      expect(recovered.status("meeting").audio.sources?.remote).toBe("inactive")
      await recovered.control({ action: "stop", meetingID: "meeting" })
      await recovered.control({ action: "reconcile", meetingID: "meeting" })
      await recovered.intelligence.running.get("meeting")
      expect(prompts.some((prompt) => prompt.includes("Approve release"))).toBe(true)
      expect(reopened.segments("meeting")).toMatchObject([{ state: "final", rawText: "Approve release" }])
      expect(reopened.checkpoints("meeting").at(-1)).toMatchObject({
        throughSequence: 1,
        final: true,
        summary: "Release was discussed",
      })
      expect(recovered.status("meeting").audio.sources?.remote).toBe("inactive")
    } finally {
      await recovered.close()
      reopened.close()
    }
  })
})
