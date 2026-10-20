export * as Decision from "./decision"

import { DecisionFailure } from "@ycoding-ai/schema/decision-failure"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Cause, Clock, Context, Deferred, Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { Agent } from "./agent"
import { DecisionAgent } from "./decision-agent"
import { DecisionJudgment } from "./decision-judgment"
import { makeLocationNode } from "./effect/app-node"
import { SessionMessage } from "./session/message"
import { SessionSchema } from "./session/schema"
import { Hash } from "./util/hash"

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
    if (this.reason === "invalid-request") return "Invalid decision request. Supply provider: agent and request: { state, questions } with 1–32 uniquely named predicate, choice, score, or text questions."
    if (this.reason === "input-too-large") return "Decision request exceeds 1 MiB. Reduce evidence to the bounded facts and criteria needed for the judgment."
    if (this.reason === "refused") return "The provider or model refused the decision request. Treat this as uncertainty; decide from evidence or report the blocker without repeated probes."
    if (this.reason === "truncated-output") return "Decision helper output was truncated or did not finish. Treat this as uncertainty; reduce the evidence or decide from evidence without retrying an unchanged judgment automatically."
    if (this.reason === "unsupported-output") return "The selected decision model route does not support strict structured JSON decisions. Configure a decision model on a verified strict route, or decide from evidence."
    if (this.reason === "timeout") return "Decision helper request timed out. Treat this as uncertainty; check the model route or decide from evidence. Do not assume cancellation prevented provider billing or retry unchanged input automatically."
    return "Decision helper request did not settle successfully. Treat this as uncertainty; check the model route or decide from evidence. Do not assume cancellation prevented provider billing or retry unchanged input automatically."
  }
}

export type Purpose = "permission" | "guardrail" | "answer"
export type Authority = Guardrail.Authority

export interface Invocation {
  readonly sessionID: SessionSchema.ID
  readonly agent?: Agent.ID
  readonly inputID?: SessionMessage.ID
  readonly purpose?: Purpose
  readonly authority?: Authority
  readonly invocationKey?: string
}

export interface Interface {
  readonly evaluate: (value: Input, context: Invocation) => Effect.Effect<Output, Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Decision") {}

const MAX_SETTLED = 128

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const agent = yield* DecisionAgent.Service
  const settled = new Map<string, Output>()
  const inflight = new Map<string, Deferred.Deferred<Output | undefined, Error>>()
  const evaluate = Effect.fn("Decision.evaluate")(function* (value: Input, context: Invocation) {
    const decoded = yield* Schema.decodeUnknownEffect(Input)(value).pipe(Effect.mapError(() => new Error({ reason: "invalid-request" })))
    if (Buffer.byteLength(JSON.stringify(decoded)) > 1_048_576) return yield* new Error({ reason: "input-too-large" })
    if (invalidInvocation(context)) return yield* new Error({ reason: "invalid-request" })
    const startedAt = yield* Clock.currentTimeMillis
    const invocation = { ...context, startedAt }
    const remaining = Clock.currentTimeMillis.pipe(
      Effect.map((now) => Math.max(0, DecisionAgent.TOTAL_TIMEOUT_MS - (now - startedAt))),
    )
    const preflight = remaining.pipe(
      Effect.flatMap((limit) => agent.modelKey(invocation).pipe(Effect.timeoutOption(Duration.millis(limit)))),
    )
    const run = agent.evaluate(decoded.request, invocation).pipe(
      Effect.map((response): Output => ({ provider: "agent", response })),
      Effect.mapError((error) => new Error({ reason: error.reason })),
    )
    if (context.invocationKey === undefined) return yield* run
    const resolved = yield* preflight
    if (Option.isNone(resolved)) return yield* new Error({ reason: "timeout" })
    const model = resolved.value
    const key = [
      context.sessionID,
      context.purpose ?? "advisory",
      context.authority ?? "advisory",
      DecisionAgent.agentFor(context),
      model,
      context.invocationKey,
      Hash.json(decoded.request),
    ].join("\0")
    while (true) {
      const claim = yield* Effect.uninterruptible(Effect.gen(function* () {
        const done = settled.get(key)
        if (done) return { type: "done" as const, output: done }
        const waiting = inflight.get(key)
        if (waiting) return { type: "wait" as const, deferred: waiting }
        const deferred = yield* Deferred.make<Output | undefined, Error>()
        inflight.set(key, deferred)
        return { type: "lead" as const, deferred }
      }))
      if (claim.type === "done") return claim.output
      if (claim.type === "wait") {
        const joined = yield* Deferred.await(claim.deferred)
        if (joined !== undefined) return joined
        continue
      }
      return yield* run.pipe(
        Effect.onExit((exit) => Effect.gen(function* () {
          if (Exit.isSuccess(exit)) {
            const current = yield* preflight
            if (Option.isSome(current) && current.value === model) {
              settled.set(key, exit.value)
              while (settled.size > MAX_SETTLED) {
                const oldest = settled.keys().next().value
                if (oldest === undefined) break
                settled.delete(oldest)
              }
            }
            return yield* Deferred.succeed(claim.deferred, exit.value)
          }
          if (Cause.hasInterrupts(exit.cause)) return yield* Deferred.succeed(claim.deferred, undefined)
          return yield* Deferred.failCause(claim.deferred, exit.cause)
        }).pipe(Effect.ensuring(Effect.sync(() => {
          if (inflight.get(key) === claim.deferred) inflight.delete(key)
        })))),
      )
    }
  })
  return Service.of({
    evaluate: (value, context) =>
      evaluate(value, context).pipe(
        Effect.timeoutOption(Duration.millis(DecisionAgent.TOTAL_TIMEOUT_MS)),
        Effect.flatMap((result) => (Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(new Error({ reason: "timeout" })))),
      ),
  })
}))

function invalidInvocation(context: Invocation) {
  if (context.invocationKey !== undefined && (context.invocationKey.length === 0 || context.invocationKey.length > 256)) return true
  if ((context.purpose === undefined) !== (context.authority === undefined)) return true
  return context.purpose === "answer" && context.authority === "baseline"
}

export const node = makeLocationNode({ service: Service, layer, deps: [DecisionAgent.node] })
