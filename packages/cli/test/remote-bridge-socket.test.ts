import { expect, test } from "bun:test"
import { parseAgentMessage } from "@ycoding-ai/remote"
import { RemoteAgent } from "../src/remote-bridge"
import type { LocalServer } from "../src/remote-local"

// The relay connection contract is one already-serialized envelope frame per
// WebSocket message. This drives the production default connection (no injected
// factory) against a real loopback socket and inspects the exact bytes the relay
// would receive, so a second serialization cannot hide behind a fake transport.

async function waitFor<Value>(check: () => Value | undefined, timeout = 10_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(10)
  }
}

function unreachableLocal(): LocalServer {
  return new Proxy({} as LocalServer, {
    get: (_target, property) => {
      if (property === "listPage") return async () => ({ data: [] })
      if (property === "events") return async () => async () => {}
      return () => Promise.reject(new Error("the local server must not be needed for this flow"))
    },
  })
}

test("writes single-encoded envelope frames through the default relay connection", async () => {
  const received: string[] = []
  const headers: Array<string | null> = []
  let agent: { readonly send: (value: string) => void } | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, socketServer) {
      if (new URL(request.url).pathname !== "/ws/v2/agent") return new Response(null, { status: 404 })
      headers.push(request.headers.get("authorization"))
      return socketServer.upgrade(request) ? undefined : new Response(null, { status: 400 })
    },
    websocket: {
      open(socket) {
        agent = socket
      },
      message(_socket, message) {
        received.push(String(message))
      },
    },
  })

  const bridge = new RemoteAgent({
    relayURL: `http://127.0.0.1:${server.port}`,
    local: unreachableLocal(),
    credentials: async () => ({ accessToken: "socket-token", accessExpiresAt: Date.now() + 600_000 }),
    refreshIntervalMs: 3_600_000,
  })

  try {
    await bridge.connect()
    const advertisement = await waitFor(() => received[0])
    expect(headers).toEqual(["Bearer socket-token"])
    const parsedAdvertisement = parseAgentMessage(advertisement)
    expect(parsedAdvertisement.ok, `relay received ${advertisement}`).toBe(true)
    if (parsedAdvertisement.ok)
      expect(parsedAdvertisement.value).toEqual({ type: "sessions" })

    agent?.send(JSON.stringify({ type: "request", id: "req_1", operation: "session.list" }))
    const rawResponse = await waitFor(() => received[1])
    const response = parseAgentMessage(rawResponse)
    expect(response.ok, `relay received ${rawResponse}`).toBe(true)
    if (response.ok) expect(response.value).toMatchObject({ type: "response", id: "req_1", ok: true })
  } finally {
    await bridge.close()
    await server.stop(true)
  }
}, 30_000)
