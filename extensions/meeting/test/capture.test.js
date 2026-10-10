import { expect, test } from "bun:test"
import { createCapture } from "../companion/capture.js"
import { createDelivery } from "../companion/delivery.js"

function deferred() {
  const value = {}
  value.promise = new Promise((resolve, reject) => Object.assign(value, { resolve, reject }))
  return value
}

test("delivery retains identical payload after unknown ACK and pressure; one request in flight", async () => {
  const gate = deferred()
  const attempts = []
  let inFlight = 0
  let maximum = 0
  const states = []
  const delivery = createDelivery({
    url: "http://127.0.0.1:1234",
    token: "capture-credential",
    fetch: async (_, options) => {
      inFlight++
      maximum = Math.max(maximum, inFlight)
      attempts.push(options.body)
      if (attempts.length === 1) {
        await gate.promise
        inFlight--
        throw new Error("network")
      }
      inFlight--
      return new Response("{}", { status: attempts.length === 2 ? 429 : 200 })
    },
    wait: async () => {},
    onState: (state) => states.push(state),
    onFailure: () => {},
  })
  const audio = { type: "audio", sequence: 0, pcm: "AAAAAA==" }
  const first = delivery.send(audio)
  const second = delivery.send({ ...audio, sequence: 1 })
  gate.resolve()
  await Promise.all([first, second])
  expect(attempts.slice(0, 3)).toEqual(Array.from({ length: 3 }, () => JSON.stringify(audio)))
  expect(JSON.parse(attempts[3]).sequence).toBe(1)
  expect(maximum).toBe(1)
  expect(states).toContain("reconnecting")
  delivery.close()
})

test("delivery fails visibly on finite reconnect exhaustion, permanent rejection and queue overflow", async () => {
  const failures = []
  let attempts = 0
  const exhausted = createDelivery({
    url: "http://127.0.0.1:1234",
    token: "capture",
    fetch: async () => {
      attempts++
      throw new Error("offline")
    },
    wait: async () => {},
    onState: () => {},
    onFailure: (reason) => failures.push(reason),
  })
  await expect(exhausted.send({ type: "heartbeat" })).rejects.toThrow("reconnect_exhausted")
  expect(attempts).toBe(4)
  const rejected = createDelivery({
    url: "http://127.0.0.1:1234",
    token: "capture",
    fetch: async () => new Response("{}", { status: 401 }),
    wait: async () => {},
    onState: () => {},
    onFailure: (reason) => failures.push(reason),
  })
  await expect(rejected.send({ type: "heartbeat" })).rejects.toThrow("pairing_expired")
  const blocked = deferred()
  const full = createDelivery({
    url: "http://127.0.0.1:1234",
    token: "capture",
    fetch: async () => blocked.promise,
    wait: async () => {},
    onState: () => {},
    onFailure: (reason) => failures.push(reason),
  })
  const pending = Array.from({ length: 33 }, () => full.send({ type: "audio" }).catch((error) => error.message))
  expect(await pending[32]).toBe("queue_overflow")
  blocked.resolve(new Response("{}"))
  expect(await Promise.all(pending)).toEqual(Array.from({ length: 33 }, () => "queue_overflow"))
  expect(failures).toEqual(["reconnect_exhausted", "pairing_expired", "queue_overflow"])
})

test("delivery retries the identical sequence after a truncated successful response body", async () => {
  const attempts = []
  const delivery = createDelivery({
    url: "http://127.0.0.1:1234",
    token: "capture",
    fetch: async (_, options) => {
      attempts.push(options.body)
      return attempts.length === 1
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("connection closed before body"))
              },
            }),
          )
        : Response.json({ accepted: true, duplicate: true })
    },
    wait: async () => {},
    onState: () => {},
    onFailure: () => {},
  })
  const audio = { type: "audio", sequence: 2, pcm: "AAAAAA==" }
  await delivery.send(audio)
  expect(attempts).toEqual([JSON.stringify(audio), JSON.stringify(audio)])
  delivery.close()
})

function fixture({ denyMicrophone = false, pendingMedia, response } = {}) {
  const tracks = []
  const sources = []
  const nodes = []
  const contexts = []
  const constraints = []
  const sent = []
  const states = []
  const stream = () => {
    const track = {
      stopped: false,
      listeners: {},
      stop() {
        this.stopped = true
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn
      },
      removeEventListener(type) {
        delete this.listeners[type]
      },
    }
    tracks.push(track)
    return { getTracks: () => [track], getAudioTracks: () => [track] }
  }
  class Context {
    sampleRate = 48000
    state = "running"
    destination = { type: "destination" }
    audioWorklet = { addModule: async () => {} }
    constructor() {
      contexts.push(this)
    }
    createMediaStreamSource(media) {
      const source = {
        media,
        connections: [],
        connect(destination) {
          this.connections.push(destination)
        },
        disconnect() {
          this.disconnected = true
        },
      }
      sources.push(source)
      return source
    }
    async resume() {}
    async close() {
      this.state = "closed"
    }
  }
  class Worklet {
    listeners = {}
    constructor(_, __, options) {
      this.source = options.processorOptions.source
      this.port = {
        onmessage: undefined,
        postMessage: () => {
          this.port.onmessage?.({ data: { type: "flushed" } })
        },
        close: () => {
          this.port.closed = true
        },
      }
      nodes.push(this)
    }
    connect() {}
    disconnect() {
      this.disconnected = true
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener
    }
    removeEventListener(type) {
      delete this.listeners[type]
    }
  }
  const capture = createCapture({
    mediaDevices: {
      getUserMedia: async (constraint) => {
        constraints.push(constraint)
        if (pendingMedia) return pendingMedia.promise
        if (constraints.length === 2 && denyMicrophone) throw new Error("denied")
        return stream()
      },
    },
    AudioContext: Context,
    AudioWorkletNode: Worklet,
    fetch: async (_, options) => {
      const message = JSON.parse(options.body)
      sent.push(message)
      return response ? response(message) : new Response("{}")
    },
    workletURL: "worklet.js",
    onState: (state) => states.push(state),
    wait: async () => {},
  })
  const options = {
    url: "http://127.0.0.1:1234",
    token: "capture",
    captureID: "c",
    tabID: 2,
    streamID: "chrome-stream",
    consent: true,
    microphone: false,
  }
  return { capture, tracks, sources, nodes, contexts, constraints, sent, states, options, stream }
}

test("explicit consent start preserves tab playback, separates microphone and cleans all resources on stop", async () => {
  const f = fixture()
  await expect(f.capture.start({ ...f.options, consent: false })).rejects.toThrow("consent_required")
  expect(f.constraints).toEqual([])
  await f.capture.start({ ...f.options, microphone: true })
  expect(f.constraints[0].audio.mandatory).toEqual({ chromeMediaSource: "tab", chromeMediaSourceId: "chrome-stream" })
  expect(f.constraints[1].audio.echoCancellation).toBe(true)
  expect(f.sources[0].connections).toContain(f.contexts[0].destination)
  expect(f.sources[1].connections).not.toContain(f.contexts[0].destination)
  f.nodes[0].port.onmessage({
    data: {
      type: "audio",
      source: "remote",
      sequence: 0,
      startMs: 0,
      sampleRate: 48000,
      samples: new Float32Array([0, 1, -1]).buffer,
    },
  })
  await f.capture.stop("user")
  expect(f.sent.map((message) => message.type)).toEqual(["start", "audio", "stop"])
  expect(f.sent[1].source).toBe("remote")
  expect(f.sent[2].reason).toBe("user")
  expect(f.tracks.every((track) => track.stopped)).toBe(true)
  expect(f.contexts.every((context) => context.state === "closed")).toBe(true)
  expect(f.nodes.every((node) => node.disconnected && node.port.closed)).toBe(true)
  expect(f.sources.every((source) => source.disconnected)).toBe(true)
})

test("microphone denial and track ended stop capture with visible errors and no leaked tab audio", async () => {
  const denied = fixture({ denyMicrophone: true })
  await expect(denied.capture.start({ ...denied.options, microphone: true })).rejects.toThrow("microphone_denied")
  expect(denied.tracks.every((track) => track.stopped)).toBe(true)
  expect(denied.contexts.every((context) => context.state === "closed")).toBe(true)
  const ended = fixture()
  await ended.capture.start(ended.options)
  await ended.tracks[0].listeners.ended()
  expect(ended.tracks[0].stopped).toBe(true)
  expect(ended.sent.at(-1)).toMatchObject({ type: "stop", reason: "track_ended" })
})

test("stop during getUserMedia cancels start and disposes late tracks without auto resume", async () => {
  const pending = deferred()
  const f = fixture({ pendingMedia: pending })
  const starting = f.capture.start(f.options).catch((error) => error.message)
  await f.capture.stop("tab_closed")
  pending.resolve(f.stream())
  expect(await starting).toBe("capture_cancelled")
  expect(f.tracks[0].stopped).toBe(true)
  expect(f.sent).toEqual([])
})

test("heartbeat bypasses blocked audio delivery and backend stop releases resources immediately", async () => {
  const blocked = deferred()
  const f = fixture({
    response: (message) =>
      message.type === "audio"
        ? blocked.promise
        : Response.json(message.type === "heartbeat" ? { stop: true } : { accepted: true }),
  })
  await f.capture.start(f.options)
  f.nodes[0].port.onmessage({
    data: {
      type: "audio",
      source: "remote",
      sequence: 0,
      startMs: 0,
      sampleRate: 48000,
      samples: new Float32Array([0]).buffer,
    },
  })
  await f.capture.heartbeat()
  expect(f.sent.map((message) => message.type)).toEqual(["start", "audio", "heartbeat"])
  expect(f.tracks.every((track) => track.stopped)).toBe(true)
  expect(f.contexts[0].state).toBe("closed")
  blocked.resolve(Response.json({ accepted: true }))
  await f.capture.stop("backend_stopped")
})

test("AudioWorklet processor failure stops recording visibly and releases all audio resources", async () => {
  const f = fixture()
  await f.capture.start(f.options)
  expect(typeof f.nodes[0].listeners.processorerror).toBe("function")
  await f.nodes[0].listeners.processorerror()
  expect(f.tracks.every((track) => track.stopped)).toBe(true)
  expect(f.nodes.every((node) => node.port.closed && node.disconnected)).toBe(true)
  expect(f.sources.every((source) => source.disconnected)).toBe(true)
  expect(f.contexts[0].state).toBe("closed")
  expect(f.sent.at(-1)).toMatchObject({ type: "stop", reason: "audio_processor_failed" })
  expect(f.states.at(-1)).toMatchObject({ phase: "error", reason: "audio_processor_failed" })
})

test("a backend stop during Start preserves its allow-listed reason and releases resources", async () => {
  const f = fixture({ response: () => Response.json({ stop: true, reason: "inference_failed" }) })
  await expect(f.capture.start(f.options)).rejects.toThrow("inference_failed")
  expect(f.tracks.every((track) => track.stopped)).toBe(true)
  expect(f.contexts[0].state).toBe("closed")
  expect(f.states.at(-1)).toMatchObject({ phase: "error", reason: "inference_failed" })
  expect(f.states.some((state) => state.reason === "capture_cancelled")).toBe(false)
})

test("backend stop without a known reason falls back to backend_stopped, not exception text", async () => {
  const f = fixture({ response: () => Response.json({ stop: true, reason: "private callback exception" }) })
  await expect(f.capture.start(f.options)).rejects.toThrow("backend_stopped")
  expect(f.states.at(-1)).toMatchObject({ phase: "stopped", reason: "backend_stopped" })
})
