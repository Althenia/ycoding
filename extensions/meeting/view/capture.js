import { createDelivery } from "./delivery.js"

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
        session.failure = "audio_cleanup_failed"
      })
  }
  const stop = async (reason = "user") => {
    const session = state.session
    if (!session) return
    if (session.stopping) {
      await session.stopping
      return
    }
    session.cancelled = true
    clearInterval(session.heartbeat)
    notify(session, "stopping", reason)
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
      await dispose(session)
      if (session.admitted && !session.backendStopped) {
        const final = session.failure
          ? createDelivery({
              key: session.options.key,
              fetch: environment.fetch,
              wait: environment.wait,
              onState: () => {},
              onFailure: () => {},
            })
          : session.delivery
        if (session.failure) session.delivery.close()
        await final
          .send({ type: "stop", captureID: session.options.captureID, reason: session.failure ?? reason })
          .catch(() => {
            session.failure = "stop_unacknowledged"
          })
        final.close()
      }
      session.delivery.close()
      session.liveness.close()
      if (state.session === session) state.session = undefined
      notify(session, session.failure ? "error" : "stopped", session.failure ?? reason)
    })()
    await session.stopping
  }
  const start = async (options) => {
    if (options.consent !== true || options.policy !== true) throw new Error("consent_required")
    if (state.session) throw new Error("capture_already_active")
    const session = {
      options,
      streams: [],
      nodes: [],
      sources: [],
      flushes: new Map(),
      cancelled: false,
      admitted: false,
      started: false,
      acceptAudio: false,
      failure: undefined,
      stopping: undefined,
      context: undefined,
      heartbeat: undefined,
      heartbeatSending: false,
      backendStopped: false,
      ended: () => {
        void stop("track_ended")
      },
      processorFailed: () => {
        session.failure = "audio_processor_failed"
        void stop(session.failure)
      },
    }
    state.session = session
    const onStop = (reason) => {
      if (session.cancelled) return
      session.backendStopped = true
      if (reason === "inference_failed") session.failure = reason
      void stop(reason)
    }
    const onFailure = (reason) => {
      if (session.cancelled || session.backendStopped) return
      session.failure = reason
      if (session.admitted) void stop(reason)
    }
    const delivery = {
      key: options.key,
      fetch: environment.fetch,
      wait: environment.wait,
      onStop,
      onFailure,
      onState: (phase) => {
        if (session.started && !session.cancelled) notify(session, phase === "connected" ? "capturing" : phase)
      },
    }
    session.delivery = createDelivery(delivery)
    session.liveness = createDelivery({ ...delivery, onState: () => {} })
    const check = () => {
      if (session.cancelled) throw new Error("capture_cancelled")
    }
    const keep = (stream) => {
      if (session.cancelled || !stream.getAudioTracks().length) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error(session.cancelled ? "capture_cancelled" : "no_tab_audio")
      }
      session.streams.push(stream)
      stream.getTracks().forEach((track) => track.addEventListener("ended", session.ended))
      return stream
    }
    notify(session, "picker")
    try {
      const remote = keep(
        await environment.mediaDevices
          .getDisplayMedia({
            video: true,
            audio: true,
            selfBrowserSurface: "exclude",
            systemAudio: "exclude",
            surfaceSwitching: "exclude",
          })
          .catch((error) => {
            throw new Error(error.name === "NotAllowedError" ? "picker_cancelled" : "picker_failed")
          }),
      )
      const microphone = options.microphone
        ? await (async () => {
            const permission = await environment.microphonePermission()
            notify(session, permission === "denied" ? "microphone_blocked" : "microphone_prompt")
            if (permission === "denied") throw new Error("microphone_blocked")
            const stream = await environment.mediaDevices
              .getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
                video: false,
              })
              .catch(() => {
                throw new Error("microphone_denied")
              })
            notify(session, "microphone_allowed")
            return keep(stream)
          })()
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
        microphone: options.microphone,
        consent: true,
      })
      check()
      session.started = true
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
            .catch(() => {
              if (!session.cancelled) void stop(session.failure ?? "delivery_unknown")
            })
        }
        source.connect(node)
        node.connect(session.context.destination)
      }
      await session.context.resume()
      check()
      session.heartbeat = setInterval(() => {
        void heartbeat()
      }, 5000)
      notify(session, "capturing")
    } catch (error) {
      if (!session.cancelled) session.failure = error.message
      await stop(session.failure ?? "capture_cancelled")
      throw new Error(session.failure ?? "capture_cancelled", { cause: error })
    }
  }
  const heartbeat = async () => {
    const session = state.session
    if (!session?.started || session.cancelled || session.heartbeatSending) return
    session.heartbeatSending = true
    await session.liveness.send({ type: "heartbeat", captureID: session.options.captureID }).catch(() => {
      if (!session.cancelled) void stop(session.failure ?? "delivery_unknown")
    })
    session.heartbeatSending = false
  }
  const leave = () => {
    const session = state.session
    if (!session) return
    session.cancelled = true
    session.acceptAudio = false
    clearInterval(session.heartbeat)
    session.delivery.close()
    session.liveness.close()
    state.session = undefined
    void dispose(session)
    notify(session, "stopped", "page_hidden")
  }
  return { start, stop, heartbeat, leave, active: () => state.session !== undefined }
}
