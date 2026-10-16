import { expect } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Exit, Fiber, Layer, PlatformError, Scope } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { AppProcess } from "@ycoding-ai/core/process"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Config } from "@ycoding-ai/core/config"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Shell } from "@ycoding-ai/core/shell"
import { Database } from "@ycoding-ai/core/database/database"
import { ShellQueue } from "@ycoding-ai/core/shell/queue"
import { ShellSandbox } from "@ycoding-ai/core/shell-sandbox"
import { ShellTable } from "@ycoding-ai/core/shell/sql"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { location } from "./fixture/location"
import { cleanGroup, escapedProcess, fileReady, groupAlive, groupGone, shellProcess } from "./fixture/shell-process"
import { testEffect } from "./lib/effect"

class Fixture extends Context.Service<
  Fixture,
  {
    readonly directory: string
    readonly spawning: {
      ready?: string
      deny?: boolean
      kills: number
      killed?: Deferred.Deferred<void>
      hook?: (pid: number) => Effect.Effect<void>
    }
  }
>()("ShellKillFixture") {}

const fixture = Layer.effect(
  Fixture,
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "ycoding-shell-kill-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ).pipe(Effect.map((directory) => ({ directory, spawning: { kills: 0 } }))),
)

const config = Layer.succeed(
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
)

const it = testEffect(
  Layer.unwrap(
    Effect.gen(function* () {
      const { directory, spawning } = yield* Fixture
      return AppNodeBuilder.build(
        LayerNode.group([
          Shell.node,
          AppProcess.node,
          Location.node,
          EventRuntime.node,
          Global.node,
          Database.node,
          ShellQueue.node,
          ShellSandbox.node,
        ]),
        [
          [
            AppProcess.node,
            Layer.effect(
              AppProcess.Service,
              Effect.gen(function* () {
                const real = yield* AppProcess.Service
                return AppProcess.Service.of({
                  ...real,
                  spawn: (command) =>
                    real
                      .spawn(command)
                      .pipe(
                        Effect.tap(() => (spawning.ready ? fileReady(spawning.ready) : Effect.void)),
                        Effect.tap((handle) => (spawning.hook ? spawning.hook(Number(handle.pid)) : Effect.void)),
                        Effect.map((handle) =>
                          ChildProcessSpawner.makeHandle({
                            ...handle,
                            kill: (options) =>
                              spawning.deny
                                ? Effect.fail(
                                    PlatformError.systemError({
                                      _tag: "PermissionDenied",
                                      module: "ChildProcess",
                                      method: "kill",
                                      cause: new Error("EPERM"),
                                    }),
                                  )
                                : handle.kill(options).pipe(
                                    Effect.tap(() =>
                                      Effect.suspend(() => {
                                        spawning.kills++
                                        return spawning.killed
                                          ? Deferred.succeed(spawning.killed, undefined)
                                          : Effect.void
                                      }),
                                    ),
                                  ),
                          }),
                        ),
                      )
                      .pipe(Effect.uninterruptible),
                })
              }),
            ).pipe(Layer.provide(AppNodeBuilder.build(AppProcess.node))),
          ],
          [Config.node, config],
          [Global.node, Global.layerWith({ data: join(directory, "data"), state: join(directory, "state") })],
          [
            Location.node,
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
          ],
        ],
      )
    }),
  ).pipe(Layer.provideMerge(fixture)),
)

const posix = process.platform === "win32" ? it.live.skip : it.live

for (const action of ["remove", "teardown"] as const) {
  posix(
    `${action} settles when an escaped descendant holds the capture pipe open`,
    () =>
      Effect.gen(function* () {
        const { directory } = yield* Fixture
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(Shell.layer().pipe(Layer.provide(config)), scope)
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const shell = Context.get(context, Shell.Service)
        const command = escapedProcess(directory)
        const info = yield* shell.create(yield* shell.prepare({ command: command.command, timeout: 0 }))
        const escaped = Number(yield* fileReady(command.ready))
        const stop = yield* (action === "remove" ? shell.remove(info.id) : Scope.close(scope, Exit.void)).pipe(
          Effect.forkDetach({ startImmediately: true }),
        )
        yield* Effect.addFinalizer(() => cleanGroup(escaped).pipe(Effect.andThen(Fiber.await(stop)), Effect.asVoid))
        yield* Effect.addFinalizer(() => cleanGroup(info.pid!))
        yield* Fiber.join(stop).pipe(Effect.timeout(5_000))
        expect(groupAlive(info.pid!)).toBe(false)
        expect(groupAlive(escaped)).toBe(true)
      }),
    15_000,
  )
}

for (const leader of ["running", "exited"] as const) {
  posix(
    `timeout bounds capture while an escaped descendant keeps writing after the leader is ${leader}`,
    () =>
      Effect.gen(function* () {
        const { directory, spawning } = yield* Fixture
        const shell = yield* Shell.Service
        const command = escapedProcess(directory, { writing: true, leaderExits: leader === "exited" })
        spawning.killed = yield* Deferred.make<void>()
        const info = yield* shell.create(yield* shell.prepare({ command: command.command, timeout: 0 }))
        yield* Effect.addFinalizer(() => cleanGroup(info.pid!))
        const escaped = Number(yield* fileReady(command.ready))
        yield* Effect.addFinalizer(() => cleanGroup(escaped))
        // A normal exit has already killed the leader's group and started its unbounded drain.
        if (leader === "exited") yield* Deferred.await(spawning.killed).pipe(Effect.timeout(5_000))
        yield* shell.timeout(info.id, 1)
        const result = yield* shell.wait(info.id).pipe(Effect.timeout(4_000))
        expect(result).toMatchObject(leader === "exited" ? { status: "exited", exit: 0 } : { status: "timeout" })
        expect(spawning.kills).toBe(1)
        expect(groupAlive(info.pid!)).toBe(false)
        expect(groupAlive(escaped)).toBe(true)
        expect((yield* shell.output(info.id, { limit: 0 })).size).toBeGreaterThan(0)
      }),
    15_000,
  )
}

posix(
  "EPERM keeps a running shell and its waiters from reporting successful cancellation",
  () =>
    Effect.gen(function* () {
      const fixture = yield* Fixture
      const shell = yield* Shell.Service
      const events = yield* EventRuntime.Service
      const db = (yield* Database.Service).db
      const info = yield* shell.create(yield* shell.prepare({ command: "sleep 60", timeout: 0 }))
      yield* Effect.addFinalizer(() => cleanGroup(info.pid!))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fixture.spawning.deny = false
        }),
      )
      const seen: string[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          if (["shell.deleted", "shell.exited"].includes(event.type)) seen.push(event.type)
        }),
      )
      const waiting = yield* shell.wait(info.id).pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
      fixture.spawning.deny = true
      const removed = yield* shell.remove(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(removed)).toBe(true)
      expect(groupAlive(info.pid!)).toBe(true)
      expect((yield* shell.get(info.id)).status).toBe("running")
      expect(yield* Effect.promise(() => Bun.file(info.file).exists())).toBe(true)
      expect((yield* db.select().from(ShellTable).all()).some((row) => row.id === info.id)).toBe(true)
      expect(seen).toEqual([])
      expect(Exit.isFailure(yield* Fiber.join(waiting).pipe(Effect.timeout(1_000)))).toBe(true)
      fixture.spawning.deny = false
      yield* shell.remove(info.id)
    }),
  15_000,
)

for (const reason of ["timeout", "memory-limit"] as const) {
  posix(
    `EPERM from ${reason} fails waiters without discarding the live process`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* Fixture
        const shell = yield* Shell.Service
        const command = shellProcess(fixture.directory, true)
        fixture.spawning.ready = command.ready
        const info = yield* shell.create(
          yield* shell.prepare({
            command: command.command,
            timeout: 0,
            memoryLimitMb: reason === "memory-limit" ? 96 : undefined,
          }),
        )
        yield* Effect.addFinalizer(() => cleanGroup(info.pid!))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            fixture.spawning.deny = false
          }),
        )
        const waiting = yield* shell.wait(info.id).pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
        fixture.spawning.deny = true
        if (reason === "timeout") yield* shell.timeout(info.id, 1)
        if (reason === "memory-limit") yield* Effect.promise(() => writeFile(command.allocate, "allocate"))
        expect(Exit.isFailure(yield* Fiber.join(waiting).pipe(Effect.timeout(5_000)))).toBe(true)
        expect((yield* shell.get(info.id)).status).toBe("running")
        expect(groupAlive(info.pid!)).toBe(true)
        fixture.spawning.deny = false
        yield* shell.remove(info.id)
      }),
    15_000,
  )
}

posix(
  "EPERM during queued spawn cancellation retains the started process",
  () =>
    Effect.gen(function* () {
      const fixture = yield* Fixture
      const shell = yield* Shell.Service
      const admitted = yield* Deferred.make<Effect.Success<ReturnType<typeof shell.create>>>()
      const removed = yield* Deferred.make<Exit.Exit<void, Shell.NotFoundError>>()
      const spawned = { pid: 0 }
      yield* Effect.addFinalizer(() => (spawned.pid ? cleanGroup(spawned.pid) : Effect.void))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fixture.spawning.deny = false
        }),
      )
      fixture.spawning.hook = (pid) =>
        Effect.gen(function* () {
          spawned.pid = pid
          const info = yield* Deferred.await(admitted)
          fixture.spawning.deny = true
          yield* shell.remove(info.id).pipe(
            Effect.exit,
            Effect.flatMap((exit) => Deferred.succeed(removed, exit)),
            Effect.forkDetach({ startImmediately: true }),
          )
        })
      const info = yield* shell.enqueue(
        yield* shell.prepare({ command: "sleep 60", timeout: 0 }),
        SessionSchema.ID.make("ses_queued_eperm"),
      )
      yield* Deferred.succeed(admitted, info)
      expect(Exit.isFailure(yield* Deferred.await(removed).pipe(Effect.timeout(5_000)))).toBe(true)
      expect((yield* shell.get(info.id)).status).toBe("running")
      expect(groupAlive(spawned.pid)).toBe(true)
      fixture.spawning.deny = false
      yield* shell.remove(info.id)
    }),
  15_000,
)

for (const reason of ["remove", "timeout", "memory-limit", "output-failure", "teardown"] as const) {
  posix(
    `settles ${reason} and removes a SIGTERM-resistant process group`,
    () =>
      Effect.gen(function* () {
        const { directory, spawning } = yield* Fixture
        const placement = yield* Location.Service
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(
          Shell.layer().pipe(Layer.provide(Layer.merge(config, Layer.succeed(Location.Service, placement)))),
          scope,
        )
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const shell = Context.get(context, Shell.Service)
        const command = shellProcess(directory, reason !== "remove")
        const events = yield* EventRuntime.Service
        const seen: string[] = []
        const deleted = yield* Deferred.make<void>()
        yield* events.listen((event) =>
          Effect.gen(function* () {
            if (!["shell.exited", "shell.deleted"].includes(event.type)) return
            seen.push(event.type)
            if (event.type === "shell.deleted") yield* Deferred.succeed(deleted, undefined)
          }),
        )
        const outputDir = join(directory, "data", "shell", placement.project.id)
        if (reason === "output-failure") {
          yield* Effect.promise(() => rm(outputDir, { recursive: true }))
          yield* Effect.promise(() => writeFile(outputDir, "not a directory"))
        }
        spawning.ready = command.ready
        const prepared = yield* shell.prepare({
          command: command.command,
          timeout: 0,
          memoryLimitMb: reason === "memory-limit" ? 96 : undefined,
        })
        const info = yield* shell.create(prepared)
        const pid = info.pid!
        yield* Effect.addFinalizer(() => cleanGroup(pid))
        yield* fileReady(command.ready)
        const waited = yield* shell.wait(info.id).pipe(Effect.forkScoped({ startImmediately: true }))
        if (reason === "remove") yield* shell.remove(info.id)
        if (reason === "timeout") yield* shell.timeout(info.id, 1)
        if (reason === "memory-limit") yield* Effect.promise(() => writeFile(command.allocate, "allocate"))
        if (reason === "teardown") yield* Scope.close(scope, Exit.void)
        const result = yield* Fiber.join(waited).pipe(Effect.timeout(6_000))
        expect(result.status).toBe(
          reason === "remove" || reason === "teardown" || reason === "output-failure" ? "killed" : reason,
        )
        yield* groupGone(pid)
        expect(groupAlive(pid)).toBe(false)
        expect(yield* fileReady(command.term)).toBe("term")
        expect(yield* fileReady(command.childTerm)).toBe("term")
        if (reason === "remove") {
          yield* Deferred.await(deleted).pipe(Effect.timeout(1_000))
          expect(seen).toEqual(["shell.deleted"])
          expect(yield* Effect.promise(() => Bun.file(info.file).exists())).toBe(false)
        }
      }),
    15_000,
  )
}

posix(
  "removed commands never publish exit or block retention eviction",
  () =>
    Effect.gen(function* () {
      const shell = yield* Shell.Service
      const events = yield* EventRuntime.Service
      const seen: string[] = []
      const info = yield* shell.create(
        yield* shell.prepare({ command: "trap 'exit 0' TERM; printf ready; while :; do sleep 0.02; done", timeout: 0 }),
      )
      yield* Effect.addFinalizer(() => cleanGroup(info.pid!))
      yield* Effect.gen(function* () {
        while (!(yield* shell.output(info.id)).output.includes("ready")) yield* Effect.sleep(10)
      }).pipe(Effect.timeout(2_000))
      yield* events.listen((event) =>
        Effect.sync(() => {
          if (
            (event.type === "shell.deleted" || event.type === "shell.exited") &&
            typeof event.data === "object" &&
            event.data !== null &&
            "id" in event.data &&
            event.data.id === info.id
          )
            seen.push(event.type)
        }),
      )
      yield* shell.remove(info.id)
      yield* groupGone(info.pid!)
      expect(seen).toEqual(["shell.deleted"])
      const evicted = yield* Deferred.make<void>()
      const retained: string[] = []
      const removals: string[] = []
      yield* events.listen((event) =>
        Effect.gen(function* () {
          if (
            event.type !== "shell.deleted" ||
            typeof event.data !== "object" ||
            event.data === null ||
            !("id" in event.data) ||
            typeof event.data.id !== "string"
          )
            return
          removals.push(event.data.id)
          if (removals.length === 2) yield* Deferred.succeed(evicted, undefined)
        }),
      )
      for (let index = 0; index < 27; index++) {
        const next = yield* shell.create(yield* shell.prepare({ command: "true", timeout: 0 }))
        retained.push(next.id)
        expect((yield* shell.wait(next.id).pipe(Effect.timeout(2_000))).status).toBe("exited")
      }
      yield* Deferred.await(evicted).pipe(Effect.timeout(2_000))
      expect(removals).toEqual(retained.slice(0, 2))
      expect(seen).toEqual(["shell.deleted"])
    }),
  15_000,
)
