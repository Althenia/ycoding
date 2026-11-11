export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error("Audio sample rate must be between 8000 and 192000 Hz")
  }
  if (samples.some((sample) => !Number.isFinite(sample))) throw new Error("Audio samples must be finite")
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const out = new Uint8Array(buffer)
  const view = new DataView(buffer)
  writeHeader(view, sampleRate, dataBytes)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.min(1, Math.max(-1, samples[index]))
    const word = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
    view.setInt16(44 + index * 2, word, true)
  }
  return out
}

function writeHeader(view: DataView, sampleRate: number, dataBytes: number): void {
  writeText(view, 0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  writeText(view, 8, "WAVE")
  writeText(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(view, 36, "data")
  view.setUint32(40, dataBytes, true)
}

function writeText(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index))
  }
}
