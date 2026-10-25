export * as DotsTool from "./tool"

import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schema } from "effect"
import type { DotsRuntime } from "../dots"
import type { Permission } from "../permission"
import { SessionGuardrail } from "../session/guardrail"
import { Tool } from "../tool/tool"
import { Hash } from "../util/hash"
import { Dots } from "@ycoding-ai/schema/dots"

const SendInput = Schema.Struct({
  text: Schema.String.annotate({ description: "Message text to send to the Session's confirmed Dot" }),
  files: Schema.Array(Schema.String)
    .pipe(Schema.optional)
    .annotate({ description: "Files to attach, as paths relative to the working directory or absolute paths" }),
})

const SendOutput = Schema.Struct({
  messageID: Schema.String,
  status: Schema.Literals(["accepted", "unknown"]),
  turnID: Schema.String.pipe(Schema.optional),
})

export function make(input: {
  readonly dots: DotsRuntime.Interface
  readonly directory: string
  readonly permission: Pick<Permission.Interface, "assert">
  readonly guardrail: Pick<SessionGuardrail.Interface, "assert">
  readonly runtimeState?: Dots.RuntimeState
  readonly state?: Dots.State
  readonly target?: Dots.Target
}) {
  const confirmedTarget = input.target
  const failure = (error: { readonly message: string }) =>
    new Tool.Failure({ message: SessionGuardrail.reviewMessage(error) ?? error.message })
  const runtimeControl = (action: "pause" | "resume") => confirmedTarget === undefined || input.state !== "connected" || input.runtimeState !== (action === "pause" ? "unpaused" : "paused") ? undefined : Tool.make({
    description: action === "pause"
      ? "Pause the entire confirmed Dot until it is explicitly resumed. This affects the Dot runtime, not a single turn."
      : "Resume the entire confirmed Dot. An unpaused Dot is permitted to operate; it is not necessarily executing.",
    input: Schema.Struct({}),
    output: Dots.Status,
    toModelOutput: () => [{ type: "text", text: action === "pause" ? "The Dot is paused until explicitly resumed." : "The Dot is unpaused." }],
    execute: (_args, context) => Effect.gen(function* () {
      const validate = () => input.dots.status(context.sessionID).pipe(Effect.flatMap((status) => {
        const target = status.target
        if (!target || target.profile !== confirmedTarget.profile || target.dotID !== confirmedTarget.dotID || target.threadID !== confirmedTarget.threadID || target.generation !== confirmedTarget.generation)
          return Effect.fail(new Tool.Failure({ message: "The Session's confirmed Dot changed; prepare a new runtime control." }))
        if (status.state !== "connected" || status.runtimeState !== (action === "pause" ? "unpaused" : "paused"))
          return Effect.fail(new Tool.Failure({ message: "The Dot runtime state changed or is unknown; prepare a new runtime control." }))
        return Effect.void
      }))
      yield* validate()
      const source = { messageID: context.messageID, callID: context.callID }
      yield* input.permission.assert({
        sessionID: context.sessionID, agent: context.agent, action: `dots_${action}`,
        resources: [`${confirmedTarget.dotID}/${confirmedTarget.threadID}`], source: { type: "tool", ...source },
      })
      const reservation = yield* input.guardrail.assert({ sessionID: context.sessionID, action: `dots_${action}`, resources: [], source })
      return yield* validate().pipe(
        Effect.andThen(() => input.dots[action]({ sessionID: context.sessionID, expectedTarget: confirmedTarget })),
        Effect.ensuring(reservation.release),
      )
    }).pipe(Effect.mapError((error) => error instanceof Tool.Failure ? error : failure(error))),
  })
  return {
    dots_send: Tool.make({
      description:
        "Send a message to the Dot the user confirmed for this Session. Only the given text and listed files are sent. A status of unknown means the outcome is unknown; do not resend it.",
      input: SendInput,
      output: SendOutput,
      toModelOutput: ({ output }) => [
        {
          type: "text",
          text:
            output.status === "accepted"
              ? `Dots accepted message ${output.messageID}${output.turnID ? ` (turn ${output.turnID})` : ""}. Replies arrive as external Dots messages.`
              : `The outcome of Dots message ${output.messageID} is unknown. Do not resend it.`,
        },
      ],
      execute: (args, context) =>
        Effect.gen(function* () {
          const target = confirmedTarget
          if (!target) return yield* new Tool.Failure({ message: "The user has not confirmed a Dot for this Session." })
          const validate = () =>
            input.dots.status(context.sessionID).pipe(
              Effect.flatMap((status) =>
                sameDot(status.target, target)
                  ? Effect.void
                  : Effect.fail(new Tool.Failure({ message: "The Session's confirmed Dot changed; prepare a new message." })),
              ),
            )
          yield* validate()
          const files = (args.files ?? []).map((file) => path.resolve(input.directory, file))
          const source = { messageID: context.messageID, callID: context.callID }
          yield* input.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "dots_send",
            resources: [`${target.dotID}/${target.threadID}`],
            metadata: {
              dot: target.label,
              files,
              operationDigest: Hash.json({ target, text: args.text, files }),
            },
            source: { type: "tool", ...source },
          })
          yield* validate()
          if (files.length > 0) {
            yield* input.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: "read",
              resources: files,
              source: { type: "tool", ...source },
            })
            yield* validate()
          }
          const reservation = yield* input.guardrail.assert({
            sessionID: context.sessionID,
            action: "dots_send",
            resources: files,
            source,
          })
          return yield* validate().pipe(
            Effect.andThen(
              input.dots.send({
                sessionID: context.sessionID,
                id: messageID(context.messageID, context.callID),
                text: args.text,
                files: files.map((file) => ({ uri: pathToFileURL(file).href, name: path.basename(file) })),
                causalMessageID: context.messageID,
                expectedTarget: target,
              }),
            ),
            Effect.ensuring(reservation.release),
          )
        }).pipe(Effect.mapError((error) => (error instanceof Tool.Failure ? error : failure(error)))),
    }),
    dots_pause: runtimeControl("pause"),
    dots_resume: runtimeControl("resume"),
  }
}

const sameDot = (left: Dots.Target | undefined, right: Dots.Target) =>
  left !== undefined &&
  left.profile === right.profile &&
  left.dotID === right.dotID &&
  left.threadID === right.threadID &&
  left.generation === right.generation

const messageID = (message: string, call: string) => {
  const hex = Hash.sha256(`${message}\0${call}`)
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-")
}
