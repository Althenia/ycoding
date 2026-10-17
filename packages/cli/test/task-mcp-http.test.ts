import { expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { taskMcpHttpApp } from "../src/task-mcp-http"

function app(fetch: (request: Request) => Promise<Response>, body?: Stream.Stream<Uint8Array, unknown>) {
  // Exercise the adapter-owned source path, rather than the Web fast path.
  const incoming = HttpServerRequest.fromWeb(new Request("http://127.0.0.1:4097/mcp"))
  Object.defineProperties(incoming, {
    source: { value: {} },
    method: { value: body ? "POST" : "GET" },
    stream: { value: body },
    url: { value: "/mcp" },
    headers: { value: { host: "127.0.0.1:4097" } },
  })
  return taskMcpHttpApp(fetch).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, incoming))
}

test("preserves streamed responses and keeps the signal live until scope closes", async () => {
  let signal: AbortSignal | undefined
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* app(async (request) => {
          signal = request.signal
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: ready\n\n"))
                controller.close()
              },
            }),
            { status: 202, headers: { "content-type": "text/event-stream", "mcp-session-id": "session" } },
          )
        })
        expect(signal?.aborted).toBe(false)
        const web = HttpServerResponse.toWeb(response)
        expect(web.status).toBe(202)
        expect(web.headers.get("mcp-session-id")).toBe("session")
        expect(yield* Effect.promise(() => web.text())).toBe("data: ready\n\n")
        expect(signal?.aborted).toBe(false)
      }),
    ),
  )
  expect(signal?.aborted).toBe(true)
})

test("aborts pending transport requests on interruption", async () => {
  let signal: AbortSignal | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const fiber = Effect.runFork(
    Effect.scoped(
      app(async (request) => {
        signal = request.signal
        started()
        return new Promise<Response>(() => {})
      }),
    ),
  )
  await ready
  await Effect.runPromise(Fiber.interrupt(fiber))
  expect(signal?.aborted).toBe(true)
})

test("sanitizes fetch failures", async () => {
  const response = await Effect.runPromise(
    Effect.scoped(
      app(async () => {
        throw new Error("secret")
      }),
    ),
  )
  const web = HttpServerResponse.toWeb(response)
  expect(web.status).toBe(500)
  expect(await web.text()).toBe("MCP request failed")
})

test("cancels unread request streams when authorization rejects a body", async () => {
  let finalized = 0
  const body = Stream.fromAsyncIterable(
    (async function* () {
      try {
        while (true) yield new Uint8Array(8)
      } finally {
        finalized++
      }
    })(),
    (error) => error,
  )
  const response = await Effect.runPromise(
    Effect.scoped(app(async () => new Response("Denied", { status: 401 }), body)),
  )
  expect(response.status).toBe(401)
  expect(finalized).toBe(1)
})
