import { expect } from "bun:test"
import { LLM, LLMClient, Message, SystemPart } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { RequestExecutor } from "@ycoding-ai/ai/route"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import type { SessionContext } from "@ycoding-ai/core/session/context"
import { SessionEffort } from "@ycoding-ai/core/session/effort"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionMessageTable, SessionProviderRequestTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Effect } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layer({ path: ":memory:" })).effect

for (const { id, profileSwitch, provider, accountState, guarded, proMode, mismatch } of [
  { id: "gpt-6.1-sol", profileSwitch: false, provider: "openai", accountState: "same", guarded: false },
  { id: "gpt-6.1-terra", profileSwitch: false, provider: "openai", accountState: "same", guarded: false },
  { id: "gpt-6.1-sol", profileSwitch: true, provider: "openai", accountState: "same", guarded: false },
  { id: "gpt-6.1-sol", profileSwitch: true, provider: "openai", accountState: "missing", guarded: false },
  { id: "gpt-6.1-sol", profileSwitch: true, provider: "openai", accountState: "different", guarded: false },
  { id: "gpt-6.1-sol", profileSwitch: true, provider: "openai", accountState: "both-missing", guarded: false },
  { id: "gpt-6.1-sol", profileSwitch: true, provider: "openai", accountState: "both-empty", guarded: false },
  { id: "gpt-6.1-sol", profileSwitch: false, provider: "openai", accountState: "both-missing", guarded: false },
  { id: "gpt-6.1-sol", profileSwitch: false, provider: "openai", accountState: "same", guarded: true },
  { id: "gpt-6.1-sol", profileSwitch: false, provider: "openai", accountState: "same", guarded: true, proMode: true },
  {
    id: "gpt-6.1-sol",
    profileSwitch: false,
    provider: "openai",
    accountState: "same",
    guarded: false,
    mismatch: "route",
  },
  {
    id: "gpt-6.1-sol",
    profileSwitch: false,
    provider: "openai",
    accountState: "same",
    guarded: false,
    mismatch: "namespace",
  },
  {
    id: "gpt-6.1-sol",
    profileSwitch: false,
    provider: "openai",
    accountState: "same",
    guarded: false,
    mismatch: "model",
  },
  { id: "gpt-5.6", profileSwitch: false, provider: "openai", accountState: "same", guarded: true },
  { id: "claude-opus-5", profileSwitch: true, provider: "anthropic", accountState: "same", guarded: false },
]) {
  it(`${id} ${profileSwitch ? "default to named profile" : "effort variant"} ${accountState}${mismatch ? ` ${mismatch} mismatch` : proMode ? " pro-mode" : guarded ? " guarded" : ""}`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessionID = Session.ID.make(`ses_effort_${id}`)
      const assistantID = SessionMessage.ID.make(`msg_effort_${id}`)
      const low = CatalogModel.VariantID.make("low")
      const high = CatalogModel.VariantID.make("high")
      const account = "a".repeat(64)
      const priorAccount = accountState === "both-missing" ? undefined : accountState === "both-empty" ? "" : account
      const providerID = Provider.ID.make(provider)
      const catalog = CatalogModel.Info.make({
        ...CatalogModel.Info.empty(providerID, CatalogModel.ID.make(id)),
        modelID: CatalogModel.ID.make(id),
        package: Provider.aisdk(provider === "openai" ? "@ai-sdk/openai" : "@ai-sdk/anthropic"),
        settings: { apiKey: "fixture-key", ...(provider === "anthropic" ? { thinking: { type: "adaptive" } } : {}) },
        variants: [
          { id: low, settings: provider === "openai" ? { reasoningEffort: "low" } : { effort: "low" } },
          { id: high, settings: provider === "openai" ? { reasoningEffort: "high" } : { effort: "high" } },
        ],
      })
      const resolve = (variant: CatalogModel.VariantID) =>
        SessionRunnerModel.withVariant(catalog, variant).pipe(
          Effect.flatMap((model) => SessionRunnerModel.fromCatalogModel(model)),
        )
      const lowModel = yield* resolve(low)
      const highModel = yield* resolve(high)
      const system = [SystemPart.make("stable prefix ".repeat(3000))]
      const cache = SessionRunnerCache.providerOptions({
        projectID: "project",
        directory: "/fixture",
        providerID: provider,
        modelID: id,
        apiModelID: id,
        sessionID,
        routeID: lowModel.route.id,
        policyRevision: CACHE_POLICY_REVISION,
        permissions: [],
        system,
        tools: [],
        openaiMode: "auto",
      })
      const firstMessages = [
        Message.user("Original request"),
        Message.make({ id: assistantID, role: "assistant", content: "Original reply" }),
      ]
      const capture = (request: ReturnType<typeof LLM.request>) =>
        Effect.gen(function* () {
          const bodies: Array<Record<string, unknown>> = []
          yield* LLMClient.generate(request).pipe(
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
          return bodies[0]!
        })
      let first = yield* capture(
        LLM.request({
          model: lowModel,
          system,
          messages: [firstMessages[0]!],
          cache: cache.cache,
          providerOptions: cache.providerOptions,
        }),
      )
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] })
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, directory: "/fixture", title: "fixture" })
      yield* db
        .insert(SessionMessageTable)
        .values({ id: assistantID, session_id: sessionID, type: "assistant", seq: 1, data: {} as never })
      yield* db.insert(SessionProviderRequestTable).values({
        id: ProviderRequest.ID.make(`prq_${id}`),
        session_id: sessionID,
        assistant_message_id: assistantID,
        connection_identity_digest: priorAccount ?? null,
        source: "step",
        agent: Agent.defaultID,
        model: { providerID, id: CatalogModel.ID.make(mismatch === "model" ? "different-model" : id), variant: low },
        route_id: mismatch === "route" ? "different-route" : lowModel.route.id,
        prompt_cache_key: mismatch === "namespace" ? "different-namespace" : cache.promptCacheKey,
        system_digest: "s",
        tool_digest: "t",
        request: 1,
        attempts: 1,
        invalidation: "first-request",
        continuation: "full",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time_created: 0,
      })
      const context = {
        session: { id: sessionID },
        contextRevision: 0,
        model: {
          ref: { providerID, id: CatalogModel.ID.make(id), variant: high },
          accountIdentityDigest: priorAccount,
        },
        messages: [{ type: "assistant", id: assistantID }],
      } as unknown as SessionContext.Loaded
      const input = LLM.request({
        model: highModel,
        system,
        messages: [...firstMessages, Message.user("Next request")],
        cache: cache.cache,
        providerOptions: cache.providerOptions,
        ...(guarded && id !== "gpt-5.6"
          ? { http: { body: proMode ? { reasoning: { mode: "pro" } } : { truncation: "auto" } } }
          : {}),
      })
      const prepare = (selected: SessionContext.Loaded) =>
        SessionEffort.prepare({
          db,
          context: selected,
          request: input,
          namespace: cache.promptCacheKey,
          catalog: { model: { get: () => Effect.succeed(catalog) } } as never,
        })
      if (profileSwitch) {
        first = yield* capture((yield* prepare(context)).request)
        if (provider === "openai")
          expect(first.input).toContainEqual({ type: "configuration_update", reasoning: { effort: "high" } })
        else expect(first.messages).toContainEqual({ role: "system", content: [], output_config: { effort: "high" } })
      }
      const prepared = yield* prepare(
        profileSwitch
          ? {
              ...context,
              model: {
                ...context.model,
                ref: { ...context.model.ref, profile: "named" },
                accountIdentityDigest:
                  accountState === "same"
                    ? account
                    : accountState === "different"
                      ? "b".repeat(64)
                      : accountState === "both-empty"
                        ? ""
                        : undefined,
              },
            }
          : context,
      )
      const second = yield* capture(prepared.request)
      const preserved =
        (accountState === "same" || (accountState === "both-missing" && !profileSwitch)) && !guarded && !mismatch
      if (provider === "openai") {
        expect(first.reasoning).toMatchObject({ effort: "low" })
        expect(second.prompt_cache_key).toBe(first.prompt_cache_key)
        expect(second.reasoning).toMatchObject({ effort: preserved ? "low" : "high" })
        if (preserved)
          expect(second.input).toContainEqual({ type: "configuration_update", reasoning: { effort: "high" } })
        else expect(second.input).not.toContainEqual({ type: "configuration_update", reasoning: { effort: "high" } })
        if (profileSwitch && preserved) expect(second.input).toEqual(first.input)
      } else {
        expect(first.output_config).toMatchObject({ effort: "low" })
        expect(second.output_config).toMatchObject({ effort: "low" })
        expect(second.messages).toEqual(first.messages)
      }
    }))
}
