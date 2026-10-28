export * as SessionUsagePricing from "./usage-pricing"

import { Cause, Effect, type Scope } from "effect"
import { CatalogModel } from "../model"
import type { Catalog } from "../catalog"
import { Location } from "../location"
import { Provider } from "../provider"
import { AbsolutePath } from "../schema"
import { Workspace } from "../workspace"
import type { PricingRef } from "./usage-read"

export type Entry = { provider: CatalogModel.Info["cost"]; router: CatalogModel.Info["cost"] }

export type Snapshot = ReadonlyMap<string, Entry | undefined>

export type Cache = ReturnType<typeof make>

export function make() {
  const locations = new Map<string, { catalog: WeakRef<Catalog.Interface>; entries: Map<string, Entry> }>()
  return {
    location(identity: string, catalog: Catalog.Interface) {
      const current = locations.get(identity)
      const value =
        current?.catalog.deref() === catalog ? current : { catalog: new WeakRef(catalog), entries: new Map<string, Entry>() }
      locations.delete(identity)
      locations.set(identity, value)
      if (locations.size > 128) locations.delete(locations.keys().next().value!)
      return {
        get: (key: string) => value.entries.get(key),
        store(key: string, entry: Entry) {
          if (locations.get(identity) !== value) return
          value.entries.delete(key)
          value.entries.set(key, entry)
          if (value.entries.size > 256) value.entries.delete(value.entries.keys().next().value!)
        },
      }
    },
    invalidate(identity: string | undefined) {
      if (identity === undefined) return locations.clear()
      locations.delete(identity)
    },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const isMissingLocation = (value: unknown) =>
  isRecord(value) && value._tag === "PlatformError" && isRecord(value.reason) && value.reason._tag === "NotFound"

export type Catalogs<E = unknown> = (location: Location.Ref) => Effect.Effect<Catalog.Interface, E, Scope.Scope>

export const resolve = <E>(input: {
  readonly catalog: Catalogs<E>
  readonly cache: Cache
  readonly catalogs: Map<string, Catalog.Interface | undefined>
  readonly resolved: Map<string, Entry | undefined>
  readonly refs: Iterable<PricingRef>
}): Effect.Effect<void, E, Scope.Scope> =>
  Effect.forEach(
    Map.groupBy(input.refs, (ref) => JSON.stringify([ref.directory, ref.workspaceID])),
    ([identity, refs]) =>
      Effect.gen(function* () {
        if (!input.catalogs.has(identity)) {
          const catalog = yield* input
            .catalog(
              Location.Ref.make({
                directory: AbsolutePath.make(refs[0]!.directory),
                workspaceID: refs[0]!.workspaceID ? Workspace.ID.make(refs[0]!.workspaceID) : undefined,
              }),
            )
            .pipe(
              Effect.catchCause((cause) =>
                isMissingLocation(Cause.squash(cause)) ? Effect.succeed(undefined) : Effect.failCause(cause),
              ),
            )
          input.catalogs.set(identity, catalog)
        }
        const catalog = input.catalogs.get(identity)
        if (!catalog) {
          refs.forEach((ref) => input.resolved.set(ref.key, undefined))
          return
        }
        const cache = input.cache.location(identity, catalog)
        for (const ref of refs) {
          const cached = cache.get(ref.key)
          if (cached) {
            input.resolved.set(ref.key, cached)
            continue
          }
          const provider = yield* catalog.model.get(
            Provider.ID.make(ref.provider),
            CatalogModel.ID.make(ref.model),
            ref.profile ?? undefined,
          )
          const router = yield* catalog.model.get(
            Provider.ID.openrouter,
            CatalogModel.ID.make(ref.provider === Provider.ID.openrouter ? ref.model : `${ref.provider}/${ref.model}`),
          )
          const entry = { provider: provider?.cost ?? [], router: router?.cost ?? [] }
          input.resolved.set(ref.key, entry)
          cache.store(ref.key, entry)
        }
      }),
    { concurrency: 4, discard: true },
  )
