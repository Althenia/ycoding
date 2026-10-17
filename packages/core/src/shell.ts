export * as Shell from "./shell"

import path from "path"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { ChildProcess } from "effect/unstable/process"
import { produce } from "immer"
import { Shell } from "@ycoding-ai/schema/shell"
import { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"
import { makeLocationNode } from "./effect/app-node"
import { AppProcess } from "./process"
import { Config } from "./config"
import { Database } from "./database/database"
import { EventRuntime } from "./event"
import { Location } from "./location"
import { Global } from "./global"
import { ShellSandbox } from "./shell-sandbox"
import { ShellLedger } from "./shell/ledger"
import { ShellSelect } from "./shell/select"
import type { SessionSchema } from "./session/schema"

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
const FORCED_DRAIN_IDLE_MS = 100
const FORCED_DRAIN_MAX_MS = 1_000
const MEMORY_CHECK_INTERVAL_MS = 250
const PROCESS_LIST_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_OUTPUT_LIMIT = 65_536
// A page may read past its byte budget only to finish a character that straddles the
// budget, so the read window covers the longest incomplete character prefix.
const MAX_COMPLETION_BYTES = 3

/** Second-byte bounds for a lead byte. Overlong forms (E0, F0), surrogates (ED), and code
 * points above U+10FFFF (F4) accept a narrower range than a plain continuation byte. */
const secondByteLower = (lead: number) => (lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80)
const secondByteUpper = (lead: number) => (lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf)

/**
 * End offset of the UTF-8 unit starting at `start`, following the decoder's own boundary
 * rule: either the bytes of a complete character, or the ill-formed prefix consumed as one
 * replacement character before decoding restarts at the offending byte. Returns `undefined`
 * while the bytes are an incomplete but valid character prefix.
 */
function unitEnd(bytes: Buffer, start: number): number | undefined {
  const lead = bytes[start]
  if (lead <= 0x7f) return start + 1
  const width =
    lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : undefined
  if (width === undefined) return start + 1
  for (let offset = 1; offset < width; offset += 1) {
    if (start + offset >= bytes.length) return undefined
    const byte = bytes[start + offset]
    const lower = offset === 1 ? secondByteLower(lead) : 0x80
    const upper = offset === 1 ? secondByteUpper(lead) : 0xbf
    if (byte < lower || byte > upper) return start + offset
  }
  return start + width
}

/**
 * End offset of the page read from `bytes`: the last decoder boundary within `budget`,
 * extended by at most `MAX_COMPLETION_BYTES` so a character that straddles the budget is
 * completed instead of split. A trailing incomplete but valid character prefix is held
 * back - the page ends before it and the cursor does not advance - unless `flushTail`
 * reports a settled capture, where the prefix can no longer complete and standard decoding
 * turns it into replacement characters.
 */
function pageEnd(bytes: Buffer, budget: number, flushTail: boolean) {
  let index = 0
  while (index < bytes.length) {
    // The budget landed on a boundary: the page is exactly the requested size.
    if (index === budget) return index
    const end = unitEnd(bytes, index)
    if (end === undefined) return flushTail ? bytes.length : index
    if (end > budget) return end
    index = end
  }
  return bytes.length
}

type Info = Shell.Info

const live = (status: Shell.Status) => status === "running"

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
  readonly lifetime: Deferred.Deferred<void>
  readonly lifecycle: Semaphore.Semaphore
  kill?: () => Effect.Effect<void>
  timeoutFiber?: Fiber.Fiber<void>
  memoryFiber?: Fiber.Fiber<void>
  timeout?: (duration: number) => Effect.Effect<void>
  processFiber?: Fiber.Fiber<void>
  exitFiber?: Fiber.Fiber<void>
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
  // Running commands only; exited shells are retained for get/output but excluded here.
  readonly list: () => Effect.Effect<Shell.Info[]>
  readonly get: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // Resolves once the command reaches a terminal status, returning its final Info. Fails with
  // NotFoundError only if the command is unknown when the wait starts. Removal and teardown settle
  // existing waiters with terminal Info after successful process cleanup. Cleanup failures
  // fail current waiters as defects and keep the live command tracked for another removal attempt.
  readonly wait: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // Replaces the running command's timeout from now; zero clears it.
  readonly timeout: (id: Shell.ID, duration: number) => Effect.Effect<Shell.Info, NotFoundError>
  readonly output: (id: Shell.ID, input?: Shell.OutputInput) => Effect.Effect<Shell.Output, NotFoundError>
  // After successful termination, marks live commands killed, removes output,
  // and publishes Deleted. A cleanup failure leaves tracking intact and fails as a defect.
  readonly remove: (id: Shell.ID) => Effect.Effect<void, NotFoundError>
  readonly noticeOwed: (id: Shell.ID, sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly noticeAdmitted: (id: Shell.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Shell") {}

export const layer = (options?: ShellSelect.Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const events = yield* EventRuntime.Service
      const location = yield* Location.Service
      const config = yield* Config.Service
      const global = yield* Global.Service
      const appProcess = yield* AppProcess.Service
      const sandbox = yield* ShellSandbox.Service
      const database = (yield* Database.Service).db
      const context = yield* Effect.context()
      const runFork = Effect.runForkWith(context)
      const sessions = new Map<string, Active>()
      const preparations = new WeakMap<Prepared, PreparedState>()
      const exitOrder: string[] = []
      const owner = yield* ShellLedger.identify(appProcess, process.pid)

      const outputDir = path.join(global.data, "shell", location.project.id)
      const { mkdir, unlink } = yield* Effect.promise(() => import("fs/promises"))
      const { createWriteStream, createReadStream } = yield* Effect.promise(() => import("fs"))
      yield* Effect.promise(() => mkdir(outputDir, { recursive: true }))

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const results = yield* Effect.forEach(
            [...sessions.values()],
            (session) => removeSession(session.info.id).pipe(Effect.exit),
            { concurrency: "unbounded" },
          )
          const failed = results.find(Exit.isFailure)
          if (failed) return yield* failed
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
        yield* session.lifecycle.withPermits(1)(
          Effect.gen(function* () {
            if (session.info.status === "running") {
              if (!session.kill) return yield* Effect.die(new Error(`Shell ${id} has no termination handle`))
              yield* session.kill()
              session.info = produce(session.info, (draft) => {
                draft.status = "killed"
                draft.time.completed = Date.now()
              })
            }
            if (session.exitFiber) yield* Fiber.interrupt(session.exitFiber)
            if (session.timeoutFiber) yield* Fiber.interrupt(session.timeoutFiber)
            if (session.memoryFiber) yield* Fiber.interrupt(session.memoryFiber)
            if (session.processFiber) yield* Fiber.interrupt(session.processFiber)
            sessions.delete(id)
            const index = exitOrder.indexOf(id)
            if (index !== -1) exitOrder.splice(index, 1)
            yield* ShellLedger.release(database, id)
            yield* Deferred.succeed(session.lifetime, undefined)
            yield* Deferred.succeed(session.done, session.info)
            yield* Effect.promise(() => unlink(session.file).catch(() => {}))
            yield* events.publish(Shell.Event.Deleted, { id })
          }),
        )
      }, Effect.uninterruptible)

      const remove = Effect.fn("Shell.remove")(function* (id: Shell.ID) {
        yield* require(id)
        yield* removeSession(id)
      })

      const list = Effect.fn("Shell.list")(function* () {
        return Array.from(sessions.values())
          .filter((session) => live(session.info.status))
          .map((session) => session.info)
      })

      const get = Effect.fn("Shell.get")(function* (id: Shell.ID) {
        const session = yield* require(id)
        if (!live(session.info.status)) yield* Deferred.await(session.done)
        return session.info
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
        const cursor = Math.max(0, input?.cursor ?? 0)
        const limit = input?.limit ?? DEFAULT_OUTPUT_LIMIT
        // `done` resolves only after the capture file is flushed, so a settled capture's trailing
        // incomplete character can no longer complete and decodes as replacement. Sample settlement
        // before the size snapshot and the read: a capture that settles while the read is in flight
        // has bytes beyond `size` that only a later read returns, so flushing this snapshot's
        // trailing prefix would corrupt the character against that continuation.
        const settled = yield* Deferred.isDone(session.done)
        const size = session.size
        if (cursor >= size) return { output: "", cursor: size, size, truncated: false }
        // A zero budget reads nothing and leaves the cursor where it is.
        if (limit === 0) return { output: "", cursor, size, truncated: false }
        const window = Math.min(limit + MAX_COMPLETION_BYTES, size - cursor)
        const buffer = Buffer.alloc(window)
        const bytesRead = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              const stream = createReadStream(session.file, { start: cursor, end: cursor + window - 1 })
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
        const end = pageEnd(
          buffer.subarray(0, bytesRead),
          Math.min(limit, bytesRead),
          settled && bytesRead >= size - cursor,
        )
        return {
          output: buffer.subarray(0, end).toString("utf8"),
          cursor: cursor + end,
          size,
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
            ChildProcess.make("ps", ["-axo", "pid=,ppid=,pgid=,rss=,lstart="], {
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
                  const parentID = Number(fields[1])
                  const groupID = Number(fields[2])
                  const residentKiB = Number(fields[3])
                  if (![processID, parentID, groupID, residentKiB].every(Number.isFinite)) return []
                  return [{ processID, parentID, groupID, residentKiB, identity: fields.slice(4).join(" ") }]
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

      const take = (prepared: Prepared) => {
        const state = preparations.get(prepared)
        if (!state) return Effect.die(new Error("Invalid shell preparation capability"))
        preparations.delete(prepared)
        return Effect.succeed(state)
      }

      const initial = (id: Shell.ID, state: PreparedState): Info => ({
        id,
        status: "running",
        command: state.command,
        cwd: state.cwd,
        shell: state.shell,
        file: path.join(outputDir, `${id}.out`),
        metadata: state.metadata ?? {},
        ...(Schema.is(SessionOrchestration.ToolCallID)(state.metadata?.toolCallID)
          ? { toolCallID: state.metadata.toolCallID }
          : {}),
        time: { started: Date.now() },
      })

      // Spawn via AppProcess and stream combined output to the file. The handle is scope-bound, so
      // this effect keeps its scope open until the command terminates (it awaits `done` at the end).
      // `ready` resolves with the registered session once startup is complete.
      const launch = (
        state: PreparedState,
        ready: Deferred.Deferred<Active, SpawnError>,
        register: (pid: number) => Active,
        announce: (session: Active) => Effect.Effect<void>,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* appProcess
              .spawn(state.process)
              .pipe(Effect.mapError((cause) => new SpawnError({ command: state.command, cause })))
            const session = register(Number(handle.pid))
            const id = session.info.id
            const file = session.file
            session.kill = () =>
              handle.kill().pipe(
                Effect.tapError((error) =>
                  Effect.gen(function* () {
                    yield* Effect.logError("Shell termination failed", { id, error })
                    session.info = produce(session.info, (draft) => {
                      draft.status = "running"
                      delete draft.time.completed
                    })
                    sessions.set(id, session)
                    const waiting = session.done
                    session.done = Deferred.makeUnsafe<Info, NotFoundError>()
                    yield* Deferred.die(waiting, error)
                  }),
                ),
                Effect.orDie,
              )

            const stream = createWriteStream(file)
            const opened = new Promise<void>((resolve) => {
              stream.once("open", () => resolve())
              stream.once("error", () => resolve())
            })
            const outputDone = Deferred.makeUnsafe<void, Error>()
            // Resolves when timeout or memory enforcement bounds the capture drain.
            const forced = Deferred.makeUnsafe<void>()
            const settlement = { started: false }
            const outputFailed = Deferred.makeUnsafe<never, Error>()
            stream.on("error", (error) => Deferred.doneUnsafe(outputFailed, Effect.fail(error)))
            yield* Effect.addFinalizer(() => Effect.sync(() => stream.destroy()))
            const finish = (status: Info["status"], exit?: number, waitOutput = true): Effect.Effect<void> =>
              Effect.gen(function* () {
                const bounded = status === "timeout" || status === "memory-limit"
                const claimed = yield* session.lifecycle.withPermits(1)(
                  Effect.gen(function* () {
                    if (session.info.status !== "running") return false
                    if (settlement.started) {
                      if (bounded) yield* Deferred.succeed(forced, undefined)
                      return false
                    }
                    yield* session.kill!()
                    settlement.started = true
                    if (bounded) yield* Deferred.succeed(forced, undefined)
                    return true
                  }),
                )
                if (!claimed) return
                const captured = waitOutput ? yield* Deferred.await(outputDone).pipe(Effect.exit) : Exit.void
                yield* session.lifecycle.withPermits(1)(
                  Effect.gen(function* () {
                    if (session.info.status !== "running") return
                    const terminal = status === "exited" && Exit.isFailure(captured) ? "killed" : status
                    session.info = produce(session.info, (draft) => {
                      draft.status = terminal
                      if (exit !== undefined && terminal === "exited") draft.exit = exit
                      draft.time.completed = Date.now()
                    })
                    if (sessions.get(id) !== session) return
                    yield* Deferred.succeed(session.done, session.info)
                    yield* events.publish(Shell.Event.Exited, {
                      id,
                      ...(exit !== undefined && terminal === "exited" ? { exit } : {}),
                      status: terminal,
                    })
                    if (sessions.get(id) !== session) return
                    exitOrder.push(id)
                    while (exitOrder.length > EXITED_LIMIT) {
                      const oldest = exitOrder.shift()
                      if (!oldest) break
                      yield* removeSession(Shell.ID.make(oldest))
                    }
                    yield* Deferred.succeed(session.lifetime, undefined)
                    if (session.timeoutFiber) yield* Fiber.interrupt(session.timeoutFiber)
                    if (session.memoryFiber) yield* Fiber.interrupt(session.memoryFiber)
                  }),
                )
              })

            // A normal exit drains capture to EOF. Forced settlement ends the drain at the first of 100 ms
            // without data or 1 s after enforcement began, so an escaped writer cannot hold it open.
            const pump = Stream.transformPull(handle.all, (pull, scope) =>
              Effect.gen(function* () {
                const expired = Deferred.makeUnsafe<void>()
                yield* Deferred.await(forced).pipe(
                  Effect.andThen(Effect.sleep(FORCED_DRAIN_MAX_MS)),
                  Effect.andThen(Deferred.succeed(expired, undefined)),
                  Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
                  Effect.forkIn(scope),
                )
                const cutoff = Deferred.await(forced).pipe(
                  Effect.andThen(Effect.raceFirst(Effect.sleep(FORCED_DRAIN_IDLE_MS), Deferred.await(expired))),
                  Effect.andThen(Cause.done()),
                  Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
                )
                return Effect.suspend(() =>
                  Deferred.isDoneUnsafe(expired) ? Cause.done() : Effect.raceFirst(pull, cutoff),
                )
              }),
            ).pipe(
              Stream.runForEach((chunk: Uint8Array) =>
                Effect.callback<void, Error>((resume) => {
                  stream.write(chunk, (error) =>
                    resume(
                      error
                        ? Effect.fail(error)
                        : Effect.sync(() => {
                            session.size += chunk.length
                          }),
                    ),
                  )
                }),
              ),
            )
            yield* Effect.gen(function* () {
              yield* pump
              yield* Effect.callback<void>((resume) => {
                stream.end(() => resume(Effect.void))
              })
            }).pipe(
              Effect.raceFirst(Deferred.await(outputFailed)),
              Effect.tapError((error) => Deferred.fail(outputDone, error)),
              Effect.tap(() => Deferred.succeed(outputDone, undefined)),
              Effect.catch((error) =>
                Effect.logWarning("Shell output capture failed", { id, error }).pipe(
                  Effect.andThen(finish("killed", undefined, false)),
                ),
              ),
              Effect.ensuring(Deferred.succeed(outputDone, undefined)),
              Effect.forkScoped,
            )
            yield* Effect.promise(() => opened)
            if (owner)
              yield* ShellLedger.record(database, {
                id,
                pid: Number(handle.pid),
                started: (yield* ShellLedger.identify(appProcess, Number(handle.pid)))?.started,
                owner,
              }).pipe(
                Effect.onError(() =>
                  Effect.gen(function* () {
                    yield* session.kill!()
                    stream.destroy()
                    sessions.delete(id)
                    yield* Effect.promise(() => unlink(file).catch(() => {}))
                  }),
                ),
              )

            if (
              session.info.status === "running" &&
              state.memoryLimitMb !== undefined &&
              process.platform !== "win32"
            ) {
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
                      if (session.info.status !== "running") return
                      if (!sample || sample.identity !== initial.identity) return
                      if (sample.residentKiB <= limitKiB) continue
                      yield* finish("memory-limit")
                      return
                    }
                  }).pipe(Effect.catch(() => finish("memory-limit"))),
                )
            }

            // Publish creation before any watcher can publish exit: a command that ended during setup
            // resolves its exit watcher synchronously, and clients that saw exit first would keep the
            // shell listed as running.
            yield* announce(session)

            session.timeout = (duration) =>
              Effect.gen(function* () {
                if (session.timeoutFiber) yield* Fiber.interrupt(session.timeoutFiber)
                session.timeoutFiber = undefined
                if (duration === 0 || session.info.status !== "running") return
                session.timeoutFiber = runFork(
                  Effect.sleep(Duration.millis(duration)).pipe(
                    Effect.flatMap(() => finish("timeout")),
                    Effect.catch(() => Effect.void),
                  ),
                )
              })

            yield* session.timeout(state.timeout)

            session.exitFiber = runFork(
              handle.exitCode.pipe(
                Effect.flatMap((code) => finish("exited", code)),
                Effect.catch(() => Effect.void),
              ),
            )

            yield* Deferred.succeed(ready, session)
            // Hold the handle's scope open until the command terminates; closing it earlier would
            // release (kill) the process before its exit is observed.
            yield* Deferred.await(session.lifetime)
          }),
        )

      const create = Effect.fn("Shell.create")(function* (prepared: Prepared) {
        const state = yield* take(prepared)
        const info = initial(Shell.ID.ascending(), state)
        const ready = Deferred.makeUnsafe<Active, SpawnError>()
        const session: Active = {
          info,
          file: info.file,
          size: 0,
          done: Deferred.makeUnsafe<Info, NotFoundError>(),
          lifetime: Deferred.makeUnsafe<void>(),
          lifecycle: Semaphore.makeUnsafe(1),
        }
        session.processFiber = runFork(
          launch(
            state,
            ready,
            (pid) => {
              session.info = produce(info, (draft) => {
                draft.pid = pid
              })
              sessions.set(info.id, session)
              return session
            },
            () => events.publish(Shell.Event.Created, { info }),
          ).pipe(Effect.catchCause((cause) => Deferred.done(ready, Exit.failCause(cause)).pipe(Effect.asVoid))),
        )
        yield* Deferred.await(ready)
        return session.info
      })

      return Service.of({
        prepare,
        create,
        list,
        get,
        wait,
        timeout,
        output,
        remove,
        noticeOwed: (id, sessionID) => ShellLedger.noticeOwed(database, id, sessionID),
        noticeAdmitted: (id) =>
          ShellLedger.noticeAdmitted(database, id, live(sessions.get(id)?.info.status ?? "exited")),
      })
    }),
  )

export function configured(options?: ShellSelect.Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      EventRuntime.node,
      Location.node,
      Config.node,
      Global.node,
      AppProcess.node,
      ShellSandbox.node,
      Database.node,
    ],
  })
}

export const node = configured()
