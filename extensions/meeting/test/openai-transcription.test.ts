import { describe, expect, it } from "bun:test"
import { normalizeChatSpeaker, parseGoogleMeet } from "../src/meet.ts"
import { encodeWavPcm16 } from "../src/transcription/wav.ts"
import {
  AudioChunkLimitError,
  createProvider,
  defaultTranscriptionConfig,
  listModels,
  sanitizeTranscriptionError,
  transcriptionConfigSchema,
} from "../src/transcription/index.ts"

describe("parseGoogleMeet", () => {
  it("accepts a lowercase meeting code", () => {
    expect(parseGoogleMeet("abc-defg-hij")).toEqual({
      code: "abc-defg-hij",
      url: "https://meet.google.com/abc-defg-hij",
    })
  })

  it("normalizes uppercase codes and trims whitespace", () => {
    expect(parseGoogleMeet("  ABC-DEFG-HIJ  ")).toEqual({
      code: "abc-defg-hij",
      url: "https://meet.google.com/abc-defg-hij",
    })
  })

  it("accepts a meet URL with query params, trailing slash, or fragment", () => {
    expect(parseGoogleMeet("https://meet.google.com/abc-defg-hij?authuser=0&hs=179")).toEqual({
      code: "abc-defg-hij",
      url: "https://meet.google.com/abc-defg-hij",
    })
    expect(parseGoogleMeet("https://meet.google.com/abc-defg-hij/")).toEqual({
      code: "abc-defg-hij",
      url: "https://meet.google.com/abc-defg-hij",
    })
    expect(parseGoogleMeet("https://meet.google.com/abc-defg-hij#section")).toEqual({
      code: "abc-defg-hij",
      url: "https://meet.google.com/abc-defg-hij",
    })
  })

  it("rejects non-meet hosts, http scheme, credentials, and extra segments", () => {
    expect(parseGoogleMeet("")).toBeUndefined()
    expect(parseGoogleMeet("not-a-code")).toBeUndefined()
    expect(parseGoogleMeet("http://meet.google.com/abc-defg-hij")).toBeUndefined()
    expect(parseGoogleMeet("https://evil.example.com/abc-defg-hij")).toBeUndefined()
    expect(parseGoogleMeet("https://meet.google.com/abc-defg-hij/extra")).toBeUndefined()
    expect(parseGoogleMeet("https://meet.google.com/new")).toBeUndefined()
    expect(parseGoogleMeet("https://meet.google.com/landing")).toBeUndefined()
    expect(parseGoogleMeet("https://user:pass@meet.google.com/abc-defg-hij")).toBeUndefined()
  })
})

describe("normalizeChatSpeaker", () => {
  it("defaults to participant for missing or blank senders", () => {
    expect(normalizeChatSpeaker()).toBe("chat:participant")
    expect(normalizeChatSpeaker("")).toBe("chat:participant")
    expect(normalizeChatSpeaker("   ")).toBe("chat:participant")
  })

  it("trims and collapses whitespace", () => {
    expect(normalizeChatSpeaker("  Alice   Smith  ")).toBe("chat:Alice Smith")
  })

  it("replaces unsafe characters and caps length", () => {
    expect(normalizeChatSpeaker("a/b:c")).toBe("chat:a-b-c")
    expect(normalizeChatSpeaker("Jane.Doe_1-2")).toBe("chat:Jane.Doe_1-2")
    expect(normalizeChatSpeaker("x".repeat(100)).length).toBe("chat:".length + 48)
  })
})

describe("encodeWavPcm16", () => {
  it("writes a mono 16-bit RIFF/WAVE header with the expected byte length", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
    const wav = encodeWavPcm16(samples, 16000)
    expect(wav.length).toBe(44 + samples.length * 2)
    const text = (offset: number, length: number) => String.fromCharCode(...wav.slice(offset, offset + length))
    expect(text(0, 4)).toBe("RIFF")
    expect(text(8, 4)).toBe("WAVE")
    expect(text(12, 4)).toBe("fmt ")
    expect(text(36, 4)).toBe("data")
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
    expect(view.getInt16(44 + 3 * 2, true)).toBe(32767)
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-32768)
  })

  it("clamps out-of-range samples to 16-bit limits", () => {
    const wav = encodeWavPcm16(new Float32Array([1.5, -1.5]), 8000)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32768)
  })

  it("rejects invalid sample rates and non-finite samples", () => {
    expect(() => encodeWavPcm16(new Float32Array([0]), 7999)).toThrow()
    expect(() => encodeWavPcm16(new Float32Array([0]), 192001)).toThrow()
    expect(() => encodeWavPcm16(new Float32Array([0]), 16000.5)).toThrow()
    expect(() => encodeWavPcm16(new Float32Array([Number.NaN]), 16000)).toThrow()
    expect(() => encodeWavPcm16(new Float32Array([Number.POSITIVE_INFINITY]), 16000)).toThrow()
  })
})

describe("openai transcription settings", () => {
  it("rejects API keys in openaiProfile", () => {
    expect(() =>
      transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, openaiProfile: "sk-proj-secret123456" }),
    ).toThrow(/credentials/i)
  })

  it("accepts a non-secret profile name", () => {
    const config = transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, openaiProfile: "work-profile" })
    expect(config.openaiProfile).toBe("work-profile")
  })

  it("rejects non-loopback http base URLs", () => {
    expect(() =>
      transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, openaiBaseUrl: "http://example.com/v1" }),
    ).toThrow(/HTTPS or loopback/i)
  })

  it("accepts https and loopback http base URLs", () => {
    expect(
      transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, openaiBaseUrl: "https://api.openai.com/v1" })
        .openaiBaseUrl,
    ).toBe("https://api.openai.com/v1")
    expect(
      transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, openaiBaseUrl: "http://127.0.0.1:8080/v1" })
        .openaiBaseUrl,
    ).toBe("http://127.0.0.1:8080/v1")
    expect(
      transcriptionConfigSchema.parse({ ...defaultTranscriptionConfig, openaiBaseUrl: "http://localhost:8080/v1" })
        .openaiBaseUrl,
    ).toBe("http://localhost:8080/v1")
  })
})

describe("sanitizeTranscriptionError", () => {
  it("redacts embedded API keys and bearer tokens", () => {
    expect(sanitizeTranscriptionError("failed sk-live-secret99999999 here")).not.toContain("sk-live")
    expect(sanitizeTranscriptionError("failed sk-live-secret99999999 here")).toContain("[REDACTED]")
    expect(sanitizeTranscriptionError("x Bearer secret-token y")).toBe("x Bearer [REDACTED] y")
    expect(sanitizeTranscriptionError("x bearer Secret-Token-123 y")).toBe("x Bearer [REDACTED] y")
  })
})

type SeenRequest = {
  count: number
  auth: string | null
  model: string | null
  language: string | null
  prompt: string | null
  fileBytes: Uint8Array | null
  fileName: string | null
}

function startStandIn(handler: (req: Request, seen: SeenRequest) => Promise<Response>) {
  const seen: SeenRequest = {
    count: 0,
    auth: null,
    model: null,
    language: null,
    prompt: null,
    fileBytes: null,
    fileName: null,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handler(req, seen),
  })
  return { server, seen, baseUrl: `http://127.0.0.1:${server.port}/v1` }
}

async function captureMultipart(req: Request, seen: SeenRequest): Promise<void> {
  seen.count += 1
  seen.auth = req.headers.get("authorization")
  const form = await req.formData()
  const model = form.get("model")
  if (typeof model === "string") seen.model = model
  const language = form.get("language")
  if (typeof language === "string") seen.language = language
  const prompt = form.get("prompt")
  if (typeof prompt === "string") seen.prompt = prompt
  const file = form.get("file")
  if (file !== null && typeof file !== "string") {
    seen.fileBytes = new Uint8Array(await file.arrayBuffer())
    if (file instanceof File) seen.fileName = file.name
  }
}

function openAIConfig(baseUrl: string, model: string, language = "en") {
  return transcriptionConfigSchema.parse({
    ...defaultTranscriptionConfig,
    provider: "openai",
    model,
    language,
    openaiBaseUrl: baseUrl,
  })
}

const testResolver = () => async () => ({ apiKey: "test-key-1", source: "test" })

describe("openai provider against a local stand-in", () => {
  it("sends authorization, wav upload, language, and prompt hints", async () => {
    const { server, seen, baseUrl } = startStandIn(async (req, seenRequest) => {
      await captureMultipart(req, seenRequest)
      return Response.json({ text: "  hello world  " })
    })
    try {
      const config = openAIConfig(baseUrl, "gpt-transcribe")
      const provider = createProvider(config, { resolveOpenAIApiKey: testResolver() })
      await provider.initialize(config)
      const results = await provider.transcribe(
        { id: "c1", source: "microphone", startMs: 1000, sampleRate: 16000, samples: new Float32Array(16000).fill(0.1) },
        { hints: ["noun one", "noun two"] },
      )
      expect(results).toEqual([{ startMs: 1000, endMs: 2000, text: "hello world" }])
      expect(seen.auth).toBe("Bearer test-key-1")
      expect(seen.model).toBe("gpt-transcribe")
      expect(seen.language).toBe("en")
      expect(seen.prompt).toContain("noun one")
      expect(seen.fileName).toBe("chunk.wav")
      expect(seen.fileBytes?.length).toBe(44 + 16000 * 2)
      expect(String.fromCharCode(...(seen.fileBytes?.slice(0, 4) ?? []))).toBe("RIFF")
      await expect(provider.healthCheck()).resolves.toMatchObject({ healthy: true, initialized: true })
      await provider.dispose()
      await expect(provider.healthCheck()).resolves.toMatchObject({ healthy: false })
    } finally {
      await server.stop()
    }
  })

  it("transcribes with gpt-4o-mini-transcribe", async () => {
    const { server, seen, baseUrl } = startStandIn(async (req, seenRequest) => {
      await captureMultipart(req, seenRequest)
      return Response.json({ text: "mini transcript" })
    })
    try {
      const config = openAIConfig(baseUrl, "gpt-4o-mini-transcribe")
      const provider = createProvider(config, { resolveOpenAIApiKey: testResolver() })
      await provider.initialize(config)
      const results = await provider.transcribe(
        { id: "c2", source: "remote", startMs: 0, sampleRate: 8000, samples: new Float32Array(8000).fill(0.2) },
        { hints: [] },
      )
      expect(results).toEqual([{ startMs: 0, endMs: 1000, text: "mini transcript" }])
      expect(seen.model).toBe("gpt-4o-mini-transcribe")
      await provider.dispose()
    } finally {
      await server.stop()
    }
  })

  it("returns no segments for empty transcripts or empty audio", async () => {
    const { server, seen, baseUrl } = startStandIn(async (_req, seenRequest) => {
      seenRequest.count += 1
      return Response.json({ text: "   " })
    })
    try {
      const config = openAIConfig(baseUrl, "whisper-1")
      const provider = createProvider(config, { resolveOpenAIApiKey: testResolver() })
      await provider.initialize(config)
      const blank = await provider.transcribe(
        { id: "c3", source: "microphone", startMs: 0, sampleRate: 16000, samples: new Float32Array(1600).fill(0.1) },
        { hints: [] },
      )
      expect(blank).toEqual([])
      const silent = await provider.transcribe(
        { id: "c4", source: "microphone", startMs: 0, sampleRate: 16000, samples: new Float32Array(0) },
        { hints: [] },
      )
      expect(silent).toEqual([])
      expect(seen.count).toBe(1)
      await provider.dispose()
    } finally {
      await server.stop()
    }
  })

  it("rejects oversized chunks without calling the service", async () => {
    const { server, seen, baseUrl } = startStandIn(async (_req, seenRequest) => {
      seenRequest.count += 1
      return Response.json({ text: "late" })
    })
    try {
      const config = openAIConfig(baseUrl, "gpt-4o-transcribe")
      const provider = createProvider(config, { resolveOpenAIApiKey: testResolver() })
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
      expect(seen.count).toBe(0)
      await provider.dispose()
    } finally {
      await server.stop()
    }
  })

  it("times out on a slow stand-in and honors aborts", async () => {
    const { server, baseUrl } = startStandIn(async () => {
      await Bun.sleep(2000)
      return Response.json({ text: "too late" })
    })
    try {
      const config = transcriptionConfigSchema.parse({
        ...defaultTranscriptionConfig,
        provider: "openai",
        model: "gpt-transcribe",
        language: "en",
        openaiBaseUrl: baseUrl,
        requestTimeoutMs: 100,
      })
      const provider = createProvider(config, { resolveOpenAIApiKey: testResolver() })
      await provider.initialize(config)
      await expect(
        provider.transcribe(
          { id: "slow", source: "microphone", startMs: 0, sampleRate: 16000, samples: new Float32Array(1600).fill(0.1) },
          { hints: [] },
        ),
      ).rejects.toThrow()
      const controller = new AbortController()
      controller.abort()
      await expect(
        provider.transcribe(
          { id: "cancelled", source: "microphone", startMs: 0, sampleRate: 16000, samples: new Float32Array(1600).fill(0.1) },
          { hints: [], signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: "AbortError" })
      await provider.dispose()
    } finally {
      await server.stop()
    }
  })

  it("redacts secrets from HTTP error responses", async () => {
    const { server, baseUrl } = startStandIn(async () => {
      return new Response("unauthorized for sk-live-secret99999999 with Bearer secret-token", { status: 401 })
    })
    try {
      const config = openAIConfig(baseUrl, "gpt-transcribe")
      const provider = createProvider(config, { resolveOpenAIApiKey: testResolver() })
      await provider.initialize(config)
      const error = await provider
        .transcribe(
          { id: "denied", source: "microphone", startMs: 0, sampleRate: 16000, samples: new Float32Array(1600).fill(0.1) },
          { hints: [] },
        )
        .then(
          () => undefined,
          (failure: unknown) => failure,
        )
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw new Error("Expected transcription to reject")
      expect(error.message).not.toContain("sk-live-secret99999999")
      expect(error.message).not.toContain("secret-token")
      expect(error.message).toContain("[REDACTED]")
      await provider.dispose()
    } finally {
      await server.stop()
    }
  })

  it("requires a credential store resolver when a profile is set", async () => {
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const config = transcriptionConfigSchema.parse({
        ...defaultTranscriptionConfig,
        provider: "openai",
        model: "gpt-transcribe",
        openaiProfile: "work-profile",
      })
      const provider = createProvider(config)
      await expect(provider.initialize(config)).rejects.toThrow(/credential store resolver/i)
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = saved
    }
  })

  it("fails without any available API key", async () => {
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const config = transcriptionConfigSchema.parse({
        ...defaultTranscriptionConfig,
        provider: "openai",
        model: "gpt-transcribe",
      })
      const provider = createProvider(config)
      await expect(provider.initialize(config)).rejects.toThrow(/API key/i)
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = saved
    }
  })
})

describe("openai model inventory", () => {
  it("lists registered openai models with the requested availability", async () => {
    const available = await listModels({ ...defaultTranscriptionConfig }, { openaiAvailable: true })
    for (const id of ["gpt-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"]) {
      expect(available.find((model) => model.id === id)).toMatchObject({ provider: "openai", installed: true })
    }
    const unavailable = await listModels({ ...defaultTranscriptionConfig }, { openaiAvailable: false })
    for (const id of ["gpt-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"]) {
      expect(unavailable.find((model) => model.id === id)).toMatchObject({ provider: "openai", installed: false })
    }
  })
})
