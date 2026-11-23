import { expect } from "bun:test"
import { ServerProcess } from "@ycoding-ai/server/process"
import type { InteractionPlatforms } from "@ycoding-ai/server/interaction-platform"
import type { RemoteConnection } from "@ycoding-ai/server/remote-connection"
import type { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Effect, Exit, Logger, Scope } from "effect"
import { availablePort } from "./fixture/loopback-port"
import { providerConfig, startProviderStandIn, type ProviderFixture } from "./fixture/provider-stand-in"

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

type ProviderStandIn = {
  readonly providerID: string
  readonly modelID: string
  readonly url: string
  /** Chat-completion request bodies the stand-in received, in order. */
  readonly requests: () => readonly unknown[]
  /** Releases every held completion so the caller can shut down cleanly. */
  readonly releaseAll: () => void
}

export type IsolatedServerOptions = {
  readonly plugins?: readonly string[]
  /** Extra runtime configuration merged over the provider declaration, for example agents. */
  readonly config?: Record<string, unknown>
  readonly provider?: ProviderFixture
  readonly remote?: RemoteConnection.Interface
  readonly replacements?: LayerNode.Replacements
  readonly interactionPlatforms?: InteractionPlatforms
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
      content: JSON.stringify({ ...(standIn === undefined ? {} : JSON.parse(providerConfig(standIn))), ...(options.plugins === undefined ? {} : { plugins: options.plugins }), ...options.config }),
    },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
  }, undefined, options.remote ? async () => options.remote! : undefined, [], undefined, options.replacements ?? [], options.interactionPlatforms).pipe(Effect.provideService(Scope.Scope, scope))
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
