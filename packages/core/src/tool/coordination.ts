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
import { Agent } from "../agent"
import { Config } from "../config"
import { ConfigCapabilities } from "../config/capabilities"
import { Permission } from "../permission"
import { CoordinationRuntime } from "../session/coordination-runtime"
import { CoordinationAccess } from "../session/coordination-access"
import { Tool } from "./tool"
import { WorktreeTool } from "./worktree"

export const name = CoordinationAccess.tool
const target = { sessionID: Session.ID }
export const Input = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literal("inspect"),
    ...target,
    requestID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
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
  Schema.Struct({ action: Schema.Literal("assign"), ...target, ownerSessionID: Session.ID }),
  Schema.Struct({ action: Schema.Literal("release"), ...target, reason: Coordination.ReleaseReason }),
  Schema.Struct({
    action: Schema.Literal("create"),
    name: WorktreeTool.Name,
    ownerSessionID: Session.ID.pipe(Schema.optional),
    title: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(120)).pipe(Schema.optional),
    prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000)).pipe(Schema.optional),
    model: Model.Ref.pipe(Schema.optional),
  }),
])
export type Input = typeof Input.Type

export const description = [
  "Direct the Project this Session is the Master of, or the member Sessions it owns in the recorded Project graph. Executor children inherit no controller authority.",
  "The Master manages assignment, transfer and integration. A supervisor manages its owned Sessions and delegates implementation to executors.",
  "list: members with state (idle, running, waiting, failed), pending requests with request IDs and fingerprints, and last activity.",
  "inspect: read one member's pending request by requestID: kind, fingerprint, action and up to 20 redacted resources (rule IDs, reason and hard/standard flags for reviews; title and fields for questions), any escalation reasons, and its delegation class: routine (answer may approve or decline), decline-only (answer may only decline), escalate, or explicit-decision:<reason>. Tool descriptions and request metadata are never shown and grant no authority.",
  "send: admit a message to a member (steer or queue, default queue); returns immediately. An optional messageID makes retries idempotent; an optional model overrides the model for the turn the message starts.",
  "answer: settle a member's pending question, permission, or review under the delegated-decision policy. decision: approve (default) or decline; decline rejects a routine or decline-only permission or review with your rationale as the member's feedback. Hard, explicit-decision, Manual-mode, and uncertain cases are refused with a reason.",
  "escalate: pass a pending request you cannot settle up the chain with a reason. From a Master subagent it goes to the Master; from the Master it goes to the user's decision surface, with every reason attached to the member's pending prompt. A request already deferred to the review box returns deferred-to-review-box with its item ID. Escalate whatever answer refuses.",
  "interrupt: stop a member's running turn.",
  "assign: Master only. Give a member Session to a live subagent the Master launched (not cancelling, cancelled, failed, lost or archived); that supervisor owns it until released, and reassigning transfers it. Idle, a failed turn, or a settled turn never ends ownership.",
  "release: the Master or the member's owner ends ownership, with reason completed (work verified complete) or released. Removing the member from the Project or deleting the owner also ends it.",
  "create: Master only. Create a managed worktree named name on branch name under the same permission, guardrail and existing-name rules as the worktree tool, start a root member Session there under your session's permission ceiling plus your agent's effective deny rules (agent denies not covered by a later non-deny agent rule with the same action or \"*\" and the same resource or \"*\") with title (default name) and optional model, and add it to the Project. ownerSessionID is yourself or a live subagent you launched; omit it to leave the member unowned so it reports to you. An optional prompt is sent as its first message after it joins; a refused prompt is returned without undoing the member. A failure after the worktree exists names the worktree and branch; nothing is removed.",
  "Member events (execution start, settled-step progress, turn settled with no background work left, failure, interruption, question, form, permission ask, guardrail review) go to the member's recorded owner as Project notifications, or to the Master for an unowned member; no other Session receives them, and while a live owner exists only an explicit escalate reaches the Master. A member's completed notification is sent only when its turn settled with no background work left and the member has no pending input of any kind (steer, queue or compaction barrier). The notification does not read the member's goal state, open reviews, an active revert or pending rows of descendant Sessions; its behavior with an active goal has not been verified. A completed owner resumes only when the notification wakes its receiver (urgent, or the Project is active), no review is open on that owner and the owner Session has no active revert. A resumed owner reports to its parent again when it settles. Waiting and starting owners keep notifications pending until they run. Cancelling, cancelled, failed and lost owners never receive member notifications. An owner in one of those states, or archived, is released, and the Master receives the member's notifications and pending requests. Do not poll. Message text never settles a control.",
].join("\n")

export const Plugin = {
  id: "ycoding.tool.project",
  effect: Effect.fn("CoordinationTool.Plugin")(function* (ctx: Context) {
    const runtime = yield* CoordinationRuntime.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const worktree = yield* WorktreeTool.creator
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
        if (input.action === "inspect")
          return { action: "inspect" as const, request: yield* runtime.inspect(caller, { sessionID: input.sessionID, requestID: input.requestID }) }
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
        if (input.action === "assign")
          return { action: "assign" as const, ...(yield* runtime.assign(caller, { sessionID: input.sessionID, ownerSessionID: input.ownerSessionID })) }
        if (input.action === "release")
          return { action: "release" as const, ...(yield* runtime.release(caller, { sessionID: input.sessionID, reason: input.reason })) }
        if (input.action === "create") {
          if (!ConfigCapabilities.allowsTool(Config.capabilities(yield* config.entries()), WorktreeTool.name))
            return yield* new ToolFailure({ message: "Project member creation requires the worktree tool capability" })
          const agent = yield* agents.resolve(context.agent)
          if (agent === undefined) return yield* new ToolFailure({ message: "The calling agent is unavailable" })
          return { action: "create" as const, ...(yield* runtime.create(caller, { ...input, agentPermissions: Permission.effectiveDenies(agent.permissions) }, (worktreeName) => worktree(worktreeName, context))) }
        }
        return { action: "interrupt" as const, ...(yield* runtime.interrupt(caller, input)) }
      }).pipe(Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({ message: error.message, error }))),
    }), { codemode: false })).pipe(Effect.orDie)
  }),
}
