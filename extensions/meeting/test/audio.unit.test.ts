import { describe, expect, it } from "bun:test"
import { AudioProcessor, reconcileOverlap } from "../src/audio"
import type { AudioChunk } from "../src/transcription/index"

function packet(overrides: Partial<Parameters<AudioProcessor["push"]>[0]> = {}) {
  return {
    captureID: "capture",
    source: "remote" as const,
    sequence: 0,
    startMs: 1000,
    sampleRate: 8000,
    samples: new Float32Array(8000).fill(0.2),
    ...overrides,
  }
}

function processor(
  onChunk: (chunk: AudioChunk) => Promise<void>,
  overrides: Partial<ConstructorParameters<typeof AudioProcessor>[0]> = {},
) {
  return new AudioProcessor({
    chunkSeconds: 1,
    overlapSeconds: 0.25,
    sampleRate: 8000,
    vad: false,
    onChunk,
    onGap: () => undefined,
    ...overrides,
  })
}

describe("AudioProcessor unit lifecycle", () => {
  it("emits stable overlapping windows and flushes only new tail audio", async () => {
    const chunks: AudioChunk[] = []
    const audio = processor(async (chunk) => {
      chunks.push(chunk)
    })
    await audio.push(packet({ samples: new Float32Array(16000).fill(0.2) }))
    await audio.flush()
    expect(chunks.map((chunk) => [chunk.startMs, chunk.samples.length])).toEqual([
      [1000, 8000],
      [1750, 8000],
      [2500, 4000],
    ])
    expect(chunks[0]?.samples.slice(6000)).toEqual(chunks[1]?.samples.slice(0, 2000))
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(3)
    expect(audio.stats().processedSeconds).toBeCloseTo(2)
    await audio.flush()
    expect(chunks).toHaveLength(3)
    await audio.close()
    expect(audio.stats().bufferedSeconds).toBe(0)
    await expect(audio.push(packet({ sequence: 1 }))).rejects.toThrow(/closed/i)
  })

  it("idempotently replays input without accepting changed duplicates or regressing clocks", async () => {
    const chunks: AudioChunk[] = []
    const audio = processor(async (chunk) => {
      chunks.push(chunk)
    })
    const original = packet()
    await audio.push(original)
    expect(await audio.push(original)).toEqual({ duplicate: true })
    await expect(audio.push({ ...original, samples: new Float32Array(8000).fill(0.3) })).rejects.toThrow(
      /duplicate|replay/i,
    )
    await expect(audio.push(packet({ sequence: 1, startMs: 900 }))).rejects.toThrow(/clock|time/i)
    await audio.push(packet({ source: "microphone", startMs: 3000 }))
    expect(chunks.map((chunk) => chunk.startMs)).toEqual([1000, 3000])
    await audio.close()
  })

  it("energy VAD suppresses silence and never calls inference on silent flush", async () => {
    const chunks: AudioChunk[] = []
    const audio = processor(
      async (chunk) => {
        chunks.push(chunk)
      },
      { vad: true },
    )
    await audio.push(packet({ samples: new Float32Array(10000) }))
    await audio.flush()
    expect(chunks).toEqual([])
    expect(audio.stats().processedSeconds).toBeCloseTo(1.25)
    await audio.close()
  })

  it("bounds replay history per source and rejects expired sequences without new inference", async () => {
    const chunks: AudioChunk[] = []
    const audio = processor(
      async (chunk) => {
        chunks.push(chunk)
      },
      { chunkSeconds: 0.01, overlapSeconds: 0 },
    )
    const initial = packet({ samples: new Float32Array(80).fill(0.2) })
    await audio.push({ ...initial, source: "microphone" })
    for (let sequence = 0; sequence < 258; sequence++) {
      await audio.push({ ...initial, sequence, startMs: 1000 + sequence * 10 })
    }
    await expect(audio.push(initial)).rejects.toThrow(/expired/i)
    expect(await audio.push({ ...initial, source: "microphone" })).toEqual({ duplicate: true })
    expect(await audio.push({ ...initial, sequence: 257, startMs: 3570 })).toEqual({ duplicate: true })
    expect(chunks).toHaveLength(259)
    await audio.close()
  })

  it("synchronously admits volatile input during blocked inference and rejects pressure before sequence admission", async () => {
    let unblock: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    let started: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const chunks: AudioChunk[] = []
    const audio = processor(
      async (chunk) => {
        started()
        await blocked
        chunks.push(chunk)
      },
      { maxBufferedSeconds: 1.75 },
    )
    expect(audio.accept(packet())).toEqual({ duplicate: false })
    expect(chunks).toEqual([])
    const draining = audio.drain()
    await entered
    expect(audio.accept(packet())).toEqual({ duplicate: true })
    expect(() => audio.accept(packet({ sequence: 1, startMs: 2000 }))).toThrow(/buffer.*full/i)
    unblock()
    await draining
    expect(audio.accept(packet({ sequence: 1, startMs: 2000 }))).toEqual({ duplicate: false })
    await audio.drain()
    await audio.close()

    let fail = true
    const retry = processor(async () => {
      if (fail) throw new Error("drain inference failed")
    })
    expect(retry.accept(packet())).toEqual({ duplicate: false })
    await expect(retry.drain()).rejects.toThrow("drain inference failed")
    expect(retry.stats()).toMatchObject({ backlog: 1, error: "drain inference failed" })
    expect(retry.accept(packet())).toEqual({ duplicate: true })
    fail = false
    await retry.drain()
    await retry.close()
  })

  it("rejects pressure before accepting sequence and preserves pending inference for explicit retry", async () => {
    let unblock: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    let started: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const chunks: AudioChunk[] = []
    const audio = processor(
      async (chunk) => {
        started()
        await blocked
        chunks.push(chunk)
      },
      { maxBufferedSeconds: 1.75 },
    )
    const first = audio.push(packet())
    await entered
    await expect(audio.push(packet({ sequence: 1, startMs: 2000 }))).rejects.toMatchObject({
      name: "AudioBackpressure",
    })
    unblock()
    await first
    expect(await audio.push(packet({ sequence: 1, startMs: 2000 }))).toEqual({ duplicate: false })
    await audio.close()
    expect(chunks.length).toBeGreaterThan(1)

    let fail = true
    const attempts: string[] = []
    const retry = processor(async (chunk) => {
      attempts.push(chunk.id)
      if (fail) throw new Error("inference failed")
    })
    await expect(retry.push(packet())).rejects.toThrow("inference failed")
    expect(retry.stats()).toMatchObject({ backlog: 1, error: "inference failed" })
    expect(retry.stats().bufferedSeconds).toBeGreaterThan(0)
    await expect(retry.close()).rejects.toThrow("inference failed")
    fail = false
    await retry.drain()
    expect(attempts[0]).toBe(attempts[1])
    expect(attempts[1]).toBe(attempts[2])
    expect(retry.stats().error).toBeUndefined()
    await retry.close()
    expect(retry.stats().bufferedSeconds).toBe(0)
  })

  it("reports timestamp/sequence gaps without blending disconnected source clocks", async () => {
    const chunks: AudioChunk[] = []
    const gaps: { source: string; startMs: number; reason: string }[] = []
    const audio = processor(
      async (chunk) => {
        chunks.push(chunk)
      },
      {
        onGap: (gap) => {
          gaps.push(gap)
        },
      },
    )
    await audio.push(packet({ samples: new Float32Array(4000).fill(0.2) }))
    await audio.push(packet({ sequence: 2, startMs: 3000, samples: new Float32Array(8000).fill(0.3) }))
    expect(gaps).toHaveLength(1)
    expect(chunks.map((chunk) => [chunk.startMs, chunk.samples.length])).toEqual([
      [1000, 4000],
      [3000, 8000],
    ])
    await audio.close()
  })

  it("resamples DC with correct duration/timestamps and filters above-Nyquist energy", async () => {
    const chunks: AudioChunk[] = []
    const audio = processor(
      async (chunk) => {
        chunks.push(chunk)
      },
      { overlapSeconds: 0 },
    )
    await audio.push(packet({ sampleRate: 48000, samples: new Float32Array(48000).fill(0.25) }))
    await audio.flush()
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ sampleRate: 8000, startMs: 1000 })
    expect(chunks[0]?.samples.length).toBe(8000)
    expect(chunks[0]?.samples.every((value) => Math.abs(value - 0.25) < 0.0001)).toBe(true)
    await audio.close()

    const filtered: AudioChunk[] = []
    const antialias = processor(
      async (chunk) => {
        filtered.push(chunk)
      },
      { overlapSeconds: 0 },
    )
    const samples = Float32Array.from({ length: 48000 }, (_, index) => Math.sin((2 * Math.PI * 6000 * index) / 48000))
    await antialias.push(packet({ sampleRate: 48000, samples }))
    await antialias.flush()
    const middle = filtered.flatMap((chunk) => Array.from(chunk.samples.slice(100, -100)))
    expect(Math.sqrt(middle.reduce((sum, value) => sum + value * value, 0) / middle.length)).toBeLessThan(0.01)
    await antialias.close()
  })

  it("resampling is independent of packet fragmentation and invalid input is not admitted", async () => {
    const whole: AudioChunk[] = []
    const split: AudioChunk[] = []
    const samples = Float32Array.from({ length: 44100 }, (_, index) => Math.sin((2 * Math.PI * 440 * index) / 44100))
    const a = processor(
      async (chunk) => {
        whole.push(chunk)
      },
      { overlapSeconds: 0 },
    )
    const b = processor(
      async (chunk) => {
        split.push(chunk)
      },
      { overlapSeconds: 0 },
    )
    await a.push(packet({ sampleRate: 44100, samples }))
    await b.push(packet({ sampleRate: 44100, samples: samples.slice(0, 10000) }))
    await b.push(
      packet({ sequence: 1, startMs: 1000 + 10000 / 44.1, sampleRate: 44100, samples: samples.slice(10000) }),
    )
    await a.flush()
    await b.flush()
    expect(split[0]?.samples).toEqual(whole[0]?.samples)
    await expect(a.push(packet({ sequence: 1, startMs: 2000, samples: new Float32Array([NaN]) }))).rejects.toThrow(
      /finite/i,
    )
    await a.close()
    await b.close()
  })

  it("continues a resampled source after flush without missing filter history or duplicating time", async () => {
    const chunks: AudioChunk[] = []
    const audio = processor(
      async (chunk) => {
        chunks.push(chunk)
      },
      { overlapSeconds: 0 },
    )
    await audio.push(packet({ sampleRate: 48000, samples: new Float32Array(24000).fill(0.25) }))
    await audio.flush()
    await audio.push(
      packet({ sequence: 1, startMs: 1500, sampleRate: 48000, samples: new Float32Array(24000).fill(0.25) }),
    )
    await audio.flush()
    expect(chunks.map((chunk) => [chunk.startMs, chunk.samples.length])).toEqual([
      [1000, 4000],
      [1500, 4000],
    ])
    expect(
      chunks.every((chunk) =>
        chunk.samples.every((sample) => Number.isFinite(sample) && Math.abs(sample - 0.25) < 0.0001),
      ),
    ).toBe(true)
    await audio.close()
  })

  it("reserves bounded inference capacity for delayed resampler tails before admitting input", async () => {
    const chunks: AudioChunk[] = []
    const audio = processor(
      async (chunk) => {
        chunks.push(chunk)
      },
      { maxBufferedSeconds: 1.1 },
    )
    expect(() => audio.accept(packet({ sampleRate: 48000, samples: new Float32Array(48048).fill(0.25) }))).toThrow(
      /buffer.*full/i,
    )
    expect(audio.stats()).toMatchObject({ bufferedSeconds: 0, backlog: 0 })
    expect(audio.accept(packet({ sampleRate: 48000, samples: new Float32Array(24000).fill(0.25) }))).toEqual({
      duplicate: false,
    })
    await audio.flush()
    expect(chunks[0]?.samples.length).toBe(4000)
    await audio.close()
  })
})

describe("reconcileOverlap unit Unicode text", () => {
  it("removes only a suffix/prefix with actual time overlap, preserving repeated utterances", () => {
    expect(reconcileOverlap({ text: "hello world", endMs: 2000 }, { text: "world again", startMs: 1500 })).toBe("again")
    expect(reconcileOverlap({ text: "hello world", endMs: 2000 }, { text: "world again", startMs: 2000 })).toBe(
      "world again",
    )
    expect(
      reconcileOverlap({ text: "ประชุมสวัสดีครับ", endMs: 2000 }, { text: "สวัสดีครับทุกคน", startMs: 1500 }),
    ).toBe("ทุกคน")
    expect(reconcileOverlap({ text: "ครับ", endMs: 2000 }, { text: "ครับ", startMs: 2200 })).toBe("ครับ")
    expect(reconcileOverlap({ text: "a", endMs: 2000 }, { text: "again", startMs: 1500 })).toBe("again")
    expect(reconcileOverlap({ text: "foobar", endMs: 2000 }, { text: "bar again", startMs: 1500 })).toBe("bar again")
  })
})
