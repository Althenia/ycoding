export interface RemoteTransport {
  readonly connect: () => Promise<void>
  /** Sends one already-serialized envelope frame; the transport never re-encodes it. */
  readonly send: (frame: string) => Promise<void>
  readonly onMessage: (handler: (event: unknown) => void) => void
  readonly disconnect: (code?: number, reason?: string) => Promise<void>
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

export type RemoteSocketOptions = { readonly headers?: Record<string, string> }

export type RemoteSocketFactory = (url: string, options: RemoteSocketOptions) => RemoteSocket

type Options = {
  readonly url: string
  /** Upgrade headers, such as the device bearer credential for the versioned agent route. */
  readonly headers?: Record<string, string>
  readonly createSocket?: RemoteSocketFactory
  readonly heartbeatIntervalMs?: number
  readonly reconnectInitialDelayMs?: number
  readonly reconnectMaxDelayMs?: number
  /** Called on every successful (re)open, before any frame is sent. */
  readonly onOpen?: () => void
  /** Called when an established connection drops and a reconnect is scheduled. */
  readonly onClose?: (info: { readonly code?: number }) => void
}

export class CloudflareRemoteTransport implements RemoteTransport {
  private readonly handlers = new Set<(event: unknown) => void>()
  private factory?: RemoteSocketFactory
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

  async connect(): Promise<void> {
    if (!this.stopped && this.socket?.readyState === OPEN) return
    this.stopped = false
    const connected = new Promise<void>((resolve, reject) => {
      this.resolveInitial = resolve
      this.rejectInitial = reject
    })
    const provided = this.options.createSocket ?? this.factory
    try {
      // A provided factory keeps socket construction synchronous; the runtime
      // default is resolved once, before the first open.
      if (provided !== undefined) this.open(provided)
      else this.open((this.factory = await resolveSocketFactory()))
    } catch (error) {
      this.stopped = true
      this.rejectInitial?.(error instanceof Error ? error : new Error("Remote transport could not open"))
      this.resolveInitial = undefined
      this.rejectInitial = undefined
    }
    return connected
  }

  async send(frame: string) {
    const socket = this.socket
    if (socket?.readyState !== OPEN) throw new Error("Remote transport is not connected")
    socket.send(frame)
  }

  onMessage(handler: (event: unknown) => void) {
    this.handlers.add(handler)
  }

  async disconnect(code = 1000, reason = "YCoding stopped") {
    this.stopped = true
    this.clearTimers()
    this.rejectInitial?.(new Error("Remote transport disconnected before opening"))
    this.resolveInitial = undefined
    this.rejectInitial = undefined
    const socket = this.socket
    this.socket = undefined
    if (socket && socket.readyState !== CLOSED && socket.readyState !== CLOSING) socket.close(code, reason)
  }

  private open(factory: RemoteSocketFactory) {
    if (this.stopped || this.socket?.readyState === OPEN || this.socket?.readyState === CONNECTING)
      return
    const socket = factory(this.options.url, { headers: this.options.headers })
    this.socket = socket
    const opened = () => {
      if (this.socket !== socket || this.stopped) return
      this.reconnectAttempt = 0
      this.awaitingPong = false
      this.startHeartbeat(socket)
      this.resolveInitial?.()
      this.resolveInitial = undefined
      this.rejectInitial = undefined
      this.options.onOpen?.()
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
    const closed = (event: SocketEvent) => {
      socket.removeEventListener("open", opened)
      socket.removeEventListener("message", message)
      socket.removeEventListener("close", closed)
      socket.removeEventListener("error", errored)
      if (this.socket !== socket) return
      this.socket = undefined
      this.clearHeartbeat()
      this.options.onClose?.({ code: event.code })
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
      const factory = this.options.createSocket ?? this.factory
      if (factory !== undefined) this.open(factory)
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

/**
 * Bun's `WebSocket` accepts `{ headers }` as its second argument; Node's DOM
 * `WebSocket` does not, so Node uses the `ws` dependency the CLI already ships.
 */
async function resolveSocketFactory(): Promise<RemoteSocketFactory> {
  if (supportsUpgradeHeaders()) return bunSocketFactory
  return await wsSocketFactory()
}

function bunSocketFactory(url: string, options: RemoteSocketOptions): RemoteSocket {
  const socket = new globalThis.WebSocket(
    url,
    options.headers === undefined ? undefined : ({ headers: options.headers } as unknown as string[]),
  )
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

function supportsUpgradeHeaders() {
  return typeof process !== "undefined" && process.versions?.bun !== undefined
}

let cachedWsFactory: RemoteSocketFactory | undefined

async function wsSocketFactory(): Promise<RemoteSocketFactory> {
  if (cachedWsFactory !== undefined) return cachedWsFactory
  const { WebSocket } = await import("ws")
  cachedWsFactory = (url, options) => new NodeRemoteSocket(new WebSocket(url, { headers: options.headers }))
  return cachedWsFactory
}

/** Adapter from the `ws` event API onto the socket surface this transport uses. */
class NodeRemoteSocket implements RemoteSocket {
  private readonly handlers = new Map<SocketListener, (...args: unknown[]) => void>()

  constructor(private readonly socket: import("ws").NodeWebSocket) {}

  get readyState() {
    return this.socket.readyState
  }

  addEventListener(type: string, listener: SocketListener) {
    const handler = (...args: unknown[]) => listener(nodeSocketEvent(type, args))
    this.handlers.set(listener, handler)
    this.socket.on(type, handler)
  }

  removeEventListener(type: string, listener: SocketListener) {
    const handler = this.handlers.get(listener)
    if (handler === undefined) return
    this.handlers.delete(listener)
    this.socket.off(type, handler)
  }

  send(value: string) {
    this.socket.send(value)
  }

  close(code?: number, reason?: string) {
    this.socket.close(code, reason)
  }
}

function nodeSocketEvent(type: string, args: readonly unknown[]): SocketEvent {
  if (type === "message") return { data: typeof args[0] === "string" ? args[0] : String(args[0]) }
  if (type === "close") return { code: typeof args[0] === "number" ? args[0] : undefined }
  return {}
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
