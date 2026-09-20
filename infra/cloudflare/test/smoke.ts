import { CloudflareRemoteTransport } from "../../../packages/cli/src/remote-transport"

const base = process.argv[2]
if (!base) throw new Error("usage: bun infra/cloudflare/test/smoke.ts <https://worker-host>")
const root = new URL(base)
root.protocol = root.protocol === "http:" ? "ws:" : "wss:"

const agentURL = new URL("/ws/agent", root).toString()
const clientURL = new URL("/ws/client", root).toString()
const agent = new CloudflareRemoteTransport({
  url: agentURL,
  heartbeatIntervalMs: 1_000,
  reconnectInitialDelayMs: 100,
  reconnectMaxDelayMs: 1_000,
})

await agent.connect()
const client = await open(clientURL)
await ping(client)

const replacement = await open(agentURL)
await closed(replacement)
await ping(client, 10_000)

client.close(1000, "smoke complete")
await agent.disconnect()
console.log("DeviceRelay WebSocket routing and reconnect smoke passed")

function open(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url)
    const deadline = setTimeout(() => reject(new Error(`WebSocket upgrade timed out for ${new URL(url).pathname}`)), 10_000)
    socket.addEventListener("open", () => {
      clearTimeout(deadline)
      resolve(socket)
    }, { once: true })
    socket.addEventListener("error", () => {
      clearTimeout(deadline)
      reject(new Error(`WebSocket upgrade failed for ${new URL(url).pathname}`))
    }, { once: true })
  })
}

function ping(socket: WebSocket, timeout = 5_000) {
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      socket.removeEventListener("message", message)
      reject(new Error("DeviceRelay ping timed out"))
    }, timeout)
    const message = (event: MessageEvent) => {
      if (event.data !== '{"type":"pong"}') return
      clearTimeout(deadline)
      socket.removeEventListener("message", message)
      resolve()
    }
    socket.addEventListener("message", message)
    socket.send('{"type":"ping"}')
  })
}

function closed(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Replacement agent was not displaced by reconnect")), 10_000)
    socket.addEventListener("close", () => {
      clearTimeout(deadline)
      resolve()
    }, { once: true })
  })
}
