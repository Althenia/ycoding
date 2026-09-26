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
const BrowserTabIndex = Integer.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
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
const BrowserBundle = Schema.Literals(["com.apple.Safari", "com.google.Chrome"])
const WebURL = Schema.String.check(Schema.makeFilter((value) => {
  try {
    const url = new URL(value)
    return /^https?:\/\//i.test(value) && ["http:", "https:"].includes(url.protocol) && url.host.length > 0
  } catch {
    return false
  }
}, { expected: "absolute http or https URL" }))
const BrowserTarget = { ...MacOS, bundle_id: BrowserBundle, window_id: Schema.String.check(Schema.isMinLength(1)), tab_index: BrowserTabIndex, expected_revision: Schema.String }
const BrowserWindowTarget = { ...MacOS, bundle_id: BrowserBundle, window_id: Schema.String.check(Schema.isMinLength(1)), expected_revision: Schema.String }
const BrowserInspect = { ...MacOS, bundle_id: BrowserBundle }
const BrowserMutation = [
  Schema.Struct({ action: Schema.Literal("webbrowser.tabs"), ...BrowserInspect }),
  Schema.Struct({ action: Schema.Literal("webbrowser.navigate"), ...BrowserTarget, url: WebURL }),
  ...(["webbrowser.back", "webbrowser.forward", "webbrowser.reload", "webbrowser.close_tab"] as const).map((action) => Schema.Struct({ action: Schema.Literal(action), ...BrowserTarget })),
  Schema.Struct({ action: Schema.Literal("webbrowser.new_tab"), ...BrowserWindowTarget, url: WebURL.pipe(Schema.optional) }),
  Schema.Struct({ action: Schema.Literal("webbrowser.eval"), ...BrowserTarget, script: Schema.String.check(Schema.makeFilter((value) => new TextEncoder().encode(value).byteLength <= 65_536, { expected: "JavaScript source no larger than 65536 UTF-8 bytes" })) }),
]

export const Input = Schema.Union([
  ...BrowserMutation,
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
  Schema.Struct({ action: Schema.Literal("desktop.launch"), ...MacOS, bundle_id: DesktopTarget.bundle_id, remote_debugging: Schema.Boolean.pipe(Schema.optional) }),
  Schema.Struct({ action: Schema.Literal("desktop.quit"), ...MacOS, bundle_id: DesktopTarget.bundle_id, pid: DesktopTarget.pid }),
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

type BrowserInput = Extract<typeof Input.Type, { action: "webbrowser.tabs" | "webbrowser.navigate" | "webbrowser.back" | "webbrowser.forward" | "webbrowser.reload" | "webbrowser.new_tab" | "webbrowser.close_tab" | "webbrowser.eval" }>
const isBrowserInput = (input: typeof Input.Type): input is BrowserInput => input.action.startsWith("webbrowser.")

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
      "desktop.quit",
      "desktop.capture",
      "desktop.click",
      "desktop.drag",
      "desktop.type",
      "desktop.scroll",
      "desktop.key",
      "webbrowser.tabs", "webbrowser.navigate", "webbrowser.back", "webbrowser.forward", "webbrowser.reload", "webbrowser.new_tab", "webbrowser.close_tab", "webbrowser.eval",
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
    exited: Schema.Boolean.pipe(Schema.optional),
    windows: Schema.Union([
      Schema.Array(Schema.Struct({ window_id: Schema.String, index: Schema.Int, revision: Schema.String, tabs: Schema.Array(Schema.Struct({ index: Schema.Int, title: Schema.String, url: Schema.String, active: Schema.Boolean })) })),
      Schema.Array(Schema.Struct({ window_id: Schema.Int, title: Schema.String, bounds: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }), on_screen: Schema.Boolean })),
    ]).pipe(Schema.optional),
    tab_index: Schema.Int.pipe(Schema.optional),
    value: Schema.String.check(Schema.makeFilter((value) => new TextEncoder().encode(value).byteLength <= 16_384, { expected: "evaluated value no larger than 16384 UTF-8 bytes" })).pipe(Schema.optional),
    truncated: Schema.Boolean.pipe(Schema.optional),
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
  ...(output.exited !== undefined ? { exited: output.exited } : {}),
  ...(output.browserWindows ? { windows: output.browserWindows } : output.windows ? { windows: output.windows } : {}),
  ...(output.tabIndex !== undefined ? { tab_index: output.tabIndex } : {}),
  ...(output.value !== undefined ? { value: output.value } : {}),
  ...(output.truncated !== undefined ? { truncated: output.truncated } : {}),
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
              "macOS desktop: list once for exact bundle_id/pid/window_id; never guess. Launch if absent. Quit only when asked; unsaved-work prompts belong to the app. Inspect first; prefer AX paths off-Space. Safari off-Space page capture can be blank while AX reads/links work; command shortcuts and menu items may be ignored. Capture only if AX is insufficient; frames and pixels share one window-local space. Off-Space Electron capture/pixel/type automatically use a PID-owned bridge when available. Use launch remote_debugging:true only when explicitly requested for a fuse-off Electron app; it gracefully quits/relaunches and leaves a localhost debug port open. Chain returned settled revisions. On effect unchanged do not repeat; use AX or report no effect. On stale_revision inspect once and retry once; on unknown_outcome, focus_restore_failed, or inspector_close_failed inspect before mutation, never replay blindly. Native raw input briefly shifts key focus then restores it; concurrent user keystrokes may reach the target. No window raising, Space switch, hardware cursor warp, or clipboard. iTerm and Finder need explicit targets. Safari/Chrome tabs: webbrowser.tabs first, then pass window_id, 1-based tab_index, and that window's revision; navigate/new_tab URLs must be absolute http(s); JavaScript runs only through webbrowser.eval (and Safari back/forward/reload), which needs the browser's Allow JavaScript from Apple Events setting.",
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
                if (isBrowserInput(input)) {
                  const bundleID = input.bundle_id
                  const operation = input.action.slice("webbrowser.".length)
                  const resource = `macos.bundle_id/${bundleID}/webbrowser.${operation}`
                  yield* permission.assert({ action: name, resources: [resource], save: [resource],
                    metadata: { platform: "macos", application: "webbrowser", bundleID }, sessionID: context.sessionID, agent: context.agent, source })
                  const reservation = yield* guardrail.assert({ sessionID: context.sessionID, action: "computer", resources: [resource],
                    metadata: { operation: input.action, platform: "macos", application: "webbrowser", bundleID }, skipReview: true })
                  if (input.action === "webbrowser.tabs")
                    return result(yield* computer.browserTabs({ sessionID: context.sessionID, callID: context.callID, bundleID }).pipe(Effect.ensuring(reservation.release)))
                  const target: MacOSComputer.BrowserTarget = { platform: "macos", application: "webbrowser", bundleID, windowID: input.window_id, tabIndex: input.action === "webbrowser.new_tab" ? 1 : input.tab_index }
                  const action: MacOSComputer.BrowserAction = input.action === "webbrowser.navigate" ? { type: input.action, url: input.url }
                    : input.action === "webbrowser.new_tab" ? { type: input.action, url: input.url }
                    : input.action === "webbrowser.eval" ? { type: input.action, script: input.script }
                    : { type: input.action }
                  return result(yield* computer.browserAct({ sessionID: context.sessionID, callID: context.callID, target, expectedRevision: input.expected_revision, action }).pipe(Effect.ensuring(reservation.release)))
                }
                if (input.action === "desktop.list" || input.action === "desktop.launch" || input.action === "desktop.quit") {
                  const resource = input.action === "desktop.list" ? "macos.desktop/list"
                    : `macos.bundle_id/${input.bundle_id}/${input.action === "desktop.quit" ? "quit" : input.remote_debugging ? "remote_debugging" : "launch"}`
                  yield* permission.assert({ action: name, resources: [resource], save: [resource],
                    metadata: { platform: "macos", application: "desktop" }, sessionID: context.sessionID, agent: context.agent, source })
                  const reservation = yield* guardrail.assert({ sessionID: context.sessionID, action: "computer", resources: [resource],
                    metadata: { operation: input.action, platform: "macos", application: "desktop" }, skipReview: true })
                  if (input.action === "desktop.list") return result(yield* computer.list({ sessionID: context.sessionID, callID: context.callID }).pipe(Effect.ensuring(reservation.release)))
                  if (input.action === "desktop.quit") return result(yield* computer.quit({ sessionID: context.sessionID, callID: context.callID, bundleID: input.bundle_id, pid: input.pid }).pipe(Effect.ensuring(reservation.release)))
                  return result(yield* computer.launch({ sessionID: context.sessionID, callID: context.callID, bundleID: input.bundle_id, remoteDebugging: input.remote_debugging }).pipe(Effect.ensuring(reservation.release)))
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
