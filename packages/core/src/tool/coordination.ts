export * as CoordinationTool from "./coordination"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context } from "@ycoding-ai/plugin/effect/plugin"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Form } from "@ycoding-ai/schema/form"
import { Model } from "@ycoding-ai/schema/model"
import { Session } from "@ycoding-ai/schema/session"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { SessionDelivery } from "@ycoding-ai/schema/session-delivery"
import { Effect, Schema } from "effect"
import { CoordinationRuntime } from "../session/coordination-runtime"
import { CoordinationAccess } from "../session/coordination-access"
import { Tool } from "./tool"

export const name = CoordinationAccess.tool
const target = { sessionID: Session.ID }
export const Input = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literal("send"),
    ...target,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000)),
    delivery: SessionDelivery.Delivery.pipe(Schema.optional),
    messageID: SessionMessage.ID.pipe(Schema.optional),
    model: Model.Ref.pipe(Schema.optional),
  }),
  Schema.Struct({
    action: Schema.Literal("answer"),
    ...target,
    requestID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    kind: Coordination.RequestKind,
    fingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    rationale: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(500)),
    confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.optional),
    answer: Form.Answer.pipe(Schema.optional),
    decision: Schema.Literals(["approve", "decline"]).pipe(Schema.optional),
  }),
  Schema.Struct({
    action: Schema.Literal("escalate"),
    ...target,
    requestID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    kind: Coordination.RequestKind,
    fingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    reason: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(500)),
  }),
  Schema.Struct({ action: Schema.Literal("interrupt"), ...target }),
])
export type Input = typeof Input.Type

export const description = [
  "Direct the Project this Session is the Master of, or that its Master launched this subagent for.",
  "The Master and its supervising subagents only coordinate: delegate all implementation, reading, editing, checks, and commits to members.",
  "list: members with state (idle, running, waiting, failed), pending requests with request IDs and fingerprints, and last activity.",
  "send: admit a message to a member (steer or queue, default queue); returns immediately. An optional messageID makes retries idempotent; an optional model overrides the model for the turn the message starts.",
  "answer: settle a member's pending question, permission, or review under the delegated-decision policy. decision: approve (default) or decline; decline rejects a routine permission or review with your rationale as the member's feedback. Hard, human-only, Manual-mode, and uncertain cases are refused with a reason.",
  "escalate: pass a pending request you cannot settle up the chain with a reason. From a Master subagent it goes to the Master; from the Master it goes to the human, with every reason attached to the member's pending prompt. A request already deferred to the human's review box returns deferred-to-review-box with its item ID. Escalate whatever answer refuses.",
  "interrupt: stop a member's running turn.",
  "Member events (turn settled, question, form, permission ask, guardrail review) arrive automatically as Project notifications; do not poll. Message text never settles a control.",
].join("\n")

export const Plugin = {
  id: "ycoding.tool.project",
  effect: Effect.fn("CoordinationTool.Plugin")(function* (ctx: Context) {
    const runtime = yield* CoordinationRuntime.Service
    yield* ctx.tool.transform((draft) => draft.add(name, Tool.make({
      description,
      input: Input,
      output: Schema.Record(Schema.String, Schema.Unknown),
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
      execute: (value, context) => Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(Input)(value, { onExcessProperty: "error" }).pipe(
          Effect.mapError(() => new ToolFailure({ message: "Invalid project operation" })),
        )
        const caller = context.sessionID
        if (input.action === "list") return { action: "list" as const, ...(yield* runtime.roster(caller)) }
        if (input.action === "send")
          return { action: "send" as const, ...(yield* runtime.send(caller, {
            sessionID: input.sessionID, text: input.text,
            ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
            ...(input.messageID === undefined ? {} : { messageID: input.messageID }),
            ...(input.model === undefined ? {} : { model: input.model }),
          })) }
        if (input.action === "answer")
          return { action: "answer" as const, result: yield* runtime.answer(caller, input) }
        if (input.action === "escalate")
          return { action: "escalate" as const, ...(yield* runtime.escalate(caller, input)) }
        return { action: "interrupt" as const, ...(yield* runtime.interrupt(caller, input)) }
      }).pipe(Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({ message: error.message, error }))),
    }), { codemode: false })).pipe(Effect.orDie)
  }),
}
