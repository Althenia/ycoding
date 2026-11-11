import { z } from "zod"
import {
  AudioChunkLimitError,
  sanitizeTranscriptionError,
  transcriptionConfigSchema,
} from "./index.ts"
import type {
  AudioChunk,
  TranscriptionConfig,
  TranscriptionMetrics,
  TranscriptionProvider,
} from "./index.ts"
import { encodeWavPcm16 } from "./wav.ts"

export type OpenAICredentialResolver = (profile?: string) => Promise<{ apiKey: string; source: string }>

export type CreateProviderOptions = {
  resolveOpenAIApiKey?: OpenAICredentialResolver
  fetch?: typeof fetch
}

const transcriptSchema = z.object({ text: z.string() })
const LANGUAGE_PATTERN = /^[a-z]{2}$/i

export function defaultOpenAICredentialResolver(): OpenAICredentialResolver {
  return async (profile?: string) => {
    if (profile !== undefined) throw new Error("OpenAI credential store resolver is required when openaiProfile is set")
    const apiKey = process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) throw new Error("OpenAI API key is not available")
    return { apiKey, source: "env:OPENAI_API_KEY" }
  }
}

export function createOpenAIProvider(
  config: TranscriptionConfig,
  options?: CreateProviderOptions,
): TranscriptionProvider {
  const resolveOpenAIApiKey = options?.resolveOpenAIApiKey ?? defaultOpenAICredentialResolver()
  const fetchImpl = options?.fetch ?? fetch
  let initialized = false
  let disposed = false
  let metrics: TranscriptionMetrics | undefined

  return {
    id: "openai",
    async initialize(nextConfig) {
      if (disposed) throw new Error("Transcription provider is disposed")
      const selected = transcriptionConfigSchema.parse(nextConfig)
      if (JSON.stringify(selected) !== JSON.stringify(config)) {
        throw new Error("Provider configuration changes require creating a provider")
      }
      if (initialized) return
      const started = Date.now()
      const resolved = await resolveOpenAIApiKey(config.openaiProfile)
      if (!resolved.apiKey.trim()) throw new Error("OpenAI API key is not available")
      initialized = true
      metrics = { initializationMs: Date.now() - started, device: `remote:${resolved.source}` }
    },
    async transcribe(chunk, context) {
      if (!initialized || disposed) throw new Error("Transcription provider is not initialized")
      if (context.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError")
      assertChunk(chunk)
      if (chunk.samples.length === 0) return []
      assertChunkLimits(chunk, config, context.hints)
      const resolved = await resolveOpenAIApiKey(config.openaiProfile)
      if (!resolved.apiKey.trim()) throw new Error("OpenAI API key is not available")
      const wav = encodeWavPcm16(chunk.samples, chunk.sampleRate)
      const form = new FormData()
      form.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav")
      form.append("model", config.model)
      form.append("response_format", "json")
      if (typeof config.language === "string" && LANGUAGE_PATTERN.test(config.language)) {
        form.append("language", config.language.toLowerCase())
      }
      if (context.hints.length > 0) form.append("prompt", context.hints.join(", ").slice(0, 1024))
      const base = (config.openaiBaseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")
      const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs)
      const signal = context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal
      const started = Date.now()
      let response: Response
      try {
        response = await fetchImpl(`${base}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${resolved.apiKey}` },
          body: form,
          signal,
        })
      } catch (error) {
        if (error instanceof DOMException) throw error
        throw new Error(sanitizeTranscriptionError(error), { cause: error })
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        throw new Error(sanitizeTranscriptionError(`${response.status} ${detail}`.trim() || "OpenAI transcription failed"))
      }
      let text: string
      try {
        text = transcriptSchema.parse(await response.json()).text
      } catch {
        throw new Error(sanitizeTranscriptionError("OpenAI transcription returned invalid JSON"))
      }
      if (!text.trim()) return []
      const audioMs = (chunk.samples.length / chunk.sampleRate) * 1000
      const inferenceMs = Date.now() - started
      metrics = {
        ...metrics,
        inferenceMs,
        realTimeFactor: inferenceMs / Math.max(1, audioMs),
        device: `remote:${resolved.source}`,
      }
      return [
        {
          startMs: chunk.startMs,
          endMs: chunk.startMs + Math.max(1, Math.round(audioMs)),
          text: text.trim(),
        },
      ]
    },
    async healthCheck() {
      return { healthy: initialized && !disposed, initialized, metrics }
    },
    async dispose() {
      disposed = true
      initialized = false
    },
  }
}

function assertChunk(chunk: AudioChunk): void {
  if (!chunk.id || chunk.id.length > 128 || !Number.isFinite(chunk.startMs) || chunk.startMs < 0) {
    throw new Error("Invalid audio chunk metadata")
  }
  if (!Number.isInteger(chunk.sampleRate) || chunk.sampleRate < 8000 || chunk.sampleRate > 192000) {
    throw new Error("Audio sample rate must be between 8000 and 192000 Hz")
  }
}

function assertChunkLimits(chunk: AudioChunk, config: TranscriptionConfig, hints: readonly string[]): void {
  if (chunk.samples.length > chunk.sampleRate * config.chunkSeconds) {
    throw new AudioChunkLimitError("Audio chunk exceeds the configured duration limit")
  }
  if (chunk.samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error("Audio samples must be finite")
  }
  if (
    hints.length > 64 ||
    hints.some((hint) => hint.length > 512) ||
    hints.reduce((size, hint) => size + Buffer.byteLength(hint), 0) > 8192
  ) {
    throw new Error("Transcription hints exceed the count or size limit")
  }
}
