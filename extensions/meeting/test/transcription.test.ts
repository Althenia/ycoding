import { describe, expect, it } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  AudioChunkLimitError,
  createProvider,
  defaultTranscriptionConfig,
  getModelCompatibility,
  installModel,
  listModels,
  registerModel,
  registerProvider,
  transcriptionConfigSchema,
} from "../src/transcription"

describe("transcription configuration", () => {
  it("provides the requested Thai Whisper defaults", () => {
    expect(defaultTranscriptionConfig).toMatchObject({
      provider: "huggingface",
      model: "biodatlab/whisper-th-large-v3-combined",
      language: "th",
      task: "transcribe",
      device: "auto",
      chunkSeconds: 15,
      overlapSeconds: 2,
    })
    expect(transcriptionConfigSchema.parse(defaultTranscriptionConfig)).toEqual(defaultTranscriptionConfig)
  })

  it("accepts the supported OpenAI Whisper model without enabling downloads", async () => {
    const config = transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, model: "openai/whisper-large-v3" })
    expect(getModelCompatibility(config)).toMatchObject({ supported: true })
    await expect(listModels()).resolves.toContainEqual(expect.objectContaining({ id: "openai/whisper-large-v3" }))
  })

  it("requires explicit authorization before installing model files", async () => {
    await expect(installModel("biodatlab/whisper-th-large-v3-combined", false)).rejects.toThrow(/authorization/i)
  })

  it("validates a bounded worker request timeout", () => {
    expect(
      transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, requestTimeoutMs: 100 }).requestTimeoutMs,
    ).toBe(100)
    expect(() => transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, requestTimeoutMs: 0 })).toThrow()
  })

  it("rejects overlap equal to or greater than the chunk duration", () => {
    expect(() =>
      transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, chunkSeconds: 4, overlapSeconds: 4 }),
    ).toThrow()
    expect(() =>
      transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, chunkSeconds: 4, overlapSeconds: 5 }),
    ).toThrow()
  })

  it("registers another explicitly declared HF Whisper architecture", () => {
    registerModel({
      id: "example/whisper-th-large-v3",
      provider: "huggingface",
      language: "th",
      task: "transcribe",
      architecture: "WhisperForConditionalGeneration",
    })
    expect(
      getModelCompatibility({ ...defaultTranscriptionConfig, model: "example/whisper-th-large-v3" }),
    ).toMatchObject({ supported: true })
  })

  it("selects a replacement provider through the registry", async () => {
    const replacement = {
      id: "replacement",
      async initialize() {},
      async transcribe() {
        return []
      },
      async healthCheck() {
        return { healthy: true, initialized: true }
      },
      async dispose() {},
    }
    registerProvider("replacement", () => replacement)
    registerModel({ id: "speech-v1", provider: "replacement", language: "th", task: "transcribe" })
    const config = transcriptionConfigSchema.parse({
      ...defaultTranscriptionConfig,
      provider: "replacement",
      model: "speech-v1",
    })
    expect(createProvider(config)).toBe(replacement)
  })

  it("reports local model availability from the selected cache", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-cache-"))
    try {
      const models = await listModels({ ...defaultTranscriptionConfig, cacheDir })
      expect(models.find((model) => model.id === "biodatlab/whisper-th-large-v3-combined")).toMatchObject({
        installed: false,
      })
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})

describe("Hugging Face worker lifecycle", () => {
  it("uses a bounded JSON-lines subprocess and reports a missing local model", async () => {
    const provider = createProvider({
      ...defaultTranscriptionConfig,
      cacheDir: "/tmp/ycoding-meeting-empty-model-cache",
    })
    await expect(
      provider.initialize({
        ...defaultTranscriptionConfig,
        cacheDir: "/tmp/ycoding-meeting-empty-model-cache",
      }),
    ).rejects.toThrow(/model.*not.*present.*cache/i)
    await expect(provider.healthCheck()).resolves.toMatchObject({ healthy: false })
    await provider.dispose()
    await expect(provider.healthCheck()).resolves.toMatchObject({ healthy: false })
  })

  it("times out and cleans up a worker that does not answer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-timeout-"))
    const executable = path.join(directory, "slow-worker")
    await writeFile(executable, "#!/bin/sh\nexec sleep 2\n")
    await chmod(executable, 0o700)
    const config = { ...defaultTranscriptionConfig, pythonExecutable: executable, requestTimeoutMs: 100 }
    const provider = createProvider(config)
    try {
      await expect(provider.initialize(config)).rejects.toThrow(/timed out/i)
      await expect(provider.dispose()).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("reports a worker executable crash without leaking child state", async () => {
    const config = { ...defaultTranscriptionConfig, pythonExecutable: "/missing/transcription-python" }
    const provider = createProvider(config)
    await expect(provider.initialize(config)).rejects.toThrow(/worker.*start|worker exited/i)
    await expect(provider.healthCheck()).resolves.toMatchObject({ healthy: false })
    await expect(provider.dispose()).resolves.toBeUndefined()
  })

  it("marks health unavailable after an initialized worker crashes", async () => {
    const worker = await makeProtocolWorker(true)
    const config = { ...defaultTranscriptionConfig, pythonExecutable: worker.executable }
    const provider = createProvider(config)
    try {
      await provider.initialize(config)
      await expect(
        provider.transcribe(
          {
            id: "crash",
            source: "microphone",
            startMs: 0,
            sampleRate: 16000,
            samples: new Float32Array(1600).fill(0.1),
          },
          { hints: [] },
        ),
      ).rejects.toThrow(/worker exited/i)
      await expect(provider.healthCheck()).resolves.toMatchObject({ healthy: false, initialized: false })
      await expect(provider.dispose()).resolves.toBeUndefined()
    } finally {
      await rm(worker.directory, { recursive: true, force: true })
    }
  })

  it("rejects oversized audio rather than dropping it", async () => {
    const worker = await makeProtocolWorker()
    const config = { ...defaultTranscriptionConfig, pythonExecutable: worker.executable, requestTimeoutMs: 1000 }
    const provider = createProvider(config)
    try {
      await provider.initialize(config)
      await expect(
        provider.transcribe(
          {
            id: "too-long",
            source: "microphone",
            startMs: 0,
            sampleRate: 16000,
            samples: new Float32Array(16 * 16000),
          },
          { hints: [] },
        ),
      ).rejects.toBeInstanceOf(AudioChunkLimitError)
      await expect(
        provider.transcribe(
          {
            id: "hints-too-long",
            source: "microphone",
            startMs: 0,
            sampleRate: 16000,
            samples: new Float32Array(1600).fill(0.1),
          },
          { hints: Array.from({ length: 65 }, () => "hint") },
        ),
      ).rejects.toThrow(/hint.*limit/i)
    } finally {
      await provider.dispose()
      await rm(worker.directory, { recursive: true, force: true })
    }
  })

  it("cancels an active worker request and cleans up", async () => {
    const worker = await makeProtocolWorker(false, true)
    const config = { ...defaultTranscriptionConfig, pythonExecutable: worker.executable, requestTimeoutMs: 1000 }
    const provider = createProvider(config)
    try {
      await provider.initialize(config)
      const controller = new AbortController()
      const pending = provider.transcribe(
        {
          id: "cancel",
          source: "microphone",
          startMs: 0,
          sampleRate: 16000,
          samples: new Float32Array(1600).fill(0.1),
        },
        { hints: [], signal: controller.signal },
      )
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: "AbortError" })
      await expect(provider.healthCheck()).resolves.toMatchObject({ healthy: false, initialized: false })
    } finally {
      await provider.dispose()
      await rm(worker.directory, { recursive: true, force: true })
    }
  })
})

async function makeProtocolWorker(crashOnTranscribe = false, hangOnTranscribe = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "ycoding-meeting-worker-"))
  const executable = path.join(directory, "worker")
  await writeFile(
    executable,
    `#!/usr/bin/env node
const readline = require("node:readline")
const crashOnTranscribe = ${crashOnTranscribe}
const hangOnTranscribe = ${hangOnTranscribe}
const input = readline.createInterface({ input: process.stdin })
input.on("line", (line) => {
  const request = JSON.parse(line)
  if (crashOnTranscribe && request.op === "transcribe") process.exit(2)
  if (hangOnTranscribe && request.op === "transcribe") return
  const response = request.op === "initialize" ? { metrics: { device: "cpu" } } : request.op === "health" ? { healthy: true } : request.op === "transcribe" ? { results: [] } : {}
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, ...response }) + "\\n")
})
`,
  )
  await chmod(executable, 0o700)
  return { directory, executable }
}
