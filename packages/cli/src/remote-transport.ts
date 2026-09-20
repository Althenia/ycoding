export interface RemoteTransport<Event = unknown> {
  readonly connect: () => Promise<void>
  readonly send: (event: Event) => Promise<void>
  readonly onMessage: (handler: (event: Event) => void) => void
  readonly disconnect: () => Promise<void>
}

type SocketEvent = { readonly data?: unknown; readonly code?: number }
type SocketListener = (event: SocketEvent) => void
const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

export interface RemoteSocket {
  readonly readyState: number
  readonly addEventListener: (type: string, listener: SocketListener) => void
  readonly removeEventListener: (type: string, listener: SocketListener) => void
  readonly send: (value: string) => void
  readonly close: (code?: number, reason?: string) => void
}

type Options = {
  readonly url: string
  readonly createSocket?: (url: string) => RemoteSocket
  readonly heartbeatIntervalMs?: number
  readonly reconnectInitialDelayMs?: number
  readonly reconnectMaxDelayMs?: number
}

export class CloudflareRemoteTransport implements RemoteTransport {
  private readonly handlers = new Set<(event: unknown) => void>()
  private socket?: RemoteSocket
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private reconnectAttempt = 0
  private awaitingPong = false
  private stopped = true
  private resolveInitial?: () => void
  private rejectInitial?: (error: Error) => void

  constructor(private readonly options: Options) {
    requireWebSocketURL(options.url)
  }

  connect() {
    if (!this.stopped && this.socket?.readyState === OPEN) return Promise.resolve()
    this.stopped = false
    const connected = new Promise<void>((resolve, reject) => {
      this.resolveInitial = resolve
      this.rejectInitial = reject
    })
    this.open()
    return connected
  }

  async send(event: unknown) {
    const socket = this.socket
    if (socket?.readyState !== OPEN) throw new Error("Remote transport is not connected")
    socket.send(JSON.stringify(event))
  }

  onMessage(handler: (event: unknown) => void) {
    this.handlers.add(handler)
  }

  async disconnect() {
    this.stopped = true
    this.clearTimers()
    this.rejectInitial?.(new Error("Remote transport disconnected before opening"))
    this.resolveInitial = undefined
    this.rejectInitial = undefined
    const socket = this.socket
    this.socket = undefined
    if (socket && socket.readyState !== CLOSED && socket.readyState !== CLOSING)
      socket.close(1000, "YCoding stopped")
  }

  private open() {
    if (this.stopped || this.socket?.readyState === OPEN || this.socket?.readyState === CONNECTING)
      return
    const socket = (this.options.createSocket ?? defaultSocket)(this.options.url)
    this.socket = socket
    const opened = () => {
      if (this.socket !== socket || this.stopped) return
      this.reconnectAttempt = 0
      this.awaitingPong = false
      this.startHeartbeat(socket)
      this.resolveInitial?.()
      this.resolveInitial = undefined
      this.rejectInitial = undefined
    }
    const message = (event: SocketEvent) => {
      if (this.socket !== socket || typeof event.data !== "string") return
      const decoded = decodeMessage(event.data)
      if (!decoded.ok) return
      const parsed = decoded.value
      if (isSignal(parsed, "ping")) {
        socket.send('{"type":"pong"}')
        return
      }
      if (isSignal(parsed, "pong")) {
        this.awaitingPong = false
        return
      }
      for (const handler of this.handlers) handler(parsed)
    }
    const closed = () => {
      socket.removeEventListener("open", opened)
      socket.removeEventListener("message", message)
      socket.removeEventListener("close", closed)
      socket.removeEventListener("error", errored)
      if (this.socket !== socket) return
      this.socket = undefined
      this.clearHeartbeat()
      this.scheduleReconnect()
    }
    const errored = () => socket.close(1011, "Remote transport error")
    socket.addEventListener("open", opened)
    socket.addEventListener("message", message)
    socket.addEventListener("close", closed)
    socket.addEventListener("error", errored)
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    const initial = this.options.reconnectInitialDelayMs ?? 1_000
    const maximum = this.options.reconnectMaxDelayMs ?? 30_000
    const delay = Math.min(initial * 2 ** this.reconnectAttempt++, maximum)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.open()
    }, delay)
  }

  private startHeartbeat(socket: RemoteSocket) {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== OPEN) return
      if (this.awaitingPong) {
        socket.close(1011, "Remote heartbeat timed out")
        return
      }
      this.awaitingPong = true
      socket.send('{"type":"ping"}')
    }, this.options.heartbeatIntervalMs ?? 20_000)
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    this.awaitingPong = false
  }

  private clearTimers() {
    this.clearHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }
}

function defaultSocket(url: string): RemoteSocket {
  const socket = new globalThis.WebSocket(url)
  const listeners = new Map<SocketListener, EventListener>()
  return {
    get readyState() {
      return socket.readyState
    },
    addEventListener(type, listener) {
      const wrapped = (event: Event) =>
        listener(event instanceof MessageEvent ? { data: event.data } : event instanceof CloseEvent ? { code: event.code } : {})
      listeners.set(listener, wrapped)
      socket.addEventListener(type, wrapped)
    },
    removeEventListener(type, listener) {
      const wrapped = listeners.get(listener)
      if (!wrapped) return
      socket.removeEventListener(type, wrapped)
      listeners.delete(listener)
    },
    send: (value) => socket.send(value),
    close: (code, reason) => socket.close(code, reason),
  }
}

function requireWebSocketURL(value: string) {
  const url = new URL(value)
  if (url.protocol === "wss:") return
  if (url.protocol === "ws:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return
  throw new Error("Remote transport requires WSS, except for local Wrangler development")
}

function decodeMessage(value: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) }
  } catch {
    return { ok: false }
  }
}

function isSignal(value: unknown, type: "ping" | "pong") {
  return typeof value === "object" && value !== null && Reflect.get(value, "type") === type
}
