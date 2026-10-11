import { createServer } from "node:http"
import type { Duplex } from "node:stream"
import { CloudflareRemoteTransport } from "../src/remote-transport.ts"

const sockets = new Set<Duplex>()
const server = createServer()
server.on("upgrade", (_request, socket) => { sockets.add(socket) })
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
if (address === null || typeof address === "string") throw new Error("The fixture did not listen")
const transport = new CloudflareRemoteTransport({ url: `ws://127.0.0.1:${address.port}`, connectTimeoutMs: 20 })
try {
  await transport.connect()
  throw new Error("The stalled upgrade must time out")
} catch (error) {
  if (!(error instanceof Error) || error.message !== "Remote connection timed out") throw error
  process.stdout.write(error.message + "\n")
} finally {
  await transport.disconnect()
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
