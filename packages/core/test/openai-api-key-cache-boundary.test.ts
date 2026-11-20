import { expect } from "bun:test"
import { LLM, LLMClient, Message, SystemPart, ToolDefinition } from "@ycoding-ai/ai"
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
  readonly store?: boolean
  readonly previous_response_id?: string
  readonly prompt_cache_key: string
  readonly prompt_cache_options: { readonly mode: "implicit" | "explicit"; readonly ttl: string }
  readonly tools?: ReadonlyArray<{ readonly name: string }>
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

it.effect("stored continuation keeps one system prompt in the provider-side conversation", () =>
  Effect.gen(function* () {
    const providerID = Provider.ID.make("openai")
    const id = CatalogModel.ID.make("gpt-6-luna")
    const model = yield* SessionRunnerModel.fromCatalogModel(
      CatalogModel.Info.make({
        ...CatalogModel.Info.empty(providerID, id),
        modelID: id,
        package: Provider.aisdk("@ai-sdk/openai"),
        settings: { apiKey: "fixture-key", baseURL: "https://api.openai.com/v1" },
      }),
    )
    expect(model.route.id).toBe("openai-responses")
    const system = [SystemPart.make("stable synthetic reference material ".repeat(4000))]
    const tools = [
      ToolDefinition.make({
        name: "lookup",
        description: "Look up a synthetic fixture value",
        inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      }),
    ]
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
      tools,
      routeID: model.route.id,
      endpointBaseURL: model.route.endpoint.baseURL,
      openaiMode: "auto",
    })
    const encode = (
      messages: ReadonlyArray<Message>,
      continuation?: { readonly previousResponseId: string; readonly continuationInputStart: number },
    ) =>
      Effect.gen(function* () {
        const bodies: Body[] = []
        yield* LLMClient.generate(
          LLM.request({
            model,
            system,
            messages,
            tools,
            cache: cache.cache,
            providerOptions: {
              ...cache.providerOptions,
              openai: { ...cache.providerOptions.openai, store: true, ...continuation },
            },
          }),
        ).pipe(
          Effect.provide(LLMClient.configured()),
          Effect.provideService(RequestExecutor.Service, {
            execute: (http) =>
              Effect.sync(() => {
                if (http.body._tag !== "Uint8Array") throw new Error("Expected encoded JSON")
                bodies.push(JSON.parse(new TextDecoder().decode(http.body.body)))
                return HttpClientResponse.fromWeb(http, new Response("fixture", { status: 400 }))
              }),
          }),
          Effect.flip,
        )
        expect(bodies).toHaveLength(1)
        return bodies[0]
      })
    const first = Message.user("Observation 1")
    const reply = Message.assistant("Reply 1")
    const second = Message.user("Observation 2")
    const full = yield* encode([first])
    const replay = yield* encode([first, reply, second])
    const continued = yield* encode([first, reply, second], {
      previousResponseId: "resp_fixture_1",
      continuationInputStart: 2,
    })
    const systemItems = (input: Body["input"]) => input.filter((item) => item.role === "system")

    expect(full.store).toBe(true)
    expect(full.previous_response_id).toBeUndefined()
    expect(systemItems(full.input)).toHaveLength(1)
    expect(full.input[0]?.role).toBe("system")
    expect(systemItems(replay.input)).toHaveLength(1)
    expect(prefix(replay, 1)).toBe(prefix(full, 1))

    expect(continued.previous_response_id).toBe("resp_fixture_1")
    expect(continued.input.map((item) => item.role)).toEqual(["user"])
    expect(continued.input[0]?.content.map((part) => part.text)).toEqual(["Observation 2"])
    expect(continued.tools?.map((tool) => tool.name)).toEqual(full.tools?.map((tool) => tool.name))
    expect(continued.prompt_cache_key).toBe(full.prompt_cache_key)
    expect(continued.prompt_cache_options).toEqual(full.prompt_cache_options)
    expect(
      systemItems([
        ...full.input,
        { role: "assistant", content: [{ type: "output_text", text: "Reply 1" }] },
        ...continued.input,
      ]),
    ).toHaveLength(1)
  }),
)
