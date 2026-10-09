import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

export type ModelDefinition = {
  id: string
  provider: string
  language: string
  task: "transcribe"
  architecture?: string
}
const MODELS = new Map<string, ModelDefinition>()
const PROVIDERS = new Map<string, (config: TranscriptionConfig) => TranscriptionProvider>()

const MAX_REQUEST_BYTES = 12 * 1024 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_CACHE_DIR = process.env.HF_HUB_CACHE ?? path.join(homedir(), ".cache", "huggingface", "hub")
const WORKER_PATH = fileURLToPath(new URL("../../python/worker.py", import.meta.url))
const workerResponseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  results: z.array(z.object({ startMs: z.number(), endMs: z.number(), text: z.string() })).optional(),
  metrics: z
    .object({
      initializationMs: z.number().optional(),
      inferenceMs: z.number().optional(),
      realTimeFactor: z.number().optional(),
      peakMemoryMb: z.number().optional(),
      device: z.string().optional(),
      warning: z.string().optional(),
    })
    .optional(),
  healthy: z.boolean().optional(),
  inventory: z
    .array(
      z.object({
        id: z.string(),
        installed: z.boolean(),
        architecture: z.string().optional(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
})

export const transcriptionConfigSchema = z
  .object({
    provider: z.string().min(1).default("huggingface"),
    model: z.string().min(1).default("biodatlab/whisper-th-large-v3-combined"),
    language: z.string().min(2).default("th"),
    task: z.literal("transcribe").default("transcribe"),
    device: z.enum(["auto", "cpu", "cuda", "mps"]).default("auto"),
    cacheDir: z.string().min(1).default(DEFAULT_CACHE_DIR),
    pythonExecutable: z.string().min(1).default("python3"),
    chunkSeconds: z.number().int().min(1).max(30).default(15),
    overlapSeconds: z.number().int().min(0).max(10).default(2),
    requestTimeoutMs: z
      .number()
      .int()
      .min(1)
      .max(20 * 60 * 1000)
      .default(10 * 60 * 1000),
  })
  .superRefine((config, context) => {
    if (config.overlapSeconds >= config.chunkSeconds) {
      context.addIssue({
        code: "custom",
        path: ["overlapSeconds"],
        message: "Overlap must be shorter than the chunk duration",
      })
    }
  })

export type TranscriptionConfig = z.infer<typeof transcriptionConfigSchema>

export const defaultTranscriptionConfig: TranscriptionConfig = transcriptionConfigSchema.parse({})

export type AudioChunk = {
  id: string
  source: "remote" | "microphone"
  startMs: number
  sampleRate: number
  samples: Float32Array
}

export type TranscriptResult = { startMs: number; endMs: number; text: string }[]

export type TranscriptionMetrics = {
  initializationMs?: number
  inferenceMs?: number
  realTimeFactor?: number
  peakMemoryMb?: number
  device?: string
  warning?: string
}

export type TranscriptionHealth = { healthy: boolean; initialized: boolean; metrics?: TranscriptionMetrics }

export type TranscriptionProvider = {
  id: string
  initialize(config: TranscriptionConfig): Promise<void>
  transcribe(chunk: AudioChunk, context: { hints: readonly string[]; signal?: AbortSignal }): Promise<TranscriptResult>
  healthCheck(): Promise<TranscriptionHealth>
  dispose(): Promise<void>
}

export type ModelCompatibility = { supported: boolean; provider: string; reason?: string }

registerModel({
  id: "biodatlab/whisper-th-large-v3-combined",
  provider: "huggingface",
  language: "th",
  task: "transcribe",
  architecture: "WhisperForConditionalGeneration",
})
registerModel({
  id: "openai/whisper-large-v3",
  provider: "huggingface",
  language: "*",
  task: "transcribe",
  architecture: "WhisperForConditionalGeneration",
})
registerProvider("huggingface", createHuggingFaceProvider)

export function registerModel(model: ModelDefinition): void {
  if (!model.id || model.id.length > 256) throw new Error("Model ID must contain between 1 and 256 characters")
  if (!/^[a-z][a-z0-9-]*$/.test(model.provider) || model.task !== "transcribe")
    throw new Error("Invalid transcription model registration")
  if (
    model.provider === "huggingface" &&
    (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model.id) ||
      model.architecture !== "WhisperForConditionalGeneration")
  ) {
    throw new Error("Hugging Face transcription models must declare a WhisperForConditionalGeneration architecture")
  }
  if (model.architecture && model.architecture.length > 256) throw new Error("Model architecture metadata is too long")
  MODELS.set(model.id, { ...model })
}

export function registerProvider(id: string, factory: (config: TranscriptionConfig) => TranscriptionProvider): void {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("Invalid transcription provider ID")
  PROVIDERS.set(id, factory)
}

function modelIDs(provider: string) {
  return [...MODELS.values()].filter((model) => model.provider === provider).map((model) => model.id)
}

export async function listModels(input: Partial<TranscriptionConfig> = {}) {
  const config = transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, ...input })
  const worker = new Worker(config)
  try {
    const response = await worker.request({
      op: "inventory",
      models: modelIDs("huggingface"),
      cacheDir: config.cacheDir,
    })
    if (!response.inventory) throw new Error("Transcription worker omitted model inventory")
    const inventory = new Map(response.inventory.map((item) => [item.id, item]))
    return [...MODELS.values()].map((model) => ({ ...model, ...(inventory.get(model.id) ?? { installed: false }) }))
  } finally {
    await worker.close()
  }
}

export function getModelCompatibility(
  config: Pick<TranscriptionConfig, "provider" | "model" | "task">,
): ModelCompatibility {
  const model = MODELS.get(config.model)
  if (!model) return { supported: false, provider: config.provider, reason: "Unsupported model" }
  if (!PROVIDERS.has(config.provider))
    return { supported: false, provider: config.provider, reason: "Unsupported provider" }
  if (model.provider !== config.provider)
    return { supported: false, provider: config.provider, reason: "Model is registered to a different provider" }
  if (model.task !== config.task)
    return { supported: false, provider: config.provider, reason: "Unsupported task for model" }
  return { supported: true, provider: config.provider }
}

export async function installModel(
  model: string,
  authorized: boolean,
  options: Partial<TranscriptionConfig> = {},
): Promise<void> {
  if (!authorized) throw new Error("Model installation requires explicit authorization")
  if (MODELS.get(model)?.provider !== "huggingface") throw new Error("Unsupported model")
  const config = transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, ...options, model })
  const worker = new Worker(config)
  try {
    await worker.request({
      op: "install",
      model,
      models: modelIDs("huggingface"),
      cacheDir: config.cacheDir,
      authorized: true,
    })
  } finally {
    await worker.close()
  }
}

export function createProvider(input: TranscriptionConfig): TranscriptionProvider {
  const config = transcriptionConfigSchema.parse(input)
  const compatibility = getModelCompatibility(config)
  if (!compatibility.supported) throw new Error(compatibility.reason)
  const factory = PROVIDERS.get(config.provider)
  if (!factory) throw new Error("Unsupported provider")
  return factory(config)
}

function createHuggingFaceProvider(config: TranscriptionConfig): TranscriptionProvider {
  const worker = new Worker(config)
  let initialized = false
  let disposed = false
  let metrics: TranscriptionMetrics | undefined

  return {
    id: "huggingface",
    async initialize(nextConfig) {
      if (disposed) throw new Error("Transcription provider is disposed")
      const selected = transcriptionConfigSchema.parse(nextConfig)
      if (JSON.stringify(selected) !== JSON.stringify(config))
        throw new Error("Provider configuration changes require creating a provider")
      if (initialized) return
      const response = await worker.request({ op: "initialize", ...selected, models: modelIDs("huggingface") })
      initialized = true
      metrics = response.metrics
    },
    async transcribe(chunk, context) {
      if (worker.failed) initialized = false
      if (!initialized || disposed) throw new Error("Transcription provider is not initialized")
      if (context.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError")
      if (!chunk.id || chunk.id.length > 128 || !Number.isFinite(chunk.startMs) || chunk.startMs < 0) {
        throw new Error("Invalid audio chunk metadata")
      }
      if (!Number.isInteger(chunk.sampleRate) || chunk.sampleRate < 8000 || chunk.sampleRate > 192000) {
        throw new Error("Audio sample rate must be between 8000 and 192000 Hz")
      }
      if (chunk.samples.length === 0) return []
      if (chunk.samples.length > chunk.sampleRate * config.chunkSeconds)
        throw new AudioChunkLimitError("Audio chunk exceeds the configured duration limit")
      if (chunk.samples.some((sample) => !Number.isFinite(sample))) throw new Error("Audio samples must be finite")
      if (
        context.hints.length > 64 ||
        context.hints.some((hint) => hint.length > 512) ||
        context.hints.reduce((size, hint) => size + Buffer.byteLength(hint), 0) > 8192
      ) {
        throw new Error("Transcription hints exceed the count or size limit")
      }
      const response = await worker
        .request(
          {
            op: "transcribe",
            chunk: {
              id: chunk.id,
              source: chunk.source,
              startMs: chunk.startMs,
              sampleRate: chunk.sampleRate,
              samples: Buffer.from(chunk.samples.buffer, chunk.samples.byteOffset, chunk.samples.byteLength).toString(
                "base64",
              ),
            },
            hints: context.hints,
          },
          context.signal,
        )
        .catch((error: unknown) => {
          if (worker.failed) initialized = false
          throw error
        })
      metrics = { ...metrics, ...response.metrics }
      if (!response.results) throw new Error("Transcription worker omitted transcript results")
      return response.results
    },
    async healthCheck() {
      if (worker.failed) initialized = false
      if (!initialized || disposed) return { healthy: false, initialized: false, metrics }
      const response = await worker.request({ op: "health" }).catch((error: unknown) => {
        if (worker.failed) initialized = false
        throw error
      })
      if (typeof response.healthy !== "boolean") throw new Error("Transcription worker omitted health status")
      return { healthy: response.healthy, initialized: true, metrics }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await worker.close()
      initialized = false
      metrics = undefined
    },
  }
}

export class AudioChunkLimitError extends RangeError {
  constructor(message: string) {
    super(message)
    this.name = "AudioChunkLimitError"
  }
}

type WorkerResponse = {
  id: string
  ok: boolean
  error?: string
  results?: TranscriptResult
  metrics?: TranscriptionMetrics
  healthy?: boolean
  inventory?: { id: string; installed: boolean; architecture?: string; reason?: string }[]
}

class Worker {
  private child: ChildProcessWithoutNullStreams | undefined
  private nextId = 0
  private readonly pending = new Map<
    string,
    {
      resolve: (response: WorkerResponse) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      signal?: AbortSignal
      abort?: () => void
    }
  >()
  private readonly decoder = new StringDecoder("utf8")
  private outputBuffer = ""
  private dead = false
  get failed() {
    return this.dead
  }

  constructor(private readonly config: TranscriptionConfig) {
    const child = this.ensureChild()
    child.stderr.on("data", () => undefined)
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk))
    child.on("error", () => this.failAll(new Error("Transcription worker failed to start")))
    child.on("exit", (code) => this.failAll(new Error(`Transcription worker exited (${code ?? "signal"})`)))
  }

  request(message: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerResponse> {
    if (signal?.aborted) return Promise.reject(new DOMException("Transcription cancelled", "AbortError"))
    if (this.dead) return Promise.reject(new Error("Transcription worker is unavailable"))
    const id = String(++this.nextId)
    const line = JSON.stringify({ ...message, id }) + "\n"
    if (Buffer.byteLength(line) > MAX_REQUEST_BYTES)
      return Promise.reject(new Error("Transcription request exceeds the protocol limit"))
    if (this.child?.killed) return Promise.reject(new Error("Transcription worker is closed"))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failAll(new Error("Transcription worker request timed out"))
        this.child?.kill("SIGKILL")
      }, this.config.requestTimeoutMs)
      const abort = signal
        ? () => {
            this.failAll(new DOMException("Transcription cancelled", "AbortError"))
            this.child?.kill("SIGTERM")
          }
        : undefined
      if (abort) signal!.addEventListener("abort", abort, { once: true })
      this.pending.set(id, { resolve, reject, timer, signal, abort })
      this.child!.stdin.write(line, (error) => {
        if (!error) return
        this.failAll(new Error("Could not write to transcription worker"))
        this.child?.kill("SIGTERM")
      })
    })
  }

  async close() {
    this.failAll(new Error("Transcription worker closed"))
    const child = this.child
    child?.stdin.end()
    child?.kill("SIGTERM")
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      child.once("exit", resolve)
      child.once("close", resolve)
      child.once("error", resolve)
    })
  }

  private ensureChild() {
    if (this.child) return this.child
    this.child = spawn(this.config.pythonExecutable, [WORKER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_CACHE: this.config.cacheDir },
    })
    return this.child
  }

  private receive(line: string) {
    let response: WorkerResponse
    try {
      response = workerResponseSchema.parse(JSON.parse(line))
    } catch {
      this.failAll(new Error("Transcription worker returned invalid JSON"))
      this.child?.kill("SIGKILL")
      return
    }
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.settle(response.id)
    if (!response.ok) pending.reject(new Error(response.error ?? "Transcription worker failed"))
    else pending.resolve(response)
  }

  private read(chunk: Buffer) {
    this.outputBuffer += this.decoder.write(chunk)
    while (true) {
      const newline = this.outputBuffer.indexOf("\n")
      if (newline < 0) break
      const line = this.outputBuffer.slice(0, newline)
      this.outputBuffer = this.outputBuffer.slice(newline + 1)
      if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) {
        this.failAll(new Error("Transcription worker response exceeds the protocol limit"))
        this.child?.kill("SIGKILL")
        return
      }
      this.receive(line)
    }
    if (Buffer.byteLength(this.outputBuffer) > MAX_RESPONSE_BYTES) {
      this.failAll(new Error("Transcription worker response exceeds the protocol limit"))
      this.child?.kill("SIGKILL")
    }
  }

  private settle(id: string) {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort)
    this.pending.delete(id)
  }

  private failAll(error: Error) {
    this.dead = true
    for (const [id, pending] of this.pending) {
      this.settle(id)
      pending.reject(error)
    }
  }
}
