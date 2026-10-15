import { describe, expect } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Fiber, Schema, Scope } from "effect"
import { ProcessLock } from "@ycoding-ai/core/util/process-lock"
import { ShellMemory } from "@ycoding-ai/core/shell/memory"
import { it } from "./lib/effect"

const temp = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "ycoding-shell-memory-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)
const decodeHistory = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ key: Schema.String, peaks: Schema.Array(Schema.Number) }))),
)

describe("shell memory history", () => {
  it.live("cleans interrupted and failed writes without leaving locks or temporary files", () =>
    Effect.gen(function* () {
      const directory = yield* temp
      const memory = ShellMemory.make(directory)
      const input = { command: "check", cwd: directory, peakMb: 100, reserveMb: 2_048, canLower: true }
      yield* memory.record(input)
      const holder = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(holder, Exit.void))
      yield* ProcessLock.acquire(path.join(directory, "memory.lock")).pipe(Scope.provide(holder))
      const writer = yield* memory.record({ ...input, peakMb: 200 }).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Fiber.interrupt(writer)
      yield* Scope.close(holder, Exit.void)
      yield* Effect.scoped(ProcessLock.acquire(path.join(directory, "memory.lock")))
      expect(yield* memory.requirement(input)).toBe(100)
      expect(yield* Effect.promise(() => readdir(directory))).toEqual(["memory.json", "memory.lock"])
      const failed = path.join(directory, "failed")
      yield* Effect.promise(() => mkdir(path.join(failed, "memory.json"), { recursive: true }))
      expect(Exit.isFailure(yield* ShellMemory.make(failed).record(input).pipe(Effect.exit))).toBe(true)
      yield* Effect.scoped(ProcessLock.acquire(path.join(failed, "memory.lock")))
      expect(yield* Effect.promise(() => readdir(failed))).toEqual(["memory.json", "memory.lock"])
    }),
  )
  it.live(
    "ignores incomplete low peaks without evicting history, but accepts increases and sampled successful exits",
    () =>
      Effect.gen(function* () {
        const directory = yield* temp
        const memory = ShellMemory.make(directory)
        const input = { command: "check", cwd: directory, reserveMb: 2_048, memoryLimitMb: 6_144 }
        yield* memory.record({ ...input, peakMb: 3_000, canLower: true })
        for (let index = 0; index < 5; index++) yield* memory.record({ ...input, peakMb: 2, canLower: false })
        expect(yield* memory.requirement(input)).toBe(3_000)
        expect(
          decodeHistory(yield* Effect.promise(() => readFile(path.join(directory, "memory.json"), "utf8")))[0]?.peaks,
        ).toEqual([3_000])
        yield* memory.record({ ...input, peakMb: 4_000, canLower: false })
        expect(yield* memory.requirement(input)).toBe(4_000)
        const cold = { ...input, command: "cold", memoryLimitMb: undefined }
        yield* memory.record({ ...cold, peakMb: 2, canLower: false })
        expect(yield* memory.requirement(cold)).toBe(2_048)
        yield* memory.record({ ...cold, peakMb: 3_000, canLower: false })
        expect(yield* memory.requirement(cold)).toBe(3_000)
        yield* memory.record({ ...input, peakMb: 1_000, canLower: true })
        expect(
          decodeHistory(yield* Effect.promise(() => readFile(path.join(directory, "memory.json"), "utf8"))).find(
            (entry) => entry.peaks.includes(4_000),
          )?.peaks,
        ).toEqual([3_000, 4_000, 1_000])
      }),
  )
  it.live("bounds contention waits without replacing the last readable history", () =>
    Effect.gen(function* () {
      const directory = yield* temp
      const memory = ShellMemory.make(directory)
      yield* memory.record({ command: "check", cwd: directory, peakMb: 100, canLower: true, reserveMb: 2_048 })
      yield* ProcessLock.acquire(path.join(directory, "memory.lock"))
      expect(
        Exit.isFailure(
          yield* memory
            .record({ command: "check", cwd: directory, peakMb: 200, canLower: true, reserveMb: 2_048 })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* memory.requirement({ command: "check", cwd: directory, reserveMb: 2_048 })).toBe(100)
    }),
  )
  it.live("retains 256 recently recorded keys and stores only hashes and measured peaks", () =>
    Effect.gen(function* () {
      const directory = yield* temp
      const memory = ShellMemory.make(directory)
      for (let index = 0; index < 257; index++)
        yield* memory.record({
          command: `command ${index}`,
          cwd: directory,
          peakMb: index + 1,
          canLower: true,
          reserveMb: 2_048,
        })
      const raw = yield* Effect.promise(() => readFile(path.join(directory, "memory.json"), "utf8"))
      const history = decodeHistory(raw)
      expect(history).toHaveLength(256)
      expect(raw).not.toContain("command")
      expect(raw).not.toContain(directory)
      expect(
        yield* memory.requirement({ command: "command 0", cwd: directory, memoryLimitMb: 6_144, reserveMb: 2_048 }),
      ).toBe(6_144)
      expect(
        yield* memory.requirement({ command: "command 1", cwd: directory, memoryLimitMb: 6_144, reserveMb: 2_048 }),
      ).toBe(2)
      expect(yield* Effect.promise(() => readdir(directory))).toEqual(["memory.json", "memory.lock"])
    }),
  )

  it.live("shares atomic updates across processes without losing independent keys and retains five runs per key", () =>
    Effect.gen(function* () {
      const directory = yield* temp
      const children = Array.from({ length: 3 }, (_, index) =>
        Bun.spawn(
          [process.execPath, path.join(import.meta.dir, "fixture/shell-memory-worker.ts"), directory, String(index)],
          { stdout: "ignore", stderr: "inherit" },
        ),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          children.forEach((child) => child.kill("SIGKILL"))
          await Promise.all(children.map((child) => child.exited))
        }),
      )
      expect(yield* Effect.promise(() => Promise.all(children.map((child) => child.exited)))).toEqual([0, 0, 0])
      const history = decodeHistory(yield* Effect.promise(() => readFile(path.join(directory, "memory.json"), "utf8")))
      expect(history).toHaveLength(4)
      expect(history.map((entry) => entry.peaks.length).toSorted((a, b) => a - b)).toEqual([4, 4, 4, 5])
      const memory = ShellMemory.make(directory)
      for (let index = 0; index < 3; index++)
        expect(yield* memory.requirement({ command: `check ${index}`, cwd: directory, reserveMb: 2_048 })).toBe(
          400 + index,
        )
    }),
  )

  it.live("keeps cold requirements after unusable samples or damaged history", () =>
    Effect.gen(function* () {
      const directory = yield* temp
      const memory = ShellMemory.make(directory)
      for (const peakMb of [0, -1, Infinity, NaN])
        yield* memory.record({ command: "check", cwd: directory, peakMb, canLower: true, reserveMb: 2_048 })
      expect(yield* memory.requirement({ command: "check", cwd: directory, reserveMb: 2_048 })).toBe(2_048)
      yield* Effect.promise(() => writeFile(path.join(directory, "memory.json"), "invalid"))
      expect(
        yield* memory.requirement({ command: "check", cwd: directory, memoryLimitMb: 6_144, reserveMb: 2_048 }),
      ).toBe(6_144)
      yield* Effect.promise(() =>
        writeFile(path.join(directory, "memory.json.11111111-1111-4111-8111-111111111111.tmp"), "interrupted"),
      )
      yield* memory.record({ command: "check", cwd: directory, peakMb: 100, canLower: true, reserveMb: 2_048 })
      expect(yield* Effect.promise(() => readdir(directory))).toEqual(["memory.json", "memory.lock"])
    }),
  )
})
