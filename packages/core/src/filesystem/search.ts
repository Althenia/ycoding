export * as FileSystemSearch from "./search"

import { makeLocationNode } from "../effect/app-node"
import path from "path"
import { Clock, Context, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { Fff } from "#fff"
import fuzzysort from "fuzzysort"
import { FileSystem } from "../filesystem"
import { MemoryTelemetry } from "../observability/memory-telemetry"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"

export interface Interface {
  readonly find: (input: FileSystem.FindInput) => Effect.Effect<FileSystem.Entry[]>
  readonly glob: (input: FileSystem.GlobInput) => Effect.Effect<readonly FileSystem.Entry[]>
  readonly grep: (input: FileSystem.GrepInput) => Effect.Effect<readonly FileSystem.Match[]>
}

export const Options = Schema.Struct({
  fff: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@ycoding/FileSystem/Search") {}

export const ripgrepLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const ripgrep = yield* Ripgrep.Service
    const scope = yield* Scope.Scope
    const index = yield* Effect.cached(
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const before = MemoryTelemetry.sample()
        const files: string[] = []
        const directories = new Set<string>()
        yield* ripgrep
          .find({
            cwd: location.directory,
            pattern: "*",
            limit: location.vcs ? Number.MAX_SAFE_INTEGER : 100_000,
            onEntry: (entry) =>
              Effect.sync(() => {
                files.push(entry.path)
                for (let end = entry.path.indexOf("/"); end !== -1; end = entry.path.indexOf("/", end + 1))
                  directories.add(entry.path.slice(0, end) + path.sep)
              }),
          })
          .pipe(Effect.orDie)
        const state = { files, directories: [...directories] }
        yield* Effect.logInfo("filesystem search initialized", {
          backend: "ripgrep",
          directory: location.directory,
          durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          ...MemoryTelemetry.delta(before),
          files: files.length,
          directories: state.directories.length,
        })
        return state
      }).pipe(Effect.forkIn(scope)),
    )
    return Service.of({
      glob: (input) =>
        Effect.gen(function* () {
          const target = path.resolve(location.directory, input.path ?? ".")
          const info = yield* fs.stat(target).pipe(Effect.orDie)
          const cwd = info.type === "File" ? path.dirname(target) : target
          return yield* ripgrep
            .glob({
              cwd,
              pattern: input.pattern,
              limit: input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT,
            })
            .pipe(
              Effect.map((result) =>
                result.map((entry) =>
                  FileSystem.Entry.make({
                    ...entry,
                    path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                  }),
                ),
              ),
              Effect.orDie,
            )
        }),
      grep: (input) =>
        Effect.gen(function* () {
          const target = path.resolve(location.directory, input.path ?? ".")
          const info = yield* fs.stat(target).pipe(Effect.orDie)
          const cwd = info.type === "File" ? path.dirname(target) : target
          return yield* ripgrep
            .grep({
              cwd,
              pattern: input.pattern,
              file: info.type === "File" ? path.basename(target) : undefined,
              include: input.include,
              limit: input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT,
            })
            .pipe(
              Effect.map((result) =>
                result.map((match) =>
                  FileSystem.Match.make({
                    ...match,
                    entry: FileSystem.Entry.make({
                      ...match.entry,
                      path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, match.entry.path))),
                    }),
                  }),
                ),
              ),
              Effect.orDie,
            )
        }),
      find: (input) =>
        Effect.gen(function* () {
          const state = yield* index.pipe(Effect.flatMap(Fiber.join))
          const items =
            input.type === "file"
              ? state.files
              : input.type === "directory"
                ? state.directories
                : [...state.files, ...state.directories]
          return fuzzysort.go(input.query, items, { limit: input.limit ?? 50 }).map((item) => {
            const relative = item.target
            const type = relative.endsWith(path.sep) ? ("directory" as const) : ("file" as const)
            return FileSystem.Entry.make({
              path: RelativePath.make(relative),
              type,
            })
          })
        }),
    })
  }),
)

export const fffLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const scope = yield* Scope.Scope
    let closed = false
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true
      }),
    )
    const initialize = yield* Effect.cached(
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const before = MemoryTelemetry.sample()
        const picker = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const result = yield* Effect.try({
              try: () =>
                Fff.create({
                  basePath: location.directory,
                  aiMode: true,
                  disableMmapCache: true,
                  disableContentIndexing: true,
                }),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to initialize fff", { error }).pipe(Effect.as(undefined)),
              ),
            )
            if (!result?.ok) {
              if (result) yield* Effect.logWarning("failed to initialize fff", { error: result.error })
              return undefined
            }
            return result.value
          }),
          (picker) => (picker ? Effect.sync(() => picker.destroy()).pipe(Effect.ignore) : Effect.void),
        ).pipe(Effect.provideService(Scope.Scope, scope))
        if (picker && !closed)
          yield* Effect.logInfo("filesystem search initialized", {
            backend: "fff",
            directory: location.directory,
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
            ...MemoryTelemetry.delta(before),
          })
        return picker
      }),
    )
    const get = Effect.suspend(() =>
      closed
        ? Effect.interrupt
        : initialize.pipe(
            Effect.uninterruptible,
            Effect.flatMap((picker) => (closed ? Effect.interrupt : Effect.succeed(picker))),
          ),
    )
    return Service.of({
      glob: (input) =>
        Effect.gen(function* () {
          const picker = yield* get
          if (!picker) return []
          const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
          const found = picker.glob(prefix ? `${prefix}/${input.pattern}` : input.pattern, {
            pageIndex: 0,
            pageSize: input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT,
          })
          if (!found.ok) throw found.error
          return found.value.items.map((item) =>
            FileSystem.Entry.make({
              path: RelativePath.make(item.relativePath.replaceAll("\\", "/")),
              type: "file",
            }),
          )
        }),
      grep: (input) =>
        Effect.gen(function* () {
          const picker = yield* get
          if (!picker) return []
          const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
          const found = picker.grep(
            [prefix ? `${prefix}/**` : undefined, input.include, input.pattern]
              .filter((value) => value !== undefined)
              .join(" "),
            { mode: "regex", pageSize: input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT, timeBudgetMs: 1_500 },
          )
          if (!found.ok) throw found.error
          return found.value.items.map((match) => {
            const bytes = Buffer.from(match.lineContent)
            return FileSystem.Match.make({
              entry: FileSystem.Entry.make({
                path: RelativePath.make(match.relativePath.replaceAll("\\", "/")),
                type: "file",
              }),
              line: match.lineNumber,
              offset: match.byteOffset,
              text: match.lineContent.length > 2_000 ? match.lineContent.slice(0, 2_000) + "..." : match.lineContent,
              submatches: match.matchRanges.map(([start, end]) => ({
                text: bytes.subarray(start, end).toString("utf8"),
                start,
                end,
              })),
            })
          })
        }),
      find: (input) =>
        Effect.gen(function* () {
          const picker = yield* get
          if (!picker) return []
          const options = { pageIndex: 0, pageSize: input.limit ?? 50 }
          const items = (() => {
            if (input.type === "file") {
              const found = picker.fileSearch(input.query.trim(), options)
              if (!found.ok) throw found.error
              return found.value.items.map((item, index) => ({
                path: item.relativePath,
                type: "file" as const,
                score: found.value.scores[index]?.total ?? 0,
              }))
            }
            if (input.type === "directory") {
              const found = picker.directorySearch(input.query.trim(), options)
              if (!found.ok) throw found.error
              return found.value.items.map((item, index) => ({
                path: item.relativePath,
                type: "directory" as const,
                score: found.value.scores[index]?.total ?? 0,
              }))
            }
            const found = picker.mixedSearch(input.query.trim(), options)
            if (!found.ok) throw found.error
            return found.value.items.map((item, index) => ({
              path: item.item.relativePath,
              type: item.type,
              score: found.value.scores[index]?.total ?? 0,
            }))
          })()
          return items
            .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
            .map((item) => {
              const relative = item.path.replaceAll("\\", "/").replace(/\/$/, "")
              return FileSystem.Entry.make({
                path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                type: item.type,
              })
            })
        }),
    })
  }),
)

export const layer = (options?: Options) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (options?.fff === false || (options?.fff === undefined && process.platform === "win32") || !Fff.available())
        return ripgrepLayer
      const location = yield* Location.Service
      // Non-VCS locations can contain many repositories, so avoid eagerly content-indexing the entire aggregate tree.
      return location.vcs ? fffLayer : ripgrepLayer
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({ service: Service, layer: layer(options), deps: [FSUtil.node, Location.node, Ripgrep.node] })
}

export const node = configured()
