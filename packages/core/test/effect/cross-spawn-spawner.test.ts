import { describe, expect, onTestFinished, test } from "bun:test"
import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import { once } from "node:events"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Exit, Layer, Stream } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import type * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@ycoding-ai/core/cross-spawn-spawner"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import { cleanGroup, fileReady, groupAlive, shellProcess } from "../fixture/shell-process"
import { ProcessGroup } from "@ycoding-ai/core/shell/process-group"

const live = LayerNode.compile(CrossSpawnSpawner.node)
const fx = testEffect(live)

function js(code: string, opts?: ChildProcess.CommandOptions) {
  return ChildProcess.make("node", ["-e", code], opts)
}

function decodeByteStream(stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) {
  return Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      const total = chunks.reduce((acc, x) => acc + x.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const chunk of chunks) {
        out.set(chunk, off)
        off += chunk.length
      }
      return new TextDecoder("utf-8").decode(out).trim()
    }),
  )
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-core-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function gone(pid: number, timeout = 5_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

describe("cross-spawn spawner", () => {
  for (const channel of ["stdout", "stderr"] as const) {
    fx.live(`releasing ${channel} closes its continuous writer without a scope kill`, () =>
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(process.execPath, [
          "-e",
          `
          const output = process.${channel};
          output.on("error", (error) => process.exit(error.code === "EPIPE" ? 0 : 2));
          const chunk = Buffer.alloc(4096, 120);
          function write() { while (output.write(chunk)) {} output.once("drain", write); }
          write();
        `,
        ])
        expect((yield* Stream.runHead(handle[channel]))._tag).toBe("Some")
        expect(yield* handle.exitCode.pipe(Effect.timeout(2_000))).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )
  }
  describe("basic spawning", () => {
    fx.effect(
      "captures stdout",
      Effect.gen(function* () {
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("ok")'])),
        )
        expect(out).toBe("ok")
      }),
    )

    fx.effect(
      "captures multiple lines",
      Effect.gen(function* () {
        const handle = yield* js('console.log("line1"); console.log("line2"); console.log("line3")')
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("line1\nline2\nline3")
      }),
    )

    fx.effect(
      "returns exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(0)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )

    fx.effect(
      "returns non-zero exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(42)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(42))
      }),
    )
  })

  describe("cwd option", () => {
    fx.effect(
      "uses cwd when spawning commands",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: tmp.path }),
          ),
        )
        expect(yield* Effect.promise(() => fs.realpath(out))).toBe(yield* Effect.promise(() => fs.realpath(tmp.path)))
      }),
    )

    fx.effect(
      "fails for invalid cwd",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
            svc.spawn(ChildProcess.make("echo", ["test"], { cwd: "/nonexistent/directory/path" })),
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  describe("env option", () => {
    fx.effect(
      "passes environment variables with extendEnv",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write(process.env.TEST_VAR ?? "")', {
          env: { TEST_VAR: "test_value" },
          extendEnv: true,
        })
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("test_value")
      }),
    )

    fx.effect(
      "passes multiple environment variables",
      Effect.gen(function* () {
        const handle = yield* js(
          "process.stdout.write(`${process.env.VAR1}-${process.env.VAR2}-${process.env.VAR3}`)",
          {
            env: { VAR1: "one", VAR2: "two", VAR3: "three" },
            extendEnv: true,
          },
        )
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("one-two-three")
      }),
    )
  })

  describe("stderr", () => {
    fx.effect(
      "captures stderr output",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error message")')
        const err = yield* decodeByteStream(handle.stderr)
        expect(err).toBe("error message")
      }),
    )

    fx.effect(
      "captures both stdout and stderr",
      Effect.gen(function* () {
        const handle = yield* js(
          [
            "let pending = 2",
            "const done = () => {",
            "  pending -= 1",
            "  if (pending === 0) setTimeout(() => process.exit(0), 0)",
            "}",
            'process.stdout.write("stdout\\n", done)',
            'process.stderr.write("stderr\\n", done)',
          ].join("\n"),
        )
        const [stdout, stderr] = yield* Effect.all([decodeByteStream(handle.stdout), decodeByteStream(handle.stderr)], {
          concurrency: 2,
        })
        expect(stdout).toBe("stdout")
        expect(stderr).toBe("stderr")
      }),
    )
  })

  describe("combined output (all)", () => {
    fx.effect(
      "captures stdout via .all when no stderr",
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make("echo", ["hello from stdout"])
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stdout")
      }),
    )

    fx.effect(
      "captures stderr via .all when no stdout",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("hello from stderr")')
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stderr")
      }),
    )
  })

  describe("stdin", () => {
    fx.effect(
      "allows providing standard input to a command",
      Effect.gen(function* () {
        const input = "a b c"
        const stdin = Stream.make(Buffer.from(input, "utf-8"))
        const handle = yield* js(
          'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
          { stdin },
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("a b c")
      }),
    )

    fx.effect(
      "normalizes the Effect utf-16le stdin encoding alias for Node",
      Effect.gen(function* () {
        const stdin = {
          stream: Stream.make(Buffer.from("hello", "utf16le")),
          encoding: "utf-16le" as const,
        }
        const handle = yield* ChildProcess.make(
          process.execPath,
          [
            "-e",
            'process.stdin.setEncoding("utf16le"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
          ],
          { stdin },
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("hello")
      }),
    )
  })

  describe("process control", () => {
    fx.live(
      "signals the original group when its leader exits before its descendants are observed",
      () =>
        Effect.gen(function* () {
          if (process.platform === "win32") return
          const tmp = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          )
          const original = ProcessGroup.native
          const state = { pid: 0, hideLeader: false }
          const targets: number[] = []
          const scoped = Layer.fresh(CrossSpawnSpawner.layer).pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeFileSystem.layer,
                NodePath.layer,
                Layer.succeed(ProcessGroup.System, {
                  read: original.read.pipe(
                    Effect.map((rows) => (state.hideLeader ? rows.filter((row) => row.pid !== state.pid) : rows)),
                  ),
                  signal: (pid, signal) => {
                    targets.push(pid)
                    return original.signal(pid, signal)
                  },
                }),
              ),
            ),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const command = shellProcess(tmp.path, true)
              const handle = yield* ChildProcess.make("node", ["-e", command.script], { forceKillAfter: 100 })
              state.pid = Number(handle.pid)
              yield* Effect.addFinalizer(() => cleanGroup(state.pid))
              yield* fileReady(command.ready)
              state.hideLeader = true
              yield* handle.kill().pipe(Effect.timeout(2_500))
              expect(targets).toEqual([-state.pid, -state.pid])
            }).pipe(Effect.provide(scoped)),
          )
        }),
      10_000,
    )

    fx.live(
      "bounds confirmation when original members remain after SIGKILL",
      () =>
        Effect.gen(function* () {
          if (process.platform === "win32") return
          const tmp = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          )
          const original = ProcessGroup.native
          const scoped = Layer.fresh(CrossSpawnSpawner.layer).pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeFileSystem.layer,
                NodePath.layer,
                Layer.succeed(ProcessGroup.System, { ...original, signal: () => Effect.void }),
              ),
            ),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const command = shellProcess(tmp.path, true)
              const handle = yield* ChildProcess.make("node", ["-e", command.script], { forceKillAfter: 100 })
              yield* Effect.addFinalizer(() => cleanGroup(Number(handle.pid)))
              yield* fileReady(command.ready)
              const result = yield* handle.kill().pipe(Effect.exit, Effect.timeout(2_500))
              expect(Exit.isFailure(result)).toBe(true)
              expect(groupAlive(Number(handle.pid))).toBe(true)
            }).pipe(Effect.provide(scoped)),
          )
        }),
      10_000,
    )

    for (const mode of ["escaped", "drain"] as const)
      fx.live(
        mode === "escaped"
          ? "Node cleanup settles while an escaped descendant keeps inherited pipes open"
          : "Node drains every byte written before leader exit while capture is held",
        () =>
          Effect.gen(function* () {
            if (process.platform === "win32") return
            const tmp = yield* Effect.acquireRelease(
              Effect.promise(() => tmpdir()),
              (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
            )
            const built = yield* Effect.promise(() =>
              Bun.build({
                entrypoints: [path.join(import.meta.dir, "../fixture/spawner-pipe.ts")],
                outdir: tmp.path,
                target: "node",
                naming: "runner.mjs",
              }),
            )
            expect(built.success).toBe(true)
            const runner = Bun.spawn(
              ["node", path.join(tmp.path, "runner.mjs"), ...(mode === "drain" ? ["drain"] : []), tmp.path],
              {
                stdout: "ignore",
                stderr: "pipe",
                detached: true,
              },
            )
            const leader = Number(yield* fileReady(path.join(tmp.path, "leader")))
            yield* Effect.addFinalizer(() => cleanGroup(leader).pipe(Effect.andThen(cleanGroup(runner.pid))))
            if (mode === "drain") {
              const code = yield* Effect.promise(() => runner.exited).pipe(Effect.timeout(3_000))
              expect(code, yield* Effect.promise(() => new Response(runner.stderr).text())).toBe(0)
              expect(
                (yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "output")))).equals(
                  Buffer.alloc(256 * 1024, 97),
                ),
              ).toBe(true)
              return
            }
            const escaped = Number(yield* fileReady(path.join(tmp.path, "escaped-ready")))
            yield* Effect.addFinalizer(() => cleanGroup(escaped))
            yield* fileReady(path.join(tmp.path, "settled"))
            expect(groupAlive(escaped)).toBe(true)
          }),
        15_000,
      )

    for (const replacement of ["stale", "replaced", "disappeared"] as const) {
      fx.live(
        `does not signal ${replacement} process-group ownership`,
        () =>
          Effect.gen(function* () {
            if (process.platform === "win32") return
            const tmp = yield* Effect.acquireRelease(
              Effect.promise(() => tmpdir()),
              (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
            )
            const original = ProcessGroup.native
            const state = { pid: 0, changed: false }
            const sent: NodeJS.Signals[] = []
            const system = {
              read: original.read.pipe(
                Effect.map((rows) =>
                  state.changed
                    ? replacement === "disappeared"
                      ? rows.filter((row) => row.pgid !== state.pid)
                      : [
                          ...rows.filter((row) => row.pid !== state.pid),
                          { pid: state.pid, pgid: state.pid, started: "replacement" },
                        ]
                    : rows,
                ),
              ),
              signal: (pid: number, signal: NodeJS.Signals) => {
                sent.push(signal)
                if (signal === "SIGTERM") state.changed = true
                return original.signal(pid, signal)
              },
            }
            const scoped = Layer.fresh(CrossSpawnSpawner.layer).pipe(
              Layer.provide(
                Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, Layer.succeed(ProcessGroup.System, system)),
              ),
            )
            const command = shellProcess(tmp.path, true)
            yield* Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* ChildProcess.make("node", ["-e", command.script], { forceKillAfter: 100 })
                state.pid = Number(handle.pid)
                yield* Effect.addFinalizer(() => cleanGroup(state.pid))
                yield* fileReady(command.ready)
                if (replacement === "stale") state.changed = true
                yield* handle.kill().pipe(Effect.timeout(2_000))
                expect(groupAlive(state.pid)).toBe(true)
                const count = sent.length
                state.changed = false
                yield* handle.kill().pipe(Effect.timeout(2_000))
                expect(sent.length).toBe(count)
                expect(sent).not.toContain("SIGKILL")
                if (replacement === "stale") expect(sent).toEqual([])
              }).pipe(Effect.provide(scoped)),
            )
          }),
        10_000,
      )
    }

    for (const mode of ["kill", "release", "exited-release"] as const) {
      fx.live(
        `cleans surviving group members after leader exit on ${mode}`,
        () =>
          Effect.gen(function* () {
            if (process.platform === "win32") return
            const tmp = yield* Effect.acquireRelease(
              Effect.promise(() => tmpdir()),
              (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
            )
            const command = shellProcess(tmp.path)
            const pid = { value: 0 }
            yield* Effect.addFinalizer(() => (pid.value ? cleanGroup(pid.value) : Effect.void))
            yield* Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* ChildProcess.make("node", ["-e", command.script], { forceKillAfter: 100 })
                pid.value = Number(handle.pid)
                yield* fileReady(command.ready)
                if (mode === "kill") yield* handle.kill().pipe(Effect.timeout(2_000))
                if (mode === "exited-release") {
                  process.kill(Number(yield* fileReady(command.ready)), "SIGTERM")
                  expect(yield* handle.exitCode.pipe(Effect.timeout(2_000))).toBe(ChildProcessSpawner.ExitCode(0))
                }
              }),
            )
            expect(groupAlive(pid.value)).toBe(false)
            expect(yield* fileReady(command.childTerm)).toBe("term")
          }),
        10_000,
      )
    }

    fx.effect(
      "kills a running process",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js("setTimeout(() => {}, 10_000)")
            yield* handle.kill()
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "kills a child when scope exits",
      Effect.gen(function* () {
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* js("setInterval(() => {}, 10_000)")
            return Number(handle.pid)
          }),
        )
        const done = yield* Effect.promise(() => gone(pid))
        expect(done).toBe(true)
      }),
    )

    fx.effect(
      "forceKillAfter escalates for stubborn processes",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const handle = yield* js(
          'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 10_000)',
        )
        expect((yield* Stream.runHead(handle.stdout))._tag).toBe("Some")
        const started = Date.now()
        const exit = yield* handle.kill({ forceKillAfter: 100 }).pipe(Effect.andThen(handle.exitCode), Effect.exit)

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "isRunning reflects process state",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("done")')
        yield* handle.exitCode
        const running = yield* handle.isRunning
        expect(running).toBe(false)
      }),
    )
  })

  describe("error handling", () => {
    fx.effect(
      "fails for invalid command",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* ChildProcess.make("nonexistent-command-12345")
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )
  })

  describe("pipeline", () => {
    fx.effect(
      "pipes stdout of one command to stdin of another",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO WORLD")
      }),
    )

    fx.effect(
      "three-stage pipeline",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.replaceAll(" ", "-")))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO-WORLD")
      }),
    )

    fx.effect(
      "pipes stderr with { from: 'stderr' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "stderr" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("error")
      }),
    )

    fx.effect(
      "pipes combined output with { from: 'all' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "all" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toContain("stdout")
        expect(out).toContain("stderr")
      }),
    )
  })

  describe("Windows-specific", () => {
    fx.effect(
      "uses shell routing on Windows",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make("set", ["YCODING_TEST_SHELL"], {
              shell: true,
              extendEnv: true,
              env: { YCODING_TEST_SHELL: "ok" },
            }),
          ),
        )
        expect(out).toContain("YCODING_TEST_SHELL=ok")
      }),
    )

    fx.effect(
      "runs cmd scripts with spaces on Windows without shell",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = path.join(tmp.path, "with space")
        const file = path.join(dir, "echo cmd.cmd")

        yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n"))

        const code = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.exitCode(
            ChildProcess.make(file, ["--stdio"], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          ),
        )
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )
  })
})


describe("Windows taskkill close race", () => {
  const closed = () => Deferred.makeUnsafe<readonly [number | null, NodeJS.Signals | null]>()

  test("accepts taskkill failure only when the same child closes during the attempt", async () => {
    const completion = closed()
    const error = Object.assign(new Error("process not found"), { code: 128 })
    expect(Deferred.isDoneUnsafe(completion)).toBe(false)
    const kill = Effect.sync(() => Deferred.doneUnsafe(completion, Exit.succeed([1, null] as const))).pipe(
      Effect.andThen(Effect.fail(error)),
    )
    const result = await Effect.runPromise(Effect.exit(CrossSpawnSpawner.recheckWindowsClose(kill, completion)))
    expect(result._tag).toBe("Success")
  })

  test("preserves failure after root exit while a descendant keeps its output pipe open", async () => {
    const completion = closed()
    const control = await tmpdir()
    const release = path.join(control.path, "release")
    const probe = path.join(control.path, "probe")
    const parent = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process")
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(String.raw`
        const fs = require("node:fs")
        let acknowledged = false
        setInterval(() => {
          if (fs.existsSync(process.argv[1])) process.exit(0)
          if (!acknowledged && fs.existsSync(process.argv[2])) {
            acknowledged = true
            process.stdout.write(String(process.pid) + "\n")
          }
        }, 10)
      `)}, ${JSON.stringify(release)}, ${JSON.stringify(probe)}], { stdio: ["ignore", 1, 2] })
      child.unref()
    `], { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    parent.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192) })
    const exit = once(parent, "exit")
    const close = new Promise<void>((resolve) => parent.once("close", (code, signal) => {
      Deferred.doneUnsafe(completion, Exit.succeed([code, signal] as const))
      resolve()
    }))
    // The release file outlives the root's stdio handles. Cleanup releases the
    // descendant even if its PID handshake fails or the test times out.
    let finished = false
    let probeWrite: Promise<void> | undefined
    let cleaning: Promise<void> | undefined
    const cleanup = () => cleaning ??= (async () => {
      await fs.writeFile(release, "")
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL")
      await close
      // A write admitted before cleanup must settle before its directory is removed.
      if (probeWrite) await Promise.allSettled([probeWrite])
      await control[Symbol.asyncDispose]()
    })()
    onTestFinished(() => {
      finished = true
      return cleanup()
    })
    const ready = new Promise<number>((resolve, reject) => {
      let output = ""
      parent.stdout!.on("data", (chunk) => {
        output += chunk.toString()
        const newline = output.indexOf("\n")
        if (newline !== -1) resolve(Number(output.slice(0, newline)))
      })
      parent.once("error", reject)
      parent.once("close", () => {
        if (finished) resolve(0) // The original test timeout already failed.
        else reject(new Error(`Descendant closed before its PID handshake (exit=${parent.exitCode}, signal=${parent.signalCode}): ${stderr}`))
      })
    })
    try {
      // The descendant must acknowledge activity after the root has exited.
      const [pid] = await Promise.all([ready, exit.then(() => {
        if (finished || cleaning) return
        return probeWrite = fs.writeFile(probe, "")
      })])
      if (finished) return
      expect(parent.exitCode).toBe(0)
      expect(Number.isInteger(pid) && pid > 0).toBe(true)
      expect(Deferred.isDoneUnsafe(completion)).toBe(false)
      const error = Object.assign(new Error("root process not found"), { code: 128 })
      const result = await Effect.runPromise(CrossSpawnSpawner.recheckWindowsClose(Effect.fail(error), completion).pipe(
        Effect.match({ onFailure: (cause) => cause, onSuccess: () => undefined }),
      ))
      expect(result).toBe(error)
      expect(Deferred.isDoneUnsafe(completion)).toBe(false)
    } finally {
      await cleanup()
    }
    expect(Deferred.isDoneUnsafe(completion)).toBe(true)
  })

  for (const code of [128, "EACCES"] as const) {
    test(`preserves taskkill ${code} while child close is unconfirmed`, async () => {
      const completion = closed()
      const error = Object.assign(new Error("taskkill failed"), { code })
      const result = await Effect.runPromise(CrossSpawnSpawner.recheckWindowsClose(Effect.fail(error), completion).pipe(
        Effect.match({ onFailure: (cause) => cause, onSuccess: () => undefined }),
      ))
      expect(result).toBe(error)
      expect(Deferred.isDoneUnsafe(completion)).toBe(false)
    })
  }
})
