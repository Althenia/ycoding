import { randomUUID } from "node:crypto"
import { writeFile, rename } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { AudioBackpressure, AudioProcessor, reconcileOverlap } from "./audio"
import type { CaptureMessage } from "./bridge"
import { meetingConfigSchema, type MeetingConfig } from "./config"
import { MeetingIntelligence, type MeetingMCP } from "./intelligence"
import { MeetingStore } from "./store"
import { createProvider, installModel, listModels, type AudioChunk, type TranscriptionProvider } from "./transcription"
import type { MeetingView, TranscriptSegment } from "./types"

const controlSchema = z
  .object({
    action: z.enum([
      "start",
      "stop",
      "status",
      "summary",
      "plan",
      "transcript",
      "knowledge-review",
      "models",
      "config",
      "select",
      "configure",
      "model-select",
      "model-install",
      "approve",
      "reject",
      "confirm",
      "reject-finding",
      "correct",
      "delete",
      "retry",
      "reconcile",
    ]),
    meetingID: z.string().max(200).optional(),
    sessionID: z.string().max(200).optional(),
    title: z.string().max(200).optional(),
    proposalID: z.string().max(200).optional(),
    findingID: z.string().max(200).optional(),
    segmentID: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    text: z.string().max(8000).optional(),
    config: z.unknown().optional(),
    authorized: z.literal(true).optional(),
    confirmed: z.literal(true).optional(),
  })
  .strict()

export class MeetingRuntime {
  config: MeetingConfig
  readonly intelligence: MeetingIntelligence
  private selected?: string
  private active?: string
  private audio?: AudioProcessor
  private provider?: TranscriptionProvider
  private health: MeetingView["health"]
  private changing = false
  private lastHeartbeat = 0
  private microphone = false
  private provisional?: TranscriptSegment
  private readonly work = new Set<Promise<void>>()
  private readonly previous = new Map<string, TranscriptSegment>()
  private controlTail: Promise<unknown> = Promise.resolve()
  private shutdown?: Promise<void>
  pairing?: MeetingView["pairing"]

  constructor(
    readonly options: {
      directory: string
      store: MeetingStore
      config: MeetingConfig
      createSession: (parentID?: string) => Promise<string>
      generate: (sessionID: string, prompt: string) => Promise<string>
      mcp: MeetingMCP
      providerFactory?: typeof createProvider
    },
  ) {
    this.config = options.config
    this.health = {
      model: this.config.transcription.model,
      provider: this.config.transcription.provider,
      device: this.config.transcription.device,
      status: "unloaded",
    }
    this.intelligence = new MeetingIntelligence({
      store: options.store,
      generate: options.generate,
      mcp: options.mcp,
      bindings: this.config.knowledge.mcpEnabled ? this.config.knowledge.bindings : [],
      maxCharacters: this.config.analysis.maxCharacters,
      retrievalTTL: this.config.knowledge.retrievalTTL,
    })
    options.store.recover()
    if (this.config.storage.retentionDays !== null) options.store.retain(this.config.storage.retentionDays)
    this.selected = options.store.listMeetings({ limit: 1 })[0]?.id
  }

  status(meetingID = this.selected): MeetingView {
    const store = this.options.store
    const meeting = meetingID ? store.getMeeting(meetingID) : undefined
    return {
      meeting,
      meetings: store.listMeetings({ limit: 100 }),
      segments: meeting
        ? store.segments(meeting.id, { after: Math.max(0, store.nextSequence(meeting.id) - 101), limit: 101 })
        : [],
      findings: meeting ? store.findings(meeting.id) : [],
      summary: meeting ? store.checkpoints(meeting.id).at(-1) : undefined,
      plan: meeting ? store.plan(meeting.id) : undefined,
      proposals: meeting ? store.proposals(meeting.id) : [],
      health: this.health,
      audio: {
        ...(this.audio?.stats() ?? { bufferedSeconds: 0, processedSeconds: 0, backlog: 0 }),
        sources: {
          remote: this.active ? "capturing" : "inactive",
          microphone: this.active && this.microphone ? "capturing" : "disabled",
        },
      },
      analysis: (meeting && this.intelligence.states.get(meeting.id)) || { status: "idle" },
      pairing: this.pairing,
      config: this.config,
    }
  }

  control(value: unknown) {
    const input = controlSchema.parse(value)
    if (this.shutdown && !["status", "retry"].includes(input.action)) throw new Error("Meeting runtime is closing")
    if (["status", "transcript", "knowledge-review", "config"].includes(input.action))
      return Promise.resolve(this.status(input.meetingID))
    const pending = this.controlTail.then(
      () => this.mutate(input),
      () => this.mutate(input),
    )
    this.controlTail = pending
    return pending
  }

  private async mutate(input: z.infer<typeof controlSchema>) {
    const store = this.options.store
    const id = input.meetingID ?? this.selected
    if (input.action === "start") {
      if (this.active) throw new Error("Stop the current recording before arming another")
      await this.load()
      const meeting = store.createMeeting({
        id: randomUUID(),
        title: input.title ?? "Meeting",
        sessionID: await this.options.createSession(input.sessionID),
      })
      this.previous.clear()
      this.selected = meeting.id
      return this.status()
    }
    if (input.action === "select") {
      if (!id || !store.getMeeting(id)) throw new Error("Meeting not found")
      this.selected = id
      return this.status()
    }
    if (input.action === "models") return { ...this.status(id), models: await listModels(this.config.transcription) }
    if (input.action === "model-install") {
      if (!input.model || input.authorized !== true)
        throw new Error("Explicit model download authorization is required")
      await installModel(input.model, true, this.config.transcription)
      return this.status(id)
    }
    if (input.action === "configure" || input.action === "model-select") {
      const next = meetingConfigSchema.parse(
        input.action === "configure"
          ? input.config
          : { ...this.config, transcription: { ...this.config.transcription, model: input.model } },
      )
      await this.configure(next)
      return this.status(id)
    }
    if (!id || !store.getMeeting(id)) throw new Error("Select or start a meeting first")
    if (input.action === "stop") {
      await this.stop(id)
      return this.status(id)
    }
    if (input.action === "summary") {
      if (this.active !== id) this.finalizeRecovered(id)
      this.schedule(this.intelligence.analyze(id, this.active !== id), id)
      return this.status(id)
    }
    if (input.action === "reconcile") {
      if (this.active === id) throw new Error("Stop capture before historical reconciliation")
      this.finalizeRecovered(id)
      this.schedule(this.intelligence.analyze(id, true, true), id)
      return this.status(id)
    }
    if (input.action === "plan") {
      this.schedule(this.intelligence.plan(id), id)
      return this.status(id)
    }
    if (input.action === "retry") {
      if (!this.audio || this.active !== id) throw new Error("No retained audio is available for this meeting")
      if (
        !this.shutdown &&
        !(await this.provider?.healthCheck().then(
          (health) => health.healthy,
          () => false,
        ))
      ) {
        await this.provider?.dispose()
        this.provider = undefined
        await this.load()
      }
      await this.audio.drain()
      store.updateMeeting(id, { error: undefined })
      return this.status(id)
    }
    if (input.action === "approve" || input.action === "reject") {
      if (!input.proposalID) throw new Error("Proposal ID is required")
      await this.intelligence.review(id, input.proposalID, input.action === "approve")
      return this.status(id)
    }
    if (input.action === "confirm" || input.action === "reject-finding") {
      const finding = store.findings(id).find((item) => item.id === input.findingID)
      if (!finding) throw new Error("Finding not found")
      store.transaction(() => {
        store.putFinding({ ...finding, status: input.action === "confirm" ? "confirmed" : "rejected" })
        store.putApproval({
          id: randomUUID(),
          meetingID: id,
          targetID: finding.id,
          decision: input.action === "confirm" ? "approve" : "reject",
          detail: finding.summary,
          createdAt: new Date().toISOString(),
        })
      })
      return this.status(id)
    }
    if (input.action === "correct") {
      if (this.active === id || this.intelligence.writing.size)
        throw new Error("Stop capture and finish knowledge writes before correcting evidence")
      await this.intelligence.running.get(id)
      const segment = store.segments(id, { limit: 10000 }).find((item) => item.id === input.segmentID)
      if (!segment || segment.state !== "final" || !input.text?.trim())
        throw new Error("A finalized segment and nonempty correction are required")
      store.transaction(() => {
        store.correctSegment(segment.id, input.text!)
        store
          .findings(id)
          .filter((finding) => finding.sourceSegmentIds.includes(segment.id) && finding.status === "confirmed")
          .forEach((finding) => store.putFinding({ ...finding, status: "unconfirmed" }))
        store
          .proposals(id)
          .filter(
            (proposal) =>
              proposal.sourceSegmentIds.includes(segment.id) &&
              ["pending", "approved", "manual", "failed"].includes(proposal.status),
          )
          .forEach((proposal) =>
            store.putProposal({
              ...proposal,
              status: "stale",
              error: "Supporting transcript was corrected; reconcile and review again",
            }),
          )
        const plan = store.plan(id)
        if (plan?.sourceSegmentIds.includes(segment.id)) store.putPlan({ ...plan, status: "rejected" })
        store.putApproval({
          id: randomUUID(),
          meetingID: id,
          targetID: segment.id,
          decision: "correct",
          detail: input.text!,
          createdAt: new Date().toISOString(),
        })
      })
      const terms = input.text.match(/[A-Za-z][A-Za-z0-9._-]{1,60}/g) ?? []
      this.config = meetingConfigSchema.parse({
        ...this.config,
        vocabulary: {
          ...this.config.vocabulary,
          hints: [...new Set([...this.config.vocabulary.hints, ...terms])].slice(0, 64),
        },
      })
      await this.saveConfig()
      this.schedule(this.intelligence.analyze(id, true, true), id)
      return this.status(id)
    }
    if (input.action === "delete") {
      if (input.confirmed !== true || this.active === id || this.intelligence.running.has(id) || this.work.size)
        throw new Error("Deletion needs confirmation and an idle meeting runtime")
      store.deleteMeeting(id)
      if (this.selected === id) this.selected = undefined
      return this.status()
    }
    return this.status(id)
  }

  private async load() {
    if (this.provider) return
    this.health = { ...this.health, status: "loading", error: undefined }
    const provider = (this.options.providerFactory ?? createProvider)(this.config.transcription)
    try {
      await provider.initialize(this.config.transcription)
      const health = await provider.healthCheck()
      if (!health.healthy) throw new Error("Transcription provider is unhealthy")
      this.provider = provider
      this.health = {
        model: this.config.transcription.model,
        provider: provider.id,
        device: health.metrics?.device ?? this.config.transcription.device,
        status: "ready",
        warning: health.metrics?.warning,
      }
    } catch (error) {
      await provider.dispose()
      this.health = {
        ...this.health,
        status: "error",
        error: "Local speech model could not initialize. Check installation and device configuration.",
      }
      throw error
    }
  }

  async capture(input: CaptureMessage) {
    if (this.shutdown) return { stop: true }
    if (input.type === "heartbeat") {
      const meeting = this.active ? this.options.store.getMeeting(this.active) : undefined
      if (!meeting || meeting.status !== "recording" || meeting.captureID !== input.captureID) return { stop: true }
      this.lastHeartbeat = Date.now()
      return { accepted: true }
    }
    if (this.changing) return { busy: true }
    if (input.type === "start") {
      if (!this.config.streaming.enabled) throw new Error("Enable incremental chunking before live capture")
      if (this.active) {
        if (this.options.store.getMeeting(this.active)?.captureID === input.captureID)
          return { accepted: true, duplicate: true }
        throw new Error("Another capture is already active")
      }
      const meeting = this.selected ? this.options.store.getMeeting(this.selected) : undefined
      if (!meeting || meeting.status !== "ready" || !this.provider)
        throw new Error("Arm a ready meeting in YCoding before capture")
      this.active = meeting.id
      this.microphone = input.microphone
      this.lastHeartbeat = Date.now()
      this.audio = new AudioProcessor({
        chunkSeconds: this.config.transcription.chunkSeconds,
        overlapSeconds: this.config.transcription.overlapSeconds,
        sampleRate: this.config.streaming.sampleRate,
        vad: this.config.streaming.vad,
        maxBufferedSeconds: this.config.streaming.maxBufferedSeconds,
        onChunk: (chunk) => this.transcribe(meeting.id, chunk),
        onGap: () => {
          this.options.store.updateMeeting(meeting.id, {
            error: "Audio discontinuity detected; timestamps preserve the gap",
          })
        },
      })
      this.options.store.updateMeeting(meeting.id, { status: "recording", captureID: input.captureID })
      return { accepted: true }
    }
    const id = this.active
    if (!id || this.options.store.getMeeting(id)?.captureID !== input.captureID) return { stop: true }
    if (input.type === "stop") {
      await this.stop(id)
      return { stop: true }
    }
    if (input.source === "microphone" && !this.microphone) throw new Error("Microphone capture was not enabled")
    const bytes = Buffer.from(input.pcm, "base64")
    const samples = new Float32Array(bytes.length / 4)
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readFloatLE(i * 4)
    try {
      const result = this.audio!.accept({ ...input, samples })
      if (!result.duplicate)
        this.schedule(
          this.audio!.drain().catch((error) => {
            this.options.store.updateMeeting(id, {
              error: "Inference failed; retained audio requires explicit retry before more capture",
            })
            throw error
          }),
          id,
        )
      return { accepted: true, duplicate: result.duplicate }
    } catch (error) {
      if (error instanceof AudioBackpressure) return { busy: true }
      this.options.store.updateMeeting(id, {
        error: "Audio processing failed; partial transcripts retained. Stop and retry pending inference.",
      })
      throw error
    }
  }

  private async transcribe(meetingID: string, chunk: AudioChunk) {
    const store = this.options.store
    const job = store.jobs(meetingID).find((item) => item.id === chunk.id)
    if (job?.status === "done") return
    const attempts = (job?.attempts ?? 0) + 1
    this.finalizeProvisional()
    store.putJob({
      id: chunk.id,
      meetingID,
      kind: "transcription",
      status: "running",
      attempts,
      updatedAt: new Date().toISOString(),
    })
    try {
      const results = await this.infer(chunk)
      store.transaction(() => {
        results.forEach((result, index) => {
          const key = `${meetingID}:${chunk.source}`
          const previous = this.previous.get(key)
          const text = previous
            ? reconcileOverlap(
                { text: previous.text, endMs: previous.endMs },
                { text: result.text, startMs: result.startMs },
              )
            : result.text
          const segment: TranscriptSegment = {
            id: `${chunk.id}:${index}`,
            meetingID,
            sequence: store.nextSequence(meetingID),
            source: chunk.source,
            speakerID: `${chunk.source}-unknown`,
            startMs: result.startMs,
            endMs: result.endMs,
            rawText: result.text,
            text,
            state: "temporary",
            model: this.health.model,
            createdAt: new Date().toISOString(),
          }
          if (!text.trim()) return
          this.finalizeProvisional()
          segment.sequence = store.nextSequence(meetingID)
          store.putSegment(segment)
          this.provisional = segment
          this.previous.set(key, segment)
        })
        store.putJob({
          id: chunk.id,
          meetingID,
          kind: "transcription",
          status: "done",
          attempts,
          updatedAt: new Date().toISOString(),
        })
      })
    } catch (error) {
      store.putJob({
        id: chunk.id,
        meetingID,
        kind: "transcription",
        status: "failed",
        attempts,
        error: "Inference failed; retry while this process retains the audio chunk",
        updatedAt: new Date().toISOString(),
      })
      throw error
    }
  }

  private async infer(chunk: AudioChunk) {
    const hints = this.config.vocabulary.preserveTechnicalTerms ? this.config.vocabulary.hints : []
    try {
      return await this.provider!.transcribe(chunk, { hints })
    } catch (error) {
      const fallback = this.config.fallback
      if (!fallback.enabled || !fallback.provider || !fallback.model || fallback.model === this.health.model)
        throw error
      await this.provider?.dispose()
      this.provider = undefined
      const selected = { ...this.config.transcription, provider: fallback.provider, model: fallback.model }
      const provider = (this.options.providerFactory ?? createProvider)(selected)
      try {
        await provider.initialize(selected)
        const result = await provider.transcribe(chunk, { hints })
        const health = await provider.healthCheck()
        this.provider = provider
        this.health = {
          model: fallback.model,
          provider: fallback.provider,
          device: health.metrics?.device ?? selected.device,
          status: "fallback",
          warning: `The selected model failed; using explicitly configured fallback ${fallback.model}`,
        }
        return result
      } catch (fallbackError) {
        await provider.dispose()
        this.health = {
          ...this.health,
          status: "error",
          error: "Both selected and configured fallback inference failed",
        }
        throw fallbackError
      }
    }
  }

  private finalizeProvisional() {
    const segment = this.provisional
    if (!segment) return
    this.options.store.putSegment({ ...segment, state: "final" })
    this.provisional = undefined
    if (this.config.analysis.incremental && !this.shutdown)
      this.schedule(this.intelligence.analyze(segment.meetingID), segment.meetingID)
  }

  private finalizeRecovered(meetingID: string) {
    this.options.store
      .segments(meetingID, { limit: 10000 })
      .filter((segment) => segment.state === "temporary")
      .forEach((segment) => this.options.store.putSegment({ ...segment, state: "final" }))
  }

  private schedule(promise: Promise<void>, meetingID: string) {
    const observed = promise
      .catch(() => {
        this.intelligence.states.set(meetingID, {
          status: "error",
          error: "Meeting processing failed; retained evidence is available. Retry explicitly.",
        })
      })
      .finally(() => this.work.delete(observed))
    this.work.add(observed)
  }

  async stop(id: string) {
    if (this.active !== id) {
      this.finalizeRecovered(id)
      this.options.store.updateMeeting(id, { status: "stopped" })
      return
    }
    this.changing = true
    this.options.store.updateMeeting(id, { status: "stopping" })
    try {
      await this.audio?.close()
      this.finalizeProvisional()
      this.active = undefined
      this.options.store.updateMeeting(id, { status: "stopped" })
      this.schedule(this.intelligence.analyze(id, true), id)
    } finally {
      this.changing = false
    }
  }

  async expireCapture(now = Date.now()) {
    if (!this.active || now - this.lastHeartbeat < 15000 || this.changing || this.shutdown) return
    const id = this.active
    await this.stop(id)
    this.options.store.updateMeeting(id, {
      status: "interrupted",
      error: "Capture source disconnected. Re-arm and explicitly activate Chrome to record again.",
    })
  }

  private async configure(next: MeetingConfig) {
    if (
      this.active &&
      (JSON.stringify(next.streaming) !== JSON.stringify(this.config.streaming) ||
        next.transcription.chunkSeconds !== this.config.transcription.chunkSeconds ||
        next.transcription.overlapSeconds !== this.config.transcription.overlapSeconds)
    )
      throw new Error("Stop capture before changing streaming configuration")
    this.changing = true
    try {
      await this.settled()
      const recovering = Boolean(this.audio?.stats().error)
      if (!recovering) {
        await this.audio?.flush()
        this.finalizeProvisional()
        await this.settled()
      }
      await this.provider?.dispose()
      this.provider = undefined
      const previous = this.config
      this.config = next
      try {
        await this.load()
      } catch (error) {
        this.config = previous
        await this.load()
        throw error
      }
      this.intelligence.options.bindings = next.knowledge.mcpEnabled ? next.knowledge.bindings : []
      this.intelligence.options.maxCharacters = next.analysis.maxCharacters
      this.intelligence.options.retrievalTTL = next.knowledge.retrievalTTL
      this.intelligence.retrieval.clear()
      await this.saveConfig()
      if (recovering) {
        await this.audio?.flush()
        this.finalizeProvisional()
        if (this.active) this.options.store.updateMeeting(this.active, { error: undefined })
      }
      if (next.storage.retentionDays !== null) this.options.store.retain(next.storage.retentionDays)
    } finally {
      this.changing = false
    }
  }

  private async saveConfig() {
    const file = path.join(this.options.directory, "settings.json")
    await writeFile(`${file}.tmp`, JSON.stringify(this.config, null, 2), { mode: 0o600 })
    await rename(`${file}.tmp`, file)
  }

  async settled() {
    while (this.work.size) await Promise.all(this.work)
  }

  close() {
    return (this.shutdown ??= this.closeOwnedWork())
  }

  private async closeOwnedWork() {
    this.changing = true
    try {
      if (this.active) {
        this.options.store.updateMeeting(this.active, {
          status: "interrupted",
          error: "Recording service stopped. Untranscribed volatile audio is not recoverable after restart.",
        })
        await this.audio?.close()
        this.finalizeProvisional()
      }
    } finally {
      try {
        await this.settled()
        await Promise.allSettled([this.controlTail])
      } finally {
        try {
          await this.provider?.dispose()
        } finally {
          this.options.store.close()
        }
      }
    }
  }
}
