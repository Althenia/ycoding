import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { MeetingRuntime } from "../src/runtime"
import { MeetingStore } from "../src/store"
import { meetingConfigSchema } from "../src/config"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-runtime-"))
  const store = new MeetingStore(path.join(directory, "test.sqlite"))
  const calls: string[] = []
  const runtime = new MeetingRuntime({
    directory,
    store,
    config: meetingConfigSchema.parse({
      analysis: { incremental: false },
      transcription: { chunkSeconds: 1, overlapSeconds: 0 },
    }),
    createSession: async () => "analysis-session",
    generate: async () => {
      calls.push("generate")
      return JSON.stringify({ summary: "summary", findings: [], proposals: [] })
    },
    mcp: {
      tools: async () => [],
      callTool: async () => {
        throw new Error("unused")
      },
    },
    providerFactory: (config) => ({
      id: config.provider,
      initialize: async () => {
        calls.push(`load:${config.model}`)
      },
      transcribe: async (chunk) => {
        calls.push("transcribe")
        return [{ startMs: chunk.startMs, endMs: chunk.startMs + 1000, text: "ต้อง rollback release นี้ก่อน" }]
      },
      healthCheck: async () => ({ healthy: true, initialized: true, metrics: { device: "test" } }),
      dispose: async () => {
        calls.push("dispose")
      },
    }),
  })
  cleanups.push(async () => {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { runtime, store, calls }
}

const packet = (sequence = 0) => {
  const samples = new Float32Array(16000).fill(0.3)
  return {
    type: "audio" as const,
    captureID: "capture-1",
    source: "remote" as const,
    sequence,
    startMs: sequence * 1000,
    sampleRate: 16000,
    pcm: Buffer.from(samples.buffer).toString("base64"),
  }
}

test("capture cannot start before arming and arming does not claim active recording", async () => {
  const { runtime } = await setup()
  await expect(
    runtime.capture({ type: "start", captureID: "capture-1", tabID: 1, microphone: false, consent: true }),
  ).rejects.toThrow("Arm")
  const view = await runtime.control({ action: "start" })
  expect(view.meeting?.status).toBe("ready")
  expect(view.segments).toEqual([])
})

test("source opt-in is enforced independently from remote capture", async () => {
  const { runtime } = await setup()
  await runtime.control({ action: "start" })
  await runtime.capture({ type: "start", captureID: "capture-1", tabID: 1, microphone: false, consent: true })
  await expect(runtime.capture({ ...packet(), source: "microphone" })).rejects.toThrow("Microphone")
})

test("arming waits for explicit capture while connected capture still expires without heartbeats", async () => {
  const { runtime } = await setup()
  await runtime.control({ action: "start" })
  await runtime.expireCapture(Date.now() + 60000)
  expect(runtime.status().meeting?.status).toBe("ready")
  await runtime.capture({ type: "start", captureID: "capture-1", tabID: 1, microphone: false, consent: true })
  await runtime.expireCapture(Date.now() + 20000)
  expect(runtime.status().meeting?.status).toBe("interrupted")
})

test("captured samples persist once and stop releases recording independently from UI", async () => {
  const { runtime, calls } = await setup()
  await runtime.control({ action: "start" })
  await runtime.capture({ type: "start", captureID: "capture-1", tabID: 1, microphone: false, consent: true })
  expect(await runtime.capture(packet())).toMatchObject({ accepted: true, duplicate: false })
  expect(await runtime.capture(packet())).toMatchObject({ accepted: true, duplicate: true })
  await runtime.control({ action: "stop" })
  expect(runtime.status().segments).toHaveLength(1)
  expect(runtime.status().segments[0]?.rawText).toContain("rollback")
  expect(calls.filter((item) => item === "transcribe")).toHaveLength(1)
  expect(await runtime.capture({ type: "heartbeat", captureID: "capture-1" })).toEqual({ stop: true })
})

test("model switch drains old audio before unloading and preserves transcript model attribution", async () => {
  const { runtime, calls } = await setup()
  await runtime.control({ action: "start" })
  await runtime.capture({ type: "start", captureID: "capture-1", tabID: 1, microphone: false, consent: true })
  await runtime.capture(packet())
  await runtime.control({ action: "model-select", model: "openai/whisper-large-v3" })
  expect(calls.indexOf("transcribe")).toBeLessThan(calls.indexOf("dispose"))
  expect(runtime.status().segments[0]?.model).toBe("biodatlab/whisper-th-large-v3-combined")
  expect(runtime.status().health.model).toBe("openai/whisper-large-v3")
})

test("windowed results remain temporary until a finalization boundary", async () => {
  const { runtime } = await setup()
  await runtime.control({ action: "start" })
  await runtime.capture({ type: "start", captureID: "capture-1", tabID: 1, microphone: false, consent: true })
  await runtime.capture(packet())
  await runtime.control({ action: "retry" })
  expect(runtime.status().segments[0]?.state).toBe("temporary")
  await runtime.control({ action: "stop" })
  expect(runtime.status().segments[0]?.state).toBe("final")
})

test("a user correction invalidates dependent confirmation while preserving raw evidence", async () => {
  const { runtime, store } = await setup()
  await runtime.control({ action: "start" })
  await runtime.capture({ type: "start", captureID: "capture-1", tabID: 1, microphone: false, consent: true })
  await runtime.capture(packet())
  await runtime.control({ action: "stop" })
  const segment = runtime.status().segments[0]
  if (!segment) throw new Error("No transcribed segment was retained")
  store.putFinding({
    id: "finding",
    meetingID: segment.meetingID,
    kind: "decision",
    summary: "Rollback",
    sourceSegmentIds: [segment.id],
    confidence: 1,
    status: "confirmed",
    createdAt: new Date().toISOString(),
  })
  await runtime.control({
    action: "correct",
    segmentID: segment.id,
    text: "อาจ rollback API",
    meetingID: segment.meetingID,
  })
  expect(runtime.status().findings[0]?.status).toBe("unconfirmed")
  expect(runtime.status().segments[0]?.rawText).toBe("ต้อง rollback release นี้ก่อน")
  expect(runtime.status().segments[0]?.text).toBe("อาจ rollback API")
  expect(runtime.config.vocabulary.hints).toContain("API")
})

test("stopping a silent meeting does not send an empty transcript for model analysis", async () => {
  const { runtime, calls } = await setup()
  await runtime.control({ action: "start" })
  await runtime.capture({ type: "start", captureID: "capture-1", tabID: 1, microphone: false, consent: true })
  await runtime.control({ action: "stop" })
  await runtime.intelligence.running.get(runtime.status().meeting!.id)
  expect(calls).not.toContain("generate")
  expect(runtime.status().findings).toEqual([])
})

test("a Bun-compiled transcription provider runs its embedded source in real Python", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "meeting-compiled-worker-"))
  const executable = path.join(directory, "python-wrapper")
  const report = path.join(directory, "spawn.json")
  const entrypoint = path.join(directory, "entry.ts")
  const binary = path.join(directory, "meeting-worker-probe")
  const cacheDir = path.join(directory, "cache")
  await Bun.write(
    executable,
    `#!/usr/bin/env python3
import json, os, sys
with open(${JSON.stringify(report)}, "w", encoding="utf-8") as output:
    json.dump({"arguments": sys.argv[1:]}, output)
os.execv(sys.executable, [sys.executable, *sys.argv[1:]])
`,
  )
  await Bun.spawn(["chmod", "700", executable]).exited
  await Bun.write(
    entrypoint,
    `import { listModels } from ${JSON.stringify(fileURLToPath(new URL("../src/transcription/index.ts", import.meta.url)))}
const models = await listModels({ cacheDir: ${JSON.stringify(cacheDir)}, pythonExecutable: ${JSON.stringify(executable)} })
if (!models.some(model => model.id === "biodatlab/whisper-th-large-v3-combined" && model.installed === false)) throw new Error("Unexpected isolated inventory")
console.log("compiled worker succeeded")
`,
  )
  try {
    const build = Bun.spawn([process.execPath, "build", "--compile", entrypoint, "--outfile", binary], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const compiled = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ])
    expect({ exitCode: compiled[0], stderr: compiled[2] }).toMatchObject({ exitCode: 0 })
    const run = Bun.spawn([binary], { cwd: directory, stdout: "pipe", stderr: "pipe" })
    const result = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    expect({ exitCode: result[0], stderr: result[2] }).toMatchObject({ exitCode: 0 })
    expect(result[1]).toContain("compiled worker succeeded")
    const recorded = z.object({ arguments: z.array(z.string()) }).parse(await Bun.file(report).json())
    expect(recorded.arguments).toEqual(["-c", await Bun.file(new URL("../python/worker.py", import.meta.url)).text()])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
