import { expect } from "bun:test"
import { LLM } from "@ycoding-ai/ai"
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route"
import { DateTime, Effect } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Money } from "@ycoding-ai/schema/money"
import { Agent } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Credential } from "@ycoding-ai/core/credential"
import { DecisionAgent } from "@ycoding-ai/core/decision-agent"
import { DecisionJudgment } from "@ycoding-ai/core/decision-judgment"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Integration } from "@ycoding-ai/core/integration"
import { Location } from "@ycoding-ai/core/location"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SessionRunnerModel.node, Credential.node, Integration.node, Catalog.node, Agent.node]), [
    [Location.node, Location.boundNode({ directory: AbsolutePath.make("/fixture") })],
  ]),
)

const providerID = Provider.ID.make("openai")
const modelID = CatalogModel.ID.make("gpt-6.1-sol")
const profile = "synthetic-chatgpt"

const session = () =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.create(),
    projectID: Project.ID.global,
    title: "codex strict fixture",
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/fixture") },
    model: CatalogModel.Ref.make({ providerID, id: modelID, profile }),
  })

const setup = Effect.gen(function* () {
  const catalog = yield* Catalog.Service
  const credentials = yield* Credential.Service
  const integrations = yield* Integration.Service
  yield* integrations.transform((draft) =>
    draft.update(Integration.ID.make(providerID), (item) => {
      item.name = "OpenAI"
    }),
  )
  yield* catalog.transform((draft) => {
    draft.provider.update(providerID, (item) => {
      item.package = Provider.aisdk("@ai-sdk/openai")
    })
    draft.model.update(providerID, modelID, (item) => {
      item.enabled = true
      item.limit = { context: 200000, output: 4096 }
    })
  })
  yield* credentials.create({
    integrationID: Integration.ID.make(providerID),
    label: profile,
    value: Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("chatgpt-browser"),
      access: "synthetic-access-token",
      refresh: "synthetic-refresh-token",
      expires: Date.now() + 600_000,
      metadata: { accountID: "synthetic-account" },
    }),
  })
  return yield* SessionRunnerModel.Service
})

const request = {
  provider: "agent" as const,
  request: { state: { operation: "compare" }, questions: [{ type: "predicate" as const, name: "equal", instructions: "Are the values equal?" }] },
}

it.effect("a resolved ChatGPT profile reaches the Codex HTTP wire with a strict decision schema", () => Effect.gen(function* () {
  const models = yield* setup
  const resolved = yield* models.resolve(session())
  expect(resolved.model.route.id).toBe("openai-codex-responses")
  expect(DecisionAgent.supportsStrictRoute(resolved.model.route.id)).toBe(true)

  const sent: Array<{ url: string; authorization?: string; account?: string; body: Record<string, any> }> = []
  yield* LLMClient.generate(LLM.request({
    model: resolved.model,
    prompt: "Judge.",
    tools: [],
    responseFormat: { type: "json", schema: DecisionJudgment.responseSchema(request.request) },
  })).pipe(
    Effect.provide(LLMClient.configured()),
    Effect.provideService(RequestExecutor.Service, {
      execute: (http) =>
        Effect.gen(function* () {
          if (http.body._tag !== "Uint8Array") return yield* Effect.die(new Error("Expected JSON request"))
          sent.push({
            url: http.url,
            authorization: http.headers.authorization,
            account: http.headers["chatgpt-account-id"],
            body: JSON.parse(new TextDecoder().decode(http.body.body)),
          })
          return HttpClientResponse.fromWeb(http, new Response("fixture", { status: 400 }))
        }),
    }),
    Effect.exit,
  )
  expect(sent).toHaveLength(1)
  expect(sent[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses")
  expect(sent[0]?.authorization).toBe("Bearer synthetic-access-token")
  expect(sent[0]?.account).toBe("synthetic-account")
  expect(sent[0]?.body.model).toBe(modelID)
  expect(sent[0]?.body.text?.format).toMatchObject({
    type: "json_schema",
    strict: true,
    schema: { type: "object", additionalProperties: false, required: ["decisions"] },
  })
  expect(sent[0]?.body.tools).toBeUndefined()
}))

it.effect("only the verified native routes are strict-capable and every unsafe route stays denied", () => Effect.sync(() => {
  for (const verified of ["openai-responses", "openai-responses-websocket", "openai-chat", "anthropic-messages", "openai-codex-responses"])
    expect(DecisionAgent.supportsStrictRoute(verified)).toBe(true)
  for (const denied of [
    "openai-codex-websocket-responses",
    "openai-compatible-chat",
    "openai-compatible-responses",
    "ai-sdk:@ai-sdk/openai",
    "ai-sdk:@ai-sdk/anthropic",
    "ai-sdk:@ai-sdk/openai-compatible",
    "gemini",
    "",
  ])
    expect(DecisionAgent.supportsStrictRoute(denied)).toBe(false)
}))
