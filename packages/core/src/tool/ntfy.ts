export * as NtfyTool from "./ntfy"

import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { ToolFailure } from "@ycoding-ai/ai"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Config } from "../config"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"

export const name = "ntfy"

export const description =
  "Send a plain-text attention notification when user attention is needed for a question, confirmation/approval, or a verified completed task; it is not for routine progress. During active goal mode, routine autonomous decisions, background progress, retries, and auto-resolvable questions do not warrant notification. Genuine attention triggers are exhausted goal attempts, a user-owned blocker, confirmation/approval that autonomy cannot resolve, or verified task completion. Use the existing goal system and tool state visible to the agent; ntfy does not read or duplicate Session autonomy state."

export const Input = Schema.Struct({
  message: Schema.String.check(Schema.isNonEmpty()).annotate({ description: "Plain-text attention message" }),
})

const Output = Schema.Struct({ delivered: Schema.Literal(true) })

export const Plugin = {
  id: "ycoding.tool.ntfy",
  effect: Effect.fn("NtfyTool.Plugin")(function* (ctx: PluginContext) {
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient
    const permission = yield* PermissionV2.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: () => [{ type: "text", text: "Attention message delivered." }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const settings = Config.latest(yield* config.entries(), "ntfy")
                if (settings?.enabled !== true)
                  return yield* Effect.fail(new ToolFailure({ message: "Ntfy notifications are disabled." }))
                const topic = settings.topic?.trim()
                if (!topic) return yield* Effect.fail(new ToolFailure({ message: "Ntfy topic is not configured." }))

                yield* permission
                  .assert({
                    action: name,
                    resources: ["https://ntfy.sh/*"],
                    save: ["*"],
                    metadata: {},
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.messageID, callID: context.callID },
                  })
                  .pipe(
                    Effect.andThen(
                      http
                        .execute(
                          HttpClientRequest.post(`https://ntfy.sh/${encodeURIComponent(topic)}`).pipe(
                            HttpClientRequest.bodyText(input.message, "text/plain"),
                          ),
                        )
                        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk)),
                    ),
                    Effect.mapError(() => new ToolFailure({ message: "Unable to deliver attention message." })),
                  )
                return { delivered: true }
              }),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
  }),
}
