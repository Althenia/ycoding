export * as Watcher from "./watcher"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { FileSystem } from "@ycoding-ai/schema/filesystem"
import { makeGlobalNode } from "../effect/app-node"
import { Cause, Context, Effect, Layer, PubSub, Schema, Scope, Stream } from "effect"
import { KeyedMutex } from "../effect/keyed-mutex"
import { lazy } from "../util/lazy"
import { watch } from "node:fs"
import { stat } from "node:fs/promises"
import path from "path"
import { Glob } from "../util/glob"
import { createRequire } from "node:module"

declare const YCODING_LIBC: string | undefined

const SUBSCRIBE_TIMEOUT_MS = 10_000
const require = createRequire(import.meta.url)

export const Event = { Updated: FileSystem.Event.Changed }

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const libc = typeof YCODING_LIBC === "undefined" ? undefined : YCODING_LIBC
    const binding = require(
      process.env.YCODING_PARCEL_WATCHER_PATH ??
        `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch {
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

export const hasNativeBinding = () => !!watcher()
export type Update = ParcelWatcher.Event

export type WatchInput =
  | { readonly path: string; readonly type: "file" }
  | { readonly path: string; readonly type: "directory"; readonly ignore?: readonly string[] }

export interface Interface {
  readonly subscribe: (input: WatchInput) => Stream.Stream<Update>
}

export const Options = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  native: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@ycoding/Watcher") {}

export const layer = (options?: Options) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const backend = getBackend()
    const native = options?.native === false ? undefined : watcher()
    if (options?.enabled === false) {
      return Service.of({ subscribe: () => Stream.empty })
    }

    type Entry = {
      readonly pubsub: PubSub.PubSub<Update>
      readonly subscription: { readonly unsubscribe: () => Promise<void> }
      refs: number
    }
    const entries = new Map<string, Entry>()
    const locks = KeyedMutex.makeUnsafe<string>()

    const acquire = Effect.fn("Watcher.acquire")(function* (input: WatchInput) {
      const scope = yield* Scope.Scope
      const target = path.resolve(input.path)
      const directory = input.type === "file" ? path.dirname(target) : target
      const ignore = [...new Set(input.type === "directory" ? (input.ignore ?? []) : [])].toSorted()
      const id = JSON.stringify([input.type, target, ignore])
      const pubsub = yield* locks.withLock(id)(
        Effect.gen(function* () {
          const existing = entries.get(id)
          if (existing) {
            existing.refs++
            return existing.pubsub
          }
          const pubsub = yield* PubSub.unbounded<Update>()
          const subscription = yield* input.type === "file"
            ? Effect.sync(() => {
                const subscription = watch(directory, { recursive: false }, (_event, file) => {
                  if (file && path.resolve(directory, file.toString()) !== target) return
                  PubSub.publishUnsafe(pubsub, {
                    path: target,
                    type: "update",
                  } satisfies Update)
                })
                if ("on" in subscription && typeof subscription.on === "function") {
                  subscription.on("error", (error: unknown) =>
                    Effect.runFork(Effect.logError("watcher callback failed", { path: target, error })),
                  )
                }
                return { unsubscribe: () => Promise.resolve(subscription.close()) }
              })
            : subscribeDirectory(native, backend, directory, ignore, pubsub)
          if (subscription) {
            entries.set(id, { pubsub, subscription, refs: 1 })
            yield* Effect.logInfo("watcher started", {
              path: target,
              type: input.type,
              backend: input.type === "file" ? "node" : native && backend ? backend : "node-recursive",
              ignores: ignore.length,
            })
            return pubsub
          }
          yield* PubSub.shutdown(pubsub)
          return pubsub
        }),
      )

      yield* Scope.addFinalizer(
        scope,
        locks.withLock(id)(
          Effect.gen(function* () {
            const entry = entries.get(id)
            if (!entry) return
            entry.refs--
            if (entry.refs > 0) return
            entries.delete(id)
            yield* Effect.promise(() => entry.subscription.unsubscribe()).pipe(Effect.ignore)
            yield* PubSub.shutdown(entry.pubsub)
            yield* Effect.logInfo("watcher stopped", { path: target, type: input.type })
          }),
        ),
      )
      return pubsub
    })

    const subscribe = (input: WatchInput) =>
      Stream.unwrap(acquire(input).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub))))

    return Service.of({ subscribe })
  }),
)

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [] })
}

export const node = configured()

function subscribeDirectory(
  native: typeof import("@parcel/watcher") | undefined,
  backend: ParcelWatcher.BackendType | undefined,
  directory: string,
  ignore: string[],
  pubsub: PubSub.PubSub<Update>,
) {
  if (!native || !backend) return Effect.sync(() => subscribeDirectoryFallback(directory, ignore, pubsub))
  const callback: ParcelWatcher.SubscribeCallback = (error, updates) => {
    if (error) Effect.runFork(Effect.logError("watcher callback failed", { error }))
    for (const update of updates) PubSub.publishUnsafe(pubsub, update)
  }
  const pending = native.subscribe(directory, callback, { ignore, backend })
  return Effect.promise(() => pending).pipe(
    Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
    Effect.catchCause((cause) => {
      pending.then((subscription) => subscription.unsubscribe()).catch(() => {})
      return Effect.logWarning("native watcher failed; using recursive fallback", {
        directory,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(subscribeDirectoryFallback(directory, ignore, pubsub)))
    }),
  )
}

function subscribeDirectoryFallback(directory: string, ignore: string[], pubsub: PubSub.PubSub<Update>) {
  const known = new Set<string>()

  const ignored = (target: string) => {
    const relative = path.relative(directory, target).split(path.sep).join("/")
    return ignore.some((pattern) => {
      if (path.isAbsolute(pattern)) return target === pattern || target.startsWith(`${pattern}${path.sep}`)
      return Glob.match(pattern, relative) || relative.split("/").includes(pattern)
    })
  }

  let pending = Promise.resolve()
  const subscription = watch(directory, { recursive: true }, (event, file) => {
    if (!file) return
    const target = path.resolve(directory, file.toString())
    if (ignored(target)) return
    pending = pending
      .then(async () => {
        if (event === "change") {
          known.add(target)
          PubSub.publishUnsafe(pubsub, { path: target, type: "update" } satisfies Update)
          return
        }

        const exists = await stat(target).then(
          () => true,
          () => false,
        )
        if (exists) {
          const type = known.has(target) ? "update" : "create"
          known.add(target)
          PubSub.publishUnsafe(pubsub, { path: target, type } satisfies Update)
          return
        }

        known.delete(target)
        for (const item of known) if (item.startsWith(`${target}${path.sep}`)) known.delete(item)
        PubSub.publishUnsafe(pubsub, { path: target, type: "delete" } satisfies Update)
      })
      .catch((error) => {
        Effect.runFork(Effect.logError("watcher callback failed", { path: target, error }))
      })
  })
  subscription.on("error", (error) =>
    Effect.runFork(Effect.logError("watcher callback failed", { path: directory, error })),
  )
  return {
    unsubscribe: async () => {
      subscription.close()
      await pending
    },
  }
}
