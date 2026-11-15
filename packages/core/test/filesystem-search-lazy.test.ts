import { afterEach, expect, spyOn, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Scope } from "effect"
import { FileSystem } from "../src/filesystem"
import { FileSystemSearch } from "../src/filesystem/search"
import { Fff } from "../src/filesystem/fff.bun"
import { FSUtil } from "../src/fs-util"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { Ripgrep } from "../src/ripgrep"
import { AbsolutePath, RelativePath } from "../src/schema"
import { location } from "./fixture/location"

const ref = Location.Ref.make({ directory: AbsolutePath.make("/synthetic/search") })
const locationLayer = Layer.succeed(Location.Service, location(ref))
const restored: Array<() => void> = []
afterEach(() => restored.splice(0).forEach((restore) => restore()))

const initializationLogs = () => {
  const records: unknown[] = []
  const layer = Logger.layer(
    [
      Logger.make(({ message }) => {
        if (Array.isArray(message) && message[0] === "filesystem search initialized") records.push(message[1])
      }),
    ],
    { mergeWithExisting: false },
  )
  return { records, layer }
}

test("search initialization telemetry contains scalar deltas and no query for each backend", async () => {
  for (const backend of ["fff", "ripgrep"] as const) {
    const { create } = native()
    const capture = initializationLogs()
    const memory = spyOn(process, "memoryUsage")
      .mockReturnValueOnce({ rss: 1000, heapTotal: 200, heapUsed: 100, external: 300, arrayBuffers: 50 })
      .mockReturnValue({ rss: 1400, heapTotal: 250, heapUsed: 160, external: 350, arrayBuffers: 60 })
    restored.push(() => memory.mockRestore())
    const rows = ["src/main.ts", "src/lib/util.ts"].map((path) =>
      FileSystem.Entry.make({ path: RelativePath.make(path), type: "file" }),
    )
    const layer =
      backend === "fff"
        ? FileSystemSearch.fffLayer.pipe(Layer.provide(locationLayer))
        : FileSystemSearch.ripgrepLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                locationLayer,
                LayerNode.compile(FSUtil.node),
                Layer.succeed(Ripgrep.Service, {
                  find: (input) =>
                    Effect.forEach(rows, (row) => input.onEntry?.(row) ?? Effect.void).pipe(Effect.as(rows)),
                  glob: () => Effect.succeed([]),
                  grep: () => Effect.succeed([]),
                }),
              ),
            ),
          )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const search = Context.get(yield* Layer.buildWithScope(layer, yield* Scope.Scope), FileSystemSearch.Service)
          expect(capture.records).toEqual([])
          yield* search.find({ query: "private-query-token", type: "file" })
          yield* search.find({ query: "another-private-token", type: "directory" })
          expect(capture.records).toHaveLength(1)
          expect(capture.records[0]).toMatchObject({
            backend,
            directory: ref.directory,
            durationMs: expect.any(Number),
            rssBytes: 1400,
            rssDeltaBytes: 400,
            heapUsedDeltaBytes: 60,
            nativeGapBytes: 800,
          })
          if (backend === "ripgrep") expect(capture.records[0]).toMatchObject({ files: 2, directories: 2 })
          expect(JSON.stringify(capture.records)).not.toContain("private")
        }),
      ).pipe(Effect.provide(capture.layer)),
    )
    create.mockRestore()
    memory.mockRestore()
  }
})

test("interrupting the first native caller cannot poison later picker users", async () => {
  const { calls, picker, create } = native()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const search = yield* buildNative(yield* Scope.Scope)
        let caller: Fiber.Fiber<unknown, unknown> | undefined
        create.mockImplementation(() => {
          calls.create++
          if (caller) Effect.runFork(Fiber.interrupt(caller))
          return { ok: true, value: picker }
        })
        caller = yield* search.find({ query: "main", type: "file" }).pipe(Effect.forkChild({ startImmediately: false }))
        expect(Exit.isFailure(yield* Fiber.await(caller))).toBe(true)
        expect(yield* search.find({ query: "main", type: "file" })).toHaveLength(1)
        expect(calls.create).toBe(1)
      }),
    ),
  )
  expect(calls.destroy).toBe(1)
})

function native() {
  const calls = { create: 0, destroy: 0, queries: [] as string[] }
  const files: Fff.Search = {
    items: [
      {
        relativePath: "src/main.ts",
        fileName: "main.ts",
        size: 0,
        modified: 0,
        accessFrecencyScore: 0,
        modificationFrecencyScore: 0,
        totalFrecencyScore: 0,
        gitStatus: "clean",
      },
    ],
    scores: [],
    totalMatched: 1,
    totalFiles: 1,
  }
  const picker: Fff.Picker = {
    destroy: () => {
      calls.destroy++
    },
    isScanning: () => false,
    waitForScan: async () => ({ ok: true, value: true }),
    refreshGitStatus: () => ({ ok: true, value: 0 }),
    fileSearch: (query) => {
      calls.queries.push(query)
      return { ok: true, value: files }
    },
    directorySearch: () => ({ ok: true, value: { items: [], scores: [], totalMatched: 0, totalDirs: 0 } }),
    mixedSearch: () => ({ ok: true, value: { items: [], scores: [], totalMatched: 0, totalFiles: 0, totalDirs: 0 } }),
    glob: (query) => {
      calls.queries.push(query)
      return { ok: true, value: files }
    },
    grep: (query) => {
      calls.queries.push(query)
      return {
        ok: true,
        value: {
          items: [],
          totalMatched: 0,
          totalFilesSearched: 0,
          totalFiles: 0,
          filteredFileCount: 0,
          nextCursor: null,
        },
      }
    },
    trackQuery: () => ({ ok: true, value: true }),
    getHistoricalQuery: () => ({ ok: true, value: null }),
  }
  const create = spyOn(Fff, "create").mockImplementation(() => {
    calls.create++
    return { ok: true, value: picker }
  })
  restored.push(() => create.mockRestore())
  return { calls, picker, create }
}

const buildNative = (scope: Scope.Scope) =>
  Layer.buildWithScope(FileSystemSearch.fffLayer.pipe(Layer.provide(locationLayer)), scope).pipe(
    Effect.map((context) => Context.get(context, FileSystemSearch.Service)),
  )

test("unused native search closes without creating or destroying a picker", async () => {
  const { calls } = native()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* buildNative(yield* Scope.Scope)
        expect(calls.create).toBe(0)
      }),
    ),
  )
  expect(calls).toEqual({ create: 0, destroy: 0, queries: [] })
})

test("concurrent native first use creates one picker and Location close destroys it exactly once", async () => {
  const { calls } = native()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const search = yield* buildNative(yield* Scope.Scope)
        expect(calls.create).toBe(0)
        const found = yield* Effect.all(
          [
            search.find({ query: " main ", type: "file" }),
            search.glob({ pattern: "*.ts", path: RelativePath.make("src") }),
            search.grep({ pattern: "needle" }),
          ],
          { concurrency: "unbounded" },
        )
        expect(found[0]).toEqual([{ path: RelativePath.make("src/main.ts"), type: "file" }])
        expect(found[1]).toEqual([{ path: RelativePath.make("src/main.ts"), type: "file" }])
        expect(calls.create).toBe(1)
        expect(calls.destroy).toBe(0)
        expect(calls.queries.toSorted()).toEqual(["main", "needle", "src/*.ts"])
      }),
    ),
  )
  expect(calls.destroy).toBe(1)
})

for (const failure of ["result", "throw"] as const) {
  test(`native ${failure} initialization failure is shared and owns no picker`, async () => {
    const { calls, create } = native()
    const capture = initializationLogs()
    create.mockImplementation(() => {
      calls.create++
      if (failure === "throw") throw new Error("synthetic init failure")
      return { ok: false, error: "synthetic init failure" }
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const search = yield* buildNative(yield* Scope.Scope)
          expect(calls.create).toBe(0)
          expect(
            yield* Effect.all(
              [search.find({ query: "x" }), search.glob({ pattern: "*" }), search.grep({ pattern: "x" })],
              { concurrency: "unbounded" },
            ),
          ).toEqual([[], [], []])
          expect(calls.create).toBe(1)
        }),
      ).pipe(Effect.provide(capture.layer)),
    )
    expect(calls.destroy).toBe(0)
    expect(capture.records).toEqual([])
  })
}

test("closing the Location reentrantly during native initialization destroys the acquired picker once", async () => {
  const { calls, create, picker } = native()
  const capture = initializationLogs()
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const search = yield* buildNative(scope)
      let closing: Fiber.Fiber<void> | undefined
      create.mockImplementation(() => {
        calls.create++
        closing = Effect.runFork(Scope.close(scope, Exit.void))
        return { ok: true, value: picker }
      })
      const exit = yield* search.find({ query: "main", type: "file" }).pipe(Effect.exit)
      if (closing) yield* Fiber.join(closing)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls.create).toBe(1)
      expect(calls.destroy).toBe(1)
      expect(calls.queries).toEqual([])
      yield* Scope.close(scope, Exit.void)
      expect(calls.destroy).toBe(1)
    }).pipe(Effect.provide(capture.layer)),
  )
  expect(capture.records).toEqual([])
})

test("native query failures propagate without replacing or leaking the picker", async () => {
  const { calls, picker } = native()
  picker.glob = () => ({ ok: false, error: "synthetic query failure" })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const search = yield* buildNative(yield* Scope.Scope)
        expect(Exit.isFailure(yield* search.glob({ pattern: "*" }).pipe(Effect.exit))).toBe(true)
        expect(yield* search.find({ query: "main", type: "file" })).toHaveLength(1)
        expect(calls.create).toBe(1)
      }),
    ),
  )
  expect(calls.destroy).toBe(1)
})

test("a retained native search cannot initialize after its Location closes", async () => {
  const { calls } = native()
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const search = yield* buildNative(scope)
      yield* Scope.close(scope, Exit.void)
      expect(Exit.isFailure(yield* search.glob({ pattern: "*" }).pipe(Effect.exit))).toBe(true)
      expect(calls).toEqual({ create: 0, destroy: 0, queries: [] })
    }),
  )
})

test("Location close interrupts an in-flight ripgrep index and releases its scan once", async () => {
  const capture = initializationLogs()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        let released = 0
        let scans = 0
        const ripgrep = Layer.succeed(Ripgrep.Service, {
          find: () =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                scans++
              }),
              () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              () =>
                Effect.sync(() => {
                  released++
                }),
            ),
          glob: () => Effect.succeed([]),
          grep: () => Effect.succeed([]),
        })
        const scope = yield* Scope.make()
        const layer = FileSystemSearch.ripgrepLayer.pipe(
          Layer.provide(Layer.mergeAll(locationLayer, ripgrep, LayerNode.compile(FSUtil.node))),
        )
        const search = Context.get(yield* Layer.buildWithScope(layer, scope), FileSystemSearch.Service)
        const caller = yield* search.find({ query: "x" }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Scope.close(scope, Exit.void)
        expect(Exit.isFailure(yield* Fiber.await(caller))).toBe(true)
        expect(scans).toBe(1)
        expect(released).toBe(1)
      }),
    ).pipe(Effect.provide(capture.layer)),
  )
  expect(capture.records).toEqual([])
})

test("interrupting the first find caller preserves the shared ripgrep scan for later callers", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        let scans = 0
        const rows = ["src/main.ts", "src/lib/util.ts"].map((path) =>
          FileSystem.Entry.make({ path: RelativePath.make(path), type: "file" }),
        )
        const ripgrep = Layer.succeed(Ripgrep.Service, {
          find: (input) =>
            Effect.gen(function* () {
              scans++
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
              yield* Effect.forEach(rows, (row) => input.onEntry?.(row) ?? Effect.void)
              return rows
            }),
          glob: () => Effect.succeed([]),
          grep: () => Effect.succeed([]),
        })
        const layer = FileSystemSearch.ripgrepLayer.pipe(
          Layer.provide(Layer.mergeAll(locationLayer, ripgrep, LayerNode.compile(FSUtil.node))),
        )
        const search = Context.get(yield* Layer.buildWithScope(layer, yield* Scope.Scope), FileSystemSearch.Service)
        const first = yield* search.find({ query: "src", type: "file" }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(first)
        expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)
        const second = yield* search.find({ query: "src", type: "file" }).pipe(Effect.forkChild)
        yield* Deferred.succeed(gate, undefined)
        expect(yield* Fiber.join(second)).toEqual(rows)
        expect(yield* search.find({ query: "src", type: "directory" })).toEqual([
          { path: RelativePath.make("src/"), type: "directory" },
          { path: RelativePath.make("src/lib/"), type: "directory" },
        ])
        expect(scans).toBe(1)
      }),
    ),
  )
})

test("failed ripgrep indexing is shared without publishing partial find results", async () => {
  const capture = initializationLogs()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let scans = 0
        const ripgrep = Layer.succeed(Ripgrep.Service, {
          find: () =>
            Effect.suspend(() => {
              scans++
              return Effect.fail(new Ripgrep.Error({ message: "synthetic scan failure" }))
            }),
          glob: () => Effect.succeed([]),
          grep: () => Effect.succeed([]),
        })
        const layer = FileSystemSearch.ripgrepLayer.pipe(
          Layer.provide(Layer.mergeAll(locationLayer, ripgrep, LayerNode.compile(FSUtil.node))),
        )
        const search = Context.get(yield* Layer.buildWithScope(layer, yield* Scope.Scope), FileSystemSearch.Service)
        const exits = yield* Effect.all(
          [search.find({ query: "x" }).pipe(Effect.exit), search.find({ query: "y" }).pipe(Effect.exit)],
          { concurrency: "unbounded" },
        )
        expect(exits.every(Exit.isFailure)).toBe(true)
        expect(scans).toBe(1)
        expect(yield* search.glob({ pattern: "*", path: RelativePath.make("/tmp") })).toEqual([])
      }),
    ).pipe(Effect.provide(capture.layer)),
  )
  expect(capture.records).toEqual([])
})

test("ripgrep glob and grep never build the unused find index; concurrent find waits for one complete scan", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        let scans = 0
        const rows = ["src/main.ts", "src/lib/util.ts", "docs/guide.md"].map((path) =>
          FileSystem.Entry.make({ path: RelativePath.make(path), type: "file" }),
        )
        const ripgrep = Layer.succeed(Ripgrep.Service, {
          find: (input) =>
            Effect.gen(function* () {
              scans++
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
              yield* Effect.forEach(rows, (row) => input.onEntry?.(row) ?? Effect.void)
              return rows
            }),
          glob: () => Effect.succeed(rows.slice(0, 1)),
          grep: () => Effect.succeed([]),
        })
        const layer = FileSystemSearch.ripgrepLayer.pipe(
          Layer.provide(Layer.mergeAll(locationLayer, ripgrep, LayerNode.compile(FSUtil.node))),
        )
        const scope = yield* Scope.Scope
        const search = Context.get(yield* Layer.buildWithScope(layer, scope), FileSystemSearch.Service)
        expect(scans).toBe(0)
        expect(yield* search.glob({ pattern: "*.ts", path: RelativePath.make("/tmp") })).toEqual([
          { path: RelativePath.make("../../tmp/src/main.ts"), type: "file" },
        ])
        expect(yield* search.grep({ pattern: "needle", path: RelativePath.make("/tmp") })).toEqual([])
        expect(scans).toBe(0)
        const first = yield* search.find({ query: "src", type: "file" }).pipe(Effect.forkChild)
        const second = yield* search.find({ query: "src", type: "directory" }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        expect(scans).toBe(1)
        yield* Deferred.succeed(gate, undefined)
        expect((yield* Fiber.join(first)).map((entry) => entry.path)).toEqual(
          rows.slice(0, 2).map((entry) => entry.path),
        )
        expect((yield* Fiber.join(second)).map((entry) => entry.path)).toEqual([
          RelativePath.make("src/"),
          RelativePath.make("src/lib/"),
        ])
        expect(yield* search.find({ query: "" })).toEqual([])
        expect(yield* search.find({ query: "util", limit: 1 })).toEqual([
          { path: RelativePath.make("src/lib/util.ts"), type: "file" },
        ])
        expect(scans).toBe(1)
      }),
    ),
  )
})
