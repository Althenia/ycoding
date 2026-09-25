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
  | { readonly type: "desktop.type"; readonly element: ReadonlyArray<number>; readonly text: string }
  | { readonly type: "desktop.scroll"; readonly element: ReadonlyArray<number>; readonly direction: "up" | "down" }
  | { readonly type: "desktop.key"; readonly element: ReadonlyArray<number>; readonly key: "enter" }

interface Owner {
  readonly sessionID: string
  readonly callID: string
}

export type Request =
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
      readonly action: "desktop.click" | "desktop.type" | "desktop.scroll" | "desktop.key"
      readonly owner: Owner
      readonly target: DesktopTarget
      readonly expectedRevision: string
      readonly element: ReadonlyArray<number>
      readonly text?: string
      readonly direction?: "up" | "down"
      readonly key?: "enter"
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
    operations: ["inspect", "capture", "click", "type", "scroll", "key"],
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
      action.type === "desktop.key")
  )
    return { action: action.type, owner, target, expectedRevision, ...action }
  return undefined
}

export const helperBinary = "ycoding-computer-helper"
export const developmentHelperPath = () => path.resolve(import.meta.dir, "../../.cache/computer-helper", helperBinary)
export const helperPath = (executable = process.execPath) =>
  path.parse(executable).name === "bun" ? developmentHelperPath() : path.join(path.dirname(executable), helperBinary)

const Response = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    action: Schema.Literals([
      "iterm.inspect",
      "iterm.send_text",
      "finder.inspect",
      "finder.move",
      "desktop.inspect",
      "desktop.capture",
      "desktop.click",
      "desktop.type",
      "desktop.scroll",
      "desktop.key",
    ]),
    revision: Schema.String,
    elements: Schema.Array(
      Schema.Struct({ path: Schema.Array(Schema.Int), role: Schema.String, label: Schema.String }),
    ).pipe(Schema.optional),
    image: Schema.String.pipe(Schema.optional),
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
  executable = helperPath(),
): Invoke {
  return (request, signal) => {
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
      request.action === "finder.move" ||
      (request.action.startsWith("desktop.") &&
        request.action !== "desktop.inspect" &&
        request.action !== "desktop.capture")
    const output = request.action.startsWith("desktop.")
      ? Effect.uninterruptible(
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
                        `${executable}.app`,
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
                  Effect.flatMap(() =>
                    Effect.tryPromise({ try: () => awaitDesktopResponse(directory), catch: (cause) => cause }),
                  ),
                ),
              ),
            ),
          ),
        )
      : processes
          .run(ChildProcess.make(executable, [], { stdin: "pipe" }), {
            stdin: JSON.stringify(request),
            signal,
            timeout: "30 seconds",
            maxOutputBytes: 64 * 1024,
            maxErrorBytes: 8 * 1024,
          })
          .pipe(
            Effect.flatMap(AppProcess.requireSuccess),
            Effect.map((result) => result.stdout.toString("utf8")),
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

function awaitDesktopResponse(directory: string): Promise<string> {
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
          const buffer = Buffer.alloc(64 * 1024 + 1)
          const { bytesRead } = await response.read(buffer, 0, buffer.length, 0)
          settle(
            bytesRead > 64 * 1024
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
