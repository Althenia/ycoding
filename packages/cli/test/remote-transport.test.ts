import { describe, expect, test } from "bun:test"
import { CloudflareRemoteTransport } from "../src/remote-transport"

type Listener = (event: { data?: string; code?: number }) => void

class FakeSocket {
  static readonly OPEN = 1
  readonly sent: string[] = []
  readyState = 0
  closeCode?: number
  closeReason?: string
  private readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener)
  }

  send(value: string) {
    this.sent.push(value)
  }

  close(code = 1000, reason?: string) {
    if (this.readyState === 3) return
    this.closeCode = code
    this.closeReason = reason
    this.readyState = 3
    this.emit("close", { code })
  }

  open() {
    this.readyState = FakeSocket.OPEN
    this.emit("open", {})
  }

  receive(value: unknown) {
    this.emit("message", { data: JSON.stringify(value) })
  }

  private emit(type: string, event: { data?: string; code?: number }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

async function waitFor(check: () => boolean, timeout = 1_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(5)
  }
}

describe("CloudflareRemoteTransport", () => {
  test("requires a secure remote URL and rejects sends before opening", async () => {
    expect(() => new CloudflareRemoteTransport({ url: "ws://example.com/ws/agent" })).toThrow(
      "Remote transport requires WSS",
    )
    expect(() => new CloudflareRemoteTransport({ url: "ws://127.0.0.1:8787/ws/agent" })).not.toThrow()
    const transport = new CloudflareRemoteTransport({
      url: "wss://ycoding-cloud.lostq901.workers.dev/ws/agent",
      createSocket: () => new FakeSocket(),
    })
    expect(transport.send({ type: "ping" })).rejects.toThrow("Remote transport is not connected")
  })

  test("heartbeats, answers ping, reconnects with backoff, and disconnects cleanly", async () => {
    const sockets: FakeSocket[] = []
    const messages: unknown[] = []
    const transport = new CloudflareRemoteTransport({
      url: "wss://ycoding-cloud.lostq901.workers.dev/ws/agent",
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      heartbeatIntervalMs: 10,
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 20,
    })
    transport.onMessage((message) => messages.push(message))

    const connected = transport.connect()
    expect(sockets).toHaveLength(1)
    sockets[0].open()
    await connected
    await waitFor(() => sockets[0].sent.includes('{"type":"ping"}'))
    sockets[0].receive({ type: "pong" })

    sockets[0].receive({ type: "ping" })
    expect(sockets[0].sent).toContain('{"type":"pong"}')
    sockets[0].receive({ type: "notice" })
    expect(messages).toEqual([{ type: "notice" }])

    sockets[0].close(1000)
    await waitFor(() => sockets.length === 2)
    sockets[1].open()
    await transport.send({ type: "ready" })
    expect(sockets[1].sent).toContain('{"type":"ready"}')

    await transport.disconnect()
    expect(sockets[1].readyState).toBe(3)
    await Bun.sleep(30)
    expect(sockets).toHaveLength(2)
  })

  test("closes and reconnects when a heartbeat is not acknowledged", async () => {
    const sockets: FakeSocket[] = []
    const transport = new CloudflareRemoteTransport({
      url: "wss://ycoding-cloud.lostq901.workers.dev/ws/agent",
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      heartbeatIntervalMs: 10,
      reconnectInitialDelayMs: 5,
    })

    const connected = transport.connect()
    sockets[0].open()
    await connected
    await waitFor(() => sockets.length === 2)
    expect(sockets[0].closeCode).toBe(1011)
    expect(sockets[0].closeReason).toBe("Remote heartbeat timed out")

    await transport.disconnect()
  })
})
