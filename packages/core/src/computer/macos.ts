export * as MacOSComputer from "./macos"

import path from "node:path"
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

export type Target = ItermTarget | FinderTarget

export type Action =
  | { readonly type: "iterm.send_text"; readonly text: string; readonly newline: boolean }
  | { readonly type: "finder.move"; readonly destination: string }

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
] as const satisfies ReadonlyArray<Capability>

export const targetKey = (target: Target) =>
  target.application === "iterm"
    ? `${target.platform}\0${target.application}\0${target.windowID}\0${target.tabIndex}\0${target.sessionID}`
    : `${target.platform}\0${target.application}\0${target.path}`

export const identity = (target: Target) => {
  if (target.application === "iterm") return capabilities[0].identity
  return capabilities[1].identity
}

export const matches = (target: Target, action: Action) =>
  (target.application === "iterm" && action.type === "iterm.send_text") ||
  (target.application === "finder" && action.type === "finder.move")

export const inspectRequest = (owner: Owner, target: Target): Request =>
  target.application === "iterm"
    ? { action: "iterm.inspect", owner, target }
    : { action: "finder.inspect", owner, target }

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
  return undefined
}

export const helperBinary = "ycoding-computer-helper"
export const developmentHelperPath = () => path.resolve(import.meta.dir, "../../.cache/computer-helper", helperBinary)
export const helperPath = (executable = process.execPath) =>
  path.parse(executable).name === "bun" ? developmentHelperPath() : path.join(path.dirname(executable), helperBinary)

const Response = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    action: Schema.Literals(["iterm.inspect", "iterm.send_text", "finder.inspect", "finder.move"]),
    revision: Schema.String,
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
    return processes
      .run(ChildProcess.make(executable, [], { stdin: "pipe" }), {
        stdin: JSON.stringify(request),
        signal,
        timeout: "30 seconds",
        maxOutputBytes: 64 * 1024,
        maxErrorBytes: 8 * 1024,
      })
      .pipe(
        Effect.flatMap(AppProcess.requireSuccess),
        Effect.flatMap((result) => decodeResponse(result.stdout.toString("utf8"))),
        Effect.mapError((error) =>
          error instanceof NativeError
            ? error
            : new NativeError({
                code:
                  request.action === "iterm.send_text" || request.action === "finder.move"
                    ? "unknown_outcome"
                    : "helper_unavailable",
                message:
                  request.action === "iterm.send_text" || request.action === "finder.move"
                    ? "Native helper settlement is unknown; inspect the target before any further mutation"
                    : "Native computer helper is unavailable or returned invalid output",
                outcome:
                  request.action === "iterm.send_text" || request.action === "finder.move" ? "unknown" : "not_started",
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
