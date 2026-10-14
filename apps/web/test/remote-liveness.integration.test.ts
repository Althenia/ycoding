import { expect, test } from "bun:test"
import { BinarySocket } from "./wire-peer"
import { binaryData } from "./core-peer"
import { createRemoteTransport } from "../src/remote/transport"
import { waitFor } from "./relay-double"

class Visibility extends EventTarget {
  hidden = false
  change(hidden: boolean) {
    this.hidden = hidden
    this.dispatchEvent(new Event("visibilitychange"))
  }
}

test("real WebSocket recovery retires a silent relay connection without replaying a mutation", async () => {
  let connections = 0
  const requests: string[] = []
  const server = Bun.serve<{ generation: number; peer?: BinarySocket }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { generation: ++connections } })) return undefined
      return new Response(null, { status: 400 })
    },
    websocket: {
      open(socket) {
        const peer = new BinarySocket(
          () => performance.now(),
          (request) => {
            requests.push(request.operation)
            if (socket.data.generation === 1) peer.quiet = true
          },
        )
        peer.message = (raw) => {
          if (socket.readyState === 1) socket.send(raw)
        }
        peer.close = (code, reason) => socket.close(code, reason)
        peer.open()
        socket.data.peer = peer
      },
      message(socket, raw) {
        socket.data.peer!.receive(binaryData(raw))
      },
    },
  })
  let reconnects = 0
  const transport = createRemoteTransport({
    url: `ws://127.0.0.1:${server.port}/`,
    pingIntervalMs: 20,
    pongTimeoutMs: 20,
    resetDelayMs: 5,
    handlers: {
      onReconnect: () => {
        reconnects += 1
      },
    },
  })
  try {
    transport.connect()
    await waitFor(() => transport.status().kind === "open")
    const outcome = transport.request("session.interrupt", { sessionID: "ses_a", timeoutMs: 0 })
    await waitFor(() => reconnects === 1)
    expect(await outcome).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
    await Bun.sleep(80)
    expect(transport.status().kind).toBe("open")
    expect(connections).toBe(2)
    expect(requests).toEqual(["session.interrupt"])
  } finally {
    transport.close()
    await server.stop(true)
  }
})

test("real relay activity keeps a resumed browser transport healthy after foreground and online probes", async () => {
  const document = new Visibility()
  document.hidden = true
  const window = new EventTarget()
  let connections = 0
  let pings = 0
  const server = Bun.serve<{ peer?: BinarySocket }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: {} })) {
        connections += 1
        return undefined
      }
      return new Response(null, { status: 400 })
    },
    websocket: {
      open(socket) {
        const peer = new BinarySocket(() => performance.now())
        peer.message = (raw) => {
          if (socket.readyState === 1) socket.send(raw)
        }
        peer.close = (code, reason) => socket.close(code, reason)
        peer.open()
        socket.data.peer = peer
      },
      message(socket, raw) {
        const peer = socket.data.peer!
        const established = peer.connection.state === "established"
        peer.receive(binaryData(raw))
        const frame = peer.sent.at(-1)
        if (established && frame?.body.case === "control" && frame.body.value.kind.case === "ping") {
          pings += 1
          peer.control({ case: "inventoryInvalidated", value: {} })
        }
      },
    },
  })
  const transport = createRemoteTransport({
    url: `ws://127.0.0.1:${server.port}/`,
    document,
    window,
    pingIntervalMs: 1000,
    pongTimeoutMs: 20,
    resetDelayMs: 5,
  })
  try {
    transport.connect()
    await waitFor(() => transport.status().kind === "open")
    await Bun.sleep(60)
    expect(pings).toBe(0)
    document.change(false)
    window.dispatchEvent(new Event("online"))
    await waitFor(() => pings === 1)
    await Bun.sleep(40)
    expect(transport.status().kind).toBe("open")
    window.dispatchEvent(new Event("online"))
    await waitFor(() => pings === 2)
    await Bun.sleep(40)
    expect(transport.status().kind).toBe("open")
    expect(connections).toBe(1)
  } finally {
    transport.close()
    await server.stop(true)
  }
})
