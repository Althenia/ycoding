import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { ModelV2 } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { Money } from "@ycoding-ai/schema/money"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionProviderRequest.node]),
  ),
)

const itWithFailingLedger = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProviderRequest.node]), [
    [
      EventV2.node,
      Layer.mock(EventV2.Service, {
        publish: () => Effect.die("provider request ledger unavailable"),
      }),
    ],
  ]),
)

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, directory: "/project", title: "Provider request test" })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

itWithFailingLedger.effect("contains provider-request persistence defects", () =>
  Effect.gen(function* () {
    const sessionID = SessionV2.ID.make("ses_provider_request_failure")
    yield* insertSession(sessionID)
    const service = yield* SessionProviderRequest.Service
    const tracker = yield* service.next({
      sessionID,
      source: "step",
      agent: AgentV2.ID.make("build"),
      model: ModelV2.Ref.make({ id: ModelV2.ID.make("gpt-5.6"), providerID: ProviderV2.ID.make("openai") }),
      routeID: "openai-responses",
      promptCacheKey: "cache-key",
      systemDigest: "system-digest",
      toolDigest: "tool-digest",
    })

    const exit = yield* Effect.exit(
      tracker.complete({
        continuation: "full",
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

it.effect("keeps unavailable pricing distinct and summarizes the latest bounded namespace", () =>
  Effect.gen(function* () {
    const sessionID = SessionV2.ID.make("ses_provider_request_unpriced")
    yield* insertSession(sessionID)
    const service = yield* SessionProviderRequest.Service
    const model = ModelV2.Ref.make({
      id: ModelV2.ID.make("custom-model"),
      providerID: ProviderV2.ID.make("custom"),
    })
    const first = yield* service.next({
      sessionID,
      source: "step",
      agent: AgentV2.ID.make("build"),
      model,
      routeID: "openai-responses",
      promptCacheKey: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      systemDigest: "system-one",
      toolDigest: "tools-one",
    })
    yield* first.complete({
      continuation: "full",
      cost: Money.USD.make(0.01),
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const second = yield* service.next({
      sessionID,
      source: "step",
      agent: AgentV2.ID.make("build"),
      model,
      routeID: "openai-responses",
      promptCacheKey: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      systemDigest: "system-one",
      toolDigest: "tools-two",
    })
    yield* second.complete({
      continuation: "continued",
      tokens: { input: 20, output: 3, reasoning: 1, cache: { read: 100, write: 5 } },
    })

    expect(yield* service.summary(sessionID)).toEqual({
      logical: 2,
      physical: 2,
      helpers: 0,
      continued: 1,
      fallback: 0,
      models: [{ model, requests: 2 }],
      tokens: { input: 30, output: 5, reasoning: 1, cache: { read: 100, write: 5 } },
      latestInvalidation: "tool-prefix-changed",
      latestNamespace: "abcdef12",
    })
    const records = yield* service.list(sessionID)
    expect(records[0]).toMatchObject({ cost: 0.01 })
    expect(records[1]).not.toHaveProperty("cost")
  }),
)

it.effect("records logical requests, physical attempts, sources, and token cost without prompt content", () =>
  Effect.gen(function* () {
    const sessionID = SessionV2.ID.make("ses_provider_request")
    yield* insertSession(sessionID)
    const service = yield* SessionProviderRequest.Service
    const tracker = yield* service.next({
      sessionID,
      inputID: SessionMessage.ID.make("msg_provider_request"),
      source: "step",
      agent: AgentV2.ID.make("build"),
      model: ModelV2.Ref.make({ id: ModelV2.ID.make("gpt-5.6"), providerID: ProviderV2.ID.make("openai") }),
      routeID: "openai-responses",
      promptCacheKey: "cache-key",
      systemDigest: "system-digest",
      toolDigest: "tool-digest",
    })

    yield* tracker.observeAttempt({
      requestID: tracker.requestID,
      routeID: "openai-responses",
      transport: "http-json",
      attempt: 1,
      phase: "started",
      time: 1,
    })
    yield* tracker.observeAttempt({
      requestID: tracker.requestID,
      routeID: "openai-responses",
      transport: "http-json",
      attempt: 1,
      phase: "failed",
      time: 2,
      error: "retryable transport failure",
    })
    yield* tracker.observeAttempt({
      requestID: tracker.requestID,
      routeID: "openai-responses",
      transport: "http-json",
      attempt: 2,
      phase: "started",
      time: 3,
    })
    yield* tracker.complete({
      invalidation: "first-request",
      continuation: "full",
      cost: Money.USD.make(0.0123),
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 50 } },
    })
    yield* tracker.complete({
      invalidation: "first-request",
      continuation: "full",
      cost: Money.USD.make(0.0123),
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 50 } },
    })

    const records = yield* service.list(sessionID)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      sessionID,
      source: "step",
      request: 1,
      attempts: 2,
      invalidation: "first-request",
      continuation: "full",
      promptCacheKey: "cache-key",
      systemDigest: "system-digest",
      toolDigest: "tool-digest",
      cost: Money.USD.make(0.0123),
    })
    expect(Object.keys(records[0] ?? {}).sort()).toEqual([
      "agent",
      "attempts",
      "continuation",
      "cost",
      "id",
      "inputID",
      "invalidation",
      "model",
      "promptCacheKey",
      "request",
      "routeID",
      "sessionID",
      "source",
      "systemDigest",
      "time",
      "tokens",
      "toolDigest",
    ])

    expect(yield* service.summary(sessionID)).toEqual({
      logical: 1,
      physical: 2,
      helpers: 0,
      continued: 0,
      fallback: 0,
      cost: Money.USD.make(0.0123),
      models: [
        {
          model: ModelV2.Ref.make({ id: ModelV2.ID.make("gpt-5.6"), providerID: ProviderV2.ID.make("openai") }),
          requests: 1,
          cost: Money.USD.make(0.0123),
        },
      ],
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 50 } },
      latestInvalidation: "first-request",
      latestNamespace: "cache-ke",
    })
  }),
)

it.effect("groups summary spend by model with deterministic ordering and unreported group cost", () =>
  Effect.gen(function* () {
    const sessionID = SessionV2.ID.make("ses_provider_request_model_spend")
    yield* insertSession(sessionID)
    const service = yield* SessionProviderRequest.Service
    const model = (providerID: string, id: string, variant?: string) =>
      ModelV2.Ref.make({
        id: ModelV2.ID.make(id),
        providerID: ProviderV2.ID.make(providerID),
        ...(variant === undefined ? {} : { variant: ModelV2.VariantID.make(variant) }),
      })
    const record = Effect.fnUntraced(function* (selected: ModelV2.Ref, cost?: number) {
      const tracker = yield* service.next({
        sessionID,
        source: "step",
        agent: AgentV2.ID.make("build"),
        model: selected,
        routeID: "openai-responses",
        promptCacheKey: "cache-key",
        systemDigest: "system",
        toolDigest: "tools",
      })
      yield* tracker.complete({
        continuation: "full",
        ...(cost === undefined ? {} : { cost: Money.USD.make(cost) }),
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    yield* record(model("openai", "gpt-5.6"), 0.75)
    yield* record(model("openai", "gpt-5.6", "high"), 0.25)
    yield* record(model("openai", "gpt-5.6", "high"), 0.25)
    yield* record(model("openai", "gpt-5.6", "low"), 0.5)
    yield* record(model("openai", "aaa-model"), 0.5)
    yield* record(model("zzz", "tie-model"), 0.5)
    yield* record(model("anthropic", "claude-sonnet-4"), 0.125)
    yield* record(model("anthropic", "claude-sonnet-4"))
    yield* record(model("zzz", "free-model"), 0)

    const summary = yield* service.summary(sessionID)
    expect(summary.models).toEqual([
      { model: model("openai", "gpt-5.6"), requests: 1, cost: Money.USD.make(0.75) },
      { model: model("openai", "aaa-model"), requests: 1, cost: Money.USD.make(0.5) },
      { model: model("openai", "gpt-5.6", "high"), requests: 2, cost: Money.USD.make(0.5) },
      { model: model("openai", "gpt-5.6", "low"), requests: 1, cost: Money.USD.make(0.5) },
      { model: model("zzz", "tie-model"), requests: 1, cost: Money.USD.make(0.5) },
      { model: model("zzz", "free-model"), requests: 1, cost: Money.USD.zero },
      { model: model("anthropic", "claude-sonnet-4"), requests: 2 },
    ])
    // One anthropic request never reported a cost, so neither its group nor the session total may claim one.
    expect(summary).not.toHaveProperty("cost")
  }),
)

it.effect("prioritizes compaction and model cache reset diagnostics while normalizing legacy default variants", () =>
  Effect.gen(function* () {
    const sessionID = SessionV2.ID.make("ses_provider_request_resets")
    yield* insertSession(sessionID)
    const service = yield* SessionProviderRequest.Service
    const model = (id: string, variant?: string) =>
      ModelV2.Ref.make({
        id: ModelV2.ID.make(id),
        providerID: ProviderV2.ID.make("openai"),
        ...(variant === undefined ? {} : { variant: ModelV2.VariantID.make(variant) }),
      })
    const record = Effect.fnUntraced(function* (
      source: "step" | "compaction",
      selected: ModelV2.Ref,
      promptCacheKey: string,
    ) {
      const tracker = yield* service.next({
        sessionID,
        source,
        agent: AgentV2.ID.make("build"),
        model: selected,
        routeID: "openai-responses",
        promptCacheKey,
        systemDigest: "system",
        toolDigest: "tools",
      })
      yield* tracker.complete({
        continuation: "full",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    })

    yield* record("step", model("gpt-5.6"), "normal-default")
    yield* record("step", model("gpt-5.6", "default"), "normal-default")
    yield* record("compaction", model("summary-model"), "compaction")
    yield* record("step", model("gpt-5.7"), "after-compaction")
    yield* record("step", model("gpt-5.8"), "model-switch")
    yield* record("step", model("gpt-5.8", "high"), "variant-switch")

    expect((yield* service.list(sessionID)).map((item) => item.invalidation)).toEqual([
      "first-request",
      "provider-not-reported",
      "model-switched",
      "compaction-reset",
      "model-switched",
      "model-variant-switched",
    ])
  }),
)
