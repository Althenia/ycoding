import { expect } from "bun:test"
import { LLM, LLMClient, Message, SystemPart } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { RequestExecutor } from "@ycoding-ai/ai/route"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { Effect } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { it } from "./lib/effect"

type Body = {
  readonly model: string
  readonly prompt_cache_key: string
  readonly prompt_cache_options: { readonly mode: "implicit" | "explicit"; readonly ttl: string }
  readonly input: ReadonlyArray<{
    readonly role: string
    readonly content: ReadonlyArray<{
      readonly type: string
      readonly text: string
      readonly prompt_cache_breakpoint?: { readonly mode: string }
    }>
  }>
}

const explicitEndpoints = (body: Body) =>
  body.input.flatMap((item, index) =>
    item.content.some((part) => part.prompt_cache_breakpoint !== undefined) ? [index] : [],
  )

const eligibleMessageEndings = (body: Body) =>
  body.input.flatMap((item, index) => (item.role === "user" ? [index] : []))

const lookupEndpoints = (body: Body) => {
  const explicit = explicitEndpoints(body)
  return new Set([
    ...explicit.slice(0, 2),
    ...explicit.slice(-50),
    ...(body.prompt_cache_options.mode === "implicit" ? eligibleMessageEndings(body).slice(-21) : []),
  ])
}

const prefix = (body: Body, endpoint: number) =>
  JSON.stringify({
    ...body,
    input: body.input.slice(0, endpoint + 1).map((item) => ({
      ...item,
      content: item.content.map(({ prompt_cache_breakpoint: _, ...part }) => part),
    })),
  })

const syntheticWrites = (body: Body) => {
  const endpoints = new Set([
    ...explicitEndpoints(body),
    ...(body.prompt_cache_options.mode === "implicit" ? eligibleMessageEndings(body).slice(-1) : []),
  ])
  expect(endpoints.size).toBeLessThanOrEqual(4)
  return new Set([...endpoints].map((endpoint) => prefix(body, endpoint)))
}

const longestSyntheticRead = (body: Body, cached: ReadonlySet<string>) =>
  Math.max(-1, ...[...lookupEndpoints(body)].filter((endpoint) => cached.has(prefix(body, endpoint))))

for (const mode of ["auto", "explicit"] as const) {
  for (const messageCount of mode === "auto" ? [48, 49] : [49, 50]) {
    it.effect(
      `${mode}: a cached third-user endpoint stays discoverable after growth to ${messageCount} user messages`,
      () =>
        Effect.gen(function* () {
          const providerID = Provider.ID.make("openai")
          const id = CatalogModel.ID.make("gpt-6.1-sol")
          const catalog = CatalogModel.Info.make({
            ...CatalogModel.Info.empty(providerID, id),
            modelID: id,
            package: Provider.aisdk("@ai-sdk/openai"),
            settings: { apiKey: "fixture-key", baseURL: "https://api.openai.com/v1" },
          })
          const model = yield* SessionRunnerModel.fromCatalogModel(catalog)
          expect(model.route.id).toBe("openai-responses")
          const system = [SystemPart.make("stable synthetic reference material ".repeat(4000))]
          const cache = SessionRunnerCache.providerOptions({
            projectID: "project",
            directory: "/fixture",
            providerID,
            modelID: id,
            apiModelID: id,
            sessionID: "session",
            accountIdentityDigest: "a".repeat(64),
            policyRevision: CACHE_POLICY_REVISION,
            permissions: [],
            system,
            tools: [],
            routeID: model.route.id,
            endpointBaseURL: model.route.endpoint.baseURL,
            openaiMode: mode,
          })
          const messages = Array.from({ length: messageCount }, (_, index) => Message.user(`Observation ${index + 1}`))
          const capture = (history: ReadonlyArray<Message>) =>
            Effect.gen(function* () {
              const bodies: Body[] = []
              yield* LLMClient.generate(
                LLM.request({
                  model,
                  system,
                  messages: history,
                  cache: cache.cache,
                  providerOptions: cache.providerOptions,
                }),
              ).pipe(
                Effect.provide(LLMClient.configured()),
                Effect.provideService(RequestExecutor.Service, {
                  execute: (http) =>
                    Effect.sync(() => {
                      expect(http.url).toBe("https://api.openai.com/v1/responses")
                      if (http.body._tag !== "Uint8Array") throw new Error("Expected encoded JSON")
                      bodies.push(JSON.parse(new TextDecoder().decode(http.body.body)))
                      return HttpClientResponse.fromWeb(http, new Response("fixture", { status: 400 }))
                    }),
                }),
                Effect.flip,
              )
              expect(bodies).toHaveLength(1)
              return bodies[0]!
            })
          const first = yield* capture(messages.slice(0, 3))
          const second = yield* capture(messages)
          expect(first.prompt_cache_options).toEqual({ mode: mode === "auto" ? "implicit" : "explicit", ttl: "30m" })
          expect(second.prompt_cache_options).toEqual(first.prompt_cache_options)
          expect(second.prompt_cache_key).toBe(first.prompt_cache_key)
          expect(second.input).toHaveLength(messageCount + 1)
          expect(second.input.slice(1).map((item) => item.content.map((part) => part.text).join(""))).toEqual(
            messages.map((_, index) => `Observation ${index + 1}`),
          )
          expect(prefix(second, 3)).toBe(prefix(first, 3))
          expect(explicitEndpoints(first)).toEqual([0, 1, 2, 3])
          const cached = syntheticWrites(first)
          expect(longestSyntheticRead(first, cached)).toBe(3)
          expect(longestSyntheticRead({ ...second, prompt_cache_key: "different-cache-partition" }, cached)).toBe(-1)
          expect(longestSyntheticRead(second, cached)).toBe(3)
        }),
    )
  }
}
