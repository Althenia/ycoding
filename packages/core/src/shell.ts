export * as Shell from "./shell"

import path from "path"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { produce } from "immer"
import { Shell } from "@ycoding-ai/schema/shell"
import { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"
import { makeLocationNode } from "./effect/app-node"
import { AppProcess } from "./process"
import { Config } from "./config"
import { ConfigShell } from "./config/shell"
import { EventV2 } from "./event"
import { Location } from "./location"
import { Global } from "./global"
import { ShellSandbox } from "./shell-sandbox"
import { ShellSelect } from "./shell/select"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Shell.NotFoundError", {
  id: Shell.ID,
}) {}

export class SpawnError extends Schema.TaggedErrorClass<SpawnError>()("Shell.SpawnError", {
  command: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Unable to start shell command: ${this.command}${detail ? `: ${detail}` : ""}`
  }
}

export class MemoryLimitUnavailable extends Schema.TaggedErrorClass<MemoryLimitUnavailable>()(
  "Shell.MemoryLimitUnavailable",
  { message: Schema.String },
) {}

// Exited processes stay observable (status, exit code, retained output) until removed explicitly.
// Cap retention so abandoned commands do not accumulate unbounded state and output files.
const EXITED_LIMIT = 25
const MEMORY_CHECK_INTERVAL_MS = 250
const PROCESS_LIST_MAX_BYTES = 4 * 1024 * 1024

type Info = Shell.Info

export interface Prepared {
  readonly warnings: readonly string[]
  readonly memoryLimitMb?: number
}

type PreparedState = {
  readonly process: ChildProcess.Command
  readonly command: string
  readonly cwd: string
  readonly timeout: number
  readonly memoryLimitMb?: number
  readonly metadata?: Shell.Metadata
  readonly shell: string
}

type Active = {
  // Immutable snapshot; lifecycle updates replace it via immer `produce`.
  info: Info
  file: string
  size: number
  // Resolves with the terminal Info once the command exits, times out, or is killed. A wait
  // started after termination resolves immediately from the already-completed deferred.
  done: Deferred.Deferred<Info, NotFoundError>
  timeoutFiber?: Fiber.Fiber<void>
  memoryFiber?: Fiber.Fiber<void>
  timeout?: (duration: number) => Effect.Effect<void>
}

/**
 * Location-owned non-interactive shell command process service.
 *
 * Each `create` spawns one shell command, captures combined stdout/stderr to a
 * file, and returns an ID. Clients poll `get` for status and `output` for
 * file-backed output by cursor. No session, message, or permission state lives
 * here; callers (e.g. `ShellTool`) own that association and store the shell ID.
 */
export interface Interface {
  readonly prepare: (
    input: Shell.CreateInput,
  ) => Effect.Effect<Prepared, ShellSandbox.Unavailable | MemoryLimitUnavailable>
  readonly create: (prepared: Prepared) => Effect.Effect<Shell.Info, SpawnError>
  // Currently running commands only; exited shells are retained for get/output but excluded here.
  readonly list: () => Effect.Effect<Shell.Info[]>
  readonly get: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // Resolves once the command reaches a terminal status, returning its final Info. Fails with
  // NotFoundError if the command is unknown or is removed before it terminates.
  readonly wait: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // Replaces the running command's timeout from now; zero clears it.
  readonly timeout: (id: Shell.ID, duration: number) => Effect.Effect<Shell.Info, NotFoundError>
  readonly output: (id: Shell.ID, input?: Shell.OutputInput) => Effect.Effect<Shell.Output, NotFoundError>
  readonly remove: (id: Shell.ID) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/Shell") {}

export const layer = (options?: ShellSelect.Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const location = yield* Location.Service
      const config = yield* Config.Service
      const global = yield* Global.Service
      const appProcess = yield* AppProcess.Service
      const sandbox = yield* ShellSandbox.Service
      const context = yield* Effect.context()
      const runFork = Effect.runForkWith(context)
      const sessions = new Map<string, Active>()
      const preparations = new WeakMap<Prepared, PreparedState>()
      const exitOrder: string[] = []

      const outputDir = path.join(global.data, "shell", location.project.id)
      const { mkdir, unlink } = yield* Effect.promise(() => import("fs/promises"))
      const { createWriteStream, createReadStream } = yield* Effect.promise(() => import("fs"))
      yield* Effect.promise(() => mkdir(outputDir, { recursive: true }))

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const session of sessions.values()) {
            if (session.timeoutFiber) yield* Fiber.interrupt(session.timeoutFiber)
            if (session.memoryFiber) yield* Fiber.interrupt(session.memoryFiber)
            // Unblock waiters still pending at teardown; succeed is a no-op once already resolved.
            yield* Deferred.fail(session.done, new NotFoundError({ id: Shell.ID.make(session.info.id) }))
          }
          sessions.clear()
          exitOrder.length = 0
        }),
      )

      const require = Effect.fn("Shell.require")(function* (id: Shell.ID) {
        const session = sessions.get(id)
        if (!session) return yield* new NotFoundError({ id })
        return session
      })

      const removeSession = Effect.fnUntraced(function* (id: Shell.ID) {
        const session = sessions.get(id)
        if (!session) return
        sessions.delete(id)
        const index = exitOrder.indexOf(id)
        if (index !== -1) exitOrder.splice(index, 1)
        if (session.timeoutFiber) yield* Fiber.interrupt(session.timeoutFiber)
        if (session.memoryFiber) yield* Fiber.interrupt(session.memoryFiber)
        // Unblock any wait still pending when the command is removed before it terminated.
        yield* Deferred.fail(session.done, new NotFoundError({ id }))
        yield* Effect.promise(() => unlink(session.file).catch(() => {}))
        yield* events.publish(Shell.Event.Deleted, { id })
      })

      const remove = Effect.fn("Shell.remove")(function* (id: Shell.ID) {
        yield* require(id)
        yield* removeSession(id)
      })

      const list = Effect.fn("Shell.list")(function* () {
        return Array.from(sessions.values())
          .filter((session) => session.info.status === "running")
          .map((session) => session.info)
      })

      const get = Effect.fn("Shell.get")(function* (id: Shell.ID) {
        return (yield* require(id)).info
      })

      const wait = Effect.fn("Shell.wait")(function* (id: Shell.ID) {
        return yield* Deferred.await((yield* require(id)).done)
      })

      const timeout = Effect.fn("Shell.timeout")(function* (id: Shell.ID, duration: number) {
        const session = yield* require(id)
        if (session.info.status !== "running" || !session.timeout) return session.info
        yield* session.timeout(duration)
        return session.info
      })

      const output = Effect.fn("Shell.output")(function* (id: Shell.ID, input?: Shell.OutputInput) {
        const session = yield* require(id)
        const cursor = input?.cursor ?? 0
        const limit = input?.limit ?? 65536
        if (cursor >= session.size) return { output: "", cursor: session.size, size: session.size, truncated: false }
        const start = Math.max(0, cursor)
        const length = Math.min(limit, session.size - start)
        const buffer = Buffer.alloc(length)
        const bytesRead = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              const stream = createReadStream(session.file, { start, end: start + length - 1 })
              let offset = 0
              stream.on("data", (chunk: string | Buffer) => {
                const bytes = Buffer.from(chunk)
                bytes.copy(buffer, offset)
                offset += bytes.length
              })
              stream.on("end", () => resolve(offset))
              stream.on("error", () => resolve(0))
            }),
        )
        return {
          output: buffer.subarray(0, bytesRead).toString("utf8"),
          cursor: start + bytesRead,
          size: session.size,
          truncated: false,
        }
      })

      const capability = (state: PreparedState, warnings: readonly string[]): Prepared => {
        const prepared = Object.freeze({
          warnings: Object.freeze([...warnings]),
          ...(state.memoryLimitMb === undefined ? {} : { memoryLimitMb: state.memoryLimitMb }),
        })
        preparations.set(prepared, state)
        return prepared
      }

      const processGroupMemory = (pid: number) =>
        appProcess
          .run(
            ChildProcess.make("ps", ["-axo", "pid=,pgid=,rss=,lstart="], {
              stdin: "ignore",
            }),
            { maxOutputBytes: PROCESS_LIST_MAX_BYTES, maxErrorBytes: 1024 },
          )
          .pipe(
            Effect.flatMap(AppProcess.requireSuccess),
            Effect.map((result) => {
              const processes = result.stdout
                .toString("utf8")
                .split("\n")
                .flatMap((line) => {
                  const fields = line.trim().split(/\s+/)
                  const processID = Number(fields[0])
                  const groupID = Number(fields[1])
                  const residentKiB = Number(fields[2])
                  if (![processID, groupID, residentKiB].every(Number.isFinite)) return []
                  return [{ processID, groupID, residentKiB, identity: fields.slice(3).join(" ") }]
                })
              const root = processes.find((process) => process.processID === pid && process.groupID === pid)
              if (!root) return
              return {
                identity: root.identity,
                residentKiB: processes
                  .filter((process) => process.groupID === pid)
                  .reduce((total, process) => total + process.residentKiB, 0),
              }
            }),
          )

      const prepare = Effect.fn("Shell.prepare")(function* (input: Shell.CreateInput) {
        const cwd = input.cwd ?? location.directory
        const entries = yield* config.entries()
        const shell = ShellSelect.preferred(Config.latest(entries, "shell"), options)
        const configuredMemoryLimitMb = Config.latest(entries, "shell_memory_limit_mb")
        const selectedMemoryLimitMb = input.memoryLimitMb ?? configuredMemoryLimitMb
        const memoryLimitMb = selectedMemoryLimitMb === 0 ? undefined : selectedMemoryLimitMb
        if (memoryLimitMb !== undefined && process.platform === "win32")
          return yield* new MemoryLimitUnavailable({
            message: "Shell process-tree memory limits are unavailable on Windows",
          })
        const raw = ChildProcess.make(shell, ShellSelect.args(shell, input.command), {
          cwd,
          env: {
            ...process.env,
            ...(memoryLimitMb === undefined
              ? {}
              : {
                  GOMEMLIMIT: `${memoryLimitMb}MiB`,
                  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${memoryLimitMb}`]
                    .filter((value): value is string => Boolean(value))
                    .join(" "),
                }),
            TERM: "xterm-256color",
            YCODING_TERMINAL: "1",
          } as Record<string, string>,
          stdin: "ignore",
          detached: process.platform !== "win32",
          forceKillAfter: Duration.seconds(3),
        })
        const state: PreparedState = {
          process: raw,
          command: input.command,
          cwd,
          timeout: input.timeout,
          memoryLimitMb,
          metadata: input.metadata,
          shell,
        }
        const mode = Config.latest(entries, "shell_sandbox") ?? "disabled"
        if (mode === "disabled") return capability(state, [])
        const sandboxed = yield* sandbox.prepare(raw).pipe(
          Effect.map((process) => ({ process })),
          Effect.catchTag("ShellSandbox.Unavailable", (error) =>
            mode === "required" ? Effect.fail(error) : Effect.succeed(undefined),
          ),
        )
        if (sandboxed) return capability({ ...state, process: sandboxed.process }, [])
        return capability(state, [
          "No enforceable shell sandbox backend was available; command ran with host-user filesystem, process, and network authority.",
        ])
      })

      const create = Effect.fn("Shell.create")(function* (prepared: Prepared) {
        const state = preparations.get(prepared)
        if (!state) return yield* Effect.die(new Error("Invalid shell preparation capability"))
        preparations.delete(prepared)
        const id = Shell.ID.ascending()
        const file = path.join(outputDir, `${id}.out`)

        const info: Info = {
          id,
          status: "running",
          command: state.command,
          cwd: state.cwd,
          shell: state.shell,
          file,
          metadata: state.metadata ?? {},
          ...(Schema.is(SessionOrchestration.ToolCallID)(state.metadata?.toolCallID)
            ? { toolCallID: state.metadata.toolCallID }
            : {}),
          time: { started: Date.now() },
        }

        // Spawn via AppProcess and stream combined output to the file. The handle is scope-bound, so
        // the managing fiber keeps its scope open until the command terminates (it awaits `done` at the
        // end). `create` returns once `ready` resolves with the registered session.
        const ready = Deferred.makeUnsafe<Active, SpawnError>()
        runFork(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* appProcess
                .spawn(state.process)
                .pipe(Effect.mapError((cause) => new SpawnError({ command: state.command, cause })))
              const session: Active = {
                info: produce(info, (draft) => {
                  draft.pid = handle.pid
                }),
                file,
                size: 0,
                done: Deferred.makeUnsafe<Info, NotFoundError>(),
              }
              sessions.set(id, session)

              const stream = createWriteStream(file)
              const outputDone = Deferred.makeUnsafe<void>()
              const pump = handle.all.pipe(
                Stream.runForEach((chunk: Uint8Array) =>
                  Effect.sync(() => {
                    stream.write(chunk)
                    session.size += chunk.length
                  }),
                ),
              )
              runFork(
                Effect.gen(function* () {
                  yield* pump.pipe(Effect.catch(() => Effect.void))
                  yield* Effect.promise(
                    () =>
                      new Promise<void>((resolve) => {
                        stream.end(() => resolve())
                      }),
                  )
                  yield* Deferred.succeed(outputDone, undefined)
                }).pipe(Effect.catch(() => Deferred.succeed(outputDone, undefined))),
              )
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    stream.once("open", () => resolve())
                    stream.once("error", () => resolve())
                  }),
              )

              const finish = (status: Info["status"], exit?: number, beforeWait = Effect.void) =>
                Effect.gen(function* () {
                  if (session.info.status !== "running") return
                  session.info = produce(session.info, (draft) => {
                    draft.status = status
                    if (exit !== undefined) draft.exit = exit
                    draft.time.completed = Date.now()
                  })
                  yield* beforeWait
                  yield* Deferred.await(outputDone)
                  // Resolve waiters with the terminal Info before any retention eviction, so an evicted
                  // session still reports success rather than the removal NotFoundError. This runs before
                  // the timeout-fiber interrupt below, which on the timeout path would otherwise cancel
                  // this very fiber (finish is invoked by the timeout fiber) before waiters are resolved.
                  yield* Deferred.succeed(session.done, session.info)
                  yield* events.publish(Shell.Event.Exited, {
                    id,
                    ...(exit !== undefined ? { exit } : {}),
                    status,
                  })
                  exitOrder.push(id)
                  while (exitOrder.length > EXITED_LIMIT) {
                    const oldest = exitOrder[0]
                    if (!oldest) break
                    yield* removeSession(Shell.ID.make(oldest))
                  }
                  // Cancel a pending timeout once the command exits on its own. Interrupting last avoids
                  // aborting finish when finish itself runs on the timeout fiber.
                  if (session.timeoutFiber) yield* Fiber.interrupt(session.timeoutFiber)
                  if (session.memoryFiber) yield* Fiber.interrupt(session.memoryFiber)
                })

              if (state.memoryLimitMb !== undefined) {
                const limitKiB = state.memoryLimitMb * 1024
                const initial = yield* processGroupMemory(Number(handle.pid)).pipe(
                  Effect.mapError((cause) => new SpawnError({ command: state.command, cause })),
                )
                if (initial)
                  session.memoryFiber = runFork(
                    Effect.gen(function* () {
                      while (session.info.status === "running") {
                        yield* Effect.sleep(Duration.millis(MEMORY_CHECK_INTERVAL_MS))
                        if (session.info.status !== "running") return
                        const sample = yield* processGroupMemory(Number(handle.pid))
                        if (!sample || sample.identity !== initial.identity) return
                        if (sample.residentKiB <= limitKiB) continue
                        yield* finish("memory-limit", undefined, handle.kill().pipe(Effect.catch(() => Effect.void)))
                        return
                      }
                    }).pipe(
                      Effect.catch(() =>
                        finish("memory-limit", undefined, handle.kill().pipe(Effect.catch(() => Effect.void))),
                      ),
                    ),
                  )
              }

              session.timeout = (duration) =>
                Effect.gen(function* () {
                  if (session.timeoutFiber) yield* Fiber.interrupt(session.timeoutFiber)
                  session.timeoutFiber = undefined
                  if (duration === 0 || session.info.status !== "running") return
                  session.timeoutFiber = runFork(
                    Effect.sleep(Duration.millis(duration)).pipe(
                      Effect.flatMap(() =>
                        finish("timeout", undefined, handle.kill().pipe(Effect.catch(() => Effect.void))),
                      ),
                      Effect.catch(() => Effect.void),
                    ),
                  )
                })

              yield* session.timeout(state.timeout)

              runFork(
                handle.exitCode.pipe(
                  Effect.flatMap((code) => finish("exited", code)),
                  Effect.catch(() => Effect.void),
                ),
              )

              yield* events.publish(Shell.Event.Created, { info })
              yield* Deferred.succeed(ready, session)
              // Hold the handle's scope open until the command terminates; closing it earlier would
              // release (kill) the process before its exit is observed.
              yield* Deferred.await(session.done).pipe(Effect.catch(() => Effect.void))
            }),
          ).pipe(Effect.catchCause((cause) => Deferred.done(ready, Exit.failCause(cause)).pipe(Effect.asVoid))),
        )

        const session = yield* Deferred.await(ready)
        return session.info
      })

      return Service.of({ prepare, create, list, get, wait, timeout, output, remove })
    }),
  )

export function configured(options?: ShellSelect.Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [EventV2.node, Location.node, Config.node, Global.node, AppProcess.node, ShellSandbox.node],
  })
}

export const node = configured()
