export * as ComputerTool from "./computer"

import path from "node:path"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { ToolFailure } from "@ycoding-ai/ai"
import { Effect, Schema } from "effect"
import { Computer } from "../computer"
import { MacOSComputer } from "../computer/macos"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { SessionGuardrail } from "../session/guardrail"
import { Tool } from "./tool"

export const name = "computer"

const MacOS = { platform: Schema.Literal("macos") }
const ItermTarget = {
  ...MacOS,
  window_id: Schema.Int.check(Schema.isGreaterThan(0)),
  tab_index: Schema.Int.check(Schema.isGreaterThan(0)),
  session_id: Schema.String,
}

export const Input = Schema.Union([
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({ action: Schema.Literal("cancel"), call_id: Schema.String }),
  Schema.Struct({ action: Schema.Literal("iterm.inspect"), ...ItermTarget }),
  Schema.Struct({
    action: Schema.Literal("iterm.send_text"),
    ...ItermTarget,
    expected_revision: Schema.String,
    text: Schema.String,
    newline: Schema.Boolean.pipe(Schema.optional),
  }),
  Schema.Struct({ action: Schema.Literal("finder.inspect"), ...MacOS, path: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("finder.move"),
    ...MacOS,
    path: Schema.String,
    destination_directory: Schema.String,
    expected_revision: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("action"))

export const Output = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("status"),
    platform: Schema.String,
    state: Schema.Literals(["supported", "unsupported"]),
    capabilities: Schema.Array(
      Schema.Struct({
        platform: Schema.String,
        application: Schema.String,
        identity: Schema.Struct({ kind: Schema.String, value: Schema.String }),
        operations: Schema.Array(Schema.String),
      }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("cancelled"), callID: Schema.String, cancelled: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("result"),
    action: Schema.Literals(["iterm.inspect", "iterm.send_text", "finder.inspect", "finder.move"]),
    revision: Schema.String,
  }),
])

const itermTarget = (input: {
  readonly platform: "macos"
  readonly window_id: number
  readonly tab_index: number
  readonly session_id: string
}) => ({
  platform: input.platform,
  application: "iterm" as const,
  windowID: input.window_id,
  tabIndex: input.tab_index,
  sessionID: input.session_id,
})

const result = (output: Computer.NativeSuccess) => ({
  type: "result" as const,
  action: output.action,
  revision: output.revision,
})

export const Plugin = {
  id: "ycoding.tool.computer",
  effect: Effect.fn("ComputerTool.Plugin")(function* (ctx: PluginContext) {
    const computer = yield* Computer.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const guardrail = yield* SessionGuardrail.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description:
              "Inspect status, cancel an active call, or control one explicit target through an available OS provider. The current macOS provider supports iTerm sessions and Finder paths without activating apps. Inspect first and pass its exact revision to mutation. The tool never launches apps, targets frontmost UI, reads unrelated sessions, uses global input/clipboard, opens/reveals Finder items, or captures the host screen.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                if (input.action === "status") {
                  const status = yield* computer.status
                  return { type: "status" as const, ...status }
                }
                if (input.action === "cancel") {
                  const cancelled = yield* computer.cancel({ sessionID: context.sessionID, callID: input.call_id })
                  return { type: "cancelled" as const, callID: input.call_id, cancelled }
                }
                const source = {
                  type: "tool" as const,
                  messageID: context.messageID,
                  callID: context.callID,
                }
                if (input.action === "iterm.inspect" || input.action === "iterm.send_text") {
                  const target = itermTarget(input)
                  const identity = MacOSComputer.identity(target)
                  const resource = `${identity.kind}/${identity.value}/${target.windowID}/${target.tabIndex}/${target.sessionID}`
                  yield* permission.assert({
                    action: name,
                    resources: [resource],
                    save: [resource],
                    metadata: { platform: target.platform, application: target.application },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                  if (input.action === "iterm.inspect")
                    return result(
                      yield* computer.inspect({
                        sessionID: context.sessionID,
                        callID: context.callID,
                        target,
                      }),
                    )
                  const reservation = yield* guardrail.assert({
                    sessionID: context.sessionID,
                    action: "shell",
                    resources: [input.text],
                    metadata: { platform: target.platform, application: target.application, target: resource },
                  })
                  return result(
                    yield* computer
                      .act({
                        sessionID: context.sessionID,
                        callID: context.callID,
                        target,
                        expectedRevision: input.expected_revision,
                        action: { type: "iterm.send_text", text: input.text, newline: input.newline ?? true },
                      })
                      .pipe(Effect.ensuring(reservation.release)),
                  )
                }

                const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                const computerTarget = {
                  platform: input.platform,
                  application: "finder" as const,
                  path: target.canonical,
                }
                const identity = MacOSComputer.identity(computerTarget)
                if (target.externalDirectory)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                if (input.action === "finder.inspect") {
                  yield* permission.assert({
                    action: name,
                    resources: [target.resource],
                    save: [target.resource],
                    metadata: {
                      platform: computerTarget.platform,
                      application: computerTarget.application,
                      identity,
                    },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                  return result(
                    yield* computer.inspect({
                      sessionID: context.sessionID,
                      callID: context.callID,
                      target: computerTarget,
                    }),
                  )
                }

                const destinationDirectory = yield* mutation.resolve({
                  path: input.destination_directory,
                  kind: "directory",
                })
                const destination = yield* mutation.resolve({
                  path: path.join(destinationDirectory.canonical, path.basename(target.canonical)),
                  kind: "file",
                })
                if (destination.externalDirectory)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(destination.externalDirectory),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                yield* permission.assert({
                  action: name,
                  resources: [target.resource, destination.resource],
                  save: [target.resource, destination.resource],
                  metadata: {
                    platform: computerTarget.platform,
                    application: computerTarget.application,
                    identity,
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const reservation = yield* guardrail.assert({
                  sessionID: context.sessionID,
                  action: "file_mutation",
                  resources: [target.canonical, destination.canonical],
                  metadata: {
                    operation: "finder.move",
                    platform: computerTarget.platform,
                    application: computerTarget.application,
                  },
                })
                return result(
                  yield* computer
                    .act({
                      sessionID: context.sessionID,
                      callID: context.callID,
                      target: computerTarget,
                      expectedRevision: input.expected_revision,
                      action: { type: "finder.move", destination: destinationDirectory.canonical },
                    })
                    .pipe(Effect.ensuring(reservation.release)),
                )
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure
                    ? error
                    : new ToolFailure({ message: `Unable to execute ${input.action}`, error }),
                ),
              ),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
  }),
}
