declare const source: string
export default source

type Track = {
  stop: () => void
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}
type Stream = { getTracks: () => Track[]; getAudioTracks: () => Track[] }
type Node = { connect: (destination: unknown) => void; disconnect: () => void }
type Context = {
  sampleRate: number
  destination: unknown
  audioWorklet: { addModule: (url: string) => Promise<void> }
  createMediaStreamSource: (stream: Stream) => Node
  resume: () => Promise<void>
  close: () => Promise<void>
}
type Frame =
  | { type: "audio"; source: string; sequence: number; startMs: number; sampleRate: number; samples: ArrayBuffer }
  | { type: "flushed" }
export function createCapture(environment: {
  mediaDevices: {
    getDisplayMedia: (constraints: Record<string, unknown>) => Promise<Stream>
    getUserMedia: (constraints: Record<string, unknown>) => Promise<Stream>
  }
  AudioContext: new () => Context
  AudioWorkletNode: new (
    context: Context,
    name: string,
    options: { processorOptions: { source: string } },
  ) => Node & {
    addEventListener: (type: string, listener: () => void) => void
    removeEventListener: (type: string, listener: () => void) => void
    port: {
      onmessage: ((event: { data: Frame }) => void) | null
      postMessage: (value: { type: string }) => void
      close: () => void
    }
  }
  fetch: (url: string, options: RequestInit) => Promise<Response>
  wait: (ms: number) => Promise<void>
  microphonePermission: () => Promise<string>
  workletURL: string
  onState: (value: { phase: string; reason?: string; captureID: string }) => void
}): {
  start: (options: {
    key: string
    captureID: string
    consent: boolean
    policy: boolean
    microphone: boolean
  }) => Promise<void>
  stop: (reason?: string) => Promise<void>
  heartbeat: () => Promise<void>
  leave: () => void
  active: () => boolean
}
