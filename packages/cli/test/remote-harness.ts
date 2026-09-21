import { expect } from "bun:test"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Exit, Logger, Scope } from "effect"
import { createServer } from "node:net"
import { deltaChunk, finishChunk } from "../../ai/test/lib/openai-chunks"

// Isolated YCoding server harness for remote bridge tests: an in-process server
// with an in-memory database and a private configuration directory, so no test
// touches the user's runtime, database, or service registration.
//
// Model-backed behavior (goal synthesis, later agent turns) can opt into a
// loopback OpenAI-compatible stand-in. It answers on 127.0.0.1 only, so no test
// reaches an external provider and no credential participates.

export const password = "test-password"
export const auth = `Basic ${Buffer.from(`ycoding:${password}`).toString("base64")}`

export type IsolatedServer = Awaited<ReturnType<typeof startServer>>

export type ProviderFixture = {
  /** The assistant text the stand-in returns. */
  readonly text: string
  /**
   * Leaves every request after the first one open. The first completion (goal
   * synthesis) still settles, so a caller can observe durable state without
   * racing the autonomous loop the activation admits.
   */
  readonly holdAfterFirst?: boolean
}

export type ProviderStandIn = {
  readonly providerID: string
  readonly modelID: string
  readonly url: string
  /** Chat-completion request bodies the stand-in received, in order. */
  readonly requests: () => readonly unknown[]
  /** Releases every held completion so the caller can shut down cleanly. */
  readonly releaseAll: () => void
}

export type IsolatedServerOptions = {
  readonly provider?: ProviderFixture
}

export async function startServer(directory: string, options: IsolatedServerOptions = {}) {
  const standIn = options.provider === undefined ? undefined : await startProviderStandIn(options.provider)
  const port = await availablePort()
  const scope = await Effect.runPromise(Scope.make())
  const logs: string[] = []
  const logger = Logger.map(Logger.formatStructured, (entry) => logs.push(JSON.stringify(entry)))
  const startingRaw = ServerProcess.start<never, never>({
    hostname: "127.0.0.1",
    port,
    password,
    database: { path: ":memory:" },
    config: {
      directory,
      project: false,
      content: standIn === undefined ? "{}" : providerConfig(standIn),
    },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
  }).pipe(Effect.provideService(Scope.Scope, scope))
  // Runtime-owned request markers are supplied when the assembled router dispatches.
  const starting = startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>
  try {
    await Effect.runPromise(starting.pipe(Effect.provide(Logger.layer([logger]))))
  } catch (error) {
    await standIn?.close()
    throw error
  }
  let closed = false
  const base = `http://127.0.0.1:${port}`
  return {
    base,
    logs,
    ...(standIn === undefined
      ? {}
      : {
          provider: {
            providerID: standIn.providerID,
            modelID: standIn.modelID,
            url: standIn.url,
            requests: standIn.requests,
            releaseAll: standIn.releaseAll,
          } satisfies ProviderStandIn,
        }),
    request(path: string, options: RequestInit = {}) {
      const headers = new Headers(options.headers)
      headers.set("authorization", auth)
      return fetch(`${base}${path}`, { ...options, headers })
    },
    async close() {
      if (closed) return
      closed = true
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await standIn?.close()
    },
  }
}

const providerID = "isolated-stand-in"
const modelID = "isolated-model"

/** Declares the loopback provider in the isolated config document, never in user config. */
function providerConfig(standIn: { readonly url: string }) {
  return JSON.stringify({
    providers: {
      [providerID]: {
        package: "aisdk:@ai-sdk/openai-compatible",
        name: "Isolated stand-in",
        settings: { baseURL: `${standIn.url}/v1`, apiKey: "isolated-stand-in-key" },
        models: { [modelID]: { name: "Isolated Model" } },
      },
    },
  })
}

async function startProviderStandIn(fixture: ProviderFixture) {
  const requests: unknown[] = []
  const held: Array<() => void> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 })
      requests.push(await request.json())
      const first = requests.length === 1
      const encoder = new TextEncoder()
      const frames = [deltaChunk({ role: "assistant" }), deltaChunk({ content: fixture.text }), finishChunk("stop")]
      const stream = new ReadableStream({
        async start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          if (!first && fixture.holdAfterFirst === true)
            await new Promise<void>((resolve) => {
              held.push(resolve)
            })
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    providerID,
    modelID,
    url: `http://127.0.0.1:${server.port}`,
    requests: () => requests,
    releaseAll: () => {
      for (const release of held.splice(0)) release()
    },
    close: async () => {
      for (const release of held.splice(0)) release()
      await server.stop(true)
    },
  }
}

export async function createSession(
  server: IsolatedServer,
  sessionID: string,
  directory: string,
  model?: { readonly providerID: string; readonly id: string },
) {
  const response = await server.request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sessionID, location: { directory }, ...(model === undefined ? {} : { model }) }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
}

export async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve a test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
