import type { NonEmptyReadonlyArray } from "effect/Array"
import { NodeFileSystem, NodePath, NodeSink, NodeStream } from "@effect/platform-node"
import {
  Deferred,
  Clock,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Predicate,
  Sink,
  Stream,
} from "effect"
import type { Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import {
  ChildProcessSpawner,
  ExitCode,
  make,
  makeHandle,
  ProcessId,
  type ChildProcessHandle,
} from "effect/unstable/process/ChildProcessSpawner"
// ast-grep-ignore: no-star-import
import * as NodeChildProcess from "node:child_process"
import { PassThrough, pipeline, type Readable } from "node:stream"
import launch from "cross-spawn"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem, path } from "./effect/app-node-platform"
import { ProcessGroup } from "./shell/process-group"

const toError = (err: unknown): Error => (err instanceof globalThis.Error ? err : new globalThis.Error(String(err)))

const toTag = (err: NodeJS.ErrnoException): PlatformError.SystemErrorTag => {
  switch (err.code) {
    case "ENOENT":
      return "NotFound"
    case "EACCES":
      return "PermissionDenied"
    case "EEXIST":
      return "AlreadyExists"
    case "EISDIR":
      return "BadResource"
    case "ENOTDIR":
      return "BadResource"
    case "EBUSY":
      return "Busy"
    case "ELOOP":
      return "BadResource"
    default:
      return "Unknown"
  }
}

const flatten = (command: ChildProcess.Command) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const opts: Array<ChildProcess.PipeOptions> = []

  const walk = (cmd: ChildProcess.Command): void => {
    switch (cmd._tag) {
      case "StandardCommand":
        commands.push(cmd)
        return
      case "PipedCommand":
        walk(cmd.left)
        opts.push(cmd.options)
        walk(cmd.right)
        return
    }
  }

  walk(command)
  if (commands.length === 0) throw new Error("flatten produced empty commands array")
  const [head, ...tail] = commands
  return {
    commands: [head, ...tail] as NonEmptyReadonlyArray<ChildProcess.StandardCommand>,
    opts,
  }
}

const toPlatformError = (
  method: string,
  err: NodeJS.ErrnoException,
  command: ChildProcess.Command,
): PlatformError.PlatformError => {
  const cmd = flatten(command)
    .commands.map((x) => `${x.command} ${x.args.join(" ")}`)
    .join(" | ")
  return PlatformError.systemError({
    _tag: toTag(err),
    module: "ChildProcess",
    method,
    pathOrDescriptor: cmd,
    syscall: err.syscall,
    cause: err,
  })
}

type ExitSignal = Deferred.Deferred<readonly [code: number | null, signal: NodeJS.Signals | null]>

// Windows close includes inherited pipe closure; root exit alone is not enough.
export const recheckWindowsClose = <E>(kill: Effect.Effect<void, E>, closed: ExitSignal) =>
  kill.pipe(Effect.catch((error) => Deferred.isDoneUnsafe(closed) ? Effect.void : Effect.fail(error)))

type Capture = {
  stdout?: PassThrough
  stderr?: PassThrough
  prefix: { channel: "stdout" | "stderr"; chunk: Buffer }[]
  collecting: boolean
  claimed: boolean
}

const makeCrossSpawnSpawner = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const processSystem = yield* ProcessGroup.System
  const buffered = new WeakMap<NodeChildProcess.ChildProcess, Capture>()
  const buffer = (source: Readable | null, channel: "stdout" | "stderr", capture: Capture) => {
    if (!source) return undefined
    const stream = new PassThrough()
    pipeline(source, stream, () => {})
    source.on("data", (chunk: Buffer) => {
      if (capture.collecting) capture.prefix.push({ channel, chunk })
    })
    return stream
  }

  const cwd = Effect.fnUntraced(function* (opts: ChildProcess.CommandOptions) {
    if (Predicate.isUndefined(opts.cwd)) return undefined
    yield* fs.access(opts.cwd)
    return path.resolve(opts.cwd)
  })

  const env = (opts: ChildProcess.CommandOptions) =>
    opts.extendEnv ? { ...globalThis.process.env, ...opts.env } : opts.env

  const input = (x: ChildProcess.CommandInput | undefined): NodeChildProcess.IOType | undefined =>
    Stream.isStream(x) ? "pipe" : x

  const output = (x: ChildProcess.CommandOutput | undefined): NodeChildProcess.IOType | undefined =>
    Sink.isSink(x) ? "pipe" : x

  const stdin = (opts: ChildProcess.CommandOptions): ChildProcess.StdinConfig => {
    const cfg: ChildProcess.StdinConfig = { stream: "pipe", encoding: "utf-8", endOnDone: true }
    if (Predicate.isUndefined(opts.stdin)) return cfg
    if (typeof opts.stdin === "string") return { ...cfg, stream: opts.stdin }
    if (Stream.isStream(opts.stdin)) return { ...cfg, stream: opts.stdin }
    return {
      stream: opts.stdin.stream,
      encoding: opts.stdin.encoding ?? cfg.encoding,
      endOnDone: opts.stdin.endOnDone ?? cfg.endOnDone,
    }
  }

  const stdio = (opts: ChildProcess.CommandOptions, key: "stdout" | "stderr"): ChildProcess.StdoutConfig => {
    const cfg = opts[key]
    if (Predicate.isUndefined(cfg)) return { stream: "pipe" }
    if (typeof cfg === "string") return { stream: cfg }
    if (Sink.isSink(cfg)) return { stream: cfg }
    return { stream: cfg.stream }
  }

  const fds = (opts: ChildProcess.CommandOptions) => {
    if (Predicate.isUndefined(opts.additionalFds)) return []
    return Object.entries(opts.additionalFds)
      .flatMap(([name, config]) => {
        const fd = ChildProcess.parseFdName(name)
        return Predicate.isUndefined(fd) ? [] : [{ fd, config }]
      })
      .toSorted((a, b) => a.fd - b.fd)
  }

  const stdios = (
    sin: ChildProcess.StdinConfig,
    sout: ChildProcess.StdoutConfig,
    serr: ChildProcess.StderrConfig,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ): NodeChildProcess.StdioOptions => {
    const pipe = (x: NodeChildProcess.IOType | undefined) =>
      process.platform === "win32" && x === "pipe" ? "overlapped" : x
    const arr: Array<NodeChildProcess.IOType | undefined> = [
      pipe(input(sin.stream)),
      pipe(output(sout.stream)),
      pipe(output(serr.stream)),
    ]
    if (extra.length === 0) return arr as NodeChildProcess.StdioOptions
    const max = extra.reduce((acc, x) => Math.max(acc, x.fd), 2)
    for (let i = 3; i <= max; i++) arr[i] = "ignore"
    for (const x of extra) arr[x.fd] = pipe("pipe")
    return arr as NodeChildProcess.StdioOptions
  }

  const setupFds = Effect.fnUntraced(function* (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ) {
    if (extra.length === 0) {
      return {
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }
    }

    const ins = new Map<number, Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>>()
    const outs = new Map<number, Stream.Stream<Uint8Array, PlatformError.PlatformError>>()

    for (const x of extra) {
      const node = proc.stdio[x.fd]
      switch (x.config.type) {
        case "input": {
          let sink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.drain
          if (node && "write" in node) {
            sink = NodeSink.fromWritable({
              evaluate: () => node,
              onError: (err) => toPlatformError(`fromWritable(fd${x.fd})`, toError(err), command),
              endOnDone: true,
            })
          }
          if (x.config.stream) yield* Effect.forkScoped(Stream.run(x.config.stream, sink))
          ins.set(x.fd, sink)
          break
        }
        case "output": {
          let stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.empty
          if (node && "read" in node) {
            const tap = new PassThrough()
            node.on("error", (err) => tap.destroy(toError(err)))
            node.pipe(tap)
            stream = NodeStream.fromReadable({
              evaluate: () => tap,
              onError: (err) => toPlatformError(`fromReadable(fd${x.fd})`, toError(err), command),
            })
          }
          if (x.config.sink) stream = Stream.transduce(stream, x.config.sink)
          outs.set(x.fd, stream)
          break
        }
      }
    }

    return {
      getInputFd: (fd: number) => ins.get(fd) ?? Sink.drain,
      getOutputFd: (fd: number) => outs.get(fd) ?? Stream.empty,
    }
  })

  const nodeBufferEncoding = (encoding: ChildProcess.Encoding | undefined): BufferEncoding | undefined =>
    encoding === "utf-16le" ? "utf16le" : encoding

  const setupStdin = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    cfg: ChildProcess.StdinConfig,
  ) =>
    Effect.suspend(() => {
      let sink: Sink.Sink<void, unknown, never, PlatformError.PlatformError> = Sink.drain
      if (Predicate.isNotNull(proc.stdin)) {
        sink = NodeSink.fromWritable({
          evaluate: () => proc.stdin!,
          onError: (err) => toPlatformError("fromWritable(stdin)", toError(err), command),
          endOnDone: cfg.endOnDone,
          encoding: nodeBufferEncoding(cfg.encoding),
        })
      }
      if (Stream.isStream(cfg.stream)) return Effect.as(Effect.forkScoped(Stream.run(cfg.stream, sink)), sink)
      return Effect.succeed(sink)
    })

  const setupOutput = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    out: ChildProcess.StdoutConfig,
    err: ChildProcess.StderrConfig,
  ) => {
    const captured = buffered.get(proc)!
    captured.collecting = false
    const readable = (stream: PassThrough | undefined, method: string) =>
      !stream
        ? Stream.empty
        : Stream.unwrap(
            Effect.sync(() => {
              captured.claimed = true
              captured.prefix.length = 0
              return stream.errored
                ? Stream.fail(toPlatformError(method, stream.errored, command))
                : NodeStream.fromReadable({
                    evaluate: () => stream,
                    onError: (cause) => toPlatformError(method, toError(cause), command),
                  })
            }),
          )
    let stdout = readable(captured.stdout, "fromReadable(stdout)")
    let stderr = readable(captured.stderr, "fromReadable(stderr)")

    if (Sink.isSink(out.stream)) stdout = Stream.transduce(stdout, out.stream)
    if (Sink.isSink(err.stream)) stderr = Stream.transduce(stderr, err.stream)

    const all = Stream.suspend(() => {
      if (captured.claimed || Sink.isSink(out.stream) || Sink.isSink(err.stream)) return Stream.merge(stdout, stderr)
      captured.claimed = true
      const prefix = captured.prefix.splice(0)
      for (const channel of ["stdout", "stderr"] as const) {
        const bytes = prefix.reduce((size, item) => size + (item.channel === channel ? item.chunk.length : 0), 0)
        if (bytes > 0) captured[channel]?.read(bytes)
      }
      return Stream.concat(Stream.fromIterable(prefix.map((item) => item.chunk)), Stream.merge(stdout, stderr))
    })
    return { stdout, stderr, all }
  }

  const spawn = (command: ChildProcess.StandardCommand, opts: NodeChildProcess.SpawnOptions) =>
    Effect.callback<readonly [NodeChildProcess.ChildProcess, ExitSignal], PlatformError.PlatformError>((resume) => {
      const signal = Deferred.makeUnsafe<readonly [code: number | null, signal: NodeJS.Signals | null]>()
      const proc = launch(command.command, command.args, opts)
      const captured: Capture = { prefix: [], collecting: true, claimed: false }
      captured.stdout = buffer(proc.stdout, "stdout", captured)
      captured.stderr = buffer(proc.stderr, "stderr", captured)
      buffered.set(proc, captured)
      let end = false
      let exit: readonly [code: number | null, signal: NodeJS.Signals | null] | undefined
      proc.on("error", (err) => {
        resume(Effect.fail(toPlatformError("spawn", err, command)))
      })
      proc.on("exit", (...args) => {
        exit = args
        if (process.platform !== "win32") Deferred.doneUnsafe(signal, Exit.succeed(args))
      })
      proc.on("close", (...args) => {
        if (end) return
        end = true
        Deferred.doneUnsafe(signal, Exit.succeed(exit ?? args))
      })
      proc.on("spawn", () => {
        resume(Effect.succeed([proc, signal]))
      })
      return Effect.sync(() => {
        proc.kill("SIGTERM")
      })
    })

  const killGroup = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ) => {
    if (globalThis.process.platform === "win32") {
      return Effect.callback<void, PlatformError.PlatformError>((resume) => {
        NodeChildProcess.exec(`taskkill /pid ${proc.pid} /T /F`, { windowsHide: true }, (err) => {
          if (err) return resume(Effect.fail(toPlatformError("kill", toError(err), command)))
          resume(Effect.void)
        })
      })
    }

    return Effect.try({
      try: () => {
        globalThis.process.kill(-proc.pid!, signal)
      },
      catch: toError,
    }).pipe(
      Effect.catch((error) =>
        "code" in error && error.code === "ESRCH" ? Effect.void : Effect.fail(toPlatformError("kill", error, command)),
      ),
    )
  }

  const terminate = Effect.fnUntraced(
    function* (
      command: ChildProcess.StandardCommand,
      proc: NodeChildProcess.ChildProcess,
      signal: ExitSignal,
      group: Effect.Success<ReturnType<typeof ProcessGroup.make>> | undefined,
      opts?: ChildProcess.KillOptions,
    ) {
      if (process.platform === "win32") {
        if (!(yield* Deferred.isDone(signal))) yield* recheckWindowsClose(killGroup(command, proc, "SIGKILL"), signal)
        yield* Deferred.await(signal)
        return
      }
      if (!group)
        return yield* Effect.fail(toPlatformError("kill", new Error("Missing process-group identity"), command))
      const gone = Effect.gen(function* () {
        while (true) {
          const members = yield* group.members
          if (members.length === 0) return
          yield* Effect.sleep(25)
        }
      })
      yield* group
        .signal(opts?.killSignal ?? command.options.killSignal ?? "SIGTERM")
        .pipe(Effect.mapError((error) => toPlatformError("kill", error, command)))
      yield* gone.pipe(
        Effect.timeoutOrElse({
          duration: opts?.forceKillAfter ?? command.options.forceKillAfter ?? Duration.seconds(3),
          orElse: () => group.signal("SIGKILL").pipe(Effect.andThen(gone), Effect.timeout(1_000)),
        }),
        Effect.mapError((error) => toPlatformError("kill", toError(error), command)),
      )
    },
    Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
  )

  const closeOutput = (proc: NodeChildProcess.ChildProcess) =>
    Effect.sync(() => {
      for (const key of ["stdout", "stderr"] as const) {
        const captured = buffered.get(proc)?.[key]
        proc[key]?.unpipe(captured)
        proc[key]?.destroy()
        captured?.end()
      }
      proc.stdin?.destroy()
    })

  const source = (handle: ChildProcessHandle, from: ChildProcess.PipeFromOption | undefined) => {
    const opt = from ?? "stdout"
    switch (opt) {
      case "stdout":
        return handle.stdout
      case "stderr":
        return handle.stderr
      case "all":
        return handle.all
      default: {
        const fd = ChildProcess.parseFdName(opt)
        return Predicate.isNotUndefined(fd) ? handle.getOutputFd(fd) : handle.stdout
      }
    }
  }

  const spawnCommand: (
    command: ChildProcess.Command,
  ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> = Effect.fnUntraced(
    function* (command) {
      switch (command._tag) {
        case "StandardCommand": {
          const sin = stdin(command.options)
          const sout = stdio(command.options, "stdout")
          const serr = stdio(command.options, "stderr")
          const extra = fds(command.options)
          const dir = yield* cwd(command.options)

          const [proc, signal, group] = yield* Effect.acquireRelease(
            spawn(command, {
              cwd: dir,
              env: env(command.options),
              stdio: stdios(sin, sout, serr, extra),
              detached: command.options.detached ?? process.platform !== "win32",
              shell: command.options.shell,
              windowsHide: process.platform === "win32",
            }).pipe(
              Effect.flatMap(([proc, signal]) =>
                Effect.gen(function* () {
                  const group =
                    process.platform === "win32"
                      ? undefined
                      : yield* ProcessGroup.make(proc.pid!, command.options.detached ?? true, processSystem)
                  return [proc, signal, group] as const
                }),
              ),
            ),
            Effect.fnUntraced(function* ([proc, signal, group]) {
              yield* terminate(command, proc, signal, group).pipe(Effect.ensuring(closeOutput(proc)), Effect.orDie)
            }),
          )

          const fd = yield* setupFds(command, proc, extra)
          const out = setupOutput(command, proc, sout, serr)
          let ref = true
          return makeHandle({
            pid: ProcessId(proc.pid!),
            stdin: yield* setupStdin(command, proc, sin),
            stdout: out.stdout,
            stderr: out.stderr,
            all: out.all,
            getInputFd: fd.getInputFd,
            getOutputFd: fd.getOutputFd,
            isRunning: Effect.map(Deferred.isDone(signal), (done) => !done),
            exitCode: Effect.flatMap(Deferred.await(signal), ([code, signal]) => {
              if (Predicate.isNotNull(code)) return Effect.succeed(ExitCode(code))
              return Effect.fail(
                toPlatformError(
                  "exitCode",
                  new Error(`Process interrupted due to receipt of signal: '${signal}'`),
                  command,
                ),
              )
            }),
            kill: (opts) => terminate(command, proc, signal, group, opts),
            unref: Effect.sync(() => {
              if (ref) {
                proc.unref()
                ref = false
              }
              return Effect.sync(() => {
                if (!ref) {
                  proc.ref()
                  ref = true
                }
              })
            }),
          })
        }
        case "PipedCommand": {
          const flat = flatten(command)
          const [head, ...tail] = flat.commands
          let handle = spawnCommand(head)
          for (let i = 0; i < tail.length; i++) {
            const next = tail[i]
            const opts = flat.opts[i] ?? {}
            const sin = stdin(next.options)
            const stream = Stream.unwrap(Effect.map(handle, (x) => source(x, opts.from)))
            const to = opts.to ?? "stdin"
            if (to === "stdin") {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            const fd = ChildProcess.parseFdName(to)
            if (Predicate.isUndefined(fd)) {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            handle = spawnCommand(
              ChildProcess.make(next.command, next.args, {
                ...next.options,
                additionalFds: {
                  ...next.options.additionalFds,
                  [ChildProcess.fdName(fd) as `fd${number}`]: { type: "input", stream },
                },
              }),
            )
          }
          return yield* handle
        }
      }
    },
  )

  return make(spawnCommand)
})

export const layer: Layer.Layer<ChildProcessSpawner, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  ChildProcessSpawner,
  makeCrossSpawnSpawner,
)

export const node = makeGlobalNode({ service: ChildProcessSpawner, layer, deps: [filesystem, path] })

export * as CrossSpawnSpawner from "./cross-spawn-spawner"
