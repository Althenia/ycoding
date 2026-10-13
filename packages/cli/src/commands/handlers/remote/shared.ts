import { EOL } from "node:os"
import { Effect } from "effect"
import { ServerConnection } from "../../../services/server-connection"
import { frontendClient } from "../../../services/client"

export const remoteClient = Effect.fnUntraced(function* (input: { server?: string; standalone?: boolean }) {
  const server = yield* ServerConnection.resolve(input)
  const url = new URL(server.endpoint.url)
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password)
    return yield* Effect.fail(new Error("Remote controls require a private loopback backend"))
  return yield* frontendClient(server.endpoint)
})

export function relayOrigin(value: string) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("The relay URL must be an origin without a path, credentials, query or fragment")
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("The relay URL must be HTTPS; only a loopback relay may use HTTP")
  return url.origin
}

export function line(value: string) {
  process.stdout.write(value + EOL)
}
