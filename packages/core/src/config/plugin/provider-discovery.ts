export * as ProviderModelDiscovery from "./provider-discovery"

import { Cache, Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

export const Request = Schema.Struct({
  providerID: Schema.String,
  baseURL: Schema.Unknown,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  managed: Schema.Boolean,
})
export type Request = typeof Request.Type

const decodeKey = Schema.decodeUnknownEffect(Schema.fromJsonString(Request))

export interface Interface {
  readonly models: (request: Request, options?: { readonly refresh?: boolean }) => Effect.Effect<readonly Model[]>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ProviderModelDiscovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cache = yield* Cache.make({
      capacity: 64,
      timeToLive: "5 minutes",
      lookup: (key: string) => decodeKey(key).pipe(Effect.orDie, Effect.flatMap(fetchModels)),
    })
    return Service.of({
      models: (request, options) => {
        const key = JSON.stringify(request)
        return options?.refresh ? Cache.refresh(cache, key) : Cache.get(cache, key)
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

const fetchModels = (request: Request) =>
  Effect.tryPromise({
    try: async () => {
      if (typeof request.baseURL !== "string" || !request.baseURL) throw new Error("provider baseURL is required")
      const endpoint = `${request.baseURL.replace(/\/$/, "")}/models`
      if (request.managed) {
        const url = new URL(endpoint)
        if (url.username || url.password) throw new Error("model discovery URL cannot contain credentials")
        if (
          url.protocol !== "https:" &&
          !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
          throw new Error("managed model discovery requires HTTPS or local HTTP")
      }
      const response = await fetch(endpoint, {
        headers: new Headers(request.headers.map(([name, value]) => [name, value])),
        ...(request.managed ? { redirect: "manual" as const } : {}),
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) throw new Error(`model discovery failed with HTTP ${response.status}`)
      return parseModels(await response.json())
    },
    catch: () => new Error("OpenAI model discovery failed"),
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("OpenAI model discovery failed", { providerID: request.providerID }).pipe(
        Effect.as([] as Model[]),
      ),
    ),
  )

export type Model = {
  readonly id: string
  readonly name?: string
  readonly capabilities?: { readonly tools?: boolean; readonly input?: string[]; readonly output?: string[] }
  readonly limit?: { readonly context?: number; readonly input?: number; readonly output?: number }
  readonly variants?: Array<{
    readonly id: string
    readonly settings?: Record<string, unknown>
    readonly headers?: Record<string, string>
    readonly body?: Record<string, unknown>
  }>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

function parseModels(value: unknown): Model[] {
  const root = record(value)
  if (root?.object !== "list" || !Array.isArray(root.data)) throw new Error("invalid OpenAI model catalog")
  return root.data.map((candidate) => {
    const item = record(candidate)
    if (!item || typeof item.id !== "string" || !item.id) throw new Error("invalid OpenAI model record")
    const capabilities = record(item.capabilities)
    const limit = record(item.limit)
    const variants = Array.isArray(item.variants)
      ? item.variants.flatMap((candidate) => {
          const variant = record(candidate)
          if (!variant || typeof variant.id !== "string" || !variant.id) return []
          return [
            {
              id: variant.id,
              ...(record(variant.settings) ? { settings: variant.settings as Record<string, unknown> } : {}),
              ...(record(variant.headers) ? { headers: variant.headers as Record<string, string> } : {}),
              ...(record(variant.body) ? { body: variant.body as Record<string, unknown> } : {}),
            },
          ]
        })
      : undefined
    return {
      id: item.id,
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(capabilities
        ? {
            capabilities: {
              ...(typeof capabilities.tools === "boolean" ? { tools: capabilities.tools } : {}),
              ...(Array.isArray(capabilities.input) && capabilities.input.every((item) => typeof item === "string")
                ? { input: capabilities.input as string[] }
                : {}),
              ...(Array.isArray(capabilities.output) && capabilities.output.every((item) => typeof item === "string")
                ? { output: capabilities.output as string[] }
                : {}),
            },
          }
        : {}),
      ...(limit
        ? {
            limit: {
              ...(typeof limit.context === "number" ? { context: limit.context } : {}),
              ...(typeof limit.input === "number" ? { input: limit.input } : {}),
              ...(typeof limit.output === "number" ? { output: limit.output } : {}),
            },
          }
        : {}),
      ...(variants ? { variants } : {}),
    }
  })
}
