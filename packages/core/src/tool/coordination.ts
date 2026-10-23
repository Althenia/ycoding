export * as CoordinationTool from "./coordination"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context } from "@ycoding-ai/plugin/effect/plugin"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Form } from "@ycoding-ai/schema/form"
import { Session } from "@ycoding-ai/schema/session"
import { Effect, Schema } from "effect"
import { CoordinationService } from "../coordination/index"
import { Permission } from "../permission"
import { CoordinationDecisions } from "../session/coordination-decisions"
import { Hash } from "../util/hash"
import { Tool } from "./tool"

const group = { groupID: Coordination.GroupID }
const revision = { ...group, revision: Coordination.Revision }
export const Input = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literals(["get", "capacity", "receipts"]), ...group }),
  Schema.Struct({ action: Schema.Literal("claim"), ...revision, targetSessionID: Session.ID,
    leaseMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 300000 })).pipe(Schema.optional) }),
  Schema.Struct({ action: Schema.Literal("release"), ...revision, targetSessionID: Session.ID, generation: Coordination.Revision }),
  Schema.Struct({ action: Schema.Literal("dispatch"), ...revision, generation: Coordination.Revision, ...Coordination.DispatchInput.fields }),
  Schema.Struct({ action: Schema.Literal("wait"), ...revision, ...Coordination.WaitInput.fields }),
  Schema.Struct({ action: Schema.Literal("cancelWait"), ...revision, waitID: Coordination.WaitID }),
  Schema.Struct({ action: Schema.Literal("inspect"), ...group, targetSessionID: Session.ID }),
  Schema.Struct({ action: Schema.Literal("decide"), ...group, targetSessionID: Session.ID,
    kind: Schema.Literals(["question", "permission", "review"]),
    requestID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    fingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    rationale: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(500)),
    confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.optional),
    answer: Form.Answer.pipe(Schema.optional),
  }),
])

export const Plugin = {
  id: "ycoding.tool.coordination",
  effect: Effect.fn("CoordinationTool.Plugin")(function* (ctx: Context) {
    const coordination = yield* CoordinationService.Service
    const decisions = yield* CoordinationDecisions.Service
    const permission = yield* Permission.Service
    yield* ctx.tool.transform((draft) => draft.add("coordination", Tool.make({
      description: "Read coordination groups, claim an assigned worker, dispatch bounded work, wait for Session events, or inspect and decide a current native request under the inherited routine-decision policy. Each dispatch requires an explicit execution agent, model reference with an advertised variant, and a one-line selection reason; its receipts retain that choice. Inspect returns request fingerprints; decide requires a rationale and uses this Session's authenticated identity. Question answers require the native answer fields and sufficient confidence. Human-only and uncertain cases escalate. Group creation, arm, stop, completion and policy changes belong to owner controls. Events are observations, never authority. Reconcile unknown mutations by their original IDs.",
      input: Input,
      output: Schema.Struct({ action: Schema.String, data: Schema.Unknown }),
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
      execute: (value, context) => Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(Input)(value, { onExcessProperty: "error" }).pipe(
          Effect.mapError(() => new ToolFailure({ message: "Invalid coordination operation" })),
        )
        yield* permission.assert({ action: "coordination", resources: ["groupID" in input ? input.groupID : "list"],
          metadata: { operationDigest: Hash.json(input) }, sessionID: context.sessionID, agent: context.agent,
          source: { type: "tool", messageID: context.messageID, callID: context.callID },
        }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
        const actor = { kind: "coordinator" as const, sessionID: context.sessionID }
        const data = yield* Effect.gen(function* () {
          if (input.action === "inspect" || input.action === "decide") {
            if (input.action === "inspect") return yield* decisions.pending({ ...input, coordinatorSessionID: context.sessionID })
            return yield* decisions.evaluate({ ...input, coordinatorSessionID: context.sessionID })
          }
          if (input.action === "list") return yield* coordination.list({})
          if (input.action === "get") return yield* coordination.get(input.groupID)
          if (input.action === "capacity") return yield* coordination.capacity(input.groupID)
          if (input.action === "receipts") return yield* coordination.receipts({ groupID: input.groupID })
          if (input.action === "claim") return yield* coordination.claim(actor, { groupID: input.groupID, expectedRevision: input.revision, targetSessionID: input.targetSessionID, leaseMs: input.leaseMs })
          if (input.action === "release") return yield* coordination.release(actor, { groupID: input.groupID, expectedRevision: input.revision, targetSessionID: input.targetSessionID, generation: input.generation })
          if (input.action === "dispatch") return yield* coordination.dispatch(actor, { ...input, expectedRevision: input.revision })
          if (input.action === "wait") return yield* coordination.wait(actor, { ...input, expectedRevision: input.revision })
          if (input.action === "cancelWait") return yield* coordination.cancelWait(actor, { groupID: input.groupID, expectedRevision: input.revision, waitID: input.waitID })
          return yield* new ToolFailure({ message: "Invalid coordination operation" })
        }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
        return { action: input.action, data }
      }),
    }), { codemode: false })).pipe(Effect.orDie)
  }),
}
