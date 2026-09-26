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
  | { readonly action: "desktop.launch"; readonly owner: Owner; readonly bundleID: string; readonly remoteDebugging?: boolean }
  | { readonly action: "desktop.quit"; readonly owner: Owner; readonly bundleID: string; readonly pid: number }
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
export const launchRequest = (owner: Owner, bundleID: string, remoteDebugging?: boolean): Request => ({ action: "desktop.launch", owner, bundleID, remoteDebugging })
export const quitRequest = (owner: Owner, bundleID: string, pid: number): Request => ({ action: "desktop.quit", owner, bundleID, pid })

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

function bridgeAction(request: Request): Action | undefined {
  if (request.action === "desktop.click")
    return request.element ? { type: "desktop.click", element: request.element }
      : request.x !== undefined && request.y !== undefined
        ? { type: "desktop.click", x: request.x, y: request.y, button: request.button, count: request.count } : undefined
  if (request.action === "desktop.drag")
    return request.fromX !== undefined && request.fromY !== undefined && request.toX !== undefined && request.toY !== undefined
      ? { type: "desktop.drag", fromX: request.fromX, fromY: request.fromY, toX: request.toX, toY: request.toY } : undefined
  if (request.action === "desktop.scroll")
    return request.element && request.direction ? { type: "desktop.scroll", element: request.element, direction: request.direction }
      : request.x !== undefined && request.y !== undefined && request.deltaX !== undefined && request.deltaY !== undefined
        ? { type: "desktop.scroll", x: request.x, y: request.y, deltaX: request.deltaX, deltaY: request.deltaY } : undefined
  if (request.action === "desktop.type") return request.text === undefined ? undefined : { type: "desktop.type", text: request.text, element: request.element }
  if (request.action === "desktop.key") return request.key === undefined ? undefined : { type: "desktop.key", key: request.key, modifiers: request.modifiers, element: request.element }
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
      "desktop.quit",
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
    exited: Schema.Boolean.pipe(Schema.optional),
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
      request.action === "finder.move" || request.action === "desktop.launch" || request.action === "desktop.quit" ||
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

export function invokeWithBridge(processes: AppProcess.Interface, platform: NodeJS.Platform = process.platform, application = applicationPath(), electron?: ReturnType<typeof import("./electron").make>): Invoke {
  const native = invokeWith(processes, platform, application)
  return (request, signal) => {
    if (platform !== "darwin" || !request.action.startsWith("desktop.")) return native(request, signal)
    if (request.action === "desktop.list" || request.action === "desktop.inspect" || request.action === "desktop.quit") return native(request, signal)
    return Effect.gen(function* () {
      const { ElectronComputer } = yield* Effect.promise(() => import("./electron"))
      const bridge = electron ?? ElectronComputer.make()
      if (request.action === "desktop.launch") {
        if (!request.remoteDebugging) return yield* native(request, signal)
        const listed = yield* native({ action: "desktop.list", owner: request.owner }, signal)
        const existing = listed.apps?.find((app) => app.bundle_id === request.bundleID)
        if (existing) {
          const active = yield* Effect.promise(() => bridge.ownedEndpoint(existing.pid))
          if (active?.targets.some((entry) => entry.type === "page"))
            return yield* native({ ...request, remoteDebugging: false }, signal)
        }
        const launched = yield* native(request, signal)
        if (launched.pid === undefined) return yield* new NativeError({ code: "unknown_outcome", message: "Electron relaunch returned no PID", outcome: "unknown" })
        const ready = yield* Effect.promise(async () => {
          const deadline = Date.now() + 3000
          while (Date.now() < deadline) {
            if ((await bridge.ownedEndpoint(launched.pid!))?.targets.some((entry) => entry.type === "page")) return true
            await Bun.sleep(50)
          }
          return false
        })
        if (!ready) return yield* new NativeError({ code: "unknown_outcome", message: "Electron relaunch did not expose a PID-owned renderer endpoint", outcome: "unknown" })
        return launched
      }
      if (request.action === "desktop.capture" || request.action === "desktop.click" || request.action === "desktop.drag" ||
          request.action === "desktop.scroll" || request.action === "desktop.type" || request.action === "desktop.key") {
        if ("element" in request && request.element) return yield* native(request, signal)
        if (!(yield* Effect.promise(() => bridge.isElectron(request.target.pid)))) return yield* native(request, signal)
        const listed = yield* native({ action: "desktop.list", owner: request.owner }, signal)
        const target = request.target
        const window = listed.apps?.find((app) => app.pid === target.pid && app.bundle_id === target.bundleID)?.windows.find((item) => item.window_id === target.windowID)
        if (!window) return yield* new NativeError({ code: "target_not_found", message: "Exact Core Graphics window is unavailable", outcome: "not_started" })
        if (window.on_screen && request.action !== "desktop.capture") return yield* native(request, signal)
        const nativeCapture = window.on_screen && request.action === "desktop.capture"
          ? yield* native(request, signal).pipe(
              Effect.map((value) => ({ value })),
              Effect.catch((error) => Effect.succeed({ error })),
            ) : undefined
        if (nativeCapture && "value" in nativeCapture) return nativeCapture.value
        if ("expectedRevision" in request) {
          const before = yield* native({ action: "desktop.inspect", owner: request.owner, target }, signal)
          if (before.revision !== request.expectedRevision)
            return yield* new NativeError({ code: "stale_revision", message: "Target state changed; inspect again", outcome: "not_started" })
        }
        const action = bridgeAction(request)
        if (request.action !== "desktop.capture" && !action)
          return yield* new NativeError({ code: "invalid_request", message: "Invalid Electron desktop action", outcome: "not_started" })
        const operation = request.action === "desktop.capture" ? { type: "capture" as const }
          : { type: "action" as const, action: action! }
        const performed = yield* Effect.tryPromise({
          try: () => bridge.perform(target, window, operation, signal),
          catch: (cause) => cause instanceof NativeError ? cause : new NativeError({
            code: operation.type === "action" ? "unknown_outcome" : "native_failure",
            message: "Electron bridge failed; inspect before retrying", outcome: operation.type === "action" ? "unknown" : "not_started",
          }),
        })
        if (performed) {
          if (performed.type === "capture") {
            const inspected = yield* native({ action: "desktop.inspect", owner: request.owner, target }, signal)
            return { status: "ok" as const, action: request.action, revision: inspected.revision,
              image: performed.image, width: performed.width, height: performed.height, scale: performed.scale }
          }
          const inspected = yield* native({ action: "desktop.inspect", owner: request.owner, target }, signal)
          if (request.action === "desktop.capture") return yield* new NativeError({ code: "invalid_response", message: "Electron bridge returned an action for capture", outcome: "unknown" })
          return { status: "ok" as const, action: request.action, revision: inspected.revision, effect: performed.effect }
        }
        if (nativeCapture && "error" in nativeCapture) return yield* nativeCapture.error
        return yield* native(request, signal)
      }
      return yield* native(request, signal)
    })
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
