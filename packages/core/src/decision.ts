export * as Decision from "./decision"

import { DecisionFailure } from "@ycoding-ai/schema/decision-failure"
import { Context, Effect, Layer, Schema } from "effect"
import { Agent } from "./agent"
import { DecisionAgent } from "./decision-agent"
import { DecisionJudgment } from "./decision-judgment"
import { makeLocationNode } from "./effect/app-node"
import { SessionMessage } from "./session/message"
import { SessionSchema } from "./session/schema"

export const Input = Schema.Struct({ provider: Schema.Literal("agent"), request: DecisionJudgment.Request })
export type Input = typeof Input.Type

export const Output = Schema.Struct({ provider: Schema.Literal("agent"), response: DecisionAgent.Response })
export type Output = typeof Output.Type

export class Error extends Schema.TaggedErrorClass<Error>()("Decision.Error", {
  reason: DecisionFailure.Reason,
}) {
  override get message() {
    if (this.reason === "unavailable") return "Decision helper unavailable. Verify agents.decision.model, efficiency.helper_models.decision, or the Session/default model and its authenticated route; decide from evidence or report the blocker without repeated probes."
    if (this.reason === "invalid-output") return "Decision helper returned invalid JSON or answers outside the requested schema. Treat this as uncertainty; clarify bounded evidence and criteria, or decide from evidence without retrying an unchanged judgment."
    if (this.reason === "invalid-request") return "Invalid decision request. Supply provider: agent and request: { state, questions } with 1–32 uniquely named predicate, choice, or score questions."
    if (this.reason === "input-too-large") return "Decision request exceeds 1 MiB. Reduce evidence to the bounded facts and criteria needed for the judgment."
    if (this.reason === "refused") return "The provider or model refused the decision request. Treat this as uncertainty; decide from evidence or report the blocker without repeated probes."
    if (this.reason === "truncated-output") return "Decision helper output was truncated or did not finish. Treat this as uncertainty; reduce the evidence or decide from evidence without retrying an unchanged judgment automatically."
    if (this.reason === "unsupported-output") return "The selected decision model route does not support strict structured JSON decisions. Configure a decision model on a verified strict route, or decide from evidence."
    if (this.reason === "timeout") return "Decision helper request timed out. Treat this as uncertainty; check the model route or decide from evidence. Do not assume cancellation prevented provider billing or retry unchanged input automatically."
    return "Decision helper request did not settle successfully. Treat this as uncertainty; check the model route or decide from evidence. Do not assume cancellation prevented provider billing or retry unchanged input automatically."
  }
}

export interface Invocation {
  readonly sessionID: SessionSchema.ID
  readonly agent?: Agent.ID
  readonly inputID?: SessionMessage.ID
}

export interface Interface {
  readonly evaluate: (input: Input, context: Invocation) => Effect.Effect<Output, Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Decision") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const agent = yield* DecisionAgent.Service
  return Service.of({
    evaluate: Effect.fn("Decision.evaluate")(function* (value, context) {
      const decoded = yield* Schema.decodeUnknownEffect(Input)(value).pipe(Effect.mapError(() => new Error({ reason: "invalid-request" })))
      if (Buffer.byteLength(JSON.stringify(decoded)) > 1_048_576) return yield* new Error({ reason: "input-too-large" })
      return yield* agent.evaluate(decoded.request, context).pipe(
        Effect.map((response): Output => ({ provider: "agent", response })),
        Effect.mapError((error) => new Error({ reason: error.reason })),
      )
    }),
  })
}))

export const node = makeLocationNode({ service: Service, layer, deps: [DecisionAgent.node] })
