import { NodeHttpServer } from "@effect/platform-node"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"

/** Keep the abort signal alive until the entire streamed response has finished. */
export function taskMcpHttpApp(fetch: (request: Request) => Promise<Response>) {
  return Effect.gen(function* () {
    const controller = new AbortController()
    const incoming = yield* HttpServerRequest.HttpServerRequest
    const request = yield* HttpServerRequest.toWeb(incoming, { signal: controller.signal })
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        controller.abort()
        // toWeb owns a separate stream fiber, including when auth rejects an unread body.
        if (request.body && !request.body.locked) await request.body.cancel().catch(() => {})
      }),
    )
    const response = yield* Effect.tryPromise(() => fetch(request)).pipe(Effect.interruptible)
    return HttpServerResponse.fromWeb(response)
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.text("MCP request failed", { status: 500 }))))
}

/** Node HTTP is available in both Bun and the supported Node SEA executable. */
export function serveTaskMcp(port: number, fetch: (request: Request) => Promise<Response>) {
  return Effect.gen(function* () {
    const server = createServer()
    server.setTimeout(30_000)
    server.requestTimeout = 30_000
    server.headersTimeout = 30_000
    const http = yield* NodeHttpServer.make(() => server, { host: "127.0.0.1", port })
    yield* http.serve(taskMcpHttpApp(fetch))
    // Close open SSE connections before the adapter's graceful shutdown finalizer.
    yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
    return http.address
  })
}
