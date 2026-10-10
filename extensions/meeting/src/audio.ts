import { createHash } from "node:crypto"
import { sanitizeTranscriptionError, type AudioChunk } from "./transcription/index"
import type { AudioSource } from "./types"

type Input = {
  captureID: string
  source: AudioSource
  sequence: number
  startMs: number
  sampleRate: number
  samples: Float32Array
}
type Options = {
  chunkSeconds: number
  overlapSeconds: number
  sampleRate?: number
  vad?: boolean
  maxBufferedSeconds?: number
  onChunk: (chunk: AudioChunk) => Promise<void>
  onGap: (gap: { source: AudioSource; startMs: number; reason: string }) => void
}
type Source = {
  originMs: number
  inputRate: number
  input: Float32Array
  inputOffset: number
  inputThrough: number
  outputThrough: number
  output: Float32Array
  outputOffset: number
  emittedThrough: number
  endMs: number
  sequence: number
  finalized: boolean
}
type Pending = { chunk: AudioChunk; seconds: number }

export class AudioBackpressure extends Error {
  constructor() {
    super("Audio buffer is full; drain pending inference and retry the unaccepted input")
    this.name = "AudioBackpressure"
  }
}

export class AudioProcessor {
  private readonly rate: number
  private readonly window: number
  private readonly overlap: number
  private readonly capacity: number
  private readonly sources = new Map<AudioSource, Source>()
  private readonly replays = new Map<AudioSource, Map<number, string>>()
  private readonly pending: Pending[] = []
  private running?: Promise<void>
  private captureID?: string
  private closing = false
  private closed = false
  private processedSeconds = 0
  private error?: string

  constructor(private readonly options: Options) {
    this.rate = options.sampleRate ?? 16000
    if (!Number.isSafeInteger(this.rate) || this.rate < 8000 || this.rate > 192000)
      throw new Error("Invalid output sample rate")
    if (!Number.isFinite(options.chunkSeconds) || options.chunkSeconds <= 0 || options.chunkSeconds > 30)
      throw new Error("Invalid chunk duration")
    if (
      !Number.isFinite(options.overlapSeconds) ||
      options.overlapSeconds < 0 ||
      options.overlapSeconds >= options.chunkSeconds
    )
      throw new Error("Overlap must be shorter than the audio chunk")
    this.window = Math.round(options.chunkSeconds * this.rate)
    this.overlap = Math.round(options.overlapSeconds * this.rate)
    if (this.window < 1 || this.window <= this.overlap) throw new Error("Invalid audio window")
    this.capacity = options.maxBufferedSeconds ?? Math.max(60, 4 * options.chunkSeconds)
    if (!Number.isFinite(this.capacity) || this.capacity < options.chunkSeconds)
      throw new Error("Buffer capacity must hold one chunk")
  }

  async push(input: Input): Promise<{ duplicate: boolean }> {
    const result = this.accept(input)
    await this.drain({ retry: false })
    return result
  }

  accept(input: Input): { duplicate: boolean } {
    if (this.closed || this.closing) throw new Error("Audio processor is closed to new input")
    this.validate(input)
    const previous = this.sources.get(input.source)
    const replay = this.replays.get(input.source)
    if (previous && input.sequence <= previous.sequence && !replay?.has(input.sequence))
      throw new Error("Audio replay expired; sequence must increase")
    const digest = createHash("sha256")
      .update(JSON.stringify([input.captureID, input.source, input.sequence, input.startMs, input.sampleRate]))
      .update(new Uint8Array(input.samples.buffer, input.samples.byteOffset, input.samples.byteLength))
      .digest("hex")
    const existing = replay?.get(input.sequence)
    if (existing !== undefined) {
      if (existing !== digest) throw new Error("Changed duplicate audio replay")
      return { duplicate: true }
    }
    if (this.error) throw new Error(`Pending audio inference failed; call drain to retry: ${this.error}`)
    if (this.bufferedSeconds() + input.samples.length / input.sampleRate > this.capacity + 1e-9)
      throw new AudioBackpressure()

    if (previous && input.sequence <= previous.sequence) throw new Error("Audio sequence must increase")
    if (previous && input.startMs < previous.endMs - (0.5 * 1000) / previous.inputRate)
      throw new Error("Audio clock cannot regress or overlap")
    const discontinuity =
      previous &&
      (input.sequence !== previous.sequence + 1 ||
        Math.abs(input.startMs - previous.endMs) > (0.5 * 1000) / previous.inputRate ||
        input.sampleRate !== previous.inputRate)
    const queued: Pending[] = []
    if (discontinuity) {
      const tail = { ...previous }
      this.convert(tail, true)
      this.emit(tail, input.source, input.captureID, queued, true)
    }
    const source: Source =
      previous && !discontinuity && !previous.finalized
        ? { ...previous }
        : {
            originMs: input.startMs,
            inputRate: input.sampleRate,
            input: new Float32Array(),
            inputOffset: 0,
            inputThrough: 0,
            outputThrough: 0,
            output: new Float32Array(),
            outputOffset: 0,
            emittedThrough: 0,
            endMs: input.startMs,
            sequence: input.sequence,
            finalized: false,
          }
    source.input = concatenate(source.input, input.samples)
    source.inputThrough += input.samples.length
    source.endMs = source.originMs + (source.inputThrough * 1000) / source.inputRate
    source.sequence = input.sequence
    this.convert(source, false)
    this.emit(source, input.source, input.captureID, queued, false)
    const projected = new Map(this.sources).set(input.source, source)
    if (this.bufferedSeconds(projected, [...this.pending, ...queued]) > this.capacity + 1e-9)
      throw new AudioBackpressure()
    const finalQueued: Pending[] = []
    const finalized = new Map<AudioSource, Source>()
    for (const [name, current] of projected) {
      const tail = { ...current }
      this.convert(tail, true)
      this.emit(tail, name, input.captureID, finalQueued, true)
      finalized.set(name, tail)
    }
    if (this.bufferedSeconds(finalized, [...this.pending, ...queued, ...finalQueued]) > this.capacity + 1e-9)
      throw new AudioBackpressure()
    this.sources.set(input.source, source)
    this.pending.push(...queued)
    this.captureID = input.captureID
    const recent = replay ?? new Map<number, string>()
    recent.set(input.sequence, digest)
    if (recent.size > 256) recent.delete(recent.keys().next().value!)
    this.replays.set(input.source, recent)
    if (discontinuity)
      this.options.onGap({
        source: input.source,
        startMs: input.startMs,
        reason: "Audio sequence, timestamp or sample-rate discontinuity",
      })
    return { duplicate: false }
  }

  async flush(): Promise<void> {
    if (this.closed) return
    await this.drain({ retry: false })
    const queued: Pending[] = []
    for (const [name, current] of this.sources) {
      const source = { ...current }
      this.convert(source, true)
      this.emit(source, name, this.captureID!, queued, true)
      this.sources.set(name, source)
    }
    this.pending.push(...queued)
    await this.drain({ retry: false })
  }

  drain(options: { retry?: boolean } = {}): Promise<void> {
    if (this.running) return this.running
    if (this.closed) return Promise.resolve()
    if (this.error && options.retry === false) return Promise.reject(new Error(this.error))
    this.running = this.process().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closing = true
    await this.flush()
    this.sources.clear()
    this.replays.clear()
    this.captureID = undefined
    this.closed = true
  }

  stats(): { bufferedSeconds: number; processedSeconds: number; backlog: number; error?: string } {
    return {
      bufferedSeconds: this.bufferedSeconds(),
      processedSeconds: this.processedSeconds,
      backlog: this.pending.length,
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  private validate(input: Input) {
    if (!input.captureID || input.captureID.length > 256 || (this.captureID && this.captureID !== input.captureID))
      throw new Error("Invalid or changed capture id")
    if (input.source !== "remote" && input.source !== "microphone") throw new Error("Invalid audio source")
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new Error("Invalid audio sequence")
    if (!Number.isFinite(input.startMs) || input.startMs < 0) throw new Error("Invalid audio timestamp")
    if (!Number.isSafeInteger(input.sampleRate) || input.sampleRate < 8000 || input.sampleRate > 192000)
      throw new Error("Invalid input sample rate")
    if (!(input.samples instanceof Float32Array) || input.samples.length === 0)
      throw new Error("Audio input must contain Float32 samples")
    if (input.samples.some((sample) => !Number.isFinite(sample))) throw new Error("Audio samples must be finite")
  }

  private bufferedSeconds(sources = this.sources, pending = this.pending) {
    return (
      [...sources.values()].reduce(
        (seconds, source) => seconds + source.input.length / source.inputRate + source.output.length / this.rate,
        0,
      ) + pending.reduce((seconds, item) => seconds + item.chunk.samples.length / this.rate, 0)
    )
  }

  private convert(source: Source, final: boolean) {
    if (source.inputRate === this.rate) {
      source.output = concatenate(source.output, source.input)
      source.outputThrough += source.input.length
      source.inputOffset = source.inputThrough
      source.input = new Float32Array()
      return
    }
    const cutoff = Math.min(1, this.rate / source.inputRate) * 0.9
    const radius = Math.ceil(24 / cutoff)
    const through = Math.round((source.inputThrough * this.rate) / source.inputRate)
    const converted: number[] = []
    while (source.outputThrough < through) {
      const position = (source.outputThrough * source.inputRate) / this.rate
      if (!final && Math.ceil(position) + radius >= source.inputThrough) break
      let value = 0
      let weight = 0
      for (let index = Math.ceil(position - radius); index <= Math.floor(position + radius); index++) {
        const distance = position - index
        const argument = Math.PI * cutoff * distance
        const coefficient =
          cutoff *
          (argument === 0 ? 1 : Math.sin(argument) / argument) *
          (0.5 + 0.5 * Math.cos((Math.PI * distance) / radius))
        const clamped = Math.max(0, Math.min(source.inputThrough - 1, index))
        const sample = source.input[clamped - source.inputOffset]
        if (sample === undefined) throw new Error("Missing audio resampler history")
        value += sample * coefficient
        weight += coefficient
      }
      converted.push(Math.max(-1, Math.min(1, value / weight)))
      source.outputThrough++
    }
    source.output = concatenate(source.output, Float32Array.from(converted))
    const discardThrough = final
      ? source.inputThrough
      : Math.min(
          source.inputThrough,
          Math.max(source.inputOffset, Math.floor((source.outputThrough * source.inputRate) / this.rate) - radius),
        )
    source.input = source.input.slice(discardThrough - source.inputOffset)
    source.inputOffset = discardThrough
  }

  private emit(source: Source, name: AudioSource, captureID: string, pending: Pending[], final: boolean) {
    while (source.output.length > 0) {
      if (
        source.output.length < this.window &&
        (!final || source.outputOffset + source.output.length <= source.emittedThrough)
      )
        break
      const length = Math.min(this.window, source.output.length)
      const through = source.outputOffset + length
      const chunk: AudioChunk = {
        id: createHash("sha256")
          .update(JSON.stringify([captureID, name, source.originMs, source.outputOffset]))
          .digest("hex"),
        source: name,
        startMs: source.originMs + (source.outputOffset * 1000) / this.rate,
        sampleRate: this.rate,
        samples: source.output.slice(0, length),
      }
      pending.push({ chunk, seconds: (through - Math.max(source.emittedThrough, source.outputOffset)) / this.rate })
      source.emittedThrough = through
      const stride = length === this.window ? this.window - this.overlap : length
      source.output = source.output.slice(stride)
      source.outputOffset += stride
    }
    if (final) {
      source.output = new Float32Array()
      source.outputOffset = source.outputThrough
      source.finalized = true
    }
  }

  private async process() {
    this.error = undefined
    while (this.pending[0] !== undefined) {
      const item = this.pending[0]
      const energyVadSpeech =
        Math.sqrt(item.chunk.samples.reduce((sum, sample) => sum + sample * sample, 0) / item.chunk.samples.length) >=
        0.005
      try {
        if (this.options.vad === false || energyVadSpeech) {
          await this.options.onChunk({ ...item.chunk, samples: item.chunk.samples.slice() })
        }
      } catch (error) {
        this.error = sanitizeTranscriptionError(error)
        throw error
      }
      this.pending.shift()
      this.processedSeconds += item.seconds
    }
  }
}

function concatenate(left: Float32Array, right: Float32Array) {
  const result = new Float32Array(left.length + right.length)
  result.set(left)
  result.set(right, left.length)
  return result
}

export function reconcileOverlap(previous: { text: string; endMs: number }, next: { text: string; startMs: number }) {
  if (!Number.isFinite(previous.endMs) || !Number.isFinite(next.startMs) || next.startMs >= previous.endMs)
    return next.text
  const segmenter = new Intl.Segmenter("th", { granularity: "grapheme" })
  const left = [...segmenter.segment(previous.text.trimEnd())].map((item) => item.segment)
  const right = [...segmenter.segment(next.text)].map((item) => item.segment)
  for (let length = Math.min(left.length, right.length); length >= 2; length--) {
    if (left.slice(-length).join("") !== right.slice(0, length).join("")) continue
    const matching = right.slice(0, length).join("")
    const tail = right.slice(length).join("")
    if (
      /^[\p{Script=Latin}\p{Number}]+$/u.test(matching) &&
      ((tail && /^[\p{Script=Latin}\p{Number}]/u.test(tail)) ||
        /[\p{Script=Latin}\p{Number}]$/u.test(left.slice(0, -length).join("")))
    )
      continue
    return tail.trimStart()
  }
  return next.text
}
