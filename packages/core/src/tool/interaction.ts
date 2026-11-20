export * as InteractionTool from "./interaction"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Interaction } from "@ycoding-ai/schema/interaction"
import { Effect, Schema } from "effect"
import { InteractionRuntime } from "../interaction"
import { Permission } from "../permission"
import { SessionGuardrail } from "../session/guardrail"
import { SessionStore } from "../session/store"
import { Hash } from "../util/hash"
import { Tool } from "./tool"

const Input = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("status") }),
  Schema.Struct({ operation: Schema.Literal("request"), selection: Interaction.Request }),
  Schema.Struct({ operation: Schema.Literal("observe"), generation: Interaction.Generation }),
  Schema.Struct({ operation: Schema.Literals(["perform", "confirm"]), generation: Interaction.Generation,
    revision: Interaction.Revision, action: Interaction.Action }),
])

const Output = Schema.Union([
  Schema.Struct({ type: Schema.Literal("status"), status: Interaction.Status }),
  Schema.Struct({ type: Schema.Literal("observation"), observation: Schema.Struct({
    revision: Interaction.Observation.fields.revision, elements: Interaction.Observation.fields.elements,
  }) }),
  Schema.Struct({ type: Schema.Literal("result"), result: Interaction.ActionResult }),
  Schema.Struct({ type: Schema.Literal("confirmation_pending") }),
])

export const Plugin = {
  id: "ycoding.tool.interaction",
  effect: Effect.fn("InteractionTool.Plugin")(function* (ctx: PluginContext) {
    const interaction = yield* InteractionRuntime.Service
    const permission = yield* Permission.Service
    const guardrail = yield* SessionGuardrail.Service
    const sessions = yield* SessionStore.Service
    yield* ctx.tool.transform((draft) => draft.add("interaction", Tool.make({
      description: "Request native approval for an exact Chrome tab or macOS window. Poll status, then observe at the active generation and use only fresh element IDs and revisions. Request confirmation for an exact irreversible action before performing it. Isolated Chrome does not support action confirmation or irreversible actions. Stop on sensitive fields, CAPTCHAs, or uncertain results. This tool does not return preview pixels.",
      input: Input,
      output: Output,
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
      execute: (input, context) => Effect.gen(function* (): Effect.fn.Return<typeof Output.Type, unknown> {
        const sessionID = context.sessionID
        const session = yield* sessions.get(sessionID)
        if (session?.scope !== "bound" || session.time.archived !== undefined) {
          interaction.revoke(sessionID)
          return yield* new ToolFailure({ message: "Interaction is unavailable for this Session" })
        }
        const source = { type: "tool" as const, messageID: context.messageID, callID: context.callID }
        const authorize = (action: string, resources: ReadonlyArray<string>, operation: string, digest: string) => permission.assert({
          action, resources, save: [], source, sessionID, agent: context.agent,
          metadata: { operation, operationDigest: digest },
        })
        if (input.operation === "status") return { type: "status", status: interaction.status(sessionID) }
        if (input.operation === "request") {
          const selection = input.selection
          if (typeof selection.url === "string" && !URL.canParse(selection.url))
            return yield* new ToolFailure({ message: "Interaction requires a valid HTTP(S) URL" })
          const requestedURL = selection.platform === "chrome" && typeof selection.url === "string" ? new URL(selection.url) : undefined
          const resource = requestedURL ? requestedURL.origin + requestedURL.pathname : selection.platform
          const digest = Hash.json(selection)
          yield* authorize("interaction", [resource], "request", digest)
          const reservation = requestedURL ? yield* guardrail.assert({ source, sessionID, action: "browser_owned_open", resources: [resource],
            metadata: { operation: "request", operationDigest: digest },
          }) : undefined
          return yield* Effect.sync(() => ({ type: "status" as const, status: interaction.request(sessionID, selection) }))
            .pipe(Effect.ensuring(reservation?.release ?? Effect.void))
        }
        const target = interaction.target(sessionID, input.generation)
        if (!target) return yield* new ToolFailure({ message: "No active Interaction matches this generation" })
        const action = "action" in input ? input.action : undefined
        const pathname = target.kind === "macos-window" ? undefined : target.pathname
        const resource = target.kind === "macos-window" ? target.bundleID : target.origin + target.pathname
        if (action?.type === "navigate" && !URL.canParse(action.url))
          return yield* new ToolFailure({ message: "Interaction requires a valid HTTP(S) navigation URL" })
        const destination = action?.type === "navigate" ? new URL(action.url) : undefined
        if (destination && (target.kind === "macos-window" || destination.origin !== target.origin))
          return yield* new ToolFailure({ message: "Navigation is outside the granted origin" })
        const resources = destination ? [resource, destination.origin + destination.pathname] : [resource]
        const digest = Hash.json({ generation: input.generation, ...(action ? { action } : {}) })
        const operation = action?.type ?? input.operation
        yield* authorize("interaction", resources, operation, digest)
        if (target.kind === "macos-window") yield* authorize("computer", resources, operation, digest)
        if (target.kind !== "macos-window") {
          yield* authorize("browser_read", resources, operation, digest)
          if (action) yield* authorize(action.type === "navigate" ? "browser_navigate" : "browser_interact", resources, operation, digest)
        }
        if (input.operation === "observe") {
          const observed = yield* Effect.tryPromise({
            try: (signal) => interaction.observe(sessionID, input.generation, signal, pathname),
            catch: () => new ToolFailure({ message: "Interaction observation was withheld or became stale" }),
          })
          return { type: "observation", observation: { revision: observed.revision, elements: observed.elements } }
        }
        if (input.operation === "confirm") {
          const refused = yield* Effect.try({
            try: () => interaction.confirmation(sessionID, input.generation, input.revision, input.action, pathname),
            catch: () => new ToolFailure({ message: "Interaction confirmation is unavailable for this action and revision" }),
          })
          return refused ? { type: "result", result: refused } : { type: "confirmation_pending" }
        }
        const reservation = yield* guardrail.assert({
          source, sessionID, resources,
          action: target.kind === "macos-window" ? "computer" : target.kind === "chrome-tab" ? "browser_profile_mutation" : "browser_mutation",
          metadata: { operation, operationDigest: digest },
        })
        const identity = Hash.json([context.messageID, context.invocationID ?? context.callID])
        const callID = Interaction.ID.make(
          `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`,
        )
        const result = yield* Effect.promise((signal) => interaction.perform(sessionID, input.generation, input.revision, callID, input.action, signal, pathname))
          .pipe(Effect.ensuring(reservation.release))
        return { type: "result", result }
      }).pipe(Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({
        message: error instanceof Error ? error.message : "Interaction was refused",
      }))),
    }), { codemode: false })).pipe(Effect.orDie)
  }),
}
