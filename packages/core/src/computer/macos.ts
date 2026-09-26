export * as MacOSComputer from "./macos"

import path from "node:path"
import os from "node:os"
import { mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { watch } from "node:fs"
import { Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "../process"
import { NativeError, type Capability, type NativeSuccess } from "./types"

export interface ItermTarget {
  readonly platform: "macos"
  readonly application: "iterm"
  readonly windowID: number
  readonly tabIndex: number
  readonly sessionID: string
}

export interface FinderTarget {
  readonly platform: "macos"
  readonly application: "finder"
  readonly path: string
}
export interface DesktopTarget {
  readonly platform: "macos"
  readonly application: "desktop"
  readonly bundleID: string
  readonly pid: number
  readonly windowID: number
}

export type Target = ItermTarget | FinderTarget | DesktopTarget

export type Action =
  | { readonly type: "iterm.send_text"; readonly text: string; readonly newline: boolean }
  | { readonly type: "finder.move"; readonly destination: string }
  | { readonly type: "desktop.click"; readonly element: ReadonlyArray<number> }
  | { readonly type: "desktop.click"; readonly x: number; readonly y: number; readonly button?: "left" | "right"; readonly count?: 1 | 2 }
  | { readonly type: "desktop.drag"; readonly fromX: number; readonly fromY: number; readonly toX: number; readonly toY: number }
  | { readonly type: "desktop.type"; readonly element?: ReadonlyArray<number>; readonly text: string }
  | { readonly type: "desktop.scroll"; readonly element: ReadonlyArray<number>; readonly direction: "up" | "down" }
  | { readonly type: "desktop.scroll"; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
  | { readonly type: "desktop.key"; readonly element?: ReadonlyArray<number>; readonly key: string; readonly modifiers?: ReadonlyArray<"command" | "shift" | "option" | "control" | "fn"> }

interface Owner {
  readonly sessionID: string
  readonly callID: string
}

export type Request =
  | { readonly action: "desktop.list"; readonly owner: Owner }
  | { readonly action: "desktop.launch"; readonly owner: Owner; readonly bundleID: string }
  | { readonly action: "iterm.inspect"; readonly owner: Owner; readonly target: ItermTarget }
  | {
      readonly action: "iterm.send_text"
      readonly owner: Owner
      readonly target: ItermTarget
      readonly expectedRevision: string
      readonly text: string
      readonly newline: boolean
    }
  | { readonly action: "finder.inspect"; readonly owner: Owner; readonly target: FinderTarget }
  | { readonly action: "desktop.inspect" | "desktop.capture"; readonly owner: Owner; readonly target: DesktopTarget }
  | {
      readonly action: "desktop.click" | "desktop.drag" | "desktop.type" | "desktop.scroll" | "desktop.key"
      readonly owner: Owner
      readonly target: DesktopTarget
      readonly expectedRevision: string
      readonly element?: ReadonlyArray<number>
      readonly text?: string
      readonly direction?: "up" | "down"
      readonly key?: string
      readonly modifiers?: ReadonlyArray<"command" | "shift" | "option" | "control" | "fn">
      readonly x?: number
      readonly y?: number
      readonly button?: "left" | "right"
      readonly count?: 1 | 2
      readonly fromX?: number
      readonly fromY?: number
      readonly toX?: number
      readonly toY?: number
      readonly deltaX?: number
      readonly deltaY?: number
    }
  | {
      readonly action: "finder.move"
      readonly owner: Owner
      readonly target: FinderTarget
      readonly destination: string
      readonly expectedRevision: string
    }

export type Success = NativeSuccess<Request["action"]>
export type Invoke = (request: Request, signal: AbortSignal) => Effect.Effect<Success, NativeError>

export const capabilities = [
  {
    platform: "macos",
    application: "iterm",
    identity: { kind: "macos.bundle_id", value: "com.googlecode.iterm2" },
    operations: ["inspect", "send_text"],
  },
  {
    platform: "macos",
    application: "finder",
    identity: { kind: "macos.bundle_id", value: "com.apple.finder" },
    operations: ["inspect", "move"],
  },
  {
    platform: "macos",
    application: "desktop",
    identity: { kind: "macos.bundle_id", value: "explicit-running-app" },
    operations: ["list", "launch", "inspect", "capture", "click", "drag", "type", "scroll", "key"],
  },
] as const satisfies ReadonlyArray<Capability>

export const targetKey = (target: Target) =>
  target.application === "iterm"
    ? `${target.platform}\0${target.application}\0${target.windowID}\0${target.tabIndex}\0${target.sessionID}`
    : target.application === "finder"
      ? `${target.platform}\0${target.application}\0${target.path}`
      : `${target.platform}\0${target.application}\0${target.bundleID}\0${target.pid}\0${target.windowID}`

export const identity = (target: Target) => {
  if (target.application === "iterm") return capabilities[0].identity
  if (target.application === "finder") return capabilities[1].identity
  return { kind: "macos.bundle_id", value: target.bundleID }
}

export const matches = (target: Target, action: Action) =>
  (target.application === "iterm" && action.type === "iterm.send_text") ||
  (target.application === "finder" && action.type === "finder.move") ||
  (target.application === "desktop" && action.type.startsWith("desktop."))

export const inspectRequest = (owner: Owner, target: Target): Request =>
  target.application === "iterm"
    ? { action: "iterm.inspect", owner, target }
    : target.application === "finder"
      ? { action: "finder.inspect", owner, target }
      : { action: "desktop.inspect", owner, target }

export const captureRequest = (owner: Owner, target: DesktopTarget): Request => ({
  action: "desktop.capture",
  owner,
  target,
})

export const listRequest = (owner: Owner): Request => ({ action: "desktop.list", owner })
export const launchRequest = (owner: Owner, bundleID: string): Request => ({ action: "desktop.launch", owner, bundleID })

export function actionRequest(
  owner: Owner,
  target: Target,
  expectedRevision: string,
  action: Action,
): Request | undefined {
  if (target.application === "iterm" && action.type === "iterm.send_text")
    return {
      action: action.type,
      owner,
      target,
      expectedRevision,
      text: action.text,
      newline: action.newline,
    }
  if (target.application === "finder" && action.type === "finder.move")
    return {
      action: action.type,
      owner,
      target,
      expectedRevision,
      destination: action.destination,
    }
  if (
    target.application === "desktop" &&
    (action.type === "desktop.click" ||
      action.type === "desktop.type" ||
      action.type === "desktop.scroll" ||
      action.type === "desktop.drag" ||
      action.type === "desktop.key")
  )
    return { action: action.type, owner, target, expectedRevision, ...action }
  return undefined
}

export const helperBinary = "ycoding-computer-use"
// macOS privacy settings display an app bundle by its filename.
export const helperApplication = "YCoding Computer Use.app"
export const applicationPath = (executable = process.execPath) =>
  path.parse(executable).name === "bun"
    ? path.resolve(import.meta.dir, "../../.cache/computer-use", helperApplication)
    : path.join(path.dirname(executable), helperApplication)

const Response = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
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
    elements: Schema.Array(Schema.Struct({ path: Schema.Array(Schema.Int), role: Schema.String, label: Schema.String,
      frame: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
      actions: Schema.Array(Schema.Literals(["press", "confirm", "increment", "decrement", "show_menu"])),
      enabled: Schema.Boolean, focused: Schema.Boolean, value: Schema.String.pipe(Schema.optional),
    })).pipe(Schema.optional),
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
  Schema.Struct({
    status: Schema.Literal("error"),
    code: NativeError.fields.code,
    message: Schema.String,
    outcome: NativeError.fields.outcome,
  }),
])
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Response))

export function invokeWith(
  processes: AppProcess.Interface,
  platform: NodeJS.Platform = process.platform,
  application = applicationPath(),
): Invoke {
  return (request) => {
    if (platform !== "darwin")
      return Effect.fail(
        new NativeError({
          code: "unsupported_platform",
          message: `Native computer use has no provider for ${platform}`,
          outcome: "not_started",
        }),
      )
    const mutating =
      request.action === "iterm.send_text" ||
      request.action === "finder.move" || request.action === "desktop.launch" ||
      (request.action.startsWith("desktop.") &&
        request.action !== "desktop.inspect" &&
        request.action !== "desktop.capture" && request.action !== "desktop.list")
    // Every request runs inside the app so its Accessibility, Screen Recording, and Automation grants apply.
    const output = Effect.uninterruptible(
      Effect.scoped(
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () => mkdtemp(path.join(os.tmpdir(), "ycoding-computer-")),
            catch: (cause) => cause,
          }),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        ).pipe(
          Effect.flatMap((directory) =>
            Effect.tryPromise({
              try: () => writeFile(path.join(directory, "request.json"), JSON.stringify(request), { mode: 0o600 }),
              catch: (cause) => cause,
            }).pipe(
              Effect.andThen(
                processes.run(
                  ChildProcess.make("/usr/bin/open", [
                    "-n",
                    "-g",
                    "-a",
                    application,
                    "--args",
                    path.join(directory, "request.json"),
                    path.join(directory, "response.json"),
                  ]),
                  {
                    timeout: "10 seconds",
                    maxOutputBytes: 1024,
                    maxErrorBytes: 1024,
                  },
                ),
              ),
              Effect.flatMap(AppProcess.requireSuccess),
              Effect.flatMap(() => Effect.tryPromise({ try: () => awaitResponse(directory), catch: (cause) => cause })),
            ),
          ),
        ),
      ),
    )
    return output.pipe(
      Effect.flatMap(decodeResponse),
      Effect.mapError((error) =>
        error instanceof NativeError
          ? error
          : new NativeError({
              code: mutating ? "unknown_outcome" : "helper_unavailable",
              message: mutating
                ? "Native helper settlement is unknown; inspect the target before any further mutation"
                : "Native computer helper is unavailable or returned invalid output",
              outcome: mutating ? "unknown" : "not_started",
            }),
      ),
      Effect.flatMap((response) =>
        response.status === "ok"
          ? response.action === request.action
            ? Effect.succeed(response)
            : Effect.fail(
                new NativeError({
                  code: "invalid_response",
                  message: "Native computer helper returned a mismatched action",
                  outcome: "unknown",
                }),
              )
          : Effect.fail(
              new NativeError({
                code: response.code,
                message: response.message,
                outcome: response.outcome,
              }),
            ),
      ),
    )
  }
}

function awaitResponse(directory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const responsePath = path.join(directory, "response.json")
    const observer = watch(directory, (_event, filename) => {
      if (filename === "response.json") void read()
    })
    const timer = setTimeout(() => settle(new Error("Native helper did not settle within 30 seconds")), 30_000)
    let completed = false
    const settle = (result: string | Error) => {
      if (completed) return
      completed = true
      observer.close()
      clearTimeout(timer)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    observer.on("error", settle)
    const read = async () => {
      try {
        const response = await open(responsePath, "r")
        try {
          const buffer = Buffer.alloc(900_000 + 1)
          const { bytesRead } = await response.read(buffer, 0, buffer.length, 0)
          settle(
            bytesRead > 900_000
              ? new Error("Native helper response exceeds the output limit")
              : buffer.subarray(0, bytesRead).toString("utf8"),
          )
        } finally {
          await response.close()
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return
        settle(error instanceof Error ? error : new Error("Native helper response could not be read"))
      }
    }
    void read()
  })
}
