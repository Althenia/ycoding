export * as Decision from "./decision"

import { OpenAIDecisions } from "@ycoding-ai/ai/openai-decisions"
import { TypeSafeDecisions } from "@ycoding-ai/ai/typesafe-decisions"
import { Usage } from "@ycoding-ai/ai"
import { ProviderShared } from "@ycoding-ai/ai/protocols/shared"
import { RequestExecutor, TransportAttempt } from "@ycoding-ai/ai/route"
import { Money } from "@ycoding-ai/schema/money"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "./agent"
import { Config } from "./config"
import { ConfigDecisions } from "./config/decisions"
import { Credential } from "./credential"
import { makeLocationNode } from "./effect/app-node"
import { requestExecutor } from "./effect/app-node-platform"
import { EventRuntime } from "./event"
import { Integration } from "./integration"
import { CatalogModel } from "./model"
import { Provider } from "./provider"
import { SessionEvent } from "./session/event"
import { SessionMessage } from "./session/message"
import { SessionProviderRequest } from "./session/provider-request"
import { SessionSchema } from "./session/schema"
import { SessionStore } from "./session/store"
import { SessionUsage } from "./session/usage"
import { Hash } from "./util/hash"

export const Input = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("openai"), request: OpenAIDecisions.Request }),
  Schema.Struct({ provider: Schema.Literal("typesafe"), request: TypeSafeDecisions.Request }),
])
export type Input = typeof Input.Type

export const Output = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("openai"), response: OpenAIDecisions.Response }),
  Schema.Struct({ provider: Schema.Literal("typesafe"), response: TypeSafeDecisions.Response }),
])
export type Output = typeof Output.Type

export class Error extends Schema.TaggedErrorClass<Error>()("Decision.Error", {
  reason: Schema.Literals(["unavailable", "invalid-request", "provider-failed", "timeout", "input-too-large"]),
}) {
  override get message() {
    return `Decision request failed (${this.reason}). Check the selected decision provider and configuration.`
  }
}

export interface Invocation {
  readonly sessionID: SessionSchema.ID
  readonly agent?: Agent.ID
  readonly inputID?: SessionMessage.ID
}

export interface ChoiceInput {
  readonly context: Invocation
  readonly provider: typeof ConfigDecisions.Provider.Type
  readonly state: Schema.Json
  readonly instructions: string
  readonly choices: Readonly<Record<string, string>>
}

export interface Choice {
  readonly choice?: string
  readonly probability?: number
  readonly refused: boolean
}

export interface Interface {
  readonly settings: () => Effect.Effect<ConfigDecisions.Info | undefined>
  readonly evaluate: (input: Input, context: Invocation) => Effect.Effect<Output, Error>
  readonly choose: (input: ChoiceInput) => Effect.Effect<Choice, Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Decision") {}

export function make(input: {
  readonly settings: Interface["settings"]
  readonly credentials: Pick<Credential.Interface, "list">
  readonly agents: Pick<Agent.Interface, "select">
  readonly store: Pick<SessionStore.Interface, "get">
  readonly executor: RequestExecutor.Interface
  readonly requests: SessionProviderRequest.Interface
  readonly events: EventRuntime.Interface
  readonly environment?: Readonly<Record<string, string | undefined>>
}): Interface {
  const evaluate = Effect.fn("Decision.evaluate")(function* (value: Input, context: Invocation) {
    const decoded = yield* Schema.decodeUnknownEffect(Input)(value).pipe(
      Effect.mapError(() => new Error({ reason: "invalid-request" })),
    )
    if (Buffer.byteLength(JSON.stringify(decoded)) > 1_048_576)
      return yield* new Error({ reason: "input-too-large" })
    const settings = yield* input.settings()
    const connection = settings?.providers?.[decoded.provider]
    const selected = (yield* input.credentials.list(Integration.ID.make(decoded.provider))).find((credential) => credential.active)
    const apiKey = connection?.api_key ??
      (selected?.value.type === "key" ? selected.value.key : undefined) ??
      (input.environment ?? process.env)[decoded.provider === "openai" ? "OPENAI_API_KEY" : "TYPESAFE_API_KEY"]
    if (!apiKey?.trim()) return yield* new Error({ reason: "unavailable" })
    const agent = context.agent ?? (yield* input.store.get(context.sessionID).pipe(
      Effect.flatMap((session) => input.agents.select(session?.agent)),
      Effect.map((selected) => selected.id),
    ))
    const routeID = decoded.provider === "openai" ? "openai-decisions" : "typesafe-decisions"
    const tracker = yield* input.requests.next({
      sessionID: context.sessionID,
      inputID: context.inputID,
      source: "decision",
      agent,
      model: { providerID: Provider.ID.make(decoded.provider), id: CatalogModel.ID.make(decoded.request.model) },
      routeID,
      promptCacheKey: `decision:${decoded.provider}:${decoded.request.model}`,
      systemDigest: Hash.sha256(JSON.stringify(decoded.request.questions)),
      toolDigest: Hash.sha256("[]"),
    })
    const operation = decoded.provider === "openai"
      ? OpenAIDecisions.evaluate(decoded.request, { apiKey, baseURL: connection?.base_url }).pipe(
          Effect.map((response): Output => ({ provider: "openai", response })),
        )
      : TypeSafeDecisions.evaluate(decoded.request, { apiKey, baseURL: connection?.base_url }).pipe(
          Effect.map((response): Output => ({ provider: "typesafe", response })),
        )
    const failed = tracker.complete({
      continuation: "full", invalidation: "cache-disabled", cacheReadReported: false,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const exit = yield* TransportAttempt.track({
      requestID: tracker.requestID, routeID, transport: "http-json", attempt: 1, observer: tracker.observeAttempt,
    }, operation.pipe(
      Effect.provideService(RequestExecutor.Service, input.executor),
      Effect.mapError(() => new Error({ reason: "provider-failed" })),
      Effect.timeoutOrElse({ duration: settings?.timeout_ms ?? 10_000, orElse: () => Effect.fail(new Error({ reason: "timeout" })) }),
    )).pipe(Effect.onInterrupt(() => failed), Effect.exit)
    if (Exit.isFailure(exit)) {
      yield* failed
      return yield* Effect.failCause(exit.cause)
    }
    const result = exit.value
    const usage = result.response.usage
    const read = result.provider === "openai" ? result.response.usage.input_tokens_details?.cached_tokens : undefined
    const write = result.provider === "openai" ? result.response.usage.input_tokens_details?.cache_write_tokens : undefined
    const tokens = SessionUsage.tokens(new Usage({
      ...ProviderShared.normalizeInputUsage({ semantics: "inclusive-total", total: usage.input_tokens, cacheRead: read, cacheWrite: write }),
      outputTokens: usage.output_tokens,
      reasoningTokens: result.provider === "openai" ? result.response.usage.output_tokens_details?.reasoning_tokens : undefined,
    }))
    yield* tracker.complete({
      tokens, continuation: "full", invalidation: "cache-disabled", cacheReadReported: read !== undefined,
    })
    yield* input.events.publish(SessionEvent.UsageRecorded, {
      sessionID: context.sessionID, source: "decision", tokens, cost: Money.USD.zero,
    })
    return result
  })

  return {
    settings: input.settings,
    evaluate,
    choose: Effect.fn("Decision.choose")(function* (value) {
      const settings = yield* input.settings()
      const result = yield* evaluate(value.provider === "openai" ? {
        provider: "openai",
        request: {
          model: "gpt-6-luna", input: JSON.stringify(value.state),
          questions: [{ type: "choice", name: "decision", instructions: value.instructions,
            choices: Object.entries(value.choices).map(([choice, description]) => ({ value: choice, description })) }],
        },
      } : {
        provider: "typesafe",
        request: { model: settings?.providers?.typesafe?.model ?? "jev-1.13.0", state: Schema.is(TypeSafeDecisions.Request.fields.state)(value.state) ? value.state : JSON.stringify(value.state),
          questions: { decision: { type: "choice", instructions: value.instructions, criteria: value.choices } } },
      }, value.context)
      if (result.provider === "openai") {
        const answer = result.response.answers[0]
        if (answer?.type !== "choice" || typeof answer.choice !== "string") return { refused: true }
        return { choice: answer.choice, probability: answer.probabilities.find((option) => option.value === answer.choice)?.probability, refused: false }
      }
      const answer = result.response.answers.decision
      if (answer?.type !== "choice") return { refused: true }
      return { choice: answer.choice, probability: answer.probabilities[answer.choice], refused: false }
    }),
  }
}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const config = yield* Config.Service
  const credentials = yield* Credential.Service
  const agents = yield* Agent.Service
  const store = yield* SessionStore.Service
  const executor = yield* RequestExecutor.Service
  const requests = yield* SessionProviderRequest.Service
  const events = yield* EventRuntime.Service
  return Service.of(make({
    settings: () => config.entries().pipe(Effect.map((entries) => Config.latest(entries, "decisions"))),
    credentials, agents, store, executor, requests, events,
  }))
}))

export const node = makeLocationNode({
  service: Service, layer,
  deps: [Config.node, Credential.node, Agent.node, SessionStore.node, requestExecutor, SessionProviderRequest.node, EventRuntime.node],
})
