class MeetingPCM extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.source = options.processorOptions.source
    this.samples = new Float32Array(Math.floor(sampleRate / 4))
    this.length = 0
    this.frames = 0
    this.sequence = 0
    this.stopped = false
    this.port.onmessage = (event) => {
      if (event.data.type !== "flush") return
      this.stopped = true
      this.emit()
      this.port.postMessage({ type: "flushed" })
    }
  }
  emit() {
    if (!this.length) return
    const samples = this.samples.slice(0, this.length)
    this.port.postMessage(
      {
        type: "audio",
        source: this.source,
        sequence: this.sequence++,
        startMs: ((this.frames - this.length) * 1000) / sampleRate,
        sampleRate,
        samples: samples.buffer,
      },
      [samples.buffer],
    )
    this.length = 0
  }
  process(inputs, outputs) {
    outputs.forEach((output) => output.forEach((channel) => channel.fill(0)))
    if (this.stopped) return false
    const channels = inputs[0]
    const count = outputs[0]?.[0]?.length ?? 128
    for (let frame = 0; frame < count; frame++) {
      const sample = channels.length
        ? channels.reduce((total, channel) => total + (channel[frame] ?? 0), 0) / channels.length
        : 0
      this.samples[this.length++] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0
      this.frames++
      if (this.length === this.samples.length) this.emit()
    }
    return true
  }
}
registerProcessor("meeting-pcm", MeetingPCM)
