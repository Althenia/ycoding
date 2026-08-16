export * as SessionGoal from "./goal"

import { LLM, LLMClient, LLMError, LLMEvent, Message, type LLMRequest } from "@ycoding-ai/ai"
import { Context, Effect, Layer, Stream } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionHistory } from "./history"
import { SessionModelHeaders } from "./model-headers"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { SessionUsage } from "./usage"

const MAX_CONTEXT_CHARS = 6_000

type Dependencies = {
  readonly headers?: SessionModelHeaders.Options
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly agents: AgentV2.Interface
  readonly models: SessionRunnerModel.Interface
}

export interface Interface {
  readonly synthesize: (input: {
    session: SessionSchema.Info
    text: string
  }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionGoal") {}

const make = (dependencies: Dependencies) => {
  const synthesize = Effect.fn("SessionGoal.synthesize")(function* (
    db: Database.Interface["db"],
    input: Parameters<Interface["synthesize"]>[0],
  ) {
    const agent = yield* dependencies.agents.get(AgentV2.ID.make("goal"))
    if (!agent) return
    const resolved = yield* (
      agent.model
        ? dependencies.models.resolve({ ...input.session, model: agent.model })
        : dependencies.models.resolve(input.session)
    ).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!resolved) return
    const context = (yield* SessionHistory.load(db, input.session.id))
      .slice(-12)
      .flatMap((message) => {
        if (message.type === "user") return [`User: ${message.text}`]
        if (message.type === "assistant")
          return [
            `Assistant: ${message.content
              .filter((part) => part.type === "text" || part.type === "reasoning")
              .map((part) => part.text)
              .join("\n")}`,
          ]
        if (message.type === "system" || message.type === "synthetic" || message.type === "skill")
          return [`Context: ${message.text}`]
        return []
      })
      .join("\n")
      .slice(-MAX_CONTEXT_CHARS)
    const chunks: string[] = []
    let failed = false
    let usage: SessionUsage.Recorded | undefined
    const recordUsage = Effect.suspend(() =>
      usage
        ? dependencies.events.publish(SessionEvent.UsageRecorded, {
            sessionID: input.session.id,
            source: "goal",
            ...usage,
          })
        : Effect.void,
    )
    const streamed = yield* dependencies.llm
      .stream(
        LLM.request({
          model: resolved.model,
          http: { headers: SessionModelHeaders.make(input.session, dependencies.headers) },
          system: agent.system,
          messages: [
            Message.user(
              [
                "Recent conversation context:",
                context || "(none)",
                "",
                "User request:",
                input.text,
              ].join("\n"),
            ),
          ],
          tools: [],
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          if (LLMEvent.is.stepFinish(event)) {
            const step = SessionUsage.record(event.usage, resolved.cost)
            usage = usage ? SessionUsage.add(usage, step) : step
          }
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
        Effect.onInterrupt(() => recordUsage.pipe(Effect.asVoid)),
      )
    yield* recordUsage
    if (!streamed || failed) return
    return chunks.join("").trim().replace(/\s+/g, " ") || undefined
  })
  return { synthesize }
}

export const layer = (options?: SessionModelHeaders.Options) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const models = yield* SessionRunnerModel.Service
    const database = yield* Database.Service
    const goal = make({ events, llm, agents, models, headers: options })
    return Service.of({
      synthesize: (input) => goal.synthesize(database.db, input).pipe(Effect.catch(() => Effect.succeed(undefined))),
    })
  }),
)

export function configured(options?: SessionModelHeaders.Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [EventV2.node, llmClient, AgentV2.node, SessionRunnerModel.node, Database.node],
  })
}

export const node = configured()
