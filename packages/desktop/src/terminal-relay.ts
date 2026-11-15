import type { TerminalAccess, TerminalFrames } from "./contract"
import { toBase64 } from "./terminal-protocol"

export type TerminalSocket = { readonly readyState: number; send(data: string): void; close(): void }
export type TerminalSocketHandlers = { open(): void; message(data: unknown): void; close(): void; error(): void }
export type TerminalSocketFactory = (url: string, handlers: TerminalSocketHandlers) => TerminalSocket
export type TerminalRelayLimits = { readonly wait: number; readonly idle: number; readonly buffer: number; readonly streams: number }

type Stream = {
  readonly id: string
  readonly revision: number
  readonly access: TerminalAccess
  readonly socket: TerminalSocket
  frames: string[]
  size: number
  open: boolean
  status: TerminalFrames["status"]
  waiter?: () => void
  idle?: ReturnType<typeof setTimeout>
}

const encoder = new TextEncoder()

export const webSocketFactory: TerminalSocketFactory = (url, handlers) => {
  const socket = new WebSocket(url)
  socket.binaryType = "arraybuffer"
  socket.onopen = () => handlers.open()
  socket.onmessage = (event) => handlers.message(event.data)
  socket.onclose = () => handlers.close()
  socket.onerror = () => handlers.error()
  return socket
}

export function terminalSocketUrl(endpoint: string, input: { readonly ptyID: string; readonly sessionID: string; readonly location: { readonly directory?: string; readonly workspace?: string }; readonly generation: number; readonly offset: number; readonly access: TerminalAccess; readonly fence?: number; readonly ticket: string }) {
  const url = new URL(`/api/pty/${encodeURIComponent(input.ptyID)}/connect`, endpoint)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  if (input.location.directory) url.searchParams.set("location[directory]", input.location.directory)
  if (input.location.workspace) url.searchParams.set("location[workspace]", input.location.workspace)
  url.searchParams.set("sessionID", input.sessionID)
  url.searchParams.set("generation", String(input.generation))
  url.searchParams.set("offset", String(input.offset))
  url.searchParams.set("access", input.access)
  if (input.fence !== undefined) url.searchParams.set("fence", String(input.fence))
  url.searchParams.set("ticket", input.ticket)
  return url.toString()
}

export class TerminalRelay {
  private streams = new Map<string, Stream>()

  constructor(private readonly socket: TerminalSocketFactory = webSocketFactory, private readonly limits: TerminalRelayLimits = { wait: 20_000, idle: 45_000, buffer: 4 * 1024 * 1024, streams: 8 }) {}

  open(url: string, revision: number, access: TerminalAccess) {
    if (this.streams.size >= this.limits.streams) {
      const oldest = this.streams.values().next().value
      if (oldest) { this.finish(oldest, "error"); this.drop(oldest) }
    }
    const id = `term_${crypto.randomUUID()}`
    let stream: Stream | undefined
    const pending: Array<(stream: Stream) => void> = []
    const on = (run: (stream: Stream) => void) => { if (stream) run(stream); else pending.push(run) }
    const socket = this.socket(url, {
      open: () => on((current) => { current.open = true }),
      message: (data) => on((current) => this.receive(current, data)),
      close: () => on((current) => this.finish(current, "closed")),
      error: () => on((current) => this.finish(current, "error")),
    })
    stream = { id, revision, access, socket, frames: [], size: 0, open: false, status: "open" }
    this.streams.set(id, stream)
    this.idle(stream)
    for (const run of pending.splice(0)) run(stream)
    return id
  }

  async read(id: string): Promise<TerminalFrames> {
    const stream = this.streams.get(id)
    if (!stream) return { frames: [], status: "error" }
    clearTimeout(stream.idle)
    stream.waiter?.()
    if (!stream.frames.length && stream.status === "open") {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); if (stream.waiter === done) stream.waiter = undefined; resolve() }
        const timer = setTimeout(done, this.limits.wait)
        stream.waiter = done
      })
    }
    const frames = stream.frames
    stream.frames = []
    stream.size = 0
    if (stream.status !== "open") this.drop(stream)
    else if (!stream.waiter) this.idle(stream)
    return { frames, status: stream.status }
  }

  write(id: string, data: string) {
    const stream = this.streams.get(id)
    if (!stream || stream.status !== "open" || !stream.open || stream.access !== "control" || stream.socket.readyState !== 1) return false
    stream.socket.send(data)
    return true
  }

  close(id: string) {
    const stream = this.streams.get(id)
    if (!stream) return
    this.finish(stream, "closed")
    this.drop(stream)
  }

  retain(revision: number | undefined) {
    for (const stream of this.streams.values()) if (stream.revision !== revision) this.finish(stream, "error")
  }

  private receive(stream: Stream, data: unknown) {
    if (stream.status !== "open") return
    const bytes = typeof data === "string" ? encoder.encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined
    if (!bytes) return this.finish(stream, "error")
    const frame = toBase64(bytes)
    stream.size += frame.length
    if (stream.size > this.limits.buffer) {
      stream.frames = []
      stream.size = 0
      return this.finish(stream, "error")
    }
    stream.frames.push(frame)
    stream.waiter?.()
  }

  private finish(stream: Stream, status: "closed" | "error") {
    if (stream.status === "open") stream.status = status
    if (stream.socket.readyState < 2) stream.socket.close()
    stream.waiter?.()
    if (!stream.waiter) this.idle(stream)
  }

  private idle(stream: Stream) {
    clearTimeout(stream.idle)
    stream.idle = setTimeout(() => {
      if (stream.waiter) return
      if (stream.socket.readyState < 2) stream.socket.close()
      this.drop(stream)
    }, this.limits.idle)
  }

  private drop(stream: Stream) {
    clearTimeout(stream.idle)
    if (this.streams.get(stream.id) === stream) this.streams.delete(stream.id)
  }
}
