import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { Effect, Semaphore } from "effect"
import {
  decodeRegexValue,
  MAX_REGEX_FRAME_BYTES,
  REGEX_PROCESS_MARKER,
  regexProcessSource,
} from "../internal/regex-process.js"
import { InterpreterRuntimeError } from "./model.js"
import { coerceToNumber } from "../stdlib/value.js"

type Reply = { ready?: boolean; result?: unknown; lastIndex?: unknown; error?: { name: string; message: string } }

export class RegexRuntime {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly lock = Semaphore.makeUnsafe(1)
  private stopped = false
  private ready = false
  private closed: Promise<void> | undefined
  private pipeFailure: Error | undefined

  constructor(
    private readonly timeoutMs: number,
    private readonly fail: (error: InterpreterRuntimeError) => void,
  ) {}

  run(
    regex: RegExp,
    method: string,
    input: string,
    options: { replacement?: string; limit?: number } = {},
  ): Effect.Effect<Reply, unknown> {
    const self = this
    return this.lock.withPermit(
      Effect.gen(function* () {
        if (self.stopped)
          return yield* Effect.fail(
            new InterpreterRuntimeError("Regex process is closed.", undefined, "TimeoutExceeded"),
          )
        if (self.pipeFailure) return yield* Effect.fail(self.pipeFailure)
        const deadline = performance.now() + self.timeoutMs
        const timeout = () => {
          const failure = new InterpreterRuntimeError(
            `Regular expression operation timed out after ${self.timeoutMs}ms.`,
            undefined,
            "TimeoutExceeded",
          )
          self.fail(failure)
          return Effect.andThen(self.close(), Effect.fail(failure))
        }
        const index = coerceToNumber(regex.lastIndex)
        const lastIndex = Number.isNaN(index) || index <= 0 ? 0 : Math.min(Math.floor(index), Number.MAX_SAFE_INTEGER)
        const frame = JSON.stringify({
          pattern: regex.source,
          flags: regex.flags,
          lastIndex,
          method,
          input,
          ...options,
        })
        const frameBytes = Buffer.byteLength(frame)
        if (performance.now() >= deadline) return yield* timeout()
        if (frameBytes > MAX_REGEX_FRAME_BYTES) throw new RangeError("Regex request exceeds the IPC frame limit.")
        if (!self.child) {
          const child = spawn(process.execPath, ["-e", regexProcessSource, "--", REGEX_PROCESS_MARKER], {
            stdio: ["pipe", "pipe", "pipe"],
          })
          self.child = child
          child.stdout.setEncoding("utf8")
          child.stderr.resume()
          const failed = (error: Error) => {
            self.pipeFailure = error
          }
          child.stdin.on("error", failed)
          child.stdout.on("error", failed)
          child.stderr.on("error", failed)
          self.closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
        }
        if (performance.now() >= deadline) return yield* timeout()
        const child = self.child
        return yield* Effect.callback<Reply, unknown>((resume) => {
          let buffer = ""
          let bytes = 0
          const clean = () => {
            clearTimeout(timer)
            child.stdout.off("data", data)
            child.off("error", error)
            child.off("close", exit)
            child.stdin.off("error", error)
            child.stdout.off("error", error)
            child.stderr.off("error", error)
          }
          const error = (cause: Error) => {
            clean()
            resume(Effect.fail(cause))
          }
          const exit = () => {
            clean()
            resume(Effect.fail(new Error("Regex process exited during an operation.")))
          }
          const data = (chunk: string) => {
            bytes += Buffer.byteLength(chunk)
            if (bytes > MAX_REGEX_FRAME_BYTES + 1) {
              clean()
              resume(
                Effect.andThen(
                  self.close(),
                  Effect.fail(new RangeError("Regex response exceeds the IPC frame limit.")),
                ),
              )
              return
            }
            buffer += chunk
            const end = buffer.indexOf("\n")
            if (end === -1) return
            let reply: Reply
            try {
              reply = JSON.parse(buffer.slice(0, end)) as Reply
            } catch {
              error(new Error("Regex process returned an invalid response."))
              return
            }
            buffer = buffer.slice(end + 1)
            bytes = Buffer.byteLength(buffer)
            if (performance.now() >= deadline) {
              clean()
              resume(timeout())
              return
            }
            if (reply.ready) {
              self.ready = true
              child.stdin.write(frame + "\n")
              return
            }
            const result = reply.error ? undefined : decodeRegexValue(reply.result)
            clean()
            if (performance.now() >= deadline) {
              resume(timeout())
              return
            }
            resume(
              reply.error
                ? Effect.fail(new InterpreterRuntimeError(reply.error.message).as(reply.error.name))
                : Effect.succeed({ ...reply, result }),
            )
          }
          const timer = setTimeout(
            () => {
              clean()
              resume(timeout())
            },
            Math.max(0, deadline - performance.now()),
          )
          child.stdout.on("data", data)
          child.once("error", error)
          child.once("close", exit)
          child.stdin.once("error", error)
          child.stdout.once("error", error)
          child.stderr.once("error", error)
          if (self.ready) child.stdin.write(frame + "\n")
          return Effect.sync(clean)
        })
      }),
    )
  }

  close(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.stopped = true
      const child = this.child
      const closed = this.closed
      this.child = undefined
      if (!child) return closed ? Effect.promise(() => closed) : Effect.void
      child.kill("SIGKILL")
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      return Effect.asVoid(Effect.promise(() => closed!))
    })
  }
}
