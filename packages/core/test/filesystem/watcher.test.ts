import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Deferred, Duration, Effect, Fiber, Layer, Option, PubSub, Queue, Schedule, Stream } from "effect"
import { Config } from "@ycoding-ai/core/config"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { LocationWatcher } from "@ycoding-ai/core/filesystem/location-watcher"
import { Watcher } from "@ycoding-ai/core/filesystem/watcher"
import { FileSystem } from "@ycoding-ai/schema/filesystem"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const describeWatcher = Watcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, EventRuntime.node])))

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({ diagnostics: () => Effect.succeed([]),
    reload: () => Effect.void,
    entries: () => Effect.succeed([]),
  }),
)

function provide(directory: string, vcs?: Location.Interface["vcs"], watcher?: Layer.Layer<Watcher.Service>) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { vcs })),
  )
  return Effect.provide(
    AppNodeBuilder.build(LocationWatcher.node, [
      [Config.node, configLayer],
      [Location.node, locationLayer],
      ...(watcher ? [[Watcher.node, watcher] as const] : []),
    ]),
  )
}

function withTmp<A, E, R>(
  f: (directory: string, vcs?: Location.Interface["vcs"]) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; init?: (directory: string) => Promise<void> },
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const tmp = await tmpdir()
      if (!options?.git) return { tmp, vcs: undefined }
      await $`git init`.cwd(tmp.path).quiet()
      await $`git config core.fsmonitor false`.cwd(tmp.path).quiet()
      await $`git config commit.gpgsign false`.cwd(tmp.path).quiet()
      await $`git config user.email test@ycoding.test`.cwd(tmp.path).quiet()
      await $`git config user.name Test`.cwd(tmp.path).quiet()
      await $`git commit --allow-empty -m root`.cwd(tmp.path).quiet()
      await options.init?.(tmp.path)
      return { tmp, vcs: { type: "git" as const, store: AbsolutePath.make(path.join(tmp.path, ".git")) } }
    }),
    ({ tmp }) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap(({ tmp, vcs }) => f(tmp.path, vcs).pipe(provide(tmp.path, vcs))))
}

function wait(check: (event: WatcherEvent) => boolean) {
  return Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const deferred = yield* Deferred.make<WatcherEvent>()
    const fiber = yield* events.subscribe(FileSystem.Event.Changed).pipe(
      Stream.runForEach((event) => {
        if (!check(event.data)) return Effect.void
        return Deferred.succeed(deferred, event.data).pipe(Effect.asVoid)
      }),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    return { deferred, fiber }
  })
}

function maybeNextUpdate<E>(
  check: (event: WatcherEvent) => boolean,
  trigger: Effect.Effect<void, E>,
  timeout: Duration.Input = "5 seconds",
) {
  return Effect.acquireUseRelease(
    wait(check),
    ({ deferred }) => trigger.pipe(Effect.andThen(Deferred.await(deferred)), Effect.timeoutOption(timeout)),
    ({ fiber }) => Fiber.interrupt(fiber),
  )
}

function nextUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>) {
  return Effect.gen(function* () {
    const result = yield* maybeNextUpdate(check, trigger)
    if (Option.isSome(result)) return result.value
    return yield* Effect.fail(new Error("timed out waiting for file watcher update"))
  })
}

function eventuallyUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: () => Effect.Effect<void, E>) {
  return Effect.gen(function* () {
    while (true) {
      const result = yield* maybeNextUpdate(check, trigger(), "250 millis")
      if (Option.isSome(result)) return result.value
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for file watcher readiness")),
    }),
  )
}

function noUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>, timeout = 500) {
  return Effect.acquireUseRelease(
    wait(check),
    ({ deferred }) =>
      trigger.pipe(
        Effect.andThen(Deferred.await(deferred)),
        Effect.timeoutOption(`${timeout} millis`),
        Effect.tap((result) => Effect.sync(() => expect(result).toEqual(Option.none()))),
      ),
    ({ fiber }) => Fiber.interrupt(fiber),
  )
}

it.live("publishes create, update, and delete changes through the recursive fallback", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const fs = yield* FSUtil.Service
    const watcher = yield* Watcher.Service
    const existing = path.join(tmp.path, "existing.txt")
    const created = path.join(tmp.path, "created.txt")
    yield* fs.writeFileString(existing, "before")

    const sentinel = path.join(tmp.path, ".watcher-ready")
    const next = <E>(file: string, type: Watcher.Update["type"], trigger: Effect.Effect<void, E>) =>
      Effect.gen(function* () {
        const updates = yield* Queue.unbounded<Watcher.Update>()
        yield* watcher
          .subscribe({ path: tmp.path, type: "directory" })
          .pipe(
            Stream.runForEach((event) => Queue.offer(updates, event)),
            Effect.forkScoped({ startImmediately: true }),
          )
        const take = (matches: (event: Watcher.Update) => boolean): Effect.Effect<Watcher.Update> =>
          Queue.take(updates).pipe(Effect.flatMap((event) => (matches(event) ? Effect.succeed(event) : take(matches))))
        const ready: Effect.Effect<Watcher.Update, unknown> = fs
          .writeFileString(sentinel, `ready-${Math.random()}`)
          .pipe(
            Effect.andThen(take((event) => event.path === sentinel).pipe(Effect.timeoutOption("250 millis"))),
            Effect.flatMap(Option.match({ onNone: () => ready, onSome: Effect.succeed })),
          )
        yield* ready
        yield* trigger
        return yield* take((event) => event.path === file && event.type === type).pipe(Effect.timeout("5 seconds"))
      })

    expect(yield* next(existing, "update", fs.writeFileString(existing, "after"))).toEqual({
      path: existing,
      type: "update",
    })
    expect(yield* next(existing, "delete", fs.remove(existing))).toEqual({
      path: existing,
      type: "delete",
    })
    expect(yield* next(created, "create", fs.writeFileString(created, "created"))).toEqual({
      path: created,
      type: "create",
    })
  }).pipe(Effect.provide(AppNodeBuilder.build(Watcher.configured({ native: false })))),
)

function ready(directory: string) {
  const file = path.join(directory, `.watcher-${Math.random().toString(36).slice(2)}`)
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* eventuallyUpdate(
      (event) => event.file === file,
      () => fs.writeFileString(file, `ready-${Math.random()}`),
    ).pipe(Effect.ensuring(fs.remove(file, { force: true }).pipe(Effect.ignore)), Effect.asVoid)
  })
}

for (const interrupted of [false, true]) {
  it.live(
    interrupted
      ? "releases location subscriptions when initialization is interrupted"
      : "waits for root and Git subscriptions before exposing the location watcher",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(() => $`git init`.cwd(tmp.path).quiet())
        const root = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
          stopped: yield* Deferred.make<void>(),
          updates: yield* PubSub.unbounded<Watcher.Update>(),
        }
        const git = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
          stopped: yield* Deferred.make<void>(),
          updates: yield* PubSub.unbounded<Watcher.Update>(),
        }
        const available = yield* Deferred.make<void>()
        const close = yield* Deferred.make<void>()
        const watcher = Layer.succeed(
          Watcher.Service,
          Watcher.Service.of({
            subscribe: (input: Watcher.WatchInput, onReady?: Effect.Effect<void>) => {
              const state = input.path === tmp.path ? root : git
              return Stream.unwrap(
                Effect.gen(function* () {
                  yield* Deferred.succeed(state.started, undefined)
                  yield* Deferred.await(state.release)
                  const subscription = yield* PubSub.subscribe(state.updates)
                  yield* onReady ?? Effect.void
                  return Stream.fromSubscription(subscription)
                }),
              ).pipe(Stream.ensuring(Deferred.succeed(state.stopped, undefined)))
            },
          }),
        )
        const fiber = yield* Effect.gen(function* () {
          yield* LocationWatcher.Service
          yield* Deferred.succeed(available, undefined)
          yield* Deferred.await(close)
        }).pipe(
          provide(tmp.path, { type: "git", store: AbsolutePath.make(path.join(tmp.path, ".git")) }, watcher),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Deferred.await(root.started)
        expect(yield* Deferred.isDone(available)).toBe(false)
        yield* Deferred.succeed(root.release, undefined)
        yield* Deferred.await(git.started)
        expect(yield* Deferred.isDone(available)).toBe(false)

        if (interrupted) {
          yield* Fiber.interrupt(fiber)
          expect(yield* Deferred.isDone(available)).toBe(false)
          expect(yield* Deferred.isDone(root.stopped)).toBe(true)
          expect(yield* Deferred.isDone(git.stopped)).toBe(true)
          return
        }

        yield* Deferred.succeed(git.release, undefined)
        yield* Deferred.await(available)
        for (const [state, file] of [
          [root, path.join(tmp.path, "file.txt")],
          [git, path.join(tmp.path, ".git", "HEAD")],
        ] as const) {
          expect(
            yield* nextUpdate(
              (event) => event.file === file,
              PubSub.publish<Watcher.Update>(state.updates, { path: file, type: "update" }).pipe(Effect.asVoid),
            ),
          ).toEqual({ file, event: "change" })
        }
        yield* Deferred.succeed(close, undefined)
        yield* Fiber.join(fiber)
        expect(yield* Deferred.isDone(root.stopped)).toBe(true)
        expect(yield* Deferred.isDone(git.stopped)).toBe(true)
      }),
  )
}

for (const failed of [false, true]) {
  it.live(
    failed
      ? "settles location initialization when a subscription fails before readiness"
      : "settles location initialization when watching is disabled",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
        )
        yield* LocationWatcher.Service.pipe(
          provide(
            tmp.path,
            { type: "git", store: AbsolutePath.make(path.join(tmp.path, ".git")) },
            failed
              ? Layer.succeed(Watcher.Service, Watcher.Service.of({ subscribe: () => Stream.die("unavailable") }))
              : Watcher.layer({ enabled: false }),
          ),
        )
      }),
  )
}

describeWatcher("LocationWatcher", () => {
  it.live("limits file watches to the exact target", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const watcher = yield* Watcher.Service
        const target = path.join(directory, "ycoding.json")
        const sibling = path.join(directory, "other.json")
        const update = yield* watcher
          .subscribe({ path: target, type: "file" })
          .pipe(Stream.take(1), Stream.runHead, Effect.forkScoped({ startImmediately: true }))
        yield* fs.writeFileString(sibling, "sibling")
        const writes = yield* Effect.suspend(() => fs.writeFileString(target, `target-${Math.random()}`)).pipe(
          Effect.repeat(Schedule.spaced("10 millis")),
          Effect.forkScoped,
        )
        const event = yield* Fiber.join(update).pipe(Effect.ensuring(Fiber.interrupt(writes)))

        expect(event.valueOrUndefined?.path).toBe(target)
      }).pipe(Effect.provide(AppNodeBuilder.build(Watcher.node))),
    ),
  )

  it.live("publishes root create, update, and delete events", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const file = path.join(directory, "watch.txt")
          yield* ready(directory)
          for (const item of [
            { event: "add" as const, trigger: fs.writeFileString(file, "a") },
            { event: "change" as const, trigger: fs.writeFileString(file, "b") },
            { event: "unlink" as const, trigger: fs.remove(file) },
          ]) {
            expect(
              yield* nextUpdate((event) => event.file === file && event.event === item.event, item.trigger),
            ).toEqual({
              file,
              event: item.event,
            })
          }
        }),
      { git: true },
    ),
  )

  it.live("skips non-git roots", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const file = path.join(directory, "plain.txt")
        yield* noUpdate((event) => event.file === file, fs.writeFileString(file, "plain"))
      }),
    ),
  )

  it.live("ignores dependency, VCS, and build directories at any depth", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const afs = yield* FSUtil.Service
          yield* ready(directory)
          const roots = ["node_modules", ".git", "dist"].map((name) => path.join(directory, "nested", name))
          const files = roots.map((root) => path.join(root, "package", "index.js"))
          yield* noUpdate(
            (event) => roots.some((root) => event.file === root || event.file.startsWith(`${root}${path.sep}`)),
            Effect.forEach(files, (file) => afs.writeWithDirs(file, "ignored"), {
              concurrency: "unbounded",
              discard: true,
            }),
          )
        }),
      { git: true },
    ),
  )

  it.live("cleanup stops publishing events", () =>
    Effect.gen(function* () {
      const events = yield* EventRuntime.Service
      const fs = yield* FSUtil.Service
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* ready(tmp.path).pipe(
        provide(tmp.path, { type: "git", store: AbsolutePath.make(path.join(tmp.path, ".git")) }),
        Effect.scoped,
      )
      const file = path.join(tmp.path, "after-dispose.txt")
      yield* noUpdate((event) => event.file === file, fs.writeFileString(file, "gone")).pipe(
        Effect.provideService(EventRuntime.Service, events),
      )
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([FSUtil.node, EventRuntime.node])))),
  )

  it.live("ignores .git/index changes", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const index = path.join(directory, ".git", "index")
          yield* ready(directory)
          yield* noUpdate(
            (event) => event.file === index,
            fs
              .writeFileString(path.join(directory, "tracked.txt"), "a")
              .pipe(Effect.andThen(Effect.promise(() => $`git add .`.cwd(directory).quiet())), Effect.asVoid),
          )
        }),
      { git: true },
    ),
  )

  it.live("publishes .git/HEAD events", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const head = path.join(directory, ".git", "HEAD")
          const branch = `watch-${Math.random().toString(36).slice(2)}`
          yield* ready(directory)
          yield* Effect.promise(() => $`git branch ${branch}`.cwd(directory).quiet())
          expect(
            yield* nextUpdate((event) => event.file === head, fs.writeFileString(head, `ref: refs/heads/${branch}\n`)),
          ).toMatchObject({ file: head })
        }),
      { git: true },
    ),
  )

  const describeSymlink = process.platform !== "win32" ? describe : describe.skip
  describeSymlink("symlinked .git", () => {
    it.live("publishes .git/HEAD events through a symlinked .git directory", () =>
      withTmp(
        (directory) =>
          Effect.gen(function* () {
            const afs = yield* FSUtil.Service
            const actual = path.join(directory, "..", `actual_${path.basename(directory)}`)
            yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(actual, { recursive: true, force: true })))
            yield* ready(directory)
            const head = path.join(directory, ".git", "HEAD")
            const branch = `watch-${Math.random().toString(36).slice(2)}`
            yield* Effect.promise(() => $`git branch ${branch}`.cwd(directory).quiet())
            expect(
              yield* nextUpdate(
                (event) => event.file === path.join(actual, "HEAD"),
                afs.writeFileString(head, `ref: refs/heads/${branch}\n`),
              ),
            ).toEqual({ file: path.join(actual, "HEAD"), event: "change" })
          }),
        {
          git: true,
          init: async (directory) => {
            const actual = path.join(directory, "..", `actual_${path.basename(directory)}`)
            await fs.rename(path.join(directory, ".git"), actual)
            await fs.symlink(actual, path.join(directory, ".git"))
          },
        },
      ),
    )
  })
})
