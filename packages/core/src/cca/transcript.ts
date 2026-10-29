export * as CcaTranscript from "./transcript"

import fs from "node:fs/promises"
import path from "node:path"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect } from "effect"
import { Shell } from "@ycoding-ai/schema/shell"
import type { SessionID } from "@ycoding-ai/schema/session-id"
import type { EventRuntime } from "../event"
import { SessionEvent } from "../session/event"
import { RelativePath } from "../schema"
import type { CcaDecisionTrace } from "./errors"

export const OUTPUT_CAP_BYTES = 1024 * 1024
export const CONTENT_CAP_BYTES = 1024 * 1024

export interface ProcessRecording {
  readonly output: (chunk: Uint8Array) => void
  readonly ended: (input: { readonly exitCode: number | null; readonly sandboxDenied: boolean }) => void
}

export interface Recorder {
  readonly process: (input: {
    readonly processId: string
    readonly command: string
    readonly shell: string
    readonly cwd: string
    readonly threadId?: string
    readonly toolCallId?: string
  }) => ProcessRecording
  readonly read: (input: { readonly path: string; readonly bytes: number }) => void
  readonly write: (input: {
    readonly operation: "write" | "createDirectory" | "remove" | "copy"
    readonly path: string
    readonly destination?: string
    readonly bytes?: number
    readonly before?: Uint8Array
    readonly after?: Uint8Array
  }) => void
  readonly http: (input: { readonly method: string; readonly url: string; readonly status?: number; readonly bytes: number }) => void
  readonly denied: (input: { readonly action: string; readonly subject: string; readonly trace: CcaDecisionTrace }) => void
  readonly flush: () => Promise<void>
}

export interface Options {
  readonly sessionID: SessionID
  readonly directory: () => string
  readonly shellDirectory: () => string
  readonly events: Pick<EventRuntime.Interface, "publish">
  readonly command?: (command: string) => Effect.Effect<void, unknown>
}

export function make(options: Options): Recorder {
  let tail = Promise.resolve()
  const enqueue = (task: Effect.Effect<unknown, unknown>) => {
    tail = tail.then(() =>
      Effect.runPromise(
        task.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.logWarning("CCA transcript recording failed", { sessionID: options.sessionID, cause })),
        ),
      ),
    )
  }
  const synthetic = (text: string, dots: Record<string, unknown>) =>
    enqueue(options.events.publish(SessionEvent.Synthetic, { sessionID: options.sessionID, text, description: text, metadata: { dots } }))
  const shown = (target: string) => {
    const relative = inside(options.directory(), target)
    return relative ?? target
  }

  return {
    process: (input) => {
      const started = Date.now()
      const id = Shell.ID.create()
      const file = path.join(options.shellDirectory(), `${id}.out`)
      const metadata = {
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
        processId: input.processId,
        cwd: input.cwd,
      }
      const info: Shell.Info = {
        id,
        status: "running",
        command: input.command,
        cwd: input.cwd,
        shell: input.shell,
        file,
        metadata: { dots: metadata },
        time: { started },
      }
      const captured: Uint8Array[] = []
      let capturedBytes = 0
      let totalBytes = 0
      let ended = false
      enqueue(Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, "")))
        yield* options.events.publish(SessionEvent.Shell.Started, { sessionID: options.sessionID, shell: info })
        if (options.command) yield* options.command(input.command)
      }))
      return {
        output: (chunk) => {
          if (ended) return
          totalBytes += chunk.byteLength
          const room = OUTPUT_CAP_BYTES - capturedBytes
          if (room <= 0) return
          const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk
          captured.push(Uint8Array.from(kept))
          capturedBytes += kept.byteLength
        },
        ended: (result) => {
          if (ended) return
          ended = true
          const output = Buffer.concat(captured)
          enqueue(Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(file, output))
            yield* options.events.publish(SessionEvent.Shell.Ended, {
              sessionID: options.sessionID,
              shell: {
                ...info,
                status: "exited",
                ...(result.exitCode === null ? {} : { exit: result.exitCode }),
                metadata: { dots: { ...metadata, sandboxDenied: result.sandboxDenied } },
                time: { started, completed: Date.now() },
              },
              output: { output: output.toString("utf8"), cursor: output.byteLength, size: output.byteLength, truncated: totalBytes > output.byteLength },
            })
          }))
        },
      }
    },
    read: (input) => synthetic(`Read ${input.bytes} bytes from ${shown(input.path)}`, { operation: "read", path: input.path, bytes: input.bytes }),
    write: (input) => {
      const target = shown(input.path)
      const text =
        input.operation === "write" ? `Wrote ${input.bytes ?? 0} bytes to ${target}`
        : input.operation === "createDirectory" ? `Created directory ${target}`
        : input.operation === "remove" ? `Removed ${target}`
        : `Copied ${target} to ${shown(input.destination ?? "")}`
      synthetic(text, {
        operation: input.operation,
        path: input.path,
        ...(input.destination === undefined ? {} : { destination: input.destination }),
        ...(input.bytes === undefined ? {} : { bytes: input.bytes }),
      })
      const change = fileChange(options.directory(), input.path, input.before, input.after)
      if (change) enqueue(options.events.publish(SessionEvent.FileChange.Recorded, { sessionID: options.sessionID, change }))
    },
    http: (input) => {
      const url = URL.parse(input.url)
      const origin = url?.origin ?? ""
      const pathname = url?.pathname ?? ""
      const outcome = input.status === undefined ? "failed" : `${input.status} (${input.bytes} bytes)`
      synthetic(`HTTP ${input.method} ${origin}${pathname} → ${outcome}`, {
        operation: "http", method: input.method, origin, path: pathname,
        ...(input.status === undefined ? {} : { status: input.status }), bytes: input.bytes,
      })
    },
    denied: (input) => synthetic(`Denied ${input.action} ${input.subject.slice(0, 200)}`, {
      operation: "denied", action: input.action, subject: input.subject, trace: input.trace,
    }),
    flush: () => tail,
  }
}

function fileChange(directory: string, target: string, before: Uint8Array | undefined, after: Uint8Array | undefined) {
  if (before === undefined || after === undefined) return undefined
  if (before.byteLength > CONTENT_CAP_BYTES || after.byteLength > CONTENT_CAP_BYTES) return undefined
  if (before.includes(0) || after.includes(0)) return undefined
  const relative = inside(directory, target)
  if (relative === undefined) return undefined
  const previous = Buffer.from(before).toString("utf8")
  const next = Buffer.from(after).toString("utf8")
  const parts = diffLines(previous, next)
  return {
    path: RelativePath.make(relative.split(path.sep).join("/")),
    patch: createTwoFilesPatch(relative, relative, previous, next),
    additions: parts.filter((part) => part.added).reduce((sum, part) => sum + (part.count ?? 0), 0),
    deletions: parts.filter((part) => part.removed).reduce((sum, part) => sum + (part.count ?? 0), 0),
  }
}

function inside(directory: string, target: string) {
  const relative = path.relative(directory, target)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return relative
}
