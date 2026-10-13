import { YCoding } from "@ycoding-ai/client/v5"
import type { Endpoint } from "@ycoding-ai/client/service"
import { Effect } from "effect"
import { WebSocket } from "ws"

export function createClient(endpoint: Endpoint) {
  return YCoding.make({
    endpoint,
    location: { directory: process.cwd() },
    socket: (url, headers) => new WebSocket(url, { headers }),
  })
}

export const frontendClient = Effect.fnUntraced(function* (endpoint: Endpoint) {
  const client = createClient(endpoint)
  yield* Effect.addFinalizer(() => Effect.sync(() => client.transport.close()))
  return client
})
