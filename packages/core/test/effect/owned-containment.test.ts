import { expect, test } from "bun:test"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Cause, Effect, Layer, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "../../src/cross-spawn-spawner"
import { ProcessGroup } from "../../src/shell/process-group"

for (const [executable, expected] of [["/usr/bin/true", 0], ["/usr/bin/false", 1]] as const) {
  test(`an exited non-detached child preserves status ${expected} when process enumeration is unavailable`, async () => {
    const layer = Layer.fresh(CrossSpawnSpawner.layer).pipe(Layer.provide(Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layer,
      Layer.succeed(ProcessGroup.System, {
        read: Effect.fail(new Error("Process enumeration is not admitted")),
        signal: () => Effect.die(new Error("An exited child must not be signalled")),
      }),
    )))
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const child = yield* ChildProcess.make(executable, [], {
        detached: false,
        extendEnv: false,
        env: { HOME: process.env.HOME!, PATH: process.env.PATH! },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      return yield* child.exitCode
    }).pipe(Effect.provide(layer))))
    expect(Number(result)).toBe(expected)
  })
}

for (const ignoresTerm of [false, true]) {
  test(`non-detached child ${ignoresTerm ? "is killed after ignoring TERM" : "exits on TERM"} without process enumeration`, async () => {
    const layer = Layer.fresh(CrossSpawnSpawner.layer).pipe(Layer.provide(Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layer,
      Layer.succeed(ProcessGroup.System, {
        read: Effect.fail(new Error("Process enumeration is not admitted")),
        signal: () => Effect.die(new Error("Process group signalling is not admitted")),
      }),
    )))
    let child: ChildProcessSpawner.ChildProcessHandle | undefined
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        child = yield* ChildProcess.make(process.execPath, ["-e", `process.on('SIGTERM',()=>${ignoresTerm ? "{}" : "process.exit(0)"}); process.stdout.write('ready'); setTimeout(()=>process.exit(4),1500)`], {
          detached: false, extendEnv: false, env: { HOME: process.env.HOME!, PATH: process.env.PATH! },
          stdin: "ignore", stdout: "pipe", stderr: "ignore", forceKillAfter: "100 millis",
        })
        yield* Stream.runHead(child.stdout)
        yield* child.kill()
        if (ignoresTerm) {
          const result = yield* Effect.exit(child.exitCode)
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(Cause.pretty(result.cause)).toContain("SIGKILL")
        }
        else expect(Number(yield* child.exitCode)).toBe(0)
      }).pipe(Effect.provide(layer))))
    } finally {
      if (child) await Effect.runPromise(Effect.exit(child.exitCode))
    }
  }, 5_000)
}

for (const detached of [undefined, true]) {
  test(`the ${detached === undefined ? "default" : "explicit detached"} child keeps its private group path`, async () => {
    let reads = 0
    const layer = Layer.fresh(CrossSpawnSpawner.layer).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer,
      Layer.succeed(ProcessGroup.System, {
        read: Effect.sync(() => { reads++; return [] }),
        signal: () => Effect.die(new Error("The finite exited group must not be signalled")),
      }),
    )))
    const output = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const child = yield* ChildProcess.make("/usr/bin/python3", ["-c", "import os;print(os.getpid()==os.getpgrp())"], {
        ...(detached === undefined ? {} : { detached }), extendEnv: false, env: { HOME: process.env.HOME!, PATH: process.env.PATH! }, stdin: "ignore", stderr: "ignore",
      })
      const output = yield* Stream.runCollect(Stream.decodeText(child.stdout))
      expect(Number(yield* child.exitCode)).toBe(0)
      return output.join("").trim()
    }).pipe(Effect.provide(layer))))
    expect(output).toBe("True")
    expect(reads).toBeGreaterThan(0)
  })
}

test("a non-detached stdin lease delivers EOF and drains its final output", async () => {
  const layer = Layer.fresh(CrossSpawnSpawner.layer).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer,
    Layer.succeed(ProcessGroup.System, {
      read: Effect.fail(new Error("Process enumeration is not admitted")), signal: () => Effect.die(new Error("Unexpected group signal")),
    }),
  )))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const child = yield* ChildProcess.make(process.execPath, ["-e", "process.stdin.resume();process.stdin.once('end',()=>process.stdout.write('lease-ended'))"], {
      detached: false, extendEnv: false, env: { HOME: process.env.HOME!, PATH: process.env.PATH! }, stdin: { stream: Stream.empty, endOnDone: true }, stderr: "ignore",
    })
    const output = yield* Stream.runCollect(Stream.decodeText(child.stdout))
    expect(output.join("")).toBe("lease-ended")
    expect(Number(yield* child.exitCode)).toBe(0)
  }).pipe(Effect.provide(layer))))
})
