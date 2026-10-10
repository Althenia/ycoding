import { createDelivery } from "./delivery.js"
import { backendStopReason } from "./protocol.js"

export function createCapture(environment) {
  const state = { session: undefined }
  const notify = (session, phase, reason) =>
    environment.onState({ phase, reason, captureID: session.options.captureID })
  const dispose = async (session) => {
    session.streams.forEach((stream) =>
      stream.getTracks().forEach((track) => {
        track.removeEventListener("ended", session.ended)
        track.stop()
      }),
    )
    session.nodes.forEach((node) => {
      node.removeEventListener("processorerror", session.processorFailed)
      node.port.onmessage = null
      node.port.close()
      node.disconnect()
    })
    session.sources.forEach((source) => source.disconnect())
    if (session.context)
      await session.context.close().catch(() => {
        notify(session, "error", "audio_cleanup_failed")
      })
  }
  const stop = async (reason = "user") => {
    const session = state.session
    if (!session) return undefined
    if (session.stopping) return session.stopping
    session.cancelled = true
    if (session.backendStopped) {
      session.acceptAudio = false
      session.delivery.close()
      session.liveness.close()
    }
    session.stopping = (async () => {
      if (session.started && !session.failure && !session.backendStopped) {
        const flushed = await Promise.all(
          session.nodes.map(
            (node) =>
              new Promise((resolve) => {
                const timer = setTimeout(() => resolve(false), 1000)
                session.flushes.set(node, () => {
                  clearTimeout(timer)
                  resolve(true)
                })
                node.port.postMessage({ type: "flush" })
              }),
          ),
        )
        if (flushed.some((value) => !value)) session.failure = "audio_flush_failed"
      }
      session.acceptAudio = false
      clearInterval(session.heartbeat)
      await dispose(session)
      if (session.admitted && !session.failure && !session.backendStopped) {
        await session.delivery.send({ type: "stop", captureID: session.options.captureID, reason }).catch((error) => {
          session.failure = error.message
        })
      }
      if (session.admitted && session.failure && !session.backendStopped) {
        session.delivery.close()
        const final = createDelivery({
          ...session.options,
          fetch: environment.fetch,
          wait: environment.wait,
          onState: () => {},
          onFailure: () => {},
        })
        await final.send({ type: "stop", captureID: session.options.captureID, reason: session.failure }).catch(() => {
          session.failure = "stop_unacknowledged"
        })
        final.close()
      }
      session.delivery.close()
      session.liveness.close()
      if (state.session === session) state.session = undefined
      notify(session, session.failure ? "error" : "stopped", session.failure ?? reason)
    })()
    return session.stopping
  }
  const start = async (options) => {
    if (options.consent !== true) throw new Error("consent_required")
    if (state.session) throw new Error("capture_already_active")
    const session = {
      options,
      streams: [],
      nodes: [],
      sources: [],
      flushes: new Map(),
      context: undefined,
      cancelled: false,
      admitted: false,
      started: false,
      acceptAudio: false,
      failure: undefined,
      stopping: undefined,
      heartbeat: undefined,
      heartbeatSending: false,
      backendStopped: false,
      stopReason: undefined,
      ended: () => stop("track_ended"),
      processorFailed: () => {
        session.failure = "audio_processor_failed"
        notify(session, "error", session.failure)
        return stop(session.failure)
      },
    }
    state.session = session
    const onStop = (reason) => {
      session.backendStopped = true
      session.stopReason = backendStopReason(reason)
      if (session.stopReason === "inference_failed") session.failure = session.stopReason
      void stop(session.stopReason)
    }
    const onFailure = (reason) => {
      session.failure = reason
      notify(session, "error", reason)
      if (session.admitted) void stop(reason)
    }
    session.delivery = createDelivery({
      ...options,
      fetch: environment.fetch,
      wait: environment.wait,
      onStop,
      onState: (phase) => {
        if (session.started && !session.cancelled) notify(session, phase === "connected" ? "capturing" : phase)
      },
      onFailure,
    })
    session.liveness = createDelivery({
      ...options,
      fetch: environment.fetch,
      wait: environment.wait,
      onStop,
      onState: () => {},
      onFailure,
    })
    const acquire = async (constraints, failure) => {
      const stream = await environment.mediaDevices.getUserMedia(constraints).catch(() => {
        throw new Error(failure)
      })
      if (session.cancelled) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error("capture_cancelled")
      }
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error("missing_audio_track")
      }
      session.streams.push(stream)
      stream.getTracks().forEach((track) => track.addEventListener("ended", session.ended))
      return stream
    }
    const check = () => {
      if (session.cancelled) throw new Error(session.stopReason ?? "capture_cancelled")
    }
    notify(session, "starting")
    try {
      const remote = await acquire(
        { audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: options.streamID } }, video: false },
        "tab_capture_denied",
      )
      const microphone = options.microphone
        ? await acquire(
            {
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
              video: false,
            },
            "microphone_denied",
          )
        : undefined
      check()
      session.context = new environment.AudioContext()
      if (session.context.sampleRate < 8000 || session.context.sampleRate > 192000)
        throw new Error("unsupported_sample_rate")
      await session.context.audioWorklet.addModule(environment.workletURL)
      check()
      session.admitted = true
      await session.delivery.send({
        type: "start",
        captureID: options.captureID,
        tabID: options.tabID,
        microphone: options.microphone,
        consent: true,
      })
      session.started = true
      check()
      session.acceptAudio = true
      for (const [sourceName, stream] of [
        ["remote", remote],
        ["microphone", microphone],
      ]) {
        if (!stream) continue
        const source = session.context.createMediaStreamSource(stream)
        const node = new environment.AudioWorkletNode(session.context, "meeting-pcm", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { source: sourceName },
        })
        session.sources.push(source)
        session.nodes.push(node)
        node.addEventListener("processorerror", session.processorFailed)
        node.port.onmessage = (event) => {
          if (event.data.type === "flushed") {
            session.flushes.get(node)?.()
            return
          }
          if (!session.acceptAudio || event.data.type !== "audio") return
          const data = event.data
          const bytes = new Uint8Array(data.samples.byteLength)
          const view = new DataView(bytes.buffer)
          new Float32Array(data.samples).forEach((sample, index) => view.setFloat32(index * 4, sample, true))
          const encoded = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")
          void session.delivery
            .send({
              type: "audio",
              captureID: options.captureID,
              source: data.source,
              sequence: data.sequence,
              startMs: data.startMs,
              sampleRate: data.sampleRate,
              pcm: btoa(encoded),
            })
            .catch(() => {})
        }
        source.connect(node)
        node.connect(session.context.destination)
        if (sourceName === "remote") source.connect(session.context.destination)
      }
      await session.context.resume()
      check()
      session.heartbeat = setInterval(() => {
        void heartbeat()
      }, 5000)
      notify(session, "capturing")
    } catch (error) {
      if (!session.cancelled)
        session.failure = [
          "microphone_denied",
          "tab_capture_denied",
          "unsupported_sample_rate",
          "missing_audio_track",
          "pairing_expired",
          "reconnect_exhausted",
          "capture_rejected",
        ].includes(error.message)
          ? error.message
          : "capture_failed"
      await stop(session.failure ?? "capture_cancelled")
      throw new Error(
        session.stopReason ??
          (session.cancelled && !session.failure ? "capture_cancelled" : (session.failure ?? "capture_failed")),
      )
    }
  }
  const heartbeat = async () => {
    const session = state.session
    if (!session?.started || session.cancelled || session.heartbeatSending) return
    session.heartbeatSending = true
    await session.liveness.send({ type: "heartbeat", captureID: session.options.captureID }).catch(() => {})
    session.heartbeatSending = false
  }
  return { start, stop, heartbeat, active: () => state.session !== undefined }
}
