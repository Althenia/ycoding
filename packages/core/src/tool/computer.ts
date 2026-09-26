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
const Integer = Schema.Union([Schema.Int, Schema.NumberFromString.pipe(Schema.check(Schema.isInt()))])
const Positive = Integer.check(Schema.isGreaterThan(0))
const Nonnegative = Integer.check(Schema.isGreaterThanOrEqualTo(0))
const ItermTarget = {
  ...MacOS,
  window_id: Positive,
  tab_index: Positive,
  session_id: Schema.String,
}
const DesktopTarget = {
  ...MacOS,
  bundle_id: Schema.String.check(Schema.isMinLength(1)),
  pid: Positive,
  window_id: Positive,
}
const Element = Schema.Array(Nonnegative).check(Schema.isMaxLength(12))
const Revision = { expected_revision: Schema.String }
const Key = Schema.String.check(Schema.isPattern(/^(?:enter|return|tab|escape|space|delete|forward_delete|up|down|left|right|home|end|page_up|page_down|f(?:[1-9]|1[0-2])|[^\x00-\x1f\x7f])$/))
const Modifiers = Schema.Array(Schema.Literals(["command", "shift", "option", "control", "fn"]))

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
  Schema.Struct({ action: Schema.Literal("desktop.list"), ...MacOS }),
  Schema.Struct({ action: Schema.Literal("desktop.launch"), ...MacOS, bundle_id: DesktopTarget.bundle_id }),
  Schema.Struct({ action: Schema.Literal("desktop.inspect"), ...DesktopTarget }),
  Schema.Struct({ action: Schema.Literal("desktop.capture"), ...DesktopTarget }),
  Schema.Struct({
    action: Schema.Literal("desktop.click"),
    ...DesktopTarget,
    element: Element,
    ...Revision,
  }),
  Schema.Struct({ action: Schema.Literal("desktop.click"), ...DesktopTarget, ...Revision,
    x: Nonnegative, y: Nonnegative, button: Schema.Literals(["left", "right"]).pipe(Schema.optional),
    count: Integer.check(Schema.isBetween({ minimum: 1, maximum: 2 })).pipe(Schema.optional),
  }),
  Schema.Struct({
    action: Schema.Literal("desktop.type"),
    ...DesktopTarget,
    element: Element,
    ...Revision,
    text: Schema.String.check(Schema.isMaxLength(4096)),
  }),
  Schema.Struct({ action: Schema.Literal("desktop.type"), ...DesktopTarget, ...Revision, text: Schema.String.check(Schema.isMaxLength(4096)) }),
  Schema.Struct({
    action: Schema.Literal("desktop.scroll"),
    ...DesktopTarget,
    element: Element,
    ...Revision,
    direction: Schema.Literals(["up", "down"]),
  }),
  Schema.Struct({ action: Schema.Literal("desktop.scroll"), ...DesktopTarget, ...Revision,
    x: Nonnegative, y: Nonnegative, delta_x: Integer, delta_y: Integer }),
  Schema.Struct({ action: Schema.Literal("desktop.drag"), ...DesktopTarget, ...Revision,
    from_x: Nonnegative, from_y: Nonnegative, to_x: Nonnegative, to_y: Nonnegative }),
  Schema.Struct({
    action: Schema.Literal("desktop.key"),
    ...DesktopTarget,
    element: Element.pipe(Schema.optional),
    ...Revision,
    key: Key,
    modifiers: Modifiers.pipe(Schema.optional),
  }),
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
    action: Schema.Literals([
      "iterm.inspect",
      "iterm.send_text",
      "finder.inspect",
      "finder.move",
      "desktop.inspect",
      "desktop.list",
      "desktop.launch",
      "desktop.capture",
      "desktop.click",
      "desktop.drag",
      "desktop.type",
      "desktop.scroll",
      "desktop.key",
    ]),
    revision: Schema.String,
    accessible: Schema.Boolean.pipe(Schema.optional),
    effect: Schema.Literals(["changed", "unchanged", "unverified"]).pipe(Schema.optional),
    elements: Schema.Array(
      Schema.Struct({ path: Schema.Array(Schema.Int), role: Schema.String, label: Schema.String,
        frame: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
        actions: Schema.Array(Schema.Literals(["press", "confirm", "increment", "decrement", "show_menu"])),
        enabled: Schema.Boolean, focused: Schema.Boolean, value: Schema.String.pipe(Schema.optional),
      }),
    ).pipe(Schema.optional),
    image: Schema.String.pipe(Schema.optional),
    width: Schema.Number.pipe(Schema.optional), height: Schema.Number.pipe(Schema.optional), scale: Schema.Number.pipe(Schema.optional),
    apps: Schema.Array(Schema.Struct({ bundle_id: Schema.String, pid: Schema.Int, name: Schema.String,
      is_active: Schema.Boolean, is_hidden: Schema.Boolean,
      windows: Schema.Array(Schema.Struct({ window_id: Schema.Int, title: Schema.String,
        bounds: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }), on_screen: Schema.Boolean })),
    })).pipe(Schema.optional),
    pid: Schema.Int.pipe(Schema.optional),
    windows: Schema.Array(Schema.Struct({ window_id: Schema.Int, title: Schema.String,
      bounds: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }), on_screen: Schema.Boolean })).pipe(Schema.optional),
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
  ...(output.accessible !== undefined ? { accessible: output.accessible } : {}),
  ...(output.effect !== undefined ? { effect: output.effect } : {}),
  ...(output.elements ? { elements: output.elements } : {}),
  ...(output.image ? { image: output.image } : {}),
  ...(output.width !== undefined ? { width: output.width, height: output.height, scale: output.scale } : {}),
  ...(output.apps ? { apps: output.apps } : {}),
  ...(output.pid !== undefined ? { pid: output.pid, windows: output.windows } : {}),
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
              "macOS desktop: list once for exact bundle_id/pid/window_id; never guess. Launch if absent. Inspect first; prefer AX element paths (also off-Space). If accessible:false, capture and use pixel coordinates; otherwise capture only if AX is insufficient. Capture pixels and element frames share one window-local space. Pass each successful window call's settled revision to chained actions; do not re-inspect between successes. Mutation effect: changed when the AX tree or window image changed, unchanged when neither did, unverified when neither can be observed. On unchanged, never repeat the same action: use an AX element or keyboard route, or report that the app ignores background input (pointer input often does not reach Chromium/Electron windows or toolbars on another Space; keyboard and AX routes do). On stale_revision inspect once then retry once; on unknown_outcome or focus_restore_failed inspect before any mutation and never replay blindly; on background_unavailable use an AX route instead of repeating. Raw pointer/key routes briefly shift keyboard focus to the target then restore it; user keystrokes during that interval may reach the target. AX routes do not shift focus. No window raising, Space switch, hardware cursor movement, or clipboard. iTerm and Finder require explicit targets.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) =>
              output.type === "result" && output.image
                ? [
                    {
                      type: "text",
                      text: JSON.stringify({
                        type: output.type,
                        action: output.action,
                        revision: output.revision,
                        image: "image/jpeg",
                        width: output.width,
                        height: output.height,
                        scale: output.scale,
                      }),
                    },
                    { type: "file", data: output.image, mime: "image/jpeg", name: "desktop-window.jpg" },
                  ]
                : [{ type: "text", text: JSON.stringify(output) }],
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
                if (input.action === "desktop.list" || input.action === "desktop.launch") {
                  const resource = input.action === "desktop.list" ? "macos.desktop/list" : `macos.bundle_id/${input.bundle_id}/launch`
                  yield* permission.assert({ action: name, resources: [resource], save: [resource],
                    metadata: { platform: "macos", application: "desktop" }, sessionID: context.sessionID, agent: context.agent, source })
                  const reservation = yield* guardrail.assert({ sessionID: context.sessionID, action: "computer", resources: [resource],
                    metadata: { operation: input.action, platform: "macos", application: "desktop" }, skipReview: true })
                  if (input.action === "desktop.list") return result(yield* computer.list({ sessionID: context.sessionID, callID: context.callID }).pipe(Effect.ensuring(reservation.release)))
                  return result(yield* computer.launch({ sessionID: context.sessionID, callID: context.callID, bundleID: input.bundle_id }).pipe(Effect.ensuring(reservation.release)))
                }
                if (
                  input.action === "desktop.inspect" ||
                  input.action === "desktop.capture" ||
                  input.action === "desktop.click" ||
                  input.action === "desktop.drag" ||
                  input.action === "desktop.type" ||
                  input.action === "desktop.scroll" ||
                  input.action === "desktop.key"
                ) {
                  const target = {
                    platform: "macos" as const,
                    application: "desktop" as const,
                    bundleID: input.bundle_id,
                    pid: input.pid,
                    windowID: input.window_id,
                  }
                  const resource = `macos.bundle_id/${target.bundleID}/${target.pid}/${target.windowID}`
                  yield* permission.assert({
                    action: name,
                    resources: [resource],
                    save: [resource],
                    metadata: { platform: target.platform, application: target.application },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                  const reviewResources =
                    input.action === "desktop.inspect" || input.action === "desktop.capture"
                      ? [resource]
                      : [
                          resource,
                          ...("element" in input && input.element ? [`element/${input.element.join("/")}`] : []),
                          ...("x" in input ? [`point/${input.x}/${input.y}`] : []),
                          ...(input.action === "desktop.type" ? [input.text] : []),
                          ...(input.action === "desktop.scroll" && "direction" in input ? [input.direction] : []),
                        ]
                  const reservation = yield* guardrail.assert({
                    sessionID: context.sessionID,
                    action: "computer",
                    resources: reviewResources,
                    metadata: { operation: input.action, platform: target.platform, application: target.application },
                    skipReview: true,
                  })
                  if (input.action === "desktop.inspect")
                    return result(
                      yield* computer
                        .inspect({ sessionID: context.sessionID, callID: context.callID, target })
                        .pipe(Effect.ensuring(reservation.release)),
                    )
                  if (input.action === "desktop.capture")
                    return result(
                      yield* computer
                        .capture({ sessionID: context.sessionID, callID: context.callID, target })
                        .pipe(Effect.ensuring(reservation.release)),
                    )
                  const action: Computer.Action =
                    input.action === "desktop.click"
                      ? "element" in input ? { type: input.action, element: input.element } : { type: input.action, x: input.x, y: input.y, button: input.button, count: input.count === 2 ? 2 as const : input.count === 1 ? 1 as const : undefined }
                      : input.action === "desktop.drag"
                        ? { type: input.action, fromX: input.from_x, fromY: input.from_y, toX: input.to_x, toY: input.to_y }
                      : input.action === "desktop.type"
                        ? { type: input.action, element: "element" in input ? input.element : undefined, text: input.text }
                        : input.action === "desktop.scroll"
                          ? "element" in input ? { type: input.action, element: input.element, direction: input.direction } : { type: input.action, x: input.x, y: input.y, deltaX: input.delta_x, deltaY: input.delta_y }
                          : { type: input.action, element: input.element, key: input.key, modifiers: input.modifiers }
                  return result(
                    yield* computer
                      .act({
                        sessionID: context.sessionID,
                        callID: context.callID,
                        target,
                        expectedRevision: input.expected_revision,
                        action,
                      })
                      .pipe(Effect.ensuring(reservation.release)),
                  )
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
                    skipReview: true,
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
                  skipReview: true,
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
