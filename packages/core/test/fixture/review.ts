import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { EventRuntime } from "@ycoding-ai/core/event"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { tmpdir } from "./tmpdir"

export const reviewLayer = (database?: ReturnType<typeof Database.layer>, includeReview = true, decision?: Decision.Interface["evaluate"]) => AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, Session.node, SessionStore.node, SessionAutonomy.node, SessionOrchestration.node, ...(includeReview ? [SessionReview.node] : []), LocationServiceMap.node]),
  [
    [Project.node, Layer.mock(Project.Service, {
      resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
      recordOpened: () => Effect.void,
    })],
    [SessionExecution.node, SessionExecution.noopLayer],
    [KeepAwake.node, Layer.mock(KeepAwake.Service, {
      hold: () => Effect.succeed({ state: "off" as const }), release: () => Effect.succeed({ state: "off" as const }),
      get: Effect.succeed({ state: "off", lid: "off", sleepHold: false } as const),
    })],
    [Decision.node, Layer.mock(Decision.Service, { evaluate: decision ?? ((input: Decision.Input) => Effect.succeed(Schema.decodeUnknownSync(Decision.Output)({
      provider: "agent", response: {
        model: { providerID: "test", id: "review-decision" }, semantics: "model-estimate", version: 1,
        answers: input.request.questions.map((question) => ({ name: question.name, type: question.type,
          answer: question.type === "predicate" ? true : null, choice: question.type === "choice" ? "escalate" : null,
          score: null, confidence: 0.7,
          ...(question.type === "choice" && question.grade ? {
            choice: null, confidence: 0,
            grades: question.choices.map((choice) => ({ choice: choice.value,
              confidence: choice.value === "escalate" ? 0.7 : 0.1, evidence: "The fixture requires human review." })),
          } : {}),
        })),
      },
    }))) } )],
    ...(database ? [[Database.node, database] as const] : []),
  ],
)

export const reviewLocation = Effect.gen(function* () {
  const directory = yield* Effect.promise(() => tmpdir("ycoding-review-"))
  yield* Effect.addFinalizer(() => Effect.promise(() => directory[Symbol.asyncDispose]()))
  yield* Effect.promise(() => Bun.write(`${directory.path}/ycoding.json`, JSON.stringify({ guardrails: { decide_reviews: true } })))
  return Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
})
