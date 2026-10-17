import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { describeView, formatSeconds, questionError, readCredentials } from "../view/model.js"
import { createCapture } from "../view/capture.js"
import { createDelivery } from "../view/delivery.js"

describe("Meeting Passage live view-model", () => {
  test("requires the view credential only in a single canonical fragment field", () => {
    const key = "a".repeat(64)
    expect(readCredentials(`#key=${key}`)).toEqual({ key })
    for (const hash of ["", "#key=short", `#key=${key}&key=${key}`, `#key=${key}&token=other`])
      expect(readCredentials(hash)).toBeUndefined()
  })

  test("unknown metrics remain unreported, while actual zero retains its unit", () => {
    expect(formatSeconds(undefined)).toBe("Unreported")
    expect(formatSeconds(null)).toBe("Unreported")
    expect(formatSeconds(Number.NaN)).toBe("Unreported")
    expect(formatSeconds(-1)).toBe("Unreported")
    expect(formatSeconds(0)).toBe("0.0 s")
    expect(formatSeconds(12.34)).toBe("12.3 s")
  })

  test("uses runtime statuses for armed, recording, finalizing and summary-ready views", () => {
    expect(describeView({ meeting: { status: "ready" } }).status).toBe("Ready · nothing is recording")
    expect(describeView({ meeting: { status: "recording" } }).status).toBe("REC · Recording")
    expect(describeView({ meeting: { status: "stopping" } }).status).toBe("Finalizing audio")
    expect(describeView({ meeting: { status: "stopped" }, analysis: { status: "running" } }).status).toBe(
      "Finalizing analysis",
    )
    expect(describeView({ meeting: { status: "stopped" }, summary: { final: true, summary: "Ready" } }).status).toBe(
      "Summary ready",
    )
    expect(describeView({}).status).toBe("Waiting for a meeting")
  })

  test("failed inference exposes retained-audio recovery without claiming capture is active", () => {
    const view = describeView({
      meeting: { status: "stopped", error: "inference_failed" },
      health: { status: "error", error: "inference_failed" },
      audio: { backlog: 2, error: "inference_failed", sources: { remote: "inactive", microphone: "disabled" } },
    })
    expect(view.status).toBe("Capture stopped · audio failed")
    expect(view.canRetry).toBe(true)
    expect(view.canStop).toBe(false)
    expect(view.notice).toContain("Retry failed audio")
    expect(view.notice).toContain("fresh consent")
  })

  test("analysis errors have terminal guidance, not an invented view action", () => {
    const view = describeView({
      meeting: { status: "stopped" },
      analysis: { status: "error", error: "Analysis failed" },
    })
    expect(view.status).toBe("Analysis failed")
    expect(view.canRetry).toBe(false)
    expect(view.notice).toContain("/meeting summary")
    const recording = describeView({ meeting: { status: "recording" }, analysis: { status: "error" } })
    expect(recording.status).toBe("REC · Recording")
    expect(recording.tone).toBe("error")
    expect(recording.notice).toContain("Analysis failed")
  })

  test("reported backlog/health warnings mark degradation; absence does not become zero", () => {
    expect(describeView({ meeting: { status: "recording" }, audio: { backlog: 3 } }).tone).toBe("warning")
    expect(describeView({ health: { status: "ready", warning: "CPU fallback" } }).health).toBe("Degraded")
    const unknown = describeView({})
    expect(unknown.buffered).toBe("Unreported")
    expect(unknown.backlog).toBe("Unreported")
    expect(unknown.lag).toBe("Unreported")
    expect(unknown.remote).toBe("Unreported")
    expect(describeView({ audio: { bufferedSeconds: 12, processedSeconds: 30, backlog: 2 } }).lag).toBe("Unreported")
  })

  test("advisory chat maps reachable server errors into actionable local feedback", () => {
    expect(questionError("busy")).toContain("one question")
    expect(questionError("no_transcript")).toContain("transcript")
    expect(questionError("select_meeting")).toContain("meeting")
    expect(questionError("answer_failed")).toContain("Retry")
  })
})

function captureFixture(
  options: {
    noAudio?: boolean
    cancel?: boolean
    micDenied?: boolean
    micBlocked?: boolean
    response?: (message: Record<string, unknown>) => Response
  } = {},
) {
  const tracks: ReturnType<typeof track>[] = []
  const messages: Record<string, unknown>[] = []
  const phases: string[] = []
  const reasons: (string | undefined)[] = []
  const constraints: Record<string, unknown>[] = []
  const sources: { connections: unknown[]; disconnected: boolean }[] = []
  function track() {
    const listeners = new Map<string, () => void>()
    return {
      stopped: false,
      stop() {
        this.stopped = true
      },
      addEventListener(type: string, listener: () => void) {
        listeners.set(type, listener)
      },
      removeEventListener(type: string) {
        listeners.delete(type)
      },
      end() {
        listeners.get("ended")?.()
      },
    }
  }
  function stream() {
    const item = track()
    tracks.push(item)
    return { getTracks: () => [item], getAudioTracks: () => (options.noAudio ? [] : [item]) }
  }
  class Context {
    sampleRate = 48000
    destination = {}
    audioWorklet = { addModule: async () => {} }
    createMediaStreamSource() {
      const source = {
        connections: [] as unknown[],
        disconnected: false,
        connect(value: unknown) {
          this.connections.push(value)
        },
        disconnect() {
          this.disconnected = true
        },
      }
      sources.push(source)
      return source
    }
    async resume() {}
    async close() {}
  }
  const nodes: Worklet[] = []
  class Worklet {
    port: {
      onmessage:
        | ((event: {
            data:
              | {
                  type: "audio"
                  source: string
                  sequence: number
                  startMs: number
                  sampleRate: number
                  samples: ArrayBuffer
                }
              | { type: "flushed" }
          }) => void)
        | null
      postMessage: () => void
      close: () => void
    } = { onmessage: null, postMessage: () => this.port.onmessage?.({ data: { type: "flushed" } }), close: () => {} }
    constructor() {
      nodes.push(this)
    }
    connect() {}
    disconnect() {}
    addEventListener() {}
    removeEventListener() {}
    emit(source: string, sequence: number) {
      this.port.onmessage?.({
        data: {
          type: "audio",
          source,
          sequence,
          startMs: sequence * 250,
          sampleRate: 48000,
          samples: new Float32Array([0.5, -0.25]).buffer,
        },
      })
    }
  }
  const stopped = Promise.withResolvers<void>()
  const capture = createCapture({
    mediaDevices: {
      getDisplayMedia: async (value) => {
        constraints.push(value)
        if (options.cancel) throw new DOMException("Cancelled", "NotAllowedError")
        return stream()
      },
      getUserMedia: async () => {
        if (options.micDenied) throw new DOMException("Denied", "NotAllowedError")
        return stream()
      },
    },
    AudioContext: Context,
    AudioWorkletNode: Worklet,
    microphonePermission: async () => (options.micBlocked ? "denied" : "prompt"),
    fetch: async (_url, request) => {
      messages.push(JSON.parse(String(request.body)))
      return (
        options.response?.(messages.at(-1)!) ??
        Response.json(messages.at(-1)?.type === "stop" ? { stop: true } : { accepted: true })
      )
    },
    wait: async () => {},
    workletURL: "/view/worklet.js",
    onState: (value) => {
      phases.push(value.phase)
      reasons.push(value.reason)
      if (value.phase === "stopped" || value.phase === "error") stopped.resolve()
    },
  })
  return {
    capture,
    stream,
    tracks,
    messages,
    phases,
    reasons,
    constraints,
    sources,
    nodes,
    stopped: stopped.promise,
    start: { key: "view", captureID: "c", consent: true, policy: true, microphone: false },
  }
}

test("page capture requires both fresh acknowledgements before invoking the picker", async () => {
  const f = captureFixture()
  await expect(f.capture.start({ ...f.start, consent: false })).rejects.toThrow("consent_required")
  await expect(f.capture.start({ ...f.start, policy: false })).rejects.toThrow("consent_required")
  expect(f.constraints).toEqual([])
  expect(f.messages).toEqual([])
})

test("no tab audio and picker cancellation release tracks without admitting capture", async () => {
  for (const options of [{ noAudio: true }, { cancel: true }]) {
    const f = captureFixture(options)
    await expect(f.capture.start(f.start)).rejects.toThrow(options.noAudio ? "no_tab_audio" : "picker_cancelled")
    expect(f.tracks.every((item) => item.stopped)).toBe(true)
    expect(f.capture.active()).toBe(false)
    expect(f.messages).toEqual([])
  }
})

test("microphone denied and blocked never silently start tab-only recording", async () => {
  for (const options of [{ micDenied: true }, { micBlocked: true }]) {
    const f = captureFixture(options)
    await expect(f.capture.start({ ...f.start, microphone: true })).rejects.toThrow(
      options.micDenied ? "microphone_denied" : "microphone_blocked",
    )
    expect(f.phases).toContain(options.micDenied ? "microphone_prompt" : "microphone_blocked")
    expect(f.tracks.every((item) => item.stopped)).toBe(true)
    expect(f.messages).toEqual([])
  }
})

test("capture sends both sources in order as float32LE and stops on Chrome track ended", async () => {
  const f = captureFixture()
  await f.capture.start({ ...f.start, microphone: true })
  expect(f.constraints[0]).toMatchObject({ video: true, audio: true })
  expect(f.messages[0]).toEqual({ type: "start", captureID: "c", microphone: true, consent: true })
  expect(f.phases).toContain("microphone_allowed")
  expect(f.sources.every((source) => source.connections.length === 1)).toBe(true)
  f.nodes[0].emit("remote", 0)
  f.nodes[1].emit("microphone", 0)
  f.nodes[0].emit("remote", 1)
  await f.capture.heartbeat()
  f.tracks[0].end()
  await f.stopped
  expect(
    f.messages.filter((value) => value.type === "audio").map((value) => [value.source, value.sequence, value.startMs]),
  ).toEqual([
    ["remote", 0, 0],
    ["microphone", 0, 0],
    ["remote", 1, 250],
  ])
  const audio = f.messages.find((value) => value.type === "audio")!
  expect(Buffer.from(String(audio.pcm), "base64").readFloatLE(0)).toBe(0.5)
  expect(Buffer.from(String(audio.pcm), "base64").readFloatLE(4)).toBe(-0.25)
  expect(f.messages.at(-1)).toEqual({ type: "stop", captureID: "c", reason: "track_ended" })
  expect(f.tracks.every((item) => item.stopped)).toBe(true)
  expect(f.sources.every((source) => source.disconnected)).toBe(true)
  const count = f.messages.length
  await f.capture.heartbeat()
  expect(f.messages.length).toBe(count)
})

test("page hide releases sources and liveness without an unreliable unload mutation", async () => {
  const f = captureFixture()
  await f.capture.start(f.start)
  f.capture.leave()
  await f.capture.heartbeat()
  expect(f.tracks.every((item) => item.stopped)).toBe(true)
  expect(f.messages.map((value) => value.type)).toEqual(["start"])
  expect(f.capture.active()).toBe(false)
})

test("Stop publishes finalizing immediately rather than claiming live capture while it flushes", async () => {
  const f = captureFixture()
  await f.capture.start(f.start)
  const stopping = f.capture.stop("user")
  expect(f.phases.at(-1)).toBe("stopping")
  await stopping
  expect(f.reasons.at(-1)).toBe("user")
})

test("backend inference failure is retained through Start settlement and live audio without another stop mutation", async () => {
  for (const boundary of ["start", "audio"]) {
    const f = captureFixture({
      response: (message) =>
        Response.json(message.type === boundary ? { stop: true, reason: "inference_failed" } : { accepted: true }),
    })
    if (boundary === "start") await expect(f.capture.start(f.start)).rejects.toThrow("inference_failed")
    if (boundary === "audio") {
      await f.capture.start(f.start)
      f.nodes[0].emit("remote", 0)
    }
    await f.stopped
    expect(f.reasons.at(-1)).toBe("inference_failed")
    expect(f.tracks.every((item) => item.stopped)).toBe(true)
    expect(f.messages.some((message) => message.type === "stop")).toBe(false)
    expect(f.capture.active()).toBe(false)
  }
})

test("delivery retries only explicit unaccepted busy, preserves frame ordering and accepts duplicate ACK", async () => {
  const attempts: string[] = []
  const gate = Promise.withResolvers<void>()
  const delivery = createDelivery({
    key: "view",
    fetch: async (url, options) => {
      expect(url).toBe("/view/capture")
      expect(options.credentials).toBe("omit")
      attempts.push(String(options.body))
      if (attempts.length === 1) {
        await gate.promise
        return Response.json({ error: "busy" }, { status: 429 })
      }
      return Response.json({ accepted: true, duplicate: true })
    },
    wait: async () => {},
    onFailure: () => {},
    onState: () => {},
  })
  const first = delivery.send({ type: "audio", sequence: 0 })
  const second = delivery.send({ type: "audio", sequence: 1 })
  expect(attempts.length).toBe(1)
  gate.resolve()
  await Promise.all([first, second])
  expect(attempts.map((value) => JSON.parse(value).sequence)).toEqual([0, 0, 1])
  delivery.close()
})

test("unknown ACK/network/5xx and unauthorized never replay; backpressure retries are bounded", async () => {
  for (const failure of ["network", "malformed", "server", "unauthorized", "busy"]) {
    let attempts = 0
    const reasons: string[] = []
    const delivery = createDelivery({
      key: "view",
      fetch: async () => {
        attempts++
        if (failure === "network") throw new Error("lost")
        if (failure === "malformed") return new Response("{}")
        return Response.json(
          { error: failure === "busy" ? "busy" : "failed" },
          { status: failure === "busy" ? 429 : failure === "unauthorized" ? 401 : 500 },
        )
      },
      wait: async () => {},
      onState: () => {},
      onFailure: (reason) => reasons.push(reason),
    })
    await expect(delivery.send({ type: "audio", sequence: 0 })).rejects.toThrow()
    expect(attempts).toBe(failure === "busy" ? 4 : 1)
    expect(reasons).toEqual([
      failure === "busy" ? "backpressure_exhausted" : failure === "unauthorized" ? "unauthorized" : "delivery_unknown",
    ])
  }
})

test("queue overflow rejects pending frames rather than dropping audio", async () => {
  const gate = Promise.withResolvers<Response>()
  const failures: string[] = []
  const delivery = createDelivery({
    key: "view",
    fetch: async () => gate.promise,
    wait: async () => {},
    onState: () => {},
    onFailure: (reason) => failures.push(reason),
  })
  const pending = Array.from({ length: 33 }, (_, sequence) =>
    delivery.send({ type: "audio", sequence }).catch((error: Error) => error.message),
  )
  gate.resolve(Response.json({ accepted: true }))
  expect(await Promise.all(pending)).toEqual(Array.from({ length: 33 }, () => "queue_overflow"))
  expect(failures).toEqual(["queue_overflow"])
})

test("actual AudioWorklet produces quarter-second monotonic frames and flushes the remainder with silent output", async () => {
  const frames: { type: string; sequence: number; startMs: number; samples: ArrayBuffer }[] = []
  type Processor = {
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean
    port: { onmessage: (event: { data: { type: string } }) => void }
  }
  let Processor: (new (options: { processorOptions: { source: string } }) => Processor) | undefined
  runInNewContext(await Bun.file(new URL("../view/worklet.js", import.meta.url)).text(), {
    sampleRate: 16000,
    Float32Array,
    AudioWorkletProcessor: class {
      port = { postMessage: (frame: (typeof frames)[number]) => frames.push(frame) }
    },
    registerProcessor: (_name: string, value: NonNullable<typeof Processor>) => {
      Processor = value
    },
  })
  if (!Processor) throw new Error("Processor did not register")
  const processor = new Processor({ processorOptions: { source: "remote" } })
  const output = new Float32Array(128).fill(1)
  for (let index = 0; index < 64; index++) processor.process([[new Float32Array(128).fill(0.5)]], [[output]])
  processor.port.onmessage({ data: { type: "flush" } })
  expect(output.every((sample) => sample === 0)).toBe(true)
  const audio = frames.filter((frame) => frame.type === "audio")
  expect(audio.map((frame) => [frame.sequence, frame.startMs, frame.samples.byteLength / 4])).toEqual([
    [0, 0, 4000],
    [1, 250, 4000],
    [2, 500, 192],
  ])
  expect(frames.at(-1)?.type).toBe("flushed")
  expect(processor.process([[]], [[output]])).toBe(false)
})
