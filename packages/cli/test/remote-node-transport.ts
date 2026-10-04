// Real-Node check for the relay transport: start a loopback WebSocket server,
// dial it with the production transport, and report the upgrade header the
// server actually received. Run under the Node runtime, not Bun:
//
//   node --experimental-transform-types test/remote-node-transport.ts
//
// Exits non-zero with a JSON result on stdout when the credential is missing.
import { CloudflareRemoteTransport } from "../src/remote-transport.ts"

type UpgradeRequest = { readonly headers: Record<string, string | undefined> }
type SocketServer = {
  readonly on: (event: string, listener: (...args: unknown[]) => void) => void
  readonly once: (event: string, listener: () => void) => void
  readonly address: () => { readonly port: number } | string | null
  readonly close: (callback?: () => void) => void
}

// The `ws` package ships no type declarations; this script declares only the
// server surface it uses.
const { WebSocketServer } = (await import("ws")) as unknown as {
  readonly WebSocketServer: new (options: { host: string; port: number }) => SocketServer
}

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
const seen: Array<string | undefined> = []
let settleClose: (value: { code?: number; reason?: string }) => void = () => {}
const closed = new Promise<{ code?: number; reason?: string }>((resolve) => { settleClose = resolve })

server.on("connection", (...args: unknown[]) => {
  const request = args[1] as UpgradeRequest | undefined
  seen.push(request?.headers.authorization)
  const socket = args[0]
  if (typeof socket === "object" && socket !== null && "close" in socket && typeof socket.close === "function")
    socket.close(1008, "Agent message rate exceeded")
})

await new Promise<void>((resolve) => server.once("listening", () => resolve()))
const address = server.address()
if (address === null || typeof address === "string") throw new Error("the fixture server did not bind a TCP port")

const transport = new CloudflareRemoteTransport({
  url: `ws://127.0.0.1:${address.port}/ws/v4/agent`,
  headers: { authorization: "Bearer node-device-token" },
  heartbeatIntervalMs: 10_000,
  onClose: settleClose,
})

let failure: string | undefined
try {
  await transport.connect()
  const close = await closed
  if (seen[0] !== "Bearer node-device-token") failure = `upgrade header was ${JSON.stringify(seen[0])}`
  if (close.code !== 1008 || close.reason !== "Agent message rate exceeded") failure = "Node transport omitted the relay policy close reason"
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
} finally {
  await transport.disconnect()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

process.stdout.write(JSON.stringify({ runtime: process.version, authorization: seen[0] ?? null, failure: failure ?? null }) + "\n")
if (failure !== undefined) process.exitCode = 1
