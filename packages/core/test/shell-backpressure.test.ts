import { afterAll, afterEach, describe, expect, mock } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { AppProcess } from "@ycoding-ai/core/process"
import { Config } from "@ycoding-ai/core/config"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Shell } from "@ycoding-ai/core/shell"
import { Deferred, Effect, Fiber, Layer, Logger, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const fsModule = await import("node:fs")
const realCreateWriteStream = fsModule.createWriteStream
const workspace = await mkdtemp(join(tmpdir(), "ycoding-shell-backpressure-"))
afterAll(() => rm(workspace, { recursive: true, force: true }))
afterAll(() => mock.module("fs", () => ({ ...fsModule, createWriteStream: realCreateWriteStream })))

const chunks = Array.from({ length: 128 }, (_, index) => Buffer.alloc(4096, index))
let sink: Writable | undefined
let release: (() => void) | undefined
let maximumBufferedBytes = 0
let produced = 0
let failWrite = false
let kills = 0
let controlled = false
const warnings: unknown[] = []

afterEach(() => {
  controlled = false
  release?.()
  release = undefined
  sink?.destroy()
  sink = undefined
})

await mock.module("fs", () => ({
  ...fsModule,
  createWriteStream: (...args: Parameters<typeof realCreateWriteStream>) => {
    if (!controlled) return realCreateWriteStream(...args)
    const file = realCreateWriteStream(...args)
    const writable = new Writable({
      highWaterMark: 1024,
      write(chunk: Buffer, _encoding, callback) {
        maximumBufferedBytes = Math.max(maximumBufferedBytes, writable.writableLength)
        if (failWrite) return callback(new Error("synthetic capture failure"))
        if (release === undefined) {
          release = () => {
            release = () => {}
            file.write(chunk, callback)
          }
          return
        }
        file.write(chunk, callback)
      },
      final(callback) {
        file.end(callback)
      },
      destroy(error, callback) {
        file.destroy()
        callback(error)
      },
    })
    file.once("open", () => writable.emit("open"))
    file.on("error", (error) => writable.destroy(error))
    sink = writable
    return writable
  },
}))

const processes = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>()
    const source = Stream.fromIterable(chunks).pipe(
      Stream.tap(() => Effect.sync(() => produced++)),
      Stream.concat(Stream.fromEffect(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))).pipe(Stream.drain)),
    )
    return AppProcess.Service.of({
      ...ChildProcessSpawner.make(() =>
        Effect.acquireRelease(
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(2_000_000_000),
              all: source,
              stdout: source,
              stderr: Stream.empty,
              stdin: Sink.drain,
              exitCode: Deferred.await(exited),
              isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
              kill: () =>
                Effect.sync(() => kills++).pipe(
                  Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
                  Effect.asVoid,
                ),
              unref: Effect.succeed(Effect.void),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
          (handle) => handle.kill().pipe(Effect.orDie),
        ),
      ),
      run: () =>
        Effect.succeed({
          command: "ps",
          exitCode: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      runStream: () => Stream.empty,
    })
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Shell.node]), [
    [AppProcess.node, processes],
    [Global.node, Global.layerWith({ data: join(workspace, "data") })],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(workspace) }))),
    ],
    [
      Config.node,
      Layer.succeed(
        Config.Service,
        Config.Service.of({
          diagnostics: () => Effect.succeed([]),
          reload: () => Effect.void,
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: new Config.Info({ shell: "/bin/sh", shell_sandbox: "disabled" }),
              }),
            ]),
        }),
      ),
    ],
  ]).pipe(
    Layer.provide(
      Logger.layer([Logger.make((options) => warnings.push(options.message))], { mergeWithExisting: false }),
    ),
  ),
)

describe("Shell capture backpressure", () => {
  it.live("bounds pending writes at one source chunk and preserves every byte in order", () =>
    Effect.gen(function* () {
      controlled = true
      produced = 0
      maximumBufferedBytes = 0
      failWrite = false
      const shell = yield* Shell.Service
      const info = yield* shell.create(yield* shell.prepare({ command: "synthetic output", timeout: 0 }))
      expect(produced).toBe(1)
      expect(sink?.writableLength).toBe(chunks[0].length)
      const waiting = yield* shell.wait(info.id).pipe(Effect.forkScoped)
      expect(waiting.pollUnsafe()).toBeUndefined()
      release?.()
      expect((yield* Fiber.join(waiting)).status).toBe("exited")
      expect(maximumBufferedBytes).toBeLessThanOrEqual(chunks[0].length)
      expect(yield* Effect.promise(() => readFile(info.file))).toEqual(Buffer.concat(chunks))
      expect((yield* shell.output(info.id, { limit: 0 })).size).toBe(Buffer.concat(chunks).length)
    }),
  )

  it.live("settles command completion when the capture sink fails", () =>
    Effect.gen(function* () {
      controlled = true
      produced = 0
      maximumBufferedBytes = 0
      failWrite = true
      kills = 0
      warnings.length = 0
      const shell = yield* Shell.Service
      const info = yield* shell.create(yield* shell.prepare({ command: "synthetic failed capture", timeout: 0 }))
      expect((yield* shell.wait(info.id).pipe(Effect.timeout("2 seconds"))).status).toBe("exited")
      expect(sink?.destroyed).toBe(true)
      expect(kills).toBeGreaterThan(0)
      expect(warnings.some((message) => Array.isArray(message) && message[0] === "Shell output capture failed")).toBe(
        true,
      )
    }),
  )

  it.live("releases a held capture write when its command is removed", () =>
    Effect.gen(function* () {
      controlled = true
      produced = 0
      maximumBufferedBytes = 0
      failWrite = false
      kills = 0
      const shell = yield* Shell.Service
      const info = yield* shell.create(yield* shell.prepare({ command: "synthetic held capture", timeout: 0 }))
      const closed = new Promise<void>((resolve) => sink?.once("close", () => resolve()))
      yield* shell.remove(info.id)
      yield* Effect.promise(() => closed).pipe(Effect.timeout("2 seconds"))
      expect(sink?.destroyed).toBe(true)
      expect(kills).toBeGreaterThan(0)
      expect(produced).toBe(1)
    }),
  )
})
