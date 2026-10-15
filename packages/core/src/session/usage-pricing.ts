export * as SessionUsagePricing from "./usage-pricing"

import type { CatalogModel } from "../model"
import type { Catalog } from "../catalog"

export type Entry = { provider: CatalogModel.Info["cost"]; router: CatalogModel.Info["cost"] }

export type Snapshot = ReadonlyMap<string, Entry | undefined>

export type Cache = ReturnType<typeof make>

export function make() {
  const locations = new Map<string, { catalog: Catalog.Interface; entries: Map<string, Entry> }>()
  return {
    location(identity: string, catalog: Catalog.Interface) {
      const current = locations.get(identity)
      const value = current?.catalog === catalog ? current : { catalog, entries: new Map<string, Entry>() }
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
